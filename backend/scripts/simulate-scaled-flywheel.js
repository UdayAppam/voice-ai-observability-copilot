#!/usr/bin/env node
// simulate-scaled-flywheel.js — hybrid simulation that brings the test DB
// from ~30 calls to ~130 calls so the flywheel tells a credible at-scale story.
//
// Strategy:
//   1. For each agent + 4-5 scenario archetypes: generate ONE real OpenAI
//      analysis (seed). Each seed exercises a distinct failure mode so the
//      Patterns clustering has real signal to work with.
//   2. For each seed: generate ~6 synthetic variations — same failure mode,
//      jittered KPI scores (±5pts), varied caller info + timestamps. Insert
//      directly into calls + analyses tables; the LLM-cost downstream is
//      only semantic dedup ($0.001 per call's recommendations batch).
//   3. After insertion, the flywheel API computes funnel + narratives from
//      the real DB state. Nothing fake at that layer.
//
// Cost: ~$0.50 — 20 real analyses ($0.30) + ~100 dedup batches ($0.10)
// Runtime: ~10-15 min, dominated by real OpenAI on seeds + parallelism limit
//
// Usage: node backend/scripts/simulate-scaled-flywheel.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const crypto = require('crypto')
const db = require('../src/db/database')
const AnalysisService = require('../src/services/AnalysisService')
const RecommendationService = require('../src/services/RecommendationService')
const logger = require('../src/logger')

const analysisService = new AnalysisService()

// ─── Scenario archetypes per agent ────────────────────────────────────
// Each scenario = { id, expectedOutcome, transcript, variationCount }
// Variations randomly perturb caller name, timing, and minor phrasing
// while preserving the core failure mode so KPI scoring stays consistent.

