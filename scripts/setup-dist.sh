#!/usr/bin/env bash
# Stage the frontend assets into dist/ for Tauri to bundle.
#
# Why this exists: Tauri's release bundler refuses `frontendDist` paths
# that include `src-tauri/` (the Rust shell) — and our project structure
# is flat at the root (index.html, app.js, styles.css, tokens.css alongside
# src-tauri/, AGENTS.md, etc). So we copy only the runtime files into a
# clean dist/ folder and point Tauri at that.
#
# Browser-mode workflow is unaffected: opening index.html at the project
# root still works exactly as before. dist/ is git-ignored.

set -euo pipefail

# Run from the repo root regardless of where invoked.
cd "$(dirname "$0")/.."

# Wipe and recreate so a stale dist/ never includes files that have since
# been removed from the source.
rm -rf dist
mkdir -p dist

# The four runtime files referenced by index.html. If you add another
# asset (e.g. a new CSS file or a runtime-loaded JSON), add it here too.
cp index.html app.js styles.css tokens.css dist/

echo "Staged $(ls dist | wc -l | tr -d ' ') file(s) into dist/"
