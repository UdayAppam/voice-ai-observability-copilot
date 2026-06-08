# Voice Agent Flywheel

**Repo**: https://github.com/UdayAppam/voice-agent-flywheel
**Stable tag**: `v4.7` (section-focused editor + word-level diff highlighting in Apply modal)

An observability + improvement copilot for HighLevel Voice AI agents. Built for the FSB Q226 hiring assignment.

Pulls call transcripts from a HighLevel sub-account (or realistic mock data), scores each call against agent-specific KPIs with OpenAI, surfaces deviations / missed opportunities / hallucinations / required human follow-up, then closes the loop by **causally measuring** whether applied recommendations actually moved the score.

The product embeds inside HighLevel via Marketplace App OAuth (Custom Menu Link in the HL nav).

---

## What it does — the two loops

```
 ┌─────────── MONITOR ──────────┐    ┌──────── ANALYZE ────────┐
 │ HL Voice AI calls            │    │ Per-call KPI scores      │
 │  ─ ingest transcripts        │ →  │  ─ deviations            │ →  Dashboard
 │  ─ link to prompt version    │    │  ─ missed opportunities  │     · /flywheel  (story + action heroes)
 │  ─ score vs agent KPIs       │    │  ─ hallucinations        │     · /patterns  (per-agent rollup)
 │                              │    │  ─ recommendations       │     · /actions
 └──────────────────────────────┘    │  ─ "Use Actions"         │     · per-call detail
                                     └──────────────────────────┘
                                                  │
                            ┌─────────────────────┘
                            ▼
        ┌──────────── VALIDATION FLYWHEEL ────────────┐
        │  Recommendation                              │
        │     → V4 one-click apply (PATCH HL agent)    │  ← writes back to HighLevel
        │     → new prompt_version recorded            │  ← V4.3 fix: was silently broken
        │     → next call ingested under new version   │  ← automatic
        │     → before/after KPI delta computed        │  ← significance: Δ≥2 AND n≥3
        │     → "leak" vs "waiting" classified         │  ← V4.4: doesn't cry wolf
        └──────────────────────────────────────────────┘
```

Monitor + Analyze are the FSB Core Functionality. The Validation Flywheel is the framing requirement — implemented as **actual causal measurement** with significance thresholds, not a metaphor.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vue 3 (Composition API) + Vite + Pinia + Vue Router + Tailwind + ApexCharts | Pinned by FSB requirement |
| Backend | Node.js 20+ + Express 4 | Pinned by FSB requirement |
| Database | SQLite via Node's built-in `node:sqlite` (WAL mode) | Zero native deps; ships with Node 22.5+ |
| AI | OpenAI `gpt-4o-mini` with `response_format: json_schema` + `strict: true` | Structured output, no parsing fragility, cheap |
| Logging | pino (structured JSON) | Production-grade |
| HL integration | Marketplace App OAuth — dashboard embeds as Custom Menu Link in HL nav | Production-shape integration, full-width iframe |
| Deploy | Local Node + cloudflared tunnel for HL-facing HTTPS; any Node host works | No cloud lock-in; persistent disk required for SQLite |

---

## What's functional vs mocked

### Core (V1–V3)
| Capability | Status |
|---|---|
| HighLevel transcript ingestion (`/voice-ai/agents`, `/voice-ai/dashboard/call-logs`) | **Live** — `HighLevelTranscriptProvider` |
| Mock transcript ingestion (4 agents × ~10 calls with realistic failures) | **Live** — `MockTranscriptProvider`, used when `TRANSCRIPT_PROVIDER=mock` |
| OpenAI per-call analysis (6 KPIs + deviations + missed + Use Actions + hallucinations) | **Live** |
| Per-agent KPI definitions with weights + thresholds | **Live** — editable via UI |
| Prompt-version tracking (SHA-256 of prompt+goal) | **Live** — detected on every Sync All |
| Hallucination detection — "unverified claims by agent" UI (7th validator) | **Live** — structured "what said / why flagged / why it matters / what to do" |
| Cross-agent failure pattern clustering | **Live** — `cluster_key` dedup |
| Use Action queue with `resolve / dismiss / escalate` verbs | **Live** |
| Marketplace App OAuth (`/api/oauth/callback`) | **Live** — per-location tokens persisted |

