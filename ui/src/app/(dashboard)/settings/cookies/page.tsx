"use client";

import { useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useCookieConsent } from "@/lib/cookie-consent-context";
import { toast } from "sonner";
import { Cookie, Shield, BarChart3, Settings } from "lucide-react";

export default function CookieSettingsPage() {
  const { hasConsent, acceptCookies, declineCookies } = useCookieConsent();
  const [analyticsEnabled, setAnalyticsEnabled] = useState(hasConsent);

  const handleSaveSettings = () => {
    if (analyticsEnabled) {
      acceptCookies();
      toast.success("Preferences saved. Analytics will persist across visits.");
    } else {
      declineCookies();
      toast.success(
        "Preferences saved. Analytics will be session-only (anonymous)."
      );
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Cookie Settings
        </h1>
        <p className="text-gray-600 mt-2">
          Manage your cookie preferences and privacy settings.
        </p>
      </div>

      <div className="grid gap-6">
        {/* Essential Cookies */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Shield className="w-5 h-5 text-green-600" />
              <div>
                <CardTitle className="text-lg">Essential Cookies</CardTitle>
                <CardDescription>
                  Required for the website to function properly
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-sm font-medium">
                  Authentication & Security
                </Label>
                <p className="text-sm text-gray-600">
                  These cookies are necessary for logging you in, maintaining
                  your session, and ensuring the security of your account.
                </p>
              </div>
              <Switch checked={true} disabled />
            </div>
            <Separator className="my-4" />
            <div className="text-xs text-gray-500">
              <strong>Cookies used:</strong> better-auth.session_token,
              better-auth.session_data
            </div>
          </CardContent>
        </Card>

        {/* Analytics Cookies */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <BarChart3 className="w-5 h-5 text-blue-600" />
              <div>
                <CardTitle className="text-lg">Analytics Persistence</CardTitle>
                <CardDescription>
                  Choose how your usage data is stored
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label
                  htmlFor="analytics-toggle"
                  className="text-sm font-medium"
                >
                  Persistent Analytics & Session Recording
                </Label>
                <p className="text-sm text-gray-600">
                  We collect comprehensive analytics under legitimate interest:
                  session recordings, heatmaps, performance metrics, error
                  tracking, user interactions, and feature usage. This setting
                  controls whether the data persists across browser sessions.
                </p>
              </div>
              <Switch
                id="analytics-toggle"
                checked={analyticsEnabled}
                onCheckedChange={setAnalyticsEnabled}
              />
            </div>
            <Separator className="my-4" />
            <div className="text-xs text-gray-500">
              <strong>Service:</strong> PostHog Analytics (Legitimate Interest)
              <br />
              <strong>Always collected:</strong> Session recordings, heatmaps,
              performance metrics, error tracking, user interactions, feature
              usage, page views, autocapture events
              <br />
              <strong>When enabled:</strong> Data persists across visits for
              user journey analysis
              <br />
              <strong>When disabled:</strong> All data cleared when browser
              closes (session-only)
            </div>
          </CardContent>
        </Card>

        {/* Privacy Information */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Cookie className="w-5 h-5 text-amber-600" />
              <div>
                <CardTitle className="text-lg">Your Privacy Rights</CardTitle>
                <CardDescription>
                  Understanding your data and privacy choices
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm text-gray-600 space-y-2">
              <p>
                <strong>Legitimate Interest Basis:</strong> We collect
                comprehensive analytics data to improve our product under
                GDPR&apos;s legitimate interest basis. This includes session
                recordings, heatmaps, performance data, and user interactions.
              </p>
              <p>
                <strong>Anonymous Without Persistence:</strong> Without
                persistent cookies, all data remains anonymous and
                session-isolated. No cross-visit tracking possible.
              </p>
              <p>
                <strong>Session Storage Mode:</strong> When persistent analytics
                are disabled, we use session storage. All data auto-deletes when
                you close your browser.
              </p>
              <p>
                <strong>Opt-Out Available:</strong> You can opt out of all
                analytics collection by enabling Do Not Track in your browser
                settings.
              </p>
              <p>
                <strong>No Third-Party Sharing:</strong> All data stays within
                our platform and is never shared with advertisers or third
                parties.
              </p>
            </div>

            <div className="pt-2">
              <a
                href="/privacy"
                className="text-sm text-blue-600 hover:text-blue-800 underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Read our full Privacy Policy →
              </a>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button
          onClick={handleSaveSettings}
          className="bg-gray-900 hover:bg-gray-800"
        >
          <Settings className="w-4 h-4 mr-2" />
          Save Cookie Preferences
        </Button>
      </div>
    </div>
  );
}
