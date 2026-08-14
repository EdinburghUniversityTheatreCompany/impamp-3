import { describe, expect, it } from "vitest";
import type { Profile } from "@/lib/db";
import {
  audioLocationLabel,
  getSyncState,
  isLegalPair,
  syncChipText,
  syncTargetLabel,
  type SyncDefect,
} from "@/lib/syncState";

const NOW = 1_700_000_000_000;

/**
 * A profile is a wide record with a lot of fields the sync state ignores.
 * Every test builds from this base and overrides only what it is about, so a
 * new required field on Profile breaks one line rather than forty.
 */
function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    name: "Test",
    syncType: "local",
    lastBackedUpAt: 0,
    backupReminderPeriod: 30,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

/** A profile in each of the six legal, healthy states. */
const HEALTHY: Record<string, Profile> = {
  "local / device": profile({ syncType: "local", audioLocation: "local" }),
  "drive / drive": profile({
    syncType: "googleDrive",
    audioLocation: "googleDrive",
    googleDriveFileId: "file-1",
    googleDriveFolderId: "folder-1",
  }),
  "drive / device": profile({
    syncType: "googleDrive",
    audioLocation: "local",
    googleDriveFileId: "file-1",
  }),
  "server / drive": profile({
    syncType: "server",
    audioLocation: "googleDrive",
    serverProfileId: "srv-1",
    serverRole: "owner",
    googleDriveFolderId: "folder-1",
  }),
  "server / hosted": profile({
    syncType: "server",
    audioLocation: "server",
    serverProfileId: "srv-1",
    serverRole: "owner",
  }),
  "server / device": profile({
    syncType: "server",
    audioLocation: "local",
    serverProfileId: "srv-1",
    serverRole: "owner",
  }),
};

describe("isLegalPair", () => {
  it("allows only device-only audio when the profile does not sync", () => {
    expect(isLegalPair("local", "local")).toBe(true);
    expect(isLegalPair("local", "googleDrive")).toBe(false);
    expect(isLegalPair("local", "server")).toBe(false);
  });

  it("refuses hosted audio for a Drive profile", () => {
    // A Drive blob carries no serverProfileId, so a peer has no route to
    // /api/profiles/:id/audio/:hash and could never fetch the bytes.
    expect(isLegalPair("googleDrive", "server")).toBe(false);
    expect(isLegalPair("googleDrive", "googleDrive")).toBe(true);
    expect(isLegalPair("googleDrive", "local")).toBe(true);
  });

  it("allows every audio location for a server profile", () => {
    expect(isLegalPair("server", "googleDrive")).toBe(true);
    expect(isLegalPair("server", "server")).toBe(true);
    expect(isLegalPair("server", "local")).toBe(true);
  });
});

describe("getSyncState — target and linkage", () => {
  it("reads the target straight off syncType", () => {
    expect(getSyncState(profile({ syncType: "local" }), NOW).target).toBe(
      "local",
    );
    expect(getSyncState(profile({ syncType: "googleDrive" }), NOW).target).toBe(
      "googleDrive",
    );
    expect(getSyncState(profile({ syncType: "server" }), NOW).target).toBe(
      "server",
    );
  });

  it("treats a profile as linked only once its backend has an id", () => {
    expect(getSyncState(HEALTHY["local / device"], NOW).isLinked).toBe(false);
    expect(getSyncState(HEALTHY["drive / drive"], NOW).isLinked).toBe(true);
    expect(getSyncState(HEALTHY["server / hosted"], NOW).isLinked).toBe(true);

    const halfLinked = profile({ syncType: "googleDrive" });
    expect(getSyncState(halfLinked, NOW).isLinked).toBe(false);
  });
});

