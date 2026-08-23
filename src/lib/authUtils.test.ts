/**
 * The Drive token guard: is this access token still usable, and if not, can it
 * be renewed without sending the user back through the consent screen?
 *
 * Everything here fails *closed*: any answer other than a token that is
 * demonstrably still good asks for reauthentication. That is the property
 * worth pinning, because each of the ways it can go wrong — no client id
 * configured, Google answering 400, the network dropping — reaches the same
 * branch by a different route, and a mistake in any one of them would hand a
 * caller `isValid: true` with no token behind it.
 *
 * The five-minute skew is the other half. A token checked at the instant it
 * expires is already useless by the time the request carrying it lands, so the
 * boundary is deliberately early, and "expires in four minutes" has to read as
 * expired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithTimeout = vi.fn();
vi.mock("@/lib/fetchWithTimeout", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));

const { isTokenExpiredOrExpiring, validateAuthState } =
  await import("./authUtils");

const MINUTE = 60_000;
const NOW = 1_700_000_000_000;

/** A `Response` stand-in: only `ok` and `json()` are read. */
function jsonResponse(ok: boolean, body: unknown) {
  return { ok, json: async () => body };
}

let clientId: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "client-id.apps.example.com";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  if (clientId === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  else process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = clientId;
  fetchWithTimeout.mockReset();
  vi.restoreAllMocks();
});

describe("isTokenExpiredOrExpiring", () => {
  it("treats an unknown expiry as expired", () => {
    expect(isTokenExpiredOrExpiring(null)).toBe(true);
  });

  it("treats the epoch as expired, not as 'no expiry'", () => {
    // 0 is falsy, so this takes the same branch as null — which is the right
    // answer for a different reason, and worth pinning either way.
    expect(isTokenExpiredOrExpiring(0)).toBe(true);
  });

  it("accepts a token with more than five minutes left", () => {
    expect(isTokenExpiredOrExpiring(NOW + 5 * MINUTE + 1)).toBe(false);
  });

  it("rejects a token inside the five-minute refresh window", () => {
    expect(isTokenExpiredOrExpiring(NOW + 4 * MINUTE)).toBe(true);
  });

  it("rejects a token exactly five minutes out", () => {
    expect(isTokenExpiredOrExpiring(NOW + 5 * MINUTE)).toBe(true);
  });

  it("rejects a token that has already expired", () => {
    expect(isTokenExpiredOrExpiring(NOW - MINUTE)).toBe(true);
  });
});

describe("validateAuthState", () => {
  it("asks for a full sign-in when there is no access token", async () => {
    expect(await validateAuthState(null, NOW + MINUTE * 60, "refresh")).toEqual(
      {
        isValid: false,
        needsReauth: true,
      },
    );
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("leaves a still-valid token alone", async () => {
    expect(
      await validateAuthState("access", NOW + MINUTE * 60, "refresh"),
    ).toEqual({ isValid: true, needsReauth: false });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("asks for a full sign-in when there is nothing to refresh with", async () => {
    expect(await validateAuthState("access", NOW - MINUTE, null)).toEqual({
      isValid: false,
      needsReauth: true,
    });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token and reports the new expiry", async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(true, { access_token: "fresh", expires_in: 3599 }),
    );

    expect(await validateAuthState("stale", NOW + MINUTE, "refresh")).toEqual({
      isValid: true,
      needsReauth: false,
      newAccessToken: "fresh",
      newExpiresAt: NOW + 3_599_000,
    });
  });

  it("posts the refresh grant as form-encoded body to Google", async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(true, { access_token: "fresh", expires_in: 60 }),
    );

    await validateAuthState("stale", NOW, "the-refresh-token");

    const [url, init] = fetchWithTimeout.mock.calls[0] as [
      string,
      RequestInit & { body: URLSearchParams },
    ];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(init.body)).toEqual({
      client_id: "client-id.apps.example.com",
      refresh_token: "the-refresh-token",
      grant_type: "refresh_token",
    });
  });

  it("asks for a full sign-in when Google rejects the refresh token", async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(false, { error: "invalid_grant" }),
    );

    expect(await validateAuthState("stale", NOW, "revoked")).toEqual({
      isValid: false,
      needsReauth: true,
    });
  });

  it("asks for a full sign-in when the refresh request never lands", async () => {
    fetchWithTimeout.mockRejectedValue(new Error("network down"));

    expect(await validateAuthState("stale", NOW, "refresh")).toEqual({
      isValid: false,
      needsReauth: true,
    });
  });

  it("does not call Google at all when no client id is configured", async () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

    expect(await validateAuthState("stale", NOW, "refresh")).toEqual({
      isValid: false,
      needsReauth: true,
    });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});
