# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Building and Development

- `npm run dev` - Start development server with Turbopack (localhost:3000)
- `npm run build` - Build for production (requires prebuild step)
- `npm run start` - Serve the production build. Runs `.next/standalone/server.js`
  (via `scripts/start-standalone.js`) — the same server the Docker image runs.
  `next start` is unsupported with `output: standalone`. Reads `PORT`; a
  `--port` argument is translated to it.
- `npm run lint` - Run ESLint
- `npm run typecheck` - `tsc --noEmit`. A gate with a name, in the CI `unit`
  job and in `hk.pkl`: TypeScript used to be enforced only as a side effect of
  `npm run build` inside the e2e job's webServer, so `npm test && npm run lint`
  went green with a type error in the tree. Some guards here **are** types —
  `profileWire.ts`'s exhaustiveness assertion is the whole of "adding a field
  to `Profile` does not put it on the wire"

### Testing

- `npm test` - Run the Vitest unit/integration suite (server sync, storage, API routes)
- `npm run test:watch` - Vitest in watch mode
- `npm run test:coverage` - The same suite with V8 coverage, and the floor in
  `vitest.config.ts` enforced. CI runs this as its own step. The thresholds are
  a **ratchet set just under the current number**, not a target: raise them
  when a run comes in comfortably above, and never lower them to make a build
  pass
- `npm run test:e2e` - Run all Playwright end-to-end tests
- `npm run test:e2e:audio` - Run audio playback tests specifically
- `npm run test:e2e:profiles` - Run profile management tests
- `npm run test:e2e:edit` - Run edit mode tests
- `npm run test:e2e:keyboard` - Run keyboard shortcut tests
- `npm run test:e2e:loudness` - Run loudness and gain tests
- `npm run test:e2e:debug` - Run tests in debug mode

(`npm test` works without `run` because `test` is a built-in npm alias. Nothing
else here is, and these were all written without it.)

### Utilities

- `npm run generate-favicon` - Generate favicon from SVG
- Scripts are located in `/scripts/` directory for build-time generation

## Architecture Overview

### Core Audio System

The application centers around a sophisticated audio playback system located in `src/lib/audio/`:

- **Audio Context Management** (`context.ts`) - Manages Web Audio API context and state
- **Audio Decoder** (`decoder.ts`) - Handles audio file decoding and caching
- **Playback Engine** (`playback.ts`) - Core playback functionality with progress tracking
- **Playback Strategies** (`strategies/`) - Different playback modes (sequential, random, round-robin)
- **Audio Cache** (`cache.ts`) - Optimized caching for decoded audio buffers

### State Management (Zustand)

Three main stores handle application state:

- **Profile Store** (`profileStore.ts`) - Active profile, profile switching, backup reminders
- **Playback Store** (`playbackStore.ts`) - Active tracks, armed tracks, playback controls
- **UI Store** (`uiStore.ts`) - Modal state, edit mode, search functionality

### Server Layer (server sync)

Server-side code lives in `src/lib/server/` and must never be imported from
client components — it uses Node's built-in `node:sqlite`:

- **Storage** (`db.ts`) - SQLite connection, migrations, typed query helpers
- **Users / Profiles / Shares** (`users.ts`, `profiles.ts`, `shares.ts`)
- **Sessions** (`session.ts`) - HttpOnly cookie, only the token hash is stored
- **Events** (`events.ts`) - in-process pub/sub behind the SSE endpoint

The client half is `src/lib/serverSync/` plus `src/hooks/useServerSync.ts`.
See `docs/server-sync.md`.

### Database Layer

IndexedDB abstraction in `src/lib/db.ts` with four object stores:

- `profiles` - Profile metadata and settings
- `padConfigurations` - Pad assignments, audio file references, playback
  modes. A pad names its bank by `bankId` and carries no position of its own,
  because a pad's position is its bank's
- `audioFiles` - Binary audio data storage
- `pageMetadata` - One row per bank: `bankId` is its identity, `pageIndex` is
  its position, plus the name and the emergency flag

### Component Architecture

