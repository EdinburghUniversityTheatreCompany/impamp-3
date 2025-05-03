"use client";

import React from "react";
import { KeyboardListenerProvider } from "./KeyboardListenerProvider";
import { SearchProvider } from "@/components/search";

export function KeyboardListenerWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SearchProvider>
      <KeyboardListenerProvider>{children}</KeyboardListenerProvider>
    </SearchProvider>
  );
}
