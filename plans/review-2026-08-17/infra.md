# Infrastructure, CI supply chain, dependencies, secrets and docs — 2026-08-17

Reviewed at `b29585b` on `main`, in the main checkout (not a worktree). Every
claim below was produced by running the command shown.

Two things were excluded by instruction and are not findings here: deleting the
orphaned docs (L9) and committing `fnox.toml` (L11).

---

## 🔴 High

### 🔴 I1 — the impossible `sqlite3` backup command survives in `docs/server-sync.md`

- **Class:** RECURRENCE
- **Where:** `docs/server-sync.md:63-65`
- **Finding:** the fix pass replaced this command in `config/deploy.yml` and
  wrote down exactly why it could never have worked:

  ```
  config/deploy.yml:108:# on the host, not through `kamal app exec`: the app image is node:alpine and
  config/deploy.yml:109:# has no sqlite3 binary, so the command this used to name could never have run
  ```

  The identical command is still the _only_ backup procedure in the server-sync
  doc:

  ```
  docs/server-sync.md:64:kamal app exec --reuse 'sqlite3 /data/impamp.db ".backup /data/backup.db"'
  ```

  Two further problems with that copy, independent of the missing binary: it
  writes the backup to `/data/backup.db` — onto the volume it is protecting —
  and `docs/server-sync.md` is the file a maintainer reaches for, since it is
  the one with a section literally headed "Backups". This is the
  "sync bugs are duplicated rules" shape: one rule written twice, one copy
  fixed.

- **Impact:** the documented recovery procedure fails with
  `sh: sqlite3: not found`, discovered at the moment someone needs a backup. A
  maintainer who does not notice may believe backups are running.
- **Fix:** replace `docs/server-sync.md:55-65` with a pointer to
  `config/deploy.yml`'s block (single source), or copy the host-side
  `docker run --rm -v impamp_data:/data -v "$PWD:/backup" alpine …` command
  verbatim. Do not keep two copies.

### 🔴 I2 — the documented backup covers SQLite only, but hosted audio is live in production

- **Class:** NEW
- **Where:** `config/deploy.yml:100-122` (the backup block) vs
  `config/deploy.yml:71-73` and `docs/wasabi-audio.md:126-131`
- **Finding:** `config/deploy.yml:71-73` sets `IMPAMP_S3_ENDPOINT`,
  `IMPAMP_S3_REGION` and `IMPAMP_S3_BUCKET: impamp-audio`, and `:85-86` supplies
  the two keys, so server-hosted audio is **on** in production. CLAUDE.md and
  `docs/wasabi-audio.md:128-131` both state the invariant:

  > **Backups become mandatory.** Once audio is hosted, the SQLite database is
  > no longer the only thing worth backing up, and the two must be restored
  > together: `audio_objects` rows without their bucket objects leave pads
  > pointing at nothing, and orphaned objects are billed but unreachable.

  No file in the repo gives a command, a schedule or a tool for the bucket half.
  `config/deploy.yml`'s backup block — the one place with a runnable
  procedure — names only the volume. `docs/wasabi-audio.md` states the
  requirement and stops. Grep confirms there is no `rclone`, `aws s3 sync`,
  `mc mirror` or bucket-versioning instruction anywhere:

  ```
  $ rg -n 'rclone|aws s3|mc mirror|versioning' docs/ config/ scripts/ README.md CLAUDE.md
  (no output)
  ```

- **Impact:** following the only documented procedure produces a backup that,
  restored, leaves every hosted sound pointing at nothing. The invariant the
  docs assert is not achievable with the instructions the docs give.
- **Fix:** put the bucket half next to the SQLite half in
  `config/deploy.yml`'s comment block — either enable Wasabi bucket versioning
  plus object lock, or an `rclone sync s3:impamp-audio <dest>` run pinned to the
  same cadence as the DB copy, with a note that the two snapshots must be taken
  close together and restored as a pair. Cross-reference it from
  `docs/wasabi-audio.md:128`.

---

## 🟡 Medium

### 🟡 I3 — `main` does not pass its own `prettier --check`, so CI's `lint` job goes red on the next push

- **Class:** REGRESSION
- **Where:** `docker-compose.yml:1`, `.claude/current_plan.md`; gate at
  `.github/workflows/ci.yml:31-32`; cause at `hk.pkl:8`
