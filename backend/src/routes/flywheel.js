const express = require('express')
const db = require('../db/database')
const NarrativeService = require('../services/NarrativeService')
const RecommendationService = require('../services/RecommendationService')

const router = express.Router()

// GET /api/flywheel/summary?days=30
// Powers the /flywheel page hero — funnel + 5 stage cards + impact summary.
router.get('/summary', (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30))
    const sinceISO = new Date(Date.now() - days * 86400e3).toISOString()

    // ── FUNNEL (definitions per PLAN_V3_FINAL §4)
    // Each stage's count, plus the conversion rate from the previous stage.
    const issuesDetected = db.prepare(`
      SELECT COUNT(*) as n FROM analyses
      WHERE analyzed_at >= ? AND status != 'pass'
    `).get(sinceISO).n

    const rootCauseRows = db.prepare(`
      SELECT root_causes_json FROM analyses
      WHERE analyzed_at >= ? AND status != 'pass'
    `).all(sinceISO)
    const rootCauseSet = new Set()
    for (const r of rootCauseRows) {
      try {
        JSON.parse(r.root_causes_json || '[]').forEach((c) => rootCauseSet.add(c.toLowerCase().trim().slice(0, 80)))
      } catch { /* ignore parse failures */ }
    }
    const rootCausesIdentified = rootCauseSet.size

    const recsGenerated = db.prepare('SELECT COUNT(*) as n FROM recommendations').get().n
    const recsApplied = db.prepare("SELECT COUNT(*) as n FROM recommendations WHERE status = 'applied'").get().n
    const outcomesMeasured = db.prepare(
      'SELECT COUNT(*) as n FROM recommendations WHERE outcome_computed_at IS NOT NULL'
    ).get().n
    const improvedScores = db.prepare(`
      SELECT COUNT(*) as n FROM recommendations
      WHERE outcome_computed_at IS NOT NULL AND after_avg_score > before_avg_score
    `).get().n

    const funnel = [
      { stage: 'Issues Detected',           count: issuesDetected,       conversionFromPrev: null },
      { stage: 'Root Causes Identified',    count: rootCausesIdentified, conversionFromPrev: pct(rootCausesIdentified, issuesDetected) },
      { stage: 'Recommendations Generated', count: recsGenerated,        conversionFromPrev: pct(recsGenerated, rootCausesIdentified) },
      { stage: 'Recommendations Applied',   count: recsApplied,          conversionFromPrev: pct(recsApplied, recsGenerated) },
      { stage: 'Outcomes Measured',         count: outcomesMeasured,     conversionFromPrev: pct(outcomesMeasured, recsApplied) },
      { stage: 'Improved Scores',           count: improvedScores,       conversionFromPrev: pct(improvedScores, outcomesMeasured) },
    ]

    // End-to-end closure rate = Improved / Issues
    const closureRate = issuesDetected > 0
      ? Math.round((improvedScores / issuesDetected) * 1000) / 10
      : null

    // ── PER-STAGE NARRATIVES (what / why / evidence / action)
    const narratives = NarrativeService.buildAll({ days })

    // ── IMPACT SUMMARY (bottom of Flywheel page)
    const recentSince = new Date(Date.now() - 7 * 86400e3).toISOString()
    const priorSince  = new Date(Date.now() - 14 * 86400e3).toISOString()
    const recent = db.prepare(`SELECT AVG(overall_score) as avg FROM analyses WHERE analyzed_at >= ?`).get(recentSince)
    const prior  = db.prepare(`SELECT AVG(overall_score) as avg FROM analyses WHERE analyzed_at >= ? AND analyzed_at < ?`).get(priorSince, recentSince)
    const avgScoreDelta = prior?.avg && recent?.avg ? Math.round((recent.avg - prior.avg) * 10) / 10 : null

    const lifecycle = RecommendationService.getLifecycleSummary()

    const impact = {
      avgScoreDeltaThisPeriod: avgScoreDelta,
      successRatePct:          lifecycle.successRate,
      measuredOutcomes:        lifecycle.totalMeasured,
      // Manual review saved = analysed calls × ~5 min each (industry conservative)
      manualReviewHoursSaved:  Math.round((db.prepare('SELECT COUNT(*) as n FROM analyses').get().n * 5) / 60 * 10) / 10,
    }

    res.json({
      window: { days, sinceISO },
      funnel,
      closureRate,
      narratives,
      impact,
    })
  } catch (err) {
    next(err)
  }
})

function pct(now, prev) {
  if (!prev || prev === 0) return null
  return Math.round((now / prev) * 100)
}

module.exports = router
