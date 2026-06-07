# Voice AI Observability Copilot

**Repo**: https://github.com/UdayAppam/voice-ai-observability-copilot
**Stable tag**: `v4.1` (one-click apply via HL Voice AI API + customer-meaningful pattern metrics)

An observability + improvement copilot for HighLevel Voice AI agents. Built for the FSB Q226 hiring assignment.

Pulls call transcripts from a HighLevel sub-account (or realistic mock data), scores each call against agent-specific KPIs with OpenAI, surfaces deviations / missed opportunities / hallucinations / required human follow-up, then closes the loop by measuring whether applied recommendations actually moved the score.

The product embeds inside HighLevel via Custom JS (single-tenant) or as a Marketplace App (multi-tenant OAuth).

---

## What it does — the two loops

```
 ┌─────────── MONITOR ──────────┐    ┌──────── ANALYZE ────────┐
 │ HL Voice AI calls            │    │ Per-call KPI scores      │
 │  ─ ingest transcripts        │ →  │  ─ deviations            │ →  Dashboard
 │  ─ link to prompt version    │    │  ─ missed opportunities  │     · /flywheel
 │  ─ score vs agent KPIs       │    │  ─ hallucinations        │     · /patterns
 │                              │    │  ─ recommendations       │     · /actions
 └──────────────────────────────┘    │  ─ "Use Actions"         │     · per-call detail
                                     └──────────────────────────┘
                                                  │
                            ┌─────────────────────┘
                            ▼
        ┌──────────── VALIDATION FLYWHEEL ────────────┐
        │  Recommendation                              │
        │     → human applies prompt change in HL      │
        │     → next sync detects SHA-256 prompt diff  │
        │     → recommendation auto-marked applied     │
        │     → before/after KPI averages computed     │
        │     → "did the fix work?" surfaced           │
        └──────────────────────────────────────────────┘
```

Monitor + Analyze are the FSB Core Functionality. The Validation Flywheel is the framing requirement — implemented as actual causal measurement, not a metaphor.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vue 3 (Composition API) + Vite + Pinia + Vue Router + Tailwind + ApexCharts | Pinned by FSB requirement |
| Backend | Node.js 20 + Express 4 | Pinned by FSB requirement |
| Database | SQLite via Node's built-in `node:sqlite` (WAL mode) | Zero native deps; ships with Node 22.5+ |
| AI | OpenAI `gpt-4o-mini` with `response_format: json_schema` + `strict: true` | Structured output, no parsing fragility, cheap |
| Logging | pino (structured JSON) | Production-grade |
| HL integration | Marketplace App OAuth — dashboard embeds as Custom Menu Link in HL nav | Production-shape integration, full-width iframe |
| Deploy | Local Node + cloudflared tunnel for HL-facing HTTPS; any Node host works | No cloud lock-in; persistent disk required for SQLite |

---

## What's functional vs mocked

| Capability | Status |
|---|---|
| HighLevel transcript ingestion (`/voice-ai/agents`, `/voice-ai/dashboard/call-logs`) | **Live** — `HighLevelTranscriptProvider` |
| Mock transcript ingestion (4 agents × ~10 calls with realistic failures) | **Live** — `MockTranscriptProvider`, used when `TRANSCRIPT_PROVIDER=mock` |
| OpenAI per-call analysis (6 KPIs + deviations + missed + Use Actions + hallucinations) | **Live** |
| Per-agent KPI definitions with weights + thresholds | **Live** — editable via UI |
| Prompt-version tracking (SHA-256 of prompt+goal) | **Live** — detected on every Sync All |
| Recommendation lifecycle (`active → applied → measured`) | **Live** — auto-applied when prompt change is detected |
| Causal before/after measurement of applied recommendations | **Live** |
| Cross-agent failure pattern clustering | **Live** — `cluster_key` dedup |
| Use Action queue with `resolve / dismiss / escalate` verbs | **Live** |
| Hallucination detection (7th validator) | **Live** — empty arrays on clean transcripts (not a bug) |
| Deterministic per-stage narratives (what / why / evidence / action) | **Live** — no extra OpenAI cost |
| OAuth Marketplace install flow (`/api/oauth/callback`) | **Live** — per-location tokens persisted |
| **V4 — One-click apply: writes recommendation directly to HL Voice AI agent via PATCH** | **Live** — `HLVoiceAgentService` + `ApplyRecommendationService`. Verified by 27/27 live regression assertions against the HL sandbox |
| **V4 — Editable diff modal: user can tune the AI suggestion before commit** | **Live** — debounced 300ms validators re-run on every keystroke; Confirm button label switches between `Apply AI suggestion` and `Apply your edit` |
| **V4 — Pre-apply validator pipeline (5 validators)** | **Live** — template vars / length / tone / forbidden content / call-length impact. Blocking failures disable Confirm |
| **V4 — Snapshot-based rollback (HL has no native versioning)** | **Live** — previous `agentPrompt` snapshotted before every PATCH; one-click revert |
| **V4 — Apply audit trail (`apply_attempts` table)** | **Live** — every Apply + Rollback logged with timeline, diff, edit metadata, user email |
| **V4 — Idempotency on double-click** | **Live** — second Apply within 5min returns cached receipt (skipped if rec is no longer `applied`) |
| **V4 — Edit-summary LLM call** (one-line "what the user changed") | **Live** — powers receipt panel + future product-intelligence metrics |
| **V4.1 — Pattern metrics: "Detected in N calls · M failed · last 4h ago · recurring"** | **Live** — replaces engineering occurrence_count with distinct-call math via `recommendation_calls` join table |
| Real-time webhook ingestion | Endpoint exists (`POST /api/transcripts/ingest`); HL webhook not wired |
| Multi-sub-account agency rollups | Out of scope per FSB ("single sub-account") |

