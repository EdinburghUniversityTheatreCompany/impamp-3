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

// Cache strategy instances for reuse (lazy loaded)
const strategies: Partial<Record<PlaybackType, PlaybackStrategy>> = {
  // Sequential is loaded immediately as it's the most common
  sequential: new SequentialStrategy(),
};

/**
 * Gets the appropriate strategy instance for the specified playback type
 * Lazy loads strategies that aren't immediately needed to reduce bundle size
 *
 * @param playbackType - The type of playback strategy to get
 * @returns The strategy instance
 */
export async function getStrategyAsync(
  playbackType: PlaybackType,
): Promise<PlaybackStrategy> {
  // Return immediately if already loaded
  if (strategies[playbackType]) {
    return strategies[playbackType]!;
  }

  // Lazy load other strategies
  switch (playbackType) {
    case "random": {
      if (!strategies.random) {
        const { RandomStrategy } = await import("./random");
        strategies.random = new RandomStrategy();
      }
      return strategies.random;
    }
    case "round-robin": {
      if (!strategies["round-robin"]) {
        const { RoundRobinStrategy } = await import("./roundRobin");
        strategies["round-robin"] = new RoundRobinStrategy();
      }
      return strategies["round-robin"];
    }
    case "sequential":
    default:
      return strategies.sequential!;
  }
}

// Synchronous version for backwards compatibility (only works with loaded strategies)
export function getStrategy(playbackType: PlaybackType): PlaybackStrategy {
  const strategy = strategies[playbackType];
  if (!strategy) {
    console.warn(
      `Strategy ${playbackType} not loaded, falling back to sequential`,
    );
    return strategies.sequential!;
  }
  return strategy;
}

// Preload all strategies for immediate access
export async function preloadAllStrategies(): Promise<void> {
  await Promise.all([
    getStrategyAsync("random"),
    getStrategyAsync("round-robin"),
  ]);
}

// Export strategy classes for direct usage if needed
export { SequentialStrategy };

// Export lazy-loaded strategy types (for TypeScript)
export type { RandomStrategy } from "./random";
export type { RoundRobinStrategy } from "./roundRobin";
