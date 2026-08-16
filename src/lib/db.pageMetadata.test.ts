/**
 * Renaming a bank and flagging it as an emergency bank are separate edits and
 * must not undo one another.
 *
 * Both helpers used to read the record *outside* the write transaction and
 * then write back *both* fields, so each carried a stale copy of the other's:
 * whichever landed second reverted the first. Two people editing the same
 * profile is the ordinary case for this app, and so is one person toggling
 * emergency while a sync writes a rename.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const {
  addProfile,
  renamePage,
  setPageEmergencyState,
  getPageMetadata,
  upsertPageMetadata,
} = await import("./db");

let profileId: number;

beforeEach(async () => {
  await clearAllStores();
  profileId = await addProfile({ name: "Board", syncType: "local" });
});

describe("editing bank metadata", () => {
  it("keeps the emergency flag when the bank is renamed", async () => {
    await setPageEmergencyState(profileId, 0, true);
    await renamePage(profileId, 0, "Act One");

    const page = await getPageMetadata(profileId, 0);
    expect(page?.name).toBe("Act One");
    expect(page?.isEmergency).toBe(true);
  });

  it("keeps the name when the emergency flag is toggled", async () => {
    await renamePage(profileId, 0, "Act Two");
    await setPageEmergencyState(profileId, 0, true);

    const page = await getPageMetadata(profileId, 0);
    expect(page?.name).toBe("Act Two");
    expect(page?.isEmergency).toBe(true);
  });

  it("does not let concurrent edits revert each other", async () => {
    // Both start from the same state, as two tabs or a sync and a click would.
    await upsertPageMetadata({
      profileId,
      pageIndex: 0,
      name: "Before",
      isEmergency: false,
    });

    await Promise.all([
      renamePage(profileId, 0, "After"),
      setPageEmergencyState(profileId, 0, true),
    ]);

    const page = await getPageMetadata(profileId, 0);
    expect(page?.name).toBe("After");
    expect(page?.isEmergency).toBe(true);
  });

  it("names a bank it has to create by its bank number, not its index", async () => {
    // Bank indices are 0-based and bank *numbers* are 1-based; the fallback
    // used the index, so an auto-created bank 3 was called "Bank 2".
    await setPageEmergencyState(profileId, 2, true);

    expect((await getPageMetadata(profileId, 2))?.name).toBe("Bank 3");
  });

  it("still writes both fields when they are both given", async () => {
    await upsertPageMetadata({
      profileId,
      pageIndex: 1,
      name: "Interval",
      isEmergency: true,
    });

    const page = await getPageMetadata(profileId, 1);
    expect(page?.name).toBe("Interval");
    expect(page?.isEmergency).toBe(true);
  });
});
