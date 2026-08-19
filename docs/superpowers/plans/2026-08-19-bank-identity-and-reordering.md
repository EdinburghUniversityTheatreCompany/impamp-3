# Bank Identity and Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every bank a stable `bankId`. Free `pageIndex` to mean position alone. Let a user drag the bank tabs into a new order in edit mode.

**Architecture:** `PageMetadata` keeps two separate fields. `bankId` is the identity that every database key, sync key and playback key uses. `pageIndex` is only the position in the tab strip and the keyboard shortcut. `PadConfiguration` drops `pageIndex` and names its bank by `bankId`. A DB v7 migration stamps the deterministic id `String(pageIndex)` onto every bank and pad, so two devices that migrate the same data agree on every id.

**Tech Stack:** TypeScript 6 (strict), Next.js 16, React 19, Zustand 5, idb 8 over IndexedDB, Vitest 4.1 with fake-indexeddb, Playwright 1.62, `@hello-pangea/dnd` 18.

**Spec:** docs/superpowers/specs/2026-08-19-banks-and-layering-design.md (§0 and §3)

## Global Constraints

- Node 24.19.0 everywhere. Do not change `.node-version`, `mise.toml` or the `NODE_VERSION` ARG in either Dockerfile.
- Vitest 4.1 runs in the **node** environment. There is no DOM and no IndexedDB.
- A test that needs the database imports `@/lib/testSupport/browserGlobals` **first**, then imports `db.ts` dynamically with `await import(...)`.
- `getDb` memoises its connection. A suite empties the object stores between tests with `clearAllStores()`.
- autoIncrement ids keep to climb across a suite. Assert against an id the store returned, never against a literal.
- TypeScript strict mode. Path alias `@/*` maps to `src/*`.
- Run the unit suite with `npm test`. Run it with coverage through `npm run test:coverage`.
- The coverage floor in `vitest.config.ts` is a ratchet. Never lower it to make a build pass.
- `npm run lint` runs `eslint .`. Prettier runs from the hk pre-commit hook. Format new files with `npx prettier --write <paths>` before each commit.
- IndexedDB access needs a `typeof window !== "undefined"` guard.
- Keep every commit atomic. Stage only the files of that step.

---

## File Structure

### New files

| Path                                     | One responsibility                                       |
| ---------------------------------------- | -------------------------------------------------------- |
| `src/lib/bankOrder.ts`                   | Pure order rules: sort, dense renumber, position lookup. |
| `src/lib/bankOrder.test.ts`              | Tests for the pure order rules.                          |
| `src/lib/dbMigrations/v7BankId.ts`       | The v6 to v7 migration and the deterministic id rule.    |
| `src/lib/dbMigrations/v7BankId.test.ts`  | Tests for the migration, run against a private database. |
| `src/lib/db.bankId.test.ts`              | Tests for the bank helpers in `db.ts`.                   |
| `src/lib/db.reorderBanks.test.ts`        | Tests for `reorderBanks`.                                |
| `src/lib/syncUtils.bankIdentity.test.ts` | Tests for merge by identity and for order normalisation. |
| `src/components/BankTabStrip.tsx`        | The bank tab strip, with the drag reorder in edit mode.  |
| `e2e-tests/bank-reorder.spec.ts`         | End-to-end test of the reorder in the browser.           |

### Modified files

