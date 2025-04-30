/**
 * Utility functions for Google Drive integration
 */
import { ProfileSyncData } from "@/lib/syncUtils";

/**
 * Constructs a standardized filename for profile sync data
 * @param profileName The name of the profile
 * @returns A sanitized filename suitable for Google Drive
 */
export const getProfileSyncFilename = (profileName: string): string => {
  const sanitizedName = profileName
    .replace(/[^a-z0-9._-]/gi, "-")
    .toLowerCase();
  return `impamp-profile-${sanitizedName}.json`;
};

/**
 * Validates the Google auth token
 * @param accessToken The Google access token
 * @param expiresAt The token expiration timestamp
 * @returns Boolean indicating if the token is still valid
 */
export const isTokenValid = (
  accessToken: string | null,
  expiresAt: number | null,
): boolean => {
  if (!accessToken) return false;
  if (!expiresAt) return false;

  // Add a 5-minute buffer to prevent edge cases
  const bufferMs = 5 * 60 * 1000;
  return Date.now() < expiresAt - bufferMs;
};

/**
 * Creates a cache key for storing profile sync timestamps
 * @param profileId The profile ID
 * @returns A localStorage-compatible key
 */
export const getSyncTimestampKey = (profileId: number): string => {
  return `lastSync_${profileId}`;
};

/**
 * Updates the last sync timestamp for a profile
 * @param profileId The profile ID
 * @param timestamp Optional timestamp to use (defaults to now)
 */
export const updateSyncTimestamp = (
  profileId: number,
  timestamp?: number,
): void => {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    getSyncTimestampKey(profileId),
    (timestamp ?? Date.now()).toString(),
  );
};

/**
 * Gets the last sync timestamp for a profile
 * @param profileId The profile ID
 * @returns The timestamp or 0 if none exists
 */
export const getSyncTimestamp = (profileId: number): number => {
  if (typeof window === "undefined") return 0;
  return parseInt(
    localStorage.getItem(getSyncTimestampKey(profileId)) || "0",
    10,
  );
};
