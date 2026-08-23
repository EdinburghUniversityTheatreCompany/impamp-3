/**
 * `authenticatedRequest`, which every Drive call in the app goes through, and
 * the thin functions layered on it.
 *
 * Three of its decisions are load-bearing and none of them is obvious from the
 * call sites:
 *
 * **404 is `null`, not an error.** Half the callers here — `findDriveFileById`,
 * `downloadDriveFile` — exist to answer "is this still there?", and a throw
 * would turn a deleted file into a failed sync rather than into a
 * reconnect prompt.
 *
 * **403 is a sentinel string.** `DRIVE_403` is thrown rather than a status
 * because callers apply different fallbacks to "you cannot see this folder"
 * than to "Drive is down", and `getFolderCapabilities` reads the message back
 * to answer `"none"`. That makes the *text* of that error part of the
 * contract, which is exactly the kind of thing that gets tidied away.
 *
 * **A 401 is retried once, and only once.** The token is refreshed through the
 * shared refresh (`api.sharedRefresh.test.ts` covers the deduplication of
 * that), the request is replayed with the new token, and a second failure is
 * final. A retry loop here would hammer Google with a dead refresh token.
 *
 * The bodies are parsed by `parseDriveResponse`, which has to tolerate an
 * empty one: DELETE answers 204 and some PATCHes answer 200 with nothing at
 * all, and `JSON.parse("")` throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenInfo } from "./types";

const fetchWithTimeout = vi.fn();
vi.mock("@/lib/fetchWithTimeout", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));

const sharedCheckAndRefresh = vi.fn();
vi.mock("./auth", () => ({
  sharedCheckAndRefresh: (...args: unknown[]) => sharedCheckAndRefresh(...args),
}));

const api = await import("./api");

const token: TokenInfo = {
  accessToken: "live-token",
  refreshToken: "refresh-token",
  expiresAt: Date.now() + 3_600_000,
};

const noteRefreshedToken = vi.fn();

/**
 * A Drive response.
 *
 * `text()` rather than `json()` is what `parseDriveResponse` reads, so the
 * body is given as a string and `json()` exists only for the error path.
 *
 * @param status - The HTTP status
 * @param body - The raw response text; `""` means "no body at all"
 * @param statusText - Used in the error message when the body carries none
 */
function drive(status: number, body = "", statusText = "Error"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
    json: async () => (body ? JSON.parse(body) : {}),
  } as unknown as Response;
}

const jsonBody = (value: unknown) => drive(200, JSON.stringify(value));

/** Queues one response per call, in order. */
function willAnswer(...responses: Response[]): void {
  for (const response of responses)
    fetchWithTimeout.mockResolvedValueOnce(response);
}

/** The URL of the nth request, counting from zero. */
const urlOf = (index: number) => String(fetchWithTimeout.mock.calls[index][0]);

/** The init of the nth request. */
const initOf = (index: number) =>
  fetchWithTimeout.mock.calls[index][1] as RequestInit;

