// NarrativeService — turns raw flywheel-stage metrics into agency-friendly
// what/why/evidence/action narratives. 100% deterministic, no OpenAI calls.
// Computed from existing analyses / recommendations / agent_prompt_versions data.
const db = require('../db/database')

const HOUR = 3600e3
const DAY = 86400e3

class NarrativeService {
  // Returns a narrative object per stage:
  //   { what, why, evidence: [{label, type, refId}], actionLabel, actionHref }
  static buildAll({ days = 30 } = {}) {
    const sinceISO    = new Date(Date.now() - days * DAY).toISOString()
    const priorSince  = new Date(Date.now() - 2 * days * DAY).toISOString()
    return {
      ingest:    this._buildIngest(sinceISO, priorSince),
      score:     this._buildScore(sinceISO, priorSince),
      recommend: this._buildRecommend(sinceISO),
      apply:     this._buildApply(sinceISO),
      measure:   this._buildMeasure(),
    }
  }

  // Per-agent variant — same 5-stage shape, all queries scoped to one agent.
  // Powers the horizontal flywheel panel on Agent Detail.
  static buildForAgent(agentId, { days = 30 } = {}) {
    const sinceISO   = new Date(Date.now() - days * DAY).toISOString()
    const priorSince = new Date(Date.now() - 2 * days * DAY).toISOString()
    return {
      ingest:    this._buildIngestForAgent(agentId, sinceISO, priorSince),
      score:     this._buildScoreForAgent(agentId, sinceISO, priorSince),
      recommend: this._buildRecommendForAgent(agentId, sinceISO),
      apply:     this._buildApplyForAgent(agentId, sinceISO),
      measure:   this._buildMeasureForAgent(agentId),
    }
  }

