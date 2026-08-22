/**
 * Offers the first-use tour, and only on the board.
 *
 * The gate — unseen on this device, and the active profile has no configured
 * pads — asks two questions and neither of them is "where are we". That was
 * fine while the effect lived in `ClientSideInitializer`, right up until you
 * notice the root layout mounts that on **every** route: `/server/open`,
 * `/drive/open` and `/server/storage` satisfy both conditions too, and a fresh
 * device arriving on a shared board's link is the single most likely visitor
 * to satisfy them at once. It got a four-step tour about pads and banks over
 * the "Shared profile" page — `Modal`'s overlay is `fixed inset-0 z-50`, so
 * over its controls rather than beside them.
 *
 * Rendering the offer from the board is the fix, because "are we on the board"
 * stops being a question anyone has to remember to ask.
 *
 * @module components/WelcomeTourOffer
 */

"use client";

import { useEffect, useRef } from "react";
import { useProfileStore } from "@/store/profileStore";
import { exposeE2EHook } from "@/lib/testHooks";

export default function WelcomeTourOffer(): null {
  const activeProfileId = useProfileStore((state) => state.activeProfileId);

  // Decides once per mount, which is why this is a ref rather than the
  // effect's deps: `activeProfileId` changes when the user switches profiles,
  // and offering a tutorial because someone opened a fresh second profile
  // would be exactly the interruption the empty-board gate exists to prevent.
  const decided = useRef(false);

  useEffect(() => {
    // Recorded on mount rather than after the decision, and that is the whole
    // point of it: proving the tour is NOT offered somewhere cannot be done by
    // looking for a modal that has not rendered yet — `toHaveCount(0)` is true
    // of an element the async pad-count read has not got round to opening, so
    // the assertion passes with the offer mounted on every route. Mount is
    // synchronous with hydration, so a spec that waits for the app to have an
    // active profile has already given this every chance to appear.
    exposeE2EHook("__impampWelcomeTourMounted", true);

    if (activeProfileId === null || decided.current) return;
    decided.current = true;

    void (async () => {
      try {
        const { getPadConfigurationsForProfile } = await import("@/lib/db");
        const pads = await getPadConfigurationsForProfile(activeProfileId);
        const configured = pads.filter(
          (pad) => (pad.audioFileIds?.length ?? 0) > 0,
        ).length;
        const { shouldOfferWelcomeTour, openWelcomeTour } =
          await import("@/lib/uiUtils");
        if (shouldOfferWelcomeTour(configured)) openWelcomeTour();
      } catch (error) {
        // Never let deciding whether to show a tutorial stop the board from
        // starting. A read that fails simply means no tour this time.
        console.warn("[WelcomeTourOffer] Welcome tour check failed:", error);
      }
    })();
  }, [activeProfileId]);

  return null;
}
