/**
 * Which Drive calls get the long timeout tier.
 *
 * `fetchWithTimeout` has two tiers, and before this test the long one sat on
 * `uploadDriveFile` — the *profile JSON* — under a comment claiming it was
 * "the whole audio blob". The calls that really do move audio were left on the
 * ten-second control tier, so a sound bigger than ten seconds of uplink could
 * not be uploaded to, or fetched from, Drive at all.
 *
 * Asserting the tier per call site rather than the timeout value: the point is
 * that a reader deciding "is this a transfer?" reaches the same answer the
 * code does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Every `fetchWithTimeout` call made during a test, in order. */
const calls: Array<{ url: string; timeoutKind?: string }> = [];

vi.mock("@/lib/fetchWithTimeout", () => ({
  fetchWithTimeout: vi.fn(
    async (url: string, init?: { timeoutKind?: string }) => {
      calls.push({ url: String(url), timeoutKind: init?.timeoutKind });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "drive-1", name: "x" }),
        blob: async () => new Blob(["bytes"]),
      } as unknown as Response;
    },
  ),
}));

const token = {
  accessToken: "token",
  expiresAt: Date.now() + 3_600_000,
} as never;
const noop = () => {};

beforeEach(() => {
  calls.length = 0;
  vi.resetModules();
});

describe("Drive calls that move audio", () => {
  it("uploads a sound on the transfer tier", async () => {
    const { uploadAudioFile } = await import("./api");

    await uploadAudioFile(
      "kick.wav",
      new Blob(["bytes"]),
      "audio/wav",
      "existing-drive-id", // avoids the folder lookup
      1,
      token,
      noop,
    );

    const upload = calls.find((c) => c.url.includes("/upload/drive/v3/files"));
    expect(upload).toBeDefined();
    expect(upload?.timeoutKind).toBe("transfer");
  });

  it("downloads a sound on the transfer tier", async () => {
    const { downloadAudioFileAsBlob } = await import("./api");

    await downloadAudioFileAsBlob("file-1", token, noop);

    const download = calls.find((c) => c.url.includes("alt=media"));
    expect(download).toBeDefined();
    expect(download?.timeoutKind).toBe("transfer");
  });

  it("downloads a sound through the public proxy on the transfer tier", async () => {
    // The signed-out path: same bytes, same reason.
    const { downloadAudioFileAsBlob } = await import("./api");

    await downloadAudioFileAsBlob("file-1", null, noop);

    const proxied = calls.find((c) =>
      c.url.includes("/api/drive/public-audio"),
    );
    expect(proxied).toBeDefined();
    expect(proxied?.timeoutKind).toBe("transfer");
  });

  it("fetches a public profile blob on the transfer tier", async () => {
    // Carries base64 audio on the paths with no separate Drive file.
    const { downloadPublicProfileData } = await import("./api");

    await downloadPublicProfileData("file-1");

    const proxied = calls.find((c) => c.url.includes("/api/drive/public-file"));
    expect(proxied).toBeDefined();
    expect(proxied?.timeoutKind).toBe("transfer");
  });
});
