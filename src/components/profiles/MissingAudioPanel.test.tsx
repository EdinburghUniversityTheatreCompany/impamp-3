// @vitest-environment jsdom
/**
 * The Maintenance tab's missing-audio panel.
 *
 * A pad names its sounds by id and the ids outlive the rows, so a restored
 * library, a failed Drive download or an evicted origin all leave pads that
 * look assigned and play nothing. This panel is the only way back, and its
 * whole state — which rows are being replaced, which have been — is keyed on
 * a string it builds itself. That key is what the tests below are mostly
 * about:
 *
 *  - **One absent row is routinely named by several pads.** Two pads pointing
 *    at the same dead id is the ordinary case (a sound was on two pages), and
 *    keying on the id alone would mark both repaired the moment one file was
 *    supplied — the same collision `EditPadForm` mints its `rowId` for. So the
 *    fixture below has exactly that shape, and one test repairs one of the two
 *    and watches the other stay broken.
 *  - **A repair that failed must not read as a repair.** `replaceMissingAudioFile`
 *    throws when the pad is no longer there, and the panel's `catch` is silent
 *    apart from a console line, so "Replaced" appearing on a row that was not
 *    is the failure mode with no other tell.
 *
 * The real `db.ts` runs against a real (fake-indexeddb) database: the point of
 * a repair is what ends up in the pad row, and a mocked writer would prove
 * only that a button is wired to something.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import * as React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";

// Every audio row written here fires a background analysis that reaches Web
// Audio, which jsdom does not have. See loudnessPipelineStub.ts.
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";

stubLoudnessPipeline();

const incrementPadConfigsVersion = vi.fn();
vi.doMock("@/store/profileStore", () => ({
  useProfileStore: { getState: () => ({ incrementPadConfigsVersion }) },
}));

// The real implementation behind a spy, so a scan can be made to fail.
// `importActual` resolves the module's own imports normally, so this is one
// connection and one memoised `getDb` — the same database the fixtures below
// write through.
const realDb = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
const findMissingAudioFiles = vi.fn(realDb.findMissingAudioFiles);
vi.doMock("@/lib/db", () => ({ ...realDb, findMissingAudioFiles }));

const MissingAudioPanel = (
  await import("@/components/profiles/MissingAudioPanel")
).default;
const {
  addAudioFile,
  addProfile,
  getDb,
  upsertPadConfiguration,
  upsertPageMetadata,
} = realDb;

/**
 * A bank id that is a minted UUID at a position that is not its index.
 *
 * A bank from `ensureDefaultBanks` has `bankId === String(pageIndex)`, so
 * identity-keyed and position-keyed code behave identically on one — and the
 * bank name on each row here is looked up by identity.
 */
const OPENERS = "b4d1a5c0-1111-4a2b-8c3d-000000000001";

/**
 * A bank the user never renamed, exactly as `ensureDefaultBanks` writes one.
 *
 * Its id is the position it sits at and its stored name is
 * `Bank ${convertIndexToBankNumber(pageIndex)}` — so the name a row shows
 * already carries the word "Bank", and a row that adds its own reads
 * "Bank Bank 6".
 */
const UNRENAMED = { bankId: "5", pageIndex: 5, name: "Bank 6" };

/** An id no `audioFiles` row will ever be given, so every pad naming it is broken. */
const GONE = 987_654;
const ALSO_GONE = 987_655;

let panel: MountedPanel;
let profileId: number;

const testId = (id: string) => panel.testId(id);
const required = (id: string) => panel.required(id);
const click = (id: string) => panel.click(id);

/**
 * The key the panel builds a row's identity from.
 *
 * The reference — profile, bank, pad, missing id — plus which occurrence of it
 * the row is, because a pad can name the same absent id twice and the panel
 * gives each line its own identity the way `EditPadForm` does. The state
 * underneath is still keyed on the reference alone, since one file repairs
 * every occurrence.
 */
function rowKey(
  pad: {
    profileId: number;
    bankId: string;
    padIndex: number;
    missingAudioFileId: number;
  },
  occurrence = 0,
): string {
  return `${pad.profileId}-${pad.bankId}-${pad.padIndex}-${pad.missingAudioFileId}-${occurrence}`;
}

/**
 * Supplies a file to one row's hidden input the way the file picker does.
 *
 * The value of a file input cannot be assigned, so the `files` list is defined
 * on the element and the native `change` React listens for is dispatched —
 * React reads `event.target.files` off the element itself.
 */
