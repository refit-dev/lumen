"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";
import {
  useCookieConsent,
  getStoredConsent,
} from "@/lib/cookie-consent-context";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const { hasConsent, isLoading } = useCookieConsent();

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (key && key !== "development_mode_key") {
      // Check if PostHog is already initialized
      if (posthog.__loaded) {
        return;
      }

      // Determine persistence method based on consent
      const consentGranted = hasConsent || getStoredConsent();

      posthog.init(key, {
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
        defaults: "2025-05-24",
        // Only difference based on consent: persistence method
        persistence: consentGranted ? "localStorage+cookie" : "memory",
        disable_cookie: !consentGranted,
        // Everything else: use PostHog defaults for maximum insights
        // All these are legitimate interest under GDPR for product improvement:
        // - Session recordings (anonymous without persistent cookies)
        // - Heatmaps and user interactions
        // - Performance monitoring
        // - Error tracking
        // - Feature usage analytics
        // - Autocapture for UX optimization
        respect_dnt: true, // Still respect Do Not Track
      });
    }
  }, [hasConsent, isLoading]);

  // Update PostHog settings when consent changes
  useEffect(() => {
    if (!isLoading && posthog.__loaded) {
      const consentGranted = hasConsent || getStoredConsent();

      // Always opt in to capturing - without cookies it's anonymous anyway
      posthog.opt_in_capturing();

      // Always keep session recording - it's anonymous without persistent user IDs
      posthog.startSessionRecording();

      // If consent was granted after initialization, reinitialize with proper settings
      if (consentGranted && posthog.config.disable_cookie) {
        // Reinitialize PostHog with full cookie support
        const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
        if (key && key !== "development_mode_key") {
          posthog.init(key, {
            api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
            defaults: "2025-05-24",
            persistence: "localStorage+cookie",
            disable_cookie: false,
            respect_dnt: true,
          });
        }
      }
    }
  }, [hasConsent, isLoading]);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
