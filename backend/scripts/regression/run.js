#!/usr/bin/env node
// Regression suite runner.
//
//   node backend/scripts/regression/run.js --seed     # reset DB + ingest + analyse + flywheel + triage
//   node backend/scripts/regression/run.js --verify   # run assertions against current DB
//   node backend/scripts/regression/run.js --full     # seed then verify
//
// Real OpenAI is used during --seed so analyses reflect actual model behaviour.
// Verification asserts downstream properties (KPI levels, recommendation counts,
// lifecycle states) — robust to model drift, strict about pipeline correctness.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const db = require('../../src/db/database')
const AnalysisService = require('../../src/services/AnalysisService')
const PromptVersionService = require('../../src/services/PromptVersionService')
const RecommendationService = require('../../src/services/RecommendationService')
const { AGENTS, SCENARIOS, USE_ACTION_TRIAGE } = require('./scenarios')

const mode = process.argv.includes('--full')   ? 'full'
           : process.argv.includes('--verify') ? 'verify'
           : process.argv.includes('--seed')   ? 'seed'
           : null

if (!mode) {
  console.error('usage: node run.js --seed | --verify | --full')
  process.exit(2)
}

// ─── Helpers ─────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
}
const ok    = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`)
const fail  = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`)
const info  = (m) => console.log(`  ${c.dim}·${c.reset} ${m}`)
const h1    = (m) => console.log(`\n${c.bold}${c.cyan}═══ ${m} ═══${c.reset}\n`)
const h2    = (m) => console.log(`\n${c.bold}── ${m} ──${c.reset}`)

