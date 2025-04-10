
## ImpAmp3 - Specification Document
*Written by Gemini 2.5 Pro*
### 1. Overview

ImpAmp 2 is a web-based soundboard application allowing users to map local audio files to keyboard shortcuts for instant playback. It features multiple sound banks, profile management, offline PWA support, and edit modes for configuration.

### 2. Core Functionality

#### 2.1. Audio Playback

* **Triggering:** Sounds can be triggered by:
    * Clicking the corresponding pad.
    * Pressing the assigned keyboard shortcut (default or custom).
* **Audio Loading & Performance:**
    * **Requirement:** All sounds associated with the *currently active profile* should be decoded and loaded into memory when the application loads or the profile is activated.
    * **Requirement:** Ensure the same audio file (referenced by its `audioFileId` in the database) is decoded and stored in memory only once, even if assigned to multiple pads.
    * **Goal:** Playback should initiate immediately upon triggering, minimizing latency. Further investigation is needed to identify and resolve the cause of existing delays.
    * **AudioContext:** The Web Audio API `AudioContext` should be resumed on the first user interaction (click or key press) to ensure playback readiness.
* **Stopping Sounds:**
    * **Panic Stop (Esc):** Pressing the `Escape` key immediately stops *all* currently playing sounds. This function should *not* be active when the search modal is open.
    * **Individual Stop:** Clicking on the entry for a currently playing track in the "Active Tracks" panel immediately stops that specific sound.
    * **Individual Fadeout:** A dedicated "Fadeout" button will be added to each entry in the "Active Tracks" panel.
        * Clicking this button initiates a fade-out over a default duration of 3 seconds.
        * The fade-out duration should be a configurable setting within the profile.
    * **Restart on Re-trigger:** Pressing the keyboard shortcut for a pad that is already playing should restart the sound from the beginning (implicitly stopping the current instance). Clicking a pad that is already playing should stop it.
* **Multiple Sounds:** The application should support playing multiple sounds concurrently.

#### 2.2. Pad Configuration

* **Layout:** A grid of pads, configurable by rows and columns (default: 4 rows, 8 columns).
* **Sound Assignment:**
    * Users can drag and drop audio files (`audio/*`) onto a pad to assign a sound.
    * On drop, the audio file blob is added to the `audioFiles` store in IndexedDB, and a `padConfiguration` entry is created/updated linking the profile, page, pad index, and the new `audioFileId`.
    * The pad name defaults to the filename without the extension.
* **Visual State:**
    * **Empty:** Visually distinct style, displays "Empty Pad".
    * **Configured:** Different visual style indicating a sound is assigned, displays the pad name.
    * **Playing:** Visual indicator (e.g., ring, highlight)  and a progress bar showing playback progress (0 to 1).
    * **Drag-over:** Visual feedback when a valid audio file is dragged over a pad (e.g., border change, background color change).
* **Key Binding Display:** Each pad should display its assigned keyboard shortcut (custom or default).

### 3. User Interface (UI) & User Experience (UX)

#### 3.1. Main Layout

* **Structure:** Three-column layout:
    * Left/Main: Pad Grid and Bank Navigation.
    * Right Sidebar: Active Tracks Panel.
    * Header Area: Title, Profile Selector, potentially Search Icon.
* **Active Tracks Panel:**
    * **Position:** Moved to the bottom of the screen.
    * Displays a list of currently playing sounds.
    * Each entry shows:
        * Sound/Pad Name.
        * Remaining playtime (formatted MM:SS).
        * A progress bar indicating playback progress.
        * A "Fadeout" button (replaces the previous 'X' stop button).
    * Clicking the track entry itself stops the sound immediately.
    * Displays "Nothing playing" when idle.
    * Includes help text "Press ESC to stop all sounds" at the top.
* **Help Text Panel:** Displays contextual help text (e.g., edit mode instructions, navigation hints) above the bank tabs.
* **Profile Selector Flicker:** The flicker when switching edit mode or banks needs to be fixed. The profile display should remain static during these actions.

#### 3.2. Bank Navigation

* **UI:** Display bank selection as tabs above the pad grid.
    * Show bank number and custom name (if set).
    * Highlight the active bank tab.
    * Indicate emergency banks visually (e.g., red dot/ring).
