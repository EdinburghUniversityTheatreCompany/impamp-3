# ImpAmp3 Soundboard

A modern, web-based soundboard application built with Next.js, TypeScript, IndexedDB, and Web Audio API. ImpAmp3 allows users to map locally stored audio files to keyboard shortcuts and trigger them instantly via keyboard or mouse clicks.

## Features

- **Offline-First PWA**: Operates fully offline after initial load using PWA techniques
- **Local Storage**: Stores configurations and audio files within the browser's IndexedDB
- **Profile Management**: Create, edit, and switch between multiple sound profiles/collections
- **Drag-and-Drop**: Easily assign audio files to pads via drag-and-drop
- **Keyboard Shortcuts**: Trigger sounds instantly via keyboard shortcuts (QWERTY layout keys q, w, e, r, etc.)
- **Multi-Page Support**: Multiple pages (banks) of sounds with intuitive keyboard navigation
- **Edit Mode**: Shift key activates edit mode for renaming pads and banks, and removing sounds (via an "X" button or Delete+click)
- **Bank Navigation**: Press 1-9 for banks 1-9, 0 for bank 10, and Alt+1 through Alt+0 for banks 11-20
- **Emergency Banks**: Mark banks as emergency for quick access during performances
- **Sync Options**: Local profiles, manual export/import, and Google Drive sync (coming soon)
- **Containerization**: Deployed as a Docker container for easy deployment

## Getting Started

### Prerequisites

- Node.js (v18.x or later)
- npm (v9.x or later)

### Installation

1. Clone the repository
   ```bash
   git clone https://github.com/edinburghuniversitytheatrecompany/impamp-3.git
   cd impamp-3
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

### Building for Production

To build the application for production deployment with PWA support:

1. Build the application
   ```bash
   npm run pwa-build
   # or
   npm run build
   ```

2. Start the production server
   ```bash
   npm run start
   ```

3. The app is now available with full PWA capabilities

### Docker Deployment

ImpAmp3 can be deployed using Docker for easier deployment and consistent environments:

#### Production Deployment

The docker-compose.yml file is configured with profiles to allow you to run only the production container in production environments:

1. Direct Docker run (without compose):
   ```bash
   # Build the image
   docker build -t impamp3:latest .
   
   # Run the container (defaults to port 3025)
   docker run -p 3025:3000 impamp3:latest
   
   # Or specify a custom port
   docker run -p 8080:3000 impamp3:latest
   ```

2. Using Docker Compose:
   ```bash
   # Start only the production app (binds to port 3025 by default)
   docker-compose up app
   
   # Start with custom port
   HOST_PORT=8080 docker-compose up app
   ```

3. Access the application at http://localhost:3025 (or your custom port)

#### Portainer Deployment

For Portainer deployment:

1. Add the docker-compose.yml file to your Portainer stack
2. By default, only the production app will start (the dev service has a profile restriction)
3. You can set the HOST_PORT environment variable in Portainer to change the default port (3025)
4. Deploy the stack

#### Development with Docker Compose

For local development with hot-reloading:

```bash
# Start the development environment with hot-reloading
COMPOSE_PROFILES=development docker-compose up

# Start only the dev environment
COMPOSE_PROFILES=development docker-compose up dev

# Start with custom port
COMPOSE_PROFILES=development DEV_PORT=8081 docker-compose up dev
```

### PWA Features

ImpAmp3 is configured as a Progressive Web App (PWA), which means it:

- Can be installed on desktops, mobile devices, and tablets
- Works offline after the initial load
- Caches audio files for offline playback
- Updates automatically when new versions are deployed

For installation instructions on different devices, refer to the [PWA Usage Guide](docs/pwa-usage-guide.md).

## Usage

1. **Adding Sounds**: Drag and drop audio files onto the pads in the grid.
2. **Playing Sounds**: Click on a pad or use the assigned keyboard shortcut.
3. **Bank Navigation**: Use the numeric keys 1-9, 0 for banks 1-10, and Alt+1 through Alt+0 for banks 11-20.
4. **Edit Mode**: Hold Shift to enter edit mode
   - Shift+click on pads or banks to rename them
   - Click the red "X" button on configured pads to remove sounds
   - Or hold Delete key and click a pad to remove its sound
   - Removing a sound will reset the pad's name to "Empty Pad"
5. **Managing Profiles**: 
   - Use the profile selector in the top-right corner to switch between profiles
   - Click "Manage Profiles" to open the full profile manager
   - Create new profiles with custom names
   - Edit or delete existing profiles
   - Each profile has its own set of sounds and bank configurations
6. **Importing/Exporting Profiles**: 
   - Export profiles to JSON files for backup or transfer to other devices
   - Import profiles from previously exported JSON files
   - Google Drive integration for syncing across devices will be added in a future update

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
    - [x] Click on track to immediately stop it
    - [x] Fadeout button to gradually reduce volume over time
    - [x] Configurable fadeout duration (stored per profile)
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
- [ ] Using alt-<number> to navigate to banks does not work. Pick something else maybe?
- [ ] Accessing bank 10 is not possible due to the numbering being weird
- [x] Hitting enter should immediately play a random emergency that round-robins
- [ ] Arm next sound effect to play so you can browse banks. 
   - Maybe add it to a list near currently playing?
   - What button should trigger playing it
- [x] Removing sound from pad in edit mode
- [x] Profile management UI
   - [x] Remember the last selected profile and start there
- [x] Manual import/export
- [ ] Google Drive integration
   - [ ] Add merging of profiles if two (or more) people edited the same Google Drive profile while offline. How to decide who gets to merge, and communicate if the merge happened.
- [x] PWA configuration, make sure it works without internet connection
- [ ] Help page with shortcuts, how to import/export, sync with Google Drive
- [ ] Short product tour/tutorial on first use
- [ ] UI refinement & theming 
   - [ ] Mobile layout
- [x] Docker containerization
- [ ] Add some tests
- [ ] Fix big delay when hitting play -> Memory issues
- [ ] Fix that IndexedDB error on startup?
- [ ] Fix the PWA stuff. I can't see the offer to install it. -> [https://nextjs.org/docs/app/building-your-application/configuring/progressive-web-apps]
- [x] Favicon based on the SVG
- [ ] The profile selector flickers when switching banks
- [x] Error when installing service workers
- [x] Can't close the PWA pop-up
- [ ] Search feature to find a specific sound effect based on filename and name
   - [ ] When the search window is open, how to close it? Esc is the natural option but already used, but then the qwerty etc keys also lose their function.
- [x] Add fadeout button to currently playing tracks with configurable duration
- [x] Move currently playing track list to the bottom of the screen

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
