import { describe, expect, it } from "vitest";
import type { PadConfiguration } from "@/lib/db";
import {
  buildPadRows,
  buildSoundRows,
  filterProblemRows,
  sortRows,
  type SoundRow,
} from "./overview";
import { DEFAULT_NORMALISATION } from "./types";

function pad(overrides: Partial<PadConfiguration> = {}): PadConfiguration {
  return {
    profileId: 1,
    padIndex: 0,
    pageIndex: 0,
    audioFileIds: [10],
    playbackType: "round-robin",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const options = {
  normalisation: DEFAULT_NORMALISATION,
  getAnalysis: () => undefined,
  getSoundName: (id: number) => `sound-${id}`,
  getBankName: () => "Bank 1",
};

function row(overrides: Partial<SoundRow>): SoundRow {
  return {
    key: "0-0-10",
    pageIndex: 0,
    padIndex: 0,
    bankName: "Bank 1",
    padName: "Pad",
    audioFileId: 10,
    soundName: "sound-10",
    gain: {
      normDb: 0,
      totalDb: 0,
      linear: 1,
      measuredLufs: -16,
      finalLufs: -16,
      truePeakDb: -6,
      predictedPeakDb: -6,
      peakLimited: false,
      boostCapped: false,
      gainClamped: false,
      willClip: false,
      estimated: false,
      unmeasured: false,
    },
    soundGainDb: 0,
    padGainDb: 0,
    ...overrides,
  };
}

describe("buildSoundRows", () => {
  it("produces one row per pad-sound pair", () => {
    const rows = buildSoundRows([pad({ audioFileIds: [10, 11] })], options);
    expect(rows).toHaveLength(2);
    expect(rows[0].audioFileId).toBe(10);
    expect(rows[1].audioFileId).toBe(11);
  });

  it("skips pads with no sounds", () => {
    expect(buildSoundRows([pad({ audioFileIds: [] })], options)).toHaveLength(
      0,
    );
  });

  it("carries both manual gains onto the row", () => {
    const rows = buildSoundRows(
      [pad({ audioGainSettings: { 10: 4 }, padGainDb: -2 })],
      options,
    );
    expect(rows[0].soundGainDb).toBe(4);
    expect(rows[0].padGainDb).toBe(-2);
  });
});

describe("sortRows", () => {
  it("sorts by deviation from target descending by default", () => {
    const rows = [
      row({ key: "a", gain: { ...row({}).gain, finalLufs: -16 } }),
      row({ key: "b", gain: { ...row({}).gain, finalLufs: -25 } }),
    ];
    const sorted = sortRows(rows, "deviation", "desc", -16);
    expect(sorted[0].key).toBe("b");
  });

  it("reverses on ascending", () => {
    const rows = [
      row({ key: "a", gain: { ...row({}).gain, finalLufs: -16 } }),
      row({ key: "b", gain: { ...row({}).gain, finalLufs: -25 } }),
    ];
    expect(sortRows(rows, "deviation", "asc", -16)[0].key).toBe("a");
  });

  // Unmeasurable rows must not silently sort to the top and look like
  // the worst offenders.
  it("sorts null-loudness rows last regardless of direction", () => {
    const rows = [
      row({ key: "null", gain: { ...row({}).gain, finalLufs: null } }),
      row({ key: "real", gain: { ...row({}).gain, finalLufs: -25 } }),
    ];
    expect(sortRows(rows, "deviation", "desc", -16)[1].key).toBe("null");
    expect(sortRows(rows, "deviation", "asc", -16)[1].key).toBe("null");
  });

  it("sorts by sound name", () => {
    const rows = [
      row({ key: "b", soundName: "zebra" }),
      row({ key: "a", soundName: "apple" }),
    ];
    expect(sortRows(rows, "soundName", "asc", -16)[0].soundName).toBe("apple");
  });
});

describe("filterProblemRows", () => {
  it("keeps clipping rows", () => {
    const rows = [
      row({ key: "ok" }),
      row({ key: "clip", gain: { ...row({}).gain, willClip: true } }),
    ];
    expect(filterProblemRows(rows, -16).map((r) => r.key)).toEqual(["clip"]);
  });

  it("keeps peak-limited rows", () => {
    const rows = [
      row({ key: "ok" }),
      row({ key: "limited", gain: { ...row({}).gain, peakLimited: true } }),
    ];
    expect(filterProblemRows(rows, -16).map((r) => r.key)).toEqual(["limited"]);
  });

  it("keeps rows more than 3 dB off target", () => {
    const rows = [
      row({ key: "ok", gain: { ...row({}).gain, finalLufs: -17 } }),
      row({ key: "off", gain: { ...row({}).gain, finalLufs: -22 } }),
    ];
    expect(filterProblemRows(rows, -16).map((r) => r.key)).toEqual(["off"]);
  });

  it("keeps unmeasured rows out of the problem list", () => {
    const rows = [
      row({
        key: "pending",
        gain: { ...row({}).gain, unmeasured: true, finalLufs: null },
      }),
    ];
    expect(filterProblemRows(rows, -16)).toHaveLength(0);
  });
});

describe("buildPadRows", () => {
  it("aggregates the spread across a pad's sounds", () => {
    const rows = [
      row({
        key: "a",
        audioFileId: 10,
        gain: { ...row({}).gain, finalLufs: -20 },
      }),
      row({
        key: "b",
        audioFileId: 11,
        gain: { ...row({}).gain, finalLufs: -14 },
      }),
    ];
    const padRows = buildPadRows(rows);
    expect(padRows).toHaveLength(1);
    expect(padRows[0].minLufs).toBeCloseTo(-20, 1);
    expect(padRows[0].maxLufs).toBeCloseTo(-14, 1);
    expect(padRows[0].spreadDb).toBeCloseTo(6, 1);
    expect(padRows[0].soundCount).toBe(2);
  });

  it("reports a null spread when nothing is measurable", () => {
    const padRows = buildPadRows([
      row({ gain: { ...row({}).gain, finalLufs: null } }),
    ]);
    expect(padRows[0].spreadDb).toBeNull();
  });
});