* **Keyboard Shortcuts:**
    * **Requirement:** Implement the following bank switching shortcuts:
        * `1` through `9`: Switch to Banks 1-9 (Indices 0-8).
        * `0`: Switch to Bank 10 (Index 9).
        * `Ctrl+1` through `Ctrl+9`: Switch to Banks 11-19 (Indices 10-18).
        * `Ctrl+0`: Switch to Bank 20 (Index 19).
    * These shortcuts should take precedence over pad triggers if the keys overlap (e.g., number keys should switch banks, not trigger pads).
* **Adding Banks:** A "+" button is visible only in Edit Mode, allowing users to add new banks (up to Bank 20).

#### 3.3. Edit Mode

* **Activation:** Holding the `Shift` key activates Edit Mode. Releasing `Shift` deactivates it, unless an edit action (like a prompt) is in progress.
* **Visual Indicators:**
    * Global border around the application (e.g., 8px amber semi-transparent).
    * Top banner indicating "EDIT MODE".
    * Editable elements (pads, banks) should have a distinct style (e.g., dashed amber border).
* **Pad Actions:**
    * **Rename:** `Shift+Click` on a pad opens a prompt to rename it.
    * **Remove Sound:**
        * A visible "X" button appears on configured pads. Clicking it removes the sound assignment (after confirmation).
        * Alternatively, holding the `Delete` key and clicking a configured pad removes the sound assignment (after confirmation).
        * Removing a sound resets the pad name to default ("Empty Pad") and clears the `audioFileId`.
* **Bank Actions:**
    * `Shift+Click` on a bank tab opens a dialog to:
        * Rename the bank.
        * Toggle its "Emergency" status.

#### 3.4. Search Feature

* **Activation:** Triggered by `Ctrl+F` or clicking a search icon (location TBD, suggest top bar).
* **UI:** A modal dialog appears.
    * Contains a search input bar at the top.
    * Below the bar, displays a list of pads (across all banks in the active profile) whose name or original filename matches the query.
* **Interaction within Modal:**
    * Clicking a result plays the sound immediately.
    * `Ctrl+Click` (or other designated modifier+click) arms the sound.
    * Pad/bank keyboard shortcuts are *disabled* while the search modal is open.
    * Pressing `Escape` *only* closes the search modal; it does not act as a panic stop. Other methods to close (e.g., click outside, close button) should also be considered.

#### 3.5. Arm Next Sound Effect

* **Concept:** Allow the user to select a sound to be played next, without interrupting Browse or current playback.
* **Arming Mechanism (Option):** `Ctrl+Click` on a pad (either in the grid or search results).
* **Display (Option):** Show the armed sound(s) in a dedicated area, potentially near/below the Active Tracks panel. Consider how multiple armed sounds would display (e.g., a queue).
* **Triggering Playback (Options - TBD):**
    * Option A: A dedicated global key (e.g., `Spacebar` - conflicting with potential future global fadeout, `Enter` - conflicts with emergency).
    * Option B: A dedicated button in the UI near the armed sound display.
    * Option C: If implementing a queue, maybe the trigger plays the *next* in the queue.
* **Interaction:** Playing a pad directly does *not* affect the armed sound(s); they remain armed.

#### 3.6. Mobile Layout

* **Requirement:** The application must be usable in landscape mode on mobile devices.
* **Portrait Mode:** Display a message prompting the user to rotate their device to landscape mode.
* **Considerations:** The layout needs significant adjustment for smaller screens. Prioritize playback accessibility. Pad grid size, active tracks display, and edit mode interactions need specific mobile designs.

#### 3.7. Product Tour

* **Requirement:** Provide a short tutorial on first use.
* **Key Steps:** 
    1.  How to trigger pads (click, keyboard).
    2.  How to assign a sound (drag-and-drop).
    3.  The `Escape` key panic button.
    4.  Stopping individual sounds (click active track entry).
    5.  Entering Edit Mode (hold Shift) and editing a pad (Shift+click to rename, X/Delete+click to remove).
    6.  Accessing the search feature (`Ctrl+F` / icon).

### 4. Data Management

#### 4.1. Profiles

* **Storage:** Profiles are stored in the `profiles` IndexedDB object store.
* **Structure:** Defined by the `Profile` interface (id, name, syncType, googleDriveFolderId?, lastSyncedEtag?, createdAt, updatedAt).
* **Management:**
    * Users can create, rename, and delete profiles via the Profile Manager UI.
    * The active profile cannot be deleted.
    * A default local profile is created automatically if no profiles exist.
* **Activation:** The active profile ID is stored in `localStorage` for persistence across sessions.

#### 4.2. Pad & Page Data

