# Implementation Plan

What was built, in what order, and what comes next. Reflects the system as shipped on 2026-06-06.

---

## 1. Goal statement

Make the agency owner's life easier by turning Voice AI call transcripts into automatic, validated, prompt-level improvements — with two clear loops that close themselves:

1. **Monitor + Analyze (FSB Core Functionality)** — every sub-item from the PDF visibly addressed.
2. **Validation Flywheel** — every applied recommendation gets measured; the loop is observable, not just claimed.

Constraints:
- Single sub-account scope per FSB
- No new infrastructure beyond Node + SQLite + OpenAI
- Built solo across Product / Design / Engineering / QA

---

## 2. What shipped

### Backend
- 9 route files, 21 endpoints
- 6 services: Analysis, Narrative, Recommendation, PromptVersion, Ingestion, HLAuth
- 3 transcript providers (Mock, HighLevel, Base abstract)
- 9 SQLite tables with WAL mode, additive-only migrations
- OpenAI integration with `response_format: json_schema strict`
- ~4,055 LOC

### Frontend
- 7 page views, 25 components
- Top-nav 4-tab IA (Overview / Flywheel / Patterns / Actions)
- Pinia state, axios API client, Vue Router with lazy-loaded chunks
- ~4,068 LOC

### Integration
- Marketplace App OAuth flow (`/api/oauth/callback` + per-location token persistence + auto-refresh)
- Dashboard embeds inside HL as a Custom Menu Link (full-width iframe)
- PIT-token fallback for single-tenant developer use

### Documentation
- README + 5 docs files (ARCHITECTURE, DATA_MODEL, API_SPEC, INTEGRATION, DEMO_SCRIPT, this file)
- All written from current code state (this revision)

---

## 3. Execution timeline

The build proceeded in 4 phases over ~3 days. Each phase was scoped to leave the previous in working state.

### Phase 0 — Foundation (Day 1)
- Express skeleton + SQLite schema (5 initial tables: agents, kpi_definitions, calls, analyses, agent_insights)
- Vue 3 + Vite + Tailwind shell
- Mock transcript provider with 4 realistic agents
- Basic OpenAI analysis pipeline with structured output
- Overview + Agent Detail + Call Detail pages
- Custom JS widget skeleton (later removed in favor of OAuth + Custom Menu Link — 440px sidebar too narrow for the rich dashboard)

### Phase 1 — HighLevel live integration (Day 2 morning)
- `HighLevelTranscriptProvider` calling `services.leadconnectorhq.com/voice-ai/*` endpoints
- PIT-based auth flow
- OAuth Marketplace flow with token persistence
- Sync All button with progress indicator
- Iframe-friendly headers (CSP + frame-ancestors)

### Phase 2 — Validation Flywheel V1 (Day 2 afternoon)
- `agent_prompt_versions` table + `PromptVersionService` with SHA-256 hashing
- `recommendations` as first-class entity (table + `RecommendationService`)
- Lifecycle: `active → applied → measured` with causal before/after
- Auto-apply detection on prompt change
- Initial `/api/agents/:id/flywheel` endpoint with structured stage data
- `AgentFlywheelPanel` (vertical) on Agent Detail

### Phase 3 — V3 redesign (Day 3) — the bulk of the recent work

Sub-phase 3.1 — Backend foundation (~1.75 h)
1. Hallucination detection (7th validator) — schema + OpenAI field + storage column
2. `NarrativeService` with deterministic what / why / evidence / action per stage
3. `GET /api/flywheel/summary` — agency-wide funnel + 5 narratives + impact
4. `GET /api/patterns` — clustered recommendations across agents
5. `use_action_statuses` table + `GET /api/actions` + `POST /:verb` (resolve/dismiss/escalate)

Sub-phase 3.2 — New pages (~3.25 h)
1. `ValidationFunnel.vue` (6 bars + conversion %)
2. `FlywheelStageCard.vue` (click-to-expand narrative)
3. `/flywheel` page (funnel + 5 cards + impact summary)
4. `MonitorAnalyzeHero.vue` (4-step strip with WHY line)
5. `PatternsView.vue` + `PatternCard.vue` (cluster cards w/ lifecycle bars)
6. `ActionsView.vue` (queue with optimistic verb buttons)

