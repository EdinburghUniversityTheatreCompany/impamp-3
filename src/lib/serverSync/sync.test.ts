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
  getAudioFileIdsForProfile: vi.fn(),
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
/**
 * Hosted audio is the optional half of server sync, and off by default. These
 * tests cover the profile loop; `serverAudio/transfer.test.ts` covers hosting.
 */
const serverAudioMocks = vi.hoisted(() => ({
  uploadProfileAudio: vi.fn(),
  downloadProfileAudio: vi.fn(),
  markHostedAudio: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/googleDrive/dataAccess", () => dataAccessMocks);
vi.mock("@/lib/googleDrive/sync", () => driveMocks);
vi.mock("./api", () => apiMocks);
vi.mock("@/lib/serverAudio/transfer", () => serverAudioMocks);

const { syncServerProfile, applyServerConflictResolution } =
  await import("./sync");
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

/**
 * Both sides changed the same pad name since the other's last sync, which is
 * the only thing the merge calls a real conflict.
 */
function stageConflict() {
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

  return { local, remote };
}

const callbacks = () => ({
  onStatusChange: vi.fn(),
  onError: vi.fn(),
  onWarnings: vi.fn(),
  onConflictsDetected: vi.fn(),
  onConflictDataAvailable: vi.fn(),
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
  dbMocks.getAudioFileIdsForProfile.mockResolvedValue(new Set<number>());
  serverAudioMocks.uploadProfileAudio.mockResolvedValue({
    hosted: [],
    warnings: [],
    aborted: true,
  });
  serverAudioMocks.downloadProfileAudio.mockResolvedValue({
    warnings: [],
    retryable: [],
    downloaded: 0,
  });
  // Hosting off: the blob passes through unchanged.
  serverAudioMocks.markHostedAudio.mockImplementation(
    (data: ProfileSyncData) => data,
  );
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
    const { local, remote } = stageConflict();

    const cbs = callbacks();
    const result = await syncServerProfile(PROFILE_ID, cbs);

    expect(result.status).toBe("conflict");
    expect(cbs.onConflictsDetected).toHaveBeenCalled();
    expect(apiMocks.pushServerProfile).not.toHaveBeenCalled();
  });

  it("hands over the three versions a human needs to settle it", async () => {
    // The list of conflicts alone had no consumer, and the error string it
    // set was a red line with nothing to click — so a server conflict simply
    // stopped the profile converging.
    const { local, remote } = stageConflict();

    const cbs = callbacks();
    await syncServerProfile(PROFILE_ID, cbs);

    expect(cbs.onConflictDataAvailable).toHaveBeenCalledOnce();
    const handed = cbs.onConflictDataAvailable.mock.calls[0][0];
    expect(handed.local).toEqual(local);
    expect(handed.remote).toEqual(remote);
    // The version the push must be checked against, so a third writer landing
    // in between is refused rather than silently overwritten.
    expect(handed.origin).toEqual({
      kind: "server",
      serverProfileId: SERVER_ID,
      version: 5,
    });
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

/**
 * Only the profile's owner publishes its audio to Drive. The old condition
 * was "not read-only, has a token, has a folder", which an *editor* satisfies
 * — and their folder id came from the owner's blob, so they would try to write
 * into someone else's Drive folder. `uploadMissingAudioFiles` treats per-file
 * failures as non-fatal, so this failed silently and the sounds never landed.
 */
describe("syncServerProfile — who may publish audio to Drive", () => {
  const withDrive = {
    tokenInfo: { accessToken: "t", refreshToken: null, expiresAt: 0 },
    onTokenRefresh: () => {},
  };

  beforeEach(() => {
    apiMocks.fetchServerProfile.mockResolvedValue(null);
    apiMocks.pushServerProfile.mockResolvedValue({ version: 4 });
  });

  it("uploads for the owner", async () => {
    dbMocks.getProfile.mockResolvedValue(
      localProfile({ googleDriveFolderId: "folder-1", serverRole: "owner" }),
    );

    await syncServerProfile(PROFILE_ID, callbacks(), withDrive);

    expect(driveMocks.uploadMissingAudioFiles).toHaveBeenCalledOnce();
  });

  it("does not upload for an editor who joined by link", async () => {
    dbMocks.getProfile.mockResolvedValue(
      localProfile({
        googleDriveFolderId: "folder-1",
        serverShareToken: "tok",
      }),
    );

    await syncServerProfile(PROFILE_ID, callbacks(), withDrive);

    expect(driveMocks.uploadMissingAudioFiles).not.toHaveBeenCalled();
  });

  it("does not upload for an email-invited editor, who has no share token", async () => {
    // The case a share-token check alone would miss.
    dbMocks.getProfile.mockResolvedValue(
      localProfile({ googleDriveFolderId: "folder-1", serverRole: "editor" }),
    );

    await syncServerProfile(PROFILE_ID, callbacks(), withDrive);

    expect(driveMocks.uploadMissingAudioFiles).not.toHaveBeenCalled();
  });

  it("still uploads for a profile that predates serverRole", async () => {
    // Unknown ownership keeps the old behaviour. Guessing "collaborator" here
    // would stop a real owner publishing at all.
    dbMocks.getProfile.mockResolvedValue(
      localProfile({ googleDriveFolderId: "folder-1" }),
    );

    await syncServerProfile(PROFILE_ID, callbacks(), withDrive);

    expect(driveMocks.uploadMissingAudioFiles).toHaveBeenCalledOnce();
  });
});

describe("syncServerProfile — warnings are not errors", () => {
  beforeEach(() => {
    apiMocks.fetchServerProfile.mockResolvedValue(null);
    apiMocks.pushServerProfile.mockResolvedValue({ version: 4 });
    dbMocks.getProfile.mockResolvedValue(
      localProfile({ googleDriveFolderId: "folder-1", serverRole: "owner" }),
    );
    serverAudioMocks.uploadProfileAudio.mockResolvedValue({
      hosted: [],
      warnings: ['"horn.mp3" was too large to host'],
      aborted: false,
    });
  });

  it("reports a warning through its own channel, not as an error", async () => {
    // Routing warnings through onError turned a sync that worked into a red
    // banner on the profile card.
    const cbs = callbacks();

    const result = await syncServerProfile(PROFILE_ID, cbs, {
      tokenInfo: { accessToken: "t", refreshToken: null, expiresAt: 0 },
      onTokenRefresh: () => {},
    });

    expect(result.status).toBe("success");
    expect(cbs.onError).not.toHaveBeenCalledWith(
      expect.stringContaining("horn.mp3"),
    );
    expect(cbs.onWarnings).toHaveBeenCalledWith([
      '"horn.mp3" was too large to host',
    ]);
  });

  it("still reports the sync as successful", async () => {
    const cbs = callbacks();

    await syncServerProfile(PROFILE_ID, cbs, {
      tokenInfo: { accessToken: "t", refreshToken: null, expiresAt: 0 },
      onTokenRefresh: () => {},
    });

    expect(cbs.onStatusChange).toHaveBeenLastCalledWith("success");
  });
});

/**
 * `audioLocation` is the user's instruction about where their sounds go, and
 * until now nothing read it: Drive uploads happened whenever a folder existed,
 * and hosted uploads whenever the account was approved. Both are now gated on
 * the answer.
 */
describe("syncServerProfile — where the sounds are published", () => {
  const withDrive = {
    tokenInfo: { accessToken: "t", refreshToken: null, expiresAt: 0 },
    onTokenRefresh: () => {},
  };

  const owning = (audioLocation: string | undefined) =>
    localProfile({
      serverRole: "owner",
      googleDriveFolderId: "folder-1",
      ...(audioLocation === undefined ? {} : { audioLocation }),
    } as Partial<Profile>);

  beforeEach(() => {
    apiMocks.fetchServerProfile.mockResolvedValue(null);
    apiMocks.pushServerProfile.mockResolvedValue({ version: 4 });
  });

  it("publishes to Drive when that is where the sounds live", async () => {
    dbMocks.getProfile.mockResolvedValue(owning("googleDrive"));

    await syncServerProfile(PROFILE_ID, callbacks(), withDrive);

    expect(driveMocks.uploadMissingAudioFiles).toHaveBeenCalledOnce();
    expect(serverAudioMocks.uploadProfileAudio).not.toHaveBeenCalled();
  });

  it("publishes to the server when that is where the sounds live", async () => {
    dbMocks.getProfile.mockResolvedValue(owning("server"));

    await syncServerProfile(PROFILE_ID, callbacks(), withDrive);

    expect(driveMocks.uploadMissingAudioFiles).not.toHaveBeenCalled();
    expect(serverAudioMocks.uploadProfileAudio).toHaveBeenCalledOnce();
  });

  it("publishes nowhere when the sounds are meant to stay put", async () => {
    dbMocks.getProfile.mockResolvedValue(owning("local"));

    await syncServerProfile(PROFILE_ID, callbacks(), withDrive);

    expect(driveMocks.uploadMissingAudioFiles).not.toHaveBeenCalled();
    expect(serverAudioMocks.uploadProfileAudio).not.toHaveBeenCalled();
  });

  it("keeps hosting for a profile that predates the setting", async () => {
    // Hosted audio leaves no local trace, so an unset value cannot be read as
    // "not hosted" — doing so would silently stop uploads for every approved
    // account already relying on them.
    dbMocks.getProfile.mockResolvedValue(owning(undefined));

    await syncServerProfile(PROFILE_ID, callbacks(), withDrive);

    expect(serverAudioMocks.uploadProfileAudio).toHaveBeenCalledOnce();
  });

  it("still downloads from both backends whatever the setting says", async () => {
    // A collaborator must fetch whatever the owner published, regardless of
    // where this device would put its own sounds.
    dbMocks.getProfile.mockResolvedValue(owning("local"));
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

    await syncServerProfile(PROFILE_ID, callbacks(), withDrive);

    expect(driveMocks.downloadMissingAudioFiles).toHaveBeenCalled();
    expect(serverAudioMocks.downloadProfileAudio).toHaveBeenCalled();
  });
});

describe("applyServerConflictResolution", () => {
  const origin = {
    kind: "server" as const,
    serverProfileId: SERVER_ID,
    version: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.updateProfile.mockResolvedValue(undefined);
    dataAccessMocks.updateLocalData.mockResolvedValue([]);
  });

  it("pushes the chosen version and records the new one", async () => {
    apiMocks.pushServerProfile.mockResolvedValue({ version: 6 });
    const resolved = syncData("resolved pad", AFTER_SYNC);

    const result = await applyServerConflictResolution(
      PROFILE_ID,
      resolved,
      origin,
    );

    expect(result.status).toBe("success");
    // Pushed *at the version the conflict was against*, so a third writer who
    // landed while the user was choosing is refused, not overwritten.
    expect(apiMocks.pushServerProfile).toHaveBeenCalledWith(
      SERVER_ID,
      resolved.profile.name,
      resolved,
      5,
    );
    expect(dataAccessMocks.updateLocalData).toHaveBeenCalledWith(
      PROFILE_ID,
      resolved,
    );
    expect(dbMocks.updateProfile).toHaveBeenCalledWith(PROFILE_ID, {
      serverVersion: 6,
    });
  });

  it("explains a lost race instead of applying anything", async () => {
    apiMocks.pushServerProfile.mockRejectedValue(
      new VersionConflictError(7, "Panto", syncData("theirs", AFTER_SYNC)),
    );

    const result = await applyServerConflictResolution(
      PROFILE_ID,
      syncData("mine", AFTER_SYNC),
      origin,
    );

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error).toMatch(
      /Someone else saved/,
    );
    expect(dataAccessMocks.updateLocalData).not.toHaveBeenCalled();
  });
});
