# Data Model

SQLite schema, lifecycle states, and the relationships that make the Validation Flywheel work. Reflects schema as shipped.

Source of truth: [`backend/src/db/schema.sql`](../backend/src/db/schema.sql).

---

## Tables (9)

```
agents ──────────────┬─< kpi_definitions
                     ├─< calls ─────┬─< analyses ─< (json columns)
                     │              └─ prompt_version_id ─> agent_prompt_versions
                     ├─< agent_prompt_versions
                     ├─< recommendations ─┬─ first_seen_prompt_version_id ─> agent_prompt_versions
                     │                    └─ applied_prompt_version_id   ─> agent_prompt_versions
                     └─< agent_insights

calls ─< use_action_statuses (overlay status for use_actions_json)

oauth_installations (standalone — keyed by HL location_id)
```

---

## Per-table reference

### `agents`
The Voice AI agents being observed. One row per HL Voice AI agent (or mock agent).
```sql
id          TEXT PRIMARY KEY   -- HL agent id, or mock UUID
name        TEXT NOT NULL
goal        TEXT NOT NULL      -- the agent's stated goal (used in OpenAI prompts)
script      TEXT               -- the prompt/script (basis of SHA-256 versioning)
created_at  TEXT
updated_at  TEXT
```

### `kpi_definitions`
Per-agent KPI definitions. 6 defaults seeded; weights must sum to 1.0; editable via `PUT /api/agents/:id/kpis`.
```sql
id          TEXT PRIMARY KEY
agent_id    TEXT NOT NULL → agents.id (CASCADE)
name        TEXT NOT NULL  -- e.g. 'call_completion'
label       TEXT NOT NULL  -- 'Call Completion'
weight      REAL NOT NULL  -- [0, 1], sum across agent must = 1.0
threshold   INTEGER NOT NULL -- [0, 100], the pass threshold
description TEXT NOT NULL  -- shown in OpenAI prompt for scoring guidance
```

Default KPI set per agent: `call_completion`, `script_adherence`, `objection_handling`, `sentiment_score`, `response_quality`, `escalation_rate`.

### `calls`
Ingested call metadata + transcript. Linked to the prompt version live when the call happened.
```sql
id                  TEXT PRIMARY KEY        -- HL call id or mock UUID
agent_id            TEXT NOT NULL → agents.id (CASCADE)
caller_number       TEXT
duration            INTEGER                 -- seconds
outcome             TEXT                    -- HL-reported (e.g. 'completed')
transcript_json     TEXT NOT NULL           -- [{turnIndex, speaker, text}, ...]
analysis_status     TEXT NOT NULL           -- 'pending'|'completed'|'failed'
prompt_version_id   TEXT → agent_prompt_versions.id (added by migration)
ingested_at         TEXT
call_timestamp      TEXT NOT NULL           -- when the call happened (used for before/after math)
```

### `agent_prompt_versions`
Every distinct version of an agent's prompt/script. The foundation of causal measurement.
```sql
id            TEXT PRIMARY KEY
agent_id      TEXT NOT NULL → agents.id (CASCADE)
prompt_hash   TEXT NOT NULL                -- SHA-256(prompt+goal) truncated to 16
prompt_text   TEXT NOT NULL
goal_text     TEXT
first_seen_at TEXT
last_seen_at  TEXT
call_count    INTEGER NOT NULL DEFAULT 0
UNIQUE(agent_id, prompt_hash)
```

A new row is inserted by `PromptVersionService.recordIfChanged()` only when the hash changes. `RecommendationService.markActiveAsApplied()` fires automatically on insert.

### `recommendations`
First-class entity with a lifecycle. Persists across analyses via `cluster_key` dedup.
```sql
id                            TEXT PRIMARY KEY
agent_id                      TEXT NOT NULL → agents.id (CASCADE)
cluster_key                   TEXT NOT NULL     -- lowercased+normalised title
title                         TEXT NOT NULL
severity                      TEXT NOT NULL     -- 'critical'|'warning'|'suggestion'
type                          TEXT NOT NULL     -- 'prompt'|'script'|'training'
detail                        TEXT
suggested_change              TEXT              -- copy-paste-ready prompt text
first_seen_at                 TEXT
last_seen_at                  TEXT
occurrence_count              INTEGER NOT NULL DEFAULT 1
first_seen_prompt_version_id  TEXT → agent_prompt_versions.id
status                        TEXT NOT NULL DEFAULT 'active'
                              -- 'active' | 'applied' | 'dismissed'
applied_at                    TEXT
applied_prompt_version_id     TEXT → agent_prompt_versions.id

-- Causal measurement (filled by computePendingOutcomes when ≥1 call exists on each side)
before_avg_score              REAL
after_avg_score               REAL
before_sample_size            INTEGER
after_sample_size             INTEGER
outcome_computed_at           TEXT

UNIQUE(agent_id, cluster_key)
```

### `analyses`
The OpenAI output per call. JSON columns hold the structured arrays from `response_format: json_schema strict`.
```sql
id                        TEXT PRIMARY KEY
call_id                   TEXT NOT NULL → calls.id (CASCADE)
overall_score             INTEGER          -- recomputed Σ(kpi × weight), NOT raw LLM
status                    TEXT NOT NULL    -- 'pass'|'warning'|'fail'
summary                   TEXT
root_causes_json          TEXT             -- string[]
kpi_scores_json           TEXT NOT NULL    -- {call_completion: 80, ...}
deviations_json           TEXT NOT NULL    -- [{turnIndex, type, description}]
missed_opportunities_json TEXT NOT NULL    -- [{turnIndex, opportunity, description}]
recommendations_json      TEXT NOT NULL    -- [{title, severity, type, detail, suggestedChange}]
use_actions_json          TEXT NOT NULL    -- [{turnIndex, reason, actionType, transcript_segment}]
hallucinations_json       TEXT NOT NULL DEFAULT '[]'
                          -- [{turnIndex, type, claim, confidence, impact}]  (added by migration)
analyzed_at               TEXT
```

