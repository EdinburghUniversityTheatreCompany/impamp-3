# ImpAmp3 Soundboard

A modern, web-based soundboard application built with Next.js, TypeScript, IndexedDB, and Web Audio API. ImpAmp3 allows users to map locally stored audio files to keyboard shortcuts and trigger them instantly via keyboard or mouse clicks.

## Contents

- [Features](#features)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Building for Production](#building-for-production)
  - [Docker Deployment](#docker-deployment)
  - [PWA and offline use](#pwa-and-offline-use)
- [Usage](#usage)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [License](#license)
- [Contributing](#contributing)
  - [Prefixes](#prefixes)
  - [Versioning](#versioning)
- [Acknowledgements](#acknowledgements)

## Features

- **Works offline**: after one online visit the whole board — banks, pads, playback, editing, import/export — runs with no network. Only syncing needs one
- **Local Storage**: Stores configurations and audio files within the browser's IndexedDB
- **Profile Management**: Create, edit, and switch between multiple sound profiles/collections
- **Drag-and-Drop**: Easily assign audio files to pads via drag-and-drop
- **Keyboard Shortcuts**: Trigger sounds instantly via keyboard shortcuts (QWERTY layout keys q, w, e, r, etc.)
- **Track Arming**: Ctrl+Click (Cmd+Click on a Mac) to arm tracks for later playback, press F9 to play the next armed track
- **Multi-Page Support**: Multiple pages (banks) of sounds with intuitive keyboard navigation
- **Multi-Sound Pads**: Assign multiple sounds to a single pad with different playback modes:
  - _Sequential_: Plays sounds in order.
  - _Random_: Plays a random sound each time.
  - _Round-Robin_: Plays sounds randomly without repeating until all have played.
- **Disable Pads**: Untick "Pad active" in the pad editor to stop a pad playing without deleting it — useful for taking a sound out of the show without losing it. Disabled pads are dimmed and marked "OFF", and ignore clicks, keys, armed cues, emergency playback and search.
- **Edit Mode**: Shift key activates edit mode for renaming pads and banks.
  - _Single Sound Pads_: Remove sound via "X" button or Delete+click.
  - _Multi-Sound Pads_: Shift+click opens an editor to manage sounds (add, remove, reorder via drag-and-drop) and select playback mode.
- **Bulk Import**: In delete/swap mode, use the bulk import feature to assign multiple audio files to empty pads at once with a visual mapping interface.
- **Bank Navigation**: Press 1-9 for banks 1-9, 0 for bank 10, and Ctrl+1 through Ctrl+0 for banks 11-20
- **Reorder Banks**: In edit mode, drag a bank tab to a new position. The pads move with the bank, and the number keys follow the new order
- **Emergency Banks**: Mark banks as emergency for quick access during performances
- **Configurable Active Pad Behavior**: Choose what triggering an already-playing pad does — continue, stop, restart, or layer a second copy over the first (up to 16). Set it per profile in Playback Settings, and override it on individual pads in the pad editor.
- **Backup Reminders**: Get notified when profiles haven't been backed up recently (configurable frequency).
- **Sync Options**: Local profiles, manual export/import (V2 format supports multi-sound), automatic [Google Drive sync](docs/google-drive-sync.md), and [sync against the app's own server](docs/server-sync.md) with live change notifications.
- **Server-hosted audio** (optional): keep sounds in the app's own storage rather than Drive — see [docs/wasabi-audio.md](docs/wasabi-audio.md).
- **Loudness normalisation**: every sound is measured once to BS.1770-4 so pads play at a consistent level — see [docs/loudness-normalisation.md](docs/loudness-normalisation.md).
- **Containerization**: Deployed as a Docker container for easy deployment

## Getting Started

### Prerequisites

- Node.js 24.19.0 (see `.node-version`; `node:sqlite` needs >= 22.13, so 18 and 20 cannot run the server-sync layer at all)
- npm (v9.x or later)

### Installation

1. Clone the repository

   ```bash
   git clone https://github.com/edinburghuniversitytheatrecompany/impamp-3.git
   cd impamp-3
   ```

2. Install dependencies

   ```bash
   npm install
   ```

3. Start the development server

   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000) in your browser

5. Run the tests

   ```bash
   npm test          # unit and API suite (Vitest)
   npm run test:e2e  # end-to-end (Playwright, chromium)
   ```

   `test:e2e` runs chromium only, which is what CI gates on. Firefox and WebKit
   are `npm run test:e2e:cross-browser`, and both are known-red for reasons
   outside the app — read [docs/cross-browser-e2e.md](docs/cross-browser-e2e.md)
   before acting on either.

### Building for Production

To build the application for production:

1. Build the application

   ```bash
   npm run build
   ```

2. Start the production server

   ```bash
   npm run start
   ```

   This serves `.next/standalone/server.js`, the same server the Docker image
   runs. It reads `PORT`; pass `--port` and it is translated for you.

3. The app is now installable, and caches itself for offline use — see
   [PWA and offline use](#pwa-and-offline-use). The service worker registers
   only in production builds, so this is the first point at which you can
   exercise it

### Docker Deployment

ImpAmp3 can be deployed using Docker for easier deployment and consistent environments:

#### Production Deployment

The docker-compose.yml file is configured with profiles to allow you to run only the production container in production environments:

1. Direct Docker run (without compose):

   ```bash
   # Build the image
   docker build -t impamp3:latest .

   # Run the container (defaults to port 3025)
   docker run -p 3025:3000 impamp3:latest

   # Or specify a custom port
   docker run -p 8080:3000 impamp3:latest

   # Server sync keeps its SQLite database at /data (IMPAMP_DB_PATH, set in
   # the image). Without a volume it lives only as long as the container, so
   # mount one to keep accounts, profiles and shares across restarts:
   docker run -p 3025:3000 -v impamp_data:/data impamp3:latest
   ```

   The soundboard itself needs none of this — profiles live in the browser's
   IndexedDB, and the container is stateless until someone turns on server
   sync.

2. Using Docker Compose:

   ```bash
   # Start only the production app (binds to port 3025 by default)
   docker-compose up app

   # Start with custom port
   HOST_PORT=8080 docker-compose up app
   ```

3. Access the application at http://localhost:3025 (or your custom port)

#### Portainer Deployment

For Portainer deployment:

1. Add the docker-compose.yml file to your Portainer stack
2. By default, only the production app will start (the dev service has a profile restriction)
3. You can set the HOST_PORT environment variable in Portainer to change the default port (3025)
4. Deploy the stack

#### Development with Docker Compose

For local development with hot-reloading:

```bash
# Start the development environment with hot-reloading
COMPOSE_PROFILES=development docker-compose up

# Start only the dev environment
COMPOSE_PROFILES=development docker-compose up dev

# Start with custom port
COMPOSE_PROFILES=development DEV_PORT=8081 docker-compose up dev
```

### PWA and offline use

ImpAmp3 installs like any other Progressive Web App — your browser's "Install
app" or "Add to Home Screen" — and a service worker caches the app itself so a
show does not depend on the venue's wifi.

What works with the network down, after one online visit:

- Launching the board, switching banks, triggering pads
- Editing pads and banks, managing profiles, import and export
- Every sound. Audio lives in IndexedDB and is never fetched over the network,
  so playback was already independent of it

What does not, by design:

- Syncing — Google Drive, server sync, and hosted audio. Nothing under `/api`
  is cached, because a stale sync response could resurrect a deleted profile or
  hide a failed write. Those calls fail while offline and resume when the
  connection returns

Updates deliberately do **not** apply while the app is open. A new build is
downloaded in the background and takes over the next time you open the app with
no other tab still running it. Swapping an app's code under a running board
mid-performance is a worse failure than being one version behind for an
evening.

`docs/offline-pwa.md` has the details, including what to do if a client seems
stuck on an old build.

## Usage

1. **Adding Sounds**: Drag and drop audio files onto the pads in the grid.
2. **Playing Sounds**: Click on a pad or use the assigned keyboard shortcut.
3. **Bank Navigation**: Use the numeric keys 1-9, 0 for banks 1-10, and Ctrl+1 through Ctrl+0 for banks 11-20.
4. **Edit Mode**: Hold Shift to enter edit mode
   - Shift+click on banks to rename them or toggle emergency status.
   - Drag a bank tab sideways to move the bank, with all of its pads, to another position.
   - Shift+click on pads to edit them:
     - _Empty/Single Sound Pads_: Opens a simple rename prompt (or the full editor if preferred).
     - _Multi-Sound Pads_: Opens the full pad editor to manage sounds (add, remove, reorder) and playback mode.
   - Click the red "X" button or use Delete+click on _single-sound_ pads to remove the sound (resets name). For multi-sound pads, this action opens the editor.
   - Untick "Pad active" in the pad editor to disable a pad. It keeps its sounds and name but will not play from any trigger until you tick the box again.
5. **Arming Tracks**:
   - Hold Ctrl — Cmd on a Mac — and click on a pad to arm it for later playback
   - Armed tracks appear in the Armed Tracks panel
   - Press F9 to play the next armed track in the queue
   - You can also click the Play button on any armed track in the panel
6. **Managing Profiles**:
   - Use the profile selector in the top-right corner to switch between profiles
   - Click "Manage Profiles" to open the full profile manager
   - Create new profiles with custom names
   - Edit or delete existing profiles
   - Configure backup reminder frequency per profile by setting the number of days, or disable reminders entirely.
   - Each profile has its own set of sounds and bank configurations
7. **Importing/Exporting Profiles**:
   - Open the Profile Manager and go to the "Import / Export" tab.
   - **Export:** Select one or more profiles from the list using the checkboxes, then click "Export Selected". A single `.iaz` archive containing all selected profiles will be downloaded. Exporting profiles updates their "last backed up" timestamp.
   - **Import:** Click "Select File to Import" and choose a previously exported archive (supports `.iaz` profile and bank archives, and the older single, multi-profile and legacy ImpAmp2 JSON formats).
   - **Export banks:** Under "Export Banks", pick a profile and tick the banks you want. The archive holds those banks and their sounds, storing a sound named by several banks only once. This is deliberately _not_ a backup of the profile and does not update the "last backed up" timestamp.
   - **Import banks:** Selecting a bank archive opens a placement dialog: each bank in the file can be added as a new bank, used to replace one the active profile already has, or skipped. Banks always go into the active profile, so switch profiles first to import them somewhere else. The import is all-or-nothing — if any bank fails, every bank it touched is put back.
   - **Google Drive:** Use the "Import from Drive..." and "Export Active Profile to Drive" buttons within the Profile Manager (Import/Export tab) after signing in. See the [Google Drive Integration Guide](docs/google-drive-sync.md) for setup and usage details.

## Project Structure

- `/src/app` - Next.js app router pages and layout
- `/src/components` - React components
- `/src/lib` - Core utilities (DB, audio, etc.)
- `/src/hooks` - Custom React hooks
- `/src/store` - State management (Zustand)

## Tech Stack

Versions are the ones currently resolved in `package-lock.json`; refresh them
whenever dependencies are upgraded.

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript 6
- **UI**: React 19
- **Styling**: Tailwind CSS 4
- **State Management**: Zustand 5
- **Local Storage**: IndexedDB (via idb 8)
- **Audio**: Web Audio API
- **File Handling**: react-dropzone 20
- **Testing**: Vitest 4 for the unit and API suite (`npm test`), Playwright 1.62 for end-to-end (chromium is what CI gates on)
- **Linting**: ESLint 9 + eslint-config-next 16, Prettier 3.9

## License

[MIT](LICENCE)

## Contributing

Open an issue if you find an error or have an idea for an improvement. Preferably do this before opening a pull request so we can discuss the implementation.

### Prefixes

feat: For new features
content: For content updates  
fix: For small changes
bug: For bugfixes  
dep: For dependency updates  
doc: Updating documentation

### Versioning

Major: proper releases  
Minor: Feature updates  
Patch: Content changes and bugfixes

## Acknowledgements

Inspired by the original [ImpAmp](https://github.com/EdinburghUniversityTheatreCompany/ImpAmp) soundboard application.
