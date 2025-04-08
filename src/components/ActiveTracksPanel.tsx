'use client';

import React, { useState, useEffect } from 'react';
import { getActiveTracks, stopAudio } from '@/lib/audio';

// Format time in seconds to MM:SS format
const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const ActiveTracksPanel: React.FC = () => {
  const [activeTracks, setActiveTracks] = useState<ReturnType<typeof getActiveTracks>>([]);
  
  // Update the list every 100ms to show accurate remaining time
  useEffect(() => {
    const intervalId = setInterval(() => {
      setActiveTracks(getActiveTracks());
    }, 100);
    
    return () => clearInterval(intervalId);
  }, []);
  
  // Custom stop function that removes the track from the list immediately
  const handleStopTrack = (key: string) => {
    // Stop the audio
    stopAudio(key);
    // Remove from local state immediately for better UX
    setActiveTracks(current => current.filter(track => track.key !== key));
  };
  
  return (
    <div className="bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-4 h-full">
      <h2 className="text-lg font-semibold mb-3 text-gray-800 dark:text-gray-200">Active Tracks</h2>
      
      {activeTracks.length === 0 ? (
        // Show "Nothing playing" when no tracks are active
        <div className="text-gray-500 dark:text-gray-400 text-center py-3">
          Nothing playing
        </div>
      ) : (
        // List of active tracks with better overflow handling
        <div className="space-y-3 max-h-[calc(100vh-180px)] overflow-y-auto pr-1">
          {activeTracks.map((track) => (
            <div 
              key={track.key} 
              className="flex items-center space-x-3 bg-white dark:bg-gray-700 p-3 rounded shadow-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-800 dark:text-gray-200 truncate">
                  {track.name}
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-600 rounded-full h-2 mt-2">
                  <div 
                    className="bg-blue-500 h-2 rounded-full transition-all duration-100" 
                    style={{ width: `${track.progress * 100}%` }}
                  />
                </div>
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-300 min-w-[50px] text-right font-mono">
                {formatTime(track.remainingTime)}
              </div>
              <button
                onClick={() => handleStopTrack(track.key)}
                className="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded flex-shrink-0"
                aria-label={`Stop playing ${track.name}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      
      {/* Help text for ESC panic button */}
      <div className="mt-3 pt-2 text-xs text-gray-500 dark:text-gray-400 text-center border-t border-gray-200 dark:border-gray-700">
        Press <kbd className="px-1 py-0.5 bg-gray-200 dark:bg-gray-600 rounded font-mono">ESC</kbd> to stop all sounds
      </div>
    </div>
  );
};

export default ActiveTracksPanel;
