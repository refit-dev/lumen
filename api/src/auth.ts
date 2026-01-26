import { betterAuth, BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization, admin, captcha } from "better-auth/plugins";
import {
  ac,
  ownerRole,
  adminRole,
  memberRole,
  developerRole,
} from "@lumen/common";
import { customSession } from "better-auth/plugins";
import { db } from "./db/client";
import { getMerchantByUserId, getOrganizationsByUserId } from "@lumen/common";
import { env } from "./env";
import { EnhancedSession } from "@lumen/common";
import { createNotificationProvider } from "./helpers/notificationProvider";
import { getSecretOrEnvVar } from "./helpers/secrets";
import { LumenPlugin } from "@getlumen/better-auth"; // For debugging, use ../../packages/better-auth & npm run build in packages/better-auth
import { isProdOrStaging } from "./helpers";

const {
  CORS_ORIGIN,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  NODE_ENV,
  DEV_SKIP_EMAIL_CHECK,
  API_URL,
} = env;

// Get Resend API key at top level for staging and production
let resendApiKey: string | null = null;
if (NODE_ENV === "staging" || NODE_ENV === "production") {
  resendApiKey = await getSecretOrEnvVar({
    secretNameTemplate: "lumen/*/resend-api-key",
    envVariableName: "RESEND_API_KEY",
    throwOnDevError: false,
    throwOnStagingOrProdError: true,
  });
}

const notify = createNotificationProvider({
  NODE_ENV,
  RESEND_API_KEY: resendApiKey,
});

// Custom session handler to add merchant data
const enhanceSessionWithMerchant = customSession(
  async ({ user, session }): Promise<EnhancedSession> => {
    // Default response with existing data
    const sessionData: EnhancedSession = {
      user,
      session,
      organization: null,
      merchant: null,
      memberRole: null,
    };
    try {
      // get organization and merchant info
      const orgs = await getOrganizationsByUserId(db, user.id);
      // Deduplicate by organization id to tolerate duplicate member rows
      const uniqueOrgsMap = new Map<string, (typeof orgs)[number]>();
      for (const row of orgs || []) {
        const orgId = row.organization.id;
        if (!uniqueOrgsMap.has(orgId)) uniqueOrgsMap.set(orgId, row);
      }
      const uniqueOrgs = Array.from(uniqueOrgsMap.values());
      if (uniqueOrgs.length > 1) {
        console.error("Multiple organizations found for user");
        return sessionData;
      }
      if (uniqueOrgs.length === 0) {
        console.error("No organizations found for user");
        return sessionData;
      }

      const orgData = uniqueOrgs[0]; // one organization per user
      const memberRole = orgData.member.role;

      const sessionDataWithOrg = {
        ...sessionData,
        organization: {
          id: orgData.organization.id,
          name: orgData.organization.name,
          slug: orgData.organization.slug,
        },
        memberRole,
      };

      const merchantResult = await db.query.merchants.findFirst({
        where: (merchants, { eq, isNull, and }) =>
          and(
            eq(merchants.organizationId, orgData.organization.id),
            isNull(merchants.deletedAt)
          ),
      });

      if (!merchantResult) {
        console.error("No merchant found for organization");
        return sessionDataWithOrg;
      }

      return {
        ...sessionDataWithOrg,
        merchant: {
          id: merchantResult.id,
          legalName: merchantResult.legalName,
          displayName: merchantResult.displayName,
          defaultCurrency: merchantResult.defaultCurrency,
        },
      };
    } catch (error) {
      console.error(
        "Error fetching organization or merchant data for session:",
        error
      );
      return sessionData;
    }
  }
);

// Prepare trusted origins list using environment variable
// Always trust local dev in addition to the configured origin
const trustedOriginList = Array.from(
  new Set(["http://localhost:3000", "http://localhost:3001", CORS_ORIGIN])
); // multiple dev envs

console.log("[AUTH DEBUG] NODE_ENV:", NODE_ENV);
console.log("[AUTH DEBUG] DEV_SKIP_EMAIL_CHECK:", DEV_SKIP_EMAIL_CHECK);
const effectiveRequireEmailVerification =
  isProdOrStaging || !DEV_SKIP_EMAIL_CHECK;
const effectiveSendOnSignUp = isProdOrStaging || !DEV_SKIP_EMAIL_CHECK;
console.log(
  "[AUTH DEBUG] effectiveRequireEmailVerification:",
  effectiveRequireEmailVerification
);
console.log("[AUTH DEBUG] effectiveSendOnSignUp:", effectiveSendOnSignUp);

const lumenApiKey = await getSecretOrEnvVar({
  secretNameTemplate: "lumen/*/lumen-api-key",
  envVariableName: "LUMEN_API_KEY",
  throwOnDevError: false,
  throwOnStagingOrProdError: true,
});

const turnstileSecretKey = await getSecretOrEnvVar({
  secretNameTemplate: "lumen/*/turnstile-secret-key",
  envVariableName: "TURNSTILE_SECRET_KEY",
  throwOnDevError: false,
  throwOnStagingOrProdError: false,
});