describe("getSyncState — audio location", () => {
  it("uses the stored intent when it is legal for the target", () => {
    const state = getSyncState(HEALTHY["server / hosted"], NOW);
    expect(state.audio).toBe("server");
    expect(state.audioIsExplicit).toBe(true);
  });

  it("falls back to inference when the stored intent is illegal", () => {
    // Hosted audio under a Drive target cannot work; the folder decides.
    const state = getSyncState(
      profile({
        syncType: "googleDrive",
        audioLocation: "server",
        googleDriveFileId: "file-1",
        googleDriveFolderId: "folder-1",
      }),
      NOW,
    );
    expect(state.audio).toBe("googleDrive");
    expect(state.audioIsExplicit).toBe(false);
  });

  describe("legacy rows with no audioLocation", () => {
    it("infers Drive from an existing folder", () => {
      const state = getSyncState(
        profile({ syncType: "server", googleDriveFolderId: "folder-1" }),
        NOW,
      );
      expect(state.audio).toBe("googleDrive");
      expect(state.audioIsExplicit).toBe(false);
    });

    it("infers Drive for a Drive profile that has not synced yet", () => {
      // The folder is created on the first sync, so its absence is not
      // evidence that the audio lives anywhere else.
      const state = getSyncState(
        profile({ syncType: "googleDrive", googleDriveFileId: "file-1" }),
        NOW,
      );
      expect(state.audio).toBe("googleDrive");
    });

    it("infers device-only for a server profile with no Drive folder", () => {
      // This is the honest reading of today's invisible state: nothing
      // publishes the audio unless hosting happens to be switched on.
      const state = getSyncState(
        profile({ syncType: "server", serverProfileId: "srv-1" }),
        NOW,
      );
      expect(state.audio).toBe("local");
    });

    it("infers device-only for a local profile", () => {
      expect(getSyncState(profile({ syncType: "local" }), NOW).audio).toBe(
        "local",
      );
    });
  });
});

describe("getSyncState — ownership", () => {
  it("calls a link-imported profile a collaborator even with no stored role", () => {
    const state = getSyncState(
      profile({
        syncType: "server",
        serverProfileId: "srv-1",
        serverShareToken: "tok",
      }),
      NOW,
    );
    expect(state.ownership).toBe("collaborator");
  });

  it("trusts a stored role over the share-token heuristic", () => {
    // An email-invited editor has no share token, so the heuristic alone
    // would wrongly call them the owner.
    const state = getSyncState(
      profile({
        syncType: "server",
        serverProfileId: "srv-1",
        serverRole: "editor",
      }),
      NOW,
    );
    expect(state.ownership).toBe("collaborator");
  });

  it("reports unknown for a legacy server profile with neither signal", () => {
    // Callers must fall back to today's behaviour here rather than guessing:
    // "owner" would re-introduce the cross-account Drive upload, "collaborator"
    // would stop a real owner uploading at all.
    const state = getSyncState(
      profile({ syncType: "server", serverProfileId: "srv-1" }),
      NOW,
    );
    expect(state.ownership).toBe("unknown");
  });

  it("treats local and writable Drive profiles as owned", () => {
    expect(getSyncState(HEALTHY["local / device"], NOW).ownership).toBe(
      "owner",
    );
    expect(getSyncState(HEALTHY["drive / drive"], NOW).ownership).toBe("owner");
  });

  it("treats a read-only Drive profile as a collaborator", () => {
    const state = getSyncState(
      profile({
        syncType: "googleDrive",
        googleDriveFileId: "file-1",
        readOnly: true,
      }),
      NOW,
    );
    expect(state.ownership).toBe("collaborator");
    expect(state.isViewerOfSomeoneElses).toBe(true);
  });

  it("does not call a local profile someone else's, whatever readOnly says", () => {
    const state = getSyncState(
      profile({ syncType: "local", readOnly: true }),
      NOW,
    );
    expect(state.isViewerOfSomeoneElses).toBe(false);
  });
});

describe("getSyncState — pause", () => {
  it("is paused only while the deadline is in the future", () => {
    const paused = getSyncState(
      profile({ syncType: "googleDrive", syncPausedUntil: NOW + 60_000 }),
      NOW,
    );
    expect(paused.paused).toBe(true);
    expect(paused.pausedUntil).toBe(NOW + 60_000);
  });

  it("is not paused once the deadline has passed", () => {
    const expired = getSyncState(
      profile({ syncType: "googleDrive", syncPausedUntil: NOW - 1 }),
      NOW,
    );
    expect(expired.paused).toBe(false);
    expect(expired.pausedUntil).toBeNull();
  });

  it("is not paused when no deadline is set", () => {
    expect(getSyncState(HEALTHY["drive / drive"], NOW).paused).toBe(false);
  });
});

