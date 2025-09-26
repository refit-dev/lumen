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
  paymentMethods,
  subscriptionDetails,
  plans,
  customerOrganizations,
} from "@lumen/common/schema";
import { eq, and, isNull, not, sql, desc, inArray, or } from "drizzle-orm";
import { createCustomer, updateCustomer, lower } from "../helpers/customers";
import { getActiveSubscriptionForCustomer } from "../helpers/billing";
import {
  getPaymentProvider,
  createPspCustomer,
  createPspPaymentAuthorization,
} from "../helpers/paymentprovider";

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
            customerOrganizationId: customers.customerOrganizationId,
            orgRole: customers.orgRole,
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
              isNull(customers.deletedAt),
              // Filter out seat member customers - only show primary or standalone customers
              or(
                isNull(customers.orgRole),
                not(eq(customers.orgRole, "member"))
              )
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
            isNull(customers.deletedAt),
            // Filter out seat member customers - only show primary or standalone customers
            or(isNull(customers.orgRole), not(eq(customers.orgRole, "member")))
          ),
        });
        return c.json({ customers: allCustomers });
      }
    }
  )
  // Customer Portal: aggregate view (requires secret key/session auth)
  .get(
    "/portal/overview",
    zValidator(
      "query",
      z.object({
        externalCustomerId: z.string().min(1),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { externalCustomerId } = c.req.valid("query");

      const customer = await db.query.customers.findFirst({
        where: and(
          eq(customers.externalCustomerId, externalCustomerId),
          eq(customers.merchantId, merchantId),
          isNull(customers.deletedAt)
        ),
      });
      if (!customer) {
        return c.json({ error: "Customer not found" }, 404);
      }

      const activeSub = await getActiveSubscriptionForCustomer(
        merchantId,
        customer.id
      );

      const subDetails = activeSub
        ? await db.query.subscriptionDetails.findFirst({
            where: and(
              eq(subscriptionDetails.subscriptionId, activeSub.id),
              isNull(subscriptionDetails.deletedAt)
            ),
          })
        : null;

      const pmList = await db.query.paymentMethods.findMany({
        where: and(
          eq(paymentMethods.customerId, customer.id),
          isNull(paymentMethods.deletedAt)
        ),
      });

      const invoicesList = await db.query.invoices.findMany({
        where: and(
          eq(invoices.customerId, customer.id),
          eq(invoices.merchantId, merchantId)
        ),
        with: { payment: true },
        orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
        limit: 20,
      });

      const paymentsList = await db.query.payments.findMany({
        where: and(
          eq(payments.merchantId, merchantId),
          inArray(
            payments.invoiceId,
            invoicesList.map((i) => i.id).filter(Boolean) as string[]
          )
        ),
        orderBy: (payments, { desc }) => [desc(payments.createdAt)],
        limit: 20,
      });

      return c.json({
        portal: {
          customer: {
            id: customer.id,
            name: customer.name,
            email: customer.email,
          },
          subscription: activeSub
            ? {
                id: activeSub.id,
                stableSubscriptionId: activeSub.stableSubscriptionId,
                status: activeSub.status,
                planId: activeSub.planId,
                gracePeriodEndsAt: activeSub.gracePeriodEndsAt,
                paymentMethodId: subDetails?.paymentMethodId || null,
              }
            : null,
          paymentMethods: pmList.map((pm) => ({
            id: pm.id,
            provider: pm.provider,
            paymentType: pm.paymentType,
            status: pm.status,
            cardBrand: pm.cardBrand,
            cardLastFour: pm.cardLastFour,
            cardExpiryMonth: pm.cardExpiryMonth,
            cardExpiryYear: pm.cardExpiryYear,
            linkedToSubscription: subDetails?.paymentMethodId === pm.id,
          })),
          invoices: invoicesList.map((inv) => ({
            id: inv.id,
            number: inv.customerInvoiceNumber,
            status: inv.status,
            totalAmountCents: inv.totalAmountCents,
            currency: inv.currency,
            issueDate: inv.issueDate,
            paidDate: inv.paidDate,
            pdfUrl: inv.pdfUrl,
            paymentStatus: inv.payment?.status || null,
          })),
          payments: paymentsList.map((p) => ({
            id: p.id,
            amountCents: p.amountCents,
            currency: p.currency,
            status: p.status,
            createdAt: p.createdAt,
            errorMessage: p.errorMessage,
            invoiceId: p.invoiceId,
          })),
        },
      });
    }
  )
  // Customer Portal: create setup intent (Stripe) or payment link (Dodo)
  .post(
    "/portal/create-setup-intent",
    zValidator(
      "json",
      z.object({
        externalCustomerId: z.string().min(1),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { externalCustomerId } = c.req.valid("json");

      let customer = await db.query.customers.findFirst({
        where: and(
          eq(customers.externalCustomerId, externalCustomerId),
          eq(customers.merchantId, merchantId),
          isNull(customers.deletedAt)
        ),
      });
      if (!customer) return c.json({ error: "Customer not found" }, 404);

      const paymentProvider = await getPaymentProvider(merchantId);
      if (!paymentProvider.isPaymentProviderReady) {
        return c.json({ error: paymentProvider.statusMessage }, 400);
      }

      if (!customer.pspCustomerId) {
        const pspCustomer = await createPspCustomer({
          paymentProvider,
          customer: {
            id: customer.id,
            email: customer.email || "",
            name: customer.name || "",
          },
        });
        if (!pspCustomer) {
          return c.json({ error: "Failed to create PSP customer" }, 500);
        }
        await db
          .update(customers)
          .set({ pspCustomerId: pspCustomer.id })
          .where(eq(customers.id, customer.id));
        customer = { ...customer, pspCustomerId: pspCustomer.id };
      }

      // For Dodo, require an active subscription to create a mandate-only link
      let planForDodo: any = null;
      if (paymentProvider.name === "dodo") {
        const activeSub = await getActiveSubscriptionForCustomer(
          merchantId,
          customer.id
        );
        if (!activeSub) {
          return c.json(
            { error: "Active subscription required to add mandate for Dodo" },
            400
          );
        }
        planForDodo = await db.query.plans.findFirst({
          where: eq(plans.id, activeSub.planId),
        });
      }

      // Create a minimal payment row to anchor the setup intent in webhooks
      const [paymentRow] = await db
        .insert(payments)
        .values({
          merchantId,
          externalPaymentId: "",
          amountCents: 0,
          currency: "usd",
          status: "pending",
          metadata: {
            portal_pm_add: "true",
            customer_id: customer.id,
            merchant_id: merchantId,
          } as Record<string, any>,
        })
        .returning();

      const auth = await createPspPaymentAuthorization({
        amount: null,
        paymentProvider,
        customer: {
          id: customer.id,
          name: customer.name || "",
          email: customer.email || "",
          billingCity: customer.billingCity || "",
          billingCountry: customer.billingCountry || "",
          billingStateProvince: customer.billingStateProvince || "",
          billingAddressLine1: customer.billingAddressLine1 || "",
          billingPostalCode: customer.billingPostalCode || "",
          pspCustomerId: customer.pspCustomerId!,
          taxId: customer.taxId || null,
        },
        currency: "usd",
        plan: (paymentProvider.name === "dodo"
          ? planForDodo
          : ({ id: "plan_placeholder", merchantId } as any)) as any,
        lumenPaymentId: paymentRow.id,
      });

      if (!auth)
        return c.json({ error: "Failed to create authorization" }, 500);

      // Update our payment row with the external setup intent id or subscription id
      await db
        .update(payments)
        .set({ externalPaymentId: auth.id })
        .where(eq(payments.id, paymentRow.id));

      if ("object" in auth && auth.object === "setup_intent") {
        if (!auth.client_secret) {
          return c.json({ error: "Failed to create authorization" }, 500);
        }
        return c.json<{
          provider: string;
          stripe: {
            clientSecret: string;
            intentId: string;
            publishableKey: string;
          };
        }>({
          provider: paymentProvider.name,
          stripe: {
            clientSecret: auth.client_secret,
            intentId: auth.intentId,
            publishableKey: paymentProvider.stripeIntegration!.publicKey,
          },
        });
      } else if ("payment_link" in auth) {
        return c.json<{
          provider: string;
          dodo: { paymentLink: string };
        }>({
          provider: paymentProvider.name,
          dodo: { paymentLink: auth.payment_link },
        });
      } else {
        // Should never happen
        return c.json({ error: "Failed to create authorization" }, 500);
      }
    }
  )
  // Customer Portal: set/update subscription payment method
  .post(
    "/portal/set-subscription-payment-method",
    zValidator(
      "json",
      z.object({
        externalCustomerId: z.string().min(1),
        paymentMethodId: z.string().min(1),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { externalCustomerId, paymentMethodId } = c.req.valid("json");

      const customer = await db.query.customers.findFirst({
        where: and(
          eq(customers.externalCustomerId, externalCustomerId),
          eq(customers.merchantId, merchantId),
          isNull(customers.deletedAt)
        ),
      });
      if (!customer) return c.json({ error: "Customer not found" }, 404);

      const pm = await db.query.paymentMethods.findFirst({
        where: and(
          eq(paymentMethods.id, paymentMethodId),
          eq(paymentMethods.customerId, customer.id),
          isNull(paymentMethods.deletedAt)
        ),
      });
      if (!pm) return c.json({ error: "Payment method not found" }, 404);

      const activeSub = await getActiveSubscriptionForCustomer(
        merchantId,
        customer.id
      );
      if (!activeSub) return c.json({ error: "No active subscription" }, 404);

      await db
        .update(subscriptionDetails)
        .set({ paymentMethodId })
        .where(
          and(
            eq(subscriptionDetails.subscriptionId, activeSub.id),
            isNull(subscriptionDetails.deletedAt)
          )
        );

      return c.json({ success: true });
    }
  )
  // Customer Portal: remove a payment method (soft delete)
  .delete(
    "/portal/payment-methods/:id",
    zValidator("param", z.object({ id: z.string().min(1) })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const id = c.req.valid("param").id;

      const pm = await db.query.paymentMethods.findFirst({
        where: and(
          eq(paymentMethods.id, id),
          eq(paymentMethods.merchantId, merchantId),
          isNull(paymentMethods.deletedAt)
        ),
      });
      if (!pm) return c.json({ error: "Payment method not found" }, 404);

      await db
        .update(paymentMethods)
        .set({ deletedAt: new Date() })
        .where(eq(paymentMethods.id, id));

      // Optionally unlink from subscription details
      await db
        .update(subscriptionDetails)
        .set({ paymentMethodId: null })
        .where(eq(subscriptionDetails.paymentMethodId, id));

      return c.json({ success: true });
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
  // Get organization customers for a primary customer
  .get(
    "/:id/organization-customers",
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
        // Get the primary customer and verify they have an organization
        const primaryCustomer = await db.query.customers.findFirst({
          where: and(
            eq(customers.id, customerId),
            eq(customers.merchantId, merchantId),
            isNull(customers.deletedAt)
          ),
        });

        if (!primaryCustomer) {
          return c.json({ error: "Customer not found" }, 404);
        }

        if (!primaryCustomer.customerOrganizationId) {
          return c.json({
            organization: null,
            customers: [],
          });
        }

        // Get organization details
        const organization = await db.query.customerOrganizations.findFirst({
          where: and(
            eq(
              customerOrganizations.id,
              primaryCustomer.customerOrganizationId
            ),
            eq(customerOrganizations.merchantId, merchantId),
            isNull(customerOrganizations.deletedAt)
          ),
        });

        // Get ALL customers in the organization (primary + seats)
        const orgCustomers = await db.query.customers.findMany({
          where: and(
            eq(
              customers.customerOrganizationId,
              primaryCustomer.customerOrganizationId
            ),
            eq(customers.merchantId, merchantId),
            isNull(customers.deletedAt)
          ),
          orderBy: [
            sql`CASE WHEN org_role = 'primary' THEN 0 ELSE 1 END`, // Primary first
            customers.createdAt,
          ],
        });

        return c.json({
          organization,
          customers: orgCustomers,
        });
      } catch (error) {
        console.error("Error fetching organization customers:", error);
        return c.json({ error: "Failed to fetch organization customers" }, 500);
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
