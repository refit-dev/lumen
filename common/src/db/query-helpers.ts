import { eq } from "drizzle-orm";
import { member, organization, merchants } from "./schema";
import { PostgresDB } from "./index";

/**
 * Get organization information by userId
 *
 * @param userId The ID of the user to find organizations for
 * @returns Array of organizations associated with the user
 */
export async function getOrganizationsByUserId(db: PostgresDB, userId: string) {
  return db
    .select()
    .from(organization)
    .innerJoin(member, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId));
}

/**
 * Get organization with related merchant data by userId
 *
 * @param userId The ID of the user to find organization and merchant data for
 * @returns Array of organizations with related merchant data
 */
export async function getOrganizationAndMerchantByUserId(
  db: PostgresDB,
  userId: string
) {
  return db
    .select()
    .from(organization)
    .innerJoin(member, eq(organization.id, member.organizationId))
    .leftJoin(merchants, eq(merchants.organizationId, organization.id))
    .where(eq(member.userId, userId));
}

/**
 * Get merchant by userId
 *
 * @param userId The ID of the user to find merchant for
 * @returns Array of merchants
 */
export async function getMerchantByUserId(db: PostgresDB, userId: string) {
  return db
    .select({
      id: merchants.id,
      legalName: merchants.legalName,
      defaultCurrency: merchants.defaultCurrency,
      displayName: merchants.displayName,
    })
    .from(merchants)
    .where(eq(merchants.userId, userId));
}
