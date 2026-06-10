# Architecture

Reflects the system as shipped at `v4.8`. Last updated 2026-06-09.

---

## 1. System diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          HighLevel Sub-Account                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  HL left nav → "AI Copilot" Custom Page (auto-provisioned)            │ │
│  │  └── full-width iframe → <BACKEND_URL>/dashboard/?locationId=…        │ │
│  │  Marketplace App OAuth populated oauth_installations on install,      │ │
│  │  giving us per-location access_token + refresh_token for HL writes.   │ │
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
│  Routes (10):                                                             │
│    /api/dashboard       → overview summary                                │
│    /api/agents          → list, detail, calls, insights,                  │
│                           flywheel, narrative, kpis (PUT)                 │
│    /api/calls           → list, detail, analysis, analyze (POST)          │
│    /api/transcripts     → ingest, simulate, sync-all                      │
│    /api/recommendations → list, summary, dismiss, preview-apply, apply,   │
│                           validate, rollback                              │
│    /api/flywheel        → funnel + 5 narratives + impact + healthSummary  │
│                           + nextAction + biggestLeak + waitingStage       │
│                           (?mode=window|all-time)                         │
│    /api/patterns        → cross-agent cluster view + agentRollup +        │
│                           per-status agent lists                          │
│    /api/actions         → Use Action queue + verb POSTs                   │
│    /api/oauth           → callback, install webhook, installations        │
│                                                                            │
│  Services (11):                                                           │
│    AnalysisService                → OpenAI per-call analysis              │
│    NarrativeService               → deterministic what/why/evidence/action│
│    RecommendationService          → lifecycle, dedup (cluster + semantic),│
│                                     before/after measurement              │
│    PromptVersionService           → SHA-256 prompt-version tracking       │
│    IngestionService               → pull, normalize, persist, link        │
│    HLAuthService                  → OAuth token exchange + refresh        │
│    HLVoiceAgentService            → PATCH /voice-ai/agents/:id (V4 apply) │
│    LocalAgentService              → V4.8 mock of HL for reg-* demo agents │
│                                     (reads/writes local agents table)    │
│    ApplyRecommendationService     → orchestrate apply (snapshot, PATCH,   │
│                                     record version, mark applied, audit) │
│                                     via getAgentService() adapter factory │
│    EditSummaryService             → "what the user changed" one-liner     │
│    PromptStructureService         → V4.2 section-aware insertion          │
│    RecommendationValidatorService → 7 validators (incl. context-          │
│                                     consistency, section-fit)             │
│                                                                            │
│  Providers (adapter pattern):                                             │
│    BaseTranscriptProvider (abstract)                                      │
│    ├── MockTranscriptProvider     ← 4 agents w/ realistic failure mix    │
│    └── HighLevelTranscriptProvider ← live HL Voice AI API                 │
│                                                                            │
│  SQLite (10 tables, WAL mode, node:sqlite — zero native deps)             │
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

Two paths into `status='applied'` exist — both now correctly record the prompt_version (V4.3 fixed the auto_api path).

```
Path A — Sync-detected (user edits prompt in HL UI directly):
    Next Sync All sees prompt hash differ
       └─ PromptVersionService.recordIfChanged → new agent_prompt_versions row
       └─ RecommendationService.markActiveAsApplied(agentId, newVersionId)
            UPDATE recommendations SET status='applied', applied_prompt_version_id=…

Path B — V4 one-click apply (auto_api):
    User clicks Apply in modal
       └─ ApplyRecommendationService.apply()
            1. Idempotency check
            2. Fetch HL agent + validate (7 validators incl. context-consistency)
            3. Snapshot previous prompt → apply_attempts
            4. PATCH /voice-ai/agents/:id   (HL writes new prompt)
            5. PromptVersionService.recordIfChanged(...)   ← V4.3 fix
            6. UPDATE recommendations SET status='applied',
                 applied_prompt_version_id=?, applied_via='auto_api'
            7. EditSummary (if user edited)
            8. Log apply_attempts row

Both paths converge on the measurement step:

    Future calls under new prompt accumulate
    ▼
    RecommendationService.computePendingOutcomes()    ← runs at end of every analysis
        before_avg = AVG(score) where prompt_version_id != applied_version
                     AND call_timestamp <= applied_at
        after_avg  = AVG(score) where prompt_version_id  = applied_version
                     AND call_timestamp >  applied_at
        requires ≥1 call on each side
    ▼
    outcome_computed_at set                           ← measured
    Surfaced on /flywheel + Impact summary
    Significance threshold: delta >= 2 AND after_sample_size >= 3
```