### `agent_insights`
Cached cross-call patterns generated on demand (Agent Detail → AI Insights). Cached so repeat opens don't re-spend OpenAI.
```sql
id                      TEXT PRIMARY KEY
agent_id                TEXT NOT NULL → agents.id (CASCADE)
summary                 TEXT NOT NULL
patterns_json           TEXT NOT NULL
use_action_summary_json TEXT NOT NULL
generated_at            TEXT
call_count              INTEGER NOT NULL
```

### `oauth_installations`
One row per HL sub-account that installed the Marketplace App. Populated by `/api/oauth/callback`.
```sql
location_id   TEXT PRIMARY KEY
company_id    TEXT NOT NULL
user_type     TEXT NOT NULL                 -- 'Location'|'Company'
access_token  TEXT NOT NULL
refresh_token TEXT NOT NULL
scope         TEXT
expires_at    TEXT NOT NULL                 -- ISO 8601 — refresh before this
installed_at  TEXT
updated_at    TEXT
```

### `use_action_statuses`
Status overlay for Use Actions. Absence of a row = `pending` (the default state for any action surfaced inside `analyses.use_actions_json`).
```sql
call_id     TEXT NOT NULL → calls.id (CASCADE)
turn_index  INTEGER NOT NULL
action_type TEXT NOT NULL                  -- mirrors useActions[].actionType
status      TEXT NOT NULL                  -- 'resolved'|'dismissed'|'escalated'
note        TEXT
updated_by  TEXT                           -- email/userId
updated_at  TEXT
PRIMARY KEY (call_id, turn_index, action_type)
```

---

## Indexes

```sql
idx_apv_agent       on agent_prompt_versions(agent_id, first_seen_at DESC)
idx_rec_status      on recommendations(status, agent_id)
idx_rec_applied     on recommendations(applied_at) WHERE applied_at IS NOT NULL
idx_uas_status      on use_action_statuses(status, updated_at DESC)
idx_calls_agent_id  on calls(agent_id)
idx_calls_status    on calls(analysis_status)
idx_analyses_call   on analyses(call_id)
idx_insights_agent  on agent_insights(agent_id, generated_at DESC)
```

---

## Migrations

`database.js` runs `schema.sql` (idempotent via `IF NOT EXISTS`) then applies forward-only column additions guarded by `columnExists()`:

- `calls.prompt_version_id` — links each call to the prompt version active when ingested
- `analyses.hallucinations_json` — added with default `'[]'` so old analyses don't break

Adding a new column? Append a `columnExists()` block to `database.js` — never edit existing migrations.

---

## Lifecycle: a recommendation's journey

```
NEW                             persistFromAnalysis() finds no existing row
  └── INSERT recommendations
        status='active'
        first_seen_prompt_version_id = current
        occurrence_count = 1
        ▼

RECURRING                       persistFromAnalysis() finds same cluster_key
  └── UPDATE recommendations
        occurrence_count++
        last_seen_at = now()
        ▼

APPLIED                         PromptVersionService detects new prompt hash
  └── markActiveAsApplied()
        status='applied'
        applied_at = now()
        applied_prompt_version_id = new
        ▼

REGRESSED                       persistFromAnalysis() finds same cluster_key AFTER apply
  └── status='active'           ← fix didn't stick, re-open
        applied_at = NULL
        outcome fields reset
        occurrence_count++
        ▼

MEASURED                        computePendingOutcomes() finds ≥1 call on each side
  └── UPDATE recommendations
        before_avg_score = AVG(score) under PRIOR prompt
        after_avg_score  = AVG(score) under APPLIED prompt
        before_sample_size, after_sample_size
        outcome_computed_at = now()
        ▼

DISMISSED                       human clicks Dismiss on /patterns
  └── POST /api/recommendations/:id/dismiss
        status='dismissed'
```

The same lifecycle drives the `/flywheel` Measure stage narrative, the impact summary, and the Patterns page lifecycle bars.

---

## Lifecycle: a Use Action's journey

Use Actions are not first-class rows; they live inside `analyses.use_actions_json`. Their triage state lives in `use_action_statuses`:

```
DETECTED                        AnalysisService writes use_actions_json
  └── NO ROW in use_action_statuses → status='pending' (default)
        ▼

TRIAGED                         human clicks Resolve/Dismiss/Escalate on /actions
  └── INSERT use_action_statuses (UPSERT)
        status = 'resolved' | 'dismissed' | 'escalated'
        note, updated_by, updated_at
```

The `/api/actions` endpoint flattens `use_actions_json` across all analyses, joins each one to its overlay status (if any), and returns the unified queue.

---

## Lifecycle: a prompt version's journey

```
DETECTED                        IngestionService calls
                                  PromptVersionService.recordIfChanged(agent)
  ├── existing row matches hash  → UPDATE last_seen_at, isNew=false
  └── no match (new hash)        → INSERT row, isNew=true
                                   ├── if prevVersionId existed:
                                   │     RecommendationService.markActiveAsApplied(
                                   │       agentId, newVersionId
                                   │     )
                                   └── future calls link to this version
                                        via calls.prompt_version_id
```

The hash is `SHA-256(prompt+goal)`, whitespace-normalised then truncated to 16 hex chars. Trivial whitespace edits don't churn versions; semantic edits always do.
