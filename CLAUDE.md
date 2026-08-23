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
- `npm run test:e2e` - Run the Playwright end-to-end suite on chromium, which
  is what CI gates on. Every `test:e2e*` script below is chromium too
- `npm run test:e2e:audio` - Run audio playback tests specifically
- `npm run test:e2e:profiles` - Run profile management tests
- `npm run test:e2e:edit` - Run edit mode tests
- `npm run test:e2e:keyboard` - Run keyboard shortcut tests
- `npm run test:e2e:loudness` - Run loudness and gain tests
- `npm run test:e2e:portrait` - Run the one portrait-layout spec on a Pixel 7.
  The only `test:e2e*` script that is not chromium-the-project, though it is
  still the chromium binary. CI names this project alongside `chromium`
- `npm run test:e2e:debug` - Run tests in debug mode
- `npm run test:e2e:cross-browser` - Run firefox and webkit, on demand only.
  Both are known-red for reasons outside the app; read
  `docs/cross-browser-e2e.md` before acting on a failure

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
- **Icons** - every glyph is a component in `src/components/icons/`, each of
  them `Icon.tsx` plus its own path data, and `Icon` is the only `<svg>` in the
  application. Size and colour arrive as `className`; the stroke weight and
  line caps come from the paint table rather than from attributes repeated on
  each `<path>`; and an icon is `aria-hidden` unless it is given a `title`,
  which exactly one of them is. There is deliberately **no icon library**:
  `lucide-react` tree-shakes to about 1.8 KB gzipped for this many glyphs, so
  the objection is not size — it is that these glyphs are Heroicons, Bootstrap
  Icons, Feather and the Google brand mark, so adopting one would restyle every
  icon in a deployed application, and lucide has no brand icons, so the Google
  "G" would keep this directory alive anyway. There is also deliberately **no
  barrel**: an `index.ts` re-exporting all twenty put all twenty into a chunk
  every route loads, measured at +5 KB raw on `/_not-found`, which renders none
  of them. Import each glyph from its own module

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
- **Audio deduplication** - every inbound path writes through
  `addOrReuseAudioFile`, which returns `{ id, reused }` and hands back the row
  already holding the same bytes. Identity is the SHA-256 of the blob and
  nothing else, so two files differing only in name or type _do_ collapse —
  everything perceptible (trim, gain, display name) lives on the
  `PadConfiguration`. Three consequences keep catching people. Reuse **writes
  nothing**, so a caller needing `driveFileIds` or `serverHosted` on the row it
  got back must backfill them itself. A supplied hash is **trusted, not
  verified**, which is exactly what lets an archive reuse a sound before
  extracting its bytes, and is why a colliding hash cannot be defended against.
  And rows are now shared **across profiles** (`audioFiles` has no
  `profileId`), which makes `deleteProfile`'s cross-profile keep and the
  `reused` flag load-bearing rather than incidental: the flag is the only thing
  standing between an import rollback and deleting audio another profile
  depends on. Do not fold reuse into `addAudioFile` — it has no production
  callers left and survives as the one writer that can still make a duplicate,
  which the dedup tests need. `src/lib/audioDedup.ts` collapses the duplicates
  already in a library, behind a preview and a confirmation
- **Offline / PWA** - `public/sw.js` caches the app shell so the board runs
  with no network; registered from `src/lib/serviceWorker/register.ts`, and in
  production builds only. The precache list is derived at install by walking
  the asset graph out from the live HTML, so there is no list to keep in step.
  Nothing under `/api` is cached, and updates never apply to a running page.
  See `docs/offline-pwa.md`

### Import/Export System

Multi-format support in `src/lib/importExport.ts` and `src/lib/bankTransfer.ts`:

- V2 format supports multi-sound pads with playback strategies
- V1 legacy format migration from ImpAmp2
- Multi-profile export/import functionality
- `exportVersion: 3` is a profile archive, `exportVersion: 4` a bank archive.
  Both are `.iaz`, and `readArchiveManifest` is the only place that decides
  which a given file is. One bank archive holds N banks and **one shared
  `audio/` folder**, so five banks naming the same sound carry its bytes once
