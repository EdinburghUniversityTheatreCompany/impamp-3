# Whole-feature review of syncing, 15 August 2026

Four reviews covering the sync feature as it stands, not as a diff. Between them
they found 43 issues. Earlier reviews this week were all diff-scoped, so the
merge core, the server routes and the Drive engine had never actually been read.
That is where nearly everything serious turned out to be.

**Almost none of this came from the sync-UI work.** The three worst problems
predate it. That is the main thing to take away before deciding what to do.

## TL;DR, in the order I would fix them

1. **Audio file IDs are device-local but travel in the blob as if they were
   global.** Three separate symptoms, one root cause. Worst case is a pad that
   plays the wrong sound, on every device. Verified.
2. **Sounds get silently dropped from pads** on partial or misclassified
   failures, and the drop is then published to everyone else. Four separate
   paths.
3. **A pad you just created can be deleted by the merge** as soon as any other
   device syncs first. This needs nothing exotic and is probably already
   happening.
4. **Revoking access does not revoke it.** Audio stays readable, and an open SSE
   stream keeps delivering. Verified.
5. **The UI reports success it did not observe**: skipped syncs read as synced,
   background failures never surface, a joined sync hangs on "syncing" forever.
6. Everything else: quota, cleanup, session edge cases, defect-detection gaps.

Items 1 to 4 can lose or corrupt a user's board. Item 5 is how you would fail to
notice items 1 to 4.

---

## 1. Audio IDs are device-local but travel as if global

The blob carries `audioFiles[].id`, and pads reference sounds by that ID. Those
IDs come from IndexedDB autoincrement, so they are per-device. Two devices that
each added their own sounds will both have an ID 3, meaning different audio.
Nothing in the format distinguishes "my ID 3" from "your ID 3".

Three symptoms, all confirmed by reading the code:

**1a. The merge remaps every pad, including ones the remote never touched.**
`syncUtils.ts:583`. `remoteToLocalIdMap` is keyed by the sender's IDs, then
`mergedData.padConfigurations.map(...)` rewrites all pads. If your ID 3 is a kick
and the peer's ID 3 is a snare that you also hold as ID 7, the map is `{3 -> 7}`,
and a purely local pad holding `[3]` comes out holding `[7]`. **The pad now plays
a different sound, locally and for everyone you push to.** Trim and gain settings
are remapped the same way.

**1b. Remote-only audio is appended keeping the sender's ID.** `syncUtils.ts:619`.
That produces two entries with the same `id` in one blob. Every other device then
builds `audioIdMap` in list order and the second entry wins, so pads resolve to
the other recording.

**1c. `updateLocalData`'s map has the same collision.** `dataAccess.ts:261`.

The fix is one decision, not three patches: either translate IDs only where the
remote value actually won (inside `compareSyncableItems`), or stop treating the
sender's IDs as addressable at all and key the blob's audio by content hash.
Hashes are already computed and already authoritative for matching, so the second
option is likely less work than it sounds and removes the whole class.

Note `CLAUDE.md` already warns that `audioGainSettings` must be remapped in three
places. That warning is a symptom of this design, not a solution to it.

## 2. Sounds get dropped from pads, and the drop is published

Four paths, all ending the same way. A pad loses a sound locally, and because the
pad is then pushed, every other device loses it too.

- **`syncUtils.ts:660`** - `resolveSyncedPadAudio`'s rescue only fires when
  _nothing_ resolved. A three-sound pad where one sound is unreachable comes back
  with two and `keptLocal: false`, so the truncated pad is written and pushed. The
  docstring's own argument for keeping local audio applies just as well to the
  partial case.
- **`serverAudio/transfer.ts:217`** - only `TypeError` counts as retryable. A 401
  from an expired session, or any 5xx, becomes a non-fatal warning, the sync
  proceeds, and the pads get cleared. The Drive downloader treats every throw as
  retryable, which is the correct behaviour.
- **`serverSync/sync.ts:187`** - `serverHosted` is never stored locally, it is
  re-derived each sync from the upload result. Any abort (unapproved account,
  global cap, one transient failure poisoning the `canHostAudio` cache) publishes
  a blob with the flag stripped from files that really are hosted. Readers then
  have no route to the bytes.
- **`serverSync/sync.ts:274`** - the conflict path returns before the audio
  download block, so `applyServerConflictResolution` applies a resolution whose
  audio was never fetched. Its warnings are then discarded at line 435. The Drive
  engine downloads before conflict detection and does not have this hole.

## 3. A new pad can be deleted by the merge

