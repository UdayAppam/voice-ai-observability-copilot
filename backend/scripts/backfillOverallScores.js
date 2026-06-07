// One-shot migration: recompute overall_score for every stored analysis from
// kpi_scores × kpi_definitions.weight so existing data matches the corrected
// formula in ARCHITECTURE.md §3.6.
//
// Run: node scripts/backfillOverallScores.js
require('dotenv').config()

const db = require('../src/db/database')
const logger = require('../src/logger')

function recompute(kpiScores, kpiDefs) {
  const totalWeight = kpiDefs.reduce((s, k) => s + k.weight, 0) || 1
  return Math.round(
    kpiDefs.reduce((sum, k) => sum + (kpiScores[k.name] || 0) * k.weight, 0) / totalWeight
  )
}

function bucketStatus(score) {
  if (score >= 70) return 'pass'
  if (score >= 50) return 'warning'
  return 'fail'
}

const rows = db.prepare(`
  SELECT a.id, a.overall_score, a.kpi_scores_json, c.agent_id
  FROM analyses a JOIN calls c ON c.id = a.call_id
`).all()

logger.info({ count: rows.length }, 'backfill: starting')

let changed = 0
for (const r of rows) {
  const defs = db
    .prepare('SELECT name, weight FROM kpi_definitions WHERE agent_id = ?')
    .all(r.agent_id)
  const newScore = recompute(JSON.parse(r.kpi_scores_json), defs)
  if (newScore !== r.overall_score) {
    db.prepare('UPDATE analyses SET overall_score = ?, status = ? WHERE id = ?')
      .run(newScore, bucketStatus(newScore), r.id)
    changed++
  }
}

logger.info({ total: rows.length, changed }, 'backfill: complete')
process.exit(0)
