#!/usr/bin/env bash
# Verify every GitHub Actions `uses:` ref is pinned to a commit SHA, and that
# each action resolves to exactly one SHA across all workflows.
#
# The header of .github/workflows/ci.yml told you to run this; it did not
# exist, which is very likely why three actions had drifted to two different
# SHAs each — `pinact run -u` had reached six of eight jobs and nothing said so.
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0
refs=$(rg --no-filename -o 'uses: *[^ ]+' .github/workflows/*.yml 2>/dev/null | sed 's/uses: *//')

# 1. Everything third-party must be a 40-character SHA, not a tag.
while read -r ref; do
  [ -n "$ref" ] || continue
  case "$ref" in
    ./*|docker://*) continue ;;  # local composite actions carry no SHA
  esac
  if ! printf '%s' "$ref" | grep -Eq '@[0-9a-f]{40}$'; then
    echo "NOT SHA-PINNED: $ref"
    fail=1
  fi
done <<< "$refs"

# 2. One SHA per action, or a bump has reached some jobs and not others.
for action in $(printf '%s\n' "$refs" | sed 's/@.*//' | sort -u); do
  [ -n "$action" ] || continue
  shas=$(printf '%s\n' "$refs" | grep "^${action}@" | sed 's/.*@//' | sort -u)
  distinct=$(printf '%s\n' "$shas" | grep -c . || true)
  if [ "$distinct" -gt 1 ]; then
    echo "PINNED AT $distinct DIFFERENT SHAS: $action"
    printf '%s\n' "$shas" | sed 's/^/    /'
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "✓ every action is SHA-pinned, and each resolves to one SHA"
fi
exit "$fail"
