const express = require('express')
const db = require('../db/database')
const NarrativeService = require('../services/NarrativeService')
const RecommendationService = require('../services/RecommendationService')

const router = express.Router()

// GET /api/flywheel/summary?days=30&mode=window|all-time
// Powers the /flywheel page hero — funnel + stage cards + impact + health summary.
//
// Windowing rules (post-V4.3 PM-reviewed refactor):
//   - mode=window (default): every funnel count + impact metric is scoped to
//     analyzed_at / first_seen_at / applied_at / outcome_computed_at within
//     the selected days. This is the honest user-expectation view when they
//     pick "Last 7 days" in the filter.
//   - mode=all-time: counts are cumulative since the start of the project,
//     for users who want "what has the loop produced overall?"
//
// Improvement thresholds:
//   - improvedAny:         after_avg_score > before_avg_score (any delta)
//   - improvedSignificant: delta >= 2 pts AND after_sample_size >= 3
//     (the second number is the one we trust for the closure rate)
router.get('/summary', (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30))
    const mode = req.query.mode === 'all-time' ? 'all-time' : 'window'
    const sinceISO = new Date(Date.now() - days * 86400e3).toISOString()
    const W = mode === 'window'

    // Reusable WHERE-clause + bindings for "since the window opened" or "always".
    // Each call counts a different timestamp column; we still need consistency
    // within the chosen mode.
    const win = (col) => W ? `${col} >= ?` : `1=1`
    const winArgs = W ? [sinceISO] : []

    // ── FUNNEL — every stage now uses the same windowing rule
    const issuesDetected = db.prepare(
      `SELECT COUNT(*) as n FROM analyses WHERE ${win('analyzed_at')} AND status != 'pass'`
    ).get(...winArgs).n

    const recsGenerated = db.prepare(
      `SELECT COUNT(*) as n FROM recommendations WHERE ${win('first_seen_at')}`
    ).get(...winArgs).n

    const recsApplied = db.prepare(
      `SELECT COUNT(*) as n FROM recommendations WHERE status = 'applied' AND ${win('applied_at')}`
    ).get(...winArgs).n

    const outcomesMeasured = db.prepare(
      `SELECT COUNT(*) as n FROM recommendations WHERE outcome_computed_at IS NOT NULL AND ${win('outcome_computed_at')}`
    ).get(...winArgs).n

    const improvedAny = db.prepare(`
      SELECT COUNT(*) as n FROM recommendations
      WHERE outcome_computed_at IS NOT NULL AND after_avg_score > before_avg_score
      AND ${win('outcome_computed_at')}
    `).get(...winArgs).n

    // The "we trust this" definition — delta ≥ 2 pts AND n ≥ 3 calls under new prompt.
    // Filters out noise from tiny samples and trivial deltas.
    const improvedSignificant = db.prepare(`
      SELECT COUNT(*) as n FROM recommendations
      WHERE outcome_computed_at IS NOT NULL
        AND (after_avg_score - before_avg_score) >= 2
        AND after_sample_size >= 3
        AND ${win('outcome_computed_at')}
    `).get(...winArgs).n

    // ── Root Causes — side stat, NOT a funnel row (different unit-of-count)
    const rootCauseRows = db.prepare(
      `SELECT root_causes_json FROM analyses WHERE ${win('analyzed_at')} AND status != 'pass'`
    ).all(...winArgs)
    const rootCauseSet = new Set()
    for (const r of rootCauseRows) {
      try {
        JSON.parse(r.root_causes_json || '[]').forEach((c) => rootCauseSet.add(c.toLowerCase().trim().slice(0, 80)))
      } catch { /* ignore parse failures */ }
    }
    const rootCausesIdentified = rootCauseSet.size

    // Funnel structure — calls vs recommendations are different units of count
    // (one failed call → multiple recs). So Issues Detected anchors the funnel
    // as context but doesn't have a conversion% TO Recommendations Generated.
    // From Generated onward, every transition IS a true subset (rec → applied →
    // measured → improved), so % conversion is meaningful.
    const yieldRatio = issuesDetected > 0
      ? Math.round((recsGenerated / issuesDetected) * 100) / 100
      : null
    const yieldNote = yieldRatio !== null
      ? `${yieldRatio} recs/issue avg`
      : null

    // ── Distinguish "leak" (user inaction) from "waiting" (natural data lag).
    // A stage is WAITING (not leaking) when the prior stage happened so recently
    // that downstream measurement hasn't had time to land yet. Specifically:
    //   - Measured needs ≥3 days after Applied to be meaningful
    //   - Improved (significant) needs ≥3 days after Measured
    // We compute this from the most recent timestamp at the prior stage.
    const mostRecentApplied = db.prepare(
      `SELECT MAX(applied_at) as ts FROM recommendations WHERE status='applied' ${W ? 'AND applied_at >= ?' : ''}`
    ).get(...(W ? [sinceISO] : [])).ts
    const mostRecentMeasured = db.prepare(
      `SELECT MAX(outcome_computed_at) as ts FROM recommendations WHERE outcome_computed_at IS NOT NULL ${W ? 'AND outcome_computed_at >= ?' : ''}`
    ).get(...(W ? [sinceISO] : [])).ts
    const daysSince = (ts) => ts ? (Date.now() - new Date(ts).getTime()) / 86400e3 : Infinity
    const MEASURE_LAG_DAYS  = 3   // Applied → Measured grace period
    const IMPROVE_LAG_DAYS  = 3   // Measured → Improved grace period

    // Status per row: 'normal' | 'leak' | 'waiting' | 'na'
    // 'leak'    = real user-actionable bottleneck (low conversion, prior step is old enough that data should exist)
    // 'waiting' = 0% conversion is normal because we're inside the lag window after the prior step
    // 'na'      = no conversion% applies (anchor rows or no prior count)
    function classify(row, prior, lagDays, priorTs) {
      if (row.conversionFromPrev === null) return 'na'
      if (prior === 0) return 'na'
      if (row.count === 0 && daysSince(priorTs) < lagDays) return 'waiting'
      if (row.conversionFromPrev < 30) return 'leak'
      return 'normal'
    }

    const funnel = [
      { stage: 'Issues Detected',           count: issuesDetected,       conversionFromPrev: null,
        contextNote: yieldNote, status: 'na' },
      { stage: 'Recommendations Generated', count: recsGenerated,        conversionFromPrev: null,
        contextNote: 'funnel entry point — % conversions below', status: 'na' },
      { stage: 'Recommendations Applied',   count: recsApplied,          conversionFromPrev: pct(recsApplied, recsGenerated),
        status: 'na' },   // populated below
      { stage: 'Outcomes Measured',         count: outcomesMeasured,     conversionFromPrev: pct(outcomesMeasured, recsApplied),
        status: 'na' },
      { stage: 'Improved Scores',           count: improvedSignificant,  conversionFromPrev: pct(improvedSignificant, outcomesMeasured),
        subCount: { label: 'incl. any improvement', value: improvedAny }, status: 'na' },
    ]
    // Applied: no time-lag concern — once a rec exists, it can be applied immediately
    funnel[2].status = classify(funnel[2], recsGenerated, 0, null)
    // Measured: needs post-apply calls under the new prompt → grace window after applied_at
    funnel[3].status = classify(funnel[3], recsApplied, MEASURE_LAG_DAYS, mostRecentApplied)
    // Improved: needs enough measured + delta computation → grace window after outcome_computed_at
    funnel[4].status = classify(funnel[4], outcomesMeasured, IMPROVE_LAG_DAYS, mostRecentMeasured)

    // Biggest leak = worst 'leak' status row only. Don't flag 'waiting' rows.
    const leakRows = funnel.filter((s) => s.status === 'leak')
    const biggestLeak = leakRows.length > 0
      ? leakRows.reduce((min, s) => s.conversionFromPrev < min.conversionFromPrev ? s : min)
      : null

    // Also surface the waiting row (if any) for honest UI messaging
    const waitingRows = funnel.filter((s) => s.status === 'waiting')
    const waitingStage = waitingRows[0] ? {
      stage: waitingRows[0].stage,
      reason: waitingRows[0].stage === 'Outcomes Measured'
        ? `Applied ${Math.round(daysSince(mostRecentApplied) * 10) / 10}d ago — post-apply calls are still accumulating.`
        : `Measured ${Math.round(daysSince(mostRecentMeasured) * 10) / 10}d ago — needs more sample to confirm significance.`,
    } : null

    // End-to-end closure rate uses the trusted (significant) definition
    const closureRate = issuesDetected > 0
      ? Math.round((improvedSignificant / issuesDetected) * 1000) / 10
      : null

    // ── PER-STAGE NARRATIVES (what / why / evidence / action)
    const narratives = NarrativeService.buildAll({ days, mode })

    // ── IMPACT SUMMARY — windowed avg-score delta + real cycle-time metric
    const recentSince = new Date(Date.now() - 7 * 86400e3).toISOString()
    const priorSince  = new Date(Date.now() - 14 * 86400e3).toISOString()
    const recent = db.prepare(`SELECT AVG(overall_score) as avg FROM analyses WHERE analyzed_at >= ?`).get(recentSince)
    const prior  = db.prepare(`SELECT AVG(overall_score) as avg FROM analyses WHERE analyzed_at >= ? AND analyzed_at < ?`).get(priorSince, recentSince)
    const avgScoreDelta = prior?.avg && recent?.avg ? Math.round((recent.avg - prior.avg) * 10) / 10 : null

    const lifecycle = RecommendationService.getLifecycleSummary()

    // Replaces the fake "manual review hours saved" — real metric: how fast does
    // a detected issue turn into an applied fix?
    const cycleRow = db.prepare(`
      SELECT AVG((julianday(applied_at) - julianday(first_seen_at))) as avgDays
      FROM recommendations
      WHERE applied_at IS NOT NULL AND first_seen_at IS NOT NULL
    `).get()
    const avgDaysIssueToFix = cycleRow.avgDays !== null
      ? Math.round(cycleRow.avgDays * 10) / 10
      : null

    // Pass rate context — how many analysed calls actually cleared the threshold?
    const totalAnalysedInWindow = db.prepare(
      `SELECT COUNT(*) as n FROM analyses WHERE ${win('analyzed_at')}`
    ).get(...winArgs).n
    const passedInWindow = Math.max(0, totalAnalysedInWindow - issuesDetected)
    const passRatePct = totalAnalysedInWindow > 0
      ? Math.round((passedInWindow / totalAnalysedInWindow) * 100)
      : null

    const impact = {
      avgScoreDeltaThisPeriod: avgScoreDelta,
      avgScoreDeltaContext:    'vs prior 7 days',
      successRatePct:          lifecycle.successRate,
      successRateContext:      `over all ${lifecycle.totalMeasured} measured outcome${lifecycle.totalMeasured === 1 ? '' : 's'}`,
      measuredOutcomes:        lifecycle.totalMeasured,
      measuredOutcomesContext: 'cumulative',
      avgDaysIssueToFix,       // null when nothing has been applied yet
      avgDaysContext:          'issue detected → fix applied',
      // New PM-correctness fields:
      analysedInWindow:        totalAnalysedInWindow,
      passedInWindow,
      passRatePct,             // can be null if no analyses
    }

    // ── HEALTH SUMMARY — distinguishes real bottleneck from natural lag
    // A stage in "waiting" status does NOT count as unhealthy because the user
    // has done their part and is just waiting for downstream data to land.
    const stageHealthChecks = [
      { name: 'Ingest',    healthy: issuesDetected > 0 || db.prepare('SELECT COUNT(*) as n FROM calls').get().n > 0 },
      { name: 'Score',     healthy: passRatePct === null || passRatePct >= 30 },  // ≥30% pass-rate = healthy
      { name: 'Recommend', healthy: recsGenerated > 0 || issuesDetected === 0 },
      { name: 'Apply',     healthy: funnel[2].status !== 'leak' },
      { name: 'Measure',   healthy: funnel[3].status !== 'leak' },  // 'waiting' counts as healthy
    ]
    const healthyCount = stageHealthChecks.filter((s) => s.healthy).length
    const totalStages  = stageHealthChecks.length
    const unhealthyStages = stageHealthChecks.filter((s) => !s.healthy).map((s) => s.name)
    const allHealthy   = healthyCount === totalStages

    let headline
    if (allHealthy && waitingStage) {
      headline = `All ${totalStages} stages healthy · ${waitingStage.stage} waiting for data`
    } else if (allHealthy) {
      headline = `All ${totalStages} stages healthy`
    } else if (biggestLeak) {
      headline = `${healthyCount} of ${totalStages} stages healthy · Biggest leak: ${biggestLeak.stage} (${biggestLeak.conversionFromPrev}% from prev)`
    } else {
      headline = `${healthyCount} of ${totalStages} stages healthy · ${unhealthyStages.join(', ')} need${unhealthyStages.length === 1 ? 's' : ''} attention`
    }

    const healthSummary = {
      healthyCount,
      totalStages,
      tone: allHealthy ? 'pass' : healthyCount >= totalStages - 1 ? 'warn' : 'fail',
      headline,
      leakStage: biggestLeak ? biggestLeak.stage : null,
      waitingStage,           // exposed for UI consumption
      unhealthyStages,
    }

    // ── NEXT BEST ACTION — respects waiting state instead of crying wolf
    const nextAction = computeNextAction({
      issuesDetected, recsGenerated, recsApplied, outcomesMeasured, improvedSignificant,
      passRatePct, waitingStage,
    })

    res.json({
      window: { days, sinceISO, mode },
      funnel,
      closureRate,
      rootCausesIdentified,
      biggestLeak,
      waitingStage,     // separate from leak — for honest waiting copy
      healthSummary,
      narratives,
      impact,
      nextAction,
    })
  } catch (err) {
    next(err)
  }
})

