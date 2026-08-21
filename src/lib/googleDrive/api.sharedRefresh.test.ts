/**
 * One refresh per expiry, however many Drive calls notice it.
 *
 * A sync reads the Google token once and threads that one `TokenInfo` through
 * every call it makes — metadata lookups, the profile JSON, then one upload or
 * download per sound. When the token expires mid-sync, each of those calls
 * gets its own 401, and each of the four 401 handlers in `api.ts` called
 * `checkAndRefreshAuth` directly. So a sync with twenty sounds could fire
 * twenty `POST /api/auth/google/refresh` requests, and — because the local
 * `tokenInfo` variable is never rewritten — the calls that came *after* a
 * successful refresh still presented the dead token and refreshed all over
 * again.
 *
 * `useGoogleDriveSync` already solved this for its own five-minute poll with a
 * module-level in-flight promise. That covered exactly one of the five places
 * that refresh. The dedupe now lives in `auth.ts`, where both reach it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TokenInfo } from "./types";

/** Every refresh request the run made. */
let refreshCalls = 0;
/** The access tokens Drive was asked to accept, in order. */
let presented: string[] = [];
/** Which access token the fake Drive currently honours. */
let liveToken = "fresh-1";
let issued = 0;

vi.mock("@/lib/fetchWithTimeout", () => ({
  fetchWithTimeout: vi.fn(
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (String(url).includes("/api/auth/google/refresh")) {
        refreshCalls += 1;
        issued += 1;
        liveToken = `fresh-${issued}`;
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: liveToken, expires_in: 3600 }),
        } as unknown as Response;
      }

      const auth = (init?.headers as Record<string, string>)?.Authorization;
      const bearer = auth?.replace("Bearer ", "") ?? "";
      presented.push(bearer);

      if (bearer !== liveToken) {
        return {
          ok: false,
          status: 401,
          text: async () => "",
          json: async () => ({}),
        } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ files: [], id: "x" }),
        json: async () => ({ files: [], id: "x" }),
      } as unknown as Response;
    },
  ),
}));

import { listAppFiles, findDriveFileById } from "./api";
import { resetSharedTokenRefresh } from "./auth";

/** The token a sync captured before it expired. */
const stale: TokenInfo = {
  accessToken: "stale",
  refreshToken: "refresh-token",
  expiresAt: Date.now() - 60_000,
};

beforeEach(() => {
  refreshCalls = 0;
  presented = [];
  issued = 0;
  liveToken = "fresh-1";
  resetSharedTokenRefresh();
});

describe("a token that expires part-way through a sync", () => {
  it("is refreshed once for calls that raced each other", async () => {
    const noop = () => {};

    await Promise.all([
      listAppFiles(stale, noop),
      listAppFiles(stale, noop),
      findDriveFileById("file-1", stale, noop),
    ]);

    expect(refreshCalls).toBe(1);
  });

  it("is refreshed once for a later call still holding the dead token", async () => {
    const noop = () => {};

    await listAppFiles(stale, noop);
    // The sync's own `tokenInfo` was captured before the refresh and nothing
    // rewrites it, so this is the token the next call really presents.
    await findDriveFileById("file-1", stale, noop);

    expect(refreshCalls).toBe(1);
    // And the retry used the token the first call obtained, rather than
    // failing or asking Google for another one.
    expect(presented.filter((t) => t === "fresh-1").length).toBe(2);
  });

  it("still reports the new token to its caller, so the store keeps up", async () => {
    const seen: TokenInfo[] = [];

    await listAppFiles(stale, (t) => seen.push(t));
    await findDriveFileById("file-1", stale, (t) => seen.push(t));

    expect(seen.map((t) => t.accessToken)).toEqual(["fresh-1", "fresh-1"]);
  });
});