- **Finding:**

  ```
  $ npx prettier --check .
  Checking formatting...
  [warn] .claude/current_plan.md
  [warn] docker-compose.yml
  [warn] Code style issues found in 2 files. Run Prettier with --write to fix.
  $ npx prettier --check . >/dev/null 2>&1; echo $?
  1
  ```

  Both files are tracked (`git ls-files --error-unmatch` succeeds on both).
  `docker-compose.yml` has a stray leading blank line — the residue of removing
  the obsolete `version:` key in `ad4fa4d`, the fix-pass commit:

  ```
  $ npx prettier docker-compose.yml | diff - docker-compose.yml
  0a1
  >
  ```

  `.claude/current_plan.md` differs in markdown emphasis (`*and*` vs `_and_`)
  and table padding.

  The cause is a pre-commit/CI scope mismatch. `hk.pkl:8` globs prettier to
  `**/*.js|ts|jsx|tsx|astro|css|scss|mdx|json` — **no `.md`, no `.yml`** — while
  CI runs `npx prettier --check .` over everything, with no `.prettierignore` in
  the repo (`ls .prettierignore` → no such file). So YAML and Markdown are
  gated in CI and invisible to the hook, which is how a formatting break landed
  on `main`. Every other gate in `hk.pkl` carries a comment claiming CI parity;
  this is the one that does not have it.

  For the record, the rest of the pipeline is green at `b29585b`:
  `eslint .` reports 0 errors on tracked files, `bash scripts/check_version_sync.sh`,
  `bash scripts/check_action_refs.sh`, `actionlint`, `zizmor` and `gitleaks git`
  all exit 0, and `npx vitest run` is 617 passed / 56 tracked test files passing
  (the only 2 failures are in `src/lib/audio/zzr1probe.test.ts`, an **untracked**
  scratch file left by another agent).

- **Impact:** the `lint` job fails on the next push to `main` and on every PR
  until it is fixed. A red pipeline that everyone learns to expect is the
  failure mode `e2e-tests/README.md:60-62` argues against in the test suite.
- **Fix:** `npx prettier --write docker-compose.yml .claude/current_plan.md`,
  then add `"**/*.md"`, `"**/*.yml"`, `"**/*.yaml"` to the `prettier` glob in
  `hk.pkl:8` so the hook covers what CI covers.

### 🟡 I4 — the image creates and chowns `/data` but never points the app at it, so the README's `docker run` cannot open its database

- **Class:** REGRESSION (introduced by `645d775`, which added `USER node`)
- **Where:** `Dockerfile:44-55`, `src/lib/server/db.ts:209`, `README.md:116-127`
- **Finding:** `Dockerfile:50` does `RUN mkdir -p /data && chown node:node /data`
  and `:55` drops to `USER node`, but the image never sets
  `ENV IMPAMP_DB_PATH`. The app's own default is relative:

  ```
  src/lib/server/db.ts:209:  return process.env.IMPAMP_DB_PATH || "./data/impamp.db";
  src/lib/server/db.ts:241:    mkdirSync(dirname(path), { recursive: true });
  ```

  `server.js` does `process.chdir(__dirname)`, which in the image is `/app`, so
  the default resolves to `/app/data` — and `/app` is created by `WORKDIR` as
  **root**, which `COPY --chown=node:node` does not change. Reproduced with the
  Dockerfile's exact instruction sequence:

  ```
  $ docker run --rm dtest sh -c 'ls -ld /app /app/sub /data'
  drwxr-xr-x 1 root root 4096 /app
  drwxr-xr-x 2 node node 4096 /app/sub
  drwxr-xr-x 2 node node 4096 /data

  $ docker run --rm dtest   # mkdirSync('/app/data') as uid 1000
  errno: -13, code: 'EACCES', syscall: 'mkdir', path: '/app/data'
  MKDIR FAILED
  ```

  `docker-compose.yml:15` and `config/deploy.yml:60` both set
  `IMPAMP_DB_PATH=/data/impamp.db`, so those paths work — which is why
  `645d775`'s verification ("on a fresh named volume SQLite creates impamp.db")
  passed. The path it did not exercise is the one `README.md:116-127` documents:

  ```bash
  docker run -p 3025:3000 impamp3:latest
  ```

  Before `USER node`, uid 0 could create `/app/data`, so this worked (badly —
  the database was ephemeral). Now it raises `EACCES`.

