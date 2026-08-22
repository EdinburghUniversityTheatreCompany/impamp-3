// @vitest-environment jsdom
/**
 * The Maintenance tab's duplicate-audio panel.
 *
 * This is the only UI in the deduplication work, and it is the one that
 * deletes audio. `collapseDuplicateAudioGroups` made the operation safe; this
 * panel decides what a user is told before they trigger it, and what the app
 * does afterwards. Three things are therefore load-bearing rather than
 * cosmetic, and each has a test below:
 *
 *  1. The panel reports what the collapse *did*, never what the preview said
 *     it would do. A `canonicalId` can be deleted between the scan and the
 *     confirmation — a pad cleared, then the orphan sweep pressed, in this tab
 *     or another one — and the collapse then skips that group whole. Saying
 *     "removed 4" when 1 went is a lie about deleted audio.
 *  2. Nothing runs without the confirmation, and nothing runs twice.
 *  3. The pad-configs version is bumped afterwards, because every in-memory
 *     copy of a pad still names the id that has just been deleted.
 *
 * The real `audioDedup` module runs against a real (fake-indexeddb) database:
 * a panel test that mocks the operation it exists to guard would prove only
 * that the buttons are wired to something. It is wrapped in `vi.fn` so a
 * failure can be forced and the arguments can be read.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import * as React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";
// Type-only, so it is erased and cannot defeat the import ordering above.
import type { DuplicateAudioGroup } from "@/lib/audioDedup";

// `db.ts` fires a loudness analysis at every row it creates, and jsdom has no
// Web Audio for it to use.
vi.doMock("@/lib/audio/loudness/pipeline", () => ({
  analyseAndStore: vi.fn(async () => null),
}));

const incrementPadConfigsVersion = vi.fn();
vi.doMock("@/store/profileStore", () => ({
  useProfileStore: { getState: () => ({ incrementPadConfigsVersion }) },
}));

// The real implementations, behind spies. `importActual` resolves the module's
// own imports normally, so this is the same `db.ts` the test writes through.
const realDedup =
  await vi.importActual<typeof import("@/lib/audioDedup")>("@/lib/audioDedup");
const findDuplicateAudioGroups = vi.fn(realDedup.findDuplicateAudioGroups);
const collapseDuplicateAudioGroups = vi.fn(
  realDedup.collapseDuplicateAudioGroups,
);
vi.doMock("@/lib/audioDedup", () => ({
  findDuplicateAudioGroups,
  collapseDuplicateAudioGroups,
}));

const DuplicateAudioPanel = (
  await import("@/components/profiles/DuplicateAudioPanel")
).default;
const { addAudioFile, addProfile, getDb, upsertPadConfiguration } =
  await import("@/lib/db");

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The same bytes every time, as a fresh Blob. */
function horn(): Blob {
  return new Blob(["the horn bytes"], { type: "audio/wav" });
}

/** Bytes that are not the horn's, so collapsing the two would be visible. */
function stab(): Blob {
  return new Blob(["a completely different stab, and then some"], {
    type: "audio/wav",
  });
}

/**
 * Stores the same sound twice under two names.
 *
 * `addAudioFile` never reuses, by design — it is the writer that made the
 * duplicates this panel exists to clear up.
 */
async function storedTwice(
  blob: () => Blob,
  name: string,
): Promise<[number, number]> {
  const first = await addAudioFile({
    name: `${name}.wav`,
    type: "audio/wav",
    blob: blob(),
  });
  const second = await addAudioFile({
    name: `${name} (1).wav`,
    type: "audio/wav",
    blob: blob(),
  });
  // The fixture trap this branch has hit four times: two "different" sounds
  // whose bytes are equal are one row, and every assertion below goes vacuous.
  expect(second).not.toBe(first);
  return [first, second];
}

