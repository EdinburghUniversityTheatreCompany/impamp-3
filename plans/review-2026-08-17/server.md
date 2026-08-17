# Server layer and its security — review of 2026-08-17

Axis: `src/lib/server/`, every route under `src/app/api/`, middleware, the Drive
proxy, and the deployment surface (`Dockerfile`, `.dockerignore`,
`config/deploy.yml`). Reviewed at `b29585b`, against the code as it now stands.

Explicitly **not** reported, per the review brief: `IMPAMP_ALLOWED_EMAILS` being
commented out in `config/deploy.yml`. That is the owner's open decision.

## Method

There is no `middleware.ts` anywhere in the repo (`fd -g '*middleware*' -H`:
no matches) and no server actions (`rg "'use server'" src`: no matches), so
every server entry point is a route handler. All 24 of them were enumerated
and each checked individually:

| Route                               | Method | Who gets in                                                            |
| ----------------------------------- | ------ | ---------------------------------------------------------------------- |
| `/up`                               | GET    | nobody checked — deliberate (see SV11)                                 |
| `/api/auth/google/exchange`         | POST   | **unauthenticated**, spends `GOOGLE_CLIENT_SECRET`                     |
| `/api/auth/google/refresh`          | POST   | **unauthenticated**, spends `GOOGLE_CLIENT_SECRET`                     |
| `/api/auth/session`                 | GET    | session cookie                                                         |
| `/api/auth/session`                 | DELETE | none needed (destroys the presented token)                             |
| `/api/profiles`                     | GET    | `requireUser`                                                          |
| `/api/profiles`                     | POST   | `requireUser` — no quota (SV9)                                         |
| `/api/profiles/:id`                 | GET    | `resolveAccess` ≥ viewer, incl. **anonymous** link token               |
| `/api/profiles/:id`                 | PUT    | `canWrite` — incl. **anonymous** editor link token (SV2)               |
| `/api/profiles/:id`                 | DELETE | owner only ✅                                                          |
| `/api/profiles/:id/events`          | GET    | `resolveAccess` ≥ viewer, re-checked each heartbeat ✅                 |
| `/api/profiles/:id/shares`          | GET    | owner only ✅                                                          |
| `/api/profiles/:id/shares`          | POST   | owner only ✅                                                          |
| `/api/profiles/:id/shares/:shareId` | DELETE | owner only, and scoped by `profile_id` ✅                              |
| `/api/profiles/:id/audio/:hash`     | GET    | profile access **+** blob names hash **+** `profileMayServeHash` (SV4) |
| `/api/audio`                        | GET    | `requireUser`                                                          |
| `/api/audio/upload-url`             | POST   | `requireUser` + `can_upload_audio`                                     |
| `/api/audio/commit`                 | POST   | `requireUser` + `can_upload_audio` + proof of possession (SV1)         |
| `/api/audio/:hash`                  | GET    | `requireUser` + holds a reference ✅                                   |
| `/api/audio/:hash`                  | DELETE | `requireUser` + holds a reference (SV3)                                |
| `/api/admin/audio`                  | GET    | `requireUser` + `is_admin`, 404 for others ✅                          |
| `/api/admin/users/:id`              | PATCH  | `requireUser` + `is_admin`, 404 for others ✅                          |
| `/api/drive/public-file`            | GET    | header gate only (SV6)                                                 |
| `/api/drive/public-audio`           | GET    | header gate only (SV6)                                                 |
| `/api/test/session`                 | POST   | `IMPAMP_E2E_SIGNIN_SECRET`, 404 when unset ✅                          |

Findings below marked "proved" were reproduced with a throwaway vitest suite
driving the real route handlers against `:memory:` and the in-memory object
store (kept in the scratchpad, not committed; the pattern is
`src/app/api/audio/audio.api.test.ts`). Console output from that run is quoted
verbatim.

