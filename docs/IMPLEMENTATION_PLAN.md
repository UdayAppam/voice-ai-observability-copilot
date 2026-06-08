# Implementation Plan

What was built, in what order, and what comes next. Reflects the system as of 2026-06-09 (`v4.5`).

---

## 1. Goal statement

Make the agency owner's life easier by turning Voice AI call transcripts into automatic, validated, prompt-level improvements — with two clear loops that close themselves:

1. **Monitor + Analyze (FSB Core Functionality)** — every sub-item from the PDF visibly addressed.
2. **Validation Flywheel** — every applied recommendation gets measured **causally** (not just claimed) with a significance threshold (Δ≥2 pts AND n≥3 calls).

Constraints:
- Single sub-account scope per FSB
- No new infrastructure beyond Node + SQLite + OpenAI
- Built solo across Product / Design / Engineering / QA

---

## 2. What shipped

### Backend
- 10 route files, 25+ endpoints
- 10 services: Analysis, Narrative, Recommendation, PromptVersion, Ingestion, HLAuth, HLVoiceAgent, ApplyRecommendation, EditSummary, PromptStructure, RecommendationValidator
- 3 transcript providers (Mock, HighLevel, Base abstract)
- 10 SQLite tables with WAL mode, additive-only migrations
- OpenAI integration with `response_format: json_schema strict` everywhere
- Semantic dedup pass on every analysis (batched LLM call, graceful no-op without API key)

### Frontend
- 7 page views, 30+ components
- Top-nav 4-tab IA (Overview / Flywheel / Patterns / Actions)
- Pinia state, axios API client, Vue Router with lazy-loaded chunks
- Flywheel page redesigned to 2-hero focus + collapsible drill-in (V4.4)
- Patterns view split by per-agent applied/active state (V4.5)
- Dark theme tokens audited for WCAG AA compliance (V4.5)

### Integration
- Marketplace App OAuth flow (`/api/oauth/callback` + per-location token persistence + auto-refresh)
- Dashboard embeds inside HL as a Custom Menu Link (full-width iframe)
- PIT-token fallback for single-tenant developer use
- V4 PATCH writes to HL Voice AI agents (`/voice-ai/agents/:id`)

### Documentation
- README + 8 docs files, all reflecting current state (V4.5)

---

## 3. Execution timeline

### Phase 0 — Foundation (Day 1)
- Express skeleton + SQLite schema (5 initial tables)
- Vue 3 + Vite + Tailwind shell
- Mock transcript provider with 4 realistic agents
- Basic OpenAI analysis pipeline with structured output
- Overview + Agent Detail + Call Detail pages

### Phase 1 — HighLevel live integration (Day 2 morning)
- `HighLevelTranscriptProvider` calling `services.leadconnectorhq.com/voice-ai/*`
- OAuth Marketplace flow with token persistence + auto-refresh
- Sync All button with progress indicator
- Iframe-friendly headers

### Phase 2 — Validation Flywheel V1 (Day 2 afternoon)
- `agent_prompt_versions` table + `PromptVersionService` (SHA-256 hashing)
- `recommendations` as first-class entity with lifecycle (`active → applied → measured`)
- Auto-apply detection on prompt change (`markActiveAsApplied`)
- `computePendingOutcomes` — causal before/after measurement (≥1 call each side)
- Initial `/api/agents/:id/flywheel` endpoint

### Phase 3 — V3 redesign (Day 3)
- 7th validator: hallucination detection
- `NarrativeService` with deterministic what / why / evidence / action
- `/api/flywheel/summary`, `/api/patterns`, `/api/actions` endpoints
- `/flywheel`, `/patterns`, `/actions` pages
- `MonitorAnalyzeHero`, `AgentHorizontalFlywheel`, `KpiEditor` components
- 4-tab top nav IA

### Phase 4 — V4: Close the Apply loop (Day 4)
- `HLVoiceAgentService` → PATCH `/voice-ai/agents/:id`
- `ApplyRecommendationService` orchestrator (idempotency, snapshot, PATCH, mark applied, audit log)
- `ApplyDiffModal.vue` (editable diff, 5 live debounced validators)
- `apply_attempts` table + receipt panel + one-click rollback
- 27/27 regression assertions against live HL sandbox

### Phase 4.1 — Pattern metrics (V4.1)
- `recommendation_calls` join table (distinct-call math vs misleading occurrence_count)
- `callsAffected` + `failedCallsAffected` on every pattern
- `urgencyDescriptor` (one-off / recurring / systemic)
- "Detected in N calls · M failed · last 4h ago · recurring" header

