# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Building and Development
- `npm run dev` - Start development server with Turbopack (localhost:3000)
- `npm run build` - Build for production (requires prebuild step)
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

### Testing
- `npm test:e2e` - Run all Playwright end-to-end tests
- `npm test:e2e:audio` - Run audio playback tests specifically
- `npm test:e2e:profiles` - Run profile management tests
- `npm test:e2e:edit` - Run edit mode tests
- `npm test:e2e:keyboard` - Run keyboard shortcut tests
- `npm test:e2e:debug` - Run tests in debug mode

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

### Code Style
- TypeScript strict mode enabled
- Path aliases: `@/*` maps to `src/*`
- Tailwind CSS version 4 for styling (without a config file and with opacity using the / notation)
- ESLint configuration with Next.js rules

### Testing Strategy
- Playwright for comprehensive E2E testing
- Tests cover audio playback, profile management, edit mode, keyboard shortcuts
- Test helper utilities in `e2e-tests/test-helpers.ts`

### Audio File Handling
- Supports drag-and-drop audio file assignment
- Files stored as blobs in IndexedDB
- Decoded audio cached for performance
- Multiple playback strategies per pad

### Profile System
- Each profile is completely isolated
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