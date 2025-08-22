"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

interface CookieConsentContextType {
  hasConsent: boolean;
  isLoading: boolean;
  acceptCookies: () => void;
  declineCookies: () => void;
  autoConsentOnLogin: () => void;
}

const CookieConsentContext = createContext<
  CookieConsentContextType | undefined
>(undefined);

const CONSENT_KEY = "lumen-cookie-consent";
const CONSENT_VALUES = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
} as const;

export function CookieConsentProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [hasConsent, setHasConsent] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check existing consent preference
    const storedConsent = localStorage.getItem(CONSENT_KEY);
    if (storedConsent === CONSENT_VALUES.ACCEPTED) {
      setHasConsent(true);
    }
    setIsLoading(false);
  }, []);

  const acceptCookies = () => {
    localStorage.setItem(CONSENT_KEY, CONSENT_VALUES.ACCEPTED);
    setHasConsent(true);
  };

  const declineCookies = () => {
    localStorage.setItem(CONSENT_KEY, CONSENT_VALUES.DECLINED);
    setHasConsent(false);
  };

  const autoConsentOnLogin = () => {
    // Automatically grant consent when user logs in to use the app
    localStorage.setItem(CONSENT_KEY, CONSENT_VALUES.ACCEPTED);
    setHasConsent(true);
  };

  return (
    <CookieConsentContext.Provider
      value={{
        hasConsent,
        isLoading,
        acceptCookies,
        declineCookies,
        autoConsentOnLogin,
      }}
    >
      {children}
    </CookieConsentContext.Provider>
  );
}

export function useCookieConsent() {
  const context = useContext(CookieConsentContext);
  if (context === undefined) {
    throw new Error(
      "useCookieConsent must be used within a CookieConsentProvider"
    );
  }
  return context;
}

export function getStoredConsent(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(CONSENT_KEY) === CONSENT_VALUES.ACCEPTED;
}
