import {
  plansSelectSchema,
  plansInsertSchema,
  plansUpdateSchema,
} from "@lumen/common/schema";
import {
  pricesSelectSchema,
  pricesInsertSchema,
  pricesUpdateSchema,
} from "@lumen/common/schema";
import {
  merchantsSelectSchema,
  merchantsInsertSchema,
  merchantsUpdateSchema,
} from "@lumen/common/schema";
import {
  featuresSelectSchema,
  featuresInsertSchema,
  featuresUpdateSchema,
} from "@lumen/common/schema";
import {
  customersSelectSchema,
  customersInsertSchema,
  customersUpdateSchema,
} from "@lumen/common/schema";
import { z } from "zod";
import { organization } from "@lumen/common/schema";
import { createInsertSchema, createUpdateSchema } from "drizzle-zod";

export const OrganizationInsertSchema = createInsertSchema(organization);
export const OrganizationUpdateSchema = createUpdateSchema(organization);

// Use the zod types from the schema
export type FeatureInsert = z.infer<typeof featuresInsertSchema>;
export type FeatureSelect = z.infer<typeof featuresSelectSchema>;
export type FeatureUpdate = z.infer<typeof featuresUpdateSchema>;
export type Merchant = z.infer<typeof merchantsSelectSchema>;
export type MerchantInsert = z.infer<typeof merchantsInsertSchema>;
export type MerchantUpdate = z.infer<typeof merchantsUpdateSchema>;
export type OrganizationInsert = z.infer<typeof OrganizationInsertSchema>;
export type OrganizationUpdate = z.infer<typeof OrganizationUpdateSchema>;
export type PlanSelect = z.infer<typeof plansSelectSchema>;
export type PlanInsert = z.infer<typeof plansInsertSchema>;
export type PlanUpdate = z.infer<typeof plansUpdateSchema>;
export type PriceSelect = z.infer<typeof pricesSelectSchema>;
export type PriceInsert = z.infer<typeof pricesInsertSchema>;
export type PriceUpdate = z.infer<typeof pricesUpdateSchema>;
export type Customer = z.infer<typeof customersSelectSchema>;
export type CustomerInsert = z.infer<typeof customersInsertSchema>;
export type CustomerUpdate = z.infer<typeof customersUpdateSchema>;

// Test data options
export interface TestUserProps {
  name?: string;
  email?: string;
  password?: string;
}

// Auth response type
export interface AuthResponse {
  status: number;
  cookies: {
    sessionToken: string;
  };
  body: {
    user: {
      id: string;
      name: string;
      email: string;
    };
  };
}

export interface TestFeature {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  featureValue: boolean | number | string;
  merchantId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  isOverrideFeature: boolean | null;
}

export type PlanWithPrice = PriceSelect & { plan: PlanSelect };
