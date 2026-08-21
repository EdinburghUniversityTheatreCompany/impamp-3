"use client";

import type { TransferProgress } from "@/lib/importExport";

/**
 * Progress bar shown while a ZIP export/import streams audio files.
 *
 * Its own module because three surfaces show it now — the profile export, the
 * profile import and the bank export — and the bank export lives in a panel of
 * its own, which `ProfileManager` renders. A copy kept next to each caller
 * would be the duplicated rule this repo regresses on, and importing it back
 * out of `ProfileManager` would be a cycle.
 */
export default function TransferProgressBar({
  progress,
  verb,
}: {
  progress: TransferProgress;
  verb: string;
}) {
  const percent =
    progress.totalBytes > 0
      ? Math.min(
          100,
          Math.round((progress.processedBytes / progress.totalBytes) * 100),
        )
      : progress.phase === "finalizing"
        ? 100
        : 0;
  const label =
    progress.phase === "preparing"
      ? "Preparing…"
      : progress.phase === "finalizing"
        ? "Finalizing…"
        : `${verb} ${progress.fileName ?? "audio"} (${Math.min(
            progress.processedFiles + 1,
            progress.totalFiles,
          )}/${progress.totalFiles})`;

  return (
    <div className="mt-3" data-testid="transfer-progress">
      <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
        <span className="truncate pr-2">{label}</span>
        <span className="shrink-0">{percent}%</span>
      </div>
      <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 rounded-full transition-[width] duration-150"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
