'use client';

import React from 'react';
import { useKeyboardListener } from '@/hooks/useKeyboardListener';

export function KeyboardListenerProvider({ children }: { children: React.ReactNode }) {
  // This hook sets up the global keyboard event listener
  useKeyboardListener();

  // Simply render children - the hook handles all the event listener logic
  return <>{children}</>;
}
