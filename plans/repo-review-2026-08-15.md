# Whole-repo review — 15 August 2026

Scope: the entire application at `8ffc5e0` (main, clean). Ten parallel review passes —
dead code, sync duplication, the audio subsystem, the two god-files, the component layer,
stores and hooks, server + API security, performance, test health, and cross-cutting
infrastructure. Every finding below cites code that was read, and each was verified against
the source before being written down.

Brief as given: **complexity, duplicated streams, and leftovers** — the things that make
bugs likely rather than the bugs themselves. Both turned up. The duplications are the
better story: nearly every 🔴 below is one rule written twice, where one copy was fixed
and the other was not.

**State of the suite when reviewed:** `npm test` green — 39 files, 519 tests, 3.7 s.
`npm run lint` clean (2 warnings, exit 0). `npm audit` 0 vulnerabilities.

---

## The shape of the problem

Three patterns account for most of what follows.

**1. The fixed copy and the unfixed copy.** A bug gets found, a fix gets written with a
comment explaining precisely why — and the second implementation of the same rule never
gets it. `useConnectServerProfile` imports as local-then-upgrade with a nine-line comment
about the duplicate-profile bug that motivated it; `/server/open/page.tsx` still does the
broken thing. `swapPadConfigurations` uses `extractPadPlaybackSettings`;
`duplicateProfileLocally`, written later, hand-copies the fields and drops two.
`useKeyboardListener` learned to release Shift on `blur`; `PadGrid`'s Delete key never did.

**2. Two things that must agree, with nothing making them agree.** Pad configurations live
in three places invalidated by two different counters. The profile→JSON shape is defined
three times. `lastSyncedAt` has three homes. "A modal is open" is tracked in three
unconnected stores and the keyboard listener knows about two of them.

**3. `for (const id of ids) await getAudioFile(id)`.** Six independent copies, each
reading whole Blob-bearing records to get one string field. This is the single most
repeated performance mistake in the codebase.

---

# 🔴 High

## Security

### S1. `serverShareToken` — a bearer credential — is exported inside every profile blob, and served to viewers

**Where:** `src/lib/importExport.ts:1394`, `src/lib/googleDrive/dataAccess.ts:121`,
`src/app/api/profiles/[id]/route.ts:41-51`

All three serialisers emit the profile via spread-minus-`lastBackedUpAt`, so every field on
the record ships — including `serverShareToken`. That token is a bearer credential:
`src/lib/server/shares.ts:5-7` says whoever holds it gets the role it was issued with.

`GET /api/profiles/:id` returns `data` verbatim to **viewers**. So an editor who joined by
share link pushes their own token inside the blob, and any viewer of that profile reads it
back out — **viewer → editor escalation**. The same token also ships inside every `.iaz`
export handed to anyone.

The import side allow-lists fields carefully (`buildImportedProfileFields`). The export side
has no equivalent.

**Fix:** one `profileWire.ts` that owns the wire shape with an explicit allow-list, replacing
all three spreads. This is the highest-value refactor in the report — see 🟡 D1.

### S2. Committing an audio hash proves nothing, bypassing the share-revocation control

**Where:** `src/app/api/audio/commit/route.ts:31-39`, `src/lib/server/audio.ts:266`

`head(key)` asks only whether the key exists; the server never hashes the bytes. Through the
dedup branch, an approved user who merely _knows_ a SHA-256 gets `alreadyStored: true`, no
upload URL, then a reference row and permanent download access.

Hashes are not secret — they are in every profile blob any viewer receives. This bypasses
`profileMayServeHash`, the control added specifically so that revoking a share revokes access
to the audio.

**Fix:** require proof of possession — either the client uploads and the server verifies the
digest, or the dedup branch checks the requester already has a reference to that hash.

### S3. `IMPAMP_ALLOWED_EMAILS` is commented out on a publicly-reachable host

**Where:** `config/deploy.yml:57` (with `:20-24`)

The config's own comment states the precondition — "UNSET MEANS ANY Google account can sign
in and store profiles — set this before exposing server sync on a public host" — and the
config then does not meet it. The host is public and SSL-terminated; the variable is
commented out. `src/lib/server/signupPolicy.ts:21` treats unset as allow-all.

Compounding, from `docs/server-sync.md:149,165-167`: the first user to sign in becomes admin,
and "**No storage quota.** Nothing caps how many profiles a user creates or how large a
profile blob may be. `IMPAMP_ALLOWED_EMAILS` is the only limit on who can consume space."

So the one control is off and there is no second control behind it. (Hosted _audio_ is
separately gated by `can_upload_audio`, so the bucket is not exposed — profile blobs are.)

**Fix:** uncomment with the intended value and redeploy. **Needs your decision on the allowed
set**, which is why it is flagged rather than assumed.

### S4. The Docker build context is 4.3 GB and carries a dev TLS private key into a build layer

**Where:** `.dockerignore` (whole file), `Dockerfile:17` (`COPY . .`)

`.dockerignore` excludes `.env*` but not `.worktrees/` (4.3 GB), `certificates/` (dev TLS
cert **and private key**) or `data/` (the dev SQLite database). Docker does not read
`.gitignore`, so `docker build .` — the command `README.md:111` tells users to run, and what
Kamal's builder does — tars all of it to the daemon, and `COPY . .` writes the key into a
builder-stage layer.

The build is multi-stage and the runner takes only `public` + `.next/standalone` +
`.next/static`, so the key does not reach the _published_ image — but it does land in the
local and CI build cache, and in any registry cache export.

`.gitleaks.toml:30` allowlists `certificates/` precisely because it holds a key. The two
ignore files disagree about the same question.

**Fix:** add `.worktrees/`, `certificates/`, `data/`, `.claude/`, `playwright-report/`,
`e2e-tests/`, `plans/`, `.kamal/`, `.github/`. Durably: mirror `.gitleaks.toml`'s allowlist,
since both files answer "which gitignored local artifacts hold secrets".

## Data corruption and loss

### C1. A merge can return a pad whose ids and hashes name different sounds

**Where:** `src/lib/googleDrive/dataAccess.ts:112-117`, `src/lib/syncUtils.ts:99-143,623-633`,
`src/lib/db.ts:1181-1190`

`audioFileHashes` / `*ByHash` are synthesised at export and never stamped into
`_fieldsModified` (`upsertPadConfiguration` types them out). So in `compareSyncableItems`
they always fall to the `else` branch and are decided by whole-item `_modified`, while
`audioFileIds` is decided **per field**.

Remote renames a pad at t=300, local swaps its sound at t=200 → ids come from local, hashes
from remote. `updateLocalData` prefers hashes, so the pad plays the wrong recording — and
publishes it.

This is the exact bug the hash fields were introduced to eliminate, reintroduced through the
merge.

**Fix:** exclude the hash fields from `allFields` and re-derive them after merging, so they
can never be independently merged.

### C2. `duplicateProfileLocally` silently drops gain settings

**Where:** `src/lib/db.ts:1758-1770`

It hand-copies pad fields and omits `audioGainSettings` and `padGainDb` — both live playback
fields, read at `usePadInteractions.ts:88,292` and `playbackStore.ts:215`. It also drops
profile `normalisation` and `backupReminderPeriod`.

The fix already exists twelve lines above: `extractPadPlaybackSettings` (`db.ts:1293`), whose
own docstring warns about exactly this failure. `swapPadConfigurations` uses it;
`duplicateProfileLocally`, added later, does not. No test covers the function.

**Note for CLAUDE.md:** the `Record<audioFileId, …>` invariant names three files. There are
**five** sites, and this is site four, currently wrong.

### C3. Joining a shared profile on an S3 deployment imports every pad empty — then publishes the emptiness

**Where:** `src/lib/importExport.ts:888-901`

`importProfileFromSyncData` handles `driveFileId` and base64, and `console.warn`-skips
everything else. Server-hosted-only files have neither, so they are skipped.

That is the sole path used by `useConnectServerProfile`. Because import stamps every field
fresh, the first sync afterwards raises a conflict whose "keep local" answer publishes the
emptied pads back to the collaborator who shared them.

