/**
 * The hosted-audio HTTP client, which is almost entirely `throwForStatus`.
 *
 * Six statuses fan out into five distinct error types, and the distinction is
 * not cosmetic — each one leads somewhere different in the UI. 501 means this
 * deployment hosts no audio at all, which is a configuration fact rather than
 * a failure and must not be offered as something to retry. 403 means the
 * account exists but has not been approved, which is a request to make of an
 * admin. 413 and 507 are quota, and the `reason` discriminates "this file is
 * too big" from "your library is full" from "the whole deployment is full",
 * three sentences with three different next actions.
 *
 * Everything else keeps its numeric status on the error, and the source
 * explains why at length: a caller has to tell "this object is gone" from "the
 * server is having a moment", because retrying a permanent failure blocks the
 * profile from syncing again and warning on a transient one lets the pull
 * apply without the audio, stripping the pads.
 *
 * The last hazard is that these are all thin wrappers, and `throwForStatus`
 * is `await`ed but not `return`ed. If a wrapper ever stops awaiting it, the
 * rejection turns into an unhandled one and the wrapper falls through to
 * `response.json()` on an error body — so every entry point is asserted to
 * reject, not just the helper.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotSignedInError } from "@/lib/serverSync/types";
import {
  fetchHarness,
  respondWith as respond,
} from "@/lib/testSupport/httpClientHarness";

const { fetchWithTimeout, onlyCall } = fetchHarness();
vi.mock("@/lib/fetchWithTimeout", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));

const api = await import("./api");

/**
 * One entry point per row, so a status can be asserted against every wrapper
 * rather than only against the helper they share.
 */
const ENTRY_POINTS: Array<[string, () => Promise<unknown>]> = [
  ["fetchAudioLibrary", () => api.fetchAudioLibrary()],
  [
    "requestUploadUrl",
    () =>
      api.requestUploadUrl({
        hash: "abc",
        sizeBytes: 10,
        contentType: "audio/wav",
        extension: "wav",
      }),
  ],
  [
    "commitUpload",
    () =>
      api.commitUpload({
        hash: "abc",
        name: "cue.wav",
        contentType: "audio/wav",
        extension: "wav",
      }),
  ],
  [
    "requestProfileDownloadUrl",
    () => api.requestProfileDownloadUrl("srv-1", "abc"),
  ],
  ["deleteHostedAudio", () => api.deleteHostedAudio("abc")],
];

beforeEach(() => {
  fetchWithTimeout.mockReset();
});

describe("the status-to-error mapping", () => {
  it.each(ENTRY_POINTS)(
    "%s raises NotSignedInError on 401",
    async (_n, call) => {
      fetchWithTimeout.mockResolvedValue(respond(401));

      await expect(call()).rejects.toBeInstanceOf(NotSignedInError);
    },
  );

  it.each(ENTRY_POINTS)(
    "%s reports 501 as hosting being off, not as a failure",
    async (_n, call) => {
      fetchWithTimeout.mockResolvedValue(respond(501));

      await expect(call()).rejects.toBeInstanceOf(
        api.AudioHostingUnavailableError,
      );
    },
  );

  it.each(ENTRY_POINTS)(
    "%s reports 403 as needing approval",
    async (_n, call) => {
      fetchWithTimeout.mockResolvedValue(respond(403, {}));

      await expect(call()).rejects.toBeInstanceOf(api.NotApprovedForAudioError);
    },
  );

  it("does not read the body for 401 or 501", async () => {
    // Those two are decided by the status alone, so a server that answers
    // them with an HTML page must not turn into a JSON parse failure.
    fetchWithTimeout.mockResolvedValue(
      respond(501, null, { jsonThrows: true }),
    );

    await expect(api.fetchAudioLibrary()).rejects.toBeInstanceOf(
      api.AudioHostingUnavailableError,
    );
  });

  it("carries the server's wording onto an approval refusal", async () => {
    fetchWithTimeout.mockResolvedValue(
      respond(403, { error: "ask an administrator for audio access" }),
    );

    await expect(api.fetchAudioLibrary()).rejects.toThrow(
      "ask an administrator for audio access",
    );
  });

  it("uses its own wording when a 403 body says nothing", async () => {
    fetchWithTimeout.mockResolvedValue(respond(403, {}));

    await expect(api.fetchAudioLibrary()).rejects.toThrow(
      "This account is not approved to upload audio",
    );
  });

  it.each([413, 507])(
    "reports %i as a quota error carrying the numbers",
    async (status) => {
      fetchWithTimeout.mockResolvedValue(
        respond(status, {
          error: "your library is full",
          reason: "user_quota",
          usedBytes: 900,
          limitBytes: 1000,
        }),
      );

      const error = await api.fetchAudioLibrary().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(api.AudioQuotaError);
      expect(error).toMatchObject({
        message: "your library is full",
        reason: "user_quota",
        usedBytes: 900,
        limitBytes: 1000,
      });
    },
  );

  it.each(["too_large", "global_cap"] as const)(
    "keeps the %s reason so the UI can say which limit was hit",
    async (reason) => {
      fetchWithTimeout.mockResolvedValue(respond(413, { reason }));

      const error = await api.fetchAudioLibrary().catch((e: unknown) => e);

      expect(error).toMatchObject({ reason });
    },
  );

  it("assumes a personal quota when the server names no reason", async () => {
    fetchWithTimeout.mockResolvedValue(respond(507, {}));

    const error = await api.fetchAudioLibrary().catch((e: unknown) => e);

    expect(error).toMatchObject({
      reason: "user_quota",
      message: "Could not read audio usage",
      usedBytes: undefined,
      limitBytes: undefined,
    });
  });

  it.each([404, 500, 502])(
    "puts status %i on an otherwise ordinary error",
    async (status) => {
      // The caller distinguishes gone from transient by this number; without
      // it, a permanent failure gets retried forever or a transient one
      // silently strips a pad's audio.
      fetchWithTimeout.mockResolvedValue(respond(status, {}));

      const error = await api
        .requestProfileDownloadUrl("srv-1", "abc")
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(api.AudioQuotaError);
      expect((error as { status?: number }).status).toBe(status);
    },
  );

  it("falls back per call site when the error body is unreadable", async () => {
    fetchWithTimeout.mockResolvedValue(
      respond(500, null, { jsonThrows: true }),
    );

    await expect(
      api.commitUpload({
        hash: "abc",
        name: "cue.wav",
        contentType: "audio/wav",
        extension: "wav",
      }),
    ).rejects.toThrow("Could not finish the upload");
  });
});

