"use client";

import { useState, useEffect } from 'react';

interface PWAStatus {
  isStandalone: boolean;
  supportsServiceWorker: boolean;
  serviceWorkerRegistered: boolean;
  manifestDetected: boolean;
  isInstallable: boolean;
  browserSupport: {
    name: string;
    supportsInstallation: boolean;
    installMethod: string;
  };
}

export default function PWADiagnostics() {
  const [status, setStatus] = useState<PWAStatus>({
    isStandalone: false,
    supportsServiceWorker: false,
    serviceWorkerRegistered: false,
    manifestDetected: false,
    isInstallable: false,
    browserSupport: {
      name: 'Unknown',
      supportsInstallation: false,
      installMethod: 'Not available'
    }
  });
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const checkPWAStatus = async () => {
      // Check if running in standalone mode (installed PWA)
      // navigator.standalone is an iOS Safari specific property
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches || 
                          ('standalone' in window.navigator && (window.navigator as Navigator & {standalone?: boolean}).standalone) || false;
      
      // Check service worker support
      const supportsServiceWorker = 'serviceWorker' in navigator;
      
      // Check if service worker is registered
      let serviceWorkerRegistered = false;
      if (supportsServiceWorker) {
        try {
          const registrations = await navigator.serviceWorker.getRegistrations();
          serviceWorkerRegistered = registrations.length > 0;
          
          // Log for debugging
          console.log('Service worker registrations:', registrations);
          
          if (!serviceWorkerRegistered && process.env.NODE_ENV !== 'development') {
            // Try to register service worker explicitly if in production and not registered
            try {
              const registration = await navigator.serviceWorker.register('/service-worker.js');
              serviceWorkerRegistered = true;
              console.log('Service worker registered successfully:', registration);
            } catch (err) {
              console.error('Service worker registration failed:', err);
            }
          }
        } catch (err) {
          console.error('Error checking service worker:', err);
        }
      }
      
      // Check manifest
      let manifestDetected = false;
      const manifestLink = document.querySelector('link[rel="manifest"]');
      if (manifestLink) {
        manifestDetected = true;
        console.log('Manifest link found:', manifestLink.getAttribute('href'));
      }
      
      // Detect browser
      const userAgent = navigator.userAgent;
      let browserInfo = {
        name: 'Unknown',
        supportsInstallation: false,
        installMethod: 'Not available'
      };
      
      if (userAgent.includes('Firefox')) {
        browserInfo = {
          name: 'Firefox',
          supportsInstallation: true,
          installMethod: 'Menu (≡) > Install Site in App'
        };
      } else if (userAgent.includes('Chrome')) {
        browserInfo = {
          name: 'Chrome',
          supportsInstallation: true,
          installMethod: 'Menu (⋮) or Install icon (+) in address bar'
        };
      } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
        // Safari has Chrome in its user agent, but Chrome has Safari
        browserInfo = {
          name: 'Safari',
          supportsInstallation: /iPhone|iPad|iPod/.test(userAgent),
          installMethod: 'Share button > Add to Home Screen'
        };
      } else if (userAgent.includes('Edge')) {
        browserInfo = {
          name: 'Edge',
          supportsInstallation: true,
          installMethod: 'Menu (⋯) > Apps > Install this site as an app'
        };
      }

      setStatus({
        isStandalone,
        supportsServiceWorker,
        serviceWorkerRegistered,
        manifestDetected,
        isInstallable: supportsServiceWorker && serviceWorkerRegistered && manifestDetected,
        browserSupport: browserInfo
      });
    };

    checkPWAStatus();
  }, []);

  const StatusItem = ({ name, value, positive = true }: { name: string, value: boolean, positive?: boolean }) => (
    <div className="flex justify-between items-center mb-2">
      <span>{name}</span>
      <span className={`px-2 py-1 rounded text-sm ${value ? 
        (positive ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800') : 
        (positive ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800')}`}>
        {value ? 'Yes' : 'No'}
      </span>
    </div>
  );

  if (!isOpen) {
    return (
      <button 
        onClick={() => setIsOpen(true)}
        className="fixed bottom-4 left-4 z-50 bg-gray-800 text-white p-2 rounded-full shadow-lg"
        title="PWA Diagnostics"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 z-50 p-4 bg-white text-black rounded-lg shadow-xl w-80 max-w-full">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-bold text-lg">PWA Diagnostics</h3>
        <button onClick={() => setIsOpen(false)} className="text-gray-500 hover:text-gray-700">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      
      <div className="mb-4">
        <StatusItem name="Running as PWA" value={status.isStandalone} />
        <StatusItem name="Service Worker Supported" value={status.supportsServiceWorker} />
        <StatusItem name="Service Worker Registered" value={status.serviceWorkerRegistered} />
        <StatusItem name="Manifest Detected" value={status.manifestDetected} />
        <StatusItem name="Is Installable" value={status.isInstallable} />
      </div>
      
      <div className="mb-4 border-t pt-2">
        <h4 className="font-medium mb-2">Browser Information</h4>
        <p><strong>Browser:</strong> {status.browserSupport.name}</p>
        <p><strong>Supports Installation:</strong> {status.browserSupport.supportsInstallation ? 'Yes' : 'No'}</p>
        <p><strong>Installation Method:</strong> {status.browserSupport.installMethod}</p>
      </div>
      
      {status.isInstallable && !status.isStandalone && (
        <div className="border-t pt-2">
          <p className="text-sm mb-2">
            Your browser supports PWA installation but the install prompt might not appear automatically.
            Try the following:
          </p>
          <div className="text-sm mb-2">
            <strong>{status.browserSupport.name} installation:</strong> {status.browserSupport.installMethod}
          </div>
        </div>
      )}
      
      {!status.serviceWorkerRegistered && (
        <div className="mt-2 p-2 bg-yellow-100 text-yellow-800 rounded">
          <p className="text-sm">Service worker is not registered. This is required for PWA functionality.</p>
        </div>
      )}
      
      <button 
        onClick={() => window.location.reload()}
        className="mt-2 px-3 py-1 bg-blue-600 text-white rounded text-sm w-full"
      >
        Reload App
      </button>
    </div>
  );
}
