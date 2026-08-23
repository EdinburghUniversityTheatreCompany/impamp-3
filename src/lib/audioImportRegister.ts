/**
 * The audio-import register: the two-sided rule that keeps an import's audio
 * alive until the pads naming it exist.
 *
 * Extracted from `db.ts`, where it sat among forty CRUD helpers in a 2757-line
 * module that fifty-two others import. It is the repo's most safety-critical
 * invariant and it has no type and no lint rule behind it — `CLAUDE.md` devotes
 * its longest paragraph to the fact that a writer can only be found by grepping
 * the callers of `addOrReuseAudioFile`. A rule enforced by prose is easier to
 * keep correct when it has a module of its own rather than a stretch of a file
 * people open for `getProfile`.
 *
 * **Nothing about the rule changed in the move**, and `db.ts` re-exports all
 * three names so every existing import still resolves. That re-export is
 * deliberate rather than transitional: the rule is repo-wide, `db.ts` is where
 * the deleters live, and rewriting a dozen import lines would have put churn
 * across the sync paths in the same branch that made them concurrent. New code
 * should import from here.
 *
 * The two sides, in full, because sweeping one is worth nothing — which has
 * happened:
 *
 * - **Writers declare.** Anything that writes an audio file and the pad naming
 *   it in *separate transactions* runs inside `withAudioImportInProgress`, or
 *   holds `beginAudioImport()` where the two halves are two user actions rather
 *   than two transactions (the pad editor).
 * - **Deleters wait.** Every deleter of audio rows awaits `settleAudioImports()`
 *   as the last thing before opening its transaction, and is never called from
 *   inside a scope — that would wait for the import that is waiting for it, and
 *   hang rather than fail.
 *
 * The register is in memory, so it is one tab wide.
 *
 * @module lib/audioImportRegister
 */

/**
 * Imports that are partway through attaching audio to pads.
 *
 * An import writes its audio records first and the pads that name them
 * several steps later, and it cannot do otherwise: a pad names its sounds by
 * the ids the audio store assigns on write, so those ids do not exist until
 * the audio does. Between the two moments the audio is real and nothing
 * references it — which is precisely what `cleanupOrphanedAudioFiles` exists
 * to delete. A cleanup landing in that window took sounds out from under an
 * import that then wrote pads naming files that were already gone.
 *
 * So an import declares itself here (`withAudioImportInProgress`) and every
 * deleter waits for it to finish before it looks. That is a guarantee
 * rather than a guess: no timer, nothing to tune, and no dependence on how
 * long the import takes. The alternatives do not survive contact with the
 * code. A grace period on recently-created audio cannot work at all —
 * `importAudioSources` stamps every record with the one `now` taken when the
 * import began, so after ten minutes of downloads its files are ten minutes
 * old at the moment its pads are written, and any grace period short enough
 * to still clean up is already too short. One transaction spanning the whole
 * import is not merely slow but impossible: an IndexedDB transaction commits
 * as soon as the event loop turns with no request outstanding, and an import
 * awaits a network download between files.
 *
 * The register is in memory, so it is exactly as wide as one tab: a second
 * tab importing while this one sweeps is still unprotected. That is the
 * honest limit of this fix — the register would have to move into the
 * database, or onto the Web Locks API, to cover it — and it is a far smaller
 * hole than the one it replaces, since both operations are ordinary
 * foreground work in the tab the user is looking at.
 */
const audioImportsInFlight = new Set<Promise<void>>();

/**
 * Runs an import that writes audio, holding off every audio deleter until it
 * has finished writing the pads that name it.
 *
 * The registered promise is one this function owns and resolves itself, never
 * the import's own: a failed import has to release the deleters exactly like a
 * successful one, and a rejection kept in a `Set` for other code to `await` is
 * an unhandled rejection waiting to be reported.
 *
 * The de-registration is a `finally` rather than a `.then` on the import, so
 * it happens *before* the caller's own `catch` runs rather than a microtask
 * after it. That ordering is what lets an import roll its own failure back on
 * the other side of this call and find the register already clear — see
 * `settleAudioImports` for why the rollback cannot happen on this side of it.
 */
