/**
 * The notice store: the one place a failure goes to be seen.
 *
 * Every write failure in the app used to be a `window.alert`, seventeen of
 * them. A native alert halts the page's JavaScript until it is dismissed, so
 * for as long as it was up, ESC could not stop a sound and Fade Out All could
 * not fade one — the worst possible property for something that pops up when
 * a pad refuses a file mid-show. Notices are state instead, and what
 * `NoticeStack` renders never claims a key or steals focus.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_NOTICES,
  noticeActions,
  reportFailure,
  useNoticeStore,
} from "@/store/noticeStore";

const shown = () => useNoticeStore.getState().notices.map((n) => n.message);

beforeEach(() => {
  noticeActions.dismissAll();
});

describe("noticeActions.error", () => {
  it("shows the message until it is dismissed", () => {
    const id = noticeActions.error("Could not swap the pads: nope");

    expect(shown()).toEqual(["Could not swap the pads: nope"]);

    noticeActions.dismiss(id);
    expect(shown()).toEqual([]);
  });

  it("keeps notices in the order they arrived", () => {
    noticeActions.error("first");
    noticeActions.error("second");

    expect(shown()).toEqual(["first", "second"]);
  });

  it("does not stack a message that is already showing", () => {
    // A pad that fails on every press would otherwise pile up one notice per
    // press. The existing notice keeps its id, so a caller holding it can
    // still dismiss the one that is there.
    const first = noticeActions.error("Could not play Applause");
    const second = noticeActions.error("Could not play Applause");

    expect(second).toBe(first);
    expect(shown()).toEqual(["Could not play Applause"]);
  });

  it("drops the oldest notice past the cap", () => {
    for (let i = 0; i < MAX_NOTICES + 2; i++) {
      noticeActions.error(`failure ${i}`);
    }

    expect(shown()).toHaveLength(MAX_NOTICES);
    expect(shown()[0]).toBe("failure 2");
    expect(shown().at(-1)).toBe(`failure ${MAX_NOTICES + 1}`);
  });

  it("hands out ids that never repeat, even after a dismissal", () => {
    const a = noticeActions.error("a");
    noticeActions.dismiss(a);
    const b = noticeActions.error("b");

    expect(b).not.toBe(a);
  });
});

describe("reportFailure", () => {
  it("logs the thrown value and shows the context with its message", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = new Error("QuotaExceededError");

    reportFailure("Could not save the loudness settings", thrown);

    expect(shown()).toEqual([
      "Could not save the loudness settings: QuotaExceededError",
    ]);
    expect(error).toHaveBeenCalledWith(
      "Could not save the loudness settings",
      thrown,
    );
    error.mockRestore();
  });

  it("shows something readable for a non-Error throw", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    reportFailure("Could not add the file", "disk full");

    expect(shown()).toEqual(["Could not add the file: disk full"]);
    vi.restoreAllMocks();
  });
});
