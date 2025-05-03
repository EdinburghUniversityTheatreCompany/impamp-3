/**
 * Keyboard Shortcut Hook
 *
 * Provides a type-safe way to register and manage keyboard shortcuts
 *
 * @module hooks/useKeyboardShortcut
 */

import { useEffect, useCallback, useRef } from "react";

export interface KeyboardShortcutOptions {
  /**
   * Keys that trigger the shortcut (e.g., ['Control', 'f'])
   */
  keys: string[];

  /**
   * Callback function to execute when shortcut is triggered
   */
  callback: (event: KeyboardEvent) => void;

  /**
   * Whether the shortcut should be active
   * @default true
   */
  isEnabled?: boolean;

  /**
   * Element to listen for keyboard events
   * @default window
   */
  target?: Window | HTMLElement | null;

  /**
   * Whether event.preventDefault() should be called
   * @default true
   */
  preventDefault?: boolean;

  /**
   * Whether event.stopPropagation() should be called
   * @default false
   */
  stopPropagation?: boolean;

  /**
   * Additional condition that must be true for the shortcut to be triggered
   */
  condition?: () => boolean;
}

/**
 * Determines if all keys in the shortcut are currently pressed
 *
 * @param event - The keyboard event
 * @param keys - Array of key names to check
 * @returns True if all keys are pressed, false otherwise
 */
function areKeysPressed(event: KeyboardEvent, keys: string[]): boolean {
  // Special handling for modifier keys
  const modifierMap: Record<string, keyof KeyboardEvent> = {
    Control: "ctrlKey",
    Shift: "shiftKey",
    Alt: "altKey",
    Meta: "metaKey",
  };

  // For each key in the shortcut, check if it's pressed
  return keys.every((key) => {
    // Check for modifier keys first
    if (key in modifierMap) {
      return event[modifierMap[key] as keyof KeyboardEvent] as boolean;
    }

    // Special handling for Space key
    if (key === " " || key === "Space") {
      return event.key === " ";
    }

    // Normal key comparison (case-insensitive)
    return event.key.toLowerCase() === key.toLowerCase();
  });
}

/**
 * Hook for registering and handling keyboard shortcuts
 *
 * @param options - Keyboard shortcut configuration
 */
export function useKeyboardShortcut(options: KeyboardShortcutOptions): void {
  const {
    keys,
    callback,
    isEnabled = true,
    target = typeof window !== "undefined" ? window : null,
    preventDefault = true,
    stopPropagation = false,
    condition,
  } = options;

  // Use refs to ensure we always have the latest callback and condition
  const callbackRef = useRef(callback);
  const conditionRef = useRef(condition);

  // Update refs when props change
  useEffect(() => {
    callbackRef.current = callback;
    conditionRef.current = condition;
  }, [callback, condition]);

  // Create the event handler
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Skip if shortcut is disabled
      if (!isEnabled) return;

      // Check if condition is met (if provided)
      if (conditionRef.current && !conditionRef.current()) return;

      // Check if all required keys are pressed
      if (areKeysPressed(event, keys)) {
        if (preventDefault) {
          event.preventDefault();
        }

        if (stopPropagation) {
          event.stopPropagation();
        }

        // Call the callback with the event
        callbackRef.current(event);
      }
    },
    [isEnabled, keys, preventDefault, stopPropagation],
  );

  // Set up the event listener
  useEffect(() => {
    if (!target) return;

    target.addEventListener("keydown", handleKeyDown as EventListener);

    // Cleanup
    return () => {
      target.removeEventListener("keydown", handleKeyDown as EventListener);
    };
  }, [target, handleKeyDown]);
}
