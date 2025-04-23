"use client";

import React, { useState, useEffect, useMemo } from "react";
import { stopAudio, fadeOutAudio } from "@/lib/audio";
import { useProfileStore } from "@/store/profileStore";
import { ActivePadBehavior } from "@/lib/db";
import { usePlaybackStore, PlaybackState } from "@/store/playbackStore";

// Format time in seconds to MM:SS format
const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

const ActiveTracksPanel: React.FC = () => {
  // Subscribe to the playback store
  const activePlaybackMap = usePlaybackStore((state) => state.activePlayback);
  // Convert map to array for easier rendering and memoize it
  const activeTracksArray = useMemo(
    () => Array.from(activePlaybackMap.values()),
    [activePlaybackMap],
  );

  const getFadeoutDuration = useProfileStore(
    (state) => state.getFadeoutDuration,
  );
  const setFadeoutDuration = useProfileStore(
    (state) => state.setFadeoutDuration,
  );
  const getActivePadBehavior = useProfileStore(
    (state) => state.getActivePadBehavior,
  );
  const setActivePadBehavior = useProfileStore(
    (state) => state.setActivePadBehavior,
  );

  const [showSettings, setShowSettings] = useState(false);
  // State for the modal inputs
  const [durationInput, setDurationInput] = useState<string>("");
  const [behaviorInput, setBehaviorInput] =
    useState<ActivePadBehavior>("continue");

  // Update the input fields when settings modal opens
  useEffect(() => {
    if (showSettings) {
      // Initialize modal state with current store values
      setDurationInput(getFadeoutDuration().toString());
      setBehaviorInput(getActivePadBehavior());
    }
  }, [showSettings, getFadeoutDuration, getActivePadBehavior]);
  // Stop function - just calls the audio lib function which handles store updates
  const handleStopTrack = (key: string) => {
    stopAudio(key);
  };

  // Handle fadeout with current fadeout duration
  const handleFadeoutTrack = (key: string) => {
    // Get current fadeout duration from profile store
    const duration = getFadeoutDuration();
    // Fade out the audio
    fadeOutAudio(key, duration);
    // Store updates are handled within fadeOutAudio and the rAF loop
  };

  return (
    <div
      className="bg-gray-100 dark:bg-gray-800 border-t border-gray-300 dark:border-gray-700 p-4 w-full shadow-lg"
      data-testid="active-tracks-panel" // Added test ID
    >
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
              Active Tracks
            </h2>
            <button
              onClick={() => setShowSettings(true)}
              className="ml-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              aria-label="Fadeout settings"
              title="Configure fadeout duration"
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
          </div>

          {/* Help text for ESC panic button */}
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Press{" "}
            <kbd className="px-1 py-0.5 bg-gray-200 dark:bg-gray-600 rounded font-mono">
              ESC
            </kbd>{" "}
            to stop all sounds
          </div>
        </div>

        {/* Settings modal for fadeout duration */}
        {showSettings && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl max-w-md w-full">
              <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6">
                Playback Settings
              </h3>

              {/* Fadeout Duration Section */}
              <div className="mb-6 border-b border-gray-200 dark:border-gray-700 pb-6">
                <h4 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">
                  Fadeout
                </h4>
                <label
                  htmlFor="fadeout-duration"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
                >
                  Fadeout Duration (seconds)
                </label>
                <input
                  type="number"
                  id="fadeout-duration"
                  value={durationInput}
                  onChange={(e) => setDurationInput(e.target.value)}
                  min="0.5"
                  max="10"
                  step="0.5"
                  className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Set how long it takes for sound to fade out (0.5 to 10
                  seconds)
                </p>
              </div>

              {/* Active Pad Behavior Section */}
              <div className="mb-4">
                <h4 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">
                  Active Pad Trigger Behavior
                </h4>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                  What happens when you trigger a pad that&apos;s already
                  playing?
                </p>
                <div className="space-y-2">
                  {(
                    [
                      {
                        value: "continue",
                        label: "Continue Playing (Default)",
                      },
                      { value: "stop", label: "Stop Sound" },
                      { value: "restart", label: "Restart Sound" },
                    ] as { value: ActivePadBehavior; label: string }[]
                  ).map((option) => (
                    <label
                      key={option.value}
                      className="flex items-center space-x-2 cursor-pointer"
                    >
                      <input
                        type="radio"
                        name="activePadBehavior"
                        value={option.value}
                        checked={behaviorInput === option.value}
                        onChange={() => setBehaviorInput(option.value)}
                        className="form-radio h-4 w-4 text-blue-600 dark:text-blue-400 border-gray-300 dark:border-gray-600 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-700"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        {option.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end space-x-3 pt-4 border-t border-gray-200 dark:border-gray-700">
                <button
                  onClick={() => setShowSettings(false)}
                  className="px-4 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-md text-gray-800 dark:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    // Make async for setActivePadBehavior
                    const duration = parseFloat(durationInput);
                    let durationIsValid = false;

                    if (!isNaN(duration) && duration >= 0.5 && duration <= 10) {
                      setFadeoutDuration(duration);
                      durationIsValid = true;
                    } else {
                      alert(
                        "Please enter a valid fadeout duration between 0.5 and 10 seconds.",
                      );
                    }

                    // Only proceed if duration was valid
                    if (durationIsValid) {
                      // Save the behavior setting (already validated by radio buttons)
                      await setActivePadBehavior(behaviorInput);
                      setShowSettings(false); // Close modal on successful save
                    }
                  }}
                  className="px-4 py-2 bg-blue-500 hover:bg-blue-600 rounded-md text-white"
                >
                  Save Settings
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTracksArray.length === 0 ? (
          // Show "Nothing playing" when no tracks are active
          <div className="text-gray-500 dark:text-gray-400 text-center py-3">
            Nothing playing
          </div>
        ) : (
          // List of active tracks with better overflow handling for bottom panel
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[20vh] overflow-y-auto pr-1 pb-safe">
            {/* Use the memoized array derived from the store */}
            {activeTracksArray.map((track: PlaybackState) => (
              <div
                key={track.key}
                className={`flex items-center space-x-3 p-3 rounded shadow-sm cursor-pointer
                  transition-colors ${
                    track.isFading
                      ? "bg-blue-50 dark:bg-blue-900/30 animate-pulse"
                      : "bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                  }`}
                onClick={() => handleStopTrack(track.key)}
                aria-label={`Stop playing ${track.name}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-800 dark:text-gray-200 truncate">
                    {track.name}
                    {track.isFading && (
                      <span className="ml-2 text-xs text-blue-500 dark:text-blue-400 font-normal">
                        fading out...
                      </span>
                    )}
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-600 rounded-full h-2 mt-2">
                    <div
                      className={`h-2 rounded-full transition-all duration-100 ${
                        track.isFading ? "bg-blue-400" : "bg-blue-500"
                      }`}
                      style={{ width: `${track.progress * 100}%` }}
                    />
                  </div>
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-300 min-w-[50px] text-right font-mono">
                  {formatTime(track.remainingTime)}
                </div>
                {!track.isFading ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation(); // Prevent triggering the parent div's onClick
                      handleFadeoutTrack(track.key);
                    }}
                    className="bg-blue-500 hover:bg-blue-600 text-white p-1.5 rounded flex-shrink-0"
                    aria-label={`Fade out ${track.name}`}
                    title={`Fade out over ${getFadeoutDuration()} ${getFadeoutDuration() === 1 ? "second" : "seconds"}`}
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
                        d="M15.536 8.464a5 5 0 010 7.072M12 9.5l-3 3L12 15.5m4.5-4.5h-7.5"
                      />
                    </svg>
                  </button>
                ) : (
                  <div
                    className="p-1.5 rounded flex-shrink-0 text-blue-400"
                    title="Fading out..."
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
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ActiveTracksPanel;
