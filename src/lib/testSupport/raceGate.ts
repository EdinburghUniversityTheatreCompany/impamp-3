/**
 * A hand-operated pause, for holding a writer between its two writes.
 *
 * The audio-import register has two halves: a writer that writes an audio row
 * and the pad naming it in separate transactions declares itself with
 * `withAudioImportInProgress`, and every deleter waits on
 * `settleAudioImports()` before it opens its transaction. Testing the writers'
 * half means catching a writer inside that window, and a test that merely
 * starts a deleter "at about the right moment" is measuring the scheduler:
 * it passes or fails on how many microtasks fake-indexeddb happens to take.
 *
 * So the window is opened by hand instead. The code under test awaits
 * `arrive()` at the point the fixture wants it stopped, the test waits for
 * `reached`, starts its deleter, gives it `longEnoughToDelete()` — far more
 * turns than it needs when nothing is holding it — and only then calls
 * `release()`. Undeclared, the deleter always wins; declared, it always waits.
 * The ordering is the same one `db.importRace.test.ts` uses from the other
 * side, and it is deterministic by construction rather than by timing luck.
 *
 * @module lib/testSupport/raceGate
 */

export interface RaceGate {
  /** Resolves once the code under test has reached the gate. */
  reached: Promise<void>;
  /** Lets the code under test carry on. */
  release: () => void;
  /** Called by the code under test: announces arrival, then blocks. */
  arrive: () => Promise<void>;
}

export function createRaceGate(): RaceGate {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announce!: () => void;
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  return {
    reached,
    release,
    arrive: async () => {
      announce();
      await held;
    },
  };
}

/** One turn of the macrotask queue. */
export function macro(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/** As many turns as a deleter could possibly need to run to completion. */
export async function longEnoughToDelete(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await macro();
}
