#!/usr/bin/env node
// bench-parse-sections-ab.js — A/B latency test for the parseSections optimization.
// Runs the CURRENT (verbatim text) approach and the PROPOSED (offsets) approach
// against the same live agent prompt, multiple times each, reports median + range.
//
// Output answers the GO/NO-GO question: does the offset schema actually cut LLM
// response time, or is the LLM bottleneck independent of output size?

require('dotenv').config({ path: __dirname + '/../.env' })
const OpenAI = require('openai')
const db = require('../src/db/database')

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const RUNS_PER_VARIANT = 3

// ── Schemas ───────────────────────────────────────────────────────────
// Current production schema — LLM must output FULL verbatim section text
const SCHEMA_VERBATIM = {
  type: 'object', additionalProperties: false, required: ['sections'],
  properties: {
    sections: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'name', 'summary', 'text'],
      properties: {
        id:      { type: 'string' },
        name:    { type: 'string' },
        summary: { type: 'string' },
        text:    { type: 'string', description: 'EXACT verbatim text of this section' },
      },
    }},
  },
}

// Proposed schema — LLM returns offsets only, backend slices text
const SCHEMA_OFFSETS = {
  type: 'object', additionalProperties: false, required: ['sections'],
  properties: {
    sections: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'name', 'summary', 'startOffset', 'endOffset'],
      properties: {
        id:           { type: 'string' },
        name:         { type: 'string' },
        summary:      { type: 'string' },
        startOffset:  { type: 'integer', description: 'inclusive starting char index in the original prompt (0-based)' },
        endOffset:    { type: 'integer', description: 'exclusive ending char index in the original prompt' },
      },
    }},
  },
}

const SYSTEM_VERBATIM =
  `You parse Voice AI agent prompts into named sections. Typical sections: ` +
  `Persona, Goals, Script/Steps, Tone Guidelines, Knowledge Base, Closing. ` +
  `For each section's "text" field: copy the EXACT verbatim characters from the prompt ` +
  `(we splice modified sections back by finding this substring). Sections must be ` +
  `contiguous and non-overlapping.`

const SYSTEM_OFFSETS =
  `You parse Voice AI agent prompts into named sections covering the ENTIRE prompt.\n\n` +
  `STRICT RULES — every character of the prompt MUST belong to exactly one section:\n` +
  `1. First section's startOffset MUST be 0.\n` +
  `2. Each section's endOffset MUST equal the next section's startOffset (no gaps).\n` +
  `3. Last section's endOffset MUST equal the total prompt length given to you.\n` +
  `4. Sections must NOT overlap (each char belongs to exactly one section).\n` +
  `5. A section spans from its header through to (but excluding) the next section's header.\n\n` +
  `Typical sections in Voice AI prompts: Persona, Goals, Script/Steps, Tone Guidelines, ` +
  `Knowledge Base, Closing Instructions, Handoff Rules. Identify what's actually present — ` +
  `don't invent sections. The whole prompt's content (headers + body text under each) ` +
  `is split among the sections. There should be no body text between sections that ` +
  `belongs to neither.\n\n` +
  `Example: a 1000-char prompt with 3 sections might be parsed as:\n` +
  `  { id: "persona", startOffset: 0,   endOffset: 300 }  ← from start through to "GOALS:" line\n` +
  `  { id: "goals",   startOffset: 300, endOffset: 650 }  ← from "GOALS:" through to "SCRIPT:"\n` +
  `  { id: "script",  startOffset: 650, endOffset: 1000 } ← from "SCRIPT:" through end of prompt\n` +
  `Total span = 1000 = prompt length. No gaps. No overlaps.`

// ── Runners ───────────────────────────────────────────────────────────
async function runVariant(label, system, schema, promptText, agentGoal) {
  const start = Date.now()
  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_schema', json_schema: {
      name: 'parse_prompt_sections', strict: true, schema,
    }},
    messages: [
      { role: 'system', content: system },
      { role: 'user', content:
        (agentGoal ? `AGENT GOAL: ${agentGoal}\n\n` : '') +
        `FULL PROMPT (${promptText.length} chars):\n${promptText}` },
    ],
  })
  const latencyMs = Date.now() - start
  const parsed = JSON.parse(res.choices[0].message.content)
  const outputTokens = res.usage.completion_tokens
  return {
    latencyMs,
    outputTokens,
    sectionCount: parsed.sections.length,
    raw: parsed,
  }
}

function quickAccuracyCheck(promptText, offsetResult) {
  // For the offset variant: validate that the offsets actually carve up the
  // prompt sensibly. Used as a "does the LLM even get this right?" check.
  const sections = offsetResult.raw.sections
  let prev = -1
  const issues = []
  for (const s of sections) {
    if (s.startOffset < 0 || s.endOffset > promptText.length) {
      issues.push(`section "${s.id}" offsets out of range`)
    }
    if (s.endOffset <= s.startOffset) {
      issues.push(`section "${s.id}" has end <= start`)
    }
    if (s.startOffset < prev) {
      issues.push(`section "${s.id}" overlaps prior`)
    }
    prev = s.endOffset
  }
  const totalSpan = sections.reduce((s, x) => s + (x.endOffset - x.startOffset), 0)
  const coverage = totalSpan / promptText.length
  return { issues, coverage, totalSpan }
}