---

## Quick start

### Option A — Mock data (zero HL or cloud setup)

```bash
git clone <repo-url>
cd voice-ai-copilot

# Backend
cd backend
cp .env.example .env             # set OPENAI_API_KEY at minimum
npm install
npm start                        # → http://localhost:3000 (auto-seeds mock data)

# Frontend (built once, served from backend at /dashboard)
cd ../frontend
npm install && npm run build
cp -r dist/. ../backend/public/dashboard/

open http://localhost:3000/dashboard/
```

The first start auto-seeds 4 mock Voice AI agents with realistic transcripts (lead-gen, legal intake, medical screening, appointment booking). Click `↻ Sync All` in the UI to trigger ingestion + analysis on every call.

### Option B — Live HighLevel sub-account

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the full walkthrough (sandbox creation, PIT scopes, OAuth Marketplace App install, cloudflared exposure, dashboard as Custom Menu Link in HL nav).

---

## Repository layout

```
.
├── README.md                       ← you are here
├── docs/
│   ├── ARCHITECTURE.md             ← system design + decisions
│   ├── IMPLEMENTATION_PLAN.md      ← what shipped + future roadmap
│   ├── DATA_MODEL.md               ← SQLite schema + lifecycle states
│   ├── API_SPEC.md                 ← every REST endpoint + payloads
│   ├── INTEGRATION.md              ← HL sandbox + cloudflared exposure + Marketplace App install
│   ├── DEMO_SCRIPT.md              ← Loom recording walkthrough
│   ├── V4_PLAN.md                  ← V4 design — one-click apply via HL Voice AI API (shipped)
│   └── V4_API_DISCOVERY.md         ← HL API findings that grounded V4's architecture
├── backend/
│   ├── src/
│   │   ├── app.js                  ← Express app + route mounting
│   │   ├── db/{schema.sql, database.js}
│   │   ├── routes/                 ← 9 route files (REST API)
│   │   ├── services/               ← 6 services (Analysis, Narrative, Recommendation, PromptVersion, Ingestion, HLAuth)
│   │   ├── providers/              ← Adapter pattern: Mock + HighLevel
│   │   └── middleware/             ← auth, errorHandler
│   ├── scripts/
│   │   ├── seed.js, analyzeAll.js, backfill*.js
│   │   └── regression/             ← scenario suite (seed + verify, ~$0.10/run)
│   └── public/dashboard/           ← built Vue SPA (served at /dashboard)
├── frontend/
│   └── src/
│       ├── App.vue, main.js
│       ├── router/                 ← 7 routes
│       ├── stores/                 ← Pinia (agentStore, callStore)
│       ├── views/                  ← 7 page views
│       ├── components/             ← 25 components
│       └── api/client.js           ← axios singleton w/ X-API-Key
└── .runtime/
    ├── run-persistent.sh           ← starts backend + cloudflared tunnel
    └── use-data.sh                 ← switch DATABASE_PATH between live + test DBs
```

---

## Team of One ownership

Built solo across all four FSB roles. Decisions made:

**Product** — chose the agency-owner persona (not end-caller, not single-agent operator), which drove top-nav IA: Overview / Flywheel / Patterns / Actions. Each tab maps to a daily task. Cut the AI-suggested-KPI auto-generation feature in favor of manual per-agent override — same value at 10× lower cost/risk. Recommendation lifecycle `active → applied → measured` chosen because the agency owner's question is "did my fix work?" not "what fix exists?".

**Design** — embraced HighLevel's design tokens (`#0066FF` primary), iframe-first sidebar layout so the dashboard never competes with HL's own chrome, narratives in plain English with a consistent **what / why / evidence / action** format on every Flywheel stage card. Status colors are semantic (pass=green, warning=amber, fail=red) and reused everywhere.

**Engineering** — adapter pattern for transcript providers (Mock vs HighLevel) so the same code path drives both; OpenAI `response_format: json_schema` with `strict: true` so we never parse free-form JSON; "trust LLM for semantic, backend for arithmetic" — `overall_score` is recomputed deterministically from `Σ(kpi_score × weight)`; SHA-256 prompt-version detection for causal before/after measurement; OAuth Marketplace App with auto-refresh + V4 PATCH writes to HL Voice AI agents; same-origin SPA serving so no CORS in prod.

**QA** — additive-only schema migrations with `columnExists` guards; lint must pass zero warnings before any deploy; manual smoke-test matrix (all SPA routes + all API endpoints + each Action verb + KPI weight validation edge cases); deterministic narrative service so every dashboard claim is reproducible from DB state.

---

## Architecture in 30 seconds

```
HighLevel Sub-Account
  └── "AI Copilot" Custom Menu Link (full-width iframe)
        └── Vue.js SPA → axios → Express API (same origin)
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
        Transcript Provider          OpenAI Analysis           SQLite (10 tables,
        (Mock or HighLevel)        (json_schema strict)        WAL, node:sqlite)
                                         │
                       ┌─────────────────┼─────────────────┐
                       ▼                 ▼                 ▼
              Recommendation         Prompt Version       Narrative
                  Service               Service           Service
                       │
                       ▼
              V4: HLVoiceAgentService → PATCH /voice-ai/agents/:id
              (one-click apply + snapshot-based rollback)
```

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Demo

2-5 min Loom recording walkthrough script: [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

---

## Status

| | |
|---|---|
| Backend lint | 0 errors, 0 warnings |
| Frontend lint | 0 errors, 0 warnings |
| Frontend build | clean (`✓ built`) |
| All SPA routes | HTTP 200 |
| All API endpoints | HTTP 200 |
| Code size | ~4,055 LOC backend · ~4,068 LOC frontend |
