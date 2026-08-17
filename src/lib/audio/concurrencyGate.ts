/**
 * A counted gate for work that must not all run at once.
 *
 * Both users of this are jobs that each hold a fully decoded `AudioBuffer`
 * while they run — decoding for playback, and measuring loudness — so the
 * thing being limited is resident memory as much as CPU. Forty three-minute
 * stereo files decoded at once is a couple of gigabytes; three at a time is
 * nothing.
 *
 * @module lib/audio/concurrencyGate
 */

export interface ConcurrencyGate {
  /** Resolves once a slot is free, and holds it until `release`. */
  acquire(): Promise<void>;
  /** Hands the slot to the next waiter, or gives it back to the pool. */
  release(): void;
}

/**
 * Hands out a fixed number of slots, queueing callers beyond that.
 *
 * A counter rather than "wait until the set of running work drains": the work
 * promises are what a caller is *part of*, so waiting on them is waiting on
 * yourself, which is exactly how the pipelined decoder once deadlocked every
 * preload batch. Releasing passes the slot straight to the next waiter instead
 * of decrementing, so a slot cannot be taken by a caller that arrives in the
 * gap.
 *
 * @param limit - How many callers may hold a slot at once
 * @returns The gate
 */
export function createConcurrencyGate(limit: number): ConcurrencyGate {
  const capacity = Math.max(1, limit);
  let inUse = 0;
  const waiting: Array<() => void> = [];

  return {
    async acquire(): Promise<void> {
      if (inUse < capacity) {
        inUse++;
        return;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    },
    release(): void {
      const next = waiting.shift();
      if (next) {
        next();
        return;
      }
      inUse--;
    },
  };
}
