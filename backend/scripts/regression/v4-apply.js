#!/usr/bin/env node
// V4 live test — exercises the full apply + rollback loop against a real HL agent.
//
// Picks one active recommendation from the live DB, runs:
//   preview-apply → apply → assert state → rollback → assert state
// and leaves the HL agent in its original state.
//
// Run with the backend running:
//   node backend/scripts/regression/v4-apply.js
//
// Requires HL_PIT_TOKEN (or OAuth installation) with voice-ai-agents.write scope.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })

const db = require('../../src/db/database')
const ApplyRecommendationService = require('../../src/services/ApplyRecommendationService')

const c = {
  reset:'\x1b[0m', bold:'\x1b[1m', green:'\x1b[32m', red:'\x1b[31m',
  yellow:'\x1b[33m', cyan:'\x1b[36m', dim:'\x1b[2m',
}
const ok    = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`)
const fail  = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`)
const info  = (m) => console.log(`  ${c.dim}·${c.reset} ${m}`)
const h1    = (m) => console.log(`\n${c.bold}${c.cyan}═══ ${m} ═══${c.reset}`)
const h2    = (m) => console.log(`\n${c.bold}── ${m} ──${c.reset}`)

let pass = 0, total = 0
function assert(label, cond, detail = '') {
  total++
  if (cond) { ok(`${label}${detail ? ' · ' + detail : ''}`); pass++ }
  else      { fail(`${label}${detail ? ' · ' + detail : ''}`) }
}