async function chooseReplacement(key: string, file: File): Promise<void> {
  const input = required(`missing-audio-replace-${key}`) as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await panel.settle();
}

/** A replacement file with bytes of its own. */
function replacementNamed(name: string): File {
  return new File([`the bytes of ${name}`], `${name}.wav`, {
    type: "audio/wav",
  });
}

async function padNaming(pad: {
  profileId: number;
  bankId: string;
  padIndex: number;
  audioFileIds: number[];
  name?: string;
}): Promise<void> {
  await upsertPadConfiguration({ ...pad, playbackType: "sequential" });
}

/** The pad row as the database holds it now. */
async function storedPad(
  owner: number,
  bankId: string,
  padIndex: number,
): Promise<{ audioFileIds: number[] } | undefined> {
  const db = await getDb();
  return db.getFromIndex("padConfigurations", "profileBankPad", [
    owner,
    bankId,
    padIndex,
  ]);
}

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
  findMissingAudioFiles.mockImplementation(realDb.findMissingAudioFiles);
  profileId = await addProfile({ name: "Show", syncType: "local" });
  await upsertPageMetadata({
    profileId,
    bankId: OPENERS,
    pageIndex: 3,
    name: "Openers",
  });
  panel = await mountPanel(<MissingAudioPanel />);
});

afterEach(async () => {
  await panel.unmount();
});

