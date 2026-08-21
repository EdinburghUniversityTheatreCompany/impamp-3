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
| 1   | Fix everything in `plans/repo-review-2026-08-21.md` | in progress |
| 2   | Drain `plans/off-topic-improvements.md`             | not started |
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
- [ ] 🟡 3 — every `RadioGroup` has no accessible name, and `FormField`'s
      `<label for>` points at nothing
- [ ] 🟡 4 — CLAUDE.md's "three outdated packages" rule is false; land the
      seven pending patch bumps
- [ ] 🟡 5 — README tells the reader to run the one e2e command CLAUDE.md
      says never to run
- [x] 🟡 6 — `settleAudioImports` was module-private (part of `dccd616`)
- [ ] 🟡 7 — six exports with no caller, one carrying the unguarded-hash
      landmine
- [ ] 🟡 8 — `ProfileManager.tsx`, 1682 lines and 0 % unit coverage
- [ ] 🟡 9 — `.claude/worktrees/` ignored only by `.git/info/exclude`
- [x] 🟢 10 — stale worktrees (removed, 2.3 GB; branches deliberately kept)
- [ ] 🟢 11 — the dedup confirmation does not say a pad can lose a slot
- [ ] 🟢 12 — `collectAudioForPads` opens one transaction per audio row
- [ ] 🟢 13 — Drive sync coverage. **Not fixable as a task** — it is a note
      about where risk sits, and the path cannot be exercised outside
      `localhost:3000`. Carry it into phase 3 rather than pretending.
- [ ] 🟢 14 — the service worker caches share-link URLs as cache keys

## Standing notes

- **Running e2e:** always `E2E_PORT=<free port>`; port 3000 is often taken and
  `reuseExistingServer` does not check what is listening. Redirect to a file
  and echo `$?` — a passing run prints almost nothing.
- **Worktrees need a real `npm ci`**, not a symlinked `node_modules`.
- Subagents get their own worktree so they cannot stomp each other; their
  branches merge back into `fix/review-2026-08-21`.
