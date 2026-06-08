// One-shot migration: turn historical analyses[].recommendations_json blobs
// into first-class rows in the recommendations table. Also seeds the initial
// agent_prompt_versions row for every agent so future prompt changes are
// detectable.
//
// Idempotent: re-running won't duplicate (clusters by normalised title).
//
// Run: node scripts/backfillRecommendations.js
require('dotenv').config()

const db = require('../src/db/database')
const logger = require('../src/logger')
const PromptVersionService = require('../src/services/PromptVersionService')
const RecommendationService = require('../src/services/RecommendationService')

logger.info('backfill-recommendations: starting')

// 1. Seed initial prompt-version row for every agent that doesn't have one
const agents = db.prepare('SELECT id, name, goal, script FROM agents').all()
let promptVersionsCreated = 0
for (const a of agents) {
  const before = db.prepare('SELECT COUNT(*) as n FROM agent_prompt_versions WHERE agent_id = ?').get(a.id)
  const { isNew, versionId } = PromptVersionService.recordIfChanged(a)
  if (isNew) {
    promptVersionsCreated++
    // Backfill: associate ALL existing calls of this agent with this version
    db.prepare('UPDATE calls SET prompt_version_id = ? WHERE agent_id = ? AND prompt_version_id IS NULL')
      .run(versionId, a.id)
    db.prepare('UPDATE agent_prompt_versions SET call_count = (SELECT COUNT(*) FROM calls WHERE prompt_version_id = ?) WHERE id = ?')
      .run(versionId, versionId)
  }
}

// 2. Promote analyses[].recommendations_json into recommendations table
const analyses = db.prepare(`
  SELECT a.recommendations_json, c.agent_id, a.analyzed_at
  FROM analyses a JOIN calls c ON c.id = a.call_id
  ORDER BY a.analyzed_at ASC
`).all()

let totalCreated = 0
let totalUpdated = 0
;(async () => {
  for (const row of analyses) {
    const recs = JSON.parse(row.recommendations_json || '[]')
    if (recs.length === 0) continue
    const currentVersion = PromptVersionService.getCurrentVersionId(row.agent_id)
    // persistFromAnalysis is now async (semantic dedup pass added).
    // Pass null for callId — backfill doesn't have a single call to link to.
    const { created, updated } = await RecommendationService.persistFromAnalysis(row.agent_id, null, recs, currentVersion)
    totalCreated += created
    totalUpdated += updated
  }
})()

logger.info(
  { agentsScanned: agents.length, promptVersionsCreated, totalCreated, totalUpdated, analysesScanned: analyses.length },
  'backfill-recommendations: complete'
)
process.exit(0)
