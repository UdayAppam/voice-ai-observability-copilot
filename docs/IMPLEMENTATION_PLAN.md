# Implementation Plan

What was built, in what order, and what comes next. Reflects the system as of 2026-06-09 (`v4.8`).

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

### Phase 4.6 — Section structure visibility + manual override + focused diff

V4.2 quietly handled section selection behind the scenes, but the user couldn't *see* the agent's full structure or *override* the LLM's choice. This phase closes those three gaps:

**A — Show full section list in ApplyDiffModal**
- The collapsible `▾ See all N sections in this agent's prompt` panel now renders every parsed section with name + char-length + summary.
- The LLM-picked target is highlighted with `►` + bold colored text; all other sections are muted with `·`. User can validate the LLM's choice without leaving the modal.
- `sectionAware.sections[]` in the API response now includes `textLength` per section (was `id` + `name` + `summary` only).

**B — Manual section override (backend + frontend)**
- `PromptStructureService.proposeInsertion()` accepts optional `forcedSectionId`. When set, the LLM call is rebuilt to skip the selection step and only produce `modifiedSectionText` for that section. The system message changes to "the user has chosen a SPECIFIC section, do NOT pick a different one."
- `routes/apply.js GET /preview-apply` accepts `?targetSectionId=<id>`. Passes through to `proposeInsertion`.
- Cache key extended to include `forcedSectionId` so different overrides for the same recommendation each get their own cache entry.
- `sectionAware.userForcedSection: true` flag flows back to the UI when the override was applied.
- Frontend dropdown in modal: "Place this fix in: [AI chooses (default) / Persona / Goals / ... ]". On change, `onSectionOverride()` triggers a silent reload (modal stays open, badge shows `regenerating…`).
- "manual override" badge appears in the section-aware header when the override is active.

