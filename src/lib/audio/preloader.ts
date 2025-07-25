/**
 * Audio Module - Intelligent Preloading System
 *
 * Implements smart audio preloading strategies to minimize user wait times:
 * - Priority-based loading (current page → recently played → all configured)
 * - Background loading using requestIdleCallback
 * - Hover-triggered preloading
 * - Usage pattern learning
 *
 * @module lib/audio/preloader
 */

import { loadAndDecodeAudioPipelined } from "./decoder";
import { isAudioBufferCached, cacheAudioBuffer } from "./cache";
import { PadConfiguration } from "../db";

// Priority levels for preloading
enum PreloadPriority {
  IMMEDIATE = 0, // Current page files
  HIGH = 1, // Recently played files
  MEDIUM = 2, // Hover-triggered files
  LOW = 3, // Background preload of all configured files
}

interface PreloadTask {
  audioFileId: number;
  priority: PreloadPriority;
  requestedAt: number;
  profileId: number;
  pageIndex: number;
  padIndex: number;
  attempts: number;
  maxAttempts: number;
}

interface PreloadStats {
  totalRequested: number;
  totalCompleted: number;
  totalFailed: number;
  averageLoadTime: number;
  cacheHitRate: number;
}

class AudioPreloader {
  private taskQueue: PreloadTask[] = [];
  private isProcessing = false;
  private stats: PreloadStats = {
    totalRequested: 0,
    totalCompleted: 0,
    totalFailed: 0,
    averageLoadTime: 0,
    cacheHitRate: 0,
  };
  private loadTimes: number[] = [];
  private recentlyPlayed: number[] = []; // Track recently played audio file IDs
  private isIdleCallbackSupported = typeof requestIdleCallback !== "undefined";

  /**
   * Add files to preload queue with specified priority
   */
  public preloadFiles(
    audioFileIds: number[],
    priority: PreloadPriority,
    context: { profileId: number; pageIndex: number; padIndex?: number },
  ): void {
    const now = Date.now();

    // Filter out already cached files and duplicates
    const uncachedIds = audioFileIds.filter((id) => !isAudioBufferCached(id));

    if (uncachedIds.length === 0) {
      console.log(
        `[Audio Preloader] All ${audioFileIds.length} files already cached`,
      );
      return;
    }

    // Create preload tasks
    const newTasks: PreloadTask[] = uncachedIds.map((audioFileId) => ({
      audioFileId,
      priority,
      requestedAt: now,
      profileId: context.profileId,
      pageIndex: context.pageIndex,
      padIndex: context.padIndex || -1,
      attempts: 0,
      maxAttempts: priority === PreloadPriority.IMMEDIATE ? 3 : 1, // Retry important files
    }));

    // Remove existing tasks for the same files (update priority if needed)
    this.taskQueue = this.taskQueue.filter(
      (task) => !uncachedIds.includes(task.audioFileId),
    );

    // Add new tasks and sort by priority
    this.taskQueue.push(...newTasks);
    this.sortTaskQueue();

    this.stats.totalRequested += newTasks.length;

    console.log(
      `[Audio Preloader] Queued ${newTasks.length} files with priority ${PreloadPriority[priority]} ` +
        `(${this.taskQueue.length} total in queue)`,
    );

    // Start processing if not already running
    this.processQueue();
  }

  /**
   * Preload current page files with highest priority
   */
  public preloadCurrentPage(
    padConfigs: PadConfiguration[],
    profileId: number,
    pageIndex: number,
  ): void {
    const allIds = padConfigs.flatMap((config) => config.audioFileIds || []);
    const uniqueIds = [...new Set(allIds)].filter(Boolean);

    if (uniqueIds.length > 0) {
      this.preloadFiles(uniqueIds, PreloadPriority.IMMEDIATE, {
        profileId,
        pageIndex,
      });
    }
  }

