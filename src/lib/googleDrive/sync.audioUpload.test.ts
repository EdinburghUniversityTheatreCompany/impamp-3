/**
 * The two Drive audio upload passes, and the folder they publish into.
 *
 * `uploadMissingAudioFiles` runs on every sync and `repairDriveAudioFiles` runs
 * when a user asks for a repair, and the difference between them is the whole
 * point: the first trusts `driveFileIds`, the second does not. A file whose
 * recorded Drive id points at something deleted, or at a file sitting outside
 * the profile's folder, looks perfectly fine to the sync and is exactly what
 * the repair exists to find.
 *
 * Three properties are worth holding here, and each of them is about *not*
 * doing work:
 *
 * **Neither pass reads a blob it does not need.** Both survey through
 * `getAudioFileMetadata` and only fetch bytes for the files actually going up.
 * That is not a micro-optimisation — a 960-sound board did 960 sequential
 * record reads per sync to discover there was nothing to do.
 *
 * **The repair adopts rather than duplicates.** Another browser may already
 * have uploaded the same sound into the folder, and re-uploading would leave
 * two copies with only one of them recorded.
 *
 * **One file's failure is not the pass's failure.** A sound that will not
 * upload must not stop the rest, because the alternative is a board that syncs
 * nothing at all until somebody works out which file is bad. The repair
 * reports the failure; the sync only logs it, because its caller has a whole
 * profile push to get on with.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";
import { quietConsole } from "@/lib/testSupport/quietConsole";
import type { TokenInfo } from "./types";

// Writing an audio row fires a background analysis that reaches Web Audio,
// which node does not have. See loudnessPipelineStub.ts.
stubLoudnessPipeline();

const api = {
  uploadAudioFile: vi.fn(),
  findDriveFileById: vi.fn(),
  findAudioFileInDriveFolder: vi.fn(),
  getOrCreateProfileFolder: vi.fn(),
};
vi.doMock("./api", async () => ({
  ...(await vi.importActual<typeof import("./api")>("./api")),
  ...api,
}));

const {
  addAudioFile,
  addProfile,
  getAudioFile,
  updateAudioFileDriveId,
  upsertPadConfiguration,
  getProfile,
} = await import("@/lib/db");
const {
  ensureProfileDriveFolder,
  repairDriveAudioFiles,
  uploadMissingAudioFiles,
} = await import("./sync");

const token: TokenInfo = {
  accessToken: "token",
  refreshToken: null,
  expiresAt: Date.now() + 60_000,
};
const noteRefreshedToken = () => {};

let profileId: number;

/**
 * Stores a sound and puts a pad in the profile that names it.
 *
 * Both passes reach their files through `getAudioFileIdsForProfile`, which
 * walks pad configurations — an audio row nothing references is invisible to
 * them, which is correct and also means a fixture that only writes the row
 * tests nothing.
 *
 * @param name - The file name, which is what the Drive calls are keyed on
 * @param padIndex - Which pad names it; each fixture needs its own
 * @returns The audio file's id
 */
async function storeSoundOnPad(name: string, padIndex: number) {
  const audioFileId = await addAudioFile({
    blob: new Blob([name], { type: "audio/wav" }),
    name,
    type: "audio/wav",
  });
  await upsertPadConfiguration({
    profileId,
    bankId: "0",
    padIndex,
    audioFileIds: [audioFileId],
    playbackType: "sequential",
  });
  return audioFileId;
}

