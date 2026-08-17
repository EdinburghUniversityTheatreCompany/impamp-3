# Storage and import/export — review 2026-08-17

Axis: `src/lib/db.ts` (IndexedDB), `src/lib/importExport.ts`, and everything else
that reads or writes the client stores (`googleDrive/dataAccess.ts`,
`serverAudio/transfer.ts`, `syncUtils.ts`).

Baseline read first: `plans/repo-review-2026-08-15.md` (ST1–ST6, D7, P12) and
`.claude/current_plan.md`'s "Deliberately not done, and why". Every finding below
was checked against the code at `b29585b`, and the four that are expressible as a
test were run against a throwaway vitest file using the repo's own
`testSupport/browserGlobals` + `fake-indexeddb` harness (deleted afterwards).

**Headline:** the fix pass fixed `importPadConfigurations` and
`importPageMetadata` thoroughly, and then stopped. The three _other_ things that
write records during an import — the profile record itself, the audio records,
and the entire legacy impamp2 path — still carry the exact defects ST2 and ST3
name. This is the "sync bugs are duplicated rules" shape from memory, applied to
import: one rule written four times, one copy fixed.

---

### 🔴 ST1 — An audio file that fails to import is still swallowed, and the UI still says "imported successfully"

- **Class:** RECURRENCE (ST3 — "Per-record import failures are `.catch`-swallowed and reported as success"; fixed for pads and pages, not for audio)
- **Where:** `src/lib/importExport.ts:455-461`, reported at `src/components/profiles/ProfileManager.tsx:867,911,918`
- **Finding:** `importPadConfigurations` and `importPageMetadata` were both changed
  to collect failures and throw (`importExport.ts:695-702`, `:537-541`), with a
  comment explaining exactly why:

  > Collected rather than swallowed. This used to log and carry on, and the
  > import then reported success — so a board came back missing pads and said
  > nothing, which is discovered mid-show.

  `importAudioSources` — the third writer in the same function — was not changed:

  ```ts
  } catch (error) {
    console.error(
      `Failed to import audio file: ${source.name} (Original ID: ${source.originalId})`,
      error,
    );
    // Skip this file, but continue with others
  }
  ```

  The failed id never enters `audioIdMap`, so `importPadConfigurations` filters it
  out of `audioFileIds` (`:628-639`) and merely `console.warn`s. `importProfileCore`
  returns a profile id, and the UI prints `Profile "…" imported successfully!`.

  Verified against `fake-indexeddb`: `importProfileFromSyncData` with a downloader
  that throws for one of two Drive files returns a numeric profile id and leaves
  the pad holding one sound instead of two. No error, no warning, no count.

  This is not a rare path. The three ways `getBlob` can reject in production are a
  Drive/hosted download failure, a corrupt ZIP entry, and
  `QuotaExceededError` on `audioTx.done` — and there is **no**
  `QuotaExceededError` handling anywhere in the client (`rg -n "QuotaExceeded" src/`
  returns nothing), so filling the browser's storage quota mid-import is precisely
  this failure mode, at scale, silently.

- **Impact:** a restore from a `.iaz` backup, or connecting a shared profile, can
  come back with pads silently emptied and be reported as a clean success. The
  user discovers it when a pad does nothing during a show. Worse on the sync
  paths: the imported pads are stamped fresh (`initialSyncFields`), so the next
  sync can publish the emptied pads back to the person who shared them — the
  second half of 🔴 C3, reintroduced through a different door.
- **Fix:** give `importAudioSources` the same treatment the pad and page importers
  got — collect `{name, error}` per failure and either throw from
  `importProfileCore` (matching the pad behaviour, so the partial profile is
  removed) or return them so the caller can report "12 of 340 sounds could not be
  imported". Special-case `QuotaExceededError` with its own message, since
  retrying will not help. The `ZipImportResult`/`importResults` plumbing to carry
  a partial-success message to the UI already exists.

---

### 🟡 ST2 — An imported profile _record_ still lands with no `_created`/`_modified`/`_fieldsModified`

