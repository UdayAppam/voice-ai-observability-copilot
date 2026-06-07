# API Specification

Exhaustive list of every REST endpoint. Reflects routes as shipped.

Auth: all `/api/*` requires `X-API-Key: <env API_KEY>` header **except** `/api/oauth/*` and `/api/webhooks/*` (HL is the caller). Health check (`/health`) is also unauthenticated.

Base URL: same origin as the dashboard (`/api`).

Error shape (normalised by `middleware/errorHandler.js`):
```json
{ "error": { "code": "STRING_CODE", "message": "human-readable", "status": 400 } }
```

---

## Health

### `GET /health`
DB ping. No auth.
```json
{ "status": "ok", "db": "connected", "timestamp": "2026-06-06T14:00:00.000Z" }
```

---

## Dashboard

### `GET /api/dashboard/summary?days=30`
Powers the Overview page hero metrics + AgentStatusStrip + failure reasons + sentiment + calls-needing-attention + KPI radar.
```json
{
  "hero": { "totalCalls": {...}, "successRate": {...}, "avgDuration": {...}, "avgHealthScore": {...}, "actionsRequired": {...} },
  "agentStatusStrip": [...],
  "topFailureReasons": [...],
  "sentimentTrend": [...],
  "callsNeedingAttention": [...],
  "aggregatedRecommendations": [...],
  "kpiPerformance": { "call_completion": 78, ... },
  "agents": [...],
  "totalAgents": 4,
  "loopClosing": {...}
}
```

---

## Agents

### `GET /api/agents`
List all agents with health score + total call count.
```json
{ "agents": [ { "id": "...", "name": "...", "goal": "...", "healthScore": 78, "totalCalls": 12 } ] }
```

### `GET /api/agents/:id`
Single agent detail: KPI defs, health, trend, last-7 sparkline, avg KPI scores, status distribution, worst-KPI callout.

### `GET /api/agents/:id/calls?page=1&limit=20&status=all|pass|warning|fail`
Paginated calls for one agent, with `topIssue` extracted from the analysis.

### `GET /api/agents/:id/insights`
Cross-call AI-generated patterns (cached in `agent_insights`). First call generates via OpenAI; subsequent calls return cache.

### `GET /api/agents/:id/flywheel`
Structured 5-stage data (numeric counts, history arrays) for the per-agent Flywheel. Distinct from `/flywheel/narrative` which returns prose.

### `GET /api/agents/:id/flywheel/narrative?days=30`
Per-agent narratives in the same shape as `/api/flywheel/summary.narratives`. Powers the horizontal flywheel panel on Agent Detail.
```json
{
  "agentId": "...",
  "window": { "days": 30 },
  "narratives": {
    "ingest":    { "what": "...", "why": "...", "evidence": [...], "actionLabel": "...", "actionHref": "..." },
    "score":     { ... },
    "recommend": { ... },
    "apply":     { ... },
    "measure":   { ... }
  }
}
```

### `PUT /api/agents/:id/kpis`
Update KPI weights + thresholds. Validation: weights must sum to 1.0 ±0.01.
```json
// Request body
{ "kpis": [ { "id": "...", "weight": 0.25, "threshold": 70 }, ... ] }

// Response
{ "agentId": "...", "kpiDefinitions": [ ...refreshed... ] }

// Error codes: INVALID_BODY, NO_KPIS, INVALID_WEIGHT, INVALID_THRESHOLD, INVALID_WEIGHT_SUM
```

---

## Calls

### `GET /api/calls?limit=50&status=all|pass|warning|fail`
Recent calls across all agents.

### `GET /api/calls/:id`
Single call w/ transcript turns annotated with `useAction`, `deviation`, `missedOpportunity`, `hallucination` references.

### `GET /api/calls/:id/analysis`
Full analysis payload: overall score, status, summary, root causes, KPI scores, deviations, missed opportunities, recommendations, useActions, hallucinations.

### `POST /api/calls/:id/analyze`
Trigger re-analysis of a single call via OpenAI. Replaces existing analysis row.

---

## Transcripts (ingestion)

### `POST /api/transcripts/ingest`
Webhook entry-point for real-time ingestion. Accepts one call payload. Body validation via `express-validator`. Endpoint wired; HL webhook subscription not yet configured.

