# Off-topic improvements

Things noticed while working on other tasks, deliberately left out of scope.
Each entry: what, where, why it matters.

## Tooling

- **`wallaby.config.js` is still partly dead.** Vitest now exists (see
  `vitest.config.ts`), so the reference to it resolves, but `setup:` still
  requires `./test/setup`, which does not. Wallaby isn't in `devDependencies`
  and isn't run in CI; either wire up the setup file or delete the config. The
  server-sync work added an ESLint override for the file rather than rewriting
  a config for a tool we don't run.
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
- **Next.js infers the wrong workspace root.** Every build warns that it
  selected `/home/mick` as the root because of a stray `~/package-lock.json`.
  That is why `output: standalone` writes its server to
  `.next/standalone/Stack/Programmeren/impamp-2/…` rather than
  `.next/standalone/server.js`. Setting `outputFileTracingRoot` in
  `next.config.ts` would pin it and make the documented start command work.
- **`npm start` contradicts `output: standalone`.** `next start` prints
  `"next start" does not work with "output: standalone" configuration`. It does
  currently serve, but both `npm start` and the Playwright config depend on a
  combination Next says is unsupported. Either drop `standalone` (the
  Dockerfile needs it) or point both at the standalone server.

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

## Docs

- **README structure fails the audit**: four `<h1>`s (should be exactly one)
  and no table of contents for a ~1300-word file.

## Done

- ~~`npm run lint` is broken (`next lint` removed in Next 16)~~ — fixed in
  `c4de6b7`, along with the two unused-import errors it had been hiding.
- ~~The e2e port is hard-coded to 3000~~ — fixed on main in `4508931`.
- ~~No unit-test layer at all~~ — Vitest added in `46c5046`.
