/**
 * Hook for fetching customer portal data
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { CustomerOverview, UseQueryOptions } from "../types";
import { useLumenClient } from "../lib/context";

export interface UseCustomerPortalResult {
  overview: CustomerOverview | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to get customer portal overview data
 *
 * @example
 * ```tsx
 * function CustomerPortal() {
 *   const { overview, loading, error } = useCustomerPortal(userId);
 *
 *   if (loading) return <div>Loading...</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *
 *   return (
 *     <div>
 *       <h2>Subscription Details</h2>
 *       <p>Plan: {overview?.subscription?.planName}</p>
 *
 *       <h3>Payment Methods</h3>
 *       <ul>
 *         {overview?.paymentMethods.map((pm) => (
 *           <li key={pm.id}>{pm.brand} •••• {pm.last4}</li>
 *         ))}
 *       </ul>
 *
 *       <h3>Recent Invoices</h3>
 *       <ul>
 *         {overview?.recentInvoices.map((inv) => (
 *           <li key={inv.id}>{inv.invoiceNumber}: {inv.status}</li>
 *         ))}
 *       </ul>
 *     </div>
 *   );
 * }
 * ```
 */
export function useCustomerPortal(
  userId: string,
  options: UseQueryOptions = {}
): UseCustomerPortalResult {
  const client = useLumenClient();
  const [data, setData] = useState<CustomerOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const {
    enabled = true,
    refetchInterval,
    refetchOnWindowFocus = false,
    onSuccess,
    onError,
  } = options;

  const fetchData = useCallback(async () => {
    if (!enabled) return;

    try {
      // Cancel previous request
      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();

      setLoading(true);
      setError(null);

      const result = await client.getCustomerOverview(
        userId,
        abortControllerRef.current.signal
      );

      setData(result);
      setLoading(false);
      onSuccess?.(result);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;

      const error = err as Error;
      setError(error);
      setLoading(false);
      onError?.(error);
    }
  }, [userId, enabled, client, onSuccess, onError]);

  // Initial fetch
  useEffect(() => {
    fetchData();

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [fetchData]);

  // Set up refetch interval
  useEffect(() => {
    if (!refetchInterval || !enabled) return;

    intervalRef.current = setInterval(() => {
      fetchData();
    }, refetchInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [refetchInterval, enabled, fetchData]);

  // Set up window focus refetch
  useEffect(() => {
    if (!refetchOnWindowFocus || !enabled) return;

    const handleFocus = () => {
      fetchData();
    };

    window.addEventListener("focus", handleFocus);

    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [refetchOnWindowFocus, enabled, fetchData]);

  const refetch = useCallback(async () => {
    await fetchData();
  }, [fetchData]);

  return {
    overview: data,
    loading,
    error,
    refetch,
  };
}
