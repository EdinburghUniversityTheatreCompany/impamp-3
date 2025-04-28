
## ImpAmp3 - Specification Document
*Written by Gemini 2.5 Pro*
### 1. Overview

ImpAmp3 is a web-based soundboard application allowing users to map local audio files to keyboard shortcuts for instant playback. It features multiple sound banks, profile management, offline PWA support, and edit modes for configuration.

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
        * Clicking this button initiates a fade-out over a default duration (configurable, default 3 seconds).
        * The fade-out duration is configurable in the Playback Settings modal (accessed via the gear icon in the Active Tracks Panel).
    * **Active Pad Trigger Behavior:** A profile setting determines what happens when a pad is triggered (via click or keyboard shortcut) while it is already playing:
        * `"continue"` (Default): The sound continues playing uninterrupted.
        * `"stop"`: The sound stops immediately.
        * `"restart"`: The sound stops and then immediately starts playing again from the beginning.
        * This setting is configurable in the Playback Settings modal.
        * **Note:** Clicking the track entry in the "Active Tracks" panel *always* stops the sound immediately, regardless of this setting.
* **Multiple Sounds per Pad:**
    * **Requirement:** Pads can be configured with multiple audio files (`audioFileIds: number[]`).
    * **Playback Modes (`playbackType`):** A pad with multiple sounds must have one of the following modes:
        * `"sequential"` (Default): On trigger, always plays the first sound (`audioFileIds[0]`). *Future enhancement: Could play next sound in sequence on subsequent triggers or after completion.*
        * `"random"`: On trigger, plays a randomly selected sound from the `audioFileIds` list.
        * `"round-robin"`: On trigger, plays a randomly selected sound from the list *that hasn't been played yet* in the current cycle. Once all sounds have played, the cycle resets. State is maintained per pad.
* **Concurrent Playback:** The application supports playing multiple sounds concurrently, including multiple instances from the same or different pads.

#### 2.2. Pad Configuration

* **Layout:** A grid of pads, configurable by rows and columns (default: 4 rows, 8 columns).
* **Sound Assignment:**
    * **Drag and Drop:**
        * If a pad has 0 or 1 sound (`audioFileIds.length <= 1`), dragging an audio file onto it *replaces* the existing sound(s) and updates the `padConfiguration` (`audioFileIds = [newId]`, `playbackType = 'sequential'`). The pad name defaults to the new filename without the extension.
        * If a pad has more than 1 sound (`audioFileIds.length > 1`), dragging an audio file onto it is *disabled*. Visual feedback should indicate this (e.g., different overlay).
    * **Edit Modal:** Sounds can be added, removed, and reordered via the Pad Edit Modal (see 3.3).
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
    * **Edit Pad:** `Shift+Click` on any pad (empty or configured) opens the Pad Edit Modal.
        * **Modal Content:**
            * Input field for Pad Name.
            * Radio buttons/Select for Playback Mode (`sequential`, `random`, `round-robin`), only enabled if >1 sound is assigned.
            * A list of currently assigned sounds, displaying filenames.
            * Drag-and-drop functionality (`@hello-pangea/dnd`) to reorder sounds in the list.
            * A remove ('X') button next to each sound in the list.
            * An "Add Sound(s)..." button that opens a file input allowing multiple `audio/*` file selection. Uploaded files are added to the DB and the list. If the pad name was default ("Empty Pad"), it updates to the first uploaded file's name.
        * **Saving:** Clicking "Save Changes" in the modal updates the `padConfiguration` in the DB with the current name, playback mode, and ordered list of `audioFileIds`.
    * **Remove Sound (Direct Action):**
        * The visible "X" button and the `Delete`+click action *only* function for pads with exactly *one* sound (`audioFileIds.length === 1`).
        * When triggered on a single-sound pad, it shows a confirmation modal. On confirm, it clears the `audioFileIds` array, resets the `playbackType` to `sequential`, and resets the pad name to default ("Empty Pad").
        * If a pad has multiple sounds, clicking the "X" button or using `Delete`+click *opens the Pad Edit Modal* instead of showing the confirmation.
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
    5.  Entering Edit Mode (hold Shift).
    6.  Editing a pad (Shift+click): Renaming, adding/removing/reordering sounds, changing playback mode via the modal.
    7.  Removing a single sound (X / Delete+click).
    8.  Accessing the search feature (`Ctrl+F` / icon).
    9.  Configuring backup reminders (Profile Manager -> Edit Profile).

