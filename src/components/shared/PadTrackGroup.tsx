/**
 * One Active Tracks row per pad.
 *
 * A pad with one sound looks exactly as it did before layers existed. A pad
 * with several shows a count button; press it and the layers appear indented
 * below, each with its own stop and fade controls. The expansion is local
 * state, because it describes this row on this screen and nothing else needs
 * to know about it.
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
      <div className="relative">
        <TrackItem
          trackKey={group.baseKey}
          name={group.name}
          remainingTime={group.newest.remainingTime}
          progress={group.newest.progress}
          isFading={group.isFading}
          isActive={true}
        />
        {layerCount > 1 && (
          <button
            type="button"
            onClick={(event) => {
              // The row itself stops the pad, so a press on the count must not
              // reach it.
              event.stopPropagation();
              setExpanded((open) => !open);
            }}
            className="absolute top-1/2 right-12 -translate-y-1/2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-mono text-blue-700 dark:bg-blue-900 dark:text-blue-300"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} the ${layerCount} layers of ${group.name}`}
            data-testid="active-track-layer-count"
          >
            {expanded ? "v" : "x"}
            {layerCount}
          </button>
        )}
      </div>

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
