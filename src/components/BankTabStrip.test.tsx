// @vitest-environment jsdom
/**
 * `BankTabStrip` renders one tab per bank and must key selection, editing and
 * the emergency indicator on `bankId`, never on array position. The
 * branch-wide hazard is that a migrated bank's id equals `String(pageIndex)`,
 * which would let position-keyed code pass a careless test by coincidence —
 * so these fixtures deliberately use ids that do not match their positions
 * ("vault-3" sits at position 1, not position "1" or "3").
 *
 * No testing-library here, matching PadGrid.bankId.test.tsx: React does not
 * otherwise know this is a test environment, so IS_REACT_ACT_ENVIRONMENT is
 * set by hand and `act()` wraps every render/interaction.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BankTabStrip, { reorderBankIds } from "@/components/BankTabStrip";
import type { PageMetadata } from "@/lib/db";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function makeBank(overrides: Partial<PageMetadata>): PageMetadata {
  return {
    profileId: 1,
    bankId: "unset",
    pageIndex: 0,
    name: "Unset",
    isEmergency: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const banks: PageMetadata[] = [
  makeBank({ bankId: "banner-hall", pageIndex: 0, name: "Banner Hall" }),
  makeBank({
    bankId: "vault-3",
    pageIndex: 1,
    name: "Vault Three",
    isEmergency: true,
  }),
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function tabs(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[role="tab"]'));
}

describe("BankTabStrip", () => {
  it("renders one tab per bank, in position order, labelled and marked by bankId", () => {
    act(() => {
      root.render(
        <BankTabStrip
          banks={banks}
          currentBankId="vault-3"
          isEditMode={false}
          onSelect={vi.fn()}
          onEdit={vi.fn()}
          onReorder={vi.fn()}
        />,
      );
    });

    const rendered = tabs();
    expect(rendered).toHaveLength(2);

    expect(rendered[0].getAttribute("data-bank-id")).toBe("banner-hall");
    expect(rendered[0].getAttribute("data-bank-index")).toBe("0");
    expect(rendered[0].textContent).toContain("1: Banner Hall");
    // The selected bank is "vault-3", which sits at position 1 — the first
    // tab must not be marked selected even though its position (0) would
    // equal a position-keyed "selected" fallback of the wrong sign.
    expect(rendered[0].getAttribute("aria-selected")).toBe("false");

    expect(rendered[1].getAttribute("data-bank-id")).toBe("vault-3");
    expect(rendered[1].getAttribute("data-bank-index")).toBe("1");
    expect(rendered[1].textContent).toContain("2: Vault Three");
    expect(rendered[1].getAttribute("aria-selected")).toBe("true");
  });

  it("shows the emergency dot only for the bank flagged emergency", () => {
    act(() => {
      root.render(
        <BankTabStrip
          banks={banks}
          currentBankId="banner-hall"
          isEditMode={false}
          onSelect={vi.fn()}
          onEdit={vi.fn()}
          onReorder={vi.fn()}
        />,
      );
    });

    const rendered = tabs();
    expect(rendered[0].querySelector('[title="Emergency bank"]')).toBeNull();
    expect(
      rendered[1].querySelector('[title="Emergency bank"]'),
    ).not.toBeNull();
  });

  it("clicking a tab outside edit mode calls onSelect with the bank's id, not its position", () => {
    const onSelect = vi.fn();
    const onEdit = vi.fn();
    act(() => {
      root.render(
        <BankTabStrip
          banks={banks}
          currentBankId="banner-hall"
          isEditMode={false}
          onSelect={onSelect}
          onEdit={onEdit}
          onReorder={vi.fn()}
        />,
      );
    });

    act(() => {
      tabs()[1].dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(onSelect).toHaveBeenCalledWith("vault-3");
    expect(onSelect).not.toHaveBeenCalledWith("1");
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("clicking a tab in edit mode calls onEdit with the bank's id, and never onSelect", () => {
    const onSelect = vi.fn();
    const onEdit = vi.fn();
    act(() => {
      root.render(
        <BankTabStrip
          banks={banks}
          currentBankId="banner-hall"
          isEditMode={true}
          onSelect={onSelect}
          onEdit={onEdit}
          onReorder={vi.fn()}
        />,
      );
    });

    act(() => {
      tabs()[1].dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(onEdit).toHaveBeenCalledWith("vault-3");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders the tabs immediately in edit mode, before the drag chunk arrives", () => {
    // Synchronous render: `BankTabsDraggable` is `React.lazy`, so this is the
    // Suspense fallback — and the claim is that the fallback is the strip
    // itself. The board must never wait on the drag library to draw its own
    // bank tabs, however slow the network is.
    act(() => {
      root.render(
        <BankTabStrip
          banks={banks}
          currentBankId="banner-hall"
          isEditMode={true}
          onSelect={vi.fn()}
          onEdit={vi.fn()}
          onReorder={vi.fn()}
        />,
      );
    });

    expect(tabs()).toHaveLength(2);
    expect(tabs()[1].getAttribute("data-bank-id")).toBe("vault-3");
    expect(
      tabs()[0].getAttribute("data-rfd-drag-handle-draggable-id"),
    ).toBeNull();
  });

  it("enables the drag handle in edit mode once the drag chunk has loaded", async () => {
    // Resolve the chunk before rendering. `React.lazy` calls the same dynamic
    // import, so this leaves its factory returning an already-settled promise
    // — otherwise this test is really measuring how long Vite takes to
    // transform a module, which varies with what else the suite is doing.
    await import("@/components/BankTabsDraggable");

    await act(async () => {
      root.render(
        <BankTabStrip
          banks={banks}
          currentBankId="banner-hall"
          isEditMode={true}
          onSelect={vi.fn()}
          onEdit={vi.fn()}
          onReorder={vi.fn()}
        />,
      );
    });
    // Flushed until the swap lands. The strip schedules its own load through
    // requestIdleCallback (or a timer where jsdom has none), so the wait is
    // for a real elapsed moment, not just a microtask turn.
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      if (tabs()[0].getAttribute("data-rfd-drag-handle-draggable-id")) break;
    }

    // `@hello-pangea/dnd` only attaches this attribute (via
    // `dragHandleProps`) when the Draggable is enabled, so its presence is
    // the observable proxy for `isDragDisabled={false}` — and, now, for the
    // drag strip having replaced the plain one at all.
    expect(tabs()[0].getAttribute("data-rfd-drag-handle-draggable-id")).toBe(
      "banner-hall",
    );
  });

  it("disables the drag handle outside edit mode", () => {
    act(() => {
      root.render(
        <BankTabStrip
          banks={banks}
          currentBankId="banner-hall"
          isEditMode={false}
          onSelect={vi.fn()}
          onEdit={vi.fn()}
          onReorder={vi.fn()}
        />,
      );
    });

    expect(
      tabs()[0].getAttribute("data-rfd-drag-handle-draggable-id"),
    ).toBeNull();
  });
});

describe("reorderBankIds", () => {
  // Deliberately scrambled `pageIndex` values (7, 2, 9) that disagree with
  // both array position and any alphabetic/numeric ordering of the ids, so
  // an implementation that sorts by `pageIndex` (or otherwise reads
  // position from anywhere but the array itself) produces a different,
  // and therefore caught, answer.
  const scrambled: PageMetadata[] = [
    makeBank({ bankId: "zulu", pageIndex: 7, name: "Zulu" }),
    makeBank({ bankId: "alpha", pageIndex: 2, name: "Alpha" }),
    makeBank({ bankId: "mike", pageIndex: 9, name: "Mike" }),
  ];

  it("moves the source bank id forward to the destination position", () => {
    expect(reorderBankIds(scrambled, 0, 2)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("moves the source bank id backward to the destination position", () => {
    expect(reorderBankIds(scrambled, 2, 0)).toEqual(["mike", "zulu", "alpha"]);
  });

  it("leaves the order unchanged when source and destination match", () => {
    expect(reorderBankIds(scrambled, 1, 1)).toEqual(["zulu", "alpha", "mike"]);
  });
});
