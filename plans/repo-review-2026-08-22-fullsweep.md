# Whole-repo review — 2026-08-22 (full sweep)

> **Status: all fourteen findings fixed on `review/fullsweep`, 2026-08-23.**
> Each landed as its own commit with its own reasoning. Two claims in the
> original report turned out to be wrong and are corrected in place, flagged
> **[corrected]** — both were found by trying to implement the fix, which is
> the argument for fixing a review rather than filing it.

Stack-agnostic whole-repository health check (`dev-hooks:repo-review`), run at
`40e39b0` on a clean tree. Distinct from the phase-7 / phase-8 / subsystems
reviews already in `plans/`: those were scoped sweeps, this is the full axis set
(correctness, smells, performance, architecture, app security, test health,
dev-env, dependencies, CI supply-chain, secrets, accessibility, docs).

Everything below was verified by running the command or reading the cited line.
No finding is reported from memory.

## What was run

| Gate                                         | Result                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run typecheck`                          | exit 0                                                                              |
| `npm run lint`                               | exit 0                                                                              |
| `npm test`                                   | **1586 passed / 166 files**, 9.2 s                                                  |
| `npm run test:coverage`                      | 61.9 % st / 54.5 % br / 58.9 % fn / 62.8 % ln — all above the ratchet (60/52/57/61) |
| `npm run test:e2e` (2 workers, CI's setting) | **201 passed**, 2.0 m, zero retries                                                 |
| `npm audit` (with and without dev)           | 0 vulnerabilities                                                                   |
| `npm outdated`                               | 1 in-range patch; 2 deliberately deferred majors                                    |
| `scripts/check_version_sync.sh`              | node 24.19.0 consistent across all four files                                       |

Every version claim in `CLAUDE.md` ("Key package versions") was checked against
`node_modules` and **all thirteen match**. The preflight's `has_tests=0` and its
"4 sub-projects" are both false positives — tests are colocated `src/**/*.test.ts`
plus `e2e-tests/`, and the sub-projects are `.next/` build artifacts.

---

## 🟡 1. The `Sec-Fetch-Site` gate is forgeable by any non-browser client, and nothing anywhere is rate-limited

- **Where:** [src/app/api/drive/proxyUtils.ts:66](../src/app/api/drive/proxyUtils.ts#L66); consumers at [public-audio/route.ts](../src/app/api/drive/public-audio/route.ts) and [public-file/route.ts](../src/app/api/drive/public-file/route.ts).
- **Finding.** `isSameHostRequest` returns `request.headers.get("sec-fetch-site") === "same-origin"`. Its docstring argues:

  > `Sec-Fetch-Site` is the header that actually answers the question […] It cannot be set by page script, so a caller that wants to claim same-origin has to actually be same-origin.

  The first half is true; the conclusion does not follow. "Cannot be set by page script" is a statement about _browsers_. A non-browser client sets it freely — `curl -H 'Sec-Fetch-Site: same-origin'` satisfies this gate exactly as `curl -H 'Referer: …'` satisfied the `Referer` check that was removed **for that precise reason**. The comment even states the removal rationale ("`Referer` is set by the caller: one curl satisfied it") without noticing it applies verbatim to the replacement.

  What sits behind the gate, by the docstring's own accounting: routes that are _"unauthenticated, unrate-limited, serve up to 100 MB, and spend the deployment's own `GOOGLE_API_KEY` doing it."_

  And the second half is repo-wide. A grep for rate limiting across `src/app/api` and `src/lib/server` returns **no implementation at all** — only three comments and a prior review's unimplemented suggestion ("at minimum rate-limit `upload-url` per user", `repo-review-2026-08-22-subsystems.md:295`).

- **Impact.** Google API quota exhaustion and bandwidth/cost amplification against `impamp.bedlamtheatre.co.uk`, from an unauthenticated caller, at 100 MB per request. Worse, this gate is load-bearing for _other_ accepted risk: `repo-review-2026-08-22-subsystems.md:393-398` downgrades the `isAllowedAudioType` content-type finding to 🟢 on the grounds that it is _"largely blocked by the `Sec-Fetch-Site` gate."_ If the gate does not hold against a scripted caller, that downgrade does not hold either.
- **[corrected] The limit first proposed was too tight.** 60 requests / 5 minutes would have refused a legitimate first load of any shared board over 60 sounds, because `public-audio` is called **once per sound**. Shipped at 600 / 5 minutes, with a test pinning it above a 300-sound board so a later "tightening" fails rather than breaking a venue.
- **Fix.** Treat the header as what it is — a cheap filter against _cross-origin browser_ abuse, not an authorisation control — and correct the docstring so the next reader does not lean on it again. Put the real bound underneath: per-IP and per-session rate limiting on both proxies (and on `upload-url`, still outstanding from the earlier review). Since the app is documented single-instance, an in-process token bucket is sufficient and needs no new dependency.

## 🟡 2. `fetchWithTimeout` only times out the headers, never the body

- **Where:** [src/lib/fetchWithTimeout.ts:82-99](../src/lib/fetchWithTimeout.ts#L82-L99).
- **Finding.** The timer is cleared in a `finally` attached to `return await fetch(...)`:

  ```ts
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limit);
  try {
    return await fetch(input, { ...init, signal: controller.signal }); // resolves at headers
  } finally {
    clearTimeout(timer); // …and disarms here
  }
  ```

  `fetch` resolves as soon as response **headers** arrive. The body is still unread at that point, and `clearTimeout` has already disarmed the abort. So `await response.text()`, `await response.blob()`, and a streamed `response.body` all run with **no deadline whatsoever** — a server that sends headers and then stalls the body hangs the caller forever.

  That is exactly the failure the module was written to prevent, and it is uncovered for the largest transfers in the app. [public-audio/route.ts:133](../src/app/api/drive/public-audio/route.ts#L133) pipes `mediaResponse.body` — up to `MAX_AUDIO_BYTES` (100 MB, line 25) — straight into the response with the timer already disarmed. The module's own docstring names the two client-side promise caches (`serverSync/sync.ts`, `serverAudio/transfer.ts` `??=`) that turn one such hang into permanent breakage for the session; both reach it through body reads.

- **Compounding.** [public-audio/route.ts:124](../src/app/api/drive/public-audio/route.ts#L124) calls `fetchWithTimeout(mediaUrl)` with **no `timeoutKind`**, so a potential 100 MB transfer takes the `control` tier (10 s) rather than `transfer` (120 s). That is currently harmless _only because of the bug above_ — the 10 s bounds headers only. Arming the timer across the body without also fixing the tier would start cancelling legitimate large downloads at 10 s.
- **Fix.** Clear the timer when the body settles, not when the headers do — wrap the response so `clearTimeout` fires on body completion/abort, or keep a separate body-phase deadline. Fix both halves together, and pass `timeoutKind: "transfer"` at the `public-audio` media fetch.

## 🟡 3. The SSE endpoint has no connection cap, and every open stream runs synchronous SQLite on a heartbeat

- **Where:** [src/app/api/profiles/\[id\]/events/route.ts:106-116](../src/app/api/profiles/[id]/events/route.ts#L106-L116).
- **Finding.** Each connection installs a 25 s interval that re-authorises:

  ```ts
  open.heartbeat = setInterval(() => {
    if (loadAuthorizedProfileMeta(request, id) instanceof NextResponse) {
      cleanup();
      return;
    }
    send(`: keep-alive\n\n`);
  }, HEARTBEAT_MS);
  ```

  `loadAuthorizedProfileMeta` → `authorizeProfileRequest` → `resolveAccess` issues up to three queries (owner lookup, email share, link share) plus `getProfileMeta` — roughly **four synchronous `node:sqlite` queries per connection per 25 s**. Re-checking is correct and deliberate (it is what revokes a withdrawn share mid-stream); the gap is that nothing bounds how many connections one caller may hold.

  The endpoint is reachable **anonymously**: `resolveAccess` grants on a link token with no account, so a holder of any view-only share link — a URL that by design circulates — can open streams without signing in. There is no per-user, per-IP or global cap, and no rate limiting (finding 1).

- **Impact.** `node:sqlite` is synchronous and the app is documented single-instance, so these queries run on the same thread serving every other request. N idle connections cost 4N blocking queries per heartbeat window; the 30-minute `MAX_STREAM_MS` bounds a connection's life but not their number, and `EventSource` reconnects automatically. Degradation is silent — the board keeps working, collaboration latency just decays back toward the polling fallback.
- **Fix.** Cap concurrent streams per session/IP (and globally), refusing the excess with 429. Cheaper still: cache the authorisation decision for a few heartbeats, or drop it to a subset of ticks, so revocation latency stays bounded without paying four queries per stream per 25 s.

## 🟡 4. No Content-Security-Policy — and this app is unusually cheap to give one

- **Where:** [next.config.ts:57-103](../next.config.ts#L57-L103).
- **Finding.** The `headers()` block sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: strict-origin-when-cross-origin`, plus `Cache-Control: no-store` on the API. A grep across `next.config.ts`, `config/`, `docker-compose.yml` and `public/` for `content-security-policy`, `strict-transport-security` and `permissions-policy` returns **nothing**. `config/deploy.yml:27-29` terminates TLS at kamal-proxy (`ssl: true`), which does not add HSTS on its own.
- **Impact.** CSP is the main defence-in-depth control against XSS, and this app has an unusual reason to want one: it serves **third-party bytes from its own origin** through the Drive proxies. `nosniff` is on those responses, but CSP is the layer that contains anything that does get through.
- **[corrected] "Zero third-party scripts" was wrong.** That came from grepping this repo's own source for `next/script` and `<script>`, which finds nothing — but `@react-oauth/google` injects `https://accounts.google.com/gsi/client` into the page at runtime, and `connect-src` additionally needs the object-store host, configured per deployment. Both were found only by reading a dependency's dist and an env-var contract. The finding stands (there was no CSP); its "a strict policy is cheap here" rationale does not, and it is the strongest possible argument for having shipped Report-Only. No `dangerouslySetInnerHTML` or `.innerHTML` in `src/`, which does hold.
- **Fix.** Add `Content-Security-Policy` (start `default-src 'self'; script-src 'self'; connect-src 'self' https://www.googleapis.com; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'`, then reconcile with Next's inline hydration via nonce or hash), plus `Strict-Transport-Security` and a minimal `Permissions-Policy`. Report-Only first to catch what the build actually needs. → [[github-actions]] is not the owner here; this is a one-file change in `next.config.ts`.

## 🟡 5. Audio uploads are strictly sequential while downloads are 4-way concurrent

- **Where:** [googleDrive/sync.ts:177-208](../src/lib/googleDrive/sync.ts#L177-L208) (`uploadMissingAudioFiles`) and [googleDrive/sync.ts:73](../src/lib/googleDrive/sync.ts#L73) (`repairDriveAudioFiles`); [serverAudio/transfer.ts:261](../src/lib/serverAudio/transfer.ts#L261) (`downloadProfileAudio`). Contrast [importExport.ts:1342](../src/lib/importExport.ts#L1342), `DRIVE_DOWNLOAD_CONCURRENCY = 4`, and the worker pool at [importExport.ts:613-629](../src/lib/importExport.ts#L613-L629).
- **Finding.** The Drive _download_ path deliberately runs a bounded worker pool. The Drive _upload_ path is a bare `for` loop with `await uploadAudioFile(...)` inside — one full network round trip per sound, strictly serialised. The hosted-audio download loop in `serverAudio/transfer.ts` is likewise sequential (presign request + transfer per sound, one at a time).

  The upload loop was already optimised once, for a different cost: the comment at lines 170-175 records fixing "a 960-sound board did 960 sequential reads per sync." The _reads_ were fixed by batching metadata; the 960 sequential **network uploads** underneath were left.

- **Impact.** First sync of a large board is latency-bound at N × round-trip. At a conservative 400 ms per upload, a 960-sound board is roughly six minutes of serialised network wait — during which the sync holds `withAudioImportInProgress`, which by design blocks every orphan sweep and audio deleter.
- **Fix.** Reuse the existing pool shape from `importAudioSources` rather than writing a third one. A shared `mapWithConcurrency(items, n, fn)` helper would cover all three sites; note `.jscpd.json` runs at threshold 0, so a hand-rolled third copy would fail the commit anyway.

## 🟡 6. `db.ts` is a 2757-line, 68-export module that 52 other modules import

- **Where:** [src/lib/db.ts](../src/lib/db.ts).
- **Finding.** Measured: 2757 lines, 67 exported symbols, imported by 52 non-test modules. It holds at least eight separable concerns — the IndexedDB schema and every domain type; connection and migrations; `audioFiles` CRUD; `profiles` CRUD; `padConfigurations` CRUD; `pageMetadata`/bank CRUD; orphan discovery and cleanup sweeps; missing-audio repair and profile duplication — **plus a cross-cutting concurrency primitive** (`withAudioImportInProgress` / `beginAudioImport` / `settleAudioImports`, lines 1388-1478).

  That last one is the reason this is 🟡 rather than 🟢. The audio-import register is the repo's most dangerous invariant — `CLAUDE.md` devotes its single longest paragraph to it, names ten writers and five deleters, and states plainly that _"there is no type and no lint rule behind any of this"_ and that a writer must be found by "grepping the callers of `addOrReuseAudioFile`". A safety primitive whose only enforcement is prose is harder to keep correct when it lives inside the same file as forty CRUD helpers, and the file is the default import for the whole app.

- **Verified working today.** I traced all nine production `addOrReuseAudioFile` call sites and all five deleters. **Both sides are correctly swept** — every writer is inside a scope (`EditPadForm` via `EditPadModalContent`'s `beginAudioImport` hold, `dataAccess.ts` via all four sync/conflict entry points, `transfer.ts` via `syncServerProfile`, and the rest wrapped directly), and every deleter awaits `settleAudioImports()`. The related layering invariants also hold: `layersByBase` is written from exactly two call sites, [playback.ts:431](../src/lib/audio/playback.ts#L431) (`clearTrackState`) and [playback.ts:494](../src/lib/audio/playback.ts#L494) (`claimPlaybackKey`), as documented; `getStrategy` is called once, keyed on `baseKey`. **This finding is about the structure that makes that correctness expensive to maintain, not about a current break.**
- **Fix.** Extract the register into its own module (`src/lib/audioImportRegister.ts`) so the primitive has a name and a boundary, then split the CRUD by store. Extracting the register first is the high-value half and is nearly mechanical. → [[thinking-tools:codebase-design]] for the split; not `/simplify`, which works at a smaller altitude.

---

## 🟢 7. `addAudioFile` uses `??` where `addOrReuseAudioFile` uses `||` — the drifted twin of a documented fix

- **Where:** [db.ts:792](../src/lib/db.ts#L792) vs [db.ts:1038](../src/lib/db.ts#L1038).
- **Finding.** 246 lines apart in one file, the same expression, opposite operators. The corrected copy carries the explanation:

  ```ts
  // db.ts:1037 — addOrReuseAudioFile
  // `||` rather than `??`: an empty string is a missing hash, not a key to
  // store rows under. See `findAudioFileIdByHashIn`.
  const hash = audioFile.hash || (await computeBlobHash(audioFile.blob));

  // db.ts:792 — addAudioFile, no comment
  const hash = audioFile.hash ?? (await computeBlobHash(audioFile.blob));
  ```

  With `??`, `addAudioFile({ hash: "", … })` stores a row keyed on `""`. This is precisely the shape `CLAUDE.md` names ("a missing or empty hash must mean 'no match', never 'any match'", found three times already) and precisely the retrieval method the project memory prescribes — _the fixed copy carries the explanatory comment, so grep it to find the unfixed twin_. It also connects to the still-open 🟢 12 in `repo-review-2026-08-22-subsystems.md`, where a stored `hash: ""` makes `createHashlessAudioIndex` skip the entire library.

- **Impact today: none.** I checked every caller — `addAudioFile` has **zero production callers**; all ~60 are `.test.ts`/`.test.tsx`. It survives deliberately as the one writer that can still make a duplicate, which the dedup tests need.
- **Fix.** Change `??` to `||` and carry the comment across. One character, and it removes a live trap from the seam the dedup suite is built on.

## 🟢 8. `Modal.tsx` justifies its focus trap with behaviour that was removed

- **Where:** [Modal.tsx:99-101](../src/components/Modal.tsx#L99-L101) vs [useKeyboardListener.ts:225](../src/hooks/useKeyboardListener.ts#L225).
- **Finding.** Modal says: _"`useKeyboardListener` suppresses Tab app-wide but bails while any overlay is open."_ The listener says: _"Tab is deliberately **not** suppressed here any more."_ `CLAUDE.md` records the removal and why (app-wide suppression "cost the header, the bank tabs and the profile selector every keyboard route in").
- **Impact.** The trap itself is correct and still required — it is now the _only_ thing keeping Tab inside a dialog, which makes it more load-bearing than the comment claims, not less. The risk is a future reader trusting a stale premise while editing focus handling.
- **Fix.** Rewrite the comment to state the current reason.

## 🟢 9. `AudioAdminPanel` uses bare `fetch` on one call and `fetchWithTimeout` on another, in the same file

- **Where:** [AudioAdminPanel.tsx:41](../src/components/audio/AudioAdminPanel.tsx#L41) vs [AudioAdminPanel.tsx:69](../src/components/audio/AudioAdminPanel.tsx#L69).
- **Finding.** The file imports `fetchWithTimeout` at line 5 and uses it for the PATCH at line 69, but the GET at line 41 is a bare `fetch("/api/admin/audio")`. `fetchWithTimeout`'s docstring says all 49 outbound calls were converted; this one was missed, and it is the only bare outbound `fetch` left in `src/` (the other grep hit, `importExport.ts:191`, is a deliberate `data:` URL decode, documented as such).
- **Impact.** Low — an admin panel GET that hangs leaves a spinner; it is not one of the cached-promise sites that turn a hang into permanent breakage.
- **Fix.** Use the wrapper already imported one line above.

## 🟢 10. `escapeDriveQueryValue` has four call sites and no test

- **Where:** [googleDrive/api.ts:25](../src/lib/googleDrive/api.ts#L25); call sites at lines 251, 550, 584 (twice).
- **Finding.** The sole escape preventing Drive query injection from a user-controlled file or bank name. The implementation is correct — it escapes backslash before apostrophe, which is the order that matters — but no test in `src/lib/googleDrive/*.test.ts` references it, so the ordering is unpinned.
- **Impact.** Low: the query runs against the user's _own_ appData scope with their own token, so a malformed name breaks their own query rather than crossing a trust boundary. It is a correctness/robustness gap, not a privilege one.
- **Fix.** Three assertions (apostrophe, backslash, backslash-before-apostrophe) in a new `api.queryEscaping.test.ts`.

## 🟢 11. Roughly fifteen symbols are exported but used only inside their own module

- **Where:** verified individually — `syncReplay.ts` (`replaySyncOutcome`, `fanOutSyncCallbacks`), `bankSummaries.ts` (`summariseBanks`), `googleDrive/api.ts` (`escapeDriveQueryValue`, `getOrCreateAppFolder`), `googleDrive/utils.ts` (`getSyncTimestampKey`), `server/s3/client.ts` (`parseListObjectsV2`), `server/audioSweep.ts` (`SWEEP_LIMITS`), `db.ts` (`DEFAULT_BANK_COUNT`), `importExport.ts` (`MAX_JSON_IMPORT_BYTES`), `useConnectDriveProfile.ts` (`isDriveProfileData`), `useGoogleSignIn.ts` (`GOOGLE_DRIVE_SCOPE`), `audio/loudness/analyseOffThread.ts` (`LOUDNESS_WORKER_TIMEOUTS`, `LoudnessWorkerTimeoutError`), `testHooks.ts` (`e2eHooksEnabled`).
- **Finding.** None is dead — each is referenced within its defining file — but none is referenced _outside_ it either, including from tests. They widen each module's public surface without a consumer.
- **Impact.** Minor: a wider surface is more to keep stable, and it obscures which exports are real API. Note the flip side — several are unexported _and_ untested, which is how finding 10 stayed invisible.
- **Fix.** Drop `export` where nothing needs it. Keep it where a test would reasonably want the seam, and add the test.

## 🟢 12. Twelve infinite animations, no `prefers-reduced-motion` opt-out

- **Where:** `animate-spin` (9 uses) and `animate-pulse` (3) across `src/components`; a grep for `prefers-reduced-motion` / `motion-reduce` across `src/**/*.tsx` and `src/app/globals.css` returns **nothing**.
- **Impact.** WCAG 2.2 SC 2.3.3. Both are indefinite loops, which is the category that affects vestibular sensitivity. Low severity — they are small spinners and pulses, not large-area or parallax motion — but this is a live-performance tool whose operators are under load.
- **Fix.** Tailwind ships the variant: `motion-reduce:animate-none` on the twelve, or one global `@media (prefers-reduced-motion: reduce)` rule in `globals.css`. → [[accessibility]].

## 🟢 13. One in-range dependency patch is available

- **Where:** `npm outdated`.
- **Finding.** `@zip.js/zip.js` 2.8.55 → 2.8.57 (wanted and latest agree, so in-range). The other two rows are `eslint` 9→10 and `typescript` 6→7, both deliberately deferred with reasons and retry conditions in `plans/deferred-upgrades.md` and both scoped as majors in `.github/dependabot.yml`. `npm audit` reports 0 vulnerabilities with and without dev dependencies.
- **Fix.** `npm update @zip.js/zip.js` — the tool `CLAUDE.md` specifies, not `npm install pkg@version`. Read the release notes first: the react-dropzone 20.1.1 lesson (a "docs fix" that swapped a transitive major) is from this same day. → [[dependency-upgrade]].

## 🟢 14. One e2e fixture is written as `tour-guard.wav.wav`

- **Where:** [e2e-tests/welcome-tour.spec.ts:90](../e2e-tests/welcome-tour.spec.ts#L90); helper at [test-helpers.ts:244](../e2e-tests/test-helpers.ts#L244).
- **Finding.** `createTestAudioFilePath` appends `.wav` itself (`path.join(tempDir, fileName + ".wav")`), so callers pass a bare name. This one passes `"tour-guard.wav"`, producing a doubled extension — visible in the run log. It is the only such caller of 30-odd.
- **Impact.** Cosmetic. The fixture is still distinct (`toneHzFor` hashes the whole name) and the spec does not assert on the filename, so it passes. It would bite a future assertion on the displayed pad name.
- **Fix.** Pass `"tour-guard"`.

---

## What is in good shape

Recorded because a review that lists only problems misrepresents the repo, and
because several of these are places a reviewer would otherwise re-derive:

- **Secrets.** No plaintext secrets in tracked files. Every hit from the credential grep is a test fixture with a self-documenting name (`"share-token-that-must-not-travel"`, `"e2e-not-a-real-secret"`). `.env*` is gitignored with an `!.env.dist` exception, `/data/` is ignored, `.kamal/secrets` holds fnox references, and reading `.env*` is blocked by permission settings — the right posture.
- **CI supply chain.** All 18 `uses:` are SHA-pinned with version comments. Default `permissions: contents: read`. No `pull_request_target`, no `github.event.*` interpolation. Nine jobs including dedicated `gitleaks`, `actions-lint` (actionlint + zizmor) and `audit`.
- **Dev-env.** `DEV_ENV_VERSION = "24"` (current), hk running prettier / eslint / vitest / tsc / jscpd / actionlint / zizmor / gitleaks / large-file checks. `scripts/check_version_sync.sh` cross-checks node across `.node-version`, `mise.toml` and **both** Dockerfiles.
- **SQL and injection.** Every server query is parameterised. The one interpolation, [server/db.ts:321](../src/lib/server/db.ts#L321), is `PRAGMA user_version = ${version + 1}` — a loop counter, and PRAGMA takes no bound parameters. No `eval`, no `new Function`, no `shell: true`, no `.innerHTML`, no `dangerouslySetInnerHTML`. The two Drive proxies are **not** SSRF: the host is hardcoded and `fileId` is validated `/^[a-zA-Z0-9_-]+$/` before interpolation.
- **Authorisation.** Centralised in `apiAuth.ts` / `profileRequests.ts`. Missing and forbidden both answer 404 so ids stay unenumerable; admin answers 404 too. Session tokens are stored only as SHA-256. `resolveAccess` takes the strongest of several grants and scopes link tokens to their minting profile. The test-only sign-in route is gated on an env var production never sets and 404s otherwise.
- **Hosted audio.** Genuinely careful: quota re-decided from the size the _bucket_ reports, proof-of-possession before granting a reference to bytes someone else uploaded, content-integrity re-hash, and the TOCTOU window explicitly logged rather than papered over.
- **Accessibility.** Better than the raw grep suggests — the 31 `<input>` vs 10 `htmlFor=` gap is wrapping `<label>` elements and `aria-label`/`sr-only`, which I checked individually. Real focus trap with restore in `Modal.tsx`, an `aria-live` announcer, and correct `role` usage throughout.
- **Zero TODO/FIXME/HACK/XXX markers** in ~63k non-test lines, and 8 `any`s, each with an explicit disable comment.
- **Docs.** `CLAUDE.md`'s version table is accurate in all thirteen entries — unusual for a 42k document.

## Summary

This is a healthy, unusually well-documented codebase. Every gate is green
(1586 unit tests, 201 e2e at CI's worker count with zero retries, clean
typecheck/lint, no advisories), coverage sits above its ratchet, and the
invariants `CLAUDE.md` warns are compiler-unenforced — the audio-import
register's two sides, the `layersByBase` two-writer rule, the per-pad strategy
cursor — all actually hold under tracing. Nothing here is a 🔴: no data-loss
bug, no missing authorisation, no exposed secret.

The findings cluster on **the network boundary**, which is the part of the app
that has grown fastest and is least covered by the local-first test strategy.
Fix in this order:

1. **Finding 2** (`fetchWithTimeout` body-read gap) — smallest change, largest
   blast radius, and the only finding that can permanently break a running
   session rather than degrade it. Fix the tier at `public-audio` in the same
   commit; they interact.
2. **Finding 1** (forgeable `Sec-Fetch-Site`, no rate limiting) — do the
   docstring correction immediately even if the rate limiter lands later,
   because a prior review already downgraded a separate finding on this gate's
   strength and that reasoning needs retracting.
3. **Finding 4** (CSP) — a one-file change made cheap by there being no
   third-party scripts to negotiate with. Report-Only first.

Findings 3 and 5 are next; both are load-related and will surface as the server
sync sees more collaborators. Finding 6 (`db.ts`) is the one structural item —
worth doing as an extraction of the audio-import register into its own module,
which is nearly mechanical and puts a boundary around the repo's most
safety-critical invariant. The 🟢 items are all small enough to batch, and 7 is
worth taking with them: it is one character, and it is the drifted twin of a
fix the repo has already made and documented.

---

## What was done

One commit per finding, on `review/fullsweep`.

| # | Finding | Commit |
|---|---|---|
| 2 | Timeout covered only the headers | `fix(fetch): carry the timeout across the body` |
| 1, 3 | Forgeable gate, no rate limiting, no SSE cap | `feat(server): rate-limit the unauthenticated surfaces` |
| 4 | No CSP | `feat(headers): add a Report-Only CSP, HSTS and Permissions-Policy` |
| 5 | Sequential audio transfers | `perf(sync): move audio a few files at a time` |
| 6 | `db.ts` god-module | `refactor(db): give the audio-import register its own module` |
| 7 | `??` vs `\|\|` twin | `fix(db): an empty hash is a missing hash in addAudioFile too` |
| 8 | Stale focus-trap comment | `docs(modal): the focus trap's reason was removed` |
| 9 | Bare `fetch` | `fix(admin): use the timeout wrapper the file already imports` |
| 10 | Untested escaper | `test(drive): pin the query escaper's ordering` |
| 11 | Over-exports | `refactor: stop exporting fifteen symbols` |
| 12 | No reduced-motion | `feat(a11y): honour prefers-reduced-motion` |
| 13 | Dependency patch | `chore(deps): @zip.js/zip.js 2.8.55 -> 2.8.57` |
| 14 | Doubled fixture extension | `test(e2e): stop asking for tour-guard.wav.wav` |

### Three bugs the fixing uncovered

None was in the report; each was found by implementing a fix rather than by
reading.

1. **The SSE stream had no `cancel()`.** Cleanup ran only via the request's
   abort signal, so a teardown that cancelled the response body instead leaked
   the subscription, the heartbeat interval and (once it existed) the
   connection slot. Found by writing the "gives the slot back" test.
2. **The caller's abort listener was detached at the headers**, so a caller
   could not cancel `fetchWithTimeout` mid-body. Found while moving the
   deadline.
3. **`public-audio` used the 10s `control` tier for a 100 MB transfer.**
   Harmless only because the deadline stopped at the headers; arming the body
   without fixing the tier would have cut off working downloads, so the two had
   to change together.

### Verification

On the finished branch, from a cold build:

- `npm run typecheck`, `npx eslint .`, jscpd (0 clones), `check_version_sync.sh` — clean
- `npm test` — **1634 passed**, up from 1586 (+48)
- `npm run test:coverage` — 62.47 st / 54.91 br / 59.28 fn / 63.34 ln, **up on
  every axis** from 61.9 / 54.52 / 58.85 / 62.78
- `npm run test:e2e` at CI's two workers — **201 passed**, zero flakes
- CSP, HSTS and Permissions-Policy confirmed on the wire against a real
  production server, and the object-store origin confirmed present with a
  build-time env var and absent without one

**A process note worth keeping.** An intermediate e2e run failed *every* test
at `waitForAppReady`, which looked exactly like the concurrency work breaking
startup. It was not. Two manual `npm run build` invocations — run to inspect
the CSP headers — left `.next` holding chunks with `NEXT_PUBLIC_E2E_HOOKS`
inlined as undefined, so `__profileStore` was compiled out and every spec
waited for a hook that could never appear. `rm -rf .next`, same tree, 201
passed. This is the "stale bundle" lie the project memory already warns about;
the tell was that the failure was total rather than localised.

### Left open, deliberately

- **The rest of the `db.ts` split** (CRUD by object store). Finding 6 took the
  half with a correctness argument behind it — the concurrency primitive — and
  left the rest, which is churn across 52 importers for a structural-only gain.
- **Promoting the CSP to enforcing.** Needs middleware, both to emit the
  object-store origin per request (Next evaluates `headers()` at build time —
  measured, not assumed) and to carry a nonce so `script-src 'unsafe-inline'`
  can go. One piece of work; do it after watching the reports through a real
  show.
- **The earlier reviews' open findings**, except where these overlapped. One
  needs re-rating rather than assuming: `repo-review-2026-08-22-subsystems.md`'s
  🟢 11 was downgraded on the strength of the `Sec-Fetch-Site` gate, and that
  reasoning is now retracted in `proxyUtils.ts`. The rate limit bounds volume,
  not content type, so it does not cover that finding.
