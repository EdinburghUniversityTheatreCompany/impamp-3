# Regression review — `git diff 8ffc5e0..HEAD` (40 commits, 141 files, +7884/−2128)

Axis: the change itself, not the subsystems. For every substantive commit: does
the fix hold, did it break something adjacent, is the extracted abstraction
really one rule, and are the deletions safe.

**Verified sound, so not findings** (checked and they hold):

- **The migration.** Migration 1 is byte-identical to `8ffc5e0`; 3 and 4 are
  appended. `DROP INDEX IF EXISTS sessions_user_idx` is safe on a live database,
  and migration 3's backfill (`json_each` guarded by `json_valid` +
  `json_type(...) = 'array'`) skips a malformed blob rather than failing the
  boot. `profile_audio` is rewritten inside the same transaction as both write
  paths (`createProfile`, `updateProfile` — the only two `INSERT`/`UPDATE`
  against `profiles` in the repo), so it cannot drift.
- **`profileMayServeHash` joining `s.email = u.email`** instead of
  `lower(trim(u.email))`. `normalizeEmail` has been applied on both write paths
  since the storage layer's first commit (`46c5046`), so there is no
  unnormalised legacy row to miss.
- **`listProfilesForUser` split into two queries.** The old `LEFT JOIN` could
  not produce a duplicate (partial unique index on `(profile_id, email)`), and
  the new `p.owner_id <> ?` preserves the old `CASE` precedence.
- **The JSON splicing** in `GET`/`409`. `profile.data` is only ever written from
  `JSON.stringify`, and everything spliced around it is `JSON.stringify`-escaped.
- **The statement cache** is bounded (every SQL string is a static literal) and
  is cleared in `closeDb` before `db.close()`.
- **`toWireProfile`** with its exhaustiveness assertion; the export path still
  strips `lastBackedUpAt` on top (`importExport.ts:1487`).
- **The sliding block sum** in `analyse.ts`: entering `[end−hop, end)` and
  leaving `[start−hop, start)` is correct for any `hop ≤ block`, and the
  512-block resync bounds the drift.
- **`extractPadPlaybackSettings`** in `duplicateProfileLocally` does carry
  `name`, so the duplicate keeps its pad names.
- **`.dockerignore`'s `!.env.dist` / `LICENCE`** match the real filenames
  (`.env.example` and `LICENSE` never existed here).

---

### 🔴 R1 — The pipelined preloader deadlocks itself, and wedges for the session

- **Class:** REGRESSION
- **Commit:** `d353f90` fix(audio): a substituted sound plays as itself, and is only decoded once
- **Where:** `src/lib/audio/decoder.ts:235-287`
- **Finding:** The commit moved the in-flight registration earlier so a
  concurrent trigger joins the running decode instead of starting its own. In
  doing so it moved the decode-slot wait _inside_ the promise that is itself
  put into `activeDecodes`.

  Before (`8ffc5e0:src/lib/audio/decoder.ts`) the wait happened before anything
  was registered, so the waiter was never a member of the set it raced:

  ```ts
  // Wait for decode slot to become available
  while (activeDecodes.size >= maxConcurrentDecodes) {
    await Promise.race(activeDecodes);
  }
  const decodePromise = trackInFlightLoad(id, async () => {
    /* decode */
  });
  activeDecodes.add(decodePromise);
  ```

  Now:

  ```ts
  const work = trackInFlightLoad(id, async () => {
    const audioFileData = await getAudioFile(id);
    ...
    while (activeDecodes.size >= maxConcurrentDecodes) {
      await Promise.race(activeDecodes);      // ← `work` is already in this set
    }
    ...
  });
  activeDecodes.add(work);
  ...
  await work;
  ```

  `batch.map(async id => …)` runs every callback synchronously up to its first
  `await` (`await work`, line 287), so **all** items of a batch are in
  `activeDecodes` before any `getAudioFile` resolves. Each then enters the
  `while` and awaits `Promise.race(activeDecodes)` — a race over a set in which
  every member is blocked on that same race. Nothing settles.

  Reproduced in the scratchpad against both revisions (probe removed):

  ```
  HEAD    batch 6 / 6 slots          → TIMEOUT   (expected done:6)
  HEAD    batch 2 / 2 slots          → TIMEOUT   (expected done:2)
  HEAD    batch 1 / 2 slots          → done:1
  8ffc5e0 batch 6 / 6 slots          → done:6
  ```

  The trigger threshold is `batch.length >= maxConcurrentDecodes`.
  `PadGrid.tsx:217` preloads the current bank on every mount and bank switch;
  `preloader.ts:316-319` passes `loadBatchSize` 8 and
  `getDecodeConcurrency(IMMEDIATE) = min(max(cores − 2, 2), 8)` — 2 on a 4-core
  machine, 6 on 8 cores, 8 on 16. So **two uncached sounds on a bank is enough
  on a 4-core laptop**, and eight is enough on any machine.

