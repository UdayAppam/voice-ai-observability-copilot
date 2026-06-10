// PromptStructureService — V4.2
//
// Two responsibilities:
//   1. parseSections(promptText, promptVersionId)  — LLM-parse the agent's prompt
//      into named sections (Persona / Goals / Script / Tone / etc). Result is
//      cached per prompt_version_id in agent_prompt_structure so each distinct
//      prompt is parsed once.
//
//   2. proposeInsertion(currentPrompt, sections, suggestion, agentGoal) — LLM
//      decides which section the snippet belongs in + reassembles the full
//      prompt with the snippet inserted in the right place (not blindly
//      appended to the end).
//
// Both calls use OpenAI strict JSON schema; no defensive parsing in callers.

const OpenAI = require('openai')
const crypto = require('crypto')
const db = require('../db/database')
const logger = require('../logger')

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

// V5.7 — parser version 2.0 switches to offset-based LLM output (LLM returns
// char offsets, backend slices verbatim text). ~4-5× faster median latency on
// large prompts (benchmark: 47s → 9-18s). Bumping the version invalidates any
// v1.0 cached rows, which get auto-overwritten on next read.
const PARSER_VERSION = '2.0'

// Coverage threshold for accepting offset-based output. The LLM sometimes
// returns header-only sections that don't span the full prompt — we require
// at least 70% total coverage; otherwise retry, then fall back to verbatim.
const OFFSET_COVERAGE_THRESHOLD = 0.7

// JSON schema — OFFSET variant (production path).
// Output: ~80 chars per section vs ~600 for verbatim. Drives the latency win.
const PARSE_SCHEMA_OFFSETS = {
  type: 'object',
  additionalProperties: false,
  required: ['sections'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'summary', 'startOffset', 'endOffset'],
        properties: {
          id:          { type: 'string',  description: 'lowercase snake-case identifier' },
          name:        { type: 'string',  description: 'human-readable section name' },
          summary:     { type: 'string',  description: 'one-line description of what this section governs' },
          startOffset: { type: 'integer', description: 'inclusive 0-based char index where this section begins' },
          endOffset:   { type: 'integer', description: 'exclusive char index where this section ends' },
        },
      },
    },
  },
}

// JSON schema — VERBATIM variant (fallback when offset validation fails twice).
const PARSE_SCHEMA_VERBATIM = {
  type: 'object',
  additionalProperties: false,
  required: ['sections'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'summary', 'text'],
        properties: {
          id:      { type: 'string' },
          name:    { type: 'string' },
          summary: { type: 'string' },
          text:    { type: 'string', description: 'EXACT verbatim text — must be a contiguous substring of the prompt' },
        },
      },
    },
  },
}

