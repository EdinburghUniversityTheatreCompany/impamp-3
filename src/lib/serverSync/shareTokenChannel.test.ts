/**
 * Where a share-link token is allowed to travel.
 *
 * It is a bearer credential: whoever holds it has the sharer's chosen role on
 * that profile. Both HTTP clients therefore send it in a header, and both say
 * in their module comments that this keeps it out of query strings and so out
 * of access logs.
 *
 * The change stream did not, and could not: `EventSource` sends the URL and
 * the cookies and nothing else — there is no API for a request header on it.
 * So one endpoint contradicted what the other two documented, and nothing
 * recorded that it was deliberate rather than an oversight.
 *
 * These tests hold both halves of the resolved rule at once: every call that
 * *can* use the header does, with no token in its URL, and the stream is the
 * single named exception. A new client that reaches for `?token=` because "the
 * SSE one does it" fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SHARE_TOKEN = "share-token-abcdef";
const SHARE_TOKEN_HEADER = "x-impamp-share-token";

const requests: Array<{ url: string; headers: Headers }> = [];

vi.mock("@/lib/fetchWithTimeout", () => ({
  fetchWithTimeout: vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "srv-1", version: 1, data: {}, url: "" }),
    } as unknown as Response;
  }),
}));

const { fetchServerProfile, pushServerProfile } = await import("./api");
const { requestProfileDownloadUrl } = await import("@/lib/serverAudio/api");
const { subscribeToProfileChanges } = await import("@/hooks/useServerSync");

/** Records the URL an EventSource was opened with. */
class RecordingEventSource {
  static lastUrl: string | null = null;
  constructor(url: string) {
    RecordingEventSource.lastUrl = url;
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const only = () => {
  expect(requests).toHaveLength(1);
  return requests[0];
};

beforeEach(() => {
  requests.length = 0;
  RecordingEventSource.lastUrl = null;
  vi.stubGlobal("EventSource", RecordingEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a call that can send a header", () => {
  it("does, when pulling a profile", async () => {
    await fetchServerProfile("srv-1", { shareToken: SHARE_TOKEN });

    const { url, headers } = only();
    expect(headers.get(SHARE_TOKEN_HEADER)).toBe(SHARE_TOKEN);
    expect(url).not.toContain(SHARE_TOKEN);
  });

  it("does, when pushing a profile", async () => {
    await pushServerProfile(
      "srv-1",
      "Panto",
      {} as never,
      1,
      SHARE_TOKEN,
    ).catch(() => {});

    const { url, headers } = only();
    expect(headers.get(SHARE_TOKEN_HEADER)).toBe(SHARE_TOKEN);
    expect(url).not.toContain(SHARE_TOKEN);
  });

  it("does, when asking for hosted audio", async () => {
    await requestProfileDownloadUrl("srv-1", "a".repeat(64), SHARE_TOKEN);

    const { url, headers } = only();
    expect(headers.get(SHARE_TOKEN_HEADER)).toBe(SHARE_TOKEN);
    expect(url).not.toContain(SHARE_TOKEN);
  });
});

describe("the change stream", () => {
  it("carries the token in the URL, because EventSource takes no headers", () => {
    // Pinned, not merely tolerated. This is the one place the rule above does
    // not hold, and it holds nowhere else — see the comment on the subscription
    // for what it costs and why there is no alternative.
    subscribeToProfileChanges("srv-1", SHARE_TOKEN, () => {})();

    expect(RecordingEventSource.lastUrl).toBe(
      `/api/profiles/srv-1/events?token=${SHARE_TOKEN}`,
    );
    // And it makes no HTTP call of its own that could have carried a header
    // instead.
    expect(requests).toHaveLength(0);
  });

  it("sends no token at all when there is none to send", () => {
    subscribeToProfileChanges("srv-1", null, () => {})();

    expect(RecordingEventSource.lastUrl).toBe("/api/profiles/srv-1/events");
  });
});
