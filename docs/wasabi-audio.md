# ImpAmp3 — Server-hosted audio (Wasabi)

Optional, off by default, and gated per account. This is the second half of
Option 4 in `docs/sync-strategies-investigation.md`; the first half (server
sync for profile _metadata_) is in `docs/server-sync.md`.

**Without this, nothing changes.** Audio lives in each user's Google Drive, the
server stores only hashes and Drive file IDs, and we host no audio at all. A
deployment that sets none of the variables below behaves exactly as before —
every route here answers `501`, and the client skips the whole path after one
cached check.

## Why it exists

Drive sync works, but a collaborator has to perform the Picker / "Open with"
dance before the app's `drive.file` token can read the owner's audio. For a
handful of approved users — the people actually building shows — hosting the
audio ourselves removes that friction completely. Hosting it for _everyone_
would mean unbounded storage, backup and abuse duties, hence the gate.

## How a file gets there

```
browser                        app server                   Wasabi
   │                                │                          │
   │─ POST /api/audio/upload-url ──▶│  approved? within quota?  │
   │◀──── presigned PUT URL ────────│                          │
   │────────────── PUT the bytes ─────────────────────────────▶│
   │─ POST /api/audio/commit ──────▶│──── HEAD (real size) ───▶│
   │◀──── usage after commit ───────│  record + start charging  │
```

Audio bytes never pass through the app. That matters twice over: the server
runs as a single instance whose SQLite layer is synchronous, and Wasabi's
free-egress policy assumes egress stays below stored volume.

The presigned PUT signs only `host`, so it cannot constrain what the browser
sends. **Commit is where the quota becomes real**: the server HEADs the object,
takes the size from the bucket rather than from the client, and re-runs the
decision against that. Bytes it will not account for are deleted again.

## Accounting

Objects are content-addressed by the SHA-256 of their bytes, so the same sound
on five pads, or held by five people, is one object.

- **Per user**: every holder of a reference is charged the full size. Any of
  them could be the last to let it go.
- **Globally**: the object counts once. That is what the bucket holds.
- An object leaves the bucket only when its **last** reference does.

**Deleting frees the user's allowance immediately.** Wasabi bills a 90-day
minimum retention per object regardless, so the deployment absorbs a residual
cost the numbers in the UI do not show. That was a deliberate choice in favour
of behaviour users can predict; the alternative was withholding quota for 90
days after a delete. If churn ever becomes a real cost problem, that is the
knob to revisit.

## Configuration

All five are required together. Miss one and hosting stays off.

| Variable                      | Example                                 |
| ----------------------------- | --------------------------------------- |
| `IMPAMP_S3_ENDPOINT`          | `https://s3.eu-central-2.wasabisys.com` |
| `IMPAMP_S3_REGION`            | `eu-central-2`                          |
| `IMPAMP_S3_BUCKET`            | `impamp-audio`                          |
| `IMPAMP_S3_ACCESS_KEY_ID`     | from Wasabi                             |
| `IMPAMP_S3_SECRET_ACCESS_KEY` | from Wasabi                             |

Optional limits, with their defaults:

| Variable                        | Default | Meaning                         |
| ------------------------------- | ------- | ------------------------------- |
| `IMPAMP_AUDIO_GLOBAL_CAP_BYTES` | 100 GiB | Ceiling across all hosted audio |
| `IMPAMP_AUDIO_USER_QUOTA_BYTES` | 2 GiB   | Per approved account            |
| `IMPAMP_AUDIO_MAX_OBJECT_BYTES` | 100 MB  | Largest single file             |
| `IMPAMP_AUDIO_UPLOAD_URL_TTL`   | 900     | Presigned PUT lifetime, seconds |
| `IMPAMP_AUDIO_DOWNLOAD_URL_TTL` | 3600    | Presigned GET lifetime, seconds |

A per-user override set by an admin beats `IMPAMP_AUDIO_USER_QUOTA_BYTES`;
clearing it puts that user back on the default, so raising the default lifts
everyone who has no specific allowance.

### Secrets

The two keys are secrets: keep them out of committed files. Use fnox with
Bitwarden Secrets Manager as everywhere else — `fnox.toml` holds only
_references_, resolved at run time. The `env-to-fnox` skill covers the setup.

### Bucket policy — you must apply this

Two things have to be set on the bucket itself; the app cannot do them for you.

**1. CORS**, or the browser's direct PUT and GET are blocked. Replace the
origin with your deployment's:

```json
[
  {
    "AllowedOrigins": ["https://impamp.example.org"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length"],
    "MaxAgeSeconds": 3000
  }
]
```

**2. Keep the bucket private.** Every read goes through a presigned URL the
server mints, and those URLs pin `response-content-type` to the audio type we
recorded. A public bucket would bypass both, and let an uploaded file be served
as `text/html` from the bucket's own origin.

An access key scoped to just this bucket is worth the five minutes: the app
only ever needs `GetObject`, `PutObject`, `DeleteObject` and `HeadObject` on
`arn:aws:s3:::<bucket>/audio/*`.

## Approving a user

The first account to sign in becomes admin (see `docs/server-sync.md`). Admins
get the controls at `/server/storage`: a checkbox per user to allow uploads,
and their allowance. Nobody can upload until an admin turns it on — including
the admin.

## Operational notes

- **Backups become mandatory.** Once audio is hosted, the SQLite database is no
  longer the only thing worth backing up, and the two must be restored
  together: `audio_objects` rows without their bucket objects leave pads
  pointing at nothing, and orphaned objects are billed but unreachable.
- **The 90-day minimum** means deleting a lot of audio does not reduce the next
  bill much. Size the cap against what you expect to _accumulate_, not what is
  live at any moment.
- **Deleting a user** cascades their references away, but the sweep that
  removes now-orphaned bucket objects runs at delete time through the API. A
  user removed directly in SQL will leave objects behind.

## Testing without Wasabi

`createFakeObjectStore` is an in-memory `ObjectStore`; `setObjectStoreForTests`
swaps it in. The whole API suite runs against it with no network, credentials
or bucket — see `src/app/api/audio/audio.api.test.ts`.

The signer is checked against reference signatures generated by botocore, AWS's
own implementation, rather than against values this codebase computed for
itself:

```bash
uv run --with botocore python scripts/generate-sigv4-vectors.py \
  > src/lib/server/s3/__fixtures__/sigv4-vectors.json
```

The generator freezes its clock, so a regenerated fixture is byte-identical
unless the signing rules themselves changed.