- **Class:** RECURRENCE (ST2 cited three sites — `importExport.ts:337,615,482`. `:615` and `:482` are the pad and page importers and are fixed; `:337` is this one and is not.)
- **Where:** `src/lib/importExport.ts:277-301` (`buildImportedProfileFields`) and `:354`
- **Finding:** `buildImportedProfileFields` returns `Omit<Profile, "id">` and never
  produces sync bookkeeping:

  ```ts
  return {
    name: profileName,
    syncType: link.syncType ?? "local",
    …
    createdAt: now,
    updatedAt: now,
  };
  ```

  and `createImportedProfile` writes it raw: `const profileId = await profileStore.add(newProfileData);`.
  Compare `addProfile` (`db.ts:1002`), which calls `initialSyncFields(profileData, nowMs)`
  for exactly this reason, and `importPadConfigurations`/`importPageMetadata`,
  which were both given `...initialSyncFields(…)` by commit `9dae464` with a
  comment saying it is "the entire basis `compareSyncableItems` decides a merge on".

  Verified: after a `.iaz` round trip the imported profile row has
  `_modified === undefined` and no `_fieldsModified`.

  The consequence is mechanical. `compareSyncableItems` (`syncUtils.ts:142-183`)
  reads `localFields[field] ?? 0`, so every field of an imported profile has
  `localMod = 0`; `localChangedSinceRemoteSync` is false for all of them, and the
  tiebreak at `:174-179` is `(remoteItem._modified ?? 0) > (localItem._modified ?? 0)`
  — with `localItem._modified` undefined, **remote wins every differing profile
  field on the first sync**, including `normalisation`, `activePadBehavior` and
  `backupReminderPeriod`. Note the export _does_ carry `_created`/`_modified`/
  `_fieldsModified` (`profileWire.ts:63-65`); the import discards them and does not
  stamp replacements.

- **Impact:** import a board, change its normalisation or active-pad behaviour,
  connect it to a share — the first sync silently reverts those settings to
  whatever the remote says, with no conflict raised, because the local side looks
  like it was never touched.
- **Fix:** `buildImportedProfileFields` should end with
  `...initialSyncFields(fields, now.getTime())` over the object it is returning,
  the same call `addProfile` makes. It is a pure function with its own tests
  (`profileWire`-style), so this is a two-line change plus an assertion.
- **Related (🟢, same file):** `importPadConfigurations` calls
  `initialSyncFields({ ...pad, profileId, audioFileIds: mappedAudioFileIds }, …)`
  (`:673-676`) — over the _incoming_ pad, not over `newPadData`. So wire-only keys
  (`audioFileHashes`, `audioTrimSettingsByHash`, …) get dead entries in
  `_fieldsModified`, while fields that are stored but absent from the source
  (`isDisabled`, `padGainDb`) get none — and an absent entry is a losing vote.
  Pass `newPadData`.

---

### 🟡 ST3 — The entire legacy impamp2 import path was untouched by the fix pass, and has every defect ST2 and ST3 name

- **Class:** RECURRENCE (`git log 8ffc5e0..HEAD -S importImpamp2Profile -- src/lib/importExport.ts` is empty — the function was not modified at all)
- **Where:** `src/lib/importExport.ts:1076-1398`
- **Finding:** four separate defects, all fixed elsewhere in the same file:

  1. **No sync fields on pages** (`:1316-1325`): `pageStore.add({ ...pageData, createdAt: now, updatedAt: now })`.
  2. **No sync fields on pads** (`:1347-1353`): `finalPadData` is `{ ...item.data, audioFileIds, playbackType, createdAt, updatedAt }`.
  3. **Per-record failures swallowed** at all three writers (`:1301-1303`, `:1319-1324`, `:1354-1361`) — each is a bare `.catch(err => console.error(...))`, and `importImpamp2Profile` then returns `profileId`. `ProfileManager.tsx:918` prints `Impamp2 profile imported successfully!`.
  4. **No hash on the audio** (`:1294-1297`): `audioStore.add({ ...item.data, createdAt: now })`, and `item.data` is built at `:1240-1247` with only `blob`, `name`, `type`. It also never triggers loudness analysis — `importProfileCore` fires `runBackfill()` (`:834-841`), this path does not, so every impamp2 sound plays at 0 dB normalisation until something else sweeps.

  Verified: importing a minimal impamp2 JSON produces a pad with
  `_modified === undefined` and `_fieldsModified === undefined`, a page with
  `_modified === undefined`, and an audio record with `hash === undefined`.

  There are still **zero** tests for this function — `importExport.zip.test.ts:4`
  says so in its own header, and `.claude/current_plan.md` step 5.1 records
  "`importImpamp2Profile` is still uncovered".

