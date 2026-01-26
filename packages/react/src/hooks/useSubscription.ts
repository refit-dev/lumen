/**
 * Hook for fetching subscription status
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { SubscriptionStatus, UseQueryOptions } from "../types";
import { useLumenClient } from "../lib/context";

export interface UseSubscriptionResult {
  subscription: SubscriptionStatus | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to get subscription status for a user
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { subscription, loading, error } = useSubscription(userId);
 *
 *   if (loading) return <div>Loading...</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *
 *   return (
 *     <div>
 *       {subscription?.hasActiveSubscription ? (
 *         <p>Plan: {subscription.subscription.planName}</p>
 *       ) : (
 *         <p>No active subscription</p>
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */
export function useSubscription(
  userId: string,
  options: UseQueryOptions = {}
): UseSubscriptionResult {
  const client = useLumenClient();
  const [data, setData] = useState<SubscriptionStatus | null>(null);
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

      const result = await client.getSubscriptionStatus(
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
    subscription: data,
    loading,
    error,
    refetch,
  };
}
