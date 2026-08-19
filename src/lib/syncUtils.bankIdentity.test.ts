/**
 * The merge keys on identity, so a rename made on one device and a reorder
 * made on another do not fight.
 *
 * With position as the key, the rename landed on whichever bank now sat at
 * that position — silently, with no conflict raised. That is the whole
 * reason `bankId` exists.
 */
import { describe, expect, it } from "vitest";
import {
  describesSameSyncState,
  detectProfileConflicts,
  normaliseIncomingSyncData,
  type ProfileSyncData,
  type SyncedPadConfiguration,
} from "./syncUtils";
import { normaliseBankOrder } from "./bankOrder";
import { migratedBankId } from "./dbMigrations/v7BankId";
import type { PageMetadata } from "./db";

const LAST_SYNC = 1_000;
const RENAMED_AT = 2_000;
const MOVED_AT = 2_500;

const baseProfile = {
  id: 1,
  name: "Test profile",
  syncType: "googleDrive" as const,
  lastBackedUpAt: 0,
  backupReminderPeriod: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function bank(
  bankId: string,
  pageIndex: number,
  name: string,
  fieldsModified: Record<string, number> = {},
): PageMetadata {
  return {
    profileId: 1,
    bankId,
    pageIndex,
    name,
    isEmergency: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    _created: 0,
    _modified: Math.max(0, ...Object.values(fieldsModified)),
    _fieldsModified: fieldsModified,
  };
}

function syncData(
  banks: PageMetadata[],
  pads: SyncedPadConfiguration[] = [],
): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    _lastSyncTimestamp: LAST_SYNC,
    profile: { ...baseProfile },
    padConfigurations: pads,
    pageMetadata: banks,
    audioFiles: [],
  };
}

function pad(
  bankId: string,
  padIndex: number,
  name: string,
): SyncedPadConfiguration {
  return {
    profileId: 1,
    bankId,
    padIndex,
    name,
    audioFileIds: [],
    playbackType: "sequential",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    _created: 0,
    _modified: 0,
    _fieldsModified: {},
  };
}

describe("a rename and a reorder made on two devices", () => {
  it("leaves the rename on the bank it was made on", async () => {
    // This device renamed bank "a" and left it at position 0.
    const local = syncData([
      bank("a", 0, "Stings", { name: RENAMED_AT }),
      bank("b", 1, "Bank 2"),
    ]);
    // The other device moved bank "b" to position 0 and never renamed.
    const remote = syncData([
      bank("a", 1, "Bank 1", { pageIndex: MOVED_AT }),
      bank("b", 0, "Bank 2", { pageIndex: MOVED_AT }),
    ]);

    const { mergedData, conflicts } = await detectProfileConflicts(
      local,
      remote,
    );
    const merged = new Map(
      mergedData.pageMetadata.map((page) => [page.bankId, page]),
    );

    expect(conflicts).toHaveLength(0);
    // The rename stayed with "a", and the move stayed with the positions.
    expect(merged.get("a")?.name).toBe("Stings");
    expect(merged.get("a")?.pageIndex).toBe(1);
    expect(merged.get("b")?.pageIndex).toBe(0);
  });

  it("does not treat a moved bank as a new bank", async () => {
    const local = syncData([bank("a", 0, "Stings"), bank("b", 1, "Beds")]);
    const remote = syncData([bank("a", 1, "Stings"), bank("b", 0, "Beds")]);

    const { mergedData } = await detectProfileConflicts(local, remote);

    expect(mergedData.pageMetadata).toHaveLength(2);
  });
});

describe("order normalisation across two devices", () => {
  it("resolves duplicate and gappy positions to one dense order", () => {
    // Both devices hold the same rows, in whatever order they read them.
    const deviceA = [bank("a", 2, "A"), bank("b", 2, "B"), bank("c", 7, "C")];
    const deviceB = [bank("c", 7, "C"), bank("b", 2, "B"), bank("a", 2, "A")];

    const orderA = normaliseBankOrder(deviceA).map((page) => page.bankId);
    const orderB = normaliseBankOrder(deviceB).map((page) => page.bankId);

    expect(orderA).toEqual(["a", "b", "c"]);
    expect(orderB).toEqual(orderA);
    expect(normaliseBankOrder(deviceA).map((page) => page.pageIndex)).toEqual([
      0, 1, 2,
    ]);
  });
});

describe("the diff summary sorts on identity, not position", () => {
  it("still reports the same state when two banks tie on an unnormalised position", () => {
    // Mid-reorder, both devices can legitimately hold two banks at the same
    // pageIndex (see bankOrder.ts). Sorting the diff summary by pageIndex
    // would break that tie by array order, which differs depending on how
    // each device happened to read its rows — a false "these differ",
    // costing a needless push. Sorting by bankId breaks the tie the same way
    // on both devices.
    const a = syncData([bank("a", 0, "A"), bank("b", 0, "B")]);
    const b = syncData([bank("b", 0, "B"), bank("a", 0, "A")]);

    expect(describesSameSyncState(a, b)).toBe(true);
  });

  it("still reports the same state when two pads in one bank are listed in opposite order", () => {
    // The sort's primary key is bankId, and every pad in the same bank ties
    // on it — this is the common case, not the rare mid-reorder one above.
    // Without the padIndex tie-break, array order (which differs per device)
    // decides the JSON order, and a false "these differ" feeds
    // `serverSync/sync.ts`'s `nothingToSend` check straight into a push loop.
    const a = syncData(
      [bank("a", 0, "A")],
      [pad("a", 0, "Kick"), pad("a", 1, "Snare")],
    );
    const b = syncData(
      [bank("a", 0, "A")],
      [pad("a", 1, "Snare"), pad("a", 0, "Kick")],
    );

    expect(describesSameSyncState(a, b)).toBe(true);
  });
});

