# Performance review — 17 August 2026

Axis: **performance, client and server**, against `main` at `b29585b` (the merge
of the 40-commit fix pass). Prior report: `plans/repo-review-2026-08-15.md`;
plan: `.claude/current_plan.md`.

Everything below was measured, not inferred. The measurement harnesses live in
the session scratchpad; the numbers and the commands that produced them are
quoted inline.

**What genuinely got fixed and stayed fixed** (re-verified, do not re-litigate):
the N1–N6 sweep — `getAudioFileMetadata` really did replace every
`for (const id of ids) await getAudioFile(id)` loop, and it is worth
**17×** (960 sequential `store.get(id)` = **460 ms**, one cursor pass =
**27.8 ms**, measured in real Chromium); `getProfileMeta` on the 304, DELETE and
both SSE paths; the prepared-statement cache; `listProfilesForUser`'s two
indexed queries; the `hashIsUsedByAnyProfile` relational index (migration 3);
`profileMayServeHash` joining the raw column; the dead `sessions_user_idx`
dropped (migration 4); `uploadProfileAudio`'s `serverHosted` short-circuit and
batched marking; `fetchWithTimeout` on all 33 outbound `fetch` sites in `src/`;
the audio buffer cache's LRU and pin accounting; the trigger path's synchronous
gain resolution (`controls.ts:388-401` — `getCachedLoudness` + `resolveGain`,
no `await` between the keypress and `playBuffer`), and the analysis cache
warmed on profile activation (`pipeline.ts:160-183`). The CLAUDE.md claim holds.

---

### 🔴 P1 — The loudness worker never loads in production; every analysis is back on the main thread