- **Impact:** anyone self-hosting via the README's direct `docker run` gets a
  500 from every server-sync API route, with an `EACCES /app/data` in the logs
  and nothing in the docs to connect it to. `getDb()` is only reached from route
  handlers, so the soundboard itself still loads — which makes it harder to
  diagnose, not easier.
- **Fix:** add `ENV IMPAMP_DB_PATH=/data/impamp.db` to the runner stage, so the
  image's default matches the directory it already creates and chowns for
  exactly this purpose. Compose and Kamal then merely restate it. Optionally
  add `VOLUME /data` and a line in README.md's Docker section noting that
  `docker run` without `-v` keeps the database only for the container's life.

### 🟡 I5 — `.gitleaks.toml`'s `^\.env` allowlist also blinds the scanner to the _tracked_ `.env.dist`

- **Class:** NEW
- **Where:** `.gitleaks.toml:24`
- **Finding:** the allowlist is documented as being "PATH-SCOPED to gitignored
  runtime/secret locations only — app/config SOURCE stays fully scanned"
  (`.gitleaks.toml:12-14`), but `'''^\.env'''` is an unanchored prefix that also
  matches `.env.dist`, which **is** tracked:

  ```
  $ git ls-files | rg -i 'env|cert|\.key|\.pem|secret'
  .env.dist
  .kamal/secrets
  e2e-tests/env.js
  ```

  Demonstrated with the repo's own config on identical content in two files:

  ```
  $ cd <scratch> && gitleaks dir --no-banner -v --redact .
  Finding:     SECRET_TOKEN=REDACTED
  RuleID:      slack-bot-token
  File:        source2.ts
  ...
  leaks found: 1
  ```

  The byte-identical `.env.dist2` produced no finding; `source2.ts` did. Both
  the hk `gitleaks` step and CI's `gitleaks git` job read this config, so the
  blind spot is on both sides of the gate. (`.env.dist` is currently clean —
  every value is empty — and `gitleaks git` over all 468 commits reports
  `no leaks found`. This is a latent hole, not an active leak.)

- **Impact:** a real credential pasted into the committed `.env.dist` template —
  the single most natural mistake for a file whose whole purpose is to list
  secret names — passes pre-commit, passes CI, and lands in public history.
- **Fix:** narrow the pattern to the gitignored forms only. gitleaks uses RE2
  (no lookahead), so enumerate:
  `'''^\.env$'''`, `'''^\.env\.local'''`, `'''^\.env\.(development|production|test)'''`.

### 🟡 I6 — `.env.dist` omits the two `IMPAMP_S3_*` secrets that `.kamal/secrets` requires

- **Class:** NEW
- **Where:** `.env.dist`, `.kamal/secrets`, `config/deploy.yml:85-86`
- **Finding:** `.kamal/secrets` resolves five values from the environment:

  ```
  KAMAL_REGISTRY_PASSWORD=$KAMAL_REGISTRY_PASSWORD
  GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
  GOOGLE_API_KEY=$GOOGLE_DRIVE_DOWNLOADS_API_KEY
  IMPAMP_S3_ACCESS_KEY_ID=$IMPAMP_S3_ACCESS_KEY_ID
  IMPAMP_S3_SECRET_ACCESS_KEY=$IMPAMP_S3_SECRET_ACCESS_KEY
  ```

  `.env.dist` — the only committed template — lists five names, and the two S3
  ones are not among them:

  ```
  KAMAL_REGISTRY_PASSWORD=
  NEXT_PUBLIC_GOOGLE_CLIENT_ID=
  NEXT_PUBLIC_GOOGLE_FILE_PICKER_API_KEY=
  GOOGLE_CLIENT_SECRET=
  GOOGLE_DRIVE_DOWNLOADS_API_KEY=
  ```

  The local `fnox.toml` does have both, but it is gitignored, so a fresh clone
  has no record that they exist.