/** The Drive id recorded against this profile for a stored sound. */
async function recordedDriveId(audioFileId: number) {
  return (await getAudioFile(audioFileId))?.driveFileIds?.[profileId];
}

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
  quietConsole();
  api.uploadAudioFile.mockImplementation(async (name: string) => ({
    id: `drive-${name}`,
  }));
  api.findDriveFileById.mockResolvedValue({ id: "existing", parents: [] });
  api.findAudioFileInDriveFolder.mockResolvedValue(null);
  api.getOrCreateProfileFolder.mockResolvedValue("folder-new");

  profileId = await addProfile({ name: "Show", syncType: "googleDrive" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uploadMissingAudioFiles", () => {
  it("uploads a sound Drive has never seen and records its id", async () => {
    const id = await storeSoundOnPad("horn.wav", 0);

    await uploadMissingAudioFiles(profileId, token, noteRefreshedToken);

    expect(api.uploadAudioFile).toHaveBeenCalledTimes(1);
    expect(await recordedDriveId(id)).toBe("drive-horn.wav");
  });

  it("skips a sound already recorded against this profile", async () => {
    const id = await storeSoundOnPad("horn.wav", 0);
    await updateAudioFileDriveId(id, "drive-existing", profileId);

    await uploadMissingAudioFiles(profileId, token, noteRefreshedToken);

    expect(api.uploadAudioFile).not.toHaveBeenCalled();
  });

  it("uploads a sound recorded only against another profile", async () => {
    // `audioFiles` rows are shared across profiles, and each profile publishes
    // into its own folder — so another profile's Drive id is not this one's.
    const id = await storeSoundOnPad("horn.wav", 0);
    await updateAudioFileDriveId(id, "drive-other", profileId + 99);

    await uploadMissingAudioFiles(profileId, token, noteRefreshedToken);

    expect(await recordedDriveId(id)).toBe("drive-horn.wav");
  });

  it("publishes into the profile's folder when it has one", async () => {
    await storeSoundOnPad("horn.wav", 0);

    await uploadMissingAudioFiles(
      profileId,
      token,
      noteRefreshedToken,
      "folder-1",
    );

    expect(api.uploadAudioFile.mock.calls[0].at(-1)).toBe("folder-1");
  });

  it("keeps going when one sound will not upload", async () => {
    // The alternative is a board that syncs nothing until somebody works out
    // which file is bad.
    const bad = await storeSoundOnPad("broken.wav", 0);
    const good = await storeSoundOnPad("horn.wav", 1);
    api.uploadAudioFile.mockImplementation(async (name: string) => {
      if (name === "broken.wav") throw new Error("Drive quota exceeded");
      return { id: `drive-${name}` };
    });

    await expect(
      uploadMissingAudioFiles(profileId, token, noteRefreshedToken),
    ).resolves.toBeUndefined();

    expect(await recordedDriveId(bad)).toBeUndefined();
    expect(await recordedDriveId(good)).toBe("drive-horn.wav");
  });

  it("does nothing for a profile with no sounds", async () => {
    await uploadMissingAudioFiles(profileId, token, noteRefreshedToken);

    expect(api.uploadAudioFile).not.toHaveBeenCalled();
  });
});

