/**
 * Tests for the server sync loop. The merge itself (`detectProfileConflicts`)
 * runs for real; only the network and IndexedDB edges are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/db";
import type { ProfileSyncData } from "@/lib/syncUtils";

const dbMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
}));
const dataAccessMocks = vi.hoisted(() => ({
  getLocalProfileSyncData: vi.fn(),
  updateLocalData: vi.fn(),
}));
const driveMocks = vi.hoisted(() => ({
  downloadMissingAudioFiles: vi.fn(),
  uploadMissingAudioFiles: vi.fn(),
}));
const apiMocks = vi.hoisted(() => ({
  createServerProfile: vi.fn(),
  fetchServerProfile: vi.fn(),
  pushServerProfile: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/googleDrive/dataAccess", () => dataAccessMocks);
vi.mock("@/lib/googleDrive/sync", () => driveMocks);
vi.mock("./api", () => apiMocks);

const { syncServerProfile } = await import("./sync");
const { VersionConflictError } = await import("./types");

const PROFILE_ID = 1;
const SERVER_ID = "server-uuid";

function localProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: PROFILE_ID,
    name: "Panto",
    syncType: "server",
    serverProfileId: SERVER_ID,
    serverVersion: 3,
    lastBackedUpAt: 0,
    backupReminderPeriod: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/**
 * A sync blob. `padName` lands on a pad so merges have something to move,
 * and `modifiedAt` drives the field-level last-write-wins comparison.
 *
 * The merge calls a change a *conflict* only when both sides moved since the
 * other's last sync, so these fixtures sit either side of LAST_SYNC:
 * `AFTER_SYNC` means "this side edited", `BEFORE_SYNC` means "this side is
 * unchanged". Two AFTER_SYNC values on the same field is a real conflict.
 */
const LAST_SYNC = 1000;
const BEFORE_SYNC = 500;
const AFTER_SYNC = 2000;

function syncData(padName: string, modifiedAt: number): ProfileSyncData {
  return {
    _syncFormatVersion: 1,
    _lastSyncTimestamp: LAST_SYNC,
    profile: {
      id: PROFILE_ID,
      name: "Panto",
      syncType: "server",
      lastBackedUpAt: 0,
      backupReminderPeriod: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      _created: 0,
      _modified: modifiedAt,
      _fieldsModified: {},
    },
    padConfigurations: [
      {
        id: 1,
        profileId: PROFILE_ID,
        pageIndex: 0,
        padIndex: 0,
        name: padName,
        audioFileIds: [],
        playbackType: "sequential",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        _created: 0,
        _modified: modifiedAt,
        _fieldsModified: { name: modifiedAt },
      },
    ],
    pageMetadata: [],
    audioFiles: [],
  };
}

const callbacks = () => ({
  onStatusChange: vi.fn(),
  onError: vi.fn(),
  onConflictsDetected: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProfile.mockResolvedValue(localProfile());
  dbMocks.updateProfile.mockResolvedValue(undefined);
  dataAccessMocks.updateLocalData.mockResolvedValue([]);
  driveMocks.downloadMissingAudioFiles.mockResolvedValue({
    warnings: [],
    retryable: [],
  });
  driveMocks.uploadMissingAudioFiles.mockResolvedValue(undefined);
  dataAccessMocks.getLocalProfileSyncData.mockResolvedValue(
    syncData("local pad", AFTER_SYNC),
  );
});

