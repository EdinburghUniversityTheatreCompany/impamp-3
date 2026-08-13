# Plan: Server-backed profile sync (Option 4, core)

Implements Option 4 from `docs/sync-strategies-investigation.md`. Option 0 already
shipped in commit `b387ee6`.

**Status: complete on `feat/server-sync`, awaiting review before merge.**
Merge is being held for sign-off because the change adds authentication and is
outward-facing (a deployed server with accounts) — see the report in the
session, and `docs/server-sync.md`.

**Scope decisions (2026-08-13, confirmed with Mick):**

- Core server sync only. **Audio stays in Google Drive** — we host nothing.
  Gated Wasabi audio hosting is a separate follow-up PR.
- Storage: **SQLite** on a Kamal volume, no replication yet.
- Tests: **Vitest** for unit/integration, Playwright for E2E.
- Admin: **`is_admin` column, first signed-in user bootstraps.** Carried now so
  the Wasabi follow-up has its anchor, even though nothing gates on it yet.

## Phases

- [x] **1. Foundations** — Vitest setup; SQLite layer (`node:sqlite`), schema
      migrations, repositories. (`46c5046`)
- [x] **2. Auth** — server session from the existing Google code exchange,
      first user becomes admin. (`0ca841e`)
- [x] **3. Sync API** — ETag/`If-Match` optimistic concurrency, shares, SSE.
      (`0ca841e`)
- [x] **4. Client** — `syncType: "server"`, `src/lib/serverSync/`,
      merge-and-retry on 409, SSE subscription, sharing UI. (`09f79a1`)
- [x] **5. Deploy + docs** — Kamal volume + env, `docs/server-sync.md`,
      CLAUDE.md, E2E spec. (`3186611`)
- [x] **6. Review pass** — signup allowlist, dead code removal (`29dca46`);
      E2E database-locking fix (`0afa46d`).

## Outstanding (deliberately not done)

- **Gated Wasabi audio hosting** — the other half of the 2026-08-12 decision:
  approved users only, a global storage cap visible to admins, per-user
  metering, and quota accounting for Wasabi's 90-day minimum retention. The
  `is_admin` / `can_upload_audio` columns exist for it; nothing reads them yet.
- **`IMPAMP_ALLOWED_EMAILS` must be set before exposing server sync publicly**
  — unset means any Google account can sign in and store profiles.
- Pre-existing E2E edit-mode flakiness — see `plans/off-topic-improvements.md`.
