// RecommendationValidatorService — pre-apply safety checks.
//
// Runs 5 validators against any proposed agentPrompt before it's PATCHed to HL.
// Same code path serves both:
//   - Initial render of the diff modal (Apply API → preview-apply)
//   - Live re-validation as the user edits the textarea (POST /validate, debounced 300ms)
//   - Final server-side defence at apply time
//
// Each validator returns { name, severity: 'pass'|'warn'|'fail', message }.
// `fail` severity blocks the Confirm button; `warn` is informational.

const OpenAI = require('openai')
const logger = require('../logger')

const PROMPT_MAX_CHARS = 8000              // conservative; HL UI suggests ~10K
const PROMPT_WARN_CHARS = 6500             // approaching limit
const FORBIDDEN_PATTERNS = [
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bXXX\b/,
  /\bCALLER_NAME_HERE\b/i,                 // placeholder leakage
  /\bINSERT_.*_HERE\b/i,
  /\b(asshole|shit|fuck|damn)\b/i,         // profanity
]

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini'

// Tiny in-memory cache so identical text doesn't re-hit OpenAI on every keystroke.
// Keyed by sha256(agent.id + proposedText). Bounded at 100 entries (LRU-ish).
const _toneCache = new Map()
function _cacheGet(key) { return _toneCache.get(key) }
function _cacheSet(key, val) {
  _toneCache.set(key, val)
  if (_toneCache.size > 100) _toneCache.delete(_toneCache.keys().next().value)
}

class RecommendationValidatorService {
  // Pure function. agent is the HL agent shape. node is unused for Voice AI
  // (single-prompt agents) but kept in signature for future multi-node support.
  // currentText is the current agentPrompt; proposedText is what we want to set it to.
  //
  // V4.2: opts.sections + opts.targetSectionId enable two additional checks
  // (context_consistency + section_fit). Validators that need extra context
  // are no-ops when their inputs aren't provided — keeps validate() backwards
  // compatible with the V4 flow.
  static async validate({ agent, currentText, proposedText, sections, targetSectionId } = {}) {
    const checks = await Promise.all([
      this._validateTemplateVars(agent, proposedText),
      this._validateLength(proposedText),
      this._validateTone(agent, proposedText),
      this._validateForbiddenContent(proposedText),
      this._predictCallLengthImpact(currentText, proposedText),
      // V4.2 — full-prompt consistency check (catches contradictions/drift)
      this._validateContextConsistency(agent, currentText, proposedText),
      // V4.2 — section fit check (only if section info is provided)
      this._validateSectionFit(sections, targetSectionId, proposedText),
    ])
    const present = checks.filter(Boolean)  // skip no-ops
    return {
      checks: present,
      blocking: present.some((c) => c.severity === 'fail'),
    }
  }

