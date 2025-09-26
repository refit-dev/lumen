import { db } from "../db/client";
import {
  customers,
  customersInsertSchemaReq,
  customersUpdateSchema,
} from "@lumen/common/schema";
import { eq, and, isNull, not, sql, SQL } from "drizzle-orm";
import { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { TransactionType } from "./index";

export function lower(email: PgColumn): SQL {
  return sql`lower(${email})`;
}

interface UpsertCustomerOptionsBase {
  email?: string;
  name?: string;
  merchantId: string;
  businessName?: string;
  billingAddressLine1?: string;
  billingAddressLine2?: string;
  billingCity?: string;
  billingPostalCode?: string;
  billingCountry?: string;
  billingStateProvince?: string;
  taxId?: string;
  metadata?: Record<string, unknown>;
  dangerouslyAllowCustomerWithoutEmail?: boolean;
  dangerouslyAllowSameEmailForDifferentCustomers?: boolean;
  tx: TransactionType;
}

interface UpsertCustomerWithInternalId extends UpsertCustomerOptionsBase {
  customerId: string;
  externalCustomerId?: string; // Can be provided to set/update on the customer
}

interface UpsertCustomerWithExternalId extends UpsertCustomerOptionsBase {
  customerId?: undefined;
  externalCustomerId: string;
}

export type UpsertCustomerOptions =
  | UpsertCustomerWithInternalId
  | UpsertCustomerWithExternalId;

/**
 * Find or create a customer.
 * Requires either customerId or externalCustomerId to be provided.
 * @param options The customer data and options
 * @returns The customer record
 */
export async function upsertCustomer(options: UpsertCustomerOptions) {
  const {
    merchantId,
    email,
    name,
    dangerouslyAllowCustomerWithoutEmail = false,
    dangerouslyAllowSameEmailForDifferentCustomers = false,
  } = options;

  // Check that email is present
  if (!email && !dangerouslyAllowCustomerWithoutEmail) {
    throw new Error(
      "Email is required unless dangerouslyAllowCustomerWithoutEmail is set to true"
    );
  }

  // Try to find an existing customer
  let customer: typeof customers.$inferSelect | undefined;
  const tx = options.tx;

  if (options.customerId) {
    console.log(`Finding customer with id ${options.customerId}`);
    customer = await tx.query.customers.findFirst({
      where: and(
        eq(customers.id, options.customerId),
        eq(customers.merchantId, merchantId), // Ensure merchant owns this customerId
        isNull(customers.deletedAt)
      ),
    });
  } else if (options.externalCustomerId) {
    // This branch is taken if customerId is not provided.
    // Per UpsertCustomerWithExternalId, options.externalCustomerId must be a string.
    console.log(
      `Finding customer with external id ${options.externalCustomerId}`
    );
    customer = await tx.query.customers.findFirst({
      where: and(
        eq(customers.externalCustomerId, options.externalCustomerId), // Now options.externalCustomerId is a string
        eq(customers.merchantId, merchantId),
        isNull(customers.deletedAt)
      ),
    });
  } else {
    throw new Error("Either customerId or externalCustomerId must be provided");
  }

  // If customer doesn't exist, create a new one
  if (!customer) {
    console.log(`Customer not found, creating new one`);
    // Check if the email is already in use (additional check to handle race conditions)
    if (email && !dangerouslyAllowSameEmailForDifferentCustomers) {
      const existingCustomerByEmail = await tx.query.customers.findFirst({
        where: and(
          eq(lower(customers.email), email.toLowerCase()),
          eq(customers.merchantId, merchantId),
          isNull(customers.deletedAt)
        ),
      });

      if (existingCustomerByEmail) {
        // If an existing customer is found for this email, merge instead of creating a new one.
        // Attach externalCustomerId if not already set; if set to a different value, throw.
        if (
          options.externalCustomerId &&
          existingCustomerByEmail.externalCustomerId &&
          existingCustomerByEmail.externalCustomerId !==
            options.externalCustomerId
        ) {
          throw new Error(
            "This email is already linked to a different external customer ID."
          );
        }

        const mergedMetadata = {
          ...(existingCustomerByEmail.metadata || {}),
          ...(options.metadata || {}),
        } as Record<string, unknown> | undefined;

        const [mergedCustomer] = await tx
          .update(customers)
          .set({
            // Prefer preserving existing non-null fields; only update when a new value is provided
            name: options.name ?? existingCustomerByEmail.name ?? null,
            businessName:
              options.businessName ??
              existingCustomerByEmail.businessName ??
              null,
            email: existingCustomerByEmail.email, // keep canonical email
            externalCustomerId:
              options.externalCustomerId ||
              existingCustomerByEmail.externalCustomerId ||
              null,
            billingAddressLine1:
              options.billingAddressLine1 ??
              existingCustomerByEmail.billingAddressLine1 ??
              null,
            billingAddressLine2:
              options.billingAddressLine2 ??
              existingCustomerByEmail.billingAddressLine2 ??
              null,
            billingCity:
              options.billingCity ??
              existingCustomerByEmail.billingCity ??
              null,
            billingPostalCode:
              options.billingPostalCode ??
              existingCustomerByEmail.billingPostalCode ??
              null,
            billingCountry:
              options.billingCountry ??
              existingCustomerByEmail.billingCountry ??
              null,
            billingStateProvince:
              options.billingStateProvince ??
              existingCustomerByEmail.billingStateProvince ??
              null,
            taxId: options.taxId ?? existingCustomerByEmail.taxId ?? null,
            metadata: mergedMetadata,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(customers.id, existingCustomerByEmail.id),
              eq(customers.merchantId, merchantId)
            )
          )
          .returning();

        customer = mergedCustomer;
        console.log(`Merged with existing customer by email: ${customer.id}`);
      }
    }

    // Create new customer (only if we didn't merge by email above)
    if (!customer) {
      const [newCustomer] = await tx
        .insert(customers)
        .values({
          merchantId: options.merchantId,
          name: options.name,
          businessName: options.businessName,
          email: options.email,
          externalCustomerId: options.externalCustomerId, // Will be string or undefined (if looked up by customerId and not provided)
          billingAddressLine1: options.billingAddressLine1,
          billingAddressLine2: options.billingAddressLine2,
          billingCity: options.billingCity,
          billingPostalCode: options.billingPostalCode,
          billingCountry: options.billingCountry,
          billingStateProvince: options.billingStateProvince,
          taxId: options.taxId,
          metadata: options.metadata,
        })
        .returning();

      customer = newCustomer;
      console.log(`Customer created: ${customer.id}`);
    }
  }

  return customer;
}

export type CreateCustomerOptions = z.infer<typeof customersInsertSchemaReq>;

export async function createCustomer(
  merchantId: string,
  options: CreateCustomerOptions
) {
  const {
    email,
    dangerouslyAllowCustomerWithoutEmail = false,
    dangerouslyAllowSameEmailForDifferentCustomers = false,
    ...customerData
  } = options;

  if (!email && !dangerouslyAllowCustomerWithoutEmail) {
    throw new Error(
      "Email is required unless dangerouslyAllowCustomerWithoutEmail is set to true"
    );
  }

  if (email && !dangerouslyAllowSameEmailForDifferentCustomers) {
    const existingCustomerByEmail = await db.query.customers.findFirst({
      where: and(
        eq(lower(customers.email), email.toLowerCase()),
        eq(customers.merchantId, merchantId),
        isNull(customers.deletedAt)
      ),
    });
    if (existingCustomerByEmail) {
      throw new Error(
        "A customer with this email already exists. Use dangerouslyAllowSameEmailForDifferentCustomers to allow multiple customers with the same email."
      );
    }
  }

  const [newCustomer] = await db
    .insert(customers)
    .values({
      ...customerData,
      email,
      merchantId,
    })
    .returning();

  return newCustomer;
}

export type UpdateCustomerOptions = z.infer<typeof customersUpdateSchema>;

export async function updateCustomer(
  merchantId: string,
  customerId: string,
  options: UpdateCustomerOptions
) {
  const { email, ...customerData } = options;

  const existingCustomer = await db.query.customers.findFirst({
    where: and(
      eq(customers.id, customerId),
      eq(customers.merchantId, merchantId),
      isNull(customers.deletedAt)
    ),
  });

  if (!existingCustomer) {
    throw new Error("Customer not found or access denied");
  }

  if (email && email.toLowerCase() !== existingCustomer.email?.toLowerCase()) {
    const customerWithNewEmail = await db.query.customers.findFirst({
      where: and(
        eq(lower(customers.email), email.toLowerCase()),
        eq(customers.merchantId, merchantId),
        isNull(customers.deletedAt),
        not(eq(customers.id, customerId))
      ),
    });
    if (customerWithNewEmail) {
      throw new Error("Another customer with this email already exists");
    }
  }

  const [updatedCustomerRecord] = await db
    .update(customers)
    .set({
      ...customerData,
      ...(email && { email }), // only set email if it's provided
      updatedAt: new Date(),
    })
    .where(
      and(eq(customers.id, customerId), eq(customers.merchantId, merchantId))
    )
    .returning();

  if (!updatedCustomerRecord) {
    throw new Error("Customer update failed");
  }

  return updatedCustomerRecord;
}
