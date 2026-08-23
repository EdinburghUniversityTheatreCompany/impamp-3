// @vitest-environment jsdom
/**
 * The profile store's remaining actions: create, update, the four import
 * entry points, the ZIP export, the Google token bookkeeping and the sync
 * pause.
 *
 * `profileStore.test.ts` covers switching, deletion, the edit gate and bank
 * selection; `profileStore.bankTransfer.test.ts` covers the bank archive pair.
 * What is left is mostly database-and-state plumbing, and its failure mode is
 * the same everywhere: the store and IndexedDB disagreeing about what exists.
 *
 * Two things here are more than plumbing.
 *
 * **The "could not read it back" fallback.** Every import and `createProfile`
 * appends the new profile to state directly, and falls back to a full
 * `fetchProfiles()` when the read-back comes up empty. Without the fallback a
 * profile that exists in IndexedDB is invisible until the page is reloaded,
 * which reads to a user as the import having silently failed.
 *
 * **A failed backup timestamp is not a failed export.** `exportProfilesToZip`
 * writing the archive and then failing to stamp `lastBackedUpAt` used to be
 * reported as an error, when the file is on disk and the only consequence is
 * the reminder firing again. The action must still answer `true`.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import "@/lib/testSupport/browserGlobals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietConsole } from "@/lib/testSupport/quietConsole";
import type { Profile } from "@/lib/db";

const db = vi.hoisted(() => ({
  addProfile: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  getAllProfiles: vi.fn(),
  ensureDefaultProfile: vi.fn(),
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  ...db,
}));

const importExport = vi.hoisted(() => ({
  importProfile: vi.fn(),
  importMultipleProfiles: vi.fn(),
  importImpamp2Profile: vi.fn(),
  importProfilesFromZip: vi.fn(),
  importProfileFromSyncData: vi.fn(),
  exportProfilesToZip: vi.fn(),
}));
vi.mock("@/lib/importExport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/importExport")>()),
  ...importExport,
}));

const auth = vi.hoisted(() => ({ validateAuthState: vi.fn() }));
vi.mock("@/lib/authUtils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authUtils")>()),
  ...auth,
}));

const { useProfileStore, whenProfilesLoaded } =
  await import("@/store/profileStore");

const state = () => useProfileStore.getState();

function profile(id: number, overrides: Partial<Profile> = {}): Profile {
  return {
    id,
    name: `Profile ${id}`,
    syncType: "local",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as Profile;
}

/** A profile export blob whose structure passes the store's own validation. */
const validExport = JSON.stringify({
  exportVersion: 2,
  profile: { name: "Imported" },
  padConfigurations: [],
  pageMetadata: [],
  audioFiles: [],
});

beforeEach(() => {
  useProfileStore.setState({
    profiles: [],
    activeProfileId: null,
    isLoading: false,
    padConfigsVersion: 0,
    syncRequestQueue: {},
    googleUser: null,
    googleAccessToken: null,
    googleRefreshToken: null,
    tokenExpiresAt: null,
    isGoogleSignedIn: false,
    needsReauth: false,
    fadeoutDuration: 3,
  });
  quietConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const spy of [...Object.values(db), ...Object.values(importExport)])
    spy.mockReset();
  auth.validateAuthState.mockReset();
});

describe("createProfile", () => {
  it("appends the profile it just wrote", async () => {
    db.addProfile.mockResolvedValue(9);
    db.getProfile.mockResolvedValue(profile(9, { name: "New" }));

    expect(
      await state().createProfile({ name: "New", syncType: "local" }),
    ).toBe(9);
    expect(state().profiles.map((p) => p.id)).toEqual([9]);
  });

  it("falls back to a full reload when the read-back comes up empty", async () => {
    // The row exists; only reading it back failed. Leaving state alone would
    // hide a profile the user just made until they reloaded the page.
    db.addProfile.mockResolvedValue(9);
    db.getProfile.mockResolvedValue(undefined);
    db.getAllProfiles.mockResolvedValue([profile(9)]);
    db.ensureDefaultProfile.mockResolvedValue(undefined);

    await state().createProfile({ name: "New", syncType: "local" });

    expect(state().profiles.map((p) => p.id)).toEqual([9]);
  });

  it("lets the write's failure reach the caller", async () => {
    db.addProfile.mockRejectedValue(new Error("quota exceeded"));

    await expect(
      state().createProfile({ name: "New", syncType: "local" }),
    ).rejects.toThrow("quota exceeded");
    expect(state().profiles).toEqual([]);
  });
});

