// @vitest-environment jsdom
/**
 * The modal shell, and the Escape stack every overlay in the app shares.
 *
 * Neither had a unit test, and both are almost entirely accessibility
 * behaviour — the kind that is invisible to a mouse user and completely
 * decides whether the app is usable from a keyboard or a screen reader.
 *
 * **The focus trap is load-bearing, not a backstop.** Its own comment says so:
 * Tab used to be suppressed app-wide by `useKeyboardListener`, that was removed
 * for costing the header, the bank tabs and the profile selector every
 * keyboard route in, and this trap is now the only thing keeping Tab inside an
 * open dialog. Without it, Tab walks straight out into the obscured page.
 *
 * **Focus moves in and comes back.** Opening a modal used to leave focus on the
 * trigger behind the overlay — a screen reader announced nothing and carried on
 * reading the page underneath — and closing dropped it to `<body>`, so the next
 * Tab restarted from the top of the document.
 *
 * **Escape belongs to the topmost overlay only.** A listener per overlay gets
 * this exactly backwards: among capture-phase listeners on one target the
 * earliest registration wins, and that is always the overlay furthest from the
 * user. That is not hypothetical — it is how Escape in the waveform trimmer
 * used to close the whole pad editor and discard the edit. And Escape must
 * never reach `useKeyboardListener`, where it doubles as the panic button that
 * silences the room.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";
import Modal from "./Modal";

let panel: MountedPanel | null = null;

/** Mounts something and remembers it, so `afterEach` can take it down. */
async function mount(node: Parameters<typeof mountPanel>[0]) {
  panel = await mountPanel(node);
  return panel;
}

