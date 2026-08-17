# Whole-repo review — 2026-08-17

A second, independent review of the whole app, run two days after
[`repo-review-2026-08-15.md`](repo-review-2026-08-15.md) and immediately after
the 40-commit fix pass answering it merged to `main` (`b29585b`).

Eleven reviewers worked in parallel, one per axis, each reading the code as it
is now rather than re-deriving the last report. Every finding is classified:

- **NEW** — not in the 15 August report
- **REGRESSION** — introduced or worsened by the fix pass
- **RECURRENCE** — reported, claimed fixed, not actually fixed
- **DEFERRED** — knowingly left, listed only where the reasoning looks wrong

Per-axis detail, with code quoted and evidence, is in
[`review-2026-08-17/`](review-2026-08-17/). This file is the index and the
ranking.

## Scale

| Axis                    | File                                               | Findings |     🔴 |
| ----------------------- | -------------------------------------------------- | -------: | -----: |
| Audio subsystem         | [audio.md](review-2026-08-17/audio.md)             |        5 |      1 |
| Storage & import/export | [storage.md](review-2026-08-17/storage.md)         |        7 |      1 |
| Sync clients            | [sync.md](review-2026-08-17/sync.md)               |        9 |      2 |
| Server & security       | [server.md](review-2026-08-17/server.md)           |       14 |      2 |
| React components        | [components.md](review-2026-08-17/components.md)   |       10 |      1 |
| Stores & hooks          | [state.md](review-2026-08-17/state.md)             |       10 |      0 |
| Performance             | [performance.md](review-2026-08-17/performance.md) |        8 |      1 |
| Dead code & duplication | [deadcode.md](review-2026-08-17/deadcode.md)       |       19 |      1 |
| Test health             | [tests.md](review-2026-08-17/tests.md)             |       33 |     10 |
| Infra, CI, deps, docs   | [infra.md](review-2026-08-17/infra.md)             |       15 |      2 |
| The fix-pass diff       | [regressions.md](review-2026-08-17/regressions.md) |        7 |      3 |
| **Total**               |                                                    |  **137** | **24** |

## The headline

**The fix pass shipped four real regressions, and this review found them.** That
is the finding that justifies having run it. A 141-file change that was green on
every gate still broke playback, keyboard triggering, Drive transfers and CI —
none of which any existing test could see.

Each of those is now fixed, with a test that fails against the previous commit:

|     | Regression                                                                                       | Fix       |
| --- | ------------------------------------------------------------------------------------------------ | --------- |
| 🔴  | The preloader deadlocked on its own decode slots; a stuck batch left pads permanently silent     | `11b23e9` |
| 🔴  | Drive's 120 s transfer timeout went to the profile JSON; audio upload and download got 10 s      | `2fafc29` |
| 🟡  | Keys fired the bank you had just left, because the new shared hook was adopted without its guard | `52873ec` |
| 🟡  | `main` failed `prettier --check`, so CI would have gone red on the next push                     | `fbc1806` |

Their shape is worth naming, because it is the same shape three times: **a fix
took the data and left the guard.** The pipelined decoder moved the in-flight
registration and left the slot-wait pointing at a set the waiter had joined.
`useKeyboardListener` adopted `usePadConfigurations` and not the `isLoading`
check that made it safe. `fetchWithTimeout` was applied by reading a comment
rather than the signature under it. In every case the _fixed_ copy carried the
careful comment and the twin did not — which is the pattern the
`sync-bugs-are-duplicated-rules` note already records, now confirmed to apply to
fixes themselves, not just to features.

**One reported 🔴 did not survive verification.** Performance P1 claimed the
loudness worker never loads in production, inferred from a build that emits the
worker's TypeScript verbatim to `/_next/static/media/…​.ts`. That asset is a
decoy; the constructor compiles to a `turbopack-worker` bootstrap that loads the
real chunks. Disproved by A/B against a clean rebuild — the worker serves every
analysis and the fallback never runs. `f31abfd` adds the e2e assertion that
settles it either way, because the fallback is silent by design and nothing else
could tell the two apart. Roughly one in eight findings not surviving contact
with the source continues to hold; treat every item below as a claim to check,
not a fact.

## 🔴 Open — ranked

Nothing below is fixed. Ordered by what I would do first.

### Data loss and silent corruption

1. **T1 — the e2e flake is a real lost-update bug.** The server-sync conflict
   test fails ~30 % of the time under load, and it is not slowness: a merge
   writes `_fieldsModified[field] = 0` for any field the local side never
   stamped, and `updateLocalData` pins the local _value_ while overwriting the
   local _stamps_. A sync whose read predates your rename erases the record that
   you renamed anything. The rename survives, the evidence does not, and the next
   merge sees no conflict and pushes over the other side. Proved by instrumented
   probes with 1:1 correlation across 16 runs. **This is the most important item
   in the review** — it is silent, it loses user edits, and it had no unit guard
   (T14). `tests.md:59`.
2. **ST1 — a failed audio import is swallowed and reported as success.** The fix
   pass hardened `importPadConfigurations` and `importPageMetadata` to collect
   failures and throw; `importAudioSources`, the third writer in the same
   function, still logs and carries on. A restore or a share-join can come back
   with pads silently emptied and say "imported successfully" — and then publish
   the emptiness back. There is no `QuotaExceededError` handling anywhere, so
   filling browser storage mid-import is exactly this, at scale. `storage.md:22`.
