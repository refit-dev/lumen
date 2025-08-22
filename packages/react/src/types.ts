import { z } from "zod";

export const FeatureSchema = z.object({
  text: z.string().min(1, "Feature text is required"),
});

export const PlanSchema = z.object({
  title: z.string().min(1, "Plan title is required"),
  description: z.string().optional(),
  price: z.number().min(0, "Price must be zero or more"),
  priceMonthly: z.number().optional(),
  priceYearly: z.number().optional(),
  interval: z.string().min(1, "Interval is required"),
  minSeats: z.number().optional(),
  features: z.array(FeatureSchema).optional(),
  buttonText: z.string().min(1, "Button text is required"),
  buttonOutline: z.boolean().optional(),
  isPopular: z.boolean().optional(),
  popularText: z.string().optional(),
  currency: z.string().optional(),
  planId: z.string().optional(), // The ID of the plan in the database
  priceId: z.string().optional(), // The ID of the selected price in the database
  priceIdMonthly: z.string().optional(), // The ID of the monthly price in the database
  priceIdYearly: z.string().optional(), // The ID of the yearly price in the database
  isEnterprisePlan: z.boolean().optional(),
  enterpriseRedirectUrl: z.string().optional(),
  // Trial information
  trial: z
    .object({
      available: z.boolean(),
      days: z.number(),
      trialPlanId: z.string(),
    })
    .optional(),
  // Pricing data with components for detailed pricing information
  pricingData: z
    .object({
      components: z
        .array(
          z
            .object({
              type: z.enum([
                "fixed",
                "per_unit",
                "usage",
              ]) as unknown as z.ZodType<"fixed" | "per_unit" | "usage">,
              label: z.string().optional(),
              amount_cents: z.number().optional(),
              unit_cost_cents: z.number().optional(),
              component_name: z.string().optional(),
              unit_label: z.string().optional(),
              metric_id: z.string().optional(),
            })
            .catchall(z.any())
        )
        .optional(),
      dsl_version: z.number().optional(),
    })
    .optional(),
  pspPlanId: z.string().optional(),
  // Additional fields added when a plan is selected from pricing table
  selectedBillingInterval: z.enum(["monthly", "yearly"]).optional(),
  selectedPrice: z.number().optional(),
});

export type Plan = z.infer<typeof PlanSchema>;

export const PricingTableSchema = z.object({
  heading: z.string().optional(),
  description: z.string().optional(),
  plans: z.array(PlanSchema),
});

export type PricingTableProps = z.infer<typeof PricingTableSchema>;
