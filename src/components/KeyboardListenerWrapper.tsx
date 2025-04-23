"use client";

import React from "react";
import { KeyboardListenerProvider } from "./KeyboardListenerProvider";
import { SearchModalProvider } from "./SearchModalProvider";

export function KeyboardListenerWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SearchModalProvider>
      <KeyboardListenerProvider>{children}</KeyboardListenerProvider>
    </SearchModalProvider>
  );
}
