"use client";

/**
 * The first-use tour (issue #8).
 *
 * Four steps in the shared `Modal`, rather than coach marks anchored to the
 * real controls. Anchored callouts would need positioning logic this repo has
 * no library for, and every anchor would be a second copy of a selector that
 * drifts when the thing it points at moves — which the portrait layout just
 * did to the transport pads. A centred dialog inherits the focus trap,
 * `role="dialog"`, Escape handling and the safe-area work already done, and it
 * is the same at 412px as at 1280px.
 *
 * What it does NOT do is as deliberate. It never appears over a board that has
 * sounds on it (see `shouldOfferWelcomeTour`), so it is structurally incapable
 * of interrupting a show — which for a live performance tool matters more than
 * any amount of teaching. And it says nothing that the Help modal does not say
 * at greater length; its whole job is to point at where things are, once.
 *
 * @module components/modals/WelcomeTourContent
 */

import React, { useState } from "react";
import { markWelcomeTourSeen } from "@/lib/firstRun";
import { useUIStore } from "@/store/uiStore";
import { armModifierLabel } from "@/lib/platform";
import { useIsApplePlatform } from "@/hooks/useIsApplePlatform";

interface Step {
  title: string;
  body: React.ReactNode;
}

function steps(modifier: string): Step[] {
  return [
    {
      title: "Every pad is a key",
      body: (
        <>
          <p>
            The grid is your keyboard. The letter in the corner of a pad is the
            key that fires it — no modifier, no focus, just the key. That is the
            whole point of the app: during a show your hands never leave the
            keyboard.
          </p>
          <p>
            <strong>Esc</strong> stops everything, from anywhere. It is worth
            knowing that one before you need it.
          </p>
        </>
      ),
    },
    {
      title: "Put a sound on a pad",
      body: (
        <>
          <p>
            Drag an audio file onto any pad, or click the pad to open its
            editor. A pad can hold several sounds and play them in order, at
            random, or round-robin.
          </p>
          <p>
            Sounds live in this browser. Nothing is uploaded unless you connect
            a profile to Google Drive or to a server.
          </p>
        </>
      ),
    },
    {
      title: "Banks are your cue sheet",
      body: (
        <>
          <p>
            The tabs above the grid are banks — twenty of them, each a full
            board. Press <strong>1</strong> to <strong>9</strong> and{" "}
            <strong>0</strong> to switch, or tap a tab.
          </p>
          <p>
            Most people give a bank to an act, a scene, or a character. Hold{" "}
            <strong>Shift</strong> to rename one, or to drag them into the order
            your script runs in.
          </p>
        </>
      ),
    },
    {
      title: "When you need more",
      body: (
        <>
          <p>
            The <strong>?</strong> button in the toolbar has everything: every
            shortcut, importing and exporting boards, sharing and syncing.
          </p>
          <p>
            Two worth knowing now: <strong>{modifier}+F</strong> searches every
            sound in every bank, and <strong>{modifier}+click</strong> queues a
            sound to fire later with <strong>F9</strong>.
          </p>
        </>
      ),
    },
  ];
}

export default function WelcomeTourContent() {
  const isApple = useIsApplePlatform();
  const all = steps(armModifierLabel(isApple));
  const [index, setIndex] = useState(0);
  const closeModal = useUIStore((state) => state.closeModal);

  const step = all[index];
  const isLast = index === all.length - 1;

  // Every exit records the answer, including the Escape the shared Modal
  // handles for us — see `openWelcomeTour`, which passes the same call as its
  // cancel handler. A tour that only remembers being *finished* reappears for
  // everyone who dismissed it, which is the group most certain not to want it.
  const finish = () => {
    markWelcomeTourSeen();
    closeModal();
  };

  return (
    <div
      className="text-gray-700 dark:text-gray-300"
      data-testid="welcome-tour"
    >
      <div className="mb-2 flex items-center gap-2">
        {all.map((_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className={`h-1.5 flex-1 rounded-full ${
              i <= index ? "bg-blue-500" : "bg-gray-200 dark:bg-gray-600"
            }`}
          />
        ))}
      </div>

      <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
        Step {index + 1} of {all.length}
      </p>

      <h3
        className="mb-2 text-lg font-medium text-gray-900 dark:text-gray-100"
        data-testid="welcome-tour-title"
      >
        {step.title}
      </h3>

      <div className="space-y-3 text-sm leading-relaxed">{step.body}</div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={finish}
          data-testid="welcome-tour-skip"
          className="text-sm text-gray-500 underline hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          Skip
        </button>

        <div className="flex items-center gap-2">
          {index > 0 && (
            <button
              type="button"
              onClick={() => setIndex(index - 1)}
              data-testid="welcome-tour-back"
              className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={() => (isLast ? finish() : setIndex(index + 1))}
            data-testid="welcome-tour-next"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {isLast ? "Get started" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
