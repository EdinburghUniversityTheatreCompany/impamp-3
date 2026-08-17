/**
 * The merge → write → merge loop, which is where the lost update lives.
 *
 * Every other sync suite stops at one half. `syncUtils.test.ts` asks what
 * `detectProfileConflicts` returns; `dataAccess.*.test.ts` asks what
 * `updateLocalData` stores when handed a blob. Neither asks the only question
 * that matters for correctness over time: **after a merge has been written
 * back, does the next merge still know what this device changed?**
 *
 * It did not. A sync reads the local profile, spends a second or two on the
 * network, and writes the merged record back — including `_fieldsModified`,
 * the record of which fields this device changed and when. If the user edits a
 * field in that window, the write lands a stamp computed from the *pre-edit*
 * snapshot on top of a value that has since changed. The edit survives; the
 * evidence of it does not. The next merge therefore sees a field nobody here
 * ever touched, hands the remote the win — or, when the remote is unstamped
 * too, pushes the local value over the other device's without ever raising a
 * conflict.
 *
 * That is silent data loss, and it is what made
 * `e2e-tests/server-sync.spec.ts:471` fail about a third of the time: the test
 * stages a genuine conflict and the app has already decided there is none.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const { getLocalProfileSyncData, updateLocalData } =
  await import("./dataAccess");
const { detectProfileConflicts, deepClone } = await import("@/lib/syncUtils");
const { getDb, updateProfile, upsertPadConfiguration } =
  await import("@/lib/db");
type ProfileSyncData = import("@/lib/syncUtils").ProfileSyncData;
type Profile = import("@/lib/db").Profile;

const PROFILE_ID = 1;

/** Long enough ago that anything the test does now outranks it. */
const SEEDED_AT = 1_000_000;

/**
 * A profile that has been synced before, whose `name` carries no stamp.
 *
 * That is the ordinary state after a connect: `updateLocalData` has written the
 * remote's record over the local one, and a field neither side had edited since
 * the format gained per-field stamps has no entry at all.
 */
const storedProfile = {
  id: PROFILE_ID,
  name: "Original",
  syncType: "server" as const,
  audioLocation: "server" as const,
  googleDriveFileId: null,
  googleDriveFolderId: null,
  serverProfileId: "srv-1",
  serverVersion: 4,
  serverShareToken: "tok-1",
  serverRole: "editor" as const,
  readOnly: false,
  followOnly: false,
  activePadBehavior: "continue" as const,
  lastBackedUpAt: 0,
  backupReminderPeriod: 0,
  createdAt: new Date(SEEDED_AT),
  updatedAt: new Date(SEEDED_AT),
  _created: SEEDED_AT,
  _modified: SEEDED_AT,
  _fieldsModified: { activePadBehavior: SEEDED_AT },
} as unknown as Profile;

/**
 * Waits for the clock to move on.
 *
 * The stamps are `Date.now()` and a test does its whole scenario inside one
 * millisecond, so without this the "edited after the sync read it" comparison
 * has nothing to compare — every stamp is the same number.
 */
async function nextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() <= start) await new Promise((r) => setTimeout(r, 1));
}

async function readProfile(): Promise<Profile> {
  const db = await getDb();
  const profile = await db.get("profiles", PROFILE_ID);
  if (!profile) throw new Error("profile vanished");
  return profile;
}

/**
 * What the server hands back when nothing has changed on it: our own last push,
 * echoed. `_lastSyncTimestamp` is 0 because the seeded profile has never
 * completed a sync from this device.
 */
function unchangedRemote(snapshot: ProfileSyncData): ProfileSyncData {
  return { ...deepClone(snapshot), _lastSyncTimestamp: 0 };
}

beforeEach(async () => {
  await clearAllStores();
  const db = await getDb();
  await db.put("profiles", storedProfile);
});

