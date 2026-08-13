# Investigation: Sync Strategies for Multi-User Profile Collaboration

**Date:** 2026-08-12
**Status:** Decided — see "Decisions" at the end.
**Implementation:** Option 0 shipped in `b387ee6`. Option 4 (core, metadata
only) shipped on the `feat/server-sync` branch — see `server-sync.md`. Gated
Wasabi audio hosting remains outstanding.

## Decisions (2026-08-12)

1. **Option 0 ships first** (PR: hardened Drive sync — light remote-change
   polling, focus/edit-mode pulls, 10 s push debounce, public audio proxy,
   anonymous read-only pull path).
2. **Option 4 follows as a separate PR**, with these choices:
   - **Wasabi** (S3-compatible, already in use by the org) hosts audio for
     **approved users only**; audio stays in Google Drive for everyone else.
   - A **global storage cap** across all hosted audio, with current usage
     visible to admins.
   - **Per-user usage metering**: admins can see how much each user has
     uploaded, and each user can see their own usage (and their limit).
   - Quota design note: Wasabi bills a 90-day minimum retention per object
     and its free-egress policy assumes egress ≤ stored volume per month —
     both worth accounting for when sizing the cap and deciding how
     deletions credit back against a user's quota.

## Goal

Allow multiple users to work jointly on a profile, and allow view-only access
for others, ideally **without hosting audio files ourselves**. A server-hosted
option for approved users is acceptable if necessary.

## Where the current approach stands

The current implementation (folder-based Google Drive sync, `drive.file`
OAuth scope) works like this:

- Each synced profile lives in a **per-profile folder** in the owner's Drive,
  containing the profile JSON and the audio files
  (`src/lib/googleDrive/sync.ts`).
- Sharing uses **native Drive permissions** on the folder: invite by email as
  reader/writer, or "anyone with the link" as reader/writer
  (`src/components/profiles/SharingPanel.tsx`).
- Recipients connect via Drive "Open with" (`src/app/drive/open/page.tsx`),
  the Drive Picker, or by pasting a share URL — with a server-side proxy
  fallback for public files (`src/app/api/drive/public-file/route.ts`).
- Sync runs debounced ~1 min after an edit, every 15 minutes, on regaining
  connectivity, and manually (`src/components/ClientSideInitializer.tsx`).
  Merging is field-level last-write-wins with per-field timestamps; true
  conflicts open a manual resolution modal (`src/lib/syncUtils.ts`).
- `readOnly` is reconciled from the actual Drive folder capabilities on each
  sync (`sync.ts` → `getFolderCapabilities`).

### Why it doesn't fully deliver joint editing / view-only

1. **`drive.file` scope visibility friction.** The app can only access files
   the user created _with the app_ or explicitly granted via the Picker /
   "Open with" flow. An invited collaborator can see the folder in Drive, but
   the app's token gets 403/404 until they perform the Picker or Open-with
   dance. Pasting a _private_ share URL fails (the code already carries a
   `DRIVE_403` / "scope-invisible file" fallback for exactly this). Files the
   owner adds to the folder _later_ have also proven unreliable to access,
   which is why `repairDriveAudioFiles` and the backfill machinery exist.
2. **Latency.** Polling every 15 minutes means collaborators work on stale
   data most of the time. There is no change-notification channel: Drive's
   Changes `watch` API needs a server webhook and still can't push to a
   browser, so the current architecture can't do much better than polling.
3. **Conflicts under concurrency.** Two people editing within the same poll
   window regularly hit the conflict modal or silent field-level
   last-write-wins. Fine for turn-taking; painful for simultaneous editing.
4. **View-only is incomplete for anonymous users.** The public proxy serves
   only the profile **JSON**. Audio downloads are always authenticated
   (`downloadAudioFileAsBlob` requires a token), so a viewer who never signs
   in gets a profile with **silent pads**.
5. **No anonymous or link-based writing.** "Anyone with link: can edit"
   exists in the UI, but writing back requires an authenticated Drive token
   with a `drive.file` grant on the folder — anonymous editing is impossible
   with Drive, full stop.

## Options considered

### Option 0 — Harden the current Drive model (no new infra)

Keep everything; fix the sharp edges:

- **Faster, cheaper change detection.** Poll `files.get(fileId,
fields=modifiedTime,version)` on the profile JSON every 30–60 s for shared
  profiles (a very light call) and only run a full sync when it changed. Add
  sync-on-`visibilitychange`/focus and a pull when entering edit mode. Drop
  the push debounce to ~10 s for shared profiles.
- **Audio through the public proxy.** Extend `/api/drive/public-file` (or add
  `/api/drive/public-audio`) to stream `alt=media` bytes for audio files of
  public profiles, with a size cap and cache headers. This completes
  anonymous **view-only**: JSON + audio both work without sign-in. We proxy
  bytes but still don't _store_ them.
- **Connect UX.** Lead recipients through the Picker/Open-with grant instead
  of URL-paste for private shares, since that's the only path `drive.file`
  reliably supports.

