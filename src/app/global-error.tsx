"use client";

import { useEffect } from "react";
import "./globals.css";
import {
  ErrorAction,
  ErrorPanel,
  stopAllSoundsFromFallback,
} from "@/components/ErrorBoundary";

/**
 * The last resort: an error thrown above every boundary in `ClientLayout`,
 * i.e. in the root layout itself.
 *
 * Next's default for this case is a bare "This page couldn't load" screen with
 * Reload and Back. On a soundboard that is not enough, because the Web Audio
 * graph lives at module scope and survives the unmount — the audio keeps
 * playing into the room with nothing on screen able to stop it. So this replaces
 * the default purely to add the panic stop.
 *
 * It must render its own <html> and <body>: Next mounts this *instead of* the
 * root layout, not inside it.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <ErrorPanel
          testId="global-error-fallback"
          title="ImpAmp could not start"
          description="The app failed to load. If a sound was playing when this happened it is still playing — stop it here before you reload."
        >
          <ErrorAction tone="neutral" onClick={reset}>
            Try again
          </ErrorAction>
          <ErrorAction
            tone="neutral"
            onClick={() => {
              stopAllSoundsFromFallback();
              window.location.reload();
            }}
          >
            Stop and reload
          </ErrorAction>
        </ErrorPanel>
      </body>
    </html>
  );
}
