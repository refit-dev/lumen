import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../db/client";
import { and, eq, isNull } from "drizzle-orm";
import { planEnrollmentRules } from "@lumen/common/schema";
import { createPrefixValidator, ID_PREFIXES } from "@lumen/common";
import {
  createEnrollmentSubscriptionForUser,
  enrollmentSubscriptionSchema,
} from "../helpers/create-enrollment-subscription";

export const enrollmentRouter = new Hono()
  // List rules for a plan
  .get(
    "/rules",
    zValidator(
      "query",
      z.object({
        planId: createPrefixValidator(ID_PREFIXES.plan)(z.string()),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { planId } = c.req.valid("query");

      const rules = await db.query.planEnrollmentRules.findMany({
        where: and(
          eq(planEnrollmentRules.merchantId, merchantId),
          eq(planEnrollmentRules.planId, planId),
          isNull(planEnrollmentRules.deletedAt)
        ),
      });

      return c.json({ rules });
    }
  )
  // Create a rule
  .post(
    "/rules",
    zValidator(
      "json",
      z.object({
        planId: createPrefixValidator(ID_PREFIXES.plan)(z.string()),
        matcherType: z.enum(["email", "domain"]),
        matcherValue: z.string().min(1),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { planId, matcherType, matcherValue } = c.req.valid("json");

      const [rule] = await db
        .insert(planEnrollmentRules)
        .values({
          merchantId,
          planId,
          matcherType,
          matcherValue,
        })
        .returning();

      return c.json({ rule }, 201);
    }
  )
  // Delete (soft-delete) a rule
  .delete(
    "/rules/:id",
    zValidator(
      "param",
      z.object({
        id: createPrefixValidator(ID_PREFIXES.planEnrollmentRule)(z.string()),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { id } = c.req.valid("param");

      await db
        .update(planEnrollmentRules)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(planEnrollmentRules.id, id),
            eq(planEnrollmentRules.merchantId, merchantId)
          )
        );

      return c.json({ success: true });
    }
  )
  // Enroll a user (create subscription)
  .post(
    "/enroll",
    zValidator(
      "json",
      enrollmentSubscriptionSchema.extend({ planId: z.string().optional() })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const data = c.req.valid("json");

      const [result, code] = await createEnrollmentSubscriptionForUser({
        ...data,
        merchantId,
      });

      return c.json(result, code);
    }
  );

export default enrollmentRouter;