- **Impact:** anyone migrating from the original ImpAmp gets a board that (a) can
  silently lose pads and report success, (b) loses to the remote on the first
  sync if they later connect it, (c) triggers the full-library hash sweep of ST5,
  and (d) plays unnormalised. This is the app's on-ramp for new users.
- **Fix:** route it through `importProfileCore`. It already builds the three
  arrays; converting them to a `ProfileImportMeta` plus `ImportAudioSource[]`
  (with `hash` computed via `computeBlobHash` on the decoded blob, which it
  already holds at `:1233`) deletes steps 5–7 entirely and inherits the sync
  fields, the failure collection, the cleanup and the loudness backfill. Write the
  round-trip test first — the plan's own rule for this file.

---

### 🟡 ST4 — A failed import leaves every audio file it wrote behind, permanently

- **Class:** NEW
- **Where:** `src/lib/importExport.ts:845-864` (cleanup) and `src/lib/db.ts:1099-1157` (`deleteProfile`)
- **Finding:** `importProfileCore`'s failure path is:

  ```ts
  if (profileId !== undefined) {
    …
    await deleteProfile(profileId);
  ```

  and `deleteProfile` decides what audio to remove from the profile's _pad
  configurations_:

  ```ts
  const audioFileIds = await getAudioFileIdsForProfile(id);
  ```

  Audio is imported at step 2 (`:792`), pads at step 4 (`:806`). Anything that
  throws in between — `importPageMetadata`, or `importPadConfigurations` when even
  one pad fails — means the pads naming that audio were never written, so
  `getAudioFileIdsForProfile` returns an empty set and `deleteProfile` deletes
  zero audio files.

  Verified: an import whose two pads collide on the unique `profilePagePad` index
  ends with `profiles: 0, audioFiles: 1 ['kick.wav']`, and the logs show
  `Found 0 unique audio file IDs for profile 6` → `Deleted profile … including 0 audio files`.
  Failing in `importPageMetadata` (before _any_ pad is written) leaks the whole
  archive's audio.

  Nothing sweeps these automatically: `cleanupOrphanedAudioFiles` is only reachable
  from a button in `ProfileManager.tsx:462`.

- **Impact:** a 2 GB restore that fails at the last step leaves 2 GB of
  unreferenced blobs in IndexedDB and no visible profile. Retrying the import
  leaks another copy. On a device near its quota this makes the _next_ import fail
  too — via ST1, silently.
- **Fix:** have `importProfileCore` track the ids `importAudioSources` actually
  created (it already has `audioIdMap`) and delete them in the catch, before or
  instead of relying on `deleteProfile`'s pad-derived set. `deleteProfile` still
  has to keep files other profiles reference, so the cleanup should intersect:
  delete the newly-created ids that no surviving pad names.

---

### 🟡 ST5 — Connecting a Drive-synced profile still throws away the hashes the blob carried, guaranteeing a full-library SHA-256 sweep