/**
 * A group the scan never produced, for the arithmetic the database cannot show.
 *
 * `reclaimableBytes` comes from `blob.size`, and under jsdom `fake-indexeddb`
 * stores a Blob as a plain object with no `size` on it — a limitation of the
 * environment, not of the panel, and it makes every real-fixture byte count
 * `NaN`. The sizes a user actually sees are worth a test all the same, so the
 * byte arithmetic and its formatting are driven from crafted groups instead.
 */
function craftedGroup(
  hash: string,
  duplicateIds: number[],
  reclaimableBytes: number,
): DuplicateAudioGroup {
  return { hash, canonicalId: 1, duplicateIds, reclaimableBytes };
}

let panel: MountedPanel;
let confirmSpy: ReturnType<typeof vi.spyOn>;

// Thin names over the shared harness, which is where the reasons live: `act`
// alone returns while a handler is still in flight, so `click` ticks the timer
// queue inside the `act` scope. A handler *meant* to stay pending — the
// double-press guard below — simply stays pending.
const testId = (id: string) => panel.testId(id);
const required = (id: string) => panel.required(id);
const click = (id: string) => panel.click(id);

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
  findDuplicateAudioGroups.mockImplementation(
    realDedup.findDuplicateAudioGroups,
  );
  collapseDuplicateAudioGroups.mockImplementation(
    realDedup.collapseDuplicateAudioGroups,
  );
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  panel = await mountPanel(<DuplicateAudioPanel />);
});

afterEach(async () => {
  await panel.unmount();
  confirmSpy.mockRestore();
});

describe("scanning", () => {
  it("offers no delete button when every sound is stored once", async () => {
    await addAudioFile({ name: "horn.wav", type: "audio/wav", blob: horn() });
    await addAudioFile({ name: "stab.wav", type: "audio/wav", blob: stab() });

    await click("duplicate-audio-scan");

    expect(required("duplicate-audio-preview").textContent).toContain(
      "No duplicates found",
    );
    expect(testId("duplicate-audio-collapse")).toBeNull();
  });

  it("counts the groups, the copies and the bytes it would reclaim", async () => {
    await storedTwice(horn, "horn");
    await storedTwice(stab, "stab");

    await click("duplicate-audio-scan");

    const preview = required("duplicate-audio-preview").textContent ?? "";
    expect(preview).toContain("2 groups");
    expect(preview).toContain("2 copies");
    expect(required("duplicate-audio-collapse").textContent).toContain(
      "Remove 2 Copies",
    );
  });

  it("adds up the bytes and shows a sub-megabyte reclaim as itself", async () => {
    // Half a megabyte is a real answer and "0 MB" is not one. Rounding the
    // total into megabytes tells a user with 900 KB of duplicates that there
    // is nothing to gain, which is the one thing the number is there to say.
    findDuplicateAudioGroups.mockResolvedValueOnce([
      craftedGroup("a".repeat(64), [2], 300_000),
      craftedGroup("b".repeat(64), [4], 212_000),
    ]);

    await click("duplicate-audio-scan");

    expect(required("duplicate-audio-preview").textContent).toContain("500 KB");
  });

  it("names the singular in the preview and on the button", async () => {
    findDuplicateAudioGroups.mockResolvedValueOnce([
      craftedGroup("a".repeat(64), [2], 300_000),
    ]);

    await click("duplicate-audio-scan");

    const preview = required("duplicate-audio-preview").textContent ?? "";
    expect(preview).toContain("1 group");
    expect(preview).toContain("1 copy");
    expect(preview).not.toContain("1 copies");
    expect(required("duplicate-audio-collapse").textContent).toContain(
      "Remove 1 Copy",
    );
  });

  it("warns that a pad naming both copies comes out a sound shorter", async () => {
    // `collapseDuplicateAudioGroups` puts the rewritten ids through a `Set`,
    // deliberately — a pad cannot list one row twice once the two rows are
    // one. But CLAUDE.md's "one pad can name one audio row twice" is a real
    // arrangement a user built on purpose, and a sequential pad set to A, B, A
    // quietly becomes a two-sound pad. The preview is the only place they
    // could find that out before pressing, so it has to say it.
    await storedTwice(horn, "horn");

    await click("duplicate-audio-scan");

    const preview = required("duplicate-audio-preview").textContent ?? "";
    expect(preview).toContain("listed the same sound twice");
    expect(preview).toContain("listing it once");
  });

  it("says the scan failed instead of leaving the panel unchanged", async () => {
    findDuplicateAudioGroups.mockRejectedValueOnce(new Error("store is shut"));

    await click("duplicate-audio-scan");

    expect(required("duplicate-audio-error").textContent).toContain(
      "store is shut",
    );
    expect(testId("duplicate-audio-collapse")).toBeNull();
  });
});

