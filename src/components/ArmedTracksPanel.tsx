"use client";

import React, { useMemo } from "react";
import {
  useArmedTracks,
  ArmedTrackState,
  playbackStoreActions,
} from "@/store/playbackStore";

const ArmedTracksPanel: React.FC = () => {
  // Subscribe to the armed tracks store
  const armedTracksMap = useArmedTracks();

  // Convert map to array for easier rendering and memoize it
  const armedTracksArray = useMemo(
    () => Array.from(armedTracksMap.values()),
    [armedTracksMap],
  );

  // Play the next armed track (which will also remove it from armed tracks)
  const handlePlayNextArmedTrack = () => {
    playbackStoreActions.playNextArmedTrack();
  };

  // Remove an armed track without playing it
  const handleRemoveArmedTrack = (key: string) => {
    playbackStoreActions.removeArmedTrack(key);
  };

  // If there are no armed tracks, don't render anything
  if (armedTracksArray.length === 0) {
    return null;
  }

  return (
    <div
      className="bg-gray-100 dark:bg-gray-800 border-t border-gray-300 dark:border-gray-700 p-4 w-full shadow-lg mt-2"
      data-testid="armed-tracks-panel"
    >
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
              Armed Tracks
            </h2>
          </div>

          {/* Help text for F9 shortcut */}
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Press{" "}
            <kbd className="px-1 py-0.5 bg-gray-200 dark:bg-gray-600 rounded font-mono">
              F9
            </kbd>{" "}
            to play next armed track
          </div>
        </div>

        {/* List of armed tracks */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[15vh] overflow-y-auto pr-1 pb-safe">
          {armedTracksArray.map((track: ArmedTrackState) => (
            <div
              key={track.key}
              className="flex items-center space-x-3 p-3 rounded shadow-sm
                  bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-800 dark:text-gray-200 truncate">
                  {track.name}
                  <span className="ml-2 text-xs text-amber-500 dark:text-amber-400 font-normal">
                    armed
                  </span>
                </div>
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => handlePlayNextArmedTrack()}
                  className="bg-green-500 hover:bg-green-600 text-white p-1.5 rounded flex-shrink-0"
                  aria-label={`Play ${track.name}`}
                  title="Play this track now"
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
                      d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </button>
                <button
                  onClick={() => handleRemoveArmedTrack(track.key)}
                  className="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded flex-shrink-0"
                  aria-label={`Remove ${track.name} from armed tracks`}
                  title="Remove from armed tracks"
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
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ArmedTracksPanel;