**Fix:** add the hosted-audio branch — `serverAudio/transfer.ts` already has the download
path.

### C4. Pad configurations live in three places; two write paths invalidate only one

**Where:** `src/hooks/usePadConfigurations.ts:56,101`, `src/hooks/useKeyboardListener.ts:208,291`,
`src/hooks/pad/usePadSwap.ts:73-93`, `src/components/modals/BulkImportModalContent.tsx:322-339`

| Copy                    | Owner                              | Invalidated by                                    |
| ----------------------- | ---------------------------------- | ------------------------------------------------- |
| IndexedDB               | authoritative                      | —                                                 |
| `result.padConfigs`     | `usePadConfigurations` → `PadGrid` | `padConfigsVersion` **and** a local `reloadToken` |
| `padConfigsRef` (a Map) | `useKeyboardListener`              | `padConfigsVersion` **only**                      |

`refreshPadConfigs()` updates the grid only; `incrementPadConfigsVersion()` updates both. Pad
swap and bulk import call the first and not the second.

**Impact.** After moving a sound in delete/move mode the grid is right but the keyboard is
not — the old key plays the sound that moved away and the new key plays nothing. After a bulk
import, **none of the newly filled pads respond to the keyboard at all**. Both persist until
the user switches bank or profile, which is exactly the kind of bug that "fixes itself" and
never gets reported.

**Fix:** have `useKeyboardListener` consume `usePadConfigurations` rather than running its own
fetch, and delete `padConfigsRef` and `reloadToken`. The two-line stopgap is
`incrementPadConfigsVersion()` at both sites — but that leaves five call sites that each have
to remember, which is how this happened.

## Playback — the panic button

### P1. A rapid retrigger strands a track that ESC cannot stop

**Where:** `src/lib/audio/playback.ts:314,495`, `src/lib/audio/controls.ts:317,510`

`playback.ts` claims the playback key with a bare `activeTracks.set`, no occupancy check.
`controls.ts:317` reads liveness synchronously, then awaits `getAudioFile` (and on the
fallback branch a full decode) before registering. Two triggers inside that window both
proceed; the second evicts the first from the map.

The evicted source keeps playing and overlapping, and `stopAllTracks` iterates
`activeTracks.keys()` — so **the panic button cannot reach it**. The same race makes
`controls.ts:510` stop an unrelated healthy track.

For a live-performance soundboard, ESC not stopping everything is the worst failure the app
has.

**Fix:** claim the key before the first await; dispose any displaced occupant.

### P2. `stopGeneration` is one global counter, so stopping one pad cancels another's pending trigger

**Where:** `src/lib/audio/playback.ts:32`, `src/lib/audio/controls.ts:465,492,558`

Every `stopTrack` bumps it; every in-flight trigger checks it. With `activePadBehavior` set
to `stop` or `restart`, retriggering pad B silently cancels pad A's pending trigger.

**Fix:** per-key generations, plus one global reserved for `stopAllTracks`.

## Server and performance

### R1. `hashIsUsedByAnyProfile` reads and JSON-parses **every profile blob in the deployment** on one DELETE

**Where:** `src/lib/server/audio.ts:207-219`, called from `src/app/api/audio/[hash]/route.ts:71`

`SELECT data FROM profiles` — no `WHERE`, no `LIMIT` — through `queryAll`, which materialises
every blob as a JS string in one array before the loop starts.
`MAX_PROFILE_BODY_BYTES = 8 MB`.

`node:sqlite` is synchronous and Node is single-threaded. 200 profiles averaging 500 KB is
~100 MB of string allocation plus ~100 MB of synchronous `JSON.parse`: **the entire process
stops** — every other user's request, every SSE heartbeat, the `/up` health check. With 8 MB
profiles it is a self-inflicted denial of service.

**Fix:** it is an existence check. Track hosted-hash membership relationally
(`profile_audio(profile_id, hash)` indexed on `hash`, written on profile PUT) making it
`SELECT 1 … WHERE hash = ? LIMIT 1`.

### R2. Not one outbound `fetch` has a timeout — and two caches then wedge permanently

**Where:** `rg "AbortController|AbortSignal" src/` → **zero matches**. 33 fetch sites across
Drive, Wasabi, the app's own backend and OAuth.

Two places turn a single hang into permanent breakage:

- `src/lib/serverSync/sync.ts:100-114` — the `inFlight` map's `finally` never runs if the
  inner fetch never settles, so **every future sync for that profile returns the same dead
  promise for the life of the tab**.
- `src/lib/serverAudio/transfer.ts:52-57` — `capability ??= fetchAudioLibrary()…` caches the
  _pending_ promise. If `/api/audio` hangs, every subsequent `uploadProfileAudio` awaits it
  forever, stalling all syncs.

`public/sw.js:107` compounds it: network-first with no timeout, so the cache fallback never
fires for a stalled socket — the whole app goes unresponsive rather than serving cache.

Server-side, un-timed proxy and OAuth fetches hold Node handlers open on a **single-instance**
deployment, so a slow Google can exhaust the process.

**Fix:** one `fetchWithTimeout` using `AbortSignal.timeout(ms)` — ~10 s for JSON control-plane
calls, 60–120 s for blob transfer. `s3/client.ts:52` already injects `fetchImpl`, so a
defaulted timeout there covers both server S3 calls in one line. Pass `signal: request.signal`
in the three proxy routes. Give `inFlight` and `capability` an expiry so a hang self-heals.

### R3. Loudness analysis is ~1 billion float ops of synchronous main-thread work, fired unqueued per file

**Where:** `src/lib/audio/loudness/truePeak.ts:84-110`, `analyse.ts:76-91`, triggered from
`src/lib/db.ts:519-531`

True-peak does 3 phases × 12 taps = 36 multiply-accumulates **per sample per channel**. A
5-minute stereo 48 kHz file is ~1.04 × 10⁹ operations. The block loop then re-sums
75 %-overlapping windows from scratch, touching every sample four times.

`addAudioFile` fires this with **no queue, no idle gate, no concurrency cap**. Dropping 40
files onto pads queues 40 microtasks that each freeze the main thread for hundreds of
milliseconds. `rg "new Worker" src/` returns nothing — there is not a single Web Worker in
the application.

**Impact.** ~0.5–2 s of hard freeze per 5-minute file: no paint, no input, and the Web Audio
render quantum can under-run so a sound already playing glitches. Bulk-importing a 300-sound
library serialises into minutes of an unresponsive tab.

**Fix:** (1) move `analyseLoudness` + `computeHopTruePeak` into a Worker — the inputs are
plain `Float32Array`s, so they transfer with zero copying; (2) make the block loop a sliding
sum, a straight 4× reduction with no accuracy change; (3) route every `analyseAndStore` call
through the existing coalescing queue in `pipeline.ts`.

### R4. `uploadProfileAudio` does two HTTP round-trips per audio file on **every** sync, with no "already hosted" short-circuit

**Where:** `src/lib/serverAudio/transfer.ts:90-126`, called from `src/lib/serverSync/sync.ts:183-189`

Nothing consults the stored `file.serverHosted` flag before entering the loop.
`requestUploadUrl` and `commitUpload` are issued unconditionally for every file, even when
the server answers "already stored". `markAudioFilesHosted` then opens a separate read-write
transaction per hash.

The loop is strictly sequential. For a 500-sound profile that is **1000 sequential HTTP
round-trips, 500 full-record IndexedDB reads and 500 IndexedDB write transactions per sync**
— ~40 s of wall clock at 40 ms RTT. Each `commitUpload` also hits `getGlobalUsage`, a full
scan of `audio_objects`, so the server pays 1000 scans too.

Syncs run on app load, every 15 min, on reconnect, on every SSE event, and 10 s after every
edit. Only bites deployments with `IMPAMP_S3_*` configured — but there it makes hosted audio
unusable past a hundred sounds.

**Fix:** filter on `serverHosted` before the loop (one cursor pass), batch
`markAudioFilesHosted` into one transaction, and run the remainder through a bounded pool.

### R5. `getProfileById` is `SELECT *` on the 304, DELETE and SSE-heartbeat paths

