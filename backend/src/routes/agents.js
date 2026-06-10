const express = require('express')
const db = require('../db/database')
const httpError = require('../utils/httpError')
const AnalysisService = require('../services/AnalysisService')
const RecommendationService = require('../services/RecommendationService')
const NarrativeService = require('../services/NarrativeService')
const logger = require('../logger')

const router = express.Router()
const analysisService = new AnalysisService()

// GET /api/agents
router.get('/', (_req, res, next) => {
  try {
    const agents = db.prepare('SELECT id, name, goal, created_at FROM agents ORDER BY name').all()

    const result = agents.map((agent) => {
      const scoreRows = db.prepare(`
        SELECT a.overall_score FROM analyses a
        JOIN calls c ON c.id = a.call_id
        WHERE c.agent_id = ? ORDER BY a.analyzed_at DESC LIMIT 30
      `).all(agent.id)

      const healthScore = scoreRows.length
        ? Math.round(scoreRows.reduce((s, r) => s + r.overall_score, 0) / scoreRows.length)
        : 0

      const totalCalls = db.prepare('SELECT COUNT(*) as n FROM calls WHERE agent_id = ?').get(agent.id).n

      return { ...agent, healthScore, totalCalls }
    })

    res.json({ agents: result })
  } catch (err) {
    next(err)
  }
})

