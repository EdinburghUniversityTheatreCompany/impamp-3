# Eight-phase run — 2026-08-22 (complete)

Mick's list, worked in order with heavy parallelism. **All eight phases are
done and merged.** One checkout, no stray worktrees, nothing left on a branch.

## Gates on `main`

1577 unit tests in 166 files · 199 chromium e2e · 4 `mobile-portrait` e2e ·
typecheck, eslint, prettier, jscpd 0 %, gitleaks, version-sync, action-pins,
actionlint, zizmor all clean · coverage ratchet 60 / 52 / 57 / 61.

**Nothing has been deployed.** `impamp.bedlamtheatre.co.uk` still runs what it
ran this morning, and that is deliberately Mick's call — this branch contains a
security fix and a behaviour change to hosted audio.

| #   | Phase                                   | State                            |
| --- | --------------------------------------- | -------------------------------- |
| 1   | Fix `plans/repo-review-2026-08-21.md`   | **done**                         |
| 2   | Drain `plans/off-topic-improvements.md` | **done** — all 16 closed         |
| 3   | Second full repo review, then fix it    | **done** — 19 findings, 17 fixed |
| 4   | Deferred upgrades now feasible          | **done** — see below             |
| 5   | A layout that works in portrait         | **done**                         |
| 6   | Issue #8 — first-use tutorial           | **done**                         |
| 7   | Full code review, fix everything        | **done** — 21 findings           |
| 8   | Full code review, fix everything        | **done** — 7 findings            |

## What phases 1–5 actually changed

Three reviews ran today and each found real bugs the previous one missed —
`repo-review-2026-08-21.md` (14 findings), the `/code-review` of the session
diff (4), and `repo-review-2026-08-22-subsystems.md` (19). That is the
strongest argument for phases 7–8 and also the reason not to expect them to
come back empty.

The bugs that mattered, all reproduced before being fixed:

- **An authorization bypass on hosted audio.** `profileMayServeHash` accepted
  "a current email-share editor holds it", and `upsertEmailShare` writes a
  share on the inviter's say-so with no acceptance. So the owner of any profile
  could manufacture the grant, and anyone ever shown a board kept its hashes
  and could re-obtain every sound in it after their share was revoked. The
  branch is gone. **The principle worth keeping: a share grants access _to_
  someone and is never evidence _about_ them.**
- **Three audio deleters could eat a row an in-flight import was holding**, all
  three deterministically. The rule now has no exceptions to encode, because
  the one deleter that ran inside an import's own scope was moved out rather
  than the register taught to skip it — a token design deadlocks when two
  imports fail at once.
- **A repaired pad stayed silent**, because the repair never bumped
  `padConfigsVersion`.
- **Drive's legacy import matched audio by filename**, merging two different
  recordings that shared a name.
- **Enter in the search box acted on the previous query's results** during the
  300 ms debounce — in a feature shipped the same morning.
- **`ArmedTrackState` was missing `isDisabled`**, so a pad switched off after
  arming still answered "enabled".

Phase 4's answer is a negative, verified rather than assumed: `typescript-eslint`
still peers `typescript: >=4.8.4 <6.1.0` and `eslint-plugin-react` still tops
out at `eslint: ^9.7`, so TypeScript 7 and ESLint 10 stay deferred.
`file-selector` left that list when react-dropzone moved its own dependency and
inverted the pin. Recorded in `plans/deferred-upgrades.md`.

`dev-hooks` was **pushed** (v24): `check_version_sync.sh` now reads every
`Dockerfile*` instead of breaking on the first, and this repo dropped the
second gate it had grown to cover that hole. CI green.

## Two lessons this run, both about evidence

**A green gate is not a verdict.** The icon branch reported 143/193 then 30/193
e2e failures at load average 19, with `worker process exited unexpectedly` and
missing-module errors — pure starvation, 193/193 once the machine was quiet.
Separately a rebuilt app screenshotted completely unstyled: the old server
still held the port, `EADDRINUSE` went to a log nobody read, and the stale
bundle named a CSS chunk the rebuild had renamed. **Check the machine before
believing a failure, and check the server before believing a screenshot.**

