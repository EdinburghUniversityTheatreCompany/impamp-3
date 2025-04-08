'use client';

import PadGrid from '@/components/PadGrid';
import { useProfileStore } from '@/store/profileStore';

export default function Home() {
  // Get the current page index from the profile store
  const currentPageIndex = useProfileStore((state) => state.currentPageIndex);
  
  return (
    <main className="flex min-h-screen flex-col items-center p-8 bg-gray-100 dark:bg-gray-800">
      {/* Fixed position header to prevent layout shifts */}
      <div className="w-full max-w-6xl mb-8">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100 text-center">
          ImpAmp 2 Soundboard
        </h1>
      </div>
      
      {/* Fixed height content container */}
      <div className="w-full max-w-6xl flex-1 flex flex-col">
        {/* Bank/Page Indicator */}
        <div className="flex justify-between items-center mb-4">
          <div className="text-gray-700 dark:text-gray-300">
            <span className="font-medium">Current Bank: </span>
            <span className="text-xl font-bold">{currentPageIndex}</span>
            <span className="text-sm ml-2 text-gray-500">(Press 0-9 to switch banks)</span>
          </div>
          
          {/* Bank Selector Buttons */}
          <div className="flex space-x-2">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((bank) => (
              <button
                key={bank}
                onClick={() => useProfileStore.getState().setCurrentPageIndex(bank)}
                className={`w-8 h-8 rounded flex items-center justify-center text-sm font-medium transition-colors
                  ${bank === currentPageIndex
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                  }`}
                aria-label={`Switch to bank ${bank}`}
              >
                {bank}
              </button>
            ))}
          </div>
        </div>
        
        {/* Pass the current page index to PadGrid */}
        <PadGrid rows={4} cols={8} currentPageIndex={currentPageIndex} />
      </div>
      {/* TODO: Add Footer or other UI elements later */}
    </main>
  );
}
