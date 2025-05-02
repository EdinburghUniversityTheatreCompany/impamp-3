# ImpAmp3 Refactoring Plan

This document outlines a comprehensive plan for refactoring the ImpAmp3 codebase according to the C³ (Common Coding Conventions) principles. The goal is to improve code quality, maintainability, and readability while ensuring the application continues to function correctly.

## Table of Contents

1. [Analysis of Current State](#analysis-of-current-state)
2. [Architecture Improvements](#architecture-improvements)
3. [Implementation Refinements](#implementation-refinements)
4. [Naming Conventions](#naming-conventions)
5. [Documentation and Comments](#documentation-and-comments)
6. [Code Layout and Organization](#code-layout-and-organization)
7. [Testing Improvements](#testing-improvements)
8. [Implementation Plan](#implementation-plan)

## Analysis of Current State

After reviewing the codebase, we've identified several areas that could benefit from improvement:

### Strengths
- Well-structured project with clear separation between components, hooks, and utilities
- Good use of TypeScript for type safety
- Effective use of React hooks and functional components
- Comprehensive end-to-end testing

### Areas for Improvement
- The audio.ts file is large (~800 lines) and handles multiple responsibilities
- Some components have high coupling with audio functionality
- Inconsistent naming conventions, especially for boolean variables and functions
- Some functions are too long and handle multiple responsibilities
- Documentation is inconsistent and sometimes focuses on "how" rather than "why"
- DRY violations in UI components and utility functions

## Architecture Improvements

### Audio Module Restructuring

**Current Issues:**
- The audio.ts file handles multiple concerns: audio context management, audio loading, playback control, and playback state management.
- Circular dependencies between audio.ts and playbackStore.ts.
- Playback type logic (sequential, random, round-robin) is implemented with switch statements.

**Proposed Structure:**
```
src/lib/audio/
├── context.ts       # AudioContext management
├── cache.ts         # Audio buffer caching
├── decoder.ts       # Audio decoding logic
├── playback.ts      # Core playback functionality
├── strategies/      # Playback strategy implementations
│   ├── sequential.ts
│   ├── random.ts
│   └── roundRobin.ts
├── controls.ts      # Public control API (stop, fade, etc.)
├── types.ts         # Shared type definitions
└── index.ts         # Public exports
```

**Key Changes:**
1. **Implement Strategy Pattern for Playback Types:**
   ```typescript
   // types.ts
   export interface PlaybackStrategy {
     selectNextSound(audioFileIds: number[]): { audioFileId: number, index: number };
     updateState(playedIndex: number): void;
   }

   // strategies/sequential.ts
   export class SequentialStrategy implements PlaybackStrategy {
     private nextIndex: number = 0;
     
     selectNextSound(audioFileIds: number[]): { audioFileId: number, index: number } {
       const index = this.nextIndex % audioFileIds.length;
       const audioFileId = audioFileIds[index];
       return { audioFileId, index };
     }
     
     updateState(playedIndex: number, audioFileIds: number[]): void {
       this.nextIndex = (playedIndex + 1) % audioFileIds.length;
     }
   }
   ```

2. **Extract AudioContext Management:**
   ```typescript
   // context.ts
   const isClient = typeof window !== "undefined";
   let audioContext: AudioContext | null = null;

   export function getAudioContext(): AudioContext {
     if (!isClient) {
       throw new Error("AudioContext is not available on the server");
     }

     if (!audioContext) {
       audioContext = new (window.AudioContext || 
         (window as any).webkitAudioContext)();
     }
     
     if (audioContext.state === "suspended") {
       audioContext.resume();
     }
     
     return audioContext;
   }

   export function resumeAudioContext(): Promise<void> {
     const context = getAudioContext();
     if (context.state === "suspended") {
       return context.resume();
     }
     return Promise.resolve();
   }
   ```

3. **Create Dedicated Audio Cache:**
   ```typescript
   // cache.ts
   const audioBufferCache = new Map<number, AudioBuffer | null>();

   export function getCachedAudioBuffer(audioFileId: number): AudioBuffer | null | undefined {
     return audioBufferCache.get(audioFileId);
   }

   export function cacheAudioBuffer(audioFileId: number, buffer: AudioBuffer | null): void {
     audioBufferCache.set(audioFileId, buffer);
   }

   export function clearAudioCache(): void {
     audioBufferCache.clear();
   }
   ```

### UI Component Restructuring

**Current Issues:**
- Duplication between ArmedTracksPanel and ActiveTracksPanel
- Direct coupling between UI components and audio functionality

**Proposed Changes:**
1. **Create Shared Track Panel Components:**
   ```
   src/components/shared/
   ├── TrackItem.tsx       # Common track item component
   ├── TrackProgressBar.tsx # Shared progress bar
   ├── BasePanelLayout.tsx # Common panel layout
   └── PanelHeader.tsx    # Reusable panel header with title and help text
   ```

2. **Extract Common Logic to Hooks:**
   ```typescript
   // hooks/useTrackControls.ts
   export function useTrackControls() {
     return {
       stopTrack: (key: string) => stopAudio(key),
       fadeOutTrack: (key: string, duration: number) => fadeOutAudio(key, duration),
       // Other common track control functions
     };
   }
   ```

## Implementation Refinements

### Break Down Large Functions

**Current Issues:**
- `triggerAudioForPad()` in audio.ts is 100+ lines and has multiple responsibilities
- `_playBuffer()` in audio.ts handles source creation, gain node setup, and event handling
- Playback type selection logic is complex and duplicated

**Proposed Changes:**
1. **Split triggerAudioForPad:**
   ```typescript
   // playback.ts
   export async function triggerAudioForPad(args: TriggerAudioArgs): Promise<void> {
     const { padIndex, audioFileIds, playbackType, activeProfileId, currentPageIndex, name } = args;
     
     if (!audioFileIds || audioFileIds.length === 0) {
       console.log(`Pad index ${padIndex} has no audio files configured.`);
       return;
     }

     const playbackKey = generatePlaybackKey(activeProfileId, currentPageIndex, padIndex);
     
     if (isTrackPlaying(playbackKey)) {
       handleActivePadTrigger(playbackKey, playbackType, activeProfileId, audioFileIds);
       return;
     }
     
     const audioSelection = selectAudioFileToPlay(audioFileIds, playbackType, playbackKey);
     await loadAndPlayAudio(audioSelection, playbackKey, {
       name: name || `Pad ${padIndex + 1}`,
       padInfo: { profileId: activeProfileId, pageIndex: currentPageIndex, padIndex }
     });
   }

   function handleActivePadTrigger(
     playbackKey: string, 
     playbackType: PlaybackType,
     activeProfileId: number,
     audioFileIds: number[]
   ): void {
     const activePadBehavior = getActivePadBehavior(activeProfileId);
     
     switch (activePadBehavior) {
       case "continue":
         return; // Do nothing
       case "stop":
         stopAudio(playbackKey);
         return;
       case "restart":
         restartAudio(playbackKey, audioFileIds, playbackType);
         return;
     }
   }
   ```

2. **Extract Audio Source Creation:**
   ```typescript
   function createAudioSource(
     buffer: AudioBuffer,
     volume: number = 1.0
   ): { source: AudioBufferSourceNode, gainNode: GainNode } {
     const context = getAudioContext();
     const source = context.createBufferSource();
     source.buffer = buffer;

     const gainNode = context.createGain();
     gainNode.gain.setValueAtTime(
       Math.max(0, Math.min(1, volume)),
       context.currentTime
     );

     source.connect(gainNode);
     gainNode.connect(context.destination);
     
     return { source, gainNode };
   }
   ```

### Apply Composition Over Mutation

**Current Issues:**
- Some functions modify variables step-by-step rather than composing final values
- State updates sometimes modify existing objects directly

**Proposed Changes:**
1. **Use Immutable Patterns Consistently:**
   ```typescript
   // Before
   const track = activeTracks.get(playbackKey);
   if (track) {
     track.isFading = true;
     // Other mutations...
   }

   // After
   const track = activeTracks.get(playbackKey);
   if (track) {
     const updatedTrack = {
       ...track,
       isFading: true
       // Other changes composed here
     };
     activeTracks.set(playbackKey, updatedTrack);
   }
   ```

2. **Compose Values from Parts:**
   ```typescript
   // Before
   let totalIncome = 0;
   totalIncome += getSalary(employee);
   totalIncome -= getTax(employee);

   // After
   const salary = getSalary(employee);
   const tax = getTax(employee);
   const totalIncome = salary - tax;
   ```

### Extract Repeated Logic

**Current Issues:**
- Track management logic is duplicated across components
- Formatting and rendering patterns are repeated

**Proposed Changes:**
1. **Create Utility Functions:**
   ```typescript
   // utils/formatters.ts
   export function formatTime(seconds: number): string {
     const mins = Math.floor(seconds / 60);
     const secs = Math.floor(seconds % 60);
     return `${mins}:${secs.toString().padStart(2, "0")}`;
   }
   ```

2. **Extract Common Track Logic:**
   ```typescript
   // hooks/useTrackManagement.ts
   export function useTrackManagement() {
     return {
       stopTrack: (key: string) => {
         stopAudio(key);
       },
       fadeOutTrack: (key: string, duration: number) => {
         fadeOutAudio(key, duration);
       },
       isTrackFading: (key: string) => {
         return isTrackFading(key);
       }
     };
   }
   ```

## Naming Conventions

### Standardize Boolean Variables and Functions

**Current Issues:**
- Inconsistent naming for boolean variables (some with is/has/can prefixes, some without)
- Some function names don't clearly express their purpose

**Proposed Changes:**
1. **Rename Boolean Variables/Functions:**
   - `fading` → `isFading`
   - `deleteMode` → `isDeleteMode`
   - `editMode` → `isEditMode`
   - `trackActive` → `isTrackActive`

2. **Standardize Function Names:**
   - Predicates should have is/has/can prefix
   - `checkTokenValidity()` → `isTokenValid()`
   - Function names should start with verbs (for actions) or nouns (for getters)

### Create Consistent Terminology

**Current Issues:**
- Terminology varies across components (e.g., "sound" vs "track" vs "audio")
- Naming for similar concepts isn't consistent (e.g., "remove" vs "delete")

**Proposed Changes:**
1. **Standardize Domain Terminology:**
   - **Bank/Page:** A collection of pads (with banks 1-20)
   - **Pad:** A clickable interface element that can be assigned audio
   - **Sound:** A reference to an audio file that can be assigned to a pad
   - **Track:** A currently playing sound instance
   - **Profile:** A collection of banks with pad configurations

2. **Define Clear Verb Pairs:**
   - `add`/`remove` for collection operations
   - `start`/`stop` for playback control
   - `open`/`close` for UI elements
   - `enable`/`disable` for feature toggles

## Documentation and Comments

**Current Issues:**
- Comments often explain "how" instead of "why"
- Some public functions lack appropriate JSDoc
- File headers missing in some files

**Proposed Changes:**
1. **Add File Headers:**
   ```typescript
   /**
    * Audio Module - Core Audio Management
    * 
    * Manages audio context, decoding, caching, and playback for the application.
    * Interfaces with IndexedDB for loading audio files and WebAudio API for playback.
    * 
    * @module lib/audio
    */
   ```

2. **Improve JSDoc Comments:**
   ```typescript
   /**
    * Triggers playback for a pad's configured audio.
    * 
    * Handles pad behavior (continue/stop/restart) based on profile settings.
    * Selects the appropriate audio file based on playback type (sequential, random, or round-robin).
    * 
    * @param args - Configuration object for audio triggering
    * @param args.padIndex - Index of the pad within the grid
    * @param args.audioFileIds - Array of audio file IDs assigned to the pad
    * @param args.playbackType - Strategy for selecting which audio to play
    * @param args.activeProfileId - ID of the current profile
    * @param args.currentPageIndex - Index of the current bank/page
    * @param args.name - Optional display name for the track
    * @returns Promise that resolves once audio playback has started
    */
   export async function triggerAudioForPad(args: TriggerAudioArgs): Promise<void> {
     // Implementation
   }
   ```

3. **Focus on "Why" in Comments:**
   ```typescript
   // Bad ❌
   // Get all profiles from the database
   const profiles = await getAllProfiles();

   // Better ✔
   // Pre-fetch all profiles to allow switching without additional db calls
   const profiles = await getAllProfiles();
   ```

4. **Add TODO and FIXME Tags:**
   ```typescript
   // TODO: Implement caching for profile configs to reduce db reads
   
   // FIXME: Current implementation might have race conditions with multiple
   // audio file loads happening simultaneously
   ```

## Code Layout and Organization

**Current Issues:**
- Inconsistent import ordering
- Some components mix rendering logic with state management
- Large files handling multiple concerns

**Proposed Changes:**
1. **Standardize Import Order:**
   ```typescript
   // 1. React/Next.js imports
   import React, { useState, useEffect } from "react";
   import { useRouter } from "next/router";
   
   // 2. Third-party libraries
   import { create } from "zustand";
   import clsx from "clsx";
   
   // 3. Internal components, hooks, contexts
   import { PadGrid } from "@/components/PadGrid";
   import { useAudioPlayback } from "@/hooks/useAudioPlayback";
   
   // 4. Utilities, types, constants
   import { formatTime } from "@/utils/formatters";
   import type { PlaybackState } from "@/types";
   import { DEFAULT_FADEOUT_DURATION } from "@/constants";
   ```

2. **Group Related Functions:**
   ```typescript
   // --- AudioContext Management ---
   
   function getAudioContext() { /* ... */ }
   function resumeAudioContext() { /* ... */ }
   
   // --- Audio Decoding ---
   
   async function decodeAudioBlob(blob: Blob) { /* ... */ }
   async function loadAndDecodeAudio(audioFileId: number) { /* ... */ }
   
   // --- Playback Control ---
   
   function playAudio(key: string, buffer: AudioBuffer) { /* ... */ }
   function stopAudio(key: string) { /* ... */ }
   function fadeOutAudio(key: string, duration: number) { /* ... */ }
   ```

3. **Split Large Components:**
   ```tsx
   // Before: All in one large component
   const SomeComponent = () => {
     // 100+ lines of component logic, rendering, etc.
   };
   
   // After: Split into smaller components
   const SomeComponent = () => {
     return (
       <div>
         <Header />
         <Content />
         <Footer />
       </div>
     );
   };
   
   const Header = () => { /* ... */ };
   const Content = () => { /* ... */ };
   const Footer = () => { /* ... */ };
   ```

## Testing Improvements

**Current Issues:**
- Some test helper functions could be refactored for DRY principle
- Test organization could be improved

**Proposed Changes:**
1. **Extract Test Utilities:**
   ```typescript
   // test-helpers.ts
   export async function setupTestAudio(page: Page): Promise<void> {
     // Common audio setup logic used across tests
   }
   
   export async function createTestTrack(page: Page, options: CreateTrackOptions): Promise<void> {
     // Create and configure a test track with given options
   }
   ```

2. **Organize Tests by Feature:**
   ```typescript
   describe('Audio Playback', () => {
     describe('Basic Playback', () => {
       test('plays audio when pad is clicked', async () => { /* ... */ });
       test('stops audio when stop button is clicked', async () => { /* ... */ });
     });
     
     describe('Multi-Sound Playback', () => {
       test('sequential mode plays sounds in order', async () => { /* ... */ });
       test('random mode plays a random sound each time', async () => { /* ... */ });
     });
   });
   ```

3. **Use Descriptive Test Names:**
   ```typescript
   // Before
   test('test sequential mode', async () => { /* ... */ });
   
   // After
   test('sequential mode should play sounds in order and cycle back to the beginning', async () => { /* ... */ });
   ```

## Implementation Plan

The refactoring will be implemented in phases to ensure the application continues to function correctly throughout the process.

### Phase 1: Audio Module Restructuring

1. Create the new directory structure for audio module
2. Extract audio context management to its own file
3. Implement strategy pattern for playback types
4. Refactor the main functions to use the new structure
5. Update imports across the codebase

**Estimated Time:** 3-4 days
**Testing Focus:** Audio playback functionality, pad triggering

### Phase 2: UI Component Refactoring

1. Create shared components for track panels
2. Refactor ArmedTracksPanel and ActiveTracksPanel to use shared components
3. Extract common logic to hooks
4. Improve naming and documentation

**Estimated Time:** 2-3 days
**Testing Focus:** UI functionality, track display and controls

### Phase 3: Implementation Refinements

1. Break down large functions into smaller, focused ones
2. Apply composition over mutation patterns
3. Extract repeated logic into utility functions
4. Apply consistent naming conventions

**Estimated Time:** 2-3 days
**Testing Focus:** Application behavior, regression testing

### Phase 4: Documentation and Cleanup

1. Add file headers across the codebase
2. Improve JSDoc comments for public API
3. Standardize code layout and organization
4. Clean up any remaining issues

**Estimated Time:** 1-2 days
**Testing Focus:** Full application testing, documentation verification

### Phase 5: Test Improvements

1. Refactor test helpers
2. Organize tests by feature
3. Improve test naming and descriptions
4. Add tests for any uncovered functionality

**Estimated Time:** 1-2 days
**Testing Focus:** Test coverage, test reliability

## Conclusion

This refactoring plan provides a comprehensive approach to improving the ImpAmp3 codebase according to the C³ principles. By addressing architecture, implementation, naming, documentation, and testing concerns, we will create a more maintainable and readable codebase that will be easier to extend and improve in the future.

The changes will be implemented incrementally, ensuring that the application continues to function correctly throughout the process. Each phase will include thorough testing to verify that the refactored code behaves as expected.

## Progress Tracking

### Completed Tasks

#### Phase 1: Audio Module Restructuring
- ✅ Created audio module directory structure
- ✅ Implemented PlaybackStrategy interface for Strategy pattern
- ✅ Created concrete strategy implementations (Sequential, Random, Round-Robin)
- ✅ Extracted AudioContext management to dedicated file
- ✅ Implemented audio buffer cache with proper TypeScript typing
- ✅ Extracted audio decoding logic to its own module
- ✅ Created playback module for core audio playback functionality
- ✅ Implemented public controls API as the main entry point
- ✅ Provided clean exports through index.ts

#### Phase 2: UI Component Refactoring
- ✅ Created formatter utility functions (formatTime)
- ✅ Implemented useTrackControls hook for common track operations
- ✅ Created shared UI components:
  - ✅ TrackProgressBar - For consistent progress visualization
  - ✅ TrackItem - Unified component for both active and armed tracks
  - ✅ PanelHeader - Consistent header with title, help text, and actions
- ✅ Refactored ArmedTracksPanel to use shared components
- ✅ Refactored ActiveTracksPanel to use shared components

### In Progress
- 🔄 Implementation Refinements (Phase 3)
- 🔄 Apply DRY principle and consistent patterns

### Next Steps
- Review other components for potential refactoring
- Create more shared components for repeated patterns
- Apply naming conventions consistently across the codebase
