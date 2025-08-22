import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../db/client";
import {
  features,
  FeatureType,
  featuresInsertSchema,
  featuresUpdateSchema,
  planFeatures,
  subscriptionFeatures,
} from "@lumen/common/schema";
import { and, eq, like, isNull, desc, or } from "drizzle-orm";
import { ID_PREFIXES, createPrefixValidator } from "@lumen/common";
import {
  addFeatureMetrics,
  removeFeatureMetrics,
  getMetricsForFeature,
} from "../lib/featureMetrics";
import { deleteFeatureAndReferences } from "../helpers/features";

// Custom validation schemas with additional business logic
export const featureCreateSchema = featuresInsertSchema
  .omit({
    id: true,
    merchantId: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    featureType: true, // We'll derive this from the value
  })
  .extend({
    featureValue: z
      .union([z.boolean(), z.number(), z.string().max(255)])
      .transform((val) => val),
    slug: z
      .string()
      .min(3)
      .max(50)
      .regex(
        /^[a-z0-9-]+$/,
        "Slug must contain only lowercase letters, numbers, and hyphens"
      )
      .transform((slug) => slug.toLowerCase()),
    metricIds: z
      .array(
        createPrefixValidator(
          ID_PREFIXES.metric,
          "Invalid metric ID format"
        )(z.string())
      )
      .optional(),
  })
  .strict();

export const featureUpdateSchema = featuresUpdateSchema
  .omit({
    id: true,
    merchantId: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    featureType: true, // We'll derive this from the value
  })
  .extend({
    featureValue: z
      .union([z.boolean(), z.number(), z.string().max(255)])
      .transform((val) => val)
      .optional(),
    metricIds: z
      .array(
        createPrefixValidator(
          ID_PREFIXES.metric,
          "Invalid metric ID format"
        )(z.string())
      )
      .optional(),
  })
  .partial();

// Simple filter - just basic text search is enough for a small set of features
export const featureFilterSchema = z.object({
  search: z.string().optional(),
});

// Schema for checking slug availability
export const checkSlugsSchema = z.object({
  slugs: z.array(z.string().min(1)).min(1).max(50), // Allow checking up to 50 slugs at once
});

// Schema for checking individual slug availability
export const checkSlugSchema = z.object({
  slug: z.string().min(1),
});

// Helper function to detect feature type
export function detectFeatureType(value: unknown): FeatureType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

