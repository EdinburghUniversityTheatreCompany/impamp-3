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
import { usePlaybackStore, PlaybackState } from "@/store/playbackStore";
import { useTrackControls } from "@/hooks/useTrackControls";
import { usePlaybackSettings } from "@/hooks/usePlaybackSettings";
import PanelHeader from "./shared/PanelHeader";
import TrackItem from "./shared/TrackItem";

/**
 * Panel component that displays currently playing tracks
 */
const ActiveTracksPanel: React.FC = () => {
  // Subscribe to the playback store
  const activePlaybackMap = usePlaybackStore((state) => state.activePlayback);

  // Convert map to array for easier rendering and memoize it
  const activeTracksArray = useMemo(
    () => Array.from(activePlaybackMap.values()),
    [activePlaybackMap],
  );

  // Get track controls hook (used internally by TrackItem)
  const {} = useTrackControls();

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
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-5 w-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
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

        {activeTracksArray.length === 0 ? (
          // Show "Nothing playing" when no tracks are active
          <div className="text-gray-500 dark:text-gray-400 text-center py-3">
            Nothing playing
          </div>
        ) : (
          // List of active tracks with better overflow handling for bottom panel
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[20vh] overflow-y-auto pr-1 pb-safe">
            {activeTracksArray.map((track: PlaybackState) => (
              <TrackItem
                key={track.key}
                trackKey={track.key}
                name={track.name}
                remainingTime={track.remainingTime}
                totalDuration={track.totalDuration}
                progress={track.progress}
                isFading={track.isFading}
                isActive={true}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ActiveTracksPanel;
