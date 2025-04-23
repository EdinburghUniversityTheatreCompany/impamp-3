# Comprehensive Refactoring Plan: ImpAmp3

(Note: Before starting implementation in Act Mode, I will re-read the modified files: SPEC.md, src/store/profileStore.ts, src/lib/db.ts)

## I. Core Data Layer & State Management (src/lib/db.ts, src/store/profileStore.ts, src/lib/importExport.ts [New])

### Modularize Import/Export Logic: [DONE]
- **Action:** Create a new file `src/lib/importExport.ts`. [DONE]
- **Action:** Move the `ProfileExport` interface, `Impamp2Export` type (from `impamp2Types.ts`), `exportProfile`, `importProfile`, `importImpamp2Profile`, `blobToBase64`, and `base64ToBlob` functions from `src/lib/db.ts` to the new `importExport.ts`. [DONE]
- **Action:** Update `src/lib/db.ts` and `src/store/profileStore.ts` to import these functions from the new location. [DONE]
- **Rationale:** Significantly cleans up `db.ts`, making it solely focused on IndexedDB interactions. Improves code organization and separation of concerns.

### Optimize DB Transactions & Efficiency: [DONE]
- **Action:** Refactor the `importAudioFiles` helper function (within the new `importExport.ts`) to perform all audio file additions (`addAudioFile`) within a single IndexedDB transaction, rather than one transaction per file. [DONE - Implemented during initial move]
- **Action:** Similarly, review `importPageMetadata` and `importPadConfigurations` to ensure they use single, efficient transactions for their respective bulk operations. [DONE - Implemented during initial move]
- **Rationale:** Drastically improves performance during profile imports, especially those with many audio files. Reduces transaction overhead.

### Decouple DB Operations from UI State: [DONE]
- **Action:** Locate and remove the direct calls to `useProfileStore.getState().incrementEmergencySoundsVersion()` within `upsertPadConfiguration` and `setPageEmergencyState` in `src/lib/db.ts`. [DONE]
- **Action:** Modify the code calling these DB functions (`src/components/PadGrid.tsx` for `upsertPadConfiguration`, `src/app/page.tsx` for `setPageEmergencyState`) to check the result/context and then call the Zustand action if needed (e.g., after successfully setting a page to emergency). [DONE]
- **Rationale:** Enforces separation of concerns. The DB layer should only manage data; UI state updates are a separate responsibility. Makes DB functions pure data operations.

### Refine Profile Store (`src/store/profileStore.ts`):
- **Action:** Refactor profile CRUD actions (`createProfile`, `updateProfile`, `deleteProfile`) and import actions (`exportProfileToJSON`, `importProfileFromJSON`, `importProfileFromImpamp2JSON`) to call the newly modularized functions from `src/lib/db.ts` and `src/lib/importExport.ts`. [DONE - Completed during import path updates]
- **Action:** Instead of calling `fetchProfiles()` after every modification, update the `profiles` array in the store directly based on the successful result of the add/update/delete/import operation. This avoids redundant reads from the DB. [DONE]
- **Action:** Implement Zustand's persistence middleware (`persist` from `zustand/middleware`) to manage storing `activeProfileId` and `fadeoutDuration` in localStorage. Remove manual `localStorage.getItem/setItem` calls. [DONE]
- **Action:** Crucially, fix the `setCurrentPageIndex` logic. Remove the DOM query (`document.querySelectorAll`). Instead, fetch the necessary `pageMetadata` for the active profile (perhaps store it within the profile store itself or fetch it when the profile loads) and check against this data to determine if a target bank index exists before allowing the switch. [DONE]
- **Action:** Analyze the usage of `isEditMode` (global Shift state) and `isEditing` (action-in-progress state) across components (`page.tsx`, `PadGrid.tsx`). Simplify the logic if possible, perhaps by relying more on modal open state (`uiStore`) or deriving `isEditing` implicitly. Ensure `isEditing` is reliably reset when modals close (confirm or cancel). [DONE]
- **Action:** Move the bank number/index conversion functions (`convertBankNumberToIndex`, `convertIndexToBankNumber`) to a utility file like `src/lib/keyboardUtils.ts` or a new `src/lib/bankUtils.ts` for better organization. [DONE]
- **Rationale:** Streamlines the store, improves performance, enhances robustness (persistence middleware), fixes incorrect DOM dependency, reduces state complexity, and improves code organization.

### Prevent Server-Side DB Access: [DONE]
- **Action:** Identify where `ensureDefaultProfile()` is currently called (likely at the bottom of `profileStore.ts`). Remove this call. [DONE]
- **Action:** In a top-level client component (e.g., wrap the content of `src/app/layout.tsx` or `src/app/page.tsx` with a new client component), use a `useEffect` hook that runs only once on mount (`[]` dependency array) to call `ensureDefaultProfile()` and potentially `getDb()` to initialize the database connection client-side. [DONE - Implemented via `ClientSideInitializer.tsx` wrapping children in `layout.tsx`, which calls `fetchProfiles` which calls `ensureDefaultProfile`]
- **Rationale:** Resolves the build/SSR warning about server-side IndexedDB access. Ensures DB logic runs only in the browser environment.

## II. Audio Engine & Playback State (`src/lib/audio.ts`, `src/components/PadGrid.tsx`, `src/store/playbackStore.ts` [New]) [DONE]