### `POST /api/transcripts/simulate/:agentId`
Generates a synthetic call for the given agent and runs full ingest → analyse pipeline. Useful for demo seeding without a real HL call.

### `POST /api/transcripts/sync-all`
Pulls every agent's latest calls from the configured provider, links each to the current prompt version (auto-applying any active recommendations if the prompt changed), then runs OpenAI analysis on any new calls. Returns counts per agent.

---

## Flywheel

### `GET /api/flywheel/summary?days=30`
Agency-wide. Powers the `/flywheel` page hero.
```json
{
  "window": { "days": 30, "sinceISO": "..." },
  "funnel": [
    { "stage": "Issues Detected", "count": 16, "conversionFromPrev": null },
    { "stage": "Root Causes Identified", "count": 37, "conversionFromPrev": 231 },
    { "stage": "Recommendations Generated", "count": 37, "conversionFromPrev": 100 },
    { "stage": "Recommendations Applied", "count": 2, "conversionFromPrev": 5 },
    { "stage": "Outcomes Measured", "count": 0, "conversionFromPrev": 0 },
    { "stage": "Improved Scores", "count": 0, "conversionFromPrev": null }
  ],
  "closureRate": 0,
  "narratives": {
    "ingest": { "what": "...", "why": "...", "evidence": [...], "actionLabel": "...", "actionHref": "..." },
    "score": {...}, "recommend": {...}, "apply": {...}, "measure": {...}
  },
  "impact": {
    "avgScoreDeltaThisPeriod": null,
    "successRatePct": null,
    "measuredOutcomes": 0,
    "manualReviewHoursSaved": 1.3
  }
}
```

---

## Patterns

### `GET /api/patterns?status=active|applied|dismissed|all&minAgents=1&limit=50`
Cross-agent failure clusters. Each row groups recommendations by `cluster_key` and shows aggregate severity + per-agent breakdown.
```json
{
  "filter": { "status": "active", "minAgents": 1, "limit": 50 },
  "total": 35,
  "patterns": [
    {
      "clusterKey": "capture lead data",
      "title": "Capture Lead Data",
      "severity": "critical",
      "affectedAgents": 1,
      "totalOccurrences": 3,
      "statusBreakdown": { "active": 1, "applied": 0, "dismissed": 0 },
      "types": ["prompt"],
      "firstSeenAt": "...",
      "lastSeenAt": "...",
      "agents": [
        { "id": "...", "agentId": "...", "agentName": "FrontDoor AI",
          "severity": "critical", "status": "active",
          "occurrences": 3, "lastSeenAt": "...",
          "suggestedChange": "...", "detail": "..." }
      ]
    }
  ]
}
```

---

## Actions (Use Action queue)

### `GET /api/actions?status=pending|resolved|dismissed|escalated|all&agentId=...&limit=100`
Flattens every Use Action across every analysis, overlaid with current lifecycle status. `counts` reflects the full set (ignores the status filter) so tab badges stay accurate.
```json
{
  "filter": { "status": "pending", "agentId": null, "limit": 100 },
  "total": 5,
  "counts": { "pending": 20, "resolved": 1, "dismissed": 0, "escalated": 0 },
  "actions": [
    {
      "callId": "...", "turnIndex": 1, "actionType": "script_training",
      "reason": "...", "transcriptSegment": "...",
      "status": "pending", "note": null, "updatedAt": null,
      "agentId": "...", "agentName": "FrontDoor AI",
      "callTimestamp": "...", "callerNumber": "...",
      "overallScore": 42
    }
  ]
}
```

### `POST /api/actions/:callId/:turnIndex/:actionType/:verb`
`verb` ∈ `{resolve, dismiss, escalate}`. Body: `{ note?, updatedBy? }`.
```json
{
  "callId": "...", "turnIndex": 1, "actionType": "script_training",
  "status": "resolved", "note": "verified with caller",
  "updatedAt": "2026-06-06T14:09:40.731Z"
}
```

---

## V4 — One-click Apply (write to HL)

5 endpoints powering the V4 apply flow. Apply + rollback write to live HL Voice AI agents via `PATCH /voice-ai/agents/:id`. Snapshot-based rollback uses `apply_attempts.previous_agent_prompt` (no native HL versioning).

