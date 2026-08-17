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
  hasProfileChangedSince: vi.fn(),
}));
const dataAccessMocks = vi.hoisted(() => ({
  getLocalProfileSyncData: vi.fn(),
  updateLocalData: vi.fn(),
  backfillDriveFileIdsFromRemote: vi.fn(),
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
  dataAccessMocks.backfillDriveFileIdsFromRemote.mockResolvedValue(undefined);
  driveMocks.downloadMissingAudioFiles.mockResolvedValue({
    warnings: [],
    retryable: [],
  });
  driveMocks.uploadMissingAudioFiles.mockResolvedValue(undefined);
  dbMocks.getAudioFileIdsForProfile.mockResolvedValue(new Set<number>());
  // The default is "the user has edited something since the last sync", which
  // is the only state in which most of these tests are interesting at all.
  dbMocks.hasProfileChangedSince.mockResolvedValue(true);
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
    expect(dbMocks.updateProfile).toHaveBeenCalledWith(
      PROFILE_ID,
      expect.objectContaining({ serverVersion: 6 }),
    );
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
    expect(dbMocks.updateProfile).toHaveBeenCalledWith(
      PROFILE_ID,
      expect.objectContaining({ serverVersion: 7 }),
    );
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
    expect(dbMocks.updateProfile).toHaveBeenCalledWith(
      PROFILE_ID,
      expect.objectContaining({
        serverVersion: 5,
        readOnly: true,
        // Written back every sync, so a promotion to editor actually lands.
        serverRole: "viewer",
      }),
    );
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
    stageConflict();

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

  it("learns what the remote already has in Drive before deciding what to upload", async () => {
    // The Drive engine backfills first and says why; the server engine uploaded
    // at the very top of the sync, before it had fetched anything, and never
    // called the backfill at all. A device holding the audio without a
    // per-profile Drive id — after an .iaz restore, a duplicated profile, or a
    // profile switched from local to server sync — therefore uploaded the whole
    // library again and left two Drive files per sound.
    dbMocks.getProfile.mockResolvedValue(
      localProfile({ googleDriveFolderId: "folder-1", serverRole: "owner" }),
    );
    const remote = syncData("local pad", BEFORE_SYNC);
    remote.audioFiles = [
      {
        id: 60,
        name: "horn.mp3",
        type: "audio/mpeg",
        hash: "hash-A",
        driveFileId: "drive-60",
      },
    ];
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: remote,
    });

    await syncServerProfile(PROFILE_ID, callbacks(), withDrive);

    expect(dataAccessMocks.backfillDriveFileIdsFromRemote).toHaveBeenCalledWith(
      remote.audioFiles,
      PROFILE_ID,
    );
    const fetched = apiMocks.fetchServerProfile.mock.invocationCallOrder[0];
    const backfilled =
      dataAccessMocks.backfillDriveFileIdsFromRemote.mock
        .invocationCallOrder[0];
    const uploaded =
      driveMocks.uploadMissingAudioFiles.mock.invocationCallOrder[0];
    expect(fetched).toBeLessThan(backfilled);
    expect(backfilled).toBeLessThan(uploaded);
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

/**
 * The recurring trap in this codebase: the sync that finds something is almost
 * never the one a profile card is holding. Scheduled and SSE-driven syncs run
 * in ClientSideInitializer's hook instance, so anything reported only to the
 * caller that *started* a run is invisible to the card.
 */
describe("syncServerProfile — a caller that joins a running sync", () => {
  beforeEach(() => {
    apiMocks.fetchServerProfile.mockResolvedValue(null);
    apiMocks.pushServerProfile.mockResolvedValue({ version: 4 });
    dbMocks.getProfile.mockResolvedValue(
      localProfile({ googleDriveFolderId: "folder-1", serverRole: "owner" }),
    );
    serverAudioMocks.uploadProfileAudio.mockResolvedValue({
      hosted: [],
      warnings: [],
      aborted: false,
    });
  });

  it("hears how the run ended, rather than waiting forever", async () => {
    // Joining used to hand back the promise and drop the joiner's callbacks,
    // so a card that pressed "Sync now" during a background sync sat on
    // "syncing" with its button disabled until the panel was reopened.
    const background = callbacks();
    const joiner = callbacks();

    const first = syncServerProfile(PROFILE_ID, background);
    const second = syncServerProfile(PROFILE_ID, joiner);

    await Promise.all([first, second]);

    expect(joiner.onStatusChange).toHaveBeenLastCalledWith("success");
    expect(joiner.onError).toHaveBeenCalledWith(null);
  });

  it("still runs the sync only once", async () => {
    const background = callbacks();
    const joiner = callbacks();

    await Promise.all([
      syncServerProfile(PROFILE_ID, background),
      syncServerProfile(PROFILE_ID, joiner),
    ]);

    // The whole point of the in-flight map: two callers, one push.
    expect(apiMocks.pushServerProfile).toHaveBeenCalledTimes(1);
  });

  it("gives both callers the same result", async () => {
    const [a, b] = await Promise.all([
      syncServerProfile(PROFILE_ID, callbacks()),
      syncServerProfile(PROFILE_ID, callbacks()),
    ]);

    expect(a.status).toBe("success");
    expect(b).toEqual(a);
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
/**
 * Following is our decision, and the server knows nothing about it. Gating the
 * push on the server's answer alone let a follower keep writing to a profile it
 * was allowed to write to — the one thing following promises not to do.
 */
describe("syncServerProfile — following holds the push back", () => {
  beforeEach(() => {
    apiMocks.pushServerProfile.mockResolvedValue({ version: 6 });
  });

  it("does not push a followed profile, even as its editor", async () => {
    dbMocks.getProfile.mockResolvedValue(localProfile({ followOnly: true }));
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: syncData("remote pad", BEFORE_SYNC),
    });

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(apiMocks.pushServerProfile).not.toHaveBeenCalled();
    // Still receives: that is the half a follower is promised.
    expect(dataAccessMocks.updateLocalData).toHaveBeenCalledOnce();
    expect(result.status).toBe("success");
  });

  it("does not mistake following for the server refusing writes", async () => {
    // `readOnly` is the server's answer. Writing our preference into it would
    // survive unfollowing and lock the profile out of editing.
    dbMocks.getProfile.mockResolvedValue(localProfile({ followOnly: true }));
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: syncData("remote pad", BEFORE_SYNC),
    });

    await syncServerProfile(PROFILE_ID, callbacks());

    expect(dbMocks.updateProfile).toHaveBeenCalledWith(
      PROFILE_ID,
      expect.objectContaining({ readOnly: false, serverRole: "editor" }),
    );
  });

  it("still pushes a profile nobody has followed", async () => {
    dbMocks.getProfile.mockResolvedValue(localProfile());
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: syncData("remote pad", BEFORE_SYNC),
    });

    await syncServerProfile(PROFILE_ID, callbacks());

    expect(apiMocks.pushServerProfile).toHaveBeenCalledOnce();
  });
});

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
    dataAccessMocks.backfillDriveFileIdsFromRemote.mockResolvedValue(undefined);
  });

  it("writes on the share token when that is how we have access", async () => {
    // A link-share editor has no session grant on this profile, only the
    // token. Resolving without it came back "no longer available on the
    // server", so the conflict never cleared and the profile stopped
    // converging until somebody changed something by hand.
    dbMocks.getProfile.mockResolvedValue(
      localProfile({ serverShareToken: "tok-1" }),
    );
    apiMocks.pushServerProfile.mockResolvedValue({ version: 6 });

    await applyServerConflictResolution(
      PROFILE_ID,
      syncData("resolved pad", AFTER_SYNC),
      origin,
    );

    expect(apiMocks.pushServerProfile).toHaveBeenCalledWith(
      SERVER_ID,
      expect.anything(),
      expect.anything(),
      5,
      "tok-1",
    );
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
      // A link-share editor writes on this token. Without it the resolution
      // came back "no longer available", and the conflict never cleared.
      null,
    );
    expect(dataAccessMocks.updateLocalData).toHaveBeenCalledWith(
      PROFILE_ID,
      resolved,
    );
    expect(dbMocks.updateProfile).toHaveBeenCalledWith(
      PROFILE_ID,
      expect.objectContaining({ serverVersion: 6 }),
    );
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

/**
 * The push has to stop somewhere, or two clients talk to each other forever.
 *
 * Every push bumps the server's version, every bump publishes an SSE change
 * event, and every change event triggers a sync. A sync that always pushed
 * therefore closed the loop: two tabs with the same profile open hammered each
 * other at SSE latency for as long as both stayed open, doing a full GET, a
 * full local read, a merge and a full PUT each round. Two tabs of the *same*
 * browser were enough, because the origin id that suppresses a client's echo
 * of its own write is per tab.
 *
 * The hard part is that "nothing changed" cannot be answered by comparing the
 * two blobs: `audioFileIds` and every `audioFiles[].id` are IndexedDB
 * autoincrement keys, so two devices holding identical boards hold blobs that
 * differ on every sound.
 */
describe("syncServerProfile — pushing only when there is something to say", () => {
  it("does not push when the server already holds everything the merge produced", async () => {
    // Answered so that a push, if one happened, would still succeed — the
    // assertion below has to fail on the push itself, not on a stray error.
    apiMocks.pushServerProfile.mockResolvedValue({ version: 6 });
    const identical = syncData("local pad", BEFORE_SYNC);
    dataAccessMocks.getLocalProfileSyncData.mockResolvedValue(identical);
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: syncData("local pad", BEFORE_SYNC),
    });

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("success");
    expect(apiMocks.pushServerProfile).not.toHaveBeenCalled();
    // The merge still lands locally, and the version we pulled is still
    // recorded — not pushing is not the same as not syncing.
    expect(dataAccessMocks.updateLocalData).toHaveBeenCalled();
    expect(dbMocks.updateProfile).toHaveBeenCalledWith(
      PROFILE_ID,
      expect.objectContaining({ serverVersion: 5 }),
    );
  });

  it("does not push when only this device's audio ids differ", async () => {
    apiMocks.pushServerProfile.mockResolvedValue({ version: 6 });
    // The steady state between two devices: the same sound, named 50 here and
    // 60 there, with the content hash agreeing. Compared literally these blobs
    // differ on every pad, which is what kept the loop running.
    const withSound = (id: number, name: string): ProfileSyncData => {
      const data = syncData("local pad", BEFORE_SYNC);
      data.padConfigurations[0].audioFileIds = [id];
      (
        data.padConfigurations[0] as { audioFileHashes?: (string | null)[] }
      ).audioFileHashes = ["hash-A"];
      data.audioFiles = [{ id, name, type: "audio/mpeg", hash: "hash-A" }];
      return data;
    };

    dataAccessMocks.getLocalProfileSyncData.mockResolvedValue(
      withSound(50, "horn.mp3"),
    );
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: withSound(60, "horn.mp3"),
    });

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("success");
    expect(apiMocks.pushServerProfile).not.toHaveBeenCalled();
  });

  it("still pushes when the merge really does carry something new", async () => {
    dataAccessMocks.getLocalProfileSyncData.mockResolvedValue(
      syncData("renamed here", AFTER_SYNC),
    );
    apiMocks.fetchServerProfile.mockResolvedValue({
      id: SERVER_ID,
      name: "Panto",
      version: 5,
      updatedAt: 0,
      access: "editor",
      data: syncData("local pad", BEFORE_SYNC),
    });
    apiMocks.pushServerProfile.mockResolvedValue({ version: 6 });

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("success");
    expect(apiMocks.pushServerProfile).toHaveBeenCalled();
  });

  it("does not push on a 304 when nothing has changed here since the last sync", async () => {
    apiMocks.fetchServerProfile.mockResolvedValue(null);
    dbMocks.hasProfileChangedSince.mockResolvedValue(false);

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("success");
    expect(apiMocks.pushServerProfile).not.toHaveBeenCalled();
  });

  it("pushes on a 304 when audio has just been hosted, which no pad records", async () => {
    apiMocks.fetchServerProfile.mockResolvedValue(null);
    apiMocks.pushServerProfile.mockResolvedValue({ version: 4 });
    dbMocks.hasProfileChangedSince.mockResolvedValue(false);

    const unhosted = syncData("local pad", BEFORE_SYNC);
    unhosted.audioFiles = [
      { id: 50, name: "horn.mp3", type: "audio/mpeg", hash: "hash-A" },
    ];
    dataAccessMocks.getLocalProfileSyncData.mockResolvedValue(unhosted);
    dbMocks.getAudioFileIdsForProfile.mockResolvedValue(new Set([50]));
    serverAudioMocks.uploadProfileAudio.mockResolvedValue({
      hosted: ["hash-A"],
      warnings: [],
      aborted: false,
    });

    const result = await syncServerProfile(PROFILE_ID, callbacks());

    expect(result.status).toBe("success");
    // Hosting touches no pad and no page, so the "did anything change here"
    // question cannot see it. Skipping the push would leave collaborators
    // unable to find bytes that are sitting on the server.
    expect(apiMocks.pushServerProfile).toHaveBeenCalled();
  });
});