- **Subtractive export, whitelist import — that way round on purpose.** The
  export copies the stored row and deletes the seven fields named in
  `ROW_FIELDS_NOT_EXPORTED`, so a field added to `PadConfiguration` later
  travels by default. The import goes back through `extractPadPlaybackSettings`,
  a `Pick`, so `id`, `profileId`, `bankId` and a foreign device's sync stamps
  cannot ride in. Reversing either half is a silent data bug: a whitelist
  export drops the next `Record<audioFileId, …>` field the way both a plan and
  a brief already dropped `audioTrimSettings`, and a spread import writes an
  archive's own row id straight into `store.add`
- **`sourceBankId` is a comparison key and is never adopted.** It is matched
  against the ids the destination profile already holds, so the dialog can
  offer "replace that bank"; an `add` mints its own id and a `replace` takes
  the destination's. It is deliberately **not** sanitised, because a cleaned
  id _looks_ adoptable — the fixtures use `"raid#7"`, the exact string that
  would break `baseKeyOf`'s playback-key parsing. No type can enforce this (a
  branded string is still assignable to `string`), so it is held by four
  separate structural means that `writeBankIntoProfile`'s comment enumerates
- **A bank import is all-or-nothing across the whole selection.** Capacity is
  checked for every bank before the first write, and one failure restores every
  bank the run touched. Half-applied is not an option: a `replace` has already
  emptied a bank the user still has, and re-running after a partial success
  mints fresh ids, so every bank that _did_ land is duplicated

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

Two upgrades are deliberately held back, with the reasons and retry conditions
in `plans/deferred-upgrades.md`: **TypeScript 7** (typescript-eslint refuses the
TS 7 API) and **ESLint 10** (eslint-plugin-react has no ESLint 10 release). They
are also the two `.github/dependabot.yml` ignores, and the ignores are scoped to
majors, so a TypeScript 6 or ESLint 9 patch is still fair game.

**The rule is those names, not a count.** This paragraph used to end "if you see
three outdated packages, none of them is fair game", which read as a standing
instruction to leave everything alone — and by the time anyone checked,
`npm outdated` had ten rows, seven of them ordinary in-range patches nobody had
taken, including a Next.js one. A rule stated as a count goes stale the moment
the count changes, so: anything `npm outdated` lists that is not a TypeScript or
ESLint major is fair game, and the count is whatever it happens to be today.

