/**
 * What a download pass costs the database before it has downloaded anything.
 *
 * Both audio downloaders decide, per remote reference, whether this device
 * already holds those bytes — and asked with one `getAudioFileByHash`, which is
 * one IndexedDB transaction each. A shared profile of a few hundred sounds is
 * a few hundred transactions on every pass that finds nothing to do, and a
 * sync makes up to six passes.
 *
 * The question is the same one every time and the answer is a single index, so
 * this measures transactions rather than milliseconds: a wall-clock threshold
 * would be a flake on a loaded machine, and the count is what the timing was
 * made of. The counter wraps the native `IDBDatabase.prototype.transaction`, so
 * it sees every transaction the code under test opens, whichever helper opened
 * it.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  downloadAudioFileAsBlob: vi.fn(),
}));

vi.mock("@/lib/googleDrive/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/googleDrive/api")>()),
  downloadAudioFileAsBlob: apiMocks.downloadAudioFileAsBlob,
}));

const serverApiMocks = vi.hoisted(() => ({
  requestProfileDownloadUrl: vi.fn(),
}));

vi.mock("@/lib/serverAudio/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/serverAudio/api")>()),
  requestProfileDownloadUrl: serverApiMocks.requestProfileDownloadUrl,
}));

const { downloadMissingAudioFiles } = await import("@/lib/googleDrive/sync");
const { downloadProfileAudio } = await import("@/lib/serverAudio/transfer");
const { addAudioFile, computeBlobHash } = await import("@/lib/db");
type ProfileSyncData = import("@/lib/syncUtils").ProfileSyncData;

const PROFILE_ID = 1;
/** Enough that a per-reference cost is unmistakable next to a fixed one. */
const SOUNDS = 30;

let transactions = 0;
let restore: () => void;

/** Counts every IndexedDB transaction opened while it is installed. */
function countTransactions(): () => void {
  const proto = IDBDatabase.prototype;
  const original = proto.transaction;
  proto.transaction = function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    transactions += 1;
    return original.apply(this, args);
  };
  return () => {
    proto.transaction = original;
  };
}

/** Sounds this device already has, and the refs a remote sends for them. */
async function seedLocalLibrary(): Promise<ProfileSyncData["audioFiles"]> {
  const refs = [];
  for (let i = 0; i < SOUNDS; i++) {
    const blob = new Blob([`sound-${i}`], { type: "audio/mpeg" });
    const hash = await computeBlobHash(blob);
    await addAudioFile({
      blob,
      name: `sound-${i}.mp3`,
      type: "audio/mpeg",
      hash,
      // Already known to belong to this profile, so nothing needs backfilling
      // and the pass is purely the "do I have this?" question.
      driveFileIds: { [PROFILE_ID]: `drive-${i}` },
      serverHosted: true,
    });
    refs.push({
      id: i + 100,
      name: `sound-${i}.mp3`,
      type: "audio/mpeg",
      driveFileId: `drive-${i}`,
      hash,
      serverHosted: true,
    });
  }
  return refs as ProfileSyncData["audioFiles"];
}

beforeEach(async () => {
  vi.clearAllMocks();
  await clearAllStores();
  apiMocks.downloadAudioFileAsBlob.mockRejectedValue(
    new Error("nothing should be downloaded"),
  );
  serverApiMocks.requestProfileDownloadUrl.mockRejectedValue(
    new Error("nothing should be downloaded"),
  );
});

afterEach(() => {
  restore?.();
});

describe("a pass over audio this device already holds", () => {
  it("asks the database once, not once per sound (Drive)", async () => {
    const refs = await seedLocalLibrary();

    transactions = 0;
    restore = countTransactions();
    const result = await downloadMissingAudioFiles(
      refs,
      PROFILE_ID,
      { accessToken: "t", refreshToken: null, expiresAt: Date.now() + 1e6 },
      () => {},
    );
    restore();

    // Guards the measurement: a pass that downloaded, or failed, would be
    // counting something else entirely.
    expect(result).toEqual({ warnings: [], retryable: [] });
    expect(transactions).toBeLessThanOrEqual(2);
  });

  it("asks the database once, not once per sound (hosted audio)", async () => {
    const refs = await seedLocalLibrary();

    transactions = 0;
    restore = countTransactions();
    const result = await downloadProfileAudio("server-profile", refs);
    restore();

    expect(result).toEqual({ warnings: [], retryable: [], downloaded: 0 });
    expect(transactions).toBeLessThanOrEqual(2);
  });
});