describe("a remote blob written before bankId shipped", () => {
  it("lands banks on the identities the local migration already minted, instead of one conflict per bank", async () => {
    // Local has already been through the v7 migration: its bankIds are
    // deterministic, `migratedBankId(pageIndex)`. The remote blob predates
    // `bankId` entirely — built as raw JSON, the way a blob actually
    // downloaded from before this branch shipped would arrive, and cast
    // rather than typed, since TypeScript cannot see what an old client left
    // out of a value that only exists as parsed JSON.
    const local = syncData([
      bank(migratedBankId(0), 0, "Stings"),
      bank(migratedBankId(1), 1, "Beds"),
    ]);
    const legacyBank = (pageIndex: number, name: string) => ({
      profileId: 1,
      pageIndex,
      name,
      isEmergency: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      _created: 0,
      _modified: 0,
      _fieldsModified: {},
    });
    const remote = {
      _syncFormatVersion: 2,
      _lastSyncTimestamp: LAST_SYNC,
      profile: { ...baseProfile },
      padConfigurations: [],
      pageMetadata: [legacyBank(0, "Stings"), legacyBank(1, "Beds")],
      audioFiles: [],
    } as unknown as ProfileSyncData;

    const { conflicts, mergedData } = await detectProfileConflicts(
      local,
      remote,
    );

    expect(conflicts).toHaveLength(0);
    const merged = new Map(
      mergedData.pageMetadata.map((page) => [page.bankId, page]),
    );
    expect(merged.size).toBe(2);
    expect(merged.get(migratedBankId(0))?.name).toBe("Stings");
    expect(merged.get(migratedBankId(1))?.name).toBe("Beds");
  });

  it("lands pads on the same identities too, keyed by bankId-padIndex", async () => {
    // No banks on either side, to isolate the pad path from the bank path
    // already covered above.
    const local = syncData([], [pad(migratedBankId(0), 0, "Kick")]);
    const legacyPad = (pageIndex: number, padIndex: number, name: string) => ({
      profileId: 1,
      pageIndex,
      padIndex,
      name,
      audioFileIds: [],
      playbackType: "sequential",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      _created: 0,
      _modified: 0,
      _fieldsModified: {},
    });
    const remote = {
      _syncFormatVersion: 2,
      _lastSyncTimestamp: LAST_SYNC,
      profile: { ...baseProfile },
      padConfigurations: [legacyPad(0, 0, "Kick")],
      pageMetadata: [],
      audioFiles: [],
    } as unknown as ProfileSyncData;

    const { conflicts, mergedData } = await detectProfileConflicts(
      local,
      remote,
    );

    expect(conflicts).toHaveLength(0);
    expect(mergedData.padConfigurations).toHaveLength(1);
    expect(mergedData.padConfigurations[0]?.bankId).toBe(migratedBankId(0));
  });
});

describe("normaliseIncomingSyncData", () => {
  it("leaves a pad with neither bankId nor pageIndex unmigrated, rather than defaulting it to bank 0", () => {
    // migrateToV7's pass 1/3 skip exactly this shape, with a warning, rather
    // than filing corrupt data under a real bank it may have nothing to do
    // with. The normaliser has to make the identical call, not merely a
    // similar one.
    const corruptPad = {
      profileId: 1,
      padIndex: 0,
      name: "Orphan",
      audioFileIds: [],
      playbackType: "sequential",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      _created: 0,
      _modified: 0,
      _fieldsModified: {},
    } as unknown as SyncedPadConfiguration;

    const normalised = normaliseIncomingSyncData({
      _syncFormatVersion: 2,
      _lastSyncTimestamp: LAST_SYNC,
      profile: { ...baseProfile },
      padConfigurations: [corruptPad],
      pageMetadata: [],
      audioFiles: [],
    });

    expect(normalised.padConfigurations[0]?.bankId).toBeUndefined();
  });

  it("strips a pad's own pageIndex once it has been given a bankId", () => {
    const legacyPad = {
      profileId: 1,
      pageIndex: 2,
      padIndex: 0,
      name: "Kick",
      audioFileIds: [],
      playbackType: "sequential",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      _created: 0,
      _modified: 0,
      _fieldsModified: {},
    } as unknown as SyncedPadConfiguration;

    const normalised = normaliseIncomingSyncData({
      _syncFormatVersion: 2,
      _lastSyncTimestamp: LAST_SYNC,
      profile: { ...baseProfile },
      padConfigurations: [legacyPad],
      pageMetadata: [],
      audioFiles: [],
    });

    expect(normalised.padConfigurations[0]?.bankId).toBe(migratedBankId(2));
    expect(
      (normalised.padConfigurations[0] as unknown as { pageIndex?: number })
        .pageIndex,
    ).toBeUndefined();
  });
});
