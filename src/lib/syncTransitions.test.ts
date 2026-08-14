import { describe, expect, it } from "vitest";
import type { AudioLocation, Profile } from "@/lib/db";
import {
  getSyncState,
  isChoosablePair,
  isLegalPair,
  type SyncTarget,
} from "@/lib/syncState";
import {
  planTransition,
  type SyncDestination,
  type TransitionPlan,
} from "@/lib/syncTransitions";

const NOW = 1_700_000_000_000;

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

const LOCAL = profile({ syncType: "local", audioLocation: "local" });

const DRIVE = profile({
  syncType: "googleDrive",
  audioLocation: "googleDrive",
  googleDriveFileId: "file-1",
  googleDriveFolderId: "folder-1",
});

const SERVER_DRIVE_AUDIO = profile({
  syncType: "server",
  audioLocation: "googleDrive",
  serverProfileId: "srv-1",
  serverVersion: 7,
  serverRole: "owner",
  googleDriveFolderId: "folder-1",
});

const SERVER_HOSTED_AUDIO = profile({
  syncType: "server",
  audioLocation: "server",
  serverProfileId: "srv-1",
  serverVersion: 7,
  serverRole: "owner",
});

const STARTS: Record<string, Profile> = {
  local: LOCAL,
  drive: DRIVE,
  "server + drive audio": SERVER_DRIVE_AUDIO,
  "server + hosted audio": SERVER_HOSTED_AUDIO,
};

const TARGETS: SyncTarget[] = ["local", "googleDrive", "server"];
const AUDIO: AudioLocation[] = ["local", "googleDrive", "server"];

const to = (target: SyncTarget, audio: AudioLocation): SyncDestination => ({
  target,
  audio,
});

/**
 * The profile a plan leaves behind. Most assertions are about this rather than
 * about `fieldUpdates`, because a plan is right when the profile ends up in
 * the right state — writing a null over a field that was already empty is
 * noise, not correctness.
 */
const applied = (from: Profile, plan: TransitionPlan): Profile =>
  ({ ...from, ...plan.fieldUpdates }) as Profile;

describe("planTransition — refusals", () => {
  it("refuses an incoherent pair and says why", () => {
    const plan = planTransition(LOCAL, to("googleDrive", "server"));
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBeTruthy();
    expect(plan.fieldUpdates).toEqual({});
  });

  it("refuses to publish someone else's profile under our own account", () => {
    const viewer = profile({
      syncType: "server",
      serverProfileId: "srv-1",
      serverShareToken: "tok",
      serverRole: "viewer",
      readOnly: true,
    });
    const plan = planTransition(viewer, to("googleDrive", "googleDrive"));
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/shared with you/i);
  });

  it("still lets a collaborator disconnect", () => {
    const viewer = profile({
      syncType: "server",
      serverProfileId: "srv-1",
      serverShareToken: "tok",
      serverRole: "viewer",
      readOnly: true,
    });
    expect(planTransition(viewer, to("local", "local")).ok).toBe(true);
  });

  it("lets a legacy profile of unknown ownership act", () => {
    // Refusing here would strand every server profile written before
    // serverRole existed.
    const legacy = profile({ syncType: "server", serverProfileId: "srv-1" });
    expect(planTransition(legacy, to("googleDrive", "googleDrive")).ok).toBe(
      true,
    );
  });

  it("accepts a no-op and asks for nothing", () => {
    const plan = planTransition(DRIVE, to("googleDrive", "googleDrive"));
    expect(plan.ok).toBe(true);
    expect(plan.fieldUpdates).toEqual({});
    expect(plan.effects).toEqual([]);
  });
});