**Verified clean, and worth not re-checking next time:** no SQL is built by
concatenation anywhere in `src/lib/server` — every statement is a static
literal with `?` placeholders through `queryOne`/`queryAll`/`execute`
(`db.ts:302-315`), and the one interpolation, `PRAGMA user_version = ${version + 1}`
(`db.ts:223`), interpolates a loop counter. `MIGRATIONS` is genuinely
append-only, with migration 1's now-pointless index dropped by an appended
migration 4 rather than by editing it (`db.ts:191-202`) — the right call, and
migration 3 has a real upgrade-from-populated-database test. No IDOR in the
profile or share routes: `deleteShare` is scoped by `profile_id`
(`shares.ts:97`), a link token only grants the profile it was minted for
(`shares.ts:148`), and "no access" and "does not exist" both answer 404
(`apiAuth.ts:51-53`). Session tokens are 32 random bytes stored only as a
SHA-256 (`session.ts:16-38`). The old review's **SV4** is fixed — the presigned
download TTL is 5 minutes, not an hour (`s3/config.ts:74-81`) — and its **SV2**
is fixed: an email takeover no longer inherits `is_admin` (`users.ts:89-98`).

---

### 🔴 SV1 — Nothing checks that uploaded bytes hash to the hash they were stored under

- **Class:** NEW
- **Where:** `src/app/api/audio/commit/route.ts:37-73`, `src/lib/server/audio.ts:311-348`, `src/lib/server/proofOfPossession.ts:20-33`
- **Finding:** The bucket is content-addressed — the key _is_ the SHA-256
  (`s3/client.ts:56-60`) — but no code path ever hashes the object. Commit does
  a `head` for existence and, when an object row already exists, a proof of
  possession. A **first** uploader is asked for neither:

  ```ts
  // commit/route.ts:57-60
  if (
    getAudioObject(fields.hash) &&
    !userHoldsReference(user.id, fields.hash)
  ) {
  ```

  With no `audio_objects` row yet, that condition is false, the proof block is
  skipped, and `recordUpload` writes the row keyed on `fields.hash` — a value
  that came from the request body and was only ever checked against
  `/^[0-9a-f]{64}$/` (`audioRequests.ts:53-55`). So an account with
  `can_upload_audio` may PUT any bytes at all under any digest it likes.

  Worse, this inverts the control `proofOfPossession.ts` exists to provide.
  That module tests the caller against _the bucket's copy_ — "the secret being
  tested is the content" (`:30-32`). Poison the copy and the poisoner becomes
  the only party who can prove possession; everyone who actually holds the real
  file is refused.

  Proved end to end. Attacker uploads junk under the hash of a file they do not
  have; the real holder then tries to host that file:

  ```
  PROBE C poison commit: 200 { hash: 'd30218…', sizeBytes: 2048, usage: {...} }
  PROBE C victim: 403 {
    error: 'That sound is already stored. Send the proof from the upload-url response to claim it.'
  }
  ```

- **Impact:** An approved uploader can (a) substitute their own audio for any
  hash, so every profile that names it — anyone's board, including boards they
  have no access to — plays the attacker's sound instead, and (b) permanently
  deny hosting of any file whose hash they can guess or observe (hashes travel
  in every profile blob a viewer can read). The corruption is not recoverable
  through the API: there is no admin object-delete route, and if the attacker
  also names the hash in a profile of their own, even their own
  `DELETE /api/audio/:hash` is refused (see SV3). `Content-Type` is pinned on
  the presigned download (`s3/client.ts:99-101`), so this is a content-integrity
  and denial problem, not XSS.
- **Fix:** Verify the digest on the _first_ commit, before `recordUpload`.
  `ObjectStore.getRange` already exists; stream the object in chunks through
  `createHash("sha256")` and compare with `fields.hash`, deleting the key and
  answering 422 on mismatch. Bounded by `maxObjectBytes` (100 MB by default),
  and it runs once per distinct object ever, not per commit. Until then the
  bucket's central invariant — key implies contents — is unenforced.

### 🔴 SV2 — A profile write buffers the entire request body before any size check, and an anonymous link-share editor can send one