describe("syncServerProfile", () => {
  it("skips a profile that isn't server-synced", async () => {
    dbMocks.getProfile.mockResolvedValue(
      localProfile({ syncType: "googleDrive" }),
    );

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result).toEqual({
      status: "skipped",
      reason: "Not a server-synced profile",
    });
    expect(apiMocks.fetchServerProfile).not.toHaveBeenCalled();
  });

  it("skips while sync is paused", async () => {
    dbMocks.getProfile.mockResolvedValue(
      localProfile({ syncPausedUntil: Date.now() + 60_000 }),
    );

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("skipped");
    expect(apiMocks.pushServerProfile).not.toHaveBeenCalled();
  });

  it("adopts a local profile the server doesn't have yet", async () => {
    dbMocks.getProfile.mockResolvedValue(
      localProfile({ serverProfileId: null, serverVersion: null }),
    );
    apiMocks.createServerProfile.mockResolvedValue({
      id: "new-id",
      version: 1,
    });

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("success");
    expect(apiMocks.createServerProfile).toHaveBeenCalledOnce();
    expect(dbMocks.updateProfile).toHaveBeenCalledWith(PROFILE_ID, {
      serverProfileId: "new-id",
      serverVersion: 1,
    });
  });

  it("pushes the merge on top of the version it pulled", async () => {
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: syncData("remote pad", BEFORE_SYNC),
    });
    apiMocks.pushServerProfile.mockResolvedValue({ version: 6 });

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("success");
    // The push must be based on 5 — the version we actually pulled — not on
    // the stale 3 the local profile was carrying.
    expect(apiMocks.pushServerProfile).toHaveBeenCalledWith(
      SERVER_ID,
      "Panto",
      expect.anything(),
      5,
      null,
    );
    expect(dbMocks.updateProfile).toHaveBeenCalledWith(PROFILE_ID, {
      serverVersion: 6,
    });
  });

  it("still pushes local edits when the server answers 304", async () => {
    // 304 → null: nothing changed remotely, but we may still owe a push.
    apiMocks.fetchServerProfile.mockResolvedValue(null);
    apiMocks.pushServerProfile.mockResolvedValue({ version: 4 });

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("success");
    expect(apiMocks.pushServerProfile).toHaveBeenCalledWith(
      SERVER_ID,
      "Panto",
      expect.anything(),
      3,
      null,
    );
  });

  it("re-merges and retries when a push loses a race", async () => {
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: syncData("remote pad", BEFORE_SYNC),
    });
    apiMocks.pushServerProfile
      .mockRejectedValueOnce(
        new VersionConflictError(
          6,
          "Panto",
          syncData("someone else", BEFORE_SYNC),
        ),
      )
      .mockResolvedValueOnce({ version: 7 });

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("success");
    expect(apiMocks.pushServerProfile).toHaveBeenCalledTimes(2);
    // The retry is based on the version that beat us, not the one we pulled.
    expect(apiMocks.pushServerProfile.mock.calls[1][3]).toBe(6);
    expect(dbMocks.updateProfile).toHaveBeenCalledWith(PROFILE_ID, {
      serverVersion: 7,
    });
  });

  it("gives up after repeated races rather than looping forever", async () => {
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: syncData("remote pad", BEFORE_SYNC),
    });
    apiMocks.pushServerProfile.mockRejectedValue(
      new VersionConflictError(9, "Panto", syncData("busy", BEFORE_SYNC)),
    );

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("error");
    expect(apiMocks.pushServerProfile).toHaveBeenCalledTimes(3);
  });

  it("never pushes as a viewer, but does apply the remote state", async () => {
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "viewer",
      data: syncData("remote pad", AFTER_SYNC),
    });
    dataAccessMocks.getLocalProfileSyncData.mockResolvedValue(
      syncData("local pad", BEFORE_SYNC),
    );

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("success");
    expect(apiMocks.pushServerProfile).not.toHaveBeenCalled();
    expect(dataAccessMocks.updateLocalData).toHaveBeenCalledOnce();
    expect(dbMocks.updateProfile).toHaveBeenCalledWith(PROFILE_ID, {
      serverVersion: 5,
      readOnly: true,
    });
  });

  it("postpones rather than dropping pads when audio can't be fetched", async () => {
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: {
        ...syncData("remote pad", BEFORE_SYNC),
        audioFiles: [
          { id: 1, name: "horn.mp3", type: "audio/mpeg", driveFileId: "d1" },
        ],
      },
    });
    driveMocks.downloadMissingAudioFiles.mockResolvedValue({
      warnings: [],
      retryable: ['"horn.mp3": network down'],
    });

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("error");
    // Nothing may be written locally or pushed — that would lose the pad.
    expect(dataAccessMocks.updateLocalData).not.toHaveBeenCalled();
    expect(apiMocks.pushServerProfile).not.toHaveBeenCalled();
  });

  it("uploads audio to Drive before pushing the blob that references it", async () => {
    dbMocks.getProfile.mockResolvedValue(
      localProfile({ googleDriveFolderId: "folder-1" }),
    );
    apiMocks.fetchServerProfile.mockResolvedValue(null);
    apiMocks.pushServerProfile.mockResolvedValue({ version: 4 });

    await syncServerProfile(PROFILE_ID, callbacks(), {
      tokenInfo: { accessToken: "t", refreshToken: null, expiresAt: 0 },
      onTokenRefresh: () => {},
    });

    expect(driveMocks.uploadMissingAudioFiles).toHaveBeenCalledOnce();
    const uploadOrder =
      driveMocks.uploadMissingAudioFiles.mock.invocationCallOrder[0];
    const pushOrder = apiMocks.pushServerProfile.mock.invocationCallOrder[0];
    expect(uploadOrder).toBeLessThan(pushOrder);
  });

  it("surfaces a genuine conflict instead of guessing", async () => {
    // Both sides changed the same pad name since their last sync.
    const local = syncData("local pad", AFTER_SYNC);
    const remote = syncData("remote pad", AFTER_SYNC + 1000);

    dataAccessMocks.getLocalProfileSyncData.mockResolvedValue(local);
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: remote,
    });

    const cbs = callbacks();
    const result = await syncServerProfile(PROFILE_ID, cbs);

    expect(result.status).toBe("conflict");
    expect(cbs.onConflictsDetected).toHaveBeenCalled();
    expect(apiMocks.pushServerProfile).not.toHaveBeenCalled();
  });

  it("shares one in-flight run between concurrent callers", async () => {
    apiMocks.fetchServerProfile.mockResolvedValue(null);
    apiMocks.pushServerProfile.mockResolvedValue({ version: 4 });

    const [a, b] = await Promise.all([
      syncServerProfile(PROFILE_ID, callbacks()),
      syncServerProfile(PROFILE_ID, callbacks()),
    ]);

    expect(a).toBe(b);
    expect(apiMocks.pushServerProfile).toHaveBeenCalledOnce();
  });
});
