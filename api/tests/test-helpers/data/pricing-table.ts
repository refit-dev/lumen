import { db } from "../../../src/db/client";
import { pricingTables, pricingTablePlans } from "@lumen/common/schema";
import { ID_PREFIXES, createPrefixedId } from "@lumen/common";

/**
 * Create a pricing table for testing
 */
export async function createTestPricingTable(data: {
  merchantId: string;
  name: string;
  slug: string;
  description?: string;
  heading?: string;
  subheading?: string;
  isActive?: boolean;
  planIds?: string[]; // Optional array of plan IDs to associate with this pricing table
  planConfigs?: Array<{
    planId: string;
    displayOrder?: number;
    isPopular?: boolean;
    popularText?: string;
    buttonText?: string;
    buttonOutline?: boolean;
  }>;
}) {
  // Extract plan data
  const { planIds, planConfigs, ...pricingTableData } = data;

  // Start a transaction to ensure consistency
  return await db.transaction(async (tx) => {
    // Create the pricing table
    const [pricingTable] = await tx
      .insert(pricingTables)
      .values({
        id: createPrefixedId(ID_PREFIXES.pricingTable),
        merchantId: data.merchantId,
        name: data.name,
        slug: data.slug,
        description: data.description || `Description for ${data.name}`,
        heading: data.heading || data.name,
        subheading:
          data.subheading || data.description || `Subheading for ${data.name}`,
        isActive: data.isActive !== undefined ? data.isActive : true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    // If plan IDs are provided, create associations
    if (planIds && planIds.length > 0) {
      // Create a map of plan configs for quick lookup
      const configMap = new Map();
      if (planConfigs) {
        planConfigs.forEach((config) => {
          configMap.set(config.planId, config);
        });
      }

      // Create associations for each plan
      for (let i = 0; i < planIds.length; i++) {
        const planId = planIds[i];
        const config = configMap.get(planId) || {};

        await tx.insert(pricingTablePlans).values({
          id: createPrefixedId(ID_PREFIXES.pricingTablePlan),
          pricingTableId: pricingTable.id,
          planId,
          merchantId: data.merchantId,
          displayOrder:
            config.displayOrder !== undefined ? config.displayOrder : i + 1,
          isPopular: config.isPopular !== undefined ? config.isPopular : false,
          popularText: config.popularText || "Popular",
          buttonText: config.buttonText || "Get Started",
          buttonOutline:
            config.buttonOutline !== undefined ? config.buttonOutline : false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    return pricingTable;
  });
}

/**
 * Create a pricing table plan association for testing
 */
export async function createTestPricingTablePlan(data: {
  pricingTableId: string;
  planId: string;
  merchantId: string;
  displayOrder?: number;
  isPopular?: boolean;
  popularText?: string;
  buttonText?: string;
  buttonOutline?: boolean;
}) {
  // Create the pricing table plan
  const [pricingTablePlan] = await db
    .insert(pricingTablePlans)
    .values({
      id: createPrefixedId(ID_PREFIXES.pricingTablePlan),
      pricingTableId: data.pricingTableId,
      planId: data.planId,
      merchantId: data.merchantId,
      displayOrder: data.displayOrder || 1,
      isPopular: data.isPopular !== undefined ? data.isPopular : false,
      popularText: data.popularText || "Popular",
      buttonText: data.buttonText || "Get Started",
      buttonOutline:
        data.buttonOutline !== undefined ? data.buttonOutline : false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return pricingTablePlan;
}