**C — Section-only before/after diff panel**
- New focused diff panel rendered above the full-prompt diff: 2-column "BEFORE / AFTER" of just the changed section's verbatim text vs the LLM's modified text.
- Skipped when `fallback` is set (blind append means there isn't a clean section-level diff to show).
- The full-prompt diff below remains so the user can still see whole-prompt context.

**Verification**:
- Backend: forced `?targetSectionId=persona` against AI Sells Itself rec — LLM correctly modified Persona section with `userForcedSection=true`, no fallback, reasoning adapted ("adds a personalized touch to the introduction").
- Default (no override): LLM picks `Information Gathering` with high confidence, same as before V4.6.
- Frontend bundle inspection confirms all new strings shipped: `Place this fix in`, `See all N sections`, `Changed section only`, `manual override`.

### Phase 4.7 — Section-focused editor + word-level diff highlighting

V4.6 surfaced the section logic via info panels but the editing surface was still a 5000-char textarea showing the whole merged prompt — the user had to scroll/search to find what to tune. The section-only before/after panel showed BEFORE and AFTER as plain text, leaving the actual change for the reader to spot mentally.

**A — Word-level diff highlighting**
- New `diff` npm dep (`^9.0.0`, Myers algorithm, ~30KB minified) imported in `ApplyDiffModal.vue`.
- `diffChunks(before, after)` helper turns string pairs into `[{type: added|removed|unchanged, text}]`.
- `diffChunkClass(type)` returns Tailwind classes: `bg-pass/20 text-pass` for added, `bg-fail/15 text-fail-text line-through` for removed, muted for unchanged.
- Two computed properties: `sectionDiff` (target section before vs LLM-modified) and `fullPromptDiff` (whole current vs proposedFullText).
- Render: `<span v-for="(c, i) in chunks" :class="diffChunkClass(c.type)">{{ c.text }}</span>` inside a `<pre>` block. Whitespace preserved.

**B — Section-focused editor as default**
- New state: `editedSectionText` (the section being edited), `editedFullText` (fallback / opt-in whole-prompt mode), `editMode: 'section' | 'full'`.
- `sectionEditAvailable` computed — `true` when `sectionAware` exists, `fallback` is null, `targetSectionText` is non-empty AND is a verbatim substring of `currentText`. False → auto-switches to 'full' mode.
- `proposedFullText` computed — in `'section'` mode, splices `editedSectionText` back into `currentText` (replacing `targetSectionText` by indexOf+slice); in `'full'` mode, returns `editedFullText` verbatim.
- `watch(proposedFullText)` triggers debounced validate — same backend contract as before, no API changes.
- `onConfirm` sends `proposedFullText.value` as `finalText` — backend doesn't know or care about section mode.

**Modal layout (default — section mode)**:
- Section-aware info card (existing V4.6)
- "AI's change to {SectionName} — added text highlighted" panel: highlighted diff preview, shown until user edits
- Side-by-side: `ORIGINAL · {SectionName}` (read-only, ~500 chars) | `MODIFIED (editable)` textarea (pre-filled with `modifiedSectionText`)
- Collapsible "▾ Show full prompt context" → reveals full-prompt with highlighted spans for whatever the splice produced
- `⤢ Edit whole prompt instead` button toggles to `'full'` mode

**Modal layout (full mode — opt-in or fallback)**:
- Yellow notice when sectionEdit unavailable explaining why
- Side-by-side: `CURRENT (whole prompt)` | `PROPOSED (editable)` (~5000 chars)
- Collapsible "▾ Show what changed" → highlighted diff view
- `⤡ Back to section-focused edit` button (when sectionEditAvailable)

**`toggleEditMode()` preserves user's edits**:
- Going `section → full`: seeds `editedFullText` with the current `proposedFullText` (whatever the splice would produce)
- Going `full → section`: best-effort tries to re-extract the user's section edits from the full prompt by matching the prefix+suffix; only succeeds if the user didn't touch the other-section text.

**Verification**:
- Build clean (`✓ built in 4.40s`, 44KB bundle for PatternsView chunk).
- Strings shipped: `AI's change to`, `Edit just the`, `Edit whole prompt`, `Show full prompt context`, `Show what changed`.
- Splice math: `currentText.indexOf(targetSectionText) + editedSectionText` symmetric with `aiSuggestedText` when user hasn't edited (validated by inspection).
- Fallback path: when `sectionAware.fallback` is non-null OR `targetSectionText` not in `currentText`, auto-switches to whole-prompt editor.

### Phase 4.8 — Apply flow works against test DB (LocalAgentService adapter)

Previously the apply pipeline short-circuited for `reg-*` demo agents with a friendly "switch to LIVE mode" error. The rest of the chain (PromptStructure parsing, validators, lifecycle, prompt-version recording, measurement) was already DB-agnostic — only the HL HTTP layer needed mocking.

**New service: `LocalAgentService.js`**
- Mirrors `HLVoiceAgentService` interface 1:1: `getAgent(id)`, `updateAgent(id, patchBody)`, `updateAgentPrompt(id, text)`.
- `getAgent` reads `agents.{id, name, script, goal}` and normalises to HL shape (`{ id, agentName, agentPrompt, goal }`).
- `updateAgent` accepts the same `{ agentPrompt, agentName, goal }` patchBody shape and writes via `UPDATE agents SET ...`.
- Throws `LOCAL_AGENT_NOT_FOUND` (status 404) on missing rows — matches HL's error shape.

**Adapter factory: `getAgentService(agentId, { locationId })`**
- `agentId.startsWith('reg-')` → returns `new LocalAgentService()`
- otherwise → returns `new HLVoiceAgentService({ locationId })`
- Lazy-requires HLVoiceAgentService to avoid circular dep with HLAuth.
- Single source of truth for the routing decision.

**Wired into**:
- `routes/apply.js` — 3 sites (`preview-apply`, `validate`, `apply` route handler) now use `getAgentService(rec.agent_id, { locationId })`. The 3 `_isDemoAgent()` short-circuits removed; helper deleted.
- `ApplyRecommendationService.js` — both `apply()` (line ~60) and `rollback()` (line ~200) now use the factory. Rollback uses `rec.agent_id` since it doesn't receive `agentId` as a method param.

**Verification end-to-end on test DB**:
- Switched to test DB, found active rec on `reg-grace` (Grace — Legal Intake).
- `GET /preview-apply` → returns successfully (was 409 DEMO_AGENT before): 486-char current prompt, 522-char AI-suggested, all 7 validators pass, sectionAware parsed 2 sections, target = Script/Steps.
- `POST /apply` with the AI-suggested text → returns `outcome: success` with full timeline including `snapshot`, `patch [status=200, newLen=522]`, `record_prompt_version [newVersionId=96c94365]`, `mark_applied`, `edit_summary`, `log_audit`.
- DB state after: rec `status=applied`, `applied_via=auto_api`, `applied_prompt_version_id=96c94365`. New row in `agent_prompt_versions`. `agents.script` length updated from 486 to 522.

**What this unlocks**:
- Full demo of V4 apply flow works against test DB without HL connectivity. The "switch to LIVE mode" moment in `DEMO_SCRIPT.md` is now optional, not required.
- Section editor (V4.7) + word-level diff (V4.7) + section override (V4.6) all visible against test data.
- Regression suite could add direct V4 apply assertions without burning HL quota.

**What's still LIVE-only by design**:
- The actual HL Voice AI PATCH (verified at the production boundary).
- OAuth installations + token refresh.
- Real call ingestion from HL `/voice-ai/dashboard/call-logs`.

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

## 6. Acceptance criteria — current ship (v5.9)

All passing as of 2026-06-10:

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
- [x] Apply modal shows the full section list with the AI-picked target highlighted; user can override the section via dropdown; section-only before/after diff renders above the full-prompt diff
- [x] Apply modal opens with section-focused editor (just the target section) by default; user edits ~500 chars instead of ~5000; whole-prompt edit available via toggle; word-level diff highlights (green=added) make AI's change visually scannable in both views
- [x] Apply chain (preview → validate → apply → rollback) works end-to-end against test DB `reg-*` agents via `LocalAgentService`; same orchestration as live but writes to local `agents` table instead of PATCHing HL
- [x] Lifecycle one-liner in Flywheel hero reads honestly: "{N} recs from {M} issues → {applied} applied ({%}) → {measured} measured ({%}) → {improved} improved ({%})" — issues are upstream context, not a funnel stage (different units; one issue ≠ one rec)
- [x] Operational stage cards default to all-expanded (V4.x polish) — both `/flywheel` agency view and Agent Detail horizontal flywheel; `Collapse all` / `Expand all` mass toggles available

### Phase 4.9 — Scaled-flywheel simulation (test DB demo state)

Test DB seeded from 30 calls → 155 calls so the dashboard tells a credible at-scale story for the FSB reviewer.

**Two scripts shipped** (`backend/scripts/`):
- `simulate-scaled-flywheel.js` — generates 22 real-OpenAI seed analyses (4-5 distinct failure scenarios per agent) + 96 synthetic variations (direct DB insert with ±5pt KPI jitter, same failure mode, jittered timestamps). ~$0.50 in OpenAI cost, ~4 min runtime.
- `simulate-apply-patterns.js` — picks the top 4 critical patterns, hits `preview-apply` (using V4.2 section-aware insertion), POSTs `/apply` via the real V4 flow (V4.8 LocalAgentService for `reg-*` agents), then injects 4 synthetic post-apply calls per applied rec and triggers `computePendingOutcomes`.

**Final state on test DB (after both scripts)**:
- 155 calls across 4 agents (FrontDoor 47, Grace 44, Maya 44, Receptionist 8) + post-apply variations
- 46 recommendations (semantic dedup kept it tight: 21 "Follow Script Steps" occurrences clustered into 1 row, etc)
- 8 applied (3 newly applied via real V4 flow + 5 from earlier session)
- 7 measured (Δ delta computed against post-apply samples)
- 5 significant improvements (Δ≥2 AND n≥3), 1 caught regression (-27.6 pts on "Confirm Appointment" — system correctly flagged for re-investigation)
- Pass rate 51% (76/150 calls passed all KPI thresholds)
- Cross-agent patterns: "Follow Script Steps" + "Capture Caller Information" each span 2 agents

**What the simulation proves end-to-end**:
- Semantic dedup at scale: 21 variations of "Capture Lead Data" / "Capture Caller Information" all merged into one cluster
- V4.2 section-aware insertion: each apply targeted Script/Steps section appropriately
- V4.2 context_consistency validator caught 1 real conflict, blocked the apply (correct behavior)
- V4.3 measurement chain: every applied rec got `applied_prompt_version_id` set + post-apply calls measured automatically
- V4.5 patterns rollup: cross-agent state ("Capture Caller Info" shows "applied 0/2 — needed on 2 agents") works at real scale
- V4.7 inline diff highlighting + V4.8 LocalAgentService: section-focused editor + local-DB apply both verified

**Observations during the simulation**:
- 1 apply was BLOCKED by `context_consistency` (Maya's "Summarize Next Steps"). Not a bug — the validator correctly identified that the proposed addition contradicted existing prompt instructions. This is the safety net working.
- 1 measured outcome regressed (-27.6 pts). Realistic — not every fix improves things. The system surfaces it in the Measure narrative as "Regression: ... (re-investigate)" which is exactly what the customer should see.
- "Biggest leak: Recommendations Applied (17%)" correctly identifies user-actionable bottleneck — 38 recs queued, 8 applied.

**Reviewer-facing demo benefit**:
- Funnel feels production-scale (74 issues, not 8)
- Cross-agent patterns visibly cluster (not just one agent's bugs)
- Measure narrative is rich: "5/7 improved (71%) — 5 significantly. Best: 'Follow Script Steps' +20.3 pts. Regression: 'Confirm Appointment' -27.6 pts"
- All ~$0.50 in real OpenAI cost — reproducible on demand.

### Phase 5.0 — Actions ↔ Flywheel connection + delta-display fix

A field check exposed two real product gaps in the Actions surface: the hero card showed `actionsRequired: 67 (6600%)` (mathematically correct period-over-period but visually meaningless when the prior count was 1), and resolving 67 actions manually didn't move the flywheel needle at all. Two issues to fix:

**Fix 1: Period-over-period % capping** (`backend/src/routes/dashboard.js`)
- `pct()` now returns `null` when prior period < 5 (tiny base makes % meaningless — e.g. 1→67 reads as 6600% which is mathematically right but visually absurd)
- New `rawDelta(now, prev)` helper returns the absolute change
- Every hero metric now exposes both `delta` (%) and `deltaRaw` (count)
- `MetricHeroCard.vue` chooses: shows raw count when `delta` is null OR `|delta| > 500`; tooltip explains why

**Fix 2: Actions ↔ Flywheel disconnect** — Actions were purely operational (resolve/dismiss/escalate as a status overlay) with NO causal link to agent improvement. Resolving them was bookkeeping. New escalation-pattern auto-spawn closes the loop:

- `routes/actions.js POST /:callId/:turnIndex/:actionType/escalate` now calls `_maybeSpawnEscalationRec(callId, actionType)` after writing the status
- Counts escalations of the SAME `(agent_id, action_type)` in the last 30 days
- When count ≥ 3 AND no existing rec for that pattern → creates a new active recommendation:
  - `title`: `"Reduce recurring '{actionType}' escalations"`
  - `severity`: `warning`
  - `type`: `escalation_pattern`
  - `cluster_key`: `escalation pattern {actionType}` (stable, so subsequent escalations bump occurrence_count instead of creating duplicates)
  - `detail` + `suggested_change`: explain the pattern and direct user to investigate
- Auto-spawned rec flows naturally into Patterns view + Apply flow → flywheel closes
- Response now returns `spawnedRec` so the UI can surface a confirmation

**Fix 3: Honest labeling** (`frontend/src/views/ActionsView.vue`)
- Subtitle now reads: "**Operational triage queue** — moments the AI flagged for human follow-up. Resolving these doesn't change the agent itself; for agent improvement see [Patterns]. · Escalate 3+ times for the same action type and the system auto-creates a Patterns recommendation."
- Sets the right expectation upfront — resolve = ops bookkeeping, escalate = trigger improvement

**Verified end-to-end** on test DB (3 escalations of `script_training` on different reg-grace calls):
- 1st + 2nd escalation: `spawnedRec: null` (below threshold)
- 3rd escalation: `spawnedRec: { id, status: 'spawned', count: 3, title: 'Reduce recurring "script_training" escalations' }`
- New `recommendations` row with type=`escalation_pattern`, severity=warning, occurrence_count=3
- Visible immediately in `/patterns` page; can be applied via real V4 flow

### Phase 5.1 — Monitor→Improve Loop strip redesign

The Overview's `Core Functionality / Monitor → Analyze Loop` widget showed 4 generic steps (Ingest, Analyze, **Surface**, **Act**) that stopped before the closure. Anyone scanning that card would see "this product detects problems" but miss "this product *closes the loop and proves the fixes work*" — the V4+ differentiator was invisible at the Overview level.

**Renamed**: `Monitor → Analyze Loop` → `Monitor → Improve Loop` (sets the right expectation: the product fixes things, doesn't just observe).

**5 steps replace 4**: Ingest → Analyze → Recommend → Apply → Measure. The last two are the V4-V4.8 work made visible — without them the card was a half-product narrative.

**Per-step trend deltas**: each card shows `↑ +N vs prior` colored by direction. Single point-in-time numbers don't tell a story; deltas do. Reviewer instantly sees motion.

**Closure callouts replace buried "Why" line** — two bold lines:
- `Closure: {closureRate}% of issues → significant improvement (Δ ≥ 2 pts, n ≥ 3)`
- `Best fix: "{title}" +{delta} pts (n={sampleSize})`

The "Best fix" line is the demo gold. On test DB: `"Follow the Script Steps" +20.3 pts (n=4)` — concrete proof the flywheel works.

**Pre-closure state** when nothing measured yet: replaces the callouts with a gentle "Apply a recommendation + accumulate post-apply calls to see the loop close." Honest framing, no fake numbers.

**Backend changes** (`/api/flywheel/summary` payload):
- New `monitorImproveStrip` field with `{ingest, analyze, recommend, apply, measure, bestFix}` shape
- Each stage has `current`, `prior` (same-length window shifted back), `deltaRaw`
- `analyze` includes `currentAvgScore` + `priorAvgScore` so the score delta is in points, not %
- `measure` exposes `significantCount` (Δ≥2 AND n≥3) and `anyCount` for the sub-label
- `bestFix` returns the highest-delta measured rec in the window (or null pre-closure)
- All computed in the existing `/api/flywheel/summary` route — no new endpoint

**Files**: `backend/src/routes/flywheel.js`, `frontend/src/components/MonitorAnalyzeHero.vue`

**Verified on test DB** (155 calls, 8 applied, 5 significant improvements): strip shows `Ingest 150 ↑146, Analyze 62/100 ↓3.9pts, Recommend 47 ↑47, Apply 8 ↑8, Measure 7 (5 significant) ↑7` + `Best fix: "Follow the Script Steps" +20.3 pts (n=4)`.

### Phase 5.2 — Dashboard delta-label clarity

Dashboard inspection turned up inconsistent delta phrasing: hero cards read `↑ 66 (vs previous period)` while the Monitor→Improve strip read `↑ N vs prior` — two phrasings on the same page for the same concept, and neither said what "period" / "prior" actually meant.

**Fix**: unified vocabulary `vs prior {N}d` everywhere, where N is the actively-selected time-range filter.

- `MetricHeroCard.vue` + `MonitorAnalyzeHero.vue` accept new `windowDays` prop
- `OverviewView.vue` passes `rangeDays` through to all 5 hero cards + the strip
- Both components compute `windowLabel = props.windowDays ? \`prior ${windowDays}d\` : 'prior period'` (graceful fallback)
- Delta line tooltip explains the exact comparison: `"Comparing last 30 days (May 10 – Jun 9) vs prior 30 days (Apr 10 – May 10)"`
- When delta is 0, the line is fully suppressed (no "→ 0 vs prior" noise)

**Result**: same label everywhere, self-explanatory at a glance, exact dates available on hover. When user changes the time filter (7d / 14d / 30d / 90d), the labels live-update.

### Phase 5.3 — Caller Mood Trend redesign

A review of the `Sentiment Trend` widget surfaced 9 real product issues — title was generic, subtitle was jargon ("sentiment bucket"), bucket thresholds didn't match the agent's sentiment KPI threshold, zero-data days plotted as 0% (read as "agent collapsed"), x-axis was technical (`06-04`), tooltip had no sample size, no per-agent filter, no spike detection, no actionable footer.

**Backend changes** (`backend/src/routes/dashboard.js`):
- `computeSentimentTrend` now returns `total` (sample size), `hasData`, plus raw counts per bucket — UI uses these for "N of M calls" tooltips and to hide zero-data days
- Accepts optional `agentId` filter so per-agent trend is possible
- New `computeSentimentSpike(trend)` — detects worst-mood day (negative ≥ 50% OR a +20pt jump vs prior day) and links to the top occurrence-count active rec on the same agent(s)
- Response now exposes `sentimentTrend`, `sentimentSpike`, `sentimentBucketThresholds`, `sentimentAgentFilter`
- Endpoint accepts `?sentimentAgentId=<id>` query param

**Frontend changes** (`frontend/src/components/SentimentTrend.vue` + `OverviewView.vue`):
- Renamed: `Sentiment Trend` → `Caller Mood Trend`
- Subtitle in plain English with color legend: `green = happy, yellow = mixed, red = upset` + threshold caption
- Per-agent dropdown (All agents / specific agent) — emits `filter-change` event; parent re-fetches
- Day labels: weekday names for ≤14d windows, `Jun 4` format for longer
- No-data days plot `null` (gap in line) instead of `0%` — stops "agent collapsed" misread
- Custom tooltip shows `"Fri Jun 7 — Happy: 25% (3 of 12)"` with all 3 buckets + sample size
- Spike day auto-annotated with red vertical line + "Spike" label using ApexCharts annotations API
- Footer: `🚨 Worst day: Fri Jun 7 — 100% upset (11 of 11 calls) · jumped +67 pts vs prior day` + top-pattern link to Patterns when available
- Footer also notes `ⓘ N days in this window had no calls` when applicable

**Verified end-to-end on live DB**:
- Backend returns 30-day trend with 27 data-days and 3 gaps; spike correctly identified June 8 (11 of 11 calls negative, +67 jump)
- Bundle includes new strings: `Caller Mood Trend`, `Happy`, `Mixed`, `Upset`, `Worst day:`, `threshold:`

### Phase 5.4 — Dashboard numbers audit + Conversion vs KPI Pass

Testing against the seeded test DB surfaced a clear correctness bug: `Success Rate: 0%` despite multiple calls being measured and improved. Investigation uncovered 4 issues across the hero metrics:

**Bug 1 — Success Rate hardcoded to a single string**
- `computeSuccessRate` (`backend/src/routes/dashboard.js`) used `WHERE c.outcome = 'booked'` literally — but real outcomes are variants like `meeting_booked`, `consultation_booked`, `appointment_booked`, `trial_started`. None matched exactly so the SUM always returned 0.
- **Fix**: Replaced with `computeConversionRate` using a `POSITIVE_OUTCOMES` set of common variants. Test DB now reports 6% (9 of 151 — correct).

**Bug 2 — `totalCallsAnalyzed` was misleading**
- Field returned `totalCalls` (every ingested call, including pending/failed analyses). Label said "analyzed" but the value didn't filter on analysis_status.
- **Fix**: New `computeAnalysedCount(sinceISO)` query filters `WHERE analysis_status = 'completed'`. Original `totalCalls` value exposed separately as `totalCallsIngested` for back-compat.

**Bug 3 — Internal inconsistency: two definitions of "success" on the same product**
- Overview hero showed "Success Rate" defined by `outcome = 'booked'` (business outcome).
- Flywheel impact showed "Pass Rate" defined by `status = 'pass'` (KPI quality).
- These are orthogonal signals — a call can be `lost` but agent did everything right, or `completed` with agent doing poorly. Both legitimate, but the dashboard called only one "success" without disambiguating.
- **Fix**: Renamed the conversion metric to "Conversion Rate" (matches what it measures — business outcome) and added a new hero card "KPI Pass Rate" (matches the flywheel signal). Hero row now has 6 cards instead of 5; both signals visible side-by-side.

**Bug 4 — Naming**
- "Success Rate" was ambiguous about what counts as success. "Conversion Rate" + "KPI Pass Rate" are precise.

**Result on test DB (was → now)**:
- `successRate: 0%` → `conversionRate: 6%` (9 of 151 calls had positive business outcomes)
- New `kpiPassRate: 50.7%` (matches flywheel impact's pass rate — internally consistent)
- `totalCallsAnalyzed: 151` (was just `totalCalls`; now reflects actual analysed count via `analysis_status='completed'`)
- Back-compat: `hero.successRate` still returned (aliased to `conversionRate`) so any external reader still parses.

**Files**: `backend/src/routes/dashboard.js`, `frontend/src/views/OverviewView.vue` (6 hero cards instead of 5; tweaked icons so two different "score" cards aren't both 🎯).

### Phase 5.5 — Agent Detail redesign (FSB-aligned)

An audit of `/agents/:id` against the Core Functionality requirements surfaced three coverage gaps + several UX issues:

**Gaps vs FSB Core Functionality**:
1. "Highlight Use Actions" — not surfaced on Agent Detail at all
2. "Immediate recommendations for prompt/script/agent adjustments" — AI Insights cards showed `suggestedChange` as TEXT only, no Apply button
3. "Validation Flywheel" — applied recommendations weren't visible at agent level with their measurement proof

**Additional UX issues**:
- Worst-KPI badge appeared in hero AND as a full callout below — redundant
- Trend label "↑ trending up" had no comparison-period context
- No deviations/missed opps aggregate at agent level
- Calls list had no hallucination flag, date with no time
- No period selector matching dashboard

**Backend** (`backend/src/routes/agents.js GET /:id?days=30`):
- Accepts `days` query param (default 30); computes prior-period for trend deltas
- New `quickStats` field: `{ totalCalls, totalCallsDelta, conversionRate, conversionCount, kpiPassRate, passCount, avgCycleDays, hallucinationCalls }` — answers "is this agent healthy?" in 4 numbers
- New `useActionsBreakdown` field: per `actionType` count + status overlay (pending/escalated/resolved/dismissed) — FSB-required Use Actions surface
- New `deviationsAggregate` + `missedOpportunitiesAggregate`: top 5 by call-count, parsed from `analyses.deviations_json` + `missed_opportunities_json`
- New `recentlyApplied` field: last 5 applied recs with `delta`, `afterSampleSize`, `status` (`measured_significant` / `measured_minor` / `measured_regression` / `waiting`) — closes the FSB Validation Flywheel loop at agent level

**Frontend** (`frontend/src/views/AgentDetailView.vue` — substantial rewrite):
- Hero consolidated: donut + name + goal + 4-stat grid (Calls Δ, Conversion %, KPI Pass %, Cycle Time) + single-line trend + worst-KPI badge + hallucination badge inline
- New "Use Actions for this agent" section with per-type breakdown + queue links — addresses the explicit FSB requirement
- New "Recurring Deviations + Missed Opportunities + Recently Applied" card — 3 sub-sections in one card showing the full FSB Monitor→Analyze→Validate loop
- AI Insights cards now have **Apply buttons** (uses existing `ApplyRecommendationButton` → V4 apply flow)
- "See all patterns for this agent →" link below Insights
- Calls list shows inline hallucination badge + `Jun 9 14:32` date+time format
- Period selector (7/14/30/90 days) in filters — matches main dashboard

**Frontend store** (`frontend/src/stores/agentStore.js`):
- `fetchAgent(id, { days })` accepts days param

**Verified end-to-end** on test DB `reg-maya`:
- quickStats: 48 calls, 8.3% conversion, 63.8% pass rate, 0.9d cycle, 8 hallucinations
- useActionsBreakdown: 7 `script_training` (all resolved)
- deviationsAggregate: "Did not ask about specific problem" — 17 of 48 calls (35%)
- recentlyApplied: 3 measured_significant recs with deltas +20.3, +19.6, +19.6 pts (n=3-4)
- All FSB requirements (Monitor / Analyze / Use Actions / immediate recommendations / Validation Flywheel) now visible at agent level

### Phase 5.6 — Per-agent Caller Mood Trend on Agent Detail

The agency-wide Caller Mood Trend (V5.3) only lived on Overview, forcing the user to navigate back and filter by agent to spot per-agent mood shifts. V5.6 surfaces the same widget on Agent Detail so the signal stays in context. Plan + validation:

**Architectural decision — extract helpers to a shared service**:
- `computeSentimentTrend` and `computeSentimentSpike` previously lived in `routes/dashboard.js`. Cross-route reuse would require either circular-import gymnastics or duplication.
- Moved to `backend/src/services/SentimentService.js` — both dashboard and agents routes now require from one canonical place. `dashboard.js` re-exports nothing new; functional behaviour identical.
- `computeSentimentSpike(trend, agentId)` extended with optional `agentId` so the "top contributing pattern" lookup can scope to a single agent on the Agent Detail surface (vs. agency-wide on Overview).

**Backend** — `backend/src/routes/agents.js GET /:id`:
- Calls `computeSentimentTrend(sinceISO, days, agent.id)` — same window the rest of the agent endpoint uses
- Calls `computeSentimentSpike(sentimentTrend, agent.id)` — agent-scoped top pattern
- Response now includes `sentimentTrend`, `sentimentSpike`, `sentimentBucketThresholds` (matches the shape Overview uses)

**Frontend** — `AgentDetailView.vue`:
- Imports the existing `SentimentTrend.vue` component (V5.3) — zero new widget code
- Placed AFTER Use Actions, BEFORE the Per-agent Flywheel — gives mood context before deviation analysis
- Passes empty `agents=[]` → dropdown auto-hides (no need to pick agent; we're already drilled in)
- Period selector at top of Agent Detail (V5.5) controls mood window too — consistent
- Spike footer auto-links to /patterns?agentId=… for next-step action

**Verified end-to-end on test DB `reg-maya`**:
- `sentimentTrend`: 30 days, 14 days with data
- `sentimentSpike`: `2026-05-25` (100% negative, 1 of 1 call), top pattern "Summarize Next Steps" (this agent's active rec) — scoping working correctly
- Bundle contains `SentimentTrend` import + new field bindings

**Files**: `backend/src/services/SentimentService.js` (new), `backend/src/routes/dashboard.js` (now requires from service), `backend/src/routes/agents.js` (uses the service + extends response), `frontend/src/views/AgentDetailView.vue` (places the component).

### Phase 5.7 — preview-apply latency optimization (offset-based parseSections)

Profiling exposed `preview-apply` taking ~47s on a cold call. Per-step instrumentation isolated the bottleneck to `PromptStructureService.parseSections` — 47s of 49s total. Root cause: the LLM was being asked to OUTPUT the full verbatim text of every section (~5K chars of output tokens for a 5K-char prompt). Most of the latency was OpenAI generation time on the huge structured-JSON output.

**A/B benchmark on Grace's 10,425-char prompt** (`backend/scripts/bench-parse-sections-ab.js`):
- VERBATIM (current): median 47s, 2,591 output tokens
- OFFSETS (proposed): median 9.7s, 487 output tokens — **4.84× faster** when LLM follows instructions

**LLM stochasticity caught by A/B**: with naive offset prompt, 67% hit rate (2 of 3 runs hit 100% coverage; 1 reverted to header-only ~27% coverage). After tightening the prompt with explicit "every char must belong to a section" rules + worked example, hit rate climbed to 67% consistently.

**Safeguards required for production**:
1. **Coverage gate** — accept offset output only if total span ≥ 70% of prompt length
2. **Validity checks** — no overlapping, no out-of-bounds, no negative spans
3. **One retry** on validation failure before falling back
4. **Verbatim fallback** — the old slow-but-deterministic path kicks in if offset attempts exhaust
5. **Fallback rate logging** — INFO log line emits `path: 'offsets' | 'verbatim-fallback'` plus `coverage` and `attempt` so production usage is observable
6. **Parser version bump** — `PARSER_VERSION` `'1.0'` → `'2.0'` invalidates the `agent_prompt_structure` cache; next read re-parses with new code

**Expected production latency** (with retry+fallback):
| Outcome | Probability | parseSections latency |
|---|---|---|
| Offset hits first try | ~67% | ~7s |
| Offset hits on retry | ~22% | ~15s |
| Both fail → verbatim fallback | ~11% | ~55s |
| **Weighted expected** | | **~15s** |

**Verified end-to-end**:
- Live cold preview-apply on Grace (10K-char prompt): **47s → 13.4s** (72% cut). `path: 'offsets'`, attempt 1, coverage=1.0
- V4.2 regression: **14/14 assertions pass**. Offset path hit on every scenario. Coverage 100% on the test prompts (smaller, well-structured).
- Downstream contract unchanged: `proposeInsertion` and the 7 validators still receive `[{id, name, summary, text}]` — `text` is now sliced from the prompt by the backend instead of generated by the LLM.

**Architectural integrity**:
- `proposeInsertion` splice algorithm unchanged (uses `currentPrompt.includes(target.text)` which is now guaranteed because text comes from `slice()`)
- `context_consistency` validator unchanged (operates on full prompt)
- `section_fit` validator unchanged (operates on section IDs)
- `agent_prompt_structure` cache schema unchanged — same `sections_json` blob format, only `parser_version` bumped

**Files**: `backend/src/services/PromptStructureService.js` (new `_parseWithSafeguards`, `_llmParseOffsets`, `_validateOffsets`, `_materialiseFromOffsets`; kept `_llmParseVerbatim` as fallback), `backend/scripts/bench-parse-sections-ab.js` (benchmark, kept for future tuning).

### Phase 5.8 — Vocabulary + threshold alignment (consistency audit)

PM + tech-architect audit found 2 real inconsistencies between what the UI claims and what the implementation does:

**Bug 1: Sentiment threshold mismatch**
- `SentimentService` used `POSITIVE_THRESHOLD=70`, `NEGATIVE_CEIL=50` (V5.3)
- But the per-agent sentiment KPI seeded by `IngestionService` has `threshold=60` (matching all default KPIs)
- Net effect: a call with `sentiment_score=65` showed as **"mixed/yellow"** on the Caller Mood Trend chart but was counted as **passing the KPI threshold** in the KPI Pass Rate. Same number → contradictory verdicts on two cards of the same dashboard.

**Fix**: Aligned `SentimentService` thresholds to `POSITIVE_THRESHOLD=60`, `NEGATIVE_CEIL=30`. Now ≥60 is "happy" (matches KPI grading), 30-59 is "mixed", <30 is "upset". Both `dashboard.js` and `agents.js` response objects updated to return `{ positive: 60, negative: 30 }`.

**Bug 2: "Patterns" vs "Recommendations" vocabulary drift**
- Same entity referenced as "Patterns" on some surfaces and "Recommendations" on others — confusing.
- The DB table is `recommendations`. The `/patterns` page groups them by `cluster_key` for the "fix once, help many" view.
- Decision: unify on **"Recommendations"** everywhere user-facing, keep route URL `/patterns` for link stability.

**Renames** (all user-facing labels updated):
- `Topbar.vue` nav tab: `Patterns` → `Recommendations`
- `PatternsView.vue` h1: `Failure Patterns` → `Recommendations`
- `PatternsView.vue` summary stat: `Patterns` → `Recommendations`
- `MonitorAnalyzeHero.vue` step sub-label: `patterns surfaced` → `recommendations surfaced`
- `ActionsView.vue` link text: `Patterns` → `Recommendations`
- `AgentDetailView.vue` link text: `Patterns` → `Recommendations`
- Route URL `/patterns` left unchanged (avoids breaking bookmarks/redirects)

**Verified** — `grep` audit confirms no remaining user-visible "Patterns" labels in frontend templates. Both endpoint responses now return aligned threshold values (60/30).

---

### Phase 5.9 — Agent Detail calls list redesign + hallucination prominence

PM-grade end-user audit of the Agent Detail page surfaced one real bug and a list of usability gaps that compounded into "I can't quickly see what's wrong with this agent."

**Bug — pagination silently missing**
- Header on the calls section said `Calls (47)` (from `callStore.totalCalls`) but the list rendered only 20 rows.
- Root cause: `callStore.fetchCalls` defaulted `limit=20`, the backend respected it, but the view had no Load More / page navigation / infinite scroll. Users genuinely thought 27 calls were missing.
- Secondary bug found during audit: the template referenced `call.hasHallucination` but the backend's `/agents/:id/calls` response never returned it — so the inline `⚠ hallucination` badge had been silently dead since the field was added.

**End-user UX gaps catalogued** (10 total):
1. Truncated to 20 of N (the bug)
2. No call duration shown — can't distinguish 30s hang-up from 5min conversation
3. No caller phone inline — can't spot repeat callers without opening each call
4. No Use Actions count badge — needs-follow-up signal hidden
5. No sort options — only "newest" implicitly; no "lowest score first" triage
6. Absolute date+time format ("Jun 9 14:32") harder to scan than "2h ago"
7. No day grouping — Friday's bad cluster invisible
8. Hallucination jargon ("hallucination") instead of customer-facing "unverified claim"
9. No hallucination/use-actions filter chips — highest-stakes signals had no shortcut
10. No search — can't find a specific call by number or issue text

**Fix — Option B (PM-recommended scope)** ships the bug fix + a full usability redesign:

**Backend (`GET /agents/:id/calls`)**:
- New query params: `sort` (newest/oldest/score_asc|desc/duration_asc|desc), `flag` (unverified/use_actions), `search` (matches caller_number OR top-issue text)
- Each row now returns `hasHallucination`, `unverifiedClaimsCount`, `topHallucinationQuote` (highest-confidence claim text), `useActionsCount`
- WHERE clauses parameter-bound (safer than the previous string-interpolated `statusFilter`)

**Store (`callStore`)**:
- `fetchCalls` accepts `append`, `sort`, `flag`, `search`
- New `hasMore` getter (calls.length < totalCalls) and `loadMore()` helper
- Search/page refetches dedupe by id in case of mid-flight filter changes

**View (`AgentDetailView.vue` — calls section)**:
- Sort dropdown · Search box (300ms debounce) · Filter chips: All / Pass / Warn / Fail / ⚠ Unverified / ⚡ Use Actions
- Day-grouping headers (Today / Yesterday / Mon Jun 8) for chronological sorts; suppressed for score/duration sorts (would scatter dates)
- Card-style 2-line rows: Line 1 = status + score + 📞 caller + ⏱ duration + time-ago; Line 2 = top issue + ⚡ N use actions badge
- "Load N more" button at bottom of list
- Header now reads `Calls — showing X of N` (truth-in-counts, removes the original confusion)

**3-layer hallucination treatment** (PM call: this signal carries brand/legal risk — it must visually outweigh other flags):
- **Layer 1 — plain language**: `⚠ hallucination` → `⚠ N unverified claims` (matches V3 Call Detail vocabulary)
- **Layer 2 — visual prominence**: red left border (`border-l-fail-text`) + amber banner above the row body. Clean calls keep a transparent border so risky ones pop on scan.
- **Layer 3 — hover tooltip**: surfaces the most concerning claim quote (`Most concerning unverified claim: "We're HIPAA-certified…"`), so triage doesn't require opening every call.

**Hero badge alignment**: Agent Detail hero's `⚠ {n} hallucinations` rewritten as `⚠ {n} calls with unverified claims` so terminology is consistent across the page.

**Verified against test DB (`reg-frontdoor` = 47 calls)**:
```
GET /api/agents/reg-frontdoor/calls?limit=20&page=1 → 20 rows, total=47
GET /api/agents/reg-frontdoor/calls?limit=20&page=2 → 20 rows, total=47
GET /api/agents/reg-frontdoor/calls?limit=20&page=3 →  7 rows, total=47   ✓ adds to 47
GET …/calls?sort=score_asc       → lowest scores first (13, 14, 14, 14)
GET …/calls?sort=duration_desc   → longest first (178s, 171s, 168s)
GET …/calls?search=DEMO-1        → 2 calls matched by caller_number
GET .../reg-maya/calls?flag=unverified → 8 calls, top quote: "We're fully HIPAA-certified, SOC 2 Type II audited…"
GET .../reg-grace/calls?flag=use_actions → 39 calls with action counts
```

---

### Phase 5.9.1 — Denominator consistency across Agent Detail

Follow-up PM audit on V5.9 found that three numbers on the Agent Detail page used three different denominators, breaking trust in the counts even though each number was internally correct.

For `reg-frontdoor` on the test DB at the default 30-day window:

| Surface | Number | Source |
|---|---|---|
| Hero "Calls" stat | 40 | `call_timestamp >= sinceISO` (windowed) |
| Recurring Deviations: "9 of **40** calls (22%)" | 40 | same windowed total |
| Calls list header "Calls (**47**)" | 47 | all calls for the agent — `GET /agents/:id/calls` ignored the period selector |

Result: the user saw "40" above and "47" below on the same page and reasonably assumed one was wrong.

**Fix 1 (the visible bug) — window the calls list by `?days=`**
- `GET /agents/:id/calls` now accepts `days` and applies `c.call_timestamp >= sinceISO` like the other endpoints
- `callStore.fetchCalls` + `loadMore` thread the param through
- `AgentDetailView` passes `rangeDays` so a single period selector drives every section
- Verified at days=7/30/90 across reg-grace, reg-maya, reg-frontdoor — hero stat and calls-list total agree in all 9 combos

**Fix 2 — make the windowing explicit in copy**
- "9 of 40 calls (22%)" → "9 of 40 calls **in last 30d** (22%)"
- Same change applied to Missed Opportunities row template
- Self-explanatory denominator; closes the "why 40 not 47?" confusion at the source

**Fix 3 (defensive) — `callCount` truly counts unique calls**
- `aggregateJsonField()` previously did `byDesc[desc].callCount++` for every JSON item, so if a single call's `deviations_json` ever contained the same description twice, the count would inflate.
- Today the test DB never generates that shape so the contract happened to hold, but the field name + UI label promise "X **of Y calls**". Switched to a `Set<call_id>` internally and expose `.size` as `callCount`.
- Today's numbers don't change (verified) — this is a latent bug guard.

**Fix 4 — longer description key**
- Bumped `slice(0, 100)` → `slice(0, 200)` to reduce silent collapse when the LLM emits long descriptions that share a 100-char prefix.

**Verified end-to-end on test DB**:
```
agent          window  hero  calls  match?
reg-grace          7d    17     17    ✓
reg-grace         30d    50     50    ✓
reg-grace         90d    52     52    ✓
reg-maya           7d    13     13    ✓
reg-maya          30d    48     48    ✓
reg-maya          90d    48     48    ✓
reg-frontdoor      7d    14     14    ✓
reg-frontdoor     30d    40     40    ✓
reg-frontdoor     90d    47     47    ✓
```

**Architect audit summary** (also captured in IMPLEMENTATION_PLAN audits across V4.3, V4.4, V5.4, V5.8, V5.9, V5.9.1):
- ✅ Funnel math + lifecycle sentence math match implementation
- ✅ Stage card `producesRows` correctly maps to funnel rows
- ✅ Apply chain (V4 + V4.3 fix) verified end-to-end on both DBs
- ✅ Measurement chain (V4.3 + V4.4 significance) aligned
- ✅ Patterns rollup (V4.5) per-agent state correct
- ✅ Use Actions → flywheel via escalation auto-spawn (V5.0)
- ✅ Conversion Rate vs KPI Pass Rate (V5.4) — two separately-labeled signals
- ✅ Sentiment thresholds now match per-agent KPI default (V5.8)
- ✅ "Patterns" terminology unified (V5.8)
- ✅ Latency optimization (V5.7) preserves downstream contract
- [x] Sync All works end-to-end and reflects in Funnel + Patterns within seconds
- [x] `npm run lint` passes in both backend and frontend with **zero warnings**
- [x] All routes return HTTP 200
- [x] WCAG AA contrast on every text token against every surface (audited)

---

## 7. Core Functionality coverage matrix

Mapping the original Core Functionality requirements to where each is implemented and how it has been verified.

### Monitor loop — Observability

| Requirement | Where it's implemented | Verification |
|---|---|---|
| Ingest existing Voice AI agent call transcripts | `IngestionService` + `HighLevelTranscriptProvider` (pull from `/voice-ai/dashboard/call-logs`) + `MockTranscriptProvider` (4 seed agents for offline dev) | Sync All button on Overview triggers ingestion; row counts visible in `bash .runtime/use-data.sh status` |
| Analyze transcripts | `AnalysisService` runs OpenAI `gpt-4o-mini` with strict JSON-schema per call | Per-call analysis row in `analyses` with `overall_score`, `status`, `kpi_scores_json`, etc |
| Set observability parameters based on agent's goals/script | `kpi_definitions` table is **per-agent** with `weight` + `threshold` + `description`; `KpiEditor.vue` inline-edits the values; LLM system prompt is rebuilt per analysis with the agent's specific KPI list | Editor enforces weights sum to 1.0; updated values flow into the next analysis without restart |
| Identify deviations | LLM returns `deviations[]` referencing specific script steps; surfaced as transcript-turn rings on Call Detail; aggregated per agent as "Recurring Deviations" (V5.5) | Call Detail Flags Timeline; Agent Detail "Recurring Deviations" lists "skipped step X in N of M calls" |
| Identify failures | `status='fail'` when recomputed `overall_score < 50`; recomputation uses `Σ(kpi_score × weight) / Σ(weight)` for arithmetic determinism | Status pill on every analysis; KPI Pass Rate on Overview hero |
| Identify missed opportunities | LLM returns `missedOpportunities[]` with per-turn references; aggregated per-agent as "Missed Opportunities" (V5.5) | Call Detail rings; Agent Detail aggregate list with frequency |

### Analyze loop — Unified Dashboard

| Requirement | Where it's implemented | Verification |
|---|---|---|
| Intuitive dashboard across existing agents | Overview page with 4-tab IA (Overview / Flywheel / Recommendations / Actions); hero metrics + Monitor→Improve 5-step strip with per-stage trend deltas (V5.1); responsive layout | `/dashboard/` loads, every tab returns HTTP 200, deltas update on filter change |
| Visualize performance issues | 6 hero cards (Total Calls, Conversion Rate, KPI Pass Rate, Avg Duration, KPI Avg, Actions Required); Caller Mood Trend with spike annotation (V5.3); Validation Funnel with leak vs waiting (V4.4); per-agent radar + KPI bars | Smoke test against test DB shows 6 cards populated, mood spike auto-annotated, funnel marks Recommendations Applied as "biggest leak" |
| Immediate recommendations for prompt/script/agent adjustments | First-class `recommendations` table with `cluster_key` dedup + semantic dedup (V4.5); V4 one-click apply via `PATCH /voice-ai/agents/:id` (PATCHes HL agent directly); editable diff modal with 7 live validators; section-aware insertion (V4.2) places fix in the right section; section-focused editor (V4.7) shows only the section being modified | 27/27 V4 regression assertions on real HL sandbox; 14/14 V4.2 validator regression; end-to-end V4.3 measurement chain verified on live data |
| Highlight Use Actions | Dedicated `/actions` queue with status overlay (`use_action_statuses` table); per-turn transcript rings on Call Detail; per-agent breakdown on Agent Detail (V5.5); escalation auto-spawn to recommendation when same `(agent, action_type)` is escalated 3+ times (V5.0) | Actions page lists every flagged turn; escalation auto-spawn verified end-to-end (3 escalations of `script_training` on `reg-grace` produced a new recommendation) |
| Validation Flywheel framing | 5-stage funnel (Issues Detected → Recommendations Generated → Applied → Measured → Improved) with conversion percentages; significance threshold `Δ≥2 pts AND n≥3`; leak vs waiting classification distinguishes user-actionable bottlenecks from natural data lag (V4.4); causal before/after via `applied_prompt_version_id` (V4.3 fix) | `computePendingOutcomes` runs at end of every analysis; verified on live HL: synthetic post-apply call → outcome computed automatically → flywheel "Outcomes Measured" increments |

## 8. Correctness & UX validation

### Does the product solve the agency owner's pain points?

| Pain point | Solution | Where the user feels it |
|---|---|---|
| "I don't have time to listen to every call" | Every call auto-scored + flagged in seconds | Overview shows totals + spike-day callouts; no manual triage needed |
| "I don't know which agent is dragging us down" | Per-agent KPI breakdown + per-agent mood trend + Worst-KPI badge | Agent Status Strip + Agent Detail page |
| "I see problems but don't know what to fix" | Recommendations clustered by failure mode with concrete `suggestedChange` text | Recommendations page + AI Insights cards with Apply button |
| "I tried a fix — did it actually work?" | Causal before/after measurement with significance threshold (Δ≥2 pts, n≥3) | Flywheel "Measure" stage + Recently Applied panel on Agent Detail |
| "Fixing each agent one at a time is slow" | Cross-agent pattern clustering — same fix applies to N agents | Recommendations page with per-agent rollup (Applied 1 of 2 — 1 still needed) |
| "When the AI hallucinates I'm liable" | Hallucination detection on every call + structured "what said / why flagged / why it matters / what to do" cards | Call Detail unverified-claims card + per-agent hallucination count badge |
| "Some calls need a human — I don't want them lost" | Use Actions queue with resolve/dismiss/escalate verbs; 3 escalations auto-spawn a recommendation | `/actions` page + per-agent breakdown + escalation→recommendation loop |

### Internal-consistency audit results

A full audit at v5.8 cross-checked every dashboard number against its implementation. Findings + resolutions:

| # | Finding | Status |
|---|---|---|
| 1 | Funnel arrow Issues→Generated implied a conversion but the units differ (calls vs recs) | Fixed V4.4 — dropped the arrow, shown as "1.62 recs/issue" context note instead |
| 2 | `successRate` was 0% on real data because it hardcoded `outcome='booked'` (no real outcome matched) | Fixed V5.4 — expanded to `POSITIVE_OUTCOMES` set + renamed to Conversion Rate |
| 3 | "Success" defined two different ways across pages (outcome vs KPI status) | Fixed V5.4 — two separate cards: Conversion Rate (business outcome) + KPI Pass Rate (agent quality) |
| 4 | `totalCallsAnalyzed` returned total calls regardless of analysis status | Fixed V5.4 — now filters on `analysis_status='completed'` |
| 5 | Caller Mood Trend used thresholds 70/50 but the per-agent sentiment KPI default was 60 — same number, two verdicts | Fixed V5.8 — aligned to 60/30 so chart and KPI grading agree |
| 6 | "Patterns" vs "Recommendations" used interchangeably on the same page | Fixed V5.8 — unified on "Recommendations" across all 6 user-facing labels |
| 7 | `Monitor → Improve Loop` strip showed `vs prior 30d` regardless of selected window | Fixed V5.2 — wrapped derived label in `computed()` so it reacts to prop changes |
| 8 | `applied_prompt_version_id` was null on every V4 apply → measurement chain silently broken | Fixed V4.3 — `ApplyRecommendationService` now records prompt version + writes ID; 3 stuck recs backfilled |
| 9 | Significance filter on Measure narrative said "0 significantly" even when there were significant improvements | Fixed V4.4 — `allMeasured` query was missing `after_sample_size` column |
| 10 | Actions surface said nothing about whether resolving them improves the agent | Fixed V5.0 — escalation auto-spawn closes the loop; subtitle clarifies "operational queue" |
| 11 | Agent Detail header said "Calls (47)" but the list only rendered 20 — no pagination UI even though backend supported `?page=&limit=` | Fixed V5.9 — Load More button + filter chips + day grouping + sort/search; header rewritten as "showing X of N" |
| 12 | `call.hasHallucination` referenced in the calls-list template but the backend never returned it → badge silently dead since the field was introduced | Fixed V5.9 — backend now derives `hasHallucination`, `unverifiedClaimsCount`, `topHallucinationQuote` per row from `hallucinations_json` |
| 13 | "Hallucination" jargon shown to end users instead of the customer-facing "unverified claim" vocabulary used on Call Detail | Fixed V5.9 — all calls-list + hero references unified on "unverified claim(s)" with 3-layer treatment (label, visual prominence, hover-quote) |
| 14 | Calls list header showed "Calls (47)" while deviation card on same page said "9 of 40 calls (22%)" — same agent, two different totals because list endpoint never applied the period selector | Fixed V5.9.1 — `GET /agents/:id/calls` now accepts `?days=` like the hero/deviation endpoints; deviation copy now explicit ("in last 30d") so the denominator is self-explanatory |
| 15 | `aggregateJsonField` counted occurrences not unique calls — contract said "X **of Y calls**" but a single call with the same description twice would have inflated the number | Fixed V5.9.1 (defensive) — switched to `Set<call_id>` internally; today's numbers unchanged but the contract now holds even if the LLM repeats a finding within one call |

### Reproducible verification

All claims above can be reproduced from a fresh DB:

```bash
# Switch to seeded test DB
bash .runtime/use-data.sh test

# Run the simulation that brings the test DB to a full flywheel state
node backend/scripts/regression/run.js --seed              # ~$0.10, ~3 min
node backend/scripts/simulate-scaled-flywheel.js           # ~$0.50, ~4 min
node backend/scripts/simulate-apply-patterns.js            # applies top 4 + measures

# Verify
curl -s -H 'X-API-Key: <key>' 'http://localhost:3001/api/flywheel/summary?days=30' | jq
curl -s -H 'X-API-Key: <key>' 'http://localhost:3001/api/dashboard/summary?days=30' | jq

# Run regression suites
node backend/scripts/regression/v4-2-validators.js         # 14/14 should pass
node backend/scripts/regression/v4-apply.js                # 27/27 against live HL sandbox
```

### Documentation aligned with implementation

This file (`IMPLEMENTATION_PLAN.md`) is treated as the canonical engineering log. Every shipped change updates the relevant Phase section + the Acceptance Criteria + this Core Functionality coverage matrix. The intent is that a reader can pick any feature claim in the README or any UI label and trace it back to (a) the Phase that shipped it, (b) the code that implements it, and (c) the verification that proved it.

## 9. Deliverables checklist

| Deliverable | Status | Where |
|---|---|---|
| GitHub repo | ✅ | https://github.com/UdayAppam/voice-agent-flywheel |
| README with Team-of-One framing + functional/mocked breakdown | ✅ | `README.md` |
| Architecture documentation | ✅ | `docs/ARCHITECTURE.md` |
| Implementation plan | ✅ (this file) | `docs/IMPLEMENTATION_PLAN.md` |
| Data model | ✅ | `docs/DATA_MODEL.md` |
| REST API specification | ✅ | `docs/API_SPEC.md` |
| HL integration guide | ✅ | `docs/INTEGRATION.md` |
| Demo script (2-5 min Loom) | Script written, recording pending | `docs/DEMO_SCRIPT.md` |
| V4 design doc + API discovery | ✅ | `docs/V4_PLAN.md`, `docs/V4_API_DISCOVERY.md` |
| Regression suites | ✅ | `backend/scripts/regression/` (scenario suite + v4-apply + v4-2-validators) |
| Simulation scripts (test DB demo state) | ✅ | `backend/scripts/simulate-scaled-flywheel.js`, `simulate-apply-patterns.js` |
| Benchmark script (latency tuning) | ✅ | `backend/scripts/bench-parse-sections-ab.js` |
| Functional/mocked breakdown | ✅ | README capabilities matrix (~25 capabilities, each marked Live or Out of scope) |
