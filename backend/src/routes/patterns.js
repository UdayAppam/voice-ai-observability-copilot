const express = require('express')
const db = require('../db/database')

const router = express.Router()

// GET /api/patterns?status=active&minAgents=1&limit=50
// Cross-agent clusters: each row groups recommendations by cluster_key,
// shows which agents share the failure pattern + aggregate severity.
// Powers the /patterns page — the "fix once, help many agents" view.
//
// V4.1: per-pattern callsAffected + failedCallsAffected come from the
// recommendation_calls join (counts distinct calls, not analysis re-runs).
// `totalOccurrences` is kept for backwards-compat but no longer driven the UI.
router.get('/', (req, res, next) => {
  try {
    const status   = ['active', 'applied', 'dismissed', 'all'].includes(req.query.status) ? req.query.status : 'active'
    const minAgents = Math.max(1, parseInt(req.query.minAgents) || 1)
    const limit     = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50))

    const statusFilter = status === 'all' ? '' : 'WHERE r.status = ?'
    const params = status === 'all' ? [] : [status]

    // Pattern-level aggregate. callsAffected = distinct calls where ANY rec in this
    // cluster surfaced. failedCallsAffected = subset where the call's analysis was
    // status='fail' (the outcome anchor).
    const rows = db.prepare(`
      SELECT
        r.cluster_key                            as clusterKey,
        MIN(r.title)                             as title,
        COUNT(DISTINCT r.agent_id)               as affectedAgents,
        SUM(r.occurrence_count)                  as totalOccurrences,
        SUM(CASE WHEN r.status='active'    THEN 1 ELSE 0 END) as activeCount,
        SUM(CASE WHEN r.status='applied'   THEN 1 ELSE 0 END) as appliedCount,
        SUM(CASE WHEN r.status='dismissed' THEN 1 ELSE 0 END) as dismissedCount,
        MIN(CASE r.severity
              WHEN 'critical'   THEN 0
              WHEN 'warning'    THEN 1
              WHEN 'suggestion' THEN 2
              ELSE 3 END)                        as severityRank,
        MIN(r.first_seen_at)                     as firstSeenAt,
        MAX(r.last_seen_at)                      as lastSeenAt,
        GROUP_CONCAT(DISTINCT r.type)            as types,
        (SELECT COUNT(DISTINCT rc.call_id)
           FROM recommendation_calls rc
           JOIN recommendations r2 ON r2.id = rc.recommendation_id
           WHERE r2.cluster_key = r.cluster_key)                            as callsAffected,
        (SELECT COUNT(DISTINCT rc.call_id)
           FROM recommendation_calls rc
           JOIN recommendations r2 ON r2.id = rc.recommendation_id
           JOIN analyses a ON a.call_id = rc.call_id
           WHERE r2.cluster_key = r.cluster_key AND a.status = 'fail')      as failedCallsAffected
      FROM recommendations r
      ${statusFilter}
      GROUP BY r.cluster_key
      HAVING affectedAgents >= ?
      ORDER BY severityRank ASC, callsAffected DESC, affectedAgents DESC
      LIMIT ?
    `).all(...params, minAgents, limit)

    // Per-agent row inside the expanded pattern. callsAffected here is the count
    // of distinct calls that surfaced this specific (rec, agent) — used as the
    // "flagged in N calls" line replacing the misleading "N× seen" label.
    const detailStmt = db.prepare(`
      SELECT r.id, r.agent_id as agentId, ag.name as agentName, r.severity,
             r.status, r.last_seen_at as lastSeenAt,
             r.suggested_change as suggestedChange, r.detail,
             (SELECT COUNT(DISTINCT rc.call_id) FROM recommendation_calls rc
                WHERE rc.recommendation_id = r.id)                          as callsAffected,
             (SELECT COUNT(DISTINCT rc.call_id) FROM recommendation_calls rc
                JOIN analyses a ON a.call_id = rc.call_id
                WHERE rc.recommendation_id = r.id AND a.status = 'fail')    as failedCallsAffected
      FROM recommendations r
      JOIN agents ag ON ag.id = r.agent_id
      WHERE r.cluster_key = ?
      ORDER BY
        CASE r.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        r.last_seen_at DESC
    `)

    const patterns = rows.map((row) => {
      const severity = ['critical', 'warning', 'suggestion'][row.severityRank] || 'suggestion'
      const agents = detailStmt.all(row.clusterKey)
      return {
        clusterKey:           row.clusterKey,
        title:                row.title,
        severity,
        affectedAgents:       row.affectedAgents,
        callsAffected:        row.callsAffected,
        failedCallsAffected:  row.failedCallsAffected,
        totalOccurrences:     row.totalOccurrences,         // kept for backwards-compat
        urgencyDescriptor:    _urgencyDescriptor(row.callsAffected),
        statusBreakdown:  {
          active:    row.activeCount,
          applied:   row.appliedCount,
          dismissed: row.dismissedCount,
        },
        types:                (row.types || '').split(',').filter(Boolean),
        firstSeenAt:          row.firstSeenAt,
        lastSeenAt:           row.lastSeenAt,
        agents,
      }
    })

    res.json({
      filter: { status, minAgents, limit },
      total:  patterns.length,
      patterns,
    })
  } catch (err) {
    next(err)
  }
})

// Turns a calls-affected count into a customer-friendly urgency label.
// Thresholds tuned for a single-sub-account assignment scale; revisit at multi-tenant scale.
function _urgencyDescriptor(callsAffected) {
  if (callsAffected >= 5) return 'systemic'
  if (callsAffected >= 2) return 'recurring'
  return 'one-off'
}

module.exports = router
