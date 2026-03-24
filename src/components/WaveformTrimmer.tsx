/**
 * Waveform Trimmer Component
 *
 * Canvas-based waveform visualization with draggable start/end trim handles.
 * Opens as an overlay from the EditPadForm for per-sound trimming.
 *
 * @module components/WaveformTrimmer
 */

import React, { useRef, useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { getWaveformPeaks, WaveformPeak } from "@/lib/audio/waveform";
import { getAudioFile } from "@/lib/db";
import { decodeAudioBlob } from "@/lib/audio/decoder";
import { getAudioContext } from "@/lib/audio/context";
import { playBuffer, stopTrack } from "@/lib/audio/playback";

interface WaveformTrimmerProps {
  audioFileId: number;
  audioFileName: string;
  trimStart: number;
  trimEnd: number;
  onTrimChange: (trimStart: number, trimEnd: number) => void;
  onClose: () => void;
}

type DragTarget = "start" | "end" | null;

const WAVEFORM_POINTS = 800;
const HANDLE_WIDTH = 8;
const CANVAS_HEIGHT = 120;
const PADDING_TOP = 20;
const PADDING_BOTTOM = 30;
const WAVEFORM_HEIGHT = CANVAS_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(2).padStart(5, "0")}`;
}

const WaveformTrimmer: React.FC<WaveformTrimmerProps> = ({
  audioFileId,
  audioFileName,
  trimStart: initialTrimStart,
  trimEnd: initialTrimEnd,
  onTrimChange,
  onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [peaks, setPeaks] = useState<WaveformPeak[] | null>(null);
  const [duration, setDuration] = useState<number>(0);
  const [trimStart, setTrimStart] = useState<number>(initialTrimStart);
  const [trimEnd, setTrimEnd] = useState<number>(initialTrimEnd);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DragTarget>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);

  // Load and decode audio
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);

        const audioFile = await getAudioFile(audioFileId);
        if (!audioFile || cancelled) return;

        const buffer = await decodeAudioBlob(audioFile.blob);
        if (cancelled) return;

        bufferRef.current = buffer;
        setDuration(buffer.duration);

        // If trimEnd is 0 or beyond duration, set to full duration
        if (initialTrimEnd <= 0 || initialTrimEnd > buffer.duration) {
          setTrimEnd(buffer.duration);
        }

        const waveformPeaks = getWaveformPeaks(buffer, WAVEFORM_POINTS);
        setPeaks(waveformPeaks);
      } catch (err) {
        if (!cancelled) {
          setError(
            `Failed to load audio: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [audioFileId, initialTrimEnd]);

  // Draw waveform
  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || duration <= 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const centerY = PADDING_TOP + WAVEFORM_HEIGHT / 2;

    ctx.clearRect(0, 0, width, height);

    // Draw dimmed regions (outside trim)
    const startX = (trimStart / duration) * width;
    const endX = (trimEnd / duration) * width;

    // Dimmed left region
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.fillRect(0, PADDING_TOP, startX, WAVEFORM_HEIGHT);

    // Dimmed right region
    ctx.fillRect(endX, PADDING_TOP, width - endX, WAVEFORM_HEIGHT);

    // Draw waveform
    const pointWidth = width / peaks.length;

    for (let i = 0; i < peaks.length; i++) {
      const x = i * pointWidth;
      const peak = peaks[i];
      const isInTrimRegion = x >= startX && x <= endX;

      // Active region in blue, inactive in gray
      ctx.fillStyle = isInTrimRegion
        ? "rgb(59, 130, 246)"
        : "rgb(156, 163, 175)";

      const minY = centerY - peak.min * (WAVEFORM_HEIGHT / 2);
      const maxY = centerY - peak.max * (WAVEFORM_HEIGHT / 2);
      const barHeight = Math.max(1, minY - maxY);

      ctx.fillRect(x, maxY, Math.max(1, pointWidth - 0.5), barHeight);
    }

    // Draw trim handles
    drawHandle(ctx, startX, height, "start");
    drawHandle(ctx, endX, height, "end");

    // Draw time labels
    ctx.fillStyle = "rgb(107, 114, 128)";
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    ctx.fillText(formatTime(trimStart), Math.max(0, startX - 20), height - 5);
    ctx.textAlign = "right";
    ctx.fillText(formatTime(trimEnd), Math.min(width, endX + 20), height - 5);

    // Draw duration label centered
    const trimmedDuration = trimEnd - trimStart;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgb(59, 130, 246)";
    ctx.fillText(
      `Duration: ${formatTime(trimmedDuration)}`,
      width / 2,
      PADDING_TOP - 5,
    );
  }, [peaks, duration, trimStart, trimEnd]);

  function drawHandle(
    ctx: CanvasRenderingContext2D,
    x: number,
    height: number,
    type: "start" | "end",
  ) {
    // Handle line
    ctx.strokeStyle =
      type === "start" ? "rgb(34, 197, 94)" : "rgb(239, 68, 68)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, PADDING_TOP);
    ctx.lineTo(x, PADDING_TOP + WAVEFORM_HEIGHT);
    ctx.stroke();

    // Handle grip
    ctx.fillStyle = type === "start" ? "rgb(34, 197, 94)" : "rgb(239, 68, 68)";
    const gripY = PADDING_TOP + WAVEFORM_HEIGHT / 2 - 12;
    ctx.beginPath();
    ctx.roundRect(x - HANDLE_WIDTH / 2, gripY, HANDLE_WIDTH, 24, 3);
    ctx.fill();

    // Grip lines
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1;
    for (let i = -4; i <= 4; i += 4) {
      ctx.beginPath();
      ctx.moveTo(x - 2, gripY + 12 + i);
      ctx.lineTo(x + 2, gripY + 12 + i);
      ctx.stroke();
    }
  }

  // Redraw on state changes
  useEffect(() => {
    drawWaveform();
  }, [drawWaveform]);

  // Handle canvas resize
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resizeObserver = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = CANVAS_HEIGHT;
      drawWaveform();
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [drawWaveform]);

  // Mouse/touch interaction
  const getTimeFromX = useCallback(
    (clientX: number): number => {
      const canvas = canvasRef.current;
      if (!canvas || duration <= 0) return 0;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      return ratio * duration;
    },
    [duration],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas || duration <= 0) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const startX = (trimStart / duration) * rect.width;
      const endX = (trimEnd / duration) * rect.width;

      // Check which handle is closest
      const distToStart = Math.abs(x - startX);
      const distToEnd = Math.abs(x - endX);
      const threshold = 20;

      if (distToStart < threshold && distToStart <= distToEnd) {
        setDragging("start");
        canvas.setPointerCapture(e.pointerId);
      } else if (distToEnd < threshold) {
        setDragging("end");
        canvas.setPointerCapture(e.pointerId);
      }
    },
    [duration, trimStart, trimEnd],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;

      const time = getTimeFromX(e.clientX);
      const minGap = 0.05; // 50ms minimum trim region

      if (dragging === "start") {
        const newStart = Math.max(0, Math.min(time, trimEnd - minGap));
        setTrimStart(newStart);
      } else if (dragging === "end") {
        const newEnd = Math.min(duration, Math.max(time, trimStart + minGap));
        setTrimEnd(newEnd);
      }
    },
    [dragging, duration, trimStart, trimEnd, getTimeFromX],
  );

  const handlePointerUp = useCallback(() => {
    setDragging(null);
  }, []);

  // Preview playback
  const handlePreview = useCallback(() => {
    const buffer = bufferRef.current;
    if (!buffer) return;

    // Stop previous preview if playing
    if (previewKey) {
      stopTrack(previewKey);
    }

    const key = `preview-trim-${Date.now()}`;
    setPreviewKey(key);

    playBuffer(buffer, key, {
      name: `Preview: ${audioFileName}`,
      padInfo: { profileId: 0, pageIndex: 0, padIndex: 0 },
      trimStart,
      trimEnd,
      multiSoundState: {
        playbackType: "sequential",
        allAudioFileIds: [audioFileId],
        currentAudioFileId: audioFileId,
      },
    });
  }, [trimStart, trimEnd, audioFileId, audioFileName, previewKey]);

  // Save and close
  const handleSave = useCallback(() => {
    onTrimChange(trimStart, trimEnd);
    onClose();
  }, [trimStart, trimEnd, onTrimChange, onClose]);

  // Reset to full duration
  const handleReset = useCallback(() => {
    setTrimStart(0);
    setTrimEnd(duration);
  }, [duration]);

  // Stop preview on unmount
  useEffect(() => {
    return () => {
      if (previewKey) {
        stopTrack(previewKey);
      }
    };
  }, [previewKey]);

  const content = (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            Trim: {audioFileName}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            type="button"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-4">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
              <span className="ml-2 text-gray-500 dark:text-gray-400 text-sm">
                Loading waveform...
              </span>
            </div>
          ) : error ? (
            <div className="text-red-500 text-sm text-center py-8">{error}</div>
          ) : (
            <>
              {/* Waveform canvas */}
              <div
                ref={containerRef}
                className="w-full bg-gray-50 dark:bg-gray-900 rounded border border-gray-200 dark:border-gray-700 cursor-col-resize"
              >
                <canvas
                  ref={canvasRef}
                  height={CANVAS_HEIGHT}
                  className="w-full"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  style={{ touchAction: "none" }}
                />
              </div>

              {/* Time info */}
              <div className="flex justify-between mt-2 text-xs text-gray-500 dark:text-gray-400 font-mono">
                <span>Start: {formatTime(trimStart)}</span>
                <span>
                  Duration: {formatTime(trimEnd - trimStart)} /{" "}
                  {formatTime(duration)}
                </span>
                <span>End: {formatTime(trimEnd)}</span>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handlePreview}
              disabled={loading || !!error}
              className="px-3 py-1.5 text-sm font-medium rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Preview
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={loading || !!error}
              className="px-3 py-1.5 text-sm font-medium rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
            >
              Reset
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm font-medium rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={loading || !!error}
              className="px-3 py-1.5 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
};

export default WaveformTrimmer;
