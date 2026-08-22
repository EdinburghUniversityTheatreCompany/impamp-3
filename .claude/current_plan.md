# Eight-phase run — started 2026-08-21

Working branch `fix/review-2026-08-21`, in the worktree
`.worktrees/fix/review-2026-08-21`. Merge to `main` at the end of each phase
that stands on its own; keep going without asking unless a phase hits one of
the pause conditions in the global CLAUDE.md.

**Definition of done for every phase:** `npx vitest run`, `npm run typecheck`,
`npm run lint`, `npx prettier --check .`, jscpd, and
`E2E_PORT=<free> npx playwright test --project=chromium --reporter=line` all
green, and the change actually exercised rather than pattern-matched.

## Phases

| #   | Phase                                               | State       |
| --- | --------------------------------------------------- | ----------- |
| 1   | Fix everything in `plans/repo-review-2026-08-21.md` | **done**    |
| 2   | Drain `plans/off-topic-improvements.md`             | in progress |
| 3   | Second full repo review, then fix what it finds     | not started |
| 4   | Take the deferred upgrades that are now feasible    | not started |
| 5   | A layout that works on mobile / portrait            | not started |
| 6   | Issue #8 — first-use tutorial                       | not started |
| 7   | Full code review, fix everything                    | not started |
| 8   | Full code review, fix everything                    | not started |

## Phase 1 — the 2026-08-21 review

Report: `plans/repo-review-2026-08-21.md`. Fourteen findings.

- [x] 🔴 1 — the dedup collapse deletes a row an in-flight import holds
      (`dccd616`, with the regression test that fails against `a0923a6`)
- [x] 🔴 2 — `test:coverage` exits 1 on a green suite (`58a4fc6`, five clean
      `--coverage` runs against two failures in three before)
- [x] 🟡 3 — every `RadioGroup` has no accessible name (merged from
      `p1/a11y`). Fixed better than the report proposed: `FormField` publishes
      its label's real id through a context and `RadioGroup` consumes it, so
      outside a `FormField` a group carries no `aria-labelledby` at all rather
      than one that dangles. `htmlFor` dropped for group children, since it is
      defined only against a labelable element and a group is a div.
      Descriptions wired
      with `aria-describedby`. Verified independently with the same probe that
      proved it broken: name resolves, no dangling `for`
- [x] 🟡 4 — rule restated by name, and all seven bumps landed (`p1/deps-docs`).
      Mick approved taking them inside the 7-day cooldown; four were published
      the same day. `npm outdated` is now exactly eslint and typescript
- [x] 🟡 5 — every `test:e2e*` script is chromium now, with
      `test:e2e:cross-browser` for the on-demand run, and the reporter prints
      to the terminal instead of only opening a browser (`p1/deps-docs`)
- [x] 🟡 6 — `settleAudioImports` was module-private (part of `dccd616`)
- [x] 🟡 7 — five deleted; `resetGoogleTokenRefreshState` kept and now used by
      a new throttle test, because the real finding there was a missing test
      (`p1/deadcode`)
- [x] 🟡 8 — 1682 → 1071 lines; the Maintenance tab is three tested panels
      (24 tests, mutation-checked). Found a real bug on the way: a repaired
      pad stayed silent because the repair never bumped `padConfigsVersion`
      (`p1/profilemanager`)
- [x] 🟡 9 — pattern moved into `.gitignore` (`p1/deps-docs`)
- [x] 🟢 10 — stale worktrees (removed, 2.3 GB; branches deliberately kept)
- [x] 🟢 11 — the dedup confirmation now says a pad naming both copies comes
      out a sound shorter (merged from `p1/a11y`)
- [x] 🟢 12 — one transaction, not one per row. Measured 25 → 1 for 25 sounds
      (`p1/deadcode`)
- [ ] 🟢 13 — Drive sync coverage. **Not fixable as a task** — it is a note
      about where risk sits, and the path cannot be exercised outside
      `localhost:3000`. Carry it into phase 3 rather than pretending.
- [x] 🟢 14 — query stripped from the document cache key, on both the write
      and the offline read (`p1/deadcode`)

## In flight

Six agents, one worktree and one branch each, all cut from `f20aeb7`. They
merge back into `fix/review-2026-08-21` as they land.

| Branch              | Carrying                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| `p1/deps-docs`      | 🟡 4 (dep rule + seven patch bumps), 🟡 5 (e2e script), 🟡 9 (gitignore)    |
| `p1/a11y`           | 🟡 3 (radiogroup name), 🟢 11 (dedup confirmation copy)                     |
| `p1/deadcode`       | 🟡 7 (six dead exports), 🟢 12 (export transactions), 🟢 14 (sw key)        |
| `p1/profilemanager` | 🟡 8 (extract the Maintenance tab, with real unit tests)                    |
| `p2/sync-bugs`      | renamed profile never converges; Drive legacy import matches by name        |
| `p2/small-fixes`    | `triggerPad` spread; cache pin asymmetry; silent pad drop; search arm chord |

## Phase 2 — the off-topic backlog

Sixteen entries. Two are already resolved and only need closing out (the
`tsc` pre-commit hook, and the coverage ratchet, which is now 58/49/55/59
against a measured 59.26/50.96/56.72/60.10). One belongs upstream in
dev-hooks rather than here (`check_version_sync.sh` reading only the first
Dockerfile — the local half is already covered by
`scripts/check_extra_dockerfiles.sh`). Two are in flight above. That leaves,
for a later wave:

- inline SVG icons should live in their own files (31 blocks, 15 components —
  a real decision: icon library vs local `icons/`, and it must be one pass)
- ProfileManager's repair list can read "Bank Bank 3"
- two sound rows in the pad editor can share a `data-testid`
- the duplicate-audio panel names no sounds
- `bankUtils.ts` spells the 20-bank cap out three times

## Standing notes

- **Running e2e:** always `E2E_PORT=<free port>`; port 3000 is often taken and
  `reuseExistingServer` does not check what is listening. Redirect to a file
  and echo `$?` — a passing run prints almost nothing.
- **Worktrees need a real `npm ci`**, not a symlinked `node_modules`.
- Subagents get their own worktree so they cannot stomp each other; their
  branches merge back into `fix/review-2026-08-21`.