*(Includes implementation of audio preloading for instant playback)*

### Centralize and Manage Audio Buffer Cache: [DONE]
- **Action:** Create a `Map` for `audioBufferCache` within the scope of `src/lib/audio.ts`. [DONE]
- **Action:** Modify `loadAndDecodeAudio` to first check this internal cache using the `audioFileId`. If found, return the cached `AudioBuffer`. If not found, proceed with fetching from DB (`getAudioFile`), decoding (`decodeAudioBlob`), storing the result in the cache, and then returning it. Handle potential null returns if fetching/decoding fails, and cache the failure (null) to avoid retrying constantly. [DONE]
- **Action:** Remove the `audioBufferCache` from `PadGrid.tsx`. [DONE]
- **Rationale:** Correctly implements the spec requirement (decode once per ID), centralizes audio data handling, improves performance by avoiding redundant decoding.

### Implement Efficient Playback State Tracking: [DONE]
- **Action:** Create a new Zustand store: `src/store/playbackStore.ts`. This store will hold the state of active tracks (e.g., a map of `playbackKey` to `{ progress: number, remainingTime: number, isFading: boolean, name: string, padInfo: object }`). [DONE]
- **Action:** Remove the `setInterval` polling loop from `PadGrid.tsx`. [DONE]
- **Action:** Within `src/lib/audio.ts`, implement a `requestAnimationFrame` loop. This loop should only start when the first sound begins playing and stop when the last sound finishes. Inside the loop, calculate the current progress/remaining time for all tracks in the internal `activeTracks` map and update the `playbackStore` state. [DONE]
- **Action:** Modify `playAudio`, `stopAudio`, and `fadeOutAudio` in `audio.ts` to also update the `playbackStore` accordingly (adding/removing tracks, setting fading state). [DONE]
- **Action:** Refactor `PadGrid.tsx` and `ActiveTracksPanel.tsx` to subscribe to `playbackStore` to get the necessary data for rendering progress bars, timers, and active track lists. [DONE]
- **Rationale:** Replaces inefficient polling with a performant animation loop. Decouples UI components from audio state calculation. Provides a centralized source of truth for playback status.

### Refine Audio Fading: [DONE]
- **Action:** Investigate if the `onended` event of the `AudioBufferSourceNode` can be reliably used for cleanup after the `linearRampToValueAtTime` completes, potentially removing the need for `setTimeout`. [DONE - Kept `setTimeout` for reliability after investigation]
- **Action:** Integrate the `isFading` status directly into the `ActiveTrack` interface/object within `audio.ts`'s internal `activeTracks` map, removing the separate `fadingTracks` map. Update the `playbackStore` with this fading status. [DONE]
- **Rationale:** Improves timing accuracy for cleanup, simplifies state management for fading tracks.

## III. Component Architecture & UI (`src/components/`, `src/app/page.tsx`)

### Deconstruct `PadGrid.tsx`:
- **Action:** Create and use a new custom hook `usePadConfigurations(profileId, pageIndex)` that encapsulates the logic for fetching pad data (`getPadConfigurationsForProfilePage`) and managing the `padConfigs` state map. `PadGrid` will call this hook.
- **Action:** `PadGrid` will subscribe to the new `playbackStore` (created in II.2) to get `playingPads` and `padPlaybackState` instead of calculating it locally.
- **Action:** Break down the large `handlePadClick` function into smaller, more focused internal functions (e.g., `handleRenameClick`, `handleRemoveClick`, `handlePlaybackClick`).
- **Action:** Refine modal interactions. Instead of passing complex `onConfirm` logic directly, consider passing simpler update functions (e.g., `updatePadName(padIndex, newName)`) to the modal trigger, which then calls the necessary DB/store functions. Or, pass necessary IDs/data to the modal content component, which handles the update logic itself upon confirmation.
- **Action:** Define the configuration for special pads ("Stop All", "Fade Out All") outside the main rendering loop, perhaps as constants or part of a configuration object, making their placement and behavior easier to manage than relying on calculated indices within the `map` function.
- **Rationale:** Dramatically reduces the complexity of `PadGrid`, making it easier to understand, test, and maintain. Improves separation of concerns.

### Enhance `Pad.tsx`:
- **Action:** Introduce the `clsx` library (or a similar utility) to combine conditional class names for styling (`baseStyle`, `configuredStyle`, `editModeStyle`, etc.), making the `className` prop much cleaner.
- **Action:** Optionally, extract the progress bar display (including the timer logic) into a separate functional component (`PadProgressBar.tsx`?) used within `Pad.tsx`.
- **Rationale:** Improves code readability and maintainability of the styling logic.

## V. General Quality Improvements

- **Consistent Error Handling:** Review `try...catch` blocks, especially in `db.ts`, `audio.ts`, and store actions. Implement a more consistent strategy, potentially using a shared notification system/toast library accessible via the `uiStore` or a dedicated hook to provide user feedback on failures.
- **Code Cleanup:** Perform a pass to remove commented-out code, unused variables/imports, and excessive `console.log` statements. Ensure consistent formatting (e.g., run Prettier). Use descriptive variable and function names.
- **SPEC Alignment:** Double-check that the refactored code still aligns with all relevant requirements in the (updated) `SPEC.md`.
