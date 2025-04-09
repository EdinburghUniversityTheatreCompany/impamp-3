"use client";

/**
 * This module provides explicit service worker registration 
 * for the PWA functionality, offering both debugging information
 * and fallback registration if the automatic registration fails.
 */

export async function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    console.info('Service workers are not supported in this environment');
    return false;
  }

  try {
    // Check if we're already registered
    const registrations = await navigator.serviceWorker.getRegistrations();
    if (registrations.length > 0) {
      console.info('Service worker already registered:', registrations);
      return true;
    }

    // Don't register in development mode to avoid conflicts with Next.js
    if (process.env.NODE_ENV === 'development') {
      console.info('Skipping service worker registration in development mode');
      return false;
    }

    // Try to register the service worker
    const registration = await navigator.serviceWorker.register('/service-worker.js');
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

    return true;
  } catch (error) {
    console.error('Error registering service worker:', error);
    return false;
  }
}

export async function unregisterServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      await registration.unregister();
    }
    console.info('Service workers unregistered');
    return true;
  } catch (error) {
    console.error('Error unregistering service workers:', error);
    return false;
  }
}

// Automatically attempt registration when this module is imported
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    registerServiceWorker();
  });
}
