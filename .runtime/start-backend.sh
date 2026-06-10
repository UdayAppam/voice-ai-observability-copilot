#!/usr/bin/env bash
# Persistent backend runner — detaches from parent session.
# Derives the repo root from this script's own location, so it works from any clone path.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT/backend"
exec env PORT="${PORT:-3001}" NODE_ENV="${NODE_ENV:-development}" node src/app.js