- **Impact:** a deploy from a fresh clone fails at
  `kamal secrets` with a missing-variable error for a key nothing told the
  operator about — and the failure mode if it is instead silently empty is worse:
  hosted audio stops signing, and `docs/wasabi-audio.md` says nothing about how
  that presents.
- **Fix:** add `IMPAMP_S3_ACCESS_KEY_ID=` and `IMPAMP_S3_SECRET_ACCESS_KEY=` to
  `.env.dist` (empty, as the others are), with a one-line comment that they are
  optional and only needed when hosted audio is on.

### 🟡 I7 — `docs/server-sync.md` says hosted audio "has not been built yet"; it shipped and is live

- **Class:** NEW
- **Where:** `docs/server-sync.md:10-14` and `:24`, contradicted by
  `docs/server-sync.md:161-164`
- **Finding:** the doc opens with

  > **Audio is not stored on the server.** … Hosting audio ourselves is a
  > separate, gated feature that has not been built yet.

  and the comparison table at `:24` gives "Where audio lives → Google Drive
  (unchanged)" for both columns. It has been built:

  ```
  $ ls src/lib/serverAudio/ src/lib/server/s3/
  api.ts  format.ts  proofOfPossession.ts  transfer.ts  (+ tests)
  client.ts  config.ts  fakeObjectStore.ts  sigv4.ts  (+ tests, fixtures)
  $ ls src/app/server/
  open  storage
  ```

  and it is enabled in production (`config/deploy.yml:71-73`). The same file
  contradicts itself 150 lines later at `:161-164` ("The gated Wasabi option …
  **now exists** as a separate, opt-in piece"). `:148-150` carries the matching
  stale claim — "Nothing gates on `is_admin` yet; it exists for the hosted-audio
  feature" — while `src/app/api/admin/audio/route.ts` and
  `src/app/api/admin/users/[id]/route.ts` both gate on it today.

- **Impact:** the same failure shape L8 called out in CLAUDE.md — two sections
  of one document giving different answers, with the more prominent one wrong.
  A reader stops at the bold sentence in the intro.
- **Fix:** rewrite `:10-14` to "audio stays in Drive **by default**; hosted
  audio is opt-in — see `wasabi-audio.md`", make the table row say
  "Drive, or the app's own storage when enabled", and drop the "yet" from
  `:150`.

### 🟡 I8 — `check_version_sync.sh` still reads only `Dockerfile`/`Containerfile`, so `Dockerfile.dev` can drift again

- **Class:** RECURRENCE (the second half of the last review's I4; plan item 13.2
  named the widening and it was not done)
- **Where:** `scripts/check_version_sync.sh:53-59`
- **Finding:** the Node pin in `Dockerfile.dev:8` was corrected to `24.19.0`,
  but the gate that was supposed to have caught it still does not look at that
  file:

  ```sh
  DOCKERFILE=""
  for f in Dockerfile Containerfile; do
    if [ -f "$f" ]; then
      DOCKERFILE=$f
      break
    fi
  done
  ```

  Its own output confirms the coverage:

  ```
  $ bash scripts/check_version_sync.sh
  Toolchain:
    ✓ node 24.19.0 — .node-version, mise.toml node, Dockerfile ARG NODE_VERSION
  ```

  `Dockerfile.dev` is not named. `hk.pkl:33`'s `versions` glob likewise lists
  `Dockerfile` but not `Dockerfile.dev`, so editing only the dev image does not
  even trigger the step.

- **Impact:** the exact bug last time (dev container on a different Node major
  from CI, silently, for months) can recur unchanged. The comment in
  `Dockerfile.dev:3-7` claims the file is "Kept in step with … the production
  Dockerfile", which nothing enforces.
- **Fix:** the script's header asks not to hand-edit its logic (it is a
  re-copyable template). Two options that respect that: loop over
  `Dockerfile* Containerfile*` and cross-check every ARG found — best done
  upstream in dev-hooks so every repo gets it — or, locally, add `Dockerfile.dev`
  to `hk.pkl:33`'s glob and a two-line repo-specific assertion that
  `Dockerfile.dev`'s `ARG NODE_VERSION` equals `.node-version`.

### 🟡 I9 — nothing builds the Docker image in CI

