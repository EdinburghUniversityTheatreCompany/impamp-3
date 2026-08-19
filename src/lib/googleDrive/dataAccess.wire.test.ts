/**
 * `getLocalProfileSyncData` — what the blob this device publishes actually
 * contains.
 *
 * `profileWire.test.ts` pins the allow-list itself. This pins the call site:
 * the blob is what Drive receives, what `PUT /api/profiles/:id` stores, and
 * what `GET /api/profiles/:id` hands back verbatim to anyone allowed to *read*
 * the profile. So a credential reaching this object is a credential reaching
 * every viewer, and it is worth asserting against the real database rather
 * than trusting the type.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const { getLocalProfileSyncData } = await import("./dataAccess");
const { getDb } = await import("@/lib/db");

const SHARE_TOKEN = "tok-a-viewer-must-never-see";

/** A profile joined by share link, so it holds an editor's bearer token. */
const collaboratorProfile = {
  name: "Show board",
  syncType: "server" as const,
  audioLocation: "googleDrive" as const,
  googleDriveFileId: "drive-file",
  googleDriveFolderId: "drive-folder",
  serverProfileId: "srv-1",
  serverVersion: 7,
  serverShareToken: SHARE_TOKEN,
  serverRole: "editor" as const,
  readOnly: false,
  followOnly: false,
  lastBackedUpAt: 123,
  backupReminderPeriod: 456,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

let profileId: number;

beforeEach(async () => {
  await clearAllStores();
  const db = await getDb();
  // autoIncrement keeps climbing across suites, so key off what the store
  // hands back rather than a literal.
  profileId = (await db.add("profiles", collaboratorProfile)) as number;
});

describe("what a remote blob is allowed to leave behind", () => {
  it("does not persist the wire-only hash fields into IndexedDB", async () => {
    // `audioFileHashes` and the `*ByHash` twins are a wire representation:
    // synthesised at export, read once to resolve a pad's audio, and
    // re-derived every time the blob is written. Stored, they are a copy
    // nothing reads that can disagree with the ids beside it after a later
    // edit — which is the exact failure the hash fields exist to prevent.
    const { updateLocalData } = await import("./dataAccess");
    const db = await getDb();

    await updateLocalData(profileId, {
      _syncFormatVersion: 1,
      profile: { ...collaboratorProfile, id: profileId },
      padConfigurations: [
        {
          profileId,
          bankId: "0",
          padIndex: 0,
          name: "Horn",
          playbackType: "round-robin",
          audioFileIds: [],
          audioFileHashes: ["hash-a"],
          audioTrimSettingsByHash: { "hash-a": { trimStart: 0, trimEnd: 1 } },
          audioGainSettingsByHash: { "hash-a": -3 },
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      pageMetadata: [],
      audioFiles: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    expect(pads).toHaveLength(1);
    expect(pads[0]).not.toHaveProperty("audioFileHashes");
    expect(pads[0]).not.toHaveProperty("audioTrimSettingsByHash");
    expect(pads[0]).not.toHaveProperty("audioGainSettingsByHash");
  });
});

describe("the published sync blob", () => {
  it("does not contain the share token anywhere", async () => {
    const blob = await getLocalProfileSyncData(profileId);

    expect(blob).not.toBeNull();
    expect(blob!.profile).not.toHaveProperty("serverShareToken");
    // Belt and braces: the whole serialised blob, not just the field, since
    // this is the object that goes over the wire.
    expect(JSON.stringify(blob)).not.toContain(SHARE_TOKEN);
  });

  it("still describes where the profile syncs", async () => {
    // The location fields are carried on purpose — the merge ignores them, but
    // dropping them here would be a different change wearing this one's badge.
    const blob = await getLocalProfileSyncData(profileId);

    expect(blob!.profile.serverProfileId).toBe("srv-1");
    expect(blob!.profile.googleDriveFileId).toBe("drive-file");
    expect(blob!.profile.googleDriveFolderId).toBe("drive-folder");
    expect(blob!.profile.name).toBe("Show board");
  });
});

describe("the delete-absent pass", () => {
  it("keeps a bank that only changed position", async () => {
    // The delete-absent pass used to key on position, so a bank that moved
    // looked like a bank the remote had deleted.
    const { updateLocalData } = await import("./dataAccess");
    const { addProfile, getAllPageMetadataForProfile, upsertPageMetadata } =
      await import("@/lib/db");

    const profileId = await addProfile({ name: "Moved", syncType: "local" });
    await upsertPageMetadata({
      profileId,
      bankId: "0",
      pageIndex: 0,
      name: "Stings",
    });
    await upsertPageMetadata({
      profileId,
      bankId: "1",
      pageIndex: 1,
      name: "Beds",
    });

    await updateLocalData(profileId, {
      _syncFormatVersion: 2,
      _lastSyncTimestamp: Date.now(),
      profile: { name: "Moved", syncType: "local" } as never,
      padConfigurations: [],
      pageMetadata: [
        {
          profileId,
          bankId: "0",
          pageIndex: 1,
          name: "Stings",
          isEmergency: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
        {
          profileId,
          bankId: "1",
          pageIndex: 0,
          name: "Beds",
          isEmergency: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      audioFiles: [],
    });

    const banks = await getAllPageMetadataForProfile(profileId);
    expect(banks.map((bank) => bank.bankId).sort()).toEqual(["0", "1"]);
    // Survival alone is not the whole claim — "only changed position" means
    // the position actually changed. An implementation that kept every bank
    // but silently discarded the incoming pageIndex would still pass the
    // assertion above.
    expect(banks.find((bank) => bank.bankId === "0")?.pageIndex).toBe(1);
    expect(banks.find((bank) => bank.bankId === "1")?.pageIndex).toBe(0);
  });

  it("deletes a bank genuinely absent from the remote, while a moved bank in the same sync survives", async () => {
    // The case the "moved" test above cannot exercise on its own: a delete
    // that keys on position cannot be told apart from a move by a test where
    // every local bank is also present remotely. Mixing a real deletion with
    // a move in the same call proves the pass tells "moved" from "gone"
    // rather than merely never deleting.
    const { updateLocalData } = await import("./dataAccess");
    const { addProfile, getAllPageMetadataForProfile, upsertPageMetadata } =
      await import("@/lib/db");

    const profileId = await addProfile({
      name: "Trimmed",
      syncType: "local",
    });
    await upsertPageMetadata({
      profileId,
      bankId: "0",
      pageIndex: 0,
      name: "Stings",
    });
    await upsertPageMetadata({
      profileId,
      bankId: "1",
      pageIndex: 1,
      name: "Beds",
    });

    await updateLocalData(profileId, {
      _syncFormatVersion: 2,
      _lastSyncTimestamp: Date.now(),
      profile: { name: "Trimmed", syncType: "local" } as never,
      padConfigurations: [],
      pageMetadata: [
        // Bank "0" moved to position 1, but is still named — must survive.
        {
          profileId,
          bankId: "0",
          pageIndex: 1,
          name: "Stings",
          isEmergency: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
        // Bank "1" is not named at all — the remote genuinely dropped it,
        // so it must be deleted rather than kept because nothing collided
        // with its old position.
      ],
      audioFiles: [],
    });

    const banks = await getAllPageMetadataForProfile(profileId);
    expect(banks.map((bank) => bank.bankId)).toEqual(["0"]);
    expect(banks[0]?.pageIndex).toBe(1);
  });

  it("deletes a pad genuinely absent from the remote, while the same-padIndex pad in another bank survives", async () => {
    // The pad twin of the two bank tests above. Two banks each hold a pad at
    // padIndex 0 — the case a key that drops bankId (or falls back to the
    // pad's own, now-nonexistent pageIndex) cannot tell apart: both pads
    // collapse onto the same map entry, so the upsert can overwrite one
    // bank's pad with the other's content and the delete pass never sees a
    // key it should delete. Bank "1"'s pad must survive; bank "0"'s must go.
    const { updateLocalData } = await import("./dataAccess");
    const {
      addProfile,
      upsertPadConfiguration,
      getPadConfigurationsForProfileBank,
    } = await import("@/lib/db");

    const profileId = await addProfile({
      name: "Pad trim",
      syncType: "local",
    });
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      name: "Kick",
      audioFileIds: [],
      playbackType: "sequential",
    });
    await upsertPadConfiguration({
      profileId,
      bankId: "1",
      padIndex: 0,
      name: "Snare",
      audioFileIds: [],
      playbackType: "sequential",
    });

    await updateLocalData(profileId, {
      _syncFormatVersion: 2,
      _lastSyncTimestamp: Date.now(),
      profile: { name: "Pad trim", syncType: "local" } as never,
      // Only bank "1"'s pad is named remotely — bank "0"'s pad is genuinely
      // gone.
      padConfigurations: [
        {
          profileId,
          bankId: "1",
          padIndex: 0,
          name: "Snare",
          audioFileIds: [],
          playbackType: "sequential",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      pageMetadata: [],
      audioFiles: [],
    });

    const bankZeroPads = await getPadConfigurationsForProfileBank(
      profileId,
      "0",
    );
    const bankOnePads = await getPadConfigurationsForProfileBank(
      profileId,
      "1",
    );
    expect(bankZeroPads).toHaveLength(0);
    expect(bankOnePads).toHaveLength(1);
    expect(bankOnePads[0]?.name).toBe("Snare");
  });
});