- **Impact:** `processBatch` never resolves, so `processQueue`'s
  `isProcessing` stays `true` for the life of the tab: the preloader is dead
  from the first bank switch onward — no hover preload, no armed-track preload,
  no whole-profile preload. No decoded buffer is ever cached, so the
  sample-accurate `playBuffer` fast path (`controls.ts:458-467`) never engages
  and every pad plays through the media-element fallback for the whole session.
  Worse, `trackInFlightLoad` registered those ids in `inFlightLoads` and they
  never settle, so anything that falls through to
  `loadAndDecodeAudioInstant`/`Enhanced` for one of them (an unstreamable
  format, a failed streaming start) awaits a promise that will never resolve —
  the pad hangs with its loading state stuck on, permanently.

  The suites do not catch it because ordinary playback goes through
  `playBlobStreaming`, not the decoder.

- **Fix:** register the in-flight entry before the first await _and_ keep the
  slot wait outside it — e.g. acquire the slot in the outer map callback before
  calling `trackInFlightLoad`, or track a separate counter that excludes the
  caller. Minimally: hoist the `while` loop above `const work = …` and keep
  `activeDecodes.add(work)` where it is. Add the `batch ≥ concurrency` case to
  `preloader.test.ts` — every existing case is below the threshold.

---

### 🔴 R2 — The keyboard now fires the _previous_ bank's pads during a bank switch

- **Class:** REGRESSION
- **Commit:** `988084d` fix(pads): one source of pad configurations, so the keyboard cannot go stale (left in place by `034e4eb`)
- **Where:** `src/hooks/useKeyboardListener.ts:217-224`, `src/hooks/usePadConfigurations.ts:120`
- **Finding:** C4 replaced the keyboard listener's private fetch with the shared
  `usePadConfigurations`. The deleted code cleared its map **synchronously** on
  every bank or profile change, and said why:

  ```ts
  // Drop the previous bank's configs immediately so keys don't trigger stale pads
  padConfigsRef.current = new Map();
  ```

  The replacement keeps whatever the hook last returned:

  ```ts
  const { padConfigs } = usePadConfigurations(
    activeProfileId === null ? null : String(activeProfileId),
    currentPageIndex,
  );
  const padConfigsRef = useRef<Map<number, PadConfiguration>>(padConfigs);
  useEffect(() => {
    padConfigsRef.current = padConfigs;
  }, [padConfigs]);
  ```

  and `usePadConfigurations` deliberately serves the stale map while the next
  read is in flight (`usePadConfigurations.ts:120`):

  ```ts
  padConfigs: profileId ? (result?.padConfigs ?? NO_CONFIGS) : NO_CONFIGS,
  isLoading: profileId !== null && result?.requestKey !== requestKey,
  ```

  `034e4eb` recognised exactly this window and guarded it — but only for the
  mouse (`PadGrid.tsx:267`, `if (isLoadingConfigs) return;`, with the comment
  "Acting on them played the old bank's sound at the new bank's position"). The
  keyboard path destructures only `{ padConfigs }` and has no such guard, and
  the `useEffect` write adds a further commit-phase delay on top.