**Where:** `src/lib/server/profiles.ts:25-27`; callers at
`src/app/api/profiles/[id]/route.ts:31,124` and `.../events/route.ts:36,95,111`

It reads the `data` column — up to 8 MB — off disk through SQLite's overflow chain and
materialises it as a UTF-16 string, synchronously, every call. The GET's comment claims the
change poll "costs almost nothing"; the blob is read before the ETag is even computed.

The heartbeat is the worst: `loadAuthorizedProfile` every 25 s per open stream, one stream per
server-synced profile per tab with no cap. 20 users × 3 profiles × 2 tabs = 120 full
profile-blob reads every 25 seconds for connections doing nothing.

**Fix:** add `getProfileMeta(id)` selecting only `id, owner_id, name, version, updated_at`,
and use it on the 304, DELETE and both SSE paths. For the heartbeat, `resolveAccess` reads
only `owner_id` and is already the cheap check.

## Correctness in the UI layer

### U1. `/server/open` re-implements `useConnectServerProfile` and reintroduces the bug that hook exists to prevent

**Where:** `src/app/server/open/page.tsx:63-131` vs `src/hooks/useConnectServerProfile.ts:40-105`

Both run the identical five-step sequence, comments copy-pasted verbatim. They diverge on the
one line that matters. The hook imports as **local** first and upgrades once the server id is
known, with a comment explaining why: a crash between the two steps used to leave a profile
typed `server` with no `serverProfileId`, and the next background sync reads exactly that as
"adopt me" — creating a _second_ server profile, leaving the share link pointing at an orphan.

The page still passes `{ syncType: "server" }` up front.

**Impact.** Opening a server share link — the primary onboarding path for a collaborator — has
a window in which a crash or failed `updateProfile` produces the documented duplicate-profile
failure. The fix was written, tested, and not applied to the page that needs it most.

**Fix:** delete the effect body and call `useConnectServerProfile()`. The hook already returns
`{ kind, name, readOnly }`, which maps 1:1 onto the page's states.

### U2. `ProfileManager` is six components in a trench coat, mounted on every page load

**Where:** `src/components/profiles/ProfileManager.tsx:82-1730`

1730 lines, **29 `useState` calls**, 11 handlers, an OAuth flow, a Drive Picker integration,
four IndexedDB maintenance routines and three tabs of markup. Two things make the size
actively costly:

- **It subscribes to the entire profile store** (`:83-101`, no selector), so every sync tick,
  `padConfigsVersion` bump, `syncRequestQueue` push and bank switch re-renders all of it.
- **It runs all of that before deciding it is invisible.** The `if (!isProfileManagerOpen)
return null` is at line 650 — after `useGoogleDriveSync()` (615 lines), `useGoogleLogin()`,
  29 `useState`s and both effects, including `:383-386`, which imports
  `@googleworkspace/drive-picker-element` on mount. It is rendered unconditionally in
  `ClientLayout.tsx:26`, so **every visitor downloads and registers the Drive Picker custom
  element on app start**, whether or not they ever open the manager or use Drive.

**Fix, in order of payoff:** (1) a one-line `ProfileManagerHost` that gates on
`isProfileManagerOpen` before constructing the body — this alone kills the eager picker import
and the invisible re-renders; (2) extract the three tabs as siblings owning their own state;
(3) the three maintenance routines are already `{isRunning, result, run()}` triples — make
them hooks.

## Tests

### T1. "Cannot delete the active profile" has never tested anything

**Where:** `e2e-tests/profiles.spec.ts:87-109`

```ts
const activeProfileItem = page
  .locator('[role="listitem"]')
  .filter({ hasText: /Default/i })
  .first();
const deleteButton = activeProfileItem.getByRole("button", { name: /delete/i });
await expect(deleteButton).toBeHidden(); // line 108
```

There is **no** `role="listitem"` anywhere in `src/`, and no `<li>` in the profile list —
`ProfileManager.tsx:736` renders `<ProfileCard>` inside plain `<div>`s
(`ProfileCard.tsx:267` uses `data-testid="profile-card"`). `toBeHidden()` passes on a
non-existent element, so **this test would pass even if the Delete button were rendered and
clickable for the active profile** — the exact regression it exists to catch.

**Fix:** retarget at `[data-testid="profile-card"]`. The real Delete button is
`ProfileCard.tsx:344`.

---

# 🟡 Medium

## Duplication — the unification targets

### D1. The profile→JSON shape is defined three times

`ProfileExport` (`importExport.ts:68`), `ProfileExportLean` (`:1332`) and `ProfileSyncData`
(`syncUtils.ts:319`). The first two both claim `exportVersion: 2` with structurally different
`audioFiles` arrays; `detectImportFormat` disambiguates by container, not version.
`ProfileExport` has no writer left but is still the type `importProfileCore` is built against
— which is _why_ there are three.

**Fix:** a `profileWire.ts` owning one shape with an explicit allow-list. Additive, pure,
closes S1, collapses the three. **This is the single most valuable change in the report.**

### D2. "Connect a Drive profile" is written out four times

`ProfileManager.tsx:337-381` (picker), `:413-512` (pasted URL), `src/app/drive/open/page.tsx:63-138`,
`src/components/profiles/ConnectProfileList.tsx:159-181`. The validation string is identical in
all four; "find the profile JSON in the folder" is duplicated word-for-word including its error
message.

**They have already drifted:** only `drive/open` and `ConnectProfileList` check whether the
profile is already connected. Pasting a link to a profile you already have silently creates a
duplicate.

**Fix:** `useConnectDriveProfile()` alongside the existing `useConnectServerProfile()`, with the
already-connected check inside it.

### D3. The Google OAuth code-exchange is copy-pasted three times

`ProfileManager.tsx:229-292`, `drive/open/page.tsx:161-215`, `AuthNotification.tsx:63-129` —
~50 identical lines each (POST exchange → destructure tokens → compute `expiresAt` → fetch
userinfo → `setGoogleAuthDetails`). Only the trailing action differs.

**Fix:** `useGoogleSignIn({ onSignedIn })`.

### D4. `SharingPanel` and `ServerSharingPanel` are the same component twice

255 vs 274 lines, scaffolding duplicated verbatim including the comment explaining the
cancellation flag. The invite form is the same markup with the same Tailwind strings; only the
role vocabulary differs (`reader`/`writer` vs `viewer`/`editor`).

Note this is _not_ the fork the sync-panel refactor already fixed — `ProfileSyncPanel` unified
the two backends correctly. These two leaves were left behind.

**Fix:** `useRemoteList<T>(fetch)` plus presentational `<InviteRow>` / `<AccessList>`.

### D5. Three copies of the "trigger audio with loading callbacks" block

`usePadInteractions.ts:283-341`, `SearchModal.tsx:84-130`, `playbackStore.ts:205-258` — each
rebuilds the same four callbacks, each recomputing `generatePadLoadingKey`. They already differ
in their log prefixes and in whether they `await`.

**Fix:** `triggerPad(padLike, opts)` in `src/lib/audio/` owning the loading-key wiring.

### D6. Four call sites open-code the pad-save sequence

`usePadDrop.ts:79-107`, `usePadInteractions.ts:120-150`, `BulkImportModalContent.tsx:316-337`,
`LoudnessOverviewModalContent.tsx:290-313` — and bulk import omits
`incrementPadConfigsVersion()`, which is 🔴 C4 above.

**Fix:** one `savePadConfiguration()` owning upsert + version bump + `requestSync` + the
emergency check.

### D7. `getHashlessIndex` is duplicated verbatim, and both run in one server sync

`src/lib/googleDrive/sync.ts:292` and `src/lib/serverAudio/transfer.ts:201` — byte-for-byte the
same shape, building four hash→id indexes total per server sync. Each reads and SHA-256s **every
audio file in the local library**, one blob fully in memory at a time.

The ZIP importer guarantees it fires: `importExport.ts:416-424` writes imported audio through a
raw transaction, bypassing `addAudioFile`, so **no hash is stored**. After a `.iaz` restore of a
2 GB library the first sync hashes all 2 GB sequentially.