describe("planTransition — the specific moves", () => {
  it("local → Drive hands the upload to the sync engine", () => {
    const plan = planTransition(LOCAL, to("googleDrive", "googleDrive"));
    expect(plan.fieldUpdates).toMatchObject({
      syncType: "googleDrive",
      audioLocation: "googleDrive",
      readOnly: false,
    });
    // Not a hand-rolled upload: syncProfile creates the folder and uploads
    // into it, which is what the old "Sync to Google Drive" button skipped.
    expect(plan.effects).toContain("driveSyncNow");
  });

  it("local → server keeps the audio choice it was given", () => {
    const plan = planTransition(LOCAL, to("server", "server"));
    expect(plan.fieldUpdates).toMatchObject({
      syncType: "server",
      audioLocation: "server",
    });
    expect(plan.effects).toContain("serverSyncNow");
    expect(plan.effects).not.toContain("ensureDriveFolder");
  });

  it("local → server with Drive audio asks for a folder first", () => {
    const plan = planTransition(LOCAL, to("server", "googleDrive"));
    expect(plan.effects.indexOf("ensureDriveFolder")).toBeLessThan(
      plan.effects.indexOf("serverSyncNow"),
    );
  });

  it("Drive → server keeps the folder but drops the profile file", () => {
    const plan = planTransition(DRIVE, to("server", "googleDrive"));
    expect(plan.ok).toBe(true);
    // The folder is where the audio lives and the server sync still uploads
    // into it.
    expect(plan.fieldUpdates.googleDriveFolderId).toBeUndefined();
    // The stale profile JSON must not be relinked by find-by-name on a later
    // Drive sync.
    expect(plan.fieldUpdates.googleDriveFileId).toBeNull();
    expect(plan.confirmations.join(" ")).toMatch(/Google Drive/i);
  });

  it("server → Drive leaves no server bookkeeping and offers to tidy up", () => {
    const plan = planTransition(
      SERVER_DRIVE_AUDIO,
      to("googleDrive", "googleDrive"),
    );
    const after = applied(SERVER_DRIVE_AUDIO, plan);
    expect(after.syncType).toBe("googleDrive");
    expect(after.serverProfileId ?? null).toBeNull();
    expect(after.serverVersion ?? null).toBeNull();
    expect(after.serverShareToken ?? null).toBeNull();
    expect(after.serverRole ?? null).toBeNull();
    expect(plan.effects).toContain("offerDeleteServerProfile");
  });

  it("disconnecting clears both backends and the audio mapping", () => {
    const plan = planTransition(SERVER_DRIVE_AUDIO, to("local", "local"));
    const after = applied(SERVER_DRIVE_AUDIO, plan);
    expect(after).toMatchObject({
      syncType: "local",
      audioLocation: "local",
      readOnly: false,
    });
    expect(after.googleDriveFileId ?? null).toBeNull();
    expect(after.googleDriveFolderId ?? null).toBeNull();
    expect(after.serverProfileId ?? null).toBeNull();
    expect(after.serverVersion ?? null).toBeNull();
    expect(after.serverShareToken ?? null).toBeNull();
    expect(after.serverRole ?? null).toBeNull();
    expect(plan.effects).toContain("clearAudioDriveIds");
  });

  it("switching audio to hosted leaves the Drive mapping alone", () => {
    // Reverting must stay instant: re-linking would re-upload everything and
    // leave duplicates in the folder. The blob is gated instead.
    const plan = planTransition(SERVER_DRIVE_AUDIO, to("server", "server"));
    expect(plan.fieldUpdates).toEqual({ audioLocation: "server" });
    expect(plan.effects).not.toContain("clearAudioDriveIds");
  });

  it("switching audio to device-only does clear the Drive mapping", () => {
    const plan = planTransition(SERVER_DRIVE_AUDIO, to("server", "local"));
    expect(plan.fieldUpdates).toMatchObject({
      audioLocation: "local",
      googleDriveFolderId: null,
    });
    expect(plan.effects).toContain("clearAudioDriveIds");
    // Reversible, so it is stated rather than gated on.
    expect(plan.warnings.join(" ")).toMatch(/collaborator/i);
    expect(plan.confirmations).toEqual([]);
  });

  it("does not offer to delete a server profile that was never adopted", () => {
    const pending = profile({ syncType: "server" });
    const plan = planTransition(pending, to("local", "local"));
    expect(plan.effects).not.toContain("offerDeleteServerProfile");
  });
});

