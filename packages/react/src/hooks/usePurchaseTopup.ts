/**
 * Hook for purchasing credit top-ups
 */

import { useState, useCallback, useRef } from "react";
import type { TopupPurchaseResult } from "../types";
import { useLumenClient } from "../lib/context";

export interface UsePurchaseTopupResult {
  purchase: (
    creditDefinitionId: string,
    quantity: number
  ) => Promise<TopupPurchaseResult>;
  loading: boolean;
  error: Error | null;
  lastResult: TopupPurchaseResult | null;
  reset: () => void;
}

/**
 * Hook to purchase credit top-ups
 *
 * @example
 * ```tsx
 * function BuyCreditsButton({ creditDefinitionId }: { creditDefinitionId: string }) {
 *   const { purchase, loading, error, lastResult } = usePurchaseTopup(userId);
 *   const [quantity, setQuantity] = useState(100);
 *
 *   const handlePurchase = async () => {
 *     try {
 *       const result = await purchase(creditDefinitionId, quantity);
 *       console.log('Payment initiated:', result.payment.id);
 *       // Credits will be granted after payment confirmation via webhook
 *     } catch (err) {
 *       console.error('Purchase failed:', err);
 *     }
 *   };
 *
 *   return (
 *     <div>
 *       <input
 *         type="number"
 *         value={quantity}
 *         onChange={(e) => setQuantity(parseInt(e.target.value))}
 *       />
 *       <button onClick={handlePurchase} disabled={loading}>
 *         {loading ? 'Processing...' : 'Buy Credits'}
 *       </button>
 *       {error && <p>Error: {error.message}</p>}
 *       {lastResult && <p>Purchasing {lastResult.expectedCredits.quantity} credits...</p>}
 *     </div>
 *   );
 * }
 * ```
 */
export function usePurchaseTopup(userId: string): UsePurchaseTopupResult {
  const client = useLumenClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<TopupPurchaseResult | null>(
    null
  );

  const abortControllerRef = useRef<AbortController | null>(null);

  const purchase = useCallback(
    async (
      creditDefinitionId: string,
      quantity: number
    ): Promise<TopupPurchaseResult> => {
      // Cancel any previous request
      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();

      setLoading(true);
      setError(null);

      try {
        const result = await client.purchaseTopup(
          userId,
          creditDefinitionId,
          quantity,
          abortControllerRef.current.signal
        );

        setLastResult(result);
        setLoading(false);
        return result;
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          throw err;
        }

        const error = err as Error;
        setError(error);
        setLoading(false);
        throw error;
      }
    },
    [userId, client]
  );

  const reset = useCallback(() => {
    setError(null);
    setLastResult(null);
  }, []);

  return {
    purchase,
    loading,
    error,
    lastResult,
    reset,
  };
}