- **Class:** NEW
- **Where:** `src/lib/server/profileRequests.ts:93-122`, `src/app/api/profiles/[id]/route.ts:65-93`
- **Finding:** `parseProfileBody` checks `content-length` first and the real
  size afterwards:

  ```ts
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROFILE_BODY_BYTES) { … 413 }

  let body: { name?: unknown; data?: unknown };
  try {
    body = await request.json();
  } catch { … }
  ```

  A chunked request carries no `content-length`; `Number(null ?? "")` is `0`,
  which is finite and under the cap, so the guard passes. `request.json()` then
  buffers and parses the whole thing with no ceiling — Next 16 App Router route
  handlers have no body-size limit (the old `api.bodyParser.sizeLimit` was
  Pages-only, and `next.config.ts` sets nothing).

  Proved: 64 MiB of chunked body, no `content-length`, fully read and parsed
  before the refusal.

  ```
  PROBE G delivered MiB: 64  heap delta MiB: 128.0  status: 413
  ```

  The reach matters as much as the mechanism. `PUT /api/profiles/:id` resolves
  access before parsing, and `resolveAccess` grants `editor` from a bare link
  token with no session at all (`shares.ts:145-151`). The order in the handler
  is `canWrite` → `parseVersionHeader` → `parseProfileBody` → `updateProfile`,
  so the body is buffered before the `If-Match` version is ever compared with
  the database — the request need not write anything to cost the memory.

- **Impact:** Anyone holding an editor share link — a string that gets pasted
  into group chats — can send a multi-gigabyte chunked body and OOM the process.
  This app is documented and deployed as a **single instance** with a
  synchronous SQLite layer (`config/deploy.yml:9-18`), so that is the whole
  service, plus the SSE bus, plus every other user's in-flight write. Repeatable
  at will, and nothing rate-limits it (SV8).
- **Fix:** Read the body through a counting stream and abort past
  `MAX_PROFILE_BODY_BYTES` instead of `await request.json()` — e.g. consume
  `request.body` with a reader, sum `byteLength`, bail on overflow, and
  `JSON.parse` the accumulated text. Also treat a missing `content-length` as a
  reason for the streaming path rather than as `0`. While there, note the cap is
  compared against `serialisedData.length` (`:117`), which is UTF-16 code units,
  so an emoji-laden profile may legitimately be ~2–3× the intended byte ceiling.

### 🟡 SV3 — A stranger's profile permanently pins your hosted audio, and your quota with it

- **Class:** NEW
- **Where:** `src/app/api/audio/[hash]/route.ts:71-79`, `src/lib/server/audio.ts:212-219`, `src/lib/server/profiles.ts:76-85`
- **Finding:** `DELETE /api/audio/:hash` refuses while _any_ profile in the
  deployment names the hash:

  ```ts
  // [hash]/route.ts:71
  if (hashIsUsedByAnyProfile(hash)) {
    return NextResponse.json(
      { error: "That sound is still used by a profile. …" },
      { status: 409 },
    );
  }
  ```

  and `hashIsUsedByAnyProfile` is `SELECT 1 FROM profile_audio WHERE hash = ?`
  with no owner scope. `profile_audio` is rebuilt from whatever a writer puts in
  `data` (`profiles.ts:58-85`), and `POST /api/profiles` accepts an arbitrary
  blob from any signed-in account. So naming someone else's hash in a profile of
  your own is enough.

  Proved: user A hosts a sound, user B (not approved for audio, no relationship
  to A) creates a profile listing A's hash, A's own delete is then refused.

  ```
  PROBE B delete status: 409 {
    error: 'That sound is still used by a profile. Remove it from the profile first.'
  }
  ```

- **Impact:** Any account can permanently freeze another account's storage
  allowance and stop them removing their own file, with no way for the victim to
  see who did it or to clear it — the squatting profile is invisible to them.
  Combined with SV1 it also makes a poisoned object undeletable.
- **Fix:** Scope the check to profiles the _holder_ can actually reach:
  `profile_audio JOIN profiles p … WHERE p.owner_id = ? OR p.id IN (<profiles
shared with this user>)`. The guard exists so an owner does not silence their
  own live board; a third party's board is not that.

### 🟡 SV4 — `profileMayServeHash` cannot see link-share editors, so audio they upload is unreachable — and revoking a share silences the owner's own board

