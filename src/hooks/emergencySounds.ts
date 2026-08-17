/**
 * The emergency sound set — what the Enter key fires.
 *
 * This lived inside `useKeyboardListener` as a pair of module-global refs and a
 * `useCallback`, which is why the ordering rule below could never be stated,
 * let alone tested: the only way in was to render the hook. It is not React
 * state (nothing re-renders when it changes) and it outlives every component
 * that reads it, so it belongs in a module of its own.
 *
 * @module hooks/emergencySounds
 */

import {
  PlaybackType,
  getAllPageMetadataForProfile,
  getPadConfigurationsForProfilePage,
} from "@/lib/db";

/** One pad on an emergency bank, everything needed to fire it. */
export interface EmergencySound {
  profileId: number;
  pageIndex: number;
  padIndex: number;
  audioFileIds: number[];
  playbackType: PlaybackType;
  name?: string;
  audioTrimSettings?: Record<number, { trimStart: number; trimEnd: number }>;
  audioGainSettings?: Record<number, number>;
  padGainDb?: number;
}

let emergencySounds: EmergencySound[] = [];
let cursor = 0;
let hasEverLoaded = false;

/**
 * Monotonic token for emergency-set loads.
 *
 * A load is not one read but a page-metadata read followed by one pad read per
 * emergency bank, so its duration depends on how many emergency banks the
 * profile has. Switch from a profile with three to a profile with none and the
 * second load routinely finishes first — after which the first one's write
 * landed last and Enter fired the profile you had just left. Clearing the set
 * before the await, which is what the code used to do, closes the window
 * *during* the await and does nothing about a superseded load resolving after
 * it. The same token `setCurrentPageIndex` uses for bank switches.
 */
let loadToken = 0;

/** Stable identity of a loaded set, used to detect a real change. */
function describeEmergencySounds(sounds: EmergencySound[]): string {
  return sounds.map((s) => `${s.pageIndex}:${s.padIndex}`).join(",");
}

/** Read every configured, enabled pad on every emergency bank of a profile. */
async function readEmergencySounds(
  profileId: number,
): Promise<EmergencySound[]> {
  try {
    const allPages = await getAllPageMetadataForProfile(profileId);
    const emergencyPages = allPages.filter((page) => page.isEmergency);

    if (emergencyPages.length === 0) {
      console.log("No emergency pages found");
      return [];
    }

    console.log(`Found ${emergencyPages.length} emergency pages`);

    const sounds: EmergencySound[] = [];
    for (const page of emergencyPages) {
      const padConfigs = await getPadConfigurationsForProfilePage(
        profileId,
        page.pageIndex,
      );

      const configuredPads = padConfigs.filter(
        (pad) =>
          pad.audioFileIds && pad.audioFileIds.length > 0 && !pad.isDisabled,
      );

      sounds.push(
        ...configuredPads.map((pad) => ({
          profileId,
          pageIndex: page.pageIndex,
          padIndex: pad.padIndex,
          audioFileIds: pad.audioFileIds!,
          playbackType: pad.playbackType,
          name: pad.name,
          audioTrimSettings: pad.audioTrimSettings,
          audioGainSettings: pad.audioGainSettings,
          padGainDb: pad.padGainDb,
        })),
      );
    }

    console.log(`Loaded ${sounds.length} emergency sounds`);
    return sounds;
  } catch (error) {
    console.error("Error loading emergency sounds:", error);
    return [];
  }
}

/**
 * Reload the emergency set for a profile, discarding superseded loads.
 *
 * @param profileId - The profile to load for, or null to empty the set
 */
export async function reloadEmergencySounds(
  profileId: number | null,
): Promise<void> {
  const token = ++loadToken;
  console.log("Reloading emergency sounds...");

  if (profileId === null) {
    console.log("No active profile, skipping emergency sounds load");
    emergencySounds = [];
    cursor = 0;
    return;
  }

  // Dropped before the await, not after it. This state is module-global, so it
  // survives a profile switch, and between the switch and this load resolving
  // Enter played the *previous* profile's emergency sound. The old set is kept
  // only to decide whether the round-robin cursor should reset.
  const previousSounds = emergencySounds;
  emergencySounds = [];

  const sounds = await readEmergencySounds(profileId);

  // A newer load has been started in the meantime, and it has already cleared
  // the set. Writing here would put this profile's sounds behind that one's
  // Enter key — the failure the comment above claims to have closed.
  if (token !== loadToken) {
    console.log(
      `Discarding superseded emergency sound load for profile ${profileId}`,
    );
    return;
  }

  emergencySounds = sounds;

  // Only restart the round-robin when the set of sounds actually changed,
  // otherwise keep the cursor (clamped to the new length).
  if (
    describeEmergencySounds(previousSounds) !== describeEmergencySounds(sounds)
  ) {
    cursor = 0;
  } else if (sounds.length > 0) {
    cursor %= sounds.length;
  } else {
    cursor = 0;
  }

  hasEverLoaded = true;
  console.log(`Reloaded ${sounds.length} emergency sounds`);
}

/**
 * The next emergency sound in round-robin order, advancing the cursor.
 *
 * @returns The sound to fire, or undefined when the set is empty
 */
export function takeNextEmergencySound(): EmergencySound | undefined {
  if (emergencySounds.length === 0) return undefined;

  const index = cursor;
  cursor = (index + 1) % emergencySounds.length;
  console.log(
    `[EmergencySounds] Playing ${index + 1}/${emergencySounds.length}: pad ${emergencySounds[index].padIndex}`,
  );
  return emergencySounds[index];
}

/** How many sounds are armed for Enter. */
export function emergencySoundCount(): number {
  return emergencySounds.length;
}

/**
 * Whether a load has ever completed.
 *
 * Enter uses this to tell "this profile has no emergency banks" from "nothing
 * has tried to look yet", and loads on the spot in the second case.
 */
export function hasLoadedEmergencySounds(): boolean {
  return hasEverLoaded;
}