// JSON schema for the insertion proposal.
const INSERTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['targetSectionId', 'insertionMode', 'modifiedSectionText', 'reasoning', 'confidence'],
  properties: {
    targetSectionId: { type: 'string', description: 'id of the section to modify' },
    insertionMode:   { type: 'string', enum: ['append_to_section', 'prepend_to_section', 'replace_section', 'insert_after_first_paragraph'] },
    modifiedSectionText: { type: 'string', description: 'the FULL text of the section after the change is applied — verbatim, ready to splice in' },
    reasoning:       { type: 'string', description: 'one-sentence rationale for the chosen section + insertion mode' },
    confidence:      { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

class PromptStructureService {
  // ── parseSections ──────────────────────────────────────────────────────
  // Returns: [{ id, name, summary, text }]
  // Cached by prompt_version_id. The first parse for a given prompt is the
  // only paid OpenAI call; subsequent reads are pure SQL.
  static async parseSections({ promptText, promptVersionId, agentGoal }) {
    if (promptVersionId) {
      const cached = db.prepare(
        'SELECT sections_json, parser_version FROM agent_prompt_structure WHERE prompt_version_id = ?'
      ).get(promptVersionId)
      if (cached && cached.parser_version === PARSER_VERSION) {
        return JSON.parse(cached.sections_json)
      }
    }

    const sections = await this._parseWithSafeguards(promptText, agentGoal)

    if (promptVersionId) {
      // INSERT OR REPLACE — if parser_version changed we overwrite the stale cache
      db.prepare(`
        INSERT INTO agent_prompt_structure (prompt_version_id, parsed_at, sections_json, parser_version)
        VALUES (?, datetime('now'), ?, ?)
        ON CONFLICT(prompt_version_id) DO UPDATE SET
          parsed_at = datetime('now'),
          sections_json = excluded.sections_json,
          parser_version = excluded.parser_version
      `).run(promptVersionId, JSON.stringify(sections), PARSER_VERSION)
    }

    return sections
  }

  // V5.7 — safeguarded parsing. Tries the fast offset approach up to 2 times.
  // If both attempts produce low coverage (LLM didn't cover the whole prompt),
  // falls back to the slower-but-deterministic verbatim approach.
  //
  // Fallback rate is logged at INFO level so we can monitor in production —
  // if it climbs above ~25%, the offset approach isn't working and we should
  // revisit prompt engineering or schema design.
  static async _parseWithSafeguards(promptText, agentGoal) {
    const t0 = Date.now()
    // Attempt 1 — offset schema
    let attempt = 1
    let lastResult = null
    while (attempt <= 2) {
      try {
        const offsetSections = await this._llmParseOffsets(promptText, agentGoal)
        const validation = this._validateOffsets(offsetSections, promptText)
        if (validation.ok) {
          const sections = this._materialiseFromOffsets(offsetSections, promptText)
          logger.info(
            { sectionCount: sections.length, promptLen: promptText.length, attempt, latencyMs: Date.now() - t0, path: 'offsets', coverage: validation.coverage },
            'PromptStructure: parsed (offset path)'
          )
          return sections
        }
        lastResult = validation
        logger.warn(
          { attempt, coverage: validation.coverage, issues: validation.issues.slice(0, 3) },
          'PromptStructure: offset attempt failed validation, retrying'
        )
      } catch (err) {
        logger.warn({ attempt, err: err.message }, 'PromptStructure: offset LLM call threw, retrying')
      }
      attempt++
    }
    // Both offset attempts failed — fall back to verbatim
    logger.warn(
      { promptLen: promptText.length, lastCoverage: lastResult?.coverage },
      'PromptStructure: falling back to verbatim path (offset attempts exhausted)'
    )
    const sections = await this._llmParseVerbatim(promptText, agentGoal)
    logger.info(
      { sectionCount: sections.length, promptLen: promptText.length, latencyMs: Date.now() - t0, path: 'verbatim-fallback' },
      'PromptStructure: parsed (verbatim fallback)'
    )
    return sections
  }

  // V5.7 — offset-based LLM call. ~5× faster than verbatim on large prompts
  // because output token count drops from ~prompt_len to ~80 chars per section.
  // Caller must validate offsets before trusting them — see _validateOffsets.
  static async _llmParseOffsets(promptText, agentGoal) {
    const res = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'parse_prompt_sections', strict: true, schema: PARSE_SCHEMA_OFFSETS },
      },
      messages: [
        { role: 'system', content:
          `You parse Voice AI agent prompts into named sections covering the ENTIRE prompt.\n\n` +
          `STRICT RULES — every character of the prompt MUST belong to exactly one section:\n` +
          `1. First section's startOffset MUST be 0.\n` +
          `2. Each section's endOffset MUST equal the next section's startOffset (no gaps).\n` +
          `3. Last section's endOffset MUST equal the total prompt length given to you.\n` +
          `4. Sections must NOT overlap.\n` +
          `5. A section spans from its header through to (but excluding) the next section's header.\n\n` +
          `Typical sections in Voice AI prompts: Persona, Goals, Script/Steps, Tone Guidelines, ` +
          `Knowledge Base, Closing Instructions, Handoff Rules. Identify what's actually present — ` +
          `don't invent sections.\n\n` +
          `Example: 1000-char prompt with 3 sections might be:\n` +
          `  { id:"persona", startOffset:0,   endOffset:300 }\n` +
          `  { id:"goals",   startOffset:300, endOffset:650 }\n` +
          `  { id:"script",  startOffset:650, endOffset:1000 }\n` +
          `Total span = 1000 = prompt length. No gaps. No overlaps.` },
        { role: 'user', content:
          (agentGoal ? `AGENT GOAL: ${agentGoal}\n\n` : '') +
          `FULL PROMPT (${promptText.length} chars):\n${promptText}` },
      ],
    })
    return JSON.parse(res.choices[0].message.content).sections
  }

  // V5.7 — validate offsets cover the prompt + are well-formed.
  // Returns { ok, coverage, issues[] }. ok = true means safe to use.
  static _validateOffsets(sections, promptText) {
    const issues = []
    if (!sections || sections.length === 0) {
      return { ok: false, coverage: 0, issues: ['no sections returned'] }
    }
    let totalSpan = 0
    let prevEnd = -1
    for (const s of sections) {
      if (s.startOffset < 0 || s.endOffset > promptText.length) {
        issues.push(`section "${s.id}" out of bounds`)
      }
      if (s.endOffset <= s.startOffset) {
        issues.push(`section "${s.id}" empty or negative span`)
      }
      if (prevEnd > -1 && s.startOffset < prevEnd) {
        issues.push(`section "${s.id}" overlaps prior`)
      }
      totalSpan += Math.max(0, s.endOffset - s.startOffset)
      prevEnd = s.endOffset
    }
    const coverage = totalSpan / promptText.length
    const ok = issues.length === 0 && coverage >= OFFSET_COVERAGE_THRESHOLD
    return { ok, coverage, issues }
  }

  // V5.7 — extract verbatim text from validated offsets via string slice.
  // Downstream consumers (proposeInsertion, validators) expect the same
  // { id, name, summary, text } shape as the original verbatim parser.
  static _materialiseFromOffsets(offsetSections, promptText) {
    return offsetSections.map((s) => ({
      id:      s.id,
      name:    s.name,
      summary: s.summary,
      text:    promptText.slice(s.startOffset, s.endOffset),
    }))
  }

  // V5.7 — original verbatim parser, kept as a fallback for when offsets fail.
  // Slower (LLM emits the full prompt as output tokens) but deterministic in
  // coverage because the LLM is asked for substrings, not character math.
  static async _llmParseVerbatim(promptText, agentGoal) {
    const res = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'parse_prompt_sections', strict: true, schema: PARSE_SCHEMA_VERBATIM },
      },
      messages: [
        { role: 'system', content:
          `You parse Voice AI agent prompts into named sections. ` +
          `Typical sections: Persona, Goals, Script/Steps, Tone Guidelines, ` +
          `Knowledge Base, Closing Instructions. Identify what's actually present. ` +
          `For each section's "text" field: copy the EXACT verbatim characters from the ` +
          `prompt (must be a contiguous substring). Sections must be contiguous and ` +
          `non-overlapping. Concatenated section texts should reconstruct the prompt.` },
        { role: 'user', content:
          (agentGoal ? `AGENT GOAL: ${agentGoal}\n\n` : '') +
          `FULL PROMPT (${promptText.length} chars):\n${promptText}` },
      ],
    })
    return JSON.parse(res.choices[0].message.content).sections
  }

  // ── proposeInsertion ───────────────────────────────────────────────────
  // Given the sections + a short snippet of guidance, the LLM picks where the
  // snippet belongs + produces the modified section text. The caller then
  // splices the modified section back into the full prompt via mergeInsertion.
  //
  // `forcedSectionId` (optional) — bypasses the LLM's section selection. When
  // provided the LLM only produces modifiedSectionText for that specific section.
  // Used by the UI to support manual section override (B).
  //
  // Cached on (promptText + suggestion + forcedSectionId) so the modal can
  // re-open without re-paying — and so the override produces a stable cache miss
  // for each chosen section.
  static _insertionCache = new Map()  // key → { proposal, mergedPrompt }
  static async proposeInsertion({ currentPrompt, sections, suggestion, agentName, agentGoal, forcedSectionId = null }) {
    const cacheKey = crypto.createHash('sha256')
      .update(currentPrompt + '::' + suggestion + '::' + (forcedSectionId || '')).digest('hex').slice(0, 24)
    const cached = this._insertionCache.get(cacheKey)
    if (cached) return cached

    // When the section is forced, validate it actually exists in the parsed
    // sections list before paying for an LLM call.
    const forcedSection = forcedSectionId
      ? sections.find((s) => s.id === forcedSectionId)
      : null
    if (forcedSectionId && !forcedSection) {
      logger.warn({ forcedSectionId, available: sections.map((s) => s.id) },
        'PromptStructure: forcedSectionId not found in parsed sections, falling back to LLM choice')
    }

    const systemMsg = forcedSection
      ? `You are improving a Voice AI agent's prompt. The user has chosen to add ` +
        `the improvement to a SPECIFIC section. Do NOT pick a different section — ` +
        `target the one given. Produce the FULL text of that section after the ` +
        `change is applied. Maintain the section's existing tone + formatting. ` +
        `Return targetSectionId = "${forcedSection.id}" exactly.`
      : `You are improving a Voice AI agent's prompt. Given the existing sections ` +
        `and a short improvement suggestion, pick the ONE section the suggestion ` +
        `most naturally modifies, then produce that section's full text after the ` +
        `change is applied. Prefer inserting near the relevant existing instruction, ` +
        `not appending blindly to the section's end. ` +
        `Maintain the section's existing tone + formatting (numbered lists, bullets, ` +
        `etc). Do NOT introduce contradictions with other sections — if the ` +
        `suggestion can't be cleanly integrated, pick the closest fit and note it ` +
        `in reasoning. ` +
        `\n\nIMPORTANT: targetSectionId MUST be one of the section id strings exactly ` +
        `as written (e.g. "persona", "qualification_script"). Do NOT return numeric ` +
        `indexes or paraphrased names.`

    const userMsg = forcedSection
      ? `AGENT: ${agentName || '(unnamed)'}\nGOAL: ${agentGoal || '(none)'}\n\n` +
        `TARGET SECTION (user-chosen, do not change):\n` +
        `  id: ${forcedSection.id}\n  name: ${forcedSection.name}\n  purpose: ${forcedSection.summary}\n` +
        `  text (${forcedSection.text.length} chars):\n${forcedSection.text.split('\n').map((l) => '  ' + l).join('\n')}\n\n` +
        `IMPROVEMENT SUGGESTION (${suggestion.length} chars):\n${suggestion}\n\n` +
        `Produce modifiedSectionText for this section.`
      : `AGENT: ${agentName || '(unnamed)'}\nGOAL: ${agentGoal || '(none)'}\n\n` +
        `AVAILABLE SECTION IDs (use one of these exactly for targetSectionId):\n` +
        sections.map((s) => `  • ${s.id}`).join('\n') + '\n\n' +
        `SECTION DETAILS:\n` +
        sections.map((s) => `─── id: ${s.id}\n    name: ${s.name}\n    purpose: ${s.summary}\n    text (${s.text.length} chars):\n${s.text.split('\n').map((l) => '    ' + l).join('\n')}`).join('\n\n') + '\n\n' +
        `IMPROVEMENT SUGGESTION (${suggestion.length} chars):\n${suggestion}\n\n` +
        `Pick the best targetSectionId from the list above and produce modifiedSectionText.`

    const res = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'propose_insertion', strict: true, schema: INSERTION_SCHEMA },
      },
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user',   content: userMsg },
      ],
    })
    const proposal = JSON.parse(res.choices[0].message.content)
    if (forcedSection) proposal.userForcedSection = true

    // Splice the modified section back into the full prompt
    const target = sections.find((s) => s.id === proposal.targetSectionId)
    if (!target) {
      logger.warn({ targetSectionId: proposal.targetSectionId, sections: sections.map((s) => s.id) },
        'PromptStructure: LLM picked unknown section, falling back to append')
      const merged = `${currentPrompt.trimEnd()}\n\n${suggestion}`
      const out = { proposal: { ...proposal, _fallback: 'unknown-section' }, mergedPrompt: merged }
      this._insertionCache.set(cacheKey, out)
      return out
    }

    let mergedPrompt
    if (currentPrompt.includes(target.text)) {
      // Splice: replace the original section text with the modified version
      mergedPrompt = currentPrompt.replace(target.text, proposal.modifiedSectionText)
    } else {
      // LLM hallucinated section text that isn't a substring — fall back
      logger.warn({ targetSectionId: proposal.targetSectionId },
        'PromptStructure: target section text not found in prompt verbatim, falling back to append')
      mergedPrompt = `${currentPrompt.trimEnd()}\n\n${suggestion}`
      proposal._fallback = 'section-text-mismatch'
    }

    const out = { proposal, mergedPrompt, targetSection: target }
    this._insertionCache.set(cacheKey, out)
    if (this._insertionCache.size > 100) this._insertionCache.delete(this._insertionCache.keys().next().value)
    return out
  }
}

module.exports = PromptStructureService
