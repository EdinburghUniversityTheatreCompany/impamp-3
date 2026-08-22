# Phase 7 review — 2026-08-22

The fourth review of the day, against `main` at `88a5005`, weighted toward the
~40 merges committed since 22:00 the previous evening. The three reviews before
it — [`repo-review-2026-08-21.md`](repo-review-2026-08-21.md), the
`/code-review` of the session diff, and
[`repo-review-2026-08-22-subsystems.md`](repo-review-2026-08-22-subsystems.md)
— are treated as answered; nothing they found is re-reported, but several of
their fixes were re-derived from scratch to see whether they hold.

**Evidence.** Every finding below cites a `file:line` and the command output,
probe run or mutation that establishes it. Probe sources were written into the
tree, run, and deleted; the exact output is quoted in place. Two proposed fixes
were applied temporarily and re-measured before being reverted. Anything that
could not be established this way is in **Claims to check** at the end and is
not counted as a finding.

## Gates, measured

| Gate                                                    | Result                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `npx vitest run` (baseline, before anything)            | **1544 passed** / 157 files, exit 0                          |
| `npx vitest run` (after the last mutation was restored) | **1544 passed** / 157 files, exit 0                          |
| mutation runs                                           | ~40, each restored with `git checkout -- <file>` immediately |
| `uptime`                                                | 1.61 at the start, 3.12–23.19 during, 3.1 for the final runs |
| e2e                                                     | deliberately not run — see the closing note                  |

---

## 🔴 High

### 🔴 1. `profile_audio.added_by` is re-attributed to whoever saves next, which 404s a collaborator's sound permanently and then lets its real holder delete the bytes

