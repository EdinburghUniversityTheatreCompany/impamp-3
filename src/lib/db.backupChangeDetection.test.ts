/**
 * The backup reminder must fire for what the *user* changed, and stay quiet
 * for what the app wrote on its own.
 *
 * Banks 1-10 used to be synthesised in the page component, so a profile
 * nobody had edited held no `pageMetadata` rows at all and the reminder's
 * "has anything changed?" check had nothing to look at. Since v7 the ten
 * default banks are real rows, materialised by `ensureDefaultBanks` and by
 * the migration's materialise pass, both stamped `Date.now()`. Left
 * unqualified that makes every profile read as edited the moment it is
 * opened after an upgrade, and every user is nagged for a backup of changes
 * they never made.
 *
 * The rows still have to *sync* — materialising a bank is a real change to
 * the profile's data — so the fix cannot be to stop stamping them. It is
 * `hasProfileChangedSince` that has to tell housekeeping from an edit, the
 * same way `BACKUP_ONLY_FIELDS` already does for the profile record.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const {
  addProfile,
  createBank,
  ensureDefaultBanks,
  getAllPageMetadataForProfile,
  getDb,
  hasProfileChangedSince,
  renameBank,
  reorderBanks,
  setBankEmergencyState,
  upsertPadConfiguration,
} = await import("./db");

let profileId: number;

/**
 * Waits for the clock to move on.
 *
 * Every stamp here is `Date.now()`, so a write and the `since` it is compared
 * against can land on the same millisecond and make a strict `>` read as
 * "unchanged" by luck. Letting real time pass first is what makes the
 * positive cases below fail for the reason they name.
 */
async function nextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() <= start) await new Promise((r) => setTimeout(r, 1));
}

/** The moment a backup finished: after the fixture, before the test's edit. */
async function backupPoint(): Promise<number> {
  await nextMillisecond();
  const at = Date.now();
  await nextMillisecond();
  return at;
}

beforeEach(async () => {
  await clearAllStores();
  profileId = await addProfile({ name: "Board", syncType: "local" });
});

describe("hasProfileChangedSince", () => {
  it("does not count the default banks the app materialises for itself", async () => {
    const backedUpAt = await backupPoint();

    // Exactly what opening the profile does after an upgrade: the ten
    // default banks appear as rows for the first time.
    await ensureDefaultBanks(profileId);

    expect(await hasProfileChangedSince(profileId, backedUpAt)).toBe(false);
  });

  it("counts a bank the user renamed", async () => {
    await ensureDefaultBanks(profileId);
    const backedUpAt = await backupPoint();

    await renameBank(profileId, "2", "Act One");

    expect(await hasProfileChangedSince(profileId, backedUpAt)).toBe(true);
  });

  it("counts a bank the user flagged as an emergency bank", async () => {
    await ensureDefaultBanks(profileId);
    const backedUpAt = await backupPoint();

    await setBankEmergencyState(profileId, "2", true);

    expect(await hasProfileChangedSince(profileId, backedUpAt)).toBe(true);
  });

  it("counts a reorder, which moves banks away from their default slots", async () => {
    const before = (await ensureDefaultBanks(profileId)).map((b) => b.bankId);
    const backedUpAt = await backupPoint();

    await reorderBanks(profileId, ["1", "0", ...before.slice(2)]);

    expect(await hasProfileChangedSince(profileId, backedUpAt)).toBe(true);
  });

  it("counts a bank the user added", async () => {
    await ensureDefaultBanks(profileId);
    const backedUpAt = await backupPoint();

    await createBank(profileId, "Bank 11");

    expect(await hasProfileChangedSince(profileId, backedUpAt)).toBe(true);
  });

  it("counts a pad the user edited, even in an otherwise untouched profile", async () => {
    await ensureDefaultBanks(profileId);
    const backedUpAt = await backupPoint();

    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 3,
      keyBinding: "q",
      name: "Applause",
      audioFileIds: [1],
      playbackType: "sequential",
    });

    expect(await hasProfileChangedSince(profileId, backedUpAt)).toBe(true);
  });

  it("counts an edit the user later undid", async () => {
    await ensureDefaultBanks(profileId);
    const backedUpAt = await backupPoint();

    await renameBank(profileId, "2", "Act One");
    await nextMillisecond();
    await renameBank(profileId, "2", "Bank 3");

    // The content is back to the default, so only the sync stamps can tell
    // this row apart from one nobody ever opened. They can: `_modified` has
    // moved past `_created`, and the archive this profile would export is not
    // the archive that was backed up.
    expect(await hasProfileChangedSince(profileId, backedUpAt)).toBe(true);
  });

  // `hasProfileChangedSince` reads rows that reach IndexedDB from imports,
  // sync merges and old migrations, not only from this file's write helpers,
  // and those can hand it a row whose `_modified` is absent or equal to
  // `_created` while its content is plainly a user's. Seeded directly for
  // that reason: no local helper produces this shape, which is exactly why
  // the check cannot lean on the stamps alone. One row per user-owned
  // content field, so each is covered on its own rather than riding on its
  // neighbour.
  it.each([
    { what: "a name the user chose", patch: { name: "Act One" } },
    { what: "the emergency flag", patch: { isEmergency: true } },
  ])(
    "counts $what on a row whose sync stamps claim it was never modified",
    async ({ patch }) => {
      await ensureDefaultBanks(profileId);
      const backedUpAt = await backupPoint();

      const db = await getDb();
      const bank = (await getAllPageMetadataForProfile(profileId)).find(
        (b) => b.pageIndex === 2,
      )!;
      const at = Date.now();
      await db.put("pageMetadata", {
        ...bank,
        ...patch,
        updatedAt: new Date(at),
        _created: at,
        _modified: at,
      });

      expect(await hasProfileChangedSince(profileId, backedUpAt)).toBe(true);
    },
  );

  it("still sees a bank whose name was edited to something else entirely", async () => {
    await ensureDefaultBanks(profileId);
    const backedUpAt = await backupPoint();

    // A rename to the *neighbouring* bank's default name: the row no longer
    // matches the default for the position it sits at, so it is an edit.
    const banks = await getAllPageMetadataForProfile(profileId);
    const third = banks.find((b) => b.pageIndex === 2)!;
    await renameBank(profileId, third.bankId, "Bank 9");

    expect(await hasProfileChangedSince(profileId, backedUpAt)).toBe(true);
  });
});
