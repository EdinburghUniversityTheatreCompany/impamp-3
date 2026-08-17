# Test health — review of 2026-08-17

Axis: coverage, quality and trustworthiness of the test suite.
Branch `main`, HEAD `b29585b`, reviewed in the working checkout (not a worktree).

## Baseline, measured on this HEAD

```
$ npx vitest run
 Test Files  55 passed (55)
      Tests  615 passed (615)
   Duration  8.61s

% Coverage report from v8   (src/**/*.{ts,tsx}, tests excluded)
Statements   : 29.64% ( 2881/9719 )
Branches     : 26.88% ( 1518/5646 )
Functions    : 26.12% ( 481/1841 )
Lines        : 29.92% ( 2703/9032 )
```

```
$ E2E_PORT=3100 npx playwright test --project=chromium --retries=0
  1 flaky
    [chromium] › e2e-tests/server-sync.spec.ts:471:3 › server sync conflicts ›
    a conflict opens the resolution modal, naming the server
  125 passed (53.4s)
```

The flake reproduced on my **first** full-suite run, at the exact line the brief
named. `--retries=0` on the command line does not reach it: the describe block
sets its own `retries: 2` (`server-sync.spec.ts:469`) and describe-level config
wins, so the run is reported "flaky" rather than failed.

Clean-checkout check: fresh `git clone` of `b29585b`, `npm ci`, `npm test` →
**615/615**, 4.67 s. Nothing untracked is load-bearing.

## How the unit findings were established

Reading a test tells you what it _says_. To find out what it _catches_, ~180
targeted mutants were run against a pristine `git archive b29585b` copy, each
followed by the full 55-file suite. **Every 🔴 and 🟡 about the unit suite below
is a surviving mutant** — the bug is present and `Tests 615 passed (615)`. I
re-ran three of them myself (T5, T7, T10) to confirm the method reproduces.

That framing matters for the headline: this is an unusually good suite. The
loudness DSP is checked against BS.1770-4 / EBU Tech 3341 reference values, the
SigV4 tests use vectors generated from botocore, the IndexedDB suites correctly
key off ids the store handed back, and **no test anywhere mocks the module it
then asserts on**. The failures cluster in one shape: a test that names the exact
production bug it exists to prevent, and then asserts a field the bug cannot
touch.

The previous review's items are re-checked at the bottom ("Status of TH1–TH8 and T1").

---

# 🔴 High

## 🔴 T1 — the server-sync conflict flake is a real lost-update bug, not a slow test

- **Class:** NEW (the flake is new to this HEAD; the merge rule behind it is older)
- **Where:** `e2e-tests/server-sync.spec.ts:471`; root cause in
  `src/lib/syncUtils.ts:453` and `:481-487` with
  `src/lib/googleDrive/dataAccess.ts:356,383`