`syncUtils.ts:305`. The test for "is this local-only item new" is
`localItem._created > remoteLastSync`, where `remoteLastSync` is the remote
blob's last write **by anyone**. Every push stamps it, including a push with no
changes.

So: you create a pad at t=100 on device B and have not synced. Device A syncs at
t=200. B syncs at t=300, and `100 <= 200` reads as "this pad was deleted
remotely". The result is a manual conflict, the sync halts, the pad is left out
of the merged set, and the modal's "use remote" option deletes your new pad.

**In any two-device setup with periodic sync, this is the normal case rather than
an edge case.** The question the code wants to ask is "was this item in the
remote state I last saw", which is what `_lastSyncTimestamp` on the local side is
for. Same bug for `pageMetadata`.

## 4. Revoking access does not revoke access

**Audio, `api/profiles/[id]/audio/[hash]/route.ts:33`.** The only authorisation is
that the named profile's blob lists the hash. You own your own profiles and you
write your own blobs, so putting someone else's hash in your own profile gets you
a presigned download. You need to know the hash, which means you either had the
bytes or you read them out of a blob. **A collaborator whose share you revoke
keeps every hash they ever saw, and can keep fetching those sounds forever.**
Verified by reading; the reviewer also reproduced it with an unrelated,
unapproved account.

**SSE, `api/profiles/[id]/events/route.ts:26`.** Authorisation is checked once at
connect, and the stream has no lifetime. A revoked collaborator keeps receiving
version bumps until they close the tab.

Related, same file: a failed `enqueue` sets `closed` without running `cleanup`,
leaking the heartbeat interval and the subscription. And the initial version is
read before `subscribeToProfile`, so a write in that window is missed, with no
polling fallback on the client despite `events.ts` assuming one.

## 5. The UI reports success it did not observe

This is the group that matters second-most, because it is how the other four
groups stay invisible.

- **`useProfileSync.ts:174`** - `syncNow` handles `error` and `conflict` and
  funnels everything else into `noteSynced`. `skipped` is a real status:
  "Not a server-synced profile", "Paused until ...". Pause syncing in another tab,
  press Sync now here, and the card says **"Synced just now"** having done
  nothing. `commit` has the same hole, so a transition whose confirming sync was
  skipped is recorded as successful.
- **`useProfileSync.ts:177`** - `syncProfile` returns the in-flight promise
  without invoking the joining caller's callbacks (`googleDrive/sync.ts:467`,
  verified). Press Sync now while the background poll is mid-run and the card
  stays on "syncing" forever, with the button disabled, until you close and
  reopen the panel.
- **`useServerSync.ts:196` and `useGoogleDriveSync.ts:377`** - only `conflicts`
  and `conflictData` reach `syncStatusStore`. `activity` and `error` stay in the
  calling instance, which for scheduled and SSE syncs is `ClientSideInitializer`,
  which renders nothing. A profile that has been failing to sync for hours shows
  its last good "synced 3 hours ago". The store's own docstring promises the
  opposite. **This is the same hook-instance trap that caused three earlier bugs.**
- **`useServerSync.ts:143`** - `refreshSession` only refreshes the instance that
  calls it, and `ServerAccountPanel` is the only caller. Sign out of server sync
  and every profile card still believes you are signed in, the server radio stays
  enabled, and the SSE streams and scheduled syncs keep firing against a dead
  cookie until a reload.
- **`useProfileSync.ts:135`** - the Drive mirror effect patches the shared store
  on mount with no guard, so reopening a panel overwrites a recorded failure with
  `idle`/`null` and the error you were reading disappears.
- **`useProfileSync.ts:160`** - server sync warnings never reach the UI at all,
  and stale ones from an earlier transition stay pinned under every later clean
  sync.
- **`SyncControls.tsx:47`** - a failed move _out of_ local reports nothing
  anywhere, because the only error channel renders `null` while the target is
  local, and a failed transition leaves it there.
- **`ProfileCard.tsx:208`** - resolving a Drive conflict is neither awaited nor
  checked, and never clears the store, so a failed resolution closes the modal
  silently and a resolved conflict reopens on remount with stale data.

## 6. Everything else

**Hosted audio and quota**

- `server/audio.ts:179` - re-committing a hash you already hold short-circuits
  before the size and quota checks, while `recordUpload` overwrites the size from
  the bucket. Since a presigned PUT signs only `host`, you can overwrite the
  object with something much larger and re-commit. Verified by reading, and
  reproduced by the reviewer at 50 KB against a 10 KB quota. Needs an approved
  account, so the blast radius is accounts you already trust.