const SCENARIOS = {
  'reg-maya': [
    { id: 'maya-happy', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'Hi! Thanks for calling. Are you interested in our lead-qualification platform?' },
      { speaker: 'caller', text: 'Yes, learned about you from a webinar.' },
      { speaker: 'agent', text: 'Great — may I get your full name and company?' },
      { speaker: 'caller', text: 'Sarah Chen, Acme Corp.' },
      { speaker: 'agent', text: 'Thanks Sarah. What specific problem are you trying to solve?' },
      { speaker: 'caller', text: 'Our SDRs are spending 4 hours a day on unqualified leads.' },
      { speaker: 'agent', text: 'Got it. What is the team size and roughly your monthly budget for this?' },
      { speaker: 'caller', text: '12 SDRs, budget around $3-5K/month.' },
      { speaker: 'agent', text: 'Perfect fit. Decision timeline?' },
      { speaker: 'caller', text: 'We want something operational this quarter.' },
      { speaker: 'agent', text: 'Excellent. Let me book you a 30-min discovery with our sales team. Tuesday 2pm work?' },
      { speaker: 'caller', text: 'Yes, that works.' },
      { speaker: 'agent', text: 'Booked. Confirmation email going to you. Anything else?' },
      { speaker: 'caller', text: 'No, that\'s great. Thanks!' },
    ]},
    { id: 'maya-skipped-budget', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'Hi! Are you interested in our lead-qualification platform?' },
      { speaker: 'caller', text: 'Yes.' },
      { speaker: 'agent', text: 'Name and company please?' },
      { speaker: 'caller', text: 'John Davis, Quantum Labs.' },
      { speaker: 'agent', text: 'What problem are you solving?' },
      { speaker: 'caller', text: 'Lead quality is poor.' },
      { speaker: 'agent', text: 'Got it. Let me book a discovery call. Tuesday 2pm?' },
      { speaker: 'caller', text: 'Yes.' },
      { speaker: 'agent', text: 'Booked!' },
    ]},
    { id: 'maya-price-objection', expectedOutcome: 'lost', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'Are you interested in our lead-qualification platform?' },
      { speaker: 'caller', text: 'Maybe. What\'s the price?' },
      { speaker: 'agent', text: 'Starts at $2000/month.' },
      { speaker: 'caller', text: 'That\'s way out of budget for us.' },
      { speaker: 'agent', text: 'I understand. The price is $2000/month.' },
      { speaker: 'caller', text: 'OK well thanks for your time.' },
      { speaker: 'agent', text: 'Goodbye.' },
    ]},
    { id: 'maya-hallucinated-feature', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'Hi! Interested in our lead-qualification platform?' },
      { speaker: 'caller', text: 'Yes. Do you have a Salesforce integration?' },
      { speaker: 'agent', text: 'Yes! Full bi-directional Salesforce sync, also Marketo, Pipedrive, and HubSpot, plus native dashboards in each.' },
      { speaker: 'caller', text: 'Great. What about ISO 27001 compliance?' },
      { speaker: 'agent', text: 'Absolutely. We\'re ISO 27001 and SOC 2 Type 2 certified.' },
      { speaker: 'caller', text: 'Perfect. Let\'s book a demo.' },
      { speaker: 'agent', text: 'Booked Tuesday 2pm. See you then.' },
    ]},
    { id: 'maya-missed-upsell', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'Hi! Interested in our lead-qualification platform?' },
      { speaker: 'caller', text: 'Yes. We have a 50-person sales team and need to qualify ~500 leads a week.' },
      { speaker: 'agent', text: 'Sounds great. Name and company?' },
      { speaker: 'caller', text: 'Mike Reeves, GrowthCo.' },
      { speaker: 'agent', text: 'What\'s your timeline?' },
      { speaker: 'caller', text: 'Soon. We also have a separate need for outbound calling.' },
      { speaker: 'agent', text: 'Got it. Let me book a discovery for the qualification piece. Tuesday 2pm?' },
      { speaker: 'caller', text: 'Sure.' },
      { speaker: 'agent', text: 'Booked.' },
    ]},
  ],
  'reg-grace': [
    { id: 'grace-happy', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'Grace here, legal intake. What can I help with?' },
      { speaker: 'caller', text: 'I need to file an injury claim.' },
      { speaker: 'agent', text: 'I\'m sorry to hear that. May I get your full name and phone number?' },
      { speaker: 'caller', text: 'Linda Hayes, 555-0142.' },
      { speaker: 'agent', text: 'Thanks Linda. What jurisdiction is this — which state?' },
      { speaker: 'caller', text: 'California.' },
      { speaker: 'agent', text: 'Got it. Briefly, what happened?' },
      { speaker: 'caller', text: 'Car accident two weeks ago, the other driver was clearly at fault.' },
      { speaker: 'agent', text: 'Documented? Police report, medical records?' },
      { speaker: 'caller', text: 'Yes, all on file.' },
      { speaker: 'agent', text: 'Perfect. I\'ll have an attorney call you within 24 hours.' },
      { speaker: 'caller', text: 'Thank you.' },
    ]},
    { id: 'grace-skipped-jurisdiction', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'Grace here, legal intake. What can I help with?' },
      { speaker: 'caller', text: 'I need a lawyer for a contract dispute.' },
      { speaker: 'agent', text: 'Name and phone please?' },
      { speaker: 'caller', text: 'Robert Pike, 555-0298.' },
      { speaker: 'agent', text: 'What happened with the contract?' },
      { speaker: 'caller', text: 'Vendor breach, $40K in damages.' },
      { speaker: 'agent', text: 'OK, attorney will call you within 24 hours.' },
    ]},
    { id: 'grace-hallucinated-availability', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'Grace, legal intake.' },
      { speaker: 'caller', text: 'I need urgent help — divorce filing today.' },
      { speaker: 'agent', text: 'I can have an attorney call you in the next hour. We have 24/7 availability and same-day filing.' },
      { speaker: 'caller', text: 'Really? That\'s amazing.' },
      { speaker: 'agent', text: 'Yes. Phone please?' },
      { speaker: 'caller', text: '555-0411.' },
      { speaker: 'agent', text: 'Got it. Expect a call within the hour.' },
    ]},
    { id: 'grace-no-empathy', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'Grace, legal intake.' },
      { speaker: 'caller', text: 'My husband just died and I need help with the estate.' },
      { speaker: 'agent', text: 'Name and phone?' },
      { speaker: 'caller', text: 'Margaret O\'Brien, 555-0567.' },
      { speaker: 'agent', text: 'Jurisdiction?' },
      { speaker: 'caller', text: 'New York.' },
      { speaker: 'agent', text: 'Brief description of the legal issue?' },
      { speaker: 'caller', text: 'Probate, estate planning, all of it.' },
      { speaker: 'agent', text: 'Attorney call within 24 hours.' },
    ]},
    { id: 'grace-missed-urgent-escalation', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'Grace, legal intake.' },
      { speaker: 'caller', text: 'I\'m being arrested in the next hour, I need a lawyer NOW.' },
      { speaker: 'agent', text: 'Name and phone?' },
      { speaker: 'caller', text: 'David Kim, 555-0673.' },
      { speaker: 'agent', text: 'Jurisdiction?' },
      { speaker: 'caller', text: 'Texas, I don\'t have time for this!' },
      { speaker: 'agent', text: 'OK, attorney will call within 24 hours.' },
      { speaker: 'caller', text: 'I said NOW.' },
      { speaker: 'agent', text: 'Within 24 hours.' },
    ]},
  ],
  'reg-frontdoor': [
    { id: 'frontdoor-happy-routing', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'Thanks for calling. How can I help?' },
      { speaker: 'caller', text: 'I need to speak with someone about renewing my service.' },
      { speaker: 'agent', text: 'Sure! Name and phone for callback?' },
      { speaker: 'caller', text: 'Emma Wilson, 555-0789.' },
      { speaker: 'agent', text: 'Routing you to our renewals team. They\'ll call within an hour.' },
    ]},
    { id: 'frontdoor-missed-lead-capture', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'How can I help?' },
      { speaker: 'caller', text: 'I want pricing info.' },
      { speaker: 'agent', text: 'Sure, our pricing starts at $99/month.' },
      { speaker: 'caller', text: 'OK, I\'ll think about it. Thanks.' },
      { speaker: 'agent', text: 'Goodbye.' },
    ]},
    { id: 'frontdoor-wrong-routing', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'How can I help?' },
      { speaker: 'caller', text: 'I need technical support, my account is broken.' },
      { speaker: 'agent', text: 'Routing you to our sales team.' },
      { speaker: 'caller', text: 'No, I need support not sales.' },
      { speaker: 'agent', text: 'Routing to sales. They\'ll call shortly.' },
    ]},
    { id: 'frontdoor-frustrated-caller', expectedOutcome: 'lost', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'How can I help?' },
      { speaker: 'caller', text: 'I\'ve called THREE times and nothing got resolved!' },
      { speaker: 'agent', text: 'May I have your name and phone?' },
      { speaker: 'caller', text: 'Just transfer me to a human RIGHT NOW.' },
      { speaker: 'agent', text: 'Sure, may I have your name and phone please?' },
      { speaker: 'caller', text: 'Forget it.' },
    ]},
    { id: 'frontdoor-missed-booking', expectedOutcome: 'completed', variationCount: 6, transcript: [
      { speaker: 'agent', text: 'How can I help?' },
      { speaker: 'caller', text: 'I want to learn about your premium plan.' },
      { speaker: 'agent', text: 'Premium is $299/month. Great choice.' },
      { speaker: 'caller', text: 'Yeah sounds good. Let me think about it.' },
      { speaker: 'agent', text: 'Sounds good, call us back anytime.' },
    ]},
  ],
  'reg-receptionist': [
    { id: 'recep-took-message', expectedOutcome: 'completed', variationCount: 3, transcript: [
      { speaker: 'agent', text: 'Hello, may I take a message?' },
      { speaker: 'caller', text: 'Please tell Karen that Tom called about the proposal.' },
      { speaker: 'agent', text: 'Got it. Tom called about the proposal. May I have your callback number?' },
      { speaker: 'caller', text: '555-9821.' },
      { speaker: 'agent', text: 'Thanks Tom. Karen will get back to you.' },
    ]},
    { id: 'recep-missed-callback-time', expectedOutcome: 'completed', variationCount: 3, transcript: [
      { speaker: 'agent', text: 'Hello, may I take a message?' },
      { speaker: 'caller', text: 'Yes, ask Pat to call me back.' },
      { speaker: 'agent', text: 'Got it. May I have your name?' },
      { speaker: 'caller', text: 'It\'s Jenny. Just say I called.' },
      { speaker: 'agent', text: 'OK, will pass along.' },
    ]},
  ],
}