### V4 — Apply loop
| Capability | Status |
|---|---|
| **V4 — One-click apply via PATCH to HL Voice AI** | **Live** — `HLVoiceAgentService` + `ApplyRecommendationService`. 27/27 regression assertions against the HL sandbox |
| **V4 — Editable diff modal with debounced (300ms) live validators** | **Live** — Confirm button label switches between `Apply AI suggestion` and `Apply your edit` |
| **V4 — Pre-apply validator pipeline (7 validators)** | **Live** — template vars / length / tone / forbidden / call-length / section-fit / context consistency. Blocking failures disable Confirm |
| **V4 — Snapshot-based rollback** | **Live** — previous prompt snapshotted before every PATCH; one-click revert |
| **V4 — Apply audit trail (`apply_attempts` table)** | **Live** — every Apply/Rollback logged with timeline, diff, edit metadata, user email |
| **V4 — Idempotency on double-click** | **Live** — second Apply within 5min returns cached receipt |
| **V4.1 — Pattern metrics: "Detected in N calls · M failed · last 4h ago · recurring"** | **Live** — distinct-call math via `recommendation_calls` join |
| **V4.2 — Section-aware prompt insertion** | **Live** — LLM parses prompt into named sections (cached in `agent_prompt_structure`), picks WHICH section the fix belongs in instead of blindly appending |
| **V4.2 — Context-consistency validator** | **Live** — separate LLM call compares modified vs original prompt for contradictions / tone drift / scope creep / sequencing / redundancy / variable mismatch; quotes conflicting phrases |
| **V4.6 — Section structure visibility + manual override + focused diff** | **Live** — Apply modal now shows the full collapsible "all N sections in this agent's prompt" list with the AI-picked target highlighted; user can override the section via dropdown (silent re-fetch with `?targetSectionId=`); section-only before/after diff panel above the full-prompt diff. Backend `proposeInsertion` accepts `forcedSectionId` to skip selection and modify the chosen section instead. |
| **V4.7 — Section-focused editor + word-level diff highlighting** | **Live** — Apply modal default editor surface is now the **section being modified** (not the whole 5000-char prompt). Editing happens against ~500-char focused textarea; on Apply the section is spliced back into the original prompt. Word-level diff highlighting (green for added, red strikethrough for removed) shown in the section-only preview AND in the full-prompt expand view. "⤢ Edit whole prompt instead" toggle for power users. Falls back to whole-prompt editor automatically when section-aware path can't apply. Uses `diff` (Myers algorithm). |
| **V4.3 — Apply→Measurement chain fix (critical bug fix)** | **Live + verified** — `ApplyRecommendationService` now records new `prompt_version` and sets `applied_prompt_version_id` so `computePendingOutcomes` can match calls to recs. Was silently broken; never measured anything. Proven end-to-end against live HL data. |
| **V4.4 — Flywheel correctness (math + framing)** | **Live** — window-scoped all funnel queries, significance threshold (Δ≥2 AND n≥3), leak-vs-waiting classification, "vs prior 7d" anchors, real `avgDaysIssueToFix` replaces fake "manual review hours saved" |
| **V4.4 — Flywheel UI redesign (2-hero focus)** | **Live** — hero metric + one-line lifecycle sentence + dominant "next best action" callout + collapsible drill-in for funnel/cards |
| **V4.5 — Semantic dedup in `persistFromAnalysis`** | **Live** — batched LLM pass catches `"Capture Caller Details" ≈ "Capture Caller Information"` style duplicates before insert. Async, graceful no-op without `OPENAI_API_KEY`. |
| **V4.5 — Patterns API per-agent rollup + UI split** | **Live** — `/api/patterns` exposes `agentRollup.applyState` (`all_applied / partial / not_started`) + lists `agentsApplied[]` + `agentsStillActive[]`. PatternCard shows "Applied 1/2 · 1 still needed" pill + splits expanded view into "Still needs apply" + "Already applied" sections. |
| **V4.5 — Dark theme readability (WCAG AA tokens)** | **Live** — `text-muted` lifted from `#6B7493` (3.0–4.1:1) → `#8B95B8` (4.7–6.4:1); new `accent-primary-text` / `accent-secondary-text` / `fail-text` token variants for text-on-card uses |

