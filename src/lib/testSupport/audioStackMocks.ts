/**
 * The stubs every "watch a trigger decide" suite needs below `controls.ts`.
 *
 * `controls.trigger.test.ts` and `controls.layer.test.ts` both stub the audio
 * stack down to the decoder, the playback module and the database so a trigger
 * can be walked step by step. Four of those stubs were byte-identical in both
 * files — the buffer cache, the audio context, the preloader and the profile
 * store — and a fifth differed only in which `getAudioFile` it overlaid onto
 * the real `@/lib/db`. That shared block was large enough to fail the jscpd
 * gate, and, worse, it is the definition of "what a trigger sees": two copies
 * are two places for that to drift.
 *
 * These are installed with `vi.doMock` rather than `vi.mock`, which is what
 * lets them live in a module at all — `vi.mock` is hoisted to the top of the
 * file it is written in and cannot be called on another file's behalf.
 * `vi.doMock` applies to *subsequent dynamic imports*, so call this before the
 * `await import("./controls")` at the top of the suite, which is where these
 * suites already load the module under test.
 *
 * The paths are aliases rather than the `./cache` / `../db` the suites used to
 * write, because a relative path would resolve against this file. Both forms
 * resolve to the same module id, so `controls.ts`'s own `./cache` import still
 * receives the stub.
 *
 * Deliberately NOT covered here: the decoder and the playback module. Those
 * are the surfaces each suite asserts against, and they differ per suite; a
 * shared stub for them would be a shared claim about what a trigger did.
 */

import { vi } from "vitest";
import type { ActivePadBehavior } from "@/lib/db";

export interface AudioStackMockOptions {
  /**
   * The profile-level behaviour the resolver sees, read on every call so a
   * suite can vary it per test rather than per file.
   */
  activePadBehavior?: () => ActivePadBehavior;
  /**
   * Exports to overlay on the real `@/lib/db`, in addition to the default
   * `getAudioFile`. A suite that wants to drive `getAudioFile` per test passes
   * its own `vi.fn()` here and keeps a handle on it.
   */
  db?: Record<string, unknown>;
}

/**
 * Stubs the audio cache, the audio context, the database, the preloader and
 * the profile store for the dynamic imports that follow.
 *
 * The database stub spreads the *real* module: `controls` reads
 * `resolveActivePadBehavior` from there as well as `getAudioFile`, and a mock
 * listing only the latter leaves the resolver undefined — which fails as a
 * broken behaviour switch rather than as the broken mock it is.
 *
 * @param options - Per-suite variation; see {@link AudioStackMockOptions}
 */
export function mockAudioStack(options: AudioStackMockOptions = {}): void {
  const activePadBehavior = options.activePadBehavior ?? (() => "continue");

  vi.doMock("@/lib/audio/cache", () => ({
    getCachedAudioBuffer: vi.fn(() => null),
    clearCachedAudioBuffer: vi.fn(),
    invalidateCachedAudioBuffer: vi.fn(),
  }));
  vi.doMock("@/lib/audio/context", () => ({
    resumeAudioContext: vi.fn(),
    getAudioContext: vi.fn(() => ({ state: "running", currentTime: 0 })),
  }));
  vi.doMock("@/lib/db", async () => {
    const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
    return {
      ...actual,
      getAudioFile: vi.fn(async () => null),
      ...options.db,
    };
  });
  vi.doMock("@/lib/audio/preloader", () => ({
    audioPreloader: { trackPlayedFile: vi.fn() },
  }));
  vi.doMock("@/store/profileStore", () => ({
    useProfileStore: {
      getState: () => ({
        getActivePadBehavior: () => activePadBehavior(),
        getNormalisationSettings: () => ({ enabled: false, targetLufs: -23 }),
      }),
    },
  }));
}
