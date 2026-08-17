# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Building and Development

- `npm run dev` - Start development server with Turbopack (localhost:3000)
- `npm run build` - Build for production (requires prebuild step)
- `npm run start` - Serve the production build. Runs `.next/standalone/server.js`
  (via `scripts/start-standalone.js`) — the same server the Docker image runs.
  `next start` is unsupported with `output: standalone`. Reads `PORT`; a
  `--port` argument is translated to it.
- `npm run lint` - Run ESLint

### Testing

- `npm test` - Run the Vitest unit/integration suite (server sync, storage, API routes)
- `npm run test:watch` - Vitest in watch mode
- `npm run test:e2e` - Run all Playwright end-to-end tests
- `npm run test:e2e:audio` - Run audio playback tests specifically
- `npm run test:e2e:profiles` - Run profile management tests
- `npm run test:e2e:edit` - Run edit mode tests
- `npm run test:e2e:keyboard` - Run keyboard shortcut tests
- `npm run test:e2e:loudness` - Run loudness and gain tests
- `npm run test:e2e:debug` - Run tests in debug mode

(`npm test` works without `run` because `test` is a built-in npm alias. Nothing
else here is, and these were all written without it.)

### Utilities

- `npm run generate-favicon` - Generate favicon from SVG
- Scripts are located in `/scripts/` directory for build-time generation

## Architecture Overview

### Core Audio System

The application centers around a sophisticated audio playback system located in `src/lib/audio/`:

- **Audio Context Management** (`context.ts`) - Manages Web Audio API context and state
- **Audio Decoder** (`decoder.ts`) - Handles audio file decoding and caching
- **Playback Engine** (`playback.ts`) - Core playback functionality with progress tracking
- **Playback Strategies** (`strategies/`) - Different playback modes (sequential, random, round-robin)
- **Audio Cache** (`cache.ts`) - Optimized caching for decoded audio buffers

### State Management (Zustand)

Three main stores handle application state:

- **Profile Store** (`profileStore.ts`) - Active profile, profile switching, backup reminders
- **Playback Store** (`playbackStore.ts`) - Active tracks, armed tracks, playback controls
- **UI Store** (`uiStore.ts`) - Modal state, edit mode, search functionality

### Server Layer (server sync)

Server-side code lives in `src/lib/server/` and must never be imported from
client components — it uses Node's built-in `node:sqlite`:

- **Storage** (`db.ts`) - SQLite connection, migrations, typed query helpers
- **Users / Profiles / Shares** (`users.ts`, `profiles.ts`, `shares.ts`)
- **Sessions** (`session.ts`) - HttpOnly cookie, only the token hash is stored
- **Events** (`events.ts`) - in-process pub/sub behind the SSE endpoint

The client half is `src/lib/serverSync/` plus `src/hooks/useServerSync.ts`.
See `docs/server-sync.md`.

### Database Layer

IndexedDB abstraction in `src/lib/db.ts` with three main object stores:

- `profiles` - Profile metadata and settings
- `padConfigurations` - Pad assignments, audio file references, playback modes
- `audioFiles` - Binary audio data storage
- `pageMetadata` - Bank names and emergency status

### Component Architecture

- **Layout Components** - `ClientLayout.tsx` handles overall application structure
- **Modal System** - Centralized modal management with `ModalRenderer.tsx`
- **Pad System** - `Pad.tsx`, `PadGrid.tsx` with drag-and-drop and edit capabilities
- **Panel Components** - `ActiveTracksPanel.tsx`, `ArmedTracksPanel.tsx` for playback status

### Key Features Implementation

- **Edit Mode** - Activated by Shift key, allows pad/bank editing
- **Search System** - Ctrl+F opens search modal across all banks
- **Track Arming** - Ctrl+Click to queue sounds, F9 to play next
- **Google Drive Sync** - Complete sync implementation in `src/lib/googleDrive/`
- **Server Sync** - ETag/If-Match sync against the app's own backend, with SSE
  change notifications (`src/lib/serverSync/`). Audio stays in Drive by
  default.
- **Server-hosted audio** - optional, off unless the five `IMPAMP_S3_*`
  variables are set, and then still per-account (`can_upload_audio`). Presigned
  PUT/GET straight to Wasabi; the app never handles the bytes.
  `src/lib/serverAudio/` (client), `src/lib/server/s3/` (signing + client).
  See `docs/wasabi-audio.md`.
- **Loudness normalisation** - every audio file is analysed once for
  BS.1770-4 loudness, stored as per-block mean squares so any trimmed
  sub-range can be measured exactly without re-decoding. Gain resolves as
  normalisation x per-sound gain x per-pad gain into `PlayAudioParams.volume`.
  `src/lib/audio/loudness/`. See `docs/loudness-normalisation.md`.
- **PWA Support** - Service worker, manifest, offline capabilities

### Import/Export System

Multi-format support in `src/lib/importExport.ts`:

- V2 format supports multi-sound pads with playback strategies
- V1 legacy format migration from ImpAmp2
- Multi-profile export/import functionality

### Keyboard Navigation

Comprehensive keyboard system (`src/lib/keyboardUtils.ts`):

- Banks 1-9: keys 1-9
- Bank 10: key 0
- Banks 11-19: Ctrl+1 through Ctrl+9
- Bank 20: Ctrl+0
- ESC: Stop all sounds (panic button)
- F9: Play next armed track
- Shift: Enter edit mode

### Docker Deployment

- Production Dockerfile with multi-stage build
- Kamal2 deployment configuration in `config/deploy.yml`
- Health check endpoint at `/up`
- Development compose setup with profiles

## Development Guidelines