describe("scanning", () => {
  it("says so when every pad names a sound this browser still holds", async () => {
    const present = await addAudioFile({
      name: "cue.wav",
      type: "audio/wav",
      blob: new Blob(["cue bytes"], { type: "audio/wav" }),
    });
    await padNaming({
      profileId,
      bankId: OPENERS,
      padIndex: 0,
      audioFileIds: [present],
    });

    await click("missing-audio-scan");

    expect(required("missing-audio-result").textContent).toContain(
      "No missing audio files found",
    );
    expect(panel.all("missing-audio-row")).toHaveLength(0);
  });

  it("names the bank and the pad of every broken reference", async () => {
    await padNaming({
      profileId,
      bankId: OPENERS,
      padIndex: 0,
      audioFileIds: [GONE],
      name: "Walk-in music",
    });
    await padNaming({
      profileId,
      bankId: OPENERS,
      padIndex: 4,
      audioFileIds: [ALSO_GONE],
    });

    await click("missing-audio-scan");

    const result = required("missing-audio-result").textContent ?? "";
    expect(result).toContain("2 missing audio files found");
    expect(result).toContain("Show");
    // The bank is named by identity, not by position: this one sits at
    // pageIndex 3 under a UUID, so a lookup keyed on the position would find
    // some other bank or none.
    expect(result).toContain("Openers");
    expect(result).toContain('"Walk-in music"');
    // An unnamed pad falls back to its one-based position, not to the empty
    // string its record holds.
    expect(result).toContain("Pad 5");
    expect(panel.all("missing-audio-row")).toHaveLength(2);
  });

  it("says a default bank's name once, not 'Bank Bank 6'", async () => {
    // `findMissingAudioFiles` reports the bank's *stored* name, and a bank
    // nobody renamed is stored as "Bank 6". The row therefore has nothing to
    // prefix: a literal "Bank " in front of it reads "Bank Bank 6", while a
    // renamed bank ("Openers") reads correctly — so only the case every
    // profile ships ten of is wrong, which is why it survived review.
    await upsertPageMetadata({ profileId, ...UNRENAMED });
    await padNaming({
      profileId,
      bankId: UNRENAMED.bankId,
      padIndex: 0,
      audioFileIds: [GONE],
    });

    await click("missing-audio-scan");

    const row = panel.all("missing-audio-row")[0].textContent ?? "";
    expect(row).toContain("Bank 6 ›");
    expect(row).not.toContain("Bank Bank");
  });

  it("says the scan failed rather than going quiet", async () => {
    // A swallowed failure is indistinguishable from a clean library: the
    // spinner comes and goes and nothing appears, except that even the "no
    // missing audio files" line is absent. A user cannot tell those apart,
    // and one of them means their board is still broken.
    findMissingAudioFiles.mockRejectedValueOnce(new Error("store is shut"));

    await click("missing-audio-scan");

    const alert = required("missing-audio-scan-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("store is shut");
    expect(testId("missing-audio-result")).toBeNull();
    // And the button comes back, so a failed scan is retryable rather than a
    // dead panel.
    expect((required("missing-audio-scan") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("takes the failure back when the next scan works", async () => {
    findMissingAudioFiles.mockRejectedValueOnce(new Error("store is shut"));

    await click("missing-audio-scan");
    await click("missing-audio-scan");

    expect(testId("missing-audio-scan-error")).toBeNull();
    expect(required("missing-audio-result").textContent).toContain(
      "No missing audio files found",
    );
  });

  it("keeps two profiles' banks apart when both call a bank '0'", async () => {
    // Every profile migrated from the pre-`bankId` schema names its banks
    // "0", "1", "2"…, so a bank name looked up by id alone collides across
    // profiles and a user is told to repair a pad on a bank they cannot find.
    const other = await addProfile({ name: "Other Show", syncType: "local" });
    await upsertPageMetadata({
      profileId,
      bankId: "0",
      pageIndex: 0,
      name: "Ours",
    });
    await upsertPageMetadata({
      profileId: other,
      bankId: "0",
      pageIndex: 0,
      name: "Theirs",
    });
    await padNaming({
      profileId: other,
      bankId: "0",
      padIndex: 0,
      audioFileIds: [GONE],
    });

    await click("missing-audio-scan");

    const result = required("missing-audio-result").textContent ?? "";
    expect(result).toContain("Other Show");
    expect(result).toContain("Theirs");
    expect(result).not.toContain("Ours");
  });
});

describe("repairing", () => {
  const brokenPad = { bankId: OPENERS, padIndex: 0, missingAudioFileId: GONE };

  it("writes the new row into the pad and marks only that row replaced", async () => {
    await padNaming({
      profileId,
      bankId: OPENERS,
      padIndex: 0,
      audioFileIds: [GONE],
    });
    await padNaming({
      profileId,
      bankId: OPENERS,
      padIndex: 1,
      audioFileIds: [ALSO_GONE],
    });

    await click("missing-audio-scan");
    await chooseReplacement(
      rowKey({ profileId, ...brokenPad }),
      replacementNamed("found-again"),
    );

    const pad = await storedPad(profileId, OPENERS, 0);
    expect(pad?.audioFileIds).toHaveLength(1);
    expect(pad?.audioFileIds[0]).not.toBe(GONE);
    const db = await getDb();
    expect(await db.get("audioFiles", pad!.audioFileIds[0])).toBeDefined();

    // The other pad is untouched, and its row still offers the picker.
    expect((await storedPad(profileId, OPENERS, 1))?.audioFileIds).toEqual([
      ALSO_GONE,
    ]);
    const rows = panel.all("missing-audio-row");
    expect(rows[0].textContent).toContain("Replaced");
    expect(rows[1].textContent).toContain("Choose replacement…");
  });

  it("repairs one of two pads naming the same dead row", async () => {
    // The collision the row key exists for. Both pads name `GONE`, so keying
    // the "replaced" set on the id would tick both off from one file — and
    // the second pad would still be silent with nothing on screen saying so.
    await padNaming({
      profileId,
      bankId: OPENERS,
      padIndex: 0,
      audioFileIds: [GONE],
    });
    await padNaming({
      profileId,
      bankId: OPENERS,
      padIndex: 7,
      audioFileIds: [GONE],
    });

    await click("missing-audio-scan");
    expect(panel.all("missing-audio-row")).toHaveLength(2);
    await chooseReplacement(
      rowKey({ profileId, ...brokenPad }),
      replacementNamed("found-again"),
    );

    const rows = panel.all("missing-audio-row");
    expect(rows[0].textContent).toContain("Replaced");
    expect(rows[1].textContent).not.toContain("Replaced");
    expect((await storedPad(profileId, OPENERS, 7))?.audioFileIds).toEqual([
      GONE,
    ]);
    // And the still-broken row can be repaired in its turn, with its own file.
    expect(
      testId(
        `missing-audio-replace-${rowKey({ profileId, bankId: OPENERS, padIndex: 7, missingAudioFileId: GONE })}`,
      ),
    ).not.toBeNull();
  });

  it("gives a pad naming one dead id twice a row apiece", async () => {
    // A pad can hold the same audio id twice — adding the same bytes again
    // returns the row already there — so the scan reports the reference once
    // per occurrence and the two rows shared a React key and a `data-testid`.
    // `e2e-tests/missing-audio-duplicate-rows.spec.ts` is the half that checks
    // the panel stays *addressable*, which only a real browser can fail on;
    // this counts the ids the way `EditPadForm.dedup.test.tsx` does.
    await padNaming({
      profileId,
      bankId: OPENERS,
      padIndex: 0,
      audioFileIds: [GONE, GONE],
    });

    await click("missing-audio-scan");
    expect(panel.all("missing-audio-row")).toHaveLength(2);

    const ids = [
      ...panel.container.querySelectorAll<HTMLInputElement>(
        '[data-testid^="missing-audio-replace-"]',
      ),
    ].map((input) => input.getAttribute("data-testid"));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    // One file repairs both, because `replaceMissingAudioFile` swaps every
    // occurrence of the id in the pad — so the state stays on the reference
    // even though the rows have identities of their own. Marking one
    // "Replaced" and leaving the other offering a picker would be the same
    // lie pointing the other way.
    await chooseReplacement(
      rowKey({ profileId, ...brokenPad }),
      replacementNamed("found-again"),
    );

    const rows = panel.all("missing-audio-row");
    expect(rows[0].textContent).toContain("Replaced");
    expect(rows[1].textContent).toContain("Replaced");
    const pad = await storedPad(profileId, OPENERS, 0);
    expect(pad?.audioFileIds).toHaveLength(2);
    expect(pad?.audioFileIds).not.toContain(GONE);
    expect(pad!.audioFileIds[0]).toBe(pad!.audioFileIds[1]);
  });

  it("reuses a row this browser already holds rather than storing it twice", async () => {
    // Re-linking a sound the library still has under another pad is the
    // ordinary case for this panel, not the exception: the file comes off the
    // same disk it was imported from. A second row for the same bytes is how
    // a library grows a duplicate of everything a user repairs.
    const existing = await addAudioFile({
      name: "already-here.wav",
      type: "audio/wav",
      blob: new Blob(["the bytes of found-again"], { type: "audio/wav" }),
    });
    await padNaming({
      profileId,
      bankId: OPENERS,
      padIndex: 0,
      audioFileIds: [GONE],
    });
    const db = await getDb();
    const before = await db.count("audioFiles");

    await click("missing-audio-scan");
    await chooseReplacement(
      rowKey({ profileId, ...brokenPad }),
      replacementNamed("found-again"),
    );

    expect((await storedPad(profileId, OPENERS, 0))?.audioFileIds).toEqual([
      existing,
    ]);
    expect(await db.count("audioFiles")).toBe(before);
  });

  it("bumps the pad-configs version so the board drops the dead id", async () => {
    // The pad now names a different row, and every in-memory copy of it — the
    // grid, the keyboard listener's map — still holds the id that is not
    // there. `padConfigsVersion` is the single counter all of them re-read on,
    // so without this the sound is repaired and the pad stays silent until a
    // bank switch or a reload.
    await padNaming({
      profileId,
      bankId: OPENERS,
      padIndex: 0,
      audioFileIds: [GONE],
    });

    await click("missing-audio-scan");
    expect(incrementPadConfigsVersion).not.toHaveBeenCalled();

    await chooseReplacement(
      rowKey({ profileId, ...brokenPad }),
      replacementNamed("found-again"),
    );

    expect(incrementPadConfigsVersion).toHaveBeenCalledTimes(1);
  });

  it("does not claim a repair when the write failed", async () => {
    await padNaming({
      profileId,
      bankId: OPENERS,
      padIndex: 0,
      audioFileIds: [GONE],
    });

    await click("missing-audio-scan");
    // The pad goes between the scan and the file being chosen — another tab,
    // or a bank deleted from the board behind this modal. `replaceMissingAudioFile`
    // throws rather than writing a pad row back from a stale read.
    const db = await getDb();
    const stale = await db.getFromIndex("padConfigurations", "profileBankPad", [
      profileId,
      OPENERS,
      0,
    ]);
    await db.delete("padConfigurations", stale!.id!);

    await chooseReplacement(
      rowKey({ profileId, ...brokenPad }),
      replacementNamed("found-again"),
    );

    const rows = panel.all("missing-audio-row");
    expect(rows[0].textContent).not.toContain("Replaced");
    expect(rows[0].textContent).toContain("Choose replacement…");
    // The bump is unconditional: a throw can land after the pad transaction
    // committed, and an unnecessary one costs a re-read of the current bank.
    expect(incrementPadConfigsVersion).toHaveBeenCalledTimes(1);
  });
});