- **Class:** NEW
- **Where:** `.github/workflows/ci.yml` (eight jobs, none of them `docker build`)
- **Finding:** the pipeline runs prettier, exec-bits, versions, gitleaks,
  actionlint+zizmor, vitest+eslint, chromium e2e and the audits. The production
  image is exercised only by `kamal deploy`, which builds locally on the
  operator's machine. The fix pass just rewrote `.dockerignore` substantially
  (adding `e2e-tests`, `playwright.config.ts`, `plans`, `docs`, `.github`,
  `.claude`) — and its own commit message records that the first attempt at
  exactly that broke `next build`:

  > `playwright.config.ts` has to go with `e2e-tests/`, not merely alongside it:
  > tsconfig includes `**/*.ts` and the config imports `./e2e-tests/env`, so
  > dropping the tests without it fails `next build` at the type-check step. The
  > first build attempt did exactly that, which is the only reason this is right.

- **Impact:** a `.dockerignore` or Dockerfile change that breaks the image is
  discovered mid-deploy, on the machine deploying, with the site's current
  version already being replaced. Combined with I4, the image has two failure
  modes nothing in CI would see.
- **Fix:** add a `docker` job that runs
  `docker build --build-arg NEXT_PUBLIC_GOOGLE_CLIENT_ID=ci-placeholder -t impamp3:ci .`
  and then `docker run -d -e IMPAMP_DB_PATH=/data/impamp.db …` plus a `curl -fsS
localhost:3000/up`. It is a few minutes and it is the only gate on the artefact
  that actually ships.

---

## 🟢 Low

### 🟢 I10 — CLAUDE.md says two upgrades are deferred; there are three

- **Class:** NEW
- **Where:** `CLAUDE.md:143-146` vs `plans/deferred-upgrades.md:6-17` and
  `.github/dependabot.yml`
- **Finding:** CLAUDE.md names TypeScript 7 and ESLint 10.
  `plans/deferred-upgrades.md` documents a third — `file-selector` held at 4.1.0
  so it stays deduped under `react-dropzone` — and `dependabot.yml` correctly
  ignores all three. `npm outdated` shows exactly those three and nothing else:

  ```
  Package        Current  Wanted  Latest
  eslint          9.39.5  9.39.5  10.8.1
  file-selector    4.1.0   4.1.0   5.0.0
  typescript       6.0.3   6.0.3   7.0.2
  ```

- **Impact:** an agent told "two are deferred" and shown three outdated packages
  concludes `file-selector` is fair game, bumps it, and un-dedupes `fromEvent`
  from the copy react-dropzone calls internally — the precise failure
  `plans/deferred-upgrades.md:6-17` exists to prevent.
- **Fix:** make it "Three upgrades" and name `file-selector` in `CLAUDE.md:143`.

### 🟢 I11 — `docs/cross-browser-e2e.md`'s pass/fail table is from a 64-test suite; it is 126 now

- **Class:** NEW
- **Where:** `docs/cross-browser-e2e.md:18-22` and `:53`
- **Finding:** the table reports chromium 64 passed, firefox 64 local / 17 CI
  failures, webkit 38 failed, and the prose adds "The 26 that pass are the ones
  that never touch audio" (26 + 38 = 64). Measured:

  ```
  $ npx playwright test --project=chromium --list
  Total: 126 tests in 20 files
  ```

  `e2e-tests/README.md:55` already says "None. The chromium suite is 126/126",
  so two docs give different numbers for the same suite. The document does pin
  its date and commit (`:13-14`, 2026-08-13, `f0486eb`), which makes the body a
  legitimate historical record — but the summary table at `:20` reads as a
  statement of current fact, and the WebKit cascade figure is now certainly
  larger than 38.

- **Fix:** move the counts into the "measured on 2026-08-13 at `f0486eb`"
  sentence, or re-run and refresh. The _causes_ documented there are still
  correct and should not be re-triaged.

### 🟢 I12 — `ci.yml` has no `concurrency:` group

- **Class:** NEW
- **Where:** `.github/workflows/ci.yml:6-13`
- **Finding:** zizmor is clean at the default persona but flags this at
  `--persona=pedantic`:

  ```
  help[concurrency-limits]: insufficient job-level concurrency limits
    --> .github/workflows/ci.yml:6:1
    | workflow is missing concurrency setting
  9 findings: 8 informational, 1 low, 0 medium, 0 high
  ```

  (The other 8 are `anonymous-definition` — jobs without a `name:` — which is
  cosmetic.)

