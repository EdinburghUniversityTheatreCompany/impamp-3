import { beforeEach, describe, expect, it } from "vitest";
import {
  cacheAudioBuffer,
  clearAudioBufferPins,
  clearAudioCache,
  clearCachedAudioBuffer,
  getAudioCacheStats,
  invalidateCachedAudioBuffer,
  isAudioBufferCached,
  isAudioBufferPinned,
  pinAudioBuffer,
  resetCacheConfiguration,
  unpinAudioBuffer,
} from "./cache";

// A stand-in for a decoded AudioBuffer. The cache only reads the three
// fields it needs to estimate memory, so a plain object is enough and keeps
// these tests runnable in Vitest's node environment (no Web Audio API).
function fakeBuffer(durationSeconds: number): AudioBuffer {
  return {
    numberOfChannels: 2,
    sampleRate: 48000,
    duration: durationSeconds,
    length: 48000 * durationSeconds,
  } as unknown as AudioBuffer;
}

// 2ch * 48000Hz * 300s * 4 bytes ≈ 115MB, so five of these blow past the
// 500MB default cap and force an eviction pass on the fifth insert.
const BIG_SECONDS = 300;

function fillCacheToEviction(): void {
  for (const id of [1, 2, 3, 4]) {
    cacheAudioBuffer(id, fakeBuffer(BIG_SECONDS));
  }
  // Pushes total memory over the cap, triggering a "limit" cleanup
  cacheAudioBuffer(5, fakeBuffer(BIG_SECONDS));
}

