#!/usr/bin/env bash
# Voice AI Copilot — toggle between LIVE and TEST data sources.
#
#   bash .runtime/use-data.sh live      # → backend serves backend/data/copilot.db (HL OAuth-fed data)
#   bash .runtime/use-data.sh test      # → backend serves backend/data/copilot.test.db (regression seeded)
#   bash .runtime/use-data.sh status    # show which DB the backend is currently using + row counts
#   bash .runtime/use-data.sh seed-test # populate the test DB by running the regression --seed
#
# How it works:
#   - Both DBs live in backend/data/
#   - `.env`'s DATABASE_PATH is rewritten, then backend reloads (tunnel stays)
#   - Existing OAuth installations (oauth_installations table) are per-DB,
#     so switching to test = test-only OAuth state and vice versa.

set -e

# Derive repo root from this script's own location so it works from any clone path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT/backend/.env"
LIVE_DB="$ROOT/backend/data/copilot.db"
TEST_DB="$ROOT/backend/data/copilot.test.db"
RELATIVE_LIVE="./data/copilot.db"
RELATIVE_TEST="./data/copilot.test.db"

ACTION="${1:-status}"

green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }

current_path() {
  grep -E '^DATABASE_PATH=' "$ENV_FILE" | head -1 | cut -d'=' -f2-
}

show_status() {
  local current
  current=$(current_path)
  local mode="unknown"
  if   [[ "$current" == "$RELATIVE_LIVE" ]]; then mode="LIVE"
  elif [[ "$current" == "$RELATIVE_TEST" ]]; then mode="TEST"
  fi
  echo "  current DATABASE_PATH: $current  →  mode: $mode"
  echo ""
  echo "  Live DB ($LIVE_DB):"
  if [ -f "$LIVE_DB" ]; then
    node -e "
const { DatabaseSync } = require('node:sqlite')
try {
  const db = new DatabaseSync('$LIVE_DB')
  const c = db.prepare(\`SELECT
    (SELECT COUNT(*) FROM agents) agents,
    (SELECT COUNT(*) FROM calls) calls,
    (SELECT COUNT(*) FROM analyses) analyses,
    (SELECT COUNT(*) FROM recommendations) recs\`).get()
  console.log('    agents:', c.agents, '· calls:', c.calls, '· analyses:', c.analyses, '· recs:', c.recs)
  db.close()
} catch (e) { console.log('    ✗ unreadable: ' + e.message) }
" 2>/dev/null | grep -v 'ExperimentalWarning\|trace-warnings'
  else
    echo "    (file does not exist — will be created on first backend start)"
  fi
  echo ""
  echo "  Test DB ($TEST_DB):"
  if [ -f "$TEST_DB" ]; then
    node -e "
const { DatabaseSync } = require('node:sqlite')
try {
  const db = new DatabaseSync('$TEST_DB')
  const c = db.prepare(\`SELECT
    (SELECT COUNT(*) FROM agents) agents,
    (SELECT COUNT(*) FROM calls) calls,
    (SELECT COUNT(*) FROM analyses) analyses,
    (SELECT COUNT(*) FROM recommendations) recs\`).get()
  console.log('    agents:', c.agents, '· calls:', c.calls, '· analyses:', c.analyses, '· recs:', c.recs)
  db.close()
} catch (e) { console.log('    ✗ unreadable: ' + e.message) }
" 2>/dev/null | grep -v 'ExperimentalWarning\|trace-warnings'
  else
    echo "    (file does not exist — run: bash .runtime/use-data.sh seed-test)"
  fi
}

reload_backend_if_running() {
  if pgrep -f 'node src/app.js' >/dev/null 2>&1; then
    yellow "  Reloading backend so the new DB path takes effect..."
    bash "$ROOT/.runtime/run-persistent.sh" reload-backend | tail -1
  else
    yellow "  Backend not running — start it with: bash $ROOT/.runtime/run-persistent.sh"
  fi
}

case "$ACTION" in
  status)
    show_status
    ;;
  live)
    sed -i "s|^DATABASE_PATH=.*|DATABASE_PATH=$RELATIVE_LIVE|" "$ENV_FILE"
    green "  ✓ switched to LIVE DB: $LIVE_DB"
    reload_backend_if_running
    ;;
  test)
    if [ ! -f "$TEST_DB" ]; then
      red "  ✗ test DB doesn't exist yet"
      yellow "  Run: bash .runtime/use-data.sh seed-test"
      exit 1
    fi
    sed -i "s|^DATABASE_PATH=.*|DATABASE_PATH=$RELATIVE_TEST|" "$ENV_FILE"
    green "  ✓ switched to TEST DB: $TEST_DB"
    reload_backend_if_running
    ;;
  seed-test)
    yellow "  Seeding test DB via regression --seed (uses real OpenAI, ~\$0.10)..."
    yellow "  This temporarily switches DATABASE_PATH so the seed lands in copilot.test.db."
    # Save current setting
    PREV=$(current_path)
    # Point at test DB
    sed -i "s|^DATABASE_PATH=.*|DATABASE_PATH=$RELATIVE_TEST|" "$ENV_FILE"
    # Need backend NOT running so it doesn't write a fresh empty file under us
    if pgrep -f 'node src/app.js' >/dev/null 2>&1; then
      yellow "  Stopping backend during seed..."
      bash "$ROOT/.runtime/run-persistent.sh" stop | tail -1
    fi
    # Run seed
    cd "$ROOT/backend"
    node scripts/regression/run.js --seed 2>&1 | grep -v 'ExperimentalWarning\|trace-warnings' | tail -25
    # Restore previous DATABASE_PATH setting
    sed -i "s|^DATABASE_PATH=.*|DATABASE_PATH=$PREV|" "$ENV_FILE"
    green "  ✓ test DB seeded at $TEST_DB"
    green "  DATABASE_PATH restored to: $PREV"
    yellow "  Restart backend manually when ready: bash $ROOT/.runtime/run-persistent.sh"
    ;;
  *)
    echo "Usage: bash $(basename "$0") {status|live|test|seed-test}"
    echo ""
    echo "  status     show which DB the backend is using + row counts in each"
    echo "  live       switch to LIVE DB (real HL OAuth-fed data, persists separately)"
    echo "  test       switch to TEST DB (regression-seeded data, persists separately)"
    echo "  seed-test  populate the test DB by running the regression --seed script"
    exit 1
    ;;
esac
