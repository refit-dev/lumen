import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { slackLog } from "../helpers/slack";

// Used when users request access to Beta features
export const betaRouter = new Hono().post(
  "/request",
  zValidator(
    "json",
    z.object({
      email: z.string().email().optional(),
      name: z.string().min(1).optional(),
      message: z.string().min(1).optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    })
  ),
  async (c) => {
    const userEmail = c.get("user")?.email;
    const json = c.req.valid("json");
    const { metadata } = json;
    try {
      if (metadata?.paymentProvider) {
        await slackLog(
          `Beta request\n${userEmail}\n${metadata.paymentProvider}`
        );
      } else {
        await slackLog(
          `Weird Beta request\n${userEmail}\n${JSON.stringify(json, null, 2)}`
        );
      }
      return c.json({ message: "Beta request sent successfully" }, 200);
    } catch (error) {
      console.error(JSON.stringify(error, null, 2));
      return c.json({ error: "Failed to send beta request" }, 500);
    }
  }
);
