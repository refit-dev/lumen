import { Hono } from "hono";
import { db } from "../db/client";
import {
  merchantTaxConfig,
  taxRegistrations,
  usNexusConfig,
  taxRateDefinitions,
  merchantTaxConfigUpdateSchema,
  taxRegistrationsInsertSchema,
  usNexusConfigUpdateSchema,
  taxRateDefinitionsInsertSchema,
  taxRateDefinitionsUpdateSchema,
  merchantTaxConfigSelectSchemaAPI,
  usNexusConfigSelectSchemaAPI,
  type MerchantTaxConfigFromApi,
  type UsNexusConfigFromApi,
} from "@lumen/common/schema";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import { calculateTaxes } from "../helpers/tax-engine";
import { usStates } from "@lumen/common/utils";

// Validation schemas
const taxConfigUpdateSchema = merchantTaxConfigUpdateSchema
  .omit({
    id: true,
    merchantId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    // Add explicit validation for defaultTaxRate to ensure it's a valid decimal string or null
    defaultTaxRate: z
      .string()
      .nullable()
      .optional()
      .refine((val) => {
        if (val === null || val === undefined || val === "") {
          return true; // Allow null/empty values
        }
        // Check if it matches decimal format
        if (!/^\d+(\.\d{1,4})?$/.test(val)) {
          return false;
        }
        const num = parseFloat(val);
        return num >= 0 && num <= 1;
      }, "Tax rate must be a valid decimal number between 0 and 1 (e.g., '0.0875' for 8.75%) or null"),
  });

const taxCalculationPreviewSchema = z.object({
  customerId: z.string(),
  amount: z.number().positive(),
  currency: z.string(),
  lineItems: z
    .array(
      z.object({
        type: z.string(),
        description: z.string(),
        subtotalCents: z.number(),
        componentId: z.string().optional(),
        priceId: z.string().optional(),
        billingPeriodStart: z.coerce.date(),
        billingPeriodEnd: z.coerce.date(),
      })
    )
    .optional()
    .default([]),
});

const nexusConfigSchema = usNexusConfigUpdateSchema.omit({
  id: true,
  merchantId: true,
  createdAt: true,
  updatedAt: true,
});

const taxRateDefinitionCreateSchema = taxRateDefinitionsInsertSchema
  .omit({
    id: true,
    merchantId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    // Add explicit validation for taxRate to ensure it's a valid decimal string
    taxRate: z
      .string()
      .regex(
        /^\d+(\.\d{1,4})?$/,
        "Tax rate must be a valid decimal number (e.g., '0.0875' for 8.75%)"
      )
      .refine((val) => {
        const num = parseFloat(val);
        return num >= 0 && num <= 1;
      }, "Tax rate must be between 0 and 1 (0% to 100%)"),
  });

const taxRateDefinitionUpdateSchemaApi = taxRateDefinitionsUpdateSchema
  .omit({
    id: true,
    merchantId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    // Add explicit validation for taxRate to ensure it's a valid decimal string (same as create schema)
    taxRate: z
      .string()
      .regex(
        /^\d+(\.\d{1,4})?$/,
        "Tax rate must be a valid decimal number (e.g., '0.0875' for 8.75%)"
      )
      .refine((val) => {
        const num = parseFloat(val);
        return num >= 0 && num <= 1;
      }, "Tax rate must be between 0 and 1 (0% to 100%)")
      .optional(), // Make it optional for updates
  });

const taxRegistrationCreateSchema = taxRegistrationsInsertSchema.omit({
  id: true,
  merchantId: true,
  createdAt: true,
  updatedAt: true,
});