- **Where:**
  - [src/lib/server/profiles.ts:112-175](../src/lib/server/profiles.ts#L112-L175) — `reindexProfileAudio`
  - [src/lib/server/profiles.ts:157](../src/lib/server/profiles.ts#L157) — the repair's guard, `rowNeedsAdder`
  - [src/lib/server/audio.ts:184-209](../src/lib/server/audio.ts#L184-L209) — `profileMayServeHash`
  - [src/lib/server/audio.ts:266-291](../src/lib/server/audio.ts#L266-L291) — `deletingHashWouldSilenceAProfile`

- **Finding.** `reindexProfileAudio`'s own docstring states the invariant it is
  meant to hold:

  > Rows that survive the write are left alone rather than deleted and
  > re-inserted, because `added_by` records who first put a sound on this
  > profile and that must not drift. Re-inserting would re-attribute an
  > editor's sound to the owner the next time the owner saved, and the owner
  > holds no reference to it — which is precisely the 404 this column exists to
  > stop.

  The protection only covers rows that **survive** a write. A hash that leaves
  the blob for one save is `DELETE`d
  ([profiles.ts:124-132](../src/lib/server/profiles.ts#L124-L132)), and the next
  save that names it again `INSERT`s a fresh row attributing it to that
  writer — with no check that the writer holds the bytes
  ([profiles.ts:168-173](../src/lib/server/profiles.ts#L168-L173)). The repair
  added in `b311642` cannot undo it, because it is gated on
  `added_by IS NULL` and the drifted value is not null.

- **Evidence — reproduced.** Probe against `main` at `88a5005`, driving the
  real `createProfile` / `updateProfile` / `profileMayServeHash` /
  `deletingHashWouldSilenceAProfile` / `releaseReference` against an in-memory
  database:

  ```
  1 collaborator added it. added_by= { added_by: 2 }  servable= true   deleteRefused= true
  2 after the round trip.  added_by= { added_by: 1 }  servable= false  deleteRefused= false
  3 helper deleted their copy -> { removed: true, orphaned: true }
      object row now: undefined
      profile still names it: { profile_id: '…', hash: 'cccc…', added_by: 1 }
  ```

  The "round trip" between lines 1 and 2 is two ordinary saves by the owner:
  one whose blob does not name the hash, one that names it again. And the real
  holder saving afterwards does not recover it:

  ```
  3. after owner re-adds it:   added_by = 1  servable = false
  4. after holder re-saves:    added_by = 1  servable = false
  ```

  `orphaned: true` at step 3 is what
  [`route.ts`](../src/app/api/audio/[hash]/route.ts) acts on to `store.remove`
  the bucket object. The bytes are gone while `profile_audio` still names the
  hash.

- **How a hash leaves the blob — three ordinary routes, not contrived.**
  1. `audioFiles` is built from `collectReferencedAudioFileIds(padConfigurations)`
     ([googleDrive/dataAccess.ts:66](../src/lib/googleDrive/dataAccess.ts#L66)),
     so it lists exactly the sounds pads currently reference. Clearing a pad and
     syncing drops the hash; putting the sound back re-adds it.
  2. The same builder **silently omits** any audio row it cannot read —
     `console.warn("Audio file with ID … referenced but not found")` at
     [dataAccess.ts:105](../src/lib/googleDrive/dataAccess.ts#L105) — while the
     pads still reference it. That is the exact state `MissingAudioPanel` exists
     to repair, so a device in it publishes a blob that drops every affected
     hash.
  3. An **anonymous editor-link holder** may PUT
     ([route.ts:98](../src/app/api/profiles/[id]/route.ts#L98) checks only
     `canWrite(access)`, and `resolveAccess` grants `editor` on a link token
     with no account). Their write passes `writerId = null`, so it deletes rows
     their blob does not name and inserts `added_by = NULL` for the rest.

- **Impact.** Data integrity and availability, on the path whose whole purpose
  is to be conservative. A collaborator's sound goes 404 on the owner's own
  board with no error anywhere, cannot be recovered by any action either party
  can take, and the 409 that is supposed to stop the holder deleting bytes a
  board still plays now answers "no". `deletingHashWouldSilenceAProfile`'s
  docstring says the two functions "agree by construction" — they do, and after
  the drift both are wrong in the same direction.

- **Fix.** Two halves, both small:
  1. **Never record an adder who does not hold the sound.** The `INSERT` at
     [profiles.ts:168](../src/lib/server/profiles.ts#L168) should write
     `userHoldsReference(writerId, hash) ? writerId : null`. A null row is
     already the "unservable but repairable" state; a wrong non-null row is the
     unservable-and-unrepairable one.
  2. **Repair on "the recorded adder cannot serve it", not on `added_by IS
NULL`.** The security argument for the repair is entirely that the writer
     holds the bytes; the old value plays no part in it.

  Both were applied temporarily and measured. With `rowNeedsAdder` changed to
  `NOT EXISTS (SELECT 1 FROM audio_references r WHERE r.hash = pa.hash AND
r.user_id = pa.added_by)` and the `AND added_by IS NULL` dropped from the
  `UPDATE`:

  ```
  after holder saves, added_by = 2   servable = true      (was 1 / false)
  4. after holder re-saves: added_by = 2  servable = true (was 1 / false)
  ```

  and `audioShareGrant.test.ts` + `profileAudio.test.ts` stayed green, 18/18 —
  including `"does not repair the row for a writer who does not hold the
sound"`, so the property the repair exists to preserve is untouched.
  `src/lib/server/profiles.ts` was restored with `git checkout --` immediately
  afterwards.

  **Residual, stated rather than hidden:** even with both halves, there is a
  window between "the owner re-adds the hash" and "a holder next saves" in
  which the row is unservable and the holder's reference is unprotected. Closing
  that needs the delete to stop losing the attribution — either not deleting on
  absence, or keeping the adder for a hash that returns — and is the larger
  change.

### 🔴 2. The uncommitted-object sweep can never look past the first 1000 keys, so on any real bucket it removes nothing

- **Where:** [src/lib/server/audioSweep.ts:89-121](../src/lib/server/audioSweep.ts#L89-L121)

- **Finding.** `continuationToken` is declared at
  [audioSweep.ts:92](../src/lib/server/audioSweep.ts#L92) as a **local**, so it
  starts `undefined` on every pass. `scanned` is incremented at
  [line 102](../src/lib/server/audioSweep.ts#L102) for _every_ object seen —
  committed ones included, before the `getAudioObject` test at line 107 — and
  the loop breaks at `MAX_SCANNED_PER_SWEEP` (1000). Nothing persists a
  resume point, and `truncated` is returned and dropped: it is read by no
  caller (`grep` across `src/` finds only the definition, the admin route's
  pass-through JSON and comments in unrelated components).

  So once a bucket holds 1000 objects, every sweep re-scans the same first 1000
  keys in lexicographic order for ever, and any abandoned object whose key
  sorts after them is unreachable by the only mechanism that could delete it.
  `MAX_REMOVED_PER_SWEEP`'s early return at
  [line 111-113](../src/lib/server/audioSweep.ts#L111-L113) has the same shape.

- **Evidence — reproduced.** Probe with the fake object store: 1200 legitimate
  committed objects (keys `audio/00/0000…` upward) plus one ten-day-old
  uncommitted 5 GB object at `audio/ff/ffff…`:

  ```
  pass 1: { scanned: 1000, removed: 0, truncated: true }  junk still there: true
  pass 2: { scanned: 1000, removed: 0, truncated: true }  junk still there: true
  pass 3: { scanned: 1000, removed: 0, truncated: true }  junk still there: true
  ```

  The same object in an otherwise-empty bucket:

  ```
  small bucket: { scanned: 1, removed: 1, truncated: false }  junk still there: false
  ```

  So the sweep works and is only reachable below the cap. `audioSweep.test.ts`
  has five cases and its largest bucket is four objects — nothing exercises
  pagination, the caps, or `truncated` at all.

- **Impact.** This is the mechanism the whole `p3/server-abuse` branch leans
  on. `plans/off-topic-improvements.md` records the deferral of signing
  `content-length` on the ground that a caller who "declares a byte, sends five
  gigabytes and never commits still gets those bytes into the bucket **until
  the sweep reaches them**". On a deployment with a real library the sweep never
  reaches them. Combined with the licence quota — which is per-TTL-window, so a
  fresh allowance every 15 minutes, measured below — the ceiling on what one
  account can leave in a Wasabi bucket at 90-day minimum billing is unbounded.

  The operator-facing documentation states the broken behaviour as fact.
  [docs/wasabi-audio.md:68-79](../docs/wasabi-audio.md) says _"a sweep removes
  them, an hour after the upload URL that could have written them expired"_ and
  mentions neither cap; `:66` sends the reader here for the whole answer to
  uploads-under-a-lie. An admin reading that has no reason ever to look in the
  bucket.

- **Fix.** Persist the resume point across passes: hoist `continuationToken`
  (and the caps' position) to module scope beside `lastSweepAt`, storing the
  token the pass stopped at and starting the next one from it, resetting to
  `undefined` on a pass that reaches the end of the listing. Then give it the
  test the module does not have — a bucket larger than `MAX_SCANNED_PER_SWEEP`
  where the junk sorts last, which is the probe above.

### 🔴 3. The `settleAudioImports` rework closed the deleters' half of the rule and left the writers' half open — three sites write audio and the pad naming it in two transactions without declaring themselves

- **Where:**
  - [src/hooks/pad/usePadDrop.ts:64](../src/hooks/pad/usePadDrop.ts#L64) → [:74](../src/hooks/pad/usePadDrop.ts#L74)
  - [src/components/modals/BulkImportModalContent.tsx:320](../src/components/modals/BulkImportModalContent.tsx#L320) → [:329](../src/components/modals/BulkImportModalContent.tsx#L329)
  - [src/components/modals/EditPadForm.tsx:239](../src/components/modals/EditPadForm.tsx#L239) — audio written on add, the pad written on Save an unbounded time later
  - against the rule at [src/lib/db.ts:1340-1370](../src/lib/db.ts#L1340-L1370) and CLAUDE.md

- **Finding.** CLAUDE.md states the rule with no exceptions: _"Anything that
  writes an audio file and the pad naming it in **separate transactions** must
  run inside `withAudioImportInProgress`"_. `2fd611f` made all five deleters
  `await settleAudioImports()` — but that wait buys nothing unless the writer at
  risk is **in** the register. It is a two-sided rule and only one side was
  swept.

  Every `withAudioImportInProgress` call site in non-test source is five:
  `importExport.ts:1064`, `bankTransfer.ts:762`, `serverSync/sync.ts:122`,
  `googleDrive/sync.ts:540`, and the definition. None of the three sites above
  is among them, so `settleAudioImports()` returns immediately while they are
  mid-sequence. The gap is a real `await`, not a theoretical one — `usePadDrop`
  awaits `addOrReuseAudioFile` at line 64 and `savePadConfiguration` at line 74,
  two transactions with an event-loop turn between them.

- **Evidence — reproduced.** Probe of the same shape as
  `db.importRace.test.ts`: the writer paused between its two writes, the
  deleter run to completion, the writer released. The only variable is whether
  the writer is wrapped:

  ```
  PROBE B declare=false provisional=1 dropId=1 reused=true padNames=[1] rowExists=false
   × UNDECLARED: the pad editor's discard vs a drop
     AssertionError: the pad names a row that exists: expected undefined not to be undefined
  PROBE B declare=true  ... rowExists=true
   ✓ declared: the pad editor's discard vs a drop
  Tests  1 failed | 1 passed (2)
  ```

- **Impact.** A pad that renders normally and is silent for ever — the exact
  outcome `2fd611f` was written to end, and nothing reports it or can later
  distinguish it from a sound removed on purpose. The reachable trigger is one
  the register itself created: `deleteUnreferencedAudioFiles` now **parks** on
  `settleAudioImports()` behind a running Drive or server sync, both of which
  register their whole run. So the pad editor's discard-on-unmount can sit
  waiting for seconds while the user drops the same file onto a pad;
  `addOrReuseAudioFile` hands back the very row queued for discard
  (`reused=true` above) and the discard's transaction opens before the drop's
  pad write lands. Before the parking existed, the discard completed in one or
  two turns and this window was not reachable — so the fix for 08-22 🔴 2 is
  what made this one live.

- **Fix.** Wrap each sequence in `withAudioImportInProgress`: one line at
  `usePadDrop.ts:62`, one around the loop at `BulkImportModalContent.tsx:309`.
  `EditPadForm` is the awkward one — the scope would have to span the modal's
  lifetime — and the honest alternative there is for the session to publish its
  provisional ids into the register rather than hold a scope open.
  **This is the fourth instance of the same omission**, and the third is still
  open: `replaceMissingAudioFile` (`db.ts:2556`→`2563`) is the 08-22 review's
  🟡 3 and was re-checked this pass — there is still no
  `withAudioImportInProgress` on that path.

---

## 🟡 Medium

### 🟡 4. Five comments still describe the authorization branch that was removed, one of them contradicted by the test 25 lines below it

- **Where:**
  - [src/lib/server/audio.ts:165-169](../src/lib/server/audio.ts#L165-L169)
  - [src/lib/server/audio.ts:177-178](../src/lib/server/audio.ts#L177-L178)
  - [src/lib/server/db.ts:226-229](../src/lib/server/db.ts#L226-L229) — migration 5's comment
  - [src/lib/server/audioShareGrant.test.ts:1-16](../src/lib/server/audioShareGrant.test.ts#L1-L16) — the module docstring
  - [src/lib/server/audioShareGrant.test.ts:82-87](../src/lib/server/audioShareGrant.test.ts#L82-L87)

- **Finding.** `aa7d9ff` removed the live-email-share branch from
  `profileMayServeHash` and `b311642` added the NULL-`added_by` repair, both on
  `fix/hosted-audio-share-grant`. `67c6d59`, on `p3/server-abuse`, is the commit
  whose message is _"correct two comments the abuse fixes left behind"_ — it
  found two and there are at least five more. Each of these is false today:

  | Comment                         | What it says                                                                                                                          | Why it is false                                                                                                                          |
  | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
  | `audio.ts:167-169`              | "`reindexProfileAudio` is INSERT OR IGNORE, so a re-save does not fill the column in. Serving those safely needs … share acceptance." | The repair exists and works — `audioShareGrant.test.ts:107` `"repairs a row with no recorded adder when its holder next saves"` passes.  |
  | `audio.ts:177-178`              | "The email-share branch stays for rows written before that column existed."                                                           | Fifteen lines below it, the SQL at `audio.ts:189-208` has no such branch. `grep -rn "profile_shares s ON s.email" src/` returns nothing. |
  | `db.ts:226-229` (migration 5)   | NULL rows "fall back to the owner and email-editor tests exactly as before"                                                           | There is no email-editor test any more; a NULL row falls back to nothing.                                                                |
  | `audioShareGrant.test.ts:11-15` | "The branch is not removable … So it is confined to exactly those rows"                                                               | It was removed.                                                                                                                          |
  | `audioShareGrant.test.ts:83-87` | "`reindexProfileAudio` is INSERT OR IGNORE, so a re-save does not fill it in … Until then the honest answer is 404."                  | Contradicted by the next test in the same file.                                                                                          |

- **Evidence.** `grep -n "email-share branch\|email-editor\|INSERT OR IGNORE, so a\|not removable" src/lib/server/audio.ts src/lib/server/db.ts src/lib/server/audioShareGrant.test.ts` locates all five;
  `grep -rn "profile_shares s ON s.email" src/` returns no match, establishing
  that the branch is genuinely gone from source. The full suite is green, so
  nothing failed when they went stale — which is the point.

- **Impact.** Documentation only, but on the highest-stakes module in the repo,
  and it is actively misleading in the direction that costs work: two of the
  five tell the next reader that a whole class of rows can never be served and
  point at **share acceptance** as the feature needed to fix it. That work is
  also on the backlog. Someone will build it before noticing it was already
  solved a different way twelve minutes later on another branch. A stale comment
  in a migration is worse still: migrations are what people read when production
  behaves unexpectedly.

- **Fix.** Rewrite all five to describe `profileMayServeHash` as it now is —
  owner-holds, or recorded-adder-holds, with the repair as the recovery route
  for NULL rows. Worth checking
  [proofOfPossession.ts:15-16](../src/lib/server/proofOfPossession.ts#L15-L16)
  in the same pass; its "which counts a reference held by any editor of the
  profile being served" is past-tense narrative but reads as a statement of
  current behaviour.

### 🟡 5. The two audio-type allow-lists have drifted, and the comment on the newer one claims they agree

- **Where:**
  - [src/app/api/drive/public-audio/route.ts:44-71](../src/app/api/drive/public-audio/route.ts#L44-L71) — `ALLOWED_TYPES` (22 entries, added today in `5ee1fe2`)
  - [src/lib/server/audioRequests.ts:71-84](../src/lib/server/audioRequests.ts#L71-L84) — `ALLOWED_CONTENT_TYPES` (12 entries)

- **Finding.** The new list's comment says it is _"What the hosted-audio upload
  path accepts, so the two agree about what a sound file is
  (src/lib/server/audioRequests.ts)"_. It is a second copy, it is a superset,
  and nothing brought the other one along. Measured:

  ```
  $ node -e '…parse both literals…'
  upload accepts   : 12  audio/wav audio/x-wav audio/wave audio/mpeg audio/mp3 audio/ogg
                         audio/webm audio/flac audio/x-flac audio/aac audio/mp4 audio/x-m4a
  proxy accepts    : 22  (the above plus the ten below)
  proxy-only (playable from Drive, refused by hosted upload):
      audio/vnd.wave audio/x-pn-wav audio/opus audio/aiff audio/x-aiff
      audio/3gpp audio/amr audio/x-ms-wma application/ogg video/ogg
  upload-only: (none)
  ```

- **Impact.** Functional, not security — the narrow list is the one guarding
  uploads. But the client sends `contentType: file.type`
  ([serverAudio/transfer.ts:144](../src/lib/serverAudio/transfer.ts#L144)),
  i.e. whatever the browser typed the dropped file as. `audio/vnd.wave` and
  `audio/x-pn-wav` are ordinary WAV spellings, and `audio/opus` an ordinary
  Opus one. A user whose browser picks one of those gets 415 _"Only audio files
  can be hosted"_ on a file that plays perfectly on their own board and streams
  fine through the Drive proxy, with no clue what to change. The comment is what
  makes this a repo-shape problem rather than an oversight: it asserts an
  invariant that a `grep` disproves, so the next person to widen one list will
  believe they are done.

- **Fix.** One exported constant, in `audioRequests.ts`, imported by the proxy —
  the proxy's two container types (`application/ogg`, `video/ogg`) can stay a
  documented local addition on top of it. Failing that, delete the sentence
  claiming they agree, because that is the half that will cause the next bug.

### 🟡 6. `"indexes nothing for a blob whose shape it does not recognise"` only checks the harmless half, and the half it skips deletes the whole index

- **Where:** [src/lib/server/profileAudio.test.ts:159-171](../src/lib/server/profileAudio.test.ts#L159-L171), against [src/lib/server/profiles.ts:76-146](../src/lib/server/profiles.ts#L76-L146).
- **Finding.** `hashesNamedBy`'s docstring says a shape it does not recognise
  _"should index nothing rather than throw on a write path"_. In
  `reindexProfileAudio`, "index nothing" is implemented as `wanted = ∅`, and
  everything in `existing` that is not in `wanted` is `DELETE`d — so on an
  **update** the same tolerance wipes every row the profile had.

  The test that carries that property's name only calls `createProfile`, on a
  profile with no index yet, and asserts the table is empty. It cannot
  distinguish "indexed nothing" from "deleted everything", because there was
  nothing to delete.

- **Evidence.** Probe: a profile whose collaborator-added hash is indexed and
  servable, then one `updateProfile` with `data: { pads: [] }` —

  ```
  before: added_by=2  servable=true
  after unrecognised blob: row = undefined  servable = false
  ```

  and `npx vitest run src/lib/server src/app/api` is **378 passed / 29 files**
  with that behaviour in place, so nothing in the suite sees it. The same suite
  never passes `writerId` to `updateProfile` at all, which is why 🔴 1 is
  invisible to it too.

- **Impact.** Any editor — including an anonymous link-share editor — can wipe a
  profile's entire hosted-audio index with one PUT, taking every sound on that
  board to 404 and (per 🔴 1) losing the attributions permanently. It needs a
  hand-made body rather than the app's own client, which is why this is 🟡 and
  not 🔴, but nothing on the server validates the shape.
- **Fix.** Make `reindexProfileAudio` no-op when `audioFiles` is absent or not
  an array, rather than treating it as "names nothing" — an unrecognised blob
  genuinely carries no information about what to delete. Then extend the test to
  the update case, which is the one that can fail.

### 🟡 7. One failed search leaves the box permanently "Still searching", says nothing, and cannot be retried

- **Where:** [src/hooks/useSearch.ts:234-236](../src/hooks/useSearch.ts#L234-L236) (the `catch`), [:256-258](../src/hooks/useSearch.ts#L256-L258) (`isStale`), [:251](../src/hooks/useSearch.ts#L251) (the effect deps); consumed at [SearchModal.tsx:226-233](../src/components/search/SearchModal.tsx#L226-L233) and [:304-314](../src/components/search/SearchModal.tsx#L304-L314).
- **Finding.** The `catch` logs to the console and returns. `setCompleted` is
  never reached, so `completed.term` never becomes `searchTerm` and `isStale`
  stays `true` for that term for ever — and the effect only re-runs on
  `[searchTerm, activeProfileId, debounceTime, hasQuery]`, so nothing ever
  retries.
- **Evidence — probe, all assertions passed.** After one rejected
  `getAllPadConfigurationsForProfile`: 60 s of fake time produce **zero**
  further read attempts; `results` still holds the _previous_ term's hits,
  `resultsTerm` still `"horn"`, `isStale === true`, `isLoading === false`; the
  hook's return value exposes no `error` field, so the only trace is
  `console.error`; and restoring a working mock plus another 60 s does not
  clear it.
- **Impact.** The modal renders `Searching…` in place of "Enter plays the first
  result" indefinitely, and every Enter answers _"Still searching. These results
  are for “horn” — press Enter again in a moment"_ — advice that can never come
  true. The operator's only escape is typing a different term. This is the exact
  shape three sibling panels were fixed for **today** (`e010816` "say so when a
  maintenance scan fails", `07a8c6b`, `317bc70`); the search hook is the
  neighbour that did not get the fix, in a feature shipped the same morning.
- **Fix.** Record the failure in `completed` (or a sibling `failedTerm`) so
  `isStale` clears, and expose it so the modal can say _the search failed_
  rather than _still searching_.

### 🟡 8. Enter is swallowed in silence when the previous query found nothing — same state, opposite behaviour

- **Where:** [SearchModal.tsx:208-236](../src/components/search/SearchModal.tsx#L208-L236) (`handleInputKeyDown`); the header hint gated at [:304](../src/components/search/SearchModal.tsx#L304).
- **Finding.** `const first = results[0]; if (!first) return;` (lines 211-212)
  sits **above** the `isStale` branch (line 226). So in one state — `isStale`
  true — the modal does two opposite things depending on something irrelevant:
  - previous term matched something → the _"Still searching…"_ notice renders;
  - previous term matched **nothing** → nothing at all. No notice, no hint (it
    is gated on `results.length > 0`), no `preventDefault`.
- **Evidence — probe, 2/2 passed.** With `isStale: true, results: []`,
  `search-activation-notice` is `null`, `search-activation-hint` is `null`, and
  `event.defaultPrevented === false`; with the identical state plus one listed
  result, the notice contains `"Still searching"`.

  The comment justifying the early return
  ([:204-207](../src/components/search/SearchModal.tsx#L204-L207)) —
  _"claiming Enter with no result to activate would swallow the emergency cue
  behind an open, empty search box"_ — is **false**, proven by a second probe
  (3/3): with `isSearchModalOpen: false` Enter fires the cue once; with it
  `true` the cue is never reached; and a keydown whose target is an `<input>`
  never reaches it either. `useIsAnyOverlayOpen.ts:31-33` ORs in the _same_ flag
  `SearchProvider.tsx:78` passes as `isOpen`, and `useKeyboardListener.ts:189-191`
  returns on it long before the Enter branch at `:275`. So the premise the
  ordering was built to protect does not exist.

- **Impact.** The one flow the Enter handler was added for — type, Enter, no Tab
  — fails silently exactly after a no-match query, which is the moment an
  operator is most likely to be correcting a typo under pressure.
- **Fix.** Move the `isStale` branch above `if (!first)`, and render the
  `Searching…` hint whenever `isStale` rather than only when results happen to
  be listed.

---

## 🟢 Low

### 🟢 9. `dropCachedLoudness` was extracted as the counterpart to `clearCachedAudioBuffer` and adopted by one of the four deleters

- **Where:** [src/lib/audio/loudness/cache.ts:73](../src/lib/audio/loudness/cache.ts#L73); called only from [src/lib/audioDedup.ts:423](../src/lib/audioDedup.ts#L423). Missing from `deleteUnreferencedAudioFiles` (`db.ts:1336`), `cleanupOrphanedAudioFiles` and `deleteProfile` — each of which does call `clearAudioCacheEntries`.
- **Evidence.** `grep -rn "dropCachedLoudness" src --include=*.ts | grep -v '\.test\.'` returns two lines, the definition and the one caller. Probe: set a measurement, delete the row through each deleter, read the cache back —

  ```
  PROBE A1 deleteProfile:       row=GONE loudnessCached=true size=1
  PROBE A1 deleteUnreferenced:  deleted=1 row=GONE loudnessCached=true
  PROBE A1 orphanSweep:         deletedCount=1 row=GONE loudnessCached=true
  Tests  3 failed
  ```

- **Impact.** Unbounded growth of the in-memory loudness map for the session; it is otherwise only emptied wholesale at profile activation. Not a wrong-gain bug — IndexedDB's autoIncrement never reissues a deleted id — so this is hygiene. Named because it is the classic partly-adopted-helper shape and the extracting commit's own message calls out the gap.
- **Fix.** Fold it into `clearAudioCacheEntries` so the two maps have one writer.

### 🟢 10. `findMissingAudioFiles` reads only `audioFileIds`, while everything else that decides what is referenced also reads the pre-V3 scalar

- **Where:** [src/lib/db.ts:2516-2518](../src/lib/db.ts#L2516-L2518) (`if (!pad.audioFileIds) continue;`) vs `collectReferencedAudioFileIds` at [db.ts:1201-1216](../src/lib/db.ts#L1201-L1216), which explicitly also reads `pad.audioFileId`.
- **Evidence.** `collectReferencedAudioFileIds`'s docstring was written after exactly this drift ("`deleteProfile` used to compute this itself and knew about the pre-V3 singular `audioFileId` while this did not"). The missing-audio scan is the copy that still does not know. Probe with a pad on the legacy shape naming an id no row holds: `PROBE A2 missing=[]` — `expected [] to include 999999`.
- **Impact.** The Missing Audio panel silently under-reports for pads left on the pre-V3 shape — and that population is real rather than theoretical: `db.ts:455-467` documents a migration-sequencing bug (since fixed, covered by `db.v7Sequencing.test.ts`) in which "a pad can keep its legacy `audioFileId` and never gain `audioFileIds`". Any device that upgraded before that fix has exactly those rows. Direction is safe — it under-reports rather than over-deletes — but this is the one panel whose whole job is finding them.
- **Fix.** Route the loop through the same helper.

### 🟢 11. `deleteAudioFile` is a sixth deleter of audio rows — no settle, no reference check, and no caller

- **Where:** [src/lib/db.ts:973-978](../src/lib/db.ts#L973-L978).
- **Evidence.** `grep -rn "deleteAudioFile\b" src --include=*.ts --include=*.tsx | grep -v deleteAudioFiles` returns two lines: the definition, and a **comment** at `EditPadModalContent.tsx:38` warning not to use it. Zero call sites, tests included.
- **Impact.** `settleAudioImports`'s docstring says the rule covers "five deleters" and enumerates them; this is a sixth, public, that deletes by id and checks no reference. 08-21's 🟡 7 removed four uncalled exports and this one survived without the documented justification `addAudioFile` has.
- **Fix.** Delete it.

### 🟢 12. The new background-analysis guard and `getAudioContext` disagree about what "this browser can decode" means

- **Where:** [src/lib/db.ts:772](../src/lib/db.ts#L772) (`if (typeof AudioContext === "undefined") return;`, added today in `6a0085a`) vs [src/lib/audio/context.ts:34-37](../src/lib/audio/context.ts#L34-L37) (`window.AudioContext || extendedWindow.webkitAudioContext`).
- **Evidence.** `grep -n "webkitAudioContext" src/lib/audio/context.ts` → `:12`, `:37`; the same grep over `db.ts` returns nothing.
- **Impact.** On a browser with only the prefixed constructor, playback works and loudness analysis is silently skipped for every file added. Practically dead — unprefixed `AudioContext` has been in Safari since 14.1 — but it is now two definitions of one predicate, which is the failure mode this repo names.
- **Fix.** Reuse `context.ts`'s test, or drop the prefixed fallback there.

### 🟢 13. `resolveActivePadBehavior`'s docstring says it has no caller

- **Where:** [src/lib/db.ts:117](../src/lib/db.ts#L117) — "It has no caller yet — Task 8 wires it".
- **Evidence.** `grep -n resolveActivePadBehavior src/lib/audio/controls.ts` → `:15` (import) and `:333` (call). The sentence after it, about `TriggerablePad` not declaring the field, is also no longer true (`triggerPad.ts:41` `extends PadPlaybackSettings`).

### 🟢 14. `errorMessage` was extracted today and three byte-identical private copies of it were left in place

- **Where:** [src/lib/errorMessage.ts:10-12](../src/lib/errorMessage.ts#L10-L12), against
  [ExportBanksPanel.tsx:49-51](../src/components/profiles/ExportBanksPanel.tsx#L49-L51),
  [BankImportPlacementDialog.tsx:91-93](../src/components/profiles/BankImportPlacementDialog.tsx#L91-L93) and
  [applyTransition.ts:41-42](../src/lib/applyTransition.ts#L41-L42).
- **Evidence.** The helper's own docstring says it is _"Written once so the
  three of them cannot disagree"_. `grep -rn 'from "@/lib/errorMessage"'` finds
  exactly three importers — `MissingAudioPanel`, `DuplicateAudioPanel`,
  `OrphanedAudioPanel`, i.e. the three the docstring names. The three files
  above each define a local `message(error: unknown)` whose body is
  `error instanceof Error ? error.message : String(error)` — the same
  expression, character for character. `BankImportPlacementDialog.tsx` was
  edited today and its copy survived the edit.
- **Impact.** None today; four identical implementations behave identically.
  Named because it is the exact "helper extracted and partly adopted" shape
  CLAUDE.md warns about, and because the jscpd-at-0 gate cannot see it: these
  are one-liners, below the clone detector's minimum token count. The docstring
  asserting "written once" is what makes it worth fixing rather than leaving.
- **Fix.** Delete the three locals and import the helper. The other `instanceof
Error` sites in the tree supply a _different_ fallback string ("Unknown
  error", "Failed to invite") and are deliberately not the same function —
  leave them.

### 🟢 15. Two of `dropRefusalReason`'s three branches are unreachable, and its test cannot see that

- **Where:** [src/hooks/pad/usePadDrop.ts:117-140](../src/hooks/pad/usePadDrop.ts#L117-L140); call site [PadGrid.tsx:429](../src/components/PadGrid.tsx#L429); blocked by [Pad.tsx:107-123](../src/components/Pad.tsx#L107-L123).
- **Evidence.** `Pad.handleAudioDrop` returns before calling `onDropAudio` when
  `soundCount > 1`, so PadGrid's `"it already holds N sounds"` refusal can never
  be logged. Probe drove a real `drop` event through the real `react-dropzone`:
  control (`soundCount={1}`) → `onDropAudio` called once; `soundCount={2}` →
  never called. The `isSpecialPad` branch is dead too — `dropRefusalReason` is
  only called in the "Regular Pad Logic" path, below early returns for exactly
  `STOP_ALL.index` and `FADE_OUT_ALL.index`, which are precisely the members of
  `SPECIAL_PAD_INDICES` (`constants.ts:58-61`). Only `!canEdit` is live, and
  that is the single case `PadGrid.dropRefusal.test.tsx` exercises — with `Pad`
  stubbed to a props recorder, which its own docstring says.
- **Impact.** The `> 1` refusal message duplicates `Pad.tsx:188/556-561`'s
  overlay text and `Pad.tsx:111-113`'s log — the same rule in three places, two
  of them unreachable. Low today; it is the repo's named regression shape.
- **Fix.** Delete the two dead branches, or move the `soundCount > 1` decision
  out of `Pad` so the one helper owns it.

### 🟢 16. `min-h-screen` (`100vh`) survives in three places after "measure against the visible viewport"

- **Where:** [src/app/drive/open/page.tsx:141](../src/app/drive/open/page.tsx#L141), [:260](../src/app/drive/open/page.tsx#L260); [src/app/server/open/page.tsx:121](../src/app/server/open/page.tsx#L121).
- **Evidence.** `git grep -n "vh\]\|min-h-screen\|h-screen\|100vh" HEAD -- 'src/**/*.tsx' 'src/**/*.css' | grep -v dvh` returns exactly those three lines. Compiling `globals.css` with `@tailwindcss/cli` produces `.min-h-screen { min-height: 100vh; }` beside `.min-h-dvh { min-height: 100dvh; }`. Commit `3053f9b` claims "Every viewport unit in the app was `vh`… one bug in eight places"; it fixed eight and left three.
- **Impact.** Cosmetic, on two rarely-seen landing pages: content centres slightly low and the page scrolls on mobile with browser chrome visible.

### 🟢 17. `pb-safe`, newly given a definition, now pads a panel that is not at the bottom

- **Where:** [src/app/globals.css:112-114](../src/app/globals.css#L112-L114); [ArmedTracksPanel.tsx:73](../src/components/ArmedTracksPanel.tsx#L73); DOM order at [page.tsx:390-393](../src/app/page.tsx#L390-L393).
- **Evidence.** The compiled output is
  `.pb-safe { padding-bottom: max(0.5rem, env(safe-area-inset-bottom)); }`.
  Before `d6850ed` the class emitted **no CSS at all** — that commit's own
  message says so. It is on **both** track panels' scroll boxes, and
  `ArmedTracksPanel` renders _above_ `ActiveTracksPanel` inside the sticky
  footer, so every device now gets at least `0.5rem` of padding inside two
  scroll containers that previously had none.
- **Fix.** Keep `pb-safe` on the bottom-most element only — the sticky wrapper
  in `page.tsx`, or `ActiveTracksPanel` — and drop it from `ArmedTracksPanel`.

---

## Test trustworthiness

Everything in this section was established by **mutating the source, running the
suite, and reading the output**, then restoring the source. A test that stays
green under the mutation of the behaviour it names is listed here.

### 🟡 18. `SearchModal`'s two key filters can both be deleted with the whole suite green

- **Where:** [SearchModal.tsx:209](../src/components/search/SearchModal.tsx#L209) (`if (e.key !== "Enter") return;`) and [:248](../src/components/search/SearchModal.tsx#L248) (`if (e.key !== "Enter" || !hasArmModifier(e)) return;`). Test file: `SearchModal.test.tsx`, 17 tests.
- **Evidence — mutated and re-run twice, once by each of two reviewers
  independently.** Deleting line 209:

  ```
  $ npx vitest run --exclude '**/__probe*'
   Test Files  157 passed (157)
        Tests  1544 passed (1544)
  ```

  Deleting line 248 alone: the same, `1544 passed`. Control — deleting
  `:212 if (!first) return;` in the same handler — correctly dies
  (`1 failed | 1543 passed`), so the file is reached and the mutants are not
  equivalent. A probe with both filters removed proves the behaviour change
  directly: _"an ordinary character typed in the box plays nothing"_ and _"an
  ordinary character on a result button arms nothing"_ both fail with
  `expected "vi.fn()" to not be called at all, but actually been called 1 times`.

- **Why nothing sees it.** `SearchModal.test.tsx`'s only key helper is
  `pressEnter()` (`:194-207`, `:334-343`), which hard-codes `key: "Enter"`.
  The e2e spec is no better: `e2e-tests/search-result-keyboard.spec.ts:57`
  fills the box with `.fill()`, which dispatches **no `keydown` at all**, and
  every `page.keyboard.press` in it is `Enter` or `Control+Enter`. So no test
  in the repo has ever sent this component a key that is not Enter.
- **Impact.** The code is correct today; what is missing is any gate on it.
  Without `:209` every character typed into the search box fires an irreversible
  cue and calls `preventDefault()`, on a board used to run live shows — and the
  whole feature shipped this morning (`34c1a71`, `b00ea89`, `2d447de`), so it
  has had exactly one day of review and no coverage of its central guard.
- **Fix.** Press `"a"` on the input and `"x"` on a result (with and without the
  arm chord) and assert `triggerPad`/`armTrack` untouched and
  `defaultPrevented === false`. Have the e2e helper `pressSequentially` rather
  than `fill`, so the browser path is covered too.

### 🟡 19. `"does not repair the row for a writer who does not hold the sound"` cannot fail

- **Where:** [audioShareGrant.test.ts:135-162](../src/lib/server/audioShareGrant.test.ts#L135-L162), guarding [profiles.ts:158](../src/lib/server/profiles.ts#L158) (`if (userHoldsReference(writerId, hash)) {`).
- **Evidence — mutation.** `if (userHoldsReference(writerId, hash))` →
  `if (true || userHoldsReference(writerId, hash))`:

  ```
  npx vitest run src/lib/server/audioShareGrant.test.ts
   Test Files  1 passed (1)
        Tests  5 passed (5)
  ```

  The guard the test is named for was disabled and all five stayed green. The
  mutant is not equivalent — a probe asserting the _column_ instead of the serve
  decision goes red: `expected 1 to be null`.

- **Why it passes anyway.** Its only assertion is
  `profileMayServeHash(profile.id, owner.id, HASH) === false`. With the guard
  gone `added_by` becomes `owner.id`, but the reference row belongs to
  `helper.id`, so the query still answers false. The assertion is true for a
  reason unrelated to the behaviour being tested.
- **Impact.** This is the one test standing between the repair path and "the
  bypass again with an extra step", in its own words — and it is exactly the
  vacuity that lets 🔴 1 exist. A regression dropping the holder check writes a
  permanent wrong adder, which `rowNeedsAdder` can then never repair.
- **Fix.** Assert the stored column: `added_by` is `null` after the
  non-holder's write and `helper.id` after the holder's. Keep the
  `profileMayServeHash` line as a second assertion.

### 🟡 20. All three "a follower may not edit" guards in `profileStore` can be deleted with the whole suite green

- **Where:** [profileStore.ts:503](../src/store/profileStore.ts#L503) (`setEditMode`), [:514](../src/store/profileStore.ts#L514) (`setDeleteMoveMode`), [:526](../src/store/profileStore.ts#L526) (`toggleDeleteMoveMode`).
- **Evidence — mutation, individually and together.** Removing each
  `if (isActive && !get().canEditActiveProfile()) return;` →
  `Test Files 157 passed (157) / Tests 1544 passed (1544)`, three times over. A
  probe with all three removed fails three ways
  (`expected true to be false` for each of `setEditMode(true)`,
  `setDeleteMoveMode(true)`, `toggleDeleteMoveMode()`), so none is equivalent.
- **Why.** `profileStore.test.ts:135-187` tests `canEditActiveProfile()` itself
  thoroughly — including `"says no for a followed profile"` — and never calls a
  single consumer. This is the repo's own recorded regression shape
  (`fixes-take-data-leave-guard`): the predicate is tested, the guards that use
  it are not. From `b880d02` (2026-08-14), not today, but the same class.
- **Impact.** A followed or view-only profile could be put into edit mode and
  delete-move mode, producing exactly the edits `b880d02`'s message says the
  next sync destroys.
- **Fix.** Three assertions in the existing "whether the active profile may be
  edited" block, on the followed-profile fixture already there.

### 🟢 21. Seven more guards with a comment explaining them and no test behind them

Each was removed and the whole suite re-run; each left `1544 passed`.

| Where                                       | Guard removed                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useSearch.ts:152`                          | `if (!bank) continue;` — has a three-line comment ("skip it rather than showing a result Enter can't reach")                                                                                                                                                                                                                                |
| `useSearch.ts:115`, `:139`                  | `if (cancelled) return;` — the whole cancellation race is untested                                                                                                                                                                                                                                                                          |
| `useSearch.ts:100`, `:146`                  | `if (!hasQuery) return;` and the empty-`audioFileIds` skip                                                                                                                                                                                                                                                                                  |
| `useSearch.ts` `isStale`                    | dropping `completed.profileId !== activeProfileId` — the profile half is documented in the JSDoc; `useSearch.test.tsx` mocks `activeProfileId` to a constant `1`                                                                                                                                                                            |
| `audioSweep.ts:161`                         | `if (sweepTimer) return;` — `ensureSweepScheduled`'s idempotence is untested, and every call would leak an hourly interval                                                                                                                                                                                                                  |
| `BankImportPlacementDialog.tsx:237`, `:188` | `if (!canImport) return;` and `if (placement.kind !== "replace") continue;`. This **extends** the 08-22 review's claim-to-check about `:441`: the neighbouring `expect(button.disabled).toBe(true)` covers the _attribute_, but the handler's own guard has nothing behind it. The equivalent line in `bankTransfer.ts:1127` kills 10 tests |

About 25 further defensive null-skips also survived (in `audioDedup.ts`,
`syncUtils.ts`, `googleDrive/`, `importExport.ts`) and are **not** listed as
findings: no fixture produces their falsy input, so they are plausibly
near-equivalent mutants rather than gaps.

### The 08-22 review's test findings 14-19: none has been fixed

Re-checked directly rather than assumed:

- **14** — `loadPipeline.test.ts:76`'s regex is unchanged.
  `/import\(\s*["'][^"']*loudness\/pipeline["']\s*\)/.test('return import("./pipeline");')` → **false**, and `loadPipeline.ts:43` is exactly `import("./pipeline")`. The scan still matches nothing.
- **15** — `db.audioNameIndex.test.ts:50`'s regex is unchanged: it sees `store.index("name")` and not `db.getFromIndex("audioFiles", "name", x)`.
- **16** — flipping `audioHashIndex.ts:68` from first-wins to last-wins leaves `1544 passed`; `db.ts:1099` is still a bare `built.set(...)`. The two indexes still disagree and neither rule is pinned.
- **18** — `MissingAudioPanel.tsx:239`'s per-profile filter → `.filter(() => true)` leaves `1544 passed`. (The line has moved to 239 and now destructures `{ entry }`, so the 08-22 report's line reference is stale.)
- **19** — `src/lib/bankSummaries.test.ts` still does not exist.
- **17** was not re-checked.

---

## Verified clean — do not re-spend the budget

Things re-derived from scratch this pass and found holding, with what
established it:

- **All 18 of today's `fix(...)` commits are covered at commit granularity.**
  Reverting each commit's non-test source to its parent turned the suite red
  every time, between 2 and 69 failures. So the day's fixes were genuinely
  tested; the gaps found above are in guards the fixes did not touch.
- **All four `settleAudioImports()` call sites in `db.ts`** (`:1322`, `:1451`,
  `:1509`, `:1705`) are load-bearing — each removal fails 4-7 tests.
  `db.importRace.test.ts` is sound.
- **`vitest.config.ts` is clean.** Today's only change (`b027629`) _raised_ the
  ratchet, 58/49/55/59 → 60/52/57/61. No `exclude` was added today to make a
  gate pass.
- **Today's test-only commits are legitimate.** `9501494`, `775f470` and
  `8fba074` are flake fixes carrying their own mutation evidence in the commit
  messages, not weakenings.
- **The pending-upload quota** (`src/lib/server/audio.ts:293-513`,
  `p3/server-abuse`). Probed against the real `canUpload` /
  `recordPendingUpload` with a 10 MB allowance: two 4 MB licences allowed, the
  third refused `user_quota` at `usedBytes: 0`, a re-mint of an already-licensed
  hash allowed (so a retry after a failed PUT is not double-charged), and the
  charge lapsing once the mint is older than the TTL. All four documented
  properties hold. The one thing to know is that "lapses after the TTL" means a
  fresh allowance every `IMPAMP_AUDIO_UPLOAD_URL_TTL` — which is by design, and
  is only a problem because the sweep behind it does not work (🔴 2).
- **`profileMayServeHash` cannot be manufactured by an owner.** The 08-22
  review's 🔴 1 fix holds: the live-share branch is gone from the SQL, both
  remaining branches join through `audio_references`, and a row whose recorded
  adder holds nothing serves nobody — including via the `INSERT` path, which
  records an adder without checking they hold the bytes but is caught at read
  time. Confirmed by probe (`servable = false` at every step where the recorded
  adder held nothing) and by `audioShareGrant.test.ts` 5/5.
- **`objectKeyForHash` cannot be injected through `extension`.**
  `parseAudioFields` accepts any string, but
  [s3/client.ts:88](../src/lib/server/s3/client.ts#L88) strips it to
  `[a-zA-Z0-9]` and lowercases — which is also why `audioSweep`'s
  `hashForKey` regex (`[a-z0-9]+`) can match every key the app mints.
- **The icon barrel is genuinely gone** (`7c10006`): `src/components/icons/`
  holds 21 files and no `index.ts`.
- **`MAX_PROFILES_PER_USER` is enforced**, at
  [api/profiles/route.ts:33](../src/app/api/profiles/route.ts#L33), not merely
  defined.
- **`useSearch`'s staleness flag, re-derived from scratch.** `results` and
  `(term, profileId)` are set in one `setCompleted` call, so `isStale === false`
  provably implies the visible results were computed for the current term **and**
  the current profile — there is no interleaving where it reports fresh while
  stale. Cancelled searches cannot write (`cancelled` is checked before every
  `setCompleted`). The only defect is the never-clearing direction, 🟡 7.
- **The icon extraction is glyph-exact.** A per-hunk script over
  `6324667 d35bcc3 025bc4b cd4235a c261e2a` matched every removed `d="…"`
  against the path data of the component that replaced it in the same hunk:
  **26 hunks matched, 0 mismatches**. The only two unmatched paths are the Drive
  page's old quarter-arc spinner unified onto the shared `SpinnerIcon`, which is
  what that commit set out to do. No barrel crept back
  (`grep -rn 'from "@/components/icons"' src` → nothing; `grep -rln "<svg" src`
  → only `Icon.tsx`). No accessibility was lost: no inline `<svg>` in the
  pre-extraction tree carried `aria-label` or `<title>` (checked at `27f5594^1`),
  and exactly one icon is given a `title` today, matching CLAUDE.md. Every call
  site outside `components/icons/` passes a `className`, and the sizes match.
- **Every hand-resolved merge conflict in the whole run, read.** Of the 23
  merges since 2026-08-21 22:00, `git show --cc … -- src/ e2e-tests/` finds
  hand-resolved hunks in exactly **three** files, and all three are benign:
  `audioDedup.importRace.test.ts` in `be0d875` (a docstring, both sides' prose
  merged), and `MissingAudioPanel.tsx` + `OrphanedAudioPanel.tsx` in `27f5594`
  (import blocks, `p2/icons`' `SpinnerIcon` against `p2/panels`'
  `errorMessage` — both kept). Everything else conflicted only in
  `plans/off-topic-improvements.md`. So the "textually clean, semantically
  wrong" merge this review was told to hunt for is **not** where today's bugs
  came from; every 🔴 above is a fix that was incomplete on its own branch.
- **CLAUDE.md's client invariants hold.** `stopPropagation` on the layer-count
  button (`shared/PadTrackGroup.tsx:49`, with its test);
  `disableInteractiveElementBlocking` present; no raw `ctrlKey` in any pointer
  path; `EditPadForm`'s `${fileId}-${occurrence}` `rowId` drives the React key,
  the dnd id and all four `data-testid`s, and `handleRemoveSound(sound.dndId)`
  is derived from it; `event.defaultPrevented` early return present at
  `useKeyboardListener.ts:221-223`.
- **The `MAX_BANKS` move is behaviour-preserving**: the old
  `convertBankNumberToIndex` special-cased `0 || 10 → 9`; the new code returns 9
  for both (`0` explicitly, `10` via `n-1`).
- **Banners cannot stack**: `setEditMode` returns early when
  `!canEditActiveProfile()` (`profileStore.ts:503`), so the amber EDIT MODE
  banner and the VIEW ONLY banner can never both be `fixed top-0`.
- **Special-pad reordering is sound**: `order-[9999]` on Stop All vs
  `order-[9998]` on Fade Out All puts Fade Out then Stop All last in portrait,
  with `lg:order-none` restoring DOM order — safe only because `Pad` is
  `tabIndex={-1}`, which it still is (`Pad.tsx:437`).
- **The `settleAudioImports` rework's deleter half, re-derived from scratch.**
  All five deleters have `await settleAudioImports()` as the **last statement
  before** their transaction, verified textually (`db.ts:1322`→`1323`,
  `1451`→`1456`, `1509`→`1510`, `1705`→`1707`, `audioDedup.ts:290`→`291`).
  `withAudioImportInProgress` (`db.ts:1388-1401`) registers a promise it owns
  and de-registers in a `finally`, so the register is provably clear before the
  caller's `catch` body runs. (The **writer** half is 🔴 3 above.)
- **`importProfileCore`'s rollback really is outside the scope.**
  `importExport.ts:1064` opens it, `runProfileImport`'s catch (`:1245`) throws
  `FailedProfileImport` carrying `profileId` + `createdAudioIds`, and
  `rollbackFailedProfileImport` (`:1276`) runs in `importProfileCore`'s catch at
  `:1078` — one line past the scope. `importProfile`,
  `importProfileFromSyncData`, `importImpamp2Profile`, `importMultipleProfiles`
  and `importProfilesFromZip` all call it sequentially: **no nesting**.
- **No nested `withAudioImportInProgress` today, and no deleter inside a scope.**
  Grepping the six deleter names across `serverSync/`, `googleDrive/`,
  `serverAudio/` and `syncUtils.ts` returns one hit and it is a comment. The
  deadlock the backlog note describes is genuinely latent, exactly as written.
- **Bank import's all-or-nothing.** Capacity, duplicate-replace-target and
  snapshot are all taken before the first write (`bankTransfer.ts:1117-1152`);
  `rollbackBankImport`'s `undo` predicate (`:1269-1270`) covers both "bank the
  profile did not hold" and "bank we replaced";
  `deleteUnreferencedAudioFiles(createdAudioIds)` runs **after** the restore and
  **outside** every per-bank scope (`:1226-1236`).
- **`collapseDuplicateAudioGroups`** re-reads every canonical inside the
  transaction, skips a group naming its own survivor among the doomed, remaps
  both settings maps in `"keep"` mode with the survivor's own entry restored,
  and inherits the loudness measurement _before_ dropping it. Groups are
  hash-disjoint so the chained-canonical case cannot arise.
- **Playback keys.** `LAYER_SEPARATOR` is the only `"#"` in `types.ts`;
  `splitInstanceKey` splits at `lastIndexOf` and requires an all-digit tail;
  `getStrategy` is keyed on `baseKey` (`controls.ts:409`); `layersByBase` still
  has only `claimPlaybackKey`/`clearTrackState` as writers.
- **The only two branches touching `db.ts`** (`p3/import-race`, `p5/mobile`)
  touched disjoint functions — `git diff 6f32e9e^1 6f32e9e -- src/lib/db.ts` is
  entirely inside `startBackgroundAnalysis`.
- **The three inline plural ternaries** left by the `count()` sweep
  (`importExport.ts:463`, `importExport.ts:796`,
  `BankImportPlacementDialog.tsx:309`) are each correct as written, and all
  three are already recorded as deliberate deferrals in
  `plans/off-topic-improvements.md`. Not a finding; noted so the next reviewer
  does not spend the grep.

## Claims to check

- **The size of the `pb-safe` regression on a notched iPhone (🟢 17).** On a
  notched device in standalone mode `env(safe-area-inset-bottom)` is around
  34 px, which would land as dead space _between_ the two track panels rather
  than clearing the home indicator. The CSS emitting and the DOM order are
  proven; the inset magnitude could not be measured from here.
- **A stale pointer in CLAUDE.md, not a code defect.** It says *"the `Draggable`
  in `BankTabStrip.tsx` must keep `disableInteractiveElementBlocking`"`*; the
guard is intact but now lives in `src/components/BankTabsDraggable.tsx`
(`grep -rl` finds it only there).

Otherwise: nothing this pass. Every item above was established by a probe run, a
mutation, or a command whose output is quoted. The two items that were
originally written as claims — the unrecognised-blob wipe and the drift's
effect on `deletingHashWouldSilenceAProfile` — were both promoted after being
reproduced (🟡 6 and 🔴 1).

---

## Top three to fix first

1. **🔴 1 — `added_by` drift.** It is the only finding here that destroys data
   the user cannot get back: the bytes leave the bucket and the pad naming them
   stays. Both halves of the fix are a few lines, both were measured working,
   and nothing has been deployed yet — so this can be closed before it can ever
   have happened to anyone.
2. **🔴 3 — the writers' half of the `settleAudioImports` rule.** Two of the
   three sites are a one-line wrap. This one bites _today_, on local IndexedDB,
   with no deploy involved, and the fix that closed the deleters' half is what
   widened the window. `replaceMissingAudioFile` (08-22 🟡 3) is the fourth site
   and should go in the same commit.
3. **🔴 2 — the sweep's continuation token.** Hoisting one variable and giving
   the module the pagination test it has never had. It is third only because the
   damage is money and storage rather than user data — but it also invalidates
   the reasoning behind a deferral already written down, so leaving it silently
   leaves that deferral wrong.

Take **🟡 19 in the same commit as 🔴 1**: the test that was supposed to guard
the repair's holder check is the reason 🔴 1 could exist, and fixing the code
without fixing the assertion leaves the next regression just as invisible.
The two 🟡 search findings (7, 8) are worth taking together and are small; the
two comment findings (4, 5) belong in one pass with 🔴 1, since the same reader
will already be in those files.

## Summary

Twenty-one findings, **all twenty-one proven** — every one cites a probe run, a
mutation plus the vitest output either side of it, or a command whose output is
quoted. Nothing is carried as an unproven claim except the two items listed
under **Claims to check**, and neither of those is counted above.

**Where the bugs actually came from.** The brief expected merge seams, and that
is not what this found. Of 23 merges, only three source files were
conflict-resolved by hand and all three resolutions are correct. Every 🔴 here
is instead **a fix that was incomplete on its own branch**, and two of the three
were made _live_ by the fix that preceded them:

- 🔴 1 — the authorization fix moved the grant to `added_by` and the repair
  gated itself on `IS NULL`, which is one case narrower than the property it
  needed.
- 🔴 3 — the import-race fix swept all five deleters and none of the writers,
  and the parking it introduced is what opened the window.
- 🔴 2 — the abuse-resistance work leaned on a sweep whose pagination has never
  been exercised by any test, and documented it as working.

That is the same shape three times: a rule with two sides, one side swept. It is
worth adding to CLAUDE.md as a named check — _when you fix one half of a
two-sided invariant, grep for the other half before you call it done_ — because
the repo's existing notes name the drift shapes but not this one.

**The second theme is tests that cannot fail.** Three more were found by
mutation (18, 19, 20) and seven smaller guards have nothing behind them (21).
Two of the three are in code shipped **today**. `SearchModal.tsx:209` is the one
to feel uneasy about: it can be deleted with 1544 tests green, and without it a
live show's operator fires an irreversible cue on every character they type.

**Not run:** the e2e suite. Nothing above needed a browser to establish, and the
machine sat between load 9 and 23 for most of this pass with three review agents
on it — the conditions the 08-22 checkpoint records as producing 163 spurious
failures. The unit suite was re-measured at 1544/1544 at the start and again
after the last mutation was restored, both at low load.