| Path                                                     | What changes                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/lib/db.ts`                                          | Types, schema v7, bank helpers, `reorderBanks`, pad reads by `bankId`. |
| `src/lib/syncUtils.ts`                                   | Key extractors, diff summary sort, conflict resolution maps.           |
| `src/lib/googleDrive/dataAccess.ts`                      | Write-back maps and the delete-absent passes, keyed on identity.       |
| `src/lib/importExport.ts`                                | Export and import of `bankId` on pads and banks.                       |
| `src/lib/audio/types.ts`                                 | `generatePlaybackKey` takes a `bankId`.                                |
| `src/lib/audio/preloader.ts`                             | Preload context carries `bankId`.                                      |
| `src/lib/audio/controls.ts`                              | Trigger context carries `bankId`.                                      |
| `src/store/loadingStore.ts`                              | `generatePadLoadingKey` takes a `bankId`.                              |
| `src/store/playbackStore.ts`                             | `padInfo` carries `bankId`; armed cue re-read by `bankId`.             |
| `src/store/profileStore.ts`                              | Holds the normalised `banks` list and `currentBankId`.                 |
| `src/hooks/usePadConfigurations.ts`                      | Reads pads by `bankId`.                                                |
| `src/hooks/emergencySounds.ts`                           | Reads emergency banks by `bankId`.                                     |
| `src/hooks/useSearch.ts`                                 | Search results carry `bankId` and position.                            |
| `src/hooks/useKeyboardListener.ts`                       | Emergency trigger passes `bankId`.                                     |
| `src/hooks/pad/usePadDrop.ts`                            | Pad writes carry `bankId`.                                             |
| `src/hooks/pad/usePadInteractions.ts`                    | Pad writes and triggers carry `bankId`.                                |
| `src/components/Pad.tsx`                                 | Pad props carry `bankId`.                                              |
| `src/components/PadGrid.tsx`                             | Grid props carry `bankId`.                                             |
| `src/components/search/SearchModal.tsx`                  | Navigation by `bankId`.                                                |
| `src/components/modals/ConflictResolutionModal.tsx`      | Conflict labels name the bank.                                         |
| `src/components/modals/BulkImportModalContent.tsx`       | Bulk writes carry `bankId`.                                            |
| `src/components/modals/LoudnessOverviewModalContent.tsx` | Bank filter and gain writes by `bankId`.                               |
| `src/components/profiles/ProfileManager.tsx`             | Missing-audio repair by `bankId`.                                      |
| `src/app/page.tsx`                                       | Renders `BankTabStrip`; no local bank state.                           |
| `e2e-tests/test-helpers.ts`                              | A helper that latches edit mode with the button.                       |
| `CLAUDE.md`                                              | Records bank identity and the renamed helpers.                         |
| `docs/server-sync.md`                                    | Records that identity is `bankId` and position is `pageIndex`.         |

---

## Task 1: The pure order rules

**Files:**

- Create `src/lib/bankOrder.ts`
- Create `src/lib/bankOrder.test.ts`

**Interfaces:**

- Consumes: `PageMetadata` from `@/lib/db` (type only, so the module has no side effect).
- Produces:
  ```ts
  export const compareBankOrder: (a: PageMetadata, b: PageMetadata) => number;
  export function normaliseBankOrder(pages: PageMetadata[]): PageMetadata[];
  export function bankIdAtPosition(
    pages: PageMetadata[],
    position: number,
  ): string | null;
  export function positionOfBank(pages: PageMetadata[], bankId: string): number;
  ```

Steps:

- [ ] **Step 1: Write the test file.** Create `src/lib/bankOrder.test.ts` with this content:

  ```ts
  /**
   * Two devices can both write a bank's position, so per-field last-write-wins
   * can leave duplicate or gappy values. The order is therefore normalised on
   * read: sort by (pageIndex, bankId) and renumber densely from 0. `bankId` is
   * stable, so both devices compute the same order from the same data.
   */
  import { describe, expect, it } from "vitest";
  import {
    bankIdAtPosition,
    normaliseBankOrder,
    positionOfBank,
  } from "./bankOrder";
  import type { PageMetadata } from "./db";

  function bank(bankId: string, pageIndex: number): PageMetadata {
    return {
      profileId: 1,
      bankId,
      pageIndex,
      name: `Bank ${bankId}`,
      isEmergency: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  const positions = (pages: PageMetadata[]) =>
    normaliseBankOrder(pages).map((page) => [page.bankId, page.pageIndex]);

  describe("normaliseBankOrder", () => {
    it("renumbers a gappy order densely from zero", () => {
      expect(positions([bank("a", 0), bank("b", 4), bank("c", 9)])).toEqual([
        ["a", 0],
        ["b", 1],
        ["c", 2],
      ]);
    });

    it("breaks a tie on bankId, so two devices agree", () => {
      const deviceA = positions([bank("b", 1), bank("a", 1), bank("c", 0)]);
      const deviceB = positions([bank("a", 1), bank("c", 0), bank("b", 1)]);

      expect(deviceA).toEqual([
        ["c", 0],
        ["a", 1],
        ["b", 2],
      ]);
      expect(deviceB).toEqual(deviceA);
    });

    it("leaves a dense order alone", () => {
      expect(positions([bank("a", 0), bank("b", 1)])).toEqual([
        ["a", 0],
        ["b", 1],
      ]);
    });

    it("does not change the array it is given", () => {
      const pages = [bank("a", 7)];

      normaliseBankOrder(pages);

      expect(pages[0].pageIndex).toBe(7);
    });
  });

  describe("position lookups", () => {
    it("reports the bank at a position", () => {
      const pages = [bank("b", 4), bank("a", 0)];

      expect(bankIdAtPosition(pages, 0)).toBe("a");
      expect(bankIdAtPosition(pages, 1)).toBe("b");
      expect(bankIdAtPosition(pages, 2)).toBeNull();
    });

    it("reports the position of a bank, and -1 when it is absent", () => {
      const pages = [bank("b", 4), bank("a", 0)];

      expect(positionOfBank(pages, "b")).toBe(1);
      expect(positionOfBank(pages, "gone")).toBe(-1);
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run src/lib/bankOrder.test.ts`. Expect this failure:

  ```
  Error: Failed to resolve import "./bankOrder" from "src/lib/bankOrder.test.ts". Does the file exist?
  ```

- [ ] **Step 3: Write the module.** Create `src/lib/bankOrder.ts`:

  ```ts
  /**
   * The order rules for banks.
   *
   * `pageIndex` is a position, and a position is an ordinary per-bank field
   * that two devices can both write. Per-field last-write-wins can therefore
   * leave two banks on the same position, or leave a gap. The rule is to sort
   * by (pageIndex, bankId) and renumber densely from 0 on read. `bankId` never
   * changes, so both devices reach the same answer from the same data.
   *
   * Pure on purpose, and free of any database import, so the merge path, the
   * store and the tab strip all share one definition of "the order".
   */
  import type { PageMetadata } from "./db";

  /** The one comparator. A second copy would drift from this one. */
  export const compareBankOrder = (a: PageMetadata, b: PageMetadata): number =>
    a.pageIndex - b.pageIndex || a.bankId.localeCompare(b.bankId);

  /**
   * Sorts banks into their display order and renumbers them densely.
   *
   * @param pages - The profile's banks, in any order
   * @returns A new array; the array index of each bank is its position
   */
  export function normaliseBankOrder(pages: PageMetadata[]): PageMetadata[] {
    return [...pages]
      .sort(compareBankOrder)
      .map((page, position) =>
        page.pageIndex === position ? page : { ...page, pageIndex: position },
      );
  }

  /**
   * The identity of the bank at a position.
   *
   * @param pages - The profile's banks, in any order
   * @param position - A zero-based position, as a hotkey selects
   * @returns The bank id, or null when no bank sits there
   */
  export function bankIdAtPosition(
    pages: PageMetadata[],
    position: number,
  ): string | null {
    return normaliseBankOrder(pages)[position]?.bankId ?? null;
  }

  /**
   * The position of a bank.
   *
   * @param pages - The profile's banks, in any order
   * @param bankId - The identity to look for
   * @returns The zero-based position, or -1 when the bank is absent
   */
  export function positionOfBank(
    pages: PageMetadata[],
    bankId: string,
  ): number {
    return normaliseBankOrder(pages).findIndex(
      (page) => page.bankId === bankId,
    );
  }
  ```

- [ ] **Step 4: Run the test and see it fail on the type.** Run `npx vitest run src/lib/bankOrder.test.ts`. `PageMetadata` has no `bankId` yet, so the test object is wrong. Vitest does not type-check, so the test passes. Run `npx tsc --noEmit` and expect:

  ```
  src/lib/bankOrder.ts(23,42): error TS2339: Property 'bankId' does not exist on type 'PageMetadata'.
  ```

  Leave this error open. Task 2 closes it.

- [ ] **Step 5: Commit.**

  ```bash
  npx prettier --write src/lib/bankOrder.ts src/lib/bankOrder.test.ts
  git add src/lib/bankOrder.ts src/lib/bankOrder.test.ts
  git commit -m "feat(banks): add the pure bank order rules"
  ```

---

## Task 2: The `bankId` fields and the v7 schema

> **HUMAN REVIEW REQUIRED.** This task and Task 3 rewrite every pad row and every bank row on every device. Do not merge the branch until a person reads the migration and the migration tests. The spec gives the same instruction in its "Sequencing" section.

**Files:**

- Change `src/lib/db.ts:12` (`DB_VERSION`)
- Change `src/lib/db.ts:108-138` (`PadConfiguration`)
- Change `src/lib/db.ts:141-153` (`PageMetadata`)
- Change `src/lib/db.ts:156-173` (`ImpAmpDBSchema`)
- Change `src/lib/db.ts:319-330` and `src/lib/db.ts:333-344` (the V1 and V2 store creation)
- Change `src/lib/db.ts:406` (insert the V7 block after the V6 block)
- Create `src/lib/dbMigrations/v7BankId.ts`

**Interfaces:**

- Consumes: `convertIndexToBankNumber` from `@/lib/bankUtils`; the `IDBPTransaction` type from `idb`.
- Produces:
  ```ts
  export const migratedBankId: (pageIndex: number) => string;
  export type V7Transaction = IDBPTransaction<
    V7Schema,
    ("padConfigurations" | "pageMetadata")[],
    "versionchange"
  >;
  export function migrateToV7(transaction: V7Transaction): Promise<void>;
  ```

Steps:

- [ ] **Step 1: Add the two fields to the record types.** In `src/lib/db.ts`, delete `pageIndex: number;` from `PadConfiguration` (line 111) and add above `padIndex`:

  ```ts
  /**
   * The bank this pad belongs to. Replaces `pageIndex`, which was both the
   * bank's identity and its position; a reorder has to change one without
   * the other. A pad's position is its bank's position, so a second copy
   * here would be a duplicated rule that drifts.
   */
  bankId: string;
  ```

  In `PageMetadata` (line 141), add above `pageIndex`:

  ```ts
  /** Immutable identity. Every key that names this bank uses it. */
  bankId: string;
  ```

  and change the comment on `pageIndex` to `/** Position only: the tab order and the keyboard shortcut. */`.

- [ ] **Step 2: Change the schema indexes.** In `ImpAmpDBSchema` (lines 163-172), replace the two index maps:

  ```ts
  padConfigurations: {
    key: number;
    value: PadConfiguration;
    indexes: {
      profileId: number;
      profileBankPad: [number, string, number];
    }
  }
  pageMetadata: {
    key: number;
    value: PageMetadata;
    // No index on [profileId, pageIndex]: two banks may share a position for
    // a moment during a merge, and a unique index would refuse the write.
    indexes: {
      profileId: number;
      profileBank: [number, string];
    }
  }
  ```

  In the V1 block (line 325), replace the `profilePagePad` index with:

  ```ts
  store.createIndex("profileBankPad", ["profileId", "bankId", "padIndex"], {
    unique: true,
  });
  ```

  In the V2 block (line 340), replace the `profilePage` index with:

  ```ts
  store.createIndex("profileBank", ["profileId", "bankId"], {
    unique: true,
  });
  ```

- [ ] **Step 3: Bump the version.** Change line 12 to:

  ```ts
  const DB_VERSION = 7; // DB version for bank identity (bankId)
  ```

- [ ] **Step 4: Write the migration module.** Create `src/lib/dbMigrations/v7BankId.ts`:

  ```ts
  /**
   * DB v7: bank identity.
   *
   * A migrated bank takes `bankId = String(pageIndex)`. This is deterministic
   * on purpose. The migration is client-side IndexedDB code, so it runs once
   * per device, on its own, against the same start data. With a random id,
   * device A mints one id for a bank and device B mints another for the same
   * bank; the merge keys on identity, sees two banks and keeps both. A
   * deterministic id makes a second device's migration a no-op instead of a
   * fork. Only a bank created *after* the migration gets a random id, because
   * a creation is a synced event and cannot diverge.
   *
   * The migration also materialises the implicit banks. Banks 1-10 used to be
   * synthesised in the page component, so a pad could sit at a position with
   * no bank row at all. Every such position gets a row first, and only then
   * does every pad get its `bankId`. A pad left without a `bankId` would
   * disappear from its bank, so this order is not optional.
   */
  import type { DBSchema, IDBPTransaction } from "idb";
  import { convertIndexToBankNumber } from "@/lib/bankUtils";

  /** A pad row between the two versions: it may carry either field. */
  interface V7Pad {
    id?: number;
    profileId: number;
    padIndex: number;
    pageIndex?: number;
    bankId?: string;
    [key: string]: unknown;
  }

  /** A bank row between the two versions. */
  interface V7Page {
    id?: number;
    profileId: number;
    pageIndex: number;
    bankId?: string;
    name: string;
    isEmergency: boolean;
    createdAt: Date;
    updatedAt: Date;
    [key: string]: unknown;
  }

  interface V7Schema extends DBSchema {
    padConfigurations: {
      key: number;
      value: V7Pad;
      indexes: { profileId: number; profileBankPad: [number, string, number] };
    };
    pageMetadata: {
      key: number;
      value: V7Page;
      indexes: { profileId: number; profileBank: [number, string] };
    };
  }

  /** The transaction shape this migration needs. */
  export type V7Transaction = IDBPTransaction<
    V7Schema,
    ("padConfigurations" | "pageMetadata")[],
    "versionchange"
  >;

  /** The identity a migrated bank takes. Deterministic across devices. */
  export const migratedBankId = (pageIndex: number): string =>
    String(pageIndex);

  export async function migrateToV7(transaction: V7Transaction): Promise<void> {
    const padStore = transaction.objectStore("padConfigurations");
    const pageStore = transaction.objectStore("pageMetadata");

    // The index changes come first, so every write below lands in the new
    // indexes. A record with no `bankId` yet is simply not indexed, so the
    // unique constraint cannot refuse these creations.
    if (padStore.indexNames.contains("profilePagePad")) {
      padStore.deleteIndex("profilePagePad");
    }
    if (!padStore.indexNames.contains("profileBankPad")) {
      padStore.createIndex(
        "profileBankPad",
        ["profileId", "bankId", "padIndex"],
        { unique: true },
      );
    }
    if (pageStore.indexNames.contains("profilePage")) {
      pageStore.deleteIndex("profilePage");
    }
    if (!pageStore.indexNames.contains("profileBank")) {
      pageStore.createIndex("profileBank", ["profileId", "bankId"], {
        unique: true,
      });
    }

    const pads = await padStore.getAll();
    const pages = await pageStore.getAll();
    const now = new Date();
    const nowMs = now.getTime();

    // 1. Materialise a bank row for every position that holds pads and has no
    //    row. Do this before the pads, or those pads lose their bank.
    const known = new Set(
      pages.map((page) => `${page.profileId}:${page.pageIndex}`),
    );
    for (const pad of pads) {
      const pageIndex = pad.pageIndex ?? 0;
      const key = `${pad.profileId}:${pageIndex}`;
      if (known.has(key)) continue;
      known.add(key);
      const content = {
        profileId: pad.profileId,
        pageIndex,
        bankId: migratedBankId(pageIndex),
        // The same default the upsert helper applies, so a materialised bank
        // reads the way an auto-created one always did.
        name: `Bank ${convertIndexToBankNumber(pageIndex)}`,
        isEmergency: false,
      };
      await pageStore.add({
        ...content,
        createdAt: now,
        updatedAt: now,
        _created: nowMs,
        _modified: nowMs,
        _fieldsModified: Object.fromEntries(
          Object.keys(content).map((field) => [field, nowMs]),
        ),
      });
    }

    // 2. Stamp the identity on every bank row that came from version 6.
    for (const page of pages) {
      if (page.bankId) continue;
      await pageStore.put({ ...page, bankId: migratedBankId(page.pageIndex) });
    }

    // 3. Stamp the identity on every pad and drop its own copy of the
    //    position.
    for (const pad of pads) {
      if (pad.bankId) continue;
      const bankId = migratedBankId(pad.pageIndex ?? 0);
      const { pageIndex: _pageIndex, ...rest } = pad;
      await padStore.put({ ...rest, bankId });
    }
  }
  ```

- [ ] **Step 5: Call the migration from `getDb`.** In `src/lib/db.ts`, add this import at the top:

  ```ts
  import { migrateToV7, type V7Transaction } from "./dbMigrations/v7BankId";
  ```

  and insert this block after the V6 block, before the "V1 Seeding" comment:

  ```ts
  // V7 Migration: bank identity. The cast is the one place the two
  // schema shapes meet; the migration module owns the pre-v7 shape.
  if (oldVersion < 7) {
    console.log("Applying V7 migration: bank identity (bankId)...");
    migrateToV7(transaction as unknown as V7Transaction).catch((err) => {
      console.error("V7 Migration error:", err);
      try {
        transaction.abort();
      } catch (abortError) {
        console.error("Error aborting transaction:", abortError);
      }
    });
  }
  ```

- [ ] **Step 6: Check the type errors that remain.** Run `npx tsc --noEmit`. Expect many errors of this shape, one per call site that still passes a `pageIndex`:

  ```
  src/lib/db.ts(1401,7): error TS2339: Property 'pageIndex' does not exist on type 'Omit<PadConfiguration, ...>'.
  ```

  These are the work of Tasks 4 to 13. Do not fix them here.

- [ ] **Step 7: Commit.**

  ```bash
  npx prettier --write src/lib/db.ts src/lib/dbMigrations/v7BankId.ts
  git add src/lib/db.ts src/lib/dbMigrations/v7BankId.ts
  git commit -m "feat(db): add bankId to the schema and the v7 migration"
  ```

---

## Task 3: Migration tests

> **HUMAN REVIEW REQUIRED.** These tests are the evidence for Task 2.

**Files:**

- Create `src/lib/dbMigrations/v7BankId.test.ts`

**Interfaces:**

- Consumes: `migrateToV7`, `V7Transaction` from `./v7BankId`; `openDB` from `idb`.
- Produces: no export.

The suite opens its **own** databases under unique names. It cannot use `getDb`, because `getDb` memoises one connection at the current version and the test has to start from the v6 shape.

Steps:

- [ ] **Step 1: Write the test file.** Create `src/lib/dbMigrations/v7BankId.test.ts`:

  ```ts
  /**
   * The v7 migration rewrites every pad row and every bank row, so it gets
   * direct tests against a database built in the v6 shape.
   *
   * The three properties that matter are in the spec: a pad at a position with
   * no bank row gains one and keeps its sounds; a second run changes nothing;
   * and two devices that migrate the same data mint the same ids, so the merge
   * sees one set of banks rather than two.
   */

  // Must be the first import: it installs fake-indexeddb before `idb` opens
  // anything.
  import "@/lib/testSupport/browserGlobals";
  import { describe, expect, it } from "vitest";
  import { openDB } from "idb";
  import { migrateToV7, migratedBankId, type V7Transaction } from "./v7BankId";

  let databaseCounter = 0;
  const nextName = () => `v7-migration-test-${++databaseCounter}`;

  /** Builds a database in the v6 shape and seeds it. */
  async function seedV6(name: string) {
    const db = await openDB(name, 6, {
      upgrade(database) {
        const pads = database.createObjectStore("padConfigurations", {
          keyPath: "id",
          autoIncrement: true,
        });
        pads.createIndex("profileId", "profileId");
        pads.createIndex(
          "profilePagePad",
          ["profileId", "pageIndex", "padIndex"],
          { unique: true },
        );
        const pages = database.createObjectStore("pageMetadata", {
          keyPath: "id",
          autoIncrement: true,
        });
        pages.createIndex("profileId", "profileId");
        pages.createIndex("profilePage", ["profileId", "pageIndex"], {
          unique: true,
        });
      },
    });

    // Bank 1 has a row. Bank 3 has pads and no row at all, which is what the
    // page component used to paper over.
    await db.add("pageMetadata", {
      profileId: 1,
      pageIndex: 0,
      name: "Stings",
      isEmergency: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await db.add("padConfigurations", {
      profileId: 1,
      pageIndex: 0,
      padIndex: 4,
      name: "Horn",
      audioFileIds: [11],
      playbackType: "sequential",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await db.add("padConfigurations", {
      profileId: 1,
      pageIndex: 2,
      padIndex: 7,
      name: "Rain",
      audioFileIds: [22],
      playbackType: "round-robin",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    db.close();
    return name;
  }

  /** Opens the seeded database at the given version and runs the migration. */
  async function migrate(name: string, version: number) {
    return openDB(name, version, {
      upgrade(_database, _oldVersion, _newVersion, transaction) {
        void migrateToV7(transaction as unknown as V7Transaction);
      },
    });
  }

  describe("the v7 bank identity migration", () => {
    it("gives every pad the bank id of its old position", async () => {
      const db = await migrate(await seedV6(nextName()), 7);

      const pads = await db.getAll("padConfigurations");
      const horn = pads.find((pad) => pad.name === "Horn");
      const rain = pads.find((pad) => pad.name === "Rain");

      expect(horn?.bankId).toBe(migratedBankId(0));
      expect(rain?.bankId).toBe(migratedBankId(2));
      db.close();
    });

    it("drops the pad's own copy of the position", async () => {
      const db = await migrate(await seedV6(nextName()), 7);

      const pads = await db.getAll("padConfigurations");

      expect(pads.every((pad) => !("pageIndex" in pad))).toBe(true);
      db.close();
    });

    it("creates a bank row for a position that had pads but no row", async () => {
      const db = await migrate(await seedV6(nextName()), 7);

      const pages = await db.getAll("pageMetadata");
      const created = pages.find((page) => page.pageIndex === 2);

      expect(created?.bankId).toBe(migratedBankId(2));
      // The name the upsert helper would have given it: bank *numbers* are
      // 1-based, so position 2 is "Bank 3".
      expect(created?.name).toBe("Bank 3");
      expect(created?.isEmergency).toBe(false);
      db.close();
    });

    it("keeps the name and the emergency flag of a bank that had a row", async () => {
      const db = await migrate(await seedV6(nextName()), 7);

      const pages = await db.getAll("pageMetadata");
      const stings = pages.find((page) => page.name === "Stings");

      expect(stings?.bankId).toBe(migratedBankId(0));
      expect(stings?.isEmergency).toBe(true);
      db.close();
    });

    it("replaces the two position indexes with identity indexes", async () => {
      const db = await migrate(await seedV6(nextName()), 7);

      const padIndexes = [
        ...db.transaction("padConfigurations").store.indexNames,
      ];
      const pageIndexes = [...db.transaction("pageMetadata").store.indexNames];

      expect(padIndexes).toContain("profileBankPad");
      expect(padIndexes).not.toContain("profilePagePad");
      expect(pageIndexes).toContain("profileBank");
      expect(pageIndexes).not.toContain("profilePage");
      db.close();
    });

    it("changes nothing on a second run", async () => {
      const name = await seedV6(nextName());
      const first = await migrate(name, 7);
      const afterFirst = {
        pads: await first.getAll("padConfigurations"),
        pages: await first.getAll("pageMetadata"),
      };
      first.close();

      // Version 8 re-runs the same code over already migrated rows.
      const second = await migrate(name, 8);
      const afterSecond = {
        pads: await second.getAll("padConfigurations"),
        pages: await second.getAll("pageMetadata"),
      };
      second.close();

      expect(afterSecond).toEqual(afterFirst);
    });

    it("mints the same ids on two devices, so a merge sees one set of banks", async () => {
      const deviceA = await migrate(await seedV6(nextName()), 7);
      const deviceB = await migrate(await seedV6(nextName()), 7);

      const idsOf = async (db: typeof deviceA) =>
        (await db.getAll("pageMetadata"))
          .map((page) => page.bankId as string)
          .sort();

      const a = await idsOf(deviceA);
      const b = await idsOf(deviceB);

      expect(a).toEqual(b);
      // The merge keys on identity, so one set of banks, not two.
      expect(new Set([...a, ...b]).size).toBe(a.length);
      deviceA.close();
      deviceB.close();
    });
  });
  ```

- [ ] **Step 2: Run the tests and see them pass.** Run `npx vitest run src/lib/dbMigrations/v7BankId.test.ts`. Every test must pass. If "creates a bank row" fails with `expected undefined to be '2'`, the materialise pass runs after the pad pass; put it back first.

- [ ] **Step 3: Prove the order guard.** Do these steps in sequence:

  1. Move the "materialise" block below the "stamp every pad" block in `src/lib/dbMigrations/v7BankId.ts`.
  2. Run the same command. Confirm the test fails.
  3. Put the block back. Confirm the test passes again.

  The test now guards the order. The spec makes this order mandatory.

- [ ] **Step 4: Commit.**

  ```bash
  npx prettier --write src/lib/dbMigrations/v7BankId.test.ts
  git add src/lib/dbMigrations/v7BankId.test.ts
  git commit -m "test(db): cover the v7 bank identity migration"
  ```

---

## Task 4: Pad reads and writes by `bankId`

**Files:**

- Change `src/lib/db.ts:1374-1453` (`upsertPadConfiguration`)
- Change `src/lib/db.ts:1495-1577` (`swapPadConfigurations`)
- Change `src/lib/db.ts:1580-1593` (`getPadConfigurationsForProfilePage`)
- Change `src/lib/db.ts:1761-1888` (`MissingAudioFile`, `findMissingAudioFiles`, `replaceMissingAudioFile`)

**Interfaces:**

- Produces:
  ```ts
  export async function getPadConfigurationsForProfileBank(
    profileId: number,
    bankId: string,
  ): Promise<PadConfiguration[]>;
  export async function swapPadConfigurations(
    profileId: number,
    bankId: string,
    fromPadIndex: number,
    toPadIndex: number,
  ): Promise<void>;
  export async function replaceMissingAudioFile(
    profileId: number,
    bankId: string,
    padIndex: number,
    missingAudioFileId: number,
    file: File,
  ): Promise<void>;
  export interface MissingAudioFile {
    profileId: number;
    profileName: string;
    bankId: string;
    bankName: string;
    padIndex: number;
    padName: string;
    missingAudioFileId: number;
  }
  ```

Steps:

- [ ] **Step 1: Write the test that fails.** Create `src/lib/db.bankId.test.ts`:

  ```ts
  /**
   * A pad names its bank by identity, not by position. These are the reads and
   * writes that a reorder must leave alone.
   */

  // Must be the first import: it installs `window` before `db.ts` can read it.
  import { clearAllStores } from "@/lib/testSupport/browserGlobals";
  import { beforeEach, describe, expect, it } from "vitest";

  const {
    addProfile,
    upsertPadConfiguration,
    getPadConfigurationsForProfileBank,
    swapPadConfigurations,
  } = await import("./db");

  let profileId: number;

  beforeEach(async () => {
    await clearAllStores();
    profileId = await addProfile({ name: "Board", syncType: "local" });
  });

  describe("pads keyed by bank identity", () => {
    it("reads back the pads of one bank and no others", async () => {
      await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 1,
        audioFileIds: [11],
        playbackType: "sequential",
      });
      await upsertPadConfiguration({
        profileId,
        bankId: "stings",
        padIndex: 1,
        audioFileIds: [22],
        playbackType: "sequential",
      });

      const pads = await getPadConfigurationsForProfileBank(profileId, "0");

      expect(pads).toHaveLength(1);
      expect(pads[0].audioFileIds).toEqual([11]);
    });

    it("updates the pad already at that bank and pad index", async () => {
      const first = await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 2,
        audioFileIds: [11],
        playbackType: "sequential",
      });
      const second = await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 2,
        name: "Renamed",
        audioFileIds: [11],
        playbackType: "sequential",
      });

      // Assert against the id the store handed back, never a literal: the
      // autoIncrement counter keeps climbing across the suite.
      expect(second).toBe(first);
      const pads = await getPadConfigurationsForProfileBank(profileId, "0");
      expect(pads).toHaveLength(1);
      expect(pads[0].name).toBe("Renamed");
    });

    it("swaps two pads inside one bank", async () => {
      await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 0,
        name: "Horn",
        audioFileIds: [11],
        playbackType: "sequential",
      });
      await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 1,
        name: "Rain",
        audioFileIds: [22],
        playbackType: "sequential",
      });

      await swapPadConfigurations(profileId, "0", 0, 1);

      const pads = await getPadConfigurationsForProfileBank(profileId, "0");
      const byIndex = new Map(pads.map((pad) => [pad.padIndex, pad]));
      expect(byIndex.get(0)?.name).toBe("Rain");
      expect(byIndex.get(1)?.name).toBe("Horn");
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run src/lib/db.bankId.test.ts`. Expect:

  ```
  TypeError: getPadConfigurationsForProfileBank is not a function
  ```

  The name does not exist yet, so the dynamic destructure gives `undefined`.

- [ ] **Step 3: Rename the read helper.** In `src/lib/db.ts`, replace `getPadConfigurationsForProfilePage` (line 1580) with:

  ```ts
  // Get all pad configurations for a specific profile and bank
  export async function getPadConfigurationsForProfileBank(
    profileId: number,
    bankId: string,
  ): Promise<PadConfiguration[]> {
    const db = await getDb();
    const tx = db.transaction("padConfigurations", "readonly");
    const store = tx.objectStore("padConfigurations");
    const index = store.index("profileBankPad");
    const range = IDBKeyRange.bound(
      [profileId, bankId, -Infinity],
      [profileId, bankId, Infinity],
    );
    return index.getAll(range);
  }
  ```

- [ ] **Step 4: Point the two write helpers at the new index.** In `upsertPadConfiguration`, change line 1393 to `const index = store.index("profileBankPad");` and lines 1399-1403 to:

  ```ts
  const existing = await index.get([
    padConfig.profileId,
    padConfig.bankId,
    padConfig.padIndex,
  ]);
  ```

  In `swapPadConfigurations`, make these changes:

  - Change the parameter `pageIndex: number` to `bankId: string`.
  - Change line 1506 to `const index = store.index("profileBankPad");`.
  - Change lines 1512-1513 to use `[profileId, bankId, fromPadIndex]` and `[profileId, bankId, toPadIndex]`.
  - Change the error message and the log to name the bank.
  - Change the new-record literal at line 1544 to `const record = { profileId, bankId, padIndex, ...content };`.

- [ ] **Step 5: Run the test and see it pass.** Run `npx vitest run src/lib/db.bankId.test.ts`. All three tests must pass.

- [ ] **Step 6: Fix the missing-audio helpers.** In `MissingAudioFile` (line 1761), replace `pageIndex: number;` with `bankId: string;` and `bankName: string;`. In `findMissingAudioFiles`, read the profile's banks once with `db.getAll("pageMetadata")`, build a `Map<string, string>` from `bankId` to name, and report `bankId: pad.bankId` and the name from that map, with the fallback `Bank ?`. In `replaceMissingAudioFile` (line 1816), change the `pageIndex: number` parameter to `bankId: string`, change the index lookup to `.index("profileBankPad").get([profileId, bankId, padIndex])`, and change the two messages to name the bank.

- [ ] **Step 7: Run the whole database suite.** Run `npx vitest run src/lib/db.bankId.test.ts src/lib/db.duplicateProfile.test.ts src/lib/db.padGain.test.ts`. Expect failures in `db.duplicateProfile.test.ts` only, because it still calls `getPadConfigurationsForProfilePage` and writes `pageIndex`. Task 6 fixes it.

- [ ] **Step 8: Commit.**

  ```bash
  npx prettier --write src/lib/db.ts src/lib/db.bankId.test.ts
  git add src/lib/db.ts src/lib/db.bankId.test.ts
  git commit -m "feat(db): key pad reads and writes on bankId"
  ```

---

## Task 5: Bank helpers keyed on identity

**Files:**

- Change `src/lib/db.ts:1613-1619` (`getPageMetadata`)
- Change `src/lib/db.ts:1641-1723` (`upsertPageMetadata`)
- Change `src/lib/db.ts:1725-1759` (`renamePage`, `setPageEmergencyState`)
- Change `src/lib/db.pageMetadata.test.ts` (the whole file)

**Interfaces:**

- Consumes: `normaliseBankOrder` from `@/lib/bankOrder`; `initialSyncFields` and `convertIndexToBankNumber` inside `db.ts`.
- Produces:
  ```ts
  export const MAX_BANKS = 20;
  export const DEFAULT_BANK_COUNT = 10;
  export async function getBankById(
    profileId: number,
    bankId: string,
  ): Promise<PageMetadata | undefined>;
  export async function upsertPageMetadata(bank: {
    profileId: number;
    bankId: string;
    pageIndex?: number;
    name?: string;
    isEmergency?: boolean;
  }): Promise<number>;
  export async function renameBank(
    profileId: number,
    bankId: string,
    newName: string,
  ): Promise<void>;
  export async function setBankEmergencyState(
    profileId: number,
    bankId: string,
    isEmergency: boolean,
  ): Promise<void>;
  export async function ensureDefaultBanks(
    profileId: number,
  ): Promise<PageMetadata[]>;
  export async function createBank(
    profileId: number,
    name: string,
    isEmergency?: boolean,
  ): Promise<PageMetadata>;
  ```

The default banks take the deterministic id `String(position)`. The migration uses the same rule for the same reason. Two devices that create bank 5 for the first time must agree on its identity. No path deletes a bank, so the ten default ids stay stable.

Steps:

- [ ] **Step 1: Rewrite the existing test to key on identity.** In `src/lib/db.pageMetadata.test.ts`, do this:

  - Change the import list to `{ addProfile, renameBank, setBankEmergencyState, getBankById, upsertPageMetadata, ensureDefaultBanks, createBank }`.
  - Change every call so it passes a bank id in place of a page index.
  - Replace the four bodies below, and add the three new cases:

  ```ts
  describe("editing bank metadata", () => {
    it("keeps the emergency flag when the bank is renamed", async () => {
      await setBankEmergencyState(profileId, "0", true);
      await renameBank(profileId, "0", "Act One");

      const bank = await getBankById(profileId, "0");
      expect(bank?.name).toBe("Act One");
      expect(bank?.isEmergency).toBe(true);
    });

    it("keeps the name when the emergency flag is toggled", async () => {
      await renameBank(profileId, "0", "Act Two");
      await setBankEmergencyState(profileId, "0", true);

      const bank = await getBankById(profileId, "0");
      expect(bank?.name).toBe("Act Two");
      expect(bank?.isEmergency).toBe(true);
    });

    it("does not let concurrent edits revert each other", async () => {
      await upsertPageMetadata({
        profileId,
        bankId: "0",
        pageIndex: 0,
        name: "Before",
        isEmergency: false,
      });

      await Promise.all([
        renameBank(profileId, "0", "After"),
        setBankEmergencyState(profileId, "0", true),
      ]);

      const bank = await getBankById(profileId, "0");
      expect(bank?.name).toBe("After");
      expect(bank?.isEmergency).toBe(true);
    });

    it("names a bank it has to create by its bank number, not its index", async () => {
      await upsertPageMetadata({ profileId, bankId: "2", pageIndex: 2 });

      expect((await getBankById(profileId, "2"))?.name).toBe("Bank 3");
    });

    it("refuses to create a bank without a position", async () => {
      await expect(
        upsertPageMetadata({ profileId, bankId: "new" }),
      ).rejects.toThrow(/position/i);
    });
  });

  describe("the default banks", () => {
    it("creates ten banks with deterministic ids", async () => {
      const banks = await ensureDefaultBanks(profileId);

      expect(banks.map((bank) => bank.bankId)).toEqual([
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
      ]);
      expect(banks.map((bank) => bank.pageIndex)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
    });

    it("creates nothing on a second call", async () => {
      const first = await ensureDefaultBanks(profileId);
      const second = await ensureDefaultBanks(profileId);

      expect(second.map((bank) => bank.id)).toEqual(
        first.map((bank) => bank.id),
      );
    });

    it("keeps a renamed default bank", async () => {
      await ensureDefaultBanks(profileId);
      await renameBank(profileId, "3", "Interval");

      const banks = await ensureDefaultBanks(profileId);

      expect(banks.find((bank) => bank.bankId === "3")?.name).toBe("Interval");
    });
  });

  describe("createBank", () => {
    it("mints a random id and takes the first free position", async () => {
      await ensureDefaultBanks(profileId);

      const bank = await createBank(profileId, "Beds");

      expect(bank.pageIndex).toBe(10);
      expect(bank.name).toBe("Beds");
      // A bank created after the migration is safe with a random id, because
      // a creation is a synced event and cannot diverge.
      expect(bank.bankId).not.toBe("10");
      expect(bank.bankId.length).toBeGreaterThan(10);
    });

    it("refuses to pass the twenty-bank cap", async () => {
      await ensureDefaultBanks(profileId);
      for (let n = 0; n < 10; n++) {
        await createBank(profileId, `Extra ${n}`);
      }

      await expect(createBank(profileId, "One too many")).rejects.toThrow(
        /at most 20/,
      );
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run src/lib/db.pageMetadata.test.ts`. Expect:

  ```
  TypeError: renameBank is not a function
  ```

- [ ] **Step 3: Write the helpers.** In `src/lib/db.ts`, add the import `import { normaliseBankOrder } from "./bankOrder";` and the two constants near `DEFAULT_PLAYBACK_TYPE`:

  ```ts
  /** The hard cap on banks per profile. Position 0-19 maps to bank 1-20. */
  export const MAX_BANKS = 20;
  /** The banks every profile starts with, so every tab has an identity. */
  export const DEFAULT_BANK_COUNT = 10;
  ```

  Replace `getPageMetadata` with:

  ```ts
  // Get one bank of a profile by its identity
  export async function getBankById(
    profileId: number,
    bankId: string,
  ): Promise<PageMetadata | undefined> {
    const db = await getDb();
    return db.getFromIndex("pageMetadata", "profileBank", [profileId, bankId]);
  }
  ```

  In `upsertPageMetadata`, change the parameter type to:

  ```ts
    pageMetadata: {
      profileId: number;
      bankId: string;
      pageIndex?: number;
      name?: string;
      isEmergency?: boolean;
    },
  ```

  change the index to `store.index("profileBank")` and the lookup key to `[pageMetadata.profileId, pageMetadata.bankId]`, and change the create branch to:

  ```ts
  // Defaults only matter here — an update keeps what is there.
  if (pageMetadata.pageIndex === undefined) {
    throw new Error(
      `Cannot create bank ${pageMetadata.bankId} without a position. Use createBank or ensureDefaultBanks.`,
    );
  }
  const content = {
    ...pageMetadata,
    pageIndex: pageMetadata.pageIndex,
    name:
      pageMetadata.name ??
      `Bank ${convertIndexToBankNumber(pageMetadata.pageIndex)}`,
    isEmergency: pageMetadata.isEmergency ?? false,
  };
  ```

  Replace `renamePage` and `setPageEmergencyState` with `renameBank(profileId, bankId, newName)` and `setBankEmergencyState(profileId, bankId, isEmergency)`, each of which calls `upsertPageMetadata({ profileId, bankId, ... })` with only its own field. Keep the comments that explain why only one field is sent.

- [ ] **Step 4: Write the two creation helpers.** Add below `renameBank`:

  ```ts
  /**
   * Makes sure a profile has its ten default banks.
   *
   * The ids are deterministic — `String(position)` — for the reason the v7
   * migration gives: two devices can materialise the same default bank on
   * their own, and a random id would give the merge two banks where there is
   * one. No path deletes a bank, so these ten ids are stable forever.
   *
   * @param profileId - The profile to fill
   * @returns Every bank of the profile, in normalised order
   */
  export async function ensureDefaultBanks(
    profileId: number,
  ): Promise<PageMetadata[]> {
    const db = await getDb();
    const tx = db.transaction("pageMetadata", "readwrite");
    const store = tx.objectStore("pageMetadata");
    const existing = await store.index("profileId").getAll(profileId);
    const known = new Set(existing.map((bank) => bank.bankId));
    const now = new Date();
    const nowMs = now.getTime();
    const created: PageMetadata[] = [];

    for (let position = 0; position < DEFAULT_BANK_COUNT; position++) {
      const bankId = String(position);
      if (known.has(bankId)) continue;
      const content = {
        profileId,
        bankId,
        pageIndex: position,
        name: `Bank ${convertIndexToBankNumber(position)}`,
        isEmergency: false,
      };
      const id = await store.add({
        ...content,
        createdAt: now,
        updatedAt: now,
        ...initialSyncFields(content, nowMs),
      });
      created.push({ ...content, id, createdAt: now, updatedAt: now });
    }
    await tx.done;

    return normaliseBankOrder([...existing, ...created]);
  }

  /**
   * Adds one bank at the first free position.
   *
   * @param profileId - The profile to add to
   * @param name - The bank name
   * @param isEmergency - Whether the bank answers the emergency key
   * @returns The bank that was written
   */
  export async function createBank(
    profileId: number,
    name: string,
    isEmergency = false,
  ): Promise<PageMetadata> {
    const db = await getDb();
    const tx = db.transaction("pageMetadata", "readwrite");
    const store = tx.objectStore("pageMetadata");
    const existing = await store.index("profileId").getAll(profileId);
    if (existing.length >= MAX_BANKS) {
      await tx.done;
      throw new Error(`A profile can hold at most ${MAX_BANKS} banks.`);
    }

    const used = new Set(existing.map((bank) => bank.pageIndex));
    let pageIndex = 0;
    while (used.has(pageIndex)) pageIndex++;

    const now = new Date();
    // A bank created after the migration is safe with a random id: a creation
    // is a synced event, so two devices cannot mint one for the same bank.
    const content = {
      profileId,
      bankId: crypto.randomUUID(),
      pageIndex,
      name,
      isEmergency,
    };
    const id = await store.add({
      ...content,
      createdAt: now,
      updatedAt: now,
      ...initialSyncFields(content, now.getTime()),
    });
    await tx.done;

    return { ...content, id, createdAt: now, updatedAt: now };
  }
  ```

- [ ] **Step 5: Run the test and see it pass.** Run `npx vitest run src/lib/db.pageMetadata.test.ts`. Every test must pass.

- [ ] **Step 6: Commit.**

  ```bash
  npx prettier --write src/lib/db.ts src/lib/db.pageMetadata.test.ts
  git add src/lib/db.ts src/lib/db.pageMetadata.test.ts
  git commit -m "feat(db): key the bank helpers on bankId"
  ```

---

## Task 6: Profile duplication keeps bank identity

**Files:**

- Change `src/lib/db.ts:1890-1959` (`duplicateProfileLocally`)
- Change `src/lib/db.duplicateProfile.test.ts:22-27` and `:39-52` and `:57-61`

**Interfaces:**

- Consumes: `upsertPadConfiguration`, `upsertPageMetadata`, `getAllPageMetadataForProfile`, `extractPadPlaybackSettings`.
- Produces: no new export.

A duplicate is a new profile, so it copies the source's `bankId` values as they are. The two profiles never merge with each other, so a shared id is safe and keeps the copy's tab order identical.

Steps:

- [ ] **Step 1: Update the existing test.** In `src/lib/db.duplicateProfile.test.ts`, do this:

  - Change the destructure at line 22 to use `getPadConfigurationsForProfileBank`.
  - Change the seed pad at line 39 to carry `bankId: "0"` in place of `pageIndex: 0`.
  - Change the `duplicatedPad` helper to `getPadConfigurationsForProfileBank(newId, "0")`.
  - Add this case:

  ```ts
  it("copies the bank identities, so the tab order survives", async () => {
    const { newId } = await duplicatedPad();
    const { getAllPageMetadataForProfile } = await import("./db");

    const banks = await getAllPageMetadataForProfile(newId);

    expect(banks.map((bank) => bank.bankId)).toContain("0");
  });
  ```

- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run src/lib/db.duplicateProfile.test.ts`. Expect:

  ```
  TypeError: getPadConfigurationsForProfileBank is not a function
  ```

  because the destructure at the top of the file still names the old function. After you fix the destructure, expect instead:

  ```
  AssertionError: expected undefined to be 'Horn'
  ```

  because `duplicateProfileLocally` still writes `pageIndex`.

- [ ] **Step 3: Fix the copy.** In `duplicateProfileLocally`, change the pad copy to pass `bankId: pad.bankId` in place of `pageIndex: pad.pageIndex`. Then change the bank copy to:

  ```ts
  for (const bank of await getAllPageMetadataForProfile(sourceProfileId)) {
    await upsertPageMetadata({
      profileId: newProfileId,
      // The copy keeps the source's identities. The two profiles never
      // merge with each other, so a shared id is safe, and it keeps the
      // copy's tab order the same as the original's.
      bankId: bank.bankId,
      pageIndex: bank.pageIndex,
      name: bank.name,
      isEmergency: bank.isEmergency,
    });
  }
  ```

  Move that loop **above** the pad loop, so every pad has a bank when it is written.

- [ ] **Step 4: Run the test and see it pass.** Run `npx vitest run src/lib/db.duplicateProfile.test.ts`. Every test must pass.

- [ ] **Step 5: Commit.**

  ```bash
  npx prettier --write src/lib/db.ts src/lib/db.duplicateProfile.test.ts
  git add src/lib/db.ts src/lib/db.duplicateProfile.test.ts
  git commit -m "fix(db): carry bank identity through profile duplication"
  ```

---

## Task 7: Sync keys on identity

**Files:**

- Change `src/lib/syncUtils.ts:53` (the comment on `ItemConflict.key`)
- Change `src/lib/syncUtils.ts:606-607` (`padConfigKeyExtractor`)
- Change `src/lib/syncUtils.ts:624-625` (`pageMetaKeyExtractor`)
- Change `src/lib/syncUtils.ts:855` and `:858` (the diff summary sort)
- Change `src/lib/syncUtils.ts:935` and `:938` (the resolution maps)

**Interfaces:**

- Consumes: `PadConfiguration`, `PageMetadata`.
- Produces: no new export. The keys change value only.

Steps:

- [ ] **Step 1: Write the test that fails.** Create `src/lib/syncUtils.bankIdentity.test.ts`:

  ```ts
  /**
   * The merge keys on identity, so a rename made on one device and a reorder
   * made on another do not fight.
   *
   * With position as the key, the rename landed on whichever bank now sat at
   * that position — silently, with no conflict raised. That is the whole
   * reason `bankId` exists.
   */
  import { describe, expect, it } from "vitest";
  import { detectProfileConflicts, type ProfileSyncData } from "./syncUtils";
  import { normaliseBankOrder } from "./bankOrder";
  import type { PageMetadata } from "./db";

  const LAST_SYNC = 1_000;
  const RENAMED_AT = 2_000;
  const MOVED_AT = 2_500;

  const baseProfile = {
    id: 1,
    name: "Test profile",
    syncType: "googleDrive" as const,
    lastBackedUpAt: 0,
    backupReminderPeriod: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  function bank(
    bankId: string,
    pageIndex: number,
    name: string,
    fieldsModified: Record<string, number> = {},
  ): PageMetadata {
    return {
      profileId: 1,
      bankId,
      pageIndex,
      name,
      isEmergency: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      _created: 0,
      _modified: Math.max(0, ...Object.values(fieldsModified)),
      _fieldsModified: fieldsModified,
    };
  }

  function syncData(banks: PageMetadata[]): ProfileSyncData {
    return {
      _syncFormatVersion: 2,
      _lastSyncTimestamp: LAST_SYNC,
      profile: { ...baseProfile },
      padConfigurations: [],
      pageMetadata: banks,
      audioFiles: [],
    };
  }

  describe("a rename and a reorder made on two devices", () => {
    it("leaves the rename on the bank it was made on", async () => {
      // This device renamed bank "a" and left it at position 0.
      const local = syncData([
        bank("a", 0, "Stings", { name: RENAMED_AT }),
        bank("b", 1, "Bank 2"),
      ]);
      // The other device moved bank "b" to position 0 and never renamed.
      const remote = syncData([
        bank("a", 1, "Bank 1", { pageIndex: MOVED_AT }),
        bank("b", 0, "Bank 2", { pageIndex: MOVED_AT }),
      ]);

      const { mergedData, conflicts } = await detectProfileConflicts(
        local,
        remote,
      );
      const merged = new Map(
        mergedData.pageMetadata.map((page) => [page.bankId, page]),
      );

      expect(conflicts).toHaveLength(0);
      // The rename stayed with "a", and the move stayed with the positions.
      expect(merged.get("a")?.name).toBe("Stings");
      expect(merged.get("a")?.pageIndex).toBe(1);
      expect(merged.get("b")?.pageIndex).toBe(0);
    });

    it("does not treat a moved bank as a new bank", async () => {
      const local = syncData([bank("a", 0, "Stings"), bank("b", 1, "Beds")]);
      const remote = syncData([bank("a", 1, "Stings"), bank("b", 0, "Beds")]);

      const { mergedData } = await detectProfileConflicts(local, remote);

      expect(mergedData.pageMetadata).toHaveLength(2);
    });
  });

  describe("order normalisation across two devices", () => {
    it("resolves duplicate and gappy positions to one dense order", () => {
      // Both devices hold the same rows, in whatever order they read them.
      const deviceA = [bank("a", 2, "A"), bank("b", 2, "B"), bank("c", 7, "C")];
      const deviceB = [bank("c", 7, "C"), bank("b", 2, "B"), bank("a", 2, "A")];

      const orderA = normaliseBankOrder(deviceA).map((page) => page.bankId);
      const orderB = normaliseBankOrder(deviceB).map((page) => page.bankId);

      expect(orderA).toEqual(["a", "b", "c"]);
      expect(orderB).toEqual(orderA);
      expect(normaliseBankOrder(deviceA).map((page) => page.pageIndex)).toEqual(
        [0, 1, 2],
      );
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run src/lib/syncUtils.bankIdentity.test.ts`. Expect:

  ```
  AssertionError: expected 'Bank 1' to be 'Stings'
  ```

  The key is still the position, so the rename lands on the bank that moved into position 0.

- [ ] **Step 3: Change the extractors.** In `src/lib/syncUtils.ts`, replace lines 606-607 with:

  ```ts
  const padConfigKeyExtractor = (item: PadConfiguration) =>
    `${item.bankId}-${item.padIndex}`;
  ```

  and lines 624-625 with:

  ```ts
  const pageMetaKeyExtractor = (item: PageMetadata) => item.bankId;
  ```

- [ ] **Step 4: Change the two other key sites.** Replace line 935 with `resolved.padConfigurations.map((p) => [`${p.bankId}-${p.padIndex}`, p]),` and line 938 with `resolved.pageMetadata.map((p) => [p.bankId, p]),`. Update the comment at line 53 to `// Unique key (profile ID, bankId-padIndex, bankId)`.

- [ ] **Step 5: Change the diff summary sort.** Replace line 855 with:

  ```ts
        .sort(
          (a, b) =>
            a.bankId.localeCompare(b.bankId) || a.padIndex - b.padIndex,
        )
  ```

  and line 858 with `.sort((a, b) => a.bankId.localeCompare(b.bankId))`. The summary must sort on identity, or a reorder alone makes two equal blobs look different and forces a needless push.

- [ ] **Step 6: Run the test and see it pass.** Run `npx vitest run src/lib/syncUtils.bankIdentity.test.ts`.

- [ ] **Step 7: Run the whole sync suite.** Run `npx vitest run src/lib/syncUtils.test.ts src/lib/syncUtils.hashTwins.test.ts src/lib/syncUtils.conflictResolution.test.ts src/lib/syncUtils.gainRemap.test.ts`. Fix each fixture that still builds a pad or bank with `pageIndex` alone: give it a `bankId`. Do not change any assertion about merge behaviour.

- [ ] **Step 8: Commit.**

  ```bash
  npx prettier --write src/lib/syncUtils.ts src/lib/syncUtils.bankIdentity.test.ts src/lib/syncUtils.test.ts src/lib/syncUtils.hashTwins.test.ts src/lib/syncUtils.conflictResolution.test.ts src/lib/syncUtils.gainRemap.test.ts
  git add src/lib/syncUtils.ts src/lib/syncUtils.bankIdentity.test.ts src/lib/syncUtils.test.ts src/lib/syncUtils.hashTwins.test.ts src/lib/syncUtils.conflictResolution.test.ts src/lib/syncUtils.gainRemap.test.ts
  git commit -m "feat(sync): key the merge on bankId"
  ```

---

## Task 8: The Drive write-back on identity

**Files:**

- Change `src/lib/googleDrive/dataAccess.ts:412-422` (the pad map and key)
- Change `src/lib/googleDrive/dataAccess.ts:449` and `:459` (two warning messages)
- Change `src/lib/googleDrive/dataAccess.ts:520-524` (the delete-absent pass for pads)
- Change `src/lib/googleDrive/dataAccess.ts:528-563` (the bank write-back and its delete-absent pass)

**Interfaces:**

- Consumes: `PadConfiguration`, `PageMetadata`.
- Produces: no new export.

The delete-absent pass at lines 559-563 becomes identity-based. It then stops being a hazard: a bank that only moved is no longer "a bank the remote does not have".

Steps:

- [ ] **Step 1: Write the test that fails.** Add this case to `src/lib/googleDrive/dataAccess.wire.test.ts`, inside the top-level `describe`:

  ```ts
  it("keeps a bank that only changed position", async () => {
    // The delete-absent pass used to key on position, so a bank that moved
    // looked like a bank the remote had deleted.
    const { updateLocalData } = await import("./dataAccess");
    const { addProfile, getAllPageMetadataForProfile, upsertPageMetadata } =
      await import("@/lib/db");

    const profileId = await addProfile({ name: "Moved", syncType: "local" });
    await upsertPageMetadata({
      profileId,
      bankId: "0",
      pageIndex: 0,
      name: "Stings",
    });
    await upsertPageMetadata({
      profileId,
      bankId: "1",
      pageIndex: 1,
      name: "Beds",
    });

    await updateLocalData(profileId, {
      _syncFormatVersion: 2,
      _lastSyncTimestamp: Date.now(),
      profile: { name: "Moved", syncType: "local" } as never,
      padConfigurations: [],
      pageMetadata: [
        {
          profileId,
          bankId: "0",
          pageIndex: 1,
          name: "Stings",
          isEmergency: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
        {
          profileId,
          bankId: "1",
          pageIndex: 0,
          name: "Beds",
          isEmergency: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      audioFiles: [],
    });

    const banks = await getAllPageMetadataForProfile(profileId);
    expect(banks.map((bank) => bank.bankId).sort()).toEqual(["0", "1"]);
  });
  ```

  Read the head of `src/lib/googleDrive/dataAccess.wire.test.ts` first and match its import style and its `beforeEach`.

- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run src/lib/googleDrive/dataAccess.wire.test.ts`. Expect a failure of this shape, because the write-back still keys on position and the merge writes both banks into one position:

  ```
  ConstraintError: Unable to add key to index 'profileBank': at least one key does not satisfy the uniqueness requirements.
  ```

- [ ] **Step 3: Key the pad write-back on identity.** Change lines 412-417 to build the map from `` `${p.bankId}-${p.padIndex}` `` and line 421 to `const key = `${pad.bankId}-${pad.padIndex}`;`. Change the two warning messages at lines 449 and 459 to name `pad.bankId`.

- [ ] **Step 4: Key the bank write-back on identity.** Make these changes:

  - Change line 530 to `existingPages.map((p: PageMetadata) => [p.bankId, p]),`.
  - Change `syncedPageIndices` to `syncedBankIds`. Add `page.bankId` to it.
  - Change line 543 to `existingPageMap.get(page.bankId)`.
  - Change the delete-absent pass at lines 559-563 to:

  ```ts
  // Delete local banks the synced data does not name. Keyed on identity,
  // so a bank that only moved is not mistaken for a bank that was deleted.
  for (const [bankId, existingPage] of existingPageMap) {
    if (!syncedBankIds.has(bankId) && existingPage?.id) {
      await pageStore.delete(existingPage.id);
    }
  }
  ```

- [ ] **Step 5: Run the test and see it pass.** Run `npx vitest run src/lib/googleDrive/dataAccess.wire.test.ts src/lib/googleDrive/dataAccess.hashKeyed.test.ts src/lib/googleDrive/dataAccess.stamps.test.ts src/lib/googleDrive/dataAccess.gain.test.ts`. Fix each fixture that still writes a pad with `pageIndex`.

- [ ] **Step 6: Commit.**

  ```bash
  npx prettier --write src/lib/googleDrive/dataAccess.ts src/lib/googleDrive/dataAccess.wire.test.ts
  git add src/lib/googleDrive/dataAccess.ts src/lib/googleDrive/*.test.ts
  git commit -m "feat(sync): write back Drive data by bank identity"
  ```

---

## Task 9: Export and import carry `bankId`

**Files:**

- Change `src/lib/importExport.ts:578-600` (the bank import loop)
- Change `src/lib/importExport.ts:700-765` (the pad import loop)
- Change `src/lib/importExport.ts:845-860` (the V1 pad migration)
- Change `src/lib/importExport.ts:1250-1310` (the impamp2 legacy import)

**Interfaces:**

- Consumes: `migratedBankId` from `@/lib/dbMigrations/v7BankId`.
- Produces: no new export.

An archive written before this change has no `bankId`. Import gives such a bank and its pads `migratedBankId(pageIndex)`. The migration uses the same rule. An old archive therefore imports into the identities the device already holds.

Steps:

- [ ] **Step 1: Write the test that fails.** Add this case to `src/lib/importExport.zip.test.ts`, inside the top-level `describe`:

  ```ts
  it("gives an archive with no bankId the deterministic migrated id", async () => {
    // A file exported before bank identity existed. The import must reach
    // the same ids the v7 migration would, or the same board arrives twice.
    const restored = await roundTripLegacyProfile({
      pageMetadata: [{ pageIndex: 2, name: "Stings", isEmergency: false }],
      padConfigurations: [
        {
          pageIndex: 2,
          padIndex: 0,
          audioFileIds: [],
          playbackType: "sequential",
        },
      ],
    });

    expect(restored.pageMetadata[0].bankId).toBe("2");
    expect(restored.padConfigurations[0].bankId).toBe("2");
  });
  ```

  Read `src/lib/importExport.zip.test.ts` first, and reuse whatever round-trip helper it already has instead of the placeholder name above. Match the helper's real name and signature.

- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run src/lib/importExport.zip.test.ts`. Expect:

  ```
  AssertionError: expected undefined to be '2'
  ```

- [ ] **Step 3: Fill in the identity on import.** In the bank import loop, change the `content` literal to:

  ```ts
  const content = {
    profileId,
    // An archive written before bank identity existed carries no id. Use
    // the same deterministic rule the v7 migration uses, so an old archive
    // imports into the identities this device already holds.
    bankId: page.bankId ?? migratedBankId(page.pageIndex),
    pageIndex: page.pageIndex,
    name: page.name,
    isEmergency: page.isEmergency,
  };
  ```

  In the pad import loop, replace `pageIndex: pad.pageIndex,` with `bankId: pad.bankId ?? migratedBankId(pad.pageIndex),` and change the two messages at lines 705 and 760-763 to name the bank id. In the V1 migration at line 851, replace `pageIndex: oldPad.pageIndex,` with `bankId: migratedBankId(oldPad.pageIndex),`. In the impamp2 legacy import at lines 1268, 1292 and 1303, add `bankId: migratedBankId(pageIndex),` beside the position.

- [ ] **Step 4: Run the test and see it pass.** Run `npx vitest run src/lib/importExport.zip.test.ts src/lib/importExport.impamp2.test.ts src/lib/importExport.syncFields.test.ts src/lib/importExport.failedImport.test.ts src/lib/importExport.hostedAudio.test.ts src/lib/importExport.serverLink.test.ts`. Fix each fixture that builds a pad with `pageIndex` alone.

- [ ] **Step 5: Commit.**

  ```bash
  npx prettier --write src/lib/importExport.ts src/lib/importExport.*.test.ts
  git add src/lib/importExport.ts src/lib/importExport.*.test.ts
  git commit -m "feat(import): carry bank identity through export and import"
  ```

---

## Task 10: Runtime keys on `bankId`

**Files:**

- Change `src/lib/audio/types.ts:99`, `:140`, `:159-168`
- Change `src/store/loadingStore.ts:15`, `:57-71`
- Change `src/store/playbackStore.ts:13`, `:21`, `:34`, `:38`, `:86`, `:113-154`
- Change `src/lib/audio/preloader.ts:30`, `:68-218`
- Change `src/lib/audio/controls.ts:438`, `:694-726`
- Change `src/lib/audio/loudness/overview.ts:25`, `:45`, `:60`, `:80-161`

**Interfaces:**

- Produces:
  ```ts
  export function generatePlaybackKey(
    profileId: number,
    bankId: string,
    padIndex: number,
  ): string; // `pad-${profileId}-${bankId}-${padIndex}`
  export function generatePadLoadingKey(
    profileId: number,
    bankId: string,
    padIndex: number,
  ): string;
  // PlaybackState.padInfo and ArmedTrackState.padInfo: { profileId: number; bankId: string; padIndex: number }
  // LoudnessOverview rows: bankId: string, and bankName from a bankId lookup
  ```

A key on identity is what lets a reorder run while sound plays. With a key on position, a reorder orphaned every active track and every armed cue.

Steps:

- [ ] **Step 1: Write the test that fails.** Add this case to `src/store/playbackStore.armed.test.ts`, inside its top-level `describe`:

  ```ts
  it("keys an armed cue on the bank, not on the position", () => {
    const { armTrack, getArmedTracks } = usePlaybackStore.getState();
    // A bank id that is not a number proves the key holds identity, not
    // position. Build the key rather than write it out: a bare literal here
    // reads to gitleaks as a generic API key.
    const bankId = "stings";

    armTrack({
      key: `armed-1-${bankId}-3`,
      name: "Horn",
      padInfo: { profileId: 1, bankId, padIndex: 3 },
      audioFileIds: [11],
      playbackType: "sequential",
    });

    // The identity is in the key, so moving the bank cannot orphan the cue.
    expect(getArmedTracks()[0].padInfo.bankId).toBe("stings");
  });
  ```

  Read `src/store/playbackStore.armed.test.ts` first and match its real `armTrack` argument shape.

- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run src/store/playbackStore.armed.test.ts`. Expect:

  ```
  AssertionError: expected undefined to be 'stings'
  ```

- [ ] **Step 3: Change the two key builders.** In `src/lib/audio/types.ts`, change `generatePlaybackKey` to take `bankId: string` and return `` `pad-${profileId}-${bankId}-${padIndex}` ``. Change both `pageIndex: number` members at lines 99 and 140 to `bankId: string`. In `src/store/loadingStore.ts`, change `generatePadLoadingKey` the same way and update the key-format comment at line 15.

- [ ] **Step 4: Change the two stores.** In `src/store/playbackStore.ts`, make these changes:

  - Change every `pageIndex` member of `padInfo` to `bankId: string`.
  - Change line 86 to `bankId: trackInfo.padInfo.bankId`.
  - Change line 118 to pass `track.padInfo.bankId` to `generatePlaybackKey`.
  - Change line 116 to call `getPadConfigurationsForProfileBank(track.padInfo.profileId, track.padInfo.bankId)`.
  - Change line 154 to pass `currentBankId: track.padInfo.bankId`.

- [ ] **Step 5: Change the audio pipeline.** In `src/lib/audio/preloader.ts` and `src/lib/audio/controls.ts`:

  - Replace every `pageIndex: number` in a context object with `bankId: string`.
  - Replace the two sentinel values `pageIndex: -1` in `preloader.ts` with `bankId: ""`.

  In `src/lib/audio/loudness/overview.ts`:

  - Replace `pageIndex` with `bankId` on both row types.
  - Change `getBankName` to `(bankId: string) => string`.
  - Change the row key at line 80 to `` `${pad.bankId}-${pad.padIndex}-${index}-${audioFileId}` ``.
  - Change the sort at line 161 to sort on `bankId` first and on `padIndex` second.

- [ ] **Step 6: Run the tests and see them pass.** Run `npx vitest run src/store/playbackStore.armed.test.ts src/lib/audio/preloader.test.ts src/lib/audio/loudness/overview.test.ts src/lib/audio/playback.trimEnd.test.ts`. Fix each fixture that still passes a `pageIndex`.

- [ ] **Step 7: Commit.**

  ```bash
  npx prettier --write src/lib/audio src/store
  git add src/lib/audio src/store
  git commit -m "feat(audio): key playback and loading on bankId"
  ```

---

## Task 11: Hooks read by `bankId`

**Files:**

- Change `src/hooks/usePadConfigurations.ts:2`, `:70-102`, `:135`
- Change `src/hooks/emergencySounds.ts:16`, `:22`, `:52`, `:72-85`
- Change `src/hooks/useSearch.ts:22`, `:123-192`
- Change `src/hooks/useKeyboardListener.ts:57`, `:73`, `:84`, `:96`
- Change `src/hooks/pad/usePadDrop.ts:80`
- Change `src/hooks/pad/usePadInteractions.ts:95`, `:191`, `:293`

**Interfaces:**

- Consumes: `getPadConfigurationsForProfileBank` from `@/lib/db`.
- Produces:
  ```ts
  export function usePadConfigurations(
    profileId: string | null,
    bankId: string | null,
  ): UsePadConfigurationsResult;
  // EmergencySound: { profileId: number; bankId: string; padIndex: number; ... }
  // SearchResult: { profileId: number; bankId: string; pageIndex: number; padIndex: number; bankName: string; ... }
  ```

A search result keeps **both** fields: `bankId` names the pad to play, and `pageIndex` is the position the app navigates to.

Steps:

- [ ] **Step 1: Write the test that fails.** Add this case to `src/hooks/usePadConfigurations.actionable.test.ts`, inside its top-level `describe`:

  ```ts
  it("asks for the pads of a bank by its identity", async () => {
    const pads = await getPadConfigurationsForProfileBank(profileId, "0");

    expect(pads.map((pad) => pad.padIndex)).toContain(0);
  });
  ```

  Read that file first and match its real setup, its imports and its profile fixture.

- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run src/hooks/usePadConfigurations.actionable.test.ts`. Expect:

  ```
  TypeError: getPadConfigurationsForProfileBank is not a function
  ```

- [ ] **Step 3: Change the hooks.** In `usePadConfigurations.ts`:

  - Change the second parameter to `bankId: string | null`. Return the empty result while it is null.
  - Change the request key at line 92 to `` `${profileId}|${bankId}|${padConfigsVersion}` ``.
  - Call `getPadConfigurationsForProfileBank`.

  In `emergencySounds.ts`:

  - Change `EmergencySound.pageIndex` to `bankId: string`.
  - Change the identity string at line 52 to `` `${s.bankId}:${s.padIndex}` ``.
  - Read each emergency bank with `getPadConfigurationsForProfileBank(profileId, bank.bankId)`.

  In the other three files:

  - In `useSearch.ts`, add `bankId` beside `pageIndex` on `SearchResult`. Key the bank-name cache on `bankId`.
  - In `useKeyboardListener.ts`, pass `sound.bankId` to `triggerAudioForPadInstant` and to the three `generatePadLoadingKey` calls.
  - In the two pad hooks, replace `pageIndex: currentPageIndex` with `bankId: currentBankId` in every write and every trigger.

- [ ] **Step 4: Run the tests and see them pass.** Run `npx vitest run src/hooks`. Fix each fixture that still passes a `pageIndex`.

- [ ] **Step 5: Commit.**

  ```bash
  npx prettier --write src/hooks
  git add src/hooks
  git commit -m "feat(hooks): read pads and emergency banks by bankId"
  ```

---

## Task 12: The store holds the banks

**Files:**

- Change `src/store/profileStore.ts:48-49`, `:69`, `:193-196`, `:256-257`, `:318-345`, `:350-412`
- Change `src/store/profileStore.test.ts`

**Interfaces:**

- Consumes: `ensureDefaultBanks` from `@/lib/db`; `positionOfBank` from `@/lib/bankOrder`.
- Produces:
  ```ts
  banks: PageMetadata[];            // normalised: the array index is the position
  currentBankId: string | null;     // the identity of the bank on screen
  loadBanks: (profileId: number) => Promise<void>;
  setCurrentPageIndex: (bankNumber: number) => void;  // unchanged signature
  ```

The store already holds the profile list, so it is the right place for the bank list. This change also removes the `pageIndexRequestToken` race guard at line 193. The banks stay in memory. The bank switch therefore needs no database read and cannot arrive late.

Steps:

- [ ] **Step 1: Write the test that fails.** Add this block to `src/store/profileStore.test.ts`:

  ```ts
  describe("bank selection", () => {
    it("selects by position and reports the identity", async () => {
      const store = useProfileStore.getState();
      await store.loadBanks(profileId);

      useProfileStore.getState().setCurrentPageIndex(3);

      expect(useProfileStore.getState().currentPageIndex).toBe(2);
      expect(useProfileStore.getState().currentBankId).toBe("2");
    });

    it("keeps the view on the same bank when the order changes", async () => {
      const { reorderBanks } = await import("@/lib/db");
      const store = useProfileStore.getState();
      await store.loadBanks(profileId);
      useProfileStore.getState().setCurrentPageIndex(3);

      // Move the selected bank to the front.
      await reorderBanks(profileId, ["2", "0", "1"]);
      await useProfileStore.getState().loadBanks(profileId);

      expect(useProfileStore.getState().currentBankId).toBe("2");
      expect(useProfileStore.getState().currentPageIndex).toBe(0);
    });

    it("refuses a position that holds no bank", async () => {
      const store = useProfileStore.getState();
      await store.loadBanks(profileId);

      useProfileStore.getState().setCurrentPageIndex(15);

      expect(useProfileStore.getState().currentBankId).toBe("0");
    });
  });
  ```

  Read `src/store/profileStore.test.ts` first and match its setup: it must create a profile and set it active before each case.

- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run src/store/profileStore.test.ts`. Expect:

  ```
  TypeError: store.loadBanks is not a function
  ```

- [ ] **Step 3: Add the state and the loader.** In `src/store/profileStore.ts`:

  - Add `banks: PageMetadata[];` and `currentBankId: string | null;` to the state interface, beside `currentPageIndex`.
  - Add `loadBanks: (profileId: number) => Promise<void>;` to the action interface.
  - Add `banks: []` and `currentBankId: null` to the initial state at line 256.

  Then add the action:

  ```ts
          loadBanks: async (profileId: number) => {
            const { ensureDefaultBanks } = await import("@/lib/db");
            const banks = await ensureDefaultBanks(profileId);
            set((state) => {
              // Follow the same bank across a reorder, rather than the slot
              // number. The user is looking at a bank, not at a position.
              const held = state.currentBankId
                ? positionOfBank(banks, state.currentBankId)
                : -1;
              const position = held >= 0 ? held : 0;
              return {
                banks,
                currentPageIndex: position,
                currentBankId: banks[position]?.bankId ?? null,
              };
            });
          },
  ```

- [ ] **Step 4: Simplify the bank switch.** Replace the whole body of `setCurrentPageIndex` (lines 350-412) with:

  ```ts
          setCurrentPageIndex: (bankNumber: number) => {
            const index = convertBankNumberToIndex(bankNumber);
            if (index < 0 || index >= MAX_BANKS) {
              console.warn(
                `Invalid bank number: ${bankNumber}. Must be 1-9, 0 (for bank 10), or 11-20.`,
              );
              return;
            }
            // The banks are already in memory, so no database read can arrive
            // late and overwrite a later choice. That is why the request token
            // this used to need is gone.
            const bank = get().banks[index];
            if (!bank) {
              console.warn(
                `Bank ${bankNumber} does not exist for this profile. Bank selection unchanged.`,
              );
              return;
            }
            set({ currentPageIndex: index, currentBankId: bank.bankId });
          },
  ```

  Delete `let pageIndexRequestToken = 0;` at line 193 and its comment. In `setActiveProfileId`, add `banks: [], currentBankId: null` to the reset at line 331. Then shorten the long comment. The reset holds, and the reason is now "a profile has its own banks".

- [ ] **Step 5: Run the test and see it pass.** Run `npx vitest run src/store/profileStore.test.ts`. All three cases must pass. `reorderBanks` does not exist yet, so mark the second case `it.todo` for now and turn it back on in Task 15.

- [ ] **Step 6: Commit.**

  ```bash
  npx prettier --write src/store/profileStore.ts src/store/profileStore.test.ts
  git add src/store/profileStore.ts src/store/profileStore.test.ts
  git commit -m "feat(store): hold the normalised bank list in the profile store"
  ```

---

## Task 13: The components take a `bankId`

**Files:**

- Change `src/components/Pad.tsx:15`, `:62`, `:71`, `:121`, `:125`
- Change `src/components/PadGrid.tsx:53`, `:72`, `:86`, `:117`, `:356`, `:390`, `:413`, `:438`
- Change `src/components/search/SearchModal.tsx:92`, `:108`, `:116`, `:249`
- Change `src/components/modals/ConflictResolutionModal.tsx:32`, `:37`
- Change `src/components/modals/BulkImportModalContent.tsx:31`, `:57`, `:325`
- Change `src/components/modals/LoudnessOverviewModalContent.tsx:70-131`, `:219-249`, `:292-348`, `:398-399`, `:520`
- Change `src/components/profiles/ProfileManager.tsx:513-519`, `:1461`, `:1470`
- Change `src/components/WaveformTrimmer.tsx:384`

**Interfaces:**

- Consumes: `bankId` from `profileStore.currentBankId` and from the search results.
- Produces: `PadProps` and `PadGridProps` take `bankId: string` in place of `pageIndex: number`.

Steps:

- [ ] **Step 1: See the failures.** Run `npx tsc --noEmit`. Expect one error per site, of this shape:

  ```
  src/components/PadGrid.tsx(117,9): error TS2322: Type '{ pageIndex: number; ... }' is not assignable to type 'IntrinsicAttributes & PadProps'.
    Property 'pageIndex' does not exist on type 'IntrinsicAttributes & PadProps'.
  ```

  The type checker is the test that fails for this task. It lists every site, so you miss nothing.

- [ ] **Step 2: Change the pad components.** In `Pad.tsx` and `PadGrid.tsx`, rename the `pageIndex: number` prop to `bankId: string` and pass it to `generatePlaybackKey`, `usePadLoadingState` and every write. In `PadGrid.tsx`, take the value from `useProfileStore((state) => state.currentBankId)` in place of `currentPageIndex`.

- [ ] **Step 3: Change the modals and the search.** Change one file at a time:

  - `SearchModal.tsx`: keep `setCurrentPageIndex(result.pageIndex)` for navigation. Change the armed key at line 108 and the `padInfo` at line 116 to use `result.bankId`.
  - `ConflictResolutionModal.tsx`: label a pad conflict `Pad Config: Bank ${item?.bankId ?? "?"}, Pad ${...}`. Label a bank conflict `Bank Meta: ${item?.bankId ?? "?"} (${item?.name ?? "Unnamed"})`.
  - `BulkImportModalContent.tsx`: take `bankId` in place of `pageIndex`. Pass it to the pad writes.
  - `LoudnessOverviewModalContent.tsx`: key `bankNames` on `bankId`. Filter on `bankId`. Find the pad by `p.bankId === bankId && p.padIndex === padIndex`.
  - `ProfileManager.tsx`: build the repair key from `entry.bankId`. Render `Bank {entry.bankName}`.
  - `WaveformTrimmer.tsx`: change the dummy `padInfo` at line 384 to `{ profileId: 0, bankId: "", padIndex: 0 }`.

- [ ] **Step 4: Check the types.** Run `npx tsc --noEmit`. Only `src/app/page.tsx` may still report errors; Task 14 fixes it.

- [ ] **Step 5: Run the whole suite.** Run `npm test`. Every test must pass.

- [ ] **Step 6: Commit.**

  ```bash
  npx prettier --write src/components
  git add src/components
  git commit -m "feat(ui): pass bankId through the pad and modal components"
  ```

---

## Task 14: The tab strip reads the store

**Files:**

- Create `src/components/BankTabStrip.tsx`
- Change `src/app/page.tsx:23-30`, `:75-133`, `:138-205`, `:289-453`

**Interfaces:**

- Consumes: `banks`, `currentBankId`, `isEditMode`, `loadBanks` from `profileStore`; `renameBank`, `setBankEmergencyState`, `createBank`, `MAX_BANKS` from `@/lib/db`.
- Produces:
  ```ts
  export interface BankTabStripProps {
    banks: PageMetadata[];
    currentBankId: string | null;
    isEditMode: boolean;
    onSelect: (bankId: string) => void;
    onEdit: (bankId: string) => void;
    onReorder: (orderedBankIds: string[]) => void;
  }
  export default function BankTabStrip(
    props: BankTabStripProps,
  ): React.JSX.Element;
  ```

This task moves the strip into its own component and deletes the local `bankNames` and `emergencyBanks` state in `page.tsx`. The drag interaction arrives in Task 16; `onReorder` stays unused until then.

Steps:

- [ ] **Step 1: Write the component without the drag.** Create `src/components/BankTabStrip.tsx`. Render one `<button role="tab">` per entry of `banks`, in array order, with `data-bank-index={position}`, `data-bank-id={bank.bankId}`, `aria-selected={bank.bankId === currentBankId}`, the label `${position + 1}: ${bank.name}`, the red dot when `bank.isEmergency`, and the same class names `page.tsx` uses today at lines 320-333. Call `onEdit(bank.bankId)` when `isEditMode` is true and `onSelect(bank.bankId)` otherwise. Keep the wrapper `<div className="flex flex-1 space-x-1 overflow-x-auto pb-1" role="tablist">`.

- [ ] **Step 2: Use it from `page.tsx`.** Delete the `bankNames` and `emergencyBanks` state and the effect that fills them. Replace them with:

  ```tsx
  const banks = useProfileStore((state) => state.banks);
  const currentBankId = useProfileStore((state) => state.currentBankId);
  const loadBanks = useProfileStore((state) => state.loadBanks);

  // `padConfigsVersion` is deliberately present: it is the counter sync
  // bumps after it applies a remote change, and without it a bank renamed by
  // a collaborator never appeared until the profile was switched.
  useEffect(() => {
    if (activeProfileId === null) return;
    void loadBanks(activeProfileId);
  }, [activeProfileId, padConfigsVersion, loadBanks]);
  ```

  Change `handleBankClick` to take a `bankId`, read the bank from `banks`, and call `renameBank` and `setBankEmergencyState` with it. Change the "+ Add Bank" handler to call `createBank(activeProfileId, finalBankName)`, then `loadBanks(activeProfileId)`, then `setCurrentPageIndex` on the new bank's position. Cap the button on `banks.length >= MAX_BANKS`. Pass `<PadGrid bankId={currentBankId ?? ""} />`.

- [ ] **Step 3: Check the types and the lint.** Run `npx tsc --noEmit` and `npm run lint`. Both must be clean.

- [ ] **Step 4: Run the app and look at it.** Ask the user to start `npm run dev` if no server runs. Open `http://localhost:3000`. Then confirm each of these:

  - Ten tabs appear.
  - A click switches the bank.
  - The keys 1-9 and 0 switch the bank.
  - Shift+click opens the bank edit modal.
  - The "+" button adds bank 11.

- [ ] **Step 5: Run the end-to-end suite.** Run `npm run test:e2e`. Every chromium test must pass. `e2e-tests/test-helpers.ts` counts `[role="tab"]`, and the count is still ten before the first added bank.

- [ ] **Step 6: Commit.**

  ```bash
  npx prettier --write src/app/page.tsx src/components/BankTabStrip.tsx
  git add src/app/page.tsx src/components/BankTabStrip.tsx
  git commit -m "refactor(ui): render the bank tabs from the store"
  ```

---

## Task 15: `reorderBanks`

**Files:**

- Change `src/lib/db.ts` (add `reorderBanks` after `createBank`)
- Create `src/lib/db.reorderBanks.test.ts`
- Change `src/store/profileStore.test.ts` (turn the `it.todo` from Task 12 back on)

**Interfaces:**

- Consumes: `compareBankOrder` from `@/lib/bankOrder`.
- Produces:
  ```ts
  export async function reorderBanks(
    profileId: number,
    orderedBankIds: string[],
  ): Promise<void>;
  ```

Steps:

- [ ] **Step 1: Write the test file.** Create `src/lib/db.reorderBanks.test.ts`:

  ```ts
  /**
   * A reorder writes `pageIndex` on the banks that moved and touches nothing
   * else. No pad row moves, no unique index is stressed, and identity is kept,
   * so the merge sees a position change rather than a mass rename.
   */

  // Must be the first import: it installs `window` before `db.ts` can read it.
  import { clearAllStores } from "@/lib/testSupport/browserGlobals";
  import { beforeEach, describe, expect, it } from "vitest";

  const {
    addProfile,
    ensureDefaultBanks,
    getAllPageMetadataForProfile,
    reorderBanks,
    upsertPadConfiguration,
    getPadConfigurationsForProfileBank,
    renameBank,
    setBankEmergencyState,
  } = await import("./db");

  let profileId: number;

  /** The bank ids in stored position order. */
  async function order(): Promise<string[]> {
    const banks = await getAllPageMetadataForProfile(profileId);
    return banks
      .sort((a, b) => a.pageIndex - b.pageIndex)
      .map((bank) => bank.bankId);
  }

  beforeEach(async () => {
    await clearAllStores();
    profileId = await addProfile({ name: "Board", syncType: "local" });
    await ensureDefaultBanks(profileId);
  });

  describe("reorderBanks", () => {
    it("moves a bank to the right", async () => {
      const before = await order();

      await reorderBanks(profileId, ["1", "2", "0", ...before.slice(3)]);

      expect((await order()).slice(0, 3)).toEqual(["1", "2", "0"]);
    });

    it("moves a bank to the left", async () => {
      const before = await order();

      await reorderBanks(profileId, [
        "4",
        ...before.filter((id) => id !== "4"),
      ]);

      expect((await order())[0]).toBe("4");
    });

    it("keeps the positions dense", async () => {
      const before = await order();

      await reorderBanks(profileId, [...before].reverse());

      const banks = await getAllPageMetadataForProfile(profileId);
      expect(banks.map((bank) => bank.pageIndex).sort((a, b) => a - b)).toEqual(
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      );
    });

    it("writes nothing when the order does not change", async () => {
      const before = await getAllPageMetadataForProfile(profileId);
      const stamps = new Map(
        before.map((bank) => [bank.bankId, bank._modified]),
      );

      await reorderBanks(profileId, await order());

      const after = await getAllPageMetadataForProfile(profileId);
      for (const bank of after) {
        expect(bank._modified).toBe(stamps.get(bank.bankId));
      }
    });

    it("stamps only the banks that moved", async () => {
      const before = await order();
      const untouched = before.slice(3);

      await reorderBanks(profileId, ["1", "2", "0", ...untouched]);

      const after = await getAllPageMetadataForProfile(profileId);
      const byId = new Map(after.map((bank) => [bank.bankId, bank]));
      for (const bankId of ["0", "1", "2"]) {
        expect(byId.get(bankId)?._fieldsModified?.pageIndex).toBeGreaterThan(0);
      }
      for (const bankId of untouched) {
        expect(byId.get(bankId)?._fieldsModified?.pageIndex).toBeUndefined();
      }
    });

    it("leaves the pads, the names and the emergency flags alone", async () => {
      await renameBank(profileId, "0", "Stings");
      await setBankEmergencyState(profileId, "0", true);
      await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 5,
        name: "Horn",
        audioFileIds: [11],
        playbackType: "sequential",
      });
      const before = await order();

      await reorderBanks(profileId, [...before].reverse());

      const pads = await getPadConfigurationsForProfileBank(profileId, "0");
      const banks = await getAllPageMetadataForProfile(profileId);
      const moved = banks.find((bank) => bank.bankId === "0");
      expect(pads).toHaveLength(1);
      expect(pads[0].name).toBe("Horn");
      expect(moved?.name).toBe("Stings");
      expect(moved?.isEmergency).toBe(true);
    });

    it("ignores an id the profile does not hold", async () => {
      const before = await order();

      await reorderBanks(profileId, ["ghost", ...before]);

      expect(await order()).toEqual(before);
    });

    it("appends a bank the caller did not name", async () => {
      await reorderBanks(profileId, ["9", "8"]);

      const after = await order();
      expect(after.slice(0, 2)).toEqual(["9", "8"]);
      expect(after).toHaveLength(10);
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run src/lib/db.reorderBanks.test.ts`. Expect:

  ```
  TypeError: reorderBanks is not a function
  ```

- [ ] **Step 3: Write the function.** Add to `src/lib/db.ts`, below `createBank`:

  ```ts
  /**
   * Writes a new bank order.
   *
   * One transaction over `pageMetadata`. Position is an ordinary field, so a
   * reorder moves no pad row and stresses no unique index. Only a bank that
   * really changed position gets a fresh sync stamp, so the merge sees a
   * position change rather than a mass rename.
   *
   * @param profileId - The profile whose banks move
   * @param orderedBankIds - The identities, in the new order. An id the
   *   profile does not hold is ignored. A bank the caller does not name keeps
   *   its relative order, after the named ones.
   */
  export async function reorderBanks(
    profileId: number,
    orderedBankIds: string[],
  ): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("pageMetadata", "readwrite");
    const store = tx.objectStore("pageMetadata");
    const banks = await store.index("profileId").getAll(profileId);
    const byId = new Map(banks.map((bank) => [bank.bankId, bank]));

    const ordered: PageMetadata[] = [];
    for (const bankId of orderedBankIds) {
      const bank = byId.get(bankId);
      if (!bank) continue;
      byId.delete(bankId);
      ordered.push(bank);
    }
    // Sorted with the shared comparator rather than renumbered, because the
    // loop below decides what to write by the *old* position.
    ordered.push(...[...byId.values()].sort(compareBankOrder));

    const now = new Date();
    const nowMs = now.getTime();
    for (let position = 0; position < ordered.length; position++) {
      const bank = ordered[position];
      if (bank.pageIndex === position) continue;
      await store.put({
        ...bank,
        pageIndex: position,
        updatedAt: now,
        _modified: nowMs,
        _fieldsModified: { ...(bank._fieldsModified ?? {}), pageIndex: nowMs },
      });
    }
    await tx.done;
  }
  ```

  Add `compareBankOrder` to the import from `./bankOrder`.

- [ ] **Step 4: Run the test and see it pass.** Run `npx vitest run src/lib/db.reorderBanks.test.ts`. All eight cases must pass.

- [ ] **Step 5: Turn the store test back on.** In `src/store/profileStore.test.ts`, change the `it.todo` from Task 12 back to `it`. Run `npx vitest run src/store/profileStore.test.ts` and see it pass.

- [ ] **Step 6: Commit.**

  ```bash
  npx prettier --write src/lib/db.ts src/lib/db.reorderBanks.test.ts src/store/profileStore.test.ts
  git add src/lib/db.ts src/lib/db.reorderBanks.test.ts src/store/profileStore.test.ts
  git commit -m "feat(banks): add reorderBanks"
  ```

---

## Task 16: Drag the tabs in edit mode

**Files:**

- Change `src/components/BankTabStrip.tsx`
- Change `src/app/page.tsx` (wire `onReorder`)

**Interfaces:**

- Consumes: `DragDropContext`, `Droppable`, `Draggable`, `OnDragEndResponder` from `@hello-pangea/dnd`; `reorderBanks` from `@/lib/db`.
- Produces: `onReorder(orderedBankIds: string[]): void` fires on drop.

Copy the shape from `src/components/modals/EditPadForm.tsx:304-374`, which already uses these primitives. The one difference is `direction="horizontal"` on the `Droppable`.

Two guards matter:

- Edit mode turns on while the user holds Shift. A Shift release in the middle of a drag unmounts the list. Hold a local `isDragging` flag. Keep the drag wrapper mounted while that flag is true.
- The drop handler runs the trio `handleBankClick` already runs: `reorderBanks`, then `incrementPadConfigsVersion()`, then `requestSync()`.

Steps:

- [ ] **Step 1: Add the drag wrapper.** In `BankTabStrip.tsx`, wrap the tab list:

  ```tsx
  const [isDragging, setIsDragging] = useState(false);
  // Edit mode turns on while Shift is held. A release in the middle of a
  // drag would unmount the list under the pointer, so stay mounted until
  // the drop lands.
  const canDrag = isEditMode || isDragging;

  const onDragEnd: OnDragEndResponder = (result) => {
    setIsDragging(false);
    if (!result.destination) return;
    const ids = banks.map((bank) => bank.bankId);
    const [moved] = ids.splice(result.source.index, 1);
    ids.splice(result.destination.index, 0, moved);
    onReorder(ids);
  };
  ```

  Render `<DragDropContext onDragStart={() => setIsDragging(true)} onDragEnd={onDragEnd}>` around a `<Droppable droppableId="bankTabs" direction="horizontal">`, and each tab inside a `<Draggable key={bank.bankId} draggableId={bank.bankId} index={position} isDragDisabled={!canDrag}>`. Spread `provided.draggableProps` and `provided.dragHandleProps` onto the tab button, and keep `{provided.placeholder}` after the list.

- [ ] **Step 2: Wire the handler.** In `src/app/page.tsx`, pass:

  ```tsx
    onReorder={async (orderedBankIds) => {
      if (activeProfileId === null) return;
      try {
        await reorderBanks(activeProfileId, orderedBankIds);
        await loadBanks(activeProfileId);
        incrementPadConfigsVersion();
        requestSync(activeProfileId);
      } catch (error) {
        console.error("Failed to reorder the banks:", error);
        alert("Failed to reorder the banks. Please try again.");
      }
    }}
  ```

  `loadBanks` keeps `currentBankId`, so the view follows the bank the user dragged rather than the slot number.

- [ ] **Step 3: Check the types and the lint.** Run `npx tsc --noEmit` and `npm run lint`. Both must be clean.

- [ ] **Step 4: Drag it in the browser and watch it.** Ask the user to start `npm run dev` if no server runs. Open `http://localhost:3000`. Click "Toggle edit mode" so edit mode latches without Shift. Drag bank 3 onto bank 1. Confirm three things with your own eyes:
  1. the tab strip shows the dragged bank first, and its number is now 1;
  2. the pad grid still shows that bank's pads;
  3. key 1 now selects it, and its old key selects the bank that took its place.

  Then reload the page and confirm the order survives.

- [ ] **Step 5: Test the keyboard drag.** With edit mode latched, press Tab until a bank tab has focus. Press Space, ArrowRight, Space. Confirm the tab moved one place to the right.

- [ ] **Step 6: Run the whole suite.** Run `npm test` and `npm run test:e2e`. Both must be green.

- [ ] **Step 7: Commit.**

  ```bash
  npx prettier --write src/components/BankTabStrip.tsx src/app/page.tsx
  git add src/components/BankTabStrip.tsx src/app/page.tsx
  git commit -m "feat(banks): drag the bank tabs to reorder them in edit mode"
  ```

---

## Task 17: The end-to-end test

**Files:**

- Create `e2e-tests/bank-reorder.spec.ts`

**Interfaces:**

- Consumes: `gotoApp`, `createTestAudioFilePath`, `prepareAudioContext` from `./test-helpers`.
- Produces: no export.

The test drives the keyboard sensor, not the mouse. A mouse drag against a virtual list is the flakiest thing this suite can do, and the library gives the keyboard path for free.

Steps:

- [ ] **Step 1: Write the spec.** Create `e2e-tests/bank-reorder.spec.ts`:

  ```ts
  import { test, expect } from "@playwright/test";
  import { gotoApp } from "./test-helpers";

  test.describe("Bank reorder", () => {
    test.beforeEach(async ({ page }) => {
      await gotoApp(page);
    });

    test("a dragged tab keeps its name at its new position", async ({
      page,
    }) => {
      // Latch edit mode with the button, so no key has to stay down during
      // the drag.
      await page.getByRole("button", { name: "Toggle edit mode" }).click();
      await expect(page.getByText("EDIT MODE", { exact: true })).toBeVisible();

      const tabs = page.locator('[role="tab"]');
      await expect(tabs.first()).toBeVisible();
      const secondTabText = (await tabs.nth(1).innerText()).trim();
      const secondName = secondTabText.split(":")[1].trim();

      // Lift, move right, drop.
      await tabs.nth(1).focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Space");

      await expect(tabs.nth(2)).toContainText(secondName);
      // The view follows the bank you dragged, not the slot number.
      await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    });

    test("the hotkey selects the new occupant of the position", async ({
      page,
    }) => {
      await page.getByRole("button", { name: "Toggle edit mode" }).click();
      await expect(page.getByText("EDIT MODE", { exact: true })).toBeVisible();

      const tabs = page.locator('[role="tab"]');
      await expect(tabs.first()).toBeVisible();
      const firstName = (await tabs.first().innerText())
        .trim()
        .split(":")[1]
        .trim();

      await tabs.first().focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Space");

      // Leave edit mode, then press the hotkey for position 1.
      await page.getByRole("button", { name: "Toggle edit mode" }).click();
      await expect(page.getByText("EDIT MODE", { exact: true })).toBeHidden();
      await page.keyboard.press("1");

      // Position 1 now holds the other bank, so the moved one is not selected.
      await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
      await expect(tabs.first()).not.toContainText(firstName);
    });

    test("the new order survives a reload", async ({ page }) => {
      await page.getByRole("button", { name: "Toggle edit mode" }).click();
      const tabs = page.locator('[role="tab"]');
      await expect(tabs.first()).toBeVisible();
      const secondName = (await tabs.nth(1).innerText())
        .trim()
        .split(":")[1]
        .trim();

      await tabs.nth(1).focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Space");

      await page.reload();
      await expect(page.locator('[role="tab"]').first()).toContainText(
        secondName,
      );
    });
  });
  ```

- [ ] **Step 2: Run it and see it pass.** Run `npx playwright test bank-reorder.spec.ts --project=chromium`. All three tests must pass. If the keyboard lift does nothing, check that the tab button carries `provided.dragHandleProps` and therefore `tabIndex={0}` and `data-rfd-drag-handle-draggable-id`.

- [ ] **Step 3: Run the whole end-to-end suite.** Run `npm run test:e2e`. Every chromium test must pass. Do not run Firefox or WebKit; read `docs/cross-browser-e2e.md` before you act on either.

- [ ] **Step 4: Commit.**

  ```bash
  npx prettier --write e2e-tests/bank-reorder.spec.ts
  git add e2e-tests/bank-reorder.spec.ts
  git commit -m "test(e2e): cover the bank reorder"
  ```

---

## Task 18: Coverage and the full gate

**Files:**

- Change `vitest.config.ts` only if the numbers rise well above the floor.

Steps:

- [ ] **Step 1: Run the whole gate.** Run, in order:

  ```bash
  npm run lint
  npx tsc --noEmit
  npm test
  npm run test:coverage
  npm run test:e2e
  ```

  All five must pass.

- [ ] **Step 2: Read the coverage summary.** Note the four numbers. The floor is a ratchet. Raise it only when the run comes in well above the current values of 33 / 28 / 27 / 33. Never lower it.

- [ ] **Step 3: Commit any ratchet change.**

  ```bash
  git add vitest.config.ts
  git commit -m "chore(test): raise the coverage floor to the new run"
  ```

  Skip this step when the numbers did not rise.

---

## Task 19: Documentation in the same branch

**Files:**

- Change `CLAUDE.md` (the "Database Layer", "Key Features Implementation" and "Important Implementation Notes" sections)
- Change `docs/server-sync.md`

Steps:

- [ ] **Step 1: Update `CLAUDE.md`.** In "Database Layer", change the `pageMetadata` line. It must say that a bank's identity is `bankId` and its position is `pageIndex`. It must also say that `padConfigurations` names its bank by `bankId`. Then add a note under "Important Implementation Notes":

  ```markdown
  - A bank's identity is `bankId` and its position is `pageIndex`. Every
    database key, sync key, playback key and loading key uses `bankId`;
    only the tab order and the keyboard shortcut use `pageIndex`. A bank
    migrated from DB v6 has `bankId = String(pageIndex)`, and so do the ten
    default banks, because two devices must reach the same id on their own.
    A bank created after that gets `crypto.randomUUID()`. The order is
    normalised on read by `src/lib/bankOrder.ts`: sort by
    `(pageIndex, bankId)` and renumber densely from 0
  ```

- [ ] **Step 2: Update `docs/server-sync.md`.** Add one short section. It records that identity is `bankId`, that position is `pageIndex`, and that the merge keys on identity.

- [ ] **Step 3: Check the format.** Run `npx prettier --check CLAUDE.md docs/server-sync.md`.

- [ ] **Step 4: Commit.**

  ```bash
  git add CLAUDE.md docs/server-sync.md
  git commit -m "docs: record bank identity and position"
  ```

---

## Before the merge

- [ ] **A person must read Task 2 and Task 3 before the branch merges.** The migration rewrites every pad row and every bank row on every device. No server step can correct a mistake. Show the reviewer these three things:

  - The migration module.
  - The seven migration tests.
  - The proof from Task 3, Step 3 that a test guards the order of the three passes.

- [ ] Confirm the five commands in Task 18 are green on the final branch head.
- [ ] Confirm the app runs from `npm run dev`. Confirm a reorder survives a reload. Confirm a hotkey selects the bank that the tab strip shows.
- [ ] Then merge to `main` with the `superpowers:finishing-a-development-branch` skill.