describe("audio buffer cache pinning", () => {
  beforeEach(() => {
    clearAudioCache();
    clearAudioBufferPins();
    resetCacheConfiguration();
  });

  it("evicts the least recently used buffer when nothing is pinned", () => {
    fillCacheToEviction();

    expect(isAudioBufferCached(1)).toBe(false);
    expect(isAudioBufferCached(5)).toBe(true);
  });

  it("keeps a pinned buffer even when it is the least recently used", () => {
    cacheAudioBuffer(1, fakeBuffer(BIG_SECONDS));
    pinAudioBuffer(1);
    for (const id of [2, 3, 4]) {
      cacheAudioBuffer(id, fakeBuffer(BIG_SECONDS));
    }
    cacheAudioBuffer(5, fakeBuffer(BIG_SECONDS));

    expect(isAudioBufferCached(1)).toBe(true);
    // Unpinned neighbours are still fair game
    expect(isAudioBufferCached(2)).toBe(false);
  });

  it("protects a buffer pinned before it was ever cached", () => {
    // Arming a pad pins its files immediately; the decode lands later.
    pinAudioBuffer(1);
    fillCacheToEviction();

    expect(isAudioBufferCached(1)).toBe(true);
  });

  it("keeps the pin until every holder has released it", () => {
    // Two armed pads can reference the same audio file
    pinAudioBuffer(1);
    pinAudioBuffer(1);
    unpinAudioBuffer(1);

    expect(isAudioBufferPinned(1)).toBe(true);
    fillCacheToEviction();
    expect(isAudioBufferCached(1)).toBe(true);
  });

  it("releases the pin after as many unpins as there were pins", () => {
    // The sequence the two tests around this one never make between them:
    // pin x2 then unpin x2. `count - 1` written as `count + 1` — two armed
    // pads sharing a sound never releasing it, so the buffer becomes
    // permanently unevictable on a cache whose whole job is bounding memory —
    // left all of cache.test.ts green.
    pinAudioBuffer(1);
    pinAudioBuffer(1);
    unpinAudioBuffer(1);
    unpinAudioBuffer(1);

    expect(isAudioBufferPinned(1)).toBe(false);
    fillCacheToEviction();
    expect(isAudioBufferCached(1)).toBe(false);
  });

  it("makes a buffer evictable again once fully unpinned", () => {
    pinAudioBuffer(1);
    unpinAudioBuffer(1);

    expect(isAudioBufferPinned(1)).toBe(false);
    fillCacheToEviction();
    expect(isAudioBufferCached(1)).toBe(false);
  });

  it("ignores an unpin for a file that was never pinned", () => {
    unpinAudioBuffer(99);
    expect(isAudioBufferPinned(99)).toBe(false);

    // `not.toThrow()` says nothing on its own, but the line under it is not
    // vacuous the way it looks: `isAudioBufferPinned` is `has()`, so a stray
    // unpin that inserted *anything* — a zero, a negative, a NaN — would be
    // caught. Removing the `count === undefined` guard does exactly that, and
    // this test fails.
    //
    // The two lines below are for the reimplementation rather than the
    // implementation: if pinning ever became count-based, a stray unpin
    // reaching -1 would be silent until the next pin failed to hold, and this
    // is where that would show up.
    pinAudioBuffer(99);
    expect(isAudioBufferPinned(99)).toBe(true);
  });

  it("reports pinned entries in the cache stats", () => {
    cacheAudioBuffer(1, fakeBuffer(1));
    cacheAudioBuffer(2, fakeBuffer(1));
    pinAudioBuffer(1);

    const stats = getAudioCacheStats();
    expect(stats.pinnedEntries).toBe(1);
  });

  it("drops the pin with the row it was protecting", () => {
    // `clearCachedAudioBuffer` is what every deletion path calls once the row
    // is gone from IndexedDB. It used to delete from the buffer map only, so
    // the pin outlived the row it named: `isAudioBufferPinned` answered true
    // for it forever and nothing could ever collect it, because nothing could
    // still name the id to unpin it.
    cacheAudioBuffer(1, fakeBuffer(1));
    pinAudioBuffer(1);

    clearCachedAudioBuffer(1);

    expect(isAudioBufferCached(1)).toBe(false);
    expect(isAudioBufferPinned(1)).toBe(false);
  });

  it("drops a pin held for a row that was never decoded", () => {
    // Arming pins immediately and the decode lands later, so a row deleted
    // between the two leaves a pin with no cache entry beside it. The early
    // return on "nothing was cached" is exactly where that used to be missed.
    pinAudioBuffer(1);

    expect(clearCachedAudioBuffer(1)).toBe(false);
    expect(isAudioBufferPinned(1)).toBe(false);
  });

  it("drops every holder's pin at once, not one of them", () => {
    // The pin is reference counted, but a deleted row is not one holder
    // releasing its claim — there is nothing left to hold. Decrementing here
    // would leave two armed pads' shared sound pinned to a row that is gone.
    pinAudioBuffer(1);
    pinAudioBuffer(1);

    clearCachedAudioBuffer(1);

    expect(isAudioBufferPinned(1)).toBe(false);
  });

  it("keeps the pin when a buffer is only invalidated for a retry", () => {
    // The other half of the same distinction, and the reason the two cannot
    // be one function. A failed decode is invalidated before it is retried,
    // and the row is still there — so an armed cue's claim on it has to
    // survive, or the very first failed decode would unprotect the sound the
    // operator has cued.
    cacheAudioBuffer(1, null);
    pinAudioBuffer(1);

    invalidateCachedAudioBuffer(1);

    expect(isAudioBufferCached(1)).toBe(false);
    expect(isAudioBufferPinned(1)).toBe(true);
  });

  it("leaves every pin alone when the whole cache is emptied", () => {
    // Same rule as the case above, wholesale: emptying the buffer map deletes
    // no rows, so every holder's claim is still live and still owed an unpin.
    cacheAudioBuffer(1, fakeBuffer(1));
    pinAudioBuffer(1);

    clearAudioCache();

    expect(isAudioBufferCached(1)).toBe(false);
    expect(isAudioBufferPinned(1)).toBe(true);
  });

  it("drops pins when they are cleared wholesale", () => {
    pinAudioBuffer(1);
    pinAudioBuffer(2);
    clearAudioBufferPins();

    expect(isAudioBufferPinned(1)).toBe(false);
    expect(isAudioBufferPinned(2)).toBe(false);
  });
});