### Out of scope (deliberate)
| Capability | Why |
|---|---|
| Real-time webhook ingestion | Endpoint exists (`POST /api/transcripts/ingest`); HL webhook not wired |
| Multi-sub-account agency rollups | Out of scope per FSB ("single sub-account") |

---

## Quick start

### Option A — Mock data (zero HL or cloud setup)

```bash
git clone https://github.com/UdayAppam/voice-agent-flywheel.git
cd voice-agent-flywheel

# Backend
cd backend
cp .env.example .env             # set OPENAI_API_KEY at minimum
npm install
npm start                        # → http://localhost:3001 (auto-seeds mock data)

# Frontend (built once, served from backend at /dashboard)
cd ../frontend
npm install && npm run build
rm -rf ../backend/public/dashboard && cp -r dist ../backend/public/dashboard

open http://localhost:3001/dashboard/
```

The first start auto-seeds 4 mock Voice AI agents with realistic transcripts. Click `↻ Sync All` in the UI to trigger ingestion + analysis on every call.

### Option B — Live HighLevel sub-account

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the full walkthrough (sandbox creation, PIT scopes, OAuth Marketplace App install, cloudflared exposure, dashboard as Custom Menu Link).

### One-command persistent server (backend + tunnel)

```bash
bash .runtime/run-persistent.sh                  # interactive: prompts for live/test
bash .runtime/run-persistent.sh restart --db=live  # skip prompt
bash .runtime/run-persistent.sh restart --db=test  # seeded flywheel demo state
bash .runtime/run-persistent.sh stop
bash .runtime/use-data.sh test|live              # toggle DB without restart
```

---

## Repository layout

```
.
├── README.md                       ← you are here
├── docs/
│   ├── ARCHITECTURE.md             ← system design + decisions (incl. V4.3–V4.5)
│   ├── IMPLEMENTATION_PLAN.md      ← what shipped + future roadmap
│   ├── DATA_MODEL.md               ← SQLite schema + lifecycle states
│   ├── API_SPEC.md                 ← every REST endpoint + payloads
│   ├── INTEGRATION.md              ← HL sandbox + cloudflared + Marketplace App install
│   ├── DEMO_SCRIPT.md              ← Loom recording walkthrough
│   ├── V4_PLAN.md                  ← V4 design — one-click apply (shipped)
│   └── V4_API_DISCOVERY.md         ← HL API findings that grounded V4
├── backend/
│   ├── src/
│   │   ├── app.js                  ← Express app + route mounting
│   │   ├── db/{schema.sql, database.js}
│   │   ├── routes/                 ← 10 route files (REST API + OAuth)
│   │   ├── services/               ← 10 services (Analysis, Narrative, Recommendation,
│   │   │                              PromptVersion, Ingestion, HLAuth, HLVoiceAgent,
│   │   │                              ApplyRecommendation, EditSummary, PromptStructure,
│   │   │                              RecommendationValidator)
│   │   ├── providers/              ← Adapter pattern: Mock + HighLevel
│   │   └── middleware/             ← auth, errorHandler
│   ├── scripts/
│   │   ├── seed.js, analyzeAll.js, backfillRecommendations.js
│   │   └── regression/             ← scenario suite + v4-apply + v4-2-validators
│   └── public/dashboard/           ← built Vue SPA (served at /dashboard)
├── frontend/
│   └── src/
│       ├── App.vue, main.js, style.css (Tailwind base + components)
│       ├── router/                 ← 7 routes
│       ├── stores/                 ← Pinia (agentStore, callStore)
│       ├── views/                  ← 7 page views
│       ├── components/             ← 30+ components
│       └── api/client.js           ← axios singleton w/ X-API-Key
└── .runtime/
    ├── run-persistent.sh           ← starts backend + cloudflared tunnel
    └── use-data.sh                 ← switch DATABASE_PATH between live + test DBs
```

