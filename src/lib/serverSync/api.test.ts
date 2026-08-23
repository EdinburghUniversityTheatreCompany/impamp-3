/**
 * The server-sync HTTP client: what it puts on the wire, and how it turns a
 * status code into something a caller can branch on.
 *
 * Almost every call here fans a response out into three or four outcomes, and
 * the interesting ones are not the happy path. `304` is a *success* that must
 * come back as `null` rather than as an empty profile — a caller treating it
 * as data would blank the board. `409` has to arrive as a
 * `VersionConflictError` still carrying the server's own version, name and
 * data, because the conflict resolver merges from it rather than making a
 * second round trip. And `401` is a `NotSignedInError` on some calls and a
 * plain failure on others, which is a deliberate difference: the sign-in
 * prompt is only worth raising where signing in would actually help.
 *
 * The conditional `If-None-Match` is the subtlest thing in the module and has
 * a comment in the source explaining it. Access is part of the tag because it
 * changes without the version moving, so a device promoted from viewer to
 * editor would otherwise get 304 forever and never learn it may write. The
 * assertion here is the pair: both parts present, or no header at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotSignedInError, VersionConflictError } from "./types";
import type { ProfileSyncData } from "./types";
import {
  fetchHarness,
  respondWith as respond,
} from "@/lib/testSupport/httpClientHarness";

const { fetchWithTimeout, onlyCall } = fetchHarness();
vi.mock("@/lib/fetchWithTimeout", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));

const api = await import("./api");

const answer = (...responses: Response[]) => {
  for (const response of responses)
    fetchWithTimeout.mockResolvedValueOnce(response);
};

const syncData = { pads: [], banks: [] } as unknown as ProfileSyncData;

beforeEach(() => {
  fetchWithTimeout.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ORIGIN_ID", () => {
  it("is a stable identifier for this tab", () => {
    expect(api.ORIGIN_ID).toEqual(expect.any(String));
    expect(api.ORIGIN_ID.length).toBeGreaterThan(8);
    expect(api.ORIGIN_ID).toBe(api.ORIGIN_ID);
  });
});

describe("fetchCurrentUser", () => {
  it("returns the user from a live session", async () => {
    answer(respond(200, { user: { id: 7, email: "a@example.com" } }));

    expect(await api.fetchCurrentUser()).toEqual({
      id: 7,
      email: "a@example.com",
    });
    expect(onlyCall().url).toBe("/api/auth/session");
  });

  it("reads 401 as 'nobody is signed in', not as an error", async () => {
    // This is the one call that must not raise on 401: it is what the app asks
    // on startup precisely to find out whether there is a session.
    answer(respond(401));

    expect(await api.fetchCurrentUser()).toBeNull();
  });

  it("surfaces the server's own message on any other failure", async () => {
    answer(respond(500, { error: "the database is on fire" }));

    await expect(api.fetchCurrentUser()).rejects.toThrow(
      "the database is on fire",
    );
  });

  it("falls back to its own wording when the body is not JSON", async () => {
    // A proxy's HTML 502 page tells us nothing the status did not.
    answer(respond(502, null, { jsonThrows: true }));

    await expect(api.fetchCurrentUser()).rejects.toThrow(
      "Could not read session",
    );
  });

  it("falls back when the body is JSON without an error string", async () => {
    answer(respond(500, { error: { code: 12 } }));

    await expect(api.fetchCurrentUser()).rejects.toThrow(
      "Could not read session",
    );
  });
});

describe("signOutOfServer", () => {
  it("deletes the session and ignores whatever comes back", async () => {
    answer(respond(500, { error: "already gone" }));

    await expect(api.signOutOfServer()).resolves.toBeUndefined();
    expect(onlyCall().init.method).toBe("DELETE");
  });
});

describe("listServerProfiles", () => {
  it("returns the profile summaries", async () => {
    answer(respond(200, { profiles: [{ id: "p1" }] }));

    expect(await api.listServerProfiles()).toEqual([{ id: "p1" }]);
  });

  it("raises NotSignedInError on 401, so the UI can offer a sign-in", async () => {
    answer(respond(401));

    await expect(api.listServerProfiles()).rejects.toBeInstanceOf(
      NotSignedInError,
    );
  });

  it("raises an ordinary error on any other failure", async () => {
    answer(respond(503, {}));

    await expect(api.listServerProfiles()).rejects.toThrow(
      "Could not list profiles",
    );
  });
});

describe("fetchServerProfile", () => {
  it("sends no If-None-Match when nothing is known", async () => {
    answer(respond(200, { id: "p1", version: 1 }));

    await api.fetchServerProfile("p1");

    expect(onlyCall().headers.has("If-None-Match")).toBe(false);
  });

  it.each([
    ["only a version", { knownVersion: 4 }],
    ["only an access", { knownAccess: "editor" }],
    ["a version of zero", { knownVersion: 0, knownAccess: "editor" }],
  ])("sends no If-None-Match given %s", async (_label, options) => {
    answer(respond(200, {}));

    await api.fetchServerProfile("p1", options);

    expect(onlyCall().headers.has("If-None-Match")).toBe(false);
  });

  it("tags the request with the version and the access together", async () => {
    // Access is in the tag because it moves without the version moving; a
    // version-only tag leaves a promoted viewer on 304 forever.
    answer(respond(304));

    await api.fetchServerProfile("p1", {
      knownVersion: 4,
      knownAccess: "editor",
    });

    expect(onlyCall().headers.get("If-None-Match")).toBe('"4.editor"');
  });

  it("returns null for 304 rather than an empty profile", async () => {
    answer(respond(304));

    expect(
      await api.fetchServerProfile("p1", {
        knownVersion: 4,
        knownAccess: "viewer",
      }),
    ).toBeNull();
  });

  it("explains a 404 in terms the user can act on", async () => {
    answer(respond(404));

    await expect(api.fetchServerProfile("p1")).rejects.toThrow(
      /no longer available on the server/,
    );
  });

  it("carries the share token in a header, never the URL", async () => {
    answer(respond(200, {}));

    await api.fetchServerProfile("p1", { shareToken: "tok-123" });

    const { url, headers } = onlyCall();
    expect(headers.get("x-impamp-share-token")).toBe("tok-123");
    expect(url).not.toContain("tok-123");
  });

  it("surfaces the server's message on any other failure", async () => {
    answer(respond(500, { error: "profile store unavailable" }));

    await expect(api.fetchServerProfile("p1")).rejects.toThrow(
      "profile store unavailable",
    );
  });
});

describe("createServerProfile", () => {
  it("posts the name and data and returns the new id and version", async () => {
    answer(respond(201, { id: "srv-9", version: 1 }));

    expect(await api.createServerProfile("Show", syncData)).toEqual({
      id: "srv-9",
      version: 1,
    });

    const { url, init } = onlyCall();
    expect(url).toBe("/api/profiles");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Show",
      data: syncData,
    });
  });

  it("raises NotSignedInError on 401", async () => {
    answer(respond(401));

    await expect(
      api.createServerProfile("Show", syncData),
    ).rejects.toBeInstanceOf(NotSignedInError);
  });

  it("raises an ordinary error on any other failure", async () => {
    answer(respond(400, { error: "name is required" }));

    await expect(api.createServerProfile("", syncData)).rejects.toThrow(
      "name is required",
    );
  });
});

describe("pushServerProfile", () => {
  it("guards the write with If-Match and names the origin tab", async () => {
    // The origin header is what lets this tab ignore the echo of its own
    // write when it comes back down the change stream.
    answer(respond(200, { version: 5 }));

    expect(
      await api.pushServerProfile("p1", "Show", syncData, 4, "tok"),
    ).toEqual({ version: 5 });

    const { init, headers } = onlyCall();
    expect(init.method).toBe("PUT");
    expect(headers.get("If-Match")).toBe('"4"');
    expect(headers.get("x-impamp-origin")).toBe(api.ORIGIN_ID);
    expect(headers.get("x-impamp-share-token")).toBe("tok");
  });

  it("turns 409 into a conflict carrying the server's current state", async () => {
    // Without the body the resolver would need a second round trip, and the
    // profile could move again in between.
    const theirs = { pads: [{ id: 1 }] } as unknown as ProfileSyncData;
    answer(respond(409, { version: 9, name: "Their Show", data: theirs }));

    const error = await api
      .pushServerProfile("p1", "Show", syncData, 4)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VersionConflictError);
    expect(error).toMatchObject({
      currentVersion: 9,
      currentName: "Their Show",
      currentData: theirs,
    });
  });

  it("says view-only on 403 rather than repeating the status", async () => {
    answer(respond(403, { error: "forbidden" }));

    await expect(
      api.pushServerProfile("p1", "Show", syncData, 4),
    ).rejects.toThrow("You have view-only access to this profile");
  });

  it("surfaces the server's message on any other failure", async () => {
    answer(respond(500, { error: "write failed" }));

    await expect(
      api.pushServerProfile("p1", "Show", syncData, 4),
    ).rejects.toThrow("write failed");
  });

  it("omits the share-token header when the profile was not opened by link", async () => {
    answer(respond(200, { version: 2 }));

    await api.pushServerProfile("p1", "Show", syncData, 1, null);

    expect(onlyCall().headers.has("x-impamp-share-token")).toBe(false);
  });
});

describe("deleteServerProfile", () => {
  it("deletes and resolves", async () => {
    answer(respond(204));

    await expect(api.deleteServerProfile("p1")).resolves.toBeUndefined();
    expect(onlyCall().init.method).toBe("DELETE");
  });

  it("raises on failure", async () => {
    answer(respond(403, {}));

    await expect(api.deleteServerProfile("p1")).rejects.toThrow(
      "Could not delete profile",
    );
  });
});

describe("the sharing calls", () => {
  it("lists shares", async () => {
    answer(respond(200, { shares: [{ id: 1, role: "viewer" }] }));

    expect(await api.listServerShares("p1")).toEqual([
      { id: 1, role: "viewer" },
    ]);
    expect(onlyCall().url).toBe("/api/profiles/p1/shares");
  });

  it("creates a link share with no email in the body", async () => {
    // A link share has no recipient, and sending `email: undefined` would
    // serialise the key away anyway — this pins the intent, not the accident.
    answer(respond(201, { share: { id: 2 } }));

    await api.createServerShare("p1", "editor");

    expect(JSON.parse(String(onlyCall().init.body))).toEqual({
      role: "editor",
    });
  });

  it("creates a person share carrying the email", async () => {
    answer(respond(201, { share: { id: 3, email: "b@example.com" } }));

    expect(
      await api.createServerShare("p1", "viewer", "b@example.com"),
    ).toEqual({ id: 3, email: "b@example.com" });
    expect(JSON.parse(String(onlyCall().init.body))).toEqual({
      role: "viewer",
      email: "b@example.com",
    });
  });

  it("revokes a share by id", async () => {
    answer(respond(204));

    await api.deleteServerShare("p1", 7);

    const { url, init } = onlyCall();
    expect(url).toBe("/api/profiles/p1/shares/7");
    expect(init.method).toBe("DELETE");
  });

  it.each([
    [
      "listServerShares",
      () => api.listServerShares("p1"),
      "Could not list sharing",
    ],
    [
      "createServerShare",
      () => api.createServerShare("p1", "viewer"),
      "Could not share profile",
    ],
    [
      "deleteServerShare",
      () => api.deleteServerShare("p1", 7),
      "Could not revoke sharing",
    ],
  ])("%s falls back to its own wording", async (_name, call, message) => {
    answer(respond(500, {}));

    await expect(call()).rejects.toThrow(message);
  });
});