**Fix:** store the hash at import time (`importAudioSources` has the blob in hand), bound the
lazy index to the hashes actually looked up, and de-duplicate the two implementations.

### D8. Four hand-rolled modal overlays alongside the modal system

`Modal.tsx:85` is the system; `ProfileManager.tsx:655`, `SearchModal.tsx:194` and
`WaveformTrimmer.tsx:424` each re-implement a subset. `Modal` provides Escape-with-
`stopImmediatePropagation` (so Escape does not also fire the panic button), overlay-click-close
and a labelled close button. `SearchModal` re-implements two of those; **`ProfileManager`
implements neither — no Escape, no overlay click.**

### D9. Five icon buttons, five copies of the same class string

`HelpButton.tsx:33`, `SearchButton.tsx:35`, `LoudnessOverviewButton.tsx`, `EditModeButton.tsx:34`,
`DeleteMoveModeButton.tsx:32`. Same shape, smaller: the spinner SVG is pasted three times inside
`ProfileManager` (`:1280`, `:1349`, `:1612`). See also the existing backlog item about 31 inline
`<svg>` blocks in `plans/off-topic-improvements.md`.

### D10. Smaller duplicates

- `SPECIAL_PAD_INDICES` computed in `PadGrid.tsx:24-41` and `BulkImportModalContent.tsx:10-13`.
- `DEFAULT_BACKUP_REMINDER_PERIOD_MS` re-derived in `useProfileEdit.ts:33-35`; `MS_IN_DAY` a
  third time in `ProfileCard.tsx:29-45`.
- The `lastSyncedAt` fallback expression is character-for-character identical in
  `useProfileSync.ts:276-278` and `ProfileCard.tsx:116-119`.
- The admin gate is copied verbatim across both `admin/*` routes; `parseJsonBody` exists in
  `audioRequests.ts` and is re-inlined in three places.
- `currentDriveToken` is written in three places.
- Five `db.ts` clusters, ~380 lines that collapse to ~120.

## Architecture and state

### A1. `profileStore` (1161 lines) is six stores in a trench coat

Beyond profiles and CRUD it holds UI mode state (`isEditMode`, `isDeleteMoveMode`,
`currentPageIndex`, `isProfileManagerOpen`), ~310 lines of import/export **including a
`document.createElement("a")` download**, Google OAuth tokens, sync orchestration,
cache-invalidation counters and app settings.

That `isEditMode` lives in the _profile_ store is the tell: `ClientSideInitializer.tsx:441-454`
subscribes to the profile store to learn the user pressed Shift, and `app/page.tsx:46`
re-renders the whole page on it. `useUIStore` exists and holds only modal state — the natural
home is already there and unused.

**Proposed split:** `profileStore` (~350 lines) · `authStore` (~120) · extend `uiStore` ·
`settingsStore` · `lib/profileTransfer.ts` (plain async functions, removes ~310 lines and the
DOM access from the store).

### A2. `ClientSideInitializer` is a 471-line sync daemon that renders `<>{children}</>`

`src/components/ClientSideInitializer.tsx:52-469`. Its entire output is line 468. Everything else
is scheduling policy: four interval constants, an eligibility predicate, per-profile debounce
timers, remote-version bookkeeping, SSE subscription reconciliation and five effects. It uses
`useProfileStore.subscribe(...)` rather than the hook in five places precisely because it does
not want to render — the tell that it should not be a component.

None of the scheduling is testable without mounting React, and "why did it sync twice?" is a
question only answerable by reading a component.

**Fix:** `src/lib/sync/scheduler.ts` exporting `startSyncScheduler(deps): () => void`, intervals
injectable. The component becomes an eight-line effect.

### A3. 175 lines of sync-merge business logic live inside a modal

`src/components/modals/ConflictResolutionModal.tsx:130-306`. `buildResolvedData` clones the
merged payload, reseeds conflicting items, applies per-field choices and hand-maintains
`_fieldsModified` / `_modified`. It imports `deepClone` and `Syncable` from `@/lib/syncUtils` —
its natural home is one import away.

The most correctness-sensitive code in the sync system — it decides what survives a conflict and
what timestamps the next sync compares — can only be exercised through a rendered React tree, so
it has no unit test. There is a `// TODO: Show error to user in the modal?` at `:317` on the path
that catches its failure.

**Fix:** move to `syncUtils.ts` as a pure `applyConflictResolutions(...)` and unit-test the four
resolution branches plus the `_modified` arithmetic.

### A4. `syncRequestQueue` never drains, and each request re-arms every profile ever edited

`src/store/profileStore.ts:446-453` writes a key and nothing ever deletes it.
`ClientSideInitializer.tsx:320-350` iterates **all** keys on every change. Edit profile 1, then
2, then 3, then 1 again: all three get a fresh timer and all three sync. The set grows
monotonically for the life of the tab.

**Fix:** use `subscribeWithSelector`'s previous value and act only on changed keys; delete the
entry when the timer fires. Better: move the debounce into the store action so there is no queue.

### A5. Server sync's in-flight map discards joiners' callbacks and swallows SSE events mid-run

`src/lib/serverSync/sync.ts:107`. Drive got the 60-line listener/replay fix for this; server did
not.

### A6. Drive reports warnings through `onError`, server through `onWarnings`

`googleDrive/sync.ts:855,974,428` vs `serverSync/sync.ts:407-411`. `SyncControls.tsx:145-152`
paints `error` red, so a Drive sync that merely missed one sound shows as **failed**, and
`status.warnings` is dead for every Drive profile — contradicting the store's own docstring.

Related: `useServerSync`'s `warnings` is written but unreadable by anyone else —
`mirrorToProfile` (`syncStatusStore.ts:147-165`) mirrors four callbacks but not `onWarnings`, so
a warning from a background sync is stored where no card can see it.

### A7. SSE subscriptions are reconciled by profile id only

`ClientSideInitializer.tsx:381-396` — if `serverProfileId` or `serverShareToken` changes on an
already-subscribed profile (re-connect, rotated token, share revoked and re-issued), the
`continue` keeps the old `EventSource` pointed at the old id. The stream then 401s forever
(`onerror` only logs) or delivers changes for the wrong profile.

**Fix:** key the map on `${profileId}:${serverProfileId}:${shareToken}`.

### A8. "A modal is open" is tracked in three places; the keyboard listener knows about two

`uiStore.isModalOpen`, `SearchContext.isSearchModalOpen`, `profileStore.isProfileManagerOpen`.
`useKeyboardListener` guards on the first two. `ProfileManager` is rendered directly in
`ClientLayout` rather than through `uiStore`, so **with the profile manager open and focus
anywhere that is not an `<input>`, `q` triggers a pad, `1` switches bank behind the overlay,
Escape runs the panic stop instead of closing the manager, and Enter fires an emergency sound.**

**Fix:** move all three into `uiStore` behind one derived `isAnyOverlayOpen`.

### A9. `PadGrid`'s Delete-key tracking is a second global keymap with no blur handling

`src/components/PadGrid.tsx:228-243`. `useKeyboardListener` learned this lesson for Shift and
added `blur` + `visibilitychange` guards (`:721-736`); `PadGrid` has neither. Alt-tab away with
Delete held and the `keyup` never arrives — `isDeleteKeyDown` stays `true`, so on return a plain
click on a pad in edit mode **removes its sound** instead of opening the editor.

### A10. Overlapping lifecycle listeners

Three `visibilitychange` handlers, two `focus`, one `blur`, one `online`, four `setInterval`s.
Returning to the tab fires `focus` **and** `visibilitychange`, so `checkForRemoteChanges` is
called twice — the second is swallowed by the 10 s gap guard, so waste rather than a bug, but it
is the "duplicated streams" shape.

**Fix:** one `useAppLifecycle()` exposing `onForeground`/`onBackground`/`onOnline`, deduped once.

### A11. `useGoogleDriveSync` keeps a second copy of the auth slice, then works around its own staleness

`src/hooks/useGoogleDriveSync.ts:158-165` copies six store fields into local state, kept in sync
by a manual subscription; then, because that copy lags a render, `:246-258` adds
`getFreshTokenInfo()` which reads the store directly. All ~15 exported callbacks use the fresh
accessor. The copy survives only as effect dependencies — which `useProfileStore(selector)`
already provides.

