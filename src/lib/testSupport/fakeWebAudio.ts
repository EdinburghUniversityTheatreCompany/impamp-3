/**
 * The Web Audio fake that `playback.ts`'s buffer path is unit-tested against.
 *
 * The only Web Audio the playback module touches is `getAudioContext`, so a
 * fake context whose sources record their `stop()` calls is enough to tell a
 * source that was really silenced from one that was merely forgotten about —
 * which is the distinction every test of a stop, a fade or a displacement
 * turns on.
 *
 * Two suites need exactly this fake: `playback.race.test.ts` (a pending
 * trigger colliding with a second trigger or another pad's stop) and
 * `playback.layers.test.ts` (the same engine, now with several instances per
 * pad). They had a byte-identical copy each, which is what made them a
 * duplicate block big enough to fail the jscpd gate; the honest fix is one
 * copy, not a suppression pragma.
 *
 * Not every suite that touches playback wants this. `controls.layerEngine.
 * test.ts` never inspects a node — a layer there *is* a live entry in the
 * engine's registry — so it writes a smaller fake to the same surface, and
 * `playback.trimEnd.test.ts` needs a gain param that records its ramps rather
 * than one that swallows them. Reach for this helper when a test asserts that
 * a *source* was stopped; write your own when it does not.
 */

import type { PlayAudioParams } from "@/lib/audio/types";

/** Accepts and discards automation, because nothing here asserts on level. */
export class FakeAudioParam {
  value = 1;
  setValueAtTime() {
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
  linearRampToValueAtTime() {
    return this;
  }
}

export class FakeGainNode {
  gain = new FakeAudioParam();
  connect() {}
  disconnect() {}
}

export class FakeBufferSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  startCalls = 0;
  stopCalls: number[] = [];
  connect() {}
  disconnect() {}
  start() {
    this.startCalls++;
  }
  stop(when = 0) {
    this.stopCalls.push(when);
  }
  /** True once anything has asked this source to stop. */
  get stopped() {
    return this.stopCalls.length > 0;
  }
}

/**
 * Every source the fake context has handed out, in creation order.
 *
 * A test reads this to reach a source the engine has since dropped from its
 * own maps — the orphaned-source case that has no other observer. Vitest
 * isolates modules per test file, so each suite gets its own array.
 */
export const createdSources: FakeBufferSource[] = [];

export const fakeAudioContext = {
  currentTime: 0,
  state: "running" as const,
  destination: {},
  createBufferSource() {
    const source = new FakeBufferSource();
    createdSources.push(source);
    return source;
  },
  createGain() {
    return new FakeGainNode();
  },
};

/** Empties {@link createdSources}. Call it from `beforeEach`, after the stop. */
export function resetFakeWebAudio(): void {
  createdSources.length = 0;
}

/**
 * Stubs the two rAF globals node does not have.
 *
 * The progress loop is irrelevant to these suites; the stub only keeps it from
 * throwing. A callback is never invoked, so no frame is ever painted.
 */
export function stubAnimationFrame(): void {
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
}

/** A ten-second stereo buffer. Only `duration` is ever read. */
export const fakeAudioBuffer = {
  duration: 10,
  numberOfChannels: 2,
} as unknown as AudioBuffer;

/**
 * The minimum `playBuffer` params for a single-sound sequential pad.
 *
 * `padInfo` is deliberately absent: `playback.ts` only copies it onto the
 * track it registers, and no assertion in either suite reads it back. The cast
 * is what says so out loud.
 *
 * @param name - The track name, which these suites set to the playback key
 * @returns Params suitable for `playBuffer`
 */
export function fakePlayParams(name: string): PlayAudioParams {
  return {
    name,
    volume: 1,
    multiSoundState: {
      playbackType: "sequential",
      allAudioFileIds: [1],
      currentAudioFileId: 1,
      currentAudioIndex: 0,
    },
  } as unknown as PlayAudioParams;
}
