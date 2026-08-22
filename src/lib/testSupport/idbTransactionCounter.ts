/**
 * Counts the IndexedDB transactions a piece of code opens.
 *
 * "Once per sound" versus "once for the pass" is the difference between a
 * fixed cost and one that grows with the library, and it is the shape this
 * repo keeps having to assert. Counting transactions rather than milliseconds
 * is deliberate: a wall-clock threshold is a flake on a loaded machine, and
 * the count is what the timing was made of.
 *
 * The counter wraps the native `IDBDatabase.prototype.transaction`, so it sees
 * every transaction the code under test opens, whichever helper opened it —
 * including ones opened by work that merely *overlaps* the measured window.
 * `addAudioFile` starting a background loudness analysis is the one that keeps
 * catching people out; a suite seeding audio should stub
 * `@/lib/audio/loudness/pipeline` before it measures anything.
 *
 * Restore in `afterEach`, not at the end of the case: an assertion that throws
 * would otherwise leave the prototype patched for every later test in the
 * file.
 */

/** Counts every IndexedDB transaction opened while it is installed. */
export function countIdbTransactions(): {
  /** How many transactions have been opened since installation. */
  count: () => number;
  /** Puts `IDBDatabase.prototype.transaction` back. */
  restore: () => void;
} {
  const proto = IDBDatabase.prototype;
  const original = proto.transaction;
  let transactions = 0;

  proto.transaction = function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    transactions += 1;
    return original.apply(this, args);
  };

  return {
    count: () => transactions,
    restore: () => {
      proto.transaction = original;
    },
  };
}
