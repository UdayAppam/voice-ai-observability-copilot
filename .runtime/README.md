# .runtime/ — local-run convenience scripts

A small toolkit for running the backend + an optional public tunnel without keeping a terminal open. **Optional** — the top-level README's Quick Start (`npm install && npm start`) is the simpler path if you just want to see the app run.

These scripts add three things on top of that:

1. **Persistent backend** — runs via `nohup setsid` so you can close the terminal and the server keeps going.
2. **Optional cloudflared tunnel** — exposes the backend over a public HTTPS URL for the HighLevel Marketplace App custom-page flow. Skipped automatically if cloudflared isn't installed.
3. **One-command DB toggle** — switch the backend between the live HighLevel-OAuth-fed DB and the seeded test DB without restarting the tunnel.

---

## First run — 60 seconds

```bash
git clone https://github.com/UdayAppam/voice-agent-flywheel.git
cd voice-agent-flywheel

# 1. Install dependencies + build frontend
( cd backend && npm install )
( cd frontend && npm install && npm run build )
cp -r frontend/dist backend/public/dashboard

# 2. Configure secrets (OpenAI key required; HL credentials only if you want
#    to PATCH a real HL Voice AI agent — leave blank for local-only review)
cp backend/.env.example backend/.env
$EDITOR backend/.env

# 3. Start the backend (interactive — choose live or test DB at the prompt)
bash .runtime/run-persistent.sh
```

Open **http://localhost:3001/dashboard/** in your browser.

That's it. If cloudflared is installed it will also print a public `*.trycloudflare.com` URL — but you don't need it for local review.

---

## What each script does

| Script | Purpose |
|---|---|
| `run-persistent.sh` | Start/stop/restart the backend (and optionally the cloudflared tunnel). Handles a graceful interactive prompt for live vs test DB. |
| `use-data.sh` | Toggle the backend between live DB (`backend/data/copilot.db`) and test DB (`backend/data/copilot.test.db`) without restarting the tunnel. |
| `start-backend.sh` | Minimal backend launcher — useful if you want to wire it into systemd/launchd/Docker yourself. |
| `start-tunnel.sh` | Minimal cloudflared launcher with automatic binary discovery. Same use case as above. |

All four scripts auto-derive the repo root from their own location, so they work from any clone path.

---

## Common commands

```bash
# Start everything fresh (interactive DB prompt)
bash .runtime/run-persistent.sh

# Same, skip the prompt
bash .runtime/run-persistent.sh start --db=test
bash .runtime/run-persistent.sh start --db=live

# Restart (e.g. after editing backend code)
bash .runtime/run-persistent.sh restart --db=test

# Reload backend only — tunnel URL stays the same (useful mid-demo)
bash .runtime/run-persistent.sh reload-backend

# Check what's running
bash .runtime/run-persistent.sh status

# Stop everything
bash .runtime/run-persistent.sh stop

# Switch DB mid-session (backend auto-reloads, tunnel URL unchanged)
bash .runtime/use-data.sh test
bash .runtime/use-data.sh live
bash .runtime/use-data.sh status     # see which DB is active + row counts in each

# Populate the test DB from a fresh clone (costs ~$0.10 in OpenAI calls)
bash .runtime/use-data.sh seed-test
```

---

## Recommended reviewer path

For the cleanest "is this thing actually working?" experience:

1. `bash .runtime/use-data.sh seed-test` — populates the test DB (~3 min, ~$0.10 OpenAI)
2. `bash .runtime/run-persistent.sh start --db=test` — backend on test data
3. Open **http://localhost:3001/dashboard/** and drill into **Maya — Lead Qualifier**. She has 48 calls, 8 unverified claims, and 3 measured-significant improvements in Recently Applied. The complete loop is visible on one agent.

The live DB only matters if you have a HighLevel sandbox configured in `.env` and want to test the OAuth + PATCH-live-agent flow. The test DB exercises the same code paths through a local adapter, so the feature set is identical.

---

## Files you'll see appear (and that git ignores)

| File | What it is |
|---|---|
| `backend.log` | stdout/stderr from the backend process |
| `backend.pid` | PID of the running backend, used by `stop` and `restart` |
| `tunnel.log` | stdout/stderr from cloudflared |
| `tunnel.pid` | PID of the running cloudflared tunnel |
| `tunnel.url` | The current `*.trycloudflare.com` URL, refreshed on every restart |

All five are listed in `.gitignore` and will never be committed.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "port 3001 already in use" | Stale backend from a previous run | `bash .runtime/run-persistent.sh stop` then try again |
| "tunnel didn't produce a URL" | cloudflared QUIC blocked by your network | Re-run with `CLOUDFLARED_PROTOCOL=http2 bash .runtime/run-persistent.sh restart`, or skip the tunnel entirely (localhost works) |
| Browser shows old code after a rebuild | The backend serves a prebuilt SPA from `backend/public/dashboard/` | After `npm run build` in `frontend/`, run `cp -r frontend/dist backend/public/dashboard` |
| "test DB doesn't exist" | First-time run on a fresh clone | `bash .runtime/use-data.sh seed-test` |