export const taxRouter = new Hono()
  // Get merchant tax configuration
  .get("/config", async (c) => {
    try {
      const merchantId = c.get("merchant")!.id;

      const config = await db.query.merchantTaxConfig.findFirst({
        where: eq(merchantTaxConfig.merchantId, merchantId),
      });

      // Return default config if none exists
      if (!config) {
        return c.json({
          autoTaxCalculation: false,
          defaultTaxRate: null,
        });
      }

      const sanitizedCfgObj = {
        ...config,
        createdAt: config.createdAt.toISOString(),
        updatedAt: config.updatedAt.toISOString(),
      };
      const parsedCfg = merchantTaxConfigSelectSchemaAPI.parse(sanitizedCfgObj);
      return c.json(parsedCfg);
    } catch (error) {
      console.error("Error fetching tax config:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })

  // Update merchant tax configuration
  .post(
    "/config/update",
    zValidator("json", taxConfigUpdateSchema),
    async (c) => {
      try {
        const merchantId = c.get("merchant")!.id;

        const data = c.req.valid("json");

        // Check if config exists
        const existingConfig = await db.query.merchantTaxConfig.findFirst({
          where: eq(merchantTaxConfig.merchantId, merchantId),
        });

        let updatedConfig;

        if (existingConfig) {
          // Update existing config
          [updatedConfig] = await db
            .update(merchantTaxConfig)
            .set({
              ...data,
              updatedAt: new Date(),
            })
            .where(eq(merchantTaxConfig.id, existingConfig.id))
            .returning();
        } else {
          // Create new config
          [updatedConfig] = await db
            .insert(merchantTaxConfig)
            .values({
              merchantId,
              ...data,
            })
            .returning();
        }

        const sanitizedConfigObj = {
          ...updatedConfig,
          createdAt: updatedConfig.createdAt.toISOString(),
          updatedAt: updatedConfig.updatedAt.toISOString(),
        };
        const parsedConfig =
          merchantTaxConfigSelectSchemaAPI.parse(sanitizedConfigObj);
        return c.json<MerchantTaxConfigFromApi>(parsedConfig);
      } catch (error) {
        console.error("Error updating tax config:", error);

        if (error instanceof z.ZodError) {
          const formattedErrors = error.errors.map((err) => ({
            code: err.code,
            message: err.message,
            path: err.path.map((p) => String(p)),
          }));
          return c.json({ error: formattedErrors }, 400);
        }

        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )

  // Get US Nexus configurations
  .get("/nexus", async (c) => {
    try {
      const merchantId = c.get("merchant")!.id;

      const nexusConfigs = await db.query.usNexusConfig.findMany({
        where: eq(usNexusConfig.merchantId, merchantId),
      });

      return c.json(nexusConfigs);
    } catch (error) {
      console.error("Error fetching nexus configs:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })

  // Update US Nexus configuration for a specific state
  .post(
    "/nexus/:state/update",
    zValidator("json", nexusConfigSchema),
    async (c) => {
      try {
        const merchantId = c.get("merchant")!.id;

        const state = c.req.param("state");
        const data = c.req.valid("json");

        // Use the shared list of US states from common utils to avoid maintaining multiple sources of truth
        const validStateCodes = new Set(
          usStates.map((s) => s.value.toUpperCase())
        );

        if (
          !state ||
          state.length !== 2 ||
          !validStateCodes.has(state.toUpperCase())
        ) {
          return c.json({ error: "Invalid US state or territory code" }, 400);
        }

        // Check if nexus config exists for this state
        const existingConfig = await db.query.usNexusConfig.findFirst({
          where: and(
            eq(usNexusConfig.merchantId, merchantId),
            eq(usNexusConfig.state, state.toUpperCase())
          ),
        });

        let updatedConfig;

        if (existingConfig) {
          // Update existing config
          [updatedConfig] = await db
            .update(usNexusConfig)
            .set({
              ...data,
              updatedAt: new Date(),
            })
            .where(eq(usNexusConfig.id, existingConfig.id))
            .returning();
        } else {
          // Create new config
          [updatedConfig] = await db
            .insert(usNexusConfig)
            .values({
              merchantId,
              state: state.toUpperCase(),
              ...data,
            })
            .returning();
        }

        const sanitizedNexusObj = {
          ...updatedConfig,
          createdAt: updatedConfig.createdAt.toISOString(),
          updatedAt: updatedConfig.updatedAt.toISOString(),
        };
        const parsedNexus =
          usNexusConfigSelectSchemaAPI.parse(sanitizedNexusObj);
        return c.json<UsNexusConfigFromApi>(parsedNexus);
      } catch (error) {
        console.error("Error updating nexus config:", error);

        if (error instanceof z.ZodError) {
          const formattedErrors = error.errors.map((err) => ({
            code: err.code,
            message: err.message,
            path: err.path.map((p) => String(p)),
          }));
          return c.json({ error: formattedErrors }, 400);
        }

        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )

  // Get tax rate definitions
  .get("/rate-definitions", async (c) => {
    try {
      const merchantId = c.get("merchant")!.id;

      const rateDefinitions = await db.query.taxRateDefinitions.findMany({
        where: and(
          eq(taxRateDefinitions.merchantId, merchantId),
          eq(taxRateDefinitions.isActive, true)
        ),
      });

      return c.json(rateDefinitions);
    } catch (error) {
      console.error("Error fetching tax rate definitions:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })

  // Create tax rate definition
  .post(
    "/rate-definitions/create",
    zValidator("json", taxRateDefinitionCreateSchema),
    async (c) => {
      try {
        const merchantId = c.get("merchant")!.id;

        const data = c.req.valid("json");

        const [rateDefinition] = await db
          .insert(taxRateDefinitions)
          .values({
            merchantId,
            ...data,
          })
          .returning();

        return c.json(rateDefinition, 201);
      } catch (error) {
        console.error("Error creating tax rate definition:", error);

        if (error instanceof z.ZodError) {
          const formattedErrors = error.errors.map((err) => ({
            code: err.code,
            message: err.message,
            path: err.path.map((p) => String(p)),
          }));
          return c.json({ error: formattedErrors }, 400);
        }

        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )

  // Update tax rate definition
  .post(
    "/rate-definitions/:id/update",
    zValidator("json", taxRateDefinitionUpdateSchemaApi),
    async (c) => {
      try {
        const merchantId = c.get("merchant")!.id;

        const id = c.req.param("id");
        const data = c.req.valid("json");

        const [updatedRateDefinition] = await db
          .update(taxRateDefinitions)
          .set({
            ...data,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(taxRateDefinitions.id, id),
              eq(taxRateDefinitions.merchantId, merchantId)
            )
          )
          .returning();

        if (!updatedRateDefinition) {
          return c.json({ error: "Tax rate definition not found" }, 404);
        }

        return c.json(updatedRateDefinition);
      } catch (error) {
        console.error("Error updating tax rate definition:", error);

        if (error instanceof z.ZodError) {
          const formattedErrors = error.errors.map((err) => ({
            code: err.code,
            message: err.message,
            path: err.path.map((p) => String(p)),
          }));
          return c.json({ error: formattedErrors }, 400);
        }

        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )

  // Get tax registrations
  .get("/registrations", async (c) => {
    try {
      const merchantId = c.get("merchant")!.id;

      const registrations = await db.query.taxRegistrations.findMany({
        where: and(
          eq(taxRegistrations.merchantId, merchantId),
          eq(taxRegistrations.isActive, true)
        ),
      });

      return c.json(registrations);
    } catch (error) {
      console.error("Error fetching tax registrations:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })

  // Create tax registration
  .post(
    "/registrations/create",
    zValidator("json", taxRegistrationCreateSchema),
    async (c) => {
      try {
        const merchantId = c.get("merchant")!.id;

        const data = c.req.valid("json");

        const [registration] = await db
          .insert(taxRegistrations)
          .values({
            merchantId,
            ...data,
          })
          .returning();

        return c.json(registration, 201);
      } catch (error) {
        console.error("Error creating tax registration:", error);

        if (error instanceof z.ZodError) {
          const formattedErrors = error.errors.map((err) => ({
            code: err.code,
            message: err.message,
            path: err.path.map((p) => String(p)),
          }));
          return c.json({ error: formattedErrors }, 400);
        }

        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )

  // Tax calculation preview for testing
  .post(
    "/calculate-preview",
    zValidator("json", taxCalculationPreviewSchema),
    async (c) => {
      try {
        const merchantId = c.get("merchant")!.id;

        const data = c.req.valid("json");

        const taxResult = await calculateTaxes({
          merchantId,
          customerId: data.customerId,
          subtotalAfterCredits: data.amount,
          lineItems: data.lineItems,
          currency: data.currency,
          billingDate: new Date(),
        });

        return c.json(taxResult);
      } catch (error) {
        console.error("Error calculating tax preview:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  );
