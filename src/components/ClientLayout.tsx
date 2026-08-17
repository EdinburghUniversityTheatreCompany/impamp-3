"use client";

import React from "react";
import { KeyboardListenerWrapper } from "@/components/KeyboardListenerWrapper";
import ProfileManagerHost from "@/components/profiles/ProfileManagerHost";
import ModalRenderer from "@/components/ModalRenderer";
import ClientSideInitializer from "@/components/ClientSideInitializer";
import GoogleAuthProviderWrapper from "@/components/auth/GoogleAuthProviderWrapper";
import AuthNotification from "@/components/AuthNotification";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  OverlayErrorFallback,
  SoundboardErrorFallback,
} from "@/components/errorFallbacks";

interface ClientLayoutProps {
  children: React.ReactNode;
}

/**
 * Client-side wrapper component that holds all client components
 * This allows us to keep the root layout as a server component
 * while still using client functionality
 *
 * Three separate boundaries rather than one, all *inside*
 * `KeyboardListenerWrapper`. The nesting is the point:
 *
 *  - inside, so a subtree that throws does not unmount the global keyboard
 *    listener with it, and Escape still stops every sound;
 *  - separate, so a modal whose chunk failed to load costs you the modal and
 *    not the board underneath it — which is the concrete failure this exists
 *    for, since the four largest modals are `React.lazy` and any dropped chunk
 *    request rejects the import.
 */
const ClientLayout: React.FC<ClientLayoutProps> = ({ children }) => {
  return (
    <GoogleAuthProviderWrapper>
      <KeyboardListenerWrapper>
        <AuthNotification />
        <ErrorBoundary
          label="soundboard"
          fallback={(reset) => <SoundboardErrorFallback reset={reset} />}
        >
          <ClientSideInitializer>{children}</ClientSideInitializer>
        </ErrorBoundary>
        <ErrorBoundary
          label="profile-manager"
          fallback={(reset) => <OverlayErrorFallback reset={reset} />}
        >
          <ProfileManagerHost />
        </ErrorBoundary>
        <ErrorBoundary
          label="modal"
          fallback={(reset) => <OverlayErrorFallback reset={reset} />}
        >
          <ModalRenderer />
        </ErrorBoundary>
      </KeyboardListenerWrapper>
    </GoogleAuthProviderWrapper>
  );
};

export default ClientLayout;
