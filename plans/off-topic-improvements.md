# Off-topic improvements

Things noticed while working on other tasks, deliberately left out of scope.
Each entry: what, where, why it matters.

## Tooling

- **`npm run lint` was broken; now it works, and it has a backlog.** `next lint`
  was removed in Next 16, so the script failed with `Invalid project directory
provided, no such directory: <repo>/lint` — while exiting 0, so it looked
  clean. The dependency-upgrade pass repointed it at `eslint .` and moved the
  ignore list `next lint` used to supply into `eslint.config.mjs`. CI and the hk
  pre-commit hook still don't run eslint, so nothing gates on the findings
  below.
- **17 ESLint errors + 5 warnings now surface.** Two sources: pre-existing
  errors, and the React Compiler-era `react-hooks` rules that arrived with
  `eslint-config-next` 16.

  | Rule                                   | Sites                                                                                                                                                                                                                                                                            |
  | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `react-hooks/set-state-in-effect` (10) | `app/drive/open/page.tsx:133`, `AuthNotification.tsx:137`, `ClientSideInitializer.tsx:55`, `BulkImportModalContent.tsx:68`, `ProfileCard.tsx:258`, `ProfileManager.tsx:288`, `SharingPanel.tsx:63`, `useGoogleDriveSync.ts:210`, `usePadConfigurations.ts:92`, `useSearch.ts:70` |
  | `react-hooks/immutability` (2)         | `WaveformTrimmer.tsx:151`, `hooks/pad/usePadInteractions.ts:265`                                                                                                                                                                                                                 |
  | `react-hooks/refs` (2)                 | `WaveformTrimmer.tsx:208`, `useKeyboardListener.ts:688`                                                                                                                                                                                                                          |
  | `react-hooks/purity` (1)               | `ProfileCard.tsx:495`                                                                                                                                                                                                                                                            |
  | `react-hooks/exhaustive-deps` (2)      | `ClientSideInitializer.tsx:249`, `usePadConfigurations.ts:89`                                                                                                                                                                                                                    |
  | `no-unused-vars` (3)                   | `e2e-tests/edit-mode.spec.ts:1` and `:14` (`Page`, `PlaybackType`), `wallaby.config.js:33`                                                                                                                                                                                       |
  | `no-require-imports` (2)               | `next.config.ts:4`, `wallaby.config.js:35`                                                                                                                                                                                                                                       |

  `set-state-in-effect` dominates and is the one worth real attention — each
  site writes state during an effect, the pattern React Compiler refuses to
  optimise. That is a refactor, not a lint sweep. The two `require()` errors are
  in config files that legitimately need CJS interop and probably want a scoped
  override in `eslint.config.mjs` instead. Clear these before wiring eslint into
  hk/CI, or every commit gets gated.

- **The e2e port is hard-coded to 3000** in `playwright.config.ts`, so the
  suite cannot run while a dev server occupies that port (common when working
  in a git worktree). Reading the port from an env var with a 3000 default
  would make parallel worktree runs possible. This bit the upgrade pass, which
  had to run against a hand-written copy of the config on another port.
- **`reuseExistingServer: true` + a rebuild is a footgun.** Running the suite
  twice in a row can leave `next start` serving a `.next` that a concurrent
  `npm run build` has replaced underneath it, which shows up as tests failing
  against code that is definitely present in the bundle. Worth a note in
  `e2e-tests/README.md`. Worse across worktrees: with a dev server on :3000
  from another checkout, the suite silently tests _that_ code instead.
- **The suite flakes under machine load.** With several worktrees building at
  once (load ~20 on 20 cores), a different spec times out on each full parallel
  run while passing 3/3 in isolation. `--workers=1 --retries=2`, which is what
  CI uses, is stable. Only relevant to local runs.
- **Stale vitest scaffolding.** `wallaby.config.js` references
  `./vitest.config.ts` and `./test/setup`, and `test-tsconfig.json` declares
  vitest/jest types — none of which exist. Either wire up vitest (there is no
  unit-test layer at all today, so all logic is covered only through
  Playwright) or delete the dead config.

## Dependencies

- **Unused dependencies — four removed, two still to judge.** Nothing in
  `src/`, `e2e-tests/` or `scripts/` imports any of these. Removed:
  `uuid`, `@types/uuid` (a deprecated stub — uuid has shipped its own types
  since v9), `jwt-decode`, and `google-api-javascript-client` (a long-abandoned
  npm mirror at v0.1.0, not Google's real client).

  Still declared, and a closer call because they are **ambient** type packages
  that contribute globals rather than imports: `@types/gapi` and
  `@types/google.picker`. No `gapi.` or `google.picker` reference survives in
  `src/` — the Drive picker is used via the
  `@googleworkspace/drive-picker-element` web component — so they look
  droppable, but `src/types/drive-picker.d.ts` hand-declares the web component's
  JSX types and is worth reading first in case it leans on them.

- **Node version pins disagree three ways:** `Dockerfile` runs `node:22-alpine`,
  CI uses `node-version: lts/*` (24), `mise.toml` says `node = "latest"` (26).
  `scripts/check_version_sync.sh` misses it because it only compares pins naming
  a concrete version. Worth settling on the current LTS everywhere.
- **Two upgrades are held back deliberately** — TypeScript 7 and ESLint 10, both
  blocked on lint tooling. Reasons and retry conditions in
  `plans/deferred-upgrades.md`.

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

## Docs

- **README structure fails the audit**: four `<h1>`s (should be exactly one)
  and no table of contents for a ~1300-word file.
