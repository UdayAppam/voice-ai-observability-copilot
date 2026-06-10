const express = require('express')
const db = require('../db/database')
const RecommendationService = require('../services/RecommendationService')

const router = express.Router()

// GET /api/dashboard/summary?days=7
// Powers the Overview page. Aggregates across all agents within the date window.
router.get('/summary', (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 7))
    const sinceISO = new Date(Date.now() - days * 86400e3).toISOString()
    const prevSinceISO = new Date(Date.now() - 2 * days * 86400e3).toISOString()
    // V5.3 — optional per-agent filter for sentiment trend (no effect on
    // other widgets; they stay agency-wide)
    const sentimentAgentId = req.query.sentimentAgentId || null

    const agents = db.prepare('SELECT id, name, goal FROM agents ORDER BY name').all()
    // Pre-fetch everything needed for all agents in O(few) queries instead of O(agents × 6).
    // Scales cleanly to 100s of agents.
    const bulk = buildBulkAgentData(agents)
    const agentSummaries = agents.map((agent) => buildAgentSummary(agent, bulk))

    // Global aggregates
    const totalCalls = sumCalls(sinceISO)
    const prevTotalCalls = sumCalls(prevSinceISO, sinceISO)
    // V5.4 — conversionRate replaces the broken successRate. See audit in
    // IMPLEMENTATION_PLAN Phase 5.4 for context.
    const conversionRate = computeConversionRate(sinceISO)
    const prevConversionRate = computeConversionRate(prevSinceISO, sinceISO)
    const kpiPassRate = computeKpiPassRate(sinceISO)
    const prevKpiPassRate = computeKpiPassRate(prevSinceISO, sinceISO)
    const avgDuration = computeAvgDuration(sinceISO)
    const prevAvgDuration = computeAvgDuration(prevSinceISO, sinceISO)
    const avgHealthScore = computeAvgHealthScore(sinceISO)
    const prevAvgHealthScore = computeAvgHealthScore(prevSinceISO, sinceISO)
    const actionsRequired = countActionsRequired(sinceISO)
    const prevActionsRequired = countActionsRequired(prevSinceISO, sinceISO)

    // Hero metrics with trend deltas. `delta` is %; `deltaRaw` is absolute.
    // UI shows whichever is more meaningful (raw when % is null/capped).
    const hero = {
      totalCalls:     { value: totalCalls,     delta: pct(totalCalls,     prevTotalCalls),    deltaRaw: rawDelta(totalCalls,     prevTotalCalls) },
      conversionRate: { value: conversionRate, delta: pct(conversionRate, prevConversionRate),deltaRaw: rawDelta(conversionRate, prevConversionRate) },
      kpiPassRate:    { value: kpiPassRate,    delta: pct(kpiPassRate,    prevKpiPassRate),   deltaRaw: rawDelta(kpiPassRate,    prevKpiPassRate) },
      avgDuration:    { value: avgDuration,    delta: pct(avgDuration,    prevAvgDuration),   deltaRaw: rawDelta(avgDuration,    prevAvgDuration) },
      avgHealthScore: { value: avgHealthScore, delta: pct(avgHealthScore, prevAvgHealthScore),deltaRaw: rawDelta(avgHealthScore, prevAvgHealthScore) },
      actionsRequired:{ value: actionsRequired,delta: pct(actionsRequired,prevActionsRequired),deltaRaw: rawDelta(actionsRequired,prevActionsRequired) },
      // Back-compat alias so any old client still parses without 500-ing
      // (frontend OverviewView is updated, but external readers may exist).
      successRate:    { value: conversionRate, delta: pct(conversionRate, prevConversionRate),deltaRaw: rawDelta(conversionRate, prevConversionRate) },
    }

    res.json({
      window: { days, sinceISO },
      totalAgents: agents.length,
      // V5.4 — was returning totalCalls (every ingested call, even pending);
      // now correctly counts only calls whose analysis completed. Both fields
      // exposed so existing readers don't break.
      totalCallsAnalyzed: computeAnalysedCount(sinceISO),
      totalCallsIngested: totalCalls,
      avgHealthScore,
      hero,
      agents: agentSummaries,
      sentimentTrend:        computeSentimentTrend(sinceISO, days, sentimentAgentId),
      sentimentSpike:        computeSentimentSpike(computeSentimentTrend(sinceISO, days, sentimentAgentId)),
      sentimentAgentFilter:  sentimentAgentId,
      sentimentBucketThresholds: { positive: 60, negative: 30 },
      topFailureReasons:     computeTopFailureReasons(sinceISO),
      callsNeedingAttention: computeCallsNeedingAttention(sinceISO),
      aggregatedRecommendations: computeAggregatedRecommendations(sinceISO),
      loopClosing:           computeLoopClosingV2(),
      agentStatusStrip:      computeAgentStatusStrip(),
      kpiPerformance:        computeKpiPerformance(sinceISO),
    })
  } catch (err) {
    next(err)
  }
})