- **Layout Components** - `ClientLayout.tsx` handles overall application structure
- **Modal System** - Centralized modal management with `ModalRenderer.tsx`
- **Pad System** - `Pad.tsx`, `PadGrid.tsx` with drag-and-drop and edit capabilities
- **Panel Components** - `ActiveTracksPanel.tsx`, `ArmedTracksPanel.tsx` for playback status

### Key Features Implementation

- **Edit Mode** - Activated by Shift key, allows pad/bank editing and
  dragging the bank tabs into a new order (`BankTabStrip.tsx`)
- **Search System** - Ctrl+F (Cmd+F on a Mac) opens search modal across all banks
- **Track Arming** - Ctrl+Click to queue sounds, F9 to play next. Command counts
  as the arm modifier everywhere Ctrl does, because macOS claims Ctrl+click as
  the secondary click and the browser never dispatches the `click`. Read the
  chord through `hasArmModifier` in `src/lib/platform.ts` rather than testing
  `ctrlKey` directly, and label it with `armModifierLabel`
- **Google Drive Sync** - Complete sync implementation in `src/lib/googleDrive/`
- **Server Sync** - ETag/If-Match sync against the app's own backend, with SSE
  change notifications (`src/lib/serverSync/`). Audio stays in Drive by
  default.
- **Server-hosted audio** - optional, off unless the five `IMPAMP_S3_*`
  variables are set, and then still per-account (`can_upload_audio`). Presigned
  PUT/GET straight to Wasabi; the app never handles the bytes.
  `src/lib/serverAudio/` (client), `src/lib/server/s3/` (signing + client).
  See `docs/wasabi-audio.md`.
- **Loudness normalisation** - every audio file is analysed once for
  BS.1770-4 loudness, stored as per-block mean squares so any trimmed
  sub-range can be measured exactly without re-decoding. Gain resolves as
  normalisation x per-sound gain x per-pad gain into `PlayAudioParams.volume`.
  `src/lib/audio/loudness/`. See `docs/loudness-normalisation.md`.
- **Layered retrigger** - `activePadBehavior` is `continue`, `stop`, `restart`
  or `layer`. It is a profile setting with a per-pad override
  (`PadConfiguration.activePadBehavior`), where `undefined` means "follow the
  profile"; resolve the two through `resolveActivePadBehavior` in `db.ts` and
  nowhere else, and import the `ActivePadBehavior` union from there rather
  than writing the members out again (it was duplicated in four places once).
  A layered pad stacks up to `MAX_LAYERS_PER_PAD` (16) overlapping sounds, and
  the 17th trigger steals the oldest so a press always makes a sound
- **Offline / PWA** - `public/sw.js` caches the app shell so the board runs
  with no network; registered from `src/lib/serviceWorker/register.ts`, and in
  production builds only. The precache list is derived at install by walking
  the asset graph out from the live HTML, so there is no list to keep in step.
  Nothing under `/api` is cached, and updates never apply to a running page.
  See `docs/offline-pwa.md`

### Import/Export System

Multi-format support in `src/lib/importExport.ts`:

- V2 format supports multi-sound pads with playback strategies
- V1 legacy format migration from ImpAmp2
- Multi-profile export/import functionality

### Keyboard Navigation

Comprehensive keyboard system (`src/lib/keyboardUtils.ts`):

