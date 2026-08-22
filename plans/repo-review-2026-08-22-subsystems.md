# Subsystem review — 2026-08-22

A scoped review of the libraries, hooks, stores and the server layer, one day
after [`repo-review-2026-08-21.md`](repo-review-2026-08-21.md) and roughly 25
merges after it. The mobile-layout work in flight was out of scope by
instruction (`page.tsx`, `layout.tsx`, `PadGrid`, `Pad`, the two track panels,
`globals.css`, `playwright.config.ts`, `components/icons/`), and so were the
findings the 08-21 report already answered.

Weighting followed where the code is youngest: the audio-dedup import-race fix,
the teardown fix across fourteen suites, the `ProfileManager` extraction into
three panels, the two Drive data-identity fixes, the `triggerPad` type refactor
and the bank-cap constant move.

**Evidence.** Three findings were reproduced by writing a throwaway Vitest
file, running it, reading what it printed, and then running it again with the
fix applied; the probe source and its exact output are quoted in place, and the
files were deleted afterwards (`git status` clean apart from this report). A
fourth was driven against the real route handlers with an in-memory database
and the fake object store. Everything else cites a `file:line` and the code at
it, and one item is marked **claim to check** because I could not establish it
from the source alone.

## Gates, measured today

| Gate             | Result                                     |
| ---------------- | ------------------------------------------ |
| `npx vitest run` | **1495 passed** / 154 files, exit 0        |
| heavier gates    | not run — the machine was resource-starved |

> **Note on the working tree.** Another session was editing this checkout while
> the review ran (`bankSummaries.ts`, `OrphanedAudioPanel.tsx`,
> `MissingAudioPanel.tsx` all changed under me — an icon extraction, by the
> look of it). Line numbers below were taken from `main` at `b6d018b`.

---

## 🔴 High

### 🔴 1. Any signed-in user can mint a download URL for any other user's hosted audio

