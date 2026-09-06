/**
 * Mounting a React panel in jsdom, and getting its async work into the DOM.
 *
 * Two of this repo's profile panels are self-contained components tested by
 * pressing their real buttons against a real (fake-indexeddb) database, and
 * both need the same three things: a container, `data-testid` lookups that
 * fail loudly rather than on `null.click`, and a press that waits for the work
 * the press started.
 *
 * That last one is the part worth having in one place. `act` alone returns
 * while the handler is still in flight: it awaits microtasks, and these
 * handlers do a dynamic `import()` and then IndexedDB callbacks, every one of
 * which is a macrotask. Ticking the timer queue *inside* the `act` scope is
 * what gets the resulting state into the DOM. A handler that is meant to stay
 * pending — a double-press guard, say — simply stays pending.
 *
 * This module must not import anything that touches IndexedDB: suites here
 * install `fake-indexeddb` through their own first import and then load
 * `db.ts` dynamically, and a static import of it from a helper would be
 * hoisted above that and defeat the arrangement.
 */

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/** How many macrotask turns a press is given to settle. */
const SETTLE_TICKS = 40;

/**
 * How long `waitFor` will wait for its condition, in wall-clock milliseconds.
 *
 * Generous on purpose, and well inside vitest's 20-second `testTimeout`: it is
 * a ceiling on a *failure*, not a duration any passing test pays — a condition
 * that is already true costs one check.
 */
const WAIT_TIMEOUT_MS = 5_000;

/**
 * A turn cap alongside the wall clock, in case the clock is not moving.
 *
 * `waitFor` is written for suites on real timers. If one installs fake timers,
 * `Date.now()` freezes and a purely wall-clock deadline never arrives, so the
 * loop would hang until the whole test timed out with nothing to say. This is
 * the seatbelt, not the mechanism.
 */
const WAIT_MAX_TICKS = 5_000;

export interface MountedPanel {
  /** The element the panel was rendered into. */
  container: HTMLDivElement;
  /** The element with this test id, or null. */
  testId(id: string): HTMLElement | null;
  /** The element with this test id, throwing a readable error when absent. */
  required(id: string): HTMLElement;
  /** Every element with this test id, in document order. */
  all(id: string): HTMLElement[];
  /** Presses the element with this test id and lets its work settle. */
  click(id: string): Promise<void>;
  /** Presses an element already in hand, and lets its work settle. */
  press(element: HTMLElement): Promise<void>;
  /**
   * Types a value into a select or input the way a user would.
   *
   * React listens for the native `change`/`input` event and reads the value
   * off its own descriptor, so assigning `element.value` and clicking does
   * nothing at all — the handler never runs and the test passes or fails for
   * the wrong reason. Going through the prototype's setter is what makes
   * React see the new value.
   */
  setValue(element: HTMLElement, value: string): Promise<void>;
  /** Lets pending work settle without pressing anything. */
  settle(): Promise<void>;
  /**
   * Waits until `condition` holds, or fails saying what it was waiting for.
   *
   * Prefer this to `settle()` wherever the test knows what it is waiting *for*.
   * `settle()` spends a fixed number of macrotask turns, which is a proxy for
   * "long enough" and not a good one: `setTimeout(0)` is clamped to about a
   * millisecond, so 40 turns is roughly 40 ms on an idle machine, and the work
   * being waited for — a file hash, an IndexedDB write, a re-read — is not
   * paced by the timer queue at all. Under load the two come apart, and the
   * assertion after the settle reads state that has not arrived. That has cost
   * this repo real time twice: `MissingAudioPanel.test.tsx` asserting
   * `Replaced` straight after a `settle()`, and `EditPadForm.dedup.test.tsx`
   * failing with "expected 2 sounds listed, saw 0" — both only when `hk` ran
   * jscpd and gitleaks beside vitest, and both green on five direct runs.
   *
   * A dynamic `import()` of a module vite-node has not fetched is the other
   * half: its fetch is not a macrotask the count can see, so no number of
   * turns is guaranteed to cover it.
   *
   * @param condition Checked between macrotask turns; must be synchronous
   * @param description What is being waited for, quoted in the failure
   */
  waitFor(condition: () => boolean, description?: string): Promise<void>;
  /** Renders something else into the same container. */
  render(node: ReactNode): Promise<void>;
  /** Unmounts and removes the container. */
  unmount(): Promise<void>;
}

/**
 * Waits until `condition` holds, or throws saying what it was waiting for.
 *
 * The module-level half of `MountedPanel.waitFor`, exported for the suites that
 * mount their own root rather than going through `mountPanel` — there must be
 * exactly one copy of this loop, and jscpd runs at threshold 0 to keep it that
 * way.
 *
 * @param condition Checked between macrotask turns; must be synchronous
 * @param description What is being waited for, quoted in the failure
 */
export async function waitForCondition(
  condition: () => boolean,
  description = "the condition",
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (let tick = 0; tick < WAIT_MAX_TICKS; tick++) {
    // Checked *between* `act` scopes, never inside one. React commits an
    // update when the scope it was queued in exits, so a condition read from
    // inside a single long-running `act` watches a DOM that is being held
    // still by the very wait — it can never come true, whatever the code under
    // test does. One turn per scope is what makes each new render visible to
    // the next check. Both hand-rolled polls this replaced had the loop inside
    // one scope, which is the likeliest reason they were load-sensitive.
    if (condition()) return;
    if (Date.now() >= deadline) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  if (!condition()) {
    throw new Error(
      `timed out after ${WAIT_TIMEOUT_MS} ms waiting for ${description}`,
    );
  }
}

/** Mounts a component and waits for whatever it starts on mount. */
export async function mountPanel(node: ReactNode): Promise<MountedPanel> {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const settle = async (): Promise<void> => {
    await act(async () => {
      for (let tick = 0; tick < SETTLE_TICKS; tick++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  };

  const testId = (id: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  const required = (id: string): HTMLElement => {
    const found = testId(id);
    if (!found) throw new Error(`no element with data-testid="${id}"`);
    return found;
  };

  const press = async (element: HTMLElement): Promise<void> => {
    await act(async () => {
      element.click();
      for (let tick = 0; tick < SETTLE_TICKS; tick++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  };

  const panel: MountedPanel = {
    container,
    testId,
    required,
    all: (id) => [
      ...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
    ],
    click: (id) => press(required(id)),
    press,
    setValue: async (element, value) => {
      const prototype = Object.getPrototypeOf(element) as object;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      await act(async () => {
        descriptor?.set?.call(element, value);
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
    },
    settle,
    waitFor: waitForCondition,
    render: async (next) => {
      await act(async () => {
        root.render(next);
      });
      await settle();
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };

  await panel.render(node);
  return panel;
}
