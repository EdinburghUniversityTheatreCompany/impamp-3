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
  // Bumped by refetch(). A counter rather than a callback so that a manual
  // refresh is just another request, handled by the same effect.
  const [reloadToken, setReloadToken] = useState(0);
  const [result, setResult] = useState<FetchResult | null>(null);

  // Everything that means "a different set of configurations". padConfigsVersion
  // is in here because the store bumps it whenever pads change elsewhere.
  const requestKey = `${profileId}|${pageIndex}|${padConfigsVersion}|${reloadToken}`;

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

  const refetch = useCallback(() => setReloadToken((n) => n + 1), []);

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
