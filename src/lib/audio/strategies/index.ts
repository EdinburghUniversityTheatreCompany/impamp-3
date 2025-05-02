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

// Cache strategy instances for reuse
const strategies = {
  sequential: new SequentialStrategy(),
  random: new RandomStrategy(),
  "round-robin": new RoundRobinStrategy(),
};

/**
 * Gets the appropriate strategy instance for the specified playback type
 *
 * @param playbackType - The type of playback strategy to get
 * @returns The strategy instance
 */
export function getStrategy(playbackType: PlaybackType): PlaybackStrategy {
  return strategies[playbackType];
}

// Export strategy classes for direct usage if needed
export { SequentialStrategy, RandomStrategy, RoundRobinStrategy };