const authConfig = {
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  advanced: {
    defaultCookieAttributes: {
      secure: true,
      httpOnly: true,
      sameSite: "none", // Allows CORS-based cookie sharing across subdomains
      partitioned: true, // New browser standards will mandate this for foreign cookies
      ...(API_URL.includes("getlumen.dev") && { domain: ".getlumen.dev" }),
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days (absolute max session length)
    updateAge: 60 * 60 * 24, // 1 day (extend the session every day)
    cookieCache: {
      enabled: true,
      maxAge: 60 * 15, // 15 minutes (cookie cache duration)
    },
  },
  plugins: [
    captcha({
      provider: "cloudflare-turnstile", // or google-recaptcha, hcaptcha, captchafox
      secretKey: turnstileSecretKey || "1x0000000000000000000000000000000AA", // test key always pass
    }),
    organization({
      // Use shared access control and roles (including custom 'developer')
      ac: ac as any,
      roles: {
        owner: ownerRole,
        admin: adminRole,
        member: memberRole,
        developer: developerRole,
      },
      async sendInvitationEmail(data) {
        const inviteUrl = `${CORS_ORIGIN}/accept-invite?invitationId=${data.id}&invitee=${encodeURIComponent(
          data.email
        )}`;
        const roles = Array.isArray(data.role) ? data.role : [data.role];
        const roleText = roles.includes("owner")
          ? "Owner"
          : roles.includes("admin")
            ? "Admin"
            : roles.includes("developer")
              ? "Developer"
              : "Member";

        try {
          await notify.sendEmail({
            to: data.email,
            subject: `You've been invited to join ${data.organization.name}`,
            html: `
              <h1>Team Invitation</h1>
              <p>Hello,</p>
              <p>${data.inviter.user.name || data.inviter.user.email} has invited you to join <strong>${data.organization.name}</strong> as a <strong>${roleText}</strong>.</p>
              <a href="${inviteUrl}" style="background-color: #000; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0;">
                Accept Invitation
              </a>
              <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
              <p><a href="${inviteUrl}">${inviteUrl}</a></p>
              <p>This invitation will expire in 48 hours.</p>
              <p>If you didn't expect this invitation, you can safely ignore this email.</p>
              <p>Best regards,<br>The Lumen Team</p>
            `,
            from: "Lumen <noreply@getlumen.dev>",
          });
        } catch (error) {
          console.error("Failed to send invitation email:", error);
        }
      },
    }),
    admin({
      defaultRole: "owner",
      adminRoles: ["admin"],
    }),
    enhanceSessionWithMerchant,
    // only add lumen plugin if lumen api key is set
    ...(lumenApiKey
      ? [
          LumenPlugin({
            apiKey: lumenApiKey,
            apiUrl: env.API_URL.replace("/v1", ""),
          }),
        ]
      : []),
  ],
  trustedOrigins: trustedOriginList, // Use the dynamic list
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: effectiveRequireEmailVerification, // Require verification in prod/staging OR when DEV_SKIP_EMAIL_CHECK is false
    sendResetPassword: async ({ user, url, token }, request) => {
      try {
        const res = await notify.sendEmail({
          to: user.email,
          subject: "Reset your password",
          html: `
              <h1>Reset your password</h1>
              <p>Hello ${user.name || user.email},</p>
              <p>We received a request to reset your password. Click the button below to reset it:</p>
              <a href="${url}" style="background-color: #000; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0;">
                Reset Password
              </a>
              <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
              <p><a href="${url}">${url}</a></p>
              <p>This link will expire in 1 hour for security purposes.</p>
              <p>If you didn't request a password reset, you can safely ignore this email.</p>
              <p>Best regards,<br>The Lumen Team</p>
            `,
          from: "Lumen <noreply@getlumen.dev>",
        });
        if (!res.success) {
          throw new Error("Failed to send password reset email");
        }
      } catch (error) {
        console.error("Failed to send password reset email:", error);
      }
    },
  },
  emailVerification: {
    sendOnSignUp: effectiveSendOnSignUp, // Auto-send in prod OR when DEV_SKIP_EMAIL_CHECK is false
    autoSignInAfterVerification: true, // Auto sign in after email verification
    sendVerificationEmail: async ({ user, url, token }, request) => {
      try {
        await notify.sendEmail({
          to: user.email,
          subject: "Verify your email address",
          html: `
              <h1>Verify your email address</h1>
              <p>Hello ${user.name || user.email},</p>
              <p>Thank you for signing up! Please click the button below to verify your email address:</p>
              <a href="${url}" style="background-color: #000; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0;">
                Verify Email Address
              </a>
              <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
              <p><a href="${url}">${url}</a></p>
              <p>This link will expire in 24 hours for security purposes.</p>
              <p>If you didn't create this account, you can safely ignore this email.</p>
              <p>Best regards,<br>The Lumen Team</p>
            `,
          from: "Lumen <noreply@getlumen.dev>",
        });
      } catch (error) {
        console.error("Failed to send verification email:", error);
      }
    },
  },
  socialProviders: {
    google: {
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
    },
  },
  // Dogfooding: assign free plan to users who sign up via email or google login
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      // Check if this is a sign-in endpoint
      // path includes "callback" if it is google login
      if (
        isProdOrStaging &&
        (ctx.path.includes("sign-in/email") || ctx.path.includes("callback"))
      ) {
        console.log("Auth Middleware. Signin or callback. ", ctx.path);
        const host = API_URL;
        if (host?.includes("getlumen.dev")) {
          try {
            const email = ctx.context.newSession?.user.email || ctx.body.email;
            await notify.sendSlack({
              text: `name: ${ctx.context.newSession?.user.name}\n${email}\npath: ${ctx.path}\nhost: ${host}`,
            });
          } catch (err) {
            console.error("Failed to log user creation to slack:", err);
          }
        }
      }
    }),
  },
} as const satisfies BetterAuthOptions;

export const auth = betterAuth(authConfig) as ReturnType<
  typeof betterAuth<typeof authConfig>
>;
