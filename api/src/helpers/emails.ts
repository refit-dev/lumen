import { Resend } from "resend";

interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
  from: string;
  attachment?: {
    filename: string;
    content: Buffer;
    contentType: string;
  };
  resendApiKey?: string;
}

export async function sendEmailWithResend({
  to,
  subject,
  body,
  from,
  attachment,
  resendApiKey,
}: SendEmailParams) {
  const SKIP_SENDING_EMAIL_DOMAINS = ["getlumen.dev", "example.com"];
  const skipSendingEmail = SKIP_SENDING_EMAIL_DOMAINS.some((domain) =>
    to.includes(domain)
  );
  if (skipSendingEmail) {
    console.log(`Skipping sending email to ${to}`);
    return { success: true, message: `Skipping sending email to ${to}` };
  }
  // Implementation with Resend. You can modify this function to use any other provider
  try {
    if (!resendApiKey) {
      console.error("resendApiKey is not set");
      return { success: false, error: "Email service not configured" };
    }

    const resend = new Resend(resendApiKey);

    const emailOptions = {
      from,
      to,
      subject,
      html: body,
      ...(attachment && {
        attachments: [
          {
            filename: attachment.filename,
            content: attachment.content,
            contentType: attachment.contentType,
          },
        ],
      }),
    };

    await Promise.all([
      resend.emails.send(emailOptions),
      // TODO: Remove this in the future
      // Debugging: Send us a copy of the email
      resend.emails.send({
        ...emailOptions,
        to: "founders@withpretzel.com",
        subject: emailOptions.subject + ` (copy of email sent to ${to})`,
      }),
    ]);

    // End of resend implementation
    return { success: true };
  } catch (error) {
    console.error("Failed to send email:", error);
    return { success: false, error };
  }
}
