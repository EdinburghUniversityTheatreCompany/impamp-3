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
export function positionOfBank(pages: PageMetadata[], bankId: string): number {
  return normaliseBankOrder(pages).findIndex((page) => page.bankId === bankId);
}
