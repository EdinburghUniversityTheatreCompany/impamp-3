# Configuration

Every environment variable the app reads, in one place.
`src/lib/configurationDocs.test.ts` fails when the code reads a variable this
file does not name.

In production the app runs as a Portainer git stack from `docker-compose.yml`.
Set these as the stack's environment variables: Portainer writes them to
`stack.env`, which the `app` service loads. Only variables that are set reach
the container, so an unset one stays unset rather than arriving as `""`.

## Build time

Next inlines these into the client bundle when the image builds. Setting one
only on the running container does nothing; change it and redeploy.

| Variable                       | Purpose                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google OAuth client id. Required: `next build` fails without one. Also read at run time, by the server's token exchange                                              |
| `NEXT_PUBLIC_GOOGLE_API_KEY`   | The Drive Picker's developer key. A browser key, restricted by referrer                                                                                              |
| `NEXT_PUBLIC_GOOGLE_APP_ID`    | The Drive Picker's app id: the Google Cloud project number. Optional                                                                                                 |
| `IMPAMP_S3_ENDPOINT`           | Also read at build time, for the `connect-src` of the Report-Only CSP in `next.config.ts`. The stack does not pass it as a build arg, so the policy omits the bucket |
| `GIT_SHA`                      | The commit the Help modal reports, read by `scripts/generate-build-info.js`. Unset, a build without `.git` reports `nogit`                                           |

## Run time

| Variable                        | Default            | Purpose                                                                                                                                                                                                      |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_CLIENT_SECRET`          | none               | OAuth code exchange and token refresh. Unset, Google sign-in fails                                                                                                                                           |
| `GOOGLE_API_KEY`                | none               | Server key the public Drive proxies spend. Unset, shared boards cannot download audio while signed out                                                                                                       |
| `IMPAMP_DB_PATH`                | `./data/impamp.db` | The server-sync SQLite database. The image and `docker-compose.yml` set `/data/impamp.db`, on the `impamp_data` volume                                                                                       |
| `IMPAMP_ALLOWED_EMAILS`         | unset: anyone      | Who may hold a server-sync account: comma-separated addresses and `@domain` suffixes. See [server-sync.md](server-sync.md#setup)                                                                             |
| `IMPAMP_TRUST_CF_CONNECTING_IP` | unset: off         | `1` makes rate limits count each visitor by Cloudflare's `CF-Connecting-IP` rather than by Cloudflare's edge address. Set it only when nothing but Cloudflare can reach the app, or the header can be forged |

### Server-hosted audio

Off unless all five of these are set. Details in [wasabi-audio.md](wasabi-audio.md).

| Variable                      | Purpose                                   |
| ----------------------------- | ----------------------------------------- |
| `IMPAMP_S3_ENDPOINT`          | e.g. `https://s3.eu-west-1.wasabisys.com` |
| `IMPAMP_S3_REGION`            | e.g. `eu-west-1`                          |
| `IMPAMP_S3_BUCKET`            | e.g. `impamp-audio`                       |
| `IMPAMP_S3_ACCESS_KEY_ID`     | Secret. A key scoped to the one bucket    |
| `IMPAMP_S3_SECRET_ACCESS_KEY` | Secret                                    |

Optional limits. Empty means the default; any other value must be a positive
number, or the server throws when hosting is first used.

| Variable                        | Default | Purpose                                                                     |
| ------------------------------- | ------- | --------------------------------------------------------------------------- |
| `IMPAMP_AUDIO_GLOBAL_CAP_BYTES` | 100 GiB | Ceiling across all hosted audio                                             |
| `IMPAMP_AUDIO_USER_QUOTA_BYTES` | 2 GiB   | Per approved account without an admin override                              |
| `IMPAMP_AUDIO_MAX_OBJECT_BYTES` | 100 MB  | Largest single file                                                         |
| `IMPAMP_AUDIO_UPLOAD_URL_TTL`   | 900     | Presigned PUT lifetime, seconds                                             |
| `IMPAMP_AUDIO_DOWNLOAD_URL_TTL` | 300     | Presigned GET lifetime, seconds. It is the revocation lag, so keep it short |

## Development and tests only

| Variable                   | Purpose                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `HOST_PORT`                | Host port `docker-compose.yml` publishes the app on. Default `3025`                         |
| `ANALYZE`                  | `true` turns on the bundle analyzer in `next.config.ts`                                     |
| `NEXT_PUBLIC_E2E_HOOKS`    | `1` exposes the Playwright test hooks (`src/lib/testHooks.ts`). Never set it in production  |
| `IMPAMP_E2E_SIGNIN_SECRET` | Enables the E2E-only sign-in route (`src/app/api/test/session`). Never set it in production |

## Backups

The database holds users, profiles, shares and sessions. It runs in WAL mode,
so copy it through SQLite's backup API, never with `cp`. The app image is
`node:alpine` and has no `sqlite3`, so run the copy in a throwaway container on
the Docker host. The volume name carries the Compose project name
(`impamp-3_impamp_data` on the Portainer stack):

```sh
docker run --rm -v impamp-3_impamp_data:/data -v "$PWD:/backup" alpine \
  sh -c 'apk add --no-cache sqlite && \
         sqlite3 /data/impamp.db ".backup /backup/impamp-$(date +%F).db"'
```

**With hosted audio on, that is only half the backup.** The bucket holds the
only copy of those sounds. Take the database copy first, then mirror the bucket
with a command that never deletes:

```sh
rclone copy wasabi:impamp-audio /backup/impamp-audio --transfers 8
```

[wasabi-audio.md](wasabi-audio.md#backups) explains why that order, and why
`copy` and never `sync`, are the only safe choices, and gives the query to
check a restore.

The container runs as uid 1000 (`node`). A volume created by this image is
owned by 1000 already; one restored from elsewhere may not be, and the app
cannot write to it until you run
`docker run --rm -v impamp-3_impamp_data:/data alpine chown -R 1000:1000 /data`.