### `GET /api/recommendations/:recId/preview-apply`
Initial diff-modal load. Returns current HL prompt, AI-suggested merged prompt, initial validator results.
```json
{
  "recommendation": { "id": "...", "title": "...", "severity": "critical", "suggestedChange": "..." },
  "agent":          { "id": "...", "name": "FrontDoor AI", "currentPromptLength": 4768 },
  "currentText":    "...full agentPrompt...",
  "aiSuggestedText":"...merged proposed prompt...",
  "validation":     { "checks": [...], "blocking": false }
}
```

### `POST /api/recommendations/:recId/validate`
Live re-validation for the editable textarea (frontend debounces 300ms). Body: `{ proposedText }`. Returns `{ checks: [...], blocking: boolean }`.

### `POST /api/agents/:agentId/recommendations/:recId/apply`
The one-click action. Snapshots → PATCHes HL → marks applied → logs audit row.

Body: `{ finalText, userEmail }`. Returns:
```json
{
  "attemptId": "uuid",
  "outcome": "success",
  "timeline": [
    { "step": "snapshot",     "startedAt": "..." },
    { "step": "patch",        "completedAt": "...", "hlResponseStatus": 200, "newPromptLength": 4842 },
    { "step": "mark_applied", "completedAt": "..." },
    { "step": "edit_summary", "completedAt": "..." },
    { "step": "log_audit",    "completedAt": "..." }
  ],
  "agentId": "...",
  "recommendationId": "...",
  "editedFromSuggestion": false,
  "editSummary": null,
  "previousAgentPromptLength": 4768,
  "finalTextLength": 4842,
  "diffSummary": "+74 chars, +2 lines",
  "idempotent": false
}
```

Idempotency: returns the prior receipt unchanged if the same rec was successfully applied within 5 min AND the rec is still in `applied` status. Post-rollback re-applies bypass idempotency.

### `POST /api/recommendations/:recId/rollback`
Re-PATCHes HL with `apply_attempts.previous_agent_prompt` from the latest success. Reverts rec to `active`. Logs a new `rolled_back` audit row. Body: `{ userEmail? }`.

### `GET /api/recommendations/:recId/history`
Audit trail for the rec — all `apply_attempts` rows ordered newest-first.
```json
{
  "recommendationId": "...",
  "attempts": [
    { "id": "...", "attempted_at": "...", "outcome": "rolled_back", "diff_summary": "-74 chars, -2 lines", "edited_from_suggestion": 0, ... },
    { "id": "...", "attempted_at": "...", "outcome": "success",     "diff_summary": "+74 chars, +2 lines", "edited_from_suggestion": 1, "edit_summary": "Added Spanish translation", ... }
  ]
}
```

Required HL scope: `voice-ai-agents.write`. See [`V4_API_DISCOVERY.md`](V4_API_DISCOVERY.md) for the HL endpoint findings + design rationale.

---

## Recommendations

### `GET /api/recommendations`
List recommendations (filterable). For richer cross-agent view, use `/api/patterns`.

### `GET /api/recommendations/summary`
Aggregate counts by status/severity.

### `POST /api/recommendations/:id/dismiss`
Mark one recommendation as `dismissed`.

---

## OAuth (Marketplace App)

### `GET /api/oauth/callback?code=...&locationId=...`
HL redirects here after a sub-account installs the app. Exchanges the auth code for tokens, persists to `oauth_installations`, kicks off initial sync, redirects to `/dashboard/?locationId=...`. **No `X-API-Key` required.**

### `POST /api/webhooks/install`
HL fires this on app install. Currently logs and returns `{ ok: true }`. Hook is in place for future install-side processing.

### `GET /api/oauth/installations`
Lists locations that have installed the app. Useful for support/debugging.

---

## Quick smoke-test recipe

```bash
KEY="${API_KEY:-test-api-key-123}"
URL="${BACKEND_URL:-http://localhost:3000}"

# health
curl -s "$URL/health"

# core endpoints
for ep in \
  /api/dashboard/summary \
  /api/flywheel/summary \
  /api/patterns \
  /api/actions \
  /api/agents; do
  printf "%-30s %s\n" "$ep" "$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $KEY" "$URL$ep")"
done

# trigger ingest + analysis
curl -s -X POST -H "X-API-Key: $KEY" "$URL/api/transcripts/sync-all"
```