- **Where:** [src/lib/server/audio.ts:184-194](../src/lib/server/audio.ts#L184-L194) — the third branch of `profileMayServeHash`; reached from [src/app/api/profiles/[id]/audio/[hash]/route.ts:41-56](../src/app/api/profiles/[id]/audio/[hash]/route.ts#L41-L56).
- **Finding.** The route gates a presigned download on two conditions, and a
  caller can satisfy both alone.

  1. `profileNamesHash(profile, hash)` — the profile's own blob must list the
     hash. The route's own comment says this is "the caller's own word".
  2. `profileMayServeHash(profile, ownerId, hash)` — somebody who could
     legitimately publish to this profile must hold a reference to those bytes.

  The third branch of (2) reads the **live** share table:

  ```sql
  OR r.user_id IN (
    SELECT u.id
      FROM users u
      JOIN profile_shares s ON s.email = u.email
     WHERE s.profile_id = ? AND s.role = 'editor'
  )
  ```

  `profile_shares` for _the profile being served_ is a table the attacker
  writes: [src/lib/server/shares.ts:40-66](../src/lib/server/shares.ts#L40-L66)
  (`upsertEmailShare`) inserts an `editor` row for **any** email address, with
  no acceptance step and no notification. So: create a profile, list the
  victim's hash in its blob, invite the victim as an editor, and the victim's
  own reference row unlocks the object.

  Driven against the real route handlers with an in-memory database and the
  fake object store:

  ```
  before invite: 404
  after invite:  200 {"url":"https://fake-bucket.test/audio/9a/9a3d….mp3?download=1&expires=3600&…"}
  ```

- **Impact.** This defeats the exact control the module exists for.
  [proofOfPossession.ts:9-17](../src/lib/server/proofOfPossession.ts#L9-L17)
  and [audio.ts:143-166](../src/lib/server/audio.ts#L143-L166) both state the
  guarantee as "revoking a share revokes the audio" and "naming a hash in a
  blob still buys nothing". Both are false. A collaborator who was shared a
  profile read-only, read its blob (hashes travel in the blob to viewers) and
  was then **revoked** can re-obtain every sound in it indefinitely. The only
  preconditions are a 64-hex hash and an email address.
  `audio.api.test.ts:1074-1115` only ever exercises the legitimate direction —
  the profile owner inviting an editor — so the reverse has never been covered.
- **Fix.** Drop the live-share branch. Migration 5 added `profile_audio.added_by`
  precisely to make this a fact about the past
  ([db.ts:214-236](../src/lib/server/db.ts#L214-L236)), and the branch survives
  only "for rows written before that column existed". Note that gating the
  fallback on `added_by IS NULL` is _not_ sufficient either: a writer using an
  anonymous link-share token records `NULL`
  ([route.ts:119-126](../src/app/api/profiles/[id]/route.ts#L119-L126)). More
  broadly, an **unaccepted** `profile_shares` row should not be usable as an
  assertion about the invitee anywhere.

### 🔴 2. Two audio deleters open their transaction without `settleAudioImports()`, and each deterministically eats a row an in-flight import is about to name

- **Where:**
  - [src/lib/db.ts:1646-1655](../src/lib/db.ts#L1646-L1655) — `deleteProfile`
  - [src/components/modals/EditPadModalContent.tsx:45](../src/components/modals/EditPadModalContent.tsx#L45) — the pad editor's discard-on-unmount
  - against the rule at [src/lib/db.ts:1378-1388](../src/lib/db.ts#L1378-L1388)
- **Finding.** CLAUDE.md and `settleAudioImports`'s own docstring state the rule
  for **every** deleter of audio rows it did not itself create. The 08-21
  review closed `collapseDuplicateAudioGroups`; two more were left, and the
  documented exception that covers one of them is no longer true.

  `settleAudioImports` exempts `deleteUnreferencedAudioFiles` because "it only
  ever considers ids its own caller just created". That argument stopped
  holding when audio started being reused by content hash: `addOrReuseAudioFile`
  hands a _pre-existing_ row's id to any caller with the same bytes, so a
  "provisional" id in the pad editor is routinely a row an unrelated import
  created seconds earlier. The file that calls it from outside `db.ts` says so
  itself — [EditPadModalContent.tsx:38-44](../src/components/modals/EditPadModalContent.tsx#L38-L44):
  _"a 'provisional' id is routinely the id of a row that already existed"_.

- **Evidence — reproduced, not inferred.** Two probes, both run against
  `main` at `b6d018b`.

  **(a) `deleteProfile` takes an in-flight import's row.** Profile A names a
  sound; a sync import into profile B reuses the same row and is between its
  audio write and its pad write; profile A is deleted in the gap:

  ```ts
  const { id: shared } = await addOrReuseAudioFile({
    name: "horn.wav",
    type: "audio/wav",
    blob: bytes(),
  });
  await upsertPadConfiguration({
    profileId: profileA,
    bankId: "0",
    padIndex: 0,
    audioFileIds: [shared],
    playbackType: "sequential",
  });

  const theImport = withAudioImportInProgress(async () => {
    const { id } = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: bytes(),
    });
    await macro();
    await macro(); // a download
    await upsertPadConfiguration({
      profileId: profileB,
      bankId: "0",
      padIndex: 0,
      audioFileIds: [id],
      playbackType: "sequential",
    });
    return { id };
  });

  await macro();
  await deleteProfile(profileA);
  ```

  printed

  ```
  PROBE shared=1 importId=1 reused=true padNames=[1] live=[] dangling=[1]
  AssertionError: expected [ 1 ] to deeply equal []
  ```

  — profile B's pad names audio row 1, and the library is empty. Inserting
  `await settleAudioImports()` immediately before `deleteProfile` turned the
  same probe green (`Tests 1 passed (1)`).

  **(b) The pad editor's discard takes an in-flight import's row.** Same
  import; the user opens the pad editor, picks the same file (so
  `addOrReuseAudioFile` hands back the import's row), then dismisses the
  dialog:

  ```
  PROBE importedId=1 provisional=1 reused=true removed=1 padNames=[1] live=[] dangling=[1]
  ```

  Reproduced on 3 of 3 consecutive runs. `await settleAudioImports()` before
  the discard turned it green.

- **Impact.** Pads that name audio rows which no longer exist. The pad still
  renders and is simply silent; nothing reports it, and no later sweep can tell
  it from a sound the user removed on purpose. Both triggers are ordinary:
  `useServerSync` and `useGoogleDriveSync` are mounted app-wide by
  `ClientSideInitializer`, so a background download is in flight while the user
  deletes a profile in the manager, or closes the pad editor.
- **Fix — and the trap in it.** `await settleAudioImports()` immediately before
  the transaction is the right shape, but **neither call site can take it
  naively**: both are also reached from _inside_ an import's own scope.
  `importProfileCore` wraps `runProfileImport` in `withAudioImportInProgress`
  ([importExport.ts:1063](../src/lib/importExport.ts#L1063)) and its rollback
  calls `deleteProfile` ([importExport.ts:1242](../src/lib/importExport.ts#L1242))
  and `deleteUnreferencedAudioFiles`
  ([importExport.ts:1254](../src/lib/importExport.ts#L1254)). Since
  `audioImportsInFlight` is a bare `Set` with no notion of "my own import"
  ([db.ts:1344-1365](../src/lib/db.ts#L1344-L1365)), `settleAudioImports` there
  would await the very promise that is waiting on it — a deadlock, not a
  slowdown. So the register needs a handle: `withAudioImportInProgress` should
  hand its scope back (or hold it in an `AsyncLocalStorage`-style token) so a
  deleter can wait for _every import but its own_. That one change is what
  makes the rule CLAUDE.md declares actually implementable outside `db.ts`,
  and it is the same structural cause as 08-21's 🔴 1 one level up.

---

## 🟡 Medium

### 🟡 3. `replaceMissingAudioFile` writes audio and pad in two transactions without declaring itself, and the orphan sweep is one panel away

- **Where:** [src/lib/db.ts:2487-2543](../src/lib/db.ts#L2487-L2543), called from [src/components/profiles/MissingAudioPanel.tsx:80](../src/components/profiles/MissingAudioPanel.tsx#L80).
- **Finding.** The other half of 🔴 2's rule: _"anything that writes an audio
  file and the pad naming it in **separate transactions** must run inside
  `withAudioImportInProgress`"_. `replaceMissingAudioFile` calls
  `addOrReuseAudioFile` (its own readwrite transaction), then opens a second
  transaction on `padConfigurations` to swap the id — and registers nothing in
  between. `MissingAudioPanel` and `OrphanedAudioPanel` are rendered on the
  **same Maintenance tab**, so the deleter is not behind a modal: it is the
  button above.
- **Evidence — reproduced.** A pad naming a missing row is repaired while the
  orphan cleanup runs, over twelve interleavings (one macrotask apart):

  ```
  [Missing Audio] Replaced missing file ID 3 with new file ID 4 in pad 0 on bank 0
  [Orphan Cleanup] Completed: 1 files deleted, 0 cache entries cleared
  PROBE n=1 padNames=[4] live=[] dangling=[4]
  PROBE firstBadInterleaving=1
  ```

  The repaired pad names row 4, which the sweep deleted. Wrapping the call in
  `withAudioImportInProgress` made all twelve interleavings clean
  (`Tests 1 passed (1)`), because `cleanupOrphanedAudioFiles` already awaits
  the register ([db.ts:1464](../src/lib/db.ts#L1464)).

- **Impact.** Pressing "Repair" while a cleanup is running silently produces
  exactly the fault the repair was meant to fix.
- **Fix.** `return withAudioImportInProgress(() => …)` around the body of
  `replaceMissingAudioFile`. Three more writers have the same shape and were
  not probed — [usePadDrop.ts:64](../src/hooks/pad/usePadDrop.ts#L64),
  [BulkImportModalContent.tsx:320](../src/components/modals/BulkImportModalContent.tsx#L320)
  and [EditPadForm.tsx:239](../src/components/modals/EditPadForm.tsx#L239),
  the last of which leaves the row unreferenced for as long as the editor is
  open. They sit behind modals, so no in-app deleter can currently run
  alongside them; that is a layout accident, not an invariant, and the same
  wrapper closes all four.

### 🟡 4. A stranger can permanently freeze another user's hosted audio and storage allowance

- **Where:** [src/lib/server/audio.ts:253-263](../src/lib/server/audio.ts#L253-L263) (`hashIsUsedByReachableProfile`), gating [src/app/api/audio/[hash]/route.ts:189-197](../src/app/api/audio/[hash]/route.ts#L189-L197).
- **Finding.** `DELETE /api/audio/:hash` answers 409 while the hash is used by
  a profile the caller can reach, and "reachable" includes any profile the
  caller has been _invited_ to:

  ```sql
  WHERE pa.hash = ?
    AND ( p.owner_id = ?
          OR EXISTS (SELECT 1 FROM profile_shares s
                      WHERE s.profile_id = p.id AND s.email = ?) )
  ```

  Same unilateral `upsertEmailShare` as 🔴 1. Verified:
  `hashIsUsedByReachableProfile(H, victim…)` returned `false`, then `true`
  after an attacker called
  `upsertEmailShare(attackerProfile, "victim@example.com", "viewer", attacker.id)`
  on a profile the victim never touched. The comment at
  [audio.ts:236-244](../src/lib/server/audio.ts#L236-L244) records that the
  _unscoped_ version of this query was a denial of service and that scoping it
  to reachable profiles fixed it; the scope is attacker-controlled.

- **Impact.** The victim can never delete that file and its bytes are charged
  against their quota forever. Only the squatting profile's owner can revoke
  the share — there is no route by which an invitee can remove themselves.
- **Fix.** Count only profiles the caller owns or has actually written to, and
  give an invitee a way to decline or remove a share.

### 🟡 5. Uncommitted uploads bypass both the per-user quota and the global cap

- **Where:** [src/app/api/audio/upload-url/route.ts:58](../src/app/api/audio/upload-url/route.ts#L58); accounting in [src/lib/server/audio.ts:67-92](../src/lib/server/audio.ts#L67-L92); the only recovery in [src/lib/server/audioSweep.ts:42-45,141](../src/lib/server/audioSweep.ts#L42-L45).
- **Finding.** `upload-url` mints `store.presignUpload(key)` after checking a
  **client-declared** `sizeBytes`, and the presign signs only `host`
  ([s3/client.ts:163-166](../src/lib/server/s3/client.ts#L163-L166)) — so the
  actual PUT is unconstrained in size. Nothing is recorded until commit, and
  `getUserUsage`/`getGlobalUsage` both sum `audio_objects`. A caller who
  declares 1 byte, PUTs 5 GB and never commits writes an object nothing counts,
  and each invented hash gets a fresh URL. The only cleanup is `sweepIfDue`,
  which is capped at `MAX_REMOVED_PER_SWEEP = 100` per hour **and runs only
  when an admin loads `/api/admin/audio`**.
- **Impact.** An account with `can_upload_audio = 1` can fill the bucket past
  `IMPAMP_AUDIO_GLOBAL_CAP_BYTES` far faster than the sweep removes, with
  Wasabi's 90-day minimum billing on every object. Held below high only because
  it needs an approved account.
- **Fix.** Record a pending-upload row when the URL is minted and charge it
  provisionally; run the sweep on a timer rather than off an admin page view;
  at minimum rate-limit `upload-url` per user.

### 🟡 6. One profile PUT can hold the global write lock for ~0.7 s, and nothing caps profiles per account

- **Where:** [src/lib/server/profiles.ts:115-123](../src/lib/server/profiles.ts#L115-L123) (`reindexProfileAudio`, inside the `transaction()` at 211); body cap at [src/lib/server/profileRequests.ts:73](../src/lib/server/profileRequests.ts#L73) (`MAX_PROFILE_BODY_BYTES`).
- **Finding.** `MAX_PROFILE_BODY_BYTES` bounds the blob at 8 MB of _bytes_, but
  nothing bounds the number of `audioFiles` entries, and `reindexProfileAudio`
  runs one `execute` per hash inside `BEGIN IMMEDIATE`. Measured against an
  in-memory database:

  ```
  entries: 110377   blob bytes: 8388668
  createProfile ms: 659
  no-op reindex update ms: 203
  profile_audio rows: 110377
  ```

  `node:sqlite` is synchronous and the app runs as a single instance, so those
  659 ms block every other request, the SSE heartbeats and `/up`. There is also
  no per-account profile limit anywhere in `profiles.ts` or the route, and
  `isSignupAllowed` returns `true` when `IMPAMP_ALLOWED_EMAILS` is unset
  ([signupPolicy.ts:29-32](../src/lib/server/signupPolicy.ts#L29-L32)).

- **Fix.** Cap the entry count where the body is parsed (a soundboard does not
  have 110k sounds), batch the inserts, and add a per-user profile ceiling.

### 🟡 7. `loadLoudnessPipeline` caches a _rejected_ import forever

- **Where:** [src/lib/audio/loudness/loadPipeline.ts:30](../src/lib/audio/loudness/loadPipeline.ts#L30) — `pipeline ??= import("./pipeline");`
- **Finding.** A promise is neither `null` nor `undefined` whether it fulfils or
  rejects, so `??=` memoises a failure exactly as durably as a success. Before
  `4a8f083` every caller issued its own `import()` and a transient failure cost
  one analysis; now the first failure disables loudness analysis for the rest
  of the session. The two callers both `.catch()` and warn
  ([db.ts:758-766](../src/lib/db.ts#L758-L766),
  [applySyncedProfile.ts:34](../src/hooks/applySyncedProfile.ts#L34)), so it is
  silent. `loadPipeline.test.ts` pins the memoisation and the single-importer
  rule; neither test touches the rejection path.
- **Impact.** In a PWA this is not hypothetical: a chunk fetch fails when the
  network drops or when a redeploy moves chunk hashes under an open tab. Every
  sound added afterwards plays at 0 dB normalisation, with a console warning as
  the only symptom — which is the same symptom the 14-of-40 bug this file was
  written to fix produced.
- **Fix.** Clear the memo on rejection:
  `pipeline ??= import("./pipeline").catch((e) => { pipeline = null; throw e; })`,
  and add the case to `loadPipeline.test.ts`.

---

## 🟢 Low

### 🟢 8. The shared loudness stub was extracted and then written out by hand seven more times

`src/lib/testSupport/loudnessPipelineStub.ts` exists so that a suite writing an
audio row cannot forget the guard, and CLAUDE.md states the rule as _"must call
`stubLoudnessPipeline()`"_. Seven suites hand-roll the same three lines instead:

```
src/components/profiles/ExportBanksPanel.test.tsx:43
src/components/profiles/BankImportPlacementDialog.test.tsx:43
src/components/profiles/DuplicateAudioPanel.test.tsx:37
src/components/modals/EditPadModalContent.discard.test.tsx:35
src/components/modals/EditPadForm.dedup.test.tsx:27
src/lib/db.audioDedup.test.ts:23
src/lib/audioHashIndex.test.ts:54
```

Behaviourally equivalent today, which is exactly why nobody notices; the copies
are three lines each, so the jscpd-at-0 gate does not see them. The cost is
that the next change to the stub — a second module to mock, an assertion helper
— reaches one caller out of eight. One `sourceScan.ts` rule ("nobody
`vi.doMock`s `loudness/pipeline` outside `loudnessPipelineStub.ts`") would hold
it the way the pipeline's single-importer rule is already held.

### 🟢 9. No cap on concurrent SSE streams, and anonymous link holders can open them

[src/app/api/profiles/[id]/events/route.ts:31-41](../src/app/api/profiles/[id]/events/route.ts#L31-L41) —
`loadAuthorizedProfileMeta` accepts a link-share token via `?token=`, so an
unauthenticated holder of a viewer link can open unbounded streams. Each holds
an interval, a timeout, a subscription in the module-level `listeners` map
([events.ts:25](../src/lib/server/events.ts#L25)) and re-runs `resolveAccess`
(up to three synchronous queries) every 25 s. `MAX_STREAM_MS` bounds one
stream's life, not the count.

### 🟢 10. A still-valid presigned PUT can overwrite an object someone else commits in the meantime

An upload URL is issued only when no `audio_objects` row exists
([audio.ts:353](../src/lib/server/audio.ts#L353)), which closes the obvious
path, but it stays valid for `uploadUrlTtlSeconds` (default 900,
[s3/config.ts:73](../src/lib/server/s3/config.ts#L73)). If user B commits that
hash inside the window, user A's URL still addresses the now-shared key. Commit
then refuses everyone with "it has been overwritten since it was stored"
([commit/route.ts:140](../src/app/api/audio/commit/route.ts#L140)) and
the object cannot be deleted because references exist. Narrow race, no
disclosure.

### 🟢 11. The Drive audio proxy echoes an attacker-influenced `Content-Type` with no `nosniff`

[src/app/api/drive/public-audio/route.ts:199-201,251-259](../src/app/api/drive/public-audio/route.ts#L199-L201) —
`isAllowedAudioType` accepts any string starting with `audio/`, and that string
(a Drive uploader's chosen mimeType) becomes the response `Content-Type` with
no `X-Content-Type-Options: nosniff`. Largely blocked by the `Sec-Fetch-Site`
gate ([api/drive/proxyUtils.ts:67](../src/app/api/drive/proxyUtils.ts#L67)), which is
why it is low. An exact allow-list plus `nosniff` closes it properly.

### 🟢 12. **Claim to check** — an empty stored hash makes `createHashlessAudioIndex` skip the whole library

[db.ts:1075-1085](../src/lib/db.ts#L1075-L1085) decides whether to scan by
comparing `db.count("audioFiles")` with `db.countFromIndex("audioFiles", "hash")`,
on the reasoning that "IndexedDB leaves a record out of an index when its key is
undefined, so the `hash` index counts exactly the rows that carry one". `""` is
a valid IndexedDB key, so a row stored with `hash: ""` counts as hashed and the
scan is skipped — including for the genuinely unhashed rows it would have
repaired, since the counts decide for the whole library at once.
`ensureAudioFileHash` uses truthiness (`if (existing.hash)`) and would have
fixed such a row. I could not find a writer that still produces one:
`addOrReuseAudioFile` and `importAudioSources` both normalise with `||`
([db.ts:1023](../src/lib/db.ts#L1023),
[importExport.ts:561](../src/lib/importExport.ts#L561)), and the Drive legacy
path does the same. So this is latent rather than live — worth a one-line
`countFromIndex` over a key range excluding `""`, or a note saying why it
cannot happen.

### 🟢 13. The plural helper has a second copy one commit after it was written

[src/lib/plural.ts](../src/lib/plural.ts) exists so that `1 banks` cannot
happen, and its docstring says "a second copy of it in the next panel is how
the two drift". [SearchModal.tsx:233](../src/components/search/SearchModal.tsx#L233)
writes `{results.length} {results.length === 1 ? "result" : "results"}` inline.
Correct today; it is `count(results.length, "result", "results")`.

---

## Test trustworthiness

A separate mutation sweep over the suites that landed in the last thirty
commits: mutate the production source, run the suite, keep only the mutants
that survive. Every item below quotes the mutation and the exact vitest line it
produced. Baseline for all of them: `Test Files 154 passed (154) / Tests 1495 passed (1495)`.

### 🟡 14. The loudness-pipeline source-scan guard cannot match the shape it guards against

- **Where:** [src/lib/audio/loudness/loadPipeline.test.ts:37-45](../src/lib/audio/loudness/loadPipeline.test.ts#L37-L45).
- **Finding.** The pattern is
  `/import\(\s*["'][^"']*loudness\/pipeline["']\s*\)/` — it requires the
  literal `loudness/pipeline` **inside the quotes**. The one legitimate
  importer writes `import("./pipeline")`
  ([loadPipeline.ts:30](../src/lib/audio/loudness/loadPipeline.ts#L30)), which
  it does not match. Checked directly:

  ```
  $ node -e '...re.test(...)'
  relative: false
  aliased : true
  ```

  So the scan has never matched anything and `expect(offenders).toEqual([])`
  compares `[]` with `[]`. Confirmed by mutation: adding
  `return import("./pipeline");` to a sibling in the same directory
  (`analyse.ts`) left it green —
  `PROBE A: sibling-relative pipeline import: exit=0 | Tests 3 passed (3)` —
  while the aliased form correctly failed
  (`PROBE A2: exit=1 | Tests 1 failed | 2 passed (3)`). Independently,
  deleting `if (skip(relative)) continue;` from
  [sourceScan.ts:53](../src/lib/testSupport/sourceScan.ts#L53) also left the
  whole suite green (`Tests 1495 passed (1495)`) — the `skip` callback excludes
  nothing, because the loader was never a hit.

- **Impact.** The guard's own docstring says why it exists: _"a caller that
  goes back to importing the pipeline directly reintroduces the bug in that
  caller alone, with every existing test still green"_, against a measured 14
  of 40 and 66 of 100 files silently unanalysed. A reintroduction from inside
  `src/lib/audio/loudness/` — the likeliest place — is invisible.
- **Fix.** Match the module basename rather than the aliased path
  (`/import\(\s*["'][^"']*\bpipeline["']\s*\)/`), keep the `skip` for
  `loadPipeline.ts` (which will then actually be doing something), and add a
  self-check: with the skip removed, the scan must return exactly
  `["lib/audio/loudness/loadPipeline.ts"]`. A scan that cannot see its own call
  site can go blind again silently.

### 🟡 15. The "no lookup by sound name" guard sees only one of the two index-access forms

- **Where:** [src/lib/db.audioNameIndex.test.ts:52](../src/lib/db.audioNameIndex.test.ts#L52) — `sourceFilesMatching(/index\(\s*["']name["']\s*\)/)`.
- **Finding.** That matches `store.index("name")` and nothing else. The `idb`
  helper form — `db.getFromIndex("audioFiles", "name", …)` /
  `getAllFromIndex(…)`, used throughout production in `bankTransfer.ts` and
  `googleDrive/dataAccess.ts` — puts `"audioFiles"` between `Index(` and the
  index name, so it never matches. Mutation: a dead function in
  `audioDedup.ts` doing `(await getDb()).getFromIndex("audioFiles", "name", name)`
  left it green —
  `PROBE B: getFromIndex name lookup: exit=0 | Tests 2 passed (2)` — while the
  low-level form in the same file failed
  (`PROBE B2: exit=1 | Tests 1 failed | 1 passed (2)`).
- **Impact.** This is the standing guard against the bug `aa56833` fixed (two
  different recordings called `horn.wav` merged onto one row). It catches the
  form nobody writes and misses the one a new contributor reaches for first.
- **Fix.** Widen to
  `/(?:\.index\(|(?:get|getAll|count)FromIndex\([^)]*,)\s*["']name["']/` and
  re-verify the expected offender list.

### 🟡 16. The two hash indexes disagree about which duplicate wins, and nothing tests either rule

- **Where:** [audioHashIndex.ts:68](../src/lib/audioHashIndex.ts#L68) versus [db.ts:1084](../src/lib/db.ts#L1084).
- **Finding.** `createStoredHashIndex` keeps the **first** row it meets for a
  hash and says why: _"First wins, matching what the `hash` index answers when
  two records hold the same bytes: both are ordered by primary key, so both
  name the older record."_ `createHashlessAudioIndex`, two files away and
  reached as the fallback from the same helper, does a bare
  `built.set(computed, localId)` — **last** wins. Both mutations survive the
  whole suite:

  ```
  AHI-first-wins -> last-wins: exit=0 | Tests 1495 passed (1495)
  DB-hashless-first-wins:      exit=0 | Tests 1495 passed (1495)
  ```

  `audioHashIndex.test.ts` holds only the transaction-count tests, so neither
  rule is pinned anywhere.

- **Impact.** In a library that still holds duplicates — the norm before the
  dedup panel existed — one sync pass attaches pads to the oldest row and
  another to the newest, depending on which index answered.
  `addOrReuseAudioFile` hands out the lowest id and
  `collapseDuplicateAudioGroups` elects the analysed one; that disagreement is
  exactly what 08-21's 🔴 1 turned on.
- **Fix.** Make the two agree on first-wins, and pin it: two rows with the same
  `hash`, assert `lookup` returns the lower id; the mirror case in
  `db.hashlessIndex.test.ts` for two hashless rows with identical bytes.

### 🟢 17. Four of the six sanitisations in `readIncomingPad` have no test

[bankTransfer.ts:652-661](../src/lib/bankTransfer.ts#L652-L661). Each guard was
removed in turn:

```
B-keyBinding-guard:     exit=0 | Tests 1495 passed (1495)
B-name-guard:           exit=0 | Tests 1495 passed (1495)
B-trim-isRecord-guard:  exit=0 | Tests 1495 passed (1495)
B-gain-isRecord-guard:  exit=0 | Tests 1495 passed (1495)
```

The two the suite does cover both die (`B-padGainDb-finite` and
`B-isDisabled-flag`, each `exit=1 | Tests 1 failed | 90 passed (91)`). The
docstring enumerates all six as a set, and the test named for it
([bankTransfer.test.ts:1995](../src/lib/bankTransfer.test.ts#L1995)) exercises
two. An archive carrying `"audioGainSettings": "loud"` reaches
`remapAudioFileIdKeys` unchecked and `keyBinding: 42` becomes a key binding.
One widened fixture at `bankTransfer.test.ts:2005` closes it.

### 🟢 18. `MissingAudioPanel`'s per-profile row filter is never asked a question

[MissingAudioPanel.tsx:176](../src/components/profiles/MissingAudioPanel.tsx#L176) —
`.filter((e) => e.profileId === profileId)` replaced with `.filter(() => true)`:

```
MA-group-filter-removed: exit=0 | Tests 1495 passed (1495)   (and 11 passed (11) for the file alone, twice)
```

The test named for it —
[MissingAudioPanel.test.tsx:262](../src/components/profiles/MissingAudioPanel.test.tsx#L262),
_"keeps two profiles' banks apart when both call a bank '0'"_ — seeds broken
pads in only one of the two profiles, so the grouping loop never renders a
second heading. With both profiles holding missing audio every row would be
listed under every heading, with duplicate `data-testid`s and duplicate React
keys. Give the second profile a broken pad and assert one row per heading.

Worth noting alongside it: the two `rowKeyOf` mutations that _did_ fail do so
because the test hard-codes the key string in its own `rowKey()` helper, not
because a collision was detected — the key is pinned by format coupling rather
than by behaviour.

### 🟢 19. `summariseBanks` says it is "exported for its own tests" and has none

[bankSummaries.ts:44-50](../src/lib/bankSummaries.ts#L44-L50). No
`bankSummaries.test.ts` exists. Most of the module is covered indirectly by the
two panel suites — mutations to the ordering, the pad and sound counts and
`bankLabel` all died — but not the trim:

```
S-bankDisplayName-no-trim: exit=0 | Tests 1495 passed (1495)
```

(`option.name.trim() ? …` → `option.name ? …`.) A whitespace-only bank name
renders blank instead of "Unnamed bank"; both panel fixtures use `""`. The
function is pure, so a direct test is cheap — include a `"   "` name.

### Claims to check

- **Three vacuous "cannot be pressed twice" assertions.**
  [OrphanedAudioPanel.test.tsx:428](../src/components/profiles/OrphanedAudioPanel.test.tsx#L428)
  asserts `toHaveBeenCalledTimes(1)` with no second press at all;
  `ExportBanksPanel.test.tsx:531` and
  `BankImportPlacementDialog.test.tsx:441` press a `disabled` button, for which
  React dispatches no click. Each test's neighbouring
  `expect(button.disabled).toBe(true)` is what actually carries it, so none of
  the three is dead — but the call-count line proves nothing.
  `BankImportPlacementDialog.tsx:213-226` says so honestly in a comment; the
  other two do not.
- **`audioHashIndex.ts:117`'s `if (!hash) return undefined` is currently an
  equivalent mutant.** Removing it leaves the suite green, because
  `stored.lookup` is a `Map.get` and `Map.get(undefined)` is already
  `undefined`. It still deserves a test: CLAUDE.md names this exact shape as
  one found three times, and the danger returns the moment that lookup goes
  back to `index.getAll(key)`.
- **Two `Errors 2 errors` lines appeared in the sweep's final full-suite run**
  that were not in its baseline, with all 1495 tests passing. Most likely the
  known background-analysis teardown noise, possibly stirred by the concurrent
  session editing this checkout — worth one clean re-run when the tree is
  quiet.

**Ruled out** (checked and found sound, so do not re-spend it):
`driveRefreshThrottle.test.tsx` — removing the throttle at
`useGoogleDriveSync.ts:303` fails **both** its tests (`Tests 2 failed (2)`,
both timing out on a real refresh loop), so the second is not the duplicate it
looks like. `audioDedup.importRace.test.ts` — removing
`await settleAudioImports()` from `audioDedup.ts:290` fails it
(`Tests 1 failed (1)`). `bankUtils.test.ts` and `audio/cache.test.ts` are both
written mutation-first. Nine further mutations across `ExportBanksPanel`,
`BankImportPlacementDialog`, `DuplicateAudioPanel` and `OrphanedAudioPanel`
(bank ordering, counting, labels, rescan scheduling, report clearing, preview
lifetime, shortfall arithmetic) all died — those suites are strong.

---

## Verified clean — do not re-spend the budget

Everything below was checked against the source (or run) during this review and
found holding.

**The three fixes this window landed all do what they claim.**

- **The dedup import race** (`dccd616`) is correctly closed:
  `await settleAudioImports()` is the last statement before the transaction
  opens in `collapseDuplicateAudioGroups`
  ([audioDedup.ts:290](../src/lib/audioDedup.ts#L290)) and in both orphan
  sweeps ([db.ts:1406](../src/lib/db.ts#L1406),
  [db.ts:1464](../src/lib/db.ts#L1464)). What was missed is the deleters
  _outside_ those three — see 🔴 2.
- **The Drive data-identity fixes** hold end to end. `findLocalAudioMatch` and
  its name fallback are gone; `lookupLocalAudioByHash`
  ([audioHashIndex.ts:112](../src/lib/audioHashIndex.ts#L112)) is the single
  answer and is used by all three inbound Drive paths (`sync.ts:325`,
  `dataAccess.ts:206`, `dataAccess.ts:268`). It returns `undefined` for a
  falsy hash, so a hashless reference matches nothing. The `audioFiles` `name`
  index survives with **no readers**, deliberately, and
  `db.audioNameIndex.test.ts` is the guard on the reader rather than on the
  index. `serverAudio/transfer.ts` keys only on `ref.hash`
  ([transfer.ts:249](../src/lib/serverAudio/transfer.ts#L249)).
- **The `triggerPad` type refactor** removes the hand-enumeration everywhere,
  not in three places out of four. `TriggerablePad` and `TriggerAudioArgs` both
  `extends PadPlaybackSettings`, `triggerPad` forwards with `...pad`
  ([triggerPad.ts:96](../src/lib/audio/triggerPad.ts#L96)), and every producer
  now fills through `extractPadPlaybackSettings`: `usePadInteractions`'s
  `armTrack`, `useSearch`'s result rows, `readEmergencySounds`,
  `playArmedTrackNow`'s re-read and its fallback. No literal field list is
  left. The two overrides written _after_ the spread (`name` in both
  `armTrack` and `useSearch`) are deliberate and commented.
- **The bank-cap move** is complete: `MAX_BANKS` has exactly one definition
  ([constants.ts:23](../src/lib/constants.ts#L23)), and `db.ts`, `bankUtils.ts`,
  `bankTransfer.ts`, `profileStore.ts`, `page.tsx` and
  `BankImportPlacementDialog.tsx` all import it. No `20`/`19` literal survives
  in the bank arithmetic, and `BANK_TEN_INDEX` is correctly _not_ derived from
  the cap.

**Audio cache and pins.** The `clearCachedAudioBuffer` /
`invalidateCachedAudioBuffer` split is applied the right way round: all three
deletion paths take the pin with the row
([db.ts:1260](../src/lib/db.ts#L1260) via `clearAudioCacheEntries`,
[db.ts:1500](../src/lib/db.ts#L1500), [db.ts:1710](../src/lib/db.ts#L1710), and
`audioDedup.ts:404`), while the failed-decode retry uses the invalidate-only
one ([controls.ts:167](../src/lib/audio/controls.ts#L167)).
`unpinAudioBuffer` on an id whose pin was dropped wholesale is a no-op
([cache.ts:335](../src/lib/audio/cache.ts#L335)), so the reference counts
cannot go negative.

**Archive and export changes.** `writeArchiveZip` merges the per-item audio
maps first-wins so a shared sound is stored once; `zipEntryReaders` refuses a
duplicate entry name outright, checks `uncompressedSize` **before** `getData`,
and truncates untrusted names in its messages
([importExport.ts:2106](../src/lib/importExport.ts#L2106) onwards).
`getAudioFilesByIds` issues every `store.get` before the first `await`, which
is what keeps them in one transaction
([db.ts:817](../src/lib/db.ts#L817)). `_saveArchive` preserves all three
outcomes (`saved`/`cancelled`/`failed`) and only the _profile_ export stamps
`lastBackedUpAt` — a bank selection deliberately does not.

**Playback keys and layering.** Re-checked after the `triggerPad` refactor,
since it moved the types those helpers sit behind. `LAYER_SEPARATOR` is the
only `"#"` literal in non-test source ([types.ts:186](../src/lib/audio/types.ts#L186)),
so nothing splits a playback key by hand. `layersByBase` still has exactly two
writers, `registerInstance` and `forgetInstance`, called from
`claimPlaybackKey` ([playback.ts:494](../src/lib/audio/playback.ts#L494)) and
`clearTrackState` ([playback.ts:431](../src/lib/audio/playback.ts#L431)) and
nowhere else.

**Bank identity.** `bankSummaries.ts` keys everything on `bankId`, orders
through `normaliseBankOrder`, and derives its sound counts from
`collectReferencedAudioFileIds` — the same function the exporter uses — so the
preview cannot promise a different archive from the one written.

**`padConfigsVersion`.** Every panel that changes pad data bumps it
(`MissingAudioPanel.tsx:107`, `DuplicateAudioPanel.tsx:121`,
`profileStore.ts:878` for the bank import). `OrphanedAudioPanel` and
`DriveAudioRepairPanel` correctly do not: neither touches a pad row.

**Server layer** (checked in addition to the 08-21 sweep, which is not
repeated here):

- Every route under `src/app/api` reaches `requireUser`, `requireAdmin`,
  `authorizeProfileRequest`/`loadAuthorizedProfileMeta`, or the
  `Sec-Fetch-Site` gate. Owner-only surfaces check `access !== "owner"`
  explicitly; PUT checks `canWrite`. Link tokens are scoped to the minting
  profile and cannot resolve to `owner` (schema
  `CHECK (role IN ('viewer','editor'))`). `deleteShare` is scoped by
  `profile_id`. Missing and forbidden both answer 404.
- **ETag/If-Match**: the tag covers access as well as version; the version read
  and the UPDATE sit in one `BEGIN IMMEDIATE` with no `await` between them
  ([profiles.ts:211-237](../src/lib/server/profiles.ts#L211-L237));
  `parseVersionHeader` rejects non-integers and `<= 0`; a missing `If-Match` is
  428, not a silent overwrite.
- **Blob redaction** runs on both the write and the read path, and a blob that
  fails to parse serves `"null"` rather than raw bytes.
- **S3 keys**: `objectKeyForHash` strips everything outside `[a-zA-Z0-9]` from
  the extension and the hash is validated as `/^[0-9a-f]{64}$/` first — no path
  traversal or key injection. `presignDownload` pins `response-content-type`,
  so a bucket object cannot be served as HTML.
- **SSRF**: the only externally-influenced outbound URLs are the two Drive
  proxies, whose `id` is `/^[a-zA-Z0-9_-]+$/` against fixed `googleapis.com`
  hosts; all outbound fetches go through `fetchWithTimeout`.
- **Proof of possession / commit**: quota is re-decided from `store.head()`'s
  size, not the client's claim; the proof gate fires on exactly the condition
  `upload-url` used to set `alreadyStored`; a zero-length or short range read
  fails closed.
- **Sessions**: only the SHA-256 is stored, expiry is checked and the row
  destroyed on read, sign-out deletes it, the cookie is HttpOnly + SameSite=Lax
  - Secure in production.
- **SQL**: every statement is a static literal with bound parameters; the one
  interpolation (`PRAGMA user_version = ${version + 1}`) takes a
  locally-computed number. Multi-statement invariants (`recordUpload`,
  `releaseReference`, `createProfile`/`updateProfile` + reindex,
  `upsertUserFromGoogle`) are all inside `transaction()`, with no nesting.
  `originId`/`profileId` reach the SSE wire through `JSON.stringify`, so
  no newline injection into the event stream.

**Not measured this run** (the machine was resource-starved by instruction):
`npm run build`, `npm start`, Playwright, `npm run test:coverage`,
`npm run lint`, `npm run typecheck`, jscpd, `npm audit`. The 08-21 report has
the last reading of each.

---

## Summary

The scoped subsystems are in good shape and the three refactors this window
landed — the trigger types, the bank cap, the Drive identity rules — were each
carried all the way through rather than three-quarters of the way, which is the
failure this repo usually produces. The panel suites are strong: nine
behavioural mutations across the four maintenance panels all died.

What did not hold divides into three kinds. One authorization bypass on the
server, reachable by anyone who has ever been shown a profile blob. One rule
CLAUDE.md states for every audio deleter, still unadopted by two of them, with
the exception clause that covers a third invalidated by content-hash reuse.
And two **source-scan guards that cannot fire** — one whose regex does not
match its own call site, one that sees only the index form nobody writes. Both
stand in for measured, silent data bugs, and both have been green since the day
they were written.

**Fix first, in this order:**

1. **🔴 1** — `profileMayServeHash`'s live email-share branch. A real
   authorization bypass on hosted audio, and it silently falsifies the
   guarantee two other modules' docstrings are written around. One `OR` clause.
2. **🔴 2** — the two deleters without `settleAudioImports()`. Both halves are
   reproduced above, and the fix is not the one-liner it looks like:
   `deleteProfile` and `deleteUnreferencedAudioFiles` are both reached from
   _inside_ an import's own scope, so the register has to learn to exclude the
   caller's own import before either can take the guard. Doing that is also
   what stops the next deleter shipping without it.
3. **🟡 14 and 🟡 15** — the two blind guards. Cheap, and until they are fixed
   every later "verified by the source scan" claim in this repo is worth less
   than it reads. Fix 🟡 14 with a self-check, so a scan that stops seeing its
   own call site fails instead of passing.

Then **🟡 3** (wrap `replaceMissingAudioFile`, the only one of these whose two
halves sit on the same screen), the two server quota/DoS items (🟡 4, 🟡 5),
which need product decisions about invitations and pending uploads rather than
a patch, and 🟡 7 and 🟡 16, which are a line of code and a test each.
