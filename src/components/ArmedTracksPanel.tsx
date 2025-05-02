/**
 * Armed Tracks Panel Component
 *
 * Displays a panel of tracks that have been armed for future playback.
 * Offers controls to play or remove armed tracks.
 *
 * @module components/ArmedTracksPanel
 */

"use client";

import React, { useMemo } from "react";
import {
  useArmedTracks,
  ArmedTrackState,
  playbackStoreActions,
} from "@/store/playbackStore";
import PanelHeader from "./shared/PanelHeader";
import TrackItem from "./shared/TrackItem";

/**
 * Panel component that displays armed tracks and provides controls
 */
const ArmedTracksPanel: React.FC = () => {
  // Subscribe to the armed tracks store
  const armedTracksMap = useArmedTracks();

  // Convert map to array for easier rendering and memoize it
  const armedTracksArray = useMemo(
    () => Array.from(armedTracksMap.values()),
    [armedTracksMap],
  );

  // If there are no armed tracks, don't render anything
  if (armedTracksArray.length === 0) {
    return null;
  }

  // Play the next armed track
  const handlePlayNext = () => {
    // Currently the store only supports playing the next armed track in queue
    playbackStoreActions.playNextArmedTrack();
  };

  // Remove an armed track without playing it
  const handleRemoveArmedTrack = (key: string) => {
    playbackStoreActions.removeArmedTrack(key);
  };

  // Help text for F9 shortcut
  const helpText = (
    <>
      Press{" "}
      <kbd className="px-1 py-0.5 bg-gray-200 dark:bg-gray-600 rounded font-mono">
        F9
      </kbd>{" "}
      to play next armed track
    </>
  );

  return (
    <div
      className="bg-gray-100 dark:bg-gray-800 border-t border-gray-300 dark:border-gray-700 p-4 w-full shadow-lg"
      data-testid="armed-tracks-panel"
    >
      <div className="max-w-6xl mx-auto">
        <PanelHeader title="Armed Tracks" helpText={helpText} />

        {/* List of armed tracks */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[15vh] overflow-y-auto pr-1 pb-safe">
          {armedTracksArray.map((track: ArmedTrackState) => (
            <TrackItem
              key={track.key}
              trackKey={track.key}
              name={track.name}
              isActive={false}
              onPlay={() => handlePlayNext()}
              onRemove={() => handleRemoveArmedTrack(track.key)}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default ArmedTracksPanel;