- **Class:** NEW
- **Where:** `src/lib/server/audio.ts:153-183`
- **Finding:** The "could this sound legitimately be on this profile" check
  admits the owner, or a _current email-share editor_:

  ```sql
  r.user_id = ?
  OR r.user_id IN (
    SELECT u.id FROM users u
      JOIN profile_shares s ON s.email = u.email
     WHERE s.profile_id = ? AND s.role = 'editor'
  )
  ```

  A link share has `email IS NULL` by schema constraint (`db.ts:123`), so it
  never joins — even though the UI mints editor links
  (`ServerSharingPanel.tsx:214-231`, "Can edit"). And the subquery reads the
  _live_ share table, so deleting or demoting a share retroactively withdraws
  access to audio that collaborator uploaded.

  Both proved:

  ```
  PROBE A owner status: 404 { error: 'Not found' }      # link-share editor's upload
  PROBE A email-share status: 200                        # same flow, email share
  PROBE E before revoke: 200
  PROBE E after revoke: 404 { error: 'Not found' }
  ```

- **Impact:** Two silent data-availability failures on a live feature. A sound
  added by a link-share editor is 404 for _everyone including the profile
  owner_, immediately and forever. And a board that worked yesterday goes silent
  on exactly the pads a departed collaborator contributed, the moment their
  share is revoked — the owner's own profile, sounds they can see listed but
  cannot play, with no error explaining it.
- **Fix:** Record the grant at the time the sound is attached rather than
  re-deriving it from live shares. A `profile_audio` row already exists per
  (profile, hash) — give it the `user_id` of the writer who introduced it, and
  have `profileMayServeHash` accept "a reference is held by anyone who has ever
  been able to publish to this profile", or simply by the writer recorded on the
  row. Whatever the shape, it must cover link-share editors, and it must not
  revoke the owner's access to a sound already on their board.

### 🟡 SV5 — The server stores and re-serves the profile blob verbatim, so the share-token fix is client-side only

- **Class:** RECURRENCE (of 🔴 S1 — closed in the client serialisers, not on the wire)
- **Where:** `src/lib/server/profileRequests.ts:107-137`, `src/app/api/profiles/[id]/route.ts:54-62`
- **Finding:** S1 was fixed by introducing `src/lib/profileWire.ts` and routing
  the two _client_ serialisers through its allow-list. The server validates only
  that `data` is an object and under the size cap; it then stores the string and
  splices it back into the GET response for anyone with viewer access:

  ```ts
  const body = `{"id":…,"access":${JSON.stringify(access)},"data":${profile.data}}`;
  ```

  Proved — a blob containing `serverShareToken` is handed straight back to an
  anonymous viewer holding a view-only link:

  ```
  PROBE F viewer sees: 200 {"serverShareToken":"SECRET-BEARER","audioFiles":[]}
  ```

- **Impact:** The viewer→editor escalation S1 describes is closed only for
  clients running the new code. This is a PWA with a service worker; an
  installed tab pinned to a pre-fix bundle keeps pushing the token inside every
  blob it writes, and the server keeps serving it to viewers. Nothing on the
  server would notice or stop it, and nothing scrubs blobs already stored.
- **Fix:** Apply the allow-list on ingress too — strip unknown/credential
  fields in `parseProfileBody` using the same `profileWire.ts` key set, so the
  rule lives in one place and is enforced where it is actually load-bearing. A
  one-off `UPDATE` to strip `serverShareToken` from stored blobs is worth doing
  at the same time.

### 🟡 SV6 — The Drive proxies' new same-origin gate is one `curl -H Referer` away, and its own test says so

- **Class:** RECURRENCE (old 🟡 SV3, claimed fixed)
- **Where:** `src/app/api/drive/proxyUtils.ts:56-69`, `src/lib/server/serverHardening.test.ts:100-107`
- **Finding:** The gate prefers `Sec-Fetch-Site` and falls back to
  Origin/Referer:

  ```ts
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";

  const source =
    request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return false;
  ```

  The comment above it argues that `Sec-Fetch-Site` "cannot be set by page
  script, so a caller that wants to claim same-origin has to actually be
  same-origin". True of a browser; irrelevant to a non-browser client, which
  simply omits it. The fallback then accepts a forged `Referer` — and the fix's
  own test pins that behaviour:

  ```ts
  it("falls back to Referer for clients that send no Sec-Fetch-Site", () => {
    expect(isSameHostRequest(proxyRequest({ referer: "https://impamp.test/app" }))).toBe(true);
  ```

  What changed is that the _no-header-at-all_ case is now refused. That raises
  the bar from zero flags to one.

