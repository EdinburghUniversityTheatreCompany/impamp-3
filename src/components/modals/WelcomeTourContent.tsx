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

import React, { useEffect, useState } from "react";
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
      title: "Control ImpAmp with the keyboard",
      body: (
        <p>
          To play a sound, just press the key that&apos;s on the pad.{" "}
          <strong>Esc</strong> stops all sounds, and <strong>space</strong>{" "}
          fades them all out. Your hands never have to leave the keyboard.
        </p>
      ),
    },
    {
      title: "Put a sound on a pad",
      body: (
        <>
          <p>
            To add a sound, just drag a soundfile onto a pad, or click a pad to
            open its editor. One pad can hold a whole stack of sounds and play
            them in order, at random, or round-robin, and you can tweak the
            length and volume of each sound.
          </p>
          <p>
            Your sounds stay in this browser. Nothing gets uploaded anywhere
            unless you connect a profile to Google Drive or to a server.
          </p>
        </>
      ),
    },
    {
      title: "Banks are your cue sheet",
      body: (
        <p>
          The tabs above the grid are banks: you can have at most twenty of
          them, and each is a full board. Press <strong>1</strong> to{" "}
          <strong>9</strong> and <strong>0</strong> to switch, or add{" "}
          <strong>Ctrl</strong> for bank 11 to 20, or click a tab.
        </p>
      ),
    },
    {
      title: "Find out more",
      body: (
        <>
          <p>
            The <strong>?</strong> button in the toolbar can tell you everything
            about ImpAmp: every shortcut, importing and exporting boards,
            sharing and syncing.
          </p>
          <p>
            Two extra shortcuts here: <strong>{modifier}+F</strong> searches
            every sound in every bank, and <strong>{modifier}+click</strong>{" "}
            queues a sound to fire later with <strong>F9</strong>.
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

  // Recorded on unmount, not through the modal's `onCancel`. `Modal` reaches
  // `onCancel` only from the Cancel button, so Escape, the × and a backdrop
  // click all closed straight past it — and this tour renders no Cancel
  // button at all, which made the handler dead code. It was measured:
  // `welcomeTourSeen` stayed null after Escape and the tour came back on the
  // next load.
  //
  // `EditPadModalContent` states the rule thirty lines from here, for the same
  // reason: unmount is the one path every dismissal takes.
  useEffect(() => markWelcomeTourSeen, []);

  const finish = () => {
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
