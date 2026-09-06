# Off-topic improvements

Things noticed while working on other tasks, deliberately left out of scope.
Each entry: what, where, why it matters.

Deferred dependency upgrades live in `plans/deferred-upgrades.md`, not here.

## The rest of the panel suites still settle by tick count

`reactPanel.tsx` now offers `waitForCondition` — a wall-clock wait on a
condition, checked _between_ `act` scopes — and the two suites that were
measured failing under `hk`'s parallel load use it: `MissingAudioPanel`'s
`chooseReplacement` waits for the row's picker to leave its disabled window,
and `EditPadForm.dedup`'s `addSounds` waits for the rows to be listed.

`settle()` and its 40 `setTimeout(0)` turns remain, and about a dozen suites
still assert straight after one. Each is the same shape: `setTimeout(0)` is
clamped to about a millisecond, so the budget is roughly 40 ms of wall clock
and is unrelated to the file hash, IndexedDB write or dynamic `import()` the
assertion is actually waiting for. Migrating one is mechanical — say what the
press should produce and wait for that — and worth doing to whichever suite
next fails on a loaded machine rather than all at once.

Two things not to re-derive. Checking a condition from _inside_ a single
long-running `act` scope can never work: React commits an update when the scope
it was queued in exits, so the wait holds the DOM still and then reads it.
Measured, not assumed — the first version of `waitForCondition` did exactly
that and sat for the full five seconds watching a frozen picker. And the
original flake was **not reproducible** here: the old code passed ten
consecutive runs of both suites at load average 26, so the migration rests on
the mechanism being wrong rather than on a red run anyone has since seen.
`HK_JOBS=1 git commit` is still the workaround if it recurs.

## Two loudness suites failed once inside `hk` and never again

On 2026-09-06 a commit was rejected by the pre-commit hook with

    FAIL src/lib/audio/loudness/analyse.sliding.test.ts > the sliding block sum
         > matches a re-summing reference on a huge dynamic range
    FAIL src/lib/audio/loudness/query.test.ts > measureRange
         > gives a different answer for a trimmed range than the whole file

and passed on the immediate retry and on every run since — full suite included,
repeatedly. Recorded because the failure mode is not obvious and the next person
should not start from scratch.

It is **not** a timeout, which is the first guess and the wrong one:
`vitest.config.ts` sets `testTimeout: 20_000` and both tests run in about 500 ms
idle, so a 40x stall would be needed. Both are pure numeric comparisons against
a re-summing reference over a deterministic generated signal — there is no
clock, no I/O and no shared state in either — so a genuine non-determinism
would have to come from below them: the worker pool, `Float32Array`
allocation under memory pressure, or something in vitest's teardown reporting
the wrong test. That last one is worth ruling out first, since this repo has
already had one teardown failure that read as an unrelated suite breaking (the
`stubLoudnessPipeline` rule in CLAUDE.md).

Nothing was changed for it: one unreproducible failure is not enough to act on,
and a speculative `retry` on these two would hide it if it comes back. Note the
run and the machine's load if it does.

## A nested `withAudioImportInProgress` would hang an import's rollback

`settleAudioImports` waits for every registered import, and nothing tells it
which one its caller is running inside — there is no `AsyncLocalStorage` in a
browser, and no `AsyncContext` yet. The rule that keeps that from deadlocking
is "no audio deleter may be called from inside `withAudioImportInProgress`",
and a failed profile import now honours it by carrying its profile id and
created audio ids out on a `FailedProfileImport` and rolling back one line past
the scope.

That holds today because no scope contains another. It would stop holding the
moment one did — if `performServerSync` or `performProfileSync` ever called
`importProfileFromSyncData` (today only the two connect hooks do), the inner
import's rollback would run outside the _inner_ scope but still inside the
_outer_ one, and `deleteProfile` would wait for the sync that is waiting for
it. The failure is a hung tab, not an error.

Nothing enforces the rule; it is prose in `settleAudioImports`'s docstring and
in CLAUDE.md. An id-based register — each scope publishing the audio rows it
has been handed but not yet named, so deleters _exclude_ rather than _wait_ —
would end the class outright and remove the latency `deleteProfile` now pays
behind a running sync. It is bigger and permissive-by-default (a writer that
forgets to publish is silently back to the original bug), which is why it was
not done here. Noticed while fixing the 08-22 review's 🔴 2.

## Nothing bounds what a presigned PUT actually writes

`upload-url` mints a presigned PUT whose signature covers only `host`
(`src/lib/server/s3/client.ts`), so the `sizeBytes` a client declares is a
claim and the bytes that arrive are unconstrained. Commit measures the object
and refuses an over-size one, and uncommitted objects are now charged
provisionally and swept hourly — but a caller who declares a byte, sends five
gigabytes and never commits still gets those bytes into the bucket until the
sweep reaches them, with Wasabi's 90-day minimum billing on each.

