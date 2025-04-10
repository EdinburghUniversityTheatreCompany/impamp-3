'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useProfileStore } from '@/store/profileStore';
import { getAllPadConfigurationsForProfile, getAudioFile } from '@/lib/db';
import { loadAndDecodeAudio, playAudio, resumeAudioContext } from '@/lib/audio';

interface SearchResult {
  profileId: number;
  pageIndex: number;
  padIndex: number;
  name: string;
  audioFileId: number;
  originalFileName: string;
  bankName: string;
}

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SearchModal: React.FC<SearchModalProps> = ({ isOpen, onClose }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  
  // Get active profile from store
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  const convertIndexToBankNumber = useProfileStore((state) => state.convertIndexToBankNumber);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault(); // Prevent the global Escape handler (panic button)
        e.stopPropagation(); // Stop event from bubbling up to global listeners
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true); // Use capture phase to ensure this runs before other handlers
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  // Handle search
  useEffect(() => {
    if (!isOpen || !searchTerm.trim() || !activeProfileId) return;

    const searchPads = async () => {
      setIsLoading(true);
      try {
        // Get all pad configurations for the active profile
        const allPads = await getAllPadConfigurationsForProfile(activeProfileId);
        
        // Create a map to store bank names by index
        const bankNames = new Map<number, string>();
        
        // Filter pads with audio files and matching names
        const searchResults: SearchResult[] = [];
        
        // Process each pad
        for (const pad of allPads) {
          if (!pad.audioFileId) continue;
          
          // Try to get bank name if we haven't loaded it yet
          if (!bankNames.has(pad.pageIndex)) {
            try {
              // You might need to implement a function to get bank name
              // For now, we'll use a default format
              bankNames.set(pad.pageIndex, `Bank ${convertIndexToBankNumber(pad.pageIndex)}`);
            } catch (error) {
              console.error(`Error getting bank name for index ${pad.pageIndex}:`, error);
              bankNames.set(pad.pageIndex, `Bank ${convertIndexToBankNumber(pad.pageIndex)}`);
            }
          }
          
          // Get pad name and file name
          const padName = pad.name || `Pad ${pad.padIndex + 1}`;
          let originalFileName = '';
          
          // Try to get original file name
          try {
            const audioFile = await getAudioFile(pad.audioFileId);
            if (audioFile) {
              originalFileName = audioFile.name;
            }
          } catch (error) {
            console.error(`Error getting audio file ${pad.audioFileId}:`, error);
          }
          
          // Check if pad matches search term
          const searchTermLower = searchTerm.toLowerCase();
          if (
            padName.toLowerCase().includes(searchTermLower) || 
            originalFileName.toLowerCase().includes(searchTermLower)
          ) {
            searchResults.push({
              profileId: activeProfileId,
              pageIndex: pad.pageIndex,
              padIndex: pad.padIndex,
              name: padName,
              audioFileId: pad.audioFileId,
              originalFileName,
              bankName: bankNames.get(pad.pageIndex) || `Bank ${convertIndexToBankNumber(pad.pageIndex)}`
            });
          }
        }
        
        setResults(searchResults);
      } catch (error) {
        console.error('Error searching pads:', error);
      } finally {
        setIsLoading(false);
      }
    };

    const debounceTimeout = setTimeout(() => {
      searchPads();
    }, 300);

    return () => clearTimeout(debounceTimeout);
  }, [searchTerm, isOpen, activeProfileId, convertIndexToBankNumber]);

  // Handle clicking outside to close
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  // Function to play sound when clicked
  const handlePlaySound = async (result: SearchResult) => {
    try {
      // Resume audio context first
      resumeAudioContext();
      
      // Load and play the audio
      const audioBuffer = await loadAndDecodeAudio(result.audioFileId);
      if (audioBuffer) {
        const playbackKey = `pad-${result.profileId}-${result.pageIndex}-${result.padIndex}`;
        playAudio(
          audioBuffer,
          playbackKey,
          {
            name: result.name,
            padInfo: {
              profileId: result.profileId, 
              pageIndex: result.pageIndex,
              padIndex: result.padIndex
            }
          }
        );
      }
    } catch (error) {
      console.error('Error playing sound:', error);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div 
        ref={modalRef}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col"
      >
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center">
          <div className="mr-2 text-gray-500 dark:text-gray-400">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search sounds..."
            className="w-full p-2 bg-transparent border-0 focus:ring-0 text-gray-900 dark:text-white text-lg"
            autoComplete="off"
          />
          <button 
            onClick={onClose}
            className="ml-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <div className="overflow-y-auto flex-1 p-2">
          {isLoading ? (
            <div className="p-4 text-center text-gray-500 dark:text-gray-400">
              Searching...
            </div>
          ) : results.length === 0 ? (
            <div className="p-4 text-center text-gray-500 dark:text-gray-400">
              {searchTerm ? 'No sounds found' : 'Type to search sounds'}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2">
              {results.map((result) => (
                <div
                  key={`${result.pageIndex}-${result.padIndex}`}
                  onClick={() => handlePlaySound(result)}
                  className="bg-white dark:bg-gray-700 rounded p-3 shadow cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                >
                  <div className="font-medium text-gray-900 dark:text-white">
                    {result.name}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {result.bankName}
                  </div>
                  {result.originalFileName && result.originalFileName !== result.name && (
                    <div className="text-xs text-gray-400 dark:text-gray-500 mt-1 italic">
                      {result.originalFileName}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SearchModal;