beforeEach(() => {
  fetchWithTimeout.mockReset();
  sharedCheckAndRefresh.mockReset();
  noteRefreshedToken.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("authentication", () => {
  it("refuses to call Drive at all without a token", async () => {
    await expect(
      api.findDriveFileById("f1", null, noteRefreshedToken),
    ).rejects.toThrow("Not authenticated");
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("treats a token object with no access token as no token", async () => {
    await expect(
      api.listAppFiles({ accessToken: "" } as TokenInfo, noteRefreshedToken),
    ).rejects.toThrow("Not authenticated");
  });

  it("sends the access token as a bearer", async () => {
    willAnswer(jsonBody({ id: "f1" }));

    await api.findDriveFileById("f1", token, noteRefreshedToken);

    expect((initOf(0).headers as Record<string, string>).Authorization).toBe(
      "Bearer live-token",
    );
  });

  it("refreshes and replays the request once on a 401", async () => {
    const refreshed = { ...token, accessToken: "fresh-token" };
    willAnswer(drive(401), jsonBody({ id: "f1" }));
    sharedCheckAndRefresh.mockResolvedValue({
      isValid: true,
      refreshedTokenInfo: refreshed,
    });

    const file = await api.findDriveFileById("f1", token, noteRefreshedToken);

    expect(file).toEqual({ id: "f1" });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect((initOf(1).headers as Record<string, string>).Authorization).toBe(
      "Bearer fresh-token",
    );
  });

  it("hands the refreshed token back so the store stops using the dead one", async () => {
    const refreshed = { ...token, accessToken: "fresh-token" };
    willAnswer(drive(401), jsonBody({}));
    sharedCheckAndRefresh.mockResolvedValue({
      isValid: true,
      refreshedTokenInfo: refreshed,
    });

    await api.findDriveFileById("f1", token, noteRefreshedToken);

    expect(noteRefreshedToken).toHaveBeenCalledWith(refreshed);
  });

  it("asks the user to sign in again when the refresh fails", async () => {
    willAnswer(drive(401));
    sharedCheckAndRefresh.mockResolvedValue({ isValid: false });

    await expect(
      api.findDriveFileById("f1", token, noteRefreshedToken),
    ).rejects.toThrow("Authentication expired. Please sign in again.");
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not retry a second time when the replay also fails", async () => {
    willAnswer(drive(401), drive(500, "", "Internal Server Error"));
    sharedCheckAndRefresh.mockResolvedValue({
      isValid: true,
      refreshedTokenInfo: token,
    });

    await expect(
      api.listFolderPermissions("folder", token, noteRefreshedToken),
    ).rejects.toThrow("API Error: 500 Internal Server Error");
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("raises the 403 sentinel when the replay is forbidden", async () => {
    willAnswer(drive(401), drive(403));
    sharedCheckAndRefresh.mockResolvedValue({
      isValid: true,
      refreshedTokenInfo: token,
    });

    await expect(
      api.listFolderPermissions("folder", token, noteRefreshedToken),
    ).rejects.toThrow("DRIVE_403");
  });
});

describe("how a response becomes a result", () => {
  it("reads 404 as 'not there' rather than as a failure", async () => {
    // Through a caller that has no 404 rescue of its own, deliberately.
    // `findDriveFileById` and `downloadDriveFile` both catch a message
    // containing "404", so they answer null either way and cannot tell
    // whether this branch exists at all.
    willAnswer(drive(404));

    expect(
      await api.listFolderPermissions("folder", token, noteRefreshedToken),
    ).toEqual([]);
  });

  it("lets a caller with its own 404 rescue answer null too", async () => {
    willAnswer(drive(404));

    expect(
      await api.findDriveFileById("gone", token, noteRefreshedToken),
    ).toBeNull();
  });

  it("raises the DRIVE_403 sentinel a caller can branch on", async () => {
    // The text is the contract: `getFolderCapabilities` matches on it.
    willAnswer(drive(403));

    await expect(
      api.listFolderPermissions("folder", token, noteRefreshedToken),
    ).rejects.toThrow("DRIVE_403");
  });

  it("quotes Google's own message on any other failure", async () => {
    willAnswer(
      drive(400, JSON.stringify({ error: { message: "Invalid query" } })),
    );

    await expect(
      api.listFolderPermissions("folder", token, noteRefreshedToken),
    ).rejects.toThrow("Google Drive API Error: 400 Invalid query");
  });

  it("falls back to the status text when the body carries no message", async () => {
    willAnswer(drive(500, "", "Backend Error"));

    await expect(
      api.listFolderPermissions("folder", token, noteRefreshedToken),
    ).rejects.toThrow("Google Drive API Error: 500 Backend Error");
  });

  it("survives an error body that is not JSON at all", async () => {
    const htmlErrorPage = {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => "<html>",
      json: async () => {
        throw new SyntaxError("not JSON");
      },
    } as unknown as Response;
    willAnswer(htmlErrorPage);

    await expect(
      api.listFolderPermissions("folder", token, noteRefreshedToken),
    ).rejects.toThrow("Google Drive API Error: 502 Bad Gateway");
  });

  it("treats a 204 as no data rather than parsing an empty string", async () => {
    // DELETE answers 204, and `JSON.parse("")` throws.
    willAnswer(drive(204));

    await expect(
      api.removePermission("folder", "perm", token, noteRefreshedToken),
    ).resolves.toBeUndefined();
  });

  it("treats a 200 with an empty body the same way", async () => {
    willAnswer(drive(200, ""));

    expect(
      await api.listFolderPermissions("folder", token, noteRefreshedToken),
    ).toEqual([]);
  });
});

describe("listDriveFilesByQuery", () => {
  it("follows nextPageToken, so results are not capped at one page", async () => {
    // Drive pages at 100. A profile with more sounds than that would
    // otherwise silently sync only the first hundred.
    willAnswer(
      jsonBody({ files: [{ id: "a" }], nextPageToken: "page-2" }),
      jsonBody({ files: [{ id: "b" }], nextPageToken: "page-3" }),
      jsonBody({ files: [{ id: "c" }] }),
    );

    const files = await api.listDriveFilesByQuery(
      "trashed=false",
      "id",
      token,
      noteRefreshedToken,
    );

    expect(files.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(urlOf(0)).not.toContain("pageToken");
    expect(urlOf(1)).toContain("pageToken=page-2");
    expect(urlOf(2)).toContain("pageToken=page-3");
  });

  it("percent-encodes the query rather than pasting it in raw", async () => {
    willAnswer(jsonBody({ files: [] }));

    await api.listDriveFilesByQuery(
      "name='a b' and trashed=false",
      "id",
      token,
      noteRefreshedToken,
    );

    expect(urlOf(0)).toContain("q=name%3D'a%20b'%20and%20trashed%3Dfalse");
  });

  it("returns nothing rather than throwing when a page has no files key", async () => {
    willAnswer(jsonBody({}));

    expect(
      await api.listDriveFilesByQuery("q", "id", token, noteRefreshedToken),
    ).toEqual([]);
  });
});

describe("finding files", () => {
  it("findDriveFileByName returns the first match", async () => {
    willAnswer(jsonBody({ files: [{ id: "first" }, { id: "second" }] }));

    expect(
      await api.findDriveFileByName("show.json", token, noteRefreshedToken),
    ).toEqual({ id: "first" });
  });

  it("findDriveFileByName escapes an apostrophe in the name", async () => {
    // Unescaped, this closes the query literal and Drive answers 400.
    willAnswer(jsonBody({ files: [] }));

    await api.findDriveFileByName("Mick's show", token, noteRefreshedToken);

    expect(decodeURIComponent(urlOf(0))).toContain("name='Mick\\'s show'");
  });

  it("findDriveFileByName returns null when nothing matches", async () => {
    willAnswer(jsonBody({ files: [] }));

    expect(
      await api.findDriveFileByName("nothing", token, noteRefreshedToken),
    ).toBeNull();
  });

  it("findAudioFileInDriveFolder scopes the search to the folder and profile", async () => {
    willAnswer(jsonBody({ files: [{ id: "audio-1" }] }));

    expect(
      await api.findAudioFileInDriveFolder(
        "cue.wav",
        7,
        "folder-1",
        token,
        noteRefreshedToken,
      ),
    ).toEqual({ id: "audio-1" });

    const query = decodeURIComponent(urlOf(0));
    expect(query).toContain("'folder-1' in parents");
    expect(query).toContain("value='7'");
    expect(query).toContain("value='audioFile'");
  });

  it("findAudioFileInDriveFolder returns null when the folder has no copy", async () => {
    willAnswer(jsonBody({ files: [] }));

    expect(
      await api.findAudioFileInDriveFolder(
        "cue.wav",
        7,
        "folder-1",
        token,
        noteRefreshedToken,
      ),
    ).toBeNull();
  });

  it("listAppFiles excludes audio, which shares the app identifier", async () => {
    willAnswer(
      jsonBody({
        files: [
          { id: "profile", appProperties: { fileType: "profile" } },
          { id: "audio", appProperties: { fileType: "audioFile" } },
          { id: "unlabelled" },
        ],
      }),
    );

    const files = await api.listAppFiles(token, noteRefreshedToken);

    expect(files.map((f) => f.id)).toEqual(["profile", "unlabelled"]);
  });

  it("listFilesInFolder asks only for JSON in that folder", async () => {
    willAnswer(jsonBody({ files: [{ id: "x" }] }));

    await api.listFilesInFolder("folder-1", token, noteRefreshedToken);

    const query = decodeURIComponent(urlOf(0));
    expect(query).toContain("'folder-1' in parents");
    expect(query).toContain("mimeType='application/json'");
  });
});

describe("getFolderCapabilities", () => {
  it.each([
    ["owner", { ownedByMe: true, capabilities: { canAddChildren: true } }],
    ["writer", { ownedByMe: false, capabilities: { canAddChildren: true } }],
    ["reader", { ownedByMe: false, capabilities: { canAddChildren: false } }],
    ["reader", { ownedByMe: false }],
  ])("reports %s", async (expected, body) => {
    willAnswer(jsonBody(body));

    expect(
      await api.getFolderCapabilities("folder", token, noteRefreshedToken),
    ).toBe(expected);
  });

  it("reports none when the folder answers with no body", async () => {
    willAnswer(drive(200, ""));

    expect(
      await api.getFolderCapabilities("folder", token, noteRefreshedToken),
    ).toBe("none");
  });

  it("reports none rather than throwing when the folder is gone", async () => {
    willAnswer(drive(404));

    expect(
      await api.getFolderCapabilities("folder", token, noteRefreshedToken),
    ).toBe("none");
  });

  it("reports none rather than throwing when access is refused", async () => {
    willAnswer(drive(403));

    expect(
      await api.getFolderCapabilities("folder", token, noteRefreshedToken),
    ).toBe("none");
  });

  it("still raises anything that is neither", async () => {
    willAnswer(drive(500, "", "Backend Error"));

    await expect(
      api.getFolderCapabilities("folder", token, noteRefreshedToken),
    ).rejects.toThrow("Backend Error");
  });
});

describe("moveFileToFolder", () => {
  it("names the current parents so the file does not end up in both", async () => {
    // Drive's PATCH is additive: without removeParents the file stays in the
    // old folder as well, and the next sync finds two copies.
    willAnswer(
      jsonBody({ parents: ["old-1", "old-2"] }),
      jsonBody({ id: "f" }),
    );

    await api.moveFileToFolder("f", "new", token, noteRefreshedToken);

    expect(urlOf(1)).toContain("addParents=new");
    expect(urlOf(1)).toContain(
      `removeParents=${encodeURIComponent("old-1,old-2")}`,
    );
    expect(initOf(1).method).toBe("PATCH");
  });

  it("copes with a file that has no parents recorded", async () => {
    willAnswer(jsonBody({}), jsonBody({ id: "f" }));

    await api.moveFileToFolder("f", "new", token, noteRefreshedToken);

    expect(urlOf(1)).toContain("removeParents=");
  });
});

describe("sharing a folder", () => {
  it("lists permissions", async () => {
    willAnswer(jsonBody({ permissions: [{ id: "p1", type: "anyone" }] }));

    expect(
      await api.listFolderPermissions("folder", token, noteRefreshedToken),
    ).toEqual([{ id: "p1", type: "anyone" }]);
  });

  it("creates the anyone permission when there is none yet", async () => {
    willAnswer(jsonBody({ permissions: [] }), jsonBody({ id: "p1" }));

    await api.setPublicLinkAccess(
      "folder",
      "reader",
      token,
      noteRefreshedToken,
    );

    expect(initOf(1).method).toBe("POST");
    expect(JSON.parse(String(initOf(1).body))).toEqual({
      type: "anyone",
      role: "reader",
    });
  });

  it("patches the existing anyone permission rather than adding a second", async () => {
    willAnswer(
      jsonBody({ permissions: [{ id: "p9", type: "anyone", role: "reader" }] }),
      jsonBody({}),
    );

    await api.setPublicLinkAccess(
      "folder",
      "writer",
      token,
      noteRefreshedToken,
    );

    expect(urlOf(1)).toContain("/permissions/p9");
    expect(initOf(1).method).toBe("PATCH");
    expect(JSON.parse(String(initOf(1).body))).toEqual({ role: "writer" });
  });

  it("deletes the anyone permission when the link is turned off", async () => {
    willAnswer(
      jsonBody({ permissions: [{ id: "p9", type: "anyone" }] }),
      drive(204),
    );

    await api.setPublicLinkAccess("folder", "off", token, noteRefreshedToken);

    expect(initOf(1).method).toBe("DELETE");
  });

  it("does nothing to turn off a link that was never on", async () => {
    willAnswer(jsonBody({ permissions: [{ id: "p1", type: "user" }] }));

    await api.setPublicLinkAccess("folder", "off", token, noteRefreshedToken);

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("invites a person by email", async () => {
    willAnswer(jsonBody({ id: "p2", emailAddress: "b@example.com" }));

    expect(
      await api.inviteUser(
        "folder",
        "b@example.com",
        "writer",
        token,
        noteRefreshedToken,
      ),
    ).toEqual({ id: "p2", emailAddress: "b@example.com" });
    expect(JSON.parse(String(initOf(0).body))).toEqual({
      type: "user",
      role: "writer",
      emailAddress: "b@example.com",
    });
  });

  it("raises when an invitation comes back with no permission", async () => {
    willAnswer(drive(200, ""));

    await expect(
      api.inviteUser(
        "folder",
        "b@example.com",
        "reader",
        token,
        noteRefreshedToken,
      ),
    ).rejects.toThrow("Failed to invite user");
  });

  it("removes a permission by id", async () => {
    willAnswer(drive(204));

    await api.removePermission("folder", "p3", token, noteRefreshedToken);

    expect(urlOf(0)).toContain("/permissions/p3");
    expect(initOf(0).method).toBe("DELETE");
  });

  it("createFilePermission opens a file to anyone with the link", async () => {
    willAnswer(jsonBody({ id: "p4" }));

    await api.createFilePermission("file-1", token, noteRefreshedToken);

    expect(JSON.parse(String(initOf(0).body))).toEqual({
      type: "anyone",
      role: "writer",
    });
  });
});

describe("getOrCreateProfileFolder", () => {
  it("reuses both folders when they already exist", async () => {
    willAnswer(
      jsonBody({ files: [{ id: "app-folder" }] }),
      jsonBody({ files: [{ id: "profile-folder" }] }),
    );

    expect(
      await api.getOrCreateProfileFolder("Show", token, noteRefreshedToken),
    ).toBe("profile-folder");
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("creates the app folder when it is missing", async () => {
    willAnswer(
      jsonBody({ files: [] }),
      jsonBody({ id: "new-app-folder" }),
      jsonBody({ files: [{ id: "profile-folder" }] }),
    );

    await api.getOrCreateProfileFolder("Show", token, noteRefreshedToken);

    expect(initOf(1).method).toBe("POST");
    expect(JSON.parse(String(initOf(1).body))).toMatchObject({
      name: "ImpAmp_Data",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root"],
    });
  });

  it("raises when Drive accepts the create but returns no id", async () => {
    willAnswer(jsonBody({ files: [] }), jsonBody({}));

    await expect(
      api.getOrCreateProfileFolder("Show", token, noteRefreshedToken),
    ).rejects.toThrow("Failed to create ImpAmp_Data folder");
  });

  it("refuses without a token, before reaching Drive", async () => {
    await expect(
      api.getOrCreateProfileFolder("Show", null, noteRefreshedToken),
    ).rejects.toThrow("Not authenticated");
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

describe("downloadDriveFile", () => {
  it("returns null for a file that has been deleted", async () => {
    willAnswer(drive(404));

    expect(
      await api.downloadDriveFile("gone", token, noteRefreshedToken),
    ).toBeNull();
  });

  it("re-raises anything that is not a 404", async () => {
    willAnswer(drive(500, "", "Backend Error"));

    await expect(
      api.downloadDriveFile("f1", token, noteRefreshedToken),
    ).rejects.toThrow("Backend Error");
  });
});
