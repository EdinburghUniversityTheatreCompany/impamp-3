#!/usr/bin/env bash
# Rebuild the app and (re)start it on E2E_PORT with the e2e window hooks
# compiled in, detached so it survives between test runs.
#
# Usage: scripts/e2e-server.sh [port]
set -euo pipefail

PORT="${1:-${E2E_PORT:-3100}}"
export NEXT_PUBLIC_E2E_HOOKS=1
export NEXT_PUBLIC_GOOGLE_CLIENT_ID="${NEXT_PUBLIC_GOOGLE_CLIENT_ID:-e2e-placeholder.apps.googleusercontent.com}"

cd "$(dirname "$0")/.."

ROOT="$PWD"

# Free the port before building. `next start` is a grandchild of the shell that
# launched it, so tracking a pid is unreliable — find whoever actually holds the
# listening socket instead, and only kill it if it is serving *this* checkout.
# Skipping this lets the new server die with EADDRINUSE while the readiness
# probe below happily succeeds against the stale one, and the tests then run
# against stale code while looking green.
#
# The standalone server chdir's into .next/standalone, so accept that too —
# matching only $ROOT would leave our own previous server running.
for pid in $(ss -lptnH "sport = :$PORT" 2>/dev/null |
  grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
  cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null)
  if [ "$cwd" = "$ROOT" ] || [ "$cwd" = "$ROOT/.next/standalone" ]; then
    kill "$pid" 2>/dev/null || true
  else
    echo "port $PORT is held by pid $pid from another directory:" >&2
    echo "  $(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo unknown)" >&2
    echo "stop it first, or pass a different port." >&2
    exit 1
  fi
done

for _ in $(seq 1 20); do
  curl -fsS -o /dev/null --max-time 1 "http://localhost:$PORT/up" 2>/dev/null || break
  sleep 1
done

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
