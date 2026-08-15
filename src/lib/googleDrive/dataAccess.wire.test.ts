/**
 * `getLocalProfileSyncData` — what the blob this device publishes actually
 * contains.
 *
 * `profileWire.test.ts` pins the allow-list itself. This pins the call site:
 * the blob is what Drive receives, what `PUT /api/profiles/:id` stores, and
 * what `GET /api/profiles/:id` hands back verbatim to anyone allowed to *read*
 * the profile. So a credential reaching this object is a credential reaching
 * every viewer, and it is worth asserting against the real database rather
 * than trusting the type.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const { getLocalProfileSyncData } = await import("./dataAccess");
const { getDb } = await import("@/lib/db");

const SHARE_TOKEN = "tok-a-viewer-must-never-see";

/** A profile joined by share link, so it holds an editor's bearer token. */
const collaboratorProfile = {
  name: "Show board",
  syncType: "server" as const,
  audioLocation: "googleDrive" as const,
  googleDriveFileId: "drive-file",
  googleDriveFolderId: "drive-folder",
  serverProfileId: "srv-1",
  serverVersion: 7,
  serverShareToken: SHARE_TOKEN,
  serverRole: "editor" as const,
  readOnly: false,
  followOnly: false,
  lastBackedUpAt: 123,
  backupReminderPeriod: 456,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

let profileId: number;

beforeEach(async () => {
  await clearAllStores();
  const db = await getDb();
  // autoIncrement keeps climbing across suites, so key off what the store
  // hands back rather than a literal.
  profileId = (await db.add("profiles", collaboratorProfile)) as number;
});

describe("the published sync blob", () => {
  it("does not contain the share token anywhere", async () => {
    const blob = await getLocalProfileSyncData(profileId);

    expect(blob).not.toBeNull();
    expect(blob!.profile).not.toHaveProperty("serverShareToken");
    // Belt and braces: the whole serialised blob, not just the field, since
    // this is the object that goes over the wire.
    expect(JSON.stringify(blob)).not.toContain(SHARE_TOKEN);
  });

  it("still describes where the profile syncs", async () => {
    // The location fields are carried on purpose — the merge ignores them, but
    // dropping them here would be a different change wearing this one's badge.
    const blob = await getLocalProfileSyncData(profileId);

    expect(blob!.profile.serverProfileId).toBe("srv-1");
    expect(blob!.profile.googleDriveFileId).toBe("drive-file");
    expect(blob!.profile.googleDriveFolderId).toBe("drive-folder");
    expect(blob!.profile.name).toBe("Show board");
  });
});
