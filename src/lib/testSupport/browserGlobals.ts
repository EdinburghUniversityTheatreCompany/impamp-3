/**
 * The browser globals an IndexedDB-backed Vitest suite needs, installed as an
 * import side effect.
 *
 * Vitest runs in the node environment, so there is no DOM and no IndexedDB.
 * `db.ts` reads `window` *as it evaluates* to decide whether it is on a
 * client, which means the global has to exist before that module is imported —
 * and static imports are hoisted above a test file's own statements. Doing the
 * work here, in a module whose only job is the side effect, is what makes the
 * ordering reliable:
 *
 *   import "@/lib/testSupport/browserGlobals";   // first import, no exceptions
 *   const { getDb } = await import("@/lib/db");  // dynamic, so it runs after
 *
 * This module must not statically import anything that touches IndexedDB, or
 * that import would be hoisted above the assignments below and defeat the
 * whole arrangement.
 */

import "fake-indexeddb/auto";

// Only what is missing. A suite that renders React asks for the jsdom
// environment and so already has both of these — and jsdom's `localStorage`
// is a getter-only accessor, so assigning over it throws rather than being
// ignored. `fake-indexeddb/auto` above is still wanted either way: jsdom has
// no IndexedDB of its own.
if (!globalThis.window) {
  globalThis.window = globalThis as unknown as Window & typeof globalThis;
}

// The Drive sync path stamps a sync timestamp on the way out. Nothing under
// test reads it back, so the smallest thing satisfying the calls will do.
if (!globalThis.localStorage) {
  const storage = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  } as Storage;
}

/**
 * Empties every object store.
 *
 * `getDb` memoises its connection, so a suite cannot swap the database between
 * tests — it empties it instead. Note that autoIncrement counters are *not*
 * reset by this, so tests must key their expectations off an id the store
 * handed back rather than a literal.
 */
export async function clearAllStores(): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  const tx = db.transaction(
    ["profiles", "audioFiles", "padConfigurations", "pageMetadata"],
    "readwrite",
  );
  await Promise.all([
    tx.objectStore("profiles").clear(),
    tx.objectStore("audioFiles").clear(),
    tx.objectStore("padConfigurations").clear(),
    tx.objectStore("pageMetadata").clear(),
    tx.done,
  ]);
}
