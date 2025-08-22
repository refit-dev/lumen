"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useCookieConsent } from "@/lib/cookie-consent-context";
import { X, Cookie } from "lucide-react";

export function CookieBanner() {
  const { hasConsent, isLoading, acceptCookies, declineCookies } =
    useCookieConsent();
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    // Only show banner if:
    // 1. Not loading
    // 2. No existing consent decision
    // 3. We're on client side
    if (!isLoading && !hasConsent && typeof window !== "undefined") {
      const hasDeclined =
        localStorage.getItem("lumen-cookie-consent") === "declined";
      setShowBanner(!hasDeclined);
    }
  }, [isLoading, hasConsent]);

  const handleAccept = () => {
    acceptCookies();
    setShowBanner(false);
  };

  const handleDecline = () => {
    declineCookies();
    setShowBanner(false);
  };

  if (!showBanner) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50">
      <div className="bg-white border-t border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <Cookie className="w-4 h-4 text-gray-500 flex-shrink-0" />
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm text-gray-700">
                  We use cookies to make our site work better and see how you
                  use it.
                </span>
                <div className="flex gap-3 text-sm">
                  <a
                    href="/privacy"
                    className="text-gray-600 underline hover:text-gray-800 whitespace-nowrap"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Privacy
                  </a>
                  <a
                    href="/terms"
                    className="text-gray-600 underline hover:text-gray-800 whitespace-nowrap"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Terms
                  </a>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <Button
                onClick={handleAccept}
                size="sm"
                className="bg-gray-900 hover:bg-gray-800 text-white px-4 py-1 text-xs font-medium"
              >
                Accept All
              </Button>
              <Button
                onClick={handleDecline}
                variant="ghost"
                size="sm"
                className="text-gray-600 hover:text-gray-800 px-3 py-1 text-xs"
              >
                Essential Only
              </Button>
              <button
                onClick={handleDecline}
                className="p-1 text-gray-400 hover:text-gray-600 transition-colors ml-1"
                aria-label="Close cookie banner"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