- **Class:** RECURRENCE (`.claude/current_plan.md` 3.6 claims "D7 (hashes): both import paths store them now (`f583648`, `7500c72`)". Three paths carry a hash — hosted, ZIP, and Drive — and the Drive one was missed.)
- **Where:** `src/lib/importExport.ts:932-947` vs `:957-970`
- **Finding:** `ProfileSyncData.audioFiles[]` carries `hash` (`syncUtils.ts:373-382`)
  and `buildProfileSyncData` populates it for every file (`dataAccess.ts:87-90`).
  The hosted branch of `importProfileFromSyncData` consumes it:

  ```ts
  audioSources.push({
    originalId: ref.id, name: ref.name, type: ref.type,
    hash,
    serverHosted: true,
    …
  ```

  The Drive branch, four lines above, does not:

  ```ts
  audioSources.push({
    originalId: ref.id,
    name: ref.name,
    type: ref.type,
    getBlob: async () => { … },
  });
  ```

  — no `hash`, and no `serverHosted` either, even though `dataAccess.ts:64-69`
  deliberately publishes _both_ routes for a profile whose sounds are hosted, so a
  ref can legitimately carry `driveFileId` **and** `serverHosted: true` and this
  branch wins.

  Verified: importing a two-file Drive sync blob whose refs both carry hashes
  produces two `audioFiles` rows with `hash === undefined`.

  `ImportAudioSource.hash`'s own doc comment (`:379-386`) states the cost:

  > without it the record lands hashless, and the next sync that needs a hash
  > reads and SHA-256s _every_ audio file in the library one blob at a time to
  > build a fallback index.

  That index is `getHashlessIndex`, and it exists in two verbatim copies
  (`googleDrive/sync.ts:313-323`, `serverAudio/transfer.ts:258-267` — the
  duplication the plan flagged at 3.6 and left). Both loop
  `ensureAudioFileHash(localId)` over `db.getAllKeys("audioFiles")`, reading each
  whole Blob-bearing record and hashing it on the main thread.

- **Impact:** accept a Drive share of a 900-sound board and the very next sync
  reads and SHA-256s the entire local audio library, synchronously on the main
  thread — the one sweep the hash-carrying work was done to avoid. The dropped
  `serverHosted` compounds it: `uploadProfileAudio`'s "already hosted"
  short-circuit (commit `6cca9e6`, finding R4) misses, so a joiner with upload
  rights re-uploads the entire library the server already holds.
- **Fix:** `hash: ref.hash` and `serverHosted: ref.serverHosted` on the Drive
  branch. While there, collapse the three branches into one push whose `getBlob`
  picks its source — the branches differ only in how bytes are fetched, and this
  finding is exactly what having three copies costs. Fold the two
  `getHashlessIndex` copies into `db.ts` at the same time.

---

### 🟡 ST6 — A DB version bump wedges every already-open tab's neighbour, silently and forever

- **Class:** NEW
- **Where:** `src/lib/db.ts:442-451`
- **Finding:**

  ```ts
  blocked() {
    console.error("IndexedDB blocked.");
  },
  blocking() {
    console.warn("IndexedDB blocking.");
  },
  ```

  `blocking()` fires on an _existing_ connection when another connection needs to
  upgrade, and the standard (and idb-documented) response is `db.close()`. This one
  only logs, so the old connection is never released; the new tab's `openDB` never
  settles, `getDb()` stays pending forever, and every consumer that awaits it —
  `ensureDefaultProfile`, the profile store's load, `usePadConfigurations` — hangs
  with no error and no UI. `blocked()` on the new side likewise only logs, so the
  user gets a permanently blank board rather than "please close the other tab".

  `DB_VERSION` is on 6 and has been bumped five times (`db.ts:12`), so this is not
  hypothetical: it fires for anyone with the app open in two tabs (or an
  installed PWA plus a tab) across a deploy that bumps the version.

- **Impact:** after a schema-bumping deploy, a second tab shows an empty
  soundboard indefinitely with nothing in the UI to explain it. Reloading does not
  help while the first tab is open.
- **Fix:** `blocking(currentVersion, blockedVersion, event) { (event.target as IDBDatabase).close(); }`
  and surface `blocked()` through the existing error/toast path with "ImpAmp is
  open in another tab — close it to finish updating".

---