  /**
   * Preload files based on user hover (anticipatory loading)
   */
  public preloadOnHover(
    audioFileIds: number[],
    context: { profileId: number; pageIndex: number; padIndex: number },
  ): void {
    // Only preload if files aren't cached and user seems to be hovering intentionally
    const uncachedIds = audioFileIds.filter((id) => !isAudioBufferCached(id));

    if (uncachedIds.length > 0) {
      // Use a short delay to avoid preloading on accidental hovers
      setTimeout(() => {
        this.preloadFiles(uncachedIds, PreloadPriority.MEDIUM, context);
      }, 200);
    }
  }

  /**
   * Track recently played files for intelligent preloading
   */
  public trackPlayedFile(audioFileId: number): void {
    // Remove if already exists and add to front
    this.recentlyPlayed = this.recentlyPlayed.filter(
      (id) => id !== audioFileId,
    );
    this.recentlyPlayed.unshift(audioFileId);

    // Keep only last 20 played files
    if (this.recentlyPlayed.length > 20) {
      this.recentlyPlayed = this.recentlyPlayed.slice(0, 20);
    }
  }

  /**
   * Background preload of all configured files across all pages
   */
  public preloadAllConfigured(
    allPadConfigs: PadConfiguration[],
    profileId: number,
  ): void {
    // Get all unique audio file IDs across all pages
    const allIds = allPadConfigs.flatMap((config) => config.audioFileIds || []);
    const uniqueIds = [...new Set(allIds)].filter(Boolean);

    // Prioritize recently played files
    const recentIds = uniqueIds.filter((id) =>
      this.recentlyPlayed.includes(id),
    );
    const otherIds = uniqueIds.filter(
      (id) => !this.recentlyPlayed.includes(id),
    );

    // Preload recently played with higher priority
    if (recentIds.length > 0) {
      this.preloadFiles(recentIds, PreloadPriority.HIGH, {
        profileId,
        pageIndex: -1,
      });
    }

    // Preload others with low priority
    if (otherIds.length > 0) {
      this.preloadFiles(otherIds, PreloadPriority.LOW, {
        profileId,
        pageIndex: -1,
      });
    }
  }

  /**
   * Sort task queue by priority and age
   */
  private sortTaskQueue(): void {
    this.taskQueue.sort((a, b) => {
      // First sort by priority
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // Then by age (older first)
      return a.requestedAt - b.requestedAt;
    });
  }