describe("updateProfile", () => {
  it("patches the row in state as well as in the database", async () => {
    useProfileStore.setState({ profiles: [profile(1), profile(2)] });
    db.updateProfile.mockResolvedValue(undefined);

    await state().updateProfile(2, { name: "Renamed" });

    expect(state().profiles.map((p) => p.name)).toEqual([
      "Profile 1",
      "Renamed",
    ]);
    expect(db.updateProfile).toHaveBeenCalledWith(2, { name: "Renamed" });
  });

  it("leaves state alone when the write fails", async () => {
    useProfileStore.setState({ profiles: [profile(1)] });
    db.updateProfile.mockRejectedValue(new Error("read-only"));

    await expect(state().updateProfile(1, { name: "Renamed" })).rejects.toThrow(
      "read-only",
    );
    expect(state().profiles[0].name).toBe("Profile 1");
  });
});

describe("importProfileFromJSON", () => {
  it("adds the imported profile to state", async () => {
    importExport.importProfile.mockResolvedValue(4);
    db.getProfile.mockResolvedValue(profile(4, { name: "Imported" }));

    expect(await state().importProfileFromJSON(validExport)).toBe(4);
    expect(state().profiles.map((p) => p.name)).toEqual(["Imported"]);
  });

  it("falls back to a full reload when the read-back comes up empty", async () => {
    importExport.importProfile.mockResolvedValue(4);
    db.getProfile.mockResolvedValue(undefined);
    db.getAllProfiles.mockResolvedValue([profile(4)]);
    db.ensureDefaultProfile.mockResolvedValue(undefined);

    await state().importProfileFromJSON(validExport);

    expect(state().profiles.map((p) => p.id)).toEqual([4]);
  });

  it("rejects something that is not JSON at all", async () => {
    await expect(state().importProfileFromJSON("not json")).rejects.toThrow(
      "Invalid JSON format",
    );
    expect(importExport.importProfile).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no version",
      { profile: {}, padConfigurations: [], pageMetadata: [], audioFiles: [] },
    ],
    [
      "no profile",
      {
        exportVersion: 2,
        padConfigurations: [],
        pageMetadata: [],
        audioFiles: [],
      },
    ],
    [
      "pads that are not an array",
      {
        exportVersion: 2,
        profile: {},
        padConfigurations: {},
        pageMetadata: [],
        audioFiles: [],
      },
    ],
    [
      "no banks",
      { exportVersion: 2, profile: {}, padConfigurations: [], audioFiles: [] },
    ],
    [
      "no audio list",
      {
        exportVersion: 2,
        profile: {},
        padConfigurations: [],
        pageMetadata: [],
      },
    ],
  ])("rejects an export with %s", async (_label, body) => {
    await expect(
      state().importProfileFromJSON(JSON.stringify(body)),
    ).rejects.toThrow("Invalid profile export format");
  });
});

describe("importMultipleProfilesFromJSON", () => {
  it("returns the per-profile results and refreshes the list", async () => {
    importExport.importMultipleProfiles.mockResolvedValue([
      { name: "A", success: true },
    ]);
    db.getAllProfiles.mockResolvedValue([profile(1)]);
    db.ensureDefaultProfile.mockResolvedValue(undefined);

    const results = await state().importMultipleProfilesFromJSON(
      JSON.stringify({ exportVersion: 1, profiles: [] }),
    );

    expect(results).toEqual([{ name: "A", success: true }]);
    expect(state().profiles.map((p) => p.id)).toEqual([1]);
  });

  it("rejects a body that is not JSON", async () => {
    await expect(state().importMultipleProfilesFromJSON("{")).rejects.toThrow(
      "Invalid JSON format",
    );
  });

  it.each([
    ["a version it does not know", { exportVersion: 2, profiles: [] }],
    ["profiles that are not an array", { exportVersion: 1, profiles: {} }],
  ])("rejects an archive with %s", async (_label, body) => {
    await expect(
      state().importMultipleProfilesFromJSON(JSON.stringify(body)),
    ).rejects.toThrow("Invalid or unsupported multi-profile export format.");
  });
});

