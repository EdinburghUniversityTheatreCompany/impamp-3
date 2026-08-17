#!/usr/bin/env bash
# Assert that EVERY Dockerfile in this repo pins the same Node as .node-version.
#
# scripts/check_version_sync.sh is a re-copyable template shared across repos,
# and its header asks that its logic not be hand-edited. It picks the first of
# `Dockerfile` / `Containerfile` and cross-checks only that one — which is
# correct for the common repo with a single image, and blind here.
#
# This repo has two. Dockerfile.dev sat on Node 22 while everything else was on
# 24, for months, silently: `COMPOSE_PROFILES=development docker-compose up` is
# the documented dev path, so anyone using it developed on a different major
# from the one CI tested and production shipped. That was found by hand and
# fixed, and the gate that should have caught it still could not see the file.
#
# So rather than fork the template, this covers what the template skips. It
# checks every Dockerfile* / Containerfile* including the one the template
# already handles: the redundancy is free, and it means this stays correct if
# the template ever changes which file it picks.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

if [ ! -f .node-version ]; then
  echo "  - no .node-version, nothing to cross-check Dockerfiles against"
  exit 0
fi

expected=$(tr -d "[:space:]\"'" <.node-version)
expected=${expected#v}

fail=0
found=0

for f in Dockerfile* Containerfile*; do
  [ -f "$f" ] || continue

  # `ARG NODE_VERSION=24.19.0`. A bare `ARG NODE_VERSION` re-declaration pulls
  # the value into a later stage's scope and pins nothing, so only `=` counts.
  pins=$(sed -n 's/^[[:space:]]*ARG[[:space:]]\{1,\}NODE_VERSION=//p' "$f" |
    tr -d "[:space:]\"'" | sed 's/^v//' | sort -u | grep -c . || true)

  if [ "$pins" -eq 0 ]; then
    echo "  - $f: no ARG NODE_VERSION default, nothing to cross-check"
    continue
  fi

  found=$((found + 1))
  actual=$(sed -n 's/^[[:space:]]*ARG[[:space:]]\{1,\}NODE_VERSION=//p' "$f" |
    tr -d "[:space:]\"'" | sed 's/^v//' | sort -u)

  if [ "$pins" -gt 1 ]; then
    echo "  ✗ $f declares ARG NODE_VERSION with conflicting defaults: $(printf '%s' "$actual" | tr '\n' ' ')"
    fail=1
  elif [ "$actual" != "$expected" ]; then
    echo "  ✗ $f ARG NODE_VERSION ($actual) != .node-version ($expected)"
    fail=1
  else
    echo "  ✓ $f ARG NODE_VERSION $actual — matches .node-version"
  fi
done

if [ "$found" -eq 0 ]; then
  echo "  - no Dockerfile pins ARG NODE_VERSION, nothing to cross-check"
fi

[ "$fail" -eq 0 ] || echo "Node pins disagree — CLAUDE.md says Node $expected everywhere."
exit "$fail"
