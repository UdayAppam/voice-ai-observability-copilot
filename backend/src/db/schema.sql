-- Voice AI Observability Copilot — Database Schema
-- Applied on every server start (IF NOT EXISTS guards are safe to re-run)

CREATE TABLE IF NOT EXISTS agents (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  goal       TEXT NOT NULL,
  script     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kpi_definitions (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  label       TEXT NOT NULL,
  weight      REAL NOT NULL,
  threshold   INTEGER NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  caller_number       TEXT,
  duration            INTEGER,
  outcome             TEXT,
  transcript_json     TEXT NOT NULL,
  analysis_status     TEXT NOT NULL DEFAULT 'pending',
  prompt_version_id   TEXT REFERENCES agent_prompt_versions(id),
  ingested_at         TEXT NOT NULL DEFAULT (datetime('now')),
  call_timestamp      TEXT NOT NULL
);

-- Every distinct version of every agent's prompt/script.
-- Foundation for causal loop-closing: each call links to the prompt version
-- that was live when the call happened.
CREATE TABLE IF NOT EXISTS agent_prompt_versions (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  prompt_hash   TEXT NOT NULL,     -- sha256 of prompt + goal (deterministic id)
  prompt_text   TEXT NOT NULL,
  goal_text     TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  call_count    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(agent_id, prompt_hash)
);
CREATE INDEX IF NOT EXISTS idx_apv_agent ON agent_prompt_versions(agent_id, first_seen_at DESC);

-- Recommendations as first-class entities (not just JSON inside analyses).
-- Each row tracks one unique recommendation per agent across its lifecycle:
-- active → applied → outcome measured.
CREATE TABLE IF NOT EXISTS recommendations (
  id                        TEXT PRIMARY KEY,
  agent_id                  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  cluster_key               TEXT NOT NULL,    -- normalised title for dedup
  title                     TEXT NOT NULL,
  severity                  TEXT NOT NULL,
  type                      TEXT NOT NULL,
  detail                    TEXT,
  suggested_change          TEXT,
  first_seen_at             TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at              TEXT NOT NULL DEFAULT (datetime('now')),
  occurrence_count          INTEGER NOT NULL DEFAULT 1,
  first_seen_prompt_version_id TEXT REFERENCES agent_prompt_versions(id),
  status                    TEXT NOT NULL DEFAULT 'active',  -- 'active'|'applied'|'dismissed'
  applied_at                TEXT,
  applied_prompt_version_id TEXT REFERENCES agent_prompt_versions(id),
  -- outcome measurement (filled in once we have post-apply calls)
  before_avg_score          REAL,
  after_avg_score           REAL,
  before_sample_size        INTEGER,
  after_sample_size         INTEGER,
  outcome_computed_at       TEXT,
  UNIQUE(agent_id, cluster_key)
);
CREATE INDEX IF NOT EXISTS idx_rec_status ON recommendations(status, agent_id);
CREATE INDEX IF NOT EXISTS idx_rec_applied ON recommendations(applied_at) WHERE applied_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS analyses (
  id                        TEXT PRIMARY KEY,
  call_id                   TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  overall_score             INTEGER,
  status                    TEXT NOT NULL,
  summary                   TEXT,
  root_causes_json          TEXT,
  kpi_scores_json           TEXT NOT NULL,
  deviations_json           TEXT NOT NULL,
  missed_opportunities_json TEXT NOT NULL,
  recommendations_json      TEXT NOT NULL,
  use_actions_json          TEXT NOT NULL,
  hallucinations_json       TEXT NOT NULL DEFAULT '[]',
  analyzed_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_insights (
  id                      TEXT PRIMARY KEY,
  agent_id                TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  summary                 TEXT NOT NULL,
  patterns_json           TEXT NOT NULL,
  use_action_summary_json TEXT NOT NULL,
  generated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  call_count              INTEGER NOT NULL
);

-- OAuth installations — one row per HL sub-account that installed the app.
-- Populated by the /api/oauth/callback handler after a Marketplace install.
CREATE TABLE IF NOT EXISTS oauth_installations (
  location_id   TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  user_type     TEXT NOT NULL,         -- "Location" | "Company"
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scope         TEXT,
  expires_at    TEXT NOT NULL,         -- ISO 8601 — refresh BEFORE this
  installed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- V4.1 — many-to-many join between recommendations and the calls that surfaced them.
-- Replaces the misleading `recommendations.occurrence_count` (which counted analysis
-- re-runs, not unique calls). Lets the Patterns UI say "Detected in N calls · M failed"
-- instead of the engineering-ish "N× across M agents".
CREATE TABLE IF NOT EXISTS recommendation_calls (
  recommendation_id  TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  call_id            TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  first_seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (recommendation_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_rec_calls_call ON recommendation_calls(call_id);

-- V4 — one-click apply audit log. Every Apply (success OR failure) lands a row.
-- previous_agent_prompt is the rollback snapshot (HL has no native versioning).
CREATE TABLE IF NOT EXISTS apply_attempts (
  id                          TEXT PRIMARY KEY,
  recommendation_id           TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  agent_id                    TEXT NOT NULL,
  attempted_at                TEXT NOT NULL DEFAULT (datetime('now')),
  outcome                     TEXT NOT NULL,    -- 'success' | 'failure' | 'rolled_back'
  -- Rollback snapshot — exact prior agentPrompt, taken BEFORE the PATCH succeeds
  previous_agent_prompt       TEXT,
  -- What was sent
  ai_suggested_text           TEXT,
  final_text                  TEXT,             -- = ai_suggested_text when not edited
  -- Edit tracking (powers product intelligence + receipt diff section)
  edited_from_suggestion      INTEGER NOT NULL DEFAULT 0,
  chars_diff_from_suggestion  INTEGER,
  edit_summary                TEXT,
  -- Audit
  diff_summary                TEXT,
  error_message               TEXT,
  user_email                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_apply_rec      ON apply_attempts(recommendation_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_apply_outcome  ON apply_attempts(outcome, attempted_at DESC);

-- Status overlay for "Use Actions" surfaced inside analyses.use_actions_json.
-- Actions live in the JSON column; this table only tracks the lifecycle the
-- agency takes on each one (resolved / dismissed / escalated).
-- Absence of a row = 'pending' (default state).
CREATE TABLE IF NOT EXISTS use_action_statuses (
  call_id     TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  turn_index  INTEGER NOT NULL,
  action_type TEXT NOT NULL,                -- mirrors useActions[].actionType
  status      TEXT NOT NULL,                -- 'resolved'|'dismissed'|'escalated'
  note        TEXT,
  updated_by  TEXT,                         -- email/user id (optional)
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (call_id, turn_index, action_type)
);
CREATE INDEX IF NOT EXISTS idx_uas_status ON use_action_statuses(status, updated_at DESC);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_calls_agent_id ON calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_calls_status   ON calls(analysis_status);
CREATE INDEX IF NOT EXISTS idx_analyses_call  ON analyses(call_id);
CREATE INDEX IF NOT EXISTS idx_insights_agent ON agent_insights(agent_id, generated_at DESC);
