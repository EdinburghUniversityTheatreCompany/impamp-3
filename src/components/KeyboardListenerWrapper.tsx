'use client';

import React from 'react';
import { KeyboardListenerProvider } from './KeyboardListenerProvider';

export function KeyboardListenerWrapper({ children }: { children: React.ReactNode }) {
  return (
    <KeyboardListenerProvider>
      {children}
    </KeyboardListenerProvider>
  );
}