describe("confirming", () => {
  it("deletes nothing when the confirmation is declined", async () => {
    const [first, second] = await storedTwice(horn, "horn");
    confirmSpy.mockReturnValue(false);

    await click("duplicate-audio-scan");
    await click("duplicate-audio-collapse");

    expect(collapseDuplicateAudioGroups).not.toHaveBeenCalled();
    const db = await getDb();
    expect(await db.get("audioFiles", first)).toBeDefined();
    expect(await db.get("audioFiles", second)).toBeDefined();
    // The preview stays put, so declining is not the same as losing the scan.
    expect(testId("duplicate-audio-collapse")).not.toBeNull();
  });

  it("names the count and the irreversibility in the confirmation", async () => {
    await storedTwice(horn, "horn");

    await click("duplicate-audio-scan");
    await click("duplicate-audio-collapse");

    const message = String(confirmSpy.mock.calls[0][0]);
    expect(message).toContain("1 duplicate audio file");
    expect(message).toContain("permanently");
    expect(message).toContain("cannot be undone");
    // The confirmation is the last thing a user reads, and it used to promise
    // only that pads would be repointed. A pad that named both rows also loses
    // an entry, which is a change to what it plays.
    expect(message).toContain("listed both copies");
  });
});

describe("collapsing", () => {
  it("removes the copies, repoints the pad and reports what it really did", async () => {
    const profileId = await addProfile({ name: "Show", syncType: "local" });
    const [first, second] = await storedTwice(horn, "horn");
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      audioFileIds: [second],
      playbackType: "sequential",
    });

    await click("duplicate-audio-scan");
    await click("duplicate-audio-collapse");

    const db = await getDb();
    expect(await db.get("audioFiles", first)).toBeDefined();
    expect(await db.get("audioFiles", second)).toBeUndefined();
    const pads = await db.getAll("padConfigurations");
    expect(pads[0].audioFileIds).toEqual([first]);

    const result = required("duplicate-audio-result").textContent ?? "";
    expect(result).toContain("Removed 1 copy");
    // The button goes with the preview it was computed from, so a second
    // press cannot act on counts that no longer describe the library.
    expect(testId("duplicate-audio-collapse")).toBeNull();
    expect(testId("duplicate-audio-shortfall")).toBeNull();
  });

  it("reports the bytes the collapse gave back, not the bytes it was offered", async () => {
    // The two numbers are allowed to differ, and when they do the collapse's
    // is the true one: a group whose survivor went in the gap is skipped, and
    // its bytes are still sitting on disk.
    findDuplicateAudioGroups.mockResolvedValueOnce([
      craftedGroup("a".repeat(64), [2], 4_000_000),
    ]);
    collapseDuplicateAudioGroups.mockResolvedValueOnce({
      removedFiles: 1,
      reclaimedBytes: 512_000,
    });

    await click("duplicate-audio-scan");
    await click("duplicate-audio-collapse");

    const result = required("duplicate-audio-result").textContent ?? "";
    expect(result).toContain("500 KB");
    expect(result).not.toContain("3.8 MB");
  });

  it("bumps the pad-configs version so no cached copy keeps the dead id", async () => {
    await storedTwice(horn, "horn");

    await click("duplicate-audio-scan");
    expect(incrementPadConfigsVersion).not.toHaveBeenCalled();

    await click("duplicate-audio-collapse");

    expect(incrementPadConfigsVersion).toHaveBeenCalledTimes(1);
  });

  it("bumps it even when the collapse deleted nothing", async () => {
    // "Deleted nothing" is not "rewrote no pad". The collapse repoints every
    // pad in the group before it deletes anything, and its last pass refuses
    // to delete a row something still names — so a run that reclaims no bytes
    // can still have changed which id every pad on the board is holding.
    findDuplicateAudioGroups.mockResolvedValueOnce([
      craftedGroup("a".repeat(64), [2], 4_000_000),
    ]);
    collapseDuplicateAudioGroups.mockResolvedValueOnce({
      removedFiles: 0,
      reclaimedBytes: 0,
    });

    await click("duplicate-audio-scan");
    await click("duplicate-audio-collapse");

    expect(incrementPadConfigsVersion).toHaveBeenCalledTimes(1);
  });

  it("reports the real count when a survivor went between scan and confirm", async () => {
    const [hornFirst] = await storedTwice(horn, "horn");
    const [stabFirst, stabSecond] = await storedTwice(stab, "stab");

    await click("duplicate-audio-scan");
    expect(required("duplicate-audio-collapse").textContent).toContain(
      "Remove 2 Copies",
    );

    // What the preview cannot know: the horn's survivor is deleted before the
    // user presses the button. The collapse skips that group whole rather than
    // pointing its pads at a row that is not there.
    const db = await getDb();
    await db.delete("audioFiles", hornFirst);

    await click("duplicate-audio-collapse");

    const result = required("duplicate-audio-result").textContent ?? "";
    expect(result).toContain("Removed 1 copy");
    expect(result).not.toContain("Removed 2");
    const shortfall = required("duplicate-audio-shortfall").textContent ?? "";
    expect(shortfall).toContain("2");
    expect(shortfall).toContain("Scan again");

    // And the group that was still whole did collapse.
    expect(await db.get("audioFiles", stabFirst)).toBeDefined();
    expect(await db.get("audioFiles", stabSecond)).toBeUndefined();
  });

  it("says the removal failed rather than reporting a silent success", async () => {
    await storedTwice(horn, "horn");
    collapseDuplicateAudioGroups.mockRejectedValueOnce(
      new Error("transaction aborted"),
    );

    await click("duplicate-audio-scan");
    await click("duplicate-audio-collapse");

    expect(required("duplicate-audio-error").textContent).toContain(
      "transaction aborted",
    );
    expect(testId("duplicate-audio-result")).toBeNull();
    // A throw can land after the transaction committed — the cache work runs
    // outside it — so the failure path has to invalidate too.
    expect(incrementPadConfigsVersion).toHaveBeenCalledTimes(1);
  });

  it("cannot be pressed twice while the first removal is still running", async () => {
    await storedTwice(horn, "horn");
    let release: (value: {
      removedFiles: number;
      reclaimedBytes: number;
    }) => void;
    collapseDuplicateAudioGroups.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    await click("duplicate-audio-scan");
    await click("duplicate-audio-collapse");

    expect(
      (required("duplicate-audio-collapse") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (required("duplicate-audio-scan") as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      release!({ removedFiles: 1, reclaimedBytes: 14 });
    });
    expect(collapseDuplicateAudioGroups).toHaveBeenCalledTimes(1);
  });

  it("hands the collapse exactly the groups the preview was drawn from", async () => {
    await storedTwice(horn, "horn");

    await click("duplicate-audio-scan");
    const previewed = await findDuplicateAudioGroups.mock.results[0].value;
    await click("duplicate-audio-collapse");

    expect(collapseDuplicateAudioGroups).toHaveBeenCalledWith(previewed);
    // A re-scan inside the handler would make the confirmed count and the
    // acted-on count different things.
    expect(findDuplicateAudioGroups).toHaveBeenCalledTimes(1);
  });
});
