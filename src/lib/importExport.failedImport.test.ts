/**
 * What an import does when part of it cannot be written.
 *
 * The pad and page importers were hardened to collect their failures and
 * throw, so a board never comes back with holes in it while the UI says
 * "imported successfully". `importAudioSources` — the third writer in the same
 * function — was left logging and carrying on, which is the same bug one layer
 * down: the failed id never enters `audioIdMap`, the pad quietly loses that
 * sound, and the import still returns a profile id.
 *
 * The failures worth naming are a download that rejects (Drive, or the app's
 * own object store) and `QuotaExceededError`, which is what filling the
 * browser's storage partway through a large restore looks like.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { importProfileFromSyncData } = await import("./importExport");
const { getDb } = await import("./db");
type ProfileSyncData = import("./syncUtils").ProfileSyncData;

const donorProfile = {
  id: 42,
  name: "Board with two sounds",
  syncType: "local" as const,
  backupReminderPeriod: 1234,
  lastBackedUpAt: 555,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** A profile whose single pad plays two Drive-hosted sounds. */
function syncData(): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    profile: donorProfile,
    pageMetadata: [],
    padConfigurations: [
      {
        profileId: 42,
        pageIndex: 0,
        padIndex: 0,
        name: "Horn",
        playbackType: "round-robin",
        audioFileIds: [200, 201],
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    audioFiles: [
      { id: 200, name: "horn.mp3", type: "audio/mpeg", driveFileId: "drive-1" },
      { id: 201, name: "stab.mp3", type: "audio/mpeg", driveFileId: "drive-2" },
    ],
  } as unknown as ProfileSyncData;
}

/**
 * The same profile, but with two pads on one page and pad index. The second
 * violates the unique profilePagePad index, so the pad importer fails — after
 * the audio has already been written.
 */
function withCollidingPads(): ProfileSyncData {
  const data = syncData();
  const pad = data.padConfigurations![0];
  data.padConfigurations = [pad, { ...pad, name: "Collides" }];
  return data;
}

/**
 * The same profile with two banks claiming position 0, neither carrying its
 * own `bankId` — a pre-bankId shape, like this file's other pageIndex-only
 * fixtures. Both resolve to `migratedBankId(0)` = "0" in the import loop, so
 * the second violates the unique `profileBank` index (the successor to the
 * deleted `profilePage` index) and the bank importer throws before a single
 * pad is written.
 */
function withCollidingBanks(): ProfileSyncData {
  const page = {
    profileId: 42,
    pageIndex: 0,
    name: "Opening",
    isEmergency: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const data = syncData();
  data.pageMetadata = [
    page,
    { ...page, name: "Collides" },
  ] as unknown as ProfileSyncData["pageMetadata"];
  return data;
}

/** Runs an import whose audio all downloads fine, and expects it to throw. */
async function expectImportToFail(
  db: Awaited<ReturnType<typeof getDb>>,
  data: ProfileSyncData,
): Promise<void> {
  await expect(
    importProfileFromSyncData(
      db,
      data,
      async () => new Blob(["bytes"], { type: "audio/mpeg" }),
    ),
  ).rejects.toThrow();
}

beforeEach(async () => {
  await clearAllStores();
});

describe("an audio file that cannot be imported", () => {
  it("fails the import instead of quietly emptying the pad", async () => {
    const db = await getDb();
    // The second sound is unavailable — a Drive outage, a revoked share, a
    // corrupt archive entry. Exactly one of the two comes down.
    const download = vi.fn(async (driveFileId: string) =>
      driveFileId === "drive-1"
        ? new Blob(["bytes"], { type: "audio/mpeg" })
        : null,
    );

    await expect(
      importProfileFromSyncData(db, syncData(), download),
    ).rejects.toThrow(/stab\.mp3/);

    // And it must not leave a profile behind claiming to be that board.
    expect(await db.getAll("profiles")).toHaveLength(0);
  });

  it("names every sound it could not write, not just the first", async () => {
    const db = await getDb();

    await expect(
      importProfileFromSyncData(db, syncData(), async () => null),
    ).rejects.toThrow(/2 of 2/);
  });

  it("says which pad the store refused, rather than just AbortError", async () => {
    // The pad importer collects a name per rejected write and composed them
    // into "N of M pads could not be imported" — after `await padTx.done`,
    // which a rejected write never lets it reach. A rejected IndexedDB
    // request aborts its transaction, so `done` rejects first and the only
    // thing the user was ever shown for a duplicate or malformed pad was the
    // bare word "AbortError", naming neither the pad nor the reason.
    //
    // The names are reported from the failure path now, and they say what
    // really happened: the transaction rolled back, so *no* pad was written,
    // not "one of two".
    const db = await getDb();

    await expect(
      importProfileFromSyncData(
        db,
        withCollidingPads(),
        async () => new Blob(["bytes"], { type: "audio/mpeg" }),
      ),
    ).rejects.toThrow(/No pads could be imported.*refused 1 of 2/);
  });

  it("says which bank the store refused, on the same reasoning", async () => {
    // The bank importer carried the identical dead message.
    const db = await getDb();

    await expect(
      importProfileFromSyncData(
        db,
        withCollidingBanks(),
        async () => new Blob(["bytes"], { type: "audio/mpeg" }),
      ),
    ).rejects.toThrow(/No banks could be imported.*refused 1 of 2/);
  });

  it("leaves nothing behind when a later step fails", async () => {
    // Audio is written at step 2 and pads at step 4, so anything that throws
    // in between leaves audio records that `deleteProfile` cannot see — it
    // works out what to delete from the profile's *pad configurations*, and
    // there are none. A 2 GB restore that failed at the last step used to
    // leave 2 GB of unreachable blobs, and retrying leaked another copy.
    const db = await getDb();
    await expectImportToFail(db, withCollidingPads());

    expect(await db.getAll("profiles")).toHaveLength(0);
    expect(await db.getAll("audioFiles")).toHaveLength(0);
  });

  it("leaves nothing behind when it fails before writing a single pad", async () => {
    // Failing in the page importer is the worse version: not one pad exists,
    // so the pad-derived cleanup deletes none of the archive's audio.
    const db = await getDb();

    await expectImportToFail(db, withCollidingBanks());

    expect(await db.getAll("audioFiles")).toHaveLength(0);
  });

  it("keeps audio another profile's pads still name", async () => {
    // The cleanup deletes what this import created, not everything it
    // touched. A file that some surviving pad references has to stay.
    const db = await getDb();
    const keeperId = await db.add("audioFiles", {
      name: "keeper.mp3",
      type: "audio/mpeg",
      blob: new Blob(["keep me"], { type: "audio/mpeg" }),
      createdAt: new Date(0),
    });
    await db.add("padConfigurations", {
      profileId: 9999,
      bankId: "0",
      padIndex: 0,
      audioFileIds: [keeperId],
      playbackType: "round-robin",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    await expectImportToFail(db, withCollidingPads());

    expect(await db.get("audioFiles", keeperId)).toBeDefined();
  });

  it("says so plainly when the device has run out of storage", async () => {
    // A QuotaExceededError is not worth retrying as-is, and the generic
    // "could not be imported" message sends people round the same loop. There
    // was no handling for it anywhere in the client.
    const db = await getDb();
    const quota = new Error("The quota has been exceeded.");
    quota.name = "QuotaExceededError";

    await expect(
      importProfileFromSyncData(db, syncData(), async () => {
        throw quota;
      }),
    ).rejects.toThrow(/storage/i);
  });
});
