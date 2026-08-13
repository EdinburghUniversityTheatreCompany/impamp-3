# ImpAmp3 — Server Sync

Server sync is the second synchronisation backend, alongside Google Drive. It
exists because Drive can't give collaborators a shared profile that updates
promptly: `drive.file` scope makes invited files invisible until the recipient
performs a Picker grant, and polling every 15 minutes means people work on
stale data. See `sync-strategies-investigation.md` for how that decision was
reached — this is "Option 4, core".

**Audio is not stored on the server.** A profile row holds only the profile
JSON, which carries content hashes and Google Drive file IDs. Collaborators
fetch the bytes from the owner's Drive, or through the public proxy when
signed out. Hosting audio ourselves is a separate, gated feature that has not
been built yet.

## What it gives you

|                     | Google Drive sync                   | Server sync                                        |
| ------------------- | ----------------------------------- | -------------------------------------------------- |
| Change latency      | ~30 s poll, 15 min backstop         | ~1 s, pushed over SSE                              |
| Inviting someone    | Drive share **plus** a Picker grant | invite by email, works at next sign-in             |
| Anonymous view-only | public Drive link                   | share link, no sign-in at all                      |
| Simultaneous edits  | last-write-wins or a conflict modal | version-checked; a lost race re-merges and retries |
| Where audio lives   | Google Drive                        | Google Drive (unchanged)                           |
| Infrastructure      | none                                | one SQLite file on a volume                        |

Server sync does _not_ give true simultaneous editing of the same pad — that
would need CRDTs (Option 3). It gives you correct convergence instead of
silent data loss.

## Setup

The server needs one environment variable and one persistent volume:

- `IMPAMP_DB_PATH` — where the SQLite database lives. Defaults to
  `./data/impamp.db`, which is fine for local development. Production sets
  `/data/impamp.db`, backed by the `impamp_data` volume in `config/deploy.yml`.
- `IMPAMP_ALLOWED_EMAILS` — **who may hold a server-sync account.** Optional,
  comma-separated, accepting full addresses and `@domain` suffixes:

  ```
  IMPAMP_ALLOWED_EMAILS="me@example.com,@bedlamtheatre.co.uk"
  ```

  Leave it unset and *any* Google account that reaches the app can sign in and
  store profiles. That is fine on a private or trusted-network deployment and
  a poor idea on a public host — **set it before exposing server sync
  publicly.** It gates server sync only; Drive sync needs no account here and
  is unaffected.

There is nothing to install. Storage uses Node's built-in `node:sqlite`, so
there is no native module to compile and no extra image build tooling. The
schema is created and migrated automatically on first use.

### Backups

The database holds users, profiles, shares and sessions. Losing it unlinks
every server-synced profile, but it is not the only copy of anyone's
soundboard: the profile data is also in each collaborator's IndexedDB, and the
audio is in Drive. Still, back it up — WAL mode means a plain `cp` can capture
a torn state, so use SQLite's own backup:

```sh
kamal app exec --reuse 'sqlite3 /data/impamp.db ".backup /data/backup.db"'
```

## How a user turns it on

1. Sign in with Google as usual. The code exchange already happens
   server-side, so the same sign-in also establishes a server session — there
   is no second consent screen. (If `IMPAMP_ALLOWED_EMAILS` is set and the
   account isn't on it, no session is created and only Drive sync is offered.)
2. On a local profile, press **Sync to ImpAmp server**. The first sync uploads
   the profile as-is and records the ID the server assigns.
3. Share it: invite an email address, or mint a share link. Invited people get
   access the moment they sign in; a link works immediately, signed in or not.

A share link opens at `/server/open?id=<profileId>&token=<shareToken>`, which
imports the profile locally and marks it server-synced.

**Keep the profile's Drive folder shared as well.** Sharing on the server
governs the profile; the audio still comes from Drive, so a collaborator who
can't reach the Drive folder gets a profile with silent pads.

## The sync protocol

Optimistic concurrency over ETags. Every profile carries a monotonically
increasing `version`.

```
GET    /api/profiles/:id      → { name, version, access, data }, ETag: "<version>"
                                If-None-Match: "<version>" → 304, empty body
PUT    /api/profiles/:id      → requires If-Match: "<version>"
                                200 on success, version incremented
                                409 if stale, *carrying the current blob*
                                428 if If-Match is missing
DELETE /api/profiles/:id      → owner only
GET    /api/profiles/:id/events → SSE; `change` events with the new version
```

Two properties are worth spelling out:

- **A 409 carries the winning data.** The client merges the server's state
  into its own using the same `detectProfileConflicts` the Drive sync uses,
  then retries — no extra round trip. It gives up after three consecutive
  races and lets the next scheduled sync try again.
- **The SSE payload carries only a version, never data.** Clients always read
  through the ETag path, so there is one code path for reading a profile and
  no way for an event to deliver stale bytes.

### Access model

| Role   | Read | Write | Manage sharing | Delete |
| ------ | ---- | ----- | -------------- | ------ |
| owner  | ✅   | ✅    | ✅             | ✅     |
| editor | ✅   | ✅    | ❌             | ❌     |
| viewer | ✅   | ❌    | ❌             | ❌     |

Access comes from ownership, an email invite, or a link token; when more than
one applies, the strongest wins. A caller with no grant gets **404, not 403**,
so profile IDs can't be enumerated by probing.

Link tokens are bearer credentials scoped to a single profile: a token minted
for profile A does nothing on profile B, and revoking one link leaves other
links working.

### Identity

Users are keyed on the Google `sub`, which is stable across email changes.
The access token from our own server-side code exchange is resolved against
Google's userinfo endpoint; because that response comes straight from Google
over TLS in reply to our own request, there is nothing further to verify.
Unverified Google emails are refused, since an email share is claimed by
address.

Sessions are random bearer tokens in an HttpOnly cookie; only their SHA-256
hash is stored. Establishing a session is best-effort — if it fails, Drive
sync carries on unaffected.

The **first user to sign in becomes an admin**. This instance is self-hosted,
so bootstrapping from the first sign-in avoids shipping a credential. Nothing
gates on `is_admin` yet; it exists for the hosted-audio feature.

## Limitations

- **Single instance only.** The SSE bus is in-process, which suits the
  single-container Kamal deployment. A second replica would need an external
  bus (Redis pub/sub, Postgres `LISTEN`); until then notifications would reach
  only viewers on the same instance, with the periodic sync as the safety net.
- **No replication.** The SQLite file lives on one volume with no streaming
  backup. Litestream (replicating to the org's Wasabi bucket) is the obvious
  next step if this becomes load-bearing.
- **Audio hosting is not implemented.** Audio remains in Drive for everyone.
  The gated Wasabi option — approved users, a global cap, per-user metering —
  is a separate piece of work.
- **No storage quota.** Nothing caps how many profiles a user creates or how
  large a profile blob may be. `IMPAMP_ALLOWED_EMAILS` is the only limit on
  who can consume space.
- **Not true concurrent editing.** Two people editing the same pad within the
  same second still produce a conflict for a human to resolve; they just no
  longer silently overwrite one another.
