const express = require('express')
const db = require('../db/database')

const router = express.Router()

const VALID_VERBS = { resolve: 'resolved', dismiss: 'dismissed', escalate: 'escalated' }
const VALID_FILTERS = ['pending', 'resolved', 'dismissed', 'escalated', 'all']

// GET /api/actions?status=pending&agentId=…&limit=100
// Flattens every Use Action out of every analysis and overlays its lifecycle
// status. Powers the /actions page — the agency's queue of "things to do".
router.get('/', (req, res, next) => {
  try {
    const status   = VALID_FILTERS.includes(req.query.status) ? req.query.status : 'pending'
    const agentId  = req.query.agentId || null
    const limit    = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100))

    const where = ['1=1']
    const args = []
    if (agentId) { where.push('c.agent_id = ?'); args.push(agentId) }

    const rows = db.prepare(`
      SELECT a.call_id    as callId,
             a.use_actions_json,
             c.agent_id   as agentId,
             ag.name      as agentName,
             c.call_timestamp as callTimestamp,
             c.caller_number  as callerNumber,
             a.overall_score  as overallScore
      FROM analyses a
      JOIN calls c ON c.id = a.call_id
      JOIN agents ag ON ag.id = c.agent_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.call_timestamp DESC
    `).all(...args)

    const statusStmt = db.prepare(
      'SELECT status, note, updated_at FROM use_action_statuses WHERE call_id = ? AND turn_index = ? AND action_type = ?'
    )

    const actions = []
    for (const row of rows) {
      let useActions
      try { useActions = JSON.parse(row.use_actions_json) } catch { continue }

      for (const ua of useActions) {
        const overlay = statusStmt.get(row.callId, ua.turnIndex, ua.actionType)
        const currentStatus = overlay?.status || 'pending'
        if (status !== 'all' && currentStatus !== status) continue

        actions.push({
          callId:       row.callId,
          turnIndex:    ua.turnIndex,
          actionType:   ua.actionType,
          reason:       ua.reason,
          transcriptSegment: ua.transcript_segment,
          status:       currentStatus,
          note:         overlay?.note || null,
          updatedAt:    overlay?.updated_at || null,
          agentId:      row.agentId,
          agentName:    row.agentName,
          callTimestamp: row.callTimestamp,
          callerNumber: row.callerNumber,
          overallScore: row.overallScore,
        })
        if (actions.length >= limit) break
      }
      if (actions.length >= limit) break
    }

    // Counters across the FULL set (ignore the status filter so the UI tab
    // badges stay accurate even when filtering).
    const counts = { pending: 0, resolved: 0, dismissed: 0, escalated: 0 }
    for (const row of rows) {
      let useActions
      try { useActions = JSON.parse(row.use_actions_json) } catch { continue }
      for (const ua of useActions) {
        const overlay = statusStmt.get(row.callId, ua.turnIndex, ua.actionType)
        counts[overlay?.status || 'pending']++
      }
    }

    res.json({
      filter: { status, agentId, limit },
      total: actions.length,
      counts,
      actions,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/actions/:callId/:turnIndex/:actionType/:verb
// verb ∈ {resolve, dismiss, escalate}. Body: { note?, updatedBy? }
router.post('/:callId/:turnIndex/:actionType/:verb', (req, res, next) => {
  try {
    const { callId, turnIndex, actionType, verb } = req.params
    const newStatus = VALID_VERBS[verb]
    if (!newStatus) {
      return res.status(400).json({ error: `invalid verb '${verb}'. Use one of: ${Object.keys(VALID_VERBS).join(', ')}` })
    }

    const turnIdx = parseInt(turnIndex)
    if (Number.isNaN(turnIdx)) return res.status(400).json({ error: 'turnIndex must be an integer' })

    // Validate the action actually exists in some analysis (avoid orphan statuses)
    const callRow = db.prepare('SELECT id FROM calls WHERE id = ?').get(callId)
    if (!callRow) return res.status(404).json({ error: `call ${callId} not found` })

    const note = req.body?.note || null
    const updatedBy = req.body?.updatedBy || null

    db.prepare(`
      INSERT INTO use_action_statuses (call_id, turn_index, action_type, status, note, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(call_id, turn_index, action_type)
        DO UPDATE SET status = excluded.status,
                      note = excluded.note,
                      updated_by = excluded.updated_by,
                      updated_at = datetime('now')
    `).run(callId, turnIdx, actionType, newStatus, note, updatedBy)

    res.json({
      callId,
      turnIndex: turnIdx,
      actionType,
      status: newStatus,
      note,
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
