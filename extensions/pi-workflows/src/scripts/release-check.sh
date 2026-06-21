#!/usr/bin/env zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

echo "[workflows] typecheck"
nix run nixpkgs#typescript -- --noEmit --pretty false --module nodenext --moduleResolution nodenext --target es2022 --lib es2022,dom \
  extensions/workflows/api.ts \
  extensions/workflows/db.ts \
  extensions/workflows/dynamic.ts \
  extensions/workflows/engine.ts \
  extensions/workflows/grinder.ts \
  extensions/workflows/index.ts \
  extensions/workflows/loader.ts \
  extensions/workflows/registry.ts \
  extensions/workflows/tests/*.test.ts \
  extensions/workflows/scripts/smoke.ts

echo "[workflows] spec-check"
node --check .pi/workflows/specs/fix-one.mjs
node --check .pi/workflows/specs/grind.mjs

echo "[workflows] tests"
nix run nixpkgs#tsx -- --test extensions/workflows/tests/*.test.ts

echo "[workflows] smoke"
nix run nixpkgs#tsx -- extensions/workflows/scripts/smoke.ts

echo "[workflows] release check passed"