describe("repairDriveAudioFiles", () => {
  it("counts what it looked at and what it put back", async () => {
    await storeSoundOnPad("horn.wav", 0);
    await storeSoundOnPad("sting.wav", 1);

    const result = await repairDriveAudioFiles(
      profileId,
      token,
      noteRefreshedToken,
    );

    expect(result).toEqual({ checked: 2, uploaded: 2, errors: [] });
  });

  it("leaves a sound alone when Drive still holds it", async () => {
    const id = await storeSoundOnPad("horn.wav", 0);
    await updateAudioFileDriveId(id, "drive-horn", profileId);

    const result = await repairDriveAudioFiles(
      profileId,
      token,
      noteRefreshedToken,
    );

    expect(result.uploaded).toBe(0);
    expect(api.uploadAudioFile).not.toHaveBeenCalled();
  });

  it("re-uploads a sound whose Drive file has been deleted", async () => {
    // This is what the repair is *for*: the recorded id looks fine to the
    // ordinary sync, which never asks Drive whether the file is still there.
    const id = await storeSoundOnPad("horn.wav", 0);
    await updateAudioFileDriveId(id, "drive-gone", profileId);
    api.findDriveFileById.mockResolvedValue(null);

    const result = await repairDriveAudioFiles(
      profileId,
      token,
      noteRefreshedToken,
    );

    expect(result.uploaded).toBe(1);
    expect(await recordedDriveId(id)).toBe("drive-horn.wav");
  });

  it("re-uploads a sound sitting outside the profile's folder", async () => {
    const id = await storeSoundOnPad("horn.wav", 0);
    await updateAudioFileDriveId(id, "drive-horn", profileId);
    api.findDriveFileById.mockResolvedValue({
      id: "drive-horn",
      parents: ["some-other-folder"],
    });

    const result = await repairDriveAudioFiles(
      profileId,
      token,
      noteRefreshedToken,
      "folder-1",
    );

    expect(result.uploaded).toBe(1);
  });

  it("adopts a copy another browser already uploaded instead of duplicating", async () => {
    // Re-uploading would leave two copies in the folder with one recorded.
    const id = await storeSoundOnPad("horn.wav", 0);
    api.findAudioFileInDriveFolder.mockResolvedValue({ id: "drive-theirs" });

    const result = await repairDriveAudioFiles(
      profileId,
      token,
      noteRefreshedToken,
      "folder-1",
    );

    expect(api.uploadAudioFile).not.toHaveBeenCalled();
    expect(result.uploaded).toBe(0);
    expect(await recordedDriveId(id)).toBe("drive-theirs");
  });

  it("uploads anyway when the folder check itself fails", async () => {
    // A failed lookup is not evidence of absence, but refusing to upload on it
    // would leave the sound unreachable — the duplicate is the cheaper risk.
    const id = await storeSoundOnPad("horn.wav", 0);
    api.findAudioFileInDriveFolder.mockRejectedValue(new Error("Drive 500"));

    const result = await repairDriveAudioFiles(
      profileId,
      token,
      noteRefreshedToken,
      "folder-1",
    );

    expect(result.uploaded).toBe(1);
    expect(await recordedDriveId(id)).toBe("drive-horn.wav");
  });

  it("names the sounds it could not repair, and repairs the rest", async () => {
    const bad = await storeSoundOnPad("broken.wav", 0);
    const good = await storeSoundOnPad("horn.wav", 1);
    api.uploadAudioFile.mockImplementation(async (name: string) => {
      if (name === "broken.wav") throw new Error("Drive quota exceeded");
      return { id: `drive-${name}` };
    });

    const result = await repairDriveAudioFiles(
      profileId,
      token,
      noteRefreshedToken,
    );

    expect(result).toMatchObject({ checked: 2, uploaded: 1 });
    expect(result.errors).toEqual(['"broken.wav": Drive quota exceeded']);
    expect(await recordedDriveId(bad)).toBeUndefined();
    expect(await recordedDriveId(good)).toBe("drive-horn.wav");
  });

  it("reports a non-Error failure without losing the file's name", async () => {
    await storeSoundOnPad("horn.wav", 0);
    api.uploadAudioFile.mockRejectedValue("Drive said no");

    const result = await repairDriveAudioFiles(
      profileId,
      token,
      noteRefreshedToken,
    );

    expect(result.errors).toEqual(['"horn.wav": Drive said no']);
  });

  it("reports nothing checked for a profile with no sounds", async () => {
    expect(
      await repairDriveAudioFiles(profileId, token, noteRefreshedToken),
    ).toEqual({ checked: 0, uploaded: 0, errors: [] });
  });
});

describe("ensureProfileDriveFolder", () => {
  it("reuses the folder the profile already names", async () => {
    await addProfile({ name: "Other", syncType: "local" });
    const { updateProfile } = await import("@/lib/db");
    await updateProfile(profileId, { googleDriveFolderId: "folder-known" });

    expect(
      await ensureProfileDriveFolder(
        profileId,
        "Show",
        token,
        noteRefreshedToken,
      ),
    ).toBe("folder-known");
    expect(api.getOrCreateProfileFolder).not.toHaveBeenCalled();
  });

  it("creates a folder and records it when the profile has none", async () => {
    // The server-sync-with-Drive-audio case: nothing else ever creates one for
    // that profile, so it would sit with somewhere to publish and no folder.
    expect(
      await ensureProfileDriveFolder(
        profileId,
        "Show",
        token,
        noteRefreshedToken,
      ),
    ).toBe("folder-new");

    expect((await getProfile(profileId))?.googleDriveFolderId).toBe(
      "folder-new",
    );
  });

  it("asks for the folder under the profile's own name", async () => {
    await ensureProfileDriveFolder(
      profileId,
      "Panto 2026",
      token,
      noteRefreshedToken,
    );

    expect(api.getOrCreateProfileFolder).toHaveBeenCalledWith(
      "Panto 2026",
      token,
      noteRefreshedToken,
    );
  });
});
