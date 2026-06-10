#!/usr/bin/env bash
#
# Voice AI Copilot — Persistent Backend + Tunnel
#
# Run this in YOUR terminal (not via Claude). Once started, you can close the
# terminal and both backend + tunnel keep running until you reboot.
#
#   bash .runtime/run-persistent.sh              # prompts for live vs test DB
#   bash .runtime/run-persistent.sh start --db=live   # skip prompt, use live
#   bash .runtime/run-persistent.sh start --db=test   # skip prompt, use test
#   bash .runtime/run-persistent.sh restart [--db=…]  # stop + start fresh
#   bash .runtime/run-persistent.sh reload-backend    # reload only (keep tunnel URL)
#   bash .runtime/run-persistent.sh stop
#   bash .runtime/run-persistent.sh status

set -e

# Derive repo root from this script's own location so the script works from any clone path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME="$ROOT/.runtime"
mkdir -p "$RUNTIME"

# cloudflared discovery — $CLOUDFLARED env, then $PATH, then known dev locations.
# Tunnel step is OPTIONAL: when cloudflared isn't installed we skip it and the
# backend stays reachable at http://localhost:3001 (enough for local review).
find_cloudflared() {
  if [ -n "$CLOUDFLARED" ] && [ -x "$CLOUDFLARED" ]; then echo "$CLOUDFLARED"; return; fi
  command -v cloudflared 2>/dev/null && return
  for cand in "$HOME/bin/cloudflared" /usr/local/bin/cloudflared /opt/homebrew/bin/cloudflared; do
    if [ -x "$cand" ]; then echo "$cand"; return; fi
  done
}

BACKEND_LOG="$RUNTIME/backend.log"
TUNNEL_LOG="$RUNTIME/tunnel.log"
BACKEND_PID_FILE="$RUNTIME/backend.pid"
TUNNEL_PID_FILE="$RUNTIME/tunnel.pid"
TUNNEL_URL_FILE="$RUNTIME/tunnel.url"
ENV_FILE="$ROOT/backend/.env"
LIVE_DB_REL="./data/copilot.db"
TEST_DB_REL="./data/copilot.test.db"
LIVE_DB_ABS="$ROOT/backend/data/copilot.db"
TEST_DB_ABS="$ROOT/backend/data/copilot.test.db"

ACTION="${1:-start}"
# Optional second arg: --db=live | --db=test  (skips prompt, useful for scripting)
DB_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --db=live) DB_FLAG="live" ;;
    --db=test) DB_FLAG="test" ;;
  esac
done

# Ask the developer which DB the backend should serve.
# Updates backend/.env DATABASE_PATH before launch. Silently no-ops if:
#   - --db=live|test was passed on the CLI
#   - stdin isn't a TTY (e.g. invoked from a script / Claude / cron)
# Sets global CHOSEN_DB to "live" or "test" for the launch banner.
choose_db() {
  CHOSEN_DB=""

  # 1. Explicit flag wins
  if [ -n "$DB_FLAG" ]; then
    CHOSEN_DB="$DB_FLAG"
  elif [ ! -t 0 ]; then
    # 2. Non-interactive — fall back to whatever .env currently has
    local current
    current=$(grep -E '^DATABASE_PATH=' "$ENV_FILE" | head -1 | cut -d'=' -f2-)
    if   [[ "$current" == "$TEST_DB_REL" ]]; then CHOSEN_DB="test"
    else                                          CHOSEN_DB="live"
    fi
    echo "Non-interactive — using current .env DATABASE_PATH ($CHOSEN_DB DB)"
    return
  else
    # 3. Interactive prompt
    local live_count test_count
    live_count=$(_count_agents "$LIVE_DB_ABS")
    test_count=$(_count_agents "$TEST_DB_ABS")
    echo ""
    echo "Which DB should the backend serve?"
    echo "  [L] live  — $LIVE_DB_REL  ($live_count agents · real HL OAuth-fed data)"
    echo "  [T] test  — $TEST_DB_REL  ($test_count agents · regression scenarios)"
    if [ "$test_count" = "0" ] || [ "$test_count" = "n/a" ]; then
      echo "       (test DB empty/missing — run: bash .runtime/use-data.sh seed-test)"
    fi
    read -r -p "Choice [L/t]: " choice
    choice=${choice:-L}
    case "$choice" in
      [Tt]*) CHOSEN_DB="test" ;;
      *)     CHOSEN_DB="live" ;;
    esac
  fi

  # Apply the choice to .env
  case "$CHOSEN_DB" in
    live) sed -i "s|^DATABASE_PATH=.*|DATABASE_PATH=$LIVE_DB_REL|" "$ENV_FILE" ;;
    test)
      if [ ! -f "$TEST_DB_ABS" ]; then
        echo "  ✗ test DB ($TEST_DB_ABS) doesn't exist."
        echo "    Seed it first: bash .runtime/use-data.sh seed-test"
        exit 1
      fi
      sed -i "s|^DATABASE_PATH=.*|DATABASE_PATH=$TEST_DB_REL|" "$ENV_FILE"
      ;;
  esac
}

