/**
 * Silences the console for the current test.
 *
 * Several modules under test log on every path they take — the decoder, the
 * preloader, the audio context, the profile store — so a suite that exercises
 * their branches deliberately buries the run's real output under hundreds of
 * lines. Muting one channel at a time is the obvious thing to write, which is
 * why three suites wrote the same four lines and tripped the jscpd gate.
 *
 * Only `log`, `warn` and `error` are muted, and they are muted as *spies*, so
 * a test that asserts on what was warned still can. Anything the suite does
 * not mute still reaches the reporter.
 */

import { vi, type MockInstance } from "vitest";

/** The three console spies a suite might want to assert on. */
export interface QuietedConsole {
  log: MockInstance;
  warn: MockInstance;
  error: MockInstance;
}

/**
 * Replaces `console.log`, `console.warn` and `console.error` with spies.
 *
 * Call it from `beforeEach`. `vi.restoreAllMocks()` in `afterEach` puts the
 * real ones back — every suite using this has that, and a suite without it
 * would re-spy an already-spied channel on every test.
 *
 * @returns The three spies, for a test that asserts on what was logged
 */
export function quietConsole(): QuietedConsole {
  const mute = (channel: "log" | "warn" | "error") =>
    vi.spyOn(console, channel).mockImplementation(() => {});

  return { log: mute("log"), warn: mute("warn"), error: mute("error") };
}