describe("detectDefects, via getSyncState", () => {
  const defectsOf = (p: Profile): SyncDefect[] => getSyncState(p, NOW).defects;

  it("finds no defect in any healthy state", () => {
    for (const [name, p] of Object.entries(HEALTHY)) {
      expect(defectsOf(p), `${name} should be clean`).toEqual([]);
    }
  });

  it("flags a Drive profile with no file (the half-finished unlink)", () => {
    expect(defectsOf(profile({ syncType: "googleDrive" }))).toContain(
      "drive-linked-but-no-file",
    );
  });

  it("flags server bookkeeping left behind on a Drive profile", () => {
    expect(
      defectsOf(
        profile({
          syncType: "googleDrive",
          googleDriveFileId: "file-1",
          serverProfileId: "srv-1",
        }),
      ),
    ).toContain("stale-server-link");
  });

  it("flags Drive bookkeeping left behind on a local profile", () => {
    expect(
      defectsOf(
        profile({ syncType: "local", googleDriveFolderId: "folder-1" }),
      ),
    ).toContain("stale-drive-link");
  });

  it("flags a server profile that never reached the server", () => {
    expect(defectsOf(profile({ syncType: "server" }))).toContain(
      "server-awaiting-first-sync",
    );
  });

  it("flags a collaborator holding the owner's Drive ids", () => {
    // The state a share-link import produces today. It makes an editor try to
    // write into the owner's Drive folder, which fails silently.
    expect(
      defectsOf(
        profile({
          syncType: "server",
          serverProfileId: "srv-1",
          serverShareToken: "tok",
          googleDriveFolderId: "folder-1",
        }),
      ),
    ).toContain("borrowed-drive-folder");
  });

  it("does not call the owner's own Drive folder borrowed", () => {
    expect(defectsOf(HEALTHY["server / drive"])).not.toContain(
      "borrowed-drive-folder",
    );
  });

  it("flags a linked server profile publishing to Drive with no folder", () => {
    // Nothing creates the folder on the server path, so this silently never
    // uploads.
    expect(
      defectsOf(
        profile({
          syncType: "server",
          audioLocation: "googleDrive",
          serverProfileId: "srv-1",
          serverRole: "owner",
        }),
      ),
    ).toContain("audio-drive-without-folder");
  });

  it("stays quiet about the missing folder before the first sync", () => {
    // "You haven't synced yet" is the useful message; the folder is downstream
    // of that and repeating it is noise.
    const defects = defectsOf(
      profile({ syncType: "server", audioLocation: "googleDrive" }),
    );
    expect(defects).toContain("server-awaiting-first-sync");
    expect(defects).not.toContain("audio-drive-without-folder");
  });

  it("stays quiet about the missing folder for a read-only profile", () => {
    expect(
      defectsOf(
        profile({
          syncType: "server",
          audioLocation: "googleDrive",
          serverProfileId: "srv-1",
          serverRole: "viewer",
          readOnly: true,
        }),
      ),
    ).not.toContain("audio-drive-without-folder");
  });
});

describe("labels", () => {
  it("names each sync target", () => {
    expect(syncTargetLabel("local")).toBe("This device only");
    expect(syncTargetLabel("googleDrive")).toBe("Google Drive");
    expect(syncTargetLabel("server")).toBe("ImpAmp server");
  });

  it("names each audio location", () => {
    expect(audioLocationLabel("googleDrive")).toBe("Google Drive folder");
    expect(audioLocationLabel("server")).toBe("ImpAmp server (hosted)");
    expect(audioLocationLabel("local")).toBe("This device only");
  });
});

