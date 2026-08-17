/**
 * `importProfileFromSyncData` — keeping the content hash the blob already had.
 *
 * The sync blob names every sound by content hash, and all three ways of
 * getting the bytes (a Drive file, embedded base64, this app's own storage)
 * carry that hash on the same `ref`. Only the hosted branch read it. The other
 * two dropped it, and `importAudioSources` writes through a raw transaction
 * rather than `addAudioFile`, so nothing computed a replacement later — the
 * record simply landed hashless.
 *
 * That is expensive rather than wrong: the next sync that needs a hash index
 * finds none and reads and SHA-256s every audio file in the library, one blob
 * at a time, on the main thread. Accept a Drive share of a large board and you
 * pay for the whole library, to rebuild something you were handed.
 *
 * The dropped `serverHosted` on the Drive branch compounds it. A profile
 * migrated to hosted audio publishes both routes deliberately, so a ref can be
 * a Drive file *and* hosted, and the Drive branch wins — losing the flag then
 * defeats the "already hosted" short-circuit and re-uploads a library the
 * server already holds.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const { importProfileFromSyncData } = await import("./importExport");
const { getDb } = await import("./db");
type ProfileSyncData = import("./syncUtils").ProfileSyncData;

const donorProfile = {
  id: 99,
  name: "Shared board",
  syncType: "googleDrive" as const,
  audioLocation: "drive" as const,
  backupReminderPeriod: 1234,
  lastBackedUpAt: 555,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** A sync blob whose two sounds arrive by the two non-hosted routes. */
function syncData(): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    profile: donorProfile,
    pageMetadata: [],
    padConfigurations: [
      {
        profileId: 99,
        pageIndex: 0,
        padIndex: 0,
        name: "Horn",
        playbackType: "round-robin",
        audioFileIds: [200, 201],
        audioFileHashes: ["hash-horn", "hash-stab"],
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    audioFiles: [
      {
        id: 200,
        name: "horn.mp3",
        type: "audio/mpeg",
        hash: "hash-horn",
        driveFileId: "drive-horn",
        // A board migrated to hosted audio publishes both routes, so this is
        // a legitimate combination and the Drive branch is the one that runs.
        serverHosted: true,
      },
      {
        id: 201,
        name: "stab.mp3",
        type: "audio/mpeg",
        hash: "hash-stab",
        data: Buffer.from("stab-bytes").toString("base64"),
      },
    ],
  } as unknown as ProfileSyncData;
}

const downloadFromDrive = async () => new Blob(["horn-bytes"]);

beforeEach(async () => {
  await clearAllStores();
});

describe("importing a shared profile's audio", () => {
  it("stores the hash the blob supplied for a Drive-backed sound", async () => {
    const db = await getDb();

    const profileId = await importProfileFromSyncData(
      db,
      syncData(),
      downloadFromDrive,
      undefined,
      { syncType: "local" },
    );

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    const horn = await db.get("audioFiles", pads[0].audioFileIds![0]);

    expect(horn?.name).toBe("horn.mp3");
    // Without this the record is hashless and the next sync rebuilds the
    // whole library's hash index by reading every blob.
    expect(horn?.hash).toBe("hash-horn");
  });

  it("stores the hash for a sound that arrived as embedded base64", async () => {
    const db = await getDb();

    const profileId = await importProfileFromSyncData(
      db,
      syncData(),
      downloadFromDrive,
      undefined,
      { syncType: "local" },
    );

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    const stab = await db.get("audioFiles", pads[0].audioFileIds![1]);

    expect(stab?.name).toBe("stab.mp3");
    expect(stab?.hash).toBe("hash-stab");
  });

  it("keeps serverHosted when a sound is published by both routes", async () => {
    const db = await getDb();

    const profileId = await importProfileFromSyncData(
      db,
      syncData(),
      downloadFromDrive,
      undefined,
      { syncType: "local" },
    );

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    const horn = await db.get("audioFiles", pads[0].audioFileIds![0]);

    // Losing this re-uploads a library the server already has.
    expect(horn?.serverHosted).toBe(true);
  });
});
