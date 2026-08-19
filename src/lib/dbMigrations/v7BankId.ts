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
    // Both the pre-migration and post-migration index names, so the
    // `contains`/`createIndex` calls below — which genuinely see either,
    // depending on how far the upgrade has run — typecheck against the
    // live indexNames they inspect.
    indexes: {
      profileId: number;
      profileBankPad: [number, string, number];
      profilePagePad: [number, number, number];
    };
  };
  pageMetadata: {
    key: number;
    value: V7Page;
    indexes: {
      profileId: number;
      profileBank: [number, string];
      profilePage: [number, number];
    };
  };
}

/** The transaction shape this migration needs. */
export type V7Transaction = IDBPTransaction<
  V7Schema,
  ("padConfigurations" | "pageMetadata")[],
  "versionchange"
>;

/** The identity a migrated bank takes. Deterministic across devices. */
export const migratedBankId = (pageIndex: number): string => String(pageIndex);

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
