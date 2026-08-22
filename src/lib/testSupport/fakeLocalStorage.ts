/**
 * A `window.localStorage` a test can control, and one that refuses.
 *
 * Two suites need both — the welcome tour's memory and the rule that decides
 * whether to offer it — and the failing store is the interesting one: real
 * `localStorage` *throws* where site data is blocked rather than returning
 * null, on the read as well as the write. Anything consulting it during a
 * first paint has to survive that, so a fake that only models success would
 * test the half that was never in doubt.
 */

import { vi } from "vitest";

/** Installs a working store, and returns what it holds. */
export function installFakeLocalStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  });
  return data;
}

/** Installs a store that throws on every access, as a blocked browser does. */
export function installThrowingLocalStorage(): void {
  const boom = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  vi.stubGlobal("window", {
    localStorage: { getItem: boom, setItem: boom, removeItem: boom },
  });
}
