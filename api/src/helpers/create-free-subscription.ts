import { z } from "zod";
import { db } from "../db/client";
import { subscriptions } from "@lumen/common/schema";
import { and, eq, isNull, desc, inArray } from "drizzle-orm";
import { prices, pricingTables, pricingTablePlans } from "@lumen/common/schema";
import { customers } from "@lumen/common/schema";
import { subscriptionFeatures } from "@lumen/common/schema";
import {
  createSubscriptionCore,
  generateImmediateInvoice,
} from "../helpers/billing";
import { upsertCustomer } from "../helpers/customers";
import { mapStableSubIdToId } from "../helpers/utils";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { getPaymentProvider } from "../helpers/paymentprovider";
import { TransactionType } from "./index";

export const freeSubscriptionSchema = z.object({
  customerEmail: z.string(),
  customerName: z.string(),
  userId: z.string(),
  billingAddressLine1: z.string().optional(),
  billingAddressLine2: z.string().optional(),
  billingCity: z.string().optional(),
  billingPostalCode: z.string().optional(),
  billingCountry: z.string().optional(),
  taxId: z.string().optional(),
});

const createFreeSubsProps = freeSubscriptionSchema.extend({
  merchantId: z.string(),
});

export const createFreeSubscriptionForUser = async (
  data: z.infer<typeof createFreeSubsProps>,
  tx?: TransactionType
) => {
  const { merchantId } = data;
  console.log(
    `Creating free subscription for merchant ${merchantId}, user ${data.userId}`
  );

  const dbInstance = tx || db;

  try {
    // Early check: ensure payment provider is configured
    const { isPaymentProviderReady, statusMessage } =
      await getPaymentProvider(merchantId);
    if (!isPaymentProviderReady) {
      return [{ error: statusMessage }, 400 as ContentfulStatusCode] as const;
    }

    // Early check: does an active subscription already exist for this external customer ID?
    const existingCustomer = await dbInstance.query.customers.findFirst({
      where: and(
        eq(customers.externalCustomerId, data.userId),
        eq(customers.merchantId, data.merchantId),
        isNull(customers.deletedAt)
      ),
    });

    if (existingCustomer) {
      console.log(
        `Found existing customer ${existingCustomer.id}, checking for active subscription`
      );
      const existingActiveSubscription =
        await dbInstance.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, existingCustomer.id),
            eq(subscriptions.merchantId, merchantId),
            isNull(subscriptions.deletedAt),
            isNull(subscriptions.endTimestamp)
          ),
        });

      if (existingActiveSubscription) {
        console.log(
          `Active subscription ${existingActiveSubscription.id} already exists for customer ${existingCustomer.id}`
        );
        return [
          {
            error: "Subscription already exists for this customer",
            subscription: mapStableSubIdToId(existingActiveSubscription),
          },
          409 as ContentfulStatusCode,
        ] as const;
      }
      console.log(
        `No active subscription found for existing customer ${existingCustomer.id}`
      );
    } else {
      console.log(`No existing customer found for userId ${data.userId}`);
    }

    return await dbInstance.transaction(async (tx) => {
      // Find all active pricing tables for this merchant
      console.log(`Finding active pricing tables for merchant ${merchantId}`);
      const activePricingTables = await tx.query.pricingTables.findMany({
        where: and(
          eq(pricingTables.merchantId, merchantId),
          eq(pricingTables.isActive, true),
          isNull(pricingTables.deletedAt)
        ),
      });

      if (activePricingTables.length === 0) {
        console.log(
          `No active pricing tables found for merchant ${merchantId}`
        );
        return [
          { error: "No active pricing tables found for this merchant" },
          404 as ContentfulStatusCode,
        ] as const;
      }
      console.log(`Found ${activePricingTables.length} active pricing tables`);

      // Get all plan IDs from the pricing tables
      const pricingTableIds = activePricingTables.map((pt) => pt.id);
      console.log(
        `Getting plans from pricing tables: ${pricingTableIds.join(", ")}`
      );
      const pricingTablePlanEntries = await tx.query.pricingTablePlans.findMany(
        {
          where: and(
            eq(pricingTablePlans.merchantId, merchantId),
            inArray(pricingTablePlans.pricingTableId, pricingTableIds),
            isNull(pricingTablePlans.deletedAt)
          ),
        }
      );

      if (pricingTablePlanEntries.length === 0) {
        console.log(
          `No plans found in active pricing tables for merchant ${merchantId}`
        );
        return [
          { error: "No plans found in active pricing tables" },
          404 as ContentfulStatusCode,
        ] as const;
      }

      const planIdsInPricingTables = pricingTablePlanEntries.map(
        (ptp) => ptp.planId
      );
      console.log(
        `Found ${planIdsInPricingTables.length} plans in pricing tables`
      );

      const pricesForPricingTablePlans = await tx.query.prices.findMany({
        where: and(
          eq(prices.merchantId, merchantId),
          inArray(prices.planId, planIdsInPricingTables),
          isNull(prices.deletedAt)
        ),
        with: {
          plan: true,
        },
        orderBy: desc(prices.createdAt),
      });
      console.log(
        `Found ${pricesForPricingTablePlans.length} prices for pricing table plans`
      );

      // Filter for free prices (where all components have 0 cost and no usage potential)
      const freePrices = pricesForPricingTablePlans.filter((price) => {
        if (!price.pricingData || !price.pricingData.components) {
          return false;
        }

        let immediateAmountToBill = 0;
        let totalPlanValueExcludingUsage = 0;
        let hasUsageComponentWithNonZeroPrice = false;

        for (const component of price.pricingData.components) {
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

        // This is a free plan if all amounts are 0 and no usage components have non-zero cost
        return (
          immediateAmountToBill === 0 &&
          totalPlanValueExcludingUsage === 0 &&
          !hasUsageComponentWithNonZeroPrice
        );
      });

      if (freePrices.length === 0) {
        console.log(`No free plans available for merchant ${merchantId}`);
        return [
          { error: "No free plans available for this merchant" },
          404 as ContentfulStatusCode,
        ] as const;
      }
      console.log(`Found ${freePrices.length} free prices`);

      // Take the latest free plan (first in the ordered list)
      const latestFreePlanPrice = freePrices[0];

      if (!latestFreePlanPrice.plan) {
        console.log(`Plan not found for price ${latestFreePlanPrice.id}`);
        return [
          { error: "Plan not found for the selected price" },
          404 as ContentfulStatusCode,
        ] as const;
      }

      console.log(
        `Selected free plan: ${latestFreePlanPrice.plan.planName} (${latestFreePlanPrice.plan.id})`
      );

      // Create or find the customer
      console.log(`Creating/updating customer for email ${data.customerEmail}`);
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
      console.log(`Customer created/found: ${customer.id}`);

      // Create the subscription using the same logic as the free plan branch in payment-init
      console.log(
        `Creating subscription for customer ${customer.id} with plan ${latestFreePlanPrice.plan.id}`
      );
      const { subscription, creditGrants } = await createSubscriptionCore({
        merchantId,
        customerId: customer.id,
        planId: latestFreePlanPrice.plan.id,
        effectivePriceId: latestFreePlanPrice.id,
        startTimestamp: new Date(),
        paymentMethodId: undefined, // No payment method needed for free plans
        dangerouslyAllowMultipleSubscriptions: true,
        tx,
      });

      if (!subscription) {
        console.log(
          `Failed to create subscription for customer ${customer.id}`
        );
        throw new Error("Failed to create subscription");
      }

      console.log(
        `Created free subscription ${subscription.id} for customer ${customer.id} with plan ${latestFreePlanPrice.plan.planName}`
      );

      if (creditGrants.grantCount > 0) {
        console.info(
          `Created ${creditGrants.grantCount} initial credit grants for subscription ${subscription.id}`
        );
      }

      // 9. Get the complete subscription with features
      console.log(
        `Retrieving complete subscription data for ${subscription.id}`
      );
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
        console.log(
          `Failed to retrieve created subscription ${subscription.id}`
        );
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

      console.log(
        `Successfully created free subscription ${subscription.id} for user ${data.userId} and invoice ${invoice?.id}`
      );
      return [
        {
          message: "Free subscription created successfully",
          subscription: subscriptionWithFeatures,
          invoice: invoice,
          plan: {
            id: latestFreePlanPrice.plan.id,
            name: latestFreePlanPrice.plan.planName,
            description: latestFreePlanPrice.plan.planDescription,
          },
          credit_grants_created: creditGrants.grantCount,
        },
        200 as ContentfulStatusCode,
      ] as const;
    });
  } catch (error) {
    console.error("Error creating free subscription:", error);
    if (error instanceof Error) {
      return [{ error: error.message }, 400 as ContentfulStatusCode] as const;
    }
    return [
      { error: "Failed to create free subscription" },
      500 as ContentfulStatusCode,
    ] as const;
  }
};
