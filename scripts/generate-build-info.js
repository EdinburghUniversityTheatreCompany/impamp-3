// scripts/generate-build-info.js
//
// Writes src/generated/build-info.json, which two modules import: the Help
// modal shows it as the app's version, and the service worker registration
// derives its cache-busting build id from it.
//
// The commit hash comes from GIT_SHA if it is set, and from `git` otherwise.
// The environment variable is not a convenience: the production image is built
// with `.git` excluded by .dockerignore, so `git rev-parse` inside it fails and
// every deployed build used to report its commit as "nogit" — the running app
// could not say which commit it was. config/deploy.yml and the CI image build
// both pass GIT_SHA now; "nogit" is left as the last resort so a build from a
// tarball still produces a valid file rather than failing.
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { createRequire } from "node:module"; // Use node: prefix for clarity
import { fileURLToPath, pathToFileURL } from "node:url"; // Import fileURLToPath

// Since package.json is JSON, we need createRequire to import it in ES Modules
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

/** Length `git rev-parse --short` yields here, and what the field has always held. */
const SHORT_SHA_LENGTH = 7;

/**
 * The commit to report, as a short hash.
 *
 * GIT_SHA is normalised rather than trusted verbatim, because the obvious
 * things to pass it are full 40-character hashes — Kamal's own version is one,
 * and so is GitHub's `github.sha`. Both would otherwise render as a wall of hex
 * in the Help modal next to a version number. A value that is not a plain hash
 * (a `git describe` output, say, or a hash marked `-dirty`) is passed through
 * untouched: it identifies the build too, and truncating it would destroy that.
 *
 * `env` is a plain record rather than NodeJS.ProcessEnv on purpose: Next
 * augments that type with a *required* NODE_ENV, so a test could not pass a
 * one-key object without inventing the rest of the environment. This reads one
 * variable, and the signature should say so.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {typeof execSync} [run]
 * @returns {string}
 */
export function resolveCommitHash(env = process.env, run = execSync) {
  const fromEnv = env.GIT_SHA?.trim();
  if (fromEnv) {
    return /^[0-9a-f]{7,40}$/i.test(fromEnv)
      ? fromEnv.slice(0, SHORT_SHA_LENGTH)
      : fromEnv;
  }
  try {
    return run("git rev-parse --short HEAD").toString().trim();
  } catch (error) {
    console.error("Error getting git commit hash:", error);
    // No git, and nothing passed in — a source tarball, or an image built
    // without the build arg. Valid file, useless hash.
    return "nogit";
  }
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {typeof execSync} [run]
 */
export function buildInfo(env = process.env, run = execSync) {
  return {
    version: packageJson.version,
    commitHash: resolveCommitHash(env, run),
    buildDate: new Date().toISOString(),
  };
}

export function writeBuildInfo() {
  const info = buildInfo();

  // Calculate __dirname equivalent in ES Modules
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const dir = path.join(__dirname, "../src/generated");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(dir, "build-info.json"),
    JSON.stringify(info, null, 2),
  );

  console.log("Build info generated:", info);
  return info;
}

// Only when run as a script. The exports above are imported by
// generate-build-info.test.ts, which must not write the real file.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  writeBuildInfo();
}