- `api/audio/commit/route.ts:31` - the key uses the client's `extension` rather
  than the stored object's, so identical bytes under different filenames produce
  different keys. The second user gets `alreadyStored: true, uploadUrl: null` and
  then a 404, and can never host that file. Every existing test uses `wav`, so
  this is uncovered.
- `api/audio/[hash]/route.ts:67` - library delete orphans the bucket object
  without checking profile references, so the owner's own live profile 404s
  immediately after.
- `api/audio/[hash]/route.ts:70` - the DB transaction commits before the awaited
  bucket delete, so a failed removal leaks bytes nothing counts and nothing can
  clean up.
- `api/audio/commit/route.ts:58` - the refusal-delete guard races a concurrent
  commit of the same hash.

**Protocol and server**

- `profileRequests.ts:102` - `If-Match` rejects the `"5.owner"` ETag that GET
  itself hands out, answering 428 "an If-Match header is required" to a request
  that sent one. Worth either accepting both forms or renaming so the split is
  obvious. (The two shapes are documented now, but the API should not be a trap.)
- `users.ts:57` - a recycled Google address (new `sub`, existing email) throws a
  UNIQUE violation that `establishSession` swallows, so that account silently
  never gets server sync, permanently, with only a server log.
- `api/profiles/[id]/route.ts:134` - profile delete publishes no change event, so
  watchers never find out.
- `profileRequests.ts:61` - no bound on blob size or profile count and no
  `bodySizeLimit`, on a deployment that must run as a single instance.

**State model**

- `syncState.ts:286` - a `local` profile carrying a leftover `readOnly: true` is
  permanently uneditable, with `canUnfollow` false, no defect raised, and the UI
  explaining "you have view-only access" on a profile that syncs nowhere.
- `syncState.ts:181` - `stale-server-link` is only detected under a Drive target,
  so `local` plus `serverProfileId` is invisible, even though the mirrored
  `stale-drive-link` case is detected. The rollback below produces exactly this
  state.
- `applyTransition.ts:115` - rollback restores only `plan.rollbackTo`, not fields
  the effects wrote. `adoptProfile` writes `serverProfileId` itself, so a
  `local -> server` move that fails after adoption rolls back to `local` while
  still pointing at a live server copy, which is then undetectable per the above.
- `syncReconcile.ts:35` - `hasBorrowedDriveLink` ignores `serverRole`, so an owner
  who opened their own share link gets their real Drive folder cleared. Add
  `serverRole !== "owner"`.
- `syncState.ts:348` - `syncChipText` returns early for local profiles, so a
  `stale-drive-link` never reaches the chip even though it is computed.
- `dataAccess.ts:337` - when the blob's `audioFiles` list is empty, translation is
  skipped entirely and the sender's raw IDs go straight into local pads. The gate
  should be per-pad, not per-blob.
- `useConnectServerProfile.ts:82` - a crash between the import and the
  `updateProfile` leaves a server-typed profile with no `serverProfileId`, and the
  next background sync creates a **second** server profile rather than linking to
  the one you opened.
- `useProfileSync.ts:302` - `useHostedAudioAvailability` shows the previous
  account's answer after a switch, offering a move that will fail.
- `useServerSync.ts:152` - the session-request dedupe passes `force: true`
  whenever a token exists, which is exactly the case it was written to
  deduplicate, so ten cards fire ten requests.

**Dead code**

- `syncUtils.ts:26` - `mergeFieldBasedChanges` has no callers anywhere, tests
  included.
- `syncStatusStore`'s `live` field has no writer and no reader.

## What I would actually do

Group 1 deserves a design decision rather than patches, and it is the one I would
start with. Keying the blob's audio by content hash removes 1a, 1b, 1c and
probably `dataAccess.ts:337` at the same time, and retires the three-places
warning in `CLAUDE.md`.

Group 3 is one comparison against the right timestamp and is probably the best
ratio of user-visible harm to effort in the whole list.

Group 4 is live and worth doing regardless of the rest, because it is the only
group where the damage is to someone other than the user who triggered it.

Group 5 is not glamorous, but until the UI stops claiming success it did not
observe, none of the other fixes can be confirmed in the field.

## Method, and what to distrust

Four reviews, split by seam: the pure core, the two engines, the server and API,
and the client surface. Findings marked verified above I confirmed myself by
reading the code, and in two cases the reviewer reproduced them against real
route handlers. **The rest are the reviewers' claims and I have not checked them
individually.** Past experience on this branch is that roughly one finding in
eight does not survive contact with the code, so read before fixing.

Not covered by any test today: a real two-account server share with Drive audio,
end to end. Every serious bug found this week lives on that path.