- **Impact:** two pushes in quick succession run two complete pipelines,
  including two chromium e2e jobs. Historic runs show 2–19 minutes each, so this
  is real Actions time on a repo that already trimmed the cross-browser job for
  exactly that reason.
- **Fix:**
  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  ```

### 🟢 I13 — `docker-compose.yml`: no healthcheck, and the `DEV_PORT` comment contradicts its own default

- **Class:** NEW
- **Where:** `docker-compose.yml:4-19` and `:34`
- **Finding:** CLAUDE.md advertises "Health check endpoint at `/up`" and
  `src/app/up/route.ts` implements it, but the compose `app` service declares no
  `healthcheck:`, so `docker compose ps` reports a wedged container as healthy.
  Separately, `:34` reads
  `- "${DEV_PORT:-3000}:3000" # Map to host port specified by DEV_PORT env var (default: 3002)`
  — the default is 3000, the comment says 3002.
- **Fix:** add
  `healthcheck: {test: ["CMD","node","-e","fetch('http://localhost:3000/up').then(r=>process.exit(r.ok?0:1))"], interval: 30s, timeout: 5s, retries: 3}`
  and correct the port comment.

### 🟢 I14 — `check_action_refs.sh` runs only in CI, not in the pre-commit hook

- **Class:** NEW
- **Where:** `.github/workflows/ci.yml:219-223`, `hk.pkl:6-86`
- **Finding:** the script exists now and works —

  ```
  $ bash scripts/check_action_refs.sh
  ✓ every action is SHA-pinned, and each resolves to one SHA
  ```

  — but it is invoked from the CI `audit` job only. `hk.pkl` has no step for it,
  while every other gate in that file is explicitly justified as mirroring CI.
  The workflow-file steps that _do_ run locally (`actionlint`, `zizmor`) do not
  flag a tag-pinned action at the default persona.

- **Impact:** the drift the script was written to catch (three actions at two
  SHAs each) is caught one push later than it could be. Small, but it is the one
  asymmetry left in a file whose stated design is that the gates cannot drift.
- **Fix:** add a `["action-refs"]` step to `hk.pkl`'s `linters` mapping globbed
  to `.github/workflows/*.yml` running `bash scripts/check_action_refs.sh`.

### 🟢 I15 — `.dockerignore` claims to mirror the gitleaks allowlist; `fnox.toml` is in neither

- **Class:** NEW
- **Where:** `.dockerignore:55-69`, `.gitleaks.toml:21-31`
- **Finding:** the comment states the list "mirrors `.gitleaks.toml`'s allowlist
  on purpose: both files are answering the same question — which gitignored
  local artifacts are here and what is in them". `fnox.toml` is a gitignored
  local artifact holding the names of every secret this project uses, and it
  appears in neither file. `COPY . .` at `Dockerfile:17` therefore tars it into
  the build context and writes it into a builder-stage layer and the build cache.
  It contains references only, never values —

  ```
  KAMAL_REGISTRY_PASSWORD = { provider = "bws-general", value = "kamal-registry-password" }
  ```

  — so this is not a leak, and multi-stage means it never reaches the published
  image. It is the same category as `certificates/` and `data/`, which the fix
  pass did add.

- **Fix:** add `fnox.toml` to `.dockerignore`'s gitignored-artifacts block. (Its
  absence from `.gitleaks.toml` is correct and should stay: a reference file
  should be scanned, precisely so a real value pasted in gets caught.)

---

## ✅ Verified clean — checked, and holding

Recorded so the next review does not spend budget re-deriving these.

**CI supply chain.** Every `uses:` in `ci.yml` is a 40-hex SHA with a version
comment; `scripts/check_action_refs.sh` exists, does what its name says
(SHA-pinning **and** one-SHA-per-action), and exits 0. `permissions: contents:
read` is set workflow-wide with no job widening it. Every `checkout` sets
`persist-credentials: false`. No `pull_request_target`. No untrusted expression
reaches a `run:` — `matrix.browser` is correctly passed through `env:` and
referenced as `"$BROWSER"`. `actionlint -shellcheck=` exits 0; `zizmor
--no-progress .github/workflows/` reports **no findings** (and also none over
`.github/` including `dependabot.yml`).

