/**
 * `escapeDriveQueryValue` had four call sites and no test.
 *
 * It is the only thing standing between a user-chosen file or bank name and a
 * Drive query string, which is built by interpolation into single quotes. The
 * blast radius is small — the query runs against the caller's own appData
 * scope with their own token, so a malformed name breaks their own request
 * rather than crossing a trust boundary — but "small" is not "none", and the
 * escaping order is the kind of detail a later tidy-up silently reverses.
 */

import { describe, expect, it } from "vitest";
import { escapeDriveQueryValue } from "./api";

describe("escapeDriveQueryValue", () => {
  it("escapes an apostrophe, which would otherwise close the literal", () => {
    // `name='Mick's cue'` is a syntax error Drive answers with a 400; it is
    // also the shape that lets a name append clauses to the query.
    expect(escapeDriveQueryValue("Mick's cue")).toBe("Mick\\'s cue");
  });

  it("escapes a backslash", () => {
    expect(escapeDriveQueryValue("back\\slash")).toBe("back\\\\slash");
  });

  it("escapes the backslash before the apostrophe, not after", () => {
    // The whole correctness of this function is the order. Escaping quotes
    // first and backslashes second would turn `\'` into `\\\'` — the backslash
    // escaping its own escape, leaving the quote live and the literal open.
    // This input is the one that tells the two orders apart.
    expect(escapeDriveQueryValue("a\\'b")).toBe("a\\\\\\'b");
  });

  it("leaves an ordinary name untouched", () => {
    expect(escapeDriveQueryValue("Act 1 - Thunder.wav")).toBe(
      "Act 1 - Thunder.wav",
    );
  });

  it("handles every occurrence, not just the first", () => {
    expect(escapeDriveQueryValue("'a'b'")).toBe("\\'a\\'b\\'");
  });

  it("copes with an empty name", () => {
    expect(escapeDriveQueryValue("")).toBe("");
  });
});
