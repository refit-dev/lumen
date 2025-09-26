import { Hono } from "hono";
import { z } from "zod";
import { createEnrollmentSubscriptionForUser } from "../helpers/create-enrollment-subscription";

// Supabase webhook payload schema
const supabaseWebhookSchema = z.object({
  type: z.literal("INSERT"),
  table: z.literal("users"),
  record: z.object({
    id: z.string(),
    email: z.string().email(),
    raw_user_meta_data: z
      .object({
        name: z.string().optional(),
        full_name: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
      })
      .optional(),
    user_metadata: z
      .object({
        name: z.string().optional(),
        full_name: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
      })
      .optional(),
  }),
});

// Clerk webhook payload schema
const clerkWebhookSchema = z.object({
  type: z.literal("user.created"),
  data: z.object({
    id: z.string(),
    email_addresses: z.array(
      z.object({
        email_address: z.string().email(),
        id: z.string(),
      })
    ),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    username: z.string().nullable(),
  }),
});

// Extract name from Supabase user data
function extractNameFromSupabaseUser(record: any): string {
  const metadata = record.raw_user_meta_data || record.user_metadata || {};

  // Try various name combinations
  if (metadata.name) return metadata.name;
  if (metadata.full_name) return metadata.full_name;
  if (metadata.first_name && metadata.last_name) {
    return `${metadata.first_name} ${metadata.last_name}`;
  }
  if (metadata.first_name) return metadata.first_name;
  if (metadata.last_name) return metadata.last_name;

  // Fallback to email username
  return record.email.split("@")[0];
}

// Extract name from Clerk user data
function extractNameFromClerkUser(data: any): string {
  if (data.first_name && data.last_name) {
    return `${data.first_name} ${data.last_name}`;
  }
  if (data.first_name) return data.first_name;
  if (data.last_name) return data.last_name;
  if (data.username) return data.username;

  // Fallback to email username
  const primaryEmail = data.email_addresses[0];
  return primaryEmail ? primaryEmail.email_address.split("@")[0] : "User";
}

// Handle webhook errors
function handleWebhookError(c: any, error: any, service: string) {
  console.error(`${service} webhook error:`, error);
  return c.json(
    {
      error: `${service} webhook processing failed: ${error.message || "Unknown error"}`,
    },
    400
  );
}

export const integrationWebhooksRouter = new Hono()
  // Supabase webhook endpoint
  .post("/supabase", async (c) => {
    const merchantId = c.get("merchant")!.id;
    console.log("Received Supabase webhook for merchant", merchantId);

    try {
      // Parse the webhook payload
      const payload = await c.req.json();
      const validatedPayload = supabaseWebhookSchema.parse(payload);

      // Extract user data
      const { record } = validatedPayload;
      const userName = extractNameFromSupabaseUser(record);

      console.log(`Processing Supabase user creation for ${record.email}`);

      // Create enrollment subscription (falls back to free if no rule matches)
      const [result, statusCode] = await createEnrollmentSubscriptionForUser({
        merchantId,
        customerEmail: record.email,
        customerName: userName,
        userId: record.id,
        // Optional fields can be added here if present in the webhook
      });

      if (statusCode !== 200) {
        console.error("Failed to create free subscription:", result);
        return c.json(result, statusCode);
      }

      console.log("Successfully created free subscription for Supabase user");
      return c.json({ ...result, received: true }, 200);
    } catch (error) {
      return handleWebhookError(c, error, "Supabase");
    }
  })

  // Clerk webhook endpoint
  .post("/clerk", async (c) => {
    const merchantId = c.get("merchant")!.id;
    console.log("Received Clerk webhook for merchant", merchantId);

    try {
      // Parse the webhook payload
      const payload = await c.req.json();
      const validatedPayload = clerkWebhookSchema.parse(payload);

      // Extract user data
      const { data } = validatedPayload;
      const primaryEmail = data.email_addresses[0];

      if (!primaryEmail) {
        return c.json({ error: "No email address found for user" }, 400);
      }

      const userName = extractNameFromClerkUser(data);

      console.log(
        `Processing Clerk user creation for ${primaryEmail.email_address}`
      );

      // Create enrollment subscription (falls back to free if no rule matches)
      const [result, statusCode] = await createEnrollmentSubscriptionForUser({
        merchantId,
        customerEmail: primaryEmail.email_address,
        customerName: userName,
        userId: data.id,
        // Optional fields can be added here if present in the webhook
      });

      if (statusCode !== 200) {
        console.error("Failed to create free subscription:", result);
        return c.json(result, statusCode);
      }

      console.log("Successfully created free subscription for Clerk user");
      return c.json({ ...result, received: true }, 200);
    } catch (error) {
      return handleWebhookError(c, error, "Clerk");
    }
  });