describe("fetchAudioLibrary", () => {
  it("returns the usage and file list", async () => {
    const payload = {
      canUploadAudio: true,
      usage: { usedBytes: 1, quotaBytes: 2, fileCount: 1 },
      files: [],
    };
    fetchWithTimeout.mockResolvedValue(respond(200, payload));

    expect(await api.fetchAudioLibrary()).toEqual(payload);
    expect(onlyCall().url).toBe("/api/audio");
  });
});

describe("requestUploadUrl", () => {
  it("posts the file's identity and returns the ticket", async () => {
    const ticket = {
      key: "aud/abc.wav",
      uploadUrl: "https://bucket.example/put",
      alreadyStored: false,
      proofRange: null,
      expiresInSeconds: 900,
    };
    fetchWithTimeout.mockResolvedValue(respond(200, ticket));

    expect(
      await api.requestUploadUrl({
        hash: "abc",
        sizeBytes: 42,
        contentType: "audio/wav",
        extension: "wav",
      }),
    ).toEqual(ticket);

    const { url, init } = onlyCall();
    expect(url).toBe("/api/audio/upload-url");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      hash: "abc",
      sizeBytes: 42,
      contentType: "audio/wav",
      extension: "wav",
    });
  });

  it("passes through a ticket for bytes someone else already stored", async () => {
    // `proofRange` is present exactly when there is nothing to upload; commit
    // refuses to hand out a reference on that path without it.
    fetchWithTimeout.mockResolvedValue(
      respond(200, {
        key: "aud/abc.wav",
        uploadUrl: null,
        alreadyStored: true,
        proofRange: { offset: 128, length: 64 },
        expiresInSeconds: 900,
      }),
    );

    const ticket = await api.requestUploadUrl({
      hash: "abc",
      sizeBytes: 42,
      contentType: "audio/wav",
      extension: "wav",
    });

    expect(ticket.uploadUrl).toBeNull();
    expect(ticket.proofRange).toEqual({ offset: 128, length: 64 });
  });
});

describe("commitUpload", () => {
  it("sends the proof when it has one and returns the new usage", async () => {
    fetchWithTimeout.mockResolvedValue(
      respond(200, {
        hash: "abc",
        sizeBytes: 42,
        usage: { usedBytes: 42, quotaBytes: 100, fileCount: 1 },
      }),
    );

    const result = await api.commitUpload({
      hash: "abc",
      name: "cue.wav",
      contentType: "audio/wav",
      extension: "wav",
      proof: "deadbeef",
    });

    expect(result.sizeBytes).toBe(42);
    const { url, init } = onlyCall();
    expect(url).toBe("/api/audio/commit");
    expect(JSON.parse(String(init.body)).proof).toBe("deadbeef");
  });
});

describe("requestProfileDownloadUrl", () => {
  it("addresses the profile's copy of the hash and returns the ticket", async () => {
    fetchWithTimeout.mockResolvedValue(
      respond(200, {
        url: "https://bucket.example/get",
        sizeBytes: 42,
        contentType: "audio/wav",
        expiresInSeconds: 300,
      }),
    );

    const ticket = await api.requestProfileDownloadUrl("srv-1", "abc");

    expect(ticket.url).toBe("https://bucket.example/get");
    expect(onlyCall().url).toBe("/api/profiles/srv-1/audio/abc");
  });

  it("sends a link-share token in a header and not in the URL", async () => {
    fetchWithTimeout.mockResolvedValue(respond(200, {}));

    await api.requestProfileDownloadUrl("srv-1", "abc", "tok-xyz");

    const { url, headers } = onlyCall();
    expect(headers.get("x-impamp-share-token")).toBe("tok-xyz");
    expect(url).not.toContain("tok-xyz");
  });

  it("sends no token header for a profile opened normally", async () => {
    fetchWithTimeout.mockResolvedValue(respond(200, {}));

    await api.requestProfileDownloadUrl("srv-1", "abc", null);

    expect(onlyCall().headers.has("x-impamp-share-token")).toBe(false);
  });
});

describe("deleteHostedAudio", () => {
  it("gives up this user's reference by hash", async () => {
    fetchWithTimeout.mockResolvedValue(respond(204));

    await expect(api.deleteHostedAudio("abc")).resolves.toBeUndefined();

    const { url, init } = onlyCall();
    expect(url).toBe("/api/audio/abc");
    expect(init.method).toBe("DELETE");
  });
});