// ─── SEED ────────────────────────────────────────────────────────────────
async function seed() {
  h1('SEED — reset DB + seed agents/calls + run OpenAI + simulate flywheel')

  // 1. Wipe DB (additive tables only — keep oauth_installations intact for HL OAuth state)
  h2('1. Wipe regression-affected tables')
  db.exec('DELETE FROM use_action_statuses')
  db.exec('DELETE FROM agent_insights')
  db.exec('DELETE FROM analyses')
  db.exec('DELETE FROM recommendations')
  db.exec('DELETE FROM calls')
  db.exec('DELETE FROM agent_prompt_versions')
  db.exec('DELETE FROM kpi_definitions')
  db.exec('DELETE FROM agents')
  ok('cleared agents, calls, analyses, recommendations, prompt_versions, kpis, insights, action_statuses')
  info('(oauth_installations preserved)')

  // 2. Insert agents + KPI defs
  h2('2. Insert agents + per-agent KPI definitions')
  for (const a of AGENTS) {
    db.prepare(`
      INSERT INTO agents (id, name, goal, script) VALUES (?, ?, ?, ?)
    `).run(a.id, a.name, a.goal, a.script)
    for (const k of a.kpis) {
      db.prepare(`
        INSERT INTO kpi_definitions (id, agent_id, name, label, weight, threshold, description)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), a.id, k.name, k.label, k.weight, k.threshold, k.description)
    }
    // Record initial prompt version (v1)
    PromptVersionService.recordIfChanged({ id: a.id, script: a.script, goal: a.goal })
    ok(`agent "${a.name}" + ${a.kpis.length} KPIs + prompt v1`)
  }

  // 3. Insert + analyse calls IN PHASES so the Validation Flywheel can close.
  //
  // Phase 3a — insert + analyse all non-flywheel scenarios + the v1 baseline calls.
  //            This creates active recs on FrontDoor under v1.
  // Phase 3b — simulate the FrontDoor prompt change (v1 → v2). Active v1 recs flip
  //            to status='applied' via markActiveAsApplied.
  // Phase 3c — insert + analyse the v2 calls (linked to v2 prompt_version_id).
  // Phase 3d — computePendingOutcomes fires (also auto-fires inside .analyze()).
  const callsByScenario = new Map()
  const analysisService = new AnalysisService()
  let now = Date.now() - SCENARIOS.length * 5 * 60 * 1000 // backdate to spread timestamps

  // — phase 3a —
  h2('3a. Insert + analyse non-flywheel + v1 baseline calls')
  const phase1Scenarios = SCENARIOS.filter((s) => s.promptVersion !== 'v2')
  for (const s of phase1Scenarios) {
    const callId = crypto.randomUUID()
    const callTimestamp = new Date(now).toISOString()
    now += 5 * 60 * 1000
    db.prepare(`
      INSERT INTO calls (id, agent_id, caller_number, duration, outcome, transcript_json, analysis_status, call_timestamp, prompt_version_id)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      callId, s.agentId,
      '555-' + String(Math.floor(Math.random() * 10000)).padStart(4, '0'),
      s.duration, s.outcome, JSON.stringify(s.transcript),
      callTimestamp, _currentPromptVersionId(s.agentId)
    )
    callsByScenario.set(s.id, { callId, callTimestamp })

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(s.agentId)
    const result = await analysisService.analyze(
      { id: callId, duration: s.duration, outcome: s.outcome, transcript: s.transcript },
      agent
    )
    if (result) {
      const stored = db.prepare('SELECT overall_score, status FROM analyses WHERE call_id = ?').get(callId)
      ok(`${s.id} → call ${callId.slice(-6)} status=${stored.status} score=${stored.overall_score}`)
    } else {
      fail(`${s.id} → analysis returned null`)
    }
  }

  // — phase 3b —
  h2('3b. Validation Flywheel — simulate FrontDoor prompt change v1 → v2')
  const frontDoor = AGENTS.find((a) => a.id === 'reg-frontdoor')
  const activeBefore = db.prepare("SELECT COUNT(*) n FROM recommendations WHERE agent_id=? AND status='active'").get(frontDoor.id).n
  info(`active recs on FrontDoor before prompt change: ${activeBefore}`)
  const versionResult = PromptVersionService.recordIfChanged({
    id: frontDoor.id, script: frontDoor.promptV2Script, goal: frontDoor.goal,
  })
  if (versionResult.isNew) {
    ok(`prompt v2 recorded (${versionResult.versionId.slice(0, 8)}...) — prev v1 (${versionResult.prevVersionId.slice(0, 8)}...)`)
  }
  // The auto-apply hook lives in IngestionService.upsertAgent (line ~111), not in
  // PromptVersionService.recordIfChanged itself. Since this script bypasses the
  // ingestion path, invoke it directly here.
  if (versionResult.isNew && versionResult.prevVersionId) {
    RecommendationService.markActiveAsApplied(frontDoor.id, versionResult.versionId)
  }
  const appliedAfter = db.prepare("SELECT COUNT(*) n FROM recommendations WHERE agent_id=? AND status='applied'").get(frontDoor.id).n
  ok(`recommendations auto-applied: ${appliedAfter} (was ${activeBefore} active before)`)
  const v2Id = versionResult.versionId

  // — phase 3c —
  h2('3c. Insert + analyse v2 (post-apply) calls')
  // V2 call timestamps MUST be strictly after applied_at for computePendingOutcomes
  // to count them as "after" samples. Restart the clock from "now + 1 minute"
  // (applied_at was just set by markActiveAsApplied via datetime('now')).
  now = Date.now() + 60 * 1000
  const phase3Scenarios = SCENARIOS.filter((s) => s.promptVersion === 'v2')
  for (const s of phase3Scenarios) {
    const callId = crypto.randomUUID()
    const callTimestamp = new Date(now).toISOString()
    now += 5 * 60 * 1000
    db.prepare(`
      INSERT INTO calls (id, agent_id, caller_number, duration, outcome, transcript_json, analysis_status, call_timestamp, prompt_version_id)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      callId, s.agentId,
      '555-' + String(Math.floor(Math.random() * 10000)).padStart(4, '0'),
      s.duration, s.outcome, JSON.stringify(s.transcript),
      callTimestamp, v2Id
    )
    callsByScenario.set(s.id, { callId, callTimestamp })

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(s.agentId)
    const result = await analysisService.analyze(
      { id: callId, duration: s.duration, outcome: s.outcome, transcript: s.transcript },
      agent
    )
    if (result) {
      const stored = db.prepare('SELECT overall_score, status FROM analyses WHERE call_id = ?').get(callId)
      ok(`${s.id} → call ${callId.slice(-6)} status=${stored.status} score=${stored.overall_score}`)
    }
  }

  // — phase 3d — measurement (analyze() already calls it after each analysis;
  // calling once more here is a no-op safety net for anything that needs it.)
  h2('3d. Final measurement pass')
  const computed = RecommendationService.computePendingOutcomes()
  if (computed > 0) ok(`computePendingOutcomes() → measured ${computed} additional outcome(s)`)
  else info('all outcomes already computed inline during analysis')
  const measuredTotal = db.prepare('SELECT COUNT(*) n FROM recommendations WHERE outcome_computed_at IS NOT NULL').get().n
  info(`total measured outcomes in DB: ${measuredTotal}`)

  // 7. Triage some use_actions to exercise the action queue lifecycle
  h2('7. Triage use_actions — exercise resolve/dismiss/escalate verbs')
  const allActions = []
  for (const a of db.prepare("SELECT call_id, use_actions_json FROM analyses WHERE use_actions_json != '[]'").all()) {
    const list = JSON.parse(a.use_actions_json)
    for (const ua of list) {
      allActions.push({ callId: a.call_id, turnIndex: ua.turnIndex, actionType: ua.actionType })
    }
  }
  USE_ACTION_TRIAGE.forEach((triage, i) => {
    const action = allActions[i]
    if (!action) return info(`no action ${i + 1} available to ${triage.verb}`)
    const newStatus = { resolve: 'resolved', dismiss: 'dismissed', escalate: 'escalated' }[triage.verb]
    db.prepare(`
      INSERT INTO use_action_statuses (call_id, turn_index, action_type, status, note, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(call_id, turn_index, action_type) DO UPDATE SET
        status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now')
    `).run(action.callId, action.turnIndex, action.actionType, newStatus, triage.note, triage.updatedBy)
    ok(`${triage.verb} → call ${action.callId.slice(-6)} turn ${action.turnIndex} (${triage.note})`)
  })

  // 8. Summary
  h2('8. Seed summary')
  const summary = {
    agents:           db.prepare('SELECT COUNT(*) n FROM agents').get().n,
    calls:            db.prepare('SELECT COUNT(*) n FROM calls').get().n,
    analyses:         db.prepare('SELECT COUNT(*) n FROM analyses').get().n,
    recommendations:  db.prepare('SELECT COUNT(*) n FROM recommendations').get().n,
    rec_applied:      db.prepare("SELECT COUNT(*) n FROM recommendations WHERE status='applied'").get().n,
    rec_measured:     db.prepare("SELECT COUNT(*) n FROM recommendations WHERE outcome_computed_at IS NOT NULL").get().n,
    prompt_versions:  db.prepare('SELECT COUNT(*) n FROM agent_prompt_versions').get().n,
    action_statuses:  db.prepare('SELECT COUNT(*) n FROM use_action_statuses').get().n,
  }
  console.log('  ' + JSON.stringify(summary, null, 2).replace(/\n/g, '\n  '))

  // Persist scenario→callId map so verify can find each call
  const mapPath = path.join(__dirname, '.last-seed-map.json')
  fs.writeFileSync(mapPath, JSON.stringify(Object.fromEntries(callsByScenario), null, 2))
  info(`scenario→call map written to ${mapPath}`)
}

function _currentPromptVersionId(agentId) {
  const row = db.prepare(
    'SELECT id FROM agent_prompt_versions WHERE agent_id = ? ORDER BY first_seen_at DESC LIMIT 1'
  ).get(agentId)
  return row?.id || null
}

// ─── VERIFY ──────────────────────────────────────────────────────────────
function verify() {
  h1('VERIFY — run assertions against current DB')

  const mapPath = path.join(__dirname, '.last-seed-map.json')
  if (!fs.existsSync(mapPath)) {
    fail('No .last-seed-map.json — run --seed first')
    process.exit(2)
  }
  const callMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'))

  const results = []
  for (const s of SCENARIOS) {
    const entry = callMap[s.id]
    if (!entry) { results.push({ id: s.id, label: s.label, pass: false, reason: 'no call seeded' }); continue }
    const an = db.prepare('SELECT * FROM analyses WHERE call_id = ?').get(entry.callId)
    if (!an) { results.push({ id: s.id, label: s.label, pass: false, reason: 'no analysis row' }); continue }

    const kpi = JSON.parse(an.kpi_scores_json)
    const devs = JSON.parse(an.deviations_json || '[]')
    const mos  = JSON.parse(an.missed_opportunities_json || '[]')
    const halls= JSON.parse(an.hallucinations_json || '[]')
    const uas  = JSON.parse(an.use_actions_json || '[]')
    const recsForCall = db.prepare(`
      SELECT COUNT(*) n FROM recommendations WHERE agent_id = ?
    `).get(s.agentId).n
    const criticalForCall = db.prepare(`
      SELECT COUNT(*) n FROM recommendations WHERE agent_id = ? AND severity='critical'
    `).get(s.agentId).n
    // This call's own analysis recommendations (not agent-wide)
    const recsThisAnalysis = JSON.parse(an.recommendations_json || '[]')
    const criticalThisAnalysis = recsThisAnalysis.filter((r) => r.severity === 'critical').length

    const exp = s.expect || {}
    const checks = []
    if (exp.status)                  checks.push({ name: `status == ${exp.status}`,                pass: an.status === exp.status, got: an.status })
    if (exp.status_in)               checks.push({ name: `status in [${exp.status_in.join(',')}]`, pass: exp.status_in.includes(an.status), got: an.status })
    if (exp.overall_score_min !== undefined)
                                     checks.push({ name: `overall_score >= ${exp.overall_score_min}`, pass: an.overall_score >= exp.overall_score_min, got: an.overall_score })
    if (exp.max_critical_recs !== undefined)
                                     checks.push({ name: `agent critical recs <= ${exp.max_critical_recs}`, pass: criticalForCall <= exp.max_critical_recs, got: criticalForCall })
    if (exp.max_call_critical_recs !== undefined)
                                     checks.push({ name: `THIS CALL critical recs <= ${exp.max_call_critical_recs}`, pass: criticalThisAnalysis <= exp.max_call_critical_recs, got: criticalThisAnalysis })
    if (exp.min_recommendations !== undefined)
                                     checks.push({ name: `agent total recs >= ${exp.min_recommendations}`, pass: recsForCall >= exp.min_recommendations, got: recsForCall })
    if (exp.min_deviations !== undefined)
                                     checks.push({ name: `deviations >= ${exp.min_deviations}`, pass: devs.length >= exp.min_deviations, got: devs.length })
    if (exp.min_missed_opportunities !== undefined)
                                     checks.push({ name: `missed >= ${exp.min_missed_opportunities}`, pass: mos.length >= exp.min_missed_opportunities, got: mos.length })
    if (exp.min_hallucinations !== undefined)
                                     checks.push({ name: `hallucinations >= ${exp.min_hallucinations}`, pass: halls.length >= exp.min_hallucinations, got: halls.length })
    if (exp.min_use_actions !== undefined)
                                     checks.push({ name: `use_actions >= ${exp.min_use_actions}`, pass: uas.length >= exp.min_use_actions, got: uas.length })
    if (exp.objection_handling_max !== undefined)
                                     checks.push({ name: `objection_handling <= ${exp.objection_handling_max}`, pass: kpi.objection_handling <= exp.objection_handling_max, got: kpi.objection_handling })
    if (exp.sentiment_score_max !== undefined)
                                     checks.push({ name: `sentiment_score <= ${exp.sentiment_score_max}`, pass: kpi.sentiment_score <= exp.sentiment_score_max, got: kpi.sentiment_score })
    if (exp.escalation_rate_max !== undefined)
                                     checks.push({ name: `escalation_rate <= ${exp.escalation_rate_max}`, pass: kpi.escalation_rate <= exp.escalation_rate_max, got: kpi.escalation_rate })
    if (exp.script_adherence_max !== undefined)
                                     checks.push({ name: `script_adherence <= ${exp.script_adherence_max}`, pass: kpi.script_adherence <= exp.script_adherence_max, got: kpi.script_adherence })

    const allPassed = checks.length === 0 || checks.every((x) => x.pass)
    results.push({ id: s.id, label: s.label, pass: allPassed, checks })
  }

  // Print per-scenario table
  for (const r of results) {
    const icon = r.pass ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`
    console.log(`${icon} ${c.bold}${r.id.padEnd(28)}${c.reset} ${r.label}`)
    if (r.reason) {
      console.log(`    ${c.red}${r.reason}${c.reset}`)
    } else if (r.checks) {
      for (const ch of r.checks) {
        const i = ch.pass ? `${c.green}  ✓${c.reset}` : `${c.red}  ✗${c.reset}`
        console.log(`  ${i} ${ch.name}  (got: ${ch.got})`)
      }
    }
  }

  // ─── System-level assertions (cross-scenario) ──────────────────────────
  h2('System-level assertions')
  const sysChecks = []
  const noDataAgent = db.prepare("SELECT id FROM agents WHERE id='reg-receptionist'").get()
  const noDataCalls = db.prepare("SELECT COUNT(*) n FROM calls WHERE agent_id='reg-receptionist'").get().n
  sysChecks.push({ name: 'zero-call agent exists with 0 calls (no-data UX)', pass: !!noDataAgent && noDataCalls === 0, got: `agent=${!!noDataAgent}, calls=${noDataCalls}` })

  const promptVersions = db.prepare("SELECT COUNT(*) n FROM agent_prompt_versions WHERE agent_id='reg-frontdoor'").get().n
  sysChecks.push({ name: 'FrontDoor has ≥2 prompt versions', pass: promptVersions >= 2, got: promptVersions })

  const appliedFDcount = db.prepare("SELECT COUNT(*) n FROM recommendations WHERE agent_id='reg-frontdoor' AND status='applied'").get().n
  sysChecks.push({ name: 'FrontDoor has ≥1 auto-applied recommendation (prompt-version flow)', pass: appliedFDcount >= 1, got: appliedFDcount })

  const triagedCount = db.prepare("SELECT COUNT(*) n FROM use_action_statuses").get().n
  sysChecks.push({ name: 'use_action_statuses has 3 triaged rows (resolved/escalated/dismissed)', pass: triagedCount >= 3, got: triagedCount })

  const verbsSeen = db.prepare("SELECT DISTINCT status FROM use_action_statuses").all().map((r) => r.status).sort()
  sysChecks.push({ name: 'all 3 verb outcomes present', pass: ['dismissed', 'escalated', 'resolved'].every((v) => verbsSeen.includes(v)), got: verbsSeen.join(',') })

  const patternRec = db.prepare("SELECT MAX(occurrence_count) n FROM recommendations WHERE agent_id='reg-grace'").get().n
  sysChecks.push({ name: 'Grace pattern detected: ≥1 recommendation with occurrence_count >= 2', pass: patternRec >= 2, got: patternRec })

  for (const ch of sysChecks) {
    const i = ch.pass ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`
    console.log(`  ${i} ${ch.name}  (got: ${ch.got})`)
  }

  // ─── Final tally ───────────────────────────────────────────────────────
  const scenPass = results.filter((r) => r.pass).length
  const sysPass  = sysChecks.filter((r) => r.pass).length
  const total    = results.length + sysChecks.length
  const passed   = scenPass + sysPass
  h1('SUMMARY')
  console.log(`  scenario assertions: ${c.bold}${scenPass}/${results.length}${c.reset}`)
  console.log(`  system assertions:   ${c.bold}${sysPass}/${sysChecks.length}${c.reset}`)
  console.log(`  total:               ${c.bold}${passed === total ? c.green : c.red}${passed}/${total}${c.reset}`)
  process.exit(passed === total ? 0 : 1)
}

// ─── Entrypoint ──────────────────────────────────────────────────────────
;(async () => {
  try {
    if (mode === 'seed' || mode === 'full') await seed()
    if (mode === 'verify' || mode === 'full') verify()
    if (mode === 'seed') process.exit(0)
  } catch (e) {
    console.error(`\n${c.red}FATAL:${c.reset} ${e.message}`)
    console.error(e.stack)
    process.exit(3)
  }
})()