**Dependencies.** `npm audit` and `npm audit --omit=dev --audit-level=high` both
report **0 vulnerabilities**. All three deferrals in
`plans/deferred-upgrades.md` were re-checked against their own retry conditions
and **all three still hold**, verified against the registry rather than from
memory:

| Deferral        | Retry condition                                        | Registry today                                                                                    |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| eslint 10       | `eslint-plugin-react` ships a stable ESLint 10 release | latest is still `7.37.5`, peer `eslint: ^3 \|\| … \|\| ^9.7`; `7.8.0-rc.0` remains on `next` only |
| typescript 7    | `typescript-eslint` supports TS ≥ 7.1                  | latest is `8.67.0`, peer `typescript: >=4.8.4 <6.1.0` — TS 7 still excluded                       |
| file-selector 5 | react-dropzone widens its range                        | `react-dropzone@20.1.0` still depends on `file-selector: ^4.1.0`                                  |

That file needs no edit. `.github/dependabot.yml` exists, covers npm and
github-actions, groups minor+patch, applies a 7-day cooldown and ignores exactly
the three deferred majors — correct on every point.

**Secrets.** `gitleaks git --redact` over all 468 commits: `no leaks found`. No
`.env`, `certificates/` or `data/` path has ever been added in history (`git log
--all --diff-filter=A --name-only` returns only `.env.dist`). `.kamal/secrets`
holds `$`-references only. `.env.dist`'s values are all empty.
`e2e-tests/env.js`'s `E2E_SIGNIN_SECRET` only enables the test sign-in route; `config/deploy.yml`
never sets `IMPAMP_E2E_SIGNIN_SECRET`, and `e2e-tests/` is excluded from the
Docker build context.

**Version pinning.** `bash scripts/check_version_sync.sh` exits 0 and confirms
node 24.19.0 across `.node-version`, `mise.toml` and the Dockerfile ARG.
`mise.lock` is tracked, `lockfile = true`, `minimum_release_age = "4d"`. `hk.pkl`
amends a pinned `hk@1.47.0`.

**Previously-reported items now genuinely fixed.** I1 root user (`Dockerfile:55`
`USER node`) · I2/I3 action-pin drift and the missing script · I5 eslint+vitest
now in `hk.pkl:47-57` · I6 `npm audit` in CI (`ci.yml:214-218`) and dependabot ·
I7 the debug `echo` is gone · I8 the single-instance constraint is at
`config/deploy.yml:9-14` · I9 patch bumps landed (`@zip.js/zip.js` 2.8.51, next
16.3.1) · S4 `.dockerignore` now excludes `.worktrees`, `certificates`, `data`,
`playwright-report` · L8's `.env.example`→`.env.dist` negation, the
`docker-compose.yml` `version:` key, README's Node floor / `pwa-usage-guide.md`
link / `LICENSE` spelling / missing features and Vitest, and CLAUDE.md's
contradictory "Pinned Versions" list · L10 (`eslint .` reports 0 errors on
tracked files; the `argsIgnorePattern: "^_"` is configured) · TH7 (the
`e2e-tests/README.md` known-failures table is rewritten and honest).

**Version tables are accurate.** Every number in `CLAUDE.md:132-141` and
`README.md:219-228` was checked against `package-lock.json`: next 16.3.1,
typescript 6.0.3, vitest 4.1.10, @playwright/test 1.62.1, prettier 3.9.6, eslint
9.39.5, eslint-config-next 16.3.1, zustand 5.0.15, idb 8.0.3, react 19.2.8,
react-dropzone 20.1.0, tailwindcss 4.3.3. All six `npm run test:e2e:*` scripts
named in CLAUDE.md exist in `package.json:18-24`, `npm run lint` is `eslint .`,
and `npm start` is `node scripts/start-standalone.js`, which does serve
`.next/standalone/server.js` and does translate `--port` into `PORT`.
`docs/sync-strategies-investigation.md` carries a clear `**Status:** Decided`
header and is cross-referenced from two live docs — it is a sound historical
record, not drift.
