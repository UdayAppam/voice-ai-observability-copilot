# HighLevel Integration Guide

End-to-end setup for installing the copilot into a HighLevel sub-account.

The integration path is **Marketplace App with OAuth**. The dashboard is added to HL's left nav as a Custom Menu Link (full-width iframe) — production-shape, multi-tenant ready, no Custom JS injection required.

> The Custom JS widget shipped in earlier iterations was removed — the 440px slide-in sidebar was too narrow for the multi-column dashboard. The OAuth + Custom Menu Link approach embeds the dashboard at full width inside HL's native chrome.

---

## Step 1 — Local quick start (verify before exposing)

```bash
# Backend
cd backend
cp .env.example .env
# Edit .env — set OPENAI_API_KEY (only required var for mock mode)
npm install
npm start                          # → http://localhost:3000

# Frontend (one-time build; backend serves /dashboard from /public)
cd ../frontend
npm install && npm run build
cp -r dist/. ../backend/public/dashboard/

# Open dashboard
open http://localhost:3000/dashboard/
```

The backend auto-seeds 4 mock agents on first start. Click `↻ Sync All` in the UI to trigger ingestion + OpenAI analysis on every call.

---

## Step 2 — Create a HL Developer Sandbox

1. Sign up at the [HighLevel Marketplace Developer Portal](https://marketplace.gohighlevel.com/)
2. Create one sandbox agency account (1 per developer, free, 6-month lifetime)
3. Inside the sandbox, create a **sub-account** — this is where the dashboard will embed
4. Enable **Voice AI** in the sub-account: Settings → Voice AI → Enable
5. Note your `locationId` from the URL bar inside the sub-account (`app.gohighlevel.com/v2/location/<HERE>/...`)

---

## Step 3 — Expose your backend over HTTPS

HighLevel's iframe + OAuth callback require an HTTPS URL it can reach. The repo uses **cloudflared** to expose your local backend without any cloud account.

```bash
# Install (one-time; macOS)
brew install cloudflared
# Linux: download from https://github.com/cloudflare/cloudflared/releases

# Start backend + tunnel together (prompts for live vs test DB)
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

---

## Step 4 — Create the Marketplace App

1. Marketplace Developer Portal → **My Apps → Create App**
2. Auth settings:
   - **Distribution type**: `Sub-Account`
   - **Redirect URI**: `<your-tunnel-url>/api/oauth/callback`
   - **Webhook URL** (optional): `<your-tunnel-url>/api/webhooks/install`
   - **Scopes** (all 3 required for full V4 functionality):
     - `voice-ai-dashboard.readonly` — call logs + transcripts
     - `voice-ai-agents.readonly` — list/read agents
     - `voice-ai-agents.write` — **V4 PATCH writes to update agent prompts**
3. Save → copy the **Client ID** + **Client Secret**

> Without `voice-ai-agents.write`, the V4 one-click Apply flow will fail with HTTP 401 "not authorized for this scope." Read-only features (dashboard, patterns, actions) still work.

---

## Step 5 — Configure backend env

Update `backend/.env`:

```env
# OAuth (from Step 4)
HL_CLIENT_ID=<paste>
HL_CLIENT_SECRET=<paste>
HL_REDIRECT_URI=<your-tunnel-url>/api/oauth/callback
HL_API_BASE=https://services.leadconnectorhq.com
HL_API_VERSION=2023-02-21

# Switch from mock to live HL ingestion
TRANSCRIPT_PROVIDER=highlevel
HL_LOCATION_ID=<your sandbox sub-account locationId>
```

Reload backend:
```bash
bash .runtime/run-persistent.sh reload-backend
```

---

## Step 6 — Install the app in your sandbox

1. Marketplace Developer Portal → your app → **Marketplace Listing** → copy the install URL (or click **Preview Install**)
2. Open that URL in a browser logged into your sandbox sub-account
3. HL asks which sub-account to install into — pick the sandbox sub-account
4. Confirm the scope list — make sure `voice-ai-agents.write` is granted
5. HL redirects to `<your-tunnel>/api/oauth/callback?code=...&locationId=...`
6. Our callback exchanges the code, persists tokens to `oauth_installations`, kicks off initial sync, redirects to `/dashboard/?locationId=...`

Verify:
```bash
curl -s -H 'X-API-Key: <your API_KEY>' <your-tunnel>/api/oauth/installations
# → { "count": 1, "installations": [{ "locationId": "...", "scope": "voice-ai-* ..." }] }
```

---

## Step 7 — Add the dashboard as a Custom Menu Link in HL

1. Sandbox sub-account → Settings → **Custom Menu Links → Add Custom Menu Link**
2. **Name**: `AI Copilot`
3. **URL**: `<your-tunnel>/dashboard/?locationId=<this-sub-account-id>`
4. **Open in**: Iframe (keeps it inside HL's chrome)
5. **Icon**: pick anything (📊 works)
6. Save → reload HL → "AI Copilot" appears in the left nav

The dashboard now lives natively inside HL at full width. Our iframe-friendly CSP headers (`app.js:17-21`) already allow embedding inside HL.

---

## Alternative — Private Integration Token (single-tenant, fastest)

If you're the agent owner and just want to try the read-only Monitor/Analyze flows without setting up a Marketplace App:

1. HL sub-account → **Settings → Private Integrations → Create Token**
2. Add scopes:
   - `voice-ai-dashboard.readonly`
   - `voice-ai-agents.readonly`
   - `voice-ai-agents.write` (only needed for V4 one-click Apply)
3. Copy the `pit-...` token
4. Set in `backend/.env`:
   ```env
   HL_PIT_TOKEN=pit-...
   HL_LOCATION_ID=<your locationId>
   TRANSCRIPT_PROVIDER=highlevel
   # Leave HL_CLIENT_ID + HL_CLIENT_SECRET unset
   ```
5. Reload backend

The provider falls back to PIT auth when no OAuth installation matches the location. Useful for developer testing — not the production path.

> **Most common gotcha:** A PIT without these scopes returns `401 "The token is not authorized for this scope"` on every request. The token itself is valid; it just lacks Voice AI surface access. Recreate the PIT with the right scopes.

---

## Real-time webhook ingestion (optional, V4.5+)

`POST /api/transcripts/ingest` is implemented but the HL webhook subscription isn't wired. To enable push-based ingestion:

1. HL → Webhooks → subscribe to `call.completed` (or equivalent Voice AI event)
2. Target URL: `<your-tunnel>/api/transcripts/ingest`
3. The same `IngestionService` code path serves both polled `Sync All` and webhook ingestion — no code changes required

---

## Security notes

- **`X-API-Key`** is required on all `/api/*` calls except `/api/oauth/*` (HL itself is the caller). Configurable via the `API_KEY` env var.
- **CORS:** none needed when dashboard + API share the same origin (default — backend serves the SPA at `/dashboard`). Dev mode (Vite `:5174` → backend `:3000`) has permissive CORS gated by `NODE_ENV !== 'production'`.
- **Iframe embedding:** Express removes `X-Frame-Options: DENY` and sets `Content-Security-Policy: frame-ancestors *`. Tighten this to `*.gohighlevel.com *.leadconnectorhq.com` for production.
- **SQLite persistence:** the DB file (`backend/data/copilot.db` by default, configurable via `DATABASE_PATH`) must live on a persistent disk. If you host on a platform with ephemeral disks, mount a volume and point `DATABASE_PATH` at it.
- **OAuth token refresh:** access tokens expire after ~24h. `HLVoiceAgentService` auto-refreshes on 401 using the persisted `refresh_token`. If refresh fails (user revoked the app), the V4 apply UI surfaces a re-install prompt.
- **OpenAI key:** stored only in `backend/.env`, never committed. `.env` is in `.gitignore`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 "not authorized for this scope"` from HL | Token missing required scope | Recreate PIT or re-install Marketplace App with the 3 voice-ai scopes |
| OAuth callback `400 Invalid grant: code is invalid` | Auth code already used (browser refresh during install) | Re-trigger install from the Marketplace listing — auth codes are one-shot |
| OAuth callback `400 Invalid locationId or accessToken does not have access` | Got a Company-level token instead of Location | Change app **Distribution type** to `Sub-Account` in Marketplace settings |
| Dashboard loads but "No agents" | Wrong location ID, or no Voice AI agents enabled | Verify `HL_LOCATION_ID`, ensure ≥1 Voice AI agent exists, click `↻ Sync All` |
| V4 Apply button → `DEMO_AGENT` error | You're on test mode — agent IDs are synthetic | `bash .runtime/use-data.sh live` |
| V4 Apply fails with 401 mid-PATCH | OAuth scope missing `voice-ai-agents.write` | Re-install app with all 3 scopes |
| DB resets when host redeploys | Host disk is ephemeral | Mount a persistent volume, point `DATABASE_PATH` at it |
| `429 rate limit exceeded` from OpenAI | Bulk sync hit your OpenAI quota | Wait, or upgrade tier |
| iframe shows "refused to connect" | CSP/X-Frame-Options not removed | Verify backend env loaded; CSP middleware is unconditional |
| Tunnel URL keeps rotating | Free cloudflared tunnels are ephemeral | Use a named cloudflared tunnel, ngrok with a stable domain, or a real host |
