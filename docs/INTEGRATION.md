# HighLevel Integration Guide

End-to-end setup for installing the copilot into a HighLevel sub-account.

The integration path is **Marketplace App with OAuth + Custom Pages**. HL auto-provisions a full-page `AI Copilot` tab in every sub-account that installs the app. The dashboard renders inside HL's managed iframe at full width with the location context passed via URL query params.

A per-sub-account **Custom Menu Link** alternative is documented as Option B in Step 7 — useful for developer testing where you want a manual URL override.

> The Custom JS widget shipped in earlier iterations was removed — the 440px slide-in sidebar was too narrow for the multi-column dashboard. Custom Pages embed at full width inside HL's native chrome and are the recommended path for Marketplace App distribution.

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

## Step 7 — Surface the dashboard inside HL

There are two production-shape ways to embed the dashboard inside a sub-account. Custom Pages is the recommended path for Marketplace App distribution; Custom Menu Links is a per-sub-account alternative if you want manual control.

### Option A (recommended) — Custom Pages (Marketplace App)

Custom Pages let a Marketplace App declare a full-page tab that HL auto-provisions inside every sub-account that installs the app. The location admin sees a dedicated `AI Copilot` page in the left nav the moment they install — no manual URL configuration per location.

**How it works at a high level**:

```
1. Marketplace App listing declares a Custom Page URL.
2. Location admin installs the app  →  HL exchanges OAuth code  →  /api/oauth/callback
3. HL automatically provisions a "Custom Page" entry in that sub-account's nav.
4. Admin clicks the tab  →  HL renders an iframe of:
   <your-app>/dashboard/?locationId=<sub_acct>&userId=<u>&companyId=<c>&...
5. Backend reads ?locationId from the URL, looks up the persisted OAuth tokens
   for that location, and serves the SPA. SPA reads ?locationId from
   window.location and uses it as the implicit auth context.
```

**Configure the Custom Page in the Marketplace listing**

1. Go to https://marketplace.gohighlevel.com → your app → **App Settings → Custom Pages**
2. Click **Add Custom Page** and fill in:

   | Field | Value | Notes |
   |---|---|---|
   | **Display name** | `AI Copilot` | What the sub-account user sees in their nav |
   | **Icon** | choose any | Optional |
   | **Custom URL** | `<your-tunnel>/dashboard/` | HL appends `?locationId=…&userId=…&companyId=…` automatically |
   | **Distribution scope** | `Sub-Account` | Must match the OAuth distribution type set in Step 4 |
   | **Sidebar position** | top, middle, or bottom | Visual preference |

3. Save the listing changes.
4. Re-install the app in your sandbox (or wait for HL to rebuild the cache — typically <1 min) so the new Custom Page provisions.
5. Reload your sandbox sub-account → `AI Copilot` appears in the left nav as a top-level tab.

**Why this works without code changes**

The backend already handles the iframe contract that Custom Pages requires:

| Custom Pages requirement | Where it's handled |
|---|---|
| Iframe-friendly CSP (no `X-Frame-Options: DENY`) | `backend/src/app.js:17-21` removes the header and sets `Content-Security-Policy: frame-ancestors *` |
| Accept `?locationId=…` query param | `routes/oauth.js` callback redirects to `/dashboard/?locationId=…`; the SPA pulls `locationId` from `window.location.search` |
| OAuth-installed tokens looked up per location | `HLAuthService.getInstallation(locationId)` resolves the persisted `access_token` / `refresh_token` from `oauth_installations` keyed on `locationId` |
| 401 auto-refresh on stale tokens | `HLVoiceAgentService._request` catches 401, calls `HLAuthService.refreshToken(locationId)`, retries once |
| Same-origin SPA serving (no CORS) | Backend serves the Vue build from `/dashboard` so all `/api/*` calls share origin |

**Verify the Custom Page is live**

```bash
# 1. Confirm an installation exists for the sub-account
curl -s -H "X-API-Key: $API_KEY" "$BACKEND_URL/api/oauth/installations" | jq
# → { "count": 1, "installations": [{ "locationId": "...", "scope": "voice-ai-... ..." }] }

# 2. Hit the dashboard with the location context HL would pass
curl -sI "$BACKEND_URL/dashboard/?locationId=<sub_acct>" | head -5
# Headers should include:
#   content-security-policy: frame-ancestors *
#   (no X-Frame-Options)

# 3. Inside HL, open the AI Copilot tab — the dashboard renders inside the iframe
```

**Tightening security before launch**

The `frame-ancestors *` directive is permissive (suitable for development + this assignment scope). Before public launch, narrow it to HL's domains in `backend/src/app.js`:

```js
res.setHeader('Content-Security-Policy',
  "frame-ancestors https://*.gohighlevel.com https://*.leadconnectorhq.com")
```

This locks the app to only render inside HL's chrome — third-party sites can no longer embed it.

### Option B — Custom Menu Link (manual, per sub-account)

If you don't want to publish the Marketplace App listing change yet — or you need a per-sub-account URL override (different OAuth installation, different tunnel) — Custom Menu Links are the manual alternative.

1. Sandbox sub-account → Settings → **Custom Menu Links → Add Custom Menu Link**
2. **Name**: `AI Copilot`
3. **URL**: `<your-tunnel>/dashboard/?locationId=<this-sub-account-id>`
4. **Open in**: Iframe (keeps it inside HL's chrome)
5. **Icon**: pick anything (📊 works)
6. Save → reload HL → `AI Copilot` appears in the left nav

This is functionally identical from the user's perspective. The only differences are:

| | Custom Pages | Custom Menu Links |
|---|---|---|
| Setup | Configured once in Marketplace listing | Configured per sub-account by the location admin |
| Auto-provisioned on install | ✅ | ❌ (manual step per sub-account) |
| Editable URL per location | ❌ (single URL in listing) | ✅ |
| Best for | Multi-tenant Marketplace App distribution | Single-tenant developer testing, ad-hoc embeds |

For this project's distribution path (Marketplace App), **Custom Pages is recommended**. Custom Menu Links remain useful for local development and the iframe rendering is identical, so a sandbox configured with a Custom Menu Link can be promoted to a Custom Page later without code changes.

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
