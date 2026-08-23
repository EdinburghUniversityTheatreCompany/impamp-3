// @vitest-environment jsdom
/**
 * The dialog a user meets when two devices changed the same board.
 *
 * It was at 0% of lines, and it is the only place in the app where somebody is
 * asked to make a data-loss decision by hand. Three things about it matter
 * more than what it looks like:
 *
 * **Resolve stays disabled until every conflict has an answer.** A partial
 * resolution silently keeps whatever the automatic merge chose for the rest,
 * which is exactly the outcome the user opened this dialog to override. A
 * field conflict needs an answer *per field*, not one for the item.
 *
 * **A failed apply says so.** It used to be logged and swallowed, which left
 * the button enabled with no explanation — so the natural response is to press
 * it again and get the same nothing.
 *
 * **The choices reach `applyConflictResolutions` unchanged.** That function is
 * where the merge rules live (`syncUtils.ts` explains at length why they are
 * there and not here: the hand-resolved path drifted from the automatic one
 * and handed users back a mixture of two devices' sounds). The dialog's job is
 * to collect choices and pass them on, so what it passes is what is asserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";
import { quietConsole } from "@/lib/testSupport/quietConsole";
import type { ItemConflict } from "@/lib/syncUtils";
import type { SyncConflictData } from "@/lib/googleDrive/types";

const applyConflictResolutions = vi.fn();
vi.mock("@/lib/syncUtils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/syncUtils")>()),
  applyConflictResolutions: (...args: unknown[]) =>
    applyConflictResolutions(...args),
}));

const { ConflictResolutionModal } = await import("./ConflictResolutionModal");

const MERGED = { merged: true } as unknown as SyncConflictData["merged"];

/** The surrounding sync state; only the timestamps and origin are rendered. */
function conflictData(
  overrides: Partial<SyncConflictData> = {},
): SyncConflictData {
  return {
    origin: { kind: "drive", fileId: "drive-1" },
    merged: MERGED,
    local: {
      _lastSyncTimestamp: Date.UTC(2026, 7, 1),
      profile: { _modified: Date.UTC(2026, 7, 2) },
    },
    remote: { profile: { _modified: Date.UTC(2026, 7, 3) } },
    ...overrides,
  } as unknown as SyncConflictData;
}

/** A per-field conflict on one pad. */
function fieldConflict(fields: string[] = ["name"]): ItemConflict {
  return {
    storeName: "padConfigurations",
    key: "bank-1-3",
    type: "field_conflict",
    localItem: { bankId: "1", padIndex: 3 },
    remoteItem: { bankId: "1", padIndex: 3 },
    fieldConflicts: fields.map((field) => ({
      field,
      localValue: `local ${field}`,
      remoteValue: `remote ${field}`,
      localModTime: Date.UTC(2026, 7, 2),
      remoteModTime: Date.UTC(2026, 7, 3),
    })),
  } as unknown as ItemConflict;
}

/** An item only one side has. */
function presenceConflict(
  type: "local_only" | "remote_only",
  key = "bank-2-0",
): ItemConflict {
  return {
    storeName: "padConfigurations",
    key,
    type,
    localItem: type === "local_only" ? { bankId: "2", padIndex: 0 } : null,
    remoteItem: type === "remote_only" ? { bankId: "2", padIndex: 0 } : null,
  } as unknown as ItemConflict;
}

let panel: MountedPanel | null = null;
const onResolve = vi.fn();
const onCancel = vi.fn();

async function open(
  conflicts: ItemConflict[],
  data: SyncConflictData = conflictData(),
) {
  panel = await mountPanel(
    <ConflictResolutionModal
      conflicts={conflicts}
      conflictData={data}
      onResolve={onResolve}
      onCancel={onCancel}
    />,
  );
  return panel;
}

/** The button whose visible text is `label`. */
function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found as HTMLButtonElement;
}

/** The radio whose surrounding label reads `label`, for field `field`. */
function radio(field: string, label: string): HTMLInputElement {
  const match = [...document.body.querySelectorAll("label")].find(
    (element) =>
      element.textContent?.trim() === label &&
      element.querySelector<HTMLInputElement>("input")?.name.endsWith(field),
  );
  const input = match?.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error(`no "${label}" radio for field "${field}"`);
  return input;
}

/** Clicks a radio the way React sees it. */
async function choose(input: HTMLInputElement): Promise<void> {
  await panel!.press(input);
}

const text = () => document.body.textContent ?? "";