// GET /api/agents/:id?days=30
// V5.5 — extended response now includes per-agent aggregates aligned with FSB
// Core Functionality (Use Actions, deviations, missed opportunities, recently
// applied + measurement proof).
router.get('/:id', (req, res, next) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id)
    if (!agent) return next(httpError('AGENT_NOT_FOUND', `Agent ${req.params.id} not found`, 404))

    // Window for the aggregates below. Falls back to 30d if not given.
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30))
    const sinceISO = new Date(Date.now() - days * 86400e3).toISOString()
    const priorSinceISO = new Date(Date.now() - 2 * days * 86400e3).toISOString()

    const kpiDefinitions = db
      .prepare('SELECT id, name, label, weight, threshold, description FROM kpi_definitions WHERE agent_id = ? ORDER BY weight DESC')
      .all(agent.id)

    // Health score + trend
    const scoreRows = db.prepare(`
      SELECT a.overall_score FROM analyses a
      JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ? ORDER BY a.analyzed_at DESC LIMIT 30
    `).all(agent.id)

    const healthScore = scoreRows.length
      ? Math.round(scoreRows.reduce((s, r) => s + r.overall_score, 0) / scoreRows.length)
      : 0

    const recent = scoreRows.slice(0, 7)
    const previous = scoreRows.slice(7, 14)
    const recentAvg = recent.length ? recent.reduce((s, r) => s + r.overall_score, 0) / recent.length : 0
    const prevAvg = previous.length ? previous.reduce((s, r) => s + r.overall_score, 0) / previous.length : 0
    const trend = prevAvg === 0 ? 'stable' : recentAvg > prevAvg + 3 ? 'up' : recentAvg < prevAvg - 3 ? 'down' : 'stable'

    // last7Days sparkline (last 7 individual call scores)
    const last7Days = scoreRows.slice(0, 7).map((r) => r.overall_score).reverse()

    // Average KPI scores across last 10 analyses
    const kpiRows = db.prepare(`
      SELECT a.kpi_scores_json FROM analyses a
      JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ? ORDER BY a.analyzed_at DESC LIMIT 10
    `).all(agent.id)

    const kpiScores = kpiRows.length ? averageKpis(kpiRows) : {}

    // Status distribution
    const statusRows = db.prepare(`
      SELECT a.status FROM analyses a
      JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ?
      ORDER BY a.analyzed_at DESC LIMIT 30
    `).all(agent.id)

    const statusDistribution = statusRows.reduce(
      (acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc },
      { pass: 0, warning: 0, fail: 0 }
    )

    // Worst KPI: lowest score relative to its threshold
    let worstKpi = null
    let worstGap = 0
    for (const def of kpiDefinitions) {
      const score = kpiScores[def.name]
      if (score === undefined) continue
      const gap = score - def.threshold
      if (gap < worstGap) {
        worstGap = gap
        worstKpi = { name: def.name, label: def.label, score, threshold: def.threshold, gap }
      }
    }

    // ─── V5.5 — Quick stats (FSB "intuitive dashboard" alignment) ────────
    const totalCallsInWindow = db.prepare(
      'SELECT COUNT(*) as n FROM calls WHERE agent_id = ? AND call_timestamp >= ?'
    ).get(agent.id, sinceISO).n
    const prevTotalCallsInWindow = db.prepare(
      'SELECT COUNT(*) as n FROM calls WHERE agent_id = ? AND call_timestamp >= ? AND call_timestamp < ?'
    ).get(agent.id, priorSinceISO, sinceISO).n
    const POSITIVE_OUTCOMES = new Set([
      'booked','completed_booked','meeting_booked','appointment_booked','consultation_booked',
      'trial_started','sale','sold','closed_won','qualified','lead_qualified',
    ])
    const outcomeRows = db.prepare(
      'SELECT outcome FROM calls WHERE agent_id = ? AND call_timestamp >= ?'
    ).all(agent.id, sinceISO)
    const conversionCount = outcomeRows.reduce((s, r) => s + (POSITIVE_OUTCOMES.has(r.outcome) ? 1 : 0), 0)
    const conversionRate = outcomeRows.length > 0
      ? Math.round((conversionCount / outcomeRows.length) * 1000) / 10 : 0
    const passRateRow = db.prepare(`
      SELECT
        SUM(CASE WHEN a.status = 'pass' THEN 1 ELSE 0 END) as good,
        COUNT(*) as total
      FROM analyses a JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ? AND a.analyzed_at >= ?
    `).get(agent.id, sinceISO)
    const kpiPassRate = passRateRow.total > 0
      ? Math.round((passRateRow.good / passRateRow.total) * 1000) / 10 : 0
    const cycleRow = db.prepare(`
      SELECT AVG(julianday(applied_at) - julianday(first_seen_at)) as avgDays
      FROM recommendations
      WHERE agent_id = ? AND applied_at IS NOT NULL AND first_seen_at IS NOT NULL
    `).get(agent.id)
    const avgCycleDays = cycleRow.avgDays !== null
      ? Math.round(cycleRow.avgDays * 10) / 10 : null
    const hallucinationCalls = db.prepare(`
      SELECT COUNT(*) as n FROM analyses a JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ? AND a.analyzed_at >= ? AND a.hallucinations_json != '[]'
    `).get(agent.id, sinceISO).n
    const quickStats = {
      totalCalls: totalCallsInWindow,
      totalCallsDelta: totalCallsInWindow - prevTotalCallsInWindow,
      conversionRate,
      conversionCount,
      kpiPassRate,
      passCount: passRateRow.good,
      avgCycleDays,
      hallucinationCalls,
    }

    // ─── V5.5 — Use Actions breakdown (FSB "Highlight Use Actions") ──────
    // Counts action types from analyses.use_actions_json overlaid with status
    // from use_action_statuses. Powers the new per-agent Use Actions widget.
    const usePayloads = db.prepare(`
      SELECT a.call_id, a.use_actions_json
      FROM analyses a JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ? AND a.analyzed_at >= ? AND a.use_actions_json != '[]'
    `).all(agent.id, sinceISO)
    const useActionTypes = {}
    for (const p of usePayloads) {
      try {
        const list = JSON.parse(p.use_actions_json)
        for (const ua of list) {
          const type = ua.actionType || 'other'
          if (!useActionTypes[type]) {
            useActionTypes[type] = { actionType: type, total: 0, pending: 0, escalated: 0, resolved: 0, dismissed: 0 }
          }
          useActionTypes[type].total++
          const status = db.prepare(
            'SELECT status FROM use_action_statuses WHERE call_id = ? AND turn_index = ? AND action_type = ?'
          ).get(p.call_id, ua.turnIndex, type)
          const s = status?.status || 'pending'
          useActionTypes[type][s] = (useActionTypes[type][s] || 0) + 1
        }
      } catch { /* skip parse failures */ }
    }
    const useActionsBreakdown = Object.values(useActionTypes)
      .sort((a, b) => b.total - a.total)

    // ─── V5.5 — Deviations + Missed Opportunities aggregate (FSB "Identify
    // deviations, failures, missed opportunities") ──────
    function aggregateJsonField(field, limit = 5) {
      const rows = db.prepare(`
        SELECT a.${field} FROM analyses a JOIN calls c ON c.id = a.call_id
        WHERE c.agent_id = ? AND a.analyzed_at >= ? AND a.${field} != '[]'
      `).all(agent.id, sinceISO)
      const byDesc = {}
      for (const r of rows) {
        try {
          for (const item of JSON.parse(r[field])) {
            const desc = (item.description || item.pattern || JSON.stringify(item)).slice(0, 100)
            byDesc[desc] = byDesc[desc] || { description: desc, callCount: 0 }
            byDesc[desc].callCount++
          }
        } catch { /* ignore */ }
      }
      return Object.values(byDesc).sort((a, b) => b.callCount - a.callCount).slice(0, limit)
    }
    const deviationsAggregate = aggregateJsonField('deviations_json')
    const missedOpportunitiesAggregate = aggregateJsonField('missed_opportunities_json')

    // ─── V5.5 — Recently applied with measurement proof (FSB "Validation
    // Flywheel"). Shows the closed loop for THIS agent. ──────
    const recentlyAppliedRows = db.prepare(`
      SELECT id, title, severity, applied_at, before_avg_score, after_avg_score,
             before_sample_size, after_sample_size, outcome_computed_at
      FROM recommendations
      WHERE agent_id = ? AND status = 'applied' AND applied_at IS NOT NULL
      ORDER BY applied_at DESC LIMIT 5
    `).all(agent.id)
    const recentlyApplied = recentlyAppliedRows.map((r) => {
      const delta = r.after_avg_score !== null && r.before_avg_score !== null
        ? Math.round((r.after_avg_score - r.before_avg_score) * 10) / 10 : null
      const status = r.outcome_computed_at
        ? (delta >= 2 && r.after_sample_size >= 3 ? 'measured_significant'
           : delta > 0 ? 'measured_minor' : 'measured_regression')
        : 'waiting'
      return {
        id: r.id, title: r.title, severity: r.severity,
        appliedAt: r.applied_at,
        beforeAvg: r.before_avg_score,
        afterAvg: r.after_avg_score,
        afterSampleSize: r.after_sample_size,
        delta,
        status,
      }
    })

    // V5.6 — per-agent Caller Mood Trend + spike, reusing SentimentService
    // helpers that already power the Overview agency-wide widget.
    const { computeSentimentTrend, computeSentimentSpike } = require('../services/SentimentService')
    const sentimentTrend = computeSentimentTrend(sinceISO, days, agent.id)
    const sentimentSpike = computeSentimentSpike(sentimentTrend, agent.id)

    res.json({
      id: agent.id,
      name: agent.name,
      goal: agent.goal,
      script: agent.script,
      kpiDefinitions,
      performance: { healthScore, trend, last7Days, kpiScores, statusDistribution, worstKpi },
      // V5.5 — new aggregates for the redesigned Agent Detail page
      window: { days, sinceISO },
      quickStats,
      useActionsBreakdown,
      deviationsAggregate,
      missedOpportunitiesAggregate,
      recentlyApplied,
      // V5.6 — per-agent Caller Mood Trend (reuses SentimentTrend.vue component)
      sentimentTrend,
      sentimentSpike,
      sentimentBucketThresholds: { positive: 60, negative: 30 },
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/agents/:id/calls?page=1&limit=20&status=all&flag=&sort=newest&search=
//
// V5.9 — calls list redesign.
//
// New behaviour:
//   • status: pass | warning | fail | all   (existing — scorecard outcome)
//   • flag:   unverified | use_actions       (overlay — separate signals from status)
//   • sort:   newest | oldest | score_asc | score_desc | duration_asc | duration_desc
//   • search: free-text against caller_number + recommendation titles
//   • each row now returns hasHallucination, unverifiedClaimsCount,
//     topHallucinationQuote, useActionsCount — so the UI can render the
//     3-layer hallucination treatment without a second roundtrip.
//
// Existing fix: the previous response did NOT include hallucination info,
// so the inline `⚠ hallucination` badge in AgentDetailView never rendered.
// We now expose hasHallucination + the count + the most concerning claim.
router.get('/:id/calls', (req, res, next) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id)
    if (!agent) return next(httpError('AGENT_NOT_FOUND', `Agent ${req.params.id} not found`, 404))

    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20))
    const status = ['pass', 'warning', 'fail', 'all'].includes(req.query.status) ? req.query.status : 'all'
    const flag = ['unverified', 'use_actions'].includes(req.query.flag) ? req.query.flag : null
    const sort = ['newest', 'oldest', 'score_asc', 'score_desc', 'duration_asc', 'duration_desc']
      .includes(req.query.sort) ? req.query.sort : 'newest'
    const search = (req.query.search || '').trim().slice(0, 80)
    const offset = (page - 1) * limit

    // WHERE clauses built defensively. Status uses parameter binding to be
    // safe against future expansion; same for search.
    const clauses = ['c.agent_id = ?']
    const params = [req.params.id]
    if (status !== 'all')           { clauses.push('a.status = ?');                params.push(status) }
    if (flag === 'unverified')      { clauses.push("a.hallucinations_json != '[]' AND a.hallucinations_json IS NOT NULL") }
    if (flag === 'use_actions')     { clauses.push("a.use_actions_json != '[]' AND a.use_actions_json IS NOT NULL") }
    if (search) {
      // matches caller number or anything inside the recommendations_json
      // (cheap LIKE — the top-issue title lives in there, so this gives users
      // a "find by issue text" without a dedicated index)
      clauses.push('(c.caller_number LIKE ? OR a.recommendations_json LIKE ?)')
      const needle = `%${search}%`
      params.push(needle, needle)
    }
    const whereSql = clauses.join(' AND ')

    const orderBy = {
      newest:        'c.call_timestamp DESC',
      oldest:        'c.call_timestamp ASC',
      score_asc:     'a.overall_score ASC NULLS LAST, c.call_timestamp DESC',
      score_desc:    'a.overall_score DESC NULLS LAST, c.call_timestamp DESC',
      duration_asc:  'c.duration ASC, c.call_timestamp DESC',
      duration_desc: 'c.duration DESC, c.call_timestamp DESC',
    }[sort]

    const total = db.prepare(`
      SELECT COUNT(*) as n FROM calls c
      LEFT JOIN analyses a ON a.call_id = c.id
      WHERE ${whereSql}
    `).get(...params).n

    const calls = db.prepare(`
      SELECT
        c.id, c.agent_id, c.caller_number, c.duration, c.outcome,
        c.analysis_status, c.call_timestamp,
        a.overall_score, a.status,
        a.recommendations_json, a.hallucinations_json, a.use_actions_json
      FROM calls c
      LEFT JOIN analyses a ON a.call_id = c.id
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset)

    const result = calls.map((c) => {
      let topIssue = null
      if (c.recommendations_json) {
        try { topIssue = JSON.parse(c.recommendations_json)[0]?.title ?? null } catch { /* ignore */ }
      }

      // Parse hallucinations / use_actions once and derive the small summary
      // the UI needs. Highest-confidence claim becomes the hover-tooltip text.
      //
      // Hallucination JSON shape (per analyses.hallucinations_json):
      //   { turnIndex, type, claim, confidence: 'low'|'medium'|'high', impact }
      // Older mock records may instead carry `quote`/`statement` keys, so we
      // fall back through all three for resilience.
      const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 }
      let unverifiedClaimsCount = 0
      let topHallucinationQuote = null
      if (c.hallucinations_json && c.hallucinations_json !== '[]') {
        try {
          const list = JSON.parse(c.hallucinations_json) || []
          unverifiedClaimsCount = list.length
          if (list.length > 0) {
            const ranked = [...list].sort(
              (a, b) => (CONFIDENCE_RANK[b.confidence] || 0) - (CONFIDENCE_RANK[a.confidence] || 0)
            )
            const top = ranked[0]
            topHallucinationQuote = top?.claim || top?.quote || top?.statement || null
          }
        } catch { /* ignore parse failure */ }
      }

      let useActionsCount = 0
      if (c.use_actions_json && c.use_actions_json !== '[]') {
        try { useActionsCount = (JSON.parse(c.use_actions_json) || []).length } catch { /* ignore */ }
      }

      /* eslint-disable no-unused-vars */
      const { recommendations_json: _rj, hallucinations_json: _hj, use_actions_json: _ua, ...rest } = c
      /* eslint-enable no-unused-vars */
      return {
        ...rest,
        topIssue,
        hasHallucination: unverifiedClaimsCount > 0,
        unverifiedClaimsCount,
        topHallucinationQuote,
        useActionsCount,
      }
    })

    res.json({ total, page, limit, sort, status, flag, search, calls: result })
  } catch (err) {
    next(err)
  }
})

// GET /api/agents/:id/insights[?refresh=true]
// Cross-call AI analysis — generated on demand, cached in agent_insights table.
// Pass ?refresh=true to bypass cache and force a fresh OpenAI generation
// (used by the [↻ Re-analyse] button in Agent Detail).
router.get('/:id/insights', async (req, res, next) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id)
    if (!agent) return next(httpError('AGENT_NOT_FOUND', `Agent ${req.params.id} not found`, 404))

    const forceRefresh = req.query.refresh === 'true' || req.query.refresh === '1'

    // Cache lookup — skipped when ?refresh=true
    if (!forceRefresh) {
      const cached = db.prepare(`
        SELECT summary, patterns_json, use_action_summary_json, generated_at, call_count
        FROM agent_insights WHERE agent_id = ?
        ORDER BY generated_at DESC LIMIT 1
      `).get(agent.id)
      if (cached) {
        logger.info({ agentId: agent.id }, 'insights: returning cached result')
        return res.json({
          agentId: agent.id,
          generatedAt: cached.generated_at,
          callCount: cached.call_count,
          summary: cached.summary,
          patternedIssues: JSON.parse(cached.patterns_json),
          useActionSummary: JSON.parse(cached.use_action_summary_json),
          cached: true,
        })
      }
    }

    // No cache (or refresh requested) — generate now (OpenAI call)
    logger.info({ agentId: agent.id, forceRefresh }, 'insights: generating')
    const result = await analysisService.analyzeAgentInsights(agent)

    if (!result) {
      return res.json({
        agentId: agent.id,
        message: 'No analysed calls yet — run analysis first',
        patternedIssues: [],
        useActionSummary: {},
        cached: false,
      })
    }

    res.json({
      agentId: agent.id,
      generatedAt: new Date().toISOString(),
      callCount: result.callCount || 0,
      summary: result.summary,
      patternedIssues: result.patterns || [],
      useActionSummary: result.useActionSummary || {},
      cached: false,
    })
  } catch (err) {
    next(err)
  }
})

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

// GET /api/agents/:id/flywheel
// Per-agent breakdown of the 5-stage Validation Flywheel.
// Each stage returns metrics specific to this agent so users can see exactly
// where the loop is or isn't turning for one agent.
router.get('/:id/flywheel', (req, res, next) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id)
    if (!agent) return next(httpError('AGENT_NOT_FOUND', `Agent ${req.params.id} not found`, 404))

    // ── Stage 1: INGEST ────────────────────────────────────────────────
    const ingest = db.prepare(`
      SELECT
        COUNT(*) as totalCalls,
        SUM(CASE WHEN analysis_status = 'completed' THEN 1 ELSE 0 END) as analysed,
        SUM(CASE WHEN analysis_status = 'pending'   THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN analysis_status = 'failed'    THEN 1 ELSE 0 END) as failed,
        MAX(call_timestamp) as lastCallAt,
        MIN(call_timestamp) as firstCallAt
      FROM calls WHERE agent_id = ?
    `).get(agent.id)

    // ── Stage 2: SCORE ────────────────────────────────────────────────
    const score = db.prepare(`
      SELECT
        COUNT(*) as totalScored,
        ROUND(AVG(overall_score)) as avgScore,
        MIN(overall_score) as minScore,
        MAX(overall_score) as maxScore,
        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passCount,
        SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) as warningCount,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as failCount
      FROM analyses a JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ?
    `).get(agent.id)

    // ── Stage 3: RECOMMEND ────────────────────────────────────────────
    const recCounts = db.prepare(`
      SELECT status, COUNT(*) as n FROM recommendations
      WHERE agent_id = ? GROUP BY status
    `).all(agent.id)
    const recStatusMap = { active: 0, applied: 0, dismissed: 0 }
    recCounts.forEach((r) => { recStatusMap[r.status] = r.n })

    const topActiveRecs = db.prepare(`
      SELECT id, title, severity, type, suggested_change, occurrence_count, first_seen_at
      FROM recommendations
      WHERE agent_id = ? AND status = 'active'
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        occurrence_count DESC
      LIMIT 5
    `).all(agent.id)

    // ── Stage 4: APPLY ────────────────────────────────────────────────
    const promptVersions = db.prepare(`
      SELECT id, prompt_hash, first_seen_at, last_seen_at, call_count,
             SUBSTR(prompt_text, 1, 240) as preview, LENGTH(prompt_text) as fullLength
      FROM agent_prompt_versions
      WHERE agent_id = ? ORDER BY first_seen_at DESC
    `).all(agent.id)

    const appliedRecs = db.prepare(`
      SELECT r.id, r.title, r.severity, r.applied_at,
             apv.prompt_hash as appliedToHash
      FROM recommendations r
      LEFT JOIN agent_prompt_versions apv ON apv.id = r.applied_prompt_version_id
      WHERE r.agent_id = ? AND r.status = 'applied' AND r.outcome_computed_at IS NULL
      ORDER BY r.applied_at DESC
    `).all(agent.id)

    // ── Stage 5: MEASURE ─────────────────────────────────────────────
    const lifecycle = RecommendationService.getLifecycleSummary(agent.id)
    const measured = lifecycle.measured

    res.json({
      agentId: agent.id,
      agentName: agent.name,
      agentGoal: agent.goal,
      currentPromptLength: (agent.script || '').length,
      stages: {
        ingest: {
          label: 'Ingest',
          totalCalls: ingest.totalCalls || 0,
          analysed: ingest.analysed || 0,
          pending: ingest.pending || 0,
          failed: ingest.failed || 0,
          firstCallAt: ingest.firstCallAt,
          lastCallAt: ingest.lastCallAt,
          source: 'HL API: /voice-ai/dashboard/call-logs',
        },
        score: {
          label: 'Score',
          totalScored: score.totalScored || 0,
          avgScore: score.avgScore || 0,
          minScore: score.minScore,
          maxScore: score.maxScore,
          passCount: score.passCount || 0,
          warningCount: score.warningCount || 0,
          failCount: score.failCount || 0,
          scoringMethod: 'OpenAI gpt-4o-mini · json_schema · 6 KPIs weighted',
        },
        recommend: {
          label: 'Recommend',
          active: recStatusMap.active,
          applied: recStatusMap.applied,
          dismissed: recStatusMap.dismissed,
          total: recStatusMap.active + recStatusMap.applied + recStatusMap.dismissed,
          topActive: topActiveRecs.map((r) => ({
            id: r.id,
            title: r.title,
            severity: r.severity,
            type: r.type,
            suggestedChange: r.suggested_change,
            occurrenceCount: r.occurrence_count,
          })),
        },
        apply: {
          label: 'Apply',
          promptVersionCount: promptVersions.length,
          currentVersion: promptVersions[0] || null,
          history: promptVersions.slice(0, 5),
          appliedRecs,
          detectionMethod: 'SHA-256 hash of prompt+goal — change detected on next Sync All',
        },
        measure: {
          label: 'Measure',
          totalMeasured: lifecycle.totalMeasured,
          improvedCount: lifecycle.improvedCount,
          regressedCount: lifecycle.regressedCount,
          flatCount: lifecycle.flatCount,
          successRate: lifecycle.successRate,
          outcomes: measured.slice(0, 5).map((m) => ({
            id: m.id,
            title: m.title,
            severity: m.severity,
            appliedAt: m.applied_at,
            before: m.before_avg_score,
            after: m.after_avg_score,
            beforeN: m.before_sample_size,
            afterN: m.after_sample_size,
            delta: Math.round(m.delta * 10) / 10,
          })),
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

// PUT /api/agents/:id/kpis
// Update weight and/or threshold on this agent's KPI definitions.
// Body: { kpis: [{ id, weight, threshold }] }
// Validation: weights across ALL of this agent's KPIs must sum to 1.0 ±0.01
router.put('/:id/kpis', (req, res, next) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id)
    if (!agent) return next(httpError('AGENT_NOT_FOUND', `Agent ${req.params.id} not found`, 404))

    const updates = Array.isArray(req.body?.kpis) ? req.body.kpis : null
    if (!updates || updates.length === 0) {
      return next(httpError('INVALID_BODY', 'kpis array required', 400))
    }

    const existing = db.prepare('SELECT id, weight, threshold FROM kpi_definitions WHERE agent_id = ?').all(agent.id)
    if (existing.length === 0) {
      return next(httpError('NO_KPIS', 'This agent has no KPI definitions to update', 400))
    }
    const existingMap = Object.fromEntries(existing.map((k) => [k.id, k]))

    // Build the post-update set so we can validate the weight sum BEFORE writing
    const postUpdate = existing.map((k) => {
      const u = updates.find((x) => x.id === k.id)
      return {
        id:        k.id,
        weight:    u && Number.isFinite(u.weight)    ? Number(u.weight)    : k.weight,
        threshold: u && Number.isInteger(u.threshold) ? u.threshold        : k.threshold,
      }
    })

    for (const k of postUpdate) {
      if (k.weight < 0 || k.weight > 1) {
        return next(httpError('INVALID_WEIGHT', `weight for ${k.id} must be in [0, 1]`, 400))
      }
      if (k.threshold < 0 || k.threshold > 100) {
        return next(httpError('INVALID_THRESHOLD', `threshold for ${k.id} must be in [0, 100]`, 400))
      }
    }

    const sum = postUpdate.reduce((s, k) => s + k.weight, 0)
    if (Math.abs(sum - 1.0) > 0.01) {
      return next(httpError('INVALID_WEIGHT_SUM', `weights must sum to 1.0 — got ${sum.toFixed(3)}`, 400))
    }

    const stmt = db.prepare('UPDATE kpi_definitions SET weight = ?, threshold = ? WHERE id = ? AND agent_id = ?')
    db.exec('BEGIN')
    try {
      for (const k of postUpdate) {
        if (existingMap[k.id].weight !== k.weight || existingMap[k.id].threshold !== k.threshold) {
          stmt.run(k.weight, k.threshold, k.id, agent.id)
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }

    const refreshed = db
      .prepare('SELECT id, name, label, weight, threshold, description FROM kpi_definitions WHERE agent_id = ? ORDER BY weight DESC')
      .all(agent.id)

    logger.info({ agentId: agent.id, count: postUpdate.length }, 'kpis: updated')
    res.json({ agentId: agent.id, kpiDefinitions: refreshed })
  } catch (err) {
    next(err)
  }
})

// GET /api/agents/:id/flywheel/narrative?days=30
// Per-agent flywheel in the narrative shape (what/why/evidence/action per stage).
// Powers the horizontal 5-card panel on Agent Detail.
router.get('/:id/flywheel/narrative', (req, res, next) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id)
    if (!agent) return next(httpError('AGENT_NOT_FOUND', `Agent ${req.params.id} not found`, 404))

    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30))
    const narratives = NarrativeService.buildForAgent(agent.id, { days })
    res.json({ agentId: agent.id, window: { days }, narratives })
  } catch (err) {
    next(err)
  }
})

module.exports = router
