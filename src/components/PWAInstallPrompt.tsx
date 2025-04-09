"use client";

import { useState, useEffect, ReactNode } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface BrowserInfo {
  name: string;
  icon: ReactNode;
  instructions: string;
  supportsAutoPrompt: boolean;
}

export default function PWAInstallPrompt() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [showManualInstructions, setShowManualInstructions] = useState(false);
  const [browserInfo, setBrowserInfo] = useState<BrowserInfo>({
    name: 'Unknown',
    icon: <></>,
    instructions: 'Installation not supported in this browser.',
    supportsAutoPrompt: false
  });

  // Detect browser and set appropriate instructions
  useEffect(() => {
    const ua = navigator.userAgent;
    let browser: BrowserInfo = {
      name: 'Unknown',
      icon: <></>,
      instructions: 'Installation not supported in this browser.',
      supportsAutoPrompt: false
    };

    if (ua.includes('Firefox')) {
      browser = {
        name: 'Firefox',
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 512 512">
            <path d="M503.52,241.48c-.12-1.56-.24-3.12-.24-4.68v-.12l-.36-4.68v-.12a245.86,245.86,0,0,0-7.32-41.15c0-.12,0-.12-.12-.24l-1.08-4c-.12-.24-.12-.48-.24-.6-.36-1.2-.72-2.52-1.08-3.72-.12-.24-.12-.48-.24-.72-.36-1.08-.72-2.16-1.08-3.12l-.36-.96c-.36-.96-.72-1.92-1.08-2.88-.12-.36-.24-.6-.36-1-.36-.96-.72-1.92-1.2-2.88-.12-.24-.24-.6-.36-.84-.48-1.08-1-2-1.44-3.12l-.24-.48c-.48-.84-.84-1.8-1.32-2.64-.24-.36-.36-.72-.6-1.08-.36-.84-.84-1.56-1.2-2.4-.24-.36-.48-.84-.72-1.2-.36-.72-.72-1.44-1.2-2.16-.24-.48-.6-.96-.84-1.44-.36-.68-.72-1.32-1.08-2-.36-.48-.6-1.08-1-1.56l-1.08-1.8c-.36-.6-.72-1.08-1.08-1.68-.36-.48-.72-1.08-1.08-1.56l-1.2-1.68c-.36-.48-.72-1-1.08-1.44a8,8,0,0,1-.6-.84l-1.2-1.68c-.48-.56-.84-1.2-1.32-1.68-.36-.48-.72-.96-1.08-1.44-.48-.56-1-1.2-1.44-1.8-.36-.48-.72-.84-1.08-1.32l-1.68-1.92c-.36-.48-.72-.84-1.08-1.2-.6-.68-1.2-1.32-1.8-2-.36-.36-.6-.72-1-1.08a18.07,18.07,0,0,0-1.56-1.68l-1.08-1.2c-.56-.56-1.2-1.2-1.8-1.68l-1.32-1.2c-.56-.56-1.08-1.08-1.68-1.56l-1.68-1.44c-.48-.48-1.08-.96-1.56-1.44-.6-.48-1.2-1-1.8-1.44-.48-.48-1.08-.84-1.56-1.32l-1.44-1.2-1.56-1.2-1.8-1.32-1.56-1.08-1.44-1.2-1.68-1.08c-.48-.36-1-.72-1.56-1.08l-1.56-1.08-1.56-1-1.68-.84-1.56-.84-1.44-.84-1.44-.72-1.56-.72-1.68-.84-1.44-.6-1.56-.72-1.44-.48-1.56-.6-1.56-.6-1.44-.48-1.56-.6-1.56-.36-1.56-.48-1.56-.48-1.56-.36-1.44-.36-1.56-.48-1.56-.24-1.56-.36-1.56-.36L401,80l-1.56-.24-1.56-.24-1.56-.12-1.44-.24-1.56-.12-1.56-.12h-1.56l-1.56-.12h-1.56l-1.56-.12H371.6l-1.56.12h-1.56l-1.56.12h-1.44l-1.56.12-1.56.12-1.56.24-1.56.12-1.56.24-1.56.24-1.56.36-1.56.36-1.56.36-1.56.36-1.44.48-1.56.48-1.56.6-1.56.48-1.56.6-1.56.6-1.56.72-1.56.72-1.56.84-1.44.72-1.56.84-1.56,1-1.56.84-1.56,1-1.56,1.08-1.56,1.08-1.44,1.08-1.56,1.2-1.56,1.32-1.44,1.2-1.56,1.32-1.56,1.32-1.44,1.44c-.52.48-1,1-1.48,1.44s-1,1-1.44,1.56c-.48.48-1,1-1.44,1.44-.48.48-.84,1-1.32,1.44l-1.32,1.56c-.36.48-.72,1-1.08,1.44-.36.48-.84,1-1.2,1.56l-1.08,1.56c-.36.48-.72,1-1.08,1.56l-1,1.56c-.36.48-.6,1-.84,1.56l-.36.72H308.68c34.44-35.88,81.72-56.4,131.16-56.4,101.64,0,184.92,83.28,184.92,184.92a187.75,187.75,0,0,1-1.68,25Z"></path>
            <path d="M215.88,401.52c-.36-.72-.84-1.32-1.2-2,3-4.92,1.84-11.52-3.48-15-18.36-11.64-35.88-22.32-42.84-26.4-1.8-1-3.48-2.16-5.16-3.12-7.08-4.32-13.08-7.92-17.28-8.88-6.92-1.56-14.76,0-21.48,4.68a31.89,31.89,0,0,0-4.2,3.12c-.36.36-.72.6-1.08,1a34.39,34.39,0,0,0-6.6,8.76c-2.16,3.84-7.56,5.76-12.72,4.92-54.48-9.12-94-31.44-117.84-66.96-1.68-3-3.24-6.06-4.68-9.12-15.6-31.92-21.6-71.28-16.92-110.52,4.56-38.76,18.72-79.56,57.36-99.36,20.52-10.44,43.2-11.28,67.36-10.8,77.76,1.68,126.48,45.24,126.48,45.24,47.28,47.88,67.44,106.8,57.72,178-8.76,46.2-19.08,57.36-26.76,67.44a34.33,34.33,0,0,1-7.56,5.64Z"></path>
          </svg>
        ),
        instructions: 'To install on Firefox, open the main menu (≡) and look for "Install Site in App" or "Add to Home Screen" option. Note this may not be available in all Firefox versions.',
        supportsAutoPrompt: false
      };
    } else if (ua.includes('Edge')) {
      browser = {
        name: 'Edge',
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 24 24">
            <path d="M20.978 11.372c-.034-4.275-3.5-8.96-9.448-8.96-1.22 0-2.39.22-3.47.632-3.539 1.345-5.493 4.583-5.612 7.424.272-1.462 1.259-3.080 2.621-4.103 2.082-1.56 5.741-1.22 5.741-1.22s-3.335 1.218-3.64 4.222c-.272 2.677 1.56 5.258 1.56 5.258.188-3.113 2.175-4.222 3.87-4.982 1.003-.446 2.156-.802 3.536-.778-.407.296-1.247.958-1.732 2.155-.582 1.425-.298 3.562-.298 3.562.26-1.349 3.968-1.927 3.968-5.258.003-.981-.362-1.898-.96-2.618 1.245 1.563 2.121 3.856 2.003 6.527-.085 1.919-.966 4.065-1.95 5.448-.926 1.297-2.258 2.493-3.454 3.264 4.604-1.413 7.893-5.71 7.728-10.565"></path>
          </svg>
        ),
        instructions: 'To install on Edge, click the menu (⋯) > Apps > Install this site as an app',
        supportsAutoPrompt: true
      };
    } else if (ua.includes('Chrome')) {
      browser = {
        name: 'Chrome',
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 7.5c-2.486 0-4.5 2.014-4.5 4.5s2.014 4.5 4.5 4.5 4.5-2.014 4.5-4.5-2.014-4.5-4.5-4.5zm0 7.5c-1.657 0-3-1.343-3-3s1.343-3 3-3 3 1.343 3 3-1.343 3-3 3z"></path>
            <path d="M12 3c-4.971 0-9 4.029-9 9s4.029 9 9 9 9-4.029 9-9-4.029-9-9-9zm4.5 9c0 2.486-2.014 4.5-4.5 4.5s-4.5-2.014-4.5-4.5s2.014-4.5 4.5-4.5 4.5 2.014 4.5 4.5z"></path>
          </svg>
        ),
        instructions: 'To install on Chrome, click the menu (⋮) and select "Install App" or look for the install icon (+) in the address bar',
        supportsAutoPrompt: true
      };
    } else if (ua.includes('Safari') && !ua.includes('Chrome')) {
      const isIOS = /iPhone|iPad|iPod/.test(ua);
      browser = {
        name: 'Safari',
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0c-6.627 0-12 5.373-12 12s5.373 12 12 12 12-5.373 12-12-5.373-12-12-12zm-1.218 19.975c-.042.013-.084.025-.125.039-.545.152-1.098.261-1.657.327v-3.066c0-.173-.075-.339-.205-.453l-5.373-4.491c-.085-.071-.18-.128-.285-.167.469-.893 1.103-1.706 1.873-2.398l8.689 2.262c.171.044.303.182.354.35.023.074.035.151.035.228l.001 1.551c-.362.155-.719.323-1.067.51l-2.24-1.853zm1.218-10.5l-7.26-1.891c.645-.255 1.328-.438 2.041-.551 1.135-.182 2.288-.099 3.405.237 1.066.321 2.074.854 2.934 1.578.083.07.15.157.195.254l-1.315.373zm5.841 10.643c-.374.365-.77.707-1.183 1.02l-1.953-9.005c-.035-.162-.022-.331.039-.485.047-.122.128-.231.233-.309.592-.435 1.134-.938 1.619-1.486.145-.166.364-.247.583-.22l.772.099c.136.017.251.109.298.237.348.927.542 1.916.576 2.918.018.531-.016 1.063-.102 1.588-.29 1.772-1.042 3.344-2.159 4.597.235.34.478.662.738.949l.539.099z"></path>
          </svg>
        ),
        instructions: isIOS ? 
          'To install on iOS Safari, tap the Share button (rectangle with arrow) and select "Add to Home Screen"' : 
          'Safari on desktop doesn\'t support PWA installation in the same way. Try Chrome or Edge instead.',
        supportsAutoPrompt: false
      };
    }

    setBrowserInfo(browser);
  }, []);

  useEffect(() => {
    // Check if the app is already installed
    if (window.matchMedia('(display-mode: standalone)').matches ||
        ('standalone' in window.navigator && (window.navigator as Navigator & {standalone?: boolean}).standalone)) {
      setIsInstalled(true);
      return;
    }

    // Store the install prompt event for later use
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
      console.log('Install prompt captured and ready');
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
    if (installPrompt) {
      // Use the automatic install prompt if available
      try {
        await installPrompt.prompt();
        const choiceResult = await installPrompt.userChoice;
        
        if (choiceResult.outcome === 'accepted') {
          console.log('User accepted the install prompt');
        } else {
          console.log('User dismissed the install prompt');
          // Show manual instructions if they dismiss the automatic prompt
          setShowManualInstructions(true);
        }
        
        // Clear the saved prompt as it can't be used again
        setInstallPrompt(null);
      } catch (err) {
        console.error('Error during installation:', err);
        setShowManualInstructions(true);
      }
    } else {
      // If no automatic prompt is available, show manual instructions
      setShowManualInstructions(true);
    }
  };

  // Exit early if PWA is already installed
  if (isInstalled) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 p-4 bg-black text-white rounded-lg shadow-lg max-w-sm">
      <div className="flex items-center mb-2">
        <div className="mr-2 text-blue-400">
          {browserInfo.icon}
        </div>
        <div className="font-medium">Install ImpAmp 2</div>
        <button 
          onClick={() => {
            setInstallPrompt(null);
            setShowManualInstructions(false);
          }}
          className="ml-auto text-gray-400 hover:text-white"
          aria-label="Close"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      
      {!showManualInstructions ? (
        <>
          <p className="text-sm mb-3">
            Install ImpAmp 2 as an app for offline access and better performance!
          </p>
          <div className="flex justify-end">
            <button 
              onClick={() => {
                setInstallPrompt(null);
                setShowManualInstructions(false);
              }} 
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
        </>
      ) : (
        <div className="text-sm">
          <p className="mb-2">
            <span className="font-bold">Manual installation in {browserInfo.name}:</span>
          </p>
          <p className="mb-3">{browserInfo.instructions}</p>
          <button 
            onClick={() => setShowManualInstructions(false)} 
            className="w-full px-3 py-1 text-sm bg-blue-600 rounded"
          >
            Got it
          </button>
        </div>
      )}
    </div>
  );
}
