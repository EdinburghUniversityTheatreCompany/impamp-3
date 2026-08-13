# Plan: Server-backed profile sync (Option 4, core)

Implements Option 4 from `docs/sync-strategies-investigation.md`. Option 0 already
shipped in commit `b387ee6`.

**Scope decisions (2026-08-13, confirmed with Mick):**

- Core server sync only. **Audio stays in Google Drive** — we host nothing.
  Gated Wasabi audio hosting is a separate follow-up PR.
- Storage: **SQLite** on a Kamal volume, no replication yet.
- Tests: **Vitest** for unit/integration, Playwright for E2E.
- Admin: **`is_admin` column, first signed-in user bootstraps.** Carried now so
  the Wasabi follow-up has its anchor, even though nothing gates on it yet.

## Phases

- [ ] **1. Foundations** — Vitest setup; SQLite layer (`node:sqlite`), schema
      migrations, repositories. DoD: `npm test` green, repo tests cover
      users/profiles/shares CRUD.
- [ ] **2. Auth** — server-side session from the existing Google code exchange
      (userinfo lookup server-side, HttpOnly signed cookie), first user becomes
      admin. DoD: session create/read/destroy tested.
- [ ] **3. Sync API** — `GET/POST /api/profiles`, `GET/PUT/DELETE
      /api/profiles/:id` with ETag/`If-Match` optimistic concurrency, shares
      endpoints, SSE change notifications. DoD: 409-on-stale and
      authorization tested.
- [ ] **4. Client** — `syncType: "server"`, `src/lib/serverSync/`, merge-and-retry
      on 409 reusing `detectProfileConflicts`, SSE subscription in
      `ClientSideInitializer`, UI to enable server sync and manage shares.
      DoD: unit tests for the retry loop; app runs and syncs.
- [ ] **5. Deploy + docs** — Kamal volume + env, `docs/server-sync.md`,
      CLAUDE.md update, E2E spec. DoD: production build passes, E2E green.

## Notes

- Audio refs live inside the profile JSON blob (`ProfileSyncData.audioFiles`,
  hash + driveFileId). No separate `audio_refs` table in this PR — the blob is
  authoritative; the Wasabi PR can add one when it needs server-side audio rows.