describe("the remaining import entry points", () => {
  it("importProfileFromImpamp2JSON adds what it imported", async () => {
    importExport.importImpamp2Profile.mockResolvedValue(5);
    db.getProfile.mockResolvedValue(profile(5, { name: "Legacy" }));

    expect(await state().importProfileFromImpamp2JSON("{}")).toBe(5);
    expect(state().profiles.map((p) => p.name)).toEqual(["Legacy"]);
  });

  it("importProfileFromImpamp2JSON falls back on an empty read-back", async () => {
    importExport.importImpamp2Profile.mockResolvedValue(5);
    db.getProfile.mockResolvedValue(undefined);
    db.getAllProfiles.mockResolvedValue([profile(5)]);
    db.ensureDefaultProfile.mockResolvedValue(undefined);

    await state().importProfileFromImpamp2JSON("{}");

    expect(state().profiles.map((p) => p.id)).toEqual([5]);
  });

  it("importProfileFromImpamp2JSON re-raises so the UI can say what broke", async () => {
    importExport.importImpamp2Profile.mockRejectedValue(
      new Error("unrecognised legacy format"),
    );

    await expect(state().importProfileFromImpamp2JSON("{}")).rejects.toThrow(
      "unrecognised legacy format",
    );
  });

  it("importProfilesFromZip returns the per-profile results", async () => {
    importExport.importProfilesFromZip.mockResolvedValue([{ name: "A" }]);
    db.getAllProfiles.mockResolvedValue([profile(1)]);
    db.ensureDefaultProfile.mockResolvedValue(undefined);

    expect(await state().importProfilesFromZip(new Blob())).toEqual([
      { name: "A" },
    ]);
    expect(state().profiles).toHaveLength(1);
  });

  it("importProfilesFromZip re-raises", async () => {
    importExport.importProfilesFromZip.mockRejectedValue(
      new Error("not an archive"),
    );

    await expect(state().importProfilesFromZip(new Blob())).rejects.toThrow(
      "not an archive",
    );
  });

  it("importProfileFromSyncData threads the audio downloaders through", async () => {
    importExport.importProfileFromSyncData.mockResolvedValue(6);
    db.getProfile.mockResolvedValue(profile(6));
    const fromDrive = vi.fn();
    const fromHost = vi.fn();

    await state().importProfileFromSyncData(
      { pads: [] } as never,
      fromDrive,
      undefined,
      undefined,
      fromHost,
    );

    const call = importExport.importProfileFromSyncData.mock.calls[0];
    expect(call[2]).toBe(fromDrive);
    expect(call[5]).toBe(fromHost);
    expect(state().profiles.map((p) => p.id)).toEqual([6]);
  });

  it("importProfileFromSyncData falls back on an empty read-back", async () => {
    importExport.importProfileFromSyncData.mockResolvedValue(6);
    db.getProfile.mockResolvedValue(undefined);
    db.getAllProfiles.mockResolvedValue([profile(6)]);
    db.ensureDefaultProfile.mockResolvedValue(undefined);

    await state().importProfileFromSyncData({ pads: [] } as never, vi.fn());

    expect(state().profiles.map((p) => p.id)).toEqual([6]);
  });

  it("importProfileFromSyncData re-raises", async () => {
    importExport.importProfileFromSyncData.mockRejectedValue(
      new Error("audio download failed"),
    );

    await expect(
      state().importProfileFromSyncData({ pads: [] } as never, vi.fn()),
    ).rejects.toThrow("audio download failed");
  });
});

