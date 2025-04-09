# UI Design Bible - ImpAmp 2 Soundboard

This document outlines the visual and interaction design guidelines for the ImpAmp 2 Soundboard application.

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
    *   Columns: TBD (e.g., 8)
    *   Rows: TBD (e.g., 4)
    *   Gap: TBD (e.g., `gap-2`)
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

### 4.3 Modals

*   **Style:** TBD (Background, Padding, Shadow)

### 4.4 Profile Management

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
*   **Keyboard Navigation:** Number keys 0-9 navigate between banks/pages.
*   **Bank Navigation:** 
    *   Keyboard shortcuts: Number keys 0-9 switch between banks/pages
    *   Visual indicator: Current bank number is displayed prominently
    *   UI buttons: Clickable numbered buttons (0-9) with active state highlighting
    *   Bank switching is immediate with no transition animation
*   **Edit Mode:**
    *   Activation: Hold the Shift key to enter edit mode
    *   Visual Indicator: Amber-colored border around the entire application
    *   Banner: "EDIT MODE" banner appears at the top of the screen
    *   Exit: Release the Shift key to exit edit mode
*   **Renaming:**
    *   Pads: Shift-click on a pad in edit mode to rename it
    *   Banks: Shift-click on a bank in edit mode to rename it
*   **Emergency Banks:**
    *   Visual Indicator: Red dot/ring on bank buttons marked as emergency
    *   Toggle: When renaming a bank in edit mode, option to mark as emergency
    *   Usage: Emergency banks can be triggered with the Enter key (round-robin)
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
