import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import { internalKeyValues } from "@lumen/common/schema";
import { and, eq, isNull } from "drizzle-orm";
import { requireAdmin } from "../middleware/admin";

const updateSchema = z.object({
  value: z.any(),
});

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

export default internalKeyValuesRouter;