**Tests that pass can still be worthless.** The portrait spec's footer
assertion flipped to passing as a _side effect_ of moving Stop All to the end,
and had to be rewritten to hit-test every on-screen pad; mutation-checking it
now reports 6 covered pads. An agent found its own first throttle test was
vacuous because an in-flight promise coalesced the calls. And
`"refuses a sound a mere viewer happens to hold"` went vacuous the moment the
branch it guarded was deleted. **Mutation-check anything load-bearing.**

## Phase 6 — issue #8, first-use tutorial

Shipped as a four-step modal tour, `WelcomeTourContent.tsx`, gated by
`src/lib/firstRun.ts` — a `localStorage` flag that **fails closed**, so a
browser refusing storage shows the tour once per load rather than throwing on
the first paint.

Two things it taught, both about dismissal. `Modal`'s `onCancel` fires only
from a Cancel button, and the tour renders none, so recording the dismissal
there was dead code; it happens on unmount instead. And the regression test was
vacuous in the other direction — `toBeHidden()` passes instantly against an
element that has not rendered yet, so it polls `localStorage` now.

The tour also broke **eleven** existing specs at once, because its overlay
intercepts the clicks every spec starts with. `gotoApp` marks it seen through
`addInitScript` before navigating; any new spec that wants to see the tour
passes `{ showWelcomeTour: true }`.

## Phases 7–8 — two more review passes

Phase 7 ran wide (21 findings, 3 red) and phase 8 ran **directed at the day's
own fixes** (7 findings). Phase 7's headline is worth keeping: the merge seams
were not the source of the bugs. Every red was a fix that was incomplete on its
own branch, and twice a fix was made live by the fix immediately preceding it —
which is an argument for reviewing a day's work as a whole rather than
reviewing each branch and trusting the merge.

The one that took longest to believe was billed as flake: two pad-editor specs
failed only in full-suite runs. `EditPadForm` built its new sound list from the
names it had finished loading, not from the ids it was holding, so adding a
sound before the names arrived **dropped every sound already on the pad** — and
the reload it triggers rebuilt the list from the truncated ids, so nothing on
screen admitted it. Ten e2e workers writing 5 MB WAVs to one disk is what
stretched the read far enough to see it.

### Still open, deliberately

- 🟡 The attribution residual is wider than the fix's comment claims: inside the
  NULL window the holder's own delete is allowed, and orphans the object.
- 🟢 `sweepIfDue`'s overlap guard has no test, and the pad-editor hold's stated
  reason is false (the behaviour is right, the comment is not).

Known-unfixed going into 7–8, and still unfixed on purpose:

- 🟢 10 from the subsystem review: a still-valid presigned PUT can overwrite an
  object someone else commits inside the 900 s window. Left deliberately; every
  fix is disproportionate and unverifiable against Wasabi from here.
- A presign signs only `host`, so a declared size is a claim — a caller can say
  1 byte and PUT 5 GB. Signing `content-length` cannot be verified from this
  repo. The new hourly sweep is what answers it for now.
- Six things a phone still cannot do (`plans/off-topic-improvements.md`), all
  performance-device concerns and all out of scope for a convenience device.

## Standing notes

- **e2e:** always `E2E_PORT=<free port>`, `--workers=1` while the machine is
  busy. Redirect to a file and echo `$?`; a passing run prints almost nothing,
  so check the count. `npm run test:e2e` is chromium-only now, and
  `test:e2e:cross-browser` is the on-demand firefox/webkit run.
- **Worktrees need a real `npm ci`.** Never point an agent at the main checkout
  while merging into it — one was mid-probe on `audioHashIndex.ts` when a merge
  landed underneath it.
- **The backlog is 6 entries**, all opened today by the work itself; none is a
  leftover from before.