3. **SY2 — manual conflict resolution reintroduces C1.** Choosing "remote" for
   `audioFileIds` leaves the local `audioFileHashes` in place, and
   `updateLocalData` prefers hashes — so a hand-resolved pad ends up with ids and
   hashes naming different sounds. The automatic path got the `DERIVED_HASH_TWINS`
   fix; the manual path did not. `sync.md`, and R4 in `regressions.md`.
4. **SY1 — two clients on one server profile push to each other forever.** An SSE
   event triggers an unconditional push, which bumps the version, which emits an
   SSE event. `sync.md`.

### Server security

5. **SV1 — uploaded bytes are never checked against the hash they are stored
   under.** Bucket poisoning, and it inverts proof-of-possession: the mechanism
   added to prove a caller holds the bytes is undermined if a caller can choose
   what bytes live at a hash. `server.md`.
6. **SV2 — profile write buffers the whole request body before any size check**,
   and an anonymous editor-link holder can send one. `server.md`.

### Promised behaviour that does not exist

7. **D1 — the service worker is never registered.** `public/sw.js` has been
   present and unreferenced since April 2025; `rg serviceWorker src/` returns
   nothing. README and CLAUDE.md both advertise offline-first PWA behaviour that
   the app does not have. I verified this personally. **Deliberately not fixed
   here:** switching a service worker on for a live deployment changes asset
   caching and update semantics for every existing user, and that file has never
   run against the current build. Mick's call. `deadcode.md`.
8. **C1 — there is no error boundary anywhere.** A failed lazy chunk (which is
   what an offline PWA produces) unmounts the whole soundboard while audio keeps
   playing, with no way back but a reload. `components.md`.

### Operations

9. **I1 — `docs/server-sync.md:64` still documents the impossible
   `kamal app exec sqlite3` backup.** The fix pass corrected this exact command
   in `config/deploy.yml` and not in the doc a person actually reads during an
   incident. Twin-copy pattern again. `infra.md`.
10. **I2 — the documented backup covers SQLite only.** Hosted audio is live in
    production, CLAUDE.md states the database and bucket must be backed up and
    restored _together_, and no file in the repo says how to snapshot the bucket.
    `infra.md`.

### Test trustworthiness

11. **T2–T10 — nine 🔴 findings that the suite is less protective than its
    counts suggest.** `rollbackTo` can be made a complete no-op and the suite
    stays green (T4); the hash-guard test asserts the one field the bug cannot
    touch (T5); proof-of-possession's offset arithmetic is never executed (T9);
    the real S3 `getRange` the whole proof depends on has no tests (T10); one
    test cannot fail on any machine that has run the suite before (T3).
    Unit-line coverage is ~30 % and the repo cannot currently measure it (T11).
    `tests.md`.

## 🟡 and 🟢

103 further findings sit in the per-axis files. The threads worth pulling:

- **Import is one rule written four times.** `storage.md`'s headline: the profile
  record, the audio records and the entire legacy impamp2 path still carry the
  defects the pad and page importers were fixed for. The impamp2 path — the app's
  on-ramp for new users — was not touched by the fix pass at all and has zero
  tests.
- **Duplication that survived a duplication-focused pass.** jscpd at 0 % removes
  token-identical clones and nothing else, so what remains is the dangerous kind:
  the same _rule_ written twice in different words. `deadcode.md` lists 19,
  including three helpers the fix pass extracted and then left partly unadopted
  (D3, D4, D5).
- **Accessibility is largely absent.** Pads are `role="button" tabIndex={0}` with
  no key handler while Tab is globally suppressed; the shared `Modal` has no
  `role="dialog"`, focus move, trap or restore; no live region announces
  playback. `components.md` C2, C6, C10.
- **Two PWA manifests, drifted.** The stale `public/manifest.json` is dead but
  publicly reachable and names two icons (`144x144`, `152x152`) that do not
  exist; Next serves the generated one. Verified. `deadcode.md` D8.
- **`profileStore.error` is written from 17 places and read by none**, and two
  actions swallow failures into it. `state.md` S6.

## Verified clean — do not re-litigate

Each axis records what it checked and found holding, so the next review does not
re-spend the budget. Highlights: migrations are genuinely append-only (migration
4 drops migration 1's index rather than editing it); no string-built SQL anywhere
in `src/lib/server`; no IDOR in the profile or share routes; every CI action is
SHA-pinned with read-only `permissions`, and `actionlint`, `zizmor`, gitleaks
history and `npm audit` are all clean; all three deferred upgrades re-verified
against the npm registry and still correctly held; zero whole-store Zustand
subscriptions remain; the `Record<audioFileId, …>` census is complete at two
fields, remapped at all four id-translating sites; `toWireProfile`'s allow-list
plus its compile-time exhaustiveness assertion is the right shape.

`performance.md` P6 also **corrects** the 15 August report: the `structuredClone`
fix it prescribed for the sync merge measures 18 % _worse_. Do not apply it.

## Gates at the time of writing

`main` at `f31abfd`: 628 unit tests, 126/126 chromium e2e plus the new worker
spec, lint, typecheck, build, prettier, jscpd (0 %), version-sync, action-pins,
actionlint and zizmor all clean.

Two caveats stated plainly. No Google Drive path has been exercised against the
live API on any of this work — OAuth accepts only `localhost:3000` as an origin —
so the Drive findings and the Drive timeout fix are verified by reading and by
asserting on the call, not by a round trip. And the deploy itself has not
happened; the production `impamp_data` volume was chowned during the previous
session and nothing has shipped since.
