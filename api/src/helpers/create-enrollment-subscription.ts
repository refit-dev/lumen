import { z } from "zod";
import { db } from "../db/client";
import { subscriptions } from "@lumen/common/schema";
import { and, eq, isNull, desc, inArray } from "drizzle-orm";
import {
  prices,
  customers,
  subscriptionFeatures,
  plans,
} from "@lumen/common/schema";
import { planEnrollmentRules } from "@lumen/common/schema";
import {
  createSubscriptionCore,
  generateImmediateInvoice,
} from "../helpers/billing";
import { upsertCustomer } from "../helpers/customers";
import { mapStableSubIdToId } from "../helpers/utils";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { TransactionType } from ".";
import {
  createFreeSubscriptionForUser,
  freeSubscriptionSchema,
} from "./create-free-subscription";
import { YC_ENROLLMENT_PLACEHOLDER_DOMAIN } from "@lumen/common/utils";
import { internalKeyValues } from "@lumen/common/schema";

export const enrollmentSubscriptionSchema = freeSubscriptionSchema.extend({
  planId: z.string().optional(),
});

function isFreePrice(p: typeof prices.$inferSelect): boolean {
  if (!p.pricingData || !p.pricingData.components) return false;

  let immediateAmountToBill = 0;
  let totalPlanValueExcludingUsage = 0;
  let hasUsageComponentWithNonZeroPrice = false;

  for (const component of p.pricingData.components) {
    if (component.type !== "usage") {
      totalPlanValueExcludingUsage += component.amount_cents || 0;
      if (component.bill_immediately) {
        immediateAmountToBill += component.amount_cents || 0;
      }
    } else {
      if (component.unit_cost_cents > 0) {
        hasUsageComponentWithNonZeroPrice = true;
      }
    }
  }

  return (
    immediateAmountToBill === 0 &&
    totalPlanValueExcludingUsage === 0 &&
    !hasUsageComponentWithNonZeroPrice
  );
}

async function findMatchingEnrollmentPlanId({
  merchantId,
  email,
  tx,
}: {
  merchantId: string;
  email: string;
  tx: TransactionType;
}): Promise<string | null> {
  const rules = await tx.query.planEnrollmentRules.findMany({
    where: and(
      eq(planEnrollmentRules.merchantId, merchantId),
      eq(planEnrollmentRules.isActive, true),
      isNull(planEnrollmentRules.deletedAt)
    ),
  });

  const lowerEmail = email.toLowerCase();
  for (const rule of rules) {
    if (rule.matcherType === "email") {
      if (lowerEmail === rule.matcherValue.toLowerCase()) return rule.planId;
    } else if (rule.matcherType === "domain") {
      if (lowerEmail.endsWith("@" + rule.matcherValue.toLowerCase()))
        return rule.planId;
      if (rule.matcherValue === YC_ENROLLMENT_PLACEHOLDER_DOMAIN) {
        const ycRow = await tx.query.internalKeyValues.findFirst({
          where: eq(internalKeyValues.key, YC_ENROLLMENT_PLACEHOLDER_DOMAIN),
        });
        const ycCompanyDomains = ycRow?.value as string[];
        if (!ycCompanyDomains) {
          console.error("YC companies not found");
        }
        // ycCompanyDomains are already in lowerCase
        if (ycCompanyDomains?.includes(lowerEmail.split("@")[1]))
          return rule.planId;
      }
    }
  }
  return null;
}

