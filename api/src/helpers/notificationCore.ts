import { sendEmailWithResend } from "./emails";
import { logger } from "./logging";

type NodeEnv = "development" | "test" | "staging" | "production";

export type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

export type SendEmailOptions = {
  to: string;
  subject: string;
  html: string;
  from: string;
  attachment?: EmailAttachment;
  allowNonProdSend?: boolean;
};

export type SendSlackOptions = {
  text?: string;
  blocks?: unknown;
};

export type CoreNotificationConfig = {
  nodeEnv: NodeEnv;
  resendApiKey?: string | null;
  slackWebhook?: string | null;
};

export type CoreNotificationProvider = {
  sendEmail: (
    opts: SendEmailOptions
  ) => Promise<{ success: boolean; error?: string }>;
  sendSlack: (
    opts: SendSlackOptions
  ) => Promise<{ success: boolean; error?: string }>;
};

/**
 * Creates a core notification provider with no environment dependencies.
 * All configuration must be passed explicitly.
 */
export function createCoreNotificationProvider(
  config: CoreNotificationConfig
): CoreNotificationProvider {
  const { nodeEnv, resendApiKey, slackWebhook } = config;

  async function sendSlack(
    opts: SendSlackOptions
  ): Promise<{ success: boolean; error?: string }> {
    if (!slackWebhook) {
      logger.warn("No Slack webhook configured, skipping Slack notification");
      return { success: false, error: "No Slack webhook configured" };
    }

    try {
      const response = await fetch(slackWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: opts.text ?? "",
          ...(opts.blocks ? { blocks: opts.blocks } : {}),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("Slack webhook failed", {
          status: response.status,
          errorText,
        });
        return {
          success: false,
          error: `Slack webhook failed: ${response.status} - ${errorText}`,
        };
      }

      return { success: true };
    } catch (e) {
      logger.error("Error sending Slack notification", e);
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async function sendEmail(
    opts: SendEmailOptions
  ): Promise<{ success: boolean; error?: string }> {
    const shouldSendRealEmail =
      nodeEnv === "production" || opts.allowNonProdSend === true;

    if (!shouldSendRealEmail) {
      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Email (non-prod preview)*\n*To:* ${opts.to}\n*Subject:* ${opts.subject}\n*From:* ${opts.from}${opts.attachment ? `\n*Attachment:* ${opts.attachment.filename}` : ""}`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Body (HTML):*\n\`\`\`${opts.html}\`\`\``,
          },
        },
      ];

      const slackResult = await sendSlack({
        text: "📧 Email (Preview)",
        blocks,
      });

      if (!slackResult.success) {
        try {
          const firstLinkMatch = opts.html?.match(/href=\"([^\"]+)\"/);
          const firstLink = firstLinkMatch?.[1];
          // Console preview fallback in non-prod when Slack is not configured
          // Include full HTML body for convenience
          // eslint-disable-next-line no-console
          console.log(
            "\n=== EMAIL PREVIEW (NON-PROD) ===\n" +
              `To: ${opts.to}\n` +
              `Subject: ${opts.subject}\n` +
              `From: ${opts.from}` +
              (firstLink ? `\nFirst link: ${firstLink}` : "") +
              "\nBody (HTML):\n" +
              opts.html +
              "\n===============================\n"
          );
        } catch {}
        return { success: true };
      }
      return slackResult;
    }

    if (!resendApiKey) {
      logger.error(
        "RESEND_API_KEY is required to send emails in this environment"
      );
      return { success: false, error: "Email service not configured" };
    }

    const result = await sendEmailWithResend({
      to: opts.to,
      subject: opts.subject,
      body: opts.html,
      from: opts.from,
      attachment: opts.attachment,
      resendApiKey: resendApiKey,
    });

    if (!result.success) {
      return {
        success: false,
        error: String((result as any).error ?? "unknown error"),
      };
    }
    return { success: true };
  }

  return { sendEmail, sendSlack };
}
