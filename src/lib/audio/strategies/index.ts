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

// Stateless strategy singletons
const strategies: Record<string, PlaybackStrategy> = {
  sequential: new SequentialStrategy(),
  random: new RandomStrategy(),
};

// Per-pad instances for stateful strategies (round-robin)
const roundRobinInstances = new Map<string, RoundRobinStrategy>();

/**
 * Gets the appropriate strategy instance for the specified playback type.
 *
 * Round-robin is stateful (tracks which sounds haven't been played yet),
 * so each pad gets its own instance keyed by playbackKey.
 *
 * @param playbackType - The type of playback strategy to get
 * @param instanceKey - Unique key for per-pad instances (required for round-robin)
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

  return strategies[playbackType] ?? strategies.sequential;
}

// Export strategy classes for direct usage if needed
export { SequentialStrategy, RandomStrategy, RoundRobinStrategy };
