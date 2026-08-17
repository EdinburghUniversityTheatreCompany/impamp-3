import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/db";
import { planTransition } from "@/lib/syncTransitions";
import { applyTransition, type TransitionRunner } from "@/lib/applyTransition";

const PROFILE_ID = 1;

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: PROFILE_ID,
    name: "Test",
    syncType: "local",
    audioLocation: "local",
    lastBackedUpAt: 0,
    backupReminderPeriod: 30,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const SERVER_PROFILE = profile({
  syncType: "server",
  audioLocation: "googleDrive",
  serverProfileId: "srv-1",
  serverVersion: 3,
  serverRole: "owner",
  googleDriveFolderId: "folder-1",
});

function runner(overrides: Partial<TransitionRunner> = {}): TransitionRunner {
  return {
    updateProfile: vi.fn().mockResolvedValue(undefined),
    clearAudioDriveIds: vi.fn().mockResolvedValue(undefined),
    ensureDriveFolder: vi.fn().mockResolvedValue(undefined),
    driveSyncNow: vi.fn().mockResolvedValue(undefined),
    serverSyncNow: vi.fn().mockResolvedValue(undefined),
    deleteServerProfile: vi.fn().mockResolvedValue(undefined),
    confirmDeleteServerProfile: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe("applyTransition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses to run a plan that was refused", async () => {
    const from = profile();
    const plan = planTransition(from, {
      target: "googleDrive",
      audio: "server",
    });
    const r = runner();

    const result = await applyTransition(from, plan, r);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(plan.reason);
    expect(r.updateProfile).not.toHaveBeenCalled();
  });

  it("runs the effects even when there is nothing to write", async () => {
    // Creating the folder a profile already claims to publish into writes no
    // fields. Skipping it made the "Publish the sounds" button a no-op.
    const from = profile({
      syncType: "server",
      audioLocation: "googleDrive",
      serverProfileId: "srv-1",
      serverRole: "owner",
    });
    const plan = planTransition(from, {
      target: "server",
      audio: "googleDrive",
    });
    const r = runner();

    expect(plan.fieldUpdates).toEqual({});
    expect(plan.effects).toContain("ensureDriveFolder");

    const result = await applyTransition(from, plan, r);

    expect(result.ok).toBe(true);
    expect(r.ensureDriveFolder).toHaveBeenCalledWith(PROFILE_ID);
    expect(r.updateProfile).not.toHaveBeenCalled();
  });

  it("does nothing at all for a no-op", async () => {
    const from = SERVER_PROFILE;
    const plan = planTransition(from, {
      target: "server",
      audio: "googleDrive",
    });
    const r = runner();

    expect((await applyTransition(from, plan, r)).ok).toBe(true);
    expect(r.updateProfile).not.toHaveBeenCalled();
    expect(r.serverSyncNow).not.toHaveBeenCalled();
  });

  it("writes every field in a single call", async () => {
    // updateProfile stamps _fieldsModified per key, so a transition split
    // across two writes leaves half the bookkeeping pointing at the old
    // backend and half at the new — the exact state being eliminated.
    const from = profile();
    const plan = planTransition(from, {
      target: "server",
      audio: "googleDrive",
    });
    const r = runner();

    await applyTransition(from, plan, r);

    expect(r.updateProfile).toHaveBeenCalledOnce();
    expect(r.updateProfile).toHaveBeenCalledWith(PROFILE_ID, plan.fieldUpdates);
  });

  it("runs the effects in the order the plan gives them", async () => {
    const from = profile();
    const plan = planTransition(from, {
      target: "server",
      audio: "googleDrive",
    });
    const r = runner();

    await applyTransition(from, plan, r);

    const folderOrder = (r.ensureDriveFolder as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const syncOrder = (r.serverSyncNow as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(folderOrder).toBeLessThan(syncOrder);
  });

  it("restores every field in one call when an effect fails", async () => {
    const from = profile();
    const plan = planTransition(from, {
      target: "server",
      audio: "local",
    });
    const r = runner({
      serverSyncNow: vi.fn().mockRejectedValue(new Error("server unreachable")),
    });

    const result = await applyTransition(from, plan, r);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/server unreachable/);
    expect(r.updateProfile).toHaveBeenCalledTimes(2);
    expect(r.updateProfile).toHaveBeenLastCalledWith(
      PROFILE_ID,
      expect.objectContaining(plan.rollbackTo),
    );
    // Naming the value as well as the shape: asserting only against
    // `plan.rollbackTo` is tautological, since that is the plan's own output.
    // The profile started local, so that is where a failed adopt must leave it.
    expect(r.updateProfile).toHaveBeenLastCalledWith(
      PROFILE_ID,
      expect.objectContaining({ syncType: "local" }),
    );
    expect(plan.fieldUpdates.syncType).toBe("server");
  });

  it("also takes back what the failed effect wrote", async () => {
    // `adoptProfile` records `serverProfileId` itself, so it is in neither
    // `fieldUpdates` nor `rollbackTo`. Rolling back only the planned fields
    // left `syncType` at local while the profile still pointed at a live
    // server copy — the split state this module exists to prevent, and one
    // nothing detected afterwards.
    const from = profile();
    const plan = planTransition(from, { target: "server", audio: "local" });
    const r = runner({
      serverSyncNow: vi.fn().mockRejectedValue(new Error("server unreachable")),
    });

    await applyTransition(from, plan, r);

    const [, restored] = (r.updateProfile as ReturnType<typeof vi.fn>).mock
      .lastCall!;
    expect(restored).toMatchObject({
      serverProfileId: null,
      serverVersion: null,
    });
  });

  it("leaves the profile alone when the write itself fails", async () => {
    const from = profile();
    const plan = planTransition(from, {
      target: "server",
      audio: "local",
    });
    const r = runner({
      updateProfile: vi.fn().mockRejectedValue(new Error("disk full")),
    });

    const result = await applyTransition(from, plan, r);

    expect(result.ok).toBe(false);
    // Nothing was written, so there is nothing to undo — a rollback here would
    // be a second failing write for no reason.
    expect(r.updateProfile).toHaveBeenCalledOnce();
    expect(r.serverSyncNow).not.toHaveBeenCalled();
  });

  describe("the copy left on the server", () => {
    it("asks before deleting it", async () => {
      const from = SERVER_PROFILE;
      const plan = planTransition(from, {
        target: "local",
        audio: "local",
      });
      const r = runner({
        confirmDeleteServerProfile: vi.fn().mockResolvedValue(true),
      });

      await applyTransition(from, plan, r);

      expect(r.confirmDeleteServerProfile).toHaveBeenCalled();
      expect(r.deleteServerProfile).toHaveBeenCalledWith("srv-1");
    });

    it("keeps it when the user says no, and still completes the move", async () => {
      const from = SERVER_PROFILE;
      const plan = planTransition(from, {
        target: "local",
        audio: "local",
      });
      const r = runner({
        confirmDeleteServerProfile: vi.fn().mockResolvedValue(false),
      });

      const result = await applyTransition(from, plan, r);

      expect(result.ok).toBe(true);
      expect(r.deleteServerProfile).not.toHaveBeenCalled();
      expect(r.updateProfile).toHaveBeenCalledOnce();
    });

    it("does not undo the move when the delete fails", async () => {
      // The local move succeeded; only the tidying up did not. Rolling back
      // would put the profile back on a server the user asked to leave.
      const from = SERVER_PROFILE;
      const plan = planTransition(from, {
        target: "local",
        audio: "local",
      });
      const r = runner({
        confirmDeleteServerProfile: vi.fn().mockResolvedValue(true),
        deleteServerProfile: vi.fn().mockRejectedValue(new Error("403")),
      });

      const result = await applyTransition(from, plan, r);

      expect(result.ok).toBe(true);
      expect(result.warnings.join(" ")).toMatch(/403/);
      expect(r.updateProfile).toHaveBeenCalledOnce();
    });
  });

  it("does not undo the move when only the audio mapping fails to clear", async () => {
    // Clearing the mapping is bookkeeping. Losing it costs a re-upload, not
    // data, and undoing a completed move over it would be worse.
    const from = SERVER_PROFILE;
    const plan = planTransition(from, {
      target: "server",
      audio: "local",
    });
    const r = runner({
      clearAudioDriveIds: vi.fn().mockRejectedValue(new Error("idb closed")),
    });

    const result = await applyTransition(from, plan, r);

    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/idb closed/);
  });

  it("passes the plan's informational warnings on, but not its confirmations", async () => {
    // Confirmations were shown and accepted before this ran; repeating them
    // afterwards reads as though something went wrong.
    const from = profile({
      syncType: "googleDrive",
      audioLocation: "googleDrive",
      googleDriveFileId: "file-1",
      googleDriveFolderId: "folder-1",
    });
    const plan = planTransition(from, { target: "server", audio: "local" });
    const r = runner();

    const result = await applyTransition(from, plan, r);

    expect(plan.confirmations.length).toBeGreaterThan(0);
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual(plan.warnings);
    for (const confirmation of plan.confirmations) {
      expect(result.warnings).not.toContain(confirmation);
    }
  });
});
