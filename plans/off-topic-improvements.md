# Off-topic improvements

Things noticed while working on other tasks, deliberately left out of scope.
Each entry: what, where, why it matters.

## Tooling

- **`reuseExistingServer: true` + a rebuild is a footgun.** Running the suite
  twice in a row can leave `next start` serving a `.next` that a concurrent
  `npm run build` has replaced underneath it, which shows up as tests failing
  against code that is definitely present in the bundle. Worth a note in
  `e2e-tests/README.md`.
- **The edit-mode E2E suite is flaky under parallel load.** About two runs in
  five, one edit-mode test fails on a timeout in the 7-worker chromium run — a
  different test each time ("Can mark a bank as emergency", "Can rename pads in
  edit mode", "opens edit modal on Shift+click", "Armed track is visually
  indicated on the pad"). Measured on `d3ccd34` as well as on the server-sync
  branch, at the same rate, so it is not a regression from either. Run times
  also swing from 30 s to 1.2 min on the same machine, which points at
  contention rather than a specific test. Worth fixing the underlying race or
  capping workers for that file.
- **`npm start` contradicts `output: standalone`.** `next start` prints
  `"next start" does not work with "output: standalone" configuration`. It does
  currently serve, but both `npm start` and the Playwright config depend on a
  combination Next says is unsupported. Either drop `standalone` (the
  Dockerfile needs it) or point both at the standalone server.

## Dependencies

- **15 react-hooks findings are demoted to warnings, not fixed.**
  `eslint-config-next` 16 turns on the React Compiler-era rules, which flag
  long-standing patterns across the codebase. `eslint.config.mjs` sets the four
  new rules to `"warn"` so CI stays green on pre-existing code; promote each
  back to `"error"` as it is cleared.

  | Rule                                   | Sites                                                                                                                                                                                                                                         |
  | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `react-hooks/set-state-in-effect` (10) | `app/drive/open/page.tsx`, `AuthNotification.tsx`, `ClientSideInitializer.tsx`, `BulkImportModalContent.tsx`, `ProfileCard.tsx`, `ProfileManager.tsx`, `SharingPanel.tsx`, `useGoogleDriveSync.ts`, `usePadConfigurations.ts`, `useSearch.ts` |
  | `react-hooks/immutability` (2)         | `WaveformTrimmer.tsx`, `hooks/pad/usePadInteractions.ts`                                                                                                                                                                                      |
  | `react-hooks/refs` (2)                 | `WaveformTrimmer.tsx`, `useKeyboardListener.ts`                                                                                                                                                                                               |
  | `react-hooks/purity` (1)               | `ProfileCard.tsx`                                                                                                                                                                                                                             |

  `set-state-in-effect` is the one worth real attention: each site writes state
  during an effect, the pattern React Compiler refuses to optimise. That is a
  refactor of the audio/profile/sync paths, not a lint sweep.

- **Two upgrades are held back deliberately** — TypeScript 7 and ESLint 10, both
  blocked on lint tooling that has no compatible release yet. Reasons and retry
  conditions in `plans/deferred-upgrades.md`.

- **`@types/gapi` and `@types/google.picker` may be droppable.** No `gapi.` or
  `google.picker` reference survives in `src/` — the Drive picker is used via
  the `@googleworkspace/drive-picker-element` web component. They are _ambient_
  packages contributing globals rather than imports, though, so absence of
  import sites is not proof they are unused; read `src/types/drive-picker.d.ts`
  first. (`uuid`, `@types/uuid`, `jwt-decode` and
  `google-api-javascript-client` were removed on the same grounds — see Done.)

- **Node version pins disagree three ways:** `Dockerfile` runs `node:22-alpine`,
  CI uses `node-version: lts/*` (24), `mise.toml` says `node = "latest"` (26).
  `scripts/check_version_sync.sh` misses it because it only compares pins naming
  a concrete version. Node 22 is also the floor for `node:sqlite`, so the
  Dockerfile cannot go below it. Worth settling on one version everywhere.

## Code

- **`Checkbox` hard-codes an `emergency-checkbox` class** in
  `src/components/forms/Checkbox.tsx:52`, on every instance regardless of
  purpose. It exists only so `e2e-tests/edit-mode.spec.ts` can select the bank
  emergency toggle. Now that the pad editor has a checkbox too, the class is
  actively misleading. Switch that test to the `data-testid` the component
  already forwards and drop the class.
- **Duplicate edit-mode border rule** in `src/components/Pad.tsx` — the same
  `border-2 border-amber-500 ...` string is declared twice in the `clsx` call
  (once unconditionally on `isEditMode`, once gated on `isDropDisabled`).
- **`EditPadModalContent` fakes `FormModalRenderProps`** rather than using
  `useFormModal`, hard-coding `errors: {}` and `isSubmitting: false`. The pad
  editor therefore has no validation at all, and
  `src/examples/FormModalUsage.tsx` documents the intended pattern that is not
  actually used.
- **Uploads are not rolled back on cancel.** `EditPadForm.handleFileChange`
  calls `addAudioFile` immediately, so audio blobs are written to IndexedDB
  even if the user then cancels the modal.
- **Import defaults `playbackType` to `"sequential"`**
  (`src/lib/importExport.ts`) while every runtime path defaults to
  `"round-robin"`. An import silently changes the behaviour of pads whose
  playback type is missing.
- **`ClientSideInitializer` holds four separate store subscriptions** (auth,
  sync queue, edit mode, server-sync streams), each firing on _every_
  `useProfileStore` mutation and filtering afterwards. Consolidating them, or
  using selector-based subscriptions, would cut redundant work on every state
  change.

- **The profile selector button has no accessible name of its own.** It is
  labelled only by the active profile's name, so a name-based locator (or a
  screen-reader user) cannot tell it apart from a pad or armed-track button
  whose sound is named similarly — `createAndSwitchToProfile` in the E2E
  helpers has to match it by `aria-haspopup` instead.

## Docs

- **README structure fails the audit**: four `<h1>`s (should be exactly one)
  and no table of contents for a ~1300-word file.

## Done

- ~~`npm run lint` is broken (`next lint` removed in Next 16)~~ — fixed in
  `c4de6b7`, along with the two unused-import errors it had been hiding.
- ~~The e2e port is hard-coded to 3000~~ — fixed on main in `4508931`.
- ~~No unit-test layer at all~~ — Vitest added in `46c5046`.
- ~~`sharp` carried four libvips CVEs~~ — closed by the 0.35.3 upgrade;
  `npm audit` went from 7 high to 0.
- ~~Four dependencies with no import sites~~ — `uuid`, `@types/uuid` (a
  deprecated stub), `jwt-decode` and `google-api-javascript-client` (an
  abandoned v0.1.0 npm mirror) removed in the dependency-upgrade pass.
- ~~`clearAllArmedTracks` had no callers, so profile switches left stale
  cues armed~~ — wired into `setActiveProfileId`.