**Effort:** days. **Result:** solid view-only (including anonymous), and
turn-taking collaboration with sub-minute freshness. Does _not_ fix truly
simultaneous editing.

### Option 1 — Broader Drive scope (`drive` full access)

Would make "shared with me" items visible without the Picker dance. Rejected:
`drive` (and `drive.readonly`) are **restricted scopes** requiring Google
verification plus an annual CASA Tier 2 security assessment (external lab,
recurring cost and process). Disproportionate for this project; `drive.file`
is the highest scope that stays out of that regime.

### Option 2 — Different consumer storage (Dropbox / OneDrive)

Same class of per-file permission and latency problems, smaller user base
overlap, a second OAuth integration to maintain. No real gain. Rejected.

### Option 3 — Real-time CRDT collaboration (Yjs)

Model the profile metadata (pads, banks, names — _not_ audio bytes) as a Yjs
document; audio stays in Drive, referenced by content hash as today.

- Gives Google-Docs-style simultaneous editing, presence ("Mick is editing
  bank 3"), and offline merge that never conflicts.
- Needs a relay/persistence point: a tiny `y-websocket` server (deployable as
  a sidecar container in the existing Kamal setup) is the reliable choice;
  y-webrtc (P2P) needs a signaling server anyway and requires peers online
  simultaneously, so it's a poor fit.
- Drive remains the durable snapshot store (the Yjs doc is periodically
  flattened back into the profile JSON), so existing single-user sync and
  export flows keep working.
- Open problem: access control. CRDT rooms don't inherit Drive ACLs; the
  simplest scheme is a room secret stored inside the profile JSON so that
  anyone with Drive access to the folder automatically has collab access.

**Effort:** weeks, plus an always-on (but tiny and stateless) service.
**Result:** true joint editing. Best done _after_ a server exists (Option 4),
since it can share that infrastructure.

### Option 4 — Lightweight app backend (recommended medium-term)

Key realization: **ImpAmp3 is already a server deployment.** The Next.js app
runs with API routes (OAuth code exchange/refresh, public-file proxy) behind
Docker + Kamal with a health check. A "full server backend" is incremental,
not a rewrite:

1. **Auth:** we already do Google sign-in; verify the ID token server-side
   and keep a `users` table + session cookie.
2. **Data:** Postgres (or SQLite + Litestream) with `profiles`
   (JSON blob + integer version), `shares` (user email or link token, role
   `viewer`/`editor`), and audio _references_ (hash + optional
   `driveFileId`).
3. **Sync protocol:** `GET /api/profiles/:id` with `If-None-Match: <version>`;
   `PUT` with `If-Match` for optimistic concurrency. On 409, run the
   _existing_ client-side merge (`detectProfileConflicts`) and retry — the
   conflict machinery is reused wholesale, just pointed at a different
   remote.
4. **Realtime-ish:** an SSE endpoint per profile that emits "changed, re-pull"
   (and optionally presence/soft-locks). Latency drops from 15 min to ~1 s
   without any CRDT complexity.
5. **Audio policy (the user-facing crux):**
   - **Default: audio stays in Google Drive** exactly as today. The server
     stores only hashes and Drive file IDs; collaborators fetch blobs from
     Drive. We host zero audio.
   - **Optional, gated: server-hosted audio** for approved users (a
     `canUploadAudio` flag, per-profile quota, files on a Kamal volume or an
     S3-compatible bucket — Cloudflare R2 is attractive: free egress,
     ~$0.015/GB-month). This removes all Drive friction for those users but
     brings storage, backup, and abuse-handling duties, hence the gating.

**Effort estimate:** the core (auth, profile storage, shares, SSE, client
`syncType: "server"` alongside the existing `"googleDrive"`) is roughly 2–4
weeks of part-time work. Gated audio hosting adds maybe another week plus
ongoing operational care (DB/blob backups become mandatory).

### Option 5 — BaaS (Firebase / Supabase)

Fastest route to realtime + auth + storage rules, but it's an external
dependency with its own quotas and pricing, and it sits awkwardly next to the
self-hosted Kamal deployment (self-hosting Supabase is heavyweight).
Mentioned for completeness; not recommended.

## Recommendation

1. **Now (days): Option 0.** Fast change detection + focus-sync +
   pull-before-edit + audio proxy for public profiles. This fully solves
   view-only (even anonymous) and makes turn-taking co-editing feel live,
   with zero new infrastructure.
2. **Next (weeks): Option 4, metadata-only.** Small server-side share +
   notify layer on the existing Next.js deployment, reusing the existing
   Google sign-in and merge code. Audio remains in Drive — we host nothing.
   Drive sync stays as an alternative/export path.
3. **Later, if needed: gated audio hosting** for approved users (R2/volume),
   and/or **Option 3 (Yjs)** on top of the same server if genuinely
   simultaneous editing (e.g. two people building a board during rehearsal)
   becomes a real requirement.