// Create a router for feature routes
export const featuresRouter = new Hono()
  // Get all features with option for a simple text search
  .get("/", async (c) => {
    const merchantId = c.get("merchant")!.id;

    try {
      const { search } = c.req.query();

      // Build query conditions
      let conditions = and(
        eq(features.merchantId, merchantId),
        isNull(features.deletedAt)
      );

      // Add simple text search if provided
      if (search) {
        conditions = and(
          conditions,
          or(
            like(features.slug, `%${search}%`),
            like(features.displayName, `%${search}%`)
          )
        );
      }

      // Execute query
      const featuresList = await db
        .select()
        .from(features)
        .where(conditions)
        .orderBy(desc(features.createdAt));

      return c.json({ features: featuresList });
    } catch (error) {
      console.error("Error fetching features:", error);
      return c.json({ error: "Failed to fetch features" }, 500);
    }
  })

  .post("checkSlug", zValidator("json", checkSlugSchema), async (c) => {
    const merchantId = c.get("merchant")!.id;
    const { slug } = c.req.valid("json");

    const existingFeature = await db.query.features.findFirst({
      where: and(
        eq(features.merchantId, merchantId),
        eq(features.slug, slug),
        isNull(features.deletedAt)
      ),
    });

    return c.json({
      conflict: !!existingFeature as boolean,
    });
  })

  // Create a new feature
  .post("/", zValidator("json", featureCreateSchema), async (c) => {
    const merchantId = c.get("merchant")!.id;

    try {
      const featureData = c.req.valid("json");

      // Check if slug already exists for this merchant
      const existingFeature = await db.query.features.findFirst({
        where: and(
          eq(features.merchantId, merchantId),
          eq(features.slug, featureData.slug),
          isNull(features.deletedAt)
        ),
      });

      if (existingFeature) {
        return c.json({ error: "Feature with this slug already exists" }, 409);
      }

      // Determine the feature type based on the provided value
      const featureType = detectFeatureType(featureData.featureValue);

      // Create the feature - always use the authenticated merchantId
      const [feature] = await db
        .insert(features)
        .values({
          merchantId, // Only use the merchantId from authentication context
          slug: featureData.slug,
          displayName: featureData.displayName,
          description: featureData.description,
          featureType, // Store the feature type
          featureValue: featureData.featureValue, // Store the actual value
          isOverrideFeature: featureData.isOverrideFeature,
        })
        .returning();

      // Attach metrics if provided
      if (featureData.metricIds?.length) {
        await addFeatureMetrics(
          merchantId,
          feature.id,
          featureData.slug,
          featureData.metricIds
        );
      }

      return c.json({ feature, metricIds: featureData.metricIds ?? [] }, 201);
    } catch (error) {
      console.error("Error creating feature:", error);
      return c.json({ error: "Failed to create feature" }, 500);
    }
  })

  // Get a specific feature
  .get("/:featureId", async (c) => {
    const merchantId = c.get("merchant")!.id;
    const { featureId } = c.req.param();

    try {
      const feature = await db.query.features.findFirst({
        where: and(
          eq(features.id, featureId),
          eq(features.merchantId, merchantId),
          isNull(features.deletedAt)
        ),
      });

      if (!feature) {
        return c.json({ error: "Feature not found" }, 404);
      }

      // Include attached metrics
      const metricIds = await getMetricsForFeature(merchantId, featureId);
      return c.json({ feature, metricIds });
    } catch (error) {
      console.error("Error fetching feature:", error);
      return c.json({ error: "Failed to fetch feature" }, 500);
    }
  })

  // Update a feature
  .put("/:featureId", zValidator("json", featureUpdateSchema), async (c) => {
    const merchantId = c.get("merchant")!.id;
    const { featureId } = c.req.param();

    try {
      const updateData = c.req.valid("json");

      // Check if feature exists and belongs to merchant
      const existingFeature = await db.query.features.findFirst({
        where: and(
          eq(features.id, featureId),
          eq(features.merchantId, merchantId),
          isNull(features.deletedAt)
        ),
      });

      if (!existingFeature) {
        return c.json({ error: "Feature not found" }, 404);
      }

      // If trying to update slug, check if new slug already exists
      if (updateData.slug && updateData.slug !== existingFeature.slug) {
        const slugExists = await db.query.features.findFirst({
          where: and(
            eq(features.merchantId, merchantId),
            eq(features.slug, updateData.slug),
            isNull(features.deletedAt)
          ),
        });

        if (slugExists) {
          return c.json(
            { error: "Feature with this slug already exists" },
            409
          );
        }

        // Update the slug in all plan features using this feature
        await db
          .update(planFeatures)
          .set({
            featureSlug: updateData.slug,
          })
          .where(
            and(
              eq(planFeatures.featureId, featureId),
              isNull(planFeatures.deletedAt)
            )
          );

        // Update the slug in all subscription features using this feature
        await db
          .update(subscriptionFeatures)
          .set({
            featureSlug: updateData.slug,
          })
          .where(
            and(
              eq(subscriptionFeatures.featureId, featureId),
              isNull(subscriptionFeatures.deletedAt)
            )
          );

        // featureMetrics doesn't have a slug, so we don't need to update it
      }

      // If updating feature value, update the feature type as well
      let featureType = existingFeature.featureType;
      if (updateData.featureValue !== undefined) {
        featureType = detectFeatureType(updateData.featureValue);

        // When updating the feature value, also update values in relevant junction tables
        // First update all plan features using this feature
        await db
          .update(planFeatures)
          .set({
            featureValue: updateData.featureValue,
          })
          .where(
            and(
              eq(planFeatures.featureId, featureId),
              isNull(planFeatures.deletedAt)
            )
          );

        // Then update all subscription features that came from plans (not overrides)
        await db
          .update(subscriptionFeatures)
          .set({
            featureValue: updateData.featureValue,
          })
          .where(
            and(
              eq(subscriptionFeatures.featureId, featureId),
              eq(subscriptionFeatures.source, "plan"),
              isNull(subscriptionFeatures.deletedAt)
            )
          );

        // featureMetrics doesn't store value, so we don't need to update it
      }

      // Update the feature metadata
      const [updatedFeature] = await db
        .update(features)
        .set({
          ...updateData,
          featureType, // Update the feature type if value changed
          featureValue:
            updateData.featureValue !== undefined
              ? updateData.featureValue
              : existingFeature.featureValue, // Update value if provided
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(features.id, featureId),
            eq(features.merchantId, merchantId),
            isNull(features.deletedAt)
          )
        )
        .returning();

      // Sync metrics associations
      if (updateData.metricIds) {
        await removeFeatureMetrics(merchantId, featureId);
        if (updateData.metricIds.length) {
          await addFeatureMetrics(
            merchantId,
            featureId,
            updateData.slug || existingFeature.slug,
            updateData.metricIds
          );
        }
      }

      const metricIds =
        updateData.metricIds ??
        (await getMetricsForFeature(merchantId, featureId));
      return c.json({ feature: updatedFeature, metricIds });
    } catch (error) {
      console.error("Error updating feature:", error);
      return c.json({ error: "Failed to update feature" }, 500);
    }
  })

  // Delete a feature (soft delete)
  .delete("/:featureId", async (c) => {
    const merchantId = c.get("merchant")!.id;
    const { featureId } = c.req.param();

    try {
      // Check if feature exists and belongs to merchant
      const existingFeature = await db.query.features.findFirst({
        where: and(
          eq(features.id, featureId),
          eq(features.merchantId, merchantId),
          isNull(features.deletedAt)
        ),
      });

      if (!existingFeature) {
        return c.json({ error: "Feature not found" }, 404);
      }

      // Delete feature and its references
      const success = await deleteFeatureAndReferences(
        featureId,
        merchantId,
        db
      );

      if (!success) {
        return c.json({ error: "Failed to delete feature" }, 500);
      }

      return c.json({
        success: true,
        message: "Feature and all its references deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting feature:", error);
      return c.json({ error: "Failed to delete feature" }, 500);
    }
  });
