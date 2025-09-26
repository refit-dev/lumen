"use client";

import React, { createContext, useContext, useEffect } from "react";
import { useSession } from "./auth-client";
import { toast } from "sonner";

interface AuthErrorContextType {
  handleAuthError: (error: Error | string) => void;
}

const AuthErrorContext = createContext<AuthErrorContextType | undefined>(
  undefined
);

export const useAuthError = () => {
  const context = useContext(AuthErrorContext);
  if (context === undefined) {
    throw new Error("useAuthError must be used within an AuthErrorProvider");
  }
  return context;
};

interface AuthErrorProviderProps {
  children: React.ReactNode;
}

const PUBLIC_ROUTES = new Set([
  "/",
  "/pricing",
  "/privacy",
  "/terms",
  "/impressum",
  "/login",
  "/demo",
  // /blog routes handled later in code with startsWith
]);

export function AuthErrorProvider({ children }: AuthErrorProviderProps) {
  const { data: session, isPending } = useSession();

  const handleAuthError = (error: Error | string) => {
    const message = typeof error === "string" ? error : error.message;

    // Show user-friendly error message
    if (
      message.includes("401") ||
      message.toLowerCase().includes("unauthorized")
    ) {
      toast.error("Your session has expired. Please log in again.");
      // The API interceptor will handle the redirect
    } else {
      console.warn("Auth-related error:", message);
    }
  };

  // Monitor session state for unexpected logouts
  useEffect(() => {
    if (!isPending) {
      if (!session?.user && typeof window !== "undefined") {
        const { pathname } = window.location;
        const isPublic =
          PUBLIC_ROUTES.has(pathname) || pathname.startsWith("/blog");

        if (!isPublic) {
          console.warn("No active session detected - redirecting to login");
          window.location.href = "/login";
        }
      }
    }
  }, [session, isPending]);

  const value = {
    handleAuthError,
  };

  return (
    <AuthErrorContext.Provider value={value}>
      {children}
    </AuthErrorContext.Provider>
  );
}