// ─── helpers ──────────────────────────────────────────────────────────────
// pct() + rawDelta() are defined further down (see "Period-over-period…" block).

function sumCalls(sinceISO, untilISO = null) {
  const sql = untilISO
    ? 'SELECT COUNT(*) as n FROM calls WHERE call_timestamp >= ? AND call_timestamp < ?'
    : 'SELECT COUNT(*) as n FROM calls WHERE call_timestamp >= ?'
  const args = untilISO ? [sinceISO, untilISO] : [sinceISO]
  return db.prepare(sql).get(...args).n
}

// V5.4 — Conversion Rate: % of calls where a positive business outcome was
// recorded. The original implementation hardcoded a single string `'booked'`
// which matched 0 rows on real data (where outcomes look like
// `meeting_booked`, `consultation_booked`, `appointment_booked`, etc.).
// We now use a set of variants. Distinct from KPI Pass Rate (which measures
// whether the AGENT did its job well via KPI scores) — both are legitimate
// signals, see computeKpiPassRate below.
const POSITIVE_OUTCOMES = new Set([
  'booked', 'completed_booked',
  'meeting_booked', 'appointment_booked', 'consultation_booked',
  'trial_started', 'sale', 'sold', 'closed_won',
  'qualified', 'lead_qualified',
])
function computeConversionRate(sinceISO, untilISO = null) {
  const where = untilISO
    ? 'WHERE c.call_timestamp >= ? AND c.call_timestamp < ?'
    : 'WHERE c.call_timestamp >= ?'
  const args = untilISO ? [sinceISO, untilISO] : [sinceISO]
  const rows = db.prepare(`SELECT outcome FROM calls c ${where}`).all(...args)
  if (rows.length === 0) return 0
  const good = rows.reduce((n, r) => n + (POSITIVE_OUTCOMES.has(r.outcome) ? 1 : 0), 0)
  return Math.round((good / rows.length) * 1000) / 10
}

