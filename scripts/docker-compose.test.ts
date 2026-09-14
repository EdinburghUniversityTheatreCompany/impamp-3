import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What `docker compose up app` hands the production image and container.
 *
 * Portainer deploys this compose file exactly as it stands, so anything it
 * leaves out is simply not configured there. Moving the app from Kamal onto
 * Portainer on 2026-09-14 found two such gaps. The Drive Picker's API key and
 * app id never reached `next build`, because compose passed only the client id.
 * And no runtime variable beyond `IMPAMP_DB_PATH` reached the container, so
 * Google sign-in, server-hosted audio and the sign-up allowlist were all off.
 * Nothing failed: the image built, `/up` answered 200, and the features were
 * just not there. `config/deploy.yml` had all of it, which is why Kamal worked.
 *
 * Lives under `scripts/` only because that and `src/` are the two roots
 * `vitest.config.ts` collects tests from.
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

const indentOf = (line: string) => line.length - line.trimStart().length;
const isContent = (line: string) =>
  line.trim() !== "" && !line.trim().startsWith("#");

/**
 * The content lines nested under a key path, found by indentation.
 *
 * Deliberately not a YAML parser: the repo has none as a direct dependency,
 * and these assertions only need "which keys sit under this one", which
 * indentation answers for the block style this file is written in.
 *
 * @returns The nested lines with comments and blanks dropped, or `[]` when any
 *   key on the path is missing
 */
function linesUnder(text: string, keys: string[]): string[] {
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  let parentIndent = -1;

  for (const key of keys) {
    const pattern = new RegExp(`^\\s*${key}:\\s*(#.*)?$`);
    let at = -1;
    for (let i = start; i < end; i++) {
      if (pattern.test(lines[i]) && indentOf(lines[i]) > parentIndent) {
        at = i;
        break;
      }
    }
    if (at === -1) return [];

    parentIndent = indentOf(lines[at]);
    start = at + 1;
    let stop = start;
    while (
      stop < end &&
      (!isContent(lines[stop]) || indentOf(lines[stop]) > parentIndent)
    ) {
      stop++;
    }
    end = stop;
  }

  return lines.slice(start, end).filter(isContent);
}

/** The keys of a block mapping: its shallowest `name:` lines. */
function mappingKeys(lines: string[]): string[] {
  if (lines.length === 0) return [];
  const shallowest = Math.min(...lines.map(indentOf));
  return lines
    .filter((line) => indentOf(line) === shallowest)
    .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*):/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined)
    .sort();
}

describe("docker-compose.yml's app service", () => {
  const compose = read("docker-compose.yml");

  it("passes every NEXT_PUBLIC_* build arg the Dockerfile declares", () => {
    // Next inlines these into the client bundle at build time, so a value that
    // only reaches the running container does nothing at all.
    const declared = [
      ...read("Dockerfile").matchAll(/^ARG\s+(NEXT_PUBLIC_[A-Z0-9_]+)/gm),
    ]
      .map((match) => match[1])
      .sort();
    // A pattern that matched nothing would make the next assertion vacuous.
    expect(declared.length).toBeGreaterThan(0);

    const passed = mappingKeys(
      linesUnder(compose, ["services", "app", "build", "args"]),
    );
    expect(passed).toEqual(expect.arrayContaining(declared));
  });

  it("hands the Portainer stack's environment to the container", () => {
    // Portainer writes a stack's variables to `stack.env` beside this file.
    // Interpolation alone only fills `${...}` placeholders; `env_file` is what
    // puts them in the container, and only the ones actually set, so an unset
    // variable stays unset rather than arriving as an empty string.
    // `required: false` keeps a plain local `docker compose up app` working.
    const envFile = linesUnder(compose, ["services", "app", "env_file"]).map(
      (line) => line.trim(),
    );
    expect(envFile).toContain("- path: stack.env");
    expect(envFile).toContain("required: false");
  });
});

describe("stack.env", () => {
  // It holds the deployment's secrets and sits in the build context, where the
  // builder stage's `COPY . .` would bake it into an image layer.
  const listed = (file: string) =>
    read(file)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line === "stack.env" || line === "/stack.env");

  it("is kept out of the Docker build context", () => {
    expect(listed(".dockerignore")).not.toHaveLength(0);
  });

  it("is never committed", () => {
    expect(listed(".gitignore")).not.toHaveLength(0);
  });
});