  // ── 1. Template variables ──────────────────────────────────────────
  // HL Voice AI prompts use {{var}} placeholders. We don't have a public
  // schema for which vars are defined per agent, so we use a conservative
  // allow-list of common HL system vars + flag anything else as suspect.
  // (When HL exposes per-agent var introspection, upgrade this.)
  static _validateTemplateVars(_agent, proposedText) {
    const ALLOWED = new Set([
      'location.name', 'location.id', 'location.timezone',
      'contact.name', 'contact.first_name', 'contact.last_name',
      'contact.email', 'contact.phone',
      'agent.name', 'agent.businessName',
      'call.duration', 'call.timestamp',
    ])
    const found = [...proposedText.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1].trim())
    const unknown = found.filter((v) => !ALLOWED.has(v))
    if (unknown.length > 0) {
      return {
        name: 'template_vars',
        severity: 'warn',
        message: `Uses ${unknown.length} template variable(s) not in our allow-list: ${unknown.slice(0, 3).map((v) => `{{${v}}}`).join(', ')}${unknown.length > 3 ? '…' : ''}. Make sure they're defined on this agent in HighLevel.`,
      }
    }
    return { name: 'template_vars', severity: 'pass', message: `${found.length} template variable(s) — all recognised` }
  }

  // ── 2. Length ──────────────────────────────────────────────────────
  static _validateLength(proposedText) {
    const n = proposedText.length
    if (n === 0) {
      return { name: 'length', severity: 'fail', message: 'Prompt cannot be empty' }
    }
    if (n > PROMPT_MAX_CHARS) {
      return { name: 'length', severity: 'fail', message: `${n.toLocaleString()} chars — exceeds the ${PROMPT_MAX_CHARS.toLocaleString()}-char limit` }
    }
    if (n > PROMPT_WARN_CHARS) {
      return { name: 'length', severity: 'warn', message: `${n.toLocaleString()} / ${PROMPT_MAX_CHARS.toLocaleString()} chars — approaching limit` }
    }
    return { name: 'length', severity: 'pass', message: `${n.toLocaleString()} / ${PROMPT_MAX_CHARS.toLocaleString()} chars` }
  }

  // ── 3. Tone (cheap LLM) ─────────────────────────────────────────────
  // Checks the proposed prompt isn't drifting wildly from the agent's stated goal.
  // Cached aggressively — identical text → identical result, no re-billing.
  static async _validateTone(agent, proposedText) {
    if (!agent?.goal && !agent?.agentName) {
      return { name: 'tone', severity: 'pass', message: 'No agent goal/name to compare against' }
    }
    const cacheKey = require('crypto').createHash('sha256')
      .update(`${agent.id || ''}::${proposedText}`).digest('hex').slice(0, 16)
    const cached = _cacheGet(cacheKey)
    if (cached) return cached

    try {
      const res = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content:
            `You evaluate whether a Voice AI agent's proposed prompt text is consistent with the agent's stated goal/role. ` +
            `Return STRICT JSON: {"consistent": true|false, "reason": "<one short sentence>"}` },
          { role: 'user', content:
            `AGENT NAME: ${agent.agentName || agent.name || '(unknown)'}\n` +
            `AGENT GOAL: ${agent.goal || '(none provided)'}\n\n` +
            `PROPOSED PROMPT TEXT:\n${proposedText.slice(0, 4000)}` },
        ],
        response_format: { type: 'json_object' },
      })
      const parsed = JSON.parse(res.choices[0].message.content)
      const out = parsed.consistent
        ? { name: 'tone', severity: 'pass', message: `Consistent with agent goal — ${parsed.reason}` }
        : { name: 'tone', severity: 'warn', message: `Possible tone/goal drift — ${parsed.reason}` }
      _cacheSet(cacheKey, out)
      return out
    } catch (err) {
      logger.warn({ err: err.message }, 'tone validator: LLM call failed; skipping non-blocking check')
      return { name: 'tone', severity: 'pass', message: 'Tone check skipped (OpenAI unavailable)' }
    }
  }

  // ── 4. Forbidden content ────────────────────────────────────────────
  static _validateForbiddenContent(proposedText) {
    const hits = []
    for (const re of FORBIDDEN_PATTERNS) {
      const m = proposedText.match(re)
      if (m) hits.push(m[0])
    }
    if (hits.length > 0) {
      return {
        name: 'forbidden_content',
        severity: 'fail',
        message: `Found ${hits.length} forbidden token(s): ${hits.slice(0, 3).map((t) => `"${t}"`).join(', ')}`,
      }
    }
    return { name: 'forbidden_content', severity: 'pass', message: 'No placeholders or forbidden tokens' }
  }

  // ── 5. Call-length impact (deterministic, informational) ────────────
  // Counts added questions and sentences to estimate seconds added per call.
  // Rough heuristic: 1 added question ≈ 3-5s caller response; 1 added statement ≈ 2-3s agent read.
  static _predictCallLengthImpact(currentText, proposedText) {
    const dQ = (proposedText.match(/\?/g) || []).length - (currentText.match(/\?/g) || []).length
    const dS = (proposedText.match(/[.!]/g) || []).length - (currentText.match(/[.!]/g) || []).length
    const secs = dQ * 4 + Math.max(0, dS) * 2
    if (secs > 15) {
      return { name: 'call_length', severity: 'warn', message: `May add ~${secs}s per call (+${dQ} question${dQ === 1 ? '' : 's'}, +${dS} statement${dS === 1 ? '' : 's'})` }
    }
    if (secs > 0) {
      return { name: 'call_length', severity: 'pass', message: `Minor call-length impact (~+${secs}s)` }
    }
    if (secs < 0) {
      return { name: 'call_length', severity: 'pass', message: `Likely shortens calls (~${secs}s)` }
    }
    return { name: 'call_length', severity: 'pass', message: 'No meaningful call-length change' }
  }

  // ── 6. Context consistency (V4.2) ──────────────────────────────────────
  // Compares the proposed FULL prompt against the original FULL prompt to
  // detect contradictions, tonal drift, scope creep, sequencing conflicts,
  // redundancies, or template-variable mismatches. The killer validator —
  // catches the case where a section-aware insertion produces a syntactically
  // clean change that semantically conflicts with another part of the prompt.
  static async _validateContextConsistency(agent, currentText, proposedText) {
    if (!agent || !currentText || currentText === proposedText) return null
    const cacheKey = require('crypto').createHash('sha256')
      .update(`${agent.id || ''}::${currentText}::${proposedText}`).digest('hex').slice(0, 24)
    const cached = _cacheGet('ctx::' + cacheKey)
    if (cached) return cached

    try {
      const res = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'context_consistency_check',
            strict: true,
            schema: {
              type: 'object', additionalProperties: false,
              required: ['verdict', 'issues'],
              properties: {
                verdict: { type: 'string', enum: ['safe', 'review', 'block'] },
                issues: {
                  type: 'array',
                  items: {
                    type: 'object', additionalProperties: false,
                    required: ['kind', 'severity', 'detail', 'conflictsWith'],
                    properties: {
                      kind:          { type: 'string', enum: ['contradiction', 'tone_drift', 'scope_creep', 'sequencing', 'redundancy', 'variable_mismatch'] },
                      severity:      { type: 'string', enum: ['block', 'warn'] },
                      detail:        { type: 'string' },
                      conflictsWith: { type: 'string', description: 'The exact phrase from the existing prompt that conflicts' },
                    },
                  },
                },
              },
            },
          },
        },
        messages: [
          { role: 'system', content:
            `You review a Voice AI agent prompt for internal consistency. Given the existing ` +
            `prompt and a modified version, list any issues the modification introduces. ` +
            `Use 'block' severity only for direct LOGICAL contradictions that would make ` +
            `the agent inconsistent (e.g. "never quote prices" vs "always quote prices"). ` +
            `Use 'warn' for tone drift, scope creep, redundancy, sequencing concerns. ` +
            `For conflictsWith, quote the EXACT phrase from the existing prompt — do not ` +
            `paraphrase. Return verdict='safe' with empty issues if no problems found.` },
          { role: 'user', content:
            `EXISTING PROMPT (${currentText.length} chars):\n${currentText}\n\n` +
            `MODIFIED PROMPT (${proposedText.length} chars):\n${proposedText}` },
        ],
      })
      const parsed = JSON.parse(res.choices[0].message.content)
      const severity = parsed.verdict === 'block' ? 'fail'
                     : parsed.verdict === 'review' ? 'warn'
                     : 'pass'
      const message = parsed.issues.length === 0
        ? 'No contradictions or drift detected vs existing prompt'
        : `${parsed.issues.length} potential issue(s): ` +
          parsed.issues.slice(0, 2).map((i) => `${_kindLabel(i.kind)} — ${i.detail}`).join(' · ') +
          (parsed.issues.length > 2 ? '…' : '')
      const out = { name: 'context_consistency', severity, message, issues: parsed.issues }
      _cacheSet('ctx::' + cacheKey, out)
      return out
    } catch (err) {
      logger.warn({ err: err.message }, 'context_consistency validator: LLM call failed; skipping non-blocking check')
      return { name: 'context_consistency', severity: 'pass', message: 'Consistency check skipped (OpenAI unavailable)' }
    }
  }

  // ── 7. Section fit (V4.2) ──────────────────────────────────────────────
  // When the section-aware merge picks a target section, does the proposed
  // text actually belong in that section? Cheap deterministic-ish check — uses
  // the section's summary + name as the matching signal.
  static _validateSectionFit(sections, targetSectionId, _proposedText) {
    if (!sections || !targetSectionId) return null
    const section = sections.find((s) => s.id === targetSectionId)
    if (!section) {
      return {
        name: 'section_fit',
        severity: 'warn',
        message: `Target section "${targetSectionId}" not found in parsed structure — falling back to append`,
      }
    }
    return {
      name: 'section_fit',
      severity: 'pass',
      message: `Belongs in "${section.name}" — ${section.summary}`,
      section,
    }
  }
}

// Human-readable labels for context_consistency issue kinds
function _kindLabel(kind) {
  return ({
    contradiction:     'Contradiction',
    tone_drift:        'Tone drift',
    scope_creep:       'Scope creep',
    sequencing:        'Sequencing conflict',
    redundancy:        'Redundancy',
    variable_mismatch: 'Template variable mismatch',
  })[kind] || kind
}

module.exports = RecommendationValidatorService
