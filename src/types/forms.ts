/**
 * Form Type Definitions
 *
 * Standardized types for form values, errors, and related structures
 * used across the application's form modals.
 *
 * @module types/forms
 */

import { PlaybackType } from "@/lib/db";

/**
 * Values for pad edit form
 */
export interface PadFormValues extends Record<string, unknown> {
  name: string;
  playbackType: PlaybackType;
  audioFileIds: number[];
}

/**
 * Values for bank edit form
 */
export interface BankFormValues extends Record<string, unknown> {
  name: string;
  isEmergency: boolean;
}

/**
 * Values for profile edit form
 */
export interface ProfileFormValues extends Record<string, unknown> {
  name: string;
  backupReminderPeriod: number;
  activePadBehavior: "continue" | "stop" | "restart";
}

/**
 * Values for playback settings form
 */
export interface PlaybackSettingsFormValues extends Record<string, unknown> {
  fadeoutDuration: number;
  activePadBehavior: "continue" | "stop" | "restart";
}

/**
 * Values for global settings form
 */
export interface SettingsFormValues extends Record<string, unknown> {
  // Add global settings as needed
  defaultTheme?: "light" | "dark" | "system";
  padGridRows?: number;
  padGridColumns?: number;
  enableKeyboardShortcuts?: boolean;
}

/**
 * Type for form validation errors
 * Creates a partial record where each key from T can have an error message string
 */
export type FormErrors<T> = Partial<Record<keyof T, string>>;
