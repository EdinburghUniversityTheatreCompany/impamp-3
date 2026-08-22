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
test's name was not captured, so this is the shape rather than a specific
diagnosis. Fake timers, or a settle that waits on a condition rather than a
count, would end the class. Noticed while merging `p2/icons`.

## Nothing bounds what a presigned PUT actually writes

`upload-url` mints a presigned PUT whose signature covers only `host`
(`src/lib/server/s3/client.ts`), so the `sizeBytes` a client declares is a
claim and the bytes that arrive are unconstrained. Commit measures the object
and refuses an over-size one, and uncommitted objects are now charged
provisionally and swept hourly — but a caller who declares a byte, sends five
gigabytes and never commits still gets those bytes into the bucket until the
sweep reaches them, with Wasabi's 90-day minimum billing on each.

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