### A12. The Google token-refresh throttle and the 5-minute interval are per hook instance

`useGoogleDriveSync.ts:130-137,316-320,339`. The hook is mounted by `ClientSideInitializer`,
`ProfileManager`, every `ProfileCard`, `ProfileSyncPanel`, `SharingPanel`, `ConnectProfileList`,
`useConnectServerProfile` and both share-link pages. With the manager open on ten profiles that
is ~12 live instances, each with its own interval and 60-second throttle. `refreshAccessToken`
has no cross-caller dedupe, so an expired token produces up to a dozen simultaneous refresh
POSTs, last writer wins.

`useServerSync.ts:116,130` shows the right pattern for exactly this — a module-level in-flight
promise and listener set.

### A13. Whole-store subscriptions in eight components and hooks

`ProfileManager.tsx:101`, `ProfileCard.tsx:68`, `ProfileSelector.tsx:10`, `drive/open/page.tsx:29`,
`server/open/page.tsx:33`, `useProfileEdit.ts:21`, `usePlaybackSettings.ts:20`,
`usePadInteractions.ts:62`. Under Zustand v5 each re-renders on _any_ mutation of that store.
`ProfileCard` is the worst — one per profile, and each additionally instantiates
`useGoogleDriveSync()` and `useServerSync()`.

### A14. `useFormModal` assigns a function during render and stores React elements in Zustand

`src/hooks/modal/useFormModal.tsx:71-146`. `handleFormSubmit` is written **during the render
phase** into a closure variable outside React's control — the pattern React 19's concurrent
renderer explicitly does not guarantee. The fallback admits the fragility: if it fires, it
submits `initialValues`, silently discarding the user's edits.

Second, `openContentModal({ content: <FormModalContent /> })` puts a live React element into the
Zustand store, which is why the store can never be persisted.

Every form in the app goes through this: pad editing, bank editing, profile editing, playback
settings.

## Audio

### AU1. Six load-and-decode entry points, ~200 lines unreachable

`decoder.ts`: `loadAndDecodeAudioParallel` and its two helpers, plus `preloadAudioFiles` and
`preloadAudioForPage`, have zero references. See 🟢 L1.

### AU2. `decodeAudioBlobStreaming` and `decodeAudioBlobProgressive` are byte-identical to `decodeAudioBlob`

Neither streams nor is progressive; `onPartialReady` fires with the _complete_ buffer _after_ the
decode, so `onAudioReady` fires twice for files > 5 MB.

### AU3. The pipelined preloader publishes its in-flight entry two awaits late

`decoder.ts:375→404`, so a concurrent trigger decodes the same blob twice. Related:
`analyseAndStore` decodes outside the in-flight registry and discards the buffer, so first-run
profile activation does roughly double the decode work; and `WaveformTrimmer` re-decodes a file
the preloader already cached.

### AU4. The error fallback plays the wrong sound with the wrong gain

It plays a _different_ sound with the _failed_ sound's normalisation gain and trim window, and
reports the wrong `audioFileId`.

### AU5. `triggerAudioForPadInstant` is 322 lines and six responsibilities

And `playbackLoopTick` enforces trim-end and destroys tracks _inside_ the rAF loop, mutating the
map it iterates — so streamed trim accuracy is frame-rate dependent.

### AU6. Round-robin special-casing leaks into `controls.ts:428`

A cast plus a duplicate `getStrategy` call — the one place the strategy abstraction fails.

## Storage and import

### ST1. `cleanupOrphanedAudioFiles` scans and deletes across three separate transactions

`src/lib/db.ts:754-838` — it can delete audio mid-import, since imports commit audio and pads
separately.

### ST2. Import writes records with no `_created` / `_modified` / `_fieldsModified`

`importExport.ts:337,615,482` — breaking `compareSyncableItems`' entire basis, which is why an
imported profile's first sync raises spurious conflicts (and why 🔴 C3 publishes emptied pads).

### ST3. Per-record import failures are `.catch`-swallowed and reported as success

`importExport.ts:490,631`.

### ST4. ZIP import has no validation

Three bare `JSON.parse(…) as T` (`:1606,1621,1630`) and no size cap, so a DEFLATE bomb OOMs the
tab. The JSON path _does_ have a cap — only the ZIP path is unguarded.

### ST5. `updateLocalData` spreads untrusted remote pads wholesale into IndexedDB

`dataAccess.ts:389`, persisting wire-only `*ByHash` fields.

### ST6. `renamePage` / `setPageEmergencyState` are non-atomic read-modify-writes

They clobber each other.

## Performance — the N+1 sweep

All the same shape: `for (const id of ids) await getAudioFile(id)`, reading whole Blob-bearing
records for one field. Worth fixing as **one sweep** behind a shared
`getAudioMetadataForProfile(profileId)` helper.

| #   | Where                                             | Cost                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | `loudness/pipeline.ts:161-169`                    | Run **twice** per `refreshProfileLoudness`, on every profile activation and after every sync. 500 sounds = 1000 sequential reads + two 12 MB cursor scans. `db.ts:557-563` documents this exact anti-pattern for a neighbouring function. |
| N2  | `googleDrive/dataAccess.ts:69-89`                 | 2–3× N+1 per file, and `serverSync/sync.ts:266` puts it **inside** the push retry loop — 960 sounds → ~1920 reads per sync, ×3 on a contended push.                                                                                       |
| N3  | `googleDrive/dataAccess.ts:375-381` vs `:454-458` | Builds a Map, then issues an index `get` per pad anyway — 960 unnecessary lookups **inside the write transaction**, extending how long it holds its locks. `existingPadMap.get(key)` is a drop-in replacement.                            |
| N4  | `hooks/useSearch.ts:135-142`                      | First Ctrl+F of a session on a 960-sound board: 960 sequential full-record reads before any result.                                                                                                                                       |
| N5  | `LoudnessOverviewModalContent.tsx:122-127`        | Unbounded `Promise.all` of up to 960 concurrent full-record reads, for `.name`.                                                                                                                                                           |
| N6  | `googleDrive/sync.ts:156-165`                     | Short-circuits correctly, but _after_ the full-record read — 960 reads per sync to discover nothing needs uploading.                                                                                                                      |

### Other performance findings

- **P1.** The sync merge does a JSON deep-clone per item and two `JSON.stringify` per field
  (`syncUtils.ts:30-38,76,105`). A 960-pad board = 960 deep-clones + ~38 400 stringify calls per
  merge, up to 3× per push. `structuredClone` plus a `===` short-circuit fixes it.
- **P2.** Server PUT does 2 full stringifies + 1 parse + 3 blob reads, one stringify **inside
  `BEGIN IMMEDIATE`** holding the global write lock (`profileRequests.ts:69-81`,
  `profiles.ts:65-84`). ~40 MB of synchronous string work per PUT at the cap — which falsifies the
  comment at `profileRequests.ts:48-49` claiming one request cannot occupy the instance.
- **P3.** Server GET parses the blob and immediately re-stringifies it
  (`api/profiles/[id]/route.ts:41-51`) — three full traversals of up to 8 MB per read. The 409
  path does it again, so the _most_ expensive request is the one that accomplished nothing.
- **P4.** `listProfilesForUser` full-scans `profiles` and walks every row's overflow chain
  (`profiles.ts:109-122`) — the OR over a LEFT JOIN makes `profiles_owner_idx` unusable, and
  `version`/`updated_at` sit _after_ the 8 MB `data` column. No LIMIT, no pagination, unindexed
  `ORDER BY`.
- **P5.** `profileMayServeHash` full-scans `users` because it joins on `lower(trim(u.email))`
  (`audio.ts:160-173`) — an expression over an indexed column. Emails are already normalised on
  write, so it buys nothing.
- **P6.** No prepared-statement cache — `db.ts:230-249` calls `prepare()` on every query. Every
  SQL string is a static literal, so a `Map<string, StatementSync>` is a safe mechanical fix.