describe("exportMultipleProfilesToZip", () => {
  /** The `download` attribute of every anchor the blob fallback clicked. */
  let downloads: string[] = [];

  beforeEach(() => {
    // No save picker, so the export takes the in-memory blob path — the one
    // Firefox and Safari take, and the one whose filename is observable.
    Reflect.deleteProperty(window, "showSaveFilePicker");
    importExport.exportProfilesToZip.mockResolvedValue(new Blob(["zip"]));
    db.updateProfile.mockResolvedValue(undefined);

    downloads = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    // jsdom implements neither, and the fallback calls both.
    URL.createObjectURL = () => "blob:fake";
    URL.revokeObjectURL = () => {};
  });

  /** The name the last download was offered under. */
  const lastDownloadName = () => downloads[downloads.length - 1];

  it("refuses an empty selection without touching the library", async () => {
    expect(await state().exportMultipleProfilesToZip([])).toBe(false);
    expect(importExport.exportProfilesToZip).not.toHaveBeenCalled();
  });

  it("names a single-profile archive after the profile", async () => {
    useProfileStore.setState({ profiles: [profile(1, { name: "Show A!" })] });

    expect(await state().exportMultipleProfilesToZip([1])).toBe(true);

    expect(lastDownloadName()).toMatch(
      /^impamp-show-a--\d{4}-\d{2}-\d{2}\.iaz$/,
    );
  });

  it("names a multi-profile archive by count, not by one of the names", async () => {
    // A file called impamp-show-a-….iaz holding three profiles is how a
    // restore goes wrong months later.
    useProfileStore.setState({
      profiles: [profile(1, { name: "Show A" }), profile(2)],
    });

    await state().exportMultipleProfilesToZip([1, 2]);

    expect(lastDownloadName()).toMatch(
      /^impamp-multi-profile-export-2-profiles-\d{4}-\d{2}-\d{2}\.iaz$/,
    );
  });

  it("falls back to a generic name for an id it does not hold", async () => {
    await state().exportMultipleProfilesToZip([99]);

    expect(lastDownloadName()).toMatch(/^impamp-profile-/);
  });

  it("stamps the backup time on every profile it exported", async () => {
    useProfileStore.setState({ profiles: [profile(1), profile(2)] });

    await state().exportMultipleProfilesToZip([1, 2]);

    expect(db.updateProfile).toHaveBeenCalledTimes(2);
    expect(state().profiles.every((p) => p.lastBackedUpAt)).toBe(true);
  });

  it("still reports success when only the timestamp fails", async () => {
    // The archive is on disk. A failed stamp means the reminder fires again,
    // which is the safe way round — it is not an export failure.
    useProfileStore.setState({ profiles: [profile(1)] });
    db.updateProfile.mockRejectedValue(new Error("write failed"));

    expect(await state().exportMultipleProfilesToZip([1])).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("backup reminder will fire again"),
      expect.any(Error),
    );
  });

  it("reports failure when there is no archive to download", async () => {
    useProfileStore.setState({ profiles: [profile(1)] });
    importExport.exportProfilesToZip.mockResolvedValue(null);

    expect(await state().exportMultipleProfilesToZip([1])).toBe(false);
    expect(db.updateProfile).not.toHaveBeenCalled();
  });

  it("lets the library's own failure reach the caller", async () => {
    useProfileStore.setState({ profiles: [profile(1)] });
    importExport.exportProfilesToZip.mockRejectedValue(
      new Error("audio missing"),
    );

    await expect(state().exportMultipleProfilesToZip([1])).rejects.toThrow(
      "audio missing",
    );
  });
});