describe("planTransition — invariants across every legal move", () => {
  const accepted: Array<{
    name: string;
    from: Profile;
    dest: SyncDestination;
    plan: ReturnType<typeof planTransition>;
  }> = [];

  for (const [name, from] of Object.entries(STARTS)) {
    for (const target of TARGETS) {
      for (const audio of AUDIO) {
        if (!isLegalPair(target, audio)) continue;
        const dest = to(target, audio);
        const plan = planTransition(from, dest);
        if (plan.ok) accepted.push({ name, from, dest, plan });
      }
    }
  }

  /** A transition that asks for the state the profile is already in. */
  const isNoop = (from: Profile, dest: SyncDestination) =>
    from.syncType === dest.target && from.audioLocation === dest.audio;

  const moves = accepted.filter(({ from, dest }) => !isNoop(from, dest));

  it("covers every start", () => {
    expect(moves.length).toBeGreaterThan(0);
    expect(new Set(moves.map((a) => a.name)).size).toBe(
      Object.keys(STARTS).length,
    );
  });

  it("writes nothing only when there is nothing to do", () => {
    for (const { name, from, dest, plan } of accepted) {
      if (Object.keys(plan.fieldUpdates).length > 0) continue;
      expect(isNoop(from, dest), `${name} → ${dest.target}/${dest.audio}`).toBe(
        true,
      );
    }
  });

  /**
   * The assertion that makes the old "Sync to Google Drive kills server sync"
   * bug unrepeatable: once the write is applied, the profile carries no
   * bookkeeping for a backend it no longer syncs to. Stated about the
   * resulting profile rather than about the write, because that is the
   * property that matters — a field that was already empty needs no null
   * written over it.
   */
  it("carries no bookkeeping for a backend it no longer syncs to", () => {
    for (const { name, from, dest, plan } of moves) {
      const label = `${name} → ${dest.target}/${dest.audio}`;
      const after = { ...from, ...plan.fieldUpdates } as Profile;

      if (dest.target !== "server") {
        for (const field of [
          "serverProfileId",
          "serverVersion",
          "serverShareToken",
          "serverRole",
        ] as const) {
          expect(after[field] ?? null, `${label}: ${field}`).toBeNull();
        }
      }
      if (dest.target !== "googleDrive") {
        expect(
          after.googleDriveFileId ?? null,
          `${label}: googleDriveFileId`,
        ).toBeNull();
      }
      // The folder is the audio home, not the sync target, so it survives a
      // move to the server — and survives a switch to hosted audio too, so
      // switching back is instant. Only "sounds stay on this device" severs it.
      if (dest.audio === "local") {
        expect(
          after.googleDriveFolderId ?? null,
          `${label}: googleDriveFolderId`,
        ).toBeNull();
      }
    }
  });

  it("keeps the Drive audio link dormant rather than severed when hosting", () => {
    const plan = planTransition(SERVER_DRIVE_AUDIO, to("server", "server"));
    const after = { ...SERVER_DRIVE_AUDIO, ...plan.fieldUpdates } as Profile;
    expect(after.googleDriveFolderId).toBe("folder-1");
  });

  it("never leaves a profile in a state it flags as defective", () => {
    for (const { name, from, dest, plan } of accepted) {
      // Only over destinations the UI can ask for. A synced profile whose
      // sounds stay on this device stays *representable* — profiles land in
      // it — but it is a defect rather than a choice, so a transition into it
      // is expected to be defective.
      if (!isChoosablePair(dest.target, dest.audio)) continue;
      const after = { ...from, ...plan.fieldUpdates } as Profile;
      // The plan's effects supply what the write alone cannot: an id from the
      // backend, and a folder. Stand those in so the check is about the
      // *fields*, not about work that has not happened yet.
      if (plan.effects.includes("serverSyncNow")) after.serverProfileId = "new";
      if (plan.effects.includes("driveSyncNow"))
        after.googleDriveFileId = "new";
      if (plan.effects.includes("ensureDriveFolder"))
        after.googleDriveFolderId = "new";

      expect(
        getSyncState(after, NOW).defects,
        `${name} → ${dest.target}/${dest.audio}`,
      ).toEqual([]);
    }
  });

  it("can roll back every field it writes", () => {
    for (const { name, plan } of accepted) {
      expect(
        Object.keys(plan.rollbackTo).sort(),
        `${name}: rollback covers the write`,
      ).toEqual(Object.keys(plan.fieldUpdates).sort());
    }
  });

  it("lands exactly where it was asked to", () => {
    for (const { name, from, dest, plan } of accepted) {
      const after = { ...from, ...plan.fieldUpdates } as Profile;
      expect(after.syncType, `${name} target`).toBe(dest.target);
      expect(after.audioLocation, `${name} audio`).toBe(dest.audio);
    }
  });
});