- **Impact:** `GET /api/drive/public-audio?id=<any world-readable Drive file>`
  remains an unauthenticated, unrate-limited 100 MB proxy spending the
  deployment's bandwidth and `GOOGLE_API_KEY` quota, for anyone willing to send
  a header. `public-file` is the same for ≤10 MB of JSON.
- **Fix:** The header gate cannot be made to hold — it is a CSRF control being
  asked to do authentication. Either require a session (or a share token) on
  these routes, or put a real budget on them: per-IP rate limit plus a global
  concurrent-transfer cap. Rewriting the comment to say what the gate actually
  buys ("stops a cross-origin page, not a script") would also stop the next
  reader over-trusting it.

### 🟡 SV7 — Nothing ever sweeps bucket objects that were never committed

- **Class:** RECURRENCE — old 🟡 SV1. `.claude/current_plan.md` phase 6.4 bundles
  it with SV2/SV3/SV4; those three shipped, this one did not, and the plan's
  closing summary nevertheless says "everything with a behavioural consequence
  is fixed".
- **Where:** `src/app/api/audio/upload-url/route.ts:52-61`, `src/lib/server/s3/client.ts:26-50`
- **Finding:** `upload-url` mints a presigned PUT and returns. The presign signs
  only `host` (`s3/client.ts:83-93`), so the URL constrains neither size nor
  content, and `sizeBytes` is only the client's claim. If the browser PUTs and
  never calls commit, no `audio_objects` row is written, so no accounting exists
  and nothing will ever look at that key again: `ObjectStore` has no `list`
  operation (`s3/client.ts:26-50`) and there is no scheduled job anywhere in the
  repo. `rg 'sweep|list' src/lib/server/s3` finds nothing of the sort.

  The other half of the original finding _is_ fixed: a caller can no longer
  obtain an upload URL for a hash that already has an object row — `canUpload`
  returns `alreadyStored: existing !== undefined` on every path
  (`audio.ts:266-302`), and `upload-url` hands out a URL only when that is false.
  So the "oversized overwrite kept on refusal" branch is now unreachable.

- **Impact:** An approved account can park unbounded bytes in the bucket that
  no quota counts, no admin view shows (`getGlobalUsage` sums `audio_objects`,
  `audio.ts:82-92`), and no API can remove. Wasabi bills them, with a 90-day
  minimum per object.
- **Fix:** Add `list` to `ObjectStore` and a sweep that removes `audio/**` keys
  older than `uploadUrlTtlSeconds` with no matching `audio_objects` row. It can
  ride on the admin page load or a small interval in the single instance — it
  needs no scheduler infrastructure.

### 🟡 SV8 — There is no rate limiting anywhere, and SSE streams are unbounded and reachable anonymously

- **Class:** NEW
- **Where:** `rg -i 'rate.?limit|throttl' src/lib/server src/app/api` → two
  comments, no code. `src/app/api/profiles/[id]/events/route.ts:31-118`
- **Finding:** No route counts requests per caller. The SSE endpoint is the
  sharpest case: it authorises with `resolveAccess`, which accepts a bare link
  token with no session, then holds a `ReadableStream`, a `setInterval` and a
  subscription for up to `MAX_STREAM_MS = 30 * 60_000`, re-running
  `loadAuthorizedProfileMeta` — three synchronous SQLite queries — every
  `HEARTBEAT_MS = 25_000`:

  ```ts
  open.heartbeat = setInterval(() => {
    if (loadAuthorizedProfileMeta(request, id) instanceof NextResponse) {
      cleanup();
      return;
    }
    send(`: keep-alive\n\n`);
  }, HEARTBEAT_MS);
  ```

  Nothing caps how many such streams one caller may hold. The 30-minute
  lifetime is also a synchronised expiry for every stream opened in the same
  window — after a deploy, every client connects at once and every one of those
  connections then expires and reconnects together, thirty minutes later.

- **Impact:** A holder of any view-only link — the credential designed to be
  handed to strangers — can open thousands of streams and turn the single
  instance into a heartbeat mill, or simply exhaust its sockets. The same
  absence lets `/api/auth/google/refresh` be hammered as an unauthenticated
  oracle against the deployment's OAuth client, and gives SV2 and SV6 their
  repeat-at-will character.