- **Impact:** In the app's primary input mode — bank keys `1`-`9`/`0`, pad keys
  — pressing a bank key and then a pad key before the IndexedDB read lands
  plays the _old_ bank's sound. `useKeyboardListener.ts:521` also matches the
  old bank's custom `keyBinding`s, and the trigger is dispatched with the
  **new** `currentPageIndex` (`:613`, `:630`), so the loading key and playback
  key describe a pad that is not the one being played. The same applies on a
  profile switch, where the previous _profile's_ pads stay live — profiles are
  meant to be completely isolated. Before this branch the map was empty in that
  window and nothing fired.
- **Fix:** take `isLoading` from the hook and return early from
  `handleKeyDown`'s pad-activation section, mirroring `PadGrid`'s guard — or
  have `usePadConfigurations` expose the request key so the keyboard can refuse
  a map that is not for the bank now showing. Extend
  `e2e-tests/overlay-keyboard.spec.ts` (or `bulk-import-keyboard.spec.ts`) with
  bank-switch-then-immediately-press.

---

### 🔴 R3 — The 120 s "transfer" timeout landed on the profile JSON; the Drive **audio** upload got 10 s

- **Class:** REGRESSION
- **Commit:** `15e17a0` fix(net): give every outbound request a deadline
- **Where:** `src/lib/googleDrive/api.ts:798-800` and `:924-928`, `:1020`, `:987`
- **Finding:** The commit is explicit that a single tier would be wrong: "10s
  for JSON control-plane calls, 120s for moving audio bytes — a 10s cap there
  would cancel working uploads on a slow connection." The tier was then applied
  to the wrong function. `uploadDriveFile(fileName, jsonData: ProfileSyncData, …)`
  builds `new Blob([JSON.stringify(jsonData, null, 2)])` — the profile blob —
  and got:

  ```ts
  const response = await fetchWithTimeout(url, {
    // Moving the whole audio blob — the largest request this app makes.
    timeoutKind: "transfer",
  ```

  `uploadAudioFile(fileName, blob, mimeType, …)` — the one that appends the
  audio blob to the multipart form (`api.ts:908`, `form.append("file", blob)`)
  and is called from `uploadMissingAudioFiles` and the repair scan
  (`googleDrive/sync.ts:130`, `:187`) — got the default:

  ```ts
  const response = await fetchWithTimeout(url, { method, headers, body: form });
  ```

  which is `FETCH_TIMEOUTS.control = 10_000`. Its 401-retry (`:938`) and
  `uploadDriveFile`'s own retry (`:822`) are likewise untiered, so even the one
  call that got 120 s loses it on retry.

- **Impact:** Every Google Drive audio upload now aborts with
  `FetchTimeoutError` if the request body has not been sent and answered within
  10 seconds. `fetch` does not resolve until the request body is written, so
  this is a hard cap on upload size × uplink: ~10 MB needs roughly 8 Mbit/s to
  survive. Bulk-importing a board over anything domestic will fail most files,
  reported as sync warnings, with the audio silently left un-uploaded. Drive
  audio sync is a documented core feature and the commit notes it was "not
  verified against real Drive".
  Downloads (`:1020`, `:987`) are also on the 10 s tier, but there the timer is
  cleared once the response headers arrive, so only TTFB is capped — much lower
  risk.
  Related, lower severity: `serverSync/api.ts` puts `pushServerProfile` /
  `fetchServerProfile` on the 10 s tier while the server accepts bodies up to
  `MAX_PROFILE_BODY_BYTES = 8 MB` (`server/profileRequests.ts:90`), and the push
  is retried `MAX_PUSH_ATTEMPTS` times, each paying the full 10 s.
- **Fix:** move `timeoutKind: "transfer"` from `uploadDriveFile` to
  `uploadAudioFile` (both the first attempt and the 401 retry), fix the comment,
  and give both retries the same tier as their first attempt. Consider a third
  tier, or `transfer`, for the profile push.

---

### 🟡 R4 — C1's "derived views do not vote" rule is not applied when a conflict is resolved by hand