describe("syncChipText", () => {
  it("says only that a local profile is local", () => {
    expect(
      syncChipText(getSyncState(HEALTHY["local / device"], NOW), null),
    ).toBe("This device only");
  });

  it("names the backend and when it last synced", () => {
    expect(
      syncChipText(
        getSyncState(HEALTHY["drive / drive"], NOW),
        "2 minutes ago",
      ),
    ).toBe("Google Drive · synced 2 minutes ago");
  });

  it("spells out where the sounds live on a server profile", () => {
    expect(
      syncChipText(
        getSyncState(HEALTHY["server / drive"], NOW),
        "2 minutes ago",
      ),
    ).toBe("ImpAmp server · sounds in Drive · synced 2 minutes ago");
  });

  it("says plainly when a synced profile keeps its sounds to itself", () => {
    // The state that is completely invisible today.
    expect(
      syncChipText(getSyncState(HEALTHY["server / device"], NOW), null),
    ).toBe("ImpAmp server · sounds stay on this device");
  });

  it("leads with view-only rather than a sync time", () => {
    const viewer = getSyncState(
      profile({
        syncType: "server",
        audioLocation: "server",
        serverProfileId: "srv-1",
        serverRole: "viewer",
        readOnly: true,
      }),
      NOW,
    );
    expect(syncChipText(viewer, "2 minutes ago")).toBe(
      "ImpAmp server · view only",
    );
  });

  it("says when you are following, since it explains why editing is off", () => {
    const followed = getSyncState(
      profile({
        syncType: "googleDrive",
        audioLocation: "googleDrive",
        googleDriveFileId: "file-1",
        googleDriveFolderId: "folder-1",
        followOnly: true,
      }),
      NOW,
    );
    expect(syncChipText(followed, "2 minutes ago")).toBe(
      "Google Drive · following",
    );
  });

  it("leads with the pause, since nothing is syncing", () => {
    const paused = getSyncState(
      profile({
        syncType: "googleDrive",
        audioLocation: "googleDrive",
        googleDriveFileId: "file-1",
        googleDriveFolderId: "folder-1",
        syncPausedUntil: NOW + 60_000,
      }),
      NOW,
    );
    expect(syncChipText(paused, "2 minutes ago")).toBe("Google Drive · paused");
  });

  it("leads with a defect, since it needs a decision", () => {
    const broken = getSyncState(profile({ syncType: "googleDrive" }), NOW);
    expect(syncChipText(broken, null)).toBe("Google Drive · needs attention");
  });
});

/**
 * Following is a decision; read-only is a permission. Keeping them apart is
 * the whole point: the Drive reconciler rewrites `readOnly` in both directions
 * on every sync, so a preference stored there is cleared by the first sync of
 * any folder you happen to have write access to — which is exactly what the
 * old "Read-only" checkbox did.
 */
describe("following", () => {
  it("is off unless chosen", () => {
    expect(getSyncState(HEALTHY["drive / drive"], NOW).following).toBe(false);
  });

  it("makes a profile read-only even where the remote would allow writes", () => {
    const followed = profile({
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      googleDriveFolderId: "folder-1",
      followOnly: true,
      readOnly: false,
    });

    const state = getSyncState(followed, NOW);
    expect(state.following).toBe(true);
    expect(state.readOnly).toBe(true);
    expect(state.canEdit).toBe(false);
  });

  it("still reports read-only when the remote refuses writes", () => {
    const viewer = profile({
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "viewer",
      readOnly: true,
    });

    const state = getSyncState(viewer, NOW);
    expect(state.following).toBe(false);
    expect(state.readOnly).toBe(true);
    expect(state.canEdit).toBe(false);
  });

  it("lets you edit a profile you can push to and have not followed", () => {
    expect(getSyncState(HEALTHY["drive / drive"], NOW).canEdit).toBe(true);
    expect(getSyncState(HEALTHY["local / device"], NOW).canEdit).toBe(true);
  });

  it("does not call a followed profile someone else's", () => {
    // Following your own board is a choice about contributing, not a
    // statement that it belongs to somebody else.
    const followed = profile({
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      followOnly: true,
    });
    expect(getSyncState(followed, NOW).isViewerOfSomeoneElses).toBe(false);
    expect(getSyncState(followed, NOW).ownership).toBe("owner");
  });

  it("can be unfollowed only where the remote would accept writes", () => {
    const followedOwner = profile({
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      followOnly: true,
    });
    expect(getSyncState(followedOwner, NOW).canUnfollow).toBe(true);

    const followedViewer = profile({
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "viewer",
      readOnly: true,
      followOnly: true,
    });
    // Unfollowing would promise writes the server will refuse.
    expect(getSyncState(followedViewer, NOW).canUnfollow).toBe(false);
  });
});