# Returns the agent count for a DB file, or "0" if missing, or "n/a" if unreadable.
_count_agents() {
  local f="$1"
  [ -f "$f" ] || { echo "0"; return; }
  node -e "
const { DatabaseSync } = require('node:sqlite')
try {
  const db = new DatabaseSync('$f')
  console.log(db.prepare('SELECT COUNT(*) n FROM agents').get().n)
  db.close()
} catch (e) { console.log('n/a') }
" 2>/dev/null
}

stop_all() {
  echo "Stopping..."
  if [ -f "$BACKEND_PID_FILE" ]; then
    kill "$(cat "$BACKEND_PID_FILE")" 2>/dev/null || true
    rm -f "$BACKEND_PID_FILE"
  fi
  if [ -f "$TUNNEL_PID_FILE" ]; then
    kill "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
    rm -f "$TUNNEL_PID_FILE"
  fi
  # Belt-and-braces
  fuser -k 3001/tcp 2>/dev/null || true
  pkill -f "cloudflared tunnel --url http://localhost:3001" 2>/dev/null || true
  sleep 1
  echo "Stopped."
}

show_status() {
  echo "=== Backend ==="
  if [ -f "$BACKEND_PID_FILE" ] && kill -0 "$(cat "$BACKEND_PID_FILE")" 2>/dev/null; then
    echo "  Running (PID $(cat "$BACKEND_PID_FILE"))"
    curl -s -m 3 http://localhost:3001/health && echo
  else
    echo "  Not running"
  fi
  echo ""
  echo "=== Tunnel ==="
  if [ -f "$TUNNEL_PID_FILE" ] && kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; then
    echo "  Running (PID $(cat "$TUNNEL_PID_FILE"))"
    [ -f "$TUNNEL_URL_FILE" ] && echo "  URL: $(cat "$TUNNEL_URL_FILE")"
  else
    echo "  Not running"
  fi
}

if [ "$ACTION" = "stop" ]; then
  stop_all
  exit 0
fi
if [ "$ACTION" = "status" ]; then
  show_status
  exit 0
fi
if [ "$ACTION" = "reload-backend" ]; then
  # Reload backend only — leave tunnel alive (so URL doesn't change)
  echo "Reloading backend only (tunnel stays alive)..."
  if [ -f "$BACKEND_PID_FILE" ]; then
    kill "$(cat "$BACKEND_PID_FILE")" 2>/dev/null || true
    rm -f "$BACKEND_PID_FILE"
  fi
  fuser -k 3001/tcp 2>/dev/null || true
  sleep 2
  cd "$ROOT/backend"
  nohup setsid env PORT=3001 NODE_ENV=development node src/app.js \
    > "$BACKEND_LOG" 2>&1 < /dev/null &
  echo $! > "$BACKEND_PID_FILE"
  sleep 3
  if curl -s -m 3 http://localhost:3001/health > /dev/null; then
    echo "  ✓ Backend reloaded (tunnel unchanged: $(cat "$TUNNEL_URL_FILE" 2>/dev/null))"
  else
    echo "  ✗ Backend failed to start. Last log:"
    tail -15 "$BACKEND_LOG"
  fi
  exit 0