describe("a merge written back must not forget what this device just changed", () => {
  it("keeps the rename's stamp when a sync that read the old name completes afterwards", async () => {
    // 1. A sync starts and reads the profile as it is now.
    const localReadAt = Date.now();
    const snapshot = await getLocalProfileSyncData(PROFILE_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.profile.name).toBe("Original");

    // 2. While the request is in flight, the user renames the profile.
    await nextMillisecond();
    await updateProfile(PROFILE_ID, { name: "Mine" });
    const renameStamp = (await readProfile())._fieldsModified?.name;
    expect(renameStamp).toBeGreaterThan(0);

    // 3. The sync comes back with nothing new and writes the merge back.
    const { requiresManualResolution, mergedData } =
      await detectProfileConflicts(snapshot!, unchangedRemote(snapshot!));
    expect(requiresManualResolution).toBe(false);
    await updateLocalData(PROFILE_ID, mergedData, localReadAt);

    const after = await readProfile();
    // The value survived — it always did, because `updateLocalData` pins the
    // local name. It is the stamp beside it that used to be flattened.
    expect(after.name).toBe("Mine");
    expect(after._fieldsModified?.name).toBe(renameStamp);
  });

  it("still sees a conflict on the next merge, rather than pushing the rename over the other device", async () => {
    const localReadAt = Date.now();
    const snapshot = await getLocalProfileSyncData(PROFILE_ID);
    await nextMillisecond();
    await updateProfile(PROFILE_ID, { name: "Mine" });
    const { mergedData } = await detectProfileConflicts(
      snapshot!,
      unchangedRemote(snapshot!),
    );
    await updateLocalData(PROFILE_ID, mergedData, localReadAt);

    // The other device renamed it too, and its push landed first.
    const theirs = unchangedRemote(snapshot!);
    theirs.profile.name = "Theirs";
    theirs.profile._fieldsModified = {
      ...theirs.profile._fieldsModified,
      name: Date.now() + 60_000,
    };

    const fresh = await getLocalProfileSyncData(PROFILE_ID);
    const second = await detectProfileConflicts(fresh!, theirs);

    // Two devices renamed the same profile. That is the case the resolution
    // modal exists for; deciding it silently is the bug.
    expect(second.requiresManualResolution).toBe(true);
    expect(second.conflicts.map((c) => c.storeName)).toContain("profiles");
  });

  it("stamps a field the remote won with the remote's time, not the local one", async () => {
    // The stamp and the value have to describe the same event. Keeping local's
    // stamp beside remote's value says "this device changed it, then", which
    // makes the two sides tie on the next merge — and a tie is decided in
    // local's favour, so the value that just arrived is pushed straight back
    // out. The stamp is the merge's whole memory; a wrong one is worse than a
    // missing one.
    const snapshot = await getLocalProfileSyncData(PROFILE_ID);
    const theirs = unchangedRemote(snapshot!);
    const theirStamp = SEEDED_AT + 5_000;
    theirs.profile.activePadBehavior = "stop";
    theirs.profile._fieldsModified = {
      ...theirs.profile._fieldsModified,
      activePadBehavior: theirStamp,
    };

    const { mergedData } = await detectProfileConflicts(snapshot!, theirs);

    expect(mergedData.profile.activePadBehavior).toBe("stop");
    expect(mergedData.profile._fieldsModified?.activePadBehavior).toBe(
      theirStamp,
    );
  });

  it("does not invent a stamp of 0 for a field neither side has ever stamped", async () => {
    const snapshot = await getLocalProfileSyncData(PROFILE_ID);
    const { mergedData } = await detectProfileConflicts(
      snapshot!,
      unchangedRemote(snapshot!),
    );

    // `name` was never stamped by either side. An explicit 0 is not the same
    // answer as "not set": it travels in the pushed blob, and it overwrites a
    // real stamp on whatever device reads it back.
    expect(mergedData.profile._fieldsModified).not.toHaveProperty("name");
    expect(mergedData.profile._fieldsModified?.activePadBehavior).toBe(
      SEEDED_AT,
    );
  });

  it("keeps a pad edit's stamp when a sync that read the old pad completes afterwards", async () => {
    await upsertPadConfiguration({
      profileId: PROFILE_ID,
      pageIndex: 0,
      padIndex: 0,
      name: "Horn",
      audioFileIds: [],
      playbackType: "sequential",
    });

    const localReadAt = Date.now();
    const snapshot = await getLocalProfileSyncData(PROFILE_ID);
    expect(snapshot!.padConfigurations).toHaveLength(1);

    await nextMillisecond();
    await upsertPadConfiguration({
      profileId: PROFILE_ID,
      pageIndex: 0,
      padIndex: 0,
      name: "Air horn",
      audioFileIds: [],
      playbackType: "sequential",
    });

    const db = await getDb();
    const renamedPad = await db
      .transaction("padConfigurations")
      .objectStore("padConfigurations")
      .index("profilePagePad")
      .get([PROFILE_ID, 0, 0]);
    const padRenameStamp = renamedPad?._fieldsModified?.name;
    expect(padRenameStamp).toBeGreaterThan(0);

    const { mergedData } = await detectProfileConflicts(
      snapshot!,
      unchangedRemote(snapshot!),
    );
    await updateLocalData(PROFILE_ID, mergedData, localReadAt);

    const storedPad = await (
      await getDb()
    )
      .transaction("padConfigurations")
      .objectStore("padConfigurations")
      .index("profilePagePad")
      .get([PROFILE_ID, 0, 0]);
    // `updateLocalData` writes the merged pad wholesale, so the same
    // flattening applied here — and pads are where the audio lives.
    expect(storedPad?.name).toBe("Air horn");
    expect(storedPad?._fieldsModified?.name).toBe(padRenameStamp);
  });
});