- **Class:** INCOMPLETE-FIX
- **Commit:** `7a90d55` fix(sync): stop a merge handing back a pad whose ids and hashes disagree
- **Where:** `src/lib/syncUtils.ts:129-140` (fixed) vs `src/components/modals/ConflictResolutionModal.tsx:152-213` (not)
- **Finding:** The commit makes `adoptRemoteValue` carry the hash-keyed twin
  with whichever side won the field it derives from, and adds
  `DERIVED_HASH_FIELDS` so a twin never raises a conflict of its own. Both hold
  for the _automatic_ merge. But when both sides changed `audioFileIds` since
  the last sync the pad is held back from `mergedData` entirely and handed to
  the modal, which seeds it from local and then assigns the chosen field with no
  knowledge of twins:

  ```ts
  const seedFromLocal = (): Syncable | null => {
    const source = conflict.localItem ?? conflict.remoteItem;
    return source ? (deepClone(source) as Syncable) : null;
  };
  ...
  } else if (choice === "remote") {
    (targetItem as unknown as Record<string, unknown>)[fc.field] = fc.remoteValue;
  ```

  Probed with `detectProfileConflicts` (local ids `[50]`/hash `hash-local` at
  t=2000, remote ids `[60]`/hash `hash-remote` at t=3000, both stamped in
  `_fieldsModified`): `requiresManualResolution: true`, `mergedData.padConfigurations: []`,
  one `fieldConflicts` entry for `audioFileIds` only, and
  `conflict.localItem.audioFileHashes === ["hash-local"]`. Choosing "remote"
  therefore produces `audioFileIds: [60]` beside `audioFileHashes: ["hash-local"]`.

- **Impact:** `updateLocalData` prefers the hashes, so the resolved pad plays the
  sound the user did _not_ pick and then publishes that pairing — the exact
  failure the commit's own message describes, reachable through the one path
  where the user was explicitly asked. Plan item 9.5 (`applyConflictResolutions`
  moves to `syncUtils.ts`) is still open, which is where this belongs.
- **Fix:** export the twin map from `syncUtils.ts` and apply the same
  adopt-with-twin / delete-twin rule in `buildResolvedData`; better, move the
  resolution application into `syncUtils.ts` so one rule serves both, and unit
  test the "resolve toward remote" case.

---

### 🟡 R5 — Drive conflict-resolution warnings are now dropped entirely

- **Class:** REGRESSION
- **Commit:** `662214c` fix(sync): one warning channel, streams keyed by identity, joiners heard
- **Where:** `src/lib/googleDrive/sync.ts:970`, `src/hooks/useGoogleDriveSync.ts:388-393` and `:425-431`
- **Finding:** The commit moves Drive's warnings off `onError` and onto an
  **optional** `onWarnings`:

  ```ts
  -onError(warnings.join("\n"));
  +onWarnings?.(warnings);
  ```

  For the ordinary sync path this is correct: `synchronizeProfile` wraps the
  callbacks in `mirrorToProfile(...)`, whose new `onWarnings` patches
  `syncStatusStore`. But `resolveConflict` passes the raw hook callbacks:

  ```ts
  return await applyConflictResolution(
    resolvedData,
    fileId,
    profileId,
    getFreshTokenInfo(),
    callbacks, // ← not mirrorToProfile(...)
    handleTokenRefresh,
  );
  ```

  and that object has no `onWarnings` at all:

  ```ts
  const callbacks = useMemo(
    () => ({
      onStatusChange: setSyncStatus,
      onError: setError,
      onConflictsDetected: setConflicts,
      onConflictDataAvailable: setConflictData,
    }),
    [],
  );
  ```

  `rg -n "onWarnings" src/` confirms the only consumers are
  `syncStatusStore.mirrorToProfile` and `useServerSync`. The same applies to
  `pullPublicReadOnlyProfile` (`sync.ts:448`) when called without a mirror.

- **Impact:** Warnings raised while resolving a Drive conflict by hand — a sound
  that could not be fetched, a file the merge dropped — used to appear (as a red
  error, which is what the commit was fixing) and now appear nowhere: neither in
  the panel nor in `syncStatusStore`. The user is told the resolution succeeded.
- **Fix:** route `resolveConflict` through `mirrorToProfile` like
  `synchronizeProfile` does, or add `onWarnings` to the hook's `callbacks`
  memo. Making `onWarnings` required on `SyncStatusCallbacks` would have caught
  this at compile time.

---

### 🟡 R6 — `/drive/open` now signs the user out of Google when the sign-in popup fails

