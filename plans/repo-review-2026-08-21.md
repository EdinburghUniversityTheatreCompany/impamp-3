# Whole-repo review — 2026-08-21

A third whole-repo review, four days after
[`repo-review-2026-08-17.md`](repo-review-2026-08-17.md) and **145 commits**
after it. `.claude/current_plan.md` records that the 08-17 report is fully
answered and that those 145 commits have never been reviewed — this report is
weighted accordingly: the older, settled code got detection sweeps, and the
reading budget went to what landed since.

Every finding below cites a command output, a `file:line`, or a runtime probe.
Two were proved by writing a throwaway test, running it, and reading what it
printed; both probes are quoted in place.

## Gates, measured today

| Gate                         | Result                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm test`                   | **1409 passed** / 143 files, exit 0                                                                     |
| `npm run test:coverage`      | **intermittently exit 1** — see 🔴 2. 59.34 / 51.01 / 56.62 / 60.16 against a 58 / 49 / 55 / 59 ratchet |
| `npm run typecheck`          | clean                                                                                                   |
| `npm run lint`               | clean                                                                                                   |
| chromium e2e                 | **189 passed**, exit 0, no retries (`E2E_PORT=3141`)                                                    |
| `npm audit` (prod + dev)     | 0 vulnerabilities                                                                                       |
| jscpd                        | 0 clones, 0.0 %                                                                                         |
| `check_version_sync.sh`      | clean — node 24.19.0 across all four places                                                             |
| `check_extra_dockerfiles.sh` | clean                                                                                                   |
| Action pins                  | every `uses:` SHA-pinned, `permissions: contents: read` default, no `pull_request_target`               |
| Tech-debt markers            | **zero** `TODO`/`FIXME`/`HACK`/`XXX` in `src`, `e2e-tests`, `scripts`                                   |

---

## 🔴 High

### 🔴 1. The duplicate-audio collapse deletes a row an in-flight import is holding

- **Where:** [src/lib/audioDedup.ts:351-364](src/lib/audioDedup.ts#L351-L364), against [src/lib/db.ts:1291](src/lib/db.ts#L1291) (`withAudioImportInProgress`) and [src/lib/db.ts:1315](src/lib/db.ts#L1315) (`settleAudioImports`).
- **Finding:** CLAUDE.md states the rule for this exact hazard — _"both orphan
  sweeps must `await settleAudioImports()` as the **last** thing before they
  open their transaction"_ — and both sweeps do
  ([db.ts:1331](src/lib/db.ts#L1331), [db.ts:1389](src/lib/db.ts#L1389)).
  `collapseDuplicateAudioGroups`, a **third** deleter added on 2026-08-21,
  does not. It deletes rows it did not create, so the scope argument that
  makes `deleteUnreferencedAudioFiles` safe does not cover it.

  The window is reachable because two independent choices disagree about
  _which_ of a duplicate pair is the keeper:

  - `addOrReuseAudioFile` hands a reusing caller the **lowest id** for the hash
    (`findAudioFileIdByHashIn` → `matches.find(f => f.id !== undefined)`, and
    `index.getAll` returns equal keys in primary-key order).
  - the collapse elects the canonical as **analysed first, then lowest id**
    ([audioDedup.ts:126-129](src/lib/audioDedup.ts#L126-L129)).

  They differ exactly when a higher-id duplicate carries a loudness analysis
  and the lowest-id one does not — which is ordinary, since analysis is
  background and best-effort (`loadPipeline.ts`'s own docstring records 14 of
  40 files losing their analysis before it was memoised).

- **Evidence — reproduced, not inferred.** A probe — saved at
  [`plans/review-2026-08-21/dedup-race-probe.md`](review-2026-08-21/dedup-race-probe.md) —
  writes two byte-identical
  rows where the higher id is analysed, starts an import inside
  `withAudioImportInProgress` that reuses a row and then awaits before writing
  its pad, and runs the collapse in the gap:

  ```
  canonicalElected:      2
  lowerId:               1     higherId: 2
  idTheImportReused:     1
  removedFiles:          1
  rowsLeft:              [2]
  padPointsAt:           [1]
  padPointsAtALiveRow:   false     ← the pad names a deleted audio row
  ```

- **Impact:** A background sync downloading audio (both `useServerSync` and
  `useGoogleDriveSync` are mounted app-wide by `ClientSideInitializer`, and the
  profile manager is a modal over the live board) while the user presses
  **Remove duplicates** in the Maintenance tab leaves pads naming audio rows
  that no longer exist. The pad still renders; it is simply silent. Nothing
  reports it, and the panel's only guard is `busy = isScanning || isCollapsing`
  ([DuplicateAudioPanel.tsx:66](src/components/profiles/DuplicateAudioPanel.tsx#L66)),
  which knows nothing about imports.
- **Fix:** Export `settleAudioImports` from `db.ts` and `await` it as the last
  statement before `collapseDuplicateAudioGroups` opens its transaction
  ([audioDedup.ts:257](src/lib/audioDedup.ts#L257)) — the ordering is
  load-bearing for the reason db.ts:1305-1314 already spells out. Optionally
  also align the canonical election with `addOrReuseAudioFile`'s reuse choice,
  which narrows the window independently. The probe above is the regression
  test: it fails against the current commit. → this repo, then `/code-review`
  on the fix.
- **Shape:** this is the recorded `fixes-take-data-leave-guard` /
  `sync-bugs-are-duplicated-rules` pattern again, one level up — a new
  _deleter_ adopted without the invariant that makes deleters safe. That the
  guard is module-private is what let it happen quietly (🟡 6).

### 🔴 2. `npm run test:coverage` intermittently exits 1 while all 1409 tests pass

- **Where:** [src/lib/db.ts:738-751](src/lib/db.ts#L738-L751) (`startBackgroundAnalysis`), surfacing from `src/lib/importExport.zip.test.ts`.
- **Finding:** Reproduced 2 of 3 consecutive runs:

  ```
  cov1 exit=1  teardownErrs=15
  cov2 exit=0  teardownErrs=0
  ```

  All 15 read `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog"
