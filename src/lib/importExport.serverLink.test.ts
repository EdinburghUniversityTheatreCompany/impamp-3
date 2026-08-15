/**
 * `importProfileFromSyncData` — bringing a profile onto this device — with
 * gain settings and a sync link.
 *
 * This is the path `useConnectServerProfile` takes for both ways in: opening
 * someone's share link, and picking one of your own from the connect list. It
 * hands the import a `{ syncType: "server" }` link and expects the donor's own
 * link fields to be ignored.
 *
 * `importPadConfigurations`, which does the id remapping underneath, is module
 * private and had no test of any kind — so the assertion that a gain setting
 * follows its sound through a fresh set of local audio ids was resting on the
 * remap helper's own unit tests, which cannot see which mode this call site
 * wires up or whether it is called at all.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const { importProfileFromSyncData } = await import("./importExport");
const { getDb } = await import("./db");
type ProfileSyncData = import("./syncUtils").ProfileSyncData;

/** The donor: a profile that syncs to *someone else's* Drive and server. */
const donorProfile = {
  id: 99,
  name: "Their board",
  syncType: "googleDrive" as const,
  audioLocation: "googleDrive" as const,
  googleDriveFileId: "their-drive-file",
  googleDriveFolderId: "their-drive-folder",
  serverProfileId: "srv-theirs",
  serverShareToken: "tok-theirs",
  serverRole: "editor" as const,
  readOnly: false,
  followOnly: true,
  activePadBehavior: "stop" as const,
  backupReminderPeriod: 1234,
  lastBackedUpAt: 555,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const syncData = {
  _syncFormatVersion: 2,
  profile: donorProfile,
  pageMetadata: [],
  padConfigurations: [
    {
      profileId: 99,
      pageIndex: 0,
      padIndex: 0,
      name: "Horn",
      // Both sounds arrive; the sender knows them as 200 and 201.
      audioFileIds: [200, 201],
      audioGainSettings: { 200: 4.5, 201: -6 },
      audioTrimSettings: {
        200: { trimStart: 0, trimEnd: 2 },
        201: { trimStart: 1, trimEnd: 3 },
      },
      padGainDb: -2.5,
      playbackType: "round-robin" as const,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    {
      profileId: 99,
      pageIndex: 0,
      padIndex: 1,
      name: "Missing",
      // References a sound the donor never shipped, so it has no local id.
      audioFileIds: [999],
      audioGainSettings: { 999: 11 },
      playbackType: "sequential" as const,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ],
  audioFiles: [
    {
      id: 200,
      name: "horn.mp3",
      type: "audio/mpeg",
      driveFileId: "drive-200",
    },
    {
      id: 201,
      name: "stab.mp3",
      type: "audio/mpeg",
      driveFileId: "drive-201",
    },
  ],
} as unknown as ProfileSyncData;

const downloadAudioBlob = async (driveFileId: string) =>
  new Blob([`bytes for ${driveFileId}`], { type: "audio/mpeg" });

beforeEach(clearAllStores);

describe("importProfileFromSyncData — gain settings on a connected server profile", () => {
  it("remaps gain onto the ids this device allocated, and takes its link from the caller rather than the donor", async () => {
    const db = await getDb();

    // Exactly what useConnectServerProfile passes: server sync, and none of
    // the donor's Drive ids — those are the owner's.
    const newProfileId = await importProfileFromSyncData(
      db,
      syncData,
      downloadAudioBlob,
      undefined,
      { syncType: "server" },
    );

    // Where it syncs is the caller's answer.
    const profile = await db.get("profiles", newProfileId);
    expect(profile?.syncType).toBe("server");
    expect(profile?.googleDriveFileId).toBeNull();
    expect(profile?.googleDriveFolderId).toBeNull();
    expect(profile?.audioLocation).toBeNull();
    // Content, by contrast, is the donor's.
    expect(profile?.activePadBehavior).toBe("stop");
    expect(profile?.backupReminderPeriod).toBe(1234);

    // The two sounds landed under ids this device chose, unrelated to 200/201.
    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      newProfileId,
    );
    const horn = pads.find((p) => p.padIndex === 0);
    expect(horn?.audioFileIds).toHaveLength(2);
    const [hornId, stabId] = horn!.audioFileIds!;

    // Each gain followed its own sound. Getting this wrong by one position is
    // the failure that would silently swap two sounds' levels.
    expect(horn?.audioGainSettings).toEqual({ [hornId]: 4.5, [stabId]: -6 });
    expect(horn?.audioTrimSettings).toEqual({
      [hornId]: { trimStart: 0, trimEnd: 2 },
      [stabId]: { trimStart: 1, trimEnd: 3 },
    });
    expect(horn?.padGainDb).toBe(-2.5);

    // Confirms the ids really were reallocated, so the assertion above is not
    // passing because 200 and 201 happened to survive verbatim.
    expect(horn?.audioFileIds).not.toContain(200);
    expect(horn?.audioFileIds).not.toContain(201);
  });

  it("drops a gain setting whose sound never arrived", async () => {
    const db = await getDb();
    const newProfileId = await importProfileFromSyncData(
      db,
      syncData,
      downloadAudioBlob,
      undefined,
      { syncType: "server" },
    );

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      newProfileId,
    );
    const missing = pads.find((p) => p.padIndex === 1);

    // 999 was never shipped, so there is no local id to move its +11 dB onto.
    // Left under 999 it would eventually attach to an unrelated recording.
    expect(missing?.audioFileIds).toEqual([]);
    expect(missing?.audioGainSettings).toEqual({});
  });

  it("gives each connected copy its own audio ids, so two imports cannot share a gain setting", async () => {
    const db = await getDb();

    const firstId = await importProfileFromSyncData(
      db,
      syncData,
      downloadAudioBlob,
      undefined,
      { syncType: "server" },
    );
    const secondId = await importProfileFromSyncData(
      db,
      syncData,
      downloadAudioBlob,
      undefined,
      { syncType: "server" },
    );

    expect(secondId).not.toBe(firstId);

    const padsOf = async (profileId: number) =>
      (
        await db.getAllFromIndex("padConfigurations", "profileId", profileId)
      ).find((p) => p.padIndex === 0);

    const first = await padsOf(firstId);
    const second = await padsOf(secondId);

    // Both copies carry the same gain values...
    expect(Object.values(first!.audioGainSettings!).sort()).toEqual(
      Object.values(second!.audioGainSettings!).sort(),
    );
    // ...and each is keyed by its own pad's audio ids. Deduplication by
    // content hash may legitimately make these the same ids; what must hold is
    // that each pad's gain keys match that pad's own sounds.
    expect(Object.keys(first!.audioGainSettings!).map(Number).sort()).toEqual(
      [...first!.audioFileIds!].sort(),
    );
    expect(Object.keys(second!.audioGainSettings!).map(Number).sort()).toEqual(
      [...second!.audioFileIds!].sort(),
    );
  });
});