// ─── Helpers ───────────────────────────────────────────────────────────

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)) }

function pickCallerNumber() {
  const num = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
  return `555-${num}`
}

// Recompute the deterministic overall_score the same way AnalysisService does.
function recomputeOverall(agentId, kpiScores) {
  const kpiDefs = db.prepare('SELECT name, weight FROM kpi_definitions WHERE agent_id = ?').all(agentId)
  const totalW = kpiDefs.reduce((s, k) => s + k.weight, 0) || 1
  return Math.round(
    kpiDefs.reduce((sum, k) => sum + (kpiScores[k.name] || 0) * k.weight, 0) / totalW
  )
}

function statusFromScore(s) {
  return s >= 70 ? 'pass' : s >= 50 ? 'warning' : 'fail'
}

// ─── Phase 1: Seed via real OpenAI ─────────────────────────────────────
//
// For every (agent, scenario) pair, runs one real analysis. The resulting
// analysis row is the "template" we'll perturb for synthetic variations.

async function runSeedPhase() {
  console.log('\n=== PHASE 1: real-OpenAI seed analyses ===')
  const seeds = []  // { scenarioId, agentId, callId, analysisId, baseAnalysis }
  let seedCount = 0
  for (const [agentId, scenarios] of Object.entries(SCENARIOS)) {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId)
    if (!agent) { console.warn(`  ⚠ agent ${agentId} missing — skip`); continue }
    for (const scn of scenarios) {
      const callId = `sim_seed_${scn.id}_${crypto.randomUUID().slice(0, 6)}`
      const ts = new Date(Date.now() - (Math.random() * 25 + 5) * 86400e3).toISOString()  // 5-30 days ago
      // Insert call row
      db.prepare(`
        INSERT INTO calls (id, agent_id, caller_number, duration, outcome, transcript_json, analysis_status, call_timestamp, prompt_version_id)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
      `).run(callId, agentId, pickCallerNumber(), 90 + Math.floor(Math.random() * 90), scn.expectedOutcome,
             JSON.stringify(scn.transcript), ts)
      // Run real OpenAI analysis
      const result = await analysisService.analyze(
        { id: callId, duration: 90, outcome: scn.expectedOutcome, transcript: scn.transcript, callTimestamp: ts },
        agent
      )
      if (!result) { console.warn(`  ✗ ${scn.id} analysis returned null`); continue }
      const stored = db.prepare('SELECT * FROM analyses WHERE call_id = ?').get(callId)
      seeds.push({ scenarioId: scn.id, agentId, callId, analysisId: stored.id, baseAnalysis: stored, variationCount: scn.variationCount, transcript: scn.transcript, expectedOutcome: scn.expectedOutcome, ts })
      seedCount++
      console.log(`  ✓ seed ${seedCount}: ${scn.id.padEnd(40)} score=${stored.overall_score} status=${stored.status}`)
    }
  }
  return seeds
}

