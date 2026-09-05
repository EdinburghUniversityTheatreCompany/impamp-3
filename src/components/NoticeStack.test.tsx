// @vitest-environment jsdom
/**
 * The box a notice is shown in.
 *
 * What is pinned here is the show-safety half of the design rather than the
 * styling: a notice must announce itself (`role="alert"`), must be
 * dismissible, and must not take focus when it appears — a `<button>` that
 * grabbed focus would turn the operator's next Space into "dismiss" rather
 * than "fade out all".
 */
import * as React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";
import { noticeActions } from "@/store/noticeStore";
import NoticeStack from "./NoticeStack";

let panel: MountedPanel;

beforeEach(async () => {
  noticeActions.dismissAll();
  panel = await mountPanel(<NoticeStack />);
});

afterEach(async () => {
  await panel.unmount();
  noticeActions.dismissAll();
});

const alerts = () => panel.container.querySelectorAll('[role="alert"]');

describe("NoticeStack", () => {
  it("renders nothing while there is nothing to say", () => {
    expect(panel.container.innerHTML).toBe("");
  });

  it("shows each notice as an alert, in arrival order", async () => {
    await act(async () => {
      noticeActions.error("first failure");
      noticeActions.error("second failure");
    });

    const boxes = alerts();
    expect(boxes).toHaveLength(2);
    expect(boxes[0].textContent).toContain("first failure");
    expect(boxes[1].textContent).toContain("second failure");
  });

  it("removes a notice when its dismiss button is pressed", async () => {
    await act(async () => {
      noticeActions.error("first failure");
      noticeActions.error("second failure");
    });

    const dismissFirst = alerts()[0].querySelector<HTMLElement>("button");
    expect(dismissFirst).not.toBeNull();
    await panel.press(dismissFirst!);

    const remaining = alerts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].textContent).toContain("second failure");
  });

  it("does not take focus when it appears", async () => {
    const board = document.createElement("button");
    board.textContent = "a pad";
    document.body.appendChild(board);
    board.focus();

    await act(async () => {
      noticeActions.error("a failure");
    });

    expect(document.activeElement).toBe(board);
    board.remove();
  });

  it("gives the dismiss button an accessible name", async () => {
    await act(async () => {
      noticeActions.error("a failure");
    });

    const button = alerts()[0].querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Dismiss");
  });
});
