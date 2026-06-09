const express = require('express')
const crypto = require('crypto')
const db = require('../db/database')
const logger = require('../logger')

const router = express.Router()

const VALID_VERBS = { resolve: 'resolved', dismiss: 'dismissed', escalate: 'escalated' }
const VALID_FILTERS = ['pending', 'resolved', 'dismissed', 'escalated', 'all']

// V5 — when the SAME (agent, action_type) gets escalated this many times within
// the lookback window, auto-spawn a Patterns-visible recommendation so the
// operational pain becomes a flywheel-improvement signal.
const ESCALATION_REC_THRESHOLD = 3
const ESCALATION_LOOKBACK_DAYS = 30

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

    // V5 — escalation → recommendation auto-spawn. Closes the loop between
    // "human keeps escalating this action type" → "agent prompt fix proposal".
    let spawnedRec = null
    if (verb === 'escalate') {
      spawnedRec = _maybeSpawnEscalationRec(callId, actionType)
    }

    res.json({
      callId,
      turnIndex: turnIdx,
      actionType,
      status: newStatus,
      note,
      updatedAt: new Date().toISOString(),
      spawnedRec,  // null when not enough escalations yet
    })
  } catch (err) {
    next(err)
  }
})

// ── V5: escalation → recommendation ──────────────────────────────────
//
// Called after each escalate verb. Counts escalations of the SAME
// (agent_id, action_type) in the lookback window. If ≥ threshold AND no
// existing rec for this pattern, creates a new active recommendation so
// the operational pain becomes a Patterns-visible improvement signal.
//
// Returns the spawned rec (or null if not triggered) so the UI can show
// a "we created a recommendation from this" confirmation.
function _maybeSpawnEscalationRec(callId, actionType) {
  // Find this call's agent_id
  const call = db.prepare('SELECT agent_id FROM calls WHERE id = ?').get(callId)
  if (!call?.agent_id) return null
  const agentId = call.agent_id

  // Count escalations of this (agent_id, action_type) in the lookback window
  const sinceISO = new Date(Date.now() - ESCALATION_LOOKBACK_DAYS * 86400e3).toISOString()
  const count = db.prepare(`
    SELECT COUNT(*) as n
    FROM use_action_statuses uas
    JOIN calls c ON c.id = uas.call_id
    WHERE c.agent_id = ?
      AND uas.action_type = ?
      AND uas.status = 'escalated'
      AND uas.updated_at >= ?
  `).get(agentId, actionType, sinceISO).n

  if (count < ESCALATION_REC_THRESHOLD) {
    logger.info({ agentId, actionType, count, threshold: ESCALATION_REC_THRESHOLD },
      'escalation tracked — below auto-spawn threshold')
    return null
  }

  // Check if we already have an active/applied rec for this escalation pattern
  // (cluster_key matches if we've spawned before for this same pattern)
  const clusterKey = `escalation pattern ${actionType}`.toLowerCase().slice(0, 120)
  const existing = db.prepare(
    `SELECT id, status FROM recommendations WHERE agent_id = ? AND cluster_key = ?`
  ).get(agentId, clusterKey)
  if (existing) {
    // Bump occurrence_count + reset to active if it was previously dismissed/applied
    db.prepare(`
      UPDATE recommendations
        SET occurrence_count = occurrence_count + 1,
            last_seen_at = datetime('now'),
            status = CASE WHEN status='dismissed' THEN 'active' ELSE status END
        WHERE id = ?
    `).run(existing.id)
    logger.info({ agentId, actionType, recId: existing.id }, 'escalation rec — bumped existing')
    return { id: existing.id, status: 'updated', count }
  }

  // Spawn a new recommendation
  const recId = crypto.randomUUID()
  const title = `Reduce recurring "${actionType}" escalations`
  const detail = `Humans have escalated "${actionType}" actions ${count} times for this agent in the last ${ESCALATION_LOOKBACK_DAYS} days. The AI keeps flagging these moments but the human keeps having to step in — suggests the agent prompt could be improved to handle this case directly.`
  const suggestedChange = `Review the most recent escalated calls for "${actionType}" patterns and add explicit handling instructions to the agent's script (e.g., escalation criteria, alternative phrasing, scope clarification).`

  db.prepare(`
    INSERT INTO recommendations
      (id, agent_id, cluster_key, title, severity, type, detail, suggested_change,
       occurrence_count, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, 'warning', 'escalation_pattern', ?, ?, ?, 'active',
            datetime('now'), datetime('now'))
  `).run(recId, agentId, clusterKey, title, detail, suggestedChange, count)

  logger.info({ agentId, actionType, recId, count }, 'escalation rec — spawned new')
  return { id: recId, status: 'spawned', count, title }
}

module.exports = router
