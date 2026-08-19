"use client";

import { useSyncExternalStore } from "react";
import { isApplePlatform } from "@/lib/platform";

/**
 * Nothing to subscribe to: a machine does not stop being a Mac mid-session.
 * `useSyncExternalStore` is here for its *server snapshot*, not for updates.
 */
const neverChanges = () => () => {};

/** The server has no `navigator`, so it always renders the PC label. */
const notAppleOnTheServer = () => false;

/**
 * Whether this is an Apple platform, for labelling keyboard chords.
 *
 * Answering honestly during hydration would make the client's HTML differ from
 * the server's, and React would blow up a `<kbd>` into a hydration mismatch.
 * `useSyncExternalStore` is the sanctioned way out: React takes the server
 * snapshot for the hydrating render and the real one immediately after, so the
 * label corrects itself in the same commit rather than via a state update.
 */
export function useIsApplePlatform(): boolean {
  return useSyncExternalStore(
    neverChanges,
    isApplePlatform,
    notAppleOnTheServer,
  );
}
