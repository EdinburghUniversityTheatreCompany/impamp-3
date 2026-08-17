"use client";

import React from "react";
import { stopAllAudio } from "@/lib/audio";

/**
 * Stop every sound.
 *
 * The import is static, and deliberately so. `playbackStore` reaches for
 * `@/lib/audio` with a dynamic import and the first draft of this copied that —
 * whereupon the e2e test caught it: the fallback exists precisely because a
 * chunk request failed, and the very next chunk request is no more likely to
 * succeed. The button rendered, was pressed, and the audio kept playing.
 *
 * It costs nothing anyway: `PadGrid` already imports `stopAllAudio` from here
 * statically, so the module is in the initial load either way.
 */
export function stopAllSoundsFromFallback(): void {
  try {
    stopAllAudio();
  } catch (error) {
    console.error("[ErrorBoundary] Could not stop audio:", error);
  }
}

const ACTION_CLASSES = {
  danger: "bg-red-600 hover:bg-red-700 text-white",
  neutral:
    "bg-gray-100 hover:bg-gray-200 text-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-200",
} as const;

interface ErrorActionProps {
  tone: keyof typeof ACTION_CLASSES;
  onClick: () => void;
  children: React.ReactNode;
}

/** One button in an error panel. */
export function ErrorAction({ tone, onClick, children }: ErrorActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${ACTION_CLASSES[tone]}`}
    >
      {children}
    </button>
  );
}

interface ErrorPanelProps {
  testId: string;
  title: string;
  description: string;
  children: React.ReactNode;
}

/**
 * The panel every fallback in the app renders.
 *
 * "Stop all sounds" comes first and is the only destructive-styled action,
 * because once a render has thrown, the Escape panic key is the thing least
 * likely to still be listening — and audio started before the failure carries
 * on regardless, since the Web Audio graph lives at module scope.
 */
export function ErrorPanel({
  testId,
  title,
  description,
  children,
}: ErrorPanelProps) {
  return (
    <div
      data-testid={testId}
      role="alert"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full">
        <h2 className="text-xl font-semibold mb-2 text-gray-900 dark:text-gray-100">
          {title}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">
          {description}
        </p>
        <div className="flex flex-wrap gap-3 justify-end">
          <ErrorAction tone="danger" onClick={stopAllSoundsFromFallback}>
            Stop all sounds
          </ErrorAction>
          {children}
        </div>
      </div>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Named in the console line, so a report says which subtree died. */
  label: string;
  /** `reset` clears the error and re-renders the subtree. */
  fallback: (reset: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Catches a render error in its subtree and shows a fallback instead of letting
 * React unmount the whole tree.
 *
 * The app had none of these, and `ModalRenderer` renders four `React.lazy`
 * modals behind a bare `Suspense`. `Suspense` covers the pending case only: a
 * rejected `import()` re-throws on the next render attempt, propagates past the
 * root, and Next replaces the entire document with its built-in "This page
 * couldn't load" screen. For a soundboard that is the worst possible failure —
 * whatever was playing keeps playing, and the panic key that could stop it has
 * just been unmounted.
 *
 * Placement matters as much as existence: the boundaries in `ClientLayout` sit
 * *inside* `KeyboardListenerWrapper`, so a subtree that throws never takes the
 * global keyboard listener with it and Escape still stops the audio.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[ErrorBoundary:${this.props.label}]`,
      error,
      info.componentStack,
    );
  }

  private reset = () => this.setState({ hasError: false });

  render() {
    if (this.state.hasError) {
      return this.props.fallback(this.reset);
    }
    return this.props.children;
  }
}
