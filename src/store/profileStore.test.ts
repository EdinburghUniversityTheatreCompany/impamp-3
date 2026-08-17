import { beforeEach, describe, expect, it } from "vitest";
import { useProfileStore } from "@/store/profileStore";
import type { Profile } from "@/lib/db";

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
