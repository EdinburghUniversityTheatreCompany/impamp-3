# UI Design Bible - ImpAmp3 Soundboard

This document outlines the visual and interaction design guidelines for the ImpAmp3 Soundboard application.

## 1. Color Palette

*   **Primary:** TBD
*   **Secondary:** TBD
*   **Accent:** TBD
*   **Background:** TBD
*   **Text:** TBD
*   **Success:** TBD
*   **Warning:** TBD
*   **Error:** TBD

## 2. Typography

*   **Primary Font:** TBD (e.g., Inter, Roboto)
*   **Headings:** TBD (Size, Weight)
*   **Body Text:** TBD (Size, Weight)

## 3. Layout & Grid

*   **Main Layout:** TBD (e.g., Sidebar + Main Content, Full Width)
*   **Pad Grid:**
    *   Columns: 12
    *   Rows: 4
    *   Gap: `gap-2` (Tailwind)
    *   **Special Pads:**
        *   Index 23 (Row 2, Col 12): "Stop All" button (Triggered by `ESC`, displays "ESC").
        *   Index 35 (Row 3, Col 12): "Fade Out All" button (Triggered by `SPACE`, displays "SPACE").
    *   **Manual Row:** Row 4 (Indices 36-47) is reserved for pads without default key bindings.
*   **Spacing:** Use Tailwind spacing scale consistently.

## 4. Components

### 4.1 Pad

*   **Default State:** TBD (Background, Border, Text Color)
*   **Hover State:** TBD
*   **Active/Playing State:** TBD (e.g., Highlight border, background change)
*   **Configured State:** TBD (Visual indicator if a sound is assigned)
*   **Key Binding Display:** TBD (Position, Style)
*   **Pad Name Display:** TBD (Position, Style)

### 4.2 Buttons

*   **Primary Button:** TBD (Style for main actions)
*   **Secondary Button:** TBD (Style for less prominent actions)
*   **Icon Button:** TBD

### 4.3 Modals (`src/components/Modal.tsx`, `src/store/uiStore.ts`)

*   **Purpose:** Provides a consistent way to display confirmations, prompts, or custom forms, replacing native browser dialogs.
*   **Structure:**
    *   Fixed overlay (`bg-black/50`).
    *   Centered content container (`bg-white dark:bg-gray-800`, rounded, shadow, padding).
    *   Optional title area.
    *   Main content area (renders custom `children`).
    *   Optional action button area (Confirm/Cancel).
    *   Close button (top-right 'X').
*   **Usage:**
    *   Managed globally via `useUIStore`.
    *   Call `openModal(config)` with a configuration object.
    *   The `config.content` property takes a ReactNode, typically one of the specific content components:
        *   `ConfirmModalContent`: Displays a simple message.
        *   `PromptModalContent`: Displays a label and text input.
        *   `EditBankModalContent`: Displays bank name input and emergency checkbox.
    *   `config.onConfirm` contains the logic to execute when the confirm button is clicked (often reading data collected by the content component).
    *   `config.onCancel` (optional) runs when the modal is closed via overlay click, close button, or cancel button.
    *   `closeModal()` closes the currently open modal.
*   **Styling:** Uses Tailwind CSS for styling. Key elements have `data-testid` attributes for testing.

### 4.4 Edit Pad Modal Content (`src/components/modals/EditPadModalContent.tsx`)

*   **Purpose:** Allows editing pad name, playback mode, and managing multiple sounds.
*   **Trigger:** Shift+click on any pad in Edit Mode.
*   **Layout:** Vertical stack (`flex flex-col space-y-4`).
*   **Components:**
    *   **Pad Name:** Standard labeled text input (`<input type="text">`).
    *   **Playback Mode:** Labeled radio button group (`<input type="radio">`) for "Sequential", "Random", "Round Robin". Disabled if sound count is <= 1.
    *   **Sounds List:**
        *   Label: "Sounds (Drag to Reorder)".
        *   Displays "Loading sounds..." or "No sounds assigned..." messages appropriately.
        *   Uses `@hello-pangea/dnd` (`DragDropContext`, `Droppable`, `Draggable`) for the list (`<ul>`).
        *   Each list item (`<li>`) shows the sound filename (truncated if necessary) and a small '✕' remove button.
        *   Styled with borders, dividers, and hover effects. Max height with vertical scroll.
    *   **Add Sound(s) Button:** Standard button styled prominently (e.g., Indigo background). Triggers a hidden file input (`<input type="file" multiple>`).
