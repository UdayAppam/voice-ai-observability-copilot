# Voice AI Observability Copilot

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
| HL integration | Custom JS widget + Marketplace OAuth | Both flows shipped |
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
| Custom JS widget (floating button + slide-in iframe) | **Live** |
| OAuth Marketplace install flow (`/api/oauth/callback`) | **Live** — per-location tokens persisted |
| Real-time webhook ingestion | Endpoint exists (`POST /api/transcripts/ingest`); HL webhook not wired |
| Auto-write recommendation back to HL agent prompt | **Not shipped** — explicit out-of-scope for V3 (manual paste-in workflow) |
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

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the full walkthrough (sandbox creation, PIT scopes, OAuth Marketplace App setup, cloudflared exposure, Custom JS install).

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
│   ├── INTEGRATION.md              ← HL sandbox + cloudflared exposure + widget install
│   ├── DEMO_SCRIPT.md              ← Loom recording walkthrough
│   └── V4_PLAN.md                  ← post-FSB roadmap: one-click apply via HL Agent Studio API
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
├── highlevel-embed/
│   ├── widget.js                   ← Custom JS for HL Settings → Custom JS
│   └── test-harness.html           ← local HL-like host page for widget development
└── .runtime/
    ├── run-persistent.sh           ← starts backend + cloudflared tunnel
    └── use-data.sh                 ← switch DATABASE_PATH between live + test DBs
```

---

## Team of One ownership

Built solo across all four FSB roles. Decisions made:

**Product** — chose the agency-owner persona (not end-caller, not single-agent operator), which drove top-nav IA: Overview / Flywheel / Patterns / Actions. Each tab maps to a daily task. Cut the AI-suggested-KPI auto-generation feature in favor of manual per-agent override — same value at 10× lower cost/risk. Recommendation lifecycle `active → applied → measured` chosen because the agency owner's question is "did my fix work?" not "what fix exists?".

**Design** — embraced HighLevel's design tokens (`#0066FF` primary), iframe-first sidebar layout so the dashboard never competes with HL's own chrome, narratives in plain English with a consistent **what / why / evidence / action** format on every Flywheel stage card. Status colors are semantic (pass=green, warning=amber, fail=red) and reused everywhere.

**Engineering** — adapter pattern for transcript providers (Mock vs HighLevel) so the same code path drives both; OpenAI `response_format: json_schema` with `strict: true` so we never parse free-form JSON; "trust LLM for semantic, backend for arithmetic" — `overall_score` is recomputed deterministically from `Σ(kpi_score × weight)`; SHA-256 prompt-version detection for causal before/after measurement; pushState-aware Custom JS widget that survives HL's SPA navigation; same-origin SPA serving so no CORS in prod.

**QA** — additive-only schema migrations with `columnExists` guards; lint must pass zero warnings before any deploy; manual smoke-test matrix (all SPA routes + all API endpoints + each Action verb + KPI weight validation edge cases); deterministic narrative service so every dashboard claim is reproducible from DB state.

---

## Architecture in 30 seconds

```
HighLevel Sub-Account
  └── Custom JS widget injects floating button
        └── Click → 440px slide-in iframe
              └── Vue.js SPA → axios → Express API (same origin)
                                          │
                       ┌──────────────────┼──────────────────┐
                       ▼                  ▼                  ▼
                  Transcript          OpenAI            SQLite (9 tables,
                  Provider           Analysis           WAL, node:sqlite)
                 (Mock or HL)    (json_schema strict)
                                       │
                              ┌────────┼────────┐
                              ▼        ▼        ▼
                       Recommendation  Prompt   Narrative
                          Service     Version   Service
                                      Service  (deterministic)
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
