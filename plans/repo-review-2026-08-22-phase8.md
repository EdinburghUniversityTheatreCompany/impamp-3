# Phase 8 review — 2026-08-22

The fifth review of the day, against `main` at `024ab95`. Directed rather than
general: [phase 7](repo-review-2026-08-22-phase7.md) concluded that merge seams
were not the source of the day's bugs — **every red finding was a fix that was
incomplete on its own branch** — and that shape is now CLAUDE.md's third named
check. So the target here is _today's fixes and their counterpart sides_, with
priority on the six changes made after phase 7 ran and which therefore no
review has ever seen: `p7/attribution`, `p7/sweep`, `p7/writers`, `p6/tutorial`,
`fix/tour-blocks-e2e`, `p7/vacuous`.

Nothing from the three earlier reports is re-reported. Where one of their
findings was re-checked and is still open, it is listed in **Still open** with
what established that, and is not counted as a finding here.

**Evidence.** Every finding below cites a `file:line` plus a probe run, a
mutation with the vitest output either side of it, or a browser run whose
output is quoted. Probe sources were written into the tree, run, and deleted.
Every mutation was applied through a script that asserts its target text exists
before writing (so a silent no-op cannot masquerade as an equivalent mutant),
and restored with `git checkout --` immediately afterwards.

**A note on re-verification.** This pass was interrupted by a connection error
partway through. Every mutation result recorded before the interruption was
re-run afterwards from a verified-clean tree, and the numbers below are the
second run's. That matters because a run that dies mid-mutation is exactly when
a "finding" can be an artefact of a half-reverted tree.

## Gates, measured

| Gate                                     | Result                                         |
| ---------------------------------------- | ---------------------------------------------- |
| `npx vitest run` (clean tree, `024ab95`) | **1575 passed** / 165 files, exit 0            |
| `npx playwright test --project=chromium` | **197 passed, 1 failed, exit 1** — see 🟡 5    |
| mutations                                | 11, each target-asserted and each restored     |
| `uptime`                                 | 1.1–4.5 throughout; 1.13 for the unit baseline |

---

## 🔴 High

### 🔴 1. The sweep asks whether the _hash_ is committed, not whether the _key_ is — so an abandoned upload under a second extension can never be removed, by any mechanism, ever

