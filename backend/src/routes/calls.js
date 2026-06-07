const express = require('express')
const db = require('../db/database')
const httpError = require('../utils/httpError')
const AnalysisService = require('../services/AnalysisService')
const logger = require('../logger')

const router = express.Router()
const analysisService = new AnalysisService()

// GET /api/calls?page=1&limit=50&agentId=&status=&sortBy=score|date&sortDir=asc|desc&q=
// Global paginated call browser. Powers the /calls page — designed for 1000s of calls.
router.get('/', (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50))
    const offset = (page - 1) * limit
    const agentId = req.query.agentId || null
    const status = req.query.status || 'all'
    const sortBy = req.query.sortBy === 'score' ? 'a.overall_score' : 'c.call_timestamp'
    const sortDir = req.query.sortDir === 'asc' ? 'ASC' : 'DESC'
    const q = (req.query.q || '').trim()

    const where = []
    const args = []
    if (agentId) { where.push('c.agent_id = ?'); args.push(agentId) }
    if (status !== 'all') { where.push('a.status = ?'); args.push(status) }
    if (q) {
      where.push('(c.id LIKE ? OR c.caller_number LIKE ? OR ag.name LIKE ?)')
      const like = `%${q}%`
      args.push(like, like, like)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const total = db.prepare(`
      SELECT COUNT(*) as n FROM calls c
      LEFT JOIN analyses a ON a.call_id = c.id
      LEFT JOIN agents ag ON ag.id = c.agent_id
      ${whereSql}
    `).get(...args).n

    const rows = db.prepare(`
      SELECT
        c.id, c.agent_id, c.caller_number, c.duration, c.outcome,
        c.analysis_status, c.call_timestamp,
        a.overall_score, a.status, a.summary,
        a.recommendations_json,
        ag.name as agentName
      FROM calls c
      LEFT JOIN analyses a ON a.call_id = c.id
      LEFT JOIN agents ag ON ag.id = c.agent_id
      ${whereSql}
      ORDER BY ${sortBy} ${sortDir} NULLS LAST
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset)

    const calls = rows.map((r) => {
      const recs = r.recommendations_json ? JSON.parse(r.recommendations_json) : []
      const topIssue = recs[0]?.title ?? null
      // eslint-disable-next-line no-unused-vars
      const { recommendations_json: _rj, ...rest } = r
      return { ...rest, topIssue }
    })

    res.json({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      calls,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/calls/:id
// Full call with annotated transcript — useAction, missedOpportunity, deviation merged by turnIndex
router.get('/:id', (req, res, next) => {
  try {
    const call = db.prepare(`
      SELECT c.*, a.name as agentName
      FROM calls c
      JOIN agents a ON a.id = c.agent_id
      WHERE c.id = ?
    `).get(req.params.id)

    if (!call) return next(httpError('CALL_NOT_FOUND', `Call ${req.params.id} not found`, 404))

    const analysis = db.prepare('SELECT * FROM analyses WHERE call_id = ?').get(req.params.id)

    const transcript = JSON.parse(call.transcript_json)
    let annotatedTranscript = transcript

    if (analysis) {
      const useActions     = JSON.parse(analysis.use_actions_json)
      const missedOpps     = JSON.parse(analysis.missed_opportunities_json)
      const deviations     = JSON.parse(analysis.deviations_json)
      const hallucinations = JSON.parse(analysis.hallucinations_json || '[]')

      annotatedTranscript = transcript.map((turn) => ({
        ...turn,
        useAction:         useActions.find((u) => u.turnIndex === turn.turnIndex) ?? null,
        missedOpportunity: missedOpps.find((m) => m.turnIndex === turn.turnIndex) ?? null,
        deviation:         deviations.find((d) => d.turnIndex === turn.turnIndex) ?? null,
        hallucination:     hallucinations.find((h) => h.turnIndex === turn.turnIndex) ?? null,
      }))
    }

    // eslint-disable-next-line no-unused-vars
    const { transcript_json: _tj, ...callMeta } = call

    res.json({
      ...callMeta,
      transcript: annotatedTranscript,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/calls/:id/analysis
router.get('/:id/analysis', (req, res, next) => {
  try {
    const call = db.prepare('SELECT id, agent_id, analysis_status FROM calls WHERE id = ?').get(req.params.id)
    if (!call) return next(httpError('CALL_NOT_FOUND', `Call ${req.params.id} not found`, 404))

    const analysis = db.prepare('SELECT * FROM analyses WHERE call_id = ?').get(req.params.id)

    if (!analysis) {
      return res.status(404).json({
        error: { code: 'ANALYSIS_NOT_FOUND', message: 'Analysis not yet available for this call', status: 404 },
      })
    }

    res.json({
      callId: req.params.id,
      analyzedAt: analysis.analyzed_at,
      overallScore: analysis.overall_score,
      status: analysis.status,
      summary: analysis.summary,
      rootCauses: JSON.parse(analysis.root_causes_json),
      kpiScores: JSON.parse(analysis.kpi_scores_json),
      deviations: JSON.parse(analysis.deviations_json),
      missedOpportunities: JSON.parse(analysis.missed_opportunities_json),
      recommendations: JSON.parse(analysis.recommendations_json),
      useActions: JSON.parse(analysis.use_actions_json),
      hallucinations: JSON.parse(analysis.hallucinations_json || '[]'),
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/calls/:id/analyze
// Re-trigger analysis synchronously — returns completed result
router.post('/:id/analyze', async (req, res, next) => {
  try {
    const callRow = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id)
    if (!callRow) return next(httpError('CALL_NOT_FOUND', `Call ${req.params.id} not found`, 404))

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(callRow.agent_id)
    if (!agent) return next(httpError('AGENT_NOT_FOUND', `Agent ${callRow.agent_id} not found`, 404))

    // Delete existing analysis so it can be re-run
    db.prepare('DELETE FROM analyses WHERE call_id = ?').run(req.params.id)
    db.prepare("UPDATE calls SET analysis_status = 'pending' WHERE id = ?").run(req.params.id)

    const call = {
      id: callRow.id,
      agentId: callRow.agent_id,
      duration: callRow.duration,
      outcome: callRow.outcome,
      transcript: JSON.parse(callRow.transcript_json),
    }

    logger.info({ callId: call.id }, 'routes: re-triggering analysis')
    const result = await analysisService.analyze(call, agent)

    if (!result) {
      return next(httpError('ANALYSIS_FAILED', 'OpenAI analysis failed — check logs', 500))
    }

    const analysis = db.prepare('SELECT * FROM analyses WHERE call_id = ?').get(req.params.id)

    res.json({
      callId: req.params.id,
      status: analysis.status,
      overallScore: analysis.overall_score,
      summary: analysis.summary,
      rootCauses: JSON.parse(analysis.root_causes_json),
      kpiScores: JSON.parse(analysis.kpi_scores_json),
      deviations: JSON.parse(analysis.deviations_json),
      missedOpportunities: JSON.parse(analysis.missed_opportunities_json),
      recommendations: JSON.parse(analysis.recommendations_json),
      useActions: JSON.parse(analysis.use_actions_json),
      hallucinations: JSON.parse(analysis.hallucinations_json || '[]'),
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
