// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProfileStore } from "@/store/profileStore";
import { syncStatusActions, useSyncStatusStore } from "@/store/syncStatusStore";
import type { Profile } from "@/lib/db";

const mocks = vi.hoisted(() => ({
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  updateProfile: mocks.updateProfile,
  deleteProfile: mocks.deleteProfile,
}));

function profile(id: number, overrides: Partial<Profile> = {}): Profile {
  return {
    id,
    name: `Profile ${id}`,
    syncType: "local",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Profile;
}

const state = () => useProfileStore.getState();

describe("switching profile", () => {
  beforeEach(() => {
    useProfileStore.setState({
      profiles: [profile(1), profile(2)],
      activeProfileId: 1,
      currentPageIndex: 0,
      isEditMode: false,
      isDeleteMoveMode: false,
    });
  });

  it("returns to the first bank, because the new profile may not have the old one", () => {
    // Banks 11-20 are opt-in per profile: `setCurrentPageIndex` refuses any
    // index >= 10 the active profile has no page metadata for. A profile
    // switch bypassed that check entirely, so bank 16 in a profile that has it
    // survived into one that does not — 48 empty pads, no bank tab selected,
    // and in edit mode a drop wrote a padConfiguration at a pageIndex with no
    // matching pageMetadata, which no tab is ever drawn for.
    useProfileStore.setState({ currentPageIndex: 15 });

    state().setActiveProfileId(2);

    expect(state().currentPageIndex).toBe(0);
  });

  it("leaves the bank alone when the same profile is selected again", () => {
    useProfileStore.setState({ currentPageIndex: 15 });

    state().setActiveProfileId(1);

    expect(state().currentPageIndex).toBe(15);
  });

  it("changes nothing at all for a profile that is not in the store", () => {
    useProfileStore.setState({ currentPageIndex: 4 });

    state().setActiveProfileId(99);

    expect(state().activeProfileId).toBe(1);
    expect(state().currentPageIndex).toBe(4);
  });

  it("returns to the first bank when the profile is cleared", () => {
    useProfileStore.setState({ currentPageIndex: 15 });

    state().setActiveProfileId(null);

    expect(state().currentPageIndex).toBe(0);
  });

  it("drops both edit modes on the way", () => {
    useProfileStore.setState({ isEditMode: true, isDeleteMoveMode: true });

    state().setActiveProfileId(2);

    expect(state().isEditMode).toBe(false);
    expect(state().isDeleteMoveMode).toBe(false);
  });
});

describe("deleting a profile", () => {
  beforeEach(() => {
    mocks.deleteProfile.mockReset();
    mocks.deleteProfile.mockResolvedValue(undefined);
    syncStatusActions.clearAll();
    useProfileStore.setState({
      profiles: [profile(1), profile(2)],
      activeProfileId: 1,
    });
  });

  it("forgets the profile's sync status with it", async () => {
    // `syncStatusStore.byProfileId` had no route to shrinking: `clear` and
    // `clearAll` existed and were called from nowhere outside their own test,
    // so a deleted profile's status entry outlived it for the life of the tab.
    syncStatusActions.patch(2, { activity: "error", error: "gone wrong" });

    await state().deleteProfile(2);

    expect(useSyncStatusStore.getState().byProfileId.has(2)).toBe(false);
  });

  it("leaves other profiles' statuses alone", async () => {
    syncStatusActions.patch(1, { activity: "syncing" });
    syncStatusActions.patch(2, { activity: "syncing" });

    await state().deleteProfile(2);

    expect(useSyncStatusStore.getState().byProfileId.get(1)?.activity).toBe(
      "syncing",
    );
  });

  it("keeps the status when the delete itself fails", async () => {
    mocks.deleteProfile.mockRejectedValue(new Error("locked"));
    syncStatusActions.patch(2, { activity: "error", error: "gone wrong" });

    await expect(state().deleteProfile(2)).rejects.toThrow("locked");

    expect(useSyncStatusStore.getState().byProfileId.has(2)).toBe(true);
  });
});

describe("whether the active profile may be edited", () => {
  it("says no while the profile behind the rehydrated id is still loading", () => {
    // `activeProfileId` comes back from localStorage synchronously at store
    // creation; `profiles` stays empty until fetchProfiles() resolves. Answering
    // "yes" for that window let Shift enter edit mode and a drop be accepted on
    // a followed or view-only profile, with no banner to explain it — and those
    // are the edits the next sync destroys.
    useProfileStore.setState({
      profiles: [],
      activeProfileId: 7,
      isLoading: true,
    });

    expect(state().canEditActiveProfile()).toBe(false);
  });

  it("says yes when no profile is selected at all", () => {
    useProfileStore.setState({
      profiles: [],
      activeProfileId: null,
      isLoading: true,
    });

    expect(state().canEditActiveProfile()).toBe(true);
  });

  it("says yes once a local profile has actually loaded", () => {
    useProfileStore.setState({
      profiles: [profile(7)],
      activeProfileId: 7,
      isLoading: false,
    });

    expect(state().canEditActiveProfile()).toBe(true);
  });

  it("says no for a followed profile", () => {
    useProfileStore.setState({
      profiles: [
        profile(7, {
          syncType: "server",
          serverProfileId: "abc",
          followOnly: true,
        } as Partial<Profile>),
      ],
      activeProfileId: 7,
      isLoading: false,
    });

    expect(state().canEditActiveProfile()).toBe(false);
  });

  it("refuses to enter any editing mode on a followed profile", () => {
    // The predicate above was tested thoroughly and none of its three
    // consumers were, so all three guards could be deleted with the whole
    // suite green — the repo's own recorded shape, a rule tested and the code
    // using it not. A followed profile put into edit or delete/move mode
    // produces exactly the edits the next sync destroys.
    useProfileStore.setState({
      profiles: [
        profile(7, {
          syncType: "server",
          serverProfileId: "abc",
          followOnly: true,
        } as Partial<Profile>),
      ],
      activeProfileId: 7,
      isLoading: false,
      isEditMode: false,
      isDeleteMoveMode: false,
    });

    state().setEditMode(true);
    expect(state().isEditMode).toBe(false);

    state().setDeleteMoveMode(true);
    expect(state().isDeleteMoveMode).toBe(false);

    state().toggleDeleteMoveMode();
    expect(state().isDeleteMoveMode).toBe(false);
  });

  it("still lets an ordinary profile into those modes", () => {
    // The other side, so a pass above cannot mean "these setters do nothing".
    useProfileStore.setState({
      profiles: [profile(7)],
      activeProfileId: 7,
      isLoading: false,
      isEditMode: false,
      isDeleteMoveMode: false,
    });

    state().setEditMode(true);
    expect(state().isEditMode).toBe(true);

    state().setDeleteMoveMode(true);
    expect(state().isDeleteMoveMode).toBe(true);
  });
});

describe("reporting a failed write", () => {
  const alerts: string[] = [];
  const originalAlert = globalThis.alert;

  beforeEach(() => {
    alerts.length = 0;
    globalThis.alert = ((message: string) => {
      alerts.push(message);
    }) as typeof globalThis.alert;
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.updateProfile.mockReset();

    useProfileStore.setState({
      profiles: [profile(1)],
      activeProfileId: 1,
    });
  });

  afterEach(() => {
    globalThis.alert = originalAlert;
    vi.restoreAllMocks();
  });

  it("keeps no error channel of its own", () => {
    // Seventeen actions used to compose a message into `state.error`, and
    // nothing anywhere selected it. A field that looks like error handling and
    // is read by nobody is worse than either surfacing it or dropping it: it
    // makes a swallowed failure look handled.
    expect("error" in state()).toBe(false);
  });

  it("tells the user when the loudness settings cannot be saved", async () => {
    // The only failure in this store with no other symptom. Every other action
    // throws to a caller that reports it; this one is called as
    // `void setNormalisation(...)` from a checkbox and a slider, so without
    // this the control simply snaps back with no explanation.
    mocks.updateProfile.mockRejectedValue(new Error("QuotaExceededError"));

    await state().setNormalisation({ enabled: true, targetLufs: -18 });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("QuotaExceededError");
  });

  it("leaves the profile untouched when the write fails", async () => {
    mocks.updateProfile.mockRejectedValue(new Error("nope"));

    await state().setNormalisation({ enabled: true, targetLufs: -18 });

    expect(state().profiles[0].normalisation).toBeUndefined();
  });

  it("says nothing when the write succeeds", async () => {
    mocks.updateProfile.mockResolvedValue(undefined);

    await state().setNormalisation({ enabled: true, targetLufs: -18 });

    expect(alerts).toHaveLength(0);
    expect(state().profiles[0].normalisation).toEqual({
      enabled: true,
      targetLufs: -18,
    });
  });
});

describe("bank selection", () => {
  let profileId: number;

  beforeEach(async () => {
    await clearAllStores();
    const { addProfile } = await import("@/lib/db");
    profileId = await addProfile({ name: "Board", syncType: "local" });
    useProfileStore.setState({
      profiles: [profile(profileId)],
      activeProfileId: profileId,
      banks: [],
      currentBankId: null,
      currentPageIndex: 0,
    });
  });

  it("selects by position and reports the identity", async () => {
    const store = useProfileStore.getState();
    await store.loadBanks(profileId);

    useProfileStore.getState().setCurrentPageIndex(3);

    expect(useProfileStore.getState().currentPageIndex).toBe(2);
    expect(useProfileStore.getState().currentBankId).toBe("2");
  });

  it("selects position 9 (bank 10) when given the literal bank number 10", async () => {
    // `convertIndexToBankNumber(9)` returns the literal `10` — that is what
    // every tab-strip click handler hands `setCurrentPageIndex` after
    // resolving a bank id to its position. `convertBankNumberToIndex` used to
    // recognise only `0` for bank 10 (the digit-key spelling), so a literal
    // `10` fell through to -1 and this call was silently rejected: clicking
    // the tenth tab left the store on whatever bank was already selected.
    const store = useProfileStore.getState();
    await store.loadBanks(profileId);

    useProfileStore.getState().setCurrentPageIndex(10);

    expect(useProfileStore.getState().currentPageIndex).toBe(9);
    expect(useProfileStore.getState().currentBankId).toBe("9");
  });

  it("keeps the view on the same bank when the order changes", async () => {
    const { reorderBanks } = await import("@/lib/db");
    const store = useProfileStore.getState();
    await store.loadBanks(profileId);
    useProfileStore.getState().setCurrentPageIndex(3);

    // Move the selected bank to the front.
    await reorderBanks(profileId, ["2", "0", "1"]);
    await useProfileStore.getState().loadBanks(profileId);

    expect(useProfileStore.getState().currentBankId).toBe("2");
    expect(useProfileStore.getState().currentPageIndex).toBe(0);
  });

  it("refuses a position that holds no bank", async () => {
    const store = useProfileStore.getState();
    await store.loadBanks(profileId);

    useProfileStore.getState().setCurrentPageIndex(15);

    expect(useProfileStore.getState().currentBankId).toBe("0");
  });
});
