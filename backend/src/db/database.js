// Uses Node.js built-in sqlite (available from Node 22.5+, stable in Node 24)
// No native compilation required — zero external dependency for the DB layer
const { DatabaseSync } = require('node:sqlite')
const path = require('path')
const fs = require('fs')
const logger = require('../logger')

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../../data/copilot.db')

const dataDir = path.dirname(DB_PATH)
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

const db = new DatabaseSync(DB_PATH)

db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
db.exec(schema)

// Forward-only migrations — additive only, idempotent.
// SQLite's CREATE TABLE IF NOT EXISTS doesn't add new columns to existing
// tables, so column adds need this manual gate.
function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  return cols.some((c) => c.name === column)
}

if (!columnExists('calls', 'prompt_version_id')) {
  db.exec('ALTER TABLE calls ADD COLUMN prompt_version_id TEXT REFERENCES agent_prompt_versions(id)')
  logger.info('migration: calls.prompt_version_id added')
}

if (!columnExists('analyses', 'hallucinations_json')) {
  db.exec("ALTER TABLE analyses ADD COLUMN hallucinations_json TEXT NOT NULL DEFAULT '[]'")
  logger.info('migration: analyses.hallucinations_json added')
}

// V4 — apply lifecycle columns on recommendations
if (!columnExists('recommendations', 'applied_via')) {
  db.exec("ALTER TABLE recommendations ADD COLUMN applied_via TEXT")
  logger.info('migration: recommendations.applied_via added')
}
if (!columnExists('recommendations', 'apply_error')) {
  db.exec("ALTER TABLE recommendations ADD COLUMN apply_error TEXT")
  logger.info('migration: recommendations.apply_error added')
}

// V4.1 — recommendation_calls join is in schema.sql (CREATE TABLE IF NOT EXISTS).
// Backfill from existing analyses on first start after the table exists.
const recCallsRows = db.prepare('SELECT COUNT(*) n FROM recommendation_calls').get().n
const recsRows     = db.prepare('SELECT COUNT(*) n FROM recommendations').get().n
if (recCallsRows === 0 && recsRows > 0) {
  logger.info({ recsRows }, 'V4.1 backfill: populating recommendation_calls from existing analyses')
  const crypto = require('crypto')
  // Reproduce the clusterKey rule from RecommendationService.clusterKey (lowercase, normalised)
  const clusterKey = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120)
  const analyses = db.prepare(`
    SELECT a.call_id, a.recommendations_json, c.agent_id
    FROM analyses a JOIN calls c ON c.id = a.call_id
    WHERE a.recommendations_json IS NOT NULL AND a.recommendations_json != '[]'
  `).all()
  const recsByKey = new Map()  // agentId+clusterKey → recId
  db.prepare('SELECT id, agent_id, cluster_key FROM recommendations').all().forEach((r) => {
    recsByKey.set(`${r.agent_id}::${r.cluster_key}`, r.id)
  })
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO recommendation_calls (recommendation_id, call_id, first_seen_at)
    VALUES (?, ?, datetime('now'))
  `)
  let linked = 0
  for (const an of analyses) {
    let recs
    try { recs = JSON.parse(an.recommendations_json) } catch { continue }
    for (const r of recs) {
      const key = `${an.agent_id}::${clusterKey(r.title || '')}`
      const recId = recsByKey.get(key)
      if (recId) {
        const res = insertLink.run(recId, an.call_id)
        if (res.changes > 0) linked++
      }
    }
  }
  logger.info({ linked }, 'V4.1 backfill: done')
  // Reference crypto so it doesn't get linted out
  void crypto
}

logger.info({ path: DB_PATH }, 'database connected')

module.exports = db