;(async () => {
  h1('V4 LIVE TEST — apply + rollback against real HL agent')

  // 1. Pick an active rec
  h2('1. Pick an active recommendation from live DB')
  const rec = db.prepare(`
    SELECT r.id, r.agent_id, r.title, r.severity, r.suggested_change,
           ag.name as agent_name
    FROM recommendations r JOIN agents ag ON ag.id = r.agent_id
    WHERE r.status = 'active' AND r.suggested_change IS NOT NULL
    ORDER BY CASE r.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
             r.occurrence_count DESC
    LIMIT 1
  `).get()
  if (!rec) { fail('No active rec found — seed live DB first'); process.exit(2) }
  info(`rec.id      = ${rec.id}`)
  info(`agent       = ${rec.agent_name} (${rec.agent_id})`)
  info(`title       = ${rec.title}`)
  info(`severity    = ${rec.severity}`)

  // 2. Apply (with NO edit — accept AI suggestion as-is)
  h2('2. APPLY — accept AI suggestion as-is')
  const locationId = process.env.HL_LOCATION_ID
  // We need the aiSuggestedText that preview-apply would produce; rebuild it
  // here by reading current prompt + appending suggestion (same logic as routes/apply.js)
  const HLVoiceAgentService = require('../../src/services/HLVoiceAgentService')
  const hl = new HLVoiceAgentService({ locationId })
  const agentBefore = await hl.getAgent(rec.agent_id)
  const originalPromptLength = agentBefore.agentPrompt.length
  info(`current prompt length = ${originalPromptLength}`)

  const aiSuggestedText = agentBefore.agentPrompt.includes(rec.suggested_change)
    ? agentBefore.agentPrompt
    : `${agentBefore.agentPrompt.trimEnd()}\n\n${rec.suggested_change}`

  const applyReceipt = await ApplyRecommendationService.apply({
    recommendationId: rec.id,
    agentId:          rec.agent_id,
    locationId,
    finalText:        aiSuggestedText,
    userEmail:        'v4-regression@test',
  })
  assert('apply outcome=success',                applyReceipt.outcome === 'success')
  assert('apply not edited (used AI suggestion)', !applyReceipt.editedFromSuggestion)
  assert('apply diff non-empty',                  applyReceipt.diffSummary && applyReceipt.diffSummary !== 'no change')
  assert('apply receipt has attemptId',           !!applyReceipt.attemptId)

  // 3. State after apply — rec marked applied, audit row written, HL prompt updated
  h2('3. State after apply')
  const recAfter = db.prepare('SELECT status, applied_via FROM recommendations WHERE id=?').get(rec.id)
  assert("rec.status='applied'",      recAfter.status === 'applied', `got status=${recAfter.status}`)
  assert("rec.applied_via='auto_api'", recAfter.applied_via === 'auto_api', `got ${recAfter.applied_via}`)

  const auditRow = db.prepare(`
    SELECT * FROM apply_attempts WHERE recommendation_id=? ORDER BY attempted_at DESC LIMIT 1
  `).get(rec.id)
  assert("audit row exists",                       !!auditRow)
  assert("audit row outcome='success'",            auditRow.outcome === 'success')
  assert("audit row has previous_agent_prompt",    !!auditRow.previous_agent_prompt && auditRow.previous_agent_prompt.length === originalPromptLength)
  assert("audit row final_text matches",           auditRow.final_text === aiSuggestedText)
  assert("audit row edited_from_suggestion=0",     auditRow.edited_from_suggestion === 0)
  assert("audit row user_email captured",          auditRow.user_email === 'v4-regression@test')

  // Verify HL actually got the new prompt
  const agentMid = await hl.getAgent(rec.agent_id)
  assert("HL agent prompt was actually patched",   agentMid.agentPrompt.length !== originalPromptLength,
    `${originalPromptLength} → ${agentMid.agentPrompt.length}`)
  assert("HL agent prompt matches final_text",     agentMid.agentPrompt === aiSuggestedText)

  // 4. Idempotency — second apply within 5min returns existing receipt without re-PATCHing
  h2('4. Idempotency — second Apply should return cached receipt')
  const before2nd = (await hl.getAgent(rec.agent_id)).agentPrompt
  const second = await ApplyRecommendationService.apply({
    recommendationId: rec.id, agentId: rec.agent_id, locationId,
    finalText: aiSuggestedText, userEmail: 'v4-regression@test',
  })
  assert("2nd apply outcome=success",  second.outcome === 'success')
  assert("2nd apply marked idempotent", second.idempotent === true)
  const after2nd = (await hl.getAgent(rec.agent_id)).agentPrompt
  assert("HL prompt unchanged by 2nd apply",       before2nd === after2nd)

  // 5. Rollback
  h2('5. ROLLBACK — restore previous prompt')
  const rollbackReceipt = await ApplyRecommendationService.rollback({
    recommendationId: rec.id, locationId, userEmail: 'v4-regression@test',
  })
  assert("rollback outcome='rolled_back'",         rollbackReceipt.outcome === 'rolled_back')
  assert("rollback restoredPromptLength matches",  rollbackReceipt.restoredPromptLength === originalPromptLength)

  const recAfterRollback = db.prepare("SELECT status, applied_at, applied_via FROM recommendations WHERE id=?").get(rec.id)
  assert("rec back to status='active'",            recAfterRollback.status === 'active')
  assert("rec.applied_at cleared",                 recAfterRollback.applied_at === null)
  assert("rec.applied_via cleared",                recAfterRollback.applied_via === null)

  const rollbackAudit = db.prepare(`
    SELECT * FROM apply_attempts WHERE recommendation_id=? ORDER BY attempted_at DESC LIMIT 1
  `).get(rec.id)
  assert("rollback audit row outcome='rolled_back'", rollbackAudit.outcome === 'rolled_back')

  const agentAfter = await hl.getAgent(rec.agent_id)
  assert("HL prompt actually restored",            agentAfter.agentPrompt.length === originalPromptLength)
  assert("HL prompt EXACT match to original",      agentAfter.agentPrompt === agentBefore.agentPrompt)

  // 6. History endpoint returns the full trail
  h2('6. History — full audit trail visible')
  const history = ApplyRecommendationService.getHistory(rec.id)
  assert("history has ≥2 attempts",                 history.length >= 2, `count=${history.length}`)
  const latestOutcomes = history.slice(0, 2).map((h) => h.outcome).sort()
  assert("latest 2 attempts: rolled_back + success", JSON.stringify(latestOutcomes) === JSON.stringify(['rolled_back', 'success']))

  // Summary
  h1('SUMMARY')
  const tone = pass === total ? c.green : c.red
  console.log(`  ${c.bold}${tone}${pass}/${total} assertions passed${c.reset}`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => {
  console.error(`\n${c.red}FATAL:${c.reset} ${e.message}`)
  if (e.stack) console.error(e.stack)
  process.exit(3)
})
