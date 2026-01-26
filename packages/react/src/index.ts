/**
 * @getlumen/react
 *
 * React hooks and components for Lumen Billing
 *
 * @example
 * ```tsx
 * import { LumenProvider, useLumenFeature, LumenFeatureGate } from '@getlumen/react';
 *
 * function App() {
 *   return (
 *     <LumenProvider config={{ apiProxyUrl: '/api/lumen' }}>
 *       <MyApp />
 *     </LumenProvider>
 *   );
 * }
 * ```
 */

// Context and Provider
export { LumenProvider, useLumenContext, useLumenClient } from "./lib/context";

// API Client
export { LumenAPIClient, LumenAPIError } from "./lib/api-client";

// Hooks
export * from "./hooks";

// Components
export * from "./components";

// Utility Functions
export * from "./lib/utils";

// Types
export * from "./types";