False positives self-correct: if the same recommendation reappears in a new analysis after being auto-applied, `persistFromAnalysis()` flips it back to `active` and resets outcome — the fix didn't stick.

**Leak vs Waiting classification (V4.4)**: a stage with 0% conversion isn't always a "leak". If the prior step happened recently (within 3 days for Measured, 3 for Improved), the stage is `waiting` — natural data lag, not user inaction. Only true leaks get flagged in red; waiting stages get a yellow "waiting on data" label. `biggestLeak` only picks from `status='leak'` rows.

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

### Customer-facing vs technical vocabulary

The system detects what the AI/LLMOps industry calls "hallucinations" — moments where the AI agent stated facts not supported by its script. **Internally** (DB column `hallucinations_json`, OpenAI prompt enum, regression assertions, API field names) we keep the technical term. **In the UI** (Call Detail card headers, header chip, explainer) we use "unverified claims by agent" — accessible to non-AI-literate agency owners.

This separation lets the code stay technically precise without leaking jargon into the customer experience. The mapping lives entirely in `CallDetailView.vue` (`formatHallucinationType()`, `whyFlagged()`, `whatToDo()` helpers); changing display copy never touches the schema or API.

### Same-origin SPA serving

The built Vue SPA is copied to `backend/public/dashboard/` and served by Express at `/dashboard`. The dashboard's API client uses `baseURL: '/api'` — no CORS in production. Dev mode (Vite on `:5174` talking to backend on `:3000`) is the only place where CORS headers matter, and they're scoped to that environment via `NODE_ENV !== 'production'`.

### Iframe-friendly headers

The dashboard must be embeddable inside HL's iframe. `X-Frame-Options: DENY` is removed and `Content-Security-Policy: frame-ancestors *` is set. In a production tightening pass this would be restricted to `*.gohighlevel.com` and `*.leadconnectorhq.com`; left open for the assignment so the local test-harness also works.

### Recommendation lifecycle as a first-class FSM

Recommendations live in their own `recommendations` table (not embedded in `analyses_json`) so they can persist across analyses and carry state: `first_seen_at`, `occurrence_count`, `status`, `applied_at`, `applied_prompt_version_id`, `before/after measurement fields`. The same recommendation seen on 5 different calls is one row with `occurrence_count=5`, not 5 rows. This is what enables the Patterns page and the causal measurement.

### Two-pass deduplication (V4.5)

Recommendation dedup runs in two passes inside `RecommendationService.persistFromAnalysis()`:

1. **Cluster-key match (synchronous, fast)** — title is lowercased + whitespace-collapsed + truncated to 120 chars. Catches identical/near-identical titles like "Add price objection pivot" / "add price objection pivot block!" → same cluster_key.
2. **Semantic LLM match (async, batched, cached)** — for proposals that miss pass 1, one batched LLM call (`gpt-4o-mini`, strict JSON schema) compares the whole batch against the agent's existing active/applied set. Catches "Capture Caller Details" ≈ "Capture Caller Information" — semantically equivalent but cluster_key would differ.

Matched proposals reuse the existing `cluster_key` → treated as occurrence_count increment, not new row. Falls back gracefully to no-op when `OPENAI_API_KEY` is missing. Adds ~$0.001/analysis + ~1s latency, accepted: prevents the "I already applied this" confusion that the cluster-key-only approach allowed.

### Patterns view: cross-agent rollup with two-phase query

A pattern (cluster_key) can have recs in multiple states across multiple agents — applied on agent X, active on agent Y, dismissed on agent Z. The "did I already apply this?" question is per-agent, not per-pattern. So the patterns API exposes:

- `agentRollup.applyState`: `'all_applied' | 'partial' | 'not_started'`
- `agentsApplied[]` / `agentsStillActive[]` / `agentsDismissed[]` — full detail rows split by status

The status filter (`?status=active`) decides which CLUSTERS to include (any cluster with ≥1 rec matching), but the per-agent rollup is computed from the FULL recommendation set so the "Applied 1 of 2 — apply to remaining 1" math is always correct regardless of filter. Implemented as a two-phase query: filter clusters via `cluster_key IN (subquery)`, then aggregate the full set.

### Use Action statuses as a status overlay