describe("the Google token bookkeeping", () => {
  it("keeps the existing refresh token when a re-consent omits one", async () => {
    // Google sends the refresh token only on the first consent. Overwriting it
    // with undefined on every later sign-in would end unattended refresh.
    useProfileStore.setState({ googleRefreshToken: "original-refresh" });

    state().setGoogleAuthDetails({ email: "a@example.com" }, "access", null, 1);

    expect(state().googleRefreshToken).toBe("original-refresh");
    expect(state().isGoogleSignedIn).toBe(true);
  });

  it("takes a refresh token when one is offered", () => {
    state().setGoogleAuthDetails({}, "access", "new-refresh", 1);

    expect(state().googleRefreshToken).toBe("new-refresh");
  });

  it("clears everything on sign-out, including the reauth flag", () => {
    state().setGoogleAuthDetails({}, "access", "refresh", 1);
    useProfileStore.setState({ needsReauth: true });

    state().clearGoogleAuthDetails();

    expect(state()).toMatchObject({
      googleUser: null,
      googleAccessToken: null,
      googleRefreshToken: null,
      tokenExpiresAt: null,
      isGoogleSignedIn: false,
      needsReauth: false,
    });
  });

  it("checkTokenValidity reads the stored expiry", () => {
    useProfileStore.setState({ tokenExpiresAt: Date.now() + 3_600_000 });
    expect(state().checkTokenValidity()).toBe(true);

    useProfileStore.setState({ tokenExpiresAt: Date.now() });
    expect(state().checkTokenValidity()).toBe(false);
  });

  it("adopts a refreshed token when validation renews one", async () => {
    auth.validateAuthState.mockResolvedValue({
      isValid: true,
      needsReauth: false,
      newAccessToken: "fresh",
      newExpiresAt: 4242,
    });

    expect(await state().validateGoogleAuthState()).toBe(true);
    expect(state()).toMatchObject({
      googleAccessToken: "fresh",
      tokenExpiresAt: 4242,
      needsReauth: false,
    });
  });

  it("leaves a still-valid token in place", async () => {
    useProfileStore.setState({ googleAccessToken: "current" });
    auth.validateAuthState.mockResolvedValue({
      isValid: true,
      needsReauth: false,
    });

    expect(await state().validateGoogleAuthState()).toBe(true);
    expect(state().googleAccessToken).toBe("current");
  });

  it("raises the reauth flag when the token cannot be renewed", async () => {
    auth.validateAuthState.mockResolvedValue({
      isValid: false,
      needsReauth: true,
    });

    expect(await state().validateGoogleAuthState()).toBe(false);
    expect(state().needsReauth).toBe(true);
  });

  it("raises the reauth flag when validation itself throws", async () => {
    auth.validateAuthState.mockRejectedValue(new Error("network down"));

    expect(await state().validateGoogleAuthState()).toBe(false);
    expect(state().needsReauth).toBe(true);
  });
});

describe("pausing sync", () => {
  beforeEach(() => {
    useProfileStore.setState({ profiles: [profile(1), profile(2)] });
    db.updateProfile.mockResolvedValue(undefined);
  });

  it("records the resume time in the database and in state", async () => {
    const before = Date.now();

    await state().pauseSync(1, 60_000);

    const paused = state().profiles.find((p) => p.id === 1)!;
    expect(paused.syncPausedUntil).toBeGreaterThanOrEqual(before + 60_000);
    expect(state().isSyncPaused(1)).toBe(true);
    expect(state().getSyncResumeTime(1)).toBe(paused.syncPausedUntil);
  });

  it("leaves other profiles running", async () => {
    await state().pauseSync(1, 60_000);

    expect(state().isSyncPaused(2)).toBe(false);
    expect(state().getSyncResumeTime(2)).toBeNull();
  });

  it("clears the pause on resume", async () => {
    await state().pauseSync(1, 60_000);

    await state().resumeSync(1);

    expect(state().isSyncPaused(1)).toBe(false);
    expect(db.updateProfile).toHaveBeenLastCalledWith(1, {
      syncPausedUntil: undefined,
    });
  });

  it("treats a pause whose time has passed as over", async () => {
    useProfileStore.setState({
      profiles: [profile(1, { syncPausedUntil: Date.now() - 1000 })],
    });

    expect(state().isSyncPaused(1)).toBe(false);
    // The stamp is still readable, which is what the UI shows.
    expect(state().getSyncResumeTime(1)).toBeLessThan(Date.now());
  });

  it("says a profile it does not hold is not paused", () => {
    expect(state().isSyncPaused(99)).toBe(false);
    expect(state().getSyncResumeTime(99)).toBeNull();
  });

  it("lets a failed pause reach the caller", async () => {
    db.updateProfile.mockRejectedValue(new Error("read-only"));

    await expect(state().pauseSync(1, 60_000)).rejects.toThrow("read-only");
    expect(state().isSyncPaused(1)).toBe(false);
  });

  it("lets a failed resume reach the caller", async () => {
    await state().pauseSync(1, 60_000);
    db.updateProfile.mockRejectedValue(new Error("read-only"));

    await expect(state().resumeSync(1)).rejects.toThrow("read-only");
    expect(state().isSyncPaused(1)).toBe(true);
  });
});

