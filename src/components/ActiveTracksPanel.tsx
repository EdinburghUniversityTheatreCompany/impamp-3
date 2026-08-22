/**
 * Active Tracks Panel Component
 *
 * Displays a panel of tracks that are currently playing.
 * Offers controls to stop or fade out tracks, and includes playback settings.
 *
 * @module components/ActiveTracksPanel
 */

"use client";

import React, { useMemo } from "react";
import { usePlaybackStore, groupPlaybackByPad } from "@/store/playbackStore";
import { usePlaybackSettings } from "@/hooks/usePlaybackSettings";
import PanelHeader from "./shared/PanelHeader";
import PadTrackGroup from "./shared/PadTrackGroup";
import { GearIcon } from "@/components/icons";

/**
 * Panel component that displays currently playing tracks
 */
const ActiveTracksPanel: React.FC = () => {
  // Subscribe to the playback store
  const activePlaybackMap = usePlaybackStore((state) => state.activePlayback);

  // Fold the instance-keyed map into one group per pad, and memoize it
  const trackGroups = useMemo(
    () => groupPlaybackByPad(activePlaybackMap),
    [activePlaybackMap],
  );

  // Get playback settings hook
  const { openPlaybackSettings } = usePlaybackSettings();

  // Settings button for the panel header
  const settingsButton = (
    <button
      onClick={openPlaybackSettings}
      className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      aria-label="Playback settings"
      title="Configure playback settings"
    >
      <GearIcon className="h-5 w-5" />
    </button>
  );

  // Help text for ESC key
  const helpText = (
    <>
      Press{" "}
      <kbd className="px-1 py-0.5 bg-gray-200 dark:bg-gray-600 rounded font-mono">
        ESC
      </kbd>{" "}
      to stop all sounds
    </>
  );

  return (
    <div
      className="bg-gray-100 dark:bg-gray-800 border-t border-gray-300 dark:border-gray-700 p-4 w-full shadow-lg"
      data-testid="active-tracks-panel"
    >
      <div className="max-w-6xl mx-auto">
        <PanelHeader
          title="Active Tracks"
          helpText={helpText}
          actions={settingsButton}
        />

        {trackGroups.length === 0 ? (
          // Show "Nothing playing" when no tracks are active
          <div className="text-gray-500 dark:text-gray-400 text-center py-3">
            Nothing playing
          </div>
        ) : (
          // List of active tracks with better overflow handling for bottom panel
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[20vh] overflow-y-auto pr-1 pb-safe">
            {trackGroups.map((group) => (
              <PadTrackGroup key={group.baseKey} group={group} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ActiveTracksPanel;
