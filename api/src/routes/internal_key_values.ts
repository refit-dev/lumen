import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import { internalKeyValues } from "@lumen/common/schema";
import { and, eq, isNull } from "drizzle-orm";
import { requireAdmin } from "../middleware/admin";
import { isEmailDenylisted } from "../helpers/emailDenylist";
import {
  EMAIL_DENYLIST_DOMAINS_KEY,
  EMAIL_DENYLIST_ADDRESSES_KEY,
} from "@lumen/common/utils";

const updateSchema = z.object({
  value: z.any(),
});

const checkEmailDenylistSchema = z.object({
  email: z.string().email(),
});

const emailDenylistManageSchema = z.object({
  email: z.string().min(1),
});

export const internalDenyListRouter = new Hono()
  .post(
    "/check-email",
    zValidator("json", checkEmailDenylistSchema),
    async (c) => {
      const { email } = c.req.valid("json");
      const isDenylisted = await isEmailDenylisted({ email, db });
      return c.json({ isDenylisted });
    }
  )
  .post(
    "/add-email",
    zValidator("json", emailDenylistManageSchema),
    async (c) => {
      const { email } = c.req.valid("json");
      const emailLower = email.toLowerCase();
      const isDomain = !emailLower.includes("@");

      const key = isDomain
        ? EMAIL_DENYLIST_DOMAINS_KEY
        : EMAIL_DENYLIST_ADDRESSES_KEY;

      const existing = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, key),
      });

      const currentList = ((existing?.value as string[]) || []).map((item) =>
        item.toLowerCase()
      );

      if (currentList.includes(emailLower)) {
        return c.json({
          message: `${isDomain ? "Domain" : "Email"} already in denylist`,
          added: false,
        });
      }

      currentList.push(emailLower);

      if (existing) {
        await db
          .update(internalKeyValues)
          .set({ value: currentList, updatedAt: new Date() })
          .where(eq(internalKeyValues.key, key));
      } else {
        await db.insert(internalKeyValues).values({ key, value: currentList });
      }

      return c.json({
        message: `${isDomain ? "Domain" : "Email"} added to denylist`,
        added: true,
      });
    }
  )
  .post(
    "/remove-email",
    zValidator("json", emailDenylistManageSchema),
    async (c) => {
      const { email } = c.req.valid("json");
      const emailLower = email.toLowerCase();
      const isDomain = !emailLower.includes("@");

      const key = isDomain
        ? EMAIL_DENYLIST_DOMAINS_KEY
        : EMAIL_DENYLIST_ADDRESSES_KEY;

      const existing = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, key),
      });

      if (!existing) {
        return c.json({
          message: `${isDomain ? "Domain" : "Email"} not found in denylist`,
          removed: false,
        });
      }

      const currentList = ((existing.value as string[]) || []).map((item) =>
        item.toLowerCase()
      );

      if (!currentList.includes(emailLower)) {
        return c.json({
          message: `${isDomain ? "Domain" : "Email"} not found in denylist`,
          removed: false,
        });
      }

      const newList = currentList.filter((item) => item !== emailLower);

      await db
        .update(internalKeyValues)
        .set({ value: newList, updatedAt: new Date() })
        .where(eq(internalKeyValues.key, key));

      return c.json({
        message: `${isDomain ? "Domain" : "Email"} removed from denylist`,
        removed: true,
      });
    }
  );

export const internalKeyValuesRouter = new Hono()
  .use(requireAdmin)
  .get("/internal-key-values", async (c) => {
    const rows = await db.query.internalKeyValues.findMany({
      where: isNull(internalKeyValues.deletedAt),
      columns: {
        key: true,
        value: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return c.json({ items: rows });
  })
  .get("/internal-key-values/:key", async (c) => {
    const { key } = c.req.param();
    const row = await db.query.internalKeyValues.findFirst({
      where: and(
        eq(internalKeyValues.key, key),
        isNull(internalKeyValues.deletedAt)
      ),
    });
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ item: row });
  })
  .put(
    "/internal-key-values/:key",
    zValidator("json", updateSchema),
    async (c) => {
      const { key } = c.req.param();
      const { value } = c.req.valid("json");

      const existing = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, key),
      });

      if (existing) {
        const [updated] = await db
          .update(internalKeyValues)
          .set({ value, updatedAt: new Date(), deletedAt: null })
          .where(eq(internalKeyValues.key, key))
          .returning();
        return c.json({ item: updated });
      }

      const [created] = await db
        .insert(internalKeyValues)
        .values({ key, value })
        .returning();
      return c.json({ item: created }, 201);
    }
  );