describe("the sync request queue", () => {
  it("records a request and then forgets it", () => {
    state().requestSync(3);
    expect(state().syncRequestQueue[3]).toEqual(expect.any(Number));

    state().clearSyncRequest(3);
    expect(3 in state().syncRequestQueue).toBe(false);
  });

  it("leaves the queue object identical when clearing something absent", () => {
    // A new object here would wake every subscriber for nothing.
    const before = state().syncRequestQueue;

    state().clearSyncRequest(99);

    expect(state().syncRequestQueue).toBe(before);
  });
});

describe("the per-profile settings readers", () => {
  it("getFadeoutDuration falls back to three seconds", () => {
    useProfileStore.setState({
      fadeoutDuration: undefined as unknown as number,
    });

    expect(state().getFadeoutDuration()).toBe(3);
  });

  it("setFadeoutDuration refuses a value that would silence the fade", () => {
    state().setFadeoutDuration(0);
    expect(state().getFadeoutDuration()).toBe(3);

    state().setFadeoutDuration(-1);
    expect(state().getFadeoutDuration()).toBe(3);

    state().setFadeoutDuration(5);
    expect(state().getFadeoutDuration()).toBe(5);
  });

  it("getActivePadBehavior defaults to continue", () => {
    expect(state().getActivePadBehavior()).toBe("continue");

    useProfileStore.setState({
      profiles: [profile(1, { activePadBehavior: "layer" })],
      activeProfileId: 1,
    });
    expect(state().getActivePadBehavior()).toBe("layer");
  });

  it("getNormalisationSettings falls back to the shared default", () => {
    const fallback = state().getNormalisationSettings();

    useProfileStore.setState({
      profiles: [
        profile(1, {
          normalisation: { ...fallback, enabled: !fallback.enabled },
        }),
      ],
      activeProfileId: 1,
    });

    expect(state().getNormalisationSettings().enabled).toBe(!fallback.enabled);
  });

  it("setNormalisation does nothing without an active profile", async () => {
    await state().setNormalisation({ enabled: true } as never);

    expect(db.updateProfile).not.toHaveBeenCalled();
  });

  it("incrementPadConfigsVersion moves the one invalidation signal", () => {
    const before = state().padConfigsVersion;

    state().incrementPadConfigsVersion();

    expect(state().padConfigsVersion).toBe(before + 1);
  });
});

describe("whenProfilesLoaded", () => {
  it("resolves immediately once loading has finished", async () => {
    useProfileStore.setState({ isLoading: false, profiles: [profile(1)] });

    expect((await whenProfilesLoaded()).map((p) => p.id)).toEqual([1]);
  });

  it("waits for the first load rather than reporting an empty list", async () => {
    // A share-link page reading `profiles` at mount sees nothing, and would
    // import a second copy of a profile the user already has.
    useProfileStore.setState({ isLoading: true, profiles: [] });
    const pending = whenProfilesLoaded();
    let settled = false;
    void pending.then(() => (settled = true));

    await Promise.resolve();
    expect(settled).toBe(false);

    useProfileStore.setState({ isLoading: false, profiles: [profile(2)] });

    expect((await pending).map((p) => p.id)).toEqual([2]);
  });
});
