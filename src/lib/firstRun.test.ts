/**
 * The welcome tour's memory, and what it does when it has none.
 *
 * The interesting cases are the failures. `localStorage` does not return null
 * when site data is blocked — it *throws*, on the read as well as the write —
 * and this is consulted on the first paint of the app's only page. The
 * direction of the failure matters more than the feature: an unreadable store
 * must read as "already seen", because a tour that cannot record its own
 * dismissal reappears on every single load with no way out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installFakeLocalStorage,
  installThrowingLocalStorage,
} from "@/lib/testSupport/fakeLocalStorage";
import {
  forgetWelcomeTourSeen,
  hasSeenWelcomeTour,
  markWelcomeTourSeen,
} from "./firstRun";

const KEY = "impamp:welcomeTourSeen";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("welcome tour memory", () => {
  it("has not been seen on a device that has never stored the flag", () => {
    installFakeLocalStorage();
    expect(hasSeenWelcomeTour()).toBe(false);
  });

  it("remembers being seen", () => {
    const data = installFakeLocalStorage();
    markWelcomeTourSeen();
    expect(data.get(KEY)).toBe("1");
    expect(hasSeenWelcomeTour()).toBe(true);
  });

  it("forgets on request, so Help can replay it", () => {
    installFakeLocalStorage();
    markWelcomeTourSeen();
    forgetWelcomeTourSeen();
    expect(hasSeenWelcomeTour()).toBe(false);
  });

  it("reads as seen when the store throws, rather than looping forever", () => {
    installThrowingLocalStorage();
    expect(hasSeenWelcomeTour()).toBe(true);
  });

  it("does not throw out of the writers when the store throws", () => {
    installThrowingLocalStorage();
    expect(() => markWelcomeTourSeen()).not.toThrow();
    expect(() => forgetWelcomeTourSeen()).not.toThrow();
  });

  it("reads as seen during server rendering, where there is no window", () => {
    vi.stubGlobal("window", undefined);
    expect(hasSeenWelcomeTour()).toBe(true);
  });
});
