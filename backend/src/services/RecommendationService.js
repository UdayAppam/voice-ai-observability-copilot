const crypto = require('crypto')
const db = require('../db/database')
const logger = require('../logger')

// First-class lifecycle for AI-suggested fixes.
// active → applied (auto-detected when prompt changes) → outcome measured
//                  (avg score on calls with new prompt vs old prompt)
class RecommendationService {
  // Normalise title for deduplication. "Add price objection pivot block",
  // "Add Price Objection Pivot Block", "add price objection pivot block!"
  // all cluster to the same key.
  static clusterKey(title) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120)
  }

  // Called after each analysis is stored. Extracts the recommendations array
  // and upserts each one against the agent's existing recommendation set.
  // V4.1: also records the (rec, call) link so we can count distinct calls
  // affected rather than analysis re-runs.
  static persistFromAnalysis(agentId, callId, recommendations, currentPromptVersionId) {
    if (!recommendations || recommendations.length === 0) return { created: 0, updated: 0 }

    let created = 0
    let updated = 0
    const linkStmt = db.prepare(`
      INSERT OR IGNORE INTO recommendation_calls (recommendation_id, call_id, first_seen_at)
      VALUES (?, ?, datetime('now'))
    `)

    for (const rec of recommendations) {
      const key = this.clusterKey(rec.title)
      const existing = db
        .prepare('SELECT id, status, occurrence_count FROM recommendations WHERE agent_id = ? AND cluster_key = ?')
        .get(agentId, key)

      let recId
      if (existing) {
        if (existing.status === 'applied') {
          // Recommendation reoccurring AFTER it was supposedly applied →
          // re-open it. The fix didn't stick.
          db.prepare(`
            UPDATE recommendations
              SET status = 'active',
                  applied_at = NULL,
                  applied_prompt_version_id = NULL,
                  before_avg_score = NULL,
                  after_avg_score = NULL,
                  before_sample_size = NULL,
                  after_sample_size = NULL,
                  outcome_computed_at = NULL,
                  occurrence_count = occurrence_count + 1,
                  last_seen_at = datetime('now'),
                  detail = ?,
                  suggested_change = ?,
                  severity = ?
              WHERE id = ?
          `).run(rec.detail || null, rec.suggestedChange || null, rec.severity, existing.id)
          logger.info({ recId: existing.id, agentId }, 'recommendation: re-opened (recurred after apply)')
        } else {
          db.prepare(`
            UPDATE recommendations
              SET occurrence_count = occurrence_count + 1,
                  last_seen_at = datetime('now'),
                  detail = ?,
                  suggested_change = ?,
                  severity = ?
              WHERE id = ?
          `).run(rec.detail || null, rec.suggestedChange || null, rec.severity, existing.id)
        }
        recId = existing.id
        updated++
      } else {
        recId = crypto.randomUUID()
        db.prepare(`
          INSERT INTO recommendations
            (id, agent_id, cluster_key, title, severity, type, detail, suggested_change,
             first_seen_prompt_version_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          recId, agentId, key,
          rec.title, rec.severity, rec.type,
          rec.detail || null, rec.suggestedChange || null,
          currentPromptVersionId
        )
        created++
      }

      // V4.1 — link the rec to the call that surfaced it (idempotent via PK)
      if (callId) linkStmt.run(recId, callId)
    }
    return { created, updated }
  }

  // Called when PromptVersionService.recordIfChanged returns isNew=true with
  // a prevVersionId. Every recommendation that was 'active' under the previous
  // prompt is now considered 'applied' — the user changed the prompt, so any
  // outstanding suggestion is presumed acted upon. False positives are
  // self-correcting: if the rec keeps appearing in new analyses, status flips
  // back to 'active' (see persistFromAnalysis above).
  static markActiveAsApplied(agentId, newPromptVersionId) {
    // applied_at MUST be ISO 8601 with 'T' separator so it compares correctly
    // against calls.call_timestamp (also ISO) in computePendingOutcomes.
    // SQLite's datetime('now') returns space-separated format which fails
    // lexicographic ordering against ISO ('T' > ' ' breaks the <=/> tests).
    const nowISO = new Date().toISOString()
    const result = db.prepare(`
      UPDATE recommendations
        SET status = 'applied',
            applied_at = ?,
            applied_prompt_version_id = ?
        WHERE agent_id = ? AND status = 'active'
    `).run(nowISO, newPromptVersionId, agentId)

    if (result.changes > 0) {
      logger.info(
        { agentId, appliedCount: result.changes },
        'recommendation: auto-applied due to prompt version change'
      )
    }
    return result.changes
  }

  // Compute before/after for every applied rec that doesn't yet have an outcome.
  // before = calls of this agent with prompt_version_id != applied_prompt_version
  //          AND call_timestamp <= applied_at
  // after  = calls with prompt_version_id = applied_prompt_version_id
  //          AND call_timestamp > applied_at
  static computePendingOutcomes() {
    const pending = db.prepare(`
      SELECT id, agent_id, applied_at, applied_prompt_version_id
      FROM recommendations
      WHERE status = 'applied' AND outcome_computed_at IS NULL
    `).all()

    let computed = 0
    for (const rec of pending) {
      const before = db.prepare(`
        SELECT AVG(a.overall_score) as avg, COUNT(*) as n
        FROM analyses a JOIN calls c ON c.id = a.call_id
        WHERE c.agent_id = ?
          AND c.call_timestamp <= ?
          AND (c.prompt_version_id IS NULL OR c.prompt_version_id != ?)
      `).get(rec.agent_id, rec.applied_at, rec.applied_prompt_version_id)

      const after = db.prepare(`
        SELECT AVG(a.overall_score) as avg, COUNT(*) as n
        FROM analyses a JOIN calls c ON c.id = a.call_id
        WHERE c.agent_id = ?
          AND c.call_timestamp > ?
          AND c.prompt_version_id = ?
      `).get(rec.agent_id, rec.applied_at, rec.applied_prompt_version_id)

      // Need at least 1 call in each window to make any claim
      if ((before.n || 0) === 0 || (after.n || 0) === 0) continue

      db.prepare(`
        UPDATE recommendations
          SET before_avg_score = ?, after_avg_score = ?,
              before_sample_size = ?, after_sample_size = ?,
              outcome_computed_at = datetime('now')
          WHERE id = ?
      `).run(
        Math.round((before.avg || 0) * 10) / 10,
        Math.round((after.avg || 0) * 10) / 10,
        before.n, after.n,
        rec.id
      )
      computed++
    }
    return computed
  }

  // Detailed view of every applied-but-not-yet-measured recommendation,
  // plus what's blocking measurement. Powers the "what's happening" UI.
  static getAppliedDetails() {
    const rows = db.prepare(`
      SELECT
        r.id, r.title, r.severity, r.type, r.agent_id, ag.name as agentName,
        r.applied_at, r.applied_prompt_version_id, r.before_avg_score, r.before_sample_size,
        r.outcome_computed_at,
        (SELECT COUNT(*) FROM calls c WHERE c.agent_id = r.agent_id
           AND c.prompt_version_id = r.applied_prompt_version_id
           AND c.call_timestamp > r.applied_at) as callsSinceApply,
        (SELECT AVG(a.overall_score) FROM analyses a
           JOIN calls c ON c.id = a.call_id
           WHERE c.agent_id = r.agent_id
             AND c.call_timestamp <= r.applied_at
             AND (c.prompt_version_id IS NULL OR c.prompt_version_id != r.applied_prompt_version_id)) as baselineAvg,
        (SELECT COUNT(*) FROM analyses a
           JOIN calls c ON c.id = a.call_id
           WHERE c.agent_id = r.agent_id
             AND c.call_timestamp <= r.applied_at
             AND (c.prompt_version_id IS NULL OR c.prompt_version_id != r.applied_prompt_version_id)) as baselineN
      FROM recommendations r
      JOIN agents ag ON ag.id = r.agent_id
      WHERE r.status = 'applied'
      ORDER BY r.applied_at DESC
    `).all()

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      type: r.type,
      agentId: r.agent_id,
      agentName: r.agentName,
      appliedAt: r.applied_at,
      callsSinceApply: r.callsSinceApply || 0,
      baselineAvg: r.baselineAvg !== null ? Math.round(r.baselineAvg * 10) / 10 : null,
      baselineN: r.baselineN || 0,
      isMeasured: !!r.outcome_computed_at,
    }))
  }

  // Detailed view of the most urgent active recommendations
  static getActiveDetails(limit = 5) {
    return db.prepare(`
      SELECT
        r.id, r.title, r.severity, r.type, r.agent_id, ag.name as agentName,
        r.occurrence_count, r.first_seen_at, r.suggested_change
      FROM recommendations r
      JOIN agents ag ON ag.id = r.agent_id
      WHERE r.status = 'active'
      ORDER BY
        CASE r.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        r.occurrence_count DESC,
        r.last_seen_at DESC
      LIMIT ?
    `).all(limit)
  }

  // Aggregate view for the dashboard widget
  static getLifecycleSummary(agentId = null) {
    const where = agentId ? 'WHERE agent_id = ?' : ''
    const args = agentId ? [agentId] : []

    const counts = db.prepare(`
      SELECT status, COUNT(*) as n FROM recommendations ${where} GROUP BY status
    `).all(...args)

    const statusCounts = { active: 0, applied: 0, dismissed: 0 }
    counts.forEach((r) => { statusCounts[r.status] = r.n })

    const measured = db.prepare(`
      SELECT id, title, severity, agent_id, before_avg_score, after_avg_score,
             before_sample_size, after_sample_size, applied_at,
             (after_avg_score - before_avg_score) as delta
      FROM recommendations
      WHERE outcome_computed_at IS NOT NULL ${agentId ? 'AND agent_id = ?' : ''}
      ORDER BY applied_at DESC
    `).all(...args)

    const improved = measured.filter((m) => m.delta > 0).length
    const regressed = measured.filter((m) => m.delta < 0).length
    const flat = measured.filter((m) => m.delta === 0).length

    return {
      counts: statusCounts,
      measured: measured.slice(0, 10),
      successRate: measured.length > 0 ? Math.round((improved / measured.length) * 100) : null,
      improvedCount: improved,
      regressedCount: regressed,
      flatCount: flat,
      totalMeasured: measured.length,
    }
  }
}

module.exports = RecommendationService