- **Fix:** A small in-process token bucket keyed on IP (and, where present,
  session/share token) in front of the write and proxy routes, plus a hard cap
  on concurrent SSE streams per key — the bus is already in-process
  (`events.ts:25`), so a counter beside `listeners` is all it takes. Jitter
  `MAX_STREAM_MS` by ±20 % so reconnects spread.

### 🟡 SV9 — Nothing caps how many profiles an account creates, or how much disk they take

- **Class:** NEW (named inside old S3's body; distinct from the allow-list decision, which is out of scope here)
- **Where:** `src/app/api/profiles/route.ts:21-40`, `src/lib/server/profiles.ts:87-106`
- **Finding:** `POST /api/profiles` is `requireUser` and then `createProfile` —
  no count check, no per-user byte total, no rate limit. Each blob may be 8 MB.
  The SQLite file lives on the `impamp_data` volume (`config/deploy.yml`), which
  has no size limit either.
- **Impact:** One account can fill the volume. When it fills, SQLite starts
  failing writes for everyone, and the database is the _only_ server-side record
  of who owns what and who holds which hosted object — the bucket is
  content-addressed with no ownership metadata in it. There is no second control
  behind whatever the sign-up policy is set to.
- **Fix:** A per-user profile count and total-bytes ceiling checked in the POST
  handler (`SELECT COUNT(*), SUM(LENGTH(data)) FROM profiles WHERE owner_id = ?`
  is one indexed query), with the same shape of refusal `uploadRefusal` already
  gives hosted audio. Worth a `capBytes`-style env override so it can be raised
  without a deploy.

### 🟡 SV10 — Every hosted-audio download still reads and re-parses the whole profile blob, though the index that exists to avoid it is right there

- **Class:** NEW
- **Where:** `src/app/api/profiles/[id]/audio/[hash]/route.ts:27-33,62-72`
- **Finding:** The route calls `loadAuthorizedProfile` — `SELECT *`, so the up
  to 8 MB `data` column comes off disk and becomes a UTF-16 string — and then
  `JSON.parse`s it just to answer a membership question:

  ```ts
  const authorized = loadAuthorizedProfile(request, id);
  …
  if (!profileReferencesHash(authorized.profile.data, hash)) return notFound();
  ```

  Migration 3 added `profile_audio(profile_id, hash)` with `PRIMARY KEY
(profile_id, hash)` for exactly this class of question (`db.ts:173-178`), and
  `loadAuthorizedProfileMeta` exists to avoid exactly this read
  (`profileRequests.ts:53-66`). Both were applied to the 304, DELETE and SSE
  paths and neither was applied here. This is the busiest of the lot: it runs
  once per sound per collaborator per session, and it is synchronous, so it
  blocks the event loop for its duration.

- **Impact:** A profile with 60 sounds and a 4 MB blob costs 60 full blob reads
  plus 60 `JSON.parse`s of 4 MB, serially, on the request thread, every time a
  collaborator opens it — on the one instance serving everyone.
- **Fix:** `loadAuthorizedProfileMeta` plus
  `SELECT 1 FROM profile_audio WHERE profile_id = ? AND hash = ?`, which hits
  the primary key. Keep `profileReferencesHash` only if pre-migration-3 rows are
  a concern; they are not, since migration 3 backfilled.

### 🟡 SV11 — The health check Kamal promotes on never touches the database

- **Class:** NEW
- **Where:** `src/app/up/route.ts` (whole file), `config/deploy.yml:100-122`
- **Finding:** `/up` returns a constant:

  ```ts
  export function GET() {
    return new Response("OK", { status: 200, … });
  }
  ```

  `getDb()` opens the file lazily on the first request that needs it
  (`db.ts:236-259`), so a container whose `/data` volume is unwritable answers
  `/up` with 200 and is promoted. That is not hypothetical: `.claude/current_plan.md`
  records precisely this failure — the pre-existing `impamp_data` volume was
  root-owned while the container now runs as uid 1000 — and it had to be caught
  by a human reading the plan and running a manual `chown` before deploying.

- **Impact:** Kamal's only automatic gate cannot see the one failure mode this
  deployment has actually hit. A bad deploy goes green and then 500s on the
  first sync.
- **Fix:** Have `/up` call `getDb()` and run one trivial statement
  (`SELECT 1`), returning 503 on throw. It stays cheap — the handle is
  memoised — and it turns "the volume is unwritable" from a post-deploy
  surprise into a failed health check.

### 🟡 SV12 — The documented backup covers the database only, while hosted audio is live in production

- **Class:** NEW
- **Where:** `config/deploy.yml:100-122` (volume and backup comment), `:66-86` (S3 vars), `CLAUDE.md` "Important Implementation Notes"
- **Finding:** All five `IMPAMP_S3_*` values are set in `config/deploy.yml`
  (endpoint/region/bucket in `clear`, both keys in `secret`), so hosted audio is
  on in production. The volume comment nonetheless still describes the
  pre-Wasabi world — "nothing in it is the only copy of a soundboard: … their
  audio stays in Drive" (`:102-105`) — which is exactly the reassurance that
  stops an operator worrying about the pairing. It then gives one backup
  command, for the SQLite file:

  ```
  #   docker run --rm -v impamp_data:/data -v "$PWD:/backup" alpine \
  #     sh -c 'apk add --no-cache sqlite && sqlite3 /data/impamp.db ".backup …"'
  ```

  CLAUDE.md states the rule this omits — "the SQLite database and the bucket
  must be backed up and restored **together**; either one alone leaves dangling
  references" — but the operational file, the one an operator reads at 2 a.m.,
  does not repeat it. There is also no restore procedure and no automation: the
  backup is a comment, so it runs only when somebody remembers.

  Credit where due: the previous pass caught and fixed the worse half of this —
  the old command named `sqlite3` inside the app container, which is
  `node:alpine` and has no such binary, so the one documented recovery could
  never have run.

- **Impact:** Restoring only the database re-points every profile at bucket
  objects whose `audio_objects` rows may no longer match, and orphans any object
  uploaded after the snapshot — bytes nothing counts and no API can delete
  (`releaseReference` only fires for a reference row that exists,
  `audio.ts:355-377`). Restoring only the bucket 404s every hosted sound.
- **Fix:** Put the pairing rule and a bucket-side snapshot (Wasabi object
  versioning, or an `aws s3 sync` to a second bucket) next to the DB command in
  `config/deploy.yml`, with the restore order written down. Better, a tiny cron
  on the host doing both and pruning, so the procedure is exercised rather than
  documented.

### 🟢 SV13 — `GET /api/profiles/:id` authorises twice and can emit an ETag one version behind the body

- **Class:** REGRESSION (introduced by `2c718dd`, the R5 fix)
- **Where:** `src/app/api/profiles/[id]/route.ts:36-58`
- **Finding:** The handler now calls `loadAuthorizedProfileMeta` for the ETag
  and then `loadAuthorizedProfile` for the blob. Both run `resolveAccess`, so a
  full-body GET does six queries where it used to do four. And they are two
  separate reads: a PUT landing between them yields `ETag: "N.owner"` on a body
  whose `"version"` is `N+1`. It self-heals — versions only increase, so the
  next conditional GET misses and refetches — but a client that feeds the ETag
  back as `If-Match` (which `parseVersionHeader` explicitly supports,
  `profileRequests.ts:178-183`) will take a needless 409.
- **Impact:** One wasted round trip in a rare race; a doubled authorisation cost
  on every full-body GET.
- **Fix:** Have `loadAuthorizedProfile` accept the already-resolved
  `AuthorizedRequest`, or return the row and the meta from one read, so
  authorisation happens once and the version behind the ETag is the version in
  the body.

### 🟢 SV14 — Nothing guards the append-only migration rule

- **Class:** NEW
- **Where:** `src/lib/server/db.ts:74-203`
- **Finding:** The rule is stated in a comment — "append only — never edit or
  reorder an existing entry once it has run anywhere" — and honoured in practice
  (migration 4 drops migration 1's index rather than editing it). But nothing
  enforces it: editing `MIGRATIONS[0]` today would leave the production database
  and a fresh one with different schemas, silently, with no test failing.
- **Impact:** Latent. The discipline is currently perfect; it is one careless
  edit from a divergence that only shows up on a restore.
- **Fix:** A test pinning `MIGRATIONS.length` and a SHA-256 of each already-shipped
  entry, updated deliberately when one is appended. Six lines, and it makes the
  comment self-enforcing.
