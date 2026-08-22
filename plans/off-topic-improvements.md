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
