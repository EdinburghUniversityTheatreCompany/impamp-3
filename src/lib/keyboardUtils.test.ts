import { describe, expect, it } from "vitest";
import { isControlActivationKey } from "./keyboardUtils";

/**
 * Half of the rule that lets Tab reach the chrome without the board losing
 * its transport keys: which keys a focused control would activate on. The
 * other half — whether focus got there by Tab or by a pointer — lives in
 * `useKeyboardListener` and is pinned by e2e-tests/chrome-keyboard.spec.ts.
 */

interface FakeTargetOptions {
  tagName?: string;
  role?: string | null;
}

function fakeTarget({
  tagName = "BUTTON",
  role = null,
}: FakeTargetOptions = {}) {
  return {
    tagName,
    getAttribute: (name: string) => (name === "role" ? role : null),
  };
}

describe("isControlActivationKey", () => {
  it.each(["Enter", " "])("claims %j for a focused button", (key) => {
    expect(isControlActivationKey(key, fakeTarget())).toBe(true);
  });

  // A letter still fires its pad and a digit still switches bank, even while
  // focus sits on a header button — only the two keys a control activates on
  // are ever given away.
  it.each(["q", "3", "F9", "Escape"])(
    "never claims %j, whatever holds focus",
    (key) => {
      expect(isControlActivationKey(key, fakeTarget())).toBe(false);
    },
  );

  it("recognises a control by its role as well as its tag", () => {
    expect(
      isControlActivationKey(
        "Enter",
        fakeTarget({ tagName: "DIV", role: "tab" }),
      ),
    ).toBe(true);
  });

  it("ignores an element that is not a control", () => {
    expect(
      isControlActivationKey(
        "Enter",
        fakeTarget({ tagName: "DIV", role: null }),
      ),
    ).toBe(false);
  });

  // The board keeps the key whenever the answer is unknowable: no target, or
  // a target that is not an element.
  it.each([
    ["no target", null],
    ["a non-element target", { nope: true }],
    ["a global object target", globalThis as unknown],
  ])("keeps the key for %s", (_label, target) => {
    expect(isControlActivationKey("Enter", target)).toBe(false);
  });
});
