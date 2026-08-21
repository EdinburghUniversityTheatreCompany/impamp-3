/**
 * Writing a pad, and telling the rest of the app that a pad changed.
 *
 * Every pad write ends the same way — bump the shared pad-configurations
 * version, then ask sync to push the profile — and that tail was open-coded at
 * six call sites: the drop handler, the edit form's submit, the single-sound
 * removal, the delete/move swap, the loudness overview's gain commit and the
 * bulk importer. Two of them were not the same: the bulk importer requested a
 * sync and left the version alone, leaning on its caller in `PadGrid` to do
 * that half, and the loudness overview reached for the store action directly
 * while everything else took a `refreshPadConfigs` prop that resolves to the
 * same action. Neither half is optional, and a rule spread over six copies and
 * two partial ones is this repo's characteristic way of losing one.
 *
 * The version is the *only* invalidation signal there is: the grid, the
 * keyboard listener and the emergency set all watch it, which is why there is
 * no "is this an emergency bank" question to ask here.
 *
 * @module hooks/pad/padWrites
 */

import { useProfileStore } from "@/store/profileStore";
import { upsertPadConfiguration } from "@/lib/db";

/** The pad record `upsertPadConfiguration` accepts — a partial merge, not a rewrite. */
export type PadWrite = Parameters<typeof upsertPadConfiguration>[0];

/**
 * Announces that a profile's pads changed.
 *
 * Read from the store rather than taken as arguments, so a call site cannot
 * hold a stale copy of either action, and so the two modal components — which
 * are not wired to `usePadConfigurations` at all — say it the same way the
 * hooks do.
 *
 * @param profileId - The profile whose pads were written
 */
export function notifyPadConfigsChanged(profileId: number): void {
  const { incrementPadConfigsVersion, requestSync } =
    useProfileStore.getState();
  incrementPadConfigsVersion();
  requestSync(profileId);
}

/**
 * Writes one pad and announces it.
 *
 * The write is a merge: `upsertPadConfiguration` spreads
 * `{...existing, ...padConfig}`, so an omitted key keeps its stored value and
 * an explicitly-`undefined` one erases it. Call sites depend on that
 * distinction in both directions — do not "complete" their field lists.
 *
 * @param pad - What to merge into the stored pad
 */
export async function savePadConfiguration(pad: PadWrite): Promise<void> {
  await upsertPadConfiguration(pad);
  notifyPadConfigsChanged(pad.profileId);
}