  /**
   * Process the preload queue using parallel loading for better performance
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.taskQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // Group tasks by priority for batch processing
      const taskGroups = new Map<PreloadPriority, PreloadTask[]>();

      // Process all tasks, grouping by priority
      while (this.taskQueue.length > 0) {
        const task = this.taskQueue.shift()!;

        // Skip if already cached
        if (isAudioBufferCached(task.audioFileId)) {
          this.stats.cacheHitRate++;
          this.stats.totalCompleted++;
          continue;
        }

        if (!taskGroups.has(task.priority)) {
          taskGroups.set(task.priority, []);
        }
        taskGroups.get(task.priority)!.push(task);
      }

      // Process groups in priority order
      const priorities = [
        PreloadPriority.IMMEDIATE,
        PreloadPriority.HIGH,
        PreloadPriority.MEDIUM,
        PreloadPriority.LOW,
      ];

      for (const priority of priorities) {
        const tasks = taskGroups.get(priority);
        if (!tasks || tasks.length === 0) continue;

        // For low priority tasks, wait for idle time
        if (priority === PreloadPriority.LOW && this.isIdleCallbackSupported) {
          await this.waitForIdleTime();
        }

        await this.processBatch(tasks, priority);

        // Small delay between priority groups
        if (priority !== PreloadPriority.IMMEDIATE && taskGroups.size > 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a batch of tasks using parallel loading
   */
  private async processBatch(
    tasks: PreloadTask[],
    priority: PreloadPriority,
  ): Promise<void> {
    if (tasks.length === 0) return;

    const audioFileIds = tasks.map((task) => task.audioFileId);
    const startTime = performance.now();

    console.log(
      `[Audio Preloader] Processing batch of ${tasks.length} files with priority ${PreloadPriority[priority]}...`,
    );

    try {
      // Use parallel loading for better performance
      const results = await loadAndDecodeAudioPipelined(
        audioFileIds,
        priority === PreloadPriority.IMMEDIATE ? 8 : 6, // Higher load concurrency for immediate tasks
        priority === PreloadPriority.IMMEDIATE ? 6 : 4, // Higher decode concurrency for immediate tasks
      );

      const endTime = performance.now();
      const loadTime = endTime - startTime;

      // Update stats and cache results
      let successCount = 0;
      let failureCount = 0;

      results.forEach((buffer, audioFileId) => {
        // Find the corresponding task for retry logic
        const task = tasks.find((t) => t.audioFileId === audioFileId);

        if (buffer) {
          successCount++;
          this.stats.totalCompleted++;
          this.loadTimes.push(loadTime / tasks.length); // Average per file

          // Update average load time (keep last 100 measurements)
          if (this.loadTimes.length > 100) {
            this.loadTimes = this.loadTimes.slice(-100);
          }
          this.stats.averageLoadTime =
            this.loadTimes.reduce((a, b) => a + b, 0) / this.loadTimes.length;
        } else {
          // Handle failures with retry logic for high-priority tasks
          if (task && task.attempts < task.maxAttempts) {
            task.attempts++;
            console.log(
              `[Audio Preloader] Retrying failed file ID ${audioFileId} (${task.attempts}/${task.maxAttempts})`,
            );

            // Re-queue with exponential backoff
            setTimeout(() => {
              this.taskQueue.unshift(task);
              this.processQueue();
            }, 1000 * task.attempts);
          } else {
            failureCount++;
            this.stats.totalFailed++;
            // Cache the failure to prevent repeated attempts
            cacheAudioBuffer(audioFileId, null);
          }
        }
      });

      console.log(
        `[Audio Preloader] ✓ Batch completed: ${successCount}/${tasks.length} successful, ` +
          `${failureCount} failed in ${loadTime.toFixed(1)}ms`,
      );
    } catch (error) {
      console.error(`[Audio Preloader] ✗ Batch processing failed:`, error);

      // Mark all tasks as failed and update stats
      tasks.forEach((task) => {
        if (task.attempts < task.maxAttempts) {
          task.attempts++;
          // Re-queue individual tasks for retry
          setTimeout(() => {
            this.taskQueue.push(task);
            this.processQueue();
          }, 1000 * task.attempts);
        } else {
          this.stats.totalFailed++;
          cacheAudioBuffer(task.audioFileId, null);
        }
      });
    }
  }

  /**
   * Wait for idle time before processing low-priority tasks
   */
  private waitForIdleTime(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(() => resolve(), { timeout: 5000 });
      } else {
        // Fallback for browsers without requestIdleCallback
        setTimeout(resolve, 0);
      }
    });
  }

  /**
   * Get current preloading statistics
   */
  public getStats(): PreloadStats & { queueLength: number } {
    return {
      ...this.stats,
      queueLength: this.taskQueue.length,
    };
  }

  /**
   * Clear the preload queue (useful when switching profiles)
   */
  public clearQueue(): void {
    this.taskQueue = [];
    console.log("[Audio Preloader] Queue cleared");
  }

  /**
   * Pause preloading (useful during active playback to avoid interference)
   */
  public pausePreloading(): void {
    this.isProcessing = true; // Prevent new processing
    console.log("[Audio Preloader] Preloading paused");
  }

  /**
   * Resume preloading
   */
  public resumePreloading(): void {
    this.isProcessing = false;
    this.processQueue();
    console.log("[Audio Preloader] Preloading resumed");
  }
}

// Export singleton instance
export const audioPreloader = new AudioPreloader();

// Export types and enums for external use
export { PreloadPriority };
export type { PreloadStats };