- **P7.** SSE has no `retry:` hint (browsers use a fixed ~3 s, not backoff), no jitter on the
  30-minute cap (so clients that connected together reconnect together), and the greeting carries
  no `originId` — so **reconnect ⇒ unconditional full sync**. Beyond 6 profiles the HTTP/1.1
  per-origin connection limit starves ordinary API fetches.
- **P8.** `@hello-pangea/dnd` (~100 KB) is in the first-load bundle via
  `page.tsx` → `PadGrid` → `usePadInteractions` → `EditPadModalContent` → `EditPadForm`, though
  it is only reachable inside the edit-pad modal.
- **P9.** zip.js runs with `useWebWorkers: false` (`importExport.ts:1424-1431`). The comment says
  workers "buy nothing here since audio entries are STOREd" — half right: `level: 0` skips
  DEFLATE, but ZIP still CRC32s every byte, on the main thread. Exporting 2 GB CRC32s 2 GB while
  the progress bar it is updating stutters.
- **P10.** `getGlobalUsage` full-scans `audio_objects` on every upload-url and commit
  (`audio.ts:84,292`) — combined with R4, one full scan per audio file per sync.
- **P11.** `public-file` buffers the whole upstream body before checking its size when Drive omits
  `content-length` (`api/drive/public-file/route.ts:39-57`).
- **P12.** `floatsToBase64` builds the string one character at a time
  (`importExport.ts:113-120`) — 12 000 concatenations per array, two arrays per file, on export.
- **P13.** `busy_timeout = 5000` (`server/db.ts:207`) is a five-second blocking sleep on the only
  thread. The repo already knows this — `api/test/session/route.ts:11-14` documents it.
- **P14.** Two dead indexes (`sessions_user_idx`, `profiles_owner_idx`) and a `SELECT COUNT(*) FROM
users` inside the sign-in write transaction that only tests `== 0`.

## Server and API

Enumerated all 24 route handlers per method with their auth and ownership checks. **No IDOR, no
SQL injection, no leaked internals** — see "Verified clean". The remaining items:

- **SV1.** Bytes can be parked in the bucket unaccounted (`upload-url/route.ts:45`): declare 1
  byte, PUT 5 GiB, never commit. Nothing HEADs, charges or sweeps uncommitted keys. The
  commit-refusal branch (`:58`) also keeps an oversized overwrite when an object row exists.
- **SV2.** Email-match wins the account and **inherits `is_admin`** (`users.ts:75-90`). The
  recycled-Workspace-account rationale is sound; the admin flag riding along is not.
- **SV3.** Drive proxies are open to anyone omitting a Referer (`proxyUtils.ts:45`:
  `if (!source) return true`) — unauthenticated, unrate-limited, 100 MB per request, spending the
  deployment's `GOOGLE_API_KEY`.
- **SV4.** Presigned download TTL is 3600 s, so revocation lags by up to an hour and the URL is a
  forwardable bearer credential.
- **SV5.** `applyTransition`'s `driveSyncNow`/`serverSyncNow` only fail on `"error"`, so a
  _paused_ profile's transition "succeeds" into the `server-awaiting-first-sync` defect.

## UI correctness

- **UI1.** `PadGrid` renders the previous bank's pads while the next loads and never reads
  `isLoading` — it is consumed only by `console.log` (`PadGrid.tsx:162-208`). Between pressing `4`
  and the read resolving, the grid shows **bank 3's pads labelled as bank 4**, and `handlePadClick`
  reads that same stale array — a click in that window plays the previous bank's sound at the new
  bank's index. The same window swallows a config error entirely.
- **UI2.** `EditPadForm` mirrors form values into local state, then fights the mirror
  (`:62-127`) — every handler writes to both, then an effect rebuilds one from the other. Correct
  only because the rebuild happens to agree.
- **UI3.** Bank metadata is duplicated into `page.tsx` state, refetched on every bank switch (with
  `currentPageIndex` in the deps but **absent from the effect body**), and hand-patched on write —
  so a bank renamed by a collaborator never appears until the profile is switched.
- **UI4.** `page.tsx:326-425` — "Add Bank" is a 100-line inline `onClick` with the form value
  smuggled through a `let` in the handler's scope, four lines from where `useFormModal` is used
  correctly for _editing_ a bank.
- **UI5.** Emergency-sound state is module-global in `useKeyboardListener.ts:40-41`, so between a
  profile switch and the async reload resolving, Enter plays the **previous** profile's emergency
  sound. One-line fix: clear the array at the top of `reloadEmergencySounds`.
- **UI6.** `SearchProvider`'s context value is rebuilt every render, which detaches and reattaches
  the global keydown/keyup handlers. Bounded today; one `useState` away from per-keystroke churn,
  and any key held across the swap loses its `keyup` pairing.
- **UI7.** Two full sync sweeps on every page load — `ClientSideInitializer.tsx:60` initialises
  `isGoogleSignedIn` to `false` and subscribes `fireImmediately` inside an effect, so the first
  sweep runs signed-out and the second runs after. Each sweep costs a Drive metadata request per
  profile.

## Test health

- **TH1. The highest-risk modules have no unit test at all:** `store/profileStore.ts` (1161),
  `googleDrive/api.ts` (1144), `googleDrive/sync.ts` (997), `audio/decoder.ts` (936),
  `audio/controls.ts` (774), `hooks/useKeyboardListener.ts` (763). **🔴 P1 and P2 are both
  directly expressible as failing tests today** against `controls.ts`, which has none. So is 🔴 C2
  (`duplicateProfileLocally`) against `db.ts`.
- **TH2.** `importExport.ts` has five targeted tests, but the ZIP path and `importImpamp2Profile`
  — ~544 lines, 31 % of the file, all reachable from the UI — have none. That is the riskiest
  place to start the split, and the reason to test before splitting.
- **TH3. E2E flakiness:** ten `waitForTimeout` sleeps, five of them **load-bearing guards on
  negative assertions** (`audio-playback.spec.ts:339`, `pad-disable.spec.ts:53,66,113`,
  `follow-profiles.spec.ts:178`) — 200–500 ms is the entire window in which a regression could be
  caught. The worst is `test-helpers.ts:204`, a 300 ms sleep immediately before a web-first
  assertion that already retries, on a helper used by four spec files.
