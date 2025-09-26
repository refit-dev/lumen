import { createAuthMiddleware } from "better-auth/plugins";
import type { BetterAuthPlugin } from "better-auth";

export interface FreeSubscriptionOptions {
  /**
   * The API URL for the subscription service
   */
  apiUrl?: string;
  /**
   * The API key for authenticating with the subscription service
   */
  apiKey: string;
  /**
   * Whether the plugin is enabled
   * @default true
   */
  enabled?: boolean;
  /**
   * Whether to only run in production/staging environments
   * @default false
   */
  prodOnly?: boolean;
  /**
   * Custom callback for successful subscription creation
   */
  onSuccess?: (user: any, subscription: any) => void;
  /**
   * Custom callback for failed subscription creation
   */
  onError?: (user: any, error: any) => void;
  /**
   * Custom logger for debugging
   */
  logger?: (message: string, ...args: any[]) => void;
}

/**
 * Better Auth plugin for automatically creating free subscriptions after user login
 */
export const LumenPlugin = (options: FreeSubscriptionOptions) => {
  const {
    apiUrl = "https://api.getlumen.dev",
    apiKey,
    enabled = true,
    prodOnly = false,
    onSuccess,
    onError,
    logger = console.log,
  } = options;

  return {
    id: "lumen-payments",
    hooks: {
      after: [
        {
          matcher: (context) => {
            return (
              context.path.includes("sign-in/email") || // dev mode when DEV_SKIP_EMAIL_CHECK is true (default)
              context.path.includes("callback") || // google auth
              context.path.includes("verify-email") // necessary for prod/staging where we send verification emails (newSession will be null when hitting /sign-in/email)
            );
          },
          handler: createAuthMiddleware(async (ctx) => {
            if (!enabled) {
              return;
            }

            // If prodOnly is true, only run in production/staging
            if (prodOnly && process.env.NODE_ENV === "development") {
              logger("Skipping subscription enrollment in development mode");
              return;
            }

            const newSession = ctx.context.newSession;

            if (!newSession) {
              logger("No new session; skipping subscription enrollment");
              return;
            }

            if (!apiKey) {
              logger("No API key provided; skipping subscription enrollment");
              return;
            }

            try {
              logger(
                "Enrolling user into plan (if eligible):",
                newSession.user.email
              );

              const response = await fetch(`${apiUrl}/v1/enrollment/enroll`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                  customerEmail: newSession.user.email,
                  customerName: newSession.user.name,
                  userId: newSession.user.id,
                }),
              });

              if (!response.ok) {
                const responseBody = await response.json();
                logger("Subscription enrollment failed:", responseBody);

                if (onError) {
                  onError(newSession.user, responseBody);
                }
              } else {
                const subscriptionData = await response.json();
                logger(
                  "Subscription enrollment succeeded for:",
                  newSession.user.email
                );

                if (onSuccess) {
                  onSuccess(newSession.user, subscriptionData);
                }
              }
            } catch (error) {
              logger("Error during subscription enrollment:", error);

              if (onError) {
                onError(newSession.user, error);
              }
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