function pct(now, prev) {
  if (!prev || prev === 0) return null
  return Math.round((now / prev) * 100)
}

// Picks the single most-leveraged thing the user should do right now.
// Ordered by what unblocks the most downstream value.
// `waitingStage` lets us soften the message — never tell the user to act
// when the system is just waiting for data.
function computeNextAction({ issuesDetected, recsGenerated, recsApplied, outcomesMeasured, improvedSignificant, passRatePct, waitingStage }) {
  if (issuesDetected === 0 && recsGenerated === 0) {
    return { label: 'Sync from HighLevel to pull recent calls', href: '#sync', tone: 'primary',
             why: 'No analysed calls in this window — the flywheel runs on call data.' }
  }
  // The gap between Generated and Applied is usually where humans need to act.
  if (recsGenerated > recsApplied + 2) {
    const pending = recsGenerated - recsApplied
    const appliedNote = recsApplied > 0 ? ` (${recsApplied} already applied)` : ''
    return { label: `Apply ${pending} pending recommendation${pending === 1 ? '' : 's'}${appliedNote}`,
             href: '/patterns', tone: 'warn',
             why: 'Recommendations are queued but not yet rolled out to your agents — the biggest blocker right now.' }
  }
  // Honest "we're waiting on data" message when measure stage hasn't matured yet
  if (waitingStage) {
    return { label: `Waiting for ${waitingStage.stage.toLowerCase()} to accumulate`,
             href: '/patterns?status=applied', tone: 'secondary',
             why: waitingStage.reason }
  }
  if (recsApplied > 0 && outcomesMeasured === 0) {
    return { label: 'Wait for post-apply calls to accumulate', href: null, tone: 'secondary',
             why: 'Fixes are applied; outcomes will compute once new calls run under the updated prompts.' }
  }
  if (outcomesMeasured > 0 && improvedSignificant === 0) {
    return { label: 'Review measured outcomes — none improved meaningfully', href: '/patterns?status=applied', tone: 'fail',
             why: 'Applied changes haven\'t moved scores. Worth re-investigating before trusting the next round.' }
  }
  if (passRatePct !== null && passRatePct < 30 && issuesDetected >= 5) {
    return { label: `Investigate why ${100 - passRatePct}% of calls fail thresholds`,
             href: '/patterns', tone: 'fail',
             why: 'Pass-rate is unusually low — either KPI thresholds are too aggressive, or there\'s a systemic agent issue worth examining before applying more fixes.' }
  }
  if (issuesDetected > 0 && recsGenerated < issuesDetected * 0.3) {
    return { label: 'Score more calls to surface patterns', href: '/calls', tone: 'primary',
             why: 'Many issues detected but few recommendations — more analysed calls will reveal repeated patterns.' }
  }
  return { label: 'Flywheel is healthy — push the next pattern', href: '/patterns', tone: 'pass',
           why: 'Stages are converting well. The next applied recommendation compounds the improvement.' }
}

module.exports = router
