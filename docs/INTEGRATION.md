# HighLevel Integration Guide

How to install the copilot in a HighLevel sub-account end-to-end. Two paths: **Custom JS widget** (fastest, single tenant) or **Marketplace App OAuth** (multi-tenant, production-shaped). Both are implemented and shipped.

---

## Path A — Custom JS widget (fastest, single sub-account)

This is the minimum viable install. The widget injects a floating button into HL; clicking opens a 440px slide-in iframe that loads the dashboard from your deployed backend.

### Step 1 — Local Quick Start (verify before deploying)

```bash
# 1. Backend
cd backend
cp .env.example .env
# edit .env: set OPENAI_API_KEY (only required var for mock mode)
npm install
npm start                          # → http://localhost:3000

# 2. Frontend (one-time build; backend serves /dashboard from /public)
cd ../frontend
npm install && npm run build
cp -r dist/. ../backend/public/dashboard/

# 3. Open dashboard
open http://localhost:3000/dashboard/
```

The backend auto-seeds 4 mock agents on first start. Click `↻ Sync All` in the UI to trigger ingestion + OpenAI analysis on every call.

### Step 2 — Verify the widget locally (no HL access needed)

```bash
cd highlevel-embed
python3 -m http.server 8000
open http://localhost:8000/test-harness.html
```

The test harness simulates HL's chrome (left nav, dark header, SPA navigation via `history.pushState`). The widget mounts inside it. Verify:
1. "AI Copilot" button appears bottom-right
2. Click → 440px sidebar slides in with the dashboard
3. Click any simulated HL nav link → widget survives the SPA route change (the `pushState`/`popstate` hooks)
4. Escape or click the backdrop → sidebar closes

If this works, the real HL install will work.

### Step 3 — Create a HL Developer Sandbox