- Banks 1-9: keys 1-9
- Bank 10: key 0
- Banks 11-19: Ctrl+1 through Ctrl+9 (Ctrl on every platform: Cmd+digit is the
  browser's tab switcher and cannot be cancelled from the page)
- Bank 20: Ctrl+0
- ESC: Stop all sounds (panic button), and hand focus back to the board
- F9: Play next armed track
- Shift: Enter edit mode
- Tab: walks the chrome only. `Pad` is `tabIndex={-1}`, so Tab can never park
  focus on the board — which is what would turn Enter and Space into "replay
  the pad Tab stopped on". A control Tab focused keeps Enter and Space for
  itself; a control a _pointer_ focused does not, so clicking Help never costs
  the operator Fade Out All. `useKeyboardListener` tracks that difference in a
  ref fed by capture-phase `keydown`/`pointerdown` listeners rather than
  asking `:focus-visible`, which flips a click-focused button to focus-visible
  on the very keydown being judged. Tab used to be suppressed app-wide
  instead, which cost the header, the bank tabs and the profile selector every
  keyboard route in

A digit names a **position**, not a bank. `setCurrentPageIndex` indexes into
`profileStore.banks` — already in display order, see `src/lib/bankOrder.ts` —
and stores the `bankId` it finds there, so after a reorder `3` selects
whichever bank sits third.

### Docker Deployment

- Production Dockerfile with multi-stage build
- Kamal2 deployment configuration in `config/deploy.yml`
- Health check endpoint at `/up`
- Development compose setup with profiles

## Development Guidelines

### Key package versions

As resolved in `package-lock.json` — keep in sync when upgrading dependencies:
Next.js 16, React 19, TypeScript 6, Tailwind CSS 4, Zustand 5, idb 8,
react-dropzone 20, Playwright 1.62, ESLint 9 with eslint-config-next 16,
Prettier 3.9, Vitest 4.1 with `@vitest/coverage-v8` on the same version (the
coverage provider is released in lockstep with Vitest, so bump the two
together).

Three upgrades are deliberately held back, with the reasons and retry
conditions in `plans/deferred-upgrades.md`: TypeScript 7 (typescript-eslint
refuses the TS 7 API), ESLint 10 (eslint-plugin-react has no ESLint 10 release)
and file-selector 5 (react-dropzone 20 depends on `^4.1.0`, so bumping the top
level installs a second copy and `fromEvent` stops being the one react-dropzone
calls internally). These are exactly the three `npm outdated` reports, and
exactly the three `.github/dependabot.yml` ignores — if you see three outdated
packages, none of them is fair game.

### Code Style

- TypeScript strict mode enabled
- Path aliases: `@/*` maps to `src/*`
- Tailwind CSS version 4 for styling (without a config file and with opacity using the / notation)
- ESLint configuration with Next.js rules. `npm run lint` calls `eslint .`
  directly — `next lint` was removed in Next 16 — so `eslint.config.mjs` owns
  the ignore list that `next lint` used to supply

### Testing Strategy

- Vitest for unit/integration tests (`src/**/*.test.ts`), run with `npm test`
- Vitest runs in the **node** environment, so there is no DOM and no
  IndexedDB by default. A test that needs the database imports
  `fake-indexeddb/auto`, assigns `globalThis.window` **before** importing
  anything that reaches `db.ts` (it reads `window` as it evaluates, to decide
  whether it is on a client), and therefore imports those modules dynamically.
  `getDb` memoises its connection, so such a suite empties the object stores
  between tests rather than swapping the database — which means autoIncrement
  ids keep climbing, and assertions must key off an id the store handed back
  rather than a literal. See `src/lib/googleDrive/dataAccess.gain.test.ts`
- Banks make position and identity look interchangeable in a fixture. A
  migrated bank and a default bank both have `bankId === String(pageIndex)`,
  so identity-keyed and position-keyed code behave **identically** on any
  fixture built from `ensureDefaultBanks`. Swapping `byId.get(bankId)` for
  `banks[Number(bankId)]` — the exact conflation the `bankId` field exists to
  end — once left all 28 tests of the owning suite green. A test that means
  to check identity needs a bank whose id is a UUID at a position that is not
  its index
- jsdom cannot run `@hello-pangea/dnd`'s sensors, so a unit test of a drag
  can only mock the library and assert that props were passed. That passed
  for three review rounds while the bank-tab drag did not work in a browser
  at all. Anything that depends on the library actually doing something needs
  a real browser: `e2e-tests/bank-reorder.spec.ts` is the regression test
- Two assertions in this area look like they check something and do not.
  `useKeyboardListener` holds a 100 ms per-key debounce as well as its
  `if (event.repeat) return;` guard, so a test that bursts auto-repeats at a
  real OS rate (~30 ms) is measuring the debounce and passes whichever way the
  guard goes — space the repeats past 100 ms. And a text assertion on the
  Active Tracks group row can pass while the row is unreadable: the layer
  badge covered the remaining time for a while and `textContent` still held
  `0:59`. Geometry was the only tell, which is why
  `e2e-tests/layer-count-row.spec.ts` measures bounding boxes in a browser
- Shared test scaffolding lives in `src/lib/testSupport/` and is excluded from
  coverage. The jscpd gate runs at threshold 0, so a second copy of a fake
  fails the commit rather than the review — reach for `fakeWebAudio.ts` (the
  Web Audio fake whose sources record `stop()`), `audioStackMocks.ts`
  (everything below `controls.ts`, installed with `vi.doMock` because
  `vi.mock` is hoisted into the file it is written in and cannot be called on
  another file's behalf), `legacyDatabase.ts`, `browserGlobals.ts` or
  `audioFixtures.ts` before writing a third
- Playwright for comprehensive E2E testing
- Tests cover audio playback, profile management, edit mode, keyboard shortcuts
- Test helper utilities in `e2e-tests/test-helpers.ts`
- The E2E run brings up **two** servers and one global setup, all from
  `playwright.config.ts`. `e2e-tests/fake-s3.js` is a real HTTP bucket — path
  style, presigned PUT, HEAD, ranged GET, DELETE, ListObjectsV2 — that
  `e2e-tests/env.js` points the five `IMPAMP_S3_*` variables at, so hosted
  audio is **on** during E2E and the presigned PUT, the commit that charges
  quota from what the bucket reports, proof of possession and the download URL
  are all exercised for real. It does not verify signatures on purpose;
  `src/lib/server/s3/sigv4.test.ts` does that against the specification's
  vectors. What an _unconfigured_ deployment answers lives in
  `audio.api.test.ts` instead. `scripts/e2e-server.sh` does not start the
  bucket — Playwright owns it — so poking the app by hand after that script has
  hosting configured with nothing behind it.
  `e2e-tests/global-setup.ts` claims the admin account before any worker
  starts, because admin is not a flag anything can set: the first user written
  to the database bootstraps as one. Without it the bit lands on whichever
  throwaway account signed in first, which changes with the worker count and
  the filter
- CI runs e2e with **two workers**, not one. Every flake this suite has had
  came from parallel load, so a single-worker run with two retries was the most
  forgiving configuration anyone ran and could not see the class of bug
  developers hit. Any test that needed a retry is listed in the job summary by
  `e2e-tests/flaky-reporter.ts`; `E2E_FAIL_ON_FLAKE=1` turns that into a gate
- Generated test WAVs go in a **per-worker** temp directory, keeping the
  basename — a pad displays the file name and specs assert on it. They used to
  share one path in `os.tmpdir()`, and two specs using the same name wrote the
  file the other was handing to `setInputFiles`
- `activatePad` **re-issues** the click or keypress until something plays,
  rather than pressing once and waiting. A single press is not guaranteed
  delivery: the keyboard listener reads its pad configurations through
  `actionablePadConfigs`, which hands back an empty map while a read is in
  flight — deliberately, so a key pressed after a bank switch cannot play the
  previous bank's pad — and assigning a sound starts such a read. The pad's
  label comes from the read that already settled, so a spec that waits for the
  name and then presses can land inside the next read's window and lose the
  press entirely
- E2E gates on **chromium only**. Firefox and WebKit are **on demand only** —
  they do not run on push or PR (Actions → ci → Run workflow, or
  `gh workflow run ci`). Both are known-red for reasons outside the app, so
  running them every push cost ~35 minutes for no actionable signal. Read
  `docs/cross-browser-e2e.md` before acting on either. In short: Playwright's
  Linux WebKit cannot write a `Blob` to IndexedDB (so no pad ever gets a
  sound), and CI's runner has no audio device (so Firefox never starts
  playback, though it was green locally when last measured). Worth running
  deliberately after a dependency upgrade, or when touching storage or
  playback. The per-browser counts in that doc are a dated measurement from a
  64-test suite, not a running total — do not compare them against a fresh run

### Audio File Handling

- Supports drag-and-drop audio file assignment
- Files stored as blobs in IndexedDB
- Decoded audio cached for performance
- Multiple playback strategies per pad

### Profile System

- Each profile is completely isolated
- `syncType` is one of `local`, `googleDrive`, or `server`
- Profiles can be linked to Google Drive for sync
- Export updates `lastBackedUpAt` timestamp
- Backup reminder system based on configurable intervals
- Materialising the ten default banks is housekeeping, not a user edit.
  `hasProfileChangedSince` filters those rows out with
  `isUntouchedDefaultBank`; without it every user is nagged to back up a
  profile they never touched, the first time they open the app after
  upgrading

## Important Implementation Notes

- Always check for `typeof window !== 'undefined'` before IndexedDB operations
- Audio context requires user interaction to start (handle suspended state)
- Keyboard shortcuts have precedence rules (bank switching > pad triggers)
- Edit mode uses visual indicators (amber borders, "EDIT MODE" banner)
- The service worker registers only in production builds, and in `next dev` it
  actively unregisters itself and drops its caches. Both matter: Turbopack
  moves chunk URLs on every edit, and a registration outlives the server that
  created it, so one `npm start` on port 3000 would otherwise serve stale
  chunks to `npm run dev` forever
- There is exactly one manifest, generated by `src/app/manifest.ts` and served
  at `/manifest.webmanifest`. A second hand-written `public/manifest.json` used
  to sit alongside it, linked from nowhere and naming two icons that did not
  exist. Do not add a static one back
- `scripts/generate-icons.js` produces the whole icon set from
  `public/icons/icon-512x512.png`. It is a manual step, not a build step, and
  its output is what is committed — so change the master and re-run it rather
  than editing individual PNGs
- Google Drive integration uses appData scope (hidden files, no quota impact)
- Server sync needs `IMPAMP_DB_PATH` and a persistent volume; the SSE bus is
  in-process, so the app must run as a single instance
- Hosted audio quota is charged from the size the _bucket_ reports at commit,
  never the size the client claimed — a presigned PUT signs only `host` and so
  cannot constrain the upload
- Once audio is hosted, the SQLite database and the bucket must be backed up
  and restored **together**; either one alone leaves dangling references
- All level arithmetic lives in `src/lib/audio/loudness/gain.ts`. The overview
  table and the playback path both call `resolveGain`; a second implementation
  would let the table disagree with what is heard
- Anything that writes an audio file and the pad naming it in **separate
  transactions** must run inside `withAudioImportInProgress` (`db.ts`), and both
  orphan sweeps must `await settleAudioImports()` as the **last** thing before
  they open their transaction. Between the two writes the audio exists with
  nothing referencing it, and `cleanupOrphanedAudioFiles` is entitled to delete
  exactly that — an import racing the cleanup button deterministically left a
  pad naming a sound that was gone. The ordering is load-bearing: work that
  registers _after_ the sweep's transaction exists is already serialised behind
  that scope, which is what closes the other half of the window. Two things this
  is not: a grace period cannot work, because every record carries the single
  `now` taken at the start of the import, so after a long download the first
  files are already older than any useful window; and one transaction spanning
  the import cannot exist, because IndexedDB commits as soon as the event loop
  turns with no request outstanding and the importer awaits a network download
  between writes. The register is in memory, so it is one tab wide
- `audioGainSettings` is keyed by audio file ID, and those IDs are remapped or
  copied in **five** places, not the three this used to name: `importExport.ts`,
  `googleDrive/dataAccess.ts`, `syncUtils.ts`, `db.ts`'s
  `duplicateProfileLocally` (which was missing them, so duplicating a profile
  silently dropped every gain setting) and `extractPadPlaybackSettings`, which
  is the helper the copying sites should all go through. Treat the list as a
  floor rather than a census: any new `Record<audioFileId, …>` field needs
  hunting for, or it silently attaches to the wrong sounds
- Gain resolution at trigger time is synchronous on purpose. The analysis cache
  is warmed on profile activation so the playback path never awaits a DB read
- A bank's identity is `bankId` and its position is `pageIndex`. Every
  database key, sync key, playback key and loading key uses `bankId`; only the
  tab order and the keyboard shortcut use `pageIndex`. A bank migrated from DB
  v6 takes `bankId = String(pageIndex)`, and so do the ten default banks
  `ensureDefaultBanks` writes — a **requirement, not a convenience**: both run
  per device against that device's own IndexedDB, so a random id would fork
  across a user's devices and sync would read one bank as several. A bank
  created afterwards is itself a synced event, so it gets
  `crypto.randomUUID()`. The order is normalised on read by
  `src/lib/bankOrder.ts` — sort by `(pageIndex, bankId)`, renumber densely
  from 0 — because `pageIndex` is an ordinary last-write-wins field and a
  merge can legitimately leave two banks on one position
- The bank tabs are `<button>`s, and `@hello-pangea/dnd` refuses any drag
  whose source event sits inside an interactive element — its
  `interactiveTagNames` includes `'button'` — so the `Draggable` in
  `BankTabStrip.tsx` must keep `disableInteractiveElementBlocking`. Without it
  no sensor starts a drag at all, and because dnd then never claims the key,
  Space, Escape and Enter reach the global handler and fade out all audio, hit
  the panic button, or fire an emergency cue. That is also why
  `useKeyboardListener` returns early on `event.defaultPrevented`: a global
  shortcut must not act on a key something nearer the target already claimed.
  Keep that a single guard — the same rule written three times is this repo's
  characteristic regression
- A pad owns a **base key**; each overlapping sound owns an **instance key**.
  A pad's first instance registers under the bare base key and later ones as
  `base#n`, where `n` grows and is never reused. Anything reading a playback
  key must go through `baseKeyOf` / `makeInstanceKey` / `layerIndexOf`
  (`src/lib/audio/types.ts`) rather than splitting the string itself:
  `baseKeyOf` splits at `lastIndexOf("#")` and only when the suffix is all
  digits, because an imported archive supplies its `bankId` unvalidated and a
  first-separator split would truncate the base key in the wrong place.
  `stopTrack` takes a base key and stops **every** layer — it is what ESC and
  the Active Tracks row call — while `stopInstance` stops exactly one.
  `stopTrack` also bumps the pad's stop generation and `stopInstance`
  deliberately does not: releasing one layer must not cancel a different layer
  of the same pad that is still loading
- Two invariants hold the layering together, and neither has a compiler behind
  it. `layersByBase` is written by `claimPlaybackKey` and `clearTrackState`
  only, because those are the only two places a track enters and leaves
  `activeTracks`; anywhere else and the two maps will disagree about what is
  playing. And there is one playback strategy cursor per **pad**, never per
  layer — `controls.ts` calls `getStrategy(playbackType, baseKey)`, and keying
  it by the instance key would hand each layer a fresh cursor, so a
  multi-sound layered pad would replay its first sound forever
- The `stopPropagation` on the Active Tracks layer-count button
  (`shared/PadTrackGroup.tsx`) is load-bearing. It was decorative while the
  button was a **sibling** of the row; the button now sits **inside** the row,
  so that one call is all that stands between expanding a group and silencing
  the pad mid-show. It has its own test — do not tidy it away

## Pinned Versions

Package versions live in **one** place: "Key package versions" above. There
used to be a second list here as well, and it had drifted — TypeScript 5 when
the repo is on 6, Playwright 1.4x when it is on 1.62, Prettier 3.8.1 when it is
on 3.9 — with the more authoritative-sounding heading carrying the wrong
answers. Two hand-maintained lists of the same facts will always drift, so this
one now covers only what is machine-checked.

- Node 24.19.0 (LTS) everywhere — `.node-version`, `mise.toml` and the
  `NODE_VERSION` ARG in **both** `Dockerfile` and `Dockerfile.dev`.
  `scripts/check_version_sync.sh` cross-checks the first three;
  `scripts/check_extra_dockerfiles.sh` covers every `Dockerfile*`, because the
  first script is a shared template that reads only one of them and
  `Dockerfile.dev` drifted to Node 22 unnoticed for months as a result.
  `node:sqlite` requires Node >= 22.13, so that is the floor
