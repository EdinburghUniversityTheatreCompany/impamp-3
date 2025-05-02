/**
 * Utility functions for formatting values
 *
 * Contains reusable formatting functions used throughout the application.
 *
 * @module utils/formatters
 */

/**
 * Format time in seconds to MM:SS format
 *
 * @param seconds - The time in seconds to format
 * @returns Formatted time string in MM:SS format
 */
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