### Phase 4.2 — Section-aware insertion + context validators (V4.2)
- `PromptStructureService` — LLM parses prompt into named sections, cached in `agent_prompt_structure` (10th table)
- `proposeInsertion` — LLM picks WHICH section the fix belongs in + produces modified section verbatim; backend splices into full prompt
- `RecommendationValidatorService` extended with 2 new validators:
  - `context_consistency` — full-prompt LLM check for contradictions / tone drift / scope creep / sequencing / redundancy / variable mismatch; surfaces conflicting phrases with quotes
  - `section_fit` — confirms target section exists
- 14/14 V4.2 regression assertions (3 scenarios: contradiction → block, tone-drift → warn, clean merge → pass + section-aware insertion picks `script` section)

### Phase 4.3 — Apply→Measurement chain fix (CRITICAL)

**The bug**: V4's `ApplyRecommendationService` marked recommendations `status='applied'` and PATCHed HighLevel with the new prompt — but **never recorded a new `agent_prompt_versions` row** and **never set `applied_prompt_version_id` on the rec**. Result: `computePendingOutcomes` could never match calls to recs → no outcome was ever computed → "Outcomes Measured" stuck at 0 forever. Silently broken since V4 shipped.

**Discovery**: PM-style audit walking the data from DB up to UI. Found 3 applied recs all with `applied_prompt_version_id = NULL`. Traced through the apply path: PATCH succeeded, mark-applied succeeded, but no version recording step existed.

**Fix** in `ApplyRecommendationService.apply()`:
```js
// After PATCH succeeds, before mark-applied:
const promptVersionResult = PromptVersionService.recordIfChanged({
  id: agentId, name: agent.name, script: finalText, goal: agent.goal,
})
// Then mark-applied also writes the version ID:
UPDATE recommendations SET ..., applied_prompt_version_id=?, ...
```

**Backfill**: existing stuck recs got `applied_prompt_version_id` set via best-guess heuristic (dominant prompt_version_id of post-apply calls for that agent, or latest version as fallback).

**Verification**: end-to-end live HL test — applied a fresh recommendation, injected a synthetic post-apply call, watched `outcome_computed_at` populate with a real Δ. Flywheel "Outcomes Measured" ticked from 0 to 1 as expected.

### Phase 4.4 — Flywheel correctness + redesign

**Math correctness**:
- All funnel counts windowed consistently (was mixing `WHERE first_seen_at >= ?` with all-time aggregates → 187% conversion rates)
- `?mode=window|all-time` toggle (default `window`)
- "Root Causes Identified" demoted from funnel row to side stat (different unit of count — calls vs. recommendations)
- Significance threshold for "Improved Scores": `delta >= 2 pts AND after_sample_size >= 3`
- "any improvement" exposed as a sub-count under "Improved Scores" (transparency, not data hiding)
- Success rate computed over ALL measured (was `LIMIT 5` → misleading "60%" was really "3 of last 5")
- Fixed bug in `NarrativeService._buildMeasure`: `allMeasured` query was missing `after_sample_size` column → significance filter always returned 0 → "0 significantly" was wrong in every dashboard

**Framing correctness — leak vs waiting**:
- 0% conversion at "Outcomes Measured" was being labeled "biggest leak" → misleading; the user can't FORCE measurement, it requires post-apply calls to accumulate
- New `status` field on each funnel row: `'leak' | 'waiting' | 'normal' | 'na'`
- "Waiting" = 0% conversion AND prior step happened within grace window (3 days for Measured, 3 days for Improved)
- `biggestLeak` only flags `status === 'leak'` rows; `waitingStage` surfaced separately
- Next-action logic respects waiting state ("Waiting for outcomes measured to accumulate" instead of "Apply more")
- Health summary: stages in `waiting` count as healthy

**Impact metrics replaced**:
- "Manual Review Hours Saved" (fake `analyses × 5min` coefficient) → `avgDaysIssueToFix` (real cycle time: `AVG(applied_at - first_seen_at)`)
- `passRatePct` surfaced as primary impact stat
- All Impact cards now show "vs prior 7d" / "cumulative" context labels

**UI redesign — 2-hero focus**:
- Hero 1: huge metric (48px) + one-line lifecycle sentence (`23 issues → 43 generated → 2 applied → 0 measured → 0 improved`) with leak step highlighted in red
- Hero 2: bordered, tinted "next best action" callout with deep-link CTA button
- Funnel + 5 stage cards + impact + closure rate → collapsed behind "▸ Drill in" toggle
- Window/All-time mode toggle in filter bar
- Page width `max-w-7xl` (was 5xl, cards were squished)
- Responsive grid `sm:2 / lg:3 / xl:5` (was always 5)
- Click affordance + caret hover animation on stage cards
- "Produces funnel rows: X, Y" labels on each stage card (links operational stage to outcome metric)