- **Class:** REGRESSION (of the fix for the previous review's 🔴 R3)
- **Where:** `src/lib/audio/loudness/analyseOffThread.ts:40-46`, and the build
  artefact `.next/static/media/analyse.worker.0yaju8ywz9_dc.ts`

**Finding.** Phase 8 moved `analyseLoudness` into a Web Worker:

```ts
worker = new Worker(new URL("./analyse.worker.ts", import.meta.url), {
  type: "module",
});
```

Turbopack does not treat that as a worker entry. It copies the **raw,
untranspiled TypeScript source** into `static/media/` and hands the client its
URL. From the built chunk (`.next/static/chunks/1sxy2g326v38a.js`):

```js
(85992,
  (e) => {
    e.q("/_next/static/media/analyse.worker.0yaju8ywz9_dc.ts");
  });
```

and the emitted file is literally the source, TS syntax and all:

```ts
import { analyseLoudness } from "./analyse";
export interface AnalyseRequest { id: number; channels: Float32Array[]; … }
self.onmessage = (event: MessageEvent<AnalyseRequest>) => { … }
```

Verified against the real production build (`npm run build`, then
`PORT=3457 node scripts/start-standalone.js`), driven from Chromium via
Playwright:

```json
{
  "contentType": "video/mp2t",
  "workerStarted": false,
  "workerError": "onerror: (no message)"
}
```

`content-type: video/mp2t` is Node's MIME mapping for `.ts`, and the response
also carries `X-Content-Type-Options: nosniff`, so the browser refuses to
execute it as a module script. (Even served correctly it would fail twice more:
the extensionless `import "./analyse"` is unresolvable in a browser, and
`export interface` is a syntax error.)

`onerror` fires, so `analyseOffThread.ts:57-67` sets `workerUnavailable = true`,
terminates the worker, and rejects every pending request — and
`analyseAudioBufferOffThread`'s `catch` at `:101-110` re-reads the channels and
calls `analyseLoudness` **on the main thread**, for the rest of the session.
The fallback is correct; it is also the thing R3 existed to remove.

**Magnitude.** The dominant stage, `computeHopTruePeak` (36 multiply-accumulates
per sample per channel — `truePeak.ts:103-121`, and its own comment says it is
"93% of the cost"), measured in Chromium on the real source:

| audio (stereo 48 kHz) | `computeHopTruePeak` |
| --------------------- | -------------------- |
| 30 s                  | **271 ms**           |
| 5 min                 | **2 396 ms**         |

That is an unbroken main-thread block — no paint, no input, and the Web Audio
render quantum can under-run, so a sound already playing glitches. The phase-8
sliding-sum change is real and did help the block loop; it did not touch this
loop, and this loop is where the time is.

**Impact.** Every file added still freezes the tab: ~0.3 s for a 30-second
sound, ~2.5 s for a five-minute one. Bulk-importing a 300-sound library is
minutes of an unresponsive tab, exactly as before the fix. It only reproduces in
a production build (the dev server serves the worker through its own transform),
which is why it survived the phase-8 verification.

**Fix.** Give Turbopack a worker entry it recognises, and **assert it**:

1. Point `new Worker` at a real emitted chunk. The reliable route with
   Turbopack/Next 16 is a `.js`/`.mjs` worker file under `public/` (or a
   `webpack`/`turbopack` `asset/resource` rule), loaded as
   `new Worker("/loudness.worker.js", { type: "module" })`, with the analysis
   code imported from a chunk the build emits.
2. Make the silent fallback loud: `analyseOffThread` currently downgrades to the
   main thread with no signal at all. `console.warn` at minimum, and an
   `exposeE2EHook` reporting `workerUnavailable`.
3. Add a Playwright test that opens the built app and asserts the hook says the
   worker is alive. A unit test cannot catch this — the defect is in the build
   output, not the source.

---

### 🟡 P2 — Both audio downloaders do one IndexedDB transaction per remote reference: 437 ms per pass, up to six passes per sync

- **Class:** NEW (the N1–N6 sweep replaced id-keyed loops; these are hash-keyed and were missed)
- **Where:** `src/lib/googleDrive/sync.ts:329-331` and
  `src/lib/serverAudio/transfer.ts:270`, both called from
  `src/lib/serverSync/sync.ts:311-335` — **inside** the `MAX_PUSH_ATTEMPTS`
  loop at `:294`

```ts
// googleDrive/sync.ts:329
let existingFile = ref.hash ? await getAudioFileByHash(ref.hash) : undefined;

// serverAudio/transfer.ts:270
for (const ref of hostedRefs) {
  if (await getAudioFileByHash(ref.hash)) continue;
```

`getAudioFileByHash` (`db.ts:714-722`) opens its **own** read-only transaction
and does `index("hash").getAll(hash)` — one transaction per reference,
sequentially, to answer "do I already have this?".

**Magnitude**, measured in real Chromium against a store of 960 records each
carrying a 200 KB blob:

| pattern                                       | 960 refs     |
| --------------------------------------------- | ------------ |
| per-hash transaction + `index.getAll` (today) | **436.8 ms** |
| one `index("hash").getAllKeys()`              | **4.7 ms**   |

93× more expensive than the one-pass equivalent. Both downloaders run on every
sync, so that is **~874 ms** per attempt, and both sit inside the retry loop, so
up to **~2.6 s** on a contended push. On top of that the same sync makes ~6
full-store cursor passes (`getAudioFileMetadata` from `uploadMissingAudioFiles`,
`uploadProfileAudio`, `getLocalProfileSyncData` per attempt, and
`loadProfileLoudness` twice plus `findUnanalysedAudioFileIds` in
`refreshProfileLoudness`) at 27.8 ms each ≈ 167 ms. Call it **~1 s of
serialised IndexedDB traffic per sync** on a 960-sound board.

**Impact.** Sync runs on load, every 15 minutes, on reconnect, on every SSE
event and 10 seconds after every edit. During a collaborative editing session
that is a second of queued IndexedDB work, repeatedly — and it queues **ahead of
the playback path**, which reads the same object store
(`controls.ts:474`, `const audioFileData = await getAudioFile(audioFileId)`) for
any pad whose buffer is not cached. A pad pressed mid-sync waits behind it.

**Fix.** One index pass per call instead of one transaction per reference:

```ts
const localHashes = new Set(
  await (await getDb()).getAllKeysFromIndex("audioFiles", "hash"),
);
```

then `localHashes.has(ref.hash)` in the loop, reading the full record only for
the references that miss. Both call sites want the same helper — put it in
`db.ts` next to `getAudioFileMetadata`, which is the same shape of fix.

---

### 🟡 P3 — `@hello-pangea/dnd` is still 92 KB of the first-load bundle for a component only reachable inside a modal

- **Class:** RECURRENCE (previous review's 🟡 P8; never assigned to a plan phase)
- **Where:** `src/hooks/pad/usePadInteractions.ts:20` →
  `src/components/modals/EditPadModalContent.tsx:11` →
  `src/components/modals/EditPadForm.tsx`, reached from
  `src/components/PadGrid.tsx:16,181`

```ts
// usePadInteractions.ts:20 — a static import, so it is in the page's graph
import EditPadModalContent, {
  createPadEditSession,
} from "@/components/modals/EditPadModalContent";
```

**Magnitude.** Measured against the current build. `/`'s prerendered HTML
(`.next/server/app/index.html`) carries 17 `<script async>` chunks totalling
**1 070 KB raw / 323 KB gzipped**. One of them is dnd:

```
.next/static/chunks/14aaxfv489-j_.js   91.9 KB raw / 28 KB gzip
  droppableId: 54  isDropDisabled: 10  onDragEnd: 6  combineTargetFor: 4
```

and it is a `<script async>` on the initial document, not a lazy chunk:

```html
<script
  src="/_next/static/chunks/14aaxfv489-j_.js"
  async=""
  crossorigin=""
></script>
```

That is **~9% of the gzipped first-load payload** for a drag-and-drop library
that can only be exercised after the user opens the edit-pad modal.

**Impact.** ~28 KB gzip downloaded, and ~92 KB parsed and compiled, on every
cold load — including the first paint of a live show — for a code path most
sessions never take.

**Fix.** `EditPadModalContent` is the only modal of its size that is _not_ in
`src/components/modals/modalRegistry.ts`, which already `lazy()`-loads four
others. Move it there (or wrap it in `React.lazy` at the `usePadInteractions`
call site) so it lands in its own chunk. This is not the `next/dynamic`
experiment the repo already measured and rejected for `ProfileManager` — it is
the `React.lazy` pattern this file already uses for `BULK_IMPORT`,
`CONFLICT_RESOLUTION`, `HELP` and `LOUDNESS_OVERVIEW`, and `BulkImportModalContent`
imports dnd too yet stays out of the first-load graph precisely because it is
registered there.

---

### 🟡 P4 — A profile PUT reads the whole blob three times, two of them under `BEGIN IMMEDIATE`

- **Class:** NEW (R5 gave the 304, DELETE and SSE paths `getProfileMeta`; PUT was not in the list)
- **Where:** `src/app/api/profiles/[id]/route.ts:69` and
  `src/lib/server/profiles.ts:132,153`

The route loads the full row purely to read `.access`, and never touches
`loaded.profile`:

```ts
// route.ts:69
const loaded = loadAuthorizedProfile(request, id);   // SELECT * — blob read, discarded
if (!canWrite(loaded.access)) { … }
```

`updateProfile` then reads it twice more, inside the write transaction:

```ts
// profiles.ts:132  — only `current.version` is needed on the success path
const current = getProfileById(id);
…
// profiles.ts:153  — only id/name/version/updated_at are ever read from this
return { status: "ok" as const, profile: getProfileById(id)! };
```

`reindexProfileAudio` (`profiles.ts:76-85`) additionally does
`DELETE` + one `INSERT` per hash on **every** write, whether or not the audio
set changed — which for a rename or a pad move it never has.

**Magnitude**, measured with `node:sqlite` on realistic blobs (bench script in
the scratchpad; WAL + `synchronous = NORMAL`, warmed prepared statements):

| profile              | `SELECT *` | `SELECT` meta | reindex (D+N INSERT) | reindex (diff, unchanged) | whole PUT txn as coded |
| -------------------- | ---------- | ------------- | -------------------- | ------------------------- | ---------------------- |
| 500 sounds (0.60 MB) | 0.57 ms    | 0.010 ms      | 1.35 ms              | 0.43 ms                   | 5.3 ms                 |
| 960 sounds (1.16 MB) | 1.31 ms    | 0.016 ms      | 2.12 ms              | 0.70 ms                   | 8.7 ms                 |
| at the 8 MB cap      | 4.56 ms    | 1.08 ms       | 13.8 ms              | 3.96 ms                   | 49.5 ms                |

So ~6 ms of avoidable synchronous work per PUT at a realistic 960 sounds, and
~24 ms at the `MAX_PROFILE_BODY_BYTES` cap — on the single thread that also
serves every other request, every SSE heartbeat and `/up`. Two of the three
reads and the whole reindex hold the global write lock while they run, which is
what `profileRequests.ts:88-89` ("small enough that one request cannot occupy
the single instance") is asserting is not the case.

**Impact.** Not visible at today's scale; it is the same failure mode R1 and R5
were about, on the one path that was missed, and it grows with both profile size
and user count.

**Fix.** Three one-liners: `loadAuthorizedProfileMeta` in `PUT` (the blob is
never used); `getProfileMeta` for the version check in `updateProfile`, reading
the full row only on the `conflict` branch that actually returns it;
`getProfileMeta` for the success return value. Then make `reindexProfileAudio`
compare the new hash set against `SELECT hash FROM profile_audio WHERE
profile_id = ?` and write nothing when they match — the common case.

---

### 🟡 P5 — Every SSE connect and reconnect triggers a full pull/merge/push

- **Class:** RECURRENCE (previous review's 🟡 P7; never assigned to a plan phase)
- **Where:** `src/app/api/profiles/[id]/events/route.ts:93-103` vs
  `src/hooks/useServerSync.ts:56-64` and
  `src/components/ClientSideInitializer.tsx:420-430`

The greeting the server sends on connect carries no `originId`:

```ts
// events/route.ts — the connect greeting
send(`event: change\ndata: ${JSON.stringify({ profileId: id, version: … })}\n\n`);
```

so the client's own-echo filter cannot suppress it:

```ts
// useServerSync.ts:63
if (change.originId === ORIGIN_ID) return; // never true for a greeting
onChange(change.version);
```

and the handler does not compare the announced version with the one it already
holds — it just syncs:

```ts
// ClientSideInitializer.tsx:423-428
(version) => { … void syncServerProfile(profileId); }
```

There is also no `retry:` hint on the stream, and `MAX_STREAM_MS = 30 * 60_000`
(`events/route.ts:30`) has no jitter.

**Magnitude.** Per server-synced profile per tab: one extra full sync at page
load (on top of `syncAllEligibleProfiles`, `ClientSideInitializer.tsx:296-300` —
`inFlight` coalesces them only if they overlap), and one every 30 minutes
thereafter, forever. Each of those is the whole cycle in P2 and P6: ~1 s of
IndexedDB traffic and a ~29 ms merge at 960 pads on the client, and a
GET (up to the full blob) plus a PUT on the server. Because the lifetime is a
fixed 30 minutes from connect with no jitter, every client that connected
together — i.e. everyone, after a deploy or restart — reconnects together and
issues its full sync in the same second, against a single-instance,
single-threaded server.

**Impact.** Doubled sync load at steady state, and a synchronised spike every 30
minutes after each restart.

**Fix.** Three independent, small changes: (1) put `originId` in the greeting
(the server does not know it, so send the client's `ORIGIN_ID` as a query
parameter on the `EventSource` URL and echo it back — or simply mark the
greeting `{ greeting: true }` and let the client compare); (2) have the
`onChange` handler skip the sync when `version <= profile.serverVersion`;
(3) jitter `MAX_STREAM_MS` by ±10% per connection and emit a `retry:` line.

---

### 🟢 P6 — The sync merge costs 29 ms per 960-pad board — and the previously proposed fix makes it _worse_

- **Class:** RECURRENCE, with a correction
- **Where:** `src/lib/syncUtils.ts:31-39` (`deepClone`), `:100`, `:148`

```ts
export const deepClone = <T>(obj: T): T => { … JSON.parse(JSON.stringify(obj)) … };
…
const mergedItem = deepClone(localItem);                                       // :100, per item
const valuesDiffer = JSON.stringify(localVal) !== JSON.stringify(remoteVal);   // :148, per field
```

**Magnitude.** Measured by calling the real `detectProfileConflicts` from a
throwaway vitest file (since deleted), with realistic pads (8 tracked fields,
hash twins, trim/gain maps), minus fixture-construction cost:

| pads          | `detectProfileConflicts` |
| ------------- | ------------------------ |
| 96 (one bank) | 1.7 ms                   |
| 500           | 13.3 ms                  |
| 960           | **28.8 ms**              |

Runs once per push attempt, so up to ~86 ms on a contended push, synchronously
on the main thread.

**The correction matters more than the finding.** The previous review prescribed
"`structuredClone` plus a `===` short-circuit". I applied exactly that
(`structuredClone(obj)` at `:33`, `localVal === remoteVal ? false : …` at
`:148`), re-ran the same benchmark, and reverted:

| pads | today        | with the prescribed fix |
| ---- | ------------ | ----------------------- |
| 96   | 1.70 ms      | 2.41 ms                 |
| 500  | 13.26 ms     | 16.36 ms                |
| 960  | **28.82 ms** | **34.12 ms**            |

`structuredClone` is ~18% _slower_ than the JSON round-trip here, and the `===`
short-circuit does not pay for itself. **Do not apply the P1 fix from the 15
August report.** If this is worth attacking at all, the lever is a structural
comparison that avoids materialising two JSON strings per field (a typed
`fieldsEqual` over the known pad shape), not a different clone primitive — and
at 29 ms it is a 🟢, not urgent.

---

### 🟢 P7 — `public/sw.js` is never registered, so the PWA caches nothing

- **Class:** NEW (and it retires one of the previous review's R2 recommendations)
- **Where:** `public/sw.js` (152 lines), `public/offline.html`;
  `rg -n "serviceWorker" src/ --glob '!*.test.*'` → **zero matches**

Verified in Chromium against the running production build:
`navigator.serviceWorker.getRegistration()` → `undefined`,
`navigator.serviceWorker.controller` → `null`, `caches.keys()` → `[]`.

So the network-first handler at `sw.js:105-138` — which the previous review's R2
flagged for having no timeout, and which would additionally `cache.put` every
successful GET including `/api/profiles/:id` blobs and the never-ending
`/api/profiles/:id/events` stream — never runs. That is a mercy, but it also
means the app gets **no** offline behaviour and no repeat-visit caching beyond
what HTTP `Cache-Control: immutable` already gives the `_next/static` assets.

**Impact.** Nothing is slower than it should be; something advertised (CLAUDE.md
"PWA Support — Service worker, manifest, offline capabilities") is absent, and
R2's "service-worker timeout" item can be closed as not-applicable.

**Fix.** Decide, then do one of them: register it (and _first_ fix the
network-first branch — exclude `/api/**`, add an `AbortSignal.timeout`, and
never `cache.put` a `text/event-stream`), or delete `sw.js`/`offline.html` and
the PWA claim.

---

### 🟢 P8 — 302 `console.log` call sites ship in the client bundle

- **Class:** DEFERRED
- **Where:** `next.config.ts` has no `compiler.removeConsole`;
  `cat .next/static/chunks/*.js | grep -o "console\.log" | wc -l` → **302**

Densest on the paths that matter: `useKeyboardListener.ts` (49 sites, on the
keydown path), `db.ts` (37), `controls.ts` (24, ~2 per pad trigger),
`playback.ts` (15), `cache.ts` (8, one per buffer stored with a `toFixed`
template).

**Magnitude.** With devtools closed this is a few microseconds per call — real
but negligible (~20 µs per pad trigger). With devtools open, which is where an
operator debugging a show will be, each call is one to two orders of magnitude
more expensive, and the template strings are built either way.

**Fix.** `compiler: { removeConsole: { exclude: ["error", "warn"] } }` in
`next.config.ts`. One line, no source changes, and it also removes the strings
themselves from the bundle.

---

## Checked and clean

- **Trigger path.** `triggerAudioForPadInstant` reaches `playBuffer` through one
  `await` (`ensureAudioContextActive`, which returns an already-resolved promise
  when the context is running — `context.ts:87`). Gain is resolved synchronously
  from the in-memory cache; the cache is warmed by `loadProfileLoudness` on
  profile activation and after every sync. `exposeE2EHook` compiles out of a
  real production build (`testHooks.ts:18-20`).
- **Audio buffer cache.** LRU with a device-memory-aware cap, reference-counted
  pins, correct memory accounting on replace and on failed decodes. No leak.
- **Loudness cache.** Replaced wholesale per profile, ~80 bytes per second of
  audio; no eviction needed and none missing.
- **Preloader.** Bounded queue, priority chunks of 12, idle-gated at LOW
  priority. `preloadAllConfiguredFiles` — the one unbounded entry point — has no
  callers.
- **Re-render behaviour.** The rAF playback loop gates its store write on a
  threshold comparison, and `usePadPlaybackState` selects one track's slice.
  Only `ActiveTracksPanel` subscribes to the whole map, which is what it renders.
- **Server query shapes.** No N+1 left in `src/lib/server/`. Statement cache
  covers every query; every hot lookup is indexed; the SSE heartbeat re-authorises
  through `getProfileMeta` and `resolveAccess`, both index seeks.
- **`busy_timeout = 5000`** (`server/db.ts:253`) cannot fire: `node:sqlite` is
  synchronous and the app holds one connection, so there is never a second
  writer to wait for. The previous review's P13 is a non-issue.
