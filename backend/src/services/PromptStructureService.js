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

const PARSER_VERSION = '1.0'

// JSON schema for the parser. Sections are name + summary + the exact verbatim
// text slice from the original prompt — we use the verbatim text to splice the
// modified section back in without character-offset drift.
const PARSE_SCHEMA = {
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
          id:      { type: 'string', description: 'lowercase snake-case identifier, e.g. "persona", "qualification_script"' },
          name:    { type: 'string', description: 'human-readable section name, e.g. "Persona", "Qualification Script"' },
          summary: { type: 'string', description: 'one-line description of what this section governs' },
          text:    { type: 'string', description: 'EXACT verbatim text from the original prompt that belongs to this section. Must be a contiguous substring. Do not paraphrase.' },
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

    const sections = await this._llmParse(promptText, agentGoal)

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

  static async _llmParse(promptText, agentGoal) {
    const res = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'parse_prompt_sections', strict: true, schema: PARSE_SCHEMA },
      },
      messages: [
        { role: 'system', content:
          `You parse Voice AI agent prompts into named sections. ` +
          `Typical sections in a Voice AI prompt: Persona, Goals, Script/Steps, ` +
          `Tone Guidelines, Knowledge Base, Closing Instructions. ` +
          `Identify what's actually present — don't invent sections. ` +
          `For each section's "text" field: copy the EXACT verbatim characters from the ` +
          `prompt (we splice modified sections back by finding this substring). ` +
          `Sections must be contiguous and non-overlapping. The concatenation of all ` +
          `sections' text should reconstruct the original prompt (with optional ` +
          `whitespace between).` },
        { role: 'user', content:
          (agentGoal ? `AGENT GOAL: ${agentGoal}\n\n` : '') +
          `FULL PROMPT (${promptText.length} chars):\n${promptText}` },
      ],
    })
    const parsed = JSON.parse(res.choices[0].message.content)
    logger.info({ sectionCount: parsed.sections.length, promptLen: promptText.length }, 'PromptStructure: parsed')
    return parsed.sections
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