### Phase 4.5 — Semantic dedup + Patterns rollup + Dark theme

**Semantic dedup** in `RecommendationService.persistFromAnalysis`:
- Two-pass design: cluster_key match (fast) → LLM batched dedup (only for misses)
- One LLM call per analysis batches all proposed recs against the agent's existing active/applied set
- LLM returns "this proposed title is a duplicate of cluster_key X" or empty for new behavior
- Matched proposals reuse the existing cluster_key → treated as occurrence_count increment, not new row
- Graceful no-op without `OPENAI_API_KEY` (logged warning, no failure)
- Existing duplicates on live DB cleaned up via one-off script (LLM-based)
- `persistFromAnalysis` is now `async`; `AnalysisService` + `backfillRecommendations.js` updated to `await`

**Patterns API per-agent rollup**:
- New SQL fields per cluster: `agentsApplied`, `agentsActive`, `agentsDismissed` (count distinct agents per status)
- New `agentRollup.applyState`: `'all_applied' | 'partial' | 'not_started'`
- New arrays: `agentsApplied[]`, `agentsStillActive[]`, `agentsDismissed[]` (split detail rows by status)
- Two-phase query: status filter chooses which CLUSTERS to include; per-agent rollup computed from FULL data (filter doesn't break "Applied 1 of 2" math when filter=active)

**PatternCard UI**:
- New header pill showing apply state: `✓ Applied to all 2` / `Applied 1/2 · 1 still needed` / `Not yet applied (3 agents)`
- Expanded view split into 2 sections:
  - `⚠ STILL NEEDS APPLY ON N AGENT(S)` (red left-border, with [Apply] buttons)
  - `✓ ALREADY APPLIED ON N AGENT(S)` (green left-border, read-only)
- Cross-agent patterns no longer look like "duplicates" of applied recs

**Dark theme readability (WCAG AA tokens)**:
- `text-muted` lifted from `#6B7493` (3.0–4.1:1 vs all bg surfaces — FAILED AA) → `#8B95B8` (4.7–6.4:1 — PASSES AA)
- `border-subtle` `#222B49` → `#2A335A` (cards now have visible edges)
- `border-strong` `#2D3858` → `#3A4670`
- New text-variant tokens for accent colors on cards:
  - `accent-primary-text` `#60A5FA` (7.0:1) — for blue text on cards (solid buttons keep `#3B82F6`)
  - `accent-secondary-text` `#A78BFA` (6.5:1)
  - `fail-text` `#F87171` (6.4:1) — for red text inside cards (solid badges keep `#EF4444`)
- 139+ existing `text-muted` usage sites auto-fixed; ~5 targeted swaps for bare accent-text on cards

---

## 4. Decisions made along the way

### Architectural calls that paid off

- **Adapter pattern for providers** — switching `TRANSCRIPT_PROVIDER` between `mock` and `highlevel` is the only change needed
- **Strict JSON schema** — zero JSON.parse defensive code; trust the OpenAI contract
- **Deterministic narratives** — zero added OpenAI cost per dashboard load
- **First-class recommendations** — enables Patterns clustering, causal measurement, lifecycle UI
- **SHA-256 prompt versioning** — closes the loop without requiring an "I applied this" button
- **PM-style data audit** — walking the chain from DB → API → UI caught the silent V4.3 measurement bug
- **Two-phase pattern query** — keeps status filter as INCLUSION rule while keeping per-agent rollup math correct

### Architectural calls that have a known trade-off

- **SHA-256 versioning is a heuristic** — typo fixes get credit for "applying" all pending recs; self-corrects when recs reappear
- **SQLite single-tenant** — does not scale to multi-sub-account; intentional FSB scope match
- **Pull-only ingestion** — Sync All replaces push; webhook is one config away
- **`X-API-Key` exposed in client SPA** — visible in browser source; tolerable for single-sub-account scope. Marketplace App's per-location OAuth tokens are the production answer
- **Semantic dedup adds ~$0.001/analysis + ~1s latency** — accepted: prevents the duplicate-rec confusion that broke user trust in V4.4. Falls back to no-op without API key.
- **Significance threshold is hard-coded (Δ≥2 AND n≥3)** — tuned for current demo scale; could be per-agent or learned in V5

---

## 5. Roadmap — what's next (post-FSB submission)

In rough priority order by customer impact:

### V5 — Real-time + alerts
- Wire HL `call.completed` webhook to `POST /api/transcripts/ingest`
- Server-sent events on `/api/events` for live dashboard updates
- Slack/email alert configuration (per-agent KPI drop thresholds)

### V5 — Production hardening
- Postgres adapter behind same SQLite-shaped query layer (no rewrite needed)
- Per-location data partitioning
- Rate limit handling for OpenAI bulk syncs
- Cost dashboard (track OpenAI tokens spent per agent + per dedup pass)

### V5 — Pattern intelligence
- Embedding-based clustering across agents (catches "ask for budget" + "qualify by spend" as same pattern without LLM cost)
- "Apply this fix to N agents" bulk operation (now feasible with the agentRollup data)
- Suggested KPI definitions per agent based on the agent's goal text
- A/B testing — try new prompt on 10% of calls, compare averages

### V6 — Agency platform
- Multi-sub-account rollup view
- Per-customer reporting / white-label
- "Copilot" conversational interface ("which agent regressed this week?")
- Knowledge base — applied fix from Agent A surfaces as suggestion for Agent B

---

## 6. Acceptance criteria — current ship (v4.5)

All passing as of 2026-06-09:

- [x] Hard-refresh `/dashboard/` shows Monitor→Analyze hero block with live data
- [x] `[♻️ Flywheel]` loads 2-hero layout with honest "leak vs waiting" classification + correct math (windowed, significance-thresholded)
- [x] Funnel "biggest leak" only flags real user-actionable bottlenecks (not natural data lag)
- [x] `[🔍 Patterns]` shows per-pattern apply-state pill and splits expanded view into "Still needs / Already applied"
- [x] `[⚠️ Actions]` queue + verb buttons work, `?turn=N` deep links scroll to flagged turn
- [x] Agent Detail shows horizontal flywheel with same narrative format
- [x] Call Detail shows transcript with hallucination flags (if any) + use action highlights
- [x] V4 Apply: PATCH succeeds → new prompt_version recorded → `applied_prompt_version_id` set → next analysed call triggers `computePendingOutcomes` → outcome populates → dashboard reflects
- [x] V4 Rollback: previous prompt restored in one click; rec returns to `status='active'`
- [x] Semantic dedup catches "Capture Caller Details" ≈ "Capture Caller Information" before insert (verified on live data)
- [x] Sync All works end-to-end and reflects in Funnel + Patterns within seconds
- [x] `npm run lint` passes in both backend and frontend with **zero warnings**
- [x] All routes return HTTP 200
- [x] WCAG AA contrast on every text token against every surface (audited)

---

## 7. FSB requirement coverage matrix

| PDF requirement | Coverage | Where |
|---|---|---|
| Sandbox account from HL Marketplace | Documented | `INTEGRATION.md` |
| Custom JS OR Marketplace App integration | Marketplace App OAuth + Custom Menu Link | `routes/oauth.js`, `HLAuthService` |
| Ingest + analyze existing Voice AI transcripts | ✅ | `IngestionService`, `AnalysisService`, `HighLevelTranscriptProvider` |
| Observability params from agent's specific goals/script | ✅ | `kpi_definitions` per agent, editable via `KpiEditor.vue` |
| Identify deviations | ✅ | OpenAI `deviations[]`, rendered as transcript rings + Flags Timeline |
| Identify failures | ✅ | `status: 'fail'` + recompute overall_score from KPIs × weights |
| Identify missed opportunities | ✅ | OpenAI `missedOpportunities[]` |
| Intuitive dashboard across existing agents | ✅ | Overview hero + 4-tab IA |
| Visualise performance issues | ✅ | Status distributions, KPI radar, failure reasons, sentiment trend, `/patterns`, 2-hero Flywheel |
| Immediate recommendations for prompt/script adjustments | ✅ + V4 closes the loop with one-click apply | First-class `recommendations` table; V4 PATCHes HL agent directly |
| Highlight "Use Actions" | ✅ | Dedicated `/actions` queue + per-turn transcript rings + verb buttons |
| Validation Flywheel framing | ✅ + V4.3 fix proves causality | Funnel + 5 stages + measured outcomes + significance thresholds + leak/waiting classification |
| GitHub repo URL | ✅ | https://github.com/UdayAppam/voice-agent-flywheel |
| 2-5 min Loom demo | Script written, recording pending | `DEMO_SCRIPT.md` |
| README + Team-of-One + functional/mocked | ✅ | `README.md` |