That last clause was doing more work than it could bear when this was written:
the sweep restarted at the first key in the bucket on every pass, so on any
deployment with a real library it reached nothing at all. It now carries a
cursor across passes and comes round in about a hundred minutes on a
200,000-object bucket, so the deferral rests on something that happens.

The fix is to put `content-length` in the presign's `SignedHeaders` so S3
rejects a PUT whose length is not the one that was signed for. It was left out
deliberately: nothing in this repo can verify Wasabi accepts it —
`e2e-tests/fake-s3.js` does not check signatures on purpose, and
`sigv4.test.ts` checks the signer against botocore's vectors rather than
against a bucket — and a signing change Wasabi disagrees with breaks every
real upload with `SignatureDoesNotMatch`. Worth doing against a live bucket
with a real key, not from here. Noticed while fixing the 08-22 review's 🟡 5.

## An email share cannot be accepted, declined or left

`upsertEmailShare` writes a share row for any address on the inviter's
say-so, and only the profile's owner can remove it. Two authorization rules
have already had to be rewritten because they read that row as evidence about
the invitee (`profileMayServeHash`, `deletingHashWouldSilenceAProfile`), and
each rewrite is a workaround for the same missing concept. What remains
without it is cosmetic — a profile you were invited to sits in your list until
its owner deletes the invitation — but the next rule that wants to know
"is this person actually a collaborator" will have the same problem.

Share acceptance is the feature: a share is offered, and grants nothing until
the invitee takes it. A "leave this profile" action is the smaller half of it
and could ship alone. Noticed while fixing the 08-22 review's 🟡 4.

## A phone has no route to four things the keyboard does

The portrait layout makes the board usable on a phone as a _convenience_
device — the scope Mick set — and deliberately stops short of the affordances
a performance device would need. Four actions have no touch route at all:

- **Play the emergency sound** (`Enter`, round-robin over emergency banks).
  No button, no gesture, nothing in the UI at all.
- **Play the next armed track** (`F9`). `ArmedTracksPanel` has a per-row play
  button, but "play the head of the queue" — the verb the panel's own help
  text tells you to press F9 for — has no control.
- **Arm a track** (Ctrl/Cmd+click, or Ctrl/Cmd+Enter in search). The chord
  needs a modifier key, so it is unreachable by touch.
- **Stop All and Fade Out All** exist _only_ as pads, at grid indices 23 and 35. There is no toolbar button for either, so the panic control is the same
  size as every other pad and needs a scroll to reach.

Two more that are touch-broken rather than merely absent:

- **Pad reordering is desktop-only.** `Pad.tsx` uses HTML5 drag-and-drop
  (`draggable`, `onDragStart`, `onDrop`), which does not fire on touch.
- **Bank-tab reordering by touch is untested.** `@hello-pangea/dnd` registers
  `useTouchSensor` by default and injects `touch-action: manipulation`, so it
  should work — but the strip is `overflow-x-auto` and scroll-versus-lift
  arbitration was never verified. `e2e-tests/bank-reorder.spec.ts` drives the
  _keyboard_ sensor only.

And one polish item: pads have no `:active` state and no tap-highlight
suppression, so feedback is `hover:` only, which sticks after a tap.

All of this becomes worth doing if the answer to "what is a phone for here"
ever changes from convenience to performance. Noticed while building the
portrait layout.

## Nothing on the board distinguishes "playing" from "audible"

Every playback signal the operator has — the pad's green progress bar, the
Active Tracks panel, the live region — reports that a source was _started_.
None of them can tell the difference between a cue coming out of the speakers
and a cue being started into a muted output. That gap is exactly what made the
iOS silent-switch bug (fixed in `src/lib/audio/audioSession.ts`) so hard to
report: the board looked completely healthy, so it arrived as "impamp doesn't
work on mobile" rather than as a routing problem.

The declared audio session closes the iOS half, but not the general case. A
phone whose media volume is at zero, an output device that has gone away
mid-show, or an OS-level Do Not Disturb configured to include media all produce
the same silent-but-healthy-looking board, and none of them is something the
page can fix — only something it can _notice_.

An `AnalyserNode` on the master bus would notice it: if a track has been
running for a second or so and peak amplitude has never left the noise floor,
something between the graph and the speakers is swallowing the audio, and the
operator should be told before the second cue rather than after the show. It
does not diagnose the cause, and it should not try to — "sound is playing but
nothing is coming out" is the whole of the useful message.

Deliberately not done with the silent-switch fix: it is a new always-on node in
the playback graph and a new piece of UI in a live-performance path, which is a
different change with a different risk profile from a one-line declaration that
no other platform even reads.

Noticed while fixing the iOS ringer-switch bug.
