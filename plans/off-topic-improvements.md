# Off-topic improvements

Things noticed while working on other tasks, deliberately left out of scope.
Each entry: what, where, why it matters.

Deferred dependency upgrades live in `plans/deferred-upgrades.md`, not here.

## `reactPanel`'s settle is a tick count, not a bounded wait

`src/lib/testSupport/reactPanel.tsx` settles a press by awaiting 40
`setTimeout(0)` turns inside one `act` scope. `setTimeout(0)` is clamped to
about a millisecond, so those 40 turns are roughly 40 ms on an idle machine
and can stretch past half a second on a loaded one. Two independent
consequences, both hit on 2026-08-22:

- A component timer set inside the settle window fires _during_ the wait
  rather than after it. `OrphanedAudioPanel`'s 500 ms re-scan did exactly
  this, clearing state the assertion was about. That specific case is fixed —
  `runOrphanScan` no longer clears the cleanup report — but the mechanism is
  general, and the fix each time has been to spy on `setTimeout` and
  intercept the request rather than wait for it.
- A dynamic `import()` a module has not been fetched yet can land _after_ all
  40 turns, because vite-node's fetch is not a macrotask the count can see.
  `cleanupOrphanedAudioFiles` reaches `await import("./audio/cache")`, and
  with `SETTLE_TICKS` cut to 4 that was the only failure in its file.

The unit suite failed once in six consecutive runs on a machine at load
average 17 while merging the icon set, and passed the other five; the failing
test's name was not captured then. It was captured on 2026-09-05, when the
pre-commit hook rejected the same tree twice while five direct runs of
`npx vitest run` passed: `hk` runs jscpd and gitleaks alongside vitest, and
that load alone was enough. The names, so the next person has a specific
target rather than a shape:

- `MissingAudioPanel.test.tsx` — "repairs one of two pads naming the same
  dead row" and "gives a pad naming one dead id twice a row apiece". Both
  assert `Replaced` on a row straight after `chooseReplacement`, which is one
  `panel.settle()` over a file hash, an IndexedDB write and a re-read.
- `EditPadForm.dedup.test.tsx` — `addSounds` has its own copy of the shape, a
  loop of 100 × 5 ms polls. It failed with "expected 2 sounds listed, saw 0".

`HK_JOBS=1 git commit` is the workaround that got the commits through: same
gates, run one at a time. Fake timers, or a settle that waits on a condition
rather than a count, would end the class. Noticed while merging `p2/icons`,
and again while landing the orange-window icons.

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

## Three inline plural ternaries left behind by the `count()` sweep

`src/lib/plural.ts` now has every "N of a thing" in the app going through it
except three, and each was left for a reason rather than missed:

- `src/lib/importExport.ts:463` —
  `${failures.length} of ${total} sound${total === 1 ? "" : "s"}`. The number
  rendered and the number the plural agrees with are different, which is not
  the shape `count` takes. Either a second helper or a reworded message.
- `src/lib/importExport.ts:796` — `${skipped.length} bank${…}`, an ordinary
  `count(skipped.length, "bank", "banks")`. Not taken because `importExport.ts`
  was owned by another change in flight on 2026-08-22.
- `src/components/profiles/BankImportPlacementDialog.tsx:309` —
  `{result.skipped.length === 1 ? "was" : "were"}`. Verb agreement, not a
  count; the noun beside it already goes through `count`. A `wasWere` helper
  would be one more thing to keep in step for one call site.

Worth a source-scan guard (`src/lib/testSupport/sourceScan.ts`) once the first
two are gone — while they remain, the skip list would be longer than the rule.
Noticed while resolving 🟢 13 of the 2026-08-22 subsystem review.

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

## The sweep's list loop has no guard against a token that never advances

`sweepUncommittedObjects` (`src/lib/server/audioSweep.ts`) pages with the
bucket's own continuation token and leaves the loop on two conditions: the
listing ended, or the scan budget ran out. A page with no objects in it
consumes no budget, so a store that answered every request with an empty page
and the same continuation token would spin the loop for ever — inside a request
handler, on a single instance whose event loop serves everything else.

Real S3 always makes progress, and the loop had this shape before the cursor
work too, so this is a hardening item rather than a bug anyone has seen. The
guard is two lines: stop when a page comes back empty and hands back the token
it was given. Worth a test with a store that does exactly that, or it is
another claim nobody checks.

Noticed while fixing the sweep's traversal (phase 7 review, 🔴 2).

## The bulk importer's "not per-pad" announcement is per-pad after all

`BulkImportModalContent.tsx:333` says _"The announcement is deliberately not
per-pad: one import can write sixty of them, and every bump re-reads the
bank"_, and the very next call is `savePadConfiguration`, whose whole job is
`upsertPadConfiguration` **plus** `notifyPadConfigsChanged` (`padWrites.ts`).
So a sixty-file import fires sixty bumps and then a sixty-first at line 351.
The comment was true when the importer wrote pads through
`upsertPadConfiguration` directly; adopting the shared tail took the write and
left the comment — this repo's characteristic shape, the same one recorded in
the "fixes take the data and leave the guard" memory.

Either the loop should go back to `upsertPadConfiguration` and keep its single
trailing announcement, or the comment and the trailing call should go. The
first is what the comment intends and is what the performance note is about.
Not taken here because it changes what the importer notifies and this branch
was about the audio-import register. Noticed while wrapping that loop in
`withAudioImportInProgress`.