export async function withAudioImportInProgress<T>(
  run: () => Promise<T>,
): Promise<T> {
  const release = beginAudioImport();
  try {
    return await run();
  } finally {
    release();
  }
}

/**
 * The same declaration, for a writer whose two halves are not one call.
 *
 * The pad editor is the case this exists for: it writes a sound's row the
 * moment the file is picked — the list and the trimmer both read it back by
 * id, so it has to exist before it can be shown — and the pad naming it only
 * on Save, which may be minutes later and is a different event entirely. There
 * is no callback to wrap, so the scope has to be opened and closed by hand.
 *
 * Two rules come with that, and neither has a compiler behind it. The release
 * must run on **every** exit, or every audio deleter in the tab waits for ever
 * — which is why the one caller releases from an unmount cleanup, the single
 * path both saving and dismissing take. And it must run **before** any deleter
 * the same caller then starts: `settleAudioImports` waits for every registered
 * import and nothing tells it which one its caller is holding, so a deleter
 * called while this hold is open waits for the hold that is waiting for it.
 * The release is synchronous and idempotent so that ordering is expressible.
 *
 * @returns The release, which may safely be called more than once
 */
export function beginAudioImport(): () => void {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  audioImportsInFlight.add(settled);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    audioImportsInFlight.delete(settled);
    finish();
  };
}

/**
 * Waits until no import is midway through attaching audio.
 *
 * Loops rather than awaiting one snapshot, because an import can start while
 * we are waiting for another. Callers must open their transaction in the same
 * turn this returns in: an import that registers *after* that transaction
 * exists is harmless — IndexedDB serialises its audio write behind the
 * sweep's overlapping readwrite scope, so the sweep never sees the new
 * records at all — but one that registers in a turn between the two would be
 * missed.
 *
 * **This is one half of a two-sided rule, and the half that was swept first.**
 * Waiting buys nothing unless the writer at risk is in the register to be
 * waited for: the rework that added this call to all five deleters declared no
 * writer at all, and six of them were still walking through the window it was
 * written to close. `withAudioImportInProgress` (or `beginAudioImport`, where
 * the two writes are two user actions) is the other half, and CLAUDE.md names
 * every writer that has to take it — grep the callers of
 * `addOrReuseAudioFile` to check the list is still complete.
 *
 * **Exported because the rule is repo-wide, not db.ts-wide.** The rule has no
 * exceptions: *every* deleter of audio rows calls this immediately before
 * opening its transaction, and none of them may be called from inside
 * `withAudioImportInProgress`. That is five deleters — `deleteProfile`,
 * `deleteUnreferencedAudioFiles`, `findOrphanedAudioFiles`,
 * `cleanupOrphanedAudioFiles` and `collapseDuplicateAudioGroups` — and the
 * second half of the sentence is why an import's rollback runs on the far
 * side of its own scope rather than inside it (see `importProfileCore`).
 * A deleter that waits from inside a scope waits for the import that is
 * waiting for it, which hangs rather than fails.
 *
 * This used to be exported "because `collapseDuplicateAudioGroups` is written
 * outside this file", with `deleteUnreferencedAudioFiles` named as a
 * deliberate exception on the grounds that it only considers ids its own
 * caller just created. Reuse by content hash ended that: `addOrReuseAudioFile`
 * hands back rows that already existed, so a caller's "created" list routinely
 * holds rows another import is mid-flight on. Both remaining deleters were
 * measured taking such a row out from under an import — see
 * `db.importRace.test.ts`.
 */
export async function settleAudioImports(): Promise<void> {
  while (audioImportsInFlight.size > 0) {
    await Promise.all([...audioImportsInFlight]);
  }
}
