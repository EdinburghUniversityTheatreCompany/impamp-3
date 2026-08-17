#!/usr/bin/env bash
# Rebuild the app and (re)start it on E2E_PORT with the e2e window hooks
# compiled in, detached so it survives between test runs.
#
# Usage: scripts/e2e-server.sh [port]
set -euo pipefail

PORT="${1:-${E2E_PORT:-3100}}"

cd "$(dirname "$0")/.."

ROOT="$PWD"

# Take the server environment from e2e-tests/env.js — the same module
# playwright.config.ts feeds its `webServer.env` from. Setting it here by hand
# is how this script came to start a server with the test sign-in route
# disabled, pointed at the developer's real database: every server-sync spec
# then failed no matter what the app did.
while IFS='=' read -r key value; do
  [ -n "$key" ] || continue
  export "$key=$value"
done < <(node -e '
  import("./e2e-tests/env.js").then(({ e2eServerEnv }) => {
    for (const [k, v] of Object.entries(e2eServerEnv)) console.log(`${k}=${v}`);
  });
')

# Free the port before building. `next start` is a grandchild of the shell that
# launched it, so tracking a pid is unreliable — find whoever actually holds the
# listening socket instead, and only kill it if it is serving *this* checkout.
# Skipping this lets the new server die with EADDRINUSE while the readiness
# probe below happily succeeds against the stale one, and the tests then run
# against stale code while looking green.
#
# Match on *anything under* $ROOT rather than $ROOT exactly: the standalone
# server chdir's into .next/standalone, and if that directory was removed while
# it ran (a `rm -rf .next`, or the rebuild below) the kernel reports the cwd as
# "…/.next/standalone (deleted)". Both are still our own server, and refusing
# to kill either leaves the rebuild to die on EADDRINUSE.
for pid in $(ss -lptnH "sport = :$PORT" 2>/dev/null |
  grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
  if [ "$cwd" = "$ROOT" ] || [ "${cwd#"$ROOT"/}" != "$cwd" ]; then
    kill "$pid" 2>/dev/null || true
  else
    echo "port $PORT is held by pid $pid from another directory:" >&2
    echo "  ${cwd:-unknown}" >&2
    echo "stop it first, or pass a different port." >&2
    exit 1
  fi
done

for _ in $(seq 1 20); do
  curl -fsS -o /dev/null --max-time 1 "http://localhost:$PORT/up" 2>/dev/null || break
  sleep 1
done

# Start from an empty server database. This is the only safe moment: the old
# server is dead and the new one has not opened the file yet. A Playwright
# globalSetup cannot do it, because the webServer plugin's setup runs first.
node e2e-tests/reset-db.js

npm run build >"/tmp/e2e-build-$PORT.log" 2>&1 || {
  echo "build failed — see /tmp/e2e-build-$PORT.log" >&2
  tail -30 "/tmp/e2e-build-$PORT.log" >&2
  exit 1
}

# `npm start` runs the standalone server, the same one the Docker image runs —
# `next start` is unsupported with `output: standalone`.
setsid nohup npm start -- --port "$PORT" \
  >"/tmp/e2e-server-$PORT.log" 2>&1 </dev/null &

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/up" 2>/dev/null; then
    echo "e2e server listening on $PORT"
    exit 0
  fi
  if grep -q EADDRINUSE "/tmp/e2e-server-$PORT.log" 2>/dev/null; then
    echo "server failed to bind $PORT (EADDRINUSE)" >&2
    exit 1
  fi
  sleep 1
done

echo "server did not come up on $PORT — see /tmp/e2e-server-$PORT.log" >&2
exit 1