### 🟢 ST7 — "What counts as referenced" is written twice, and the copies have already drifted

- **Class:** NEW
- **Where:** `src/lib/db.ts:808-818` (`collectReferencedAudioFileIds`) vs `:1136-1148` (`deleteProfile`)
- **Finding:** `separateOrphans` was extracted specifically "so the two cannot
  disagree about what 'orphaned' means" (`:844-845`) — but it shares only with
  `findOrphanedAudioFiles`. `deleteProfile` computes the same thing a third time
  and knows about a case the shared helper does not:

  ```ts
  const pad = refCursor.value as PadConfiguration & { audioFileId?: number };
  if (pad.profileId !== id) {
    pad.audioFileIds?.forEach((audioId) => stillReferencedIds.add(audioId));
    if (typeof pad.audioFileId === "number") {
      stillReferencedIds.add(pad.audioFileId);
    }
  }
  ```

  `collectReferencedAudioFileIds` reads only `audioFileIds`. A pad still carrying
  the pre-V3 singular `audioFileId` is therefore "referenced" to `deleteProfile`
  and "orphaned" to the cleanup button. Such pads should not exist — but
  `migrateStoreV4` catches per-record update errors and _continues_ (`:257-263`),
  so a record whose migration failed keeps the old shape and survives.

- **Impact:** narrow, but the failure is deletion of a sound a pad still uses,
  triggered by a button labelled "clean up".
- **Fix:** teach `collectReferencedAudioFileIds` about the legacy field and have
  `deleteProfile` call it, so there is genuinely one answer. (Or, better, make the
  V4 migration abort rather than continue on a record it could not rewrite.)

---

## Checked and holding

Worth recording so the next review does not re-derive them:

- **ST1 (orphan cleanup across three transactions)** — genuinely fixed.
  `findOrphanedAudioFiles` and `cleanupOrphanedAudioFiles` each use one
  `["audioFiles","padConfigurations"]` transaction and share `separateOrphans`
  (`db.ts:846-982`). The comment explaining the import-window race is accurate.
- **ST4 (ZIP import validation)** — fixed properly: `MAX_ZIP_METADATA_BYTES`
  enforced against `uncompressedSize` before reading (`:1691-1703`), named JSON
  errors, and `asLeanProfile` shape-checking (`:1869-1894`).
- **ST5 (`updateLocalData` spreading wire fields into IndexedDB)** — fixed; the
  three `*ByHash` fields are destructured off before the write
  (`dataAccess.ts:468-473`). One residue: the trim/gain remap only runs inside
  `if (padWithProfileId.audioFileIds?.length)` (`:412`), so a remote pad with
  settings but no sounds stores the sender's raw ids. Harmless today (nothing
  reads a setting for an id the pad does not name) but it is a fourth copy of the
  remap rule.
- **ST6 (`renamePage`/`setPageEmergencyState` clobbering)** — fixed; both now pass
  only their own field and `upsertPageMetadata` merges inside the transaction
  (`db.ts:1547-1678`). The object literals omit the other key rather than passing
  `undefined`, so the spread is safe.
- **C2 (`duplicateProfileLocally` dropping gain)** — fixed via
  `extractPadPlaybackSettings`, and the ids stay valid because the copy references
  the same audio rows.
- **The `Record<audioFileId, …>` census** — only two such fields exist
  (`audioTrimSettings`, `audioGainSettings`). Both are remapped at all four id-
  translating sites: `importExport.ts:645-652`, `dataAccess.ts:440-459`,
  `syncUtils.ts:589-603`, and `db.ts`'s duplicate (via
  `extractPadPlaybackSettings`, which needs no remap). `AudioFile.driveFileIds` is
  keyed by _profile_ id, not audio id, and is handled separately. No new
  `Record<audioFileId, …>` field has appeared.
- **`toWireProfile`** — the allow-list plus the compile-time exhaustiveness
  assertion is the right shape, and the export path drops `lastBackedUpAt` on top
  of it. Nothing an import needs is missing from it.
