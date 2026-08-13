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

# Stop whatever this script started last time, if it is still listening.
if [ -f ".e2e-server-$PORT.pid" ]; then
  kill "$(cat ".e2e-server-$PORT.pid")" 2>/dev/null || true
  rm -f ".e2e-server-$PORT.pid"
  sleep 1
fi

npm run build >"/tmp/e2e-build-$PORT.log" 2>&1 || {
  echo "build failed — see /tmp/e2e-build-$PORT.log" >&2
  tail -30 "/tmp/e2e-build-$PORT.log" >&2
  exit 1
}

setsid nohup npx next start --port "$PORT" \
  >"/tmp/e2e-server-$PORT.log" 2>&1 </dev/null &
echo $! >".e2e-server-$PORT.pid"

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/up"; then
    echo "e2e server listening on $PORT (pid $(cat ".e2e-server-$PORT.pid"))"
    exit 0
  fi
  sleep 1
done

echo "server did not come up on $PORT — see /tmp/e2e-server-$PORT.log" >&2
exit 1
