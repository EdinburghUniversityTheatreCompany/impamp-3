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