### Key package versions

As resolved in `package-lock.json` — keep in sync when upgrading dependencies:
Next.js 16, React 19, TypeScript 6, Tailwind CSS 4, Zustand 5, idb 8,
react-dropzone 20, Playwright 1.62, ESLint 9 with eslint-config-next 16,
Prettier 3.9.

Two upgrades are deliberately held back, with the reasons and retry conditions
in `plans/deferred-upgrades.md`: TypeScript 7 (typescript-eslint refuses the TS
7 API) and ESLint 10 (eslint-plugin-react has no ESLint 10 release).

### Code Style

- TypeScript strict mode enabled
- Path aliases: `@/*` maps to `src/*`
- Tailwind CSS version 4 for styling (without a config file and with opacity using the / notation)
- ESLint configuration with Next.js rules. `npm run lint` calls `eslint .`
  directly — `next lint` was removed in Next 16 — so `eslint.config.mjs` owns
  the ignore list that `next lint` used to supply

### Testing Strategy

- Vitest for unit/integration tests (`src/**/*.test.ts`), run with `npm test`
- Vitest runs in the **node** environment, so there is no DOM and no
  IndexedDB by default. A test that needs the database imports
  `fake-indexeddb/auto`, assigns `globalThis.window` **before** importing
  anything that reaches `db.ts` (it reads `window` as it evaluates, to decide
  whether it is on a client), and therefore imports those modules dynamically.
  `getDb` memoises its connection, so such a suite empties the object stores
  between tests rather than swapping the database — which means autoIncrement
  ids keep climbing, and assertions must key off an id the store handed back
  rather than a literal. See `src/lib/googleDrive/dataAccess.gain.test.ts`
- Playwright for comprehensive E2E testing
- Tests cover audio playback, profile management, edit mode, keyboard shortcuts
- Test helper utilities in `e2e-tests/test-helpers.ts`
- E2E gates on **chromium only**. Firefox and WebKit are **on demand only** —
  they do not run on push or PR (Actions → ci → Run workflow, or
  `gh workflow run ci`). Both are known-red for reasons outside the app, so
  running them every push cost ~35 minutes for no actionable signal. Read
  `docs/cross-browser-e2e.md` before acting on either. In short: Playwright's
  Linux WebKit cannot write a `Blob` to IndexedDB (so no pad ever gets a
  sound), and CI's runner has no audio device (so Firefox never starts
  playback, though it is 64/64 locally). Worth running deliberately after a
  dependency upgrade, or when touching storage or playback

### Audio File Handling

- Supports drag-and-drop audio file assignment
- Files stored as blobs in IndexedDB
- Decoded audio cached for performance
- Multiple playback strategies per pad

### Profile System

- Each profile is completely isolated
- `syncType` is one of `local`, `googleDrive`, or `server`
- Profiles can be linked to Google Drive for sync
- Export updates `lastBackedUpAt` timestamp
- Backup reminder system based on configurable intervals

## Important Implementation Notes

- Always check for `typeof window !== 'undefined'` before IndexedDB operations
- Audio context requires user interaction to start (handle suspended state)
- Keyboard shortcuts have precedence rules (bank switching > pad triggers)
- Edit mode uses visual indicators (amber borders, "EDIT MODE" banner)
- PWA implementation requires service worker registration and manifest
- Google Drive integration uses appData scope (hidden files, no quota impact)
- Server sync needs `IMPAMP_DB_PATH` and a persistent volume; the SSE bus is
  in-process, so the app must run as a single instance
- Hosted audio quota is charged from the size the _bucket_ reports at commit,
  never the size the client claimed — a presigned PUT signs only `host` and so
  cannot constrain the upload
- Once audio is hosted, the SQLite database and the bucket must be backed up
  and restored **together**; either one alone leaves dangling references
- All level arithmetic lives in `src/lib/audio/loudness/gain.ts`. The overview
  table and the playback path both call `resolveGain`; a second implementation
  would let the table disagree with what is heard
- `audioGainSettings` is keyed by audio file ID, and those IDs are remapped or
  copied in **five** places, not the three this used to name: `importExport.ts`,
  `googleDrive/dataAccess.ts`, `syncUtils.ts`, `db.ts`'s
  `duplicateProfileLocally` (which was missing them, so duplicating a profile
  silently dropped every gain setting) and `extractPadPlaybackSettings`, which
  is the helper the copying sites should all go through. Treat the list as a
  floor rather than a census: any new `Record<audioFileId, …>` field needs
  hunting for, or it silently attaches to the wrong sounds
- Gain resolution at trigger time is synchronous on purpose. The analysis cache
  is warmed on profile activation so the playback path never awaits a DB read

## Pinned Versions

Package versions live in **one** place: "Key package versions" above. There
used to be a second list here as well, and it had drifted — TypeScript 5 when
the repo is on 6, Playwright 1.4x when it is on 1.62, Prettier 3.8.1 when it is
on 3.9 — with the more authoritative-sounding heading carrying the wrong
answers. Two hand-maintained lists of the same facts will always drift, so this
one now covers only what is machine-checked.

- Node 24.19.0 (LTS) everywhere — `.node-version`, `mise.toml` and the
  `NODE_VERSION` ARG in **both** `Dockerfile` and `Dockerfile.dev`.
  `scripts/check_version_sync.sh` cross-checks the first three;
  `scripts/check_extra_dockerfiles.sh` covers every `Dockerfile*`, because the
  first script is a shared template that reads only one of them and
  `Dockerfile.dev` drifted to Node 22 unnoticed for months as a result.
  `node:sqlite` requires Node >= 22.13, so that is the floor
