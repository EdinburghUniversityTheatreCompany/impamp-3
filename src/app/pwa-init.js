'use client';

/**
 * This script initializes the PWA functionality at runtime
 * It's imported into the layout.tsx file to ensure it runs on the client side
 */

if (typeof window !== 'undefined') {
  window.addEventListener('load', async () => {
    if ('serviceWorker' in navigator) {
      try {
        // Don't register in development mode to avoid conflicts with Next.js
        if (process.env.NODE_ENV === 'development') {
          console.info('Skipping service worker registration in development mode');
          return;
        }
        
        // Check if already registered
        const registrations = await navigator.serviceWorker.getRegistrations();
        if (registrations.length > 0) {
          console.info('Service worker already registered:', registrations);
          return;
        }
        
        // Register the service worker
        const registration = await navigator.serviceWorker.register('/sw.js');
        console.info('Service worker registered successfully:', registration);
        
        // Listen for any updates
        registration.onupdatefound = () => {
          const installingWorker = registration.installing;
          if (!installingWorker) return;
          
          installingWorker.onstatechange = () => {
            if (installingWorker.state === 'installed') {
              if (navigator.serviceWorker.controller) {
                console.info('New content is available; please refresh.');
              } else {
                console.info('Content is cached for offline use.');
              }
            }
          };
        };
      } catch (error) {
        console.error('Error registering service worker:', error);
      }
    }
  });
}
