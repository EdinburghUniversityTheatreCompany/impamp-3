#!/usr/bin/env node
/**
 * Serve the production build the way production actually serves it.
 *
 * `next start` refuses to work with `output: standalone` — it prints
 *
 *   "next start" does not work with "output: standalone" configuration.
 *   Use "node .next/standalone/server.js" instead.
 *
 * and, while it does currently serve, it is running a code path Next says is
 * unsupported. The Dockerfile has always used the standalone server, so
 * `npm start` was testing a different server from the one that ships.
 *
 * `next build` writes .next/standalone with the traced node_modules and
 * server.js, but deliberately does NOT copy the two directories the server
 * reads at runtime — public/ and .next/static — because a deploy is expected
 * to place them (the Dockerfile does exactly this). So do the same here, then
 * hand over to server.js.
 *
 * Port and host come from the environment (PORT / HOSTNAME); the standalone
 * server has no CLI flags. `npm start -- --port 3100` therefore does nothing,
 * so accept `--port`/`-p` here and translate it into PORT.
 */

import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const standalone = join(root, ".next", "standalone");

if (!existsSync(join(standalone, "server.js"))) {
  console.error(
    `No standalone build at ${standalone}. Run \`npm run build\` first.`,
  );
  process.exit(1);
}

// --port/-p is accepted only so existing invocations keep working; the
// standalone server reads PORT.
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--port" || arg === "-p") {
    process.env.PORT = argv[++i];
  } else if (arg.startsWith("--port=")) {
    process.env.PORT = arg.slice("--port=".length);
  }
}
process.env.PORT ??= "3000";
process.env.HOSTNAME ??= "0.0.0.0";

// server.js does `process.chdir(__dirname)`, so anything cwd-relative resolves
// under .next/standalone once it takes over. The server-sync database defaults
// to "./data/impamp.db" (src/lib/server/db.ts), which under `next start` meant
// <repo>/data — and .next is wiped by every rebuild. Anchor it to the repo so
// a local `npm start` keeps its database. Docker sets IMPAMP_DB_PATH itself.
process.env.IMPAMP_DB_PATH ??= join(root, "data", "impamp.db");

// Assets the standalone server serves but the build does not copy in.
cpSync(join(root, "public"), join(standalone, "public"), { recursive: true });
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), {
  recursive: true,
});

await import(join(standalone, "server.js"));
