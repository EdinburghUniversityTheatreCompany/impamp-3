/**
 * When the first-use tour is offered, and — much more importantly — when it is
 * not.
 *
 * The board is a live performance tool. A modal that can appear over a board
 * someone has built is not a tutorial, it is an incident, so the offer is
 * gated on the board being empty as well as on the tour being unseen. That
 * second condition is the one worth a test: the first is obvious and would
 * survive any refactor, while "empty board" is the kind of guard someone
 * removes while simplifying.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installFakeLocalStorage,
  installThrowingLocalStorage,
} from "@/lib/testSupport/fakeLocalStorage";
import { shouldOfferWelcomeTour } from "./uiUtils";
import { markWelcomeTourSeen } from "./firstRun";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldOfferWelcomeTour", () => {
  it("offers it on an empty board nobody has been shown", () => {
    installFakeLocalStorage();
    expect(shouldOfferWelcomeTour(0)).toBe(true);
  });

  it("does not offer it over a board that has sounds on it", () => {
    installFakeLocalStorage();
    expect(shouldOfferWelcomeTour(1)).toBe(false);
    expect(shouldOfferWelcomeTour(48)).toBe(false);
  });

  it("does not offer it twice on the same device", () => {
    installFakeLocalStorage();
    markWelcomeTourSeen();
    expect(shouldOfferWelcomeTour(0)).toBe(false);
  });

  it("does not offer it when the store cannot be read", () => {
    installThrowingLocalStorage();
    expect(shouldOfferWelcomeTour(0)).toBe(false);
  });
});