* **Storage:**
    * Pad configurations are stored in `padConfigurations` (profileId, pageIndex, padIndex, audioFileId?, name?, keyBinding?, etc.). Indexed by `profilePagePad`.
    * Page/Bank metadata (name, emergency status) is stored in `pageMetadata` (profileId, pageIndex, name, isEmergency, etc.). Indexed by `profilePage`.
    * Audio file blobs are stored in `audioFiles` (id, blob, name, type, etc.).
* **Relationships:** `padConfigurations` links to `profiles` and `audioFiles`. `pageMetadata` links to `profiles`.
* **Updates:** Changes (rename, sound assignment/removal, emergency status) trigger updates in IndexedDB via `upsertPadConfiguration` or `upsertPageMetadata`.

#### 4.3. Import / Export

* **Format:** Export uses a JSON structure (`ProfileExport`) containing profile details, all associated pad configurations, all associated page metadata, and base64-encoded audio file data.
* **Export:** Users select a profile to export, generating a downloadable JSON file named `impamp-<profile-name>-<date>.json`.
* **Import:** Users select an exported JSON file. The system parses it, creates a *new* profile (handling potential name conflicts by appending `(n)`), imports audio blobs, page metadata, and pad configurations, mapping original audio IDs to newly created ones.

#### 4.4. Sync (Future - Google Drive)

* **Goal:** Allow profiles (configurations and potentially audio files) to be synced via Google Drive.
* **Offline Merging Strategy (TBD):** Define how conflicts are handled if a profile is edited offline on multiple devices and then synced. Options:
    * Last Write Wins (based on timestamp).
    * User Prompt: Notify user(s) of conflict and provide options to merge or choose a version.
    * Automatic Merge: Attempt to merge changes intelligently where possible (e.g., changes to different pads/banks).
* **Communication:** Clear communication to the user about sync status, conflicts, and merge results is required.

### 5. Progressive Web App (PWA) & Offline Support

* **Requirement:** The application must function fully offline after initial load and installation.
* **Implementation (Needs Rework):**
    * **Service Worker:** A service worker (`public/sw.js`) must be implemented to handle caching and offline access.
    * **Caching Strategy:**
        * **App Shell:** Pre-cache core application assets (HTML, CSS, JS, icons) on install. Use a network-first or stale-while-revalidate strategy for updates.
        * **Audio Files:** Cache audio files aggressively (e.g., Cache-first). They are already stored in IndexedDB, but caching via the SW might improve initial load performance after the first fetch. Consider if SW caching is needed *in addition* to IndexedDB. *Decision needed: Rely solely on IndexedDB for offline audio or also use Cache Storage via SW?*
        * **API/Data:** Configurations are primarily managed via IndexedDB, which works offline.
    * **Offline Page:** A fallback page (`public/offline.html`) should be served if a network request fails and the resource is not cached (especially for navigation).
    * **Installation Prompt:** The browser's native PWA installation prompt should appear. Provide a manual trigger/button (e.g., in the profile menu) if the automatic prompt is dismissed or fails.
* **Sync on Reconnect:** If Google Drive sync is implemented, it should automatically attempt to sync changes made offline when the connection is restored.

### 6. Technical Issues & Fixes

* **IndexedDB Server Access Error:** The warning "Attempted to access IndexedDB on the server" during server startup (`ensureDefaultProfile` call stack) needs to be resolved. Database operations should only occur client-side. Wrap DB access calls in checks for `typeof window !== 'undefined'` or ensure they are only called from client components/effects.
* **PWA Implementation:** Review and likely reimplement the PWA setup (service worker, manifest, registration logic) to ensure reliable installation, offline functionality, and update handling.
* **Bank Navigation Shortcuts:** Fix the implementation of `Ctrl+1` to `Ctrl+0` shortcuts for banks 11-20.
* **Bank 10 Access:** Ensure the '0' key correctly maps to bank 10 (index 9).

### 7. Future Considerations / Open Questions

* **Testing:** Add unit and integration tests.
* **Arm Next Sound - Trigger:** Finalize the mechanism for *playing* an armed sound.
* **Google Drive - Merge Strategy:** Decide on the specific merge/conflict resolution strategy.
* **Google Drive - Audio Sync:** Decide if audio *files* themselves should be synced via Drive or only configurations (requiring users to have the same audio files locally on different devices).
* **Fadeout Duration:** Confirm if the 3-second default is acceptable and how profile-specific configuration should be implemented.
* **UI Theming:** Define specific color palettes and typography.