beforeEach(() => {
  quietConsole();
  onResolve.mockReset();
  onCancel.mockReset();
  applyConflictResolutions.mockReset();
  applyConflictResolutions.mockReturnValue({ resolved: true });
});

afterEach(async () => {
  await panel?.unmount();
  panel = null;
  vi.restoreAllMocks();
});

describe("what the dialog explains", () => {
  it("counts the conflicts, pluralised", async () => {
    await open([fieldConflict(), presenceConflict("local_only")]);

    expect(text()).toContain("2 conflicts to resolve");
  });

  it("says one conflict in the singular", async () => {
    await open([fieldConflict()]);

    expect(text()).toContain("1 conflict to resolve");
  });

  it("names Drive as the other side when that is where the copy is", async () => {
    await open([fieldConflict()]);

    expect(text()).toContain("Both your local copy and Google Drive");
  });

  it("names the server as the other side for a server profile", async () => {
    await open(
      [fieldConflict()],
      conflictData({
        origin: { kind: "server", serverProfileId: "srv-1", version: 4 },
      }),
    );

    expect(text()).toContain("Both your local copy and the ImpAmp server");
  });

  it("omits a timestamp it does not have", async () => {
    // A profile that has never synced has no last-sync stamp, and a line
    // reading "Last sync: Invalid Date" is worse than no line.
    await open(
      [fieldConflict()],
      conflictData({
        local: { profile: {} } as unknown as SyncConflictData["local"],
        remote: { profile: {} } as unknown as SyncConflictData["remote"],
      }),
    );

    expect(text()).not.toContain("Last sync:");
    expect(text()).not.toContain("Invalid Date");
  });

  it("titles a pad conflict by its bank and pad", async () => {
    await open([fieldConflict()]);

    expect(text()).toContain("Pad Config: Bank 1, Pad 3");
  });

  it("titles a bank conflict by its id and name", async () => {
    await open([
      {
        storeName: "pageMetadata",
        key: "bank-9",
        type: "local_only",
        localItem: { bankId: "9", name: "Act Two" },
      } as unknown as ItemConflict,
    ]);

    expect(text()).toContain("Bank Meta: 9 (Act Two)");
  });

  it("titles a profile conflict by its name", async () => {
    await open([
      {
        storeName: "profiles",
        key: 1,
        type: "local_only",
        localItem: { name: "Panto" },
      } as unknown as ItemConflict,
    ]);

    expect(text()).toContain("Profile: Panto");
  });

  it("falls back to the key for a store it does not know", async () => {
    await open([
      {
        storeName: "somethingElse",
        key: "odd-key",
        type: "local_only",
        localItem: {},
      } as unknown as ItemConflict,
    ]);

    expect(text()).toContain("Item Key: odd-key");
  });

  it("reads the title off the remote side when there is no local one", async () => {
    await open([presenceConflict("remote_only")]);

    expect(text()).toContain("Pad Config: Bank 2, Pad 0");
  });

  it("shows an object value as formatted JSON rather than [object Object]", async () => {
    await open([
      {
        storeName: "padConfigurations",
        key: "k",
        type: "local_only",
        localItem: { audioFileIds: [1, 2] },
      } as unknown as ItemConflict,
    ]);

    expect(text()).toContain('"audioFileIds"');
  });

  it("says Unknown for a modification time the other side did not send", async () => {
    const conflict = fieldConflict();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conflict.fieldConflicts as any)[0].remoteModTime = undefined;

    await open([conflict]);

    expect(text()).toContain("Unknown");
  });
});

describe("when Resolve becomes available", () => {
  it("stays disabled until something has been chosen", async () => {
    await open([fieldConflict()]);

    expect(button("Resolve Conflicts").disabled).toBe(true);
  });

  it("needs a choice for every field, not one for the item", async () => {
    // A field left unanswered silently keeps whatever the automatic merge
    // chose — the outcome the user opened this dialog to override.
    await open([fieldConflict(["name", "audioFileIds"])]);

    await choose(radio("name", "Keep Local"));
    expect(button("Resolve Conflicts").disabled).toBe(true);

    await choose(radio("audioFileIds", "Keep Remote"));
    expect(button("Resolve Conflicts").disabled).toBe(false);
  });

  it("needs a choice for every conflict, not just the first", async () => {
    await open([fieldConflict(), presenceConflict("remote_only")]);

    await choose(radio("name", "Keep Local"));
    expect(button("Resolve Conflicts").disabled).toBe(true);

    await panel!.press(button("Accept Remote Item"));
    expect(button("Resolve Conflicts").disabled).toBe(false);
  });

  it("takes one press for a local-only item", async () => {
    await open([presenceConflict("local_only")]);

    await panel!.press(button("Delete Local Item"));

    expect(button("Resolve Conflicts").disabled).toBe(false);
  });

  it("does nothing when pressed while still disabled", async () => {
    await open([fieldConflict()]);

    await panel!.press(button("Resolve Conflicts"));

    expect(applyConflictResolutions).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });
});

