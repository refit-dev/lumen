import { env as apiEnv } from "../env";
import { getSecretOrEnvVar } from "./secrets";
import {
  createCoreNotificationProvider,
  type EmailAttachment,
  type SendEmailOptions,
  type SendSlackOptions,
} from "./notificationCore";

type NodeEnv = "development" | "test" | "staging" | "production";

type EnvLike = {
  NODE_ENV?: NodeEnv | null;
  RESEND_API_KEY?: string | null;
  SLACK_WEBHOOK?: string | null;
};

export type NotificationProvider = {
  sendEmail: (
    opts: SendEmailOptions
  ) => Promise<{ success: boolean; error?: string }>;
  sendSlack: (
    opts: SendSlackOptions
  ) => Promise<{ success: boolean; error?: string }>;
};

// Re-export types for backward compatibility
export type { EmailAttachment, SendEmailOptions, SendSlackOptions };

// if used on Trigger.dev, we NEED to pass env vars here
// it's because the getSecretOrEnvVar function will not work on Trigger.dev
// because all the secrets are stored as env vars on Trigger.dev
export function createNotificationProvider(
  envOverride?: EnvLike
): NotificationProvider {
  const nodeEnv: NodeEnv = envOverride?.NODE_ENV ?? apiEnv.NODE_ENV;
  let cachedResendKey: string | null | undefined = envOverride?.RESEND_API_KEY;
  let cachedSlackWebhook: string | null | undefined =
    envOverride?.SLACK_WEBHOOK;

  async function resolveResendKey(): Promise<string | null> {
    if (cachedResendKey !== undefined) return cachedResendKey;
    try {
      const key = await getSecretOrEnvVar({
        secretNameTemplate: "lumen/*/resend-api-key",
        envVariableName: "RESEND_API_KEY",
        throwOnDevError: false,
        throwOnStagingOrProdError:
          nodeEnv !== "development" && nodeEnv !== "test",
      });
      cachedResendKey = key;
      return key;
    } catch (e) {
      console.error("Failed to resolve RESEND_API_KEY", e);
      return null;
    }
  }

  async function resolveSlackWebhook(): Promise<string | null> {
    if (cachedSlackWebhook !== undefined) return cachedSlackWebhook;
    try {
      const url = await getSecretOrEnvVar({
        secretNameTemplate: "lumen/*/slack-webhook",
        envVariableName: "SLACK_WEBHOOK",
        throwOnDevError: false,
        throwOnStagingOrProdError: false,
      });
      cachedSlackWebhook = url;
      return url;
    } catch (e) {
      console.warn("Slack webhook not configured");
      return null;
    }
  }

  // Create a core provider that will handle the actual sending
  let coreProvider: ReturnType<typeof createCoreNotificationProvider> | null =
    null;

  async function getCoreProvider() {
    if (!coreProvider) {
      const resendKey = await resolveResendKey();
      const slackWebhook = await resolveSlackWebhook();

      coreProvider = createCoreNotificationProvider({
        nodeEnv,
        resendApiKey: resendKey,
        slackWebhook: slackWebhook,
      });
    }
    return coreProvider;
  }

  async function sendEmail(opts: SendEmailOptions) {
    const core = await getCoreProvider();
    return core.sendEmail(opts);
  }

  async function sendSlack(opts: SendSlackOptions) {
    const core = await getCoreProvider();
    return core.sendSlack(opts);
  }

  return { sendEmail, sendSlack };
}