- **TH4.** `armed-tracks.spec.ts:530` carries `{ timeout: 5000 }`, which
  `playwright.config.ts:24-27` explicitly forbids in so many words ("that is the old default
  written out longhand, and pinning an assertion back down to it is what made these tests
  flaky"). It **lowers** the effective timeout from 15 s to 5 s. Single highest-value one-line fix
  in the suite.
- **TH5.** `getArmedTrackNames` (`armed-tracks.spec.ts:49-72`) returns `[]` when a non-retrying
  `isVisible()` is false, so **five negative assertions pass for two different reasons** —
  "the track was removed" and "the panel had not rendered yet". `:659` asserts empty, and the
  early return _is_ empty.
- **TH6.** Two missing `await`s on clicks — `profiles.spec.ts:60,74` — so the next assertion races
  the click.
- **TH7.** `e2e-tests/README.md:50-64` lists four "known failures" whose stated causes **no longer
  exist in the specs** (verified by grep: `exportProfile`, `"Remove sound"` and `prompt-input` all
  return no matches in the files named). It also omits 63 of the 122 tests from its scope
  description.
- **TH8.** Ten clusters of duplicated E2E setup, each 5+ lines across 2+ files — the worst being
  `loadSoundOntoPad` (~14 sites) and `assignSoundsToPad` (~11 sites, independently re-extracted by
  three different specs). `openProfileManager` **exists** in `test-helpers.ts:546` and five specs
  hand-roll it anyway — including `server-sync.spec.ts:308-313`, a verbatim inline copy.

## Infrastructure

- **I1.** Production container runs as **root** — no `USER` directive in either stage, so
  `node server.js` runs as uid 0 with the `/data` SQLite volume writable by it.
- **I2.** Action pins have drifted — `actions/checkout`, `setup-node` and `upload-artifact` are each
  pinned at **two different SHAs** across jobs. The `unit` job (the one gating `npm test` and
  `npm run lint`) runs an older toolchain than the rest of the pipeline; `upload-artifact` is three
  majors behind there.
- **I3.** `ci.yml:1-3` tells you to verify pins with `scripts/check_action_refs.sh`, which **does
  not exist**. Very likely the direct cause of I2.
- **I4.** `Dockerfile.dev:2` is `node:22-alpine` while everything else is 24.19.0 — and
  `check_version_sync.sh:54` loops over `Dockerfile Containerfile` only, so the gate passes without
  looking. This contradicts CLAUDE.md's "Node 24.19.0 everywhere". It also uses `npm install`, not
  `npm ci`, so the dev container does not reproduce the lockfile.
- **I5.** The pre-commit hook runs neither ESLint nor the test suite, though CI runs both — while
  every _other_ gate in `hk.pkl` carries a comment claiming CI/pre-commit parity. The two checks
  most likely to catch a real regression are the two that exist on one side only.
- **I6.** No `npm audit` step in CI and no dependabot/Renovate config. Currently clean, so latent —
  but a new advisory lands silently, and nothing proposes bumps (which is how I2 accumulated).
- **I7.** `Dockerfile:24` — a leftover `RUN echo "CLIENT_ID during build: $..."`. The value is
  `NEXT_PUBLIC_` and public by design, so **not a secret leak**; it is a debugging leftover that
  pins the value in a cache layer and invalidates the cache on every change. The pattern is the
  concern — the next `ARG` added there may not be public.
- **I8.** The single-instance requirement is documented in two places but **not in
  `config/deploy.yml`**, the one file where it would actually be violated. Adding a second host is
  a one-line, entirely natural edit that silently breaks SSE fan-out, and the failure is soft —
  it presents as "notifications are sometimes slow", not as an outage.
- **I9.** Six packages behind: `next`, `eslint-config-next`, `@next/bundle-analyzer` 16.3.0 →
  16.3.1 and `@zip.js/zip.js` 2.8.47 → 2.8.51, all in-range patch bumps. The three deferred
  upgrades in `plans/deferred-upgrades.md` were re-checked against their own retry conditions —
  **all three are correctly still deferred** (`eslint-plugin-react` still peers `^9.7`;
  `typescript-eslint` is already at latest and still refuses TS 7; `file-selector` 5 would
  un-dedupe from `react-dropzone`). That file needs no edit.

---

# 🟢 Low

### L1. Dead exports — 18 symbols referenced only by their own defining file

Each verified: `rg -w <symbol> src e2e-tests scripts -l` returns one path.

```
src/components/modals/modalRegistry.ts   hasModalComponent
src/lib/audio/cache.ts                   forceCleanup, getCacheConfig
src/lib/audio/controls.ts                getPlayingAudioKeys, preloadAudioForPage
src/lib/audio/decoder.ts                 decodeAudioBlobStreaming, decodeAudioBlobProgressive,
                                         decodeAudioFilesParallel, loadAndDecodeAudioParallel,
                                         loadAudioFilesParallel
src/lib/db.ts                            getAudioFileByName, getPageMetadata
src/lib/server/apiAuth.ts                getRequestUser, getShareToken
src/lib/server/audioRequests.ts          isAllowedContentType, isValidHash, parseAudioFields,
                                         parseJsonBody
src/lib/server/session.ts                getCurrentUser
src/lib/server/shares.ts                 getShareByLinkToken
src/lib/server/users.ts                  getUserByGoogleSub
src/lib/serverAudio/api.ts               requestOwnDownloadUrl
```

Note `parseJsonBody` is dead **while three routes re-inline what it does** — see D10. A further
~20 exports are referenced only by their own tests (`clearAudioCache`, `analyseLoudness`,
`extractPadPlaybackSettings`, `remapAudioFileIdKeys`, …); those are legitimate test seams, not
dead code, but `decoder.ts`'s five are dead in every sense and sit in the main bundle.

### L2. Two barrel files with zero importers

`src/hooks/modal/index.ts` and `src/lib/audio/strategies/index.ts` (10 and 63 lines). The other
five barrels are used.

### L3. Half the modal registry is unreachable

`ModalType.CONFIRM` and `ModalType.PROMPT` are registered but nothing references them —
`usePadInteractions.ts:242` and `page.tsx:331` render both directly as `content` instead. So the
lazy-loading indirection is bypassed for exactly the two smallest modals, and `hasModalComponent`
has never had a caller. (For `BULK_IMPORT`, `CONFLICT_RESOLUTION`, `HELP` and `LOUDNESS_OVERVIEW`
the registry earns its keep — those are 500–600 line components correctly kept out of the initial
bundle.)

### L4. Dead props and a dead hook call

- `EditPadForm.tsx:59` — `profileId` threaded through three components, unused at the end, with an
  eslint-disable to silence it.
- `TrackItem.tsx:70-71` — `totalDuration`, "kept for future use", supplied by
  `ActiveTracksPanel.tsx:110`.
- `ActiveTracksPanel.tsx:32-33` — `const {} = useTrackControls();`, an empty destructure whose only
  effect is to instantiate a hook that `TrackItem` instantiates for itself anyway.
- `Pad.tsx:18-19` — `isConfigured` and `soundCount` mean the same thing at every call site except
  the special pads, which fake it; two props that can disagree, kept in sync by a comment.

### L5. Unreachable UI

`src/app/drive/open/page.tsx:19,236-258` — `PageState` declares `{ kind: "loading" }` and renders
~22 lines of spinner markup for it, but no `setPageState` call ever produces it.

### L6. A comment describing code that was removed

`ProfileManager.tsx:294-299` — an unterminated sentence describing a render-phase error adjustment
that does not exist. `useGoogleDriveSync` does return `error`, but `ProfileManager.tsx:193-198`
destructures only the four functions, so a Drive error the hook records is never displayed there.

### L7. Two stale TODOs

`ConflictResolutionModal.tsx:317` (`// TODO: Show error to user in the modal?` — on the catch path
of the 175-line merge function, A3) and `profileStore.ts:297`.

### L8. Documentation drift

- `CLAUDE.md:219-220` ("Pinned Versions") says TypeScript **5**, Playwright **1.4x**, Prettier
  **3.8.1**. Measured: 6.0.3, 1.62.1, 3.9.6. `CLAUDE.md:132-137` ("Key package versions") has them
  right. **Two sections in one file give different answers and the authoritative-sounding one is
  wrong** — an agent reading `:219` writes TS-5-era code. Fix by deleting the package list from
  `:219-220` and leaving "Pinned Versions" to cover Node alone (the thing genuinely pinned and
  machine-checked).
- `CLAUDE.md:21-26` — all six `npm test:e2e*` commands are invalid; they need `npm run`. Only
  `npm test` works, because `test` is a built-in npm alias. `test:e2e:loudness` is undocumented.
- `README.md:52` states a Node floor of 18.x. `node:sqlite` requires ≥ 22.13, so the app cannot run
  there — a contributor gets a runtime failure in `server/db.ts`, not a version error.
- `README.md:165` links `docs/pwa-usage-guide.md`, which does not exist.
- `README.md:223` links `LICENSE`; the tracked file is `LICENCE`. 404s on GitHub.
- `README.md` omits server sync, hosted audio and loudness normalisation from Features, and Vitest
  from the tech stack — the unit suite is invisible to a new contributor.
- `.dockerignore:53` negates `.env.example`; the repo's template is `.env.dist`, so it is excluded.
- `docker-compose.yml:1` uses the obsolete `version:` key.

### L9. ~850 KB of tracked prose nothing routes a reader to

| File                                                          | Size   | Referenced by                                                                                         |
| ------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `docs/original-impamp-code.txt`                               | 627 KB | `hk.pkl:63,68` and `ci.yml:220-226` — **only as a large-file exemption**. Nothing in `src/` cites it. |
| `docs/superpowers/plans/2026-08-14-loudness-normalisation.md` | 140 KB | its own spec only; the feature shipped and is documented in `docs/loudness-normalisation.md`          |
| `docs/superpowers/specs/…-design.md`                          | 29 KB  | the plan above                                                                                        |
| `docs/refactoring-plan.md`                                    | 28 KB  | nothing — and it has a "Progress Tracking" section, so it reads as current work                       |
| `SPEC.md`                                                     | 22 KB  | nothing                                                                                               |
| `ui-design-bible.md`                                          | 8.2 KB | nothing                                                                                               |

Two separate gates carry a bespoke exemption for one file. **Needs your call — these are
deletions.**

### L10. `npm run lint` has 2 warnings

`src/lib/server/s3/client.test.ts:26` — `_input`/`_init`, a deliberate `fetch` stub signature. The
`_`-prefix convention just is not configured: set
`"@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }]`.

### L11. `fnox.toml` is gitignored

An intentional deviation (the repo has non-fnox contributors) and the reason is recorded — but it
means only one machine can resolve secrets, and the BWS key names live nowhere in version control.
`fnox.toml` contains only references, no values. Optional: commit it, or record the key names in
`.env.dist` comments.

### L12. Minor React hygiene

`renderProfileSelector` (`page.tsx:65-68`) memoises nothing — the comment states an intent the
code does not achieve · a redundant `key` inside an already-keyed component (`PadGrid.tsx:109`) ·
a stale closure in the Drive Picker effect (`ProfileManager.tsx:389-411`), safe only incidentally ·
`selectModalState` (`uiStore.ts:50-55`) returns a fresh object each call and has no consumer —
passed to `useUIStore` it would re-render forever.

---

# ✅ Verified clean — do not re-litigate

Several things were checked specifically because they were plausible risks, and they hold. Worth
recording so the next review does not spend its budget here.

**Security.** All 24 route handlers enumerated per method: every profile/share/audio route resolves
authorization from the session or link token, never from a client-supplied owner id. **No IDOR.**
Every SQL value is bound (`server/db.ts:230-249`); the only interpolation is
`PRAGMA user_version = ${version+1}` from a loop counter. **No SQL injection.** The ETag CAS **is**
atomic — `updateProfile` runs inside `transaction()`, which issues `BEGIN IMMEDIATE`, taking the
write lock before reading the version. `/api/test/session` is properly dead in production (404s
unless `IMPAMP_E2E_SIGNIN_SECRET` is set; `config/deploy.yml` never sets it). SSE listeners are
released cleanly and re-check access every 25 s. No internal errors, stack traces or SQL text leak
to clients.

**The bucket-size invariant holds.** CLAUDE.md requires quota to be charged from the size the
_bucket_ reports at commit, never the client's claim. `commit/route.ts:33,47` HEADs the object and
passes `stored.sizeBytes`. Correct.

**The gain single-source-of-truth rule holds.** An exhaustive grep for level arithmetic outside
`loudness/gain.ts` found only measurement (`query.ts`), a filter coefficient (`kWeighting.ts`), the
derived `MAX_GAIN`, and test fixtures. Both mandated consumers call `resolveGain`
(`controls.ts:380`, `overview.ts:82`). No duplicate implementation.

**The `audioGainSettings` three-places rule holds.** Both id-keyed fields are handled in all three
sites and no third such field exists — but the hash-keyed twins silently added two more places
(`byHash` / `keyByLocalId`), and `duplicateProfileLocally` is a fifth site that is currently wrong
(🔴 C2). **The rule as written in CLAUDE.md is now under-specified.**

**No IndexedDB transaction auto-close footgun.** Every transaction in `db.ts` was checked for a
non-IDB `await` between requests. There is none — the one place it was wrong is fixed and
documented at `dataAccess.ts:200-203`.

**Object URLs are clean** on every audio path — every `createObjectURL` traced to its
`revokeObjectURL`.

**Listener/timer cleanup is essentially complete.** Every `addEventListener`, `setInterval`,
`EventSource` and store `subscribe` was traced to its teardown; all present. The three exceptions
are module singletons (audio-context listeners, the cache LRU sweep) where one-per-page-life is the
right call, plus a 100 ms debounce map. What survives a profile switch and should not:
`emergencySoundsRef` (UI5), `activePlayback` (undocumented asymmetry), `syncRequestQueue` (A4).

**The recent sync review genuinely landed.** Eleven of its findings were re-verified as fixed:
new-pad deletion, partial audio-drop rescue, the per-pad translation gate,
`isPermanentAudioFailure`, conflict-after-download, `stale-server-link`, the `syncReconcile` owner
check, rollback of effect-written fields, and both dead-code items. The merge itself
(`detectProfileConflicts`) is genuinely shared between backends.

**`ProfileSyncPanel` + `useProfileSync` + `syncStatusStore` is a good refactor** — the two sync
backends were properly unified behind one hook and one panel, and `IDLE_SYNC_STATUS` is a frozen
shared reference precisely to avoid the new-object-per-selector loop. Do not undo this; D4 is about
two _leaves_ it left behind, not the trunk.

**Other things that are right and should be kept as the model:** the audio buffer cache
(`cache.ts` — byte-accurate LRU, device-memory-aware limits, reference-counted pinning so armed
tracks survive eviction — the strongest code in the repo on the performance axis) · pad hydration
is a single indexed range query, not 48 · the SSE pub/sub is O(watchers of that profile) with an
`{id, version, originId}` payload, so no per-event work scales with profile size · playback
monitoring is rAF-driven and change-gated · ZIP export/import is genuinely streaming and
memory-bounded · `usePadConfigurations` (derived `isLoading`, request-keyed results, cancellation) ·
`Pad`'s per-pad store subscription, so progress ticks re-render one pad rather than the grid ·
Shift edit-mode teardown covers all four exits and discards `event.repeat` · `Modal.tsx:36-48`
stops Escape doubling as the panic button · no client file imports `@/lib/server/**` · CI is
genuinely hardened (SHA pins, `permissions: contents: read`, `persist-credentials: false`, no
`pull_request_target`, no `secrets.*` in any workflow, zizmor + actionlint in CI _and_ pre-commit,
gitleaks over full history) · **no secret has ever been committed** — history checked, and the
regex sweep's only hits are test fixtures and AWS's own published SigV4 example key.

---

# Summary

The app is in better shape than its line counts suggest. There is no architectural rot, no
injection, no IDOR, no leaked secret, and the recent sync work genuinely landed. The test suite is
green and fast, CI is properly hardened, and several subsystems — the audio cache, the sync status
store, pad hydration, the SSE bus — are exemplary and should be left alone.

What it has instead is **duplication that has started to diverge**. Nearly every 🔴 is one rule
written twice where one copy got the fix and the other did not, and the codebase's own comments are
the evidence: the fixed copies carry careful multi-line explanations of the bug they prevent, sitting
a few files away from the copy that still has it. That is a maintenance model that works right up
until it doesn't, and C1, C2, C3 and U1 are it not working.

**Fix first, in this order:**

1. **S3 — uncomment `IMPAMP_ALLOWED_EMAILS`.** One line, but it is open signup on a public host with
   no storage quota behind it. Needs your decision on the allowed set, so it is the one item that
   cannot start without you.
2. **S1 + D1 — the wire shape.** Building `profileWire.ts` with an explicit allow-list closes the
   share-token escalation _and_ collapses the three-shapes problem that produced it. It is additive
   and pure, so it is also the safest large change available.
3. **P1 + P2 — the playback races.** ESC failing to stop a stranded track is the worst failure a
   live-performance app can have, and both are directly expressible as failing tests today against
   `controls.ts`, which currently has none. Write the tests first.

Then: R1 and R2 (one query change and one `fetchWithTimeout` helper remove a self-inflicted server
outage and the whole class of permanent-wedge failures), C4 (the keyboard going stale after a bulk
import), and S4 (`.dockerignore`, thirty seconds of work).

The **N+1 sweep** (N1–N6) is worth doing as a single change behind one
`getAudioMetadataForProfile(profileId)` helper rather than six separate fixes — it is the same
mistake six times and deserves one answer.

Leave the big structural splits — `ProfileManager`, `profileStore`, `db.ts`, `importExport.ts` —
until after the correctness work. `importExport.ts` in particular should not be split before its ZIP
and impamp2 paths have tests; that is 31 % of the file with no coverage at all.
