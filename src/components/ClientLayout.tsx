"use client";

import React from "react";
import { KeyboardListenerWrapper } from "@/components/KeyboardListenerWrapper";
import ProfileManagerHost from "@/components/profiles/ProfileManagerHost";
import ModalRenderer from "@/components/ModalRenderer";
import ClientSideInitializer from "@/components/ClientSideInitializer";
import GoogleAuthProviderWrapper from "@/components/auth/GoogleAuthProviderWrapper";
import AuthNotification from "@/components/AuthNotification";

interface ClientLayoutProps {
  children: React.ReactNode;
}

/**
 * Client-side wrapper component that holds all client components
 * This allows us to keep the root layout as a server component
 * while still using client functionality
 */
const ClientLayout: React.FC<ClientLayoutProps> = ({ children }) => {
  return (
    <GoogleAuthProviderWrapper>
      <KeyboardListenerWrapper>
        <AuthNotification />
        <ClientSideInitializer>{children}</ClientSideInitializer>
        <ProfileManagerHost />
        <ModalRenderer />
      </KeyboardListenerWrapper>
    </GoogleAuthProviderWrapper>
  );
};

export default ClientLayout;
