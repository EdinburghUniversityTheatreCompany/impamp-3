# Off-topic improvements

Things noticed while working on other tasks, deliberately left out of scope.
Each entry: what, where, why it matters.

## Tooling

- **`npm run lint` is broken.** `next lint` was removed in Next 16, so the
  script fails with `Invalid project directory provided, no such directory:
<repo>/lint`. `npx eslint src e2e-tests` works. Fix the script (and check
  whether CI is silently passing a no-op lint step).
- **Two pre-existing ESLint errors** in `e2e-tests/edit-mode.spec.ts:1` and
  `:14` — unused `Page` and `PlaybackType` imports.
- **The e2e port is hard-coded to 3000** in `playwright.config.ts`, so the
  suite cannot run while a dev server occupies that port (common when working
  in a git worktree). Reading the port from an env var with a 3000 default
  would make parallel worktree runs possible.
- **`reuseExistingServer: true` + a rebuild is a footgun.** Running the suite
  twice in a row can leave `next start` serving a `.next` that a concurrent
  `npm run build` has replaced underneath it, which shows up as tests failing
  against code that is definitely present in the bundle. Worth a note in
  `e2e-tests/README.md`.
- **Stale vitest scaffolding.** `wallaby.config.js` references
  `./vitest.config.ts` and `./test/setup`, and `test-tsconfig.json` declares
  vitest/jest types — none of which exist. Either wire up vitest (there is no
  unit-test layer at all today, so all logic is covered only through
  Playwright) or delete the dead config.

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
