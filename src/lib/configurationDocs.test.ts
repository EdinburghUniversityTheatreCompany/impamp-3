import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFilesMatching } from "./testSupport/sourceScan";

/**
 * Every environment variable the app reads is documented in one place.
 *
 * `config/deploy.yml` used to be that place, as a side effect of being the
 * Kamal deployment: each variable sat next to a comment saying what it did.
 * The app moved to a Portainer stack on 2026-09-14 and the Kamal files went,
 * so the list lives in `docs/configuration.md` now. A list nothing checks goes
 * stale the day someone adds a variable, and an undocumented variable on a
 * Portainer stack is one nobody sets.
 */

const SRC_ROOT = path.join(import.meta.dirname, "..");
const REPO_ROOT = path.join(SRC_ROOT, "..");

/** Set by Node and Next themselves, never by whoever deploys the app. */
const RUNTIME_PROVIDED = new Set(["NODE_ENV"]);

function variablesReadIn(text: string): string[] {
  const direct = [...text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)];
  // `s3/config.ts` reads its limits through `readNumber("NAME", fallback)`,
  // and the name is often on the line after the call.
  const viaReadNumber = [
    ...text.matchAll(/readNumber\(\s*"([A-Z][A-Z0-9_]*)"/g),
  ];
  return [...direct, ...viaReadNumber].map((match) => match[1]);
}

function variablesTheAppReads(): string[] {
  const files = sourceFilesMatching(/process\.env|readNumber\(/).map((file) =>
    path.join(SRC_ROOT, file),
  );
  files.push(path.join(REPO_ROOT, "next.config.ts"));

  const names = new Set(
    files.flatMap((file) => variablesReadIn(fs.readFileSync(file, "utf8"))),
  );
  return [...names].filter((name) => !RUNTIME_PROVIDED.has(name)).sort();
}

describe("docs/configuration.md", () => {
  const docs = fs.readFileSync(
    path.join(REPO_ROOT, "docs", "configuration.md"),
    "utf8",
  );

  it("finds the variables it is checking", () => {
    // A scan that matched nothing would pass the next test vacuously.
    expect(variablesTheAppReads()).toEqual(
      expect.arrayContaining([
        "GOOGLE_CLIENT_SECRET",
        "IMPAMP_AUDIO_MAX_OBJECT_BYTES",
        "NEXT_PUBLIC_GOOGLE_CLIENT_ID",
      ]),
    );
  });

  it("documents every environment variable the app reads", () => {
    const undocumented = variablesTheAppReads().filter(
      (name) => !docs.includes(`\`${name}\``),
    );
    expect(undocumented).toEqual([]);
  });
});