// V5.4 — KPI Pass Rate: % of analysed calls where the AGENT met its KPI
// thresholds. Different from Conversion Rate above. Both are useful.
function computeKpiPassRate(sinceISO, untilISO = null) {
  const where = untilISO
    ? 'WHERE a.analyzed_at >= ? AND a.analyzed_at < ?'
    : 'WHERE a.analyzed_at >= ?'
  const args = untilISO ? [sinceISO, untilISO] : [sinceISO]
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as good,
      COUNT(*) as total
    FROM analyses a ${where}
  `).get(...args)
  if (!row.total) return 0
  return Math.round((row.good / row.total) * 1000) / 10
}

// V5.4 — count of CALLS WHOSE ANALYSIS HAS COMPLETED. Distinct from totalCalls
// (which includes pending/failed analyses too). The original `totalCallsAnalyzed`
// field misleadingly returned totalCalls — see audit.
function computeAnalysedCount(sinceISO) {
  return db.prepare(
    `SELECT COUNT(*) as n FROM calls WHERE call_timestamp >= ? AND analysis_status = 'completed'`
  ).get(sinceISO).n
}

function computeAvgDuration(sinceISO, untilISO = null) {
  const where = untilISO
    ? 'WHERE call_timestamp >= ? AND call_timestamp < ?'
    : 'WHERE call_timestamp >= ?'
  const args = untilISO ? [sinceISO, untilISO] : [sinceISO]
  const row = db.prepare(`SELECT AVG(duration) as avg FROM calls ${where}`).get(...args)
  return Math.round(row.avg || 0)
}

function computeAvgHealthScore(sinceISO, untilISO = null) {
  const where = untilISO
    ? 'WHERE a.analyzed_at >= ? AND a.analyzed_at < ?'
    : 'WHERE a.analyzed_at >= ?'
  const args = untilISO ? [sinceISO, untilISO] : [sinceISO]
  const row = db.prepare(`SELECT AVG(overall_score) as avg FROM analyses a ${where}`).get(...args)
  return Math.round(row.avg || 0)
}

// Period-over-period % change. Returns null when prior is too small
// (< 5) to produce a meaningful percentage — a 1→67 jump reads as 6600%
// which is mathematically right but visually absurd. UI falls back to deltaRaw.
function pct(now, prev) {
  if (!prev || prev === 0) return null
  if (prev < 5) return null
  return Math.round(((now - prev) / prev) * 1000) / 10
}

// Raw absolute change — meaningful regardless of base size. Always returned
// alongside `delta` so the UI can pick whichever is more informative.
function rawDelta(now, prev) {
  if (prev === null || prev === undefined) return null
  return now - prev
}

function countActionsRequired(sinceISO, untilISO = null) {
  // Sum lengths of use_actions arrays across analyses in window
  const where = untilISO
    ? 'WHERE a.analyzed_at >= ? AND a.analyzed_at < ?'
    : 'WHERE a.analyzed_at >= ?'
  const args = untilISO ? [sinceISO, untilISO] : [sinceISO]
  const rows = db.prepare(`SELECT use_actions_json FROM analyses a ${where}`).all(...args)
  return rows.reduce((sum, r) => sum + JSON.parse(r.use_actions_json).length, 0)
}

// V5.6 — sentiment helpers extracted to backend/src/services/SentimentService.js
// so both dashboard (agency-wide) and agents (per-agent) routes can share them.
const { computeSentimentTrend, computeSentimentSpike } = require('../services/SentimentService')

function computeTopFailureReasons(sinceISO) {
  // Cluster recommendation titles across all analyses in window
  const rows = db.prepare(`
    SELECT a.recommendations_json
    FROM analyses a
    WHERE a.analyzed_at >= ?
  `).all(sinceISO)

  const total = rows.length || 1
  const counts = {}
  for (const r of rows) {
    const recs = JSON.parse(r.recommendations_json)
    for (const rec of recs) {
      const key = rec.title
      if (!counts[key]) counts[key] = { label: rec.title, count: 0, severity: rec.severity }
      counts[key].count++
    }
  }

  return Object.values(counts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((r) => ({ ...r, pct: Math.round((r.count / total) * 100) }))
}

function computeCallsNeedingAttention(sinceISO) {
  // Top 5 calls with critical/warning severity recs in window, ordered by lowest score
  return db.prepare(`
    SELECT
      c.id, c.agent_id, c.duration, c.outcome, c.call_timestamp,
      ag.name as agentName,
      a.overall_score,
      a.recommendations_json
    FROM analyses a
    JOIN calls c ON c.id = a.call_id
    JOIN agents ag ON ag.id = c.agent_id
    WHERE a.analyzed_at >= ?
    ORDER BY a.overall_score ASC
    LIMIT 5
  `).all(sinceISO).map((row) => {
    const recs = JSON.parse(row.recommendations_json)
    const topRec = recs.find((r) => r.severity === 'critical') ?? recs[0]
    // eslint-disable-next-line no-unused-vars
    const { recommendations_json: _r, ...rest } = row
    return { ...rest, issue: topRec?.title ?? row.outcome }
  })
}

function computeAggregatedRecommendations(sinceISO) {
  // Same clustering as topFailureReasons but returns the full rec object with impact band
  const rows = db.prepare(`
    SELECT a.recommendations_json FROM analyses a WHERE a.analyzed_at >= ?
  `).all(sinceISO)

  const total = rows.length || 1
  const map = {}
  for (const r of rows) {
    const recs = JSON.parse(r.recommendations_json)
    for (const rec of recs) {
      const key = rec.title
      if (!map[key]) {
        map[key] = { ...rec, count: 0 }
      }
      map[key].count++
    }
  }

  return Object.values(map)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((r) => {
      const pct = Math.round((r.count / total) * 100)
      const impact = pct >= 30 ? 'high' : pct >= 15 ? 'medium' : 'low'
      return { ...r, pctOfCalls: pct, impact }
    })
}

// Production version: uses the recommendation lifecycle table for causal
// before/after measurement, not arbitrary time windows.
function computeLoopClosingV2() {
  const summary = RecommendationService.getLifecycleSummary()
  const measured = summary.measured

  if (summary.counts.applied === 0 && summary.counts.active === 0) {
    return { state: 'collecting', message: 'No recommendations tracked yet. The flywheel activates after the first analysed call.' }
  }

  if (summary.counts.applied === 0) {
    return {
      state: 'awaiting_apply',
      activeCount: summary.counts.active,
      message: `${summary.counts.active} active recommendation${summary.counts.active === 1 ? '' : 's'} waiting to be applied. Edit the agent prompt in HighLevel to close the loop.`,
      topActive: RecommendationService.getActiveDetails(3).map((r) => ({
        id: r.id,
        title: r.title,
        severity: r.severity,
        type: r.type,
        agentId: r.agent_id,
        agentName: r.agentName,
        suggestedChange: r.suggested_change,
        occurrenceCount: r.occurrence_count,
      })),
    }
  }

  const applied = RecommendationService.getAppliedDetails()

  if (measured.length === 0) {
    return {
      state: 'awaiting_measurement',
      appliedCount: summary.counts.applied,
      activeCount: summary.counts.active,
      message: `${summary.counts.applied} recommendation${summary.counts.applied === 1 ? '' : 's'} applied to the HighLevel agent prompt. Outcome will be measured after the next analysed call with the new prompt.`,
      applied: applied.filter((r) => !r.isMeasured),
    }
  }

  return {
    state: 'measured',
    successRate: summary.successRate,
    improvedCount: summary.improvedCount,
    regressedCount: summary.regressedCount,
    flatCount: summary.flatCount,
    totalMeasured: summary.totalMeasured,
    activeCount: summary.counts.active,
    appliedCount: summary.counts.applied,
    awaitingMeasurement: applied.filter((r) => !r.isMeasured),
    recent: measured.slice(0, 5).map((m) => ({
      id: m.id,
      title: m.title,
      severity: m.severity,
      appliedAt: m.applied_at,
      before: m.before_avg_score,
      after: m.after_avg_score,
      delta: Math.round(m.delta * 10) / 10,
      beforeN: m.before_sample_size,
      afterN: m.after_sample_size,
    })),
  }
}

// Legacy V1 — kept for reference / fallback. Time-window correlation only.
// eslint-disable-next-line no-unused-vars
function computeLoopClosing() {
  // Pull top recommendation from prior week, compare avg score before vs after.
  // If insufficient data → return baseline-collection state.
  const recentSince = new Date(Date.now() - 7 * 86400e3).toISOString()
  const priorSince  = new Date(Date.now() - 14 * 86400e3).toISOString()

  const prior = computeAvgHealthScore(priorSince, recentSince)
  const recent = computeAvgHealthScore(recentSince)

  if (prior === 0 || recent === 0) {
    return { state: 'collecting', message: 'Collecting baseline — flywheel impact will appear after 14 days of data.' }
  }

  // Find the most frequent rec title from the prior week
  const priorRecs = db.prepare(`
    SELECT recommendations_json FROM analyses a
    WHERE a.analyzed_at >= ? AND a.analyzed_at < ?
  `).all(priorSince, recentSince)

  const counts = {}
  for (const r of priorRecs) {
    for (const rec of JSON.parse(r.recommendations_json)) {
      counts[rec.title] = (counts[rec.title] || 0) + 1
    }
  }
  const topRec = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]

  return {
    state: 'measured',
    topRecLastWeek: topRec ? topRec[0] : null,
    priorScore: prior,
    recentScore: recent,
    delta: Math.round((recent - prior) * 10) / 10,
    direction: recent > prior ? 'improving' : recent < prior ? 'declining' : 'stable',
  }
}

function computeAgentStatusStrip() {
  // For each agent: list which KPIs are passing vs failing based on most recent
  // 10 calls' averaged scores against the agent's thresholds.
  const agents = db.prepare('SELECT id, name FROM agents').all()

  return agents.map((agent) => {
    const defs = db.prepare(
      'SELECT name, label, threshold FROM kpi_definitions WHERE agent_id = ?'
    ).all(agent.id)

    const recentScores = db.prepare(`
      SELECT a.kpi_scores_json FROM analyses a
      JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ?
      ORDER BY a.analyzed_at DESC LIMIT 10
    `).all(agent.id)

    if (recentScores.length === 0) {
      return {
        agentId: agent.id,
        agentName: agent.name,
        callCount: 0,
        kpis: defs.map((d) => ({ ...d, status: 'no_data', score: null })),
      }
    }

    const totals = {}
    for (const s of recentScores) {
      const parsed = JSON.parse(s.kpi_scores_json)
      for (const [key, val] of Object.entries(parsed)) {
        if (!totals[key]) totals[key] = { sum: 0, count: 0 }
        totals[key].sum += val
        totals[key].count++
      }
    }

    return {
      agentId: agent.id,
      agentName: agent.name,
      callCount: recentScores.length,
      kpis: defs.map((d) => {
        const avg = totals[d.name] ? Math.round(totals[d.name].sum / totals[d.name].count) : null
        return {
          name: d.name,
          label: d.label,
          threshold: d.threshold,
          score: avg,
          status: avg === null ? 'no_data' : avg >= d.threshold ? 'pass' : avg >= d.threshold - 15 ? 'warning' : 'fail',
        }
      }),
    }
  })
}

function computeKpiPerformance(sinceISO) {
  // Aggregate avg KPI scores across all analyses in window — feeds the radar
  const rows = db.prepare(`
    SELECT a.kpi_scores_json FROM analyses a WHERE a.analyzed_at >= ?
  `).all(sinceISO)

  if (rows.length === 0) return {}

  const totals = {}
  for (const r of rows) {
    for (const [k, v] of Object.entries(JSON.parse(r.kpi_scores_json))) {
      if (!totals[k]) totals[k] = { sum: 0, count: 0 }
      totals[k].sum += v
      totals[k].count++
    }
  }

  const result = {}
  for (const [k, t] of Object.entries(totals)) {
    result[k] = Math.round(t.sum / t.count)
  }
  return result
}

// Replaces 6 queries per agent with 5 total queries for the whole agency.
// At 100 agents this drops a /summary call from ~600 SQL statements to ~5.
function buildBulkAgentData(agents) {
  if (agents.length === 0) return { byAgent: new Map() }

  const ids = agents.map((a) => a.id)
  const placeholders = ids.map(() => '?').join(',')

  // Last 30 analyses per agent (each row already has agent_id + overall_score)
  const analysisRows = db.prepare(`
    SELECT
      c.agent_id,
      a.overall_score,
      a.status,
      a.kpi_scores_json,
      a.recommendations_json,
      a.analyzed_at,
      ROW_NUMBER() OVER (PARTITION BY c.agent_id ORDER BY a.analyzed_at DESC) as rn
    FROM analyses a
    JOIN calls c ON c.id = a.call_id
    WHERE c.agent_id IN (${placeholders})
  `).all(...ids)

  // Total/last call per agent
  const callStatsRows = db.prepare(`
    SELECT agent_id, COUNT(*) as total, MAX(call_timestamp) as lastCallAt
    FROM calls
    WHERE agent_id IN (${placeholders})
    GROUP BY agent_id
  `).all(...ids)

  const kpiDefRows = db.prepare(`
    SELECT agent_id, name, label, threshold
    FROM kpi_definitions
    WHERE agent_id IN (${placeholders})
  `).all(...ids)

  // Bucket by agent_id
  const byAgent = new Map(agents.map((a) => [a.id, {
    last30: [], last10Kpis: [], statusLast30: [],
    callStats: { total: 0, lastCallAt: null }, kpiDefs: [], topRecommendations: [],
  }]))

  for (const r of analysisRows) {
    const bucket = byAgent.get(r.agent_id)
    if (!bucket) continue
    if (r.rn <= 30) {
      bucket.last30.push(r.overall_score)
      bucket.statusLast30.push(r.status)
    }
    if (r.rn <= 10) bucket.last10Kpis.push(JSON.parse(r.kpi_scores_json))
    if (r.rn === 1 && (r.status === 'fail' || r.status === 'warning')) {
      try {
        bucket.topRecommendations.push(JSON.parse(r.recommendations_json)[0]?.title)
      } catch { /* ignore parse failures */ }
    }
  }

  for (const r of callStatsRows) {
    const b = byAgent.get(r.agent_id)
    if (b) b.callStats = { total: r.total, lastCallAt: r.lastCallAt }
  }

  for (const r of kpiDefRows) {
    const b = byAgent.get(r.agent_id)
    if (b) b.kpiDefs.push({ name: r.name, label: r.label, threshold: r.threshold })
  }

  return { byAgent }
}

function buildAgentSummary(agent, bulk) {
  const b = bulk.byAgent.get(agent.id) || {
    last30: [], last10Kpis: [], statusLast30: [], callStats: { total: 0, lastCallAt: null },
    kpiDefs: [], topRecommendations: [],
  }
  const scoreRows = b.last30.map((s) => ({ overall_score: s }))

  const healthScore = scoreRows.length
    ? Math.round(scoreRows.reduce((s, r) => s + r.overall_score, 0) / scoreRows.length)
    : 0

  const recent = scoreRows.slice(0, 7)
  const previous = scoreRows.slice(7, 14)
  const recentAvg = recent.length ? recent.reduce((s, r) => s + r.overall_score, 0) / recent.length : 0
  const prevAvg = previous.length ? previous.reduce((s, r) => s + r.overall_score, 0) / previous.length : 0
  const trend = prevAvg === 0 ? 'stable' : recentAvg > prevAvg + 3 ? 'up' : recentAvg < prevAvg - 3 ? 'down' : 'stable'

  const callStats = b.callStats || { total: 0, lastCallAt: null }
  const kpiRows = b.last10Kpis.map((k) => ({ kpi_scores_json: JSON.stringify(k) }))
  const kpiSummary = kpiRows.length ? averageKpis(kpiRows) : {}
  const topIssue = b.topRecommendations[0] ?? null
  const statusDistribution = b.statusLast30.reduce(
    (acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc },
    { pass: 0, warning: 0, fail: 0 }
  )

  const kpiDefs = b.kpiDefs
  let worstKpi = null
  let worstGap = 0
  for (const def of kpiDefs) {
    const score = kpiSummary[def.name]
    if (score === undefined) continue
    const gap = score - def.threshold
    if (gap < worstGap) {
      worstGap = gap
      worstKpi = { name: def.name, label: def.label, score, threshold: def.threshold, gap }
    }
  }

  const sparkline = scoreRows.slice(0, 14).map((r) => r.overall_score).reverse()

  return {
    id: agent.id,
    name: agent.name,
    healthScore,
    trend,
    totalCalls: callStats.total,
    analyzedCalls: scoreRows.length,
    lastCallAt: callStats.lastCallAt,
    topIssue,
    kpiSummary,
    statusDistribution,
    worstKpi,
    sparkline,
  }
}

function averageKpis(rows) {
  const totals = {}
  const counts = {}
  for (const row of rows) {
    const kpis = JSON.parse(row.kpi_scores_json)
    for (const [key, val] of Object.entries(kpis)) {
      totals[key] = (totals[key] || 0) + val
      counts[key] = (counts[key] || 0) + 1
    }
  }
  const result = {}
  for (const key of Object.keys(totals)) {
    result[key] = Math.round(totals[key] / counts[key])
  }
  return result
}

module.exports = router
