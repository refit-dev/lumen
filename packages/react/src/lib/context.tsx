/**
 * React context for Lumen configuration
 */

import React, { createContext, useContext, useMemo } from "react";
import type { LumenConfig } from "../types";
import { LumenAPIClient, setDefaultClient } from "./api-client";

interface LumenContextValue {
  config: LumenConfig;
  client: LumenAPIClient;
}

const LumenContext = createContext<LumenContextValue | null>(null);

export interface LumenProviderProps {
  children: React.ReactNode;
  config: LumenConfig;
}

/**
 * Provider component that configures the Lumen React SDK
 *
 * Wrap your app with this provider to enable all Lumen hooks and components
 *
 * @example
 * ```tsx
 * <LumenProvider config={{ apiProxyUrl: "/api/lumen" }}>
 *   <App />
 * </LumenProvider>
 * ```
 */
export function LumenProvider({ children, config }: LumenProviderProps) {
  const client = useMemo(() => {
    const apiClient = new LumenAPIClient(config);
    setDefaultClient(apiClient);
    return apiClient;
  }, [config]);

  const value = useMemo(() => ({ config, client }), [config, client]);

  return (
    <LumenContext.Provider value={value}>{children}</LumenContext.Provider>
  );
}

/**
 * Hook to access Lumen configuration and API client
 * @internal
 */
export function useLumenContext(): LumenContextValue {
  const context = useContext(LumenContext);
  if (!context) {
    throw new Error("useLumenContext must be used within a LumenProvider");
  }
  return context;
}

/**
 * Hook to access the Lumen API client
 * @internal
 */
export function useLumenClient(): LumenAPIClient {
  const { client } = useLumenContext();
  return client;
}
