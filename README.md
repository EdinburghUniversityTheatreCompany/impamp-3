# ImpAmp 2 Soundboard

A modern, web-based soundboard application built with Next.js, TypeScript, IndexedDB, and Web Audio API. ImpAmp 2 allows users to map locally stored audio files to keyboard shortcuts and trigger them instantly via keyboard or mouse clicks.

## Features

- **Offline-First PWA**: Operates fully offline after initial load using PWA techniques
- **Local Storage**: Stores configurations and audio files within the browser's IndexedDB
- **Profile Management**: Create and switch between multiple sound profiles/collections
- **Drag-and-Drop**: Easily assign audio files to pads via drag-and-drop
- **Keyboard Shortcuts**: Trigger sounds instantly via keyboard shortcuts (QWERTY layout keys q, w, e, r, etc.)
- **Multi-Page Support**: Multiple pages (banks) of sounds with intuitive keyboard navigation
- **Edit Mode**: Shift key activates edit mode for renaming pads and banks
- **Bank Navigation**: Press 1-9 for banks 1-9, 0 for bank 10, and Alt+1 through Alt+0 for banks 11-20
- **Emergency Banks**: Mark banks as emergency for quick access during performances
- **Sync Options**: Local profiles, manual export/import, and Google Drive sync (coming soon)
- **Containerization**: Deployed as a Docker container (coming soon)

## Getting Started

### Prerequisites

- Node.js (v18.x or later)
- npm (v9.x or later)

### Installation

1. Clone the repository
   ```bash
   git clone https://github.com/your-username/impamp-2.git
   cd impamp-2
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

## Usage

1. **Adding Sounds**: Drag and drop audio files onto the pads in the grid.
2. **Playing Sounds**: Click on a pad or use the assigned keyboard shortcut.
3. **Bank Navigation**: Use the numeric keys 1-9, 0 for banks 1-10, and Alt+1 through Alt+0 for banks 11-20.
4. **Edit Mode**: Hold Shift to enter edit mode, then Shift+click on pads or banks to rename them.
5. **Creating Profiles**: (Coming soon)
6. **Syncing**: (Coming soon)

## Project Structure

- `/src/app` - Next.js app router pages and layout
- `/src/components` - React components
- `/src/lib` - Core utilities (DB, audio, etc.)
- `/src/hooks` - Custom React hooks
- `/src/store` - State management (Zustand)

## Tech Stack

- **Framework**: Next.js (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **State Management**: Zustand
- **Local Storage**: IndexedDB (via idb)
- **Audio**: Web Audio API
- **File Handling**: react-dropzone

## Development Roadmap

- [x] Project setup
- [x] Basic UI structure
- [x] IndexedDB schema
- [x] State management
- [x] Audio playback foundation
- [x] Pad interaction with drag-and-drop
- [x] Keyboard shortcuts
- [ ] Page navigation
    - [x] Display a browser tab style navigation of banks
    - [x] Flicker when switching banks is annoying
- [x] Display the current playing tracks in a list + their remaining playtime + a button to stop them right now
    - [x] The stop button stops the sound but not remove from 
- [x] esc as panic stop playing button
- [x] dedicated keyboard shortcut for each pad (q w e r t y u i o p a s d f g etc)
- [x] Display keyboard shortcut for pad and esc as panic button in the track playing list
- [x] Progress bars in the pads
- [x] Move the panic button help text to the top
- [x] Holding shift enters edit mode
   - [x] Visually distinct mode to show you're in edit mode
   - [x] Shift-click on pad to rename
   - [x] Shift-click on bank to rename or to mark bank as emergency
   - [x] Show "+" button to the right of the banks to add a new one
- [ ] Hitting enter should immediately play a random emergency that round-robins
- [ ] Arm next sound effect to play so you can browse banks. 
   - Maybe add it to a list near currently playing?
   - What button should trigger playing it
- [ ] Profile management UI
- [ ] Manual import/export
- [ ] Google Drive integration
- [ ] PWA configuration, make sure it works without internet connection
- [ ] Help page with shortcuts, how to import/export, sync with Google Drive
- [ ] UI refinement & theming
- [ ] Docker containerization
- [ ] Add some tests
- [ ] Fix big delay when hitting play -> Memory issues

## License

[MIT](LICENSE)

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
