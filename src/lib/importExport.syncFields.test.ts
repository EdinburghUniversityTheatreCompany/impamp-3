/**
 * The sync bookkeeping an import writes.
 *
 * `_created`, `_modified` and `_fieldsModified` are the entire basis
 * `compareSyncableItems` decides a merge on. A record written without them
 * reads `localFields[field] ?? 0` as zero for every field, so nothing counts
 * as changed locally and the tiebreak — `(remote._modified ?? 0) >
 * (local._modified ?? 0)` — hands the remote every differing field.
 *
 * The pad and page importers were given `initialSyncFields`. The profile
 * record was not, so importing a board, changing its normalisation, and then
 * connecting it to a share silently reverted the change on the first sync.
 * And the pads stamped the *incoming* object rather than the one being
 * written, which votes on wire-only keys and abstains on stored ones.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const { importProfileFromSyncData } = await import("./importExport");
const { getDb } = await import("./db");
type ProfileSyncData = import("./syncUtils").ProfileSyncData;

/**
 * A donor whose pad carries the hash-keyed fields that exist only on the
 * wire, and omits two that exist only in the store (`isDisabled`, `padGainDb`).
 */
function syncData(): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    profile: {
      id: 7,
      name: "Donor board",
      syncType: "server" as const,
      normalisation: { enabled: false, targetLufs: -20 },
      activePadBehavior: "stop" as const,
      backupReminderPeriod: 4321,
      lastBackedUpAt: 111,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    pageMetadata: [],
    padConfigurations: [
      {
        profileId: 7,
        pageIndex: 0,
        padIndex: 0,
        name: "Horn",
        playbackType: "round-robin",
        audioFileIds: [],
        audioFileHashes: [],
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    audioFiles: [],
  } as unknown as ProfileSyncData;
}

const importIt = async () => {
  const db = await getDb();
  const profileId = await importProfileFromSyncData(
    db,
    syncData(),
    async () => null,
  );
  return { db, profileId };
};

beforeEach(async () => {
  await clearAllStores();
});

describe("an imported profile record", () => {
  it("is stamped as modified now, like every other record the import writes", async () => {
    const { db, profileId } = await importIt();
    const profile = await db.get("profiles", profileId);

    expect(profile?._created).toBeGreaterThan(0);
    expect(profile?._modified).toBeGreaterThan(0);
  });

  it("stamps the settings a first sync would otherwise silently revert", async () => {
    const { db, profileId } = await importIt();
    const fields = (await db.get("profiles", profileId))?._fieldsModified ?? {};

    for (const field of [
      "name",
      "normalisation",
      "activePadBehavior",
      "backupReminderPeriod",
    ]) {
      expect(fields[field]).toBeGreaterThan(0);
    }
  });

  it("does not stamp the housekeeping fields", async () => {
    // `initialSyncFields` excludes these deliberately — they are not content,
    // and a vote on them means nothing to a merge.
    const { db, profileId } = await importIt();
    const fields = (await db.get("profiles", profileId))?._fieldsModified ?? {};

    expect(fields).not.toHaveProperty("createdAt");
    expect(fields).not.toHaveProperty("updatedAt");
    expect(fields).not.toHaveProperty("id");
  });
});

describe("an imported pad", () => {
  it("stamps the fields it is stored with, not the ones it arrived with", async () => {
    const { db, profileId } = await importIt();
    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    const fields = pads[0]._fieldsModified ?? {};

    // Stored on the record, so a merge can be asked about them. An absent
    // entry is a losing vote, which is how an imported pad lost its own
    // disabled flag to a remote that happened to have one.
    expect(fields).toHaveProperty("isDisabled");
    expect(fields).toHaveProperty("padGainDb");

    // Wire-only: derived on the way out and destructured off on the way in,
    // so a stamp for one describes a field that is not there.
    expect(fields).not.toHaveProperty("audioFileHashes");
  });
});

describe("importing a pre-bankId sync blob directly", () => {
  // `importProfileFromSyncData` is reachable with a blob nothing upstream
  // has normalised — `useConnectServerProfile` calls `fetchServerProfile`
  // directly, and `ProfileManager`'s public-share proxy fetches
  // `/api/drive/public-file` itself, neither going through
  // `googleDrive/api.ts` or `serverSync/sync.ts`'s normalisation. This
  // fixture is genuinely pre-bankId — pageIndex only, no bankId anywhere —
  // exactly what either of those raw paths would hand this function.
  it("still gives the bank and its pad the deterministic migrated id", async () => {
    const db = await getDb();
    const legacyData = {
      _syncFormatVersion: 2,
      profile: {
        id: 9,
        name: "Legacy donor",
        syncType: "server" as const,
        activePadBehavior: "stop" as const,
        backupReminderPeriod: 4321,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      pageMetadata: [
        {
          profileId: 9,
          pageIndex: 3,
          name: "Stings",
          isEmergency: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      padConfigurations: [
        {
          profileId: 9,
          pageIndex: 3,
          padIndex: 0,
          name: "Horn",
          playbackType: "round-robin",
          audioFileIds: [],
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      audioFiles: [],
    } as unknown as ProfileSyncData;

    const profileId = await importProfileFromSyncData(
      db,
      legacyData,
      async () => null,
    );

    const pages = await db.getAllFromIndex(
      "pageMetadata",
      "profileId",
      profileId,
    );
    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );

    expect(pages[0].bankId).toBe("3");
    expect(pads[0].bankId).toBe("3");
  });
});