fi
if [ "$ACTION" = "restart" ]; then
  stop_all
fi

# Stop any leftovers before starting fresh
fuser -k 3001/tcp 2>/dev/null || true
pkill -f "cloudflared tunnel --url http://localhost:3001" 2>/dev/null || true
sleep 1

# Ask the developer which DB to serve (live HL vs test scenarios)
choose_db

# Start backend — nohup detaches from terminal; setsid puts it in a new session
echo "Starting backend (DB mode: $CHOSEN_DB)..."
cd "$ROOT/backend"
nohup setsid env PORT=3001 NODE_ENV=development node src/app.js \
  > "$BACKEND_LOG" 2>&1 < /dev/null &
echo $! > "$BACKEND_PID_FILE"
sleep 4

# Verify backend started
if ! curl -s -m 3 http://localhost:3001/health > /dev/null; then
  echo "ERROR: backend failed to start. Last log lines:"
  tail -15 "$BACKEND_LOG"
  exit 1
fi
echo "  ✓ Backend up on http://localhost:3001"

# Start tunnel (optional — skip cleanly if cloudflared isn't installed)
CLOUDFLARED_BIN=$(find_cloudflared)
URL=""
if [ -z "$CLOUDFLARED_BIN" ]; then
  echo "  ℹ cloudflared not installed — skipping tunnel."
  echo "    Backend is reachable at http://localhost:3001 for local review."
  echo "    To enable the public tunnel: install cloudflared and re-run, or set CLOUDFLARED=/path/to/cloudflared."
else
  echo "Starting cloudflared tunnel ($CLOUDFLARED_BIN)..."
  nohup setsid "$CLOUDFLARED_BIN" tunnel \
    --url http://localhost:3001 --no-autoupdate \
    > "$TUNNEL_LOG" 2>&1 < /dev/null &
  echo $! > "$TUNNEL_PID_FILE"

  # Wait for URL to appear in the log
  echo "  Waiting for tunnel URL..."
  for i in $(seq 1 15); do
    sleep 1
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    if [ -n "$URL" ]; then break; fi
  done

  if [ -z "$URL" ]; then
    echo "  ⚠ Tunnel didn't produce a URL within 15s. Last log:"
    tail -15 "$TUNNEL_LOG"
    echo "    Continuing without tunnel — backend still reachable at http://localhost:3001."
  else
    echo "$URL" > "$TUNNEL_URL_FILE"
    sleep 3
    if curl -s -m 10 "$URL/health" > /dev/null; then
      echo "  ✓ Tunnel live at: $URL"
    else
      echo "  ⚠ Tunnel URL exists but isn't responding yet — wait 10 seconds and retry"
    fi
  fi
fi

echo ""
echo "============================================================"
echo " ALL RUNNING — close this terminal whenever you like."
echo "============================================================"
echo ""
echo "  DB mode:     $CHOSEN_DB  (switch anytime: bash $RUNTIME/use-data.sh live|test)"
echo "  Local URL:   http://localhost:3001/dashboard/"
echo "  Backend log: tail -f $BACKEND_LOG"
[ -n "$URL" ] && echo "  Tunnel log:  tail -f $TUNNEL_LOG"
echo "  Stop:        bash $0 stop"
echo "  Status:      bash $0 status"
echo ""
if [ -n "$URL" ]; then
  echo "  PUBLIC URL: $URL"
  echo ""
  echo "  Next step (HL Marketplace App): update REDIRECT_URI / Custom Page URL"
  echo "                                  to this tunnel URL."
else
  echo "  Open http://localhost:3001/dashboard/ in a browser."
fi
