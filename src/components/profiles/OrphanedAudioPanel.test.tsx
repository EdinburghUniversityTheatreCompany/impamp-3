// @vitest-environment jsdom
/**
 * The Maintenance tab's orphaned-audio panel.
 *
 * One of the two buttons in the app that deletes a user's audio, and until
 * now the only one of the two with no unit test at all — it lived inside
 * `ProfileManager`, which e2e opens and no unit suite mounts. So the questions
 * below were only ever answered by reading the code:
 *
 *  1. Is what the panel offers to delete the same set the database calls
 *     orphaned? The scan and the cleanup are two separate reads of the
 *     library, and a sound named only by *another profile's* pad is the case
 *     that separates "unreferenced" from "unreferenced by anything I can see"
 *     — audio rows carry no `profileId`, so getting that wrong deletes a
 *     sound out from under a profile the user is not even looking at.
 *  2. Does the count on screen after a cleanup come from the database, or
 *     from subtracting the numbers the panel already had?
 *  3. Does a cleanup that failed say so, or does the panel just go quiet?
 *
 * The real `db.ts` runs against a real (fake-indexeddb) database, so a pass
 * here means rows really were deleted; the two functions are wrapped in
 * `vi.fn` so a failure can be forced and the call count read.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";

// Every audio row written here fires a background analysis that reaches Web
// Audio, which jsdom does not have. See loudnessPipelineStub.ts.
stubLoudnessPipeline();

// The real implementations, behind spies. `importActual` resolves the
// module's own imports normally, so this is one connection and one memoised
// `getDb` — the same database the fixtures below write through.
const realDb = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
const findOrphanedAudioFiles = vi.fn(realDb.findOrphanedAudioFiles);
const cleanupOrphanedAudioFiles = vi.fn(realDb.cleanupOrphanedAudioFiles);
vi.doMock("@/lib/db", () => ({
  ...realDb,
  findOrphanedAudioFiles,
  cleanupOrphanedAudioFiles,
}));

const OrphanedAudioPanel = (
  await import("@/components/profiles/OrphanedAudioPanel")
).default;
const { addAudioFile, addProfile, getDb, upsertPadConfiguration } = realDb;

/** How long the panel waits before re-reading the library after a cleanup. */
const RESCAN_DELAY_MS = 500;

let panel: MountedPanel;
let profileId: number;

const testId = (id: string) => panel.testId(id);
const required = (id: string) => panel.required(id);
const click = (id: string) => panel.click(id);
const text = (id: string) => required(id).textContent ?? "";

/** A sound of its own, so no two fixtures collapse onto one row by content. */
function soundNamed(name: string): Promise<number> {
  return addAudioFile({
    name: `${name}.wav`,
    type: "audio/wav",
    blob: new Blob([`the bytes of ${name}`], { type: "audio/wav" }),
  });
}

/** Points a pad at a sound, which is the only thing that makes it referenced. */
function padNaming(
  audioFileIds: number[],
  padIndex: number,
  owner = profileId,
): Promise<number> {
  return upsertPadConfiguration({
    profileId: owner,
    bankId: "0",
    padIndex,
    audioFileIds,
    playbackType: "sequential",
  });
}

/**
 * Presses Delete and waits out the re-scan it schedules.
 *
 * The panel re-reads the library half a second after a cleanup that deleted
 * something, and `handleScanOrphans` clears the cleanup report as it starts.
 * A test that does not wait leaves that timer to fire after the file has
 * finished — a stray database read and its logging, which is what tears a
 * coverage run down. So every test that deletes anything waits here.
 */
async function cleanupAndWaitForRescan(): Promise<void> {
  await click("orphan-cleanup");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, RESCAN_DELAY_MS + 100));
  });
  await panel.settle();
}

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
  findOrphanedAudioFiles.mockImplementation(realDb.findOrphanedAudioFiles);
  cleanupOrphanedAudioFiles.mockImplementation(
    realDb.cleanupOrphanedAudioFiles,
  );
  profileId = await addProfile({ name: "Show", syncType: "local" });
  panel = await mountPanel(<OrphanedAudioPanel />);
});

afterEach(async () => {
  await panel.unmount();
});

