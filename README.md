# ImpAmp3 Soundboard

A modern, web-based soundboard application built with Next.js, TypeScript, IndexedDB, and Web Audio API. ImpAmp3 allows users to map locally stored audio files to keyboard shortcuts and trigger them instantly via keyboard or mouse clicks.

## Features

- **Offline-First PWA**: Operates fully offline after initial load using PWA techniques
- **Local Storage**: Stores configurations and audio files within the browser's IndexedDB
- **Profile Management**: Create, edit, and switch between multiple sound profiles/collections
- **Drag-and-Drop**: Easily assign audio files to pads via drag-and-drop
- **Keyboard Shortcuts**: Trigger sounds instantly via keyboard shortcuts (QWERTY layout keys q, w, e, r, etc.)
- **Track Arming**: Ctrl+Click to arm tracks for later playback, press F9 to play the next armed track
- **Multi-Page Support**: Multiple pages (banks) of sounds with intuitive keyboard navigation
- **Multi-Sound Pads**: Assign multiple sounds to a single pad with different playback modes:
    - *Sequential*: Plays sounds in order.
    - *Random*: Plays a random sound each time.
    - *Round-Robin*: Plays sounds randomly without repeating until all have played.
- **Edit Mode**: Shift key activates edit mode for renaming pads and banks.
    - *Single Sound Pads*: Remove sound via "X" button or Delete+click.
    - *Multi-Sound Pads*: Shift+click opens an editor to manage sounds (add, remove, reorder via drag-and-drop) and select playback mode.
- **Bulk Import**: In delete/swap mode, use the bulk import feature to assign multiple audio files to empty pads at once with a visual mapping interface.
- **Bank Navigation**: Press 1-9 for banks 1-9, 0 for bank 10, and Ctrl+1 through Ctrl+0 for banks 11-20
- **Emergency Banks**: Mark banks as emergency for quick access during performances
- **Configurable Active Pad Behavior**: Choose whether triggering an active pad continues, stops, or restarts the sound (via Playback Settings).
- **Backup Reminders**: Get notified when profiles haven't been backed up recently (configurable frequency).
- **Sync Options**: Local profiles, manual export/import (V2 format supports multi-sound), and automatic [Google Drive Import/Export](docs/google-drive-sync.md).
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
3. **Bank Navigation**: Use the numeric keys 1-9, 0 for banks 1-10, and Ctrl+1 through Ctrl+0 for banks 11-20.
4. **Edit Mode**: Hold Shift to enter edit mode
   - Shift+click on banks to rename them or toggle emergency status.
   - Shift+click on pads to edit them:
     - *Empty/Single Sound Pads*: Opens a simple rename prompt (or the full editor if preferred).
     - *Multi-Sound Pads*: Opens the full pad editor to manage sounds (add, remove, reorder) and playback mode.
   - Click the red "X" button or use Delete+click on *single-sound* pads to remove the sound (resets name). For multi-sound pads, this action opens the editor.
5. **Arming Tracks**:
   - Hold Ctrl and click on a pad to arm it for later playback
   - Armed tracks appear in the Armed Tracks panel
   - Press F9 to play the next armed track in the queue
   - You can also click the Play button on any armed track in the panel
5. **Managing Profiles**:
   - Use the profile selector in the top-right corner to switch between profiles
   - Click "Manage Profiles" to open the full profile manager
   - Create new profiles with custom names
   - Edit or delete existing profiles
   - Configure backup reminder frequency per profile by setting the number of days, or disable reminders entirely.
   - Each profile has its own set of sounds and bank configurations
6. **Importing/Exporting Profiles**:
   - Open the Profile Manager and go to the "Import / Export" tab.
   - **Export:** Select one or more profiles from the list using the checkboxes, then click "Export Selected". A single JSON file containing all selected profiles will be downloaded. Exporting profiles updates their "last backed up" timestamp.
   - **Import:** Click "Select File to Import" and choose a previously exported JSON file (supports single, multi-profile, and legacy ImpAmp2 formats).
   - **Google Drive:** Use the "Import from Drive..." and "Export Active Profile to Drive" buttons within the Profile Manager (Import/Export tab) after signing in. See the [Google Drive Integration Guide](docs/google-drive-sync.md) for setup and usage details.

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
