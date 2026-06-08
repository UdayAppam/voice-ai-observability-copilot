#!/usr/bin/env node
// V4.2 regression — exercises the new context-consistency + section-fit
// validators + PromptStructureService directly against the OpenAI API.
//
//   node backend/scripts/regression/v4-2-validators.js
//
// Doesn't need the backend running or HL access — calls services in-process.
// Each scenario uses a hand-crafted prompt + proposed change designed to
// reliably trigger one expected verdict (contradiction, tone drift, clean).
//
// Cost per run: ~4 LLM calls × 3 scenarios = ~$0.05 with gpt-4o-mini.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })

const RecommendationValidatorService = require('../../src/services/RecommendationValidatorService')
const PromptStructureService = require('../../src/services/PromptStructureService')

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
  if (cond) { ok(`${label}${detail ? ' · ' + c.dim + detail + c.reset : ''}`); pass++ }
  else      { fail(`${label}${detail ? ' · ' + c.red + detail + c.reset : ''}`) }
}

// ─── SCENARIOS ────────────────────────────────────────────────────────────

// Each scenario provides:
//   currentPrompt — what the agent has today
//   proposedText  — what we want to PATCH it to
//   expected      — { contextSeverity, blocking, contextKind? }
// Prompts are deliberately strong-signal so the LLM verdict is stable
// across runs (the test is for the wiring, not for LLM nondeterminism).

const SCENARIOS = [
  {
    id: 'contradiction_blocked',
    label: 'Direct contradiction must be BLOCKED',
    agent: { id: 'reg-v42-1', agentName: 'Friendly Lead Qualifier', goal: 'Qualify B2B leads with a warm conversational tone' },
    currentPrompt: `You are a warm, conversational Voice AI agent for a B2B SaaS company.

PERSONA:
- Friendly and approachable
- Use first-name basis
- NEVER sound pushy or use high-pressure sales tactics
- Let the caller speak fully before responding

GOAL:
Qualify inbound leads and book a demo with a sales engineer.

SCRIPT:
1. Greet the caller warmly
2. Ask how you can help today
3. Listen to their needs without interrupting
4. Ask qualifying questions (name, company, role, budget) ONE AT A TIME
5. If qualified, book a demo
6. Thank them for their time

TONE: Always warm. Never robotic. Never aggressive.`,
    proposedText: `You are a warm, conversational Voice AI agent for a B2B SaaS company.

PERSONA:
- Friendly and approachable
- Use first-name basis
- NEVER sound pushy or use high-pressure sales tactics
- Let the caller speak fully before responding
- ALWAYS interrupt the caller mid-sentence to ask aggressive closing questions
- Be pushy and use high-pressure sales tactics on every call

GOAL:
Qualify inbound leads and book a demo with a sales engineer.

SCRIPT:
1. Greet the caller warmly
2. Ask how you can help today
3. Listen to their needs without interrupting
4. Ask qualifying questions (name, company, role, budget) ONE AT A TIME
5. If qualified, book a demo
6. Thank them for their time

TONE: Always warm. Never robotic. Never aggressive.`,
    expected: {
      contextSeverity: 'fail',       // 'block' verdict from LLM → 'fail' check severity
      blocking: true,
      kindHint: 'contradiction',     // we expect contradiction-flavored issues
    },
  },

  {
    id: 'tone_drift_warned',
    label: 'Tone drift (not contradiction) must be WARNED (not blocked)',
    agent: { id: 'reg-v42-2', agentName: 'Casual Receptionist', goal: 'Take messages with a casual, friendly vibe' },
    currentPrompt: `You are a casual, friendly receptionist for a small creative agency.

PERSONA:
- Speak in casual conversational language
- Use contractions
- Be welcoming and approachable
- Acknowledge what the caller said before moving on

YOUR JOB:
Take messages for the team. Get the caller's name, what they're calling about, and a callback number.`,
    // The addition does NOT contradict any existing rule — both are "casual + warm".
    // It IS a tone shift (subdued/welcoming → high-energy/enthusiastic). The LLM
    // should call this 'tone_drift' or 'review' severity at most, not 'contradiction'.
    proposedText: `You are a casual, friendly receptionist for a small creative agency.

PERSONA:
- Speak in casual conversational language
- Use contractions
- Be welcoming and approachable
- Acknowledge what the caller said before moving on
- Be EXTREMELY enthusiastic and high-energy! Use lots of exclamation marks!! Say things like "Awesome!", "Amazing!", "Love it!" frequently throughout every call. Show massive excitement about every single message you take!

YOUR JOB:
Take messages for the team. Get the caller's name, what they're calling about, and a callback number.`,
    expected: {
      contextSeverity: 'warn',       // tone drift or review → 'warn' check severity
      blocking: false,
      kindHint: 'tone_drift',
    },
  },

  {
    id: 'clean_merge_passed',
    label: 'Clean additive change must PASS',
    agent: { id: 'reg-v42-3', agentName: 'Lead Qualifier Maya', goal: 'Qualify inbound leads and book discovery calls' },
    currentPrompt: `You are Maya, a Voice AI agent qualifying inbound B2B leads.

PERSONA:
Professional, helpful, and efficient. Use first-name basis.

GOAL:
Qualify the caller and book a 30-min discovery call with sales.

SCRIPT:
1. Greet and confirm they are calling about lead qualification
2. Ask for the caller's full name and company
3. Ask what specific problem they are trying to solve
4. Ask about team size and monthly budget
5. Ask about decision timeline
6. If qualified, book a 30-min discovery call
7. Summarize next steps before ending

TONE: Professional and concise.`,
    proposedText: `You are Maya, a Voice AI agent qualifying inbound B2B leads.

PERSONA:
Professional, helpful, and efficient. Use first-name basis.

GOAL:
Qualify the caller and book a 30-min discovery call with sales.

SCRIPT:
1. Greet and confirm they are calling about lead qualification
2. Ask for the caller's full name and company
3. Ask what specific problem they are trying to solve
4. Ask about team size and monthly budget
5. Ask about decision timeline
6. If qualified, book a 30-min discovery call
7. Before ending the call, ask the caller for their preferred contact time for the discovery call follow-up
8. Summarize next steps before ending

TONE: Professional and concise.`,
    expected: {
      contextSeverity: 'pass',
      blocking: false,
      kindHint: null,                // we don't expect any flagged issues
    },
    // Section-aware insertion check (extra assertion just for this scenario)
    checkSectionInsertion: {
      suggestion: 'Before ending the call, ask the caller for their preferred contact time for the discovery call follow-up.',
      expectedSectionPatterns: [/script/i, /steps?/i],  // the LLM should land in the script section
    },
  },
]