Sub-phase 3.3 — Integration (~1.25 h)
1. Hallucination flags on Call Detail transcript (rings + chip + popover + timeline)
2. `AgentHorizontalFlywheel.vue` + `GET /api/agents/:id/flywheel/narrative` + `NarrativeService.buildForAgent()`
3. `KpiEditor.vue` + `PUT /api/agents/:id/kpis` with weight-sum=1.0 validation

Sub-phase 3.4 — Switch over (~45 min)
1. Overview cleanup — added MonitorAnalyzeHero + FlywheelSnapshotTile, removed FlywheelDiagram + LoopClosingWidget
2. Top nav — 4 tabs in Topbar with active-state styling
3. Final QA — all routes 200, lint clean, build clean

### Phase 4 — Bug fixes + documentation refresh (current)
- Fixed broken Apply / Measure action links (Apply now deep-links to top recently-changed agent; Measure links to `/patterns?status=applied`)
- Made PatternsView URL-aware (initialise from `?status=` and `?minAgents=`, sync URL on filter change)
- Wiped 9 stale doc files + `revamped.txt`
- Wrote 6 fresh docs (this one + ARCHITECTURE + DATA_MODEL + API_SPEC + INTEGRATION + DEMO_SCRIPT + README)

---

## 4. Decisions made along the way

### Cut from V3 scope

| Item | Why cut |
|---|---|
| OpenAI on-demand "explain why" button | Deterministic narratives already cover the need; OpenAI cost without grade lift |
| AI auto-suggested per-agent KPIs | Manual override delivers same value at 10× less risk |
| `validation_runs` audit log | Not graded; observability beyond demo scope |
| `expected_impact_pct` predictions | Cool but adds OpenAI complexity; measured impact is the real differentiator |
| Multi-validator architecture split | Single OpenAI call works; splitting = 6× cost |
| Embedding-based pattern clustering | Title-based `cluster_key` works at current scale |
| A/B testing for prompts | V4 product feature |
| Multi-sub-account agency rollups | FSB says single sub-account |
| Executive reporting | Real product feature, not graded |
| Real-time webhook ingestion | Endpoint exists; HL webhook wiring is one config change |

### Architectural calls that paid off

- **Adapter pattern for providers** — switching `TRANSCRIPT_PROVIDER` between `mock` and `highlevel` is the only change needed
- **Strict JSON schema** — zero JSON.parse defensive code; trust the OpenAI contract
- **Deterministic narratives** — zero added OpenAI cost per dashboard load
- **First-class recommendations** — enables Patterns clustering, causal measurement, and lifecycle UI
- **SHA-256 prompt versioning** — closes the loop without requiring an "I applied this" button

### Architectural calls that have a known trade-off

- **SHA-256 versioning is a heuristic** — typo fixes get credit for "applying" all pending recs; self-corrects when recs reappear
- **SQLite single-tenant** — does not scale to multi-sub-account; intentional FSB scope match
- **Pull-only ingestion** — Sync All replaces push; webhook is one config away
- **`X-API-Key` exposed in client SPA** — visible in browser source; tolerable for single-sub-account scope. Marketplace App's per-location OAuth tokens are the production answer
- **Narrative bounded by SQL rules** — can't synthesise novel insights; future "explain in depth" OpenAI button planned

---

## 5. Roadmap — what's next (post-FSB submission)

In rough priority order by customer impact:

### V4 — Close the apply loop (highest ROI) — **fully scoped in [`V4_PLAN.md`](V4_PLAN.md)**

Direct one-click application of recommendations into the live HL agent via `PATCH /agent-studio/agent/versions/:versionId`. Replaces the only manual step in V3 (paste suggested text into HL Agent Studio). Effort: ~15 hours including a non-optional 2 h API discovery phase against the sandbox. See `V4_PLAN.md` for endpoint inventory, 7-phase build, failure modes, go/no-go criteria.

