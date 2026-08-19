/**
 * Playback Announcer
 *
 * The app's live region for "what is currently making noise".
 *
 * @module components/PlaybackAnnouncer
 */

"use client";

import React from "react";
import {
  usePlaybackStore,
  groupPlaybackByPad,
  describePlayingLayers,
} from "@/store/playbackStore";

/** A visually hidden polite live region. */
function LiveRegion({ testId, text }: { testId: string; text: string }) {
  return (
    <div
      data-testid={testId}
      role="status"
      aria-live="polite"
      // The whole line is read, not the diff. These are short and the reader
      // needs the verb ("Playing:") as much as the names.
      aria-atomic="true"
      className="sr-only"
    >
      {text}
    </div>
  );
}

/**
 * Announces what is playing and what is armed.
 *
 * The only `aria-live` or `role="status"` in the component tree were two
 * `role="alert"`s on the backup reminder and the conflict resolver. Nothing
 * said that a pad had fired, that a track had finished, that a cue was armed,
 * or that F9 had consumed one — and this is a tool whose entire state is what
 * is currently making noise.
 *
 * Two reasons this is its own component rather than an attribute on the panels.
 *
 * `TrackItem` renders a remaining-time readout that changes every animation
 * frame. A live region wrapped around the Active Tracks list would announce a
 * countdown for as long as anything played, which is worse than announcing
 * nothing. These regions carry names and nothing else.
 *
 * And `ArmedTracksPanel` returns `null` when the queue empties, so the panel
 * itself cannot host a region that survives the transition it most needs to
 * report. Mounting here — always, hidden — means the region exists before it
 * has anything to say, which is also what makes it announce at all: a live
 * region inserted into the DOM together with its content is not reliably read.
 *
 * The selectors return strings, not the maps. `updateTrackProgress` replaces
 * `activePlayback` on every frame, so a selector returning the map would
 * re-render this on every frame; returning a joined string means zustand's
 * `Object.is` check sees no change and nothing re-renders until a name does.
 *
 * A stacked pad reads as `Applause, 3 layers`. The reader hears the count
 * once, in place of the name three times.
 */
export default function PlaybackAnnouncer() {
  const playing = usePlaybackStore((state) =>
    describePlayingLayers(groupPlaybackByPad(state.activePlayback)),
  );
  const armed = usePlaybackStore((state) =>
    Array.from(state.armedTracks.values(), (track) => track.name).join(", "),
  );

  return (
    <>
      {/* "Playback stopped" rather than the panel's "Nothing playing", and
          not only to keep the two out of each other's way in tests. A live
          region reports a transition, and "stopped" is the thing that just
          happened; the panel is describing a state you can see. */}
      <LiveRegion
        testId="playback-announcer"
        text={playing ? `Playing: ${playing}` : "Playback stopped"}
      />
      <LiveRegion
        testId="armed-announcer"
        text={armed ? `Armed: ${armed}` : "Nothing armed"}
      />
    </>
  );
}
