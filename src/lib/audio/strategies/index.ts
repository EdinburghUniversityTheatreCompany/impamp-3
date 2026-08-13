/**
 * Audio Module - Playback Strategies
 *
 * Factory for creating and managing playback strategies.
 * Provides a simple way to get the appropriate strategy based on playback type.
 *
 * @module lib/audio/strategies
 */

import { PlaybackType } from "../../db";
import { PlaybackStrategy } from "../types";
import { SequentialStrategy } from "./sequential";
import { RandomStrategy } from "./random";
import { RoundRobinStrategy } from "./roundRobin";

// Fallback strategies used when no per-pad instance key is provided
const strategies: Record<string, PlaybackStrategy> = {
  sequential: new SequentialStrategy(),
  random: new RandomStrategy(),
};

// Per-pad instances for stateful strategies (sequential, round-robin)
const sequentialInstances = new Map<string, SequentialStrategy>();
const roundRobinInstances = new Map<string, RoundRobinStrategy>();

/**
 * Gets the appropriate strategy instance for the specified playback type.
 *
 * Sequential (tracks the position in the sequence) and round-robin (tracks which
 * sounds haven't been played yet) are stateful, so each pad gets its own instance
 * keyed by playbackKey. Random is stateless and can be shared.
 *
 * @param playbackType - The type of playback strategy to get
 * @param instanceKey - Unique key for per-pad instances (sequential, round-robin)
 * @returns The strategy instance
 */
export function getStrategy(
  playbackType: PlaybackType,
  instanceKey?: string,
): PlaybackStrategy {
  if (playbackType === "round-robin" && instanceKey) {
    let instance = roundRobinInstances.get(instanceKey);
    if (!instance) {
      instance = new RoundRobinStrategy();
      roundRobinInstances.set(instanceKey, instance);
    }
    return instance;
  }

  if (playbackType === "sequential" && instanceKey) {
    let instance = sequentialInstances.get(instanceKey);
    if (!instance) {
      instance = new SequentialStrategy();
      sequentialInstances.set(instanceKey, instance);
    }
    return instance;
  }

  return strategies[playbackType] ?? strategies.sequential;
}

// Export strategy classes for direct usage if needed
export { SequentialStrategy, RandomStrategy, RoundRobinStrategy };
