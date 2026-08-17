# State of play — 2026-08-17

The 15 August review and its fix pass are **done and merged** (`b29585b`). The
plan that drove them is closed; what follows replaces it.

## What happened since

The fix pass was reviewed in turn, by eleven parallel reviewers over the whole
app. Report: [`plans/repo-review-2026-08-17.md`](../plans/repo-review-2026-08-17.md),
per-axis detail in [`plans/review-2026-08-17/`](../plans/review-2026-08-17/).
137 findings, 24 high.

It found four regressions the fix pass had shipped past every gate. All four are
fixed on `main`, each with a test that fails against the commit before it:

- `11b23e9` — the preloader deadlocked on its own decode slots (🔴, silent pads)
- `2fafc29` — Drive's transfer timeout was on the JSON, not the audio (🔴)
- `52873ec` — keys fired the bank you had just left (🟡)
- `fbc1806` — `main` failed `prettier --check`; the commit gate now checks the
  same formats CI does (🟡)

`f31abfd` adds an e2e assertion that the loudness worker really does serve
analysis in a production build — that finding (P1) was a **false positive**, and
the assertion is what settles it either way, since the fallback is silent.

## Gates on `main` at `4c84839`

628 unit · 127/127 chromium e2e · lint · typecheck · build · prettier · jscpd 0 %
· version-sync · action-pins · actionlint · zizmor — all clean, tree clean.

## Next, in order

Nothing is in progress. The backlog is the new review's 🔴 list, ranked there.
Start at the top:

1. **T1** — the server-sync e2e flake is a real lost-update bug: a merge writes
   `_fieldsModified[field] = 0` for unstamped fields, and `updateLocalData`
   overwrites local stamps while pinning local values, so a sync erases the
   record that this device changed something. Silent, loses user edits, no unit
   guard. `plans/review-2026-08-17/tests.md:59`.
2. **ST1** — a failed audio import is swallowed and reported as success.
3. **SY2 / SY1** — hand-resolved conflicts desync ids from hashes; two clients on
   one server profile push to each other forever.
4. **SV1 / SV2** — uploaded bytes unverified against their hash; profile write
   buffers the body before any size check.
5. Then the 🟡 threads, of which the largest is that **import is one rule written
   four times** and the legacy impamp2 path has none of the fixes and no tests.

## Waiting on Mick

- **Registering the service worker.** `public/sw.js` exists and is referenced by
  nothing, so the offline-first PWA the README promises does not exist. Turning
  it on changes caching and update semantics for every existing user of a live
  deployment, from a file that has never run against the current build.
- **`IMPAMP_ALLOWED_EMAILS`** on the public host — still his call on the set.
- **L9 / L11** from the previous review: deleting ~864 KB of orphaned docs, and
  whether to commit `fnox.toml`.

## Not deployed

Nothing has shipped since the previous session. The production `impamp_data`
volume was chowned to uid 1000 then, with a verified backup taken first.