- **Finding:**

  The test stages a genuine conflict (local rename "Mine", server rename
  "Theirs" with a stamp 60 s in the future and `_lastSyncTimestamp: 0`) and then
  waits 30 s for the resolution modal. When it fails, the modal is not late: by
  the time the poll starts the app has already decided there is no conflict and
  pushed the merged result back to the server, and no merge afterwards finds one
  either. In the failing probe runs, _no_ `Conflict detection complete` line is
  logged after the reload at all, while the passing runs log two.

  I instrumented a throwaway copy of the test (deleted afterwards) that reads the
  local profile out of IndexedDB at three points and captures the browser
  console. Eight parallel copies, twice: **5/3 and 6/2**. Keyed by each run's
  `serverProfileId` stamp, this is the local profile's `_fieldsModified.name`
  after the rename and after staging:

  ```
  afterSeed sp=…714904 name=…714975   afterStage sp=…714904 name=…714975   PASS
  afterSeed sp=…714940 name=…715022   afterStage sp=…714940 name=…715022   PASS
  afterSeed sp=…714978 name=…715050   afterStage sp=…714978 name=…715050   PASS
  afterSeed sp=…714994 name=…715083   afterStage sp=…714994 name=…715083   PASS
  afterSeed sp=…715022 name=…715092   afterStage sp=…715022 name=…715092   PASS
  afterSeed sp=…715049 name=…715106   afterStage sp=…715049 name=…715106   PASS
  afterSeed sp=…714947 name=…715101   afterStage sp=…714947 name=0         FAIL
  afterSeed sp=…714983 name=0         afterStage sp=…714983 name=0         FAIL
  ```

  **In both failures the local profile's `_fieldsModified.name` had been reset to
  `0`** — the record that _this device_ renamed the profile was erased while the
  renamed value ("Mine") stayed in place. The console from one failing run:

  ```
  …714868 [DB] Updating profile ID=1. Changes: syncType, audioLocation, readOnly, followOnly
  …714948 [DB] Updating profile ID=1. Changes: serverProfileId, serverVersion
  …715095 Conflict detection complete. Found 0 conflicts. Requires manual resolution: false
  …715102 [DB] Updating profile ID=1. Changes: name        ← the test's rename lands, 7 ms later
  …715150 [DB] Updating profile ID=1. Changes: serverVersion, readOnly, serverRole
  …715461 Conflict detection complete. Found 0 conflicts. Requires manual resolution: false
  …715468 [DB] Updating profile ID=1. Changes: serverVersion, readOnly, serverRole
  ```

  The second merge (…715461) runs _after_ the staged PUT and still finds zero
  conflicts.

  The mechanism, in three lines of product code:

  1. `syncUtils.ts:481-487` — after every merge, for a field whose local side
     never stamped anything, the merged blob is written with
     `_fieldsModified[field] = localMod`, and `localMod` is
     `localProfileFields[field] ?? 0`. An unstamped field is persisted as an
     explicit **0**.
  2. `dataAccess.ts:356` — `updateLocalData` pins `name:
existingLocalProfile?.name`, so the local _value_ is never overwritten…
  3. …but `dataAccess.ts:383` puts the whole merged record, so the local
     `_fieldsModified` **is** overwritten. A sync whose local read happened
     before the rename therefore lands `_fieldsModified.name = 0` on top of a
     name the user has already changed.

  `syncUtils.ts:453` then requires `localMod > (remoteData._lastSyncTimestamp ?? 0)`
  for a conflict. With `localMod = 0` and the staged `_lastSyncTimestamp = 0`,
  `0 > 0` is false: no conflict, remote wins, and the client pushes the merged
  blob back.

  Visible in the server database independently of any instrumentation. Every
  staged conflict in `data/e2e.db` splits cleanly on `_lastSyncTimestamp` (the
  test's PUT always writes `0`; only a client push writes a real value):

  ```
  13cf1c88 v3 blobName="Theirs" _lastSync=0             ← retry that passed
  8a3c9671 v4 blobName="Theirs" _lastSync=1786923497614 ← attempt that failed
  c089bd43 v3 blobName="Theirs" _lastSync=0             ← passed
  311a3289 v5 blobName="Theirs" _lastSync=1786922608376 ← failed
  5aaa8bad v5 blobName="Theirs" _lastSync=1786922577443 ← failed
  d4b09366 v4 blobName="Theirs" _lastSync=1786922546402 ← failed
  … 20/20 rows consistent
  ```

  In one probe run the final server blob was named **"Mine"** at v5 — the
  device's rename overwrote the server's, having never been flagged.

- **Impact:** a user renames a profile on device A; a background sync that had
  already read the profile completes a moment later and wipes the "I changed
  this" stamp. Device B's concurrent edit to the same field then wins silently,
  or A's push overwrites B's — no conflict modal either way. This is exactly the
  silent-data-loss class the modal exists to prevent, and the only test that
  would catch it is the one being written off as flaky. It is not restricted to
  `name`: the same writeback runs for every profile field, and
  `compareSyncableItems` (`syncUtils.ts:101`) has the same shape for pads.
- **Fix:** two parts, and the first is product code.
  1. Stop `updateLocalData` widening `_fieldsModified` backwards: merge the
     merged stamps into the _current_ stored record (`Math.max` per field) rather
     than replacing it, and stop `syncUtils.ts:487` writing `0` for a field with
     no stamp — omit the key. Cover it in `src/lib/syncUtils.test.ts`: a merge
     computed against a pre-rename snapshot must not lower a stamp that has since
     been raised.
  2. Only then make the e2e deterministic: after `seedActiveProfileSync`, poll
     the local profile until `_fieldsModified.name` is non-zero _and stays_
     non-zero before staging, and assert it again after staging. That turns 30
     seconds of silence into a one-line failure naming the cause.

---

## 🔴 T2 — the conflict test's "nudge" never runs, so its 30 s poll is a sleep

- **Class:** NEW
- **Where:** `e2e-tests/server-sync.spec.ts:429-451`
- **Finding:** `reloadAndWaitForConflict` claims to nudge the app rather than
  wait on timers:

  ```ts
  const syncNow = page.getByTestId("sync-now");
  if ((await syncNow.count()) > 0 && (await syncNow.isEnabled())) {
    await syncNow.click({ timeout: 1_000 }).catch(() => {});
  }
  ```

  `sync-now` is rendered by `SyncControls.tsx:87`, inside the sync panel behind
  the status chip's disclosure (`SyncStatusChip.tsx:67`, `ProfileCard.tsx:289`).
  The reload closes it. My reproduction's failure snapshot shows the Profile
  Manager open with the card collapsed:

  ```yaml
  - heading "Profile Manager" [level=2]
  - heading "Mine" [level=3]
  - button "ImpAmp server · needs attention Show sync settings"
  ```

  No `sync-now` exists on the page, so `count()` is 0 on all ~30 iterations and
  the `.catch(() => {})` never even gets a chance to fire. The poll degenerates
  into a 30-second sleep that only counts modals.

- **Impact:** the test's own comment says the nudge is what stops it "turning on
  how busy the machine is" — the property it claims is the one it does not have.
  The guard-then-swallow shape (`if (count()) … .catch(() => {})`) cannot report
  that it did nothing, so this stayed invisible.
- **Fix:** expand the disclosure first
  (`await page.getByTestId("sync-status-chip").first().click()`), then click
  `sync-now` unguarded so a missing button fails loudly; or drop the nudge and
  rely on a deterministic trigger. Do not keep a guarded click that can silently
  be a no-op.

---

## 🔴 T3 — "enabling server sync exposes the sharing controls" cannot fail on any machine that has run the suite before

- **Class:** NEW
- **Where:** `e2e-tests/server-sync.spec.ts:305`, assertion at `:331-341`
- **Finding:** the test signs in as a **fixed** address and then makes the one
  assertion that distinguishes "the adopt reached the server" from "a label
  changed locally":

  ```ts
  await signIn(page, await mintSession(request, "ui@example.com"));
  …
  // The profile really reached the server, not just the local UI.
  await expect.poll(async () => (await response.json()).profiles.length, {…})
    .toBeGreaterThan(0);
  ```

  `data/e2e.db` is gitignored (`/data/`) and never reset — no `globalSetup`, no
  teardown, nothing truncates it. Querying it directly:

  ```
  total users 48 · total profiles 117        (before my own runs)

  conflicted@example.com  18 profiles
  ui@example.com           9
  etag@example.com         9
  conflict@example.com     9
  sharer@example.com       9
  linksharer@example.com   9
  resolver@example.com     9
  owner2@example.com       9
  ```

  Eight fixed addresses, one profile each per run — the count _is_ the number of
  times the suite has been run on this machine. Everything created through
  `signedInAs` appears once, as designed. So `profiles.length` is 9 before the
  test acts and the poll's first sample passes. The file's own helper
  `signedInAs` (`:56-65`) exists precisely to prevent this and says so in its doc
  comment; only 4 of 16 sign-ins use it.

- **Impact:** the same shape as the old T1 — an assertion that passes for a reason
  unrelated to what it tests. If adoption stopped writing to the server entirely,
  this test would be green on every developer machine. It is only honest on a
  clean database, i.e. in CI — where the suite also runs serially and so cannot
  see T1. Neither environment tests the whole thing.
- **Fix:** route the remaining twelve literal-address `mintSession` calls through
  `signedInAs`; or capture `const before = profiles.length` and assert
  `toBeGreaterThan(before)`. Add a `globalSetup` that deletes `E2E_DB_PATH` (it is
  already exported from `playwright.config.ts:5` and used by nothing).

---

## 🔴 T4 — `rollbackTo` can be made a complete no-op and the suite stays green

- **Class:** NEW
- **Where:** `src/lib/syncTransitions.test.ts:345-352`, `src/lib/applyTransition.test.ts:148-152`
- **Finding:**

  ```ts
  expect(
    Object.keys(plan.rollbackTo).sort(),
    `${name}: rollback covers the write`,
  ).toEqual(Object.keys(plan.fieldUpdates).sort());
  ```

  compares only **key sets**. The other half —

  ```ts
  expect(r.updateProfile).toHaveBeenLastCalledWith(
    PROFILE_ID,
    expect.objectContaining(plan.rollbackTo),
  );
  ```

  — asserts the runner was handed `plan.rollbackTo`, the plan's own output, so it
  is tautological with respect to values. **No test asserts `rollbackTo` holds the
  profile's _previous_ values.**

  **Mutant:** rewriting `syncTransitions.ts:233-238` so rollback writes the failed
  _new_ values back — a total no-op — → **615/615 pass**.

- **Impact:** a failed `local → server` move leaves `syncType: "server"` written
  while the server never adopted the profile — the exact split state
  `applyTransition.ts:9-13` says the module exists to eliminate.
- **Fix:** assert values for at least one non-trivial move, plus a generic
  invariant over `accepted`: for every key, `rollbackTo[key] === from[key] ?? …`
  and `!== fieldUpdates[key]` wherever the two differ.

---

## 🔴 T5 — the hash-guard test asserts the one field the bug cannot touch

- **Class:** NEW
- **Where:** `src/lib/syncUtils.test.ts:253-277`, guard at `src/lib/syncUtils.ts:579`
- **Finding:** the test's own docblock names the regression precisely —

  ```ts
  // This device: 3 = kick, 7 = snare. The peer numbers *snare* 3, so the
  // sender-keyed map is {3 -> 7} and the untouched local pad holding [3]
  // used to come back holding [7].
  …
  expect(localPad?.audioFileHashes).toEqual([KICK]);
  ```

  — and then asserts `audioFileHashes`. The regression lives in `audioFileIds`.
  Nothing in the translation block (`syncUtils.ts:581-607`) ever writes
  `audioFileHashes`, so the assertion is true whether or not the guard exists.

  **Mutant, which I ran myself:** deleting
  `if (pad.audioFileHashes?.length) return pad;` from `syncUtils.ts:579` →

  ```
   Test Files  55 passed (55)
        Tests  615 passed (615)
  ```

  A probe under the mutant prints `audioFileIds= [7] hashes= ["hash-kick"]` — the
  local kick comes back as a snare, exactly as the docblock describes, and is then
  published to every peer.

- **Impact:** the guard against a pad's sounds being silently swapped during a
  merge is unprotected. This is a "the wrong sound plays live" bug, on a
  soundboard.
- **Fix:** `expect(localPad?.audioFileIds).toEqual([3]);` alongside the hash
  assertion.

---

## 🔴 T6 — four of the five sync-status mirrors are unreachable by the suite

- **Class:** NEW
- **Where:** `src/store/syncStatusStore.test.ts:17-42`; product code at
  `syncStatusStore.ts:151,158,172,176`
- **Finding:** the file's only `mirrorToProfile` test exercises `onWarnings`
  alone. Lines 66-125 drive `syncStatusActions` directly, so they never touch the
  wrapper.

  **Mutant:** deleting all four other `syncStatusActions.patch(...)` calls —
  activity, error, conflicts, conflictData → **615/615 pass**.

- **Impact:** precisely the bug `syncStatusStore.ts:131-136` documents: background
  sync status and errors stay inside `ClientSideInitializer`'s hook instance and
  no profile card sees them. Note this is also the channel T1's conflict has to
  travel down to reach the modal.
- **Fix:** turn the existing test into a table over all five callbacks: fire each,
  assert both that the inner callback ran and that `read(7)` shows the field.

---

## 🔴 T7 — the idle-identity test reimplements the selector instead of calling it

- **Class:** NEW
- **Where:** `src/store/syncStatusStore.test.ts:50-58`
- **Finding:**

  ```ts
  const first =
    useSyncStatusStore.getState().byProfileId.get(1) ?? IDLE_SYNC_STATUS;
  const second =
    useSyncStatusStore.getState().byProfileId.get(1) ?? IDLE_SYNC_STATUS;
  expect(first).toBe(second);
  ```

  The `??` fallback is written **in the test**, so this asserts
  `IDLE_SYNC_STATUS === IDLE_SYNC_STATUS`. `useProfileSyncStatus`
  (`syncStatusStore.ts:113-121`) — the selector whose reference stability actually
  matters — is never called by this file.

  **Mutant, which I ran myself:** spreading both branches of
  `useProfileSyncStatus` into a fresh object → **615/615 pass**.

- **Impact:** the selector is consumed by `ProfileCard.tsx:119` and
  `useProfileSync.ts:130`. Under React 19's `useSyncExternalStore` a new identity
  per call is a "getSnapshot should be cached" infinite re-render — a hard crash
  on the profile list, and the exact failure the frozen `IDLE_SYNC_STATUS` and its
  four-line comment exist to prevent.
- **Fix:** extract the selector as a plain exported function and test it, or add a
  `@vitest-environment jsdom` `renderHook` test comparing identities across
  renders.

---

## 🔴 T8 — the orphan-cleanup race test asserts a disjunction that is true either way — and currently observes the bad state

- **Class:** NEW
- **Where:** `src/lib/db.orphanCleanup.test.ts:65-90`
- **Finding:**

  ```ts
  // Whichever transaction goes first, the two must agree: ... never a pad
  // naming a file that is gone.
  const stillThere = await getAudioFile(arriving);
  if (cleanup.deletedCount > 0) {
    expect(stillThere).toBeUndefined();
  } else {
    expect(stillThere).toBeDefined();
  }
  ```

  The comment states the invariant and the test then **never looks at the pad**.
  Both branches are satisfiable, so it cannot fail.

  Proved two ways. Mutating `db.ts:923` to `separateOrphans(allAudioKeys, [])` —
  cleanup forgetting pad references entirely — and running this test alone
  (`-t "concurrent import"`) → passes. (The file's other three tests do catch that
  mutant, so the blindness is confined to this `it`.) And a probe on **unmutated**
  code, five runs, prints:

  ```
  PROBE deletedCount= 1 padNamesFile= true fileExists= false
  ```

  Under this test's own conditions the pad deterministically ends up naming a
  deleted file — the invariant the comment names — and the test calls it a pass.

- **Impact:** the one test guarding "an import racing a cleanup never loses audio"
  is currently watching that happen and reporting success.
- **Fix:** drop the branch and assert the invariant directly — read the pads back
  and assert no pad references an id `getAudioFile` cannot resolve. That will also
  surface the separate question of whether the single-transaction cleanup really
  closes the window against a concurrent pad write.

---

## 🔴 T9 — proof-of-possession: the offset arithmetic is never executed, and the test named for it cannot detect that

- **Class:** NEW
- **Where:** `src/lib/serverAudio/proofOfPossession.test.ts:50-56`;
  `src/app/api/audio/audio.api.test.ts:49`; product code
  `proofOfPossession.ts:66-67`
- **Finding:** two independent blind spots on the same function.

  **(a) The range assertion is a single-fixture coincidence.**

  ```ts
  const size = 300 * 1024;
  const range = proofRangeFor(HASH, size);
  expect(range.offset).toBeGreaterThanOrEqual(0); // unfalsifiable: it's a modulo
  expect(range.offset + range.length).toBeLessThanOrEqual(size);
  ```

  **Mutant:** `proofOfPossession.ts:66` `const span = sizeBytes - PROOF_WINDOW_BYTES`
  → `+`, which lets the window run past EOF → **615/615 pass**. The single
  hardcoded `HASH = "c0ffee".padEnd(64,"a")` happens to land inside; **370 of 1000
  random hashes would push the window past the end of the file.**

  **(b) Every integration test runs the degenerate branch.**
  `audio.api.test.ts:49` sets `maxObjectBytes: 8 * KB` while `PROOF_WINDOW_BYTES`
  is 64 KB, so `proofRangeFor` _always_ returns `{offset: 0, length: wholeFile}`
  and line 67 is the module's only uncovered line.

  **Mutant:** replacing line 67 with `return { offset: 0, length: PROOF_WINDOW_BYTES }`
  — deleting the anchoring the docblock spends a paragraph justifying ("a
  container header can be reconstructed from metadata alone") → **615/615 pass**.

- **Impact:** the security property silently degrades to "hash the first 64 KB".
  Worse in practice: an off-by-one between the offset the server sends and the one
  it reads back would refuse **every** legitimate second uploader of any file over
  64 KB — essentially every real audio file — with CI green, because client and
  server agree today only through both computing `offset: 0`. Commit `886832f`
  ("require proof of the bytes, not just knowledge of the hash") is the change
  this is meant to protect.
- **Fix:** property-test `proofRangeFor` over many random hashes and sizes
  (`0 <= offset <= size - 65536`, `length === 65536`, deterministic, different
  hashes → different offsets); and add one integration config with
  `maxObjectBytes > 64 KB` doing a real dedup commit of a ~200 KB file.

---

## 🔴 T10 — the real S3 `getRange` — the read the whole proof check depends on — has no tests

- **Class:** NEW
- **Where:** `src/lib/server/s3/client.test.ts` (no `describe` for `getRange`);
  product code `client.ts:157-159`
- **Finding:** the suite has blocks for `objectKeyForHash`, `presignUpload`,
  `presignDownload`, `head` and `remove`, and **none for `getRange`**, the fifth
  method of the interface. The only `getRange` any test executes is
  `fakeObjectStore.ts:39-43`, a different eleven-line implementation slicing an
  in-memory `Map` — so the integration tests prove the fake is consistent with the
  test's own `proofFor()` helper. A closed loop between two pieces of test code.

  **Mutant, which I ran myself:** replacing

  ```ts
  return response.status === 200 ? body.slice(offset, offset + length) : body;
  ```

  with a bare `return body;` — the "S3 ignored the Range header" case the comment
  two lines above explicitly anticipates → **615/615 pass**.

- **Impact:** Wasabi answering 200 instead of 206 makes every dedup commit 403
  with "Send the proof from the upload-url response to claim it." Users cannot
  host any file someone else already has. The `404 → null` handling and the
  `length <= 0` guard are likewise unexercised.
- **Fix:** add `describe("getRange")` using the existing `respond()` seam extended
  to carry a body: assert the `Range: bytes=…` header, a 206 body returned
  verbatim, a 200 body sliced, 404 → `null`, 403 → throws.

---

# 🟡 Medium

## 🟡 T11 — unit coverage is 30 %, and the repo cannot measure it

- **Class:** RECURRENCE (TH1, partially addressed)
- **Where:** measured with `@vitest/coverage-v8@4.1.10`, installed with
  `--no-save` because **there is no coverage provider in `devDependencies`, no
  `coverage` block in `vitest.config.ts`, and no coverage step in CI.**
- **Finding:** 29.92 % of lines. By directory, worst first (uncovered / total):

  ```
   777 /  777   0.0%  src/components/profiles
   701 / 1441  51.4%  src/lib/audio
   696 /  827  15.8%  src/lib/googleDrive
   568 /  568   0.0%  src/components/modals
   351 /  351   0.0%  src/store/profileStore.ts
   350 /  604  42.1%  src/lib/db.ts
   264 /  264   0.0%  src/hooks/useKeyboardListener.ts
   211 /  491  57.0%  src/lib/importExport.ts
   183 /  183   0.0%  src/components/ClientSideInitializer.tsx
   175 /  175   0.0%  src/components/WaveformTrimmer.tsx
  ```

  The six files TH1 named, today:

  ```
      0%  351 lines  src/store/profileStore.ts
      0%  308        src/lib/googleDrive/api.ts
      0%  294        src/lib/googleDrive/sync.ts
      0%  264        src/hooks/useKeyboardListener.ts
   1.94%  154        src/lib/audio/decoder.ts
  36.84%  171        src/lib/audio/controls.ts     ← was 0, now covered
  42.05%  604        src/lib/db.ts                 ← was 0, now covered
  ```

  Two of six addressed, four untouched. No Google Drive path on this branch has
  been exercised against the live API, and none is exercised in the unit suite
  either — `googleDrive/api.ts` + `sync.ts` are 602 lines at 0 %.

  Also 0 % and worth naming because they are server-side and network-reachable:
  `app/api/auth/google/exchange`, `app/api/auth/google/refresh`,
  `app/api/drive/public-file`, `app/api/drive/public-audio`,
  `app/api/profiles/[id]/events` (SSE), and `lib/serverSync/api.ts` (the whole
  HTTP client, 59 lines).

- **Impact:** "615 tests" reads as broad cover; it is 30 %, concentrated in
  `lib/server`, `loudness` and `syncUtils`, and absent from every store, hook and
  component. Nothing measures it, so it can only drift down.
- **Fix:** add `@vitest/coverage-v8` to `devDependencies`, a `coverage` block to
  `vitest.config.ts`, and a `test:coverage` script. Then set a **floor at today's
  number** in CI and raise it deliberately — a ratchet, not a target.

---

## 🟡 T12 — the legacy import router and V1 import have no unit test at all

- **Class:** DEFERRED (recorded in the plan at 5.1: "`importImpamp2Profile` is
  still uncovered")
- **Where:** `src/lib/importExport.ts:1001` (`importMultipleProfiles`), `:1076`
  (`importImpamp2Profile`), `:1899` (`detectImportFormat`), `:179` (`base64ToBlob`)
- **Finding:** v8 function-level coverage lists these as never entered:

  ```
  UNCOVERED fn line   179 base64ToBlob
  UNCOVERED fn line  1001 importMultipleProfiles
  UNCOVERED fn line  1076 importImpamp2Profile
  UNCOVERED fn line  1899 detectImportFormat
  ```

  `detectImportFormat` is the router every dropped file goes through
  (`ProfileManager.tsx:842-844`): zip vs V2-single vs V1-multi vs impamp2-legacy
  vs too-large. Its "too large" and "unknown" branches have no test of any kind.

  There **is** an e2e smoke test for the legacy path
  (`e2e-tests/profiles.spec.ts:126`) driving a 1-page / 1-pad / 1-tiny-WAV payload
  through the real file input. That is one happy path through ~215 lines; the
  base64 decode failure, multi-page mapping, pad-key mapping and the
  `deleteProfile` cleanup on partial failure are unexercised.

- **Impact:** the legacy importer meets the most malformed input of anything in
  the app (files exported by a different program, years ago) and is the least
  defended.
- **Fix:** `importExport.zip.test.ts` is the model — same `fake-indexeddb`
  harness. Add `importExport.legacy.test.ts` covering `detectImportFormat` over
  all six return values, and `importImpamp2Profile` over multi-page, a corrupt
  `file:` payload, a pad with no file, and the cleanup path.

---

## 🟡 T13 — the E2E server database is shared, cumulative and unbounded

- **Class:** NEW
- **Where:** `e2e-tests/env.js:11`; `playwright.config.ts` has no `globalSetup`
- **Finding:** `E2E_DB_PATH` resolves to `data/e2e.db` and nothing ever resets it:

  ```
  data/e2e.db      152 KB   48 users, 117 profiles   (68 / 146 after my runs)
  data/e2e.db-wal  4.1 MB
  ```

  Twelve of sixteen sign-ins use a fixed address. `stageServerConflict` then picks
  its target with `list.profiles[0].id` (`server-sync.spec.ts:387`) — the most
  recently updated of eighteen. Right today, one slow adopt away from staging a
  conflict on a profile from three days ago and failing for a reason nobody would
  find.

- **Impact:** local and CI runs test different databases. The assertions needing a
  clean slate (T3) are meaningful only in CI; the ones depending on ordering are
  only exercised locally. The suite gets slower and less deterministic the more it
  is run.
- **Fix:** a `globalSetup` unlinking `E2E_DB_PATH` and its `-wal`/`-shm` siblings,
  plus `signedInAs` everywhere. Both small; the second is already written.

---

## 🟡 T14 — nothing closes the merge → write → merge loop, which is why T1 had no unit-level guard

- **Class:** NEW
- **Where:** `src/lib/serverSync/sync.test.ts:15-17,39`;
  `src/lib/googleDrive/dataAccess.{gain,hashKeyed,wire}.test.ts`
- **Finding:** the sync-loop suite is honestly scoped — its header says "the merge
  itself (`detectProfileConflicts`) runs for real; only the network and IndexedDB
  edges are stubbed", and that is exactly what it does. But the stubbed edge is the
  one T1 lives on:

  ```ts
  const dataAccessMocks = vi.hoisted(() => ({
    getLocalProfileSyncData: vi.fn(),
    updateLocalData: vi.fn(), // ← the write-back is a no-op
  }));
  ```

  `getLocalProfileSyncData` returns a fixture rather than reading back what
  `updateLocalData` last wrote, so a merge is never fed the state a previous merge
  persisted. Three suites _do_ call the real `updateLocalData` against
  `fake-indexeddb`, but a grep for `_fieldsModified` across all 55 test files
  finds no assertion anywhere about what it stores there:

  ```
  profileWire.test.ts:29,71     — the wire shape, not the write-back
  importExport.zip.test.ts:178  — the import path
  syncUtils.test.ts:45          — an input fixture
  ```

  This is not over-mocking in the "tests the mock" sense; it is a seam no suite
  spans. Every piece is tested and the join is not.

- **Impact:** the class of bug where a merge writes a _worse_ record than it read —
  stamps lowered, a field's provenance erased — is structurally invisible to the
  unit suite. T1 is one instance, and it surfaced only as a 30-second timeout in
  one e2e test.
- **Fix:** one integration-shaped suite using `fake-indexeddb` and the real
  `dataAccess`: seed a profile, run `detectProfileConflicts` + `updateLocalData`
  against a stale local snapshot, read the profile back, and assert no
  `_fieldsModified` entry went down and none was created as `0`. That single test
  would have failed on T1.

---

## 🟡 T15 — `unmeasured: false` on the measured path is never asserted

- **Class:** NEW
- **Where:** `src/lib/audio/loudness/gain.test.ts:103-109`;
  `overview.test.ts:34-63`
- **Finding:** the suite asserts `unmeasured === true` for a file with no
  analysis. Nothing asserts it is `false` for a measured one, and `overview`
  builds its `SoundRow` fixtures by hand with `unmeasured: false` hardcoded, so
  the join between the two is untested.

  **Mutant:** `gain.ts:92` `unmeasured: false` → `true` → **615/615 pass**.

- **Impact:** `filterProblemRows` excludes unmeasured rows
  (`overview.test.ts:209-217`), so the Loudness Overview's "problems only" view
  would silently show **nothing at all**, for every sound, with a green suite.
  From the same campaign: `peakLimited`, `boostCapped`, `willClip` and `estimated`
  in the unmeasured branch (`gain.ts:38-42`) all survive inversion, and
  `boostCapped: canNormalise && …` → `||` (`gain.ts:88`) survives — a "Boost
  capped" / "Will clip" badge lighting up on every sound with normalisation off
  would fail nothing.
- **Fix:** add `expect(r.unmeasured).toBe(false)` to the measured tests, and build
  at least one `overview` row through `resolveGain` rather than by hand.

---

## 🟡 T16 — the pin reference-count decrement is never exercised

- **Class:** NEW
- **Where:** `src/lib/audio/cache.test.ts:73-91`; product code `cache.ts:343`
- **Finding:** the file has "keeps the pin until every holder has released it"
  (pin ×2, unpin ×1) and "makes a buffer evictable again once fully unpinned"
  (pin ×1, unpin ×1). **The sequence pin ×2 → unpin ×2 appears nowhere.**

  **Mutant:** `pinnedAudioFileIds.set(audioFileId, count - 1)` → `count + 1` →
  **615/615 pass** (all 8 tests in `cache.test.ts` green).

- **Impact:** two armed pads sharing a sound never release it; the buffer becomes
  permanently unevictable. `performCleanup` even has a `console.warn` for "could
  not reach its target: N pinned entries" — the symptom — on a cache whose whole
  purpose is bounding memory on a live board. Broader signal: **35 of 51 mutants
  in `cache.ts` survive**, including `getAudioCacheStats`'s decode counters,
  `totalMemoryUsage` accounting in `clearCachedAudioBuffer`, and the entire
  30-second cleanup interval.
- **Fix:** one test — `pin, pin, unpin, unpin, expect(isAudioBufferPinned(1)).toBe(false)`.

---

## 🟡 T17 — `role = 'editor'` in `profileMayServeHash` is untested, so a viewer's uploads would be served

- **Class:** NEW
- **Where:** `src/lib/server/audio.ts:174`; tests at `audio.api.test.ts:736,758`
- **Finding:** the editor case and the no-grant case are covered; the **viewer**
  holding a reference is not.

  **Mutant:** deleting `AND s.role = 'editor'` → **615/615 pass**.

- **Impact:** a viewer of a profile gets any sound they hold served through it —
  the "the blob is the caller's own word" escalation the surrounding comment says
  this clause closes, half-open again.
- **Fix:** a sibling test sharing as `"viewer"` instead of `"editor"`, expecting 404.

---

## 🟡 T18 — the `secure` cookie flag is asserted nowhere in the repo

- **Class:** NEW
- **Where:** `src/lib/server/session.test.ts:91-96`
- **Finding:** the test is named "marks the cookie HttpOnly and same-site" and
  asserts `httpOnly`, `sameSite` and `path`. `session.ts` also sets
  `secure: process.env.NODE_ENV === "production"` and `maxAge`; a grep for
  `secure` across every `*.test.ts` returns nothing.

  **Mutant:** forcing `secure: false` → **615/615 pass**.

- **Impact:** the session cookie could ship without `Secure` in production and no
  test would notice. A test promising cookie hardening delivers three of four
  attributes.
- **Fix:** assert `maxAge`, plus two cases setting and restoring `NODE_ENV`.

---

## 🟡 T19 — `syncReconcile`'s idempotence test hand-feeds the repaired fixture

- **Class:** NEW
- **Where:** `src/lib/syncReconcile.test.ts:124-132`
- **Finding:** `updateProfile` is a mock, so the first call changes nothing; the
  second returns 0 only because the test swaps in an already-repaired fixture by
  hand. It is a restatement of the case at line 46 dressed as idempotence — a
  repair writing the _wrong_ fields would still "find nothing on a second run".
- **Impact:** the reconciler's "safe to run repeatedly" property is unverified,
  and it runs on every load.
- **Fix:** make the fake `updateProfile` apply its patch to a mutable array that
  `getAllProfiles` reads back; run twice against the same store and assert 1 then 0.

---

## 🟡 T20 — `profileWire`'s allow-list is guarded only by a type check no _named_ gate runs

- **Class:** NEW
- **Where:** `src/lib/profileWire.test.ts:61-75`; `profileWire.ts:92-98`;
  `.github/workflows/ci.yml`
- **Finding:** the test asserts 10 of `SHAREABLE_PROFILE_FIELDS`' 21 entries. The
  rest leans on the compile-time `_everyProfileFieldIsClassified` assertion.

  **Mutant:** deleting `"readOnly"`, `"audioLocation"`, `"followOnly"` and
  `"serverVersion"` from the list → **615/615 pass**. (Deleting the _content_
  fields is caught.)

  Correcting a stronger version of this claim: CI _does_ type-check, but only as a
  side effect. There is no `tsc --noEmit` in `ci.yml`, `hk.pkl` or `package.json`
  — but the `e2e` job runs `npx playwright test`, whose `webServer` runs
  `npm run build`, and `next.config.ts` sets no `typescript.ignoreBuildErrors`, so
  Next type-checks there. Verified: `npx tsc --noEmit` is clean on this HEAD.

- **Impact:** the guard holds in CI, but only in the slowest job and for a reason
  nothing states. A developer running `npm test && npm run lint` — the two commands
  the `unit` job runs, and the two a pre-commit hook would run — sees green with a
  type error, and the pre-commit hook has no tsc step either. Since the point of
  `profileWire.ts` is that "adding a field to `Profile` does not put it on the
  wire", the enforcement should be nearer to hand than a production build.
- **Fix:** assert structurally —
  `expect(Object.keys(toWireProfile(fullProfile())).sort()).toEqual([...SHAREABLE_PROFILE_FIELDS].sort())`
  — and add an explicit `tsc --noEmit` step to the `unit` job and to `hk.pkl`.

---

## 🟡 T21 — `expect(response.status).not.toBe(200)` accepts any failure, including the wrong one

- **Class:** NEW
- **Where:** `src/app/api/audio/audio.api.test.ts:733`
- **Finding:** the test ("re-checks the quota when the bytes behind a held hash
  change") does have teeth against its target, but the assertion accepts 400, 403,
  404 and 500 equally where the right answer is 413 `too_large`. Every sibling
  test in the file asserts an exact status; this is the one that does not.
- **Impact:** the quota refusal could become an auth failure or a 500 and this
  would still pass, hiding a regression as an unchanged green.
- **Fix:** `toBe(413)` plus the `reason` field.

---

## 🟡 T22 — six more named controls whose intent is documented and whose behaviour is unasserted

- **Class:** NEW
- **Where / finding** (each mutation-proved; grouped because the fix is the same
  shape):
  - **`resolveObjectStore()`'s production branch and the 501/507 responses never
    execute** (`audioRequests.ts:39-46,113,190`). `setObjectStoreForTests`
    short-circuits in every test, so nothing ever reaches `audioHostingDisabled()`
    — the 501 the _default_ deployment returns from every audio route. Changing
    the `global_cap` refusal from 507 to **200 OK** leaves the suite green.
  - **The 8 MB profile-body cap has no test at all** (`profileRequests.ts:101,111,118`).
    `profiles.api.test.ts` covers 400/428/409/403/304/404 — every status except the
    DoS bound the docblock says the module exists to add.
  - **Both `db.ts` rollback paths are untested** (`db.ts:226-227`, `326-327`).
    `migration3.test.ts:1-9` opens by arguing "a migration that throws also takes
    the whole app down at boot" and then tests only migrations that succeed.
  - **The download-URL TTL default is untested and not in the env reset list.**
    `config.test.ts:12-17`'s `TOUCHED` omits `IMPAMP_AUDIO_UPLOAD_URL_TTL` /
    `IMPAMP_AUDIO_DOWNLOAD_URL_TTL`, so `beforeEach` does not clear them; changing
    the default from `5 * 60` to `24 * 60 * 60` — the value `config.ts:76-79`
    argues against, since "the TTL _is_ the revocation lag" — leaves the suite green.
  - **`measureRange`'s partial-block weighting is only tested on a constant
    signal.** `query.ts:101` `overlap = min(…) - max(…)` → `+` survives, because
    the "sub-400 ms estimated" test (`query.test.ts:77-85`) uses a constant tone
    where any weighting gives the same answer. Block-boundary inclusion
    (`query.ts:80`) and the finite side of the absolute gate (`query.ts:116`)
    survive too — the gate is only ever exercised with digital silence.
  - **`controls.ts`'s `currentAudioIndex: playingIndex >= 0 ? …` → `> 0` survives**,
    so `controls.fallback.test.ts:133-139` never covers index 0 — the first sound
    of a multi-sound pad would report the wrong index to the Active Tracks panel.
- **Fix:** one targeted test each; none is more than a few lines.

---

## 🟡 T23 — `getArmedTrackNames` is bound to Tailwind classes and reads without waiting

- **Class:** RECURRENCE (TH5, partially fixed)
- **Where:** `e2e-tests/armed-tracks.spec.ts:49-80`
- **Finding:** TH5's panel-level fix landed — the helper now waits for the panel
  with a retrying `toBeVisible`. The row-level read did not:

  ```ts
  const trackItems = panel.locator(".font-medium.text-gray-800");
  …
  const count = await trackItems.count();   // :67 — the one call with no auto-wait
  ```

  `count()` does not retry, so a panel visible before its rows paint yields a
  short list, and every negative assertion built on it — `not.toContain` at
  `:297, :370, :379, :380` and `toEqual([])` at `:669` — passes for the wrong
  reason. And the selector is a Tailwind class pair while the component beside it
  already ships `data-testid="armed-track-item"` (`TrackItem.tsx:131`); a restyle
  makes the helper return `[]` forever, at which point the positive assertions
  fail loudly (fine) and the negative ones go quietly green.

- **Impact:** five assertions about tracks having been _removed_ from the queue can
  pass without the removal having happened.
- **Fix:** `panel.getByTestId("armed-track-item")`, and at the three call sites
  that know the expected number, `await expect(trackItems).toHaveCount(n)` before
  reading. Same file, `clickRemoveOnArmedTrack` (`:143-160`) builds
  `:has-text(name)` then `.first()`, which resolves to the outermost matching
  ancestor — use the `Remove … from queue` accessible name from `TrackItem.tsx:246`.

---

## 🟡 T24 — three load-bearing sleeps remain, and the worst guards the follow feature's headline promise

- **Class:** RECURRENCE (TH3, partially fixed — ten sleeps became six)
- **Where:** full inventory:

  | file:line                     | ms   | guards                                          | verdict                              |
  | ----------------------------- | ---- | ----------------------------------------------- | ------------------------------------ |
  | `follow-profiles.spec.ts:34`  | 300  | `toHaveCount(0)` on `EDIT MODE` at `:74`, `:96` | load-bearing                         |
  | `follow-profiles.spec.ts:178` | 2000 | `not.toContainText(name)` at `:179`             | load-bearing, justified in a comment |
  | `audio-playback.spec.ts:339`  | 200  | `not.toContainText(thirdSound)` at `:343`       | load-bearing                         |
  | `audio-playback.spec.ts:265`  | 200  | "still playing" after a second click            | load-bearing in disguise             |
  | `audio-playback.spec.ts:294`  | 200  | "still playing" after a second click            | load-bearing in disguise             |
  | `audio-playback.spec.ts:332`  | 100  | positive `toBeVisible`                          | benign                               |

- **Finding:** `pad-disable.spec.ts` got the good fix — its three sleeps were
  replaced by a positive `playControlPad` event (`:35-50`), the pattern the rest
  should adopt. What remains:

  ```ts
  async function tryToEnterEditMode(page: Page) {
    await page.keyboard.down("Shift");
    await page.waitForTimeout(300);
  }
  ```

  300 ms is the entire window in which "the follow gate stopped blocking edit
  mode" can be caught, and `test-helpers.ts:48-55` says in so many words that the
  Shift→edit-mode latency is _not_ fixed, because the keyboard listener detaches
  and reattaches as state changes. Under ten workers a regression that lets edit
  mode on at 350 ms is green.

- **Impact:** two tests whose whole job is "a followed profile refuses edit mode"
  are guarded by a guess at a latency the codebase already says is variable.
- **Fix:** the `playControlPad` idiom — after `keyboard.down("Shift")` wait for a
  positive observable consequence of the keypress having been processed, then
  assert the absence. For `audio-playback.spec.ts:265/294`, read the track's
  `startTime` through the existing test hooks and assert it did or did not move.

---

## 🟡 T25 — three backup-reminder negatives resolve before the thing they check has rendered

- **Class:** NEW
- **Where:** `e2e-tests/backup-reminders.spec.ts:234, 260, 305`
- **Finding:**

  ```ts
  await page.reload();
  await waitForAppReady(page);
  …
  await expect(reminderBanner).toBeHidden();
  ```

  `waitForAppReady` (`test-helpers.ts:30-45`) returns as soon as a profile is
  active and one bank tab is visible. The reminder banner is decided after that,
  from `lastBackedUpAt`. `toBeHidden()` resolves on its first poll, so a
  regression showing the banner one render later passes. These are exactly the
  three "the reminder does not appear" cases. The two that go through
  `closeProfileManager` (`:287`, `:322`) are a real round-trip and are sound.

- **Impact:** the reminder-suppression rules are asserted by tests that would pass
  if the rules were removed and the banner merely rendered a frame late.
- **Fix:** assert a positive marker that only exists once the reminder decision has
  been made — the simplest is a permanently-rendered wrapper testid on the banner's
  slot — then assert the banner itself is absent.

---

## 🟡 T26 — `openProfileManager` can silently do nothing, and there are three of it

- **Class:** RECURRENCE (TH8, partially fixed)
- **Where:** `e2e-tests/test-helpers.ts:548-555`; copies at
  `server-sync.spec.ts:308-313` (verbatim, the one the previous review named) and
  `backup-reminders.spec.ts:118-129` (a shadowing second implementation);
  hand-rolled again at `profiles.spec.ts:33` and `:163`,
  `import-export.spec.ts:145`, `import-defaults.spec.ts:256`, `loudness.spec.ts:30`
- **Finding:**

  ```ts
  const manage = page.getByText(/Manage Profiles/i).first();
  if (await manage.count()) await manage.click();
  ```

  `count()` does not auto-wait and the dropdown renders on a React state update
  after `click()` resolves, so a zero count is live under load — and the guard
  turns "the menu had not painted" into "silently skip opening the manager".
  Callers assert afterwards, so this fails red rather than green, but with a
  misleading error (`sync-status-chip not found`) rather than the real cause. Also
  `getByRole("button", { name: /Profile/i }).first()` at `:549`: inside an open
  Profile Manager that regex matches "Edit Profile", "Create Profile" and "Use
  This Profile".

- **Impact:** wasted debugging on a misattributed failure, and one more instance of
  the guard-then-skip shape T2 shows can hide a no-op entirely.
- **Fix:** `await page.getByRole("menuitem", { name: "Manage Profiles" }).click();`
  — auto-waits, no guard, and already what `profiles.spec.ts:163` does. Then delete
  the two duplicate implementations and adopt the helper at the five hand-rolled sites.

---

## 🟡 T27 — `retries: 2` on the conflict describe is absorbing a routine failure, not a rare one

- **Class:** NEW
- **Where:** `e2e-tests/server-sync.spec.ts:469` (rationale at `:455-468`)
- **Finding:** the comment argues a retry "cannot hide a regression: if conflicts
  stopped surfacing, every attempt would fail". True of a _total_ regression, false
  of a partial one — and the retry is firing routinely.
  `conflicted@example.com` has 18 profiles against `resolver@example.com`'s 9, and
  both tests run `stageServerConflict` exactly once per attempt, so the first test
  has averaged roughly two attempts per run. The wall-clock spacing shows it:

  ```
  23:22:26 → 23:22:57 → 23:23:28   (31 s apart: three attempts of one test)
  ```

  My own reproduction: attempt 1 failed, retry 1 passed, reported "1 flaky".

- **Impact:** a newly introduced 50 % flake in either conflict test would be
  invisible — it would land inside a retry budget a permanent flake is already
  consuming. The retry has stopped being a backstop and become the mechanism by
  which the suite is green.
- **Fix:** fix T1 first; the retry should then never fire. Keep it if you like, but
  make it observable: fail when `testInfo.retry > 0` locally, or drop to
  `retries: 1` so the flake rate has somewhere to show.

---

## 🟡 T28 — two overlay-keyboard assertions check a state that was already true

- **Class:** NEW (the file is new, from commit `6a2ce80`)
- **Where:** `e2e-tests/overlay-keyboard.spec.ts:42-44` and `:66-71`
- **Finding:**

  ```ts
  await page.keyboard.press("q");
  await expectNothingPlaying(page); // expect("Nothing playing").toBeVisible()
  ```

  Nothing was ever played in this test, so "Nothing playing" is visible before the
  keypress and `toBeVisible()` succeeds on its first poll. Same at `:66-71`:
  playback is running, so "Nothing playing" is already hidden and `toBeHidden()`
  returns immediately.

  In fairness, the plan records these as "failing 3/3 against the old code"
  (`6a2ce80`), so the leak was fast enough to be caught then — the assertions are
  not tautological, they are racing. But nothing bounds the window, and the third
  test in the file (`:74-93`) shows the right shape: a `Close` click and its
  `toBeHidden` sit between the keypress and the check.

- **Impact:** an overlay-keyboard regression that starts playback a few hundred
  milliseconds late — under the load this suite generates — passes.
- **Fix:** press `q` behind the overlay, then close the overlay and press `q` again
  and wait for _that_ to play; by the time the second is audible the leaked first
  would be too. For the Escape case, take a second observable action after pressing
  Escape and only then assert the track is still in `active-tracks-panel`.

---

## 🟡 T29 — `docs/cross-browser-e2e.md` still describes a 64-test suite

- **Class:** RECURRENCE (TH7 — the stale table was fixed in `e2e-tests/README.md`
  and the same rot is one directory away)
- **Where:** `docs/cross-browser-e2e.md:20-25`
- **Finding:** the table records `chromium 64 passed / firefox 64 locally, 17
failed in CI / webkit 38 failed`, measured "on 2026-08-13 (commit `f0486eb`)".
  The suite is now **126** chromium tests and `e2e-tests/README.md` was updated to
  say so. 64 + 38 = 102, so the WebKit count cannot be current either: 62 further
  tests exist that the doc has no view on.
- **Impact:** the brief asked whether the stated reasons still hold. The **reasons
  do** — both are properties of the harness rather than the app (Playwright's Linux
  WebKit rejecting every Blob written to IndexedDB; no audio device on GitHub's
  runner), and nothing in the 40-commit fix pass touched Blob storage or audio
  output. But the numbers are what a reader uses to decide whether a red
  cross-browser run matches expectations, and they are wrong by roughly a quarter
  of the suite — precisely the failure mode the README's own replacement note
  describes.
- **Fix:** either re-run both projects and restate the table with today's counts
  and a new commit stamp, or delete the counts and keep only the causes. The causes
  are the durable part.

---

## 🟡 T30 — CI is the most forgiving configuration, so it cannot see this suite's flake class

- **Class:** NEW
- **Where:** `playwright.config.ts:31-32`; `.github/workflows/ci.yml` job `e2e`
- **Finding:** `retries: process.env.CI ? 2 : 0` and
  `workers: process.env.CI ? 1 : undefined`. CI runs **serially with two retries**;
  a developer runs **ten workers with none**. The config's own comments attribute
  every historical flake in this suite to parallel load, and T1 only reproduces
  under it.
- **Impact:** a green CI run is evidence that the suite is green when nothing
  competes with it, not that it is healthy. Conversely the developer sees flakes CI
  never will, which is how a real bug (T1) came to be read as noise. There is also
  no coverage gate and no flake reporting, so nothing in CI trends.
- **Fix:** run CI e2e with at least 2 workers (GitHub runners have 4 vCPUs), and
  surface retries — fail on any test that needed one, or at minimum print the flaky
  list into the job summary so a rising rate is visible.

---

## 🟡 T31 — what has no end-to-end exercise at all

- **Class:** NEW
- **Where:** `e2e-tests/` versus the feature list in `CLAUDE.md`
- **Finding**, ranked by what would hurt most if it broke silently:
  1. **Hosted audio (S3/Wasabi) has no happy path.** `server-sync.spec.ts:768-806`
     only asserts that an _unconfigured_ deployment returns 501/404. The presigned
     PUT, the commit, and the "quota is charged from the size the bucket reports,
     never the size the client claimed" rule that `CLAUDE.md` names as the
     security-critical invariant are never exercised together. Compounded by T9 and
     T10, which show the unit-level cover of the same path is also hollow.
  2. **SSE is never opened by a test.** `/api/profiles/[id]/events` is 0 % in unit
     coverage and no spec subscribes — `reloadAndWaitForConflict` explicitly
     _avoids_ SSE and reloads instead. The live-collaboration promise and the
     single-instance deployment constraint both rest on a path with no test at all.
  3. **Share revocation.** `DELETE /api/profiles/[id]/shares/[shareId]` has no
     test; shares are created and read, never revoked. A revoked link that still
     reads is a silent data leak.
  4. **Trimming / `WaveformTrimmer`.** 175 lines at 0 %, and no spec references
     `edit-pad-trim-sound-*`. Trimming feeds the per-block-mean-square loudness
     query, so a regression here changes what is heard.
  5. **Admin authorisation above the 404 boundary.** No admin account is ever
     minted, so `/api/admin/*` is only asserted to 404 for a non-admin.
  6. **Emergency-bank playback.** `edit-mode.spec.ts:130-178` marks a bank and
     checks the red dot; nothing ever presses Enter to play an emergency sound.
- **Fix:** (1) and (2) are worth a spec each — a fake S3 endpoint for the first, an
  `EventSource` assertion for the second. (3) is four lines added to the existing
  sharing spec.

---

# 🟢 Low

## 🟢 T32 — fixed temp-file paths collide across parallel workers

- **Class:** NEW
- **Where:** `e2e-tests/test-helpers.ts:130-134`
- **Finding:** generated WAVs are written to `os.tmpdir()/<fileName>.wav` with no
  uniquifier. `"Accordion_BassNote_01"` is used by both `audio-playback.spec.ts:61`
  and `search-modal.spec.ts:20`, which run concurrently at `fullyParallel` with ten
  workers, writing and reading the same path.
- **Impact:** harmless today because the contents are deterministic, but a torn
  read during `setInputFiles` would present as an unexplainable decode failure.
- **Fix:** suffix with the worker index or a nonce.

---

## 🟢 T33 — assertions that cannot fail, individually harmless

- **Class:** NEW
- **Where / finding:**
  - `src/lib/server/db.test.ts:179` — `expect(owned.id).not.toBe(shared.id)`
    compares two `randomUUID()`s. Unrelated to the listing test it is attached to.
  - `src/lib/syncUtils.test.ts:85` — `expect(result.requiresManualResolution).toBe(false)`
    with `localMod === LAST_SYNC === 1000` can never fail, since the predicate at
    `syncUtils.ts:453` needs `localMod > 1000`. The value assertion above it is
    load-bearing, so the test still earns its place.
  - `src/store/syncStatusStore.test.ts:44-48` reads a map `beforeEach` just cleared,
    then asserts two literals off a frozen constant.
  - `src/lib/audio/cache.test.ts:94` — `expect(() => unpinAudioBuffer(99)).not.toThrow()`
    is vacuous alone; line 95 rescues it.
  - `src/lib/server/migration3.test.ts:105` — `toBeGreaterThanOrEqual(3)` is
    effectively "didn't throw"; `toBe(MIGRATIONS.length)` would catch a silent no-op.
  - `src/lib/importExport.loudness.test.ts:6-35` — the `byteOffset` branch of
    `floatsToBase64` is uncovered (fixtures are always exact-size). Defensive only.
  - `src/lib/syncState.test.ts:34` — comment says "six legal, healthy states" above
    a four-entry map. Fix the comment.
  - `audio.api.test.ts:192,514,622` — `toContain("upload=1")` asserts on
    `fakeObjectStore`'s own fabricated URL shape; the real coverage is in
    `sigv4.test.ts`.
- **Fix:** each is a one-line change; worth doing in a single sweep rather than
  individually.

---

# Status of TH1–TH8 and T1 from `plans/repo-review-2026-08-15.md`

| ID                         | Status                            | Evidence                                                                                                                                                                                                                                                               |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1** (delete-protection) | ✅ fixed                          | `profiles.spec.ts:87-123` targets `getByTestId("profile-card")` (real: `ProfileCard.tsx:272`) and asserts both halves — `toHaveCount(0)` on the active card _and_ `toBeVisible()` on the inactive one. The button is gated at `ProfileCard.tsx:327`, so both can fail. |
| **TH1**                    | 🟡 partial                        | `controls.ts` 0 → 36.8 %, `db.ts` 0 → 42.1 %. `profileStore.ts`, `googleDrive/api.ts`, `googleDrive/sync.ts`, `useKeyboardListener.ts` still 0 %; `decoder.ts` 1.9 %. See T11.                                                                                         |
| **TH2**                    | 🟡 partial                        | `importExport.zip.test.ts` covers the `.iaz` round trip. `importImpamp2Profile`, `importMultipleProfiles` and `detectImportFormat` still 0 % — see T12.                                                                                                                |
| **TH3**                    | 🟡 partial                        | Ten sleeps → six; `pad-disable.spec.ts` fixed properly. Three load-bearing ones remain — see T24.                                                                                                                                                                      |
| **TH4**                    | ✅ fixed                          | No `{ timeout: 5000 }` anywhere; `armed-tracks.spec.ts:537-541` carries an explanatory comment instead.                                                                                                                                                                |
| **TH5**                    | 🟡 partial                        | Panel-level wait fixed; the row-level `count()` is not — see T23.                                                                                                                                                                                                      |
| **TH6**                    | ✅ fixed                          | A sweep for un-awaited Playwright calls and un-awaited `expect(locator)` across all 22 files returns zero.                                                                                                                                                             |
| **TH7**                    | ✅ fixed in `e2e-tests/README.md` | "Known failures: None. 126/126", with a note on why a stale list is worse than none. The same rot has surfaced in `docs/cross-browser-e2e.md` — see T29.                                                                                                               |
| **TH8**                    | 🟡 partial                        | `openProfileManager` exists and six specs use it; the `server-sync.spec.ts:308-313` verbatim copy is still there, plus a shadowing second implementation — see T26.                                                                                                    |

---

# Checked and clean

Stated explicitly, because a category that turns up nothing is a finding too.

- **No T1 recurrence in the selectors.** Every `data-testid` referenced anywhere in
  `e2e-tests/` was extracted and cross-checked against `src/`. Fifteen looked
  missing and all fifteen are template-generated and provably constructible
  (`SyncAxes.tsx:90` `` `${testIdPrefix}-${option}` ``, `SyncDefectBanner.tsx:70`
  `` `fix-${defect}` ``, `LoudnessOverviewModalContent.tsx:349,433`, `Pad.tsx:366`).
  Every non-testid negative locator resolves to a real element and is asserted
  positively somewhere: `.bg-green-500` (`PadProgressBar.tsx:19`), `.text-amber-500`
  (`Pad.tsx:386`), `"Nothing playing"` (`ActiveTracksPanel.tsx:91`), `"EDIT MODE"`
  (`page.tsx:212`), `"Cannot drop here"` (`Pad.tsx:460`), `role="progressbar"`
  (`AudioStoragePanel.tsx:113`), `button.bg-red-500` (`TrackItem.tsx:245`). The
  selector-level failure mode is genuinely gone; what remains is timing.
- **Over-mocking: clean.** All 24 `vi.mock` calls were judged individually. Every
  one mocks a _collaborator_ at an observation boundary — `@/lib/db`, `./api`,
  `./decoder`, `./context` — never the module under test.
  `serverAudio/transfer.test.ts:29` even keeps the real error classes via
  `importOriginal` because the subject branches on `instanceof`. The 12 server/API
  test files contain **one** `vi.fn` in 3186 lines (an injected `fetch`) and drive
  real route handlers against real in-memory SQLite. No test asserts a mock's own
  return value in place of the subject's behaviour.
- **Literal auto-increment ids: clean, and deliberately so.**
  `src/lib/testSupport/browserGlobals.ts:38-45` carries the exact warning from
  `CLAUDE.md`, `clearAllStores` covers all four object stores, all nine
  IndexedDB-backed suites call it, and every one keys off ids the store handed back
  (`dataAccess.wire.test.ts:46-48` even comments on it). No `expect(x.id).toBe(1)`
  anywhere. The `profileId: 1` literals that do exist are in pure-function fixtures
  that never touch a store.
- **Cross-file state via the memoised `getDb`: not possible.** `vitest.config.ts`
  sets no `pool`/`isolate` override, so Vitest 4's default `pool: "forks"`,
  `isolate: true` gives every file its own process. Worth a comment in that config,
  since several server test files leave `IMPAMP_DB_PATH` set at end-of-file and are
  safe _only_ because of it.
- **Shared state within a file:** one instance (`config.test.ts`'s incomplete
  `TOUCHED` list, T22), which cannot bite today. Everything else resets correctly.
- **Tautological fixtures / self-fulfilling crypto:** essentially clean. The two
  round-trip suites are backed by hand-built archives that pin the _reader_ side of
  the format; `sigv4.test.ts` checks `__fixtures__/sigv4-vectors.json`, generated by
  `scripts/generate-sigv4-vectors.py` from botocore's `S3SigV4Auth` with a frozen
  clock — genuinely external vectors. The only self-referential loops are T4, T7,
  T9(b) and T10.
- **Clean checkout — verified, not assumed.** Fresh `git clone` of `b29585b`,
  `npm ci`, `npm test`:

  ```
   Test Files  55 passed (55)
        Tests  615 passed (615)
     Duration  4.67s
  ```

  `/data/` is gitignored, e2e audio fixtures are generated at run time
  (`test-helpers.ts:131`), every spec file is tracked. (The e2e half cannot be
  green-from-clean in the same sense — see T3, where a _clean_ database is what
  makes one assertion meaningful again.)

- **Genuinely solid files**, named so a future review does not re-audit them:
`loudness/analyse.test.ts`, `kWeighting.test.ts`, `truePeak.test.ts`,
`analyse.sliding.test.ts` (BS.1770-4 / EBU Tech 3341 reference values and a
re-summing reference implementation); `audio/playback.race.test.ts`;
`serverSync/sync.test.ts`; `serverAudio/transfer.test.ts`;
`googleDrive/dataAccess.{gain,hashKeyed,wire}.test.ts`;
`syncUtils.hashTwins.test.ts`; `fetchWithTimeout.test.ts`; `syncState.test.ts`;
`server/s3/sigv4.test.ts`; `server/audio.test.ts`;
`app/api/test/session/route.test.ts`.
</content>
