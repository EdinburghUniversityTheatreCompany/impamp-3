import { describe, expect, it } from "vitest";
import type { Profile } from "@/lib/db";
import { buildImportedProfileFields } from "@/lib/importExport";

/**
 * An import must never inherit where the *donor* profile synced.
 *
 * It used to. A server share link produced a profile marked `server` while
 * holding the owner's Drive ids, which made this device try to publish audio
 * into someone else's Drive folder — silently, because those upload failures
 * are non-fatal. An ordinary file import produced a second local profile
 * pointing at the same Drive file as the first, and the two then fought over
 * it.
 */

const NOW = new Date(1_700_000_000_000);
const DEFAULT_REMINDER = 30 * 24 * 60 * 60 * 1000;

/** A profile that syncs somewhere and carries every location field. */
const donor: Partial<Profile> = {
  name: "Someone Else's Board",
  syncType: "googleDrive",
  googleDriveFileId: "their-file",
  googleDriveFolderId: "their-folder",
  audioLocation: "server",
  serverProfileId: "their-server-id",
  serverShareToken: "their-token",
  serverRole: "owner",
  readOnly: true,
  backupReminderPeriod: 999,
  activePadBehavior: "stop",
  normalisation: { enabled: false, targetLufs: -20 },
};

const build = (link = {}) =>
  buildImportedProfileFields(donor, "My Copy", NOW, DEFAULT_REMINDER, link);

describe("buildImportedProfileFields", () => {
  it("gives a plain import a local, unlinked profile", () => {
    const fields = build();

    expect(fields.syncType).toBe("local");
    expect(fields.googleDriveFileId).toBeNull();
    expect(fields.googleDriveFolderId).toBeNull();
    expect(fields.audioLocation).toBeNull();
  });

  it("never carries the donor's server bookkeeping", () => {
    const fields = build() as Partial<Profile>;

    expect(fields.serverProfileId ?? null).toBeNull();
    expect(fields.serverShareToken ?? null).toBeNull();
    expect(fields.serverRole ?? null).toBeNull();
  });

  it("does not inherit the donor's read-only flag", () => {
    // Read-only describes *their* access to *their* copy. A local import is
    // ours to edit.
    expect((build() as Partial<Profile>).readOnly ?? false).toBe(false);
  });

  it("takes the link the caller asked for", () => {
    const fields = build({
      syncType: "googleDrive" as const,
      audioLocation: "googleDrive" as const,
      googleDriveFileId: "my-file",
      googleDriveFolderId: "my-folder",
    });

    expect(fields.syncType).toBe("googleDrive");
    expect(fields.audioLocation).toBe("googleDrive");
    expect(fields.googleDriveFileId).toBe("my-file");
    expect(fields.googleDriveFolderId).toBe("my-folder");
  });

  it("gives a server share link no Drive ids at all", () => {
    // The exact shape /server/open asks for. The payload carries the owner's
    // folder; the recipient must not adopt it.
    const fields = build({ syncType: "server" as const });

    expect(fields.syncType).toBe("server");
    expect(fields.googleDriveFileId).toBeNull();
    expect(fields.googleDriveFolderId).toBeNull();
  });

  it("keeps the content the donor legitimately passes on", () => {
    const fields = build();

    expect(fields.name).toBe("My Copy");
    expect(fields.activePadBehavior).toBe("stop");
    expect(fields.backupReminderPeriod).toBe(999);
    expect(fields.normalisation).toEqual({ enabled: false, targetLufs: -20 });
  });

  it("falls back to the default reminder period", () => {
    const fields = buildImportedProfileFields(
      { name: "x" },
      "My Copy",
      NOW,
      DEFAULT_REMINDER,
    );

    expect(fields.backupReminderPeriod).toBe(DEFAULT_REMINDER);
  });

  it("stamps the import time rather than the donor's last backup", () => {
    const fields = build();

    expect(fields.lastBackedUpAt).toBe(NOW.getTime());
    expect(fields.createdAt).toBe(NOW);
  });
});
