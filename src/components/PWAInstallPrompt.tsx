"use client";

import { useState, useEffect } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export default function PWAInstallPrompt() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    // Check if the app is already installed
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setIsInstalled(true);
      return;
    }

    // Store the install prompt event for later use
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    // Check if PWA was successfully installed
    window.addEventListener('appinstalled', () => {
      setIsInstalled(true);
      setInstallPrompt(null);
      console.log('PWA was installed');
    });

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!installPrompt) return;

    // Show the install prompt
    await installPrompt.prompt();

    // Wait for the user to respond to the prompt
    const choiceResult = await installPrompt.userChoice;
    
    if (choiceResult.outcome === 'accepted') {
      console.log('User accepted the install prompt');
    } else {
      console.log('User dismissed the install prompt');
    }

    // Clear the saved prompt as it can't be used again
    setInstallPrompt(null);
  };

  // Don't show install button if PWA is already installed or not installable
  if (isInstalled || !installPrompt) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 p-4 bg-black text-white rounded-lg shadow-lg">
      <div className="mb-2 font-medium">Install ImpAmp 2</div>
      <p className="text-sm mb-3">Install ImpAmp 2 as an app for offline access and better performance!</p>
      <div className="flex justify-end">
        <button 
          onClick={() => setInstallPrompt(null)} 
          className="mr-2 px-3 py-1 text-sm bg-gray-700 rounded"
        >
          Not now
        </button>
        <button 
          onClick={handleInstallClick} 
          className="px-3 py-1 text-sm bg-blue-600 rounded"
        >
          Install
        </button>
      </div>
    </div>
  );
}
