/**
 * Hook for fetching available credit top-ups
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { AvailableTopup, UseQueryOptions } from "../types";
import { useLumenClient } from "../lib/context";

export interface UseAvailableTopupsResult {
  topups: AvailableTopup[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to get available credit top-ups for a user
 *
 * @example
 * ```tsx
 * function TopupOptions() {
 *   const { topups, loading, error, refetch } = useAvailableTopups(userId);
 *
 *   if (loading) return <div>Loading...</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *
 *   return (
 *     <div>
 *       <h2>Available Top-ups</h2>
 *       {topups.map((topup) => (
 *         <div key={topup.creditDefinitionId}>
 *           <h3>{topup.featureName}</h3>
 *           <p>{topup.creditsRemaining} / {topup.creditAllowance} credits remaining</p>
 *           <p>Price: ${topup.topupPricePerCreditCents / 100} per credit</p>
 *           <p>Min: {topup.minQuantity}, Max: {topup.maxQuantity || 'Unlimited'}</p>
 *         </div>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useAvailableTopups(
  userId: string,
  options: UseQueryOptions = {}
): UseAvailableTopupsResult {
  const client = useLumenClient();
  const [data, setData] = useState<AvailableTopup[]>([]);
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

      const result = await client.getAvailableTopups(
        userId,
        abortControllerRef.current.signal
      );

      const topups = result.availableTopups || [];
      setData(topups);
      setLoading(false);
      onSuccess?.(topups);
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
    topups: data,
    loading,
    error,
    refetch,
  };
}
