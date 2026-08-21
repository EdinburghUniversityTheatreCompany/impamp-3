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
  /** Renders something else into the same container. */
  render(node: ReactNode): Promise<void>;
  /** Unmounts and removes the container. */
  unmount(): Promise<void>;
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
