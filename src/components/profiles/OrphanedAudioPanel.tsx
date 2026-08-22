"use client";

/**
 * The Maintenance tab's orphaned-audio panel: scan, read, delete.
 *
 * An audio row survives the pad that named it — clearing a pad, deleting a
 * bank or removing a profile all leave the bytes behind — so a library grows
 * sounds nothing can reach. This is where they are found and removed, and it
 * is one of the two buttons in the app that deletes a user's audio.
 *
 * Two rules it keeps, both visible in the markup below:
 *
 *  - **The scan only looks.** The delete button is rendered only once a scan
 *    has found something to delete, and it names the count in its own label,
 *    so the press that deletes is never the first press.
 *  - **The count shown after a cleanup is the cleanup's own.** Scan results
 *    and cleanup results are separate pieces of state and the second does not
 *    overwrite the first; a re-scan is scheduled instead, so what is on screen
 *    afterwards came from reading the database again rather than from
 *    subtracting the numbers the panel had.
 */

import { useState } from "react";

import { errorMessage } from "@/lib/errorMessage";

export default function OrphanedAudioPanel() {
  // Orphan cleanup state
  const [isCleaningOrphans, setIsCleaningOrphans] = useState(false);
  const [orphanCleanupResult, setOrphanCleanupResult] = useState<{
    deletedCount: number;
    cacheEntriesCleared: number;
    errors: string[];
  } | null>(null);
  const [orphanScanResult, setOrphanScanResult] = useState<{
    orphanedIds: Set<number>;
    referencedIds: Set<number>;
    totalAudioFiles: number;
  } | null>(null);
  const [isScanningOrphans, setIsScanningOrphans] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const handleScanOrphans = async () => {
    setIsScanningOrphans(true);
    setOrphanScanResult(null);
    setOrphanCleanupResult(null);
    setScanError(null);

    try {
      const { findOrphanedAudioFiles } = await import("@/lib/db");
      const result = await findOrphanedAudioFiles();
      setOrphanScanResult(result);
    } catch (error) {
      console.error("Failed to scan for orphaned audio files:", error);
      // Said out loud, not only to the console. A swallowed failure leaves the
      // panel exactly as it was, which is what a library with no orphans looks
      // like too — the results box is simply absent rather than saying "0
      // orphaned", and no user can tell those two apart.
      setScanError(`The scan could not finish: ${errorMessage(error)}.`);
    } finally {
      setIsScanningOrphans(false);
    }
  };

  const handleCleanupOrphans = async () => {
    setIsCleaningOrphans(true);
    setOrphanCleanupResult(null);

    try {
      const { cleanupOrphanedAudioFiles } = await import("@/lib/db");
      const result = await cleanupOrphanedAudioFiles();
      setOrphanCleanupResult(result);

      // Refresh scan results after cleanup
      if (result.deletedCount > 0) {
        setTimeout(() => {
          handleScanOrphans();
        }, 500);
      }
    } catch (error) {
      console.error("Failed to cleanup orphaned audio files:", error);
      setOrphanCleanupResult({
        deletedCount: 0,
        cacheEntriesCleared: 0,
        errors: [
          `Failed to cleanup: ${error instanceof Error ? error.message : error}`,
        ],
      });
    } finally {
      setIsCleaningOrphans(false);
    }
  };

  return (
    <section className="mb-8">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
        Orphaned Audio Files
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Scan for and clean up audio files that are no longer referenced by any
        sound pads. These files take up storage space but are not being used.
      </p>

      <div className="space-y-4">
        {/* Scan Button */}
        <div>
          <button
            onClick={handleScanOrphans}
            disabled={isScanningOrphans || isCleaningOrphans}
            data-testid="orphan-scan"
            className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {isScanningOrphans ? (
              <>
                <svg
                  className="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                Scanning...
              </>
            ) : (
              "Scan for Orphaned Files"
            )}
          </button>
        </div>

        {scanError && (
          <div
            role="alert"
            data-testid="orphan-scan-error"
            className="rounded-lg p-4 bg-yellow-50 dark:bg-yellow-900/20 text-sm text-yellow-800 dark:text-yellow-200"
          >
            {scanError}
          </div>
        )}

        {/* Scan Results */}
        {orphanScanResult && (
          <div
            className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4"
            data-testid="orphan-scan-result"
          >
            <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
              Scan Results
            </h4>
            <div className="space-y-2 text-sm">
              <p className="text-gray-600 dark:text-gray-300">
                Total audio files:{" "}
                <span className="font-medium">
                  {orphanScanResult.totalAudioFiles}
                </span>
              </p>
              <p className="text-green-600 dark:text-green-400">
                Referenced files:{" "}
                <span className="font-medium">
                  {orphanScanResult.referencedIds.size}
                </span>
              </p>
              <p
                className={`font-medium ${
                  orphanScanResult.orphanedIds.size > 0
                    ? "text-orange-600 dark:text-orange-400"
                    : "text-green-600 dark:text-green-400"
                }`}
              >
                Orphaned files:{" "}
                <span className="font-medium">
                  {orphanScanResult.orphanedIds.size}
                </span>
              </p>

              {orphanScanResult.orphanedIds.size > 0 && (
                <div className="mt-4">
                  <button
                    onClick={handleCleanupOrphans}
                    disabled={isCleaningOrphans || isScanningOrphans}
                    data-testid="orphan-cleanup"
                    className="px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                  >
                    {isCleaningOrphans ? (
                      <>
                        <svg
                          className="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline"
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          ></circle>
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          ></path>
                        </svg>
                        Cleaning up...
                      </>
                    ) : (
                      `Delete ${orphanScanResult.orphanedIds.size} Orphaned Files`
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Cleanup Results */}
        {orphanCleanupResult && (
          <div
            data-testid="orphan-cleanup-result"
            className={`rounded-lg p-4 ${
              orphanCleanupResult.errors.length > 0
                ? "bg-yellow-50 dark:bg-yellow-900/20"
                : "bg-green-50 dark:bg-green-900/20"
            }`}
          >
            <h4
              className={`font-medium mb-2 ${
                orphanCleanupResult.errors.length > 0
                  ? "text-yellow-800 dark:text-yellow-200"
                  : "text-green-800 dark:text-green-200"
              }`}
            >
              Cleanup Results
            </h4>
            <div className="space-y-2 text-sm">
              <p
                className={
                  orphanCleanupResult.errors.length > 0
                    ? "text-yellow-700 dark:text-yellow-300"
                    : "text-green-700 dark:text-green-300"
                }
              >
                Files deleted:{" "}
                <span className="font-medium">
                  {orphanCleanupResult.deletedCount}
                </span>
              </p>
              <p
                className={
                  orphanCleanupResult.errors.length > 0
                    ? "text-yellow-700 dark:text-yellow-300"
                    : "text-green-700 dark:text-green-300"
                }
              >
                Cache entries cleared:{" "}
                <span className="font-medium">
                  {orphanCleanupResult.cacheEntriesCleared}
                </span>
              </p>

              {orphanCleanupResult.errors.length > 0 && (
                <div className="mt-2">
                  <p className="text-yellow-800 dark:text-yellow-200 font-medium">
                    Errors encountered:
                  </p>
                  <ul className="mt-1 space-y-1 text-yellow-700 dark:text-yellow-300">
                    {orphanCleanupResult.errors.map((error, index) => (
                      <li key={index} className="text-xs">
                        • {error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {orphanCleanupResult.deletedCount > 0 &&
                orphanCleanupResult.errors.length === 0 && (
                  <p className="text-green-700 dark:text-green-300 font-medium mt-2">
                    ✅ Cleanup completed successfully!
                  </p>
                )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
