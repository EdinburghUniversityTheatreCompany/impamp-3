"use client";

/**
 * Load a list from a remote source, with cancellation and a manual reload.
 *
 * `SharingPanel` and `ServerSharingPanel` each carried their own copy of this —
 * the same loading/error state, the same effect with the same `cancelled` flag,
 * and the same comment explaining why the flag is there. The cancellation is
 * the part worth having once: a slow response landing after unmount, or after
 * the panel has moved to another profile, writes someone else's data into the
 * open panel, and that is exactly the kind of thing one copy gets fixed for and
 * the other does not.
 *
 * @module hooks/useRemoteList
 */

import { useCallback, useEffect, useState } from "react";

export interface RemoteList {
  /** True only for the first load; a reload keeps the current list on screen. */
  loading: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  /** Re-fetch without a spinner, for after a change. */
  reload: () => Promise<void>;
}

/**
 * @param fetchList - Fetches the list. Its identity gates re-loading, so it
 *   must be stable (`useCallback`) or memoised by its own inputs.
 * @param apply - Writes the result into the caller's state.
 * @param failureMessage - Fallback when the error carries no message.
 */
export function useRemoteList<T>(
  fetchList: () => Promise<T>,
  apply: (value: T) => void,
  failureMessage: string,
): RemoteList {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const describe = useCallback(
    (err: unknown) => (err instanceof Error ? err.message : failureMessage),
    [failureMessage],
  );

  // The initial load, in the shape React documents for fetching in an effect:
  // state is set from the promise's callbacks, and a cancelled flag stops a
  // slow response from landing after unmount or after the caller has moved on.
  useEffect(() => {
    let cancelled = false;

    // Deliberately no `setLoading(true)` here. It starts true and only ever
    // goes false, which is what both callers did — and setting state
    // synchronously inside an effect triggers a cascading render, which the
    // lint rule refuses.
    fetchList().then(
      (value) => {
        if (cancelled) return;
        apply(value);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(describe(err));
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [fetchList, apply, describe]);

  // No spinner: every caller already shows its own in-flight state, and
  // leaving the current list on screen while it refreshes beats blanking it.
  const reload = useCallback(async () => {
    try {
      apply(await fetchList());
      setError(null);
    } catch (err) {
      setError(describe(err));
    }
  }, [fetchList, apply, describe]);

  return { loading, error, setError, reload };
}
