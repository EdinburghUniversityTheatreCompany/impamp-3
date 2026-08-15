# Plan: fix the whole-feature sync review

Findings live in `plans/sync-review-2026-08-15.md` (43 of them, four seams).
Work happens in `.worktrees/fix/sync-review` on branch `fix/sync-review`, cut
from `main` at `fcf08fe` (which already contains the loudness merge).

Mick's decisions: **hash-key the blob** for group 1 rather than the targeted
patch, and **one deploy at the end** rather than shipping the security group
first. Both were made after I recommended the opposite on each, so they are
deliberate.

Verify each finding against the code before fixing it. Roughly one in eight on
this branch has not survived contact, and twice this week a "cleaner" fix
introduced something worse than the bug.

## Phase 1 - hash-key the audio references (group 1)

The root cause behind three findings: `audioFiles[].id` is an IndexedDB
autoincrement, so it means different audio on every device, and the merge
translates _every_ pad through a map keyed by the sender's ids.

Approach is **additive, not a replacement**, so no migration and no compat
window:

- the blob keeps `audioFiles[].id` and pads keep `audioFileIds`, so a client
  running older code reads exactly what it reads today
- pads gain `audioFileHashes`, and trim/gain gain hash-keyed twins
- a reader that understands hashes uses them and skips id translation entirely,
  which is what removes the class rather than narrowing it
- a reader that does not falls back to today's path

Done when: a merge between two devices whose numeric ids collide leaves every
pad pointing at the sound it started with, proven by a test that fails without
the change.

- [ ] 1.1 Add the hash-keyed fields to `ProfileSyncData` and write them in
      `getLocalProfileSyncData`
- [ ] 1.2 Prefer hashes in `updateLocalData` / `resolveSyncedPadAudio`
- [ ] 1.3 Stop `detectProfileConflicts` translating ids when hashes are present
- [ ] 1.4 Give appended remote-only audio an id unused in the merged list
      (finding 1b, still needed for the legacy path)
- [ ] 1.5 Retire the "remap in three places" warning in CLAUDE.md if it no
      longer holds

## Phase 2 - stop sounds being dropped from pads (group 2)

- [ ] 2.1 `resolveSyncedPadAudio` keeps local audio on _partial_ resolution
      failure, not only when nothing resolved
- [ ] 2.2 `serverAudio/transfer.ts` treats every throw as retryable, matching
      the Drive downloader, instead of only `TypeError`
- [ ] 2.3 Store `serverHosted` locally rather than re-deriving it each sync
- [ ] 2.4 Download audio before the server conflict path returns, and stop
      discarding `updateLocalData`'s warnings

## Phase 3 - stop the merge deleting a new pad (group 3)

- [ ] 3.1 Decide "was this in the remote state I last saw" from the local
      `_lastSyncTimestamp`, not the remote's last write by anyone
- [ ] 3.2 Same for `pageMetadata`

## Phase 4 - access control (group 4)

- [ ] 4.1 Authorise an audio download against a grant, not against a blob the
      caller wrote
- [ ] 4.2 Re-check SSE authorisation, and give the stream a lifetime
- [ ] 4.3 Run `cleanup` when `enqueue` fails, and when the signal is already
      aborted
- [ ] 4.4 Read the initial version after subscribing

## Phase 5 - stop the UI reporting success it did not observe (group 5)

- [ ] 5.1 `skipped` and `unchanged` stop being stamped as synced
- [ ] 5.2 A joined sync gets its callbacks, so the card does not hang
- [ ] 5.3 Background `activity`/`error` reach `syncStatusStore`
- [ ] 5.4 `refreshSession` crosses hook instances
- [ ] 5.5 The Drive mirror effect stops clobbering a recorded failure
- [ ] 5.6 Server warnings reach the UI and stale ones clear
- [ ] 5.7 A failed move out of local reports something
- [ ] 5.8 Drive conflict resolution is awaited, checked, and clears the store

## Phase 6 - the rest (group 6)

Quota fast path, commit key extension, delete orphaning objects, the
transaction/bucket ordering, `If-Match` rejecting its own ETag, recycled Google
email, missing delete event, body size bound, and the `syncState` /
`applyTransition` / `syncReconcile` gaps. Dead code last.

## Then

Full suites on the branch, merge to main, suites again on merged main, push
(carries the loudness work too, which Mick has approved), watch CI, deploy.