1. Sign up at the [HighLevel Marketplace Developer Portal](https://marketplace.gohighlevel.com/)
2. Create one sandbox agency account (1 per developer, free, 6-month duration)
3. Inside the sandbox, create a **sub-account** — this is where the widget embeds
4. Enable **Voice AI** in the sub-account: Settings → Voice AI → Enable

### Step 4 — Expose the local backend over HTTPS

HighLevel's Custom JS iframe + OAuth callback require an HTTPS URL it can reach. The repo uses **cloudflared** to expose your local backend to the internet without any cloud account.

```bash
# Install (one-time; macOS)
brew install cloudflared
# or Linux: download from https://github.com/cloudflare/cloudflared/releases

# Start backend + tunnel together
bash .runtime/run-persistent.sh

# Prints a URL like:
#   PUBLIC URL: https://<random-words>.trycloudflare.com
```

Verify:
```bash
curl https://<your-tunnel>.trycloudflare.com/health
# → {"status":"ok","db":"connected","timestamp":"..."}
```

> **Tunnel caveats:** the URL changes every time cloudflared restarts. For a stable demo URL, use a cloudflared named tunnel (`cloudflared tunnel create copilot-demo`) or any HTTPS reverse proxy (ngrok, your own VPS). For real production, host the backend on any Node-friendly platform and put HTTPS in front of it.

### Step 5 — Inject Custom JS into HighLevel

1. Open `highlevel-embed/widget.js`, update the `BACKEND_URL` constant (line ~19) to your tunnel URL
2. In the HL sub-account: **Settings → Custom JS & CSS → Custom JS**
3. Paste the entire `widget.js` content
4. Save → reload any HL page

The "AI Copilot" button should now appear bottom-right on every HL page in that sub-account.

### Step 6 — Switch to live HL transcripts

Until now you're running on mock data. To pull real Voice AI transcripts:

#### 6a. Create a Private Integration Token (PIT)
1. HL sub-account → **Settings → Private Integrations → Create Token**
2. Add **both** scopes:
   - `voice-ai-dashboard.readonly`
   - `voice-ai-agents.readonly`
3. Copy the `pit-...` token

> **Most common gotcha:** A PIT without these scopes returns `401 "The token is not authorized for this scope"` on every call. The token is valid — it just can't see the Voice AI surface. Add scopes, create a fresh token.

#### 6b. Find your Location ID
HL → **Settings → Business Profile** — the URL contains your `locationId`:
```
/v2/location/aBcDeF12345/settings/business-profile
              └── this is your locationId
```

#### 6c. Configure
Update `backend/.env`:
```env
TRANSCRIPT_PROVIDER=highlevel
HL_PIT_TOKEN=pit-...
HL_LOCATION_ID=aBcDeF12345
```

Reload the backend (`bash .runtime/run-persistent.sh reload-backend`). Next `↻ Sync All` pulls real agents + transcripts from your sub-account.

#### 6d. Verify the token + scopes independently
```bash
curl -H "Authorization: Bearer $HL_PIT_TOKEN" \
     -H "Version: 2023-02-21" \
     "https://services.leadconnectorhq.com/voice-ai/agents?locationId=$HL_LOCATION_ID"
# → 200 OK with an array of agents (not 401)
```

---

## Path B — Marketplace App with OAuth (multi-tenant)

Use this path if you want the app to "reside within the customer account" per FSB language, supporting multiple sub-accounts installing it. The OAuth callback handler is implemented and the `oauth_installations` table persists per-location tokens.

### Step 1 — Create the Marketplace App

1. [Marketplace Developer Portal](https://marketplace.gohighlevel.com/) → **My Apps → Create App**
2. Auth settings:
   - **Distribution type**: Sub-Account
   - **Redirect URI**: `<your-tunnel-url>/api/oauth/callback`
   - **Scopes**: `voice-ai-dashboard.readonly`, `voice-ai-agents.readonly`
3. Save → note the **Client ID** + **Client Secret**

### Step 2 — Configure backend env

```env
HL_CLIENT_ID=...
HL_CLIENT_SECRET=...
HL_REDIRECT_URI=<your-tunnel-url>/api/oauth/callback
HL_API_BASE=https://services.leadconnectorhq.com
HL_API_VERSION=2023-02-21
```

Redeploy.

### Step 3 — Install in a sub-account

1. Marketplace → your app → **Install** → pick a sub-account
2. HL redirects to `<HL_REDIRECT_URI>?code=...&locationId=...`
3. `/api/oauth/callback` exchanges the code, persists tokens to `oauth_installations`, kicks off initial transcript sync, redirects to `/dashboard/?locationId=...`

### Step 4 — Add the dashboard as a Custom Page

The Marketplace App approach lets you add the dashboard URL directly as a sub-account **Custom Menu Link** instead of relying on Custom JS:

1. Sub-account: Settings → Custom Menu Links → Add
2. URL: `<your-backend>/dashboard/?locationId=<this-location>`
3. Save → the dashboard now lives in HL's left nav

---

## Real-time webhook ingestion (optional)

`POST /api/transcripts/ingest` is implemented for webhook-driven ingestion. To wire it up:

1. HL → Webhooks → subscribe to `call.completed` (or equivalent Voice AI event)
2. Target URL: `https://<your-backend>/api/transcripts/ingest`
3. The same `IngestionService.ingestOne()` path that powers Sync All handles the payload — no code changes needed

This converts Sync All from a pull-on-demand model to push-on-event.

---

## Security notes

- **API key visibility:** the `X-API-Key` header is hardcoded into `widget.js` (client-side JS). The key is visible in the browser source. Acceptable for the FSB single-sub-account scope. The Marketplace App path (Path B) replaces this with OAuth tokens scoped per location.
- **CORS:** none needed when dashboard + API share the same origin (default — backend serves the SPA at `/dashboard`). Dev mode (Vite `:5174` → backend `:3000`) has permissive CORS gated by `NODE_ENV !== 'production'`.
- **Iframe embedding:** Express removes `X-Frame-Options: DENY` and sets `Content-Security-Policy: frame-ancestors *`. Tighten this to `*.gohighlevel.com *.leadconnectorhq.com` for production.
- **SQLite persistence:** the DB file (`backend/data/copilot.db` by default, configurable via `DATABASE_PATH`) must live on a persistent disk. If you host on a platform with ephemeral disks, mount a volume and point `DATABASE_PATH` at it.
- **OpenAI key:** stored only in `backend/.env`, never committed. `.env` is in `.gitignore`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 The token is not authorized for this scope` from HL | PIT created without Voice AI scopes | Recreate PIT with `voice-ai-dashboard.readonly` + `voice-ai-agents.readonly` |
| Widget button doesn't appear in HL | Custom JS pasted into Custom CSS, or saved without enabling | Re-paste into Custom **JS** field, save, reload |
| Dashboard loads but shows "No agents" | Wrong location ID or no Voice AI agents created in sub-account | Verify location ID, ensure ≥1 Voice AI agent exists, click Sync All |
| DB resets when host redeploys | Host disk is ephemeral | Mount a persistent volume, point `DATABASE_PATH` at it (e.g. `/data/copilot.db`) |
| `429 rate limit exceeded` from OpenAI | Bulk sync hit OpenAI quota | Wait, or lower OpenAI tier rate limits in Settings |
| iframe shows "refused to connect" | CSP/X-Frame-Options not removed | Verify backend env `NODE_ENV` is set; the iframe-friendly headers middleware runs unconditionally |