// ── Main ──────────────────────────────────────────────────────────────
;(async () => {
  // Find a real live agent with a sizeable prompt
  const recordWithPrompt = db.prepare(`
    SELECT apv.prompt_text, agt.goal, agt.name
    FROM agent_prompt_versions apv
    JOIN agents agt ON agt.id = apv.agent_id
    WHERE apv.agent_id NOT LIKE 'reg-%' AND LENGTH(apv.prompt_text) > 3000
    ORDER BY LENGTH(apv.prompt_text) DESC LIMIT 1
  `).get()
  if (!recordWithPrompt) {
    console.error('No live agent with prompt > 3000 chars; aborting')
    process.exit(1)
  }
  const { prompt_text: promptText, goal, name } = recordWithPrompt
  console.log(`╔══════════════════════════════════════════════════════════════════════════╗`)
  console.log(`║ parseSections A/B benchmark                                              ║`)
  console.log(`║ Model: ${MODEL.padEnd(67)}║`)
  console.log(`║ Agent: ${name.slice(0, 30).padEnd(15)} prompt: ${promptText.length} chars                       ║`)
  console.log(`║ Runs per variant: ${RUNS_PER_VARIANT}                                                     ║`)
  console.log(`╚══════════════════════════════════════════════════════════════════════════╝\n`)

  const results = { verbatim: [], offsets: [] }
  for (let i = 0; i < RUNS_PER_VARIANT; i++) {
    console.log(`── Run ${i+1}/${RUNS_PER_VARIANT} ──`)
    try {
      const v = await runVariant('VERBATIM', SYSTEM_VERBATIM, SCHEMA_VERBATIM, promptText, goal)
      console.log(`  VERBATIM  latency=${v.latencyMs.toString().padStart(6)}ms · output_tokens=${v.outputTokens} · sections=${v.sectionCount}`)
      results.verbatim.push(v)
    } catch (e) {
      console.log(`  VERBATIM  ERROR: ${e.message}`)
    }
    try {
      const o = await runVariant('OFFSETS', SYSTEM_OFFSETS, SCHEMA_OFFSETS, promptText, goal)
      const check = quickAccuracyCheck(promptText, o)
      console.log(`  OFFSETS   latency=${o.latencyMs.toString().padStart(6)}ms · output_tokens=${o.outputTokens} · sections=${o.sectionCount} · coverage=${Math.round(check.coverage * 100)}% · issues=${check.issues.length}`)
      if (check.issues.length) console.log(`            ⚠ ` + check.issues.join('; '))
      results.offsets.push({ ...o, check })
    } catch (e) {
      console.log(`  OFFSETS   ERROR: ${e.message}`)
    }
  }

  console.log(`\n╔══════════════════════════════════════════════════════════════════════════╗`)
  console.log(`║ SUMMARY                                                                  ║`)
  console.log(`╚══════════════════════════════════════════════════════════════════════════╝`)
  function stats(label, arr, key = 'latencyMs') {
    if (arr.length === 0) { console.log(`  ${label}: (no successful runs)`); return null }
    const sorted = arr.map((r) => r[key]).sort((a,b) => a-b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const min = sorted[0]
    const max = sorted[sorted.length - 1]
    return { median, min, max, sorted }
  }

  const v = stats('verbatim', results.verbatim)
  const o = stats('offsets',  results.offsets)
  const vt = stats('verbatim tokens', results.verbatim, 'outputTokens')
  const ot = stats('offsets  tokens', results.offsets,  'outputTokens')

  console.log()
  console.log(`  Latency (ms):`)
  console.log(`    VERBATIM  median=${v?.median ?? '—'}  min=${v?.min ?? '—'}  max=${v?.max ?? '—'}`)
  console.log(`    OFFSETS   median=${o?.median ?? '—'}  min=${o?.min ?? '—'}  max=${o?.max ?? '—'}`)
  if (v && o) {
    const speedup = (v.median / o.median).toFixed(2)
    const pctSaved = Math.round((1 - o.median / v.median) * 100)
    console.log(`    >>> OFFSETS is ${speedup}× faster (saves ${pctSaved}% of median latency)`)
  }
  console.log()
  console.log(`  Output tokens:`)
  console.log(`    VERBATIM  median=${vt?.median}`)
  console.log(`    OFFSETS   median=${ot?.median}`)
  console.log()
  console.log(`  Offset-variant accuracy:`)
  const allIssues = results.offsets.flatMap((r) => r.check.issues || [])
  const totalCov = results.offsets.reduce((s, r) => s + r.check.coverage, 0) / results.offsets.length
  console.log(`    avg coverage: ${Math.round(totalCov * 100)}%`)
  console.log(`    total validation issues across ${results.offsets.length} runs: ${allIssues.length}`)
  if (allIssues.length) console.log(`      e.g.: ` + allIssues.slice(0, 3).join('; '))

  console.log()
  if (v && o) {
    if (o.median <= v.median * 0.5) {
      console.log(`  🟢 GO  — OFFSETS variant ≥2× faster median. Proceed with safeguarded implementation.`)
    } else if (o.median <= v.median * 0.8) {
      console.log(`  🟡 CONSIDER  — only ${Math.round((1 - o.median/v.median)*100)}% savings. Worth it if accuracy holds; less compelling than predicted.`)
    } else {
      console.log(`  🔴 NO-GO  — latency savings under 20%. The bottleneck isn't output size. Abort and consider Fix #2 or #3 instead.`)
    }
  }
  process.exit(0)
})().catch((e) => { console.error(e.stack); process.exit(1) })
