#!/usr/bin/env bash
# Persistent cloudflared tunnel runner.
# Looks up cloudflared in this order: $CLOUDFLARED env → $PATH → known dev locations.
# For local-only review you do NOT need cloudflared at all — localhost:3001 works directly.
set -e
CLOUDFLARED_BIN="${CLOUDFLARED:-$(command -v cloudflared || true)}"
if [ -z "$CLOUDFLARED_BIN" ]; then
  for cand in "$HOME/bin/cloudflared" /usr/local/bin/cloudflared /opt/homebrew/bin/cloudflared; do
    if [ -x "$cand" ]; then CLOUDFLARED_BIN="$cand"; break; fi
  done
fi
if [ -z "$CLOUDFLARED_BIN" ]; then
  echo "ERROR: cloudflared not found on PATH or in known locations."
  echo "       Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  echo "       Or skip the tunnel entirely — the backend at http://localhost:3001 works for local review."
  exit 1
fi
exec "$CLOUDFLARED_BIN" tunnel --url http://localhost:3001 --no-autoupdate
