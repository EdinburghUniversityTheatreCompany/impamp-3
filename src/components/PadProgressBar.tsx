import React from "react";

interface PadProgressBarProps {
  progress: number; // 0.0 to 1.0
  remainingTime: number | null; // Seconds, or null if not available/applicable
}

const PadProgressBar: React.FC<PadProgressBarProps> = ({
  progress,
  remainingTime,
}) => {
  // Ensure progress is within bounds
  const clampedProgress = Math.max(0, Math.min(1, progress));

  return (
    <div className="absolute bottom-0 left-0 right-0 h-4 bg-gray-200 dark:bg-gray-700 z-50 flex items-center justify-center overflow-hidden">
      {/* Background progress bar */}
      <div
        className="absolute left-0 top-0 bottom-0 bg-green-500 transition-width duration-100 ease-linear" // Use transition-width
        style={{ width: `${clampedProgress * 100}%` }}
        role="progressbar"
        aria-valuenow={clampedProgress * 100}
        aria-valuemin={0}
        aria-valuemax={100}
      />
      {/* Timer text - centered on top */}
      {remainingTime !== null && (
        <span className="relative z-10 text-xs font-semibold text-white mix-blend-difference">
          {remainingTime}s
        </span>
      )}
    </div>
  );
};

export default PadProgressBar;