Use Actions live inside `analyses.use_actions_json` (they're per-call). Their lifecycle (resolved / dismissed / escalated) is overlaid via a separate `use_action_statuses` table keyed by `(call_id, turn_index, action_type)`. Absence of a row = `pending`. This lets us preserve the original AI output untouched while still letting agents triage them.

---

## 4. Frontend architecture

### Pages (7)

| Route | Purpose |
|---|---|
| `/` | Overview — hero metrics, MonitorAnalyzeHero, FlywheelSnapshotTile, AgentStatusStrip, KPI radar, failure reasons, sentiment trend, calls needing attention |
| `/flywheel` | Validation Funnel + 5 stage cards (all expanded by default (Collapse all toggle); each card toggles independently) + impact summary |
| `/patterns` | Cross-agent failure pattern cards w/ lifecycle bars (filter by status + min-agents, URL-synced) |
| `/actions` | Use Action queue w/ 4-tab filter + verb buttons (optimistic UI) |
| `/calls` | All calls list |
| `/calls/:id` | Call Detail — transcript w/ unverified-claim cards (4-section structured view: what said / why flagged / why it matters / what to do), Use Action / deviation / missed-opportunity rings, KPI bars, recommendations, flags timeline. Includes dismissable first-time explainer for "what's an unverified claim?". |
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

## 5b. V4 — Close the Apply loop (shipped 2026-06-07, V4.3 measurement chain fix 2026-06-08)

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
        ApplyRecommendationService.apply()
          1. Idempotency check (only if rec.status='applied')
          2. Fetch HL agent + re-validate (7 validators server-side)
          3. Snapshot previous agentPrompt → apply_attempts row
          4. HLVoiceAgentService.updateAgentPrompt(...) → PATCH /voice-ai/agents/:id
          5. PromptVersionService.recordIfChanged(...)             ← V4.3 fix
          6. UPDATE recommendations SET status='applied',
             applied_prompt_version_id=?, applied_via='auto_api'   ← V4.3 fix
          7. EditSummaryService.summarise() if edited
          8. Persist apply_attempts row (outcome, diffs, edit metadata)
          9. Return receipt with full timeline (incl. new prompt_version step)
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

7 validators run live (debounced 300ms) as the user edits the textarea:
- Template variables (block if any unknown `{{var}}` in the proposed text)
- Length (block if over 8K chars)
- Tone consistency (warn if drifts from agent goal — cheap LLM call, cached)
- Forbidden content (block on TODO/placeholder leaks, profanity)
- Call-length impact (informational warn)
- **Section fit** (V4.2 — confirms LLM-picked target section exists)
- **Context consistency** (V4.2 — full-prompt LLM check for contradictions / tone drift / scope creep / sequencing / redundancy / variable mismatch; quotes conflicting phrases with `conflictsWith` evidence)

Confirm button label switches between `Apply AI suggestion` and `Apply your edit` based on whether the textarea has been modified — psychologically anchors authorship.

### V4.6 — Section visibility + manual override + focused diff

V4.2 chose the right section behind the scenes; V4.6 makes it transparent and overridable:

- The Apply modal renders a collapsible **"See all N sections in this agent's prompt"** list with name + char-length + summary per section. The LLM-picked target is highlighted with `►` + bold colored text; the rest are muted.
- A **section override dropdown** lets the user force a different section. On change, the frontend silently re-fetches `GET /api/recommendations/:recId/preview-apply?targetSectionId=<id>`. `PromptStructureService.proposeInsertion()` accepts the `forcedSectionId`, rebuilds its LLM prompt to skip selection ("you MUST target this exact section"), and only produces `modifiedSectionText`. Cache key includes `forcedSectionId` so each override variation is independently cached.
- A **section-only before/after diff panel** sits above the full-prompt diff — 2-column "BEFORE / AFTER" of just the changed section's verbatim text vs. the LLM's modified text. Suppressed when the path fell back to blind append.
- `sectionAware.userForcedSection: true` flag surfaces in the response so the UI can label the result as `manual override` rather than AI choice.

This closes the trust gap from V4.2 — users can now SEE the structure they're editing and override the choice when needed, without leaving the modal.

### V4.7 — Section-focused editor + inline diff highlighting

V4.6 made the section choice visible; V4.7 makes the section the **editing surface**:

- **Default editor**: the textarea is pre-filled with `modifiedSectionText` only (~500 chars) instead of the full merged prompt (~5000 chars). Splice math happens client-side: `proposedFullText = currentText.slice(0, idx) + editedSectionText + currentText.slice(idx + targetSectionText.length)`. The backend apply endpoint receives the spliced final text — no API contract change.
- **Word-level diff highlighting**: `diff` library (Myers algorithm) renders `BEFORE → AFTER` as colored `<span>` chunks — green-tint for added, red-tint+strikethrough for removed, muted for unchanged. Applied in (a) the section-only preview panel and (b) the "Show full prompt context" expand. Eye lands on the change instantly.
- **Mode toggle**: `⤢ Edit whole prompt instead` switches to the full-prompt editor (the V4.6 behavior). Seeds `editedFullText` with the current `proposedFullText` so the user's section edits aren't lost. Switching back uses prefix+suffix matching to best-effort recover section edits.
- **Auto-fallback**: when `sectionAware.fallback` is non-null (LLM picked invalid section / section text mismatch) OR `targetSectionText` not found in `currentText`, the modal auto-opens in whole-prompt mode with a yellow notice explaining why.

Why client-side splice and not backend? Three reasons: (1) backend validators run against the spliced full prompt anyway — no new validation needed; (2) keeps the apply API stable (`finalText` semantics unchanged); (3) the splice is O(1) and deterministic — `targetSectionText` is guaranteed verbatim in `currentText` by `PromptStructureService` (or `sectionEditAvailable` is false).

### V4.8 — LocalAgentService adapter (test DB apply pipeline)

The apply chain was designed against `HLVoiceAgentService` (real HL HTTP). `reg-*` demo agents in test DB don't exist in HighLevel, so the original implementation short-circuited with a friendly "switch to live" error. Everything *else* in the chain (PromptStructure, validators, lifecycle, prompt-version recording, measurement) was already DB-agnostic — only the HL HTTP layer needed mocking.

`LocalAgentService` mirrors `HLVoiceAgentService`'s public interface 1:1 — same method names, same return shapes (`{ id, agentName, agentPrompt, goal }`) — but backs `getAgent` with a SQLite read against the local `agents` table and backs `updateAgent`/`updateAgentPrompt` with an `UPDATE agents SET script = ?, …`. Throws `LOCAL_AGENT_NOT_FOUND` on missing rows, mirroring HL's 404 shape.

The adapter factory `getAgentService(agentId, { locationId })` lives at the bottom of `LocalAgentService.js`. It picks based solely on the `reg-` prefix:

```
agentId.startsWith('reg-')  →  new LocalAgentService()
otherwise                   →  new HLVoiceAgentService({ locationId })
```

Called from 5 sites: `routes/apply.js` (preview-apply, validate, apply handler) and `ApplyRecommendationService.js` (apply orchestrator, rollback). Replaces both the `_isDemoAgent()` short-circuit AND the direct `new HLVoiceAgentService(...)` constructor calls. Live HL behaviour is unchanged — the factory returns the same instance the old code constructed manually.

This is the adapter pattern paying dividends: the right architecture made this a ~150-LOC change instead of a refactor.

### V4.3 — The missing prompt_version link (critical bug fix)

Originally, the auto_api apply path marked `status='applied'` but **did not** call `PromptVersionService.recordIfChanged()` or set `applied_prompt_version_id`. Result: `computePendingOutcomes()` couldn't match calls to recs → no outcome ever computed → "Outcomes Measured" stuck at 0. Caught by PM-style data audit walking from DB → API → UI. Fix added the version-recording step between PATCH and mark-applied. Verified end-to-end against live HL data: apply → ingest synthetic post-apply call → analysis runs → `outcome_computed_at` populates with real Δ.

Full design rationale in [`V4_PLAN.md`](V4_PLAN.md) §12.

---

## 6. What this architecture does NOT do (explicit non-goals)

These are deliberate scope cuts. Each is a clear next step but adds risk/cost without grade lift:

- ~~Auto-write recommendations back to HL agent prompt~~ — **shipped V4 (one-click PATCH)**
- ~~Causal measurement of applied recommendations~~ — **shipped V4.3 (auto via `computePendingOutcomes` post-analysis)**
- ~~Significance threshold on improvements~~ — **shipped V4.4 (Δ≥2 AND n≥3)**
- ~~Semantic dedup of LLM-generated rec titles~~ — **shipped V4.5 (batched LLM pass in `persistFromAnalysis`)**
- ~~Per-agent applied rollup in patterns~~ — **shipped V4.5 (`agentRollup` API + split UI)**
- **Real-time webhook ingestion** (Sync All polls; `POST /api/transcripts/ingest` endpoint exists but HL webhook not wired)
- **A/B testing for prompt variants** (full cutover on every prompt change)
- **Multi-sub-account agency rollup** (FSB says single sub-account)
- **Embedding-based recommendation clustering** (semantic LLM dedup works at current scale; embedding is the V5 evolution)
- **Cost/usage dashboard for OpenAI spend** (not tracked)
- **Slack/email alerting on KPI drops** (pull-only UI for now)

Roadmap detail in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) §5.
