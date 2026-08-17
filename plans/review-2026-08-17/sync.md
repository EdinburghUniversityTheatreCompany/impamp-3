# Sync clients — review, 17 August 2026

Axis: `syncUtils.ts`, `syncReplay.ts`, `profileWire.ts`, `googleDrive/*`,
`serverSync/*`, `serverAudio/*`, `useServerSync.ts`, and the scheduler in
`ClientSideInitializer.tsx`. Branch `main` at `b29585b`.

Read first: `plans/repo-review-2026-08-15.md`, `.claude/current_plan.md`,
`docs/server-sync.md`, `docs/google-drive-sync.md`, `docs/wasabi-audio.md`.

**Verified clean, do not re-litigate.** S1 is genuinely closed —
`toWireProfile` is the only serialiser on both outbound paths
(`importExport.ts:1487`, `dataAccess.ts:135`), the exhaustiveness assertion at
`profileWire.ts:93-98` really does fail to compile on a new `Profile` field, and
nothing else in `src/` builds a profile for the wire. C1 is fixed _in the
automatic merge_ (`DERIVED_HASH_TWINS` / `adoptRemoteValue`) — see SY2 for the
path it did not reach. A5 (joiners' callbacks), A6 (one warning channel) and A7
(streams keyed by identity) are all correctly done, and `syncReplay.ts` is a
good shared home for them. `updateLocalData`'s per-field pinning of the location
fields (`dataAccess.ts:367-377`) is right, and its per-pad translation gate is
right.

---

### 🔴 SY1 — Two clients on one server profile push to each other forever

- **Class:** NEW
- **Where:** `src/lib/serverSync/sync.ts:294-389`, `src/app/api/profiles/[id]/route.ts:118-124`,
  `src/app/api/profiles/[id]/events/route.ts:93-101`, `src/hooks/useServerSync.ts:56-68`,
  `src/components/ClientSideInitializer.tsx:420-430`
- **Finding:** Four rules that are each defensible on their own close a loop.

  1. **Every sync pushes, whether or not anything changed.** `pullMergePush`
     has no "nothing to send" branch — the only things that hold a push back
     are the remote refusing writes and the user following:

     ```ts
     if (remoteReadOnly || following) { … return finish(…); }

     try {
       const pushed = await pushServerProfile(
         serverId, mergedData.profile.name, mergedData, remoteVersion, shareToken,
       );
     ```

     On a 304 `remote` is `null`, `detectProfileConflicts(localData, null)`
     returns `mergedData = deepClone(localData)`, and it is pushed anyway. The
     suite states this as intended: `sync.test.ts:249` — _"still pushes local
     edits when the server answers 304"_.

  2. **Every push bumps the version and publishes an event.**
     `server/profiles.ts:141` is `SET … version = version + 1` with no
     content comparison, and the route publishes unconditionally:

     ```ts
     publishProfileChange({
       profileId: id,
       version: result.profile.version,
       originId: request.headers.get("x-impamp-origin") ?? undefined,
     });
     ```

  3. **Every `change` event triggers a full sync**, with no debounce, no
     rate limit, and no comparison against the version we already hold
     (`ClientSideInitializer.tsx:423-428`):

     ```ts
     (version) => {
       console.log(
         `Server reports profile ${profileId} at version ${version} — syncing...`,
       );
       void syncServerProfile(profileId);
     };
     ```

     The only suppression is `if (change.originId === ORIGIN_ID) return;`
     (`useServerSync.ts:63`), and `ORIGIN_ID` is **per browser tab**
     (`serverSync/api.ts:23`) — so it silences a tab's echo of its own write
     and nothing else.

  4. **Connecting a stream is itself an event.** The SSE route greets every
     new connection with a `change` carrying no `originId`
     (`events/route.ts:93-101`), and `MAX_STREAM_MS = 30 * 60_000` forces a
     reconnect every half hour.

  Chain them: tab A pushes (v5→v6, origin A) → the server publishes v6 → tab B
  hears it (origin ≠ B) → B pulls, merges, **pushes** (v6→v7, origin B) → the
  server publishes v7 → A hears it → A pushes (v7→v8) → … Nothing damps it:
  `_lastSyncTimestamp` is refreshed on both sides each round, so no conflict is
  ever raised and no field ever stops changing hands. Two tabs of the _same_
  user are enough, because `ORIGIN_ID` is per tab.

- **Impact:** As long as two browsers/tabs have the same server profile open,
  they hammer each other at SSE latency (~1 s) indefinitely. Each round is a
  full `GET` of the blob, a `getLocalProfileSyncData` (every pad + every audio
  metadata record), a `detectProfileConflicts`, and a `PUT` of the whole blob —
  which on the server is a full re-serialise plus `reindexProfileAudio` under a
  write transaction. The version counter climbs without bound. On a laptop this
  is a flat battery and a warm fan during a show; on the single-instance server
  it is a permanent write load proportional to the number of open tabs.
- **Fix:** Do not push when the merge produced nothing new. The cheapest honest
  test is to compare the merged payload against what the remote gave us,
  ignoring `_lastSyncTimestamp`: if `remote` was non-null and
  `JSON.stringify({...mergedData, _lastSyncTimestamp: 0})` equals the same for
  `remote.data`, return `{ status: "unchanged", version: remoteVersion }` (the
  variant already exists at `serverSync/types.ts:60` and has no producer). On
  the 304 path the test is "did anything local change since `lastSync_<id>`",
  and the helper for it is already written and already correct about
  `_fieldsModified` versus `updatedAt`: `hasProfileChangedSince(profileId,
since)` at `db.ts:1238`. Belt and braces: have the SSE
  handler ignore an event whose `version` is not greater than the profile's
  stored `serverVersion`, which also kills the reconnect-greeting sync.

---

### 🔴 SY2 — Resolving a conflict by hand reintroduces C1: the pad's ids say one sound, its hashes say another

- **Class:** RECURRENCE (of 🔴 C1 in `plans/repo-review-2026-08-15.md:123`)
- **Where:** `src/components/modals/ConflictResolutionModal.tsx:154-213`, with
  `src/lib/syncUtils.ts:104-110,125-140` and
  `src/lib/googleDrive/dataAccess.ts:412-420`
- **Finding:** C1 was fixed in the _automatic_ merge by making the hash fields
  follow their source field (`syncUtils.ts:125-140`):

  ```ts
  const adoptRemoteValue = (field: string, key: keyof Syncable) => {
    (mergedItem as any)[key] = remoteItem[key];
    const twin = DERIVED_HASH_TWINS[field];
    if (!twin) return;
    …
  };
  ```

  The manual resolution path has no such rule. A conflicting pad is held back
  from `mergedData`, so the modal seeds it from **local**:

  ```ts
  const seedFromLocal = (): Syncable | null => {
    const source = conflict.localItem ?? conflict.remoteItem;
    return source ? (deepClone(source) as Syncable) : null;
  };
  ```

  and then applies the user's per-field choice to that seed and nothing else:

  ```ts
  } else if (choice === "remote") {
    const remoteValStr = JSON.stringify(fc.remoteValue);
    if (currentValStr !== remoteValStr) {
      (targetItem as unknown as Record<string, unknown>)[fc.field] = fc.remoteValue;
  ```

  So choosing **"use remote"** for `audioFileIds` writes remote's ids over a
  clone that still carries **local's** `audioFileHashes`,
  `audioTrimSettingsByHash` and `audioGainSettingsByHash`. The user is never
  offered the hash fields as a choice, because `isVotingField`
  (`syncUtils.ts:104-110`) deliberately excludes them, so nothing can correct
  it downstream.

  `updateLocalData` then prefers the hashes, exactly as C1 described:

  ```ts
  const resolved = resolveSyncedPadAudio(
    padWithProfileId.audioFileIds,
    audioIdMap,
    existing?.audioFileIds,
    pad.audioFileHashes,
    localIdByHash,
  );
  ```

  and `resolveSyncedPadAudio` (`syncUtils.ts:673-688`) walks `syncedIds` by
  index taking `syncedHashes[index]` first. If the two sides had different
  numbers of sounds the arrays are now different lengths, so the tail indices
  fall through to `audioIdMap.get(syncedId)` — translating the _sender's_ ids
  — while the head resolves to local's sounds. The result is a pad assembled
  from both devices at once.

- **Impact:** The user picks "use the version from the ImpAmp server", presses
  Apply, and gets their **own** sounds back on the pad (or, on a length
  mismatch, a mixture). The resolved blob is then pushed
  (`serverSync/sync.ts:467`, `googleDrive/sync.ts:935`), so every other device
  reads the same hashes and reaches the same wrong sounds. This is the
  conflict path — the one moment the user was promised their choice would be
  honoured — and it is the highest-consequence code in the sync system with no
  unit test (🟡 A3 in the old review, still not done).
- **Fix:** Move `DERIVED_HASH_TWINS` out of `syncUtils.ts`'s module scope into
  an export, and have the modal's `choice === "remote"` branch call the same
  twin-adoption helper `adoptRemoteValue` uses (copy remote's twin, or delete
  the local one when remote has none). Better, and what A3 asked for: lift
  `buildResolvedData` into `syncUtils.ts` as a pure
  `applyConflictResolutions(conflictData, resolutions)` so it shares
  `adoptRemoteValue` outright, and unit-test the four branches.

---

### 🟡 SY3 — A profile rename never reaches the other device, and gets pushed back over the top

- **Class:** NEW
- **Where:** `src/lib/googleDrive/dataAccess.ts:353-356`, with
  `src/lib/syncUtils.ts:466-474`
- **Finding:** `updateLocalData` pins the profile name to whatever this device
  already had:

  ```ts
  const profileWithId = {
    ...data.profile,
    id: profileId,
    name: existingLocalProfile?.name ?? data.profile.name,
  ```

  Unlike every field below it, this one carries no comment explaining itself,
  and unlike them it is not a location field — it is content, and
  `isComparableProfileField` (`syncUtils.ts:320-325`) lets it take part in the
  merge. So the merge decides the name and then the writer throws that decision
  away, while still storing the merge's `_fieldsModified`:

  ```ts
  } else if (remoteMod > localMod) {
    (mergedData.profile as any)[key] = remoteVal;
    …
    mergedData.profile._fieldsModified[field] = remoteMod;
  ```

  Trace a rename on A at t=T. B pulls: `remoteMod (T) > localMod`, so
  `mergedData.profile.name` = the new name, and B **pushes it** — but
  `updateLocalData` keeps B's old name locally _and_ stores
  `_fieldsModified.name = T`. On B's next sync the two sides tie
  (`localMod === remoteMod === T`), `remoteMod > localMod` is false, local
  wins, and B pushes the **old** name back. A does the same in reverse. The
  name flaps on every sync and never converges.

- **Impact:** Renaming a shared profile silently does nothing for
  collaborators. On the server backend the profile row's `name` — what
  `/api/profiles` lists and what the sharing UI shows — flips back and forth on
  every sync (`serverSync/sync.ts:378` passes `mergedData.profile.name`). On
  Drive it is worse than cosmetic: the _filename_ is derived from it
  (`googleDrive/sync.ts:824`, `getProfileSyncFilename(mergedData.profile.name)`),
  so the Drive file is renamed on every sync, and `findDriveFileByName` — the
  relink-by-name fallback at `sync.ts:653-666` — is looking for a name that may
  currently be the other device's.
- **Fix:** Let the merged name through (`name: data.profile.name`). If the
  original intent was to stop a _read-only_ pull renaming a locally-renamed
  profile, gate it on that — `isReadOnlyForSync(existingLocalProfile)` — rather
  than on all pulls; and either way do not store a `_fieldsModified.name` the
  stored value does not match.

---

### 🟡 SY4 — Downloaded audio is stored under the hash the sender claimed, which nothing ever verifies

- **Class:** NEW
- **Where:** `src/lib/serverAudio/transfer.ts:290-299`,
  `src/lib/googleDrive/sync.ts:366-373`, `src/lib/db.ts:546`
- **Finding:** Both downloaders take the hash from the blob and store it as
  fact:

  ```ts
  const blob = await response.blob();
  const stored: Omit<AudioFile, "id" | "createdAt"> = {
    name: ref.name,
    type: ref.type || ticket.contentType,
    blob,
    hash: ref.hash,
    serverHosted: true,
  };
  await addAudioFile(stored);
  ```

  and `addAudioFile` trusts a supplied hash — `const hash = audioFile.hash ?? (await computeBlobHash(audioFile.blob));`
  — so the bytes are never hashed. The whole sync system is content-addressed
  on top of that record: `getAudioFileByHash`, `localIdByHash`,
  `audioFileHashes`, the dedup skip in both downloaders.

  On the hosted path this is reachable, not theoretical. The server's own
  module says so (`src/lib/server/proofOfPossession.ts`): _"the presigned PUT
  is issued for a content-addressed key and **nothing verifies what is sent**"_.
  Withholding the upload URL protects an object that already exists — it does
  nothing about the **first** uploader. Hashes are not secret (they are in
  every blob a viewer can read), the key is
  `storageKeyForHash(hash, extension)` with a client-chosen extension, and
  `commit` only asks for a proof when `getAudioObject(fields.hash)` already
  returns a row (`api/audio/commit/route.ts:57-60`). So an approved uploader
  who has merely _seen_ a hash can create the canonical object for it out of
  arbitrary bytes.

- **Impact:** Everyone who later pulls that profile downloads the substituted
  bytes and stores them locally **under the legitimate hash** — so dedup,
  future merges and the pad all agree it is the right sound, and it plays the
  wrong one. The real holder of that audio can then never host it: their
  upload-url gets `alreadyStored`, and their proof is computed over their own
  bytes and will never match the poisoned object's. On the Drive path the same
  gap turns a replaced file in a link-writable folder (the Share button sets
  the folder public-editable, `docs/google-drive-sync.md` §3) into a silent
  substitution instead of a warning.
- **Fix:** Client-side, verify before storing — both call sites already have
  `computeBlobHash` in scope; on mismatch treat it as a retryable/permanent
  download failure rather than writing the record. Server-side, close the
  first-uploader hole: either stream-digest the object at commit (max object is
  100 MB, and commit is once per object per deployment) or, cheaper, keep the
  object row unconfirmed until a second, independent commit corroborates it.

---

### 🟡 SY5 — "Both import paths store the hash now" is only half true; the Drive branch still drops it

- **Class:** RECURRENCE (of 🟡 D7; `.claude/current_plan.md:71` records it done)
- **Where:** `src/lib/importExport.ts:934-949` and `:951-956`, against `:962-970`
  and `:1790-1797`
- **Finding:** `importProfileFromSyncData` builds four kinds of audio source.
  The hosted branch and the ZIP branch pass `hash`; the Drive branch and the
  legacy base64 branch do not, although `ref.hash` is sitting right there in
  the same `ref`:

  ```ts
  if (ref.driveFileId) {
    const driveFileId = ref.driveFileId;
    audioSources.push({
      originalId: ref.id,
      name: ref.name,
      type: ref.type,
      getBlob: async () => { … },
    });
  ```

  `importAudioSources` writes through a raw transaction
  (`importExport.ts:443-452`) rather than `addAudioFile`, so nothing computes
  one either: `hash: source.hash` is simply `undefined`.

- **Impact:** Connecting to a shared **Drive** profile — the documented
  collaboration flow — imports the entire audio library with no hashes. The
  very next sync then pays D7's stated cost in full: `getLocalProfileSyncData`
  calls `ensureAudioFileHash` per file (`dataAccess.ts:87-90`), and
  `downloadMissingAudioFiles` misses the hash index and builds
  `getHashlessIndex`, which reads and SHA-256s **every blob in the library**
  (`googleDrive/sync.ts:313-323`). It self-heals after one sync, but that one
  sync is a full-library rehash on the main thread right after a connect. The
  plan's own note that "the duplicated `getHashlessIndex` itself is still two
  copies" compounds it: a server sync that also has hosted audio builds the
  same index twice (`serverAudio/transfer.ts:258-267`).
- **Fix:** `hash: ref.hash` on both branches (three words), and de-duplicate
  the two `getHashlessIndex` copies into one lazily-built, hash-bounded index.

---

### 🟡 SY6 — Server sync uploads to Drive before it has pulled, so it re-uploads files the remote already names

- **Class:** NEW
- **Where:** `src/lib/serverSync/sync.ts:186-198`, against
  `src/lib/googleDrive/sync.ts:733-748`
- **Finding:** The Drive engine backfills Drive ids out of the remote blob
  _before_ deciding what to upload, and says why:

  ```ts
  // 1a. Backfill driveFileIds from remote JSON into local audio file records so
  //     that uploadMissingAudioFiles skips files already on Drive without needing
  //     an extra Drive API search query per file.
  if (remoteData?.audioFiles) {
    await backfillDriveFileIdsFromRemote(remoteData.audioFiles, profileId);
  }
  ```

  The server engine calls `uploadMissingAudioFiles` at the very top of
  `performServerSync`, before `pullMergePush` has fetched anything, and never
  calls `backfillDriveFileIdsFromRemote` at all — it is imported nowhere
  outside `googleDrive/sync.ts`. `uploadMissingAudioFiles` decides purely on
  `audioFile.driveFileIds?.[profileId]` (`sync.ts:176`) and, unlike
  `repairDriveAudioFiles`, has no `findAudioFileInDriveFolder` guard either.

- **Impact:** Any device whose local library holds the profile's audio without
  a per-profile Drive id — a `.iaz` restore, a duplicated profile, a profile
  switched from local to server sync after the audio already existed — uploads
  the whole library to Drive on its first server sync, creating a second copy
  of every sound in the folder even though the remote blob names Drive ids for
  the identical bytes. Wasted upload, doubled Drive storage, and two Drive
  files per sound for anyone browsing the folder.
- **Fix:** Fetch the remote first, or at minimum move the Drive upload inside
  `pullMergePush` after `fetchServerProfile` and put
  `backfillDriveFileIdsFromRemote(remote.data.audioFiles, profileId)` in front
  of it, exactly as the Drive engine does.

---

### 🟡 SY7 — The shared token refresh does not cover the path where 401s actually happen

- **Class:** RECURRENCE (of 🟡 A12, fixed in `2be7efb` for the hook only)
- **Where:** `src/lib/googleDrive/api.ts:77,811,935,1024` against
  `src/hooks/useGoogleDriveSync.ts:130-141`
- **Finding:** The fix pass added module-level coalescing:

  ```ts
  let lastRefreshAttempt = 0;
  let refreshInFlight: ReturnType<typeof checkAndRefreshAuth> | null = null;

  function sharedCheckAndRefresh(tokenInfo) {
    refreshInFlight ??= checkAndRefreshAuth(tokenInfo).finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }
  ```

  but only the hook's five-minute _validity poll_ uses it
  (`useGoogleDriveSync.ts:356`). All four in-request 401 handlers in
  `api.ts` still call the raw `checkAndRefreshAuth(tokenInfo)` — and those are
  where a 401 is actually met.

  It compounds with a stale capture: `performProfileSync` receives one
  `tokenInfo` (`googleDrive/sync.ts:543`) and passes that same object down to
  `uploadMissingAudioFiles`, `downloadMissingAudioFiles`,
  `repairDriveAudioFiles` and every `authenticatedRequest`. The
  `refreshCallback` writes the new token to the store; nothing in the running
  sync re-reads it. So once the token expires mid-sync, **every remaining file**
  presents the same dead token, 401s, and fires its own
  `POST /api/auth/google/refresh`.

- **Impact:** A token expiring during a large sync produces one refresh round
  trip per audio file rather than one per sync — hundreds on a large board —
  each finishing by writing the result to the store, last writer winning. This
  is the precise failure the shared throttle's own docstring describes, on the
  path it does not cover.
- **Fix:** Export `sharedCheckAndRefresh` (or move it to `googleDrive/auth.ts`
  where `checkAndRefreshAuth` lives) and use it at all four `api.ts` sites.
  Separately, give the Drive engine a `getToken(): TokenInfo | null` thunk
  instead of a captured `tokenInfo`, so a refresh mid-sync is picked up by the
  next request — `useServerSync` already passes a thunk-shaped `DriveAccess`
  built at call time (`useServerSync.ts:209-220`) for exactly this reason.

---

### 🟢 SY8 — The SSE stream puts the share token in the query string, which both API clients say it never does

- **Class:** NEW
- **Where:** `src/hooks/useServerSync.ts:51-54`, against `src/lib/serverSync/api.ts:4-6`
  and `src/lib/serverAudio/api.ts:5`
- **Finding:** Both HTTP clients open with the same claim — _"A link-share
  token … travels in a header so it never ends up in a server access log's
  query string"_ — and both honour it (`x-impamp-share-token`). The event
  stream does not:

  ```ts
  const query = shareToken ? `?token=${encodeURIComponent(shareToken)}` : "";
  const source = new EventSource(
    `/api/profiles/${serverProfileId}/events${query}`,
  );
  ```

  `EventSource` cannot set headers, so this is a real constraint rather than an
  oversight — but the token is a long-lived bearer credential
  (`server/shares.ts`), the stream is re-opened at least every 30 minutes
  (`events/route.ts:28`), and every reverse proxy in front of the app logs the
  full request line by default.

- **Impact:** An editor's share token accumulates in the deployment's access
  logs, where the other two clients were deliberately written to keep it out.
  Low, because the token also arrives in a pasted `/server/open?…&token=` URL —
  but the comments state a rule the code breaks in one place, which is how the
  next person concludes the rule does not matter.
- **Fix:** Either mint a short-lived, stream-scoped ticket from the session
  before opening the `EventSource` and pass that, or accept the constraint and
  amend the two comments to say "except the event stream, which `EventSource`
  gives us no way to header".

---

### 🟢 SY9 — A share-link import prefers Drive over hosted audio, so C3's outcome survives for migrated profiles

- **Class:** NEW (adjacent to 🔴 C3, `plans/repo-review-2026-08-15.md:159`)
- **Where:** `src/lib/importExport.ts:934-970`
- **Finding:** The C3 fix added the hosted branch as the **last** alternative:
  `if (ref.driveFileId) … else if (typeof ref.data === "string") … else if (ref.serverHosted && ref.hash && downloadHostedBlob)`.
  But `getLocalProfileSyncData` deliberately publishes both routes when it
  knows both (`dataAccess.ts:61-95`: _"Every route we know about goes in the
  blob"_), so a profile whose audio was in Drive before hosting was switched on
  carries a `driveFileId` **and** `serverHosted: true` — and the import takes
  the Drive route.
- **Impact:** The collaborator is sent back to the `drive.file`/Picker dance
  that hosted audio exists to remove; if the fetch fails,
  `importAudioSources` swallows it per file (`importExport.ts:455-461`) and the
  pad is imported empty — C3's exact ending — even though the bytes were
  available from the server all along.
- **Fix:** Test `ref.serverHosted && ref.hash && downloadHostedBlob` first, and
  fall back to `driveFileId` only when the hosted fetch is unavailable or
  fails.
