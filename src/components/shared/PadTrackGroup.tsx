/**
 * One Active Tracks row per pad.
 *
 * A pad with one sound looks exactly as it did before layers existed. A pad
 * with several shows a count button; press it and the layers appear indented
 * below, each with its own stop and fade controls. The expansion is local
 * state, because it describes this row on this screen and nothing else needs
 * to know about it.
 *
 * The count goes through `TrackItem`'s `badge` slot, which puts it in the
 * row's own flex flow just left of the remaining time. It used to be
 * absolutely positioned over the row at `right-12`, where it landed squarely
 * on the time and left "0:59" reading "0:" — measured in Chromium, the badge
 * started 18px inside the time readout's right edge.
 *
 * @module components/shared/PadTrackGroup
 */

"use client";

import React, { useState } from "react";
import type { PadPlaybackGroup } from "@/store/playbackStore";
import TrackItem from "./TrackItem";

interface PadTrackGroupProps {
  group: PadPlaybackGroup;
}

const PadTrackGroup: React.FC<PadTrackGroupProps> = ({ group }) => {
  const [expanded, setExpanded] = useState(false);
  const layerCount = group.layers.length;

  return (
    <div className="flex flex-col gap-1">
      <TrackItem
        trackKey={group.baseKey}
        name={group.name}
        remainingTime={group.newest.remainingTime}
        progress={group.newest.progress}
        isFading={group.isFading}
        isActive={true}
        badge={
          layerCount > 1 ? (
            <button
              type="button"
              onClick={(event) => {
                // The row itself stops the pad, and the count now sits inside
                // it, so a press on the count must not reach the row.
                event.stopPropagation();
                setExpanded((open) => !open);
              }}
              className="flex-shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-mono text-blue-700 hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide" : "Show"} the ${layerCount} layers of ${group.name}`}
              data-testid="active-track-layer-count"
            >
              {expanded ? "v" : "x"}
              {layerCount}
            </button>
          ) : undefined
        }
      />

      {expanded &&
        layerCount > 1 &&
        group.layers.map((layer, index) => (
          <div
            key={layer.key}
            className="ml-6"
            data-testid="active-track-layer-item"
          >
            <TrackItem
              trackKey={layer.key}
              name={`layer ${index + 1}`}
              remainingTime={layer.remainingTime}
              progress={layer.progress}
              isFading={layer.isFading}
              isActive={true}
            />
          </div>
        ))}
    </div>
  );
};

export default PadTrackGroup;
