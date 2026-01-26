import { internalKeyValues } from "@lumen/common/schema";
import {
  EMAIL_DENYLIST_DOMAINS_KEY,
  EMAIL_DENYLIST_ADDRESSES_KEY,
} from "@lumen/common/utils";
import { eq } from "drizzle-orm";
import { type PostgresDB } from "@lumen/common";

const HARDCODED_DENYLIST_DOMAINS = ["getlumen.dev", "example.com"];

async function isEmailDenylistedDB(
  email: string,
  db: PostgresDB
): Promise<boolean> {
  try {
    const [domainsResult, addressesResult] = await Promise.all([
      db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_DOMAINS_KEY),
      }),
      db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_ADDRESSES_KEY),
      }),
    ]);

    const denylistedDomains = (domainsResult?.value as string[]) || [];
    denylistedDomains.push(...HARDCODED_DENYLIST_DOMAINS);
    const denylistedAddresses = (addressesResult?.value as string[]) || [];

    const emailLower = email.toLowerCase();
    const emailDomain = emailLower.split("@")[1];

    const isDomainDenylisted = denylistedDomains.some((domain) =>
      emailDomain?.includes(domain.toLowerCase())
    );
    const isAddressDenylisted = denylistedAddresses.some(
      (address) => address.toLowerCase() === emailLower
    );

    return isDomainDenylisted || isAddressDenylisted;
  } catch (error) {
    console.error("Error checking email denylist:", error);
    return false;
  }
}

async function isEmailDenylistedAPI(
  email: string,
  apiUrl: string,
  apiKey: string
): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/denylist/check-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ email }),
    });

    if (!response.ok) {
      console.error("Failed to check denylist via API", {
        status: response.status,
      });
      return false;
    }

    const { isDenylisted } = (await response.json()) as {
      isDenylisted: boolean;
    };
    return isDenylisted;
  } catch (error) {
    console.error("Error checking email denylist via API:", error);
    return false;
  }
}

export const isEmailDenylisted = async ({
  email,
  db,
  apiUrl,
  apiKey,
}: {
  email: string;
  db?: PostgresDB;
  apiUrl?: string | null;
  apiKey?: string | null;
}): Promise<boolean> => {
  if (db) {
    return await isEmailDenylistedDB(email, db);
  }
  if (!apiUrl || !apiKey) {
    throw new Error(
      "API URL and API key are required to check email denylist via API"
    );
  }
  return await isEmailDenylistedAPI(email, apiUrl, apiKey);
};