was pending`, all attributed to `importExport.zip.test.ts`. Without
  `--coverage` the same suite is 0 for 0 across a full run. `addAudioFile` and
  `addOrReuseAudioFile` fire `startBackgroundAnalysis` without awaiting; in
  node there is no Web Audio, so the pipeline rejects and `console.warn`s
  **after** the test file has finished, and the worker is torn down mid-log.

- **Impact:** CI runs `test:coverage` as its own step, so this reddens a build
  on a green suite — the most expensive kind of failure, because the natural
  reading is "my change broke something". `.claude/current_plan.md` lists it as
  open with "frequency unknown"; it is roughly two runs in three here.
- **Fix:** Add the `vi.doMock("@/lib/audio/loudness/pipeline", …)` stub that
  `audioDedup.test.ts:33` already uses to the **11** suites that write audio
  without it:

  ```
  importExport.zip · importExport.dedup · importExport.hostedAudio
  db.hashlessIndex · db.orphanCleanup
  googleDrive/sync.hashVerification · googleDrive/sync.downloadDedup
  googleDrive/dataAccess.gain · googleDrive/dataAccess.hashKeyed
  serverAudio/transfer · serverAudio/transfer.downloadDedup
  ```

  (`loudness/pipeline.test.ts` and `loudness/loadPipeline.test.ts` legitimately
  exercise the real thing.) A shared helper in `src/lib/testSupport/` would
  keep the twelfth suite from being written without it — the jscpd-at-0 gate
  will ask for that anyway.

---

## 🟡 Medium

### 🟡 3. Every `RadioGroup` has no accessible name, and its visible label points at nothing

- **Where:** [src/components/forms/RadioGroup.tsx:60](src/components/forms/RadioGroup.tsx#L60) and [src/components/forms/FormField.tsx:29](src/components/forms/FormField.tsx#L29).
- **Finding:** `RadioGroup` sets `aria-labelledby={`${id}-label`}`, and no
  element with that id is rendered — by the component or by any of its four
  callers (`grep -rn 'id={`\${.*}-label`}' src` returns nothing). Separately,
  `FormField` renders `<label htmlFor={id}>` while `RadioGroup` puts `id` on
  nothing — the inputs get `${id}-${option.value}`.
- **Evidence — runtime probe**, rendering `FormField id="playbackType"` around
  `RadioGroup id="playbackType"`:

  ```
  label[for=playbackType] exists:      true
  element with id=playbackType exists: false
  radiogroup aria-labelledby:          "playbackType-label"
  element with that id exists:         false
  ```

  Rendered HTML confirms it: `<label for="playbackType">Playback Mode</label>`
  followed by `<div role="radiogroup" aria-labelledby="playbackType-label">`.

- **Impact:** Four controls announce as an unnamed "group": **Playback Mode**
  and **When already playing** ([EditPadForm.tsx:339,360](src/components/modals/EditPadForm.tsx#L339)),
  the sync-type chooser ([ProfileEditForm.tsx:78](src/components/profiles/ProfileEditForm.tsx#L78))
  and the profile-wide retrigger behaviour
  ([PlaybackSettingsForm.tsx:57](src/components/settings/PlaybackSettingsForm.tsx#L57)).
  Clicking the visible label also does nothing, because it points at no
  control. This is the one open item from the 08-17 accessibility sweep — the
  rest of that axis (Modal `role="dialog"` + focus trap + restore,
  `ErrorBoundary`, `PlaybackAnnouncer`'s live region, Tab reaching the chrome)
  is all now in place and verified.
- **Fix:** One line: give `FormField`'s `<label>` `id={`${id}-label`}`. That
  satisfies the `aria-labelledby` and leaves `htmlFor` harmlessly redundant —
  or drop `htmlFor` for the radiogroup case. While there,
  `option.description` ([RadioGroup.tsx:90-94](src/components/forms/RadioGroup.tsx#L90-L94))
  is rendered next to each input with no `aria-describedby`, so it is never
  announced. → [[accessibility]].

### 🟡 4. CLAUDE.md's dependency rule is now false, and it tells the next agent to do nothing

- **Where:** CLAUDE.md, "Key package versions"; `.github/dependabot.yml`.
- **Finding:** CLAUDE.md says _"These are exactly the three `npm outdated`
  reports, and exactly the three `.github/dependabot.yml` ignores — if you see
  three outdated packages, none of them is fair game."_ `npm outdated` today
  returns **ten** rows, seven of which are ordinary in-range patch bumps:

  ```
  @next/bundle-analyzer  16.3.1 → 16.3.2      next            16.3.1 → 16.3.2
  eslint-config-next     16.3.1 → 16.3.2      vitest          4.1.10 → 4.1.11
  @vitest/coverage-v8    4.1.10 → 4.1.11      react-dropzone  20.1.0 → 20.1.1
  @zip.js/zip.js         2.8.51 → 2.8.55
  ```

  Dependabot only ignores **majors** for typescript / eslint / file-selector,
  so it would propose all seven. The three genuine deferrals
  (`plans/deferred-upgrades.md`) are still correctly held.

- **Impact:** The sentence reads as a standing instruction not to touch
  anything, so a pending Next.js patch (the kind that carries security fixes)
  sits unbumped and unexamined. A rule stated as a count goes stale the moment
  the count changes.
- **Fix:** Restate it by _identity_ rather than by count — "typescript, eslint
  and file-selector majors are deferred; everything else `npm outdated` shows
  is fair game" — and land the seven patch bumps. → [[dependency-upgrade]].

### 🟡 5. The README tells you to run the one e2e command CLAUDE.md says never to run

- **Where:** [README.md:85](README.md#L85); [package.json](package.json) `"test:e2e": "playwright test"`; [playwright.config.ts:65-71](playwright.config.ts#L65-L71).
- **Finding:** The README's "Run the tests" step says `npm run test:e2e`. That
  is a bare `playwright test`, and the config declares chromium, firefox **and**
  webkit as default projects. CLAUDE.md is explicit about the consequence:
  _"it runs firefox and webkit as well — both known-red below — exits 1, and
  lets the html reporter swallow stdout. It looks exactly like your change
  breaking everything. Use `npx playwright test --project=chromium
