import { describe, expect, it } from "vitest";
import { toWireProfile, WITHHELD_PROFILE_FIELDS } from "./profileWire";
import type { Profile } from "./db";

/** Every field a stored profile can carry, so nothing is withheld by omission. */
function fullProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 7,
    name: "Show",
    syncType: "server",
    googleDriveFileId: "drive-file",
    googleDriveFolderId: "drive-folder",
    serverProfileId: "11111111-2222-3333-4444-555555555555",
    serverVersion: 12,
    serverShareToken: "share-token-that-must-not-travel",
    serverRole: "editor",
    audioLocation: "server",
    readOnly: false,
    followOnly: false,
    activePadBehavior: "restart",
    normalisation: { enabled: true, targetLufs: -16 },
    syncPausedUntil: 1_760_000_000_000,
    lastBackedUpAt: 1_750_000_000_000,
    backupReminderPeriod: 30 * 24 * 60 * 60 * 1000,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    _created: 1_740_000_000_000,
    _modified: 1_745_000_000_000,
    _fieldsModified: { name: 1_745_000_000_000 },
    ...overrides,
  } as Profile;
}

describe("toWireProfile", () => {
  /**
   * The whole shape, not a sample of it.
   *
   * The field-by-field assertions below cover ten of the allow-list's
   * twenty-one entries, and the other eleven leaned entirely on the
   * compile-time `_everyProfileFieldIsClassified` assertion in `profileWire.ts`.
   * Deleting `readOnly`, `audioLocation`, `followOnly` and `serverVersion` from
   * the allow-list left the whole suite green — the compiler catches a field
   * that is on *neither* list, and says nothing about one quietly moved off the
   * wire, which is the same silent-data-loss shape the module exists to
   * prevent in the other direction.
   *
   * Derived from the fixture rather than from `SHAREABLE_PROFILE_FIELDS`:
   * asserting against the list the implementation iterates would only prove it
   * can read its own list. `fullProfile` is a hand-written census of every
   * field a stored profile can carry, so this says "everything a profile has,
   * except what we deliberately withhold".
   */
  it("carries every profile field except the withheld ones", () => {
    const profile = fullProfile();
    const withheld: string[] = [...WITHHELD_PROFILE_FIELDS];

    expect(Object.keys(toWireProfile(profile)).sort()).toEqual(
      Object.keys(profile)
        .filter((field) => !withheld.includes(field))
        .sort(),
    );
  });

  it.each(WITHHELD_PROFILE_FIELDS)("never carries %s", (field) => {
    // Driven off the list itself, so a field added to it is covered the moment
    // it is added rather than whenever someone remembers to write a case.
    expect(toWireProfile(fullProfile())).not.toHaveProperty(field);
  });

  it("never carries the share token", () => {
    // The token is a bearer credential: whoever holds it gets the role it was
    // issued with. It rode inside every export and every sync blob, and
    // GET /api/profiles/:id hands the blob back to viewers.
    const wire = toWireProfile(fullProfile());

    expect(wire).not.toHaveProperty("serverShareToken");
    expect(JSON.stringify(wire)).not.toContain(
      "share-token-that-must-not-travel",
    );
  });

  it("still carries lastBackedUpAt, which sync has always sent", () => {
    // Only the export path drops it, and it always did: an import stamps its
    // own, so inheriting the donor's would claim a backup that never happened.
    // Withholding it here instead would be a behaviour change dressed up as a
    // security fix.
    expect(toWireProfile(fullProfile()).lastBackedUpAt).toBe(1_750_000_000_000);
  });

  it("still carries everything sync and import rely on", () => {
    const wire = toWireProfile(fullProfile());

    // Content.
    expect(wire.name).toBe("Show");
    expect(wire.activePadBehavior).toBe("restart");
    expect(wire.normalisation).toEqual({ enabled: true, targetLufs: -16 });
    expect(wire.backupReminderPeriod).toBe(30 * 24 * 60 * 60 * 1000);
    // Sync bookkeeping the merge compares on.
    expect(wire._modified).toBe(1_745_000_000_000);
    expect(wire._fieldsModified).toEqual({ name: 1_745_000_000_000 });
    // Location fields, which the merge ignores but the blob has always carried.
    expect(wire.syncType).toBe("server");
    expect(wire.serverProfileId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("keeps the Drive ids, which are published on purpose", () => {
    // Withholding these assumed the hosting had happened; when it silently had
    // not, the blob named sounds nobody could fetch and pads were emptied.
    const wire = toWireProfile(fullProfile());

    expect(wire.googleDriveFileId).toBe("drive-file");
    expect(wire.googleDriveFolderId).toBe("drive-folder");
  });

  it("leaves an unset optional field unset rather than explicitly undefined", () => {
    // The blobs are compared field-by-field during a merge, and an explicit
    // undefined is not the same answer as "not set".
    const profile = fullProfile();
    delete profile.serverRole;

    const wire = toWireProfile(profile);

    expect("serverRole" in wire).toBe(false);
  });

  it("copies rather than aliasing the stored record", () => {
    const profile = fullProfile();
    const wire = toWireProfile(profile);

    expect(wire).not.toBe(profile);
    expect(Object.keys(wire)).not.toContain("serverShareToken");
  });
});
