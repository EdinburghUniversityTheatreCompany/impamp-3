import { useState, useEffect, useCallback, useMemo } from "react";
import { getPadConfigurationsForProfilePage, PadConfiguration } from "@/lib/db"; // Assuming PadConfiguration is exported from db.ts
import { useProfileStore } from "@/store/profileStore";

interface UsePadConfigurationsResult {
  padConfigs: Map<number, PadConfiguration>;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void; // Added a refetch function for manual refresh if needed
}

const NO_CONFIGS: Map<number, PadConfiguration> = new Map();

/** What we last finished fetching, and for which request. */
interface FetchResult {
  requestKey: string;
  padConfigs: Map<number, PadConfiguration>;
  error: Error | null;
}

function toConfigMap(
  configArray: PadConfiguration[],
): Map<number, PadConfiguration> {
  const configMap = new Map<number, PadConfiguration>();
  for (const config of configArray) {
    if (config.padIndex === undefined) {
      console.warn(
        "usePadConfigurations: Found config without padIndex, skipping:",
        config,
      );
      continue;
    }
    configMap.set(config.padIndex, config);
  }
  return configMap;
}

/**
 * Custom hook to fetch and manage pad configurations for a specific profile page.
 * @param profileId The ID of the active profile, or null if none.
 * @param pageIndex The index of the current page (bank).
 * @returns An object containing the pad configurations, loading state, error state, and a refetch function.
 */
export function usePadConfigurations(
  profileId: string | null,
  pageIndex: number,
): UsePadConfigurationsResult {
  const padConfigsVersion = useProfileStore((state) => state.padConfigsVersion);
  const incrementPadConfigsVersion = useProfileStore(
    (state) => state.incrementPadConfigsVersion,
  );
  const [result, setResult] = useState<FetchResult | null>(null);

  // Everything that means "a different set of configurations".
  //
  // `padConfigsVersion` is the *only* invalidator on purpose. There used to be
  // a hook-local `reloadToken` bumped by refetch() as well, which meant a
  // refresh reached this hook instance and nothing else — and
  // `useKeyboardListener` kept its own copy of the same data, keyed on the
  // store counter alone. A write path that called refetch() without also
  // bumping the counter therefore updated what you could see and not what you
  // could play. Two write paths did exactly that.
  const requestKey = `${profileId}|${pageIndex}|${padConfigsVersion}`;

  useEffect(() => {
    if (!profileId) return;

    let cancelled = false;
    const numericProfileId = parseInt(profileId, 10);

    const request = Number.isNaN(numericProfileId)
      ? Promise.reject(new Error(`Invalid profileId format: ${profileId}`))
      : getPadConfigurationsForProfilePage(numericProfileId, pageIndex);

    request.then(
      (configArray) => {
        if (cancelled) return;
        setResult({
          requestKey,
          padConfigs: toConfigMap(configArray),
          error: null,
        });
      },
      (err: unknown) => {
        if (cancelled) return;
        console.error(
          "usePadConfigurations: Error fetching pad configurations:",
          err,
        );
        setResult({
          requestKey,
          padConfigs: NO_CONFIGS,
          error:
            err instanceof Error
              ? err
              : new Error("Failed to fetch pad configurations"),
        });
      },
    );

    // A bank switch or profile change must not be overwritten by the response
    // to the request it replaced.
    return () => {
      cancelled = true;
    };
  }, [profileId, pageIndex, requestKey]);

  // Deliberately the store action rather than local state: every consumer of
  // pad configurations has to hear about a refresh, not just this one.
  const refetch = useCallback(
    () => incrementPadConfigsVersion(),
    [incrementPadConfigsVersion],
  );

  // isLoading is derived rather than stored: we are loading exactly while the
  // newest result on hand is not the one for the request now in flight. Storing
  // it meant setting state synchronously inside the effect, one extra render
  // per fetch, purely to say something the state we already have implies.
  return useMemo(
    () => ({
      padConfigs: profileId ? (result?.padConfigs ?? NO_CONFIGS) : NO_CONFIGS,
      isLoading: profileId !== null && result?.requestKey !== requestKey,
      error: profileId ? (result?.error ?? null) : null,
      refetch,
    }),
    [profileId, requestKey, result, refetch],
  );
}