--reporter=line`."_
- **Impact:** The documented onboarding path produces a long red run for
  reasons unrelated to the reader's change, and the guidance that explains it
  lives in a file the README never points at. Two copies of the same fact, one
  of them wrong — the failure mode this repo names as characteristic.
- **Fix:** Make `test:e2e` chromium-only and add `test:e2e:cross-browser` for
  the on-demand run, so the default command matches what CI gates on; then the
  README needs no caveat at all.

### 🟡 6. `settleAudioImports` is module-private, so a repo-wide invariant cannot be adopted

- **Where:** [src/lib/db.ts:1315](src/lib/db.ts#L1315) — `async function settleAudioImports()`, no `export`.
- **Finding:** CLAUDE.md states the rule for **every** audio deleter, but the
  primitive that satisfies it is reachable only from inside `db.ts`. Its two
  in-file callers comply; the one deleter written outside `db.ts`
  (`audioDedup.ts`) does not, and could not have without editing `db.ts` first.
- **Impact:** This is the structural cause of 🔴 1, and it will be the cause of
  the next one. Any future deleter outside `db.ts` faces the same wall.
- **Fix:** Export it, and say in its docstring that it is the entry point for
  the rule CLAUDE.md declares — the way `findAudioFileIdByHashIn` is the one
  answer to "does a row already hold these bytes?".

### 🟡 7. Six exports with no caller anywhere, one of them a documented landmine

- **Where:** verified by cross-file grep plus an in-file occurrence count, so
  same-file consumers are excluded from the claim.

  | Export                         | Where                                                             |
  | ------------------------------ | ----------------------------------------------------------------- |
  | `getAudioFileByHash`           | [db.ts:910](src/lib/db.ts#L910)                                   |
  | `analyseAudioBuffer`           | [loudness/analyse.ts:134](src/lib/audio/loudness/analyse.ts#L134) |
  | `generateTimestamp`            | [syncUtils.ts:23](src/lib/syncUtils.ts#L23)                       |
  | `resetGoogleTokenRefreshState` | [useGoogleDriveSync.ts:143](src/hooks/useGoogleDriveSync.ts#L143) |
  | `shouldAttemptTokenRefresh`    | [googleDrive/auth.ts:121](src/lib/googleDrive/auth.ts#L121)       |
  | `formatAuthError`              | [googleDrive/auth.ts:105](src/lib/googleDrive/auth.ts#L105)       |

- **Finding:** `getAudioFileByHash` is the one that matters. It calls
  `index("hash").getAll(hash)` with **no empty-hash guard** — the exact shape
  CLAUDE.md says has now been found three times on one branch, and that
  `findAudioFileIdByHashIn` exists to be the single guarded answer to. It has
  zero production callers; the only mentions left are two comments saying it is
  what `audioHashIndex` replaced. `plans/off-topic-improvements.md` already
  carries it as _"one unguarded caller away from returning any row"_ — the
  cheaper resolution is that there is no caller to guard.

  `resetGoogleTokenRefreshState` is a test-reset seam for the module-level
  state added by `549cc1a` that **no test calls**, so that state's isolation is
  not exercised.

- **Impact:** Low today, latent tomorrow: a dead helper with the repo's most
  expensive bug shape baked in is the most attractive thing for a future caller
  to reach for.
- **Fix:** Delete all six. Nothing in the tree references them.
  → `/simplify`.

### 🟡 8. `ProfileManager.tsx` — 1682 lines, 25+ `useState`, 0 % unit coverage

- **Where:** [src/components/profiles/ProfileManager.tsx](src/components/profiles/ProfileManager.tsx).
- **Finding:** The largest component in the repo, and one of six files with
  **0 % line coverage** despite 80+ statements:

  ```
     0 %   325 stmts  src/components/profiles/ProfileManager.tsx
     0 %   176        src/components/WaveformTrimmer.tsx
     0 %   108        src/components/modals/LoudnessOverviewModalContent.tsx
     0 %    94        src/app/page.tsx
     0 %    82        src/components/profiles/ProfileCard.tsx
     0 %    81        src/components/profiles/sync/ProfileSyncPanel.tsx
  ```

  It holds the Drive picker, the share-link connect flow, orphan scan/cleanup,
  missing-file repair, Drive audio repair, profile export selection, bank
  import and bank export — nine independent workflows in one function. Its own
  header comment already records "29 useState calls and a 615-line hook".

- **Impact:** These are covered only by e2e, so every change to them costs a
  browser run to verify, and the branches e2e does not walk are unverified
  entirely. It is also where the highest-consequence buttons live (cleanup,
  repair, replace).
- **Fix:** Not a rewrite. Peel off one workflow at a time into the sibling
  panel components the tab already has —
  `DuplicateAudioPanel`/`ExportBanksPanel`/`BankImportPlacementDialog` are the
  pattern, and all three arrived with unit tests. The Maintenance tab
  (orphans + missing files + Drive repair, ~7 of the useStates) is the
  natural first extraction.

### 🟡 9. `.claude/worktrees/` is ignored only by an uncommitted file

- **Where:** `.git/info/exclude:11`; [.gitignore:59](.gitignore#L59) covers `/.worktrees/` but not `.claude/worktrees/`.
- **Finding:** `git check-ignore -v` names `.git/info/exclude` as the rule
  keeping 577 MB of agent worktrees untracked. That file is per-clone and never
  committed.
- **Impact:** Any fresh clone, any CI checkout that creates one, or any other
  machine will see those trees as untracked — and a stray `git add -A` commits
  a checkout plus `node_modules` into the repo.
- **Fix:** Move the pattern into `.gitignore` next to `/.worktrees/`.
  `.dockerignore` already lists both, which is why the image is unaffected.

---

## 🟢 Low

### 🟢 10. 2.3 GB of stale worktrees on branches whose work is already in `main`

`git worktree list` shows three besides the checkout: `fix/repo-review` (1.7 GB
tree, last commit 2026-08-17), `fix/infra-review-2026-08-17` (577 MB,
2026-08-17) and `loudness-normalisation` (2026-08-15). The first two are merged
into `main`. The other two look unmerged (`git branch --no-merged main` lists
`loudness-normalisation` and `feat/wasabi-audio` with 40 and 10 commits), but
**every one of those commits is in `main` under a different hash** — I checked
`fix(a11y): name the profile selector by its purpose` (present at
`ProfileSelector.tsx:58`), `fix(profiles): let the "Synced" status actually
appear` (`c17122e`), `refactor(audio): load panel data without setState inside
an effect body` (`d146370`) and the README table of contents (present). **No
work is stranded.** → `superpowers:finishing-a-development-branch` to remove
the worktrees and delete the branches.

### 🟢 11. The dedup confirmation does not say a pad can lose sound slots

[DuplicateAudioPanel.tsx:88-92](src/components/profiles/DuplicateAudioPanel.tsx#L88-L92)
promises _"Every pad that uses a removed copy will be pointed at the copy that
stays"_. It does more than that: [audioDedup.ts:333-334](src/lib/audioDedup.ts#L333-L334)
collapses the rewritten `audioFileIds` through a `Set`, so a pad naming both
rows of a group ends with **one** entry where it had two. That is deliberate
and tested (`audioDedup.test.ts:409-415`), but it contradicts the repo's own
rule that one pad may legitimately name one row twice (`c878520` numbers
repeated sounds in the editor for exactly this). A sequential pad set to play a
sound, then another, then the first will quietly become a one-sound pad. One
extra sentence in the confirm text.

### 🟢 12. The export reads one IndexedDB transaction per audio row

[importExport.ts:1792](src/lib/importExport.ts#L1792) — `collectAudioForPads`
loops `await getAudioFile(id)`, and `getAudioFile` is a bare `db.get`
([db.ts:771](src/lib/db.ts#L771)), so a full board of 400 sounds opens 400
transactions before a byte is written. `getAudioFileMetadata(ids)` already
exists as the batched-cursor answer for the metadata case
([db.ts:831](src/lib/db.ts#L831)); this one needs the blobs too, so the fix is
one cursor pass rather than that helper.

### 🟢 13. The Drive sync path is the largest thinly-tested surface left

`googleDrive/sync.ts` **24 %** lines (283 statements), `googleDrive/api.ts`
**34 %** (308). This is also the code that, per the 08-17 report and
`memory/google-oauth-origin-localhost-3000`, cannot be exercised against the
live API from anywhere but `localhost:3000`. Not actionable as a single fix,
but it is where an unreviewed change is least likely to be caught, and worth
knowing before touching it.

### 🟢 14. The service worker caches share-link URLs as cache keys

[public/sw.js](public/sw.js) `handleNavigation` caches every successful
navigation under `request.url`, query string included — so
`/server/open?id=…&token=…` becomes a persistent Cache Storage key that lives
until the next build changes `?build=`. The token is already in the address bar
and in history, so the marginal exposure is small, and `/api/**` is correctly
never touched. Worth a `url.search` strip on the cache key if it is cheap.

---

## Verified clean — do not re-spend the budget

- **Secrets.** No plaintext credential in `src`, `scripts`, `config`,
  `e2e-tests`, `.github` or the root files; every hit is a test fixture. `.env*`,
  `certificates` and `/data/` are gitignored and `git ls-files` confirms none is
  tracked (only `.env.dist`). `.gitleaks.toml` present and wired into hk.
- **CI supply chain.** Every `uses:` is SHA-pinned, the workflow defaults to
  `permissions: contents: read`, and there is no `pull_request_target`.
- **App security.** No string-built SQL in `src/lib/server` or `src/app/api`; no
  `eval`, `new Function`, `child_process` or `shell: true` in `src`; no
  `dangerouslySetInnerHTML` or `innerHTML` anywhere. Both admin routes go
  through `requireAdmin` and answer 404 rather than 403. `/api/test/session` is
  double-gated on `IMPAMP_E2E_SIGNIN_SECRET` being set _and_ presented, and
  answers 404 either way.
- **08-17's server 🔴s are closed.** `contentIntegrity.ts` now hashes what the
  bucket actually holds, in bounded 4 MB chunks, and `commit` calls it
  (`storedObjectMatchesHash`); `requestBody.ts` is the bounded reader.
- **08-17's a11y 🔴s are closed** except finding 3: `Modal` has
  `role="dialog"`, `aria-modal`, a focus trap and focus restore;
  `ErrorBoundary` exists; `PlaybackAnnouncer` is a real `aria-live` region.
- **The documented invariants hold**, checked one by one: no hand-rolled `#`
  splitting of playback keys outside `audio/types.ts`; `layersByBase` written
  only by `claimPlaybackKey` and `clearTrackState`; exactly one
  `getStrategy(playbackType, baseKey)` call site; `deleteAudioFile` has no
  production caller and every deletion goes through
  `deleteUnreferencedAudioFiles`; both orphan sweeps `await
settleAudioImports()` immediately before opening their transaction; the
  direct `ctrlKey`/`metaKey` reads that remain are the four CLAUDE.md
  documents as deliberate (Ctrl+S, Ctrl+F, Ctrl+digit, and the pad-activation
  modifier veto).
- **Bank transfer** (`bankTransfer.ts`, 1294 lines, landed yesterday) reads
  clean: capacity and duplicate-target checks run before the first write, the
  rollback baseline is `null` until the profile has been read, the rollback
  restores replaced rows verbatim inside one transaction over both stores, and
  `sourceBankId` is compared and never adopted.
- **No lost work on the unmerged branches** — see 🟢 10.
- **Performance.** No whole-store Zustand subscription remains; the rAF
  playback loop stops itself when `activeTracks` empties; `removeConsole` strips
  logs from production builds; per-iteration IO is confined to loops already
  inside a single transaction, with 🟢 12 the one exception.
- **Dev-env.** `DEV_ENV_VERSION = "23"`, mise pins node 24.19.0, hk runs
  prettier, eslint, vitest, typecheck, jscpd, actionlint, action-pins and both
  version-sync scripts. The Dockerfile is multi-stage, layer-ordered, drops to
  `USER node`, pre-creates and chowns `/data`, and passes `GIT_SHA` so the live
  app reports its own commit.

---

## Summary

This is a healthy repo and an unusually well-documented one — zero TODO
markers, zero clones, no `@ts-ignore`, no dependency vulnerabilities, a clean
supply chain, and prose comments that consistently explain _why_ rather than
_what_. Two prior reviews have been answered in full, and the 145 commits since
the last one hold up: the newest module (`bankTransfer.ts`) was the one I
expected to break and did not.

The one thing that did break is instructive. **🔴 1 is a genuine data bug and
it has the repo's own signature on it**: a new deleter shipped without the
invariant CLAUDE.md declares for every deleter, because the primitive enforcing
that invariant is private to `db.ts` (🟡 6). That pair is the finding worth
acting on — the guard, and then the reason the guard was skippable.

**Fix first, in this order:**

1. **🔴 1** — export `settleAudioImports`, call it in
   `collapseDuplicateAudioGroups`, land the probe as the regression test. It
   silently breaks pads today.
2. **🔴 2** — stub the loudness pipeline in the eleven suites. Cheap,
   mechanical, and it stops CI lying about the next change.
3. **🟡 3** — one line in `FormField`, fixing four controls.

Then the documentation pair (🟡 4 and 🟡 5), which are both cases of a second
copy of a fact drifting from the first — and both actively misdirect the next
person to open the repo. The rest can wait for a quiet afternoon.