## `npm run dev` does not start the app

`CLAUDE.md` and the README both document `npm run dev` as the way to start the
development server. On a clean checkout it returns **500** on every request:

```
ERROR: NEXT_PUBLIC_GOOGLE_CLIENT_ID environment variable is not set.
⨯ Error: Google OAuth components must be used within GoogleOAuthProvider
    at useGoogleSignIn (src/hooks/useGoogleSignIn.ts:66)
    at AuthNotification (src/components/AuthNotification.tsx:56)
```

`GoogleAuthProviderWrapper` renders no provider without the variable, and
`AuthNotification` calls `useGoogleSignIn` unconditionally on the only page,
so the whole board fails to render — not just the sign-in button.

`fnox exec -- npm run dev` works, because `fnox.toml` carries the reference.
Nothing says so: the deploy note in memory covers `fnox exec -- kamal deploy`
and the dev server is documented as a bare `npm run dev`.

Two candidate fixes, and they are not the same. Making the script
`fnox exec -- next dev --turbopack` fixes it for anyone with the vault, and
breaks it for anyone without. Making `AuthNotification` degrade when the
variable is absent — the app is fully usable without Google Drive, and the
production build already treats these as build-time-inlined optionals — fixes
it for everyone and matches what the three `NEXT_PUBLIC_*` ARGs in the
Dockerfile already imply. The e2e suite supplies a dummy value for exactly
this reason (`playwright.config.ts`), which is the third option: document a
dummy in `.env.dist` and say so in the README.

Noticed while starting a dev server so Mick could try the first-use tour.

## `next dev` writes a block into CLAUDE.md

Starting the dev server appends a `<!-- BEGIN:nextjs-agent-rules -->` block to
`CLAUDE.md` and logs "Generated CLAUDE.md for AI agents. Set `agentRules:
false` in next.config to disable." The block re-creates itself on every run, so
reverting it leaves a tree that goes dirty again the next time anyone develops.

Three options, and the choice is about whose document this is. Committing the
block keeps the tree clean and is what the block itself suggests. Setting
`agentRules: false` in `next.config.ts` keeps `CLAUDE.md` entirely
hand-authored, which is what the rest of this file plainly is — nearly every
paragraph exists because something broke, and an auto-generated section
telling an agent to read `node_modules/next/dist/docs/` sits oddly among them.
Moving the generated content to its own file, if Next supports that, would be
the third.

Noticed when a dev server started for a manual check left `CLAUDE.md`
modified and blocked a merge.

## The preloader's batch-level retry defeats its own batching

When `loadAndDecodeAudioPipelined` _rejects_ — as opposed to answering with a
map of nulls — `processBatch` re-queues each task from its own
`setTimeout(…, 1000 * task.attempts)`, and each of those callbacks calls
`processQueue()`. The first timer to fire starts a run with one task in the
queue, so a failed batch of N comes back as N single-file requests rather than
as one batch of N. The delay is per task and identical, so this is not a
deliberate stagger.

One shared timer that re-queues the whole batch and then calls `processQueue`
once would restore the batching. Nothing is broken by the current shape — every
file is still retried and still ends up cached — so this is efficiency, not
correctness.

Noticed while writing `preloader.test.ts`'s "retries every task when the
decoder itself throws", which had to be written to the current behaviour.

## A trim end that outlived its audio reports a length the file does not have

`playBlobStreaming` computes `track.duration` from the trim range at trigger
time (`trimEnd - trimStart`). The `loadedmetadata` handler then re-clamps
`trimStart`/`trimEnd` against the real duration — an unusable `trimEnd`
becomes `undefined`, play to the natural end — but only recomputes
`track.duration` `if (track.duration <= 0)`.

So a pad carrying `trimEnd: 500` on a ten-second file plays correctly and
reports 8:19 remaining for its whole length. This is reachable rather than
theoretical: `audioTrimSettings` is keyed by audio file id and survives
`replaceMissingAudioFile`, so replacing a missing sound with a shorter one
produces exactly this.

The fix is one line — recompute `track.duration` from the re-clamped range
whenever the range actually changed, not only when the duration is still zero.
`playback.streaming.test.ts` asserts the current behaviour with a comment
pointing here, so the test will need updating with the fix.

Noticed while writing that suite; the assertion was written to what the code
does after the expectation of 9 measured 499.

## The search matcher does not trim the term it matches on

`useSearch` decides _whether to search_ on a trimmed term:

```ts
const hasQuery = searchTerm.trim().length > 0 && activeProfileId !== null;
```

but it matches on the raw one:

```ts
const searchTermLower = searchTerm.toLowerCase();
const nameMatches = padName.toLowerCase().includes(searchTermLower);
```

So typing `"horn "` searches — `hasQuery` is true — and matches nothing, because
no pad name contains a trailing space. The operator sees "No sounds found" for
a sound that is on the board. A trailing space is easy to arrive at: it is what
a double-tap on a phone keyboard's space bar leaves behind, and what pasting a
cue name out of a script usually carries.

The fix is one line (match on the trimmed term), but it is a behaviour change
in the middle of a live-performance path, so it wants its own commit and its
own case in `useSearch.test.tsx` rather than riding along with something else.

Noticed while writing the failure-path tests for the same hook: a test that
typed `"horn "` as "a different term that still matches" found nothing, and the
hook was right to find nothing.

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