export const createEnrollmentSubscriptionForUser = async (
  data: z.infer<typeof enrollmentSubscriptionSchema> & { merchantId: string },
  tx?: TransactionType
) => {
  const { merchantId } = data;

  const dbInstance = tx || db;

  try {
    // Early check: does an active subscription already exist for this external customer ID?
    const existingCustomer = await dbInstance.query.customers.findFirst({
      where: and(
        eq(customers.externalCustomerId, data.userId),
        eq(customers.merchantId, data.merchantId),
        isNull(customers.deletedAt)
      ),
    });

    if (existingCustomer) {
      const existingActiveSubscription =
        await dbInstance.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, existingCustomer.id),
            eq(subscriptions.merchantId, merchantId),
            isNull(subscriptions.deletedAt),
            isNull(subscriptions.endTimestamp),
            inArray(subscriptions.status, ["active", "trialing", "past_due"])
          ),
        });

      if (existingActiveSubscription) {
        return [
          {
            error: "Subscription already exists for this customer",
            subscription: mapStableSubIdToId(existingActiveSubscription),
          },
          409 as ContentfulStatusCode,
        ] as const;
      }
    }

    return await dbInstance.transaction(async (tx) => {
      let selectedPlanId: string | null = data.planId || null;

      if (!selectedPlanId) {
        selectedPlanId = await findMatchingEnrollmentPlanId({
          merchantId,
          email: data.customerEmail,
          tx,
        });
      }

      if (!selectedPlanId) {
        // Fallback to free subscription logic that picks from active pricing tables
        return await createFreeSubscriptionForUser(data, tx);
      }

      // Validate plan belongs to this merchant
      const planRecord = await tx.query.plans.findFirst({
        where: and(
          eq(plans.id, selectedPlanId),
          eq(plans.merchantId, merchantId),
          isNull(plans.deletedAt)
        ),
      });

      if (!planRecord) {
        return [
          { error: "Plan not found or access denied" },
          404 as ContentfulStatusCode,
        ] as const;
      }

      // Get latest free price for this plan regardless of pricing table visibility
      const planPrices = await tx.query.prices.findMany({
        where: and(
          eq(prices.merchantId, merchantId),
          eq(prices.planId, selectedPlanId),
          isNull(prices.deletedAt)
        ),
        orderBy: desc(prices.createdAt),
      });

      const freePrices = planPrices.filter(isFreePrice);
      if (freePrices.length === 0) {
        return [
          { error: "Selected plan has no pure free price; cannot auto-enroll" },
          400 as ContentfulStatusCode,
        ] as const;
      }

      const latestFreePlanPrice = freePrices[0];

      const customer = await upsertCustomer({
        merchantId,
        email: data.customerEmail,
        name: data.customerName,
        externalCustomerId: data.userId,
        billingAddressLine1: data.billingAddressLine1,
        billingAddressLine2: data.billingAddressLine2,
        billingCity: data.billingCity,
        billingPostalCode: data.billingPostalCode,
        billingCountry: data.billingCountry,
        taxId: data.taxId,
        tx,
      });

      const { subscription, creditGrants } = await createSubscriptionCore({
        merchantId,
        customerId: customer.id,
        planId: latestFreePlanPrice.planId,
        effectivePriceId: latestFreePlanPrice.id,
        startTimestamp: new Date(),
        paymentMethodId: undefined,
        dangerouslyAllowMultipleSubscriptions: true,
        tx,
      });

      if (!subscription) {
        throw new Error("Failed to create subscription");
      }

      const subscriptionWithFeatures = await tx.query.subscriptions.findFirst({
        where: eq(subscriptions.id, subscription.id),
        with: {
          customer: true,
          plan: true,
          price: true,
          subscriptionFeatures: {
            where: isNull(subscriptionFeatures.deletedAt),
            with: {
              feature: true,
            },
          },
          subscriptionDetails: true,
        },
      });

      if (!subscriptionWithFeatures) {
        throw new Error("Failed to retrieve created subscription");
      }

      const invoice = await generateImmediateInvoice({
        merchantId,
        customerId: customer.id,
        subscription,
        price: latestFreePlanPrice,
        subscriptionDetailsRecords:
          subscriptionWithFeatures.subscriptionDetails,
        firstBillingPeriodStart: new Date(),
        tx,
        taxInfo: undefined,
      });

      return [
        {
          message: "Enrollment subscription created successfully",
          subscription: subscriptionWithFeatures,
          invoice: invoice,
          plan: {
            id: latestFreePlanPrice.planId,
          },
          credit_grants_created: creditGrants.grantCount,
        },
        200 as ContentfulStatusCode,
      ] as const;
    });
  } catch (error) {
    console.error("Error creating enrollment subscription:", error);
    if (error instanceof Error) {
      return [{ error: error.message }, 400 as ContentfulStatusCode] as const;
    }
    return [
      { error: "Failed to create enrollment subscription" },
      500 as ContentfulStatusCode,
    ] as const;
  }
};
