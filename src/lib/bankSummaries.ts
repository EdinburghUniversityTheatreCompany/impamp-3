/**
 * A profile's banks as a list a person can pick from.
 *
 * Two surfaces ask the same question of a profile — the export panel ("which
 * of these do you want to send?") and the import placement dialog ("which of
 * these should this one replace?") — and the answer has to be the same list,
 * numbered the same way, in both. That is why this is a module rather than a
 * helper inside either component:
 *
 *  - **Board order, not stored order.** `normaliseBankOrder` is what the tab
 *    strip and the digit keys use, so "3:" here is "3:" on the board even
 *    after a reorder and even when a merge has left two banks on one
 *    `pageIndex`. Sorting by the raw `pageIndex` agrees on every profile
 *    except the ones somebody has arranged by hand — which are exactly the
 *    profiles these two features exist for.
 *  - **Nothing is keyed on a name.** Bank names are user-supplied and are not
 *    unique; two banks called "SFX" is ordinary. Every identity here is a
 *    `bankId`, which the `profileBank` index makes unique inside a profile,
 *    and the position prefix is the only thing keeping the two labels apart
 *    on screen.
 */

import { normaliseBankOrder } from "./bankOrder";
import { count } from "./plural";
import type { PadConfiguration, PageMetadata } from "./db";

/** One row of a bank list: a bank, where it sits, and what it holds. */
export interface BankListOption {
  bankId: string;
  /** The stored name, verbatim — it is what goes into an archive. */
  name: string;
  /** Display position, 0-based. The number shown is this plus one. */
  position: number;
  isEmergency: boolean;
  /** Pads that name at least one sound. A cleared pad keeps its row. */
  padCount: number;
  /** Distinct audio rows, which is what an archive actually carries. */
  soundCount: number;
}

/** What a bank with no name is called in a list. */
export const UNNAMED_BANK = "Unnamed bank";

/**
 * Turns a profile's banks and pads into the rows a list shows.
 *
 * Pure, and exported for its own tests: everything that can go wrong here is
 * invisible on a profile whose banks were never rearranged, because a default
 * or migrated bank has `bankId === String(pageIndex)` and position-keyed code
 * then gives the same answers as identity-keyed code.
 *
 * `collectReferencedAudioFileIds` is what the exporter itself uses to decide
 * which sounds a bank carries, so the count here cannot promise a different
 * archive from the one that gets written — a pad naming one sound twice, or
 * two pads sharing a sound, is one sound in both. (It can over-count by a row
 * a pad names but the library no longer holds; the exporter skips those, and
 * checking would mean reading every audio row to draw a list.)
 *
 * @param pages The profile's banks, in any order
 * @param pads Every pad row of that profile, from every bank
 */
function summariseBanks(
  pages: PageMetadata[],
  pads: PadConfiguration[],
  collectReferencedAudioFileIds: (pads: PadConfiguration[]) => Set<number>,
): BankListOption[] {
  const padsByBank = new Map<string, PadConfiguration[]>();
  for (const pad of pads) {
    const existing = padsByBank.get(pad.bankId);
    if (existing) existing.push(pad);
    else padsByBank.set(pad.bankId, [pad]);
  }

  return normaliseBankOrder(pages).map((page, position) => {
    const bankPads = padsByBank.get(page.bankId) ?? [];
    return {
      bankId: page.bankId,
      name: page.name,
      position,
      isEmergency: page.isEmergency,
      padCount: bankPads.filter((pad) => pad.audioFileIds.length > 0).length,
      soundCount: collectReferencedAudioFileIds(bankPads).size,
    };
  });
}

/** What a bank holds, as a phrase: "Empty", or "2 pads, 3 sounds". */
export function bankContents(option: {
  padCount: number;
  soundCount: number;
}): string {
  return option.soundCount === 0
    ? "Empty"
    : `${count(option.padCount, "pad", "pads")}, ${count(
        option.soundCount,
        "sound",
        "sounds",
      )}`;
}

/** What a bank holds, and whether it is the emergency bank. */
export function describeBank(option: BankListOption): string {
  const contents = bankContents(option);
  return option.isEmergency ? `${contents} · Emergency bank` : contents;
}

/** A bank's name as it can be shown, with a stand-in for the unnamed one. */
export function bankDisplayName(option: { name: string }): string {
  return option.name.trim() ? option.name : UNNAMED_BANK;
}

/**
 * A bank as one line of plain text: "3: SFX".
 *
 * The number is what tells two banks of the same name apart, so anything that
 * names a bank to a user — an option in a dropdown, a sentence about what is
 * about to be deleted — has to carry it.
 */
export function bankLabel(option: BankListOption): string {
  return `${option.position + 1}: ${bankDisplayName(option)}`;
}

/**
 * Reads one profile's banks and turns them into rows.
 *
 * The database import is dynamic so a panel that is only rendered inside the
 * profile manager does not pull `db.ts` into the page's first load.
 */
export async function loadBankOptions(
  profileId: number,
): Promise<BankListOption[]> {
  const {
    collectReferencedAudioFileIds,
    getAllPageMetadataForProfile,
    getPadConfigurationsForProfile,
  } = await import("@/lib/db");
  const [pages, pads] = await Promise.all([
    getAllPageMetadataForProfile(profileId),
    getPadConfigurationsForProfile(profileId),
  ]);
  return summariseBanks(pages, pads, collectReferencedAudioFileIds);
}