- **Where:**
  - [src/lib/server/audioSweep.ts:200](../src/lib/server/audioSweep.ts#L200) — `committedHashesAmong([...candidates.values()])`
  - [src/lib/server/audioSweep.ts:207](../src/lib/server/audioSweep.ts#L207) — `if (!hash || committed.has(hash)) continue;`
  - [src/lib/server/s3/client.ts:102](../src/lib/server/s3/client.ts#L102) — `objectKeyForHash(hash, extension)`, the extension being part of the key
  - [src/lib/server/audio.ts:263](../src/lib/server/audio.ts#L263) — `storageKeyForHash`, whose own docstring records that one hash produced two keys once already
  - [src/lib/server/audioRequests.ts:188](../src/lib/server/audioRequests.ts#L188) — `extension` is any string the caller sends
  - [src/lib/server/audio.ts:377](../src/lib/server/audio.ts#L377) — `ON CONFLICT(user_id, hash)`: one provisional charge per hash, however many keys

- **Finding.** `p7/sweep` fixed the traversal — the cursor now walks the whole
  bucket, and that half is genuinely covered (four mutants killed, below). The
  other half of the same rule was not swept: the _decision_ about each key is
  still keyed on the hash, as it has been since `25984ef`. The bucket is not
  keyed on the hash. It is keyed on `audio/<shard>/<hash>.<extension>`, and the
  extension comes from the request body with no validation beyond
  `objectKeyForHash`'s `[a-zA-Z0-9]` strip.

  So the moment _any_ key for a hash is committed, `committed.has(hash)` is
  true for **every** key carrying that hash, and the sweep skips them all. An
  object PUT under `…​.aa` and never committed is invisible to the sweep for
  ever once `…​.wav` commits. There is no other mechanism: no quota counts it
  (`audio_objects` has one row per hash), the admin view sums the same table,
  and no API can delete a key that is not the one `storageKeyForHash` derives.

- **Evidence — reproduced end to end through the real route handlers**
  (`upload-url`, `commit`) against an in-memory database and the fake object
  store, with the sweep run twice thirty days later:

  ```
  mint ext=aa status=200 key=audio/c9/c91a…1609.aa uploadUrl=yes
  mint ext=ab status=200 key=audio/c9/c91a…1609.ab uploadUrl=yes
  mint ext=ac status=200 key=audio/c9/c91a…1609.ac uploadUrl=yes
  pending rows charged: [ { user_id: 1, size_bytes: 1024 } ]
  commit status 200
  sweep pass1 { scanned: 4, removed: 0, truncated: false } pass2 { … same … }
  junk survived: 3 of 3
  audio_objects says stored: [ 1024 ]
  ```

  Each junk object was written at 6 MB against a declared 1 KB, which is
  legitimate: a presigned PUT signs only `host`, as the module says. The bucket
  holds 18 MB; the database says 1024 bytes; the sweep removes nothing on an
  otherwise-empty bucket, so this is not the scan cap.

  Note the third line of the probe output particularly. `recordPendingUpload`
  is `ON CONFLICT(user_id, hash)`, so **N mints for one hash under N
  extensions leave exactly one provisional charge** — and that charge lapses
  after `uploadUrlTtlSeconds` anyway. The quota work in `p3/server-abuse`
  bounds licences per hash, not keys per hash.

- **Impact.** This is the last hole in the mechanism the whole of
  `p3/server-abuse` leans on, and it is the one that survives the cursor fix.
  The amplification is bounded only by how many mints an approved account
  makes before committing: for each hash, one committed object and arbitrarily
  many permanent ones, each of them arbitrarily large, each billed by Wasabi at
  a 90-day minimum. `plans/off-topic-improvements.md` defers signing
  `content-length` on the explicit ground that unbilled bytes survive only
  "until the sweep reaches them". For these keys the sweep never reaches them,
  and — unlike phase 7's 🔴 2 — no later pass ever will.

  Ordinary users can produce this without meaning to. The extension is taken
  from the file name, so the same bytes as `horn.mp3` and `horn.mpeg` are two
  keys; whichever upload fails first is permanent once the other commits.

- **Fix.** Decide per key. `committedHashesAmong` should hand back the
  committed key for each hash (it already reads `audio_objects`, which carries
  `extension`), and line 207 should compare `object.key` against it rather than
  test hash membership — so a key that is not the one this hash is stored under
  is an orphan like any other. Then the test that does not exist: a bucket
  holding a committed object and a same-hash object under a different
  extension, which the probe above is.

---

## 🟡 Medium

### 🟡 2. Escape, the backdrop and the × do not record the first-use tour as seen, so it comes back on every load — and two comments assert the opposite

- **Where:**
  - [src/lib/uiUtils.ts:58-59](../src/lib/uiUtils.ts#L58-L59) — `showCancelButton: false` and `onCancel: markWelcomeTourSeen`
  - [src/lib/uiUtils.ts:45-48](../src/lib/uiUtils.ts#L45-L48) — the comment claiming Escape and the backdrop go through `onCancel`
  - [src/components/modals/WelcomeTourContent.tsx:114-121](../src/components/modals/WelcomeTourContent.tsx#L114-L121) — the same claim, and `finish()`, the only reachable writer
  - [src/components/Modal.tsx:68](../src/components/Modal.tsx#L68) (`useEscapeToClose(isOpen, onClose)`), [:142-146](../src/components/Modal.tsx#L142-L146) (`handleCancel`, wired only to the Cancel button), [:166](../src/components/Modal.tsx#L166) (backdrop → `onClose`), [:187](../src/components/Modal.tsx#L187) (× → `onClose`)
  - against [src/store/uiStore.ts:43](../src/store/uiStore.ts#L43) and [src/components/modals/EditPadModalContent.tsx:28-31](../src/components/modals/EditPadModalContent.tsx#L28-L31), which both state the real rule

- **Finding.** The shared `Modal` reaches `onCancel` from exactly one place:
  the Cancel button. Escape, an overlay click and the × all call `onClose`,
  which `ModalRenderer` binds to `closeModal`. `openWelcomeTour` passes
  `showCancelButton: false`, so the tour has no Cancel button at all — its
  `onCancel: markWelcomeTourSeen` is unreachable code.

  The repo already knew this. `uiStore.ts:43` says "Callbacks like `onCancel`
  should be handled by the specific action triggering the close (e.g., Cancel
  button)", and `EditPadModalContent.tsx:28` says it in full: _"onCancel runs
  only for the Cancel button, while Escape, the X and an overlay click all
  close the modal straight through onClose"_ — which is why that component
  discards on unmount instead. The tour was written on the opposite assumption
  a few hours later, and says so twice.

- **Evidence — two independent measurements.**

  jsdom, driving the real `Modal` with the exact props `openWelcomeTour`
  passes, plus a control:

  ```
  after Escape:      onCancel calls = 0  onClose calls = 1
  after backdrop:    onCancel calls = 0  onClose calls = 2
  after X:           onCancel calls = 0  onClose calls = 3
  cancel button present with showCancelButton=false: false
  CONTROL cancel button: onCancel calls = 1
  ```

  And the real application in chromium, twice (the second time on an idle
  machine), reading `localStorage` after each dismissal:

  ```
  PROBE after Escape, welcomeTourSeen = null
  PROBE tour back after reload: true
  PROBE after the X, welcomeTourSeen = null
  PROBE CONTROL after Skip, welcomeTourSeen = "1"
  ```

  The control matters: `Skip` writes `"1"`, so the storage path works and the
  gate is not failing closed for some unrelated reason. On the first attempt at
  this probe I read `back: false` because I checked before the tour's IndexedDB
  read had resolved; the line above is from the run that waits for it.

- **Impact.** Escape, clicking outside and the × are the three most natural
  ways to dismiss a dialog, and all three leave the tour to reappear on the
  next load, and the next. The only exits that stick are `Skip` and `Get
started`. `firstRun.ts`'s own docstring names this outcome as the thing its
  fail-closed direction exists to avoid — _"a modal that reappears on every
  load with no way to dismiss it permanently"_ — and it is what ships. It lands
  on first-time users only, which is to say on everyone's first impression of a
  live performance tool.

  Neither e2e spec can see it: both dismiss through `welcome-tour-next` or
  `welcome-tour-skip`, the two buttons that call `finish()` directly.

- **Fix.** Either have `WelcomeTourContent` record seen-ness from an unmount
  cleanup (the pattern `EditPadModalContent` adopted for exactly this reason),
  or make `Modal` route Escape, the backdrop and the × through `handleCancel`
  — but that second one changes every modal in the app and needs its own
  review. The first is three lines. Add a spec that presses Escape and reloads.

### 🟡 3. The tour is gated on the board, not on the page, so it opens over a share link — the one place a brand-new user arrives

- **Where:**
  - [src/components/ClientSideInitializer.tsx:205-219](../src/components/ClientSideInitializer.tsx#L205-L219) — the offer effect
  - [src/lib/uiUtils.ts:75](../src/lib/uiUtils.ts#L75) — `shouldOfferWelcomeTour(configuredPadCount)`, which asks two questions and neither is "where are we"
  - [src/app/layout.tsx:52](../src/app/layout.tsx#L52) → [src/components/ClientLayout.tsx:44](../src/components/ClientLayout.tsx#L44) — `ClientSideInitializer` wraps **every** route, not just `/`

- **Finding.** The gate is "unseen on this device AND the active profile has no
  configured pads". `ClientSideInitializer` is mounted by the root layout, so
  those two conditions are also satisfied on `/server/open`, `/drive/open` and
  `/server/storage`, and the tour opens over them. A fresh device arriving on a
  shared board's link is the _most_ likely visitor to satisfy both conditions
  at once.

- **Evidence — chromium, no `gotoApp`, exactly like a device that has never
  seen the app:**

  ```
  PROBE tour visible on /server/open: true
  PROBE overlay count: 1
  ```

  The overlay is `Modal`'s `fixed inset-0 z-50`, so it is over that page's own
  controls, not beside them.

- **Impact.** The first thing a new user does with a shared board is open its
  link, and they get a four-step tour about pads and banks in front of the
  "Shared profile" page instead — and, per 🟡 2, one that comes back if they
  press Escape to get at the page. It is also why the fix in
  `fix/tour-blocks-e2e` is narrower than it reads: `gotoApp` marks the tour
  seen, but five specs navigate without it
  (`server-sync.spec.ts:344`, `:388`, `:394`, `:1272`, `:1285`) and therefore
  still meet the tour. They pass only because every one of them asserts
  `toBeVisible()` on text and never clicks anything — Playwright's visibility
  check does not care about an overlay. That is a spec suite one `click()` away
  from the same eleven-spec failure `f3a96f5` fixed.

- **Fix.** Offer the tour only from the board. The effect could check
  `usePathname() === "/"`, or — better, since it is the same question the gate
  already means to ask — move the offer out of `ClientSideInitializer` and into
  `src/app/page.tsx`. Then make `markWelcomeTourSeen` unconditional in
  `gotoApp` rather than tied to a navigation helper some specs skip.

### 🟡 4. `p7/attribution`'s residual is real, and one direction of it is worse than the commit message states: in the NULL window the holder's bytes are unprotected, and losing them is not recoverable

- **Where:**
  - [src/lib/server/profiles.ts:181](../src/lib/server/profiles.ts#L181) — the `INSERT`, now `… ? writerId : null`
  - [src/lib/server/audio.ts:308-331](../src/lib/server/audio.ts#L308-L331) — `deletingHashWouldSilenceAProfile`, whose `(p.owner_id = ? OR pa.added_by = ?)` cannot match a NULL `added_by`
  - [src/app/api/audio/[hash]/route.ts:74](../src/app/api/audio/[hash]/route.ts#L74) → [:84](../src/app/api/audio/[hash]/route.ts#L84) — the 409 that is skipped, and the `releaseReference` that then orphans the object

- **Finding.** Both halves of the fix are correct and both are covered (see
  **Verified clean**). The stated residual is _"between an owner re-adding a
  hash and a holder next saving, the row is NULL and the sound unservable"_,
  with the reassurance _"It fails closed and self-heals."_ That is true of the
  **serve** side and not of the **delete** side, and the two are supposed to
  agree by construction — `deletingHashWouldSilenceAProfile`'s docstring says
  so in as many words.

  A NULL `added_by` makes the row unservable, which is intended. It also makes
  the row invisible to `deletingHashWouldSilenceAProfile`, so the 409 that
  stops the real holder deleting bytes a board still plays answers "safe to
  delete". If they take that offer during the window, the object is orphaned
  and removed, no holder remains, and the "a holder next saves" repair the
  design depends on can never fire. It does not self-heal; it hardens.

- **Evidence — probe against the real `createProfile` / `updateProfile` /
  `profileMayServeHash` / `deletingHashWouldSilenceAProfile` /
  `releaseReference`:**

  ```
  baseline         added_by= 2    servable= true   deleteRefused= true
  after round trip added_by= null servable= false  deleteRefused= false
  holder deletes: { removed: true, orphaned: true }  object row now: undefined
  profile still names it, added_by= null   holders left: { n: 0 }
  ```

  The "round trip" is two ordinary saves by the owner, one without the hash and
  one with it back.

- **Impact.** Not a regression — the pre-fix state (`added_by` = the owner, who
  holds nothing) answered `deleteRefused: false` too, so the fix did not widen
  this. But it is the half of the residual that destroys data the user cannot
  get back, and the commit message and the test's comment both describe the
  residual as benign. Somebody deciding whether this is worth closing will read
  "fails closed and self-heals" and reasonably decide it is not.

- **Fix.** Two options, and the choice is a design call rather than a bug fix.
  Either widen `deletingHashWouldSilenceAProfile` to refuse while _any_ profile
  names the hash and the caller is its last holder — which reintroduces the
  denial-of-service `p3/server-abuse` closed, so probably not — or stop losing
  the attribution across a round trip at all, which is the larger change phase 7
  already named. In the meantime, correct the claim: state the delete side of
  the window in `attributionDrift.test.ts`'s docstring, since that file is where
  the next reader will look.

### 🟡 5. The chromium gate is not green, and passes only by winning a race: `/server/storage` renders the same heading text twice for an approved account

- **Where:**
  - [src/app/server/storage/page.tsx:19](../src/app/server/storage/page.tsx#L19) — `<h1>Server audio storage</h1>`
  - [src/components/audio/AudioStoragePanel.tsx:98](../src/components/audio/AudioStoragePanel.tsx#L98) — `<h3>Server audio storage</h3>`, inside that page
  - [src/components/audio/AudioStoragePanel.tsx:80](../src/components/audio/AudioStoragePanel.tsx#L80) — `if (state.kind === "loading" || state.kind === "unavailable") return null;`
  - [e2e-tests/server-sync.spec.ts:1274-1276](../e2e-tests/server-sync.spec.ts#L1274-L1276) — the assertion

- **Finding.** The storage page's own `<h1>` and the panel nested inside it use
  the identical string. `AudioStoragePanel` is shared — it also renders in the
  sync panel, which is why it carries its own `<h3>` heading — so on the
  dedicated page the name appears at two heading levels, one inside the other.

  The panel returns `null` until its usage fetch resolves, so the page has one
  heading and then two. `getByRole("heading", { name: "Server audio storage" })`
  is a strict locator: it succeeds only if Playwright's first evaluation lands
  inside the loading window, and throws a strict-mode violation for ever after.
  The test does not verify a state; it races the page finishing loading.

  For an anonymous visitor (the spec 16 lines below) the panel stays `null`, so
  that one passes every time — which is why the pair looks consistent.

- **Evidence — measured, on an idle machine (load 1.1–2.0, nothing else
  running).** A full chromium run:

  ```
    1 failed
      [chromium] › e2e-tests/server-sync.spec.ts:1266:3 › hosted audio › the storage page shows an approved account its allowance
    197 passed (3.5m)
  ```

  with

  ```
  Error: strict mode violation: getByRole('heading', { name: 'Server audio storage' }) resolved to 2 elements:
      1) <h1 class="text-xl font-semibold">Server audio storage</h1> aka locator('h1')
      2) <h3 class="text-sm font-semibold">Server audio storage</h3> aka locator('h3')
  ```

  and `--repeat-each=8` on that spec alone:

  ```
    5 failed
    3 passed (16.8s)
  ```

- **Impact.** Two things, and the second is why this is here rather than on the
  backlog.

  The gate lies in both directions. Roughly three runs in eight are green, so
  `npm run test:e2e` reports a clean tree as broken most of the time and a
  broken tree as clean the rest — and CI has `retries: 2`
  (`playwright.config.ts:40`), which turns a 5-in-8 failure into a red build
  about a quarter of the time and a "flaky" line in the job summary otherwise.
  `E2E_FAIL_ON_FLAKE=1` makes that a gate. This is the exact hazard the day's
  checkpoint and CLAUDE.md keep circling — **my own first run of this suite
  reported `198 passed` and I nearly wrote it into the gates table above.** The
  difference between the two runs was only what else the machine was doing.

  And underneath it is a real accessibility defect, independent of any test: a
  screen-reader user tabbing the heading outline of `/server/storage` hears
  "Server audio storage" twice, at level 1 and level 3, with no way to tell the
  page from the panel.

  Not from today — the panel is `26b4977` (2026-08-13) and the spec `33b88b8`
  (2026-08-21) — but no review has reported it, and the three that ran today
  either skipped e2e deliberately or read its result through a pipe.

- **Fix.** Rename one of them. The panel's heading is the one that has to work
  in two places, so the page's `<h1>` should say what the _page_ is —
  "Server audio" or "Storage on this server" — or the page should drop its own
  heading and let the panel own it. Then tighten the assertion to
  `getByRole("heading", { level: 1, name: … })` so it stops being a race
  whichever way the naming goes.

---

## 🟢 Low

### 🟢 6. `sweepIfDue`'s pre-await throttle claim — the whole of its overlap protection — can be moved after the await with all 17 tests green

- **Where:** [src/lib/server/audioSweep.ts:299-302](../src/lib/server/audioSweep.ts#L299-L302), whose comment reads _"Claimed before the first await, so two overlapping callers cannot both sweep and a throw still leaves the hour's throttle in place."_
- **Evidence — mutation, plus a probe proving the mutant is not equivalent.**
  Moving `nextSweepAt = now + MIN_SWEEP_INTERVAL_MS` to after the `await`:

  ```
  npx vitest run src/lib/server/audioSweep.test.ts   →  Tests  17 passed (17)
  ```

  Two concurrent `sweepIfDue` calls against a store whose `list` takes 5 ms:

  ```
  unmutated:  A = { scanned: 3, removed: 3, truncated: true }   B = null
  mutated:    A = { scanned: 3, removed: 3, truncated: true }   B = { scanned: 3, removed: 3, truncated: true }
  ```

- **Impact.** None today; the code is right. What is missing is any gate on it,
  in a module rewritten twice this afternoon. Two concurrent passes share the
  module-level `resumeAfterKey`, so each would clobber the other's cursor as
  well as doing the same work twice — and the second property the comment
  claims, that a throw leaves the hour's throttle in place, is equally
  untested. The two live callers (`ensureSweepScheduled`'s 5-minute tick and
  the admin page) can both fire at once by construction.
- **Fix.** One test: two `sweepIfDue` calls started together against a store
  that resolves slowly, asserting the second is `null`. One more for the throw.

### 🟢 7. The pad editor's mount-to-unmount register hold is safe, but the reason given for it is false — the profile manager is not in `uiStore`

- **Where:**
  - [src/components/modals/EditPadModalContent.tsx:41-45](../src/components/modals/EditPadModalContent.tsx#L41-L45) — _"every deleter in the app is a button on the profile manager or the editor's own discard, and `uiStore` holds exactly one modal, so the profile manager cannot be open at the same time as this"_
  - [src/store/profileStore.ts:942](../src/store/profileStore.ts#L942) — `openProfileManager`, in `profileStore`
  - [src/store/uiStore.ts:22](../src/store/uiStore.ts#L22) — `isModalOpen`, a different store
  - [src/components/profiles/ProfileManagerHost.tsx:40](../src/components/profiles/ProfileManagerHost.tsx#L40) and [src/components/ClientLayout.tsx:50](../src/components/ClientLayout.tsx#L50) — rendered independently of `ModalRenderer`
- **Evidence.** `useEscapeToClose`'s own docstring names the profile manager as
  _"the one overlay rendered outside the modal system"_, and
  `useIsAnyOverlayOpen.ts:33` ORs three independent flags precisely because
  they are independent. Nothing sets `isModalOpen: false` when
  `isProfileManagerOpen` becomes true, or the reverse — so the two can be open
  together in state.

  What actually keeps them apart is a z-index. `Modal`'s overlay is
  `fixed inset-0 z-50` (`Modal.tsx:166`); the only opener reachable while a
  modal is up is `BackupReminderNotification`'s "Manage Profiles" button, and
  that banner is `z-40` (`BackupReminderNotification.tsx:26`, with the inline
  comment `// Changed z-50 to z-40`). A click there hits the overlay, which
  closes the editor.

- **Impact.** None today, and the hold itself is well built (release first,
  synchronous, idempotent, and `EditPadForm`'s own `<Suspense fallback={null}>`
  at `:497` contains the trimmer's lazy load so a re-suspension cannot destroy
  the effect mid-edit — checked, because that would fire the discard with the
  editor still open). But the _stated_ safety argument is one raised z-index, one
  toast, or one programmatic `openProfileManager()` away from being wrong, and
  the failure it guards is the worst kind to debug: `settleAudioImports`
  (`db.ts:1475`) is a `while` loop with no timeout, so a deleter reached while
  the hold is open hangs the tab silently and for ever.
- **Fix.** Replace the reason with the true one, or make it true — have
  `openProfileManager` close any open modal, which is what the comment already
  assumes.

---

## Still open — re-checked this pass, not re-reported

Each was verified against the tree at `024ab95`; none is counted as a finding.

- **Phase 7 🟡 4, the five stale authorization comments.** All still present:
  `audio.ts:195`, `:209`, `:211`, `:219`; `db.ts:218`, `:228`;
  `audioShareGrant.test.ts:5`, `:88`, `:98`. One of them is now _more_ wrong
  than when it was reported — `audio.ts:209` says _"`reindexProfileAudio` is
  INSERT OR IGNORE, so a re-save does not fill the column in"_, and after
  `p7/attribution` the repair fills it in for a strictly larger set of rows than
  before. It still points the next reader at share acceptance as the feature
  needed to fix a problem that is solved.
- **Phase 7 🟡 6, the unrecognised-blob wipe.** Reproduced again: one
  `updateProfile` with `data: { pads: [] }` takes a servable
  collaborator-added row to `rowExists= undefined  servable= false`.
- **Phase 7 🟡 7 and 🟡 8, the search hook and Enter ordering.**
  `SearchModal.tsx:209-212` is unchanged: `if (!first) return;` still sits above
  the `isStale` branch.
- **Phase 7 🟢 9** (`dropCachedLoudness` still has one caller, `audioDedup.ts:423`),
  **🟢 11** (`deleteAudioFile`, `db.ts:973`, still zero callers),
  **🟢 13** (`db.ts:117`'s "no caller yet"),
  **🟢 14** (three byte-identical `errorMessage` copies at `ExportBanksPanel.tsx:50`,
  `BankImportPlacementDialog.tsx:92`, `applyTransition.ts:42`),
  **🟢 16** (`min-h-screen` at `drive/open/page.tsx:141`, `:260`, `server/open/page.tsx:121`),
  **🟢 17** (`pb-safe` on both track panels, `ActiveTracksPanel.tsx:77` and `ArmedTracksPanel.tsx:73`).
- **Phase 7 🟢 21's `audioSweep.ts` row.** `ensureSweepScheduled`'s
  `if (sweepTimer) return;` still leaves 17/17 green when removed.

---

## The six unreviewed changes, answered

- **`p7/attribution`.** Its two sides are the `INSERT` and the repair, and both
  were swept — mutating either kills a test, by name and for the right reason.
  The read side (`profileMayServeHash`) needed nothing: it already refuses a
  NULL adder. `reindexProfileAudio` is the only writer of `added_by` anywhere
  (`grep -rn profile_audio src`), so there is no third side. The stated residual
  is real but understated in one direction — 🟡 4.
- **`p7/sweep`.** The bucket shrinking under the cursor is a non-question:
  `start-after` is a lexicographic filter in both the real client
  (`s3/client.ts:267`) and the bucket the tests drive, so a cursor key that has
  been deleted still resumes correctly — which the sweep relies on already,
  since the removal cap parks the cursor on the object it just deleted. Two
  passes cannot overlap through `sweepIfDue`, the only caller, though nothing
  tests that (🟢 6). The reset condition is right and is covered. What the fix
  did not sweep is the per-key/per-hash decision — 🔴 1.
- **`p7/writers`.** Complete. Grepping every caller of `addOrReuseAudioFile`
  and `importAudioSources` in non-test source gives ten writers, and all ten are
  declared: `EditPadForm` (via the editor's hold), `BulkImportModalContent`,
  `usePadDrop`, `swapMissingAudioFile`, `googleDrive/dataAccess`,
  `googleDrive/sync`'s `downloadMissingAudioFiles` (inside `syncProfile`'s
  scope, including the `pullPublicReadOnlyProfile` path), `serverAudio/transfer`
  (inside `syncServerProfile`'s), both conflict-resolution entry points, and
  `importAudioSources`' two callers. No scope contains a deleter, and no scope
  nests inside another — the conflict-resolution entry points are called only
  from UI hooks, never from inside a sync run.
- **The `beginAudioImport` hold specifically.** It cannot leak through a
  re-suspension (`EditPadForm` has its own Suspense boundary at `:497`), a
  second editor (`uiStore` genuinely holds one modal, and opening another
  unmounts this one), or a navigation. The one thing worth fixing is the reason
  written next to it — 🟢 7.
- **`p6/tutorial` and `fix/tour-blocks-e2e`.** Two findings, 🟡 2 and 🟡 3. The
  e2e question specifically: five specs navigate without `gotoApp` and do still
  meet the tour, and pass only because none of them clicks.
- **`p7/vacuous`.** All three rewrites hold. Six mutations, six kills.

---

## Verified clean — do not re-spend the budget

Established this pass, with what established it.

- **`p7/sweep`'s traversal is genuinely covered**, which is worth saying because
  the module had no pagination test at all yesterday. Four mutations, four
  kills, each `5 failed | 12 passed` or better:
  never recording the cursor; not resetting it at the end of the listing;
  dropping `startAfter` from the list call; and (separately) `1 failed` for
  ignoring `truncated` in `sweepIfDue`. The suite drives a real HTTP bucket with
  real continuation tokens, so the wire format is exercised too.
- **`p7/attribution` is covered on both halves.** `if (userHoldsReference(...))`
  → `if (true || …)` fails `"does not repair the row for a writer who does not
hold the sound"` with `expected 1 to be null` — the assertion the vacuous-test
  fix added, failing for exactly the reason it exists. Making the `INSERT`
  record `writerId` unconditionally fails one test; putting `rowNeedsAdder` back
  to `added_by IS NULL` fails `"repairs a row whose recorded adder no longer
holds the sound"`. Three separate mutants, three separate deaths.
- **`p7/vacuous`'s three rewrites all bite.** Deleting `SearchModal.tsx:209`
  → `2 failed`; weakening `:248` to drop its Enter half → `1 failed`; deleting
  each of `profileStore.ts:503`, `:514`, `:526` → `1 failed` apiece. Every one
  of these left the whole 1544-test suite green yesterday.
- **`committedHashesAmong` is correct as written** (`audio.ts:151-171`): empty
  in, empty out; the range is derived from the page's own extremes and the
  result is filtered by the wanted set, so a near-miss neighbour cannot leak in.
  The defect in 🔴 1 is in what the answer is _used for_, not in the answer.
- **`sweepIfDue` is the only production caller of `sweepUncommittedObjects`**
  (`grep -rn` over `src/`, excluding tests: the admin route at
  `api/admin/audio/route.ts:28` and the timer, both through `sweepIfDue`).
- **The reuse-writes-nothing rule holds at every site that needs it.** Of the
  callers that read `reused`, `googleDrive/sync.ts:382` backfills
  `driveFileIds`, `googleDrive/dataAccess.ts:303` backfills the same,
  `serverAudio/transfer.ts:302` calls `markAudioFilesHosted`, and
  `EditPadForm.tsx:253` re-reads the stored name. `swapMissingAudioFile` and the
  two local-file writers need no backfill.
- **`extension` cannot be injected into a key.** `objectKeyForHash` strips to
  `[a-zA-Z0-9]` and lowercases, and `hashForKey`'s `[a-z0-9]+` therefore matches
  every key the app mints — re-derived, because 🔴 1 depends on the _number_ of
  keys a hash can have rather than their shape.
- **The unit gate is honest at `024ab95`**: 1575/1575 on a clean tree at load
  1.13, twice. The e2e gate is **not** — see 🟡 5. My own first chromium run
  read `198 passed` and I nearly wrote it into this table; the second run, on a
  quieter machine, exited 1. Both were read from a file, which is the only
  reason the exit code was available to be believed.

---

## Top three to fix first

1. **🔴 1 — the sweep's per-hash decision.** The only finding here that costs
   money indefinitely and that no later pass can undo: once a hash commits, its
   other keys are permanent, and nothing in the product can see or delete them.
   The fix is small — `committedHashesAmong` already reads the column it needs —
   and it belongs in the same commit as the test the module has never had for
   it. Take it while the reasoning behind the `content-length` deferral in
   `plans/off-topic-improvements.md` still depends on the sweep working.
2. **🟡 5 — the heading that makes the e2e gate a coin flip.** It is a two-line
   rename, and until it lands nobody can read a chromium result and know what it
   means. That is worth more than its own severity suggests: four reviews today
   turned on the question of whether a green run was telling the truth, and this
   is one spec that provably is not. Fixing 🔴 1 without it means shipping a
   storage change against a gate that fails five times in eight for an unrelated
   reason.
3. **🟡 2 — the tour that will not stay dismissed.** Three lines, it ships in
   front of every new user, and the code asserts twice that it already works.
   Take **🟡 3 in the same commit**: same file, same feature, same day old, and
   🟡 3 also removes a trap the e2e suite is one `click()` away from hitting.

🟢 6 is two tests and should ride along with 🔴 1, since the fix is in that file
anyway. 🟡 4 is a decision rather than a fix: at minimum correct the record in
`attributionDrift.test.ts`, so nobody re-derives the delete side from scratch.
🟢 7 is one comment.

---

## Summary

Seven findings, **all seven proven** — every one cites a probe run, a mutation
with the vitest output either side of it, or a chromium run whose output is
quoted. Nothing is carried as an unproven claim; there is no "claims to check"
section this time.

**The named shape held up, and found the headline bug.** Phase 7's rule — _a
rule with two sides is only fixed when both sides are swept_ — is what 🔴 1 came
out of: `p7/sweep` fixed "look at every key" and left "decide per key" alone, so
the sweep now walks a bucket it still cannot clean. 🟡 2 is the same shape in
the client: "record the answer on every exit" was swept for the two buttons and
not for the three dismissals, with a comment in a neighbouring file already
stating the rule correctly.

**The three post-phase-7 server fixes are otherwise sound**, and unusually well
covered for work written in an afternoon — eleven mutations found exactly one
untested guard between them (🟢 6), and every writer of an audio row in the tree
is now declared to the import register, which I checked by enumerating them
rather than by trusting the list. The tour is the weak spot: it is the only
thing in this pass that shipped with two comments asserting behaviour the code
does not have, and it is the newest code in the tree.

**The thing I would tell the next reviewer first**, though, is 🟡 5 — because it
nearly caught me. My first chromium run reported `198 passed` and I had already
written it into the gates table as the documented baseline. The second run, on
an idle machine, exited 1 on a spec that fails five times in eight. The lesson
is not the one the day has been repeating — I did redirect to a file, and I did
not end the command with `echo` — it is the next one along: **reading the count
is not reading the result.** 198 was the number I expected, so I stopped there.
The exit code was in the same file and said otherwise.
