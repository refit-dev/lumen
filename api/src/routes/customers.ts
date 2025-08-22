import { Hono } from "hono";
import { z } from "zod";
import { ID_PREFIXES, createPrefixValidator } from "@lumen/common";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import {
  customers,
  customersInsertSchemaReq,
  payments,
  invoices,
  subscriptions,
} from "@lumen/common/schema";
import { eq, and, isNull, not, sql, desc } from "drizzle-orm";
import { createCustomer, updateCustomer, lower } from "../helpers/customers";

const customerUpdateSchema = customersInsertSchemaReq.partial();

async function getSubscriptionStatusByExternalCustomerId(
  merchantId: string,
  externalCustomerId: string
) {
  // Find the customer by external customer ID
  const customer = await db.query.customers.findFirst({
    where: and(
      eq(customers.externalCustomerId, externalCustomerId),
      eq(customers.merchantId, merchantId),
      isNull(customers.deletedAt)
    ),
  });

  if (!customer) {
    return {
      hasActiveSubscription: false,
      customer: null,
      subscription: null,
    };
  }

  // Check for active subscription
  const activeSubscription = await db.query.subscriptions.findFirst({
    where: and(
      eq(subscriptions.customerId, customer.id),
      eq(subscriptions.merchantId, merchantId),
      isNull(subscriptions.endTimestamp)
    ),
    with: {
      plan: {
        columns: {
          id: true,
          planName: true,
          planDescription: true,
        },
      },
      price: {
        columns: {
          id: true,
          currency: true,
          pricingData: true,
        },
      },
    },
    orderBy: desc(subscriptions.createdAt),
  });

  if (!activeSubscription) {
    return {
      hasActiveSubscription: false,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
      },
      subscription: null,
    };
  }

  return {
    hasActiveSubscription: true,
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
    },
    subscription: {
      id: activeSubscription.id,
      planId: activeSubscription.planId,
      planName: activeSubscription.plan.planName,
      planDescription: activeSubscription.plan.planDescription,
      priceId: activeSubscription.effectivePriceId,
      currency: activeSubscription.price.currency,
      pricingData: activeSubscription.price.pricingData,
      startTimestamp: activeSubscription.startTimestamp,
    },
  };
}

