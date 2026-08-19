import { useState, useEffect, useCallback, useMemo } from "react";
import { getPadConfigurationsForProfileBank, PadConfiguration } from "@/lib/db"; // Assuming PadConfiguration is exported from db.ts
import { useProfileStore } from "@/store/profileStore";

interface UsePadConfigurationsResult {
  padConfigs: Map<number, PadConfiguration>;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void; // Added a refetch function for manual refresh if needed
}

/**
 * The empty result, shared so every "no pads right now" is the same object and
 * a consumer holding it in a ref does not see a change that isn't one.
 */
export const NO_CONFIGS: Map<number, PadConfiguration> = new Map();

/**
 * The pads a trigger may act on, as opposed to the pads worth drawing.
 *
 * These differ, and the difference is the whole point. This hook keeps the
 * last successful result while the next read is in flight so the grid does not
 * blank on every bank change — but during that window the map describes the
 * bank you just left, under the new bank's key positions. Rendering it for a
 * frame is a cosmetic choice; playing, arming, editing or deleting from it is
 * not, and it is the same wrong sound either way.
 *
 * Written once because it was previously written once: `PadGrid` guarded its
 * mouse path and `useKeyboardListener` did not, so the keyboard kept firing the
 * previous bank's sounds long after the click path stopped.
 *
 * @param padConfigs - The latest configs on hand
 * @param isLoading - Whether a newer read is still in flight
 * @returns The configs safe to act on, empty while loading
 */
export function actionablePadConfigs(
  padConfigs: Map<number, PadConfiguration>,
  isLoading: boolean,
): Map<number, PadConfiguration> {
  return isLoading ? NO_CONFIGS : padConfigs;
}

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
 * Custom hook to fetch and manage pad configurations for a specific profile bank.
 * @param profileId The ID of the active profile, or null if none.
 * @param bankId The identity of the current bank, or null if none.
 * @returns An object containing the pad configurations, loading state, error state, and a refetch function.
 */
export function usePadConfigurations(
  profileId: string | null,
  bankId: string | null,
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
  const requestKey = `${profileId}|${bankId}|${padConfigsVersion}`;

  useEffect(() => {
    if (!profileId || !bankId) return;

    let cancelled = false;
    const numericProfileId = parseInt(profileId, 10);

    const request = Number.isNaN(numericProfileId)
      ? Promise.reject(new Error(`Invalid profileId format: ${profileId}`))
      : getPadConfigurationsForProfileBank(numericProfileId, bankId);

    request.then(
      (configArray: PadConfiguration[]) => {
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
  }, [profileId, bankId, requestKey]);

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
  const hasTarget = profileId !== null && bankId !== null;
  return useMemo(
    () => ({
      padConfigs: hasTarget ? (result?.padConfigs ?? NO_CONFIGS) : NO_CONFIGS,
      isLoading: hasTarget && result?.requestKey !== requestKey,
      error: hasTarget ? (result?.error ?? null) : null,
      refetch,
    }),
    [hasTarget, requestKey, result, refetch],
  );
}
