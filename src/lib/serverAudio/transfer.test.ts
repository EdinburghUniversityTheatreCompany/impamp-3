/**
 * Tests for moving audio between IndexedDB and the hosted bucket. The HTTP
 * client and IndexedDB are stubbed; the decision logic runs for real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileSyncData } from "@/lib/syncUtils";
import { NotSignedInError } from "@/lib/serverSync/types";

const dbMocks = vi.hoisted(() => ({
  addAudioFile: vi.fn(),
  computeBlobHash: vi.fn(),
  // Returns the getter the real factory returns. These suites never exercise
  // the pre-hashing fallback — every reference carries a hash — so an empty
  // index is the honest stand-in for "nothing matched by content".
  createHashlessAudioIndex: vi.fn(() => async () => new Map()),
  ensureAudioFileHash: vi.fn(),
  getAudioFile: vi.fn(),
  getAudioFileByHash: vi.fn(),
  getAudioFileMetadata: vi.fn(),
  getDb: vi.fn(),
  markAudioFilesHosted: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  commitUpload: vi.fn(),
  fetchAudioLibrary: vi.fn(),
  requestProfileDownloadUrl: vi.fn(),
  requestUploadUrl: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("./api", async (importOriginal) => {
  // The error classes are real: the code under test branches on instanceof.
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, ...apiMocks };
});

const {
  canHostAudio,
  downloadProfileAudio,
  extensionOf,
  forgetAudioCapability,
  markHostedAudio,
  uploadProfileAudio,
} = await import("./transfer");
const { AudioQuotaError, NotApprovedForAudioError } = await import("./api");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function localFile(hash: string, name = "clap.wav", size = 1024) {
  return {
    id: 1,
    name,
    type: "audio/wav",
    hash,
    blob: new Blob([new Uint8Array(size)], { type: "audio/wav" }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetAudioCapability();
  vi.stubGlobal("fetch", vi.fn());
  apiMocks.fetchAudioLibrary.mockResolvedValue({
    canUploadAudio: true,
    usage: { usedBytes: 0, quotaBytes: 1000, fileCount: 0 },
    files: [],
  });
  dbMocks.getDb.mockResolvedValue({
    getAllKeys: vi.fn().mockResolvedValue([]),
  });
  dbMocks.getAudioFileByHash.mockResolvedValue(undefined);
  // Mirrors whatever getAudioFile is stubbed to return, so a test that sets up
  // a local file gets a consistent answer from both without saying it twice.
  dbMocks.getAudioFileMetadata.mockImplementation(
    async (ids: Iterable<number>) => {
      const map = new Map();
      for (const id of ids) {
        const file = await dbMocks.getAudioFile(id);
        if (file) {
          map.set(id, {
            id,
            name: file.name,
            type: file.type,
            hash: file.hash,
            serverHosted: file.serverHosted,
          });
        }
      }
      return map;
    },
  );
});

describe("extensionOf", () => {
  it("takes the extension from the filename", () => {
    expect(extensionOf("Applause.WAV", "audio/wav")).toBe("wav");
  });

  it("falls back to the content type's subtype", () => {
    expect(extensionOf("no-extension", "audio/mpeg")).toBe("mpeg");
  });
});

describe("canHostAudio", () => {
  it("asks the server once and remembers the answer", async () => {
    await canHostAudio();
    await canHostAudio();
    expect(apiMocks.fetchAudioLibrary).toHaveBeenCalledOnce();
  });

  it("is false when the deployment hosts nothing", async () => {
    apiMocks.fetchAudioLibrary.mockRejectedValue(new Error("501"));
    expect(await canHostAudio()).toBe(false);
  });

  it("is false for an account that is not approved", async () => {
    apiMocks.fetchAudioLibrary.mockResolvedValue({
      canUploadAudio: false,
      usage: { usedBytes: 0, quotaBytes: 0, fileCount: 0 },
      files: [],
    });
    expect(await canHostAudio()).toBe(false);
  });
});

describe("uploadProfileAudio", () => {
  it("does nothing at all when hosting is unavailable", async () => {
    apiMocks.fetchAudioLibrary.mockRejectedValue(new Error("501"));

    const result = await uploadProfileAudio([1, 2, 3]);

    expect(result).toEqual({ hosted: [], warnings: [], aborted: true });
    // The point of the capability cache: no per-file requests at all.
    expect(apiMocks.requestUploadUrl).not.toHaveBeenCalled();
    expect(dbMocks.getAudioFile).not.toHaveBeenCalled();
  });

  it("uploads the bytes and commits", async () => {
    dbMocks.getAudioFile.mockResolvedValue(localFile(HASH_A));
    apiMocks.requestUploadUrl.mockResolvedValue({
      key: "audio/aa/x.wav",
      uploadUrl: "https://bucket.test/put",
      alreadyStored: false,
      expiresInSeconds: 900,
    });
    apiMocks.commitUpload.mockResolvedValue({});
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    const result = await uploadProfileAudio([1]);

    expect(result.hosted).toEqual([HASH_A]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://bucket.test/put");
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ method: "PUT" });
    expect(apiMocks.commitUpload).toHaveBeenCalledWith(
      expect.objectContaining({ hash: HASH_A, name: "clap.wav" }),
    );
  });

  it("sends no bytes when the object is already in the bucket", async () => {
    dbMocks.getAudioFile.mockResolvedValue(localFile(HASH_A));
    apiMocks.requestUploadUrl.mockResolvedValue({
      key: "audio/aa/x.wav",
      uploadUrl: null,
      alreadyStored: true,
      expiresInSeconds: 900,
    });
    apiMocks.commitUpload.mockResolvedValue({});

    const result = await uploadProfileAudio([1]);

    expect(result.hosted).toEqual([HASH_A]);
    expect(fetch).not.toHaveBeenCalled();
    expect(apiMocks.commitUpload).toHaveBeenCalledOnce();
  });

  it("asks the server nothing about files it already knows are hosted", async () => {
    // The loop used to issue requestUploadUrl *and* commitUpload for every
    // file on every sync, ignoring the stored serverHosted flag entirely. On a
    // 500-sound profile that is a thousand sequential round trips, repeated on
    // load, every 15 minutes, on reconnect, on every SSE event and ten seconds
    // after every edit.
    dbMocks.getAudioFile.mockImplementation(async (id: number) => ({
      ...localFile(id === 1 ? HASH_A : HASH_B),
      id,
      serverHosted: true,
    }));

    const result = await uploadProfileAudio([1, 2]);

    expect(apiMocks.requestUploadUrl).not.toHaveBeenCalled();
    expect(apiMocks.commitUpload).not.toHaveBeenCalled();
    // Still reported: the caller uses this to tell readers where the bytes are.
    expect(result.hosted).toEqual([HASH_A, HASH_B]);
    expect(result.aborted).toBe(false);
  });

  it("marks newly hosted files in one write rather than one per hash", async () => {
    dbMocks.getAudioFile.mockImplementation(async (id: number) => ({
      ...localFile(id === 1 ? HASH_A : HASH_B),
      id,
    }));
    apiMocks.requestUploadUrl.mockResolvedValue({
      key: "k",
      uploadUrl: null,
      alreadyStored: true,
      expiresInSeconds: 900,
    });
    apiMocks.commitUpload.mockResolvedValue({});

    await uploadProfileAudio([1, 2]);

    expect(dbMocks.markAudioFilesHosted).toHaveBeenCalledTimes(1);
    expect(dbMocks.markAudioFilesHosted).toHaveBeenCalledWith([HASH_A, HASH_B]);
  });

  it("reports a per-file quota refusal but keeps going", async () => {
    // Keyed by id rather than by call order: the metadata pass and the upload
    // loop both ask, and a `mockResolvedValueOnce` chain would hand the second
    // asker the wrong file.
    const byId: Record<number, ReturnType<typeof localFile>> = {
      1: localFile(HASH_A, "big.wav"),
      2: localFile(HASH_B, "small.wav"),
    };
    dbMocks.getAudioFile.mockImplementation(async (id: number) => byId[id]);
    apiMocks.requestUploadUrl
      .mockRejectedValueOnce(
        new AudioQuotaError("over your allowance", "user_quota"),
      )
      .mockResolvedValueOnce({
        key: "k",
        uploadUrl: null,
        alreadyStored: true,
        expiresInSeconds: 900,
      });
    apiMocks.commitUpload.mockResolvedValue({});

    const result = await uploadProfileAudio([1, 2]);

    expect(result.aborted).toBe(false);
    expect(result.warnings).toEqual(["big.wav: over your allowance"]);
    expect(result.hosted).toEqual([HASH_B]);
  });

  it("gives up on the rest once the server-wide cap is hit", async () => {
    dbMocks.getAudioFile.mockResolvedValue(localFile(HASH_A));
    apiMocks.requestUploadUrl.mockRejectedValue(
      new AudioQuotaError("storage is full", "global_cap"),
    );

    const result = await uploadProfileAudio([1, 2, 3]);

    expect(result.aborted).toBe(true);
    expect(apiMocks.requestUploadUrl).toHaveBeenCalledOnce();
  });

  it("gives up when approval is withdrawn mid-run", async () => {
    dbMocks.getAudioFile.mockResolvedValue(localFile(HASH_A));
    apiMocks.requestUploadUrl.mockRejectedValue(new NotApprovedForAudioError());

    const result = await uploadProfileAudio([1, 2]);

    expect(result.aborted).toBe(true);
    expect(apiMocks.requestUploadUrl).toHaveBeenCalledOnce();
  });

  it("records a failed PUT as a warning rather than claiming success", async () => {
    dbMocks.getAudioFile.mockResolvedValue(localFile(HASH_A));
    apiMocks.requestUploadUrl.mockResolvedValue({
      key: "k",
      uploadUrl: "https://bucket.test/put",
      alreadyStored: false,
      expiresInSeconds: 900,
    });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }));

    const result = await uploadProfileAudio([1]);

    expect(result.hosted).toEqual([]);
    expect(result.warnings[0]).toContain("403");
    expect(apiMocks.commitUpload).not.toHaveBeenCalled();
  });
});

describe("downloadProfileAudio", () => {
  const refs = (
    overrides: Partial<ProfileSyncData["audioFiles"][number]>[],
  ): ProfileSyncData["audioFiles"] =>
    overrides.map((o, i) => ({
      id: i,
      name: `sound-${i}.wav`,
      type: "audio/wav",
      ...o,
    }));

  it("ignores files that are not server-hosted", async () => {
    const result = await downloadProfileAudio(
      "srv",
      refs([{ hash: HASH_A, driveFileId: "drive-1" }]),
    );

    expect(result.downloaded).toBe(0);
    expect(apiMocks.requestProfileDownloadUrl).not.toHaveBeenCalled();
  });

  it("skips a file this browser already has", async () => {
    dbMocks.getAudioFileByHash.mockResolvedValue({ id: 7 });

    const result = await downloadProfileAudio(
      "srv",
      refs([{ hash: HASH_A, serverHosted: true }]),
    );

    expect(result.downloaded).toBe(0);
    expect(apiMocks.requestProfileDownloadUrl).not.toHaveBeenCalled();
  });

  it("fetches and stores audio it does not have", async () => {
    apiMocks.requestProfileDownloadUrl.mockResolvedValue({
      url: "https://bucket.test/get",
      sizeBytes: 4,
      contentType: "audio/wav",
      expiresInSeconds: 3600,
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Blob([new Uint8Array(4)]), { status: 200 }),
    );

    const result = await downloadProfileAudio(
      "srv",
      refs([{ hash: HASH_A, serverHosted: true }]),
    );

    expect(result.downloaded).toBe(1);
    expect(dbMocks.addAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({ hash: HASH_A, name: "sound-0.wav" }),
    );
  });

  it("passes a share token through, so an anonymous viewer can fetch", async () => {
    apiMocks.requestProfileDownloadUrl.mockResolvedValue({
      url: "https://bucket.test/get",
      sizeBytes: 4,
      contentType: "audio/wav",
      expiresInSeconds: 3600,
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Blob([new Uint8Array(4)]), { status: 200 }),
    );

    await downloadProfileAudio(
      "srv",
      refs([{ hash: HASH_A, serverHosted: true }]),
      "share-token",
    );

    expect(apiMocks.requestProfileDownloadUrl).toHaveBeenCalledWith(
      "srv",
      HASH_A,
      "share-token",
    );
  });

  it("marks an expired URL retryable rather than losing the file", async () => {
    apiMocks.requestProfileDownloadUrl.mockResolvedValue({
      url: "https://bucket.test/get",
      sizeBytes: 4,
      contentType: "audio/wav",
      expiresInSeconds: 3600,
    });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }));

    const result = await downloadProfileAudio(
      "srv",
      refs([{ hash: HASH_A, serverHosted: true }]),
    );

    expect(result.retryable).toHaveLength(1);
    expect(result.downloaded).toBe(0);
    expect(dbMocks.addAudioFile).not.toHaveBeenCalled();
  });

  it("remembers locally that the bytes are hosted", async () => {
    // The flag used to be worked out afresh each sync from whatever that run
    // uploaded, so any abort published a blob claiming nothing was hosted, and
    // readers had no route to the bytes.
    apiMocks.requestProfileDownloadUrl.mockResolvedValue({
      url: "https://bucket.test/get",
      sizeBytes: 4,
      contentType: "audio/wav",
      expiresInSeconds: 3600,
    });
    vi.mocked(fetch).mockResolvedValue(new Response(new Blob(["abcd"])));

    await downloadProfileAudio(
      "srv",
      refs([{ hash: HASH_A, serverHosted: true }]),
    );

    expect(dbMocks.addAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({ serverHosted: true }),
    );
  });

  it("retries a session that expired mid-sync instead of losing the pads", async () => {
    // Only `TypeError` counted as retryable, so a 401 read as a refusal: the
    // sync carried on, the audio never arrived, and `updateLocalData` cleared
    // every pad that referenced it and published them empty.
    apiMocks.requestProfileDownloadUrl.mockRejectedValue(
      new NotSignedInError(),
    );

    const result = await downloadProfileAudio(
      "srv",
      refs([{ hash: HASH_A, serverHosted: true }]),
    );

    expect(result.retryable).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("gives up on an object the bucket no longer has", async () => {
    // The one failure that must not be retried: retrying forever would stop
    // the profile syncing at all, which costs more than the one sound.
    const gone = Object.assign(new Error("Not found"), { status: 404 });
    apiMocks.requestProfileDownloadUrl.mockRejectedValue(gone);

    const result = await downloadProfileAudio(
      "srv",
      refs([{ hash: HASH_A, serverHosted: true }]),
    );

    expect(result.retryable).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("markHostedAudio", () => {
  const data = {
    _syncFormatVersion: 1,
    audioFiles: [
      { id: 1, name: "a.wav", type: "audio/wav", hash: HASH_A },
      { id: 2, name: "b.wav", type: "audio/wav", hash: HASH_B },
    ],
  } as unknown as ProfileSyncData;

  it("marks only the hashes that are hosted", () => {
    const marked = markHostedAudio(data, new Set([HASH_A]));

    expect(marked.audioFiles[0].serverHosted).toBe(true);
    expect(marked.audioFiles[1].serverHosted).toBeUndefined();
  });

  it("returns the blob untouched when nothing is hosted", () => {
    expect(markHostedAudio(data, new Set())).toBe(data);
  });
});
