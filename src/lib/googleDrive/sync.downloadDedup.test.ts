/**
 * What `downloadMissingAudioFiles` does with bytes the library turns out to
 * already hold.
 *
 * The function checks by hash before it downloads, so the ordinary duplicate
 * never reaches the write at all. The check and the write are two separate
 * transactions, though, and a browser runs several syncs at once — one per
 * connected profile, plus whatever a second tab is doing. Two of them pulling
 * the same shared sound both miss the check, both download, and both write.
 * `addAudioFile` stored two rows for that; the reuse path collapses them,
 * because its lookup and its insert are one transaction.
 *
 * These fixtures are deliberately their own, not shared with the pre-check
 * tests: the pre-check passes whether the write reuses or not, so a fixture
 * that returns early can never see the difference.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileSyncData } from "@/lib/syncUtils";

const downloadAudioFileAsBlob = vi.fn();
vi.doMock("./api", async () => ({
  ...(await vi.importActual<typeof import("./api")>("./api")),
  downloadAudioFileAsBlob,
}));

const { addAudioFile, computeBlobHash, getDb } = await import("@/lib/db");
const { downloadMissingAudioFiles } = await import("./sync");

const PROFILE_ID = 42;

/** The same bytes every time, as a fresh Blob. */
function horn(): Blob {
  return new Blob(["the horn bytes"], { type: "audio/wav" });
}

/** A Drive reference to the horn, with the hash a sync blob would carry. */
async function hornRef(
  overrides: Partial<ProfileSyncData["audioFiles"][number]> = {},
): Promise<ProfileSyncData["audioFiles"]> {
  return [
    {
      id: 1,
      name: "horn.wav",
      type: "audio/wav",
      hash: await computeBlobHash(horn()),
      driveFileId: "drive-horn",
      ...overrides,
    },
  ];
}

/** Runs the downloader with a token that is never actually used. */
async function download(refs: ProfileSyncData["audioFiles"]) {
  return downloadMissingAudioFiles(
    refs,
    PROFILE_ID,
    { accessToken: "token", expiresAt: Date.now() + 60_000 },
    () => {},
  );
}

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
});

describe("downloadMissingAudioFiles", () => {
  it("stores audio the library does not have", async () => {
    downloadAudioFileAsBlob.mockResolvedValue(horn());

    const result = await download(await hornRef());

    const db = await getDb();
    const rows = await db.getAll("audioFiles");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("horn.wav");
    expect(rows[0].hash).toBe(await computeBlobHash(horn()));
    expect(rows[0].driveFileIds).toEqual({ [PROFILE_ID]: "drive-horn" });
    expect(result.warnings).toEqual([]);
    expect(result.retryable).toEqual([]);
  });

  it("keeps one row when another sync lands the same bytes mid-download", async () => {
    // The download is where the time goes, and it is not inside the check.
    // Writing the row from the mock is what a second sync finishing first
    // looks like from in here.
    downloadAudioFileAsBlob.mockImplementation(async () => {
      await addAudioFile({ name: "horn.wav", type: "audio/wav", blob: horn() });
      return horn();
    });

    await download(await hornRef());

    const db = await getDb();
    expect(await db.getAll("audioFiles")).toHaveLength(1);
  });

  it("records this profile's Drive id on a row it reused", async () => {
    // Reuse writes nothing to the row it found, by design — so the Drive id
    // this profile knows for these bytes has to be put on afterwards. Without
    // it the sound is in the library with no route back to Drive for this
    // profile, and the next push re-uploads it.
    downloadAudioFileAsBlob.mockImplementation(async () => {
      await addAudioFile({ name: "horn.wav", type: "audio/wav", blob: horn() });
      return horn();
    });

    await download(await hornRef());

    const db = await getDb();
    const rows = await db.getAll("audioFiles");
    expect(rows).toHaveLength(1);
    expect(rows[0].driveFileIds).toEqual({ [PROFILE_ID]: "drive-horn" });
  });

  it("does not download bytes the library already holds", async () => {
    // The pre-check earns its keep: the whole point is to skip the network,
    // not merely to avoid the second row.
    const existingId = await addAudioFile({
      name: "horn-under-another-name.wav",
      type: "audio/wav",
      blob: horn(),
    });

    await download(await hornRef());

    expect(downloadAudioFileAsBlob).not.toHaveBeenCalled();
    const db = await getDb();
    const row = await db.get("audioFiles", existingId);
    expect(row?.driveFileIds).toEqual({ [PROFILE_ID]: "drive-horn" });
  });
});