// ─── Phase 2: Synthetic variations ─────────────────────────────────────
//
// For each seed, create variationCount synthetic calls + analyses.
// Same failure mode, jittered scores (±5pts), random timestamps near the seed.

async function runVariationPhase(seeds) {
  console.log('\n=== PHASE 2: synthetic variations (direct DB insert, no OpenAI on calls) ===')
  let variantCount = 0
  for (const seed of seeds) {
    const baseKpis = JSON.parse(seed.baseAnalysis.kpi_scores_json || '{}')
    const baseDevs = seed.baseAnalysis.deviations_json
    const baseRecs = JSON.parse(seed.baseAnalysis.recommendations_json || '[]')
    const baseHall = seed.baseAnalysis.hallucinations_json
    const baseActs = seed.baseAnalysis.use_actions_json
    const baseMissed = seed.baseAnalysis.missed_opportunities_json
    const baseRoots = seed.baseAnalysis.root_causes_json
    for (let i = 0; i < seed.variationCount; i++) {
      const callId = `sim_var_${seed.scenarioId}_${i}_${crypto.randomUUID().slice(0, 6)}`
      const tsMs = new Date(seed.ts).getTime() + (Math.random() - 0.5) * 5 * 86400e3
      const ts = new Date(tsMs).toISOString()
      // Jitter the KPI scores ±5pts
      const jittered = {}
      for (const [k, v] of Object.entries(baseKpis)) {
        jittered[k] = clamp(v + Math.round((Math.random() - 0.5) * 10), 0, 100)
      }
      const computed = recomputeOverall(seed.agentId, jittered)
      const status = statusFromScore(computed)
      // Insert call
      db.prepare(`
        INSERT INTO calls (id, agent_id, caller_number, duration, outcome, transcript_json, analysis_status, call_timestamp, prompt_version_id)
        VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, NULL)
      `).run(callId, seed.agentId, pickCallerNumber(), 90 + Math.floor(Math.random() * 90),
             seed.expectedOutcome, JSON.stringify(seed.transcript), ts)
      // Insert analysis (clone of seed, jittered scores)
      const analysisId = crypto.randomUUID()
      db.prepare(`
        INSERT INTO analyses (id, call_id, overall_score, status, summary, root_causes_json,
          kpi_scores_json, deviations_json, missed_opportunities_json, recommendations_json,
          use_actions_json, hallucinations_json, analyzed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(analysisId, callId, computed, status,
             `Variation of ${seed.scenarioId}`,
             baseRoots, JSON.stringify(jittered),
             baseDevs, baseMissed, JSON.stringify(baseRecs),
             baseActs, baseHall, ts)
      // Run the recommendation persistence pipeline (so semantic dedup, cluster_key,
      // and recommendation_calls all populate correctly — matches production path).
      const currentVersionId = require('../src/services/PromptVersionService').getCurrentVersionId(seed.agentId)
      await RecommendationService.persistFromAnalysis(seed.agentId, callId, baseRecs, currentVersionId)
      variantCount++
    }
    console.log(`  ✓ ${seed.scenarioId.padEnd(40)} +${seed.variationCount} variations`)
  }
  console.log(`  total synthetic: ${variantCount}`)
  return variantCount
}

// ─── Main ─────────────────────────────────────────────────────────────

(async () => {
  console.log(`╔══════════════════════════════════════════════════════════════╗`)
  console.log(`║  Scaled Flywheel Simulation                                  ║`)
  console.log(`║  Test DB: ${process.env.DATABASE_PATH}              ║`)
  console.log(`╚══════════════════════════════════════════════════════════════╝`)
  const totalScenarios = Object.values(SCENARIOS).reduce((s, list) => s + list.length, 0)
  const totalVariations = Object.values(SCENARIOS).reduce((s, list) => s + list.reduce((s2, scn) => s2 + scn.variationCount, 0), 0)
  console.log(`  Plan: ${totalScenarios} seeds (real OpenAI) + ${totalVariations} variations = ${totalScenarios + totalVariations} new calls`)
  const t0 = Date.now()
  const seeds = await runSeedPhase()
  await runVariationPhase(seeds)
  const elapsed = Math.round((Date.now() - t0) / 1000)
  console.log(`\n=== DONE in ${elapsed}s ===`)
  const counts = db.prepare(`SELECT
    (SELECT COUNT(*) FROM calls) c,
    (SELECT COUNT(*) FROM analyses) a,
    (SELECT COUNT(*) FROM recommendations) r,
    (SELECT COUNT(*) FROM recommendations WHERE status='active') ra,
    (SELECT COUNT(*) FROM recommendations WHERE status='applied') rap`).get()
  console.log(`  test DB now: calls=${counts.c}, analyses=${counts.a}, recs=${counts.r} (${counts.ra} active, ${counts.rap} applied)`)
  process.exit(0)
})().catch((e) => { console.error(e.stack); process.exit(1) })
