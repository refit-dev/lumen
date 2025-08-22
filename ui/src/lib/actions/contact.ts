"use server";

interface ContactFormData {
  email: string;
  message: string;
  recaptchaToken: string;
}

interface NewsletterData {
  email: string;
}

export async function submitContactForm(data: ContactFormData) {
  const webhookUrl = process.env.LUMEN_WEBSITE_SLACK_CONTACT_US_WEBHOOK_URL;
  const recaptchaSecretKey = process.env.GOOGLE_RECAPTCHA_SECRET_KEY;

  if (!webhookUrl) {
    throw new Error("Slack webhook URL not configured");
  }

  if (!recaptchaSecretKey) {
    throw new Error("reCAPTCHA secret key not configured");
  }

  // Verify reCAPTCHA token
  const recaptchaResponse = await fetch(
    "https://www.google.com/recaptcha/api/siteverify",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `secret=${recaptchaSecretKey}&response=${data.recaptchaToken}`,
    }
  );

  const recaptchaResult = await recaptchaResponse.json();

  if (!recaptchaResult.success) {
    throw new Error("reCAPTCHA verification failed");
  }

  // Check reCAPTCHA v3 score (0.0 to 1.0, where 1.0 is very likely human)
  if (recaptchaResult.score < 0.5) {
    throw new Error("reCAPTCHA score too low - potential spam detected");
  }

  const slackMessage = {
    text: "New Contact Form Submission",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "New Contact Form Submission",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Email:*\n${data.email}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Message:*\n${data.message}`,
        },
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(slackMessage),
  });

  if (!response.ok) {
    throw new Error(`Failed to send message: ${response.statusText}`);
  }

  return { success: true };
}

export async function submitNewsletterSignup(data: NewsletterData) {
  const webhookUrl = process.env.LUMEN_WEBSITE_SLACK_CONTACT_US_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error("Slack webhook URL not configured");
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(data.email)) {
    throw new Error("Invalid email address");
  }

  const slackMessage = {
    text: "New Newsletter Signup",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "New Newsletter Signup",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Email:*\n${data.email}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Source:* Landing page newsletter signup",
        },
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(slackMessage),
  });

  if (!response.ok) {
    throw new Error(`Failed to send newsletter signup: ${response.statusText}`);
  }

  return { success: true };
}

interface AuthenticatedContactData {
  message: string;
  userEmail: string;
  context?: string;
}

export async function submitAuthenticatedContactForm(
  data: AuthenticatedContactData
) {
  const webhookUrl = process.env.LUMEN_WEBSITE_SLACK_CONTACT_US_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error("Slack webhook URL not configured");
  }

  const slackMessage = {
    text: "New Contact Form Submission (Authenticated User)",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "New Contact Form Submission (Authenticated User)",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Email:*\n${data.userEmail}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Message:*\n${data.message}`,
        },
      },
      ...(data.context
        ? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Context:*\n${data.context}`,
              },
            },
          ]
        : []),
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Source:* Dashboard (authenticated user)",
        },
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(slackMessage),
  });

  if (!response.ok) {
    throw new Error(`Failed to send message: ${response.statusText}`);
  }

  return { success: true };
}
