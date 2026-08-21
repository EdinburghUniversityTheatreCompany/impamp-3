import { describe, it, expect, vi, afterEach } from "vitest";
import type { execSync as ExecSync } from "node:child_process";
import { resolveCommitHash, buildInfo } from "./generate-build-info.js";

/**
 * The commit hash the deployed app reports.
 *
 * This is worth a test because the failure is silent and was live for months:
 * `.dockerignore` excludes `.git`, so `git rev-parse` inside the image throws,
 * the catch below returns "nogit", and the Help modal cheerfully reports
 * "0.42.0-nogit" on every deployed build. Nothing goes red — the file is
 * written, the app boots, the service worker still busts its cache off
 * buildDate. The only symptom is that nobody can tell which commit is running.
 */

/** execSync is overloaded (Buffer or string by options); the fake only has to answer .toString(). */
const fakeGit = (stdout: string) =>
  vi.fn(() => stdout) as unknown as typeof ExecSync;

const throwingGit = () =>
  vi.fn(() => {
    throw new Error("not a git repository");
  }) as unknown as typeof ExecSync;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveCommitHash", () => {
  it("shortens a full 40-character SHA", () => {
    // Kamal's version and GitHub's github.sha are both full hashes, and the
    // Help modal renders this next to a version number.
    const git = fakeGit("ffffff0\n");
    expect(
      resolveCommitHash(
        { GIT_SHA: "eac76f9f26d15be3ee52b0ec652af4dc2de14654" },
        git,
      ),
    ).toBe("eac76f9");
    expect(git).not.toHaveBeenCalled();
  });

  it("leaves an already-short hash alone", () => {
    expect(
      resolveCommitHash({ GIT_SHA: "eac76f9" }, fakeGit("ffffff0\n")),
    ).toBe("eac76f9");
  });

  it("passes a non-hash description through untouched", () => {
    // A `git describe` output or a dirty marker identifies the build too, and
    // truncating either to seven characters would destroy that.
    expect(
      resolveCommitHash({ GIT_SHA: "eac76f9-dirty" }, fakeGit("ffffff0\n")),
    ).toBe("eac76f9-dirty");
  });

  it("falls back to git when GIT_SHA is unset", () => {
    const git = fakeGit("abc1234\n");
    expect(resolveCommitHash({}, git)).toBe("abc1234");
    expect(git).toHaveBeenCalledWith("git rev-parse --short HEAD");
  });

  it("falls back to git when GIT_SHA is set but blank", () => {
    // An unset build arg arrives as an empty string rather than as absent,
    // which would otherwise make the reported hash the empty string.
    expect(resolveCommitHash({ GIT_SHA: "   " }, fakeGit("abc1234\n"))).toBe(
      "abc1234",
    );
  });

  it("reports nogit only when there is no GIT_SHA and no git", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveCommitHash({}, throwingGit())).toBe("nogit");
  });

  it("does not report nogit inside an image built with the arg", () => {
    // The regression this whole change exists for: no .git in the container,
    // GIT_SHA supplied by config/deploy.yml.
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      resolveCommitHash(
        { GIT_SHA: "eac76f9f26d15be3ee52b0ec652af4dc2de14654" },
        throwingGit(),
      ),
    ).toBe("eac76f9");
  });
});

describe("buildInfo", () => {
  it("carries the version, the resolved hash and a timestamp", () => {
    const info = buildInfo({ GIT_SHA: "eac76f9" }, fakeGit("ffffff0\n"));
    expect(info.commitHash).toBe("eac76f9");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(Number.isNaN(Date.parse(info.buildDate))).toBe(false);
  });
});
