# Architecture

Reflects the system as shipped. Last updated 2026-06-06.

---

## 1. System diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          HighLevel Sub-Account                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Custom JS (Settings → Custom JS & CSS)                              │  │
│  │  └── widget.js                                                       │  │
│  │        ├── Floating "AI Copilot" button (bottom-right, fixed)        │  │
│  │        ├── 440px slide-in sidebar w/ iframe                          │  │
│  │        ├── pushState/popstate hooks (survives HL SPA navigation)     │  │
│  │        └── __COPILOT_INSTALLED__ guard against double mount          │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │ iframe.src = BACKEND_URL/dashboard/
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                Backend (Express @ BACKEND_URL — same origin)               │
│                                                                            │
│  GET  /dashboard/*  → static SPA (Vue build, no cache for index.html)     │
│  GET  /health       → DB ping                                             │
│  GET|POST /api/oauth/*  ← no auth (HL is the caller)                      │
│  *    /api/*        ← X-API-Key auth middleware                           │
│                                                                            │
│  Routes (9):                                                              │
│    /api/dashboard       → overview summary                                │
│    /api/agents          → list, detail, calls, insights,                  │
│                           flywheel, narrative, kpis (PUT)                 │
│    /api/calls           → list, detail, analysis, analyze (POST)          │
│    /api/transcripts     → ingest, simulate, sync-all                      │
│    /api/recommendations → list, summary, dismiss                          │
│    /api/flywheel        → agency-wide funnel + 5 narratives + impact      │
│    /api/patterns        → cross-agent cluster view                        │
│    /api/actions         → Use Action queue + verb POSTs                   │
│    /api/oauth           → callback, install webhook, installations        │
│                                                                            │
│  Services (6):                                                            │
│    AnalysisService          → OpenAI per-call analysis                    │
│    NarrativeService         → deterministic what/why/evidence/action       │
│    RecommendationService    → lifecycle, dedup, before/after measurement   │
│    PromptVersionService     → SHA-256 prompt-version tracking             │
│    IngestionService         → pull, normalize, persist, link to version   │
│    HLAuthService            → OAuth token exchange + refresh              │
│                                                                            │
│  Providers (adapter pattern):                                             │
│    BaseTranscriptProvider (abstract)                                      │
│    ├── MockTranscriptProvider     ← 4 agents w/ realistic failure mix    │
│    └── HighLevelTranscriptProvider ← live HL Voice AI API                 │
│                                                                            │
│  SQLite (9 tables, WAL mode, node:sqlite — zero native deps)              │
└────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼ (when TRANSCRIPT_PROVIDER=highlevel)
              HighLevel Voice AI API (services.leadconnectorhq.com)
              GET /voice-ai/agents?locationId=...
              GET /voice-ai/dashboard/call-logs?locationId=...&agentId=...
              GET /voice-ai/dashboard/call-logs/{callId}
```

---

## 2. The two loops, mapped to the FSB requirement

### Monitor loop (Observability)

```
HL Sub-Account
     │ Sync All button (or webhook)
     ▼
IngestionService
     │   ─ pulls agents + new calls via provider
     │   ─ calls PromptVersionService.recordIfChanged(agent)
     │       └─ SHA-256(prompt+goal) → new row in agent_prompt_versions if new
     │       └─ if isNew + prevVersion: RecommendationService.markActiveAsApplied()
     │   ─ persists calls w/ prompt_version_id link
     ▼
AnalysisService (background, parallel up to 4)
     │   ─ kpi_definitions (per agent) → OpenAI system prompt
     │   ─ OpenAI gpt-4o-mini, response_format: json_schema strict
     │   ─ recomputes overall_score deterministically Σ(kpi × weight)
     │   ─ writes to analyses (+ hallucinations_json, use_actions_json, etc.)
     ▼
RecommendationService.persistFromAnalysis()
     │   ─ normalised cluster_key (dedup)
     │   ─ upsert into recommendations w/ first_seen_prompt_version_id
```

### Analyze loop (Dashboard)

```
                  ┌─ /api/dashboard/summary    → Overview
                  ├─ /api/flywheel/summary     → /flywheel (funnel + 5 narratives + impact)
                  ├─ /api/patterns             → /patterns (cluster view)
                  ├─ /api/actions              → /actions (queue + verb POSTs)
analyses[],       ├─ /api/agents/:id           → Agent Detail (KPI bars, insights, calls)
recommendations[],├─ /api/agents/:id/flywheel/narrative → Agent's horizontal flywheel
agent_prompt_     ├─ /api/agents/:id/kpis (PUT) → KpiEditor inline edits
versions[],       └─ /api/calls/:id/analysis   → Call Detail (transcript w/ flags,
use_action_                                       KPI bars, recommendations)
statuses[]
```

### Validation Flywheel (closes the loop with causality)

```
Recommendation born                                  ← active
    │
    ▼ (human edits prompt in HL UI)
Next Sync All sees prompt hash differ                ← prompt_version row inserted
    │
    ▼ RecommendationService.markActiveAsApplied(agentId, newVersionId)
All active recs → status='applied'                   ← applied
    │
    ▼ Future calls under new prompt accumulate
RecommendationService.computePendingOutcomes()
    │   before_avg = AVG(score) where prompt_version_id != applied_version
    │                AND call_timestamp <= applied_at
    │   after_avg  = AVG(score) where prompt_version_id  = applied_version
    │                AND call_timestamp >  applied_at
    │   requires ≥1 call on each side
    ▼
outcome_computed_at set                              ← measured
Surfaced on /flywheel "Measure" stage + Impact summary
```

False positives self-correct: if the same recommendation reappears in a new analysis after being auto-applied, `persistFromAnalysis()` flips it back to `active` and resets outcome — the fix didn't stick.

---

## 3. Key design decisions

### "Trust LLM for semantic, backend for arithmetic"

OpenAI returns per-KPI integers 0–100. The overall score is recomputed deterministically from `kpi_definitions.weight × kpi_score`. The LLM's `overallScore` field exists only as a sanity check; we never persist it directly. This makes scoring reproducible — re-running the same analysis with the same weights always gives the same overall, regardless of LLM stochasticity.

### Strict JSON schema, never parse free-form

Every OpenAI call uses `response_format: { type: 'json_schema', json_schema: { strict: true, schema: {...} } }`. There is no try/catch around JSON parsing because there is no parsing — the API guarantees the shape. Required fields, enums, and `additionalProperties: false` are all enforced server-side by OpenAI.

### Adapter pattern for transcript sources

`BaseTranscriptProvider` defines `fetchAgents()`, `fetchCalls(agentId)`, `fetchTranscript(callId)`. `MockTranscriptProvider` and `HighLevelTranscriptProvider` implement the same interface. `IngestionService` is provider-agnostic — switching `TRANSCRIPT_PROVIDER=mock|highlevel` in env swaps which adapter is used at app start. Tests, demos, and offline development all use the same code path as production.

### Deterministic narratives (no extra OpenAI cost)

Every Flywheel stage emits a `{ what, why, evidence, actionLabel, actionHref }` shape. The text is generated by `NarrativeService` from pure SQL queries — no LLM call. This means:
- Zero added OpenAI spend per dashboard load
- Identical narrative for identical DB state (reproducible)
- Cheap to compute → safe to call on every page load
- No latency, no fallback for LLM failure

The trade-off is the narrative quality is bounded by the rules in `NarrativeService`. Acceptable for V3; a V4 enhancement could add an "explain in depth" button that calls OpenAI on demand.

### SHA-256 prompt-version tracking

Detecting "did the agent prompt change?" is the trigger for closing the validation loop. We hash the normalized (whitespace-collapsed) `prompt+goal` and compare to the last known hash. New hash → new `agent_prompt_versions` row → all active recommendations marked `applied`. This is a heuristic — a typo fix gets credit for "applying" all pending recs. False positives self-correct because the same recommendations reappear in new analyses and flip back to `active`.

### Single-tenant SQLite + WAL

The FSB scope says single sub-account. SQLite via `node:sqlite` (built-in to Node 22.5+) gives zero native dependencies, file-based persistence (mount a persistent volume + point `DATABASE_PATH` at it on any host with ephemeral disks), and WAL mode for concurrent reads. Scaling beyond one sub-account would need either per-location databases or Postgres; both are clear next steps but out of FSB scope.

### Same-origin SPA serving

The built Vue SPA is copied to `backend/public/dashboard/` and served by Express at `/dashboard`. The dashboard's API client uses `baseURL: '/api'` — no CORS in production. Dev mode (Vite on `:5174` talking to backend on `:3000`) is the only place where CORS headers matter, and they're scoped to that environment via `NODE_ENV !== 'production'`.

### Iframe-friendly headers

The dashboard must be embeddable inside HL's iframe. `X-Frame-Options: DENY` is removed and `Content-Security-Policy: frame-ancestors *` is set. In a production tightening pass this would be restricted to `*.gohighlevel.com` and `*.leadconnectorhq.com`; left open for the assignment so the local test-harness also works.

### Recommendation lifecycle as a first-class FSM

Recommendations live in their own `recommendations` table (not embedded in `analyses_json`) so they can persist across analyses and carry state: `first_seen_at`, `occurrence_count`, `status`, `applied_at`, `before/after measurement fields`. The same recommendation seen on 5 different calls is one row with `occurrence_count=5`, not 5 rows. This is what enables the Patterns page (`cluster_key` dedup) and the causal measurement.

### Use Action statuses as a status overlay

Use Actions live inside `analyses.use_actions_json` (they're per-call). Their lifecycle (resolved / dismissed / escalated) is overlaid via a separate `use_action_statuses` table keyed by `(call_id, turn_index, action_type)`. Absence of a row = `pending`. This lets us preserve the original AI output untouched while still letting agents triage them.

---

## 4. Frontend architecture

### Pages (7)

| Route | Purpose |
|---|---|
| `/` | Overview — hero metrics, MonitorAnalyzeHero, FlywheelSnapshotTile, AgentStatusStrip, KPI radar, failure reasons, sentiment trend, calls needing attention |
| `/flywheel` | Validation Funnel + 5 stage cards (click to expand for what/why/evidence/action) + impact summary |
| `/patterns` | Cross-agent failure pattern cards w/ lifecycle bars (filter by status + min-agents, URL-synced) |
| `/actions` | Use Action queue w/ 4-tab filter + verb buttons (optimistic UI) |
| `/calls` | All calls list |
| `/calls/:id` | Call Detail — transcript w/ hallucination + Use Action + deviation + missed rings, KPI bars, recommendations, flags timeline |
| `/agents/:id` | Agent Detail — health donut, KpiEditor, horizontal AgentFlywheelStageCards, KpiBars, AI Insights, calls list |

### Components (25)

Grouped by purpose:

- **Shell**: `AppShell`, `Topbar` (4-tab nav), `BackLink`
- **Hero / metrics**: `MetricHeroCard`, `MonitorAnalyzeHero`, `FlywheelSnapshotTile`, `HealthDonut`, `StatusBar`
- **Flywheel**: `ValidationFunnel`, `FlywheelStageCard`, `AgentHorizontalFlywheel`
- **KPIs**: `KpiBars`, `KpiRadar`, `KpiEditor`, `WorstKpiBadge`
- **Agents/calls**: `AgentStatusStrip`, `CallsNeedingAttention`, `FailureReasonsList`, `SentimentTrend`, `Sparkline`
- **Recommendations/patterns**: `AggregatedRecommendations`, `PatternCard`
- **States**: `LoadingSpinner`, `ErrorState`, `EmptyState`

### State

Pinia stores: `agentStore` (current agent, agents list, insights), `callStore` (current call, calls list, sync state). Most page-level state lives in component `ref()`s — stores hold only data shared across views.

### API client

Single `axios` instance with `baseURL: /api` (prod) or `VITE_API_BASE_URL` (dev) and `X-API-Key` header injected from `VITE_API_KEY` env. Error interceptor normalises every failure to `{ code, message, status }`.

---

## 5. Failure-mode analysis (what could break, how we'd know)

| Risk | Detection | Mitigation |
|---|---|---|
| OpenAI returns malformed JSON | Cannot happen — `strict: true` enforces schema | n/a |
| OpenAI rate-limit during Sync All | Errors logged + per-call status set to `failed` | Sequential processing per agent w/ retry on next sync |
| Prompt version detection false-positive (typo fix marks 12 recs applied) | Recommendations reappear in new analyses | Auto-flip back to `active` + reset outcome |
| Action queue race (two clients resolve the same action) | Last write wins via UPSERT | UNIQUE primary key + `ON CONFLICT DO UPDATE` |
| SQLite WAL grows unbounded under heavy writes | Disk monitoring | WAL checkpoint on `PRAGMA journal_size_limit` (default ok for assignment scale) |
| Widget mounted twice on HL SPA nav | `window.__COPILOT_INSTALLED__` guard | Built-in |
| Cloudflared tunnel URL changes on restart | Visible in `.runtime/run-persistent.sh status` | Use a named cloudflared tunnel or any stable HTTPS reverse proxy for production |
| Host disk is ephemeral, DB resets on redeploy | Manual check after deploy | Mount a persistent volume + set `DATABASE_PATH` to that path (per `INTEGRATION.md`) |

---

## 5b. V4 — Close the Apply loop (shipped 2026-06-07)

V3 stops at "recommendation generated"; the human must paste the suggested text into HL. V4 closes the loop with one-click direct writes to the live Voice AI agent.

```
Recommendation card on /patterns
    [Apply to {AgentName} →]   ← V4 button
                ↓
        ApplyDiffModal opens
        ├── GET /api/recommendations/:recId/preview-apply
        │     → returns currentText, aiSuggestedText (merged), validators
        ├── Editable textarea pre-filled with aiSuggestedText
        │     → POST /api/recommendations/:recId/validate (debounced 300ms)
        └── [Apply your edit] / [Apply AI suggestion]
                ↓
        POST /api/agents/:agentId/recommendations/:recId/apply
                ↓
        ApplyRecommendationService.run()
          1. Idempotency check (only if rec.status='applied')
          2. Fetch HL agent + re-validate (server-side defence)
          3. Snapshot previous agentPrompt → apply_attempts row
          4. HLVoiceAgentService.updateAgentPrompt(...) → PATCH /voice-ai/agents/:id
          5. UPDATE recommendations SET status='applied', applied_via='auto_api'
          6. EditSummaryService.summarise() if edited
          7. Persist apply_attempts row (outcome, diffs, edit metadata)
          8. Return receipt with full timeline
                ↓
        ApplyReceiptPanel renders timeline + "What's next" + Rollback affordance
```

### Rollback design

HL Voice AI has **no native versioning** on agents (confirmed via discovery — see `V4_API_DISCOVERY.md`). Rollback is owned by us:

```
POST /api/recommendations/:recId/rollback
    ↓
fetch latest apply_attempts row with outcome='success' for this rec
    ↓
HLVoiceAgentService.updateAgentPrompt(agentId, previous_agent_prompt)
    ↓
UPDATE recommendations SET status='active', applied_at=NULL, applied_via=NULL
    ↓
INSERT new apply_attempts row with outcome='rolled_back'
```

Always reversible in 1 click. The `previous_agent_prompt` snapshot is taken inside the orchestrator's protected section *before* the PATCH ever fires, so even if PATCH succeeds and a downstream step fails, we have a recovery anchor.

### V4 trust layer (UX)

Every Apply surfaces 3 layers of information before the user can click Confirm:
- **WHY** — narrative on the rec card (occurrence count, evidence calls)
- **WHAT** — diff modal with current vs proposed side-by-side
- **WHERE** — exact agent name + node/prompt-location in the modal header

5 validators run live (debounced 300ms) as the user edits the textarea:
- Template variables (block if any unknown `{{var}}` in the proposed text)
- Length (block if over 8K chars)
- Tone consistency (warn if drifts from agent goal — cheap LLM call, cached)
- Forbidden content (block on TODO/placeholder leaks, profanity)
- Call-length impact (informational warn)

Confirm button label switches between `Apply AI suggestion` and `Apply your edit` based on whether the textarea has been modified — psychologically anchors authorship.

Full design rationale in [`V4_PLAN.md`](V4_PLAN.md) §12.

---

## 6. What this architecture does NOT do (explicit non-goals for V3)

These are deliberate scope cuts. Each is a clear next step but adds risk/cost without grade lift:

- **Auto-write recommendations back to HL agent prompt** (manual paste-in for now)
- **Real-time webhook ingestion** (Sync All polls; `POST /api/transcripts/ingest` endpoint exists but HL webhook not wired)
- **A/B testing for prompt variants** (full cutover on every prompt change)
- **Multi-sub-account agency rollup** (FSB says single sub-account)
- **OpenAI-on-demand "explain in depth" button** (deterministic narratives suffice)
- **Embedding-based recommendation clustering** (title cluster_key works at current scale)
- **Cost/usage dashboard for OpenAI spend** (not tracked)
- **Slack/email alerting on KPI drops** (pull-only UI for V3)

Roadmap detail in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) §5.