---

## Team of One ownership

Built solo across all four FSB roles. Decisions made:

**Product** — chose the agency-owner persona (not end-caller, not single-agent operator), which drove top-nav IA: Overview / Flywheel / Patterns / Actions. Each tab maps to a daily task. Cut the AI-suggested-KPI auto-generation feature in favor of manual per-agent override — same value at 10× lower cost/risk. Recommendation lifecycle `active → applied → measured` chosen because the agency owner's question is "did my fix work?" not "what fix exists?". The Flywheel page was redesigned mid-build into **2 dominant heroes + opt-in drill-in** after PM-grade self-critique — the original 5-card layout was a wall of numbers; the new layout answers "is this healthy?" and "what should I do?" in 3 seconds.

**Design** — embraced HighLevel's design tokens, iframe-first layout so the dashboard never competes with HL's own chrome, narratives in plain English with consistent **what / why / evidence / action** format on every Flywheel stage card. Status colors are semantic (pass=green, warning=amber, fail=red) and reused everywhere. Dark theme audited for WCAG AA contrast — every text token now passes 4.5:1 minimum against every surface.

**Engineering** — adapter pattern for transcript providers (Mock vs HighLevel) so the same code path drives both; OpenAI `response_format: json_schema` with `strict: true` so we never parse free-form JSON; "trust LLM for semantic, backend for arithmetic" — `overall_score` is recomputed deterministically from `Σ(kpi_score × weight)`; SHA-256 prompt-version detection for causal before/after measurement; OAuth Marketplace App with auto-refresh + V4 PATCH writes to HL Voice AI agents; same-origin SPA serving so no CORS in prod. Caught and fixed a silent V4 bug where `applied_prompt_version_id` was never set, breaking the measurement chain — found by walking the data from DB up to UI as PM-style audit.

**QA** — additive-only schema migrations with `columnExists` guards; lint must pass zero warnings before any deploy; regression suite covers V4 apply + V4.2 section-aware insertion (3 scenarios: contradiction, tone-drift, clean merge, 14/14 assertions passing); end-to-end verification of the V4.3 measurement bug fix proven on live HL data; deterministic narrative service so every dashboard claim is reproducible from DB state.

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
              ┌──────────────────────────┼──────────────────────────┐
              ▼                          ▼                          ▼
       Recommendation              Prompt Version              Narrative
          Service                      Service                  Service
       (+ semantic dedup)
              │
              ▼
       ApplyRecommendationService
              │
              ▼
       HLVoiceAgentService → PATCH /voice-ai/agents/:id
       + records new prompt_version + sets applied_prompt_version_id
       + computePendingOutcomes runs at end of next analysis (automatic)
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
| V4 apply regression | 27/27 assertions ✓ (live HL sandbox) |
| V4.2 validator regression | 14/14 assertions ✓ (contradiction + tone drift + clean merge) |
| V4.3 measurement chain | Verified end-to-end on live HL data |
| V4.6 section override | Verified end-to-end (force `persona` → LLM modifies Persona instead of `Information Gathering`) |
| V4.7 section-focused editor | Builds clean; section-edit splices into full prompt before apply; auto-falls back to whole-prompt editor on section-mismatch |
| All SPA routes | HTTP 200 |
| All API endpoints | HTTP 200 |