- **Class:** REGRESSION
- **Commit:** `807a268` refactor(auth): one Google sign-in, not three copies of it
- **Where:** `src/hooks/useGoogleSignIn.ts:122-131`, was `src/app/drive/open/page.tsx:224-228` at `8ffc5e0`
- **Finding:** The commit states "The three copies were identical, so this is a
  faithful extraction rather than a rewrite." They were not identical in their
  popup-failure handler. `ProfileManager` and `AuthNotification` both ended
  theirs with `clearGoogleAuthDetails()`; `/drive/open` did not:

  ```ts
  // 8ffc5e0:src/app/drive/open/page.tsx
  onError: (errorResponse) => {
    setSignInError(
      `Sign-in failed: ${errorResponse.error_description || errorResponse.error || "Unknown error"}`,
    );
  },
  ```

  The unified hook applies the other two sites' behaviour to all three:

  ```ts
  onError: (errorResponse) => {
    ...
    // The popup failing mid-flow can leave a half-written slice behind.
    clearGoogleAuthDetails();
  },
  ```

- **Impact:** On `/drive/open` — the page a collaborator lands on from a shared
  Drive link — a popup that is blocked, closed or cancelled now wipes the
  user's stored Google tokens, signing them out of Drive across the whole app
  rather than just failing the connect. Also a cosmetic change: the message
  prefix goes from "Sign-in failed" to "Login failed", and the old
  `setSignInError(null)` at the start of a successful exchange is gone, so a
  stale error can persist through a subsequent success.
- **Fix:** either make the clear opt-in (`clearOnPopupFailure?: boolean`,
  default false, set by the two callers that wanted it) or decide it is right
  everywhere and say so — but do not carry it in as an unremarked side effect of
  a "faithful extraction". Add `onSignedIn` clearing the caller's error, or have
  the hook call `onError(null)` on success.

---

### 🟢 R7 — `GET /api/profiles/:id` authorises and reads twice, and can stamp a stale ETag on a fresh body

- **Class:** NEW
- **Commit:** `2c718dd` perf(server): stop reading the whole database to answer small questions
- **Where:** `src/app/api/profiles/[id]/route.ts:33-45`
- **Finding:** The 304 optimisation is right, but the non-304 path now does the
  whole authorisation and lookup a second time:

  ```ts
  const meta = loadAuthorizedProfileMeta(request, id);   // authorise + SELECT (no blob)
  const etag = profileEtag(meta.profile.version, access);
  if (etagMatches(...)) return 304;
  const loaded = loadAuthorizedProfile(request, id);     // authorise + SELECT * again
  ```

  Two `authorizeProfileRequest` calls (each hitting `sessions`/`profile_shares`)
  and two `profiles` reads per full GET. And because the two reads are not in one
  transaction, a `PUT` landing between them yields a body at version _N+1_ under
  `ETag: "N.<access>"`.

- **Impact:** Small. The client reads `version` from the body, not the header
  (`serverSync/api.ts:110`), so the mismatch self-corrects on the next poll; the
  extra work is one indexed lookup on a path that is already reading the blob.
- **Fix:** read the row once — `getProfileById` up front and derive the meta
  from it, or have `loadAuthorizedProfileMeta` return the auth result so the
  second call only needs the blob.

---

## Deletions checked, nothing lost

`bc70ec8` removed 560 lines. Spot-checked the risky ones against the rest of the
tree: `hasModalComponent`, `getAudioFileByName`, `forceCleanup`,
`getCacheConfig`, `getPlayingAudioKeys`, `getActivePlaybackKeys`,
`getCurrentUser` (`session.ts`) and `requestOwnDownloadUrl` have no remaining
callers; `ModalType.CONFIRM`/`PROMPT` are rendered directly as `content` by
`usePadInteractions` and `app/page.tsx` and never looked up by name. Removing
`onPartialReady` from `loadAndDecodeAudioInstant` did not orphan `onAudioReady`
— it is still called on the cached-buffer, streaming and decode paths
(`controls.ts:465`, `:520`, `:593`) and by `triggerPad`. The one genuine defect
that came out of that commit is R1, above, from the decoder rewrite it forced.