export const customersRouter = new Hono()
  .get(
    "/",
    zValidator(
      "query",
      z
        .object({
          includePaymentData: z.string().optional().default("false"),
        })
        .optional()
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const includePaymentData =
        c.req.valid("query")?.includePaymentData === "true";

      if (includePaymentData) {
        // Optimized query with payment aggregations
        const customersWithPayments = await db
          .select({
            // Customer fields
            id: customers.id,
            merchantId: customers.merchantId,
            name: customers.name,
            email: customers.email,
            phoneNumber: customers.phoneNumber,
            pspCustomerId: customers.pspCustomerId,
            externalCustomerId: customers.externalCustomerId,
            billingAddressLine1: customers.billingAddressLine1,
            billingAddressLine2: customers.billingAddressLine2,
            billingCity: customers.billingCity,
            billingStateProvince: customers.billingStateProvince,
            billingPostalCode: customers.billingPostalCode,
            billingCountry: customers.billingCountry,
            businessName: customers.businessName,
            taxId: customers.taxId,
            taxExempt: customers.taxExempt,
            taxExemptionReason: customers.taxExemptionReason,
            taxExemptionCertificate: customers.taxExemptionCertificate,
            taxRateDefinitionId: customers.taxRateDefinitionId,
            taxCalculationMethod: customers.taxCalculationMethod,
            invoicePrefix: customers.invoicePrefix,
            preferredLanguage: customers.preferredLanguage,
            timezone: customers.timezone,
            preferredCurrency: customers.preferredCurrency,
            metadata: customers.metadata,
            createdAt: customers.createdAt,
            updatedAt: customers.updatedAt,
            deletedAt: customers.deletedAt,
            // Payment aggregations
            totalPaymentsCents: sql<number>`COALESCE(SUM(CASE WHEN ${payments.status} IN ('succeeded', 'paid') THEN ${payments.amountCents} ELSE 0 END), 0)`,
            paymentCount: sql<number>`COALESCE(COUNT(CASE WHEN ${payments.status} IN ('succeeded', 'paid') THEN 1 END), 0)`,
            currency: sql<string>`COALESCE(${payments.currency}, 'USD')`,
          })
          .from(customers)
          .leftJoin(invoices, eq(invoices.customerId, customers.id))
          .leftJoin(payments, eq(payments.invoiceId, invoices.id))
          .where(
            and(
              eq(customers.merchantId, merchantId),
              isNull(customers.deletedAt)
            )
          )
          .groupBy(customers.id, payments.currency)
          .having(sql`COUNT(*) > 0 OR COUNT(${payments.id}) = 0`); // Include customers with no payments

        return c.json({ customers: customersWithPayments });
      } else {
        // Original simple query
        const allCustomers = await db.query.customers.findMany({
          where: and(
            eq(customers.merchantId, merchantId),
            isNull(customers.deletedAt)
          ),
        });
        return c.json({ customers: allCustomers });
      }
    }
  )
  // Check subscription status for a user by external customer ID
  .get(
    "/subscription-status",
    zValidator(
      "query",
      z.object({
        externalCustomerId: z
          .string()
          .min(1, "External customer ID is required"),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const externalCustomerId = c.req.valid("query").externalCustomerId;

      try {
        const result = await getSubscriptionStatusByExternalCustomerId(
          merchantId,
          externalCustomerId
        );
        return c.json(result);
      } catch (error) {
        console.error("Error checking subscription status:", error);
        return c.json({ error: "Failed to check subscription status" }, 500);
      }
    }
  )
  .get(
    "/:id",
    zValidator(
      "param",
      z.object({
        id: createPrefixValidator(
          ID_PREFIXES.customer,
          "Invalid customer ID format"
        )(z.string()),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const customerId = c.req.valid("param").id;

      try {
        const customer = await db.query.customers.findFirst({
          where: and(
            eq(customers.id, customerId),
            eq(customers.merchantId, merchantId),
            isNull(customers.deletedAt)
          ),
        });

        if (!customer) {
          return c.json({ error: "Customer not found or access denied" }, 404);
        }

        return c.json({ customer });
      } catch (error) {
        console.error("Error fetching customer by ID:", error);
        return c.json({ error: "Failed to fetch customer" }, 500);
      }
    }
  )
  .post("/", zValidator("json", customersInsertSchemaReq), async (c) => {
    const merchantId = c.get("merchant")!.id;
    const data = c.req.valid("json");

    try {
      const newCustomer = await createCustomer(merchantId, data);
      return c.json({ customer: newCustomer }, 201);
    } catch (error: any) {
      console.error("Error creating customer:", error);
      if (
        error.message.includes("Email is required") ||
        error.message.includes("A customer with this email already exists")
      ) {
        return c.json(
          { error: error.message },
          error.message.includes("already exists") ? 409 : 400
        );
      }
      return c.json({ error: "Failed to create customer" }, 500);
    }
  })
  .post(
    "/:id",
    zValidator(
      "param",
      z.object({
        id: createPrefixValidator(
          ID_PREFIXES.customer,
          "Invalid customer ID format"
        )(z.string()),
      })
    ),
    zValidator("json", customerUpdateSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const customerId = c.req.valid("param").id;
      const data = c.req.valid("json");

      // Check for email conflicts before calling updateCustomer if dangerouslyAllowSameEmailForDifferentCustomers is not true
      // This check is needed here because dangerouslyAllowSameEmailForDifferentCustomers is not part of UpdateCustomerOptions
      if (data.email && !data.dangerouslyAllowSameEmailForDifferentCustomers) {
        const existingCustomer = await db.query.customers.findFirst({
          where: and(
            eq(customers.id, customerId),
            eq(customers.merchantId, merchantId),
            isNull(customers.deletedAt)
          ),
        });

        if (
          existingCustomer &&
          data.email.toLowerCase() !== existingCustomer.email?.toLowerCase()
        ) {
          const customerWithNewEmail = await db.query.customers.findFirst({
            where: and(
              eq(lower(customers.email), data.email.toLowerCase()),
              eq(customers.merchantId, merchantId),
              isNull(customers.deletedAt),
              not(eq(customers.id, customerId))
            ),
          });
          if (customerWithNewEmail) {
            return c.json(
              {
                error:
                  "Another customer with this email already exists. Use dangerouslyAllowSameEmailForDifferentCustomers to allow.",
              },
              409
            );
          }
        }
      }

      try {
        const updatedCustomer = await updateCustomer(
          merchantId,
          customerId,
          data
        );
        return c.json({ customer: updatedCustomer });
      } catch (error: any) {
        console.error("Error updating customer:", error);
        if (
          error.message.includes("Customer not found or access denied") ||
          error.message.includes(
            "Another customer with this email already exists"
          )
        ) {
          return c.json(
            { error: error.message },
            error.message.includes("not found") ? 404 : 409
          );
        }
        return c.json({ error: "Failed to update customer" }, 500);
      }
    }
  )
  .delete(
    "/:id",
    zValidator(
      "param",
      z.object({
        id: createPrefixValidator(
          ID_PREFIXES.customer,
          "Invalid customer ID format"
        )(z.string()),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const customerId = c.req.valid("param").id;

      let existingCustomer;
      try {
        existingCustomer = await db.query.customers.findFirst({
          where: and(
            eq(customers.id, customerId),
            eq(customers.merchantId, merchantId),
            isNull(customers.deletedAt)
          ),
        });
      } catch (error) {
        console.error("Error finding customer for delete:", error);
        return c.json({ error: "Failed to find customer for delete" }, 500);
      }

      if (!existingCustomer) {
        return c.json({ error: "Customer not found or access denied" }, 404);
      }

      try {
        const result = await db
          .update(customers)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(customers.id, customerId),
              eq(customers.merchantId, merchantId)
            )
          )
          .returning({ id: customers.id });

        if (result.length === 0) {
          return c.json(
            { error: "Customer not found or already deleted during operation" },
            404
          );
        }

        return c.json({ success: true });
      } catch (error) {
        console.error("Error deleting customer:", error);
        return c.json({ error: "Failed to delete customer" }, 500);
      }
    }
  );
