import { useState, useEffect, useCallback } from "react";
import { getPadConfigurationsForProfilePage, PadConfiguration } from "@/lib/db"; // Assuming PadConfiguration is exported from db.ts

interface UsePadConfigurationsResult {
  padConfigs: Map<number, PadConfiguration>;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void; // Added a refetch function for manual refresh if needed
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
  const [padConfigs, setPadConfigs] = useState<Map<number, PadConfiguration>>(
    new Map(),
  );
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchConfigs = useCallback(async () => {
    if (!profileId) {
      // If there's no profile ID, clear existing configs and don't fetch.
      setPadConfigs(new Map());
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    console.log(
      `usePadConfigurations: Fetching for profile ${profileId}, page ${pageIndex}`,
    );

    try {
      // Convert profileId string to number before calling DB function
      const numericProfileId = parseInt(profileId, 10);
      if (isNaN(numericProfileId)) {
        throw new Error(`Invalid profileId format: ${profileId}`);
      }

      // Fetch the configurations as an array using the numeric ID
      const configArray = await getPadConfigurationsForProfilePage(
        numericProfileId,
        pageIndex,
      );
      console.log(
        `usePadConfigurations: Fetched ${configArray.length} configs for profile ID ${numericProfileId}`,
      );

      // Convert the array to a Map, using padIndex as the key
      const configMap = new Map<number, PadConfiguration>();
      configArray.forEach((config) => {
        if (config.padIndex !== undefined) {
          // Ensure padIndex exists
          configMap.set(config.padIndex, config);
        } else {
          console.warn(
            "usePadConfigurations: Found config without padIndex, skipping:",
            config,
          );
        }
      });

      setPadConfigs(configMap);
    } catch (err) {
      console.error(
        "usePadConfigurations: Error fetching pad configurations:",
        err,
      );
      setError(
        err instanceof Error
          ? err
          : new Error("Failed to fetch pad configurations"),
      );
      setPadConfigs(new Map()); // Clear configs on error
    } finally {
      setIsLoading(false);
    }
  }, [profileId, pageIndex]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]); // Dependency array includes fetchConfigs, which changes when profileId or pageIndex changes

  return { padConfigs, isLoading, error, refetch: fetchConfigs };
}
