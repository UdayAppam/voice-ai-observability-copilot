const express = require('express')
const db = require('../db/database')
const RecommendationService = require('../services/RecommendationService')

const router = express.Router()

// GET /api/recommendations?agentId=...&status=active|applied|dismissed
router.get('/', (req, res, next) => {
  try {
    const where = []
    const args = []
    if (req.query.agentId) { where.push('r.agent_id = ?'); args.push(req.query.agentId) }
    if (req.query.status)  { where.push('r.status = ?');   args.push(req.query.status) }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const rows = db.prepare(`
      SELECT
        r.id, r.agent_id, ag.name as agentName,
        r.title, r.severity, r.type, r.detail, r.suggested_change,
        r.occurrence_count,
        r.status, r.first_seen_at, r.applied_at,
        r.before_avg_score, r.after_avg_score,
        r.before_sample_size, r.after_sample_size,
        r.outcome_computed_at,
        (r.after_avg_score - r.before_avg_score) as delta
      FROM recommendations r
      JOIN agents ag ON ag.id = r.agent_id
      ${whereSql}
      ORDER BY
        CASE r.status WHEN 'active' THEN 0 WHEN 'applied' THEN 1 ELSE 2 END,
        r.last_seen_at DESC
    `).all(...args)

    res.json({ recommendations: rows })
  } catch (err) {
    next(err)
  }
})

// GET /api/recommendations/summary — lifecycle counts + measured outcomes
router.get('/summary', (req, res, next) => {
  try {
    res.json(RecommendationService.getLifecycleSummary(req.query.agentId || null))
  } catch (err) {
    next(err)
  }
})

// POST /api/recommendations/:id/dismiss — user can manually dismiss
router.post('/:id/dismiss', (req, res, next) => {
  try {
    const result = db.prepare("UPDATE recommendations SET status = 'dismissed' WHERE id = ?").run(req.params.id)
    if (result.changes === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Recommendation not found', status: 404 } })
    }
    res.json({ id: req.params.id, status: 'dismissed' })
  } catch (err) {
    next(err)
  }
})

module.exports = router
