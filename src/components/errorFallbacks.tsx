"use client";

import React from "react";
import { useUIStore } from "@/store/uiStore";
import { useProfileStore } from "@/store/profileStore";
import { ErrorAction, ErrorPanel } from "./ErrorBoundary";

const reloadPage = () => window.location.reload();

/**
 * Shown when the soundboard itself fails to render.
 *
 * "Try again" is offered here and not on the overlay fallback because a
 * soundboard failure is usually transient state, whereas the overlay failure we
 * have a concrete trigger for is a rejected `React.lazy` import — and `lazy`
 * caches its rejection, so re-rendering the same modal would throw again the
 * instant it mounted.
 */
export function SoundboardErrorFallback({ reset }: { reset: () => void }) {
  return (
    <ErrorPanel
      testId="app-error-fallback"
      title="The soundboard stopped responding"
      description="Something went wrong while drawing the board. Any sound that was already playing is still playing — stop it here if you need to."
    >
      <ErrorAction tone="neutral" onClick={reset}>
        Try again
      </ErrorAction>
      <ErrorAction tone="neutral" onClick={reloadPage}>
        Reload
      </ErrorAction>
    </ErrorPanel>
  );
}

/**
 * Shown when a modal or the profile manager fails to render.
 *
 * Closing has to happen before the reset: the boundary re-renders its children
 * on reset, and the modal that just threw is still the open one until the store
 * says otherwise. Both closers run because one fallback serves both overlays,
 * and closing something that is already closed is a no-op.
 */
export function OverlayErrorFallback({ reset }: { reset: () => void }) {
  const dismiss = () => {
    useUIStore.getState().closeModal();
    useProfileStore.getState().closeProfileManager();
    reset();
  };

  return (
    <ErrorPanel
      testId="modal-error-fallback"
      title="This dialog could not be opened"
      description="Its code failed to load — usually a dropped connection or a deploy that happened while this tab was open. The soundboard behind it is unaffected; close this and carry on, or reload when you get a chance."
    >
      <ErrorAction tone="neutral" onClick={dismiss}>
        Close
      </ErrorAction>
      <ErrorAction tone="neutral" onClick={reloadPage}>
        Reload
      </ErrorAction>
    </ErrorPanel>
  );
}