/** Presses a key on `target` the way a browser would, and returns the event. */
function pressKey(
  target: EventTarget,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

/**
 * Presses Escape at the document, which is where a real one lands.
 *
 * Not at `window`: an event dispatched *on* window puts every listener there
 * in the target phase, where they run in registration order and the capture
 * flag buys nothing. A real keydown targets the focused element and reaches
 * window's capture listeners on the way down — which is the whole mechanism
 * `useEscapeToClose` relies on to get there first.
 */
const pressEscape = () => pressKey(document.body, "Escape");

afterEach(async () => {
  await panel?.unmount();
  panel = null;
  vi.restoreAllMocks();
});

describe("what the modal renders", () => {
  it("renders nothing at all while closed", async () => {
    const { container } = await mount(
      <Modal isOpen={false} onClose={() => {}} title="Settings">
        <p>body</p>
      </Modal>,
    );

    expect(container.innerHTML).toBe("");
  });

  it("names the dialog by its own heading", async () => {
    // An unnamed dialog is announced as just "dialog".
    const view = await mount(
      <Modal isOpen onClose={() => {}} title="Edit Pad">
        <p>body</p>
      </Modal>,
    );

    const dialog = view.required("custom-modal");
    const heading = view.required("modal-title");
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(dialog.hasAttribute("aria-label")).toBe(false);
  });

  it("falls back to a generic label when there is no heading", async () => {
    const view = await mount(
      <Modal isOpen onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );

    const dialog = view.required("custom-modal");
    expect(dialog.getAttribute("aria-label")).toBe("Dialog");
    expect(dialog.hasAttribute("aria-labelledby")).toBe(false);
    expect(view.testId("modal-title")).toBeNull();
  });

  it("marks itself modal, so assistive tech hides the page behind it", async () => {
    const view = await mount(
      <Modal isOpen onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );

    expect(view.required("custom-modal").getAttribute("role")).toBe("dialog");
    expect(view.required("custom-modal").getAttribute("aria-modal")).toBe(
      "true",
    );
  });

  it("shows no confirm button without a handler for it", async () => {
    const view = await mount(
      <Modal isOpen onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );

    expect(view.testId("modal-confirm-button")).toBeNull();
    expect(view.testId("modal-cancel-button")).not.toBeNull();
  });

  it("omits the whole button row when neither button is wanted", async () => {
    const view = await mount(
      <Modal
        isOpen
        onClose={() => {}}
        showConfirmButton={false}
        showCancelButton={false}
      >
        <p>body</p>
      </Modal>,
    );

    expect(view.testId("modal-cancel-button")).toBeNull();
    expect(view.testId("modal-confirm-button")).toBeNull();
  });

  it("uses the captions it was given", async () => {
    const view = await mount(
      <Modal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        confirmText="Overwrite"
        cancelText="Keep mine"
      >
        <p>body</p>
      </Modal>,
    );

    expect(view.required("modal-confirm-button").textContent).toBe("Overwrite");
    expect(view.required("modal-cancel-button").textContent).toBe("Keep mine");
  });
});

describe("the ways a modal closes", () => {
  it("closes on the × in the corner", async () => {
    const onClose = vi.fn();
    const view = await mount(
      <Modal isOpen onClose={onClose}>
        <p>body</p>
      </Modal>,
    );

    await view.click("modal-close-button");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a click on the overlay", async () => {
    const onClose = vi.fn();
    const view = await mount(
      <Modal isOpen onClose={onClose}>
        <p>body</p>
      </Modal>,
    );

    await view.click("custom-modal-overlay");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a click inside the dialog", async () => {
    // The overlay's handler is on an ancestor, so without the stopPropagation
    // every click on the content would dismiss the modal.
    const onClose = vi.fn();
    const view = await mount(
      <Modal isOpen onClose={onClose}>
        <p>body</p>
      </Modal>,
    );

    await view.click("modal-content");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("always closes on cancel, whether or not a handler was given", async () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    const view = await mount(
      <Modal isOpen onClose={onClose} onCancel={onCancel}>
        <p>body</p>
      </Modal>,
    );

    await view.click("modal-cancel-button");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("awaits an async cancel handler before closing", async () => {
    const order: string[] = [];
    const view = await mount(
      <Modal
        isOpen
        onClose={() => order.push("close")}
        onCancel={async () => {
          await Promise.resolve();
          order.push("cancel");
        }}
      >
        <p>body</p>
      </Modal>,
    );

    await view.click("modal-cancel-button");

    expect(order).toEqual(["cancel", "close"]);
  });

  it("leaves the modal open after a confirm", async () => {
    // Deliberate: the caller decides whether confirming dismisses it.
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const view = await mount(
      <Modal isOpen onClose={onClose} onConfirm={onConfirm}>
        <p>body</p>
      </Modal>,
    );

    await view.click("modal-confirm-button");

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("focus", () => {
  it("moves into the dialog rather than the first control", async () => {
    // The heading has to be announced, and these modals are lazy — the first
    // control does not exist yet when this runs.
    const view = await mount(
      <Modal isOpen onClose={() => {}} title="Edit Pad">
        <button>inside</button>
      </Modal>,
    );

    expect(document.activeElement).toBe(view.required("custom-modal"));
  });

  it("hands focus back to whatever opened it", async () => {
    // Otherwise focus drops to <body> and the next Tab restarts from the top
    // of the document.
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const view = await mount(
      <Modal isOpen onClose={() => {}}>
        <button>inside</button>
      </Modal>,
    );
    expect(document.activeElement).not.toBe(trigger);

    await view.render(
      <Modal isOpen={false} onClose={() => {}}>
        <button>inside</button>
      </Modal>,
    );

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe("the Tab trap", () => {
  /** A modal with two focusable controls plus its own × and buttons. */
  async function trapped() {
    const view = await mount(
      <Modal isOpen onClose={() => {}} onConfirm={() => {}}>
        <button data-testid="first-inside">one</button>
        <button data-testid="second-inside">two</button>
      </Modal>,
    );
    // jsdom gives everything a zero-sized box, and the trap filters by
    // `getClientRects()`. Without this the dialog reads as empty.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      { width: 10, height: 10 },
    ] as unknown as DOMRectList);
    return view;
  }

  /** The dialog's focusable children, in the order the trap sees them. */
  const focusables = (view: MountedPanel) => [
    ...view
      .required("custom-modal")
      .querySelectorAll<HTMLElement>("button:not([disabled])"),
  ];

  it("wraps forward from the last control to the first", async () => {
    const view = await trapped();
    const controls = focusables(view);
    const last = controls[controls.length - 1];
    last.focus();

    const event = pressKey(view.required("custom-modal"), "Tab");

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[0]);
  });

  it("wraps backward from the first control to the last", async () => {
    const view = await trapped();
    const controls = focusables(view);
    controls[0].focus();

    const event = pressKey(view.required("custom-modal"), "Tab", {
      shiftKey: true,
    });

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[controls.length - 1]);
  });

  it("wraps the very first Shift+Tab, while focus is still on the dialog", async () => {
    // The container counts as "before the first", or that press would leave.
    const view = await trapped();
    const dialog = view.required("custom-modal");
    dialog.focus();

    pressKey(dialog, "Tab", { shiftKey: true });

    const controls = focusables(view);
    expect(document.activeElement).toBe(controls[controls.length - 1]);
  });

  it("leaves the browser to handle a Tab in the middle", async () => {
    const view = await trapped();
    focusables(view)[1].focus();

    const event = pressKey(view.required("custom-modal"), "Tab");

    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores keys that are not Tab", async () => {
    const view = await trapped();

    const event = pressKey(view.required("custom-modal"), "a");

    expect(event.defaultPrevented).toBe(false);
  });

  it("refuses to move focus out of a dialog with nothing focusable in it", async () => {
    // Every control is invisible, so there is nowhere to go — and going
    // anywhere means leaving the dialog.
    const view = await mount(
      <Modal isOpen onClose={() => {}} showCancelButton={false}>
        <p>nothing focusable</p>
      </Modal>,
    );
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(
      [] as unknown as DOMRectList,
    );

    const event = pressKey(view.required("custom-modal"), "Tab");

    expect(event.defaultPrevented).toBe(true);
  });
});

describe("Escape", () => {
  it("closes the modal", async () => {
    const onClose = vi.fn();
    await mount(
      <Modal isOpen onClose={onClose}>
        <p>body</p>
      </Modal>,
    );

    pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is swallowed, so it never reaches the panic button", async () => {
    // `useKeyboardListener` is on `window` too, and Escape there stops every
    // sound in the room.
    // Registered exactly as `useKeyboardListener` registers it: on window,
    // in the bubble phase. A capture-phase stand-in would be unfaithful — and
    // would pass or fail on registration order rather than on the guard.
    const panicButton = vi.fn();
    window.addEventListener("keydown", panicButton);
    await mount(
      <Modal isOpen onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(true);
    expect(panicButton).not.toHaveBeenCalled();
    window.removeEventListener("keydown", panicButton);
  });

  it("reaches the page again once the modal has closed", async () => {
    const stillListening = vi.fn();
    const view = await mount(
      <Modal isOpen onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );

    await view.render(
      <Modal isOpen={false} onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );
    window.addEventListener("keydown", stillListening);
    pressEscape();
    window.removeEventListener("keydown", stillListening);

    expect(stillListening).toHaveBeenCalledTimes(1);
  });

  it("goes to the innermost of two open dialogs", async () => {
    // The registration order is outermost-first, which is exactly why a
    // listener per overlay would give this to the wrong one.
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    await mount(
      <>
        <Modal isOpen onClose={closeOuter}>
          <p>outer</p>
        </Modal>
        <Modal isOpen onClose={closeInner}>
          <p>inner</p>
        </Modal>
      </>,
    );

    pressEscape();

    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it("hands Escape back to the outer dialog when the inner one closes", async () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const view = await mount(
      <>
        <Modal isOpen onClose={closeOuter}>
          <p>outer</p>
        </Modal>
        <Modal isOpen onClose={closeInner}>
          <p>inner</p>
        </Modal>
      </>,
    );

    await view.render(
      <>
        <Modal isOpen onClose={closeOuter}>
          <p>outer</p>
        </Modal>
        <Modal isOpen={false} onClose={closeInner}>
          <p>inner</p>
        </Modal>
      </>,
    );
    pressEscape();

    expect(closeOuter).toHaveBeenCalledTimes(1);
    expect(closeInner).not.toHaveBeenCalled();
  });

  it("calls the handler the latest render supplied", async () => {
    // The handler is read through a ref precisely so a new identity per render
    // — which is every render, for the inline arrows most callers pass — does
    // not re-order the stack. Reading a stale one would close using last
    // render's props.
    const first = vi.fn();
    const second = vi.fn();
    const view = await mount(
      <Modal isOpen onClose={first}>
        <p>body</p>
      </Modal>,
    );

    await view.render(
      <Modal isOpen onClose={second}>
        <p>body</p>
      </Modal>,
    );
    pressEscape();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("takes its window listener back down with the last overlay", async () => {
    // Hygiene rather than behaviour: with the stack empty the handler already
    // returns without doing anything, so nothing a user can see changes. The
    // assertion is on the teardown itself, because that is the only observer —
    // otherwise the app keeps a capture-phase keydown listener on window for
    // the life of the tab after the first modal it ever opened.
    const remove = vi.spyOn(window, "removeEventListener");
    const view = await mount(
      <Modal isOpen onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );

    await view.render(
      <Modal isOpen={false} onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );

    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function), true);
  });

  it("keeps the listener while another overlay is still open", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const view = await mount(
      <>
        <Modal isOpen onClose={() => {}}>
          <p>outer</p>
        </Modal>
        <Modal isOpen onClose={() => {}}>
          <p>inner</p>
        </Modal>
      </>,
    );

    await view.render(
      <>
        <Modal isOpen onClose={() => {}}>
          <p>outer</p>
        </Modal>
        <Modal isOpen={false} onClose={() => {}}>
          <p>inner</p>
        </Modal>
      </>,
    );

    expect(remove).not.toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      true,
    );
  });

  it("ignores every other key", async () => {
    const onClose = vi.fn();
    await mount(
      <Modal isOpen onClose={onClose}>
        <p>body</p>
      </Modal>,
    );

    pressKey(document.body, "Enter");
    pressKey(document.body, " ");

    expect(onClose).not.toHaveBeenCalled();
  });
});
