"use client";

import React, { createContext, useContext, ReactNode } from "react";
import { LocaleContext, detectUserLocale } from "./locale";

interface LocaleProviderProps {
  children: ReactNode;
  merchantCountry?: string;
  customerCountry?: string;
}

interface LocaleContextValue {
  localeContext: LocaleContext;
  merchantCountry?: string;
  customerCountry?: string;
}

const LocaleContextProvider = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  children,
  merchantCountry,
  customerCountry,
}: LocaleProviderProps) {
  const localeContext = detectUserLocale(merchantCountry, customerCountry);

  return (
    <LocaleContextProvider.Provider
      value={{
        localeContext,
        merchantCountry,
        customerCountry,
      }}
    >
      {children}
    </LocaleContextProvider.Provider>
  );
}

export function useLocaleContext(): LocaleContextValue {
  const context = useContext(LocaleContextProvider);
  if (!context) {
    // Fallback to default behavior if no context is available
    return {
      localeContext: detectUserLocale(),
      merchantCountry: undefined,
      customerCountry: undefined,
    };
  }
  return context;
}

// Convenience hooks for specific formatting needs
export function useDateFormatter() {
  const { merchantCountry, customerCountry } = useLocaleContext();

  return {
    formatDate: (
      date: Date | string,
      options: {
        style?: "short" | "medium" | "long" | "full";
        includeTime?: boolean;
      } = {}
    ) => {
      const dateObj = typeof date === "string" ? new Date(date) : date;
      const localeContext = detectUserLocale(merchantCountry, customerCountry);

      const formatOptions: Intl.DateTimeFormatOptions = {};

      // Set date style - always use individual properties to force English month names
      // Note: We avoid dateStyle to ensure month names are always in English
      formatOptions.year = "numeric";
      formatOptions.month = "short";
      formatOptions.day = "numeric";

      // Add time if requested
      if (options.includeTime) {
        formatOptions.hour = "numeric";
        formatOptions.minute = "2-digit";
        formatOptions.hour12 = localeContext.timeFormat === "12";
      }

      // Always use en-US for formatting to ensure English month names
      // but preserve the time format preference from the user's locale
      return new Intl.DateTimeFormat("en-US", formatOptions).format(dateObj);
    },

    formatDateLegacy: (date: Date | string) => {
      // For backward compatibility with existing toLocaleDateString() calls
      // Always use en-US to ensure English month names
      const dateObj = typeof date === "string" ? new Date(date) : date;
      return dateObj.toLocaleDateString("en-US");
    },

    formatDateTimeLegacy: (date: Date | string) => {
      // For backward compatibility with existing toLocaleString() calls
      // Always use en-US to ensure English month names
      const dateObj = typeof date === "string" ? new Date(date) : date;
      const localeContext = detectUserLocale(merchantCountry, customerCountry);

      // Use en-US for formatting but preserve time format preference
      const options: Intl.DateTimeFormatOptions = {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: localeContext.timeFormat === "12",
      };

      return new Intl.DateTimeFormat("en-US", options).format(dateObj);
    },
  };
}

export function useNumberFormatter() {
  const { merchantCountry, customerCountry } = useLocaleContext();

  return {
    formatNumberLegacy: (number: number) => {
      // For backward compatibility with existing toLocaleString() calls
      const localeContext = detectUserLocale(merchantCountry, customerCountry);
      return number.toLocaleString(localeContext.locale);
    },
  };
}