*   **Interaction:**
    *   Drag handles on list items for reordering.
    *   Remove button deletes the sound from the list state.
    *   Add button opens file dialog; selected audio files are added to the DB and the list state.
    *   Pad name updates automatically to the first added sound's name *only if* the name was previously "Empty Pad".
*   **Saving:** The main modal's "Save Changes" button reads the state from this component (via a ref) and calls `upsertPadConfiguration`.

### 4.5 Profile Management

*   **Profile Selector:**
    *   Location: Top-right of the main interface
    *   Style: Dropdown with icon and active profile name
    *   Features: Quick profile switching, option to open full profile manager
    *   Color: Consistent with main UI, highlighted active profile

*   **Profile Manager Modal:**
    *   Layout: Tabbed interface with Profiles and Import/Export tabs
    *   Profile Cards: Displays name, sync type, creation date, active status
    *   Card Actions: Activate, Edit, Delete buttons for each profile
    *   Creation Form: Form for creating new profiles with name and sync type options

*   **Import/Export:**
    *   Reserved section for future file-based import/export functionality
    *   Reserved section for future Google Drive integration

## 5. Interaction Patterns

*   **Drag and Drop:** Visual feedback during drag-over and on drop.
*   **Keyboard Navigation:**
    *   Number keys 1-9, 0: Switch banks 1-10.
    *   Ctrl + (1-9, 0): Switch banks 11-20.
    *   Pad Keys (QWERTY row, ASDF row up to `\`, ZXCV row up to `/`): Trigger corresponding pads (indices 0-22, 24-34).
    *   `Escape`: Stop all currently playing audio (corresponds to Pad Index 23).
    *   `Space`: Fade out all currently playing audio (corresponds to Pad Index 35).
    *   `Enter`: Play next emergency sound (round-robin).
    *   `Shift` (Hold): Enter Edit Mode.
    *   `Delete` (in Edit Mode): Show remove confirmation for the clicked pad.
    *   `Ctrl + F`: Open Search Modal.
*   **Bank Navigation:** 
    *   Keyboard shortcuts: See Keyboard Navigation section.
    *   Visual indicator: Current bank number is displayed prominently
    *   UI buttons: Clickable numbered buttons (0-9) with active state highlighting
    *   Bank switching is immediate with no transition animation
*   **Edit Mode:**
    *   Activation: Hold the Shift key to enter edit mode
    *   Visual Indicator: Amber-colored border around the entire application
    *   Banner: "EDIT MODE" banner appears at the top of the screen
    *   Exit: Release the Shift key to exit edit mode
*   **Renaming/Editing (via Modal):**
    *   Pads: Shift+click on a pad in edit mode opens a modal (`PromptModalContent`) to enter a new name.
    *   Banks: Shift+click on a bank tab in edit mode opens a modal (`EditBankModalContent`) to edit the name and toggle emergency status.
*   **Adding Banks (via Modal):**
    *   Clicking the '+' button in edit mode opens a modal (`PromptModalContent`) to enter the new bank's name.
*   **Removing Pad Sound (via Modal):**
    *   Clicking the 'x' button on a configured pad in edit mode opens a confirmation modal (`ConfirmModalContent`).
*   **Emergency Banks:**
    *   Visual Indicator: Red dot/ring on bank tabs marked as emergency.
    *   Toggle: Handled within the `EditBankModalContent` via a checkbox.
    *   Usage: Emergency banks can be triggered with the Enter key (round-robin).
*   **Sync Status:** Clear visual indicators for syncing, success, conflicts, errors.

## 6. Edit Mode Design

### 6.1 Global Indicators

*   **Border:** 8px amber-colored semi-transparent border around the entire application
*   **Banner:** Fixed-position amber banner at the top with white text stating "EDIT MODE"
*   **Helper Text:** Shift+click instructions appear in relevant areas

### 6.2 Editable Elements

*   **Pads:**
    *   Border: Amber dashed border
    *   Interaction: Shift+click to rename
    *   Visual Feedback: Highlight on hover in edit mode

*   **Banks:**
    *   Border: Amber dashed border
    *   Tooltip: Shows bank name and edit instructions on hover
    *   Interaction: Shift+click to rename and set emergency status
    *   Emergency Indicator: Red dot in top-right corner for emergency banks

*   **Add Bank Button:**
    *   Visibility: Only visible in edit mode
    *   Style: Amber-colored "+" button that appears at the end of the bank list
    *   Position: Right side of bank buttons

*(This document will be updated as design decisions are made during development.)*
