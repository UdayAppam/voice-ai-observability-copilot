// SentimentService — V5.6
// Shared between dashboard route (agency-wide trend) and agents route
// (per-agent trend). Extracted from dashboard.js so both can require it
// without circular-import gymnastics.
//
// Two helpers:
//   - computeSentimentTrend({ sinceISO, days, agentId })  → day-by-day bucketed series
//   - computeSentimentSpike(trend)                        → worst day + top contributing pattern

const db = require('../db/database')

// PM-aligned thresholds (V5.8 fix). Match the per-agent sentiment KPI default
// threshold (60) so the chart and the KPI grading speak the same language.
// Before V5.8, chart used 70 positive / 50 negative — meaning a sentiment of
// 65 would show as "mixed" on the chart yet "passing the KPI" on the KPI bar.
// Same number → two different verdicts. Now both surfaces agree.
const SENTIMENT_POSITIVE_THRESHOLD = 60
const SENTIMENT_NEGATIVE_CEIL = 30

// Day-by-day distribution. `total` exposed for tooltip "N of M calls" context.
// `hasData` lets the UI hide zero-data days instead of plotting 0% (which
// reads as "agent collapsed" — a misleading false signal).
function computeSentimentTrend(sinceISO, days, agentId = null) {
  const where = agentId
    ? 'WHERE a.analyzed_at >= ? AND c.agent_id = ?'
    : 'WHERE a.analyzed_at >= ?'
  const args  = agentId ? [sinceISO, agentId] : [sinceISO]
  const rows = db.prepare(`
    SELECT DATE(a.analyzed_at) as day, a.kpi_scores_json
    FROM analyses a JOIN calls c ON c.id = a.call_id
    ${where}
    ORDER BY a.analyzed_at ASC
  `).all(...args)

  // Build a date map covering every day in the window even if zero data
  const series = {}
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - (days - 1 - i) * 86400e3).toISOString().slice(0, 10)
    series[d] = { day: d, positive: 0, neutral: 0, negative: 0, total: 0 }
  }

  for (const r of rows) {
    if (!series[r.day]) continue
    const sentiment = JSON.parse(r.kpi_scores_json).sentiment_score ?? 0
    if (sentiment >= SENTIMENT_POSITIVE_THRESHOLD) series[r.day].positive++
    else if (sentiment >= SENTIMENT_NEGATIVE_CEIL) series[r.day].neutral++
    else series[r.day].negative++
    series[r.day].total++
  }

  return Object.values(series).map((s) => {
    const hasData = s.total > 0
    return {
      day: s.day,
      total: s.total,
      hasData,
      // Percentages — null when no data so the chart can hide (not plot 0%)
      positive: hasData ? Math.round((s.positive / s.total) * 100) : null,
      neutral:  hasData ? Math.round((s.neutral  / s.total) * 100) : null,
      negative: hasData ? Math.round((s.negative / s.total) * 100) : null,
      // Raw counts for tooltip "N of M" context
      positiveCount: s.positive,
      neutralCount:  s.neutral,
      negativeCount: s.negative,
    }
  })
}

// "Spike" = a day where negative% jumped ≥20 pts vs the prior data day OR
// an absolute high-negative day (≥50%). Returns the worst spike + the best
// candidate contributing recommendation.
function computeSentimentSpike(trend, agentId = null) {
  let worst = null
  let prior = null
  for (const d of trend) {
    if (!d.hasData) continue
    if (prior && d.negative > prior.negative && (d.negative - prior.negative) >= 20) {
      const jump = d.negative - prior.negative
      if (!worst || jump > worst.jump) {
        worst = { day: d.day, negative: d.negative, negativeCount: d.negativeCount, total: d.total, jump }
      }
    }
    if (d.negative >= 50 && (!worst || d.negative > worst.negative)) {
      worst = { day: d.day, negative: d.negative, negativeCount: d.negativeCount, total: d.total, jump: null }
    }
    prior = d
  }
  if (!worst) return null

  // Find the top contributing pattern: highest-occurrence active rec touching
  // any call on the worst day. When agentId is given, scope to that agent only.
  const startISO = worst.day + 'T00:00:00.000Z'
  const endISO   = worst.day + 'T23:59:59.999Z'
  const agentClause = agentId ? `AND r.agent_id = '${agentId.replace(/'/g, "''")}'` : ''
  const topRec = db.prepare(`
    SELECT r.title, r.id, ag.name as agentName
    FROM recommendations r
    JOIN agents ag ON ag.id = r.agent_id
    WHERE r.status = 'active'
      ${agentClause}
      AND r.agent_id IN (
        SELECT DISTINCT c.agent_id FROM calls c
        JOIN analyses a ON a.call_id = c.id
        WHERE a.analyzed_at >= ? AND a.analyzed_at <= ?
          AND CAST(json_extract(a.kpi_scores_json, '$.sentiment_score') AS INTEGER) < ${SENTIMENT_NEGATIVE_CEIL}
      )
    ORDER BY r.occurrence_count DESC LIMIT 1
  `).get(startISO, endISO)

  return { ...worst, topRec: topRec || null }
}

module.exports = {
  computeSentimentTrend,
  computeSentimentSpike,
  SENTIMENT_POSITIVE_THRESHOLD,
  SENTIMENT_NEGATIVE_CEIL,
}
