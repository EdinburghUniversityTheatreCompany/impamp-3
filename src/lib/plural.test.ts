import { describe, expect, it } from "vitest";
import { count } from "./plural";
import { sourceFilesMatching } from "@/lib/testSupport/sourceScan";

describe("count", () => {
  it("uses the singular for exactly one", () => {
    expect(count(1, "bank", "banks")).toBe("1 bank");
  });

  it("uses the plural for everything else, zero included", () => {
    expect(count(0, "bank", "banks")).toBe("0 banks");
    expect(count(2, "bank", "banks")).toBe("2 banks");
  });

  it("reads correctly when the rendered number is not the counted one", () => {
    // `describeAudioImportFailures` renders "2 of 5 sounds": the number in
    // front is the failure count and the noun agrees with the total, which is
    // not a shape `count` can express on its own — the caller writes the "N of"
    // and hands `count` the total.
    expect(`3 of ${count(5, "sound", "sounds")}`).toBe("3 of 5 sounds");
    expect(`1 of ${count(1, "sound", "sounds")}`).toBe("1 of 1 sound");
  });
});

/**
 * The rule no assertion can hold: nobody writes the plural ternary inline.
 *
 * Every "N of a thing" in the app goes through `count`, and the value of that
 * is that the two cannot drift into saying "1 banks". A *new* inline ternary in
 * a file this suite does not import is invisible to every other kind of test,
 * so the test has to go and look at the source.
 *
 * The skip list is deliberately empty. This guard was worth adding only once
 * the last two offenders were gone — while they remained, the exceptions would
 * have been longer than the rule.
 *
 * Verb agreement is *not* this pattern and is not caught here:
 * `BankImportPlacementDialog`'s `was`/`were` picks a verb rather than a noun,
 * and the noun beside it already goes through `count`.
 */
describe("plurals are not written inline", () => {
  it('has no `? "" : "s"` ternary anywhere in src/', () => {
    const offenders = sourceFilesMatching(
      /\?\s*""\s*:\s*"s"|\?\s*"s"\s*:\s*""/,
    );

    expect(offenders).toEqual([]);
  });
});
