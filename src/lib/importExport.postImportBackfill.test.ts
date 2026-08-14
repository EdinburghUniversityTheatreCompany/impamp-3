import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IDBPDatabase } from "idb";
import type { ImpAmpDBSchema } from "./db";
import type { ProfileExport } from "./importExport";

// `runBackfill` is what should get triggered once a ZIP/JSON import commits
// — see the comment at the end of `importProfileCore`. Mocking the pipeline
// module lets this test observe that trigger without pulling in the
// Web-Audio-only decode/analyse machinery, and without needing a real
// IndexedDB (this suite runs under Vitest's node environment).
const runBackfill = vi.fn().mockResolvedValue(undefined);
vi.mock("./audio/loudness/pipeline", () => ({
  runBackfill: () => runBackfill(),
}));

/**
 * A minimal stand-in for `idb`'s `IDBPDatabase`, supporting just the calls
 * `importProfileCore` and its helpers make: `transaction(...).objectStore(
 * ...).add(...)`, the `.store` shortcut used for the profile-name-uniqueness
 * check, and `.done`. Good enough to drive `importProfile` end-to-end without
 * a real IndexedDB implementation.
 */
function createFakeDb(): IDBPDatabase<ImpAmpDBSchema> {
  let nextId = 1;

  const makeStore = () => ({
    add: async (...[]: unknown[]) => nextId++,
    index: (...[]: unknown[]) => ({
      get: async (...[]: unknown[]) => undefined, // never a name conflict
    }),
  });

  const transaction = (...[]: unknown[]) => {
    const store = makeStore();
    return {
      objectStore: (...[]: unknown[]) => store,
      store,
      done: Promise.resolve(),
    };
  };

  return { transaction } as unknown as IDBPDatabase<ImpAmpDBSchema>;
}

function minimalExport(overrides: Partial<ProfileExport> = {}): ProfileExport {
  return {
    exportVersion: 2,
    exportDate: new Date(0).toISOString(),
    profile: {
      name: "Imported Profile",
      syncType: "local",
      backupReminderPeriod: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    padConfigurations: [],
    pageMetadata: [],
    audioFiles: [],
    ...overrides,
  };
}

// The trigger is fire-and-forget (`void import(...).then(...)`), and the
// dynamic `import()` itself takes an extra microtask turn or two even though
// the module is mocked — so give it several ticks rather than assume one is
// enough.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("importProfile triggers a post-import backfill", () => {
  beforeEach(() => {
    runBackfill.mockClear();
  });

  it("calls runBackfill once the import transaction commits", async () => {
    const { importProfile } = await import("./importExport");
    const db = createFakeDb();

    const profileId = await importProfile(db, minimalExport());

    expect(profileId).toBeGreaterThan(0);
    await flushMicrotasks();
    expect(runBackfill).toHaveBeenCalledTimes(1);
  });

  it("does not let a backfill failure surface as an unhandled rejection", async () => {
    runBackfill.mockRejectedValueOnce(new Error("boom"));
    const { importProfile } = await import("./importExport");
    const db = createFakeDb();

    // The import itself must still resolve normally.
    await expect(importProfile(db, minimalExport())).resolves.toEqual(
      expect.any(Number),
    );

    await flushMicrotasks();
    expect(runBackfill).toHaveBeenCalledTimes(1);
  });
});
