/**
 * The sentence to show a user for something that was thrown.
 *
 * A `catch` binding is `unknown`, and the maintenance panels all have to turn
 * one into text for a `role="alert"` box. Written once so the three of them
 * cannot disagree about what a non-`Error` looks like — `String(caught)` for
 * anything that is not one, never `"[object Object]"` from a template that
 * assumed `.message` was there.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