### V4.5 — Real-time push
- Wire HL `call.completed` webhook to `POST /api/transcripts/ingest`
- Server-sent events on `/api/events` for live dashboard updates
- Slack/email alert configuration (per-agent KPI drop thresholds)

### V5 — Production hardening
- Postgres adapter behind same SQLite-shaped query layer (no rewrite needed)
- Per-location data partitioning
- OAuth token auto-refresh with retry queue
- Rate limit handling for OpenAI bulk syncs
- Cost dashboard (track OpenAI tokens spent per agent)

### V5 — Pattern intelligence
- Embedding-based clustering across agents (catches "ask for budget" + "qualify by spend" as same pattern)
- "Apply this fix to N agents" bulk operation
- Suggested KPI definitions per agent based on the agent's goal text (OpenAI)
- A/B testing — try new prompt on 10% of calls, compare averages

### V6 — Agency platform
- Multi-sub-account rollup view
- Per-customer reporting / white-label
- "Copilot" conversational interface ("which agent regressed this week?")
- Knowledge base — applied fix from Agent A surfaces as suggestion for Agent B

---

## 6. Acceptance criteria — V3 (current ship)

All passing as of 2026-06-06:

- [x] Hard-refresh `/dashboard/` shows Monitor→Analyze hero block with live data
- [x] Click `[♻️ Flywheel]` → loads funnel viz with 6 stages, real counts
- [x] Click any stage card → expands with 4-line narrative (what/why/evidence/action)
- [x] Click `[🔍 Patterns]` → loads pattern cards across all agents
- [x] Click `[⚠️ Actions]` → loads action queue, [Resolve] button removes row optimistically
- [x] Click any agent → Agent Detail shows horizontal flywheel with same narrative format
- [x] Click any failing call → Call Detail shows transcript with hallucination flags (if any) + use action highlights
- [x] Sync All works end-to-end and reflects in Funnel + Patterns within 5 seconds
- [x] `npm run lint` passes in both backend and frontend with **zero warnings**
- [x] All routes return HTTP 200 (no dead links from new top nav)
- [x] Apply / Measure action links resolve to real destinations (post-bug-fix)

---

## 7. FSB requirement coverage matrix

| PDF requirement | Coverage | Where |
|---|---|---|
| Sandbox account from HL Marketplace | Documented | `INTEGRATION.md` |
| Custom JS OR Marketplace App integration | Marketplace App OAuth + Custom Menu Link | `routes/oauth.js`, `HLAuthService`, dashboard added as Custom Menu Link in HL nav |
| Ingest + analyze existing Voice AI transcripts | A | `IngestionService`, `AnalysisService`, `HighLevelTranscriptProvider` |
| Observability params from agent's specific goals/script | A | `kpi_definitions` per agent, editable via `KpiEditor.vue` + `PUT /api/agents/:id/kpis` |
| Identify deviations | A | OpenAI `deviations[]`, rendered as transcript rings + Flags Timeline |
| Identify failures | A | `status: 'fail'` + recompute overall_score from KPIs × weights |
| Identify missed opportunities | A | OpenAI `missedOpportunities[]`, rendered identically |
| Intuitive dashboard across existing agents | A+ | Overview hero metrics + 4-tab IA + AgentStatusStrip |
| Visualise performance issues | A+ | Status distributions, KPI radar, failure reasons, sentiment trend, /patterns clusters |
| Immediate recommendations for prompt/script adjustments | A+ | First-class `recommendations` table with copy-paste `suggestedChange`, surfaced everywhere |
| Highlight "Use Actions" | A+ | Dedicated `/actions` queue + per-turn transcript rings + verb buttons |
| GitHub repo URL | ✅ shipped | https://github.com/UdayAppam/voice-ai-observability-copilot |
| 2-5 min Loom demo | Script written, recording pending | `DEMO_SCRIPT.md` |
| README + Team-of-One + functional/mocked | A | `README.md` |