Two things to check before taking one, both learned the hard way on 2026-08-22.
Read the release notes even for a patch — react-dropzone 20.1.1 was a docs fix
that also swapped `file-selector` from `^4.1.0` to `^5.0.0`, which silently
forked a dependency `Pad.tsx` hands data across. And `npm update` is the tool,
not `npm install pkg@version`: the latter rewrites the range in `package.json`,
and the ranges are floors that should move only when something requires it.

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
  another file's behalf), `loudnessPipelineStub.ts`, `legacyDatabase.ts`,
  `browserGlobals.ts`, `zipArchive.ts`, `reactPanel.tsx`,
  `httpClientHarness.ts` (the `Response` stand-in and the fetch spy both API
  clients' suites need), `quietConsole.ts` or `audioFixtures.ts` before
  writing a third
- **A suite that writes an audio row must call `stubLoudnessPipeline()`**,
  unless it mocks `@/lib/db` wholesale or is one of the two suites testing the
  pipeline itself. `addAudioFile` and `addOrReuseAudioFile` fire
  `startBackgroundAnalysis` without awaiting it; in node that rejects and
  db.ts logs the rejection _after_ the test file has finished, which under
  `--coverage` tears the worker down with
  `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`.
  Measured at two failing runs in three before the stub and zero in five
  after. The suite stays green and the **command exits 1**, so it reads as
  your change breaking everything; and because it is timing, one passing run
  is no evidence at all
- **A new assertion is worth only what a mutation of the source can prove.**
  Every suite added by the coverage sweep was checked by breaking the thing it
  claims to hold and confirming the suite goes red, and that found four
  assertions that looked right and tested nothing. The instances are worth
  knowing because each is a _shape_, not a one-off: a caller with its own
  rescue for the condition under test (`findDriveFileById` catches any message
  containing "404", so it answers `null` whether or not `authenticatedRequest`
  has a 404 branch at all — assert through a caller that has no rescue); a
  second copy of the rule elsewhere (`fadeOutAllTracks`'s `isFading` check,
  and the trimmer's explicit stop of its previous preview, both redundant with
  something else that already does it); a stand-in registered in the wrong
  event phase (a capture-phase fake panic button beats `useEscapeToClose` on
  registration order, where the real bubble-phase one does not, so the test
  measured the order rather than the guard); and a React handler read in the
  same tick as the state it closes over (a `pointermove` dispatched
  immediately after `pointerdown` still sees `dragging === null`, so the drag
  test passed whatever the drag logic did). Where the mutation survives for a
  reason worth recording rather than fixing, the finding goes to
  `plans/off-topic-improvements.md` and the test carries a comment pointing
  at it
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
- E2E audio fixtures are only distinct if the generator makes them so.
  `createTestAudioFilePath` pitches its sine wave from an FNV-1a hash of the
  file name, and `assertDistinct` refuses to hand identical bytes out under two
  names. Before that the waveform came from the duration alone, so every
  "distinct" fixture in the suite was byte-identical — and once audio rows are
  reused by content hash, a spec called "Sequential mode plays sounds in order"
  is asserting on a pad holding **one** row listed three times. It was equally
  untrue before dedup for anything comparing content; dedup only made it
  visible. A fixture needing two different sounds should also assert they got
  different ids
- **Every `test:e2e*` script names a project, and that is not decoration.**
  All but one name `--project=chromium`; `test:e2e:portrait` names
  `--project=mobile-portrait`, which is the same browser binary on a Pixel 7.
  `test:e2e` used to be a bare `playwright test`, which runs
  firefox and webkit as well — both known-red below — so it exited 1 on a
  perfectly good tree, and the html reporter swallowed the stdout that would
  have said why. It looked exactly like your change breaking everything, and
  the README sent every new contributor straight into it. The `line` reporter
  in `playwright.config.ts` is the other half of that fix. Firefox and webkit
  now live behind `npm run test:e2e:cross-browser`, which is the only script
  that runs anything but chromium
- `activatePad` returns **immediately if anything at all is playing**: its poll
  opens `if (await nothingPlaying.isHidden()) return true;`, so a sound left
  running by an earlier call lets the next call through **without pressing the
  pad it was handed**, which then fails on a progress bar it never triggered.
  Any spec activating a second pad must silence the first
- E2E gates on the **chromium binary only**, in two projects: the desktop
  suite and `mobile-portrait`. That second one is a lesson rather than a
  detail — it was declared in `playwright.config.ts`, `testIgnore`d out of all
  three browser projects, and then selected by no npm script and no CI job, so
  the portrait layout's only coverage never ran anywhere from the day it was
  written. A project is not a gate until something names it.
  Firefox and WebKit are **on demand only** —
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

- Each profile is isolated in everything **except audio bytes**. This used to
  read "completely isolated" and stopped being true when audio started being
  reused by content hash: `audioFiles` rows carry no `profileId`, so one row is
  routinely named by pads in several profiles. Any code that deletes an audio
  row must ask whether something else still references it —
  `deleteUnreferencedAudioFiles`, never `deleteAudioFile`
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
  transactions** must run inside `withAudioImportInProgress`
  (`src/lib/audioImportRegister.ts`, re-exported from `db.ts` so every existing
  import still resolves — new code should import from the register), and
  **every deleter of audio rows must `await settleAudioImports()` as the last
  thing before it opens its transaction, and must not be called from inside
  `withAudioImportInProgress`.** That is one sentence with no exceptions,
  **ten writers and five deleters**, and it is a two-sided rule where sweeping
  one side is worth nothing: the 2026-08-22 rework added the wait to every
  deleter and declared no writer, and a deleter waits for what is in the
  register, so six writers were still walking through the window it was
  written to close. The deleters are `deleteProfile`,
  `deleteUnreferencedAudioFiles`, the two orphan sweeps and
  `collapseDuplicateAudioGroups`. The writers are `importProfileCore`,
  `writeBankIntoProfile`, `syncProfile`, `syncServerProfile`,
  `applyConflictResolution`, `applyServerConflictResolution`,
  `replaceMissingAudioFile`, the drop handler (`usePadDrop`) and the bulk
  importer (`BulkImportModalContent`) — and the pad editor, which is the tenth
  and cannot use the wrapper at all. It writes a sound's row when the file is
  picked and the pad naming it on Save, so its window is not two transactions a
  turn apart but two user actions minutes apart; `EditPadModalContent` holds
  `beginAudioImport()` from mount to unmount instead, releasing it in the same
  synchronous block as its own discard. Two things follow. **A scope must
  never contain another** — see `plans/off-topic-improvements.md`, and note
  that it is why the two conflict-resolution entry points declare themselves
  rather than the `updateLocalData` they share with the two sync runs, which
  are declared already. And a writer that has been handed a row but not yet
  named it must be **found by grepping the callers of `addOrReuseAudioFile`**,
  which is where all seven live; there is no type and no lint rule behind any
  of this. The second half is why a
  failed profile import carries its profile id and created audio ids out on a
  `FailedProfileImport` and rolls back one line past the scope
  (`importProfileCore`) — a deleter waiting from inside a scope waits for the
  import that is waiting for it, and hangs rather than fails.
  `deleteUnreferencedAudioFiles` used to be a documented exception, on the
  grounds that it only considers ids its own caller just created. Reuse by
  content hash ended that and nobody noticed: `addOrReuseAudioFile` hands back
  rows that already existed, so a "provisional" id in the pad editor, or a
  "created" id in an import's rollback, is routinely a row another import is
  mid-flight on. It and `deleteProfile` were both measured deleting such a row
  and leaving a pad naming nothing (`db.importRace.test.ts`).
  `settleAudioImports` is exported because the rule is repo-wide; it was
  private, and the one deleter written outside `db.ts` shipped without the
  guard because there was no way to reach it. Between the two writes the audio
  exists with nothing referencing it, and `cleanupOrphanedAudioFiles` is
  entitled to delete exactly that — an import racing the cleanup button
  deterministically left a pad naming a sound that was gone. The ordering is
  load-bearing: work that registers _after_ the sweep's transaction exists is
  already serialised behind that scope, which is what closes the other half of
  the window. Two things this is not: a grace period cannot work, because
  every record carries the single `now` taken at the start of the import, so
  after a long download the first
  files are already older than any useful window; and one transaction spanning
  the import cannot exist, because IndexedDB commits as soon as the event loop
  turns with no request outstanding and the importer awaits a network download
  between writes. The register is in memory, so it is one tab wide
- **A rule with two sides is only fixed when both sides are swept.** This is
  the repo's third named regression shape, alongside "the same rule written
  twice" and "a fix took the data and left the guard", and on 2026-08-22 it
  produced every red finding of a review in one day — twice with the second
  bug made reachable by the fix immediately before it. The instances:
  `settleAudioImports` was given to all five _deleters_ and no _writer_, so
  three sites still wrote audio and its pad in two transactions undeclared;
  `reindexProfileAudio` protected rows that _survive_ a write and not the
  delete-and-reinsert path, so an owner's two ordinary saves re-attributed a
  collaborator's sound to themselves permanently; and the uncommitted-object
  sweep gained a scan cap without a continuation token, so it could never look
  past the first 1000 keys. Each fix was verified against its own headline
  claim and each was incomplete. **When you fix one side of a rule, name the
  other side out loud and check it before you claim the fix** — "deleters
  wait" implies "writers declare", "rows that stay are protected" implies
  "rows that leave and return", "scan a bounded number" implies "resume where
  you stopped"
- **A missing or empty hash must mean "no match", never "any match".**
  `index.getAll(key)` returns **every row in the store** when `key` is
  `undefined` — and also when it is an object, measured rather than assumed:
  `getAll({ not: "one" })` over two rows hands back both. So an unguarded
  lookup neither throws nor comes back empty; it silently answers with an
  arbitrary unrelated sound. That shape has now been found three times on one
  branch: `findAudioFileIdByHashIn`'s `if (!hash) return undefined`,
  `addOrReuseAudioFile` using `||` rather than `??` so `""` counts as absent
  instead of becoming a key every later hashless file collapses onto, and the
  `typeof ref.hash === "string"` guard on the bank-import path, where removing
  it made an archive's sound play as the destination profile's own. A declared
  `string` is a type, not a runtime fact, and an archive supplies its hashes
  unvalidated
- **One pad can name one audio row twice** — add the same file to a pad twice,
  or import a bank back into the profile it came from — so anything keyed on
  `fileId` alone collides. `EditPadForm` mints one `rowId` of
  `${fileId}-${occurrence}` per row and derives the dnd id, all four test ids
  and the remove handler from it. This has shipped wrong twice: once as the
  drag id (duplicate React keys, and removing one copy removed both), and again
  when that was fixed and the four neighbours one line away were left behind.
  Both halves are now pinned twice over: `EditPadForm.dedup.test.tsx` counts
  the matches in jsdom, and `e2e-tests/pad-editor-duplicate-rows.spec.ts`
  builds the pad in a browser and drives each copy's own controls — a
  collision there is a Playwright strict-mode violation, which is the failure
  no unit test can produce. That spec was missing for a release, and it is why
  a duplicate id could sit in the tree unseen: no other spec ever builds a pad
  naming one sound twice.
  `audioGainSettings` and `audioTrimSettings` stay keyed on `fileId`
  deliberately, because two copies of one row genuinely share one gain and one
  trim
- **The pad editor's sound list is a projection, not a place to append.**
  `EditPadForm` turns `values.audioFileIds` into rows with one sequential
  `await getAudioFile(id)`, and the Add Sounds input is live for the whole of
  that read — the list only says "Loading sounds…". `handleFileChange`
  therefore appended to `sounds` and wrote the result back, which inside that
  window is `[...[], ...newSounds]`: every sound the pad already had, dropped,
  with nothing on screen admitting it because the list is then rebuilt from
  the ids that were just truncated. Append to the ids through `setValues`'s
  updater form and let the effect rebuild the rows. `values` is no safer than
  `sounds` here — by the time the handler writes it has awaited a content
  hash, a database write and a name read — which is why
  `FormModalRenderProps.setValues` is React's own
  `Dispatch<SetStateAction<T>>`. The drag and the remove button may keep
  reading `sounds`, because both need a row on screen and `isLoadingNames`
  hides the list while a load is in flight. The window is disk-bound, so it
  opens under ten parallel e2e workers and essentially never on an idle
  machine: it cost the chromium gate two intermittent failures that each
  passed 4 of 4 in isolation, and `EditPadForm.loadRace.test.tsx` gates it by
  holding `getAudioFile` behind a gate rather than by racing anything
- `audioGainSettings` is keyed by audio file ID, and `audioTrimSettings` is the
  second field of that shape — missed by a plan and a brief in turn, which is
  the hazard in miniature. Those IDs are remapped or copied in **seven** places,
  not the three this used to name: `importExport.ts`,
  `googleDrive/dataAccess.ts`, `syncUtils.ts`, `db.ts`'s
  `duplicateProfileLocally` (which was missing them, so duplicating a profile
  silently dropped every gain setting), `extractPadPlaybackSettings` (the
  helper the copying sites should all go through), `audioDedup.ts`'s
  `collapseDuplicateAudioGroups` and `bankTransfer.ts`'s bank writer. The last
  two go through `remapAudioFileIdKeys` in opposite modes, and both are right:
  **keep** for the collapse, because an id in no duplicate group is untouched
  and "drop" there would delete every setting on every pad it rewrote; **drop**
  for an import, because a setting keyed on an id the archive never delivered
  must not survive. Treat the list as a floor rather than a census: any new
  `Record<audioFileId, …>` field needs hunting for, or it silently attaches to
  the wrong sounds
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
  `scripts/check_version_sync.sh` cross-checks all four. It reads every
  `Dockerfile*` as of dev-env standard v24; before that it stopped at the
  first, which is how `Dockerfile.dev` drifted to Node 22 unnoticed for
  months, and this repo carried a second script to cover the gap. That
  script is gone — two gates for one rule is how they drift. The hk step's
  glob is deliberately `Dockerfile*` rather than the template's `Dockerfile`,
  so editing only the dev image still fires it.
  `node:sqlite` requires Node >= 22.13, so that is the floor
