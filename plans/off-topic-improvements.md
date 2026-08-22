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
