# ImpAmp 2 PWA Usage Guide

ImpAmp 2 has been configured as a Progressive Web App (PWA), allowing you to install it on your device and use it offline.

## What is a PWA?

A Progressive Web App provides an app-like experience in a web browser:
- Works offline or with poor internet connections
- Can be installed on your device's home screen
- Loads quickly and reliably
- Provides native app-like experience

## Installing ImpAmp 2 as a PWA

ImpAmp 2 features an improved installation system that provides browser-specific instructions.

### Automatic Installation

1. Visit the ImpAmp 2 website
2. Look for the install prompt that appears in the bottom-right corner
3. Click "Install"
4. Follow any on-screen instructions

### Manual Installation by Browser

If the automatic installation prompt doesn't appear, you can install manually:

#### Chrome (Desktop)
1. Click the menu (⋮) in the top-right corner
2. Look for "Install ImpAmp 2..." or "Install app" option
3. Alternatively, look for the install icon (+) in the address bar

#### Microsoft Edge
1. Click the menu (⋯) in the top-right corner 
2. Select "Apps" → "Install this site as an app"
3. Follow the on-screen prompts

#### Firefox
Firefox on desktop has limited PWA support. You may see:
1. Menu (≡) → "Install Site in App" (newer Firefox versions)
2. If that option isn't available, use Chrome or Edge instead

#### Safari (iOS/iPadOS)
1. Tap the Share button (rectangle with an arrow)
2. Scroll down and tap "Add to Home Screen"
3. Tap "Add" in the top-right corner

#### Safari (macOS)
Safari on macOS doesn't currently support PWA installation. Use Chrome or Edge instead.

#### Android
1. Visit the ImpAmp 2 website in Chrome
2. Tap the menu button (three dots) in the top-right corner
3. Select "Add to Home screen" or "Install App"
4. Follow the on-screen instructions

## Troubleshooting Installation Issues

If you're having trouble installing the app:

1. Use the PWA Diagnostics tool in ImpAmp 2 (small icon in the bottom-left corner) to check:
   - Service worker status
   - Installation eligibility
   - Browser compatibility
   - Browser-specific instructions

2. Common issues:
   - Service worker not registered: Try refreshing the page
   - Not running on HTTPS: Make sure you're accessing the site via HTTPS
   - Browser doesn't support PWAs: Try a different browser like Chrome or Edge
   - Cache issues: Clear browser cache and reload

## Offline Usage

Once installed, ImpAmp 2 can be used without an internet connection:

- All your previously uploaded audio files will be available offline
- Your pad and bank configurations will be preserved
- Any changes made while offline will be saved locally

## Important Notes

- For first-time use, an internet connection is required to download the application files
- Large audio files may take longer to cache for offline use
- When you're online again, any updates to the app will be automatically applied
- The app must be installed on the same device where you want to use it offline

## Advanced Troubleshooting

If you experience persistent issues with the PWA:

1. Make sure your browser is up to date
2. Clear browser cache completely (application cache, service workers, and site data)
3. Use the PWA Diagnostics tool for detailed information
4. Try uninstalling and reinstalling the app
5. Check browser console for any error messages (Developer Tools → Console)

For more help, refer to the main documentation or contact support.
