/**
 * Carrying out a planned move between sync states.
 *
 * `planTransition` decides what should happen; this makes it happen, and puts
 * it back if it does not. The split exists because the decision is pure and
 * worth testing exhaustively, while the doing needs React hooks, IndexedDB and
 * the network.
 *
 * The one rule that matters: `updateProfile` stamps `_fieldsModified` per key,
 * so a transition applied across two writes can leave half the bookkeeping
 * pointing at the old backend and half at the new — which is the class of
 * state this whole change set exists to eliminate. Both the write and the
 * undo are therefore single calls.
 */

import type { Profile } from "@/lib/db";
import type { TransitionPlan } from "@/lib/syncTransitions";

/**
 * The side effects a transition needs, injected so the decision logic and the
 * ordering can be tested without a browser.
 */
export interface TransitionRunner {
  updateProfile: (id: number, updates: Partial<Profile>) => Promise<void>;
  clearAudioDriveIds: (id: number) => Promise<void>;
  ensureDriveFolder: (id: number) => Promise<void>;
  driveSyncNow: (id: number) => Promise<void>;
  serverSyncNow: (id: number) => Promise<void>;
  deleteServerProfile: (serverProfileId: string) => Promise<void>;
  /** Ask the user whether to delete the now-unused copy on the server. */
  confirmDeleteServerProfile: () => Promise<boolean>;
}

export interface TransitionOutcome {
  ok: boolean;
  error?: string;
  /** The plan's own consequences, plus anything that went wrong non-fatally. */
  warnings: string[];
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Takes the whole profile rather than its id: the id of the copy on the server
 * has to be read *before* the write nulls it, and a separate argument for it
 * is a thing a caller can forget.
 */
export async function applyTransition(
  profile: Profile,
  plan: TransitionPlan,
  runner: TransitionRunner,
): Promise<TransitionOutcome> {
  const profileId = profile.id!;
  const serverProfileId = profile.serverProfileId;

  if (!plan.ok) {
    return { ok: false, error: plan.reason, warnings: [] };
  }

  // The plan's confirmations were shown before this ran, so only its
  // informational warnings travel onward alongside anything that goes wrong.
  const warnings = [...plan.warnings];

  if (Object.keys(plan.fieldUpdates).length === 0) {
    return { ok: true, warnings };
  }

  try {
    await runner.updateProfile(profileId, plan.fieldUpdates);
  } catch (error) {
    // Nothing was written, so there is nothing to undo. A rollback here would
    // be a second failing write for no reason.
    return { ok: false, error: message(error), warnings };
  }

  for (const effect of plan.effects) {
    try {
      switch (effect) {
        case "clearAudioDriveIds":
          await runner.clearAudioDriveIds(profileId);
          break;
        case "ensureDriveFolder":
          await runner.ensureDriveFolder(profileId);
          break;
        case "driveSyncNow":
          await runner.driveSyncNow(profileId);
          break;
        case "serverSyncNow":
          await runner.serverSyncNow(profileId);
          break;
        case "offerDeleteServerProfile":
          if (serverProfileId && (await runner.confirmDeleteServerProfile())) {
            await runner.deleteServerProfile(serverProfileId);
          }
          break;
      }
    } catch (error) {
      // Two effects are tidying up rather than part of the move. Undoing a
      // completed transition because the tidying failed would be worse than
      // leaving it untidy: it would put the profile back on a backend the
      // user asked to leave, or re-link audio they asked to unlink.
      if (
        effect === "clearAudioDriveIds" ||
        effect === "offerDeleteServerProfile"
      ) {
        warnings.push(message(error));
        continue;
      }

      try {
        await runner.updateProfile(profileId, plan.rollbackTo);
      } catch (rollbackError) {
        warnings.push(
          `Could not undo the change either: ${message(rollbackError)}`,
        );
      }
      return { ok: false, error: message(error), warnings };
    }
  }

  return { ok: true, warnings };
}
