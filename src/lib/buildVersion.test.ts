import { describe, expect, it } from "vitest";
import { versionLabel } from "./buildVersion";

/**
 * The version line in the Help modal.
 *
 * The Portainer stack builds without `.git` and without a `GIT_SHA` build arg,
 * and Portainer has no variable holding the deployed commit, so every image it
 * builds reports its commit as "nogit". "0.42.0-nogit" is the same string for
 * every such build, which is exactly the question the line exists to answer:
 * which build is this? The build date is in the same file and does tell them
 * apart.
 */

describe("versionLabel", () => {
  it("pairs the version with the commit when the commit is known", () => {
    expect(
      versionLabel({
        version: "0.42.0",
        commitHash: "eac76f9",
        buildDate: "2026-09-14T12:45:02.266Z",
      }),
    ).toBe("0.42.0-eac76f9");
  });

  it("names the build by its date when there is no commit", () => {
    expect(
      versionLabel({
        version: "0.42.0",
        commitHash: "nogit",
        buildDate: "2026-09-14T12:45:02.266Z",
      }),
    ).toBe("0.42.0, built 2026-09-14 12:45 UTC");
  });

  it("keeps the old label rather than printing an invalid date", () => {
    expect(
      versionLabel({
        version: "0.42.0",
        commitHash: "nogit",
        buildDate: "not a date",
      }),
    ).toBe("0.42.0-nogit");
  });
});