#### 3.8. Backup Reminder Notification

* **Trigger:** Appears if one or more profiles have a `backupReminderPeriod` set (not -1) and the time since their `lastBackedUpAt` exceeds that period.
* **UI:** A non-intrusive banner displayed at the top-center of the application.
    * Shows a warning icon and text "Backup Recommended".
    * Lists the names of the profiles needing backup.
    * Includes a "Manage Profiles" button that opens the Profile Manager modal.
* **Dismissal:** The banner is purely informational and does not need explicit dismissal. It disappears automatically if the underlying conditions (profiles needing backup) are no longer met (e.g., after exporting the profile or changing the reminder setting).

### 4. Data Management

#### 4.1. Profiles

* **Storage:** Profiles are stored in the `profiles` IndexedDB object store.
* **Structure:** Defined by the `Profile` interface (id, name, syncType, googleDriveFolderId?, lastSyncedEtag?, activePadBehavior?, fadeoutDuration?, `lastBackedUpAt`, `backupReminderPeriod`, createdAt, updatedAt).
    * `lastBackedUpAt`: Timestamp (milliseconds) of the last successful profile export. Initialized to `createdAt`.
    * `backupReminderPeriod`: Duration (milliseconds) after `lastBackedUpAt` when a backup reminder should be shown. Defaults to 30 days. A value of `-1` disables reminders for the profile.
* **Management:**
    * Users can create, rename, and delete profiles via the Profile Manager UI.
    * Users can configure the `backupReminderPeriod` for each profile via a number input (specifying days) and a checkbox to disable reminders in the Profile Manager's edit view.
    * The active profile cannot be deleted.
    * A default local profile is created automatically if no profiles exist.
* **Activation:** The active profile ID is stored in `localStorage` for persistence across sessions.

#### 4.2. Pad & Page Data

* **Storage:**
    * Pad configurations are stored in `padConfigurations` (profileId, pageIndex, padIndex, `audioFileIds: number[]`, `playbackType: PlaybackType`, name?, keyBinding?, etc.). Indexed by `profilePagePad`.
    * Page/Bank metadata (name, emergency status) is stored in `pageMetadata` (profileId, pageIndex, name, isEmergency, etc.). Indexed by `profilePage`.
    * Audio file blobs are stored in `audioFiles` (id, blob, name, type, etc.).
* **Relationships:** `padConfigurations` links to `profiles` and `audioFiles` (via `audioFileIds`). `pageMetadata` links to `profiles`.
* **Updates:** Changes (rename, sound assignment/removal/reorder, playback mode change, emergency status) trigger updates in IndexedDB via `upsertPadConfiguration` or `upsertPageMetadata`.

#### 4.3. Import / Export

* **Format:** Export uses a JSON structure (`ProfileExport`) with `exportVersion: 2`. It contains profile details (excluding `lastBackedUpAt`), all associated pad configurations (now including `audioFileIds` and `playbackType`), all associated page metadata, and base64-encoded audio file data for all referenced unique audio files.
* **Export:** Users select a profile to export, generating a downloadable JSON file named `impamp-<profile-name>-<date>.json`. Upon successful export file generation, the profile's `lastBackedUpAt` timestamp is updated to the current time in the database.
* **Import:** Users select an exported JSON file.
    * The system parses it, creates a *new* profile (handling potential name conflicts by appending `(n)`).
    * Imports audio blobs, page metadata, and profile settings.
    * **Pad Configuration Import:**
        * If the imported file `exportVersion` is 2 (or missing but contains `audioFileIds`), it imports `padConfigurations` using the `audioFileIds` and `playbackType` fields.
        * If the imported file `exportVersion` is 1 (or missing and contains `audioFileId`), it migrates the old `audioFileId` field to `audioFileIds: [audioFileId]` and sets `playbackType: 'sequential'` before saving.
    * Original audio IDs are mapped to newly created ones during import.
    * The imported profile's `lastBackedUpAt` is set to the time of import.
* **Export:**
    * Users select one or more profiles via checkboxes in the "Import/Export" tab of the Profile Manager.
    * Clicking "Export Selected" triggers the generation of a single JSON file using the `MultiProfileExport` format (even if only one profile is selected).
    * The filename follows the pattern `impamp-multi-profile-export-X-profiles-YYYY-MM-DD.json` or `impamp-<profile-name>-YYYY-MM-DD.json` if only one profile is selected.
    * Exporting profiles updates their respective `lastBackedUpAt` timestamps in the database and application state.

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
