# ImpAmp 2 Soundboard

A modern, web-based soundboard application built with Next.js, TypeScript, IndexedDB, and Web Audio API. ImpAmp 2 allows users to map locally stored audio files to keyboard shortcuts and trigger them instantly via keyboard or mouse clicks.

## Features

- **Offline-First PWA**: Operates fully offline after initial load using PWA techniques
- **Local Storage**: Stores configurations and audio files within the browser's IndexedDB
- **Profile Management**: Create and switch between multiple sound profiles/collections
- **Drag-and-Drop**: Easily assign audio files to pads via drag-and-drop
- **Keyboard Shortcuts**: Trigger sounds instantly via keyboard shortcuts
- **Multi-Page Support**: Multiple pages of sounds within each profile
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
3. **Creating Profiles**: (Coming soon)
4. **Syncing**: (Coming soon)

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
- [ ] Display the current playing tracks in a list + their remaining playtime + a button to stop them right now
- [ ] esc as panic stop playing button
- [ ] dedicated keyboard shortcut for each pad (1, 2, 3, 4, 5, 6, 7, next row q w e r t, next row a s d f, etc)
- [ ] Profile management UI
- [ ] Manual import/export
- [ ] Google Drive integration
- [ ] PWA configuration
- [ ] UI refinement & theming
- [ ] Docker containerization

## License

[MIT](LICENSE)

## Acknowledgements

Inspired by the original ImpAmp soundboard application.