  static _buildIngestForAgent(agentId, sinceISO, priorSince) {
    const recent = db.prepare('SELECT COUNT(*) as n FROM calls WHERE agent_id = ? AND call_timestamp >= ?').get(agentId, sinceISO).n
    const prior  = db.prepare('SELECT COUNT(*) as n FROM calls WHERE agent_id = ? AND call_timestamp >= ? AND call_timestamp < ?').get(agentId, priorSince, sinceISO).n
    const delta  = recent - prior
    const pct    = prior > 0 ? Math.round((delta / prior) * 100) : null
    const last   = db.prepare('SELECT id, call_timestamp as ts, caller_number as caller FROM calls WHERE agent_id = ? ORDER BY call_timestamp DESC LIMIT 3').all(agentId)

    let why
    if (recent === 0) why = 'No calls yet in this window for this agent. Sync All to fetch the latest.'
    else if (pct === null) why = `${recent} calls — baseline period (no prior data).`
    else if (pct > 10) why = `Volume up ${pct}% — this agent is gaining traction.`
    else if (pct < -10) why = `Volume down ${Math.abs(pct)}% — caller activity is slowing.`
    else why = `Steady volume — within ±10% of prior.`

    return {
      what: `${recent} calls${pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct}%)` : ''}`,
      why,
      evidence: last.map((c) => ({
        label: `#${c.id.slice(-6)} · ${this._relative(c.ts)}`,
        type: 'call',
        refId: c.id,
      })),
      actionLabel: '↻ Sync from HighLevel',
      actionHref: '#sync',
    }
  }

  static _buildScoreForAgent(agentId, sinceISO, priorSince) {
    const recent = db.prepare(`
      SELECT AVG(a.overall_score) as avg, COUNT(*) as n
      FROM analyses a JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ? AND a.analyzed_at >= ?
    `).get(agentId, sinceISO)
    const prior = db.prepare(`
      SELECT AVG(a.overall_score) as avg
      FROM analyses a JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ? AND a.analyzed_at >= ? AND a.analyzed_at < ?
    `).get(agentId, priorSince, sinceISO)

    const recentAvg = Math.round(recent.avg || 0)
    const priorAvg  = Math.round(prior.avg || 0)
    const delta     = priorAvg ? recentAvg - priorAvg : null

    if (recent.n === 0) {
      return { what: 'No scored calls yet', why: 'Scoring runs automatically on ingest.', evidence: [], actionLabel: null, actionHref: null }
    }

    const worst = db.prepare(`
      SELECT a.call_id, a.overall_score
      FROM analyses a JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ? AND a.analyzed_at >= ? AND a.status != 'pass'
      ORDER BY a.overall_score ASC LIMIT 3
    `).all(agentId, sinceISO)

    let why
    if (delta === null) why = `${recent.n} calls analysed — baseline period.`
    else if (delta > 0) why = `Up ${delta} pts vs prior period — recent fixes are landing.`
    else if (delta < 0) why = `Down ${Math.abs(delta)} pts — something in the script may have regressed.`
    else why = `Score flat at ${recentAvg}/100. ${worst.length > 0 ? `${worst.length} calls failed thresholds.` : 'All recent calls are passing.'}`

    return {
      what: `Avg ${recentAvg}/100${delta !== null ? ` (${delta >= 0 ? '+' : ''}${delta} pts)` : ''} · ${recent.n} analysed`,
      why,
      evidence: worst.map((c) => ({
        label: `#${c.call_id.slice(-6)} · ${c.overall_score}/100`,
        type: 'call',
        refId: c.call_id,
      })),
      actionLabel: 'View calls →',
      actionHref: `/agents/${agentId}#calls`,
    }
  }

  static _buildRecommendForAgent(agentId, sinceISO) {
    const counts = db.prepare(`
      SELECT status, COUNT(*) as n FROM recommendations WHERE agent_id = ? GROUP BY status
    `).all(agentId)
    const map = { active: 0, applied: 0, dismissed: 0 }
    counts.forEach((r) => { map[r.status] = r.n })

    const newSinceWindow = db.prepare(
      'SELECT COUNT(*) as n FROM recommendations WHERE agent_id = ? AND first_seen_at >= ?'
    ).get(agentId, sinceISO).n

    const top = db.prepare(`
      SELECT id, title, severity, occurrence_count
      FROM recommendations WHERE agent_id = ? AND status = 'active'
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, occurrence_count DESC
      LIMIT 3
    `).all(agentId)

    if (map.active === 0) {
      return {
        what: 'No active recommendations',
        why: map.applied > 0 ? `All ${map.applied} prior recommendations have been applied.` : 'No issues detected for this agent.',
        evidence: [],
        actionLabel: null, actionHref: null,
      }
    }

    return {
      what: `${map.active} active · ${map.applied} applied`,
      why: `${newSinceWindow} new this period. Top: "${top[0]?.title || '—'}" (${top[0]?.severity}).`,
      evidence: top.map((r) => ({
        label: `${this._sevIcon(r.severity)} ${r.title.slice(0, 50)}`,
        type: 'recommendation',
        refId: r.id,
      })),
      actionLabel: 'Open Patterns →',
      actionHref: '/patterns',
    }
  }

  static _buildApplyForAgent(agentId, sinceISO) {
    const versionsTotal = db.prepare('SELECT COUNT(*) as n FROM agent_prompt_versions WHERE agent_id = ?').get(agentId).n
    const recentChanges = db.prepare(`
      SELECT apv.id, apv.first_seen_at,
             (SELECT COUNT(*) FROM recommendations r WHERE r.applied_prompt_version_id = apv.id) as appliedCount
      FROM agent_prompt_versions apv
      WHERE apv.agent_id = ? AND apv.first_seen_at >= ?
      ORDER BY apv.first_seen_at DESC LIMIT 3
    `).all(agentId, sinceISO)
    const totalApplied = db.prepare(
      "SELECT COUNT(*) as n FROM recommendations WHERE agent_id = ? AND status = 'applied'"
    ).get(agentId).n

    if (versionsTotal === 0) {
      return { what: '0 prompt versions tracked', why: 'Recorded on next Sync All.', evidence: [], actionLabel: null, actionHref: null }
    }

    const why = recentChanges.length === 0
      ? `${versionsTotal} version${versionsTotal > 1 ? 's' : ''} on record. No prompt edit during this window — waiting on you to apply pending recommendations.`
      : `${recentChanges.length} prompt change${recentChanges.length > 1 ? 's' : ''} detected (${this._relative(recentChanges[0].first_seen_at)}). Auto-applied ${recentChanges.reduce((s, v) => s + v.appliedCount, 0)} recommendation${recentChanges.reduce((s, v) => s + v.appliedCount, 0) === 1 ? '' : 's'}.`

    return {
      what: `${totalApplied} recommendation${totalApplied === 1 ? '' : 's'} applied · ${versionsTotal} version${versionsTotal === 1 ? '' : 's'}`,
      why,
      evidence: recentChanges.map((v) => ({
        label: `${this._relative(v.first_seen_at)} · ${v.appliedCount} rec attached`,
        type: 'prompt_version',
      })),
      actionLabel: null, actionHref: null,
    }
  }

  static _buildMeasureForAgent(agentId) {
    const measured = db.prepare(`
      SELECT id, title, before_avg_score, after_avg_score, before_sample_size, after_sample_size,
             (after_avg_score - before_avg_score) as delta
      FROM recommendations
      WHERE agent_id = ? AND outcome_computed_at IS NOT NULL
      ORDER BY applied_at DESC LIMIT 5
    `).all(agentId)
    const totalApplied = db.prepare(
      "SELECT COUNT(*) as n FROM recommendations WHERE agent_id = ? AND status = 'applied'"
    ).get(agentId).n
    const pending = totalApplied - measured.length

    if (totalApplied === 0) {
      return { what: 'No outcomes yet', why: 'Outcomes appear after a prompt change + new calls under it.', evidence: [], actionLabel: null, actionHref: null }
    }
    if (measured.length === 0) {
      return {
        what: `${totalApplied} applied · ${pending} pending measurement`,
        why: `All applied recommendations are still collecting post-apply calls.`,
        evidence: [], actionLabel: null, actionHref: null,
      }
    }
    const improved = measured.filter((m) => m.delta > 0)
    const successRate = Math.round((improved.length / measured.length) * 100)
    const best = improved.sort((a, b) => b.delta - a.delta)[0]

    return {
      what: `${successRate}% success · ${measured.length} measured · ${pending} pending`,
      why: best
        ? `${improved.length} of ${measured.length} improved. Best: "${best.title}" +${Math.round(best.delta * 10) / 10} pts (n=${best.after_sample_size}).`
        : `${measured.length} measured; none improved yet — re-investigate the applied fixes.`,
      evidence: measured.slice(0, 3).map((m) => ({
        label: `${m.delta > 0 ? '+' : ''}${Math.round(m.delta * 10) / 10}: ${m.title.slice(0, 40)}`,
        type: 'recommendation',
        refId: m.id,
      })),
      actionLabel: null, actionHref: null,
    }
  }

  // ── Stage 1: Ingest ──────────────────────────────────────────────────
  static _buildIngest(sinceISO, priorSince) {
    const recent = db.prepare(
      'SELECT COUNT(*) as n FROM calls WHERE call_timestamp >= ?'
    ).get(sinceISO).n
    const prior = db.prepare(
      'SELECT COUNT(*) as n FROM calls WHERE call_timestamp >= ? AND call_timestamp < ?'
    ).get(priorSince, sinceISO).n

    const delta = recent - prior
    const pctChange = prior > 0 ? Math.round((delta / prior) * 100) : null

    // Per-agent contribution to volume
    const perAgent = db.prepare(`
      SELECT ag.name as agentName, COUNT(c.id) as n
      FROM calls c JOIN agents ag ON ag.id = c.agent_id
      WHERE c.call_timestamp >= ?
      GROUP BY ag.id ORDER BY n DESC LIMIT 3
    `).all(sinceISO)

    let why
    if (recent === 0) {
      why = 'No calls ingested yet in this window. Run Sync All to pull the latest from HighLevel.'
    } else if (pctChange === null) {
      why = `${recent} calls ingested — baseline period (no prior data to compare).`
    } else if (pctChange > 10) {
      const top = perAgent[0]
      why = `Volume up ${pctChange}%. Largest contributor: ${top?.agentName} (${top?.n} calls in window).`
    } else if (pctChange < -10) {
      why = `Volume down ${Math.abs(pctChange)}%. Could indicate reduced campaign activity or HL ingestion lag.`
    } else {
      why = `Steady volume — within ±10% of the prior period.`
    }

    return {
      what: `${recent} calls ingested${pctChange !== null ? ` (${pctChange >= 0 ? '+' : ''}${pctChange}% vs prior)` : ''}`,
      why,
      evidence: perAgent.map((a) => ({ label: `${a.agentName}: ${a.n}`, type: 'agent_contrib' })),
      actionLabel: '↻ Sync from HighLevel',
      actionHref: '#sync',
    }
  }

  // ── Stage 2: Score ────────────────────────────────────────────────────
  static _buildScore(sinceISO, priorSince) {
    const recent = db.prepare(`
      SELECT AVG(overall_score) as avg, COUNT(*) as n
      FROM analyses WHERE analyzed_at >= ?
    `).get(sinceISO)
    const prior = db.prepare(`
      SELECT AVG(overall_score) as avg FROM analyses
      WHERE analyzed_at >= ? AND analyzed_at < ?
    `).get(priorSince, sinceISO)

    const recentAvg = Math.round(recent.avg || 0)
    const priorAvg = Math.round(prior.avg || 0)
    const delta = priorAvg ? recentAvg - priorAvg : null

    if (recent.n === 0) {
      return {
        what: 'No scored calls in this window',
        why: 'Scoring runs automatically when calls ingest. Try ↻ Sync All.',
        evidence: [],
        actionLabel: null, actionHref: null,
      }
    }

    // Per-KPI movement: compare avg of each KPI between windows
    const kpiNames = ['call_completion','script_adherence','objection_handling','sentiment_score','response_quality','escalation_rate']
    const kpiDeltas = []
    for (const name of kpiNames) {
      const recVal = this._avgKpi(name, sinceISO, null)
      const priVal = this._avgKpi(name, priorSince, sinceISO)
      if (recVal !== null && priVal !== null && Math.abs(recVal - priVal) >= 3) {
        kpiDeltas.push({ name, recVal, priVal, delta: recVal - priVal })
      }
    }
    kpiDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

    // Worst-scoring calls drive evidence
    const worstCalls = db.prepare(`
      SELECT a.call_id, a.overall_score, ag.name as agentName
      FROM analyses a
      JOIN calls c ON c.id = a.call_id
      JOIN agents ag ON ag.id = c.agent_id
      WHERE a.analyzed_at >= ? AND a.status != 'pass'
      ORDER BY a.overall_score ASC LIMIT 3
    `).all(sinceISO)

    let why
    if (delta === null) {
      why = `${recent.n} calls scored — baseline period (no prior comparison).`
    } else if (kpiDeltas.length > 0) {
      const top = kpiDeltas[0]
      const dir = top.delta < 0 ? 'fell' : 'rose'
      const sign = top.delta < 0 ? '-' : '+'
      const others = kpiDeltas.length > 1 ? `; ${kpiDeltas.length - 1} other KPI${kpiDeltas.length > 2 ? 's' : ''} also moved` : ''
      why = `Largest mover: ${this._kpiLabel(top.name)} ${dir} ${sign}${Math.abs(top.delta)} pts (${top.priVal}→${top.recVal})${others}.`
    } else if (Math.abs(delta) < 3) {
      why = `Overall ${recentAvg}/100. KPI distribution stable vs prior period.`
    } else {
      why = `Overall avg shifted ${delta >= 0 ? '+' : ''}${delta} pts but no individual KPI moved significantly — could be noise from small sample.`
    }

    return {
      what: `Avg KPI ${recentAvg}/100${delta !== null ? ` (${delta >= 0 ? '+' : ''}${delta} pts vs prior)` : ''} · ${recent.n} analysed`,
      why,
      evidence: worstCalls.map((c) => ({
        label: `${c.agentName} #${c.call_id.slice(-6)} · ${c.overall_score}/100`,
        type: 'call',
        refId: c.call_id,
      })),
      actionLabel: 'View failure patterns →',
      actionHref: '/patterns',
    }
  }

  // ── Stage 3: Recommend ────────────────────────────────────────────────
  static _buildRecommend(sinceISO) {
    const counts = db.prepare(`
      SELECT status, COUNT(*) as n FROM recommendations GROUP BY status
    `).all()
    const map = { active: 0, applied: 0, dismissed: 0 }
    counts.forEach((r) => { map[r.status] = r.n })

    const byseverity = db.prepare(`
      SELECT severity, COUNT(*) as n FROM recommendations
      WHERE status = 'active' GROUP BY severity
    `).all()
    const sevMap = { critical: 0, warning: 0, suggestion: 0 }
    byseverity.forEach((r) => { sevMap[r.severity] = r.n })

    const topRecs = db.prepare(`
      SELECT r.id, r.title, r.severity, r.occurrence_count,
             COUNT(DISTINCT ag.id) as agentCount
      FROM recommendations r
      JOIN (
        SELECT cluster_key, agent_id FROM recommendations WHERE status = 'active'
      ) c ON c.cluster_key = r.cluster_key
      JOIN agents ag ON ag.id = c.agent_id
      WHERE r.status = 'active'
      GROUP BY r.cluster_key
      ORDER BY agentCount DESC, r.occurrence_count DESC
      LIMIT 3
    `).all()

    const newSinceWindow = db.prepare(`
      SELECT COUNT(*) as n FROM recommendations WHERE first_seen_at >= ?
    `).get(sinceISO).n

    if (map.active === 0) {
      return {
        what: 'No active recommendations',
        why: map.applied > 0
          ? `Excellent — all ${map.applied} prior recommendations have been applied.`
          : 'No analysed calls have produced recommendations yet.',
        evidence: [],
        actionLabel: null, actionHref: null,
      }
    }

    const distribution = `${sevMap.critical} critical · ${sevMap.warning} warning · ${sevMap.suggestion} suggestion`
    const newBit = newSinceWindow > 0 ? `, ${newSinceWindow} new this period` : ''
    const top = topRecs[0]
    const why = `${distribution}${newBit}. Most-pressing pattern: "${top?.title || '—'}" affects ${top?.agentCount || '?'} agent${top?.agentCount === 1 ? '' : 's'}.`

    return {
      what: `${map.active} active recommendations · ${map.applied} applied`,
      why,
      evidence: topRecs.map((r) => ({
        label: `${this._sevIcon(r.severity)} ${r.title.slice(0, 50)}`,
        type: 'recommendation',
        refId: r.id,
      })),
      actionLabel: 'Open Patterns →',
      actionHref: '/patterns',
    }
  }

  // ── Stage 4: Apply ────────────────────────────────────────────────────
  static _buildApply(sinceISO) {
    const versionsTotal = db.prepare('SELECT COUNT(*) as n FROM agent_prompt_versions').get().n
    const recentChanges = db.prepare(`
      SELECT apv.id, apv.agent_id, ag.name as agentName, apv.first_seen_at,
             (SELECT COUNT(*) FROM recommendations r WHERE r.applied_prompt_version_id = apv.id) as appliedCount
      FROM agent_prompt_versions apv
      JOIN agents ag ON ag.id = apv.agent_id
      WHERE apv.first_seen_at >= ?
      ORDER BY apv.first_seen_at DESC LIMIT 3
    `).all(sinceISO)

    const totalApplied = db.prepare(
      "SELECT COUNT(*) as n FROM recommendations WHERE status = 'applied'"
    ).get().n

    if (versionsTotal === 0) {
      return {
        what: '0 prompt versions tracked',
        why: 'Versions get recorded on the next Sync All. No agents have been ingested yet.',
        evidence: [],
        actionLabel: null, actionHref: null,
      }
    }

    let why
    if (recentChanges.length === 0) {
      why = `${versionsTotal} version${versionsTotal > 1 ? 's' : ''} tracked total. No prompt edits in HighLevel during this window — the loop is waiting on humans to apply pending recommendations.`
    } else {
      const top = recentChanges[0]
      const ago = this._relative(top.first_seen_at)
      const recsAttached = recentChanges.reduce((s, v) => s + v.appliedCount, 0)
      why = `${recentChanges.length} prompt change${recentChanges.length > 1 ? 's' : ''} detected (${top.agentName} most recent, ${ago}). ${recsAttached > 0 ? `${recsAttached} recommendation${recsAttached > 1 ? 's' : ''} auto-marked applied as a result.` : 'No active recommendations were attached.'}`
    }

    // Action deep-links to the top recently-changed agent if we have one.
    // Otherwise route to /patterns (the queue of pending recs to apply).
    const topAgent = recentChanges[0]
    const actionLabel = topAgent ? `Open ${topAgent.agentName} →` : 'Open pending patterns →'
    const actionHref  = topAgent ? `/agents/${topAgent.agent_id}` : '/patterns'

    return {
      what: `${totalApplied} recommendation${totalApplied === 1 ? '' : 's'} applied · ${versionsTotal} prompt version${versionsTotal === 1 ? '' : 's'} tracked`,
      why,
      // Evidence entries link to the agent's detail page (where the per-agent
      // flywheel + KPI history live).
      evidence: recentChanges.map((v) => ({
        label: `${v.agentName} · ${this._relative(v.first_seen_at)} · ${v.appliedCount} rec`,
        type: 'agent',
        refId: v.agent_id,
      })),
      actionLabel,
      actionHref,
    }
  }

  // ── Stage 5: Measure ──────────────────────────────────────────────────
  static _buildMeasure() {
    const measured = db.prepare(`
      SELECT id, title, before_avg_score, after_avg_score, before_sample_size, after_sample_size,
             (after_avg_score - before_avg_score) as delta
      FROM recommendations
      WHERE outcome_computed_at IS NOT NULL
      ORDER BY applied_at DESC LIMIT 5
    `).all()

    const totalApplied = db.prepare(
      "SELECT COUNT(*) as n FROM recommendations WHERE status = 'applied'"
    ).get().n
    const totalMeasured = measured.length
    const pendingMeasurement = totalApplied - totalMeasured

    if (totalApplied === 0) {
      return {
        what: 'No outcomes to measure yet',
        why: 'Outcomes appear after a recommendation is applied (i.e., the agent prompt is updated in HighLevel) and new calls are scored under the new prompt.',
        evidence: [],
        actionLabel: null, actionHref: null,
      }
    }

    if (totalMeasured === 0) {
      return {
        what: `${totalApplied} applied · ${pendingMeasurement} pending measurement`,
        why: `All applied recommendations are still collecting post-apply calls. The first outcome will appear once ${pendingMeasurement === 1 ? 'this recommendation' : 'any of them'} accumulates at least one analysed call under the new prompt.`,
        evidence: [],
        actionLabel: 'See applied recs →',
        actionHref: '/patterns?status=applied',
      }
    }

    const improved = measured.filter((m) => m.delta > 0)
    const regressed = measured.filter((m) => m.delta < 0)
    const successRate = Math.round((improved.length / totalMeasured) * 100)

    const best = improved.sort((a, b) => b.delta - a.delta)[0]
    const worst = regressed.sort((a, b) => a.delta - b.delta)[0]

    let why = `${improved.length} of ${totalMeasured} measured recommendations improved scores`
    if (best) why += `. Best: "${best.title}" delivered +${Math.round(best.delta * 10) / 10} pts (n=${best.after_sample_size})`
    if (worst) {
      const d = Math.round(worst.delta * 10) / 10
      why += `. Regression: "${worst.title}" ${d > 0 ? '+' + d : d} pts (re-investigate)`
    }
    why += '.'

    return {
      what: `${successRate}% success rate · ${totalMeasured} measured · ${pendingMeasurement} pending`,
      why,
      evidence: measured.slice(0, 3).map((m) => ({
        label: `${m.delta > 0 ? '+' : ''}${Math.round(m.delta * 10) / 10}: ${m.title.slice(0, 40)}`,
        type: 'recommendation',
        refId: m.id,
      })),
      actionLabel: 'Apply the next recommendation →',
      actionHref: '/patterns',
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────
  static _avgKpi(name, sinceISO, untilISO) {
    const where = untilISO
      ? 'WHERE analyzed_at >= ? AND analyzed_at < ?'
      : 'WHERE analyzed_at >= ?'
    const args = untilISO ? [sinceISO, untilISO] : [sinceISO]
    const rows = db.prepare(`SELECT kpi_scores_json FROM analyses ${where}`).all(...args)
    if (rows.length === 0) return null
    const total = rows.reduce((s, r) => s + (JSON.parse(r.kpi_scores_json)[name] ?? 0), 0)
    return Math.round(total / rows.length)
  }

  static _kpiLabel(name) {
    return {
      call_completion: 'Call Completion',
      script_adherence: 'Script Adherence',
      objection_handling: 'Objection Handling',
      sentiment_score: 'Caller Sentiment',
      response_quality: 'Response Quality',
      escalation_rate: 'Escalation Rate',
    }[name] || name
  }

  static _sevIcon(sev) {
    return sev === 'critical' ? '🔴' : sev === 'warning' ? '🟡' : '🔵'
  }

  static _relative(iso) {
    if (!iso) return '—'
    const diff = Date.now() - new Date(iso).getTime()
    if (diff < HOUR) return `${Math.round(diff / 60000)} min ago`
    if (diff < DAY) return `${Math.round(diff / HOUR)} h ago`
    return `${Math.round(diff / DAY)} d ago`
  }
}

module.exports = NarrativeService
