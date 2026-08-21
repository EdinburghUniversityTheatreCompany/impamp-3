# State of play — 2026-08-21

The 2026-08-17 whole-repo review is **fully answered**: every 🔴 and the
🟡 tail are closed. `plans/repo-review-2026-08-17.md` is the report and
`plans/review-2026-08-17/` the per-axis detail; both are now history rather
than a worklist.

**This is deployed.** `impamp.bedlamtheatre.co.uk` runs the current `main`,
and the Help modal reports its own commit (`0.42.0-<sha>`), so what is live
can be read off the app rather than asked of the host over SSH.

## Gates on `main`

1167 unit tests in 128 files · 182 chromium e2e in 37 files · coverage
54.48 / 46.39 / 51.27 / 55.19 against a 53 / 45 / 50 / 54 ratchet ·
typecheck, eslint, prettier, jscpd 0%, version-sync, action-pins, actionlint,
zizmor, gitleaks all clean · the production image builds, boots, and is
asserted to carry its own commit hash.

**Running e2e:** always `E2E_PORT=<free port>`. Port 3000 is often held by
another project of Mick's, and `reuseExistingServer` does not check _what_ is
listening — a collision reports every test failing. Never read a piped
`tail`/`grep` as the verdict; redirect to a file and echo `$?`. A passing run
prints almost nothing now that `flaky-reporter.ts` is the reporter, so
"no output" and "nothing ran" look identical.

## Open

1. **A teardown-flake class, and it can redden CI.** `npm run test:coverage`
   exited 1 once today with three
   `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
   from `db.hashlessIndex.test.ts`, while all 1167 tests passed. Cause is the
   family this session already fixed twice: `addAudioFile` fires loudness
   analysis fire-and-forget, and its console output outlives the test file.
   Seven suites call `addAudioFile` without mocking the pipeline —
   `db.hashlessIndex`, `db.orphanCleanup`, `importExport.zip`,
   `importExport.hostedAudio`, `googleDrive/sync.hashVerification`,
   `googleDrive/dataAccess.gain`, `googleDrive/dataAccess.hashKeyed`. Three
   others already mock it, which is the fix. Not reproducible in isolation
   (0/5), so treat frequency as unknown rather than low.
2. **The 145 commits since the review have never been reviewed.** Much of it
   was written fast and in parallel. Two real bugs surfaced from it today by
   accident, not by looking. A **diff review against the review's baseline**
   is the high-yield move; another whole-repo sweep is not.
3. **`plans/off-topic-improvements.md`** — 8 items, none urgent. Two are real
   bugs: a renamed profile never converges and the conflict modal misreports
   it; `RadioGroup`'s `aria-labelledby` points at an id nothing renders.
4. **Deferred upgrades** stay deferred, with conditions in
   `plans/deferred-upgrades.md`: TypeScript 7, ESLint 10, file-selector 5.
   These are exactly the three `npm outdated` rows and the three dependabot
   ignores — if you see three outdated packages, none is fair game.

## Not ours to touch

- **`feat/audio-dedup-and-bank-transfer`** is another session's live work
  (`addOrReuseAudioFile`, absent from `main`). It was 57 commits behind and is
  now 1, so that session is actively merging. Leave it alone; it merges itself.
- Several stale `origin/claude/*` branches from cloud sessions. No open PRs.

## Mick's calls

- **`IMPAMP_ALLOWED_EMAILS`** is still commented out in `config/deploy.yml`,
  so **any** Google account can sign in and store profiles on the public host.
  Unchanged by any deploy this session — it has always been this way — but it
  is the one open item with a security consequence.
- **SV8 / SV9** — rate limiting and per-account quotas. Declined deliberately:
  the quota numbers _are_ the policy, and a per-IP limiter has to know which
  proxy header to trust behind Kamal.