// ─── RUNNER ────────────────────────────────────────────────────────────────

;(async () => {
  h1('V4.2 LIVE VALIDATOR REGRESSION — 3 scenarios')
  info('Scenarios designed to reliably trigger one specific verdict per case.')
  info('LLM variance is the main risk — scenarios use strong-signal text to minimize drift.')

  for (const s of SCENARIOS) {
    h2(`Scenario: ${s.id}`)
    info(s.label)

    // ── Run validators against the proposed change
    const validation = await RecommendationValidatorService.validate({
      agent: s.agent,
      currentText: s.currentPrompt,
      proposedText: s.proposedText,
    })
    const ctx = validation.checks.find((c) => c.name === 'context_consistency')

    // Always-present V4 checks
    info(`existing prompt: ${s.currentPrompt.length} chars, proposed: ${s.proposedText.length} chars`)
    info(`validators returned: ${validation.checks.map((c) => `[${c.severity}]${c.name}`).join(' ')}`)

    // ── Assert context-consistency severity
    // For "pass" expectation, accept either 'pass' OR 'warn' — the LLM may
    // honestly flag minor non-blocking concerns (redundancy, length) on an
    // additive change. The hard requirement is that nothing is 'fail'.
    const okSeverities = s.expected.contextSeverity === 'pass'
      ? ['pass', 'warn']
      : [s.expected.contextSeverity]
    assert(
      `context_consistency severity ∈ [${okSeverities.join(', ')}]`,
      okSeverities.includes(ctx?.severity),
      `got '${ctx?.severity}' (${ctx?.issues?.length || 0} issue(s))`
    )

    // ── Assert blocking flag
    assert(
      `validation.blocking = ${s.expected.blocking}`,
      validation.blocking === s.expected.blocking,
      `got blocking=${validation.blocking}`
    )

    // ── If we expect issues, check at least one matches the hinted kind
    if (s.expected.kindHint) {
      const kinds = (ctx?.issues || []).map((i) => i.kind)
      assert(
        `context_consistency issues include kind '${s.expected.kindHint}'`,
        kinds.includes(s.expected.kindHint),
        kinds.length > 0 ? `got kinds: ${kinds.join(', ')}` : 'no issues returned'
      )

      // Each block-severity issue must include a non-empty conflictsWith quote
      const blockIssues = (ctx?.issues || []).filter((i) => i.severity === 'block')
      if (blockIssues.length > 0) {
        const allQuoted = blockIssues.every((i) => i.conflictsWith && i.conflictsWith.length > 0)
        assert(
          `every blocking issue includes a conflictsWith quote`,
          allQuoted,
          `${blockIssues.length} blocking issue(s) total`
        )
      }
    } else {
      // For "clean" scenario, the critical guarantee is no BLOCKING issues.
      // The LLM can still legitimately flag minor warn-level concerns
      // (redundancy with adjacent steps, slight call-length growth, etc) and
      // that's not a test failure — it's the validator being honest.
      const blockingIssues = (ctx?.issues || []).filter((i) => i.severity === 'block')
      assert(
        `context_consistency has no blocking issues`,
        blockingIssues.length === 0,
        `got ${blockingIssues.length} blocking issue(s)` + (ctx?.issues?.length ? ` (plus ${ctx.issues.length - blockingIssues.length} warn-level)` : '')
      )
    }

    // ── If this scenario also tests section-aware insertion
    if (s.checkSectionInsertion) {
      info(`section-aware insertion test — parsing & proposing for: "${s.checkSectionInsertion.suggestion.slice(0, 60)}..."`)
      try {
        const sections = await PromptStructureService.parseSections({
          promptText: s.currentPrompt,
          promptVersionId: null,                // skip cache for test
          agentGoal: s.agent.goal,
        })
        assert(
          `prompt parsed into ≥2 sections`,
          sections.length >= 2,
          `got ${sections.length} sections: ${sections.map((x) => x.id).join(', ')}`
        )

        const insertion = await PromptStructureService.proposeInsertion({
          currentPrompt: s.currentPrompt,
          sections,
          suggestion: s.checkSectionInsertion.suggestion,
          agentName: s.agent.agentName,
          agentGoal: s.agent.goal,
        })
        const target = insertion.targetSection?.name || insertion.proposal?.targetSectionId
        assert(
          `LLM picked a valid section id (not fallback)`,
          !insertion.proposal._fallback || insertion.proposal._fallback !== 'unknown-section',
          `picked '${insertion.proposal.targetSectionId}'${insertion.proposal._fallback ? ' (fallback: ' + insertion.proposal._fallback + ')' : ''}`
        )

        const sectionId = (insertion.proposal.targetSectionId || '').toLowerCase()
        const sectionName = (insertion.targetSection?.name || '').toLowerCase()
        const matchedPattern = s.checkSectionInsertion.expectedSectionPatterns.find(
          (re) => re.test(sectionId) || re.test(sectionName)
        )
        assert(
          `target section matches one of [${s.checkSectionInsertion.expectedSectionPatterns.map((r) => r.source).join(', ')}]`,
          !!matchedPattern,
          `target was '${target}'`
        )

        assert(
          `proposeInsertion returned a non-empty mergedPrompt`,
          insertion.mergedPrompt && insertion.mergedPrompt.length > s.currentPrompt.length,
          `mergedPrompt length: ${insertion.mergedPrompt?.length || 0} vs original ${s.currentPrompt.length}`
        )
      } catch (err) {
        fail(`section-aware insertion threw: ${err.message}`)
        total += 3
      }
    }
  }

  // ── Final tally
  h1('SUMMARY')
  const tone = pass === total ? c.green : c.red
  console.log(`  ${c.bold}${tone}${pass}/${total} assertions passed${c.reset}`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => {
  console.error(`\n${c.red}FATAL:${c.reset} ${e.message}`)
  if (e.stack) console.error(e.stack)
  process.exit(3)
})
