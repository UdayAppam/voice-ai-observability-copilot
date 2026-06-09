#!/usr/bin/env node
// simulate-apply-patterns.js — phase 2 of the scaled-flywheel simulation.
// Picks the top 3 most-impactful active patterns, applies each via the real
// V4 flow (using LocalAgentService for reg-* agents), then injects synthetic
// post-apply calls to trigger computePendingOutcomes naturally.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const crypto = require('crypto')
const db = require('../src/db/database')
const ApplyRecommendationService = require('../src/services/ApplyRecommendationService')
const RecommendationService = require('../src/services/RecommendationService')

;(async () => {
  console.log(`\n=== APPLY PATTERNS — picking top 3 active recs by impact ===`)

  // Pick top 3: critical severity first, then by occurrence_count, exclude already-applied
  const candidates = db.prepare(`
    SELECT r.id, r.agent_id, r.title, r.severity, r.occurrence_count, ag.name as agentName
    FROM recommendations r JOIN agents ag ON ag.id = r.agent_id
    WHERE r.status = 'active'
    ORDER BY
      CASE r.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
      r.occurrence_count DESC
    LIMIT 4
  `).all()

  // Use HTTP path so we get the same section-aware insertion the UI does.
  // Blind-append bypasses V4.2 and the context_consistency validator (correctly)
  // blocks contradictions introduced by sloppy appending.
  const API_KEY = process.env.API_KEY || 'test-api-key-123'
  // Persistent server runs on 3001 because port 3000 is taken by Next.js dev server.
  // Override the .env PORT (which says 3000) explicitly.
  const BASE = 'http://localhost:3001'

  for (const cand of candidates) {
    console.log(`\n→ Applying: "${cand.title}" on ${cand.agentName} [${cand.severity}, n=${cand.occurrence_count}]`)
    try {
      // Step A — preview-apply produces the section-aware aiSuggestedText
      const previewRes = await fetch(`${BASE}/api/recommendations/${cand.id}/preview-apply`, {
        headers: { 'X-API-Key': API_KEY },
      })
      const preview = await previewRes.json()
      if (preview.error) { throw new Error(`preview-apply: ${preview.error.message}`) }
      const finalText = preview.aiSuggestedText
      console.log(`  · preview: ${preview.sectionAware ? `section-aware (target=${preview.sectionAware.targetSectionName})` : 'blind-append fallback'}, validators ${preview.validation.blocking ? 'BLOCKED' : 'ok'}`)
      if (preview.validation.blocking) {
        const failed = preview.validation.checks.filter(c=>c.severity==='fail').map(c=>c.name).join(', ')
        console.warn(`  ✗ validators block this even with section-aware: ${failed}`)
        continue
      }

      // Step B — POST /apply with the section-aware text
      const applyRes = await fetch(`${BASE}/api/agents/${cand.agent_id}/recommendations/${cand.id}/apply`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ finalText, userEmail: 'pm-review@example.com' }),
      })
      const receipt = await applyRes.json()
      if (receipt.error) { throw new Error(`apply: ${receipt.error.message}`) }
      const versionStep = receipt.timeline.find((s) => s.step === 'record_prompt_version')
      console.log(`  ✓ outcome=${receipt.outcome}, newVersion=${versionStep?.versionId?.slice(0,8) || '—'}`)

      // Inject 4 synthetic post-apply calls for this agent under the new prompt version
      // — gives computePendingOutcomes enough samples to meet n>=3 significance threshold
      const newVersionId = versionStep?.versionId
      if (!newVersionId) { console.warn('  ⚠ no prompt_version recorded, skipping measurement'); continue }
      const baseAnalysis = db.prepare(`
        SELECT kpi_scores_json, overall_score FROM analyses a JOIN calls c ON c.id=a.call_id
        WHERE c.agent_id=? ORDER BY a.analyzed_at DESC LIMIT 1
      `).get(cand.agent_id)
      const baseKpis = JSON.parse(baseAnalysis.kpi_scores_json || '{}')
      // Improvement scenario: post-apply scores +10 on average
      for (let i = 0; i < 4; i++) {
        const callId = `sim_postapply_${cand.id.slice(0,8)}_${i}`
        const tsMs = Date.now() + (i + 1) * 60 * 1000  // strictly after applied_at
        const ts = new Date(tsMs).toISOString()
        const liftedKpis = {}
        for (const [k, v] of Object.entries(baseKpis)) {
          const lift = 10 + Math.round((Math.random() - 0.3) * 8)  // +6 to +14 typically
          liftedKpis[k] = Math.min(100, v + lift)
        }
        const kpiDefs = db.prepare('SELECT name, weight FROM kpi_definitions WHERE agent_id=?').all(cand.agent_id)
        const totalW = kpiDefs.reduce((s,k)=>s+k.weight,0) || 1
        const newOverall = Math.round(kpiDefs.reduce((s,k)=>s+(liftedKpis[k.name]||0)*k.weight,0) / totalW)
        const status = newOverall >= 70 ? 'pass' : newOverall >= 50 ? 'warning' : 'fail'
        db.prepare(`
          INSERT INTO calls (id, agent_id, caller_number, duration, outcome, transcript_json, analysis_status, call_timestamp, prompt_version_id)
          VALUES (?, ?, ?, 95, 'completed', '[{"speaker":"agent","text":"post-apply simulation"}]', 'completed', ?, ?)
        `).run(callId, cand.agent_id, '555-' + String(Math.floor(Math.random()*10000)).padStart(4,'0'), ts, newVersionId)
        db.prepare(`
          INSERT INTO analyses (id, call_id, overall_score, status, summary, root_causes_json, kpi_scores_json,
            deviations_json, missed_opportunities_json, recommendations_json, use_actions_json, hallucinations_json, analyzed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), callId, newOverall, status, 'Post-apply sim', '[]',
               JSON.stringify(liftedKpis), '[]', '[]', '[]', '[]', '[]', ts)
      }
      // Trigger measurement
      const computed = RecommendationService.computePendingOutcomes()
      console.log(`  ✓ +4 post-apply calls injected, ${computed} outcome(s) just computed`)
    } catch (err) {
      console.error(`  ✗ apply failed: ${err.message}`)
    }
  }

  console.log(`\n=== FINAL STATE ===`)
  const r = db.prepare(`SELECT
    (SELECT COUNT(*) FROM calls) c,
    (SELECT COUNT(*) FROM analyses) a,
    (SELECT COUNT(*) FROM recommendations) tr,
    (SELECT COUNT(*) FROM recommendations WHERE status='active') ra,
    (SELECT COUNT(*) FROM recommendations WHERE status='applied') rap,
    (SELECT COUNT(*) FROM recommendations WHERE outcome_computed_at IS NOT NULL) rm,
    (SELECT COUNT(*) FROM recommendations WHERE outcome_computed_at IS NOT NULL AND after_avg_score > before_avg_score) ri,
    (SELECT COUNT(*) FROM recommendations WHERE outcome_computed_at IS NOT NULL AND (after_avg_score - before_avg_score) >= 2 AND after_sample_size >= 3) rs`).get()
  console.log(`  calls:           ${r.c}`)
  console.log(`  analyses:        ${r.a}`)
  console.log(`  recs (total):    ${r.tr}`)
  console.log(`    active:        ${r.ra}`)
  console.log(`    applied:       ${r.rap}`)
  console.log(`    measured:      ${r.rm}`)
  console.log(`    improved (any): ${r.ri}`)
  console.log(`    improved (significant): ${r.rs}`)
  process.exit(0)
})().catch((e) => { console.error(e.stack); process.exit(1) })
