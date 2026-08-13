/**
 * End-to-end test hooks
 *
 * The Playwright suite runs against a production build (see playwright.config.ts),
 * so `NODE_ENV !== "production"` is false there and anything gated on it is gone
 * by the time the tests run. These helpers gate on an explicit build-time flag
 * instead: playwright.config.ts sets NEXT_PUBLIC_E2E_HOOKS=1 for the server it
 * starts, while a real deploy leaves it unset and Next inlines the check as
 * `undefined === "1"`, so the hooks are dropped.
 *
 * Only expose read-only views of state the UI cannot otherwise reveal — a hook
 * is a test affordance, not a second public API.
 *
 * @module lib/testHooks
 */

export const e2eHooksEnabled =
  process.env.NODE_ENV !== "production" ||
  process.env.NEXT_PUBLIC_E2E_HOOKS === "1";

/**
 * Attaches a value to `window` under the given name when test hooks are enabled.
 * No-ops during SSR and in ordinary production builds.
 */
export function exposeE2EHook(name: string, value: unknown): void {
  if (typeof window === "undefined" || !e2eHooksEnabled) return;
  (window as unknown as Record<string, unknown>)[name] = value;
}