describe("what the choices become", () => {
  it("hands the per-field choices to the merge, keyed by conflict", async () => {
    await open([fieldConflict(["name", "audioFileIds"])]);

    await choose(radio("name", "Keep Local"));
    await choose(radio("audioFileIds", "Keep Remote"));
    await panel!.press(button("Resolve Conflicts"));

    expect(applyConflictResolutions).toHaveBeenCalledWith(
      MERGED,
      expect.any(Array),
      { "bank-1-3": { name: "local", audioFileIds: "remote" } },
    );
  });

  it("lets a choice be changed before resolving", async () => {
    await open([fieldConflict()]);

    await choose(radio("name", "Keep Local"));
    await choose(radio("name", "Keep Remote"));
    await panel!.press(button("Resolve Conflicts"));

    expect(applyConflictResolutions.mock.calls[0][2]).toEqual({
      "bank-1-3": { name: "remote" },
    });
  });

  it.each([
    ["local_only", "Keep Local Item", "keep"],
    ["local_only", "Delete Local Item", "delete"],
    ["remote_only", "Accept Remote Item", "accept"],
    ["remote_only", "Discard Remote Item", "discard"],
  ] as const)("records %s / %s as %s", async (type, label, choice) => {
    await open([presenceConflict(type)]);

    await panel!.press(button(label));
    await panel!.press(button("Resolve Conflicts"));

    expect(applyConflictResolutions.mock.calls[0][2]).toEqual({
      "bank-2-0": choice,
    });
  });

  it("passes the merged blob rather than either side's", async () => {
    // The dialog resolves *on top of* the automatic merge; passing one raw
    // side would discard every non-conflicting change from the other.
    await open([presenceConflict("local_only")]);

    await panel!.press(button("Keep Local Item"));
    await panel!.press(button("Resolve Conflicts"));

    expect(applyConflictResolutions.mock.calls[0][0]).toBe(MERGED);
  });

  it("hands the result to its caller", async () => {
    await open([presenceConflict("local_only")]);

    await panel!.press(button("Keep Local Item"));
    await panel!.press(button("Resolve Conflicts"));

    expect(onResolve).toHaveBeenCalledWith({ resolved: true });
  });

  it("groups two conflicts on the same item into one card", async () => {
    await open([fieldConflict(), fieldConflict(["volume"])]);

    const headings = [...document.body.querySelectorAll("h3")];
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toContain("Bank 1, Pad 3");
  });
});

describe("when applying the choices fails", () => {
  it("says so instead of leaving the button to be pressed again", async () => {
    applyConflictResolutions.mockImplementation(() => {
      throw new Error("audioFileIds no longer match any stored sound");
    });
    await open([presenceConflict("local_only")]);

    await panel!.press(button("Keep Local Item"));
    await panel!.press(button("Resolve Conflicts"));

    const alert = document.body.querySelector(
      '[data-testid="conflict-resolve-error"]',
    );
    expect(alert?.textContent).toContain("no longer match any stored sound");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("re-enables the button, so the choices can be changed and retried", async () => {
    applyConflictResolutions.mockImplementationOnce(() => {
      throw new Error("nope");
    });
    await open([presenceConflict("local_only")]);
    await panel!.press(button("Keep Local Item"));

    await panel!.press(button("Resolve Conflicts"));
    expect(button("Resolve Conflicts").disabled).toBe(false);

    await panel!.press(button("Resolve Conflicts"));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("explains a non-Error failure in words rather than showing nothing", async () => {
    applyConflictResolutions.mockImplementation(() => {
      throw "a bare string";
    });
    await open([presenceConflict("local_only")]);

    await panel!.press(button("Keep Local Item"));
    await panel!.press(button("Resolve Conflicts"));

    expect(text()).toContain("Nothing has been changed");
  });
});

describe("cancelling", () => {
  it("hands control back without resolving anything", async () => {
    await open([fieldConflict()]);

    await panel!.press(button("Cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(applyConflictResolutions).not.toHaveBeenCalled();
  });
});