describe("scanning", () => {
  it("splits the library into what is named and what is not", async () => {
    const used = await soundNamed("cue");
    await soundNamed("orphan-one");
    await soundNamed("orphan-two");
    await padNaming([used], 0);

    await click("orphan-scan");

    const result = text("orphan-scan-result");
    expect(result).toContain("Total audio files: 3");
    expect(result).toContain("Referenced files: 1");
    expect(result).toContain("Orphaned files: 2");
    expect(text("orphan-cleanup")).toContain("Delete 2 Orphaned Files");
  });

  it("offers no delete button when every sound is named by a pad", async () => {
    const first = await soundNamed("cue");
    const second = await soundNamed("sting");
    await padNaming([first, second], 0);

    await click("orphan-scan");

    expect(text("orphan-scan-result")).toContain("Orphaned files: 0");
    expect(testId("orphan-cleanup")).toBeNull();
  });

  it("counts a sound only another profile's pad names as referenced", async () => {
    // `audioFiles` rows carry no `profileId` — one row is routinely named by
    // pads in several profiles — so "nothing in *this* profile names it" is
    // not orphaned, it is shared. Getting this wrong deletes a sound out from
    // under a profile the user is not looking at.
    const shared = await soundNamed("shared-horn");
    const otherProfile = await addProfile({ name: "Other", syncType: "local" });
    await padNaming([shared], 0, otherProfile);

    await click("orphan-scan");

    expect(text("orphan-scan-result")).toContain("Referenced files: 1");
    expect(text("orphan-scan-result")).toContain("Orphaned files: 0");
    expect(testId("orphan-cleanup")).toBeNull();
  });

  it("leaves no results behind when the scan itself fails", async () => {
    findOrphanedAudioFiles.mockRejectedValueOnce(new Error("store is shut"));

    await click("orphan-scan");

    expect(testId("orphan-scan-result")).toBeNull();
    // And the button comes back, so a failed scan is retryable rather than a
    // dead panel.
    expect((required("orphan-scan") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("deleting", () => {
  it("removes the unnamed rows and keeps the named one", async () => {
    const used = await soundNamed("cue");
    const firstOrphan = await soundNamed("orphan-one");
    const secondOrphan = await soundNamed("orphan-two");
    await padNaming([used], 0);

    await click("orphan-scan");
    expect(text("orphan-cleanup")).toContain("Delete 2 Orphaned Files");
    // The report is read before the re-scan clears it, which is the whole of
    // the half-second window below.
    await click("orphan-cleanup");

    expect(text("orphan-cleanup-result")).toContain("Files deleted: 2");

    const db = await getDb();
    expect(await db.get("audioFiles", used)).toBeDefined();
    expect(await db.get("audioFiles", firstOrphan)).toBeUndefined();
    expect(await db.get("audioFiles", secondOrphan)).toBeUndefined();

    await act(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, RESCAN_DELAY_MS + 100),
      );
    });
  });

  it("re-reads the library afterwards rather than subtracting", async () => {
    await soundNamed("orphan-one");

    await click("orphan-scan");
    await cleanupAndWaitForRescan();

    // Twice: the scan the user asked for, and the one the cleanup scheduled.
    // The second is what puts a count on screen that came from the database
    // rather than from the panel's own arithmetic.
    expect(findOrphanedAudioFiles).toHaveBeenCalledTimes(2);
    expect(text("orphan-scan-result")).toContain("Total audio files: 0");
    expect(text("orphan-scan-result")).toContain("Orphaned files: 0");
    expect(testId("orphan-cleanup")).toBeNull();
  });

  it("says the cleanup failed rather than reporting nothing", async () => {
    await soundNamed("orphan-one");
    cleanupOrphanedAudioFiles.mockRejectedValueOnce(
      new Error("transaction aborted"),
    );

    await click("orphan-scan");
    await click("orphan-cleanup");

    const result = text("orphan-cleanup-result");
    expect(result).toContain("Failed to cleanup");
    expect(result).toContain("transaction aborted");
    expect(result).not.toContain("Cleanup completed successfully");
  });

  it("lists the rows the cleanup could not delete", async () => {
    // A partial failure is the case a bare "done" would hide: some rows went,
    // one did not, and the one that did not is still taking up the space the
    // user pressed the button to reclaim.
    await soundNamed("orphan-one");
    cleanupOrphanedAudioFiles.mockResolvedValueOnce({
      deletedCount: 0,
      cacheEntriesCleared: 0,
      errors: ["Failed to delete audio file 7: locked"],
    });

    await click("orphan-scan");
    await click("orphan-cleanup");

    const result = text("orphan-cleanup-result");
    expect(result).toContain("Errors encountered");
    expect(result).toContain("Failed to delete audio file 7: locked");
    expect(result).not.toContain("Cleanup completed successfully");
  });

  it("cannot be scanned or pressed again while a delete is running", async () => {
    await soundNamed("orphan-one");
    let release: (value: {
      deletedCount: number;
      cacheEntriesCleared: number;
      errors: string[];
    }) => void;
    cleanupOrphanedAudioFiles.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    await click("orphan-scan");
    await click("orphan-cleanup");

    expect((required("orphan-cleanup") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((required("orphan-scan") as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      release!({ deletedCount: 0, cacheEntriesCleared: 0, errors: [] });
    });
    expect(cleanupOrphanedAudioFiles).toHaveBeenCalledTimes(1);
  });
});
