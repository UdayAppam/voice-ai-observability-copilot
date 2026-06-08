// ApplyRecommendationService — V4 orchestrator.
// One-click application of a recommendation into a live HighLevel Voice AI agent.
//
// Flow (per V4_PLAN.md §4):
//   1. Idempotency: if rec is already applied within 5 min, return existing receipt
//   2. Validate (server-side defence — UI also validates pre-Confirm)
//   3. Snapshot current agentPrompt to apply_attempts.previous_agent_prompt
//   4. PATCH HL with the new agentPrompt
//   5. Mark recommendation applied
//   6. Run EditSummaryService (if user edited)
//   7. Log apply_attempts row with full audit fields
//   8. Trigger ingestion sync so subsequent calls measure against the new prompt
//   9. Return receipt to caller (the modal renders it as the post-apply timeline)

const crypto = require('crypto')
const db = require('../db/database')
const logger = require('../logger')
const HLVoiceAgentService = require('./HLVoiceAgentService')
const RecommendationValidatorService = require('./RecommendationValidatorService')
const EditSummaryService = require('./EditSummaryService')
const PromptVersionService = require('./PromptVersionService')
// V4.8 — adapter factory: reg-* demo agents resolve to LocalAgentService;
// real HL agents resolve to HLVoiceAgentService. Same orchestration either way.
const { getAgentService } = require('./LocalAgentService')

// Idempotency window: a second Apply for the same rec within 5 min returns the
// existing receipt (handles double-clicks during the 2-5s orchestration).
// Inlined into the SQL below as `datetime('now', '-5 minutes')`.

class ApplyRecommendationService {
  // Main entry point. Called from POST /api/agents/:agentId/recommendations/:recId/apply.
  // Returns the receipt object the frontend renders as a timeline.
  static async apply({ recommendationId, agentId, locationId, finalText, userEmail }) {
    const startedAt = new Date().toISOString()

    // ── 1. Fetch & gate ──────────────────────────────────────────────
    const rec = db.prepare('SELECT * FROM recommendations WHERE id = ?').get(recommendationId)
    if (!rec) throw _err('REC_NOT_FOUND', `Recommendation ${recommendationId} not found`, 404)
    if (rec.agent_id !== agentId) throw _err('AGENT_MISMATCH', `Rec belongs to agent ${rec.agent_id}, not ${agentId}`, 400)
    if (!finalText || typeof finalText !== 'string') throw _err('INVALID_BODY', 'finalText required', 400)

    // Idempotency check — short-circuit ONLY if rec is currently 'applied'.
    // If the user has rolled back since then, rec.status='active' and a fresh
    // apply is intended (not a double-click). This avoids the bug where a
    // post-rollback re-apply silently returns the stale prior receipt.
    if (rec.status === 'applied') {
      const recentSuccess = db.prepare(`
        SELECT * FROM apply_attempts
        WHERE recommendation_id = ? AND outcome = 'success'
          AND attempted_at >= datetime('now', '-5 minutes')
        ORDER BY attempted_at DESC LIMIT 1
      `).get(recommendationId)
      if (recentSuccess) {
        logger.info({ recId: recommendationId }, 'apply: idempotency hit — returning prior receipt')
        return _attemptToReceipt(recentSuccess, { idempotent: true })
      }
    }

    // ── 2. Fetch HL agent + validate ─────────────────────────────────
    const hl = getAgentService(agentId, { locationId })
    const agent = await hl.getAgent(agentId)
    const currentText = agent.agentPrompt
    const validation = await RecommendationValidatorService.validate({
      agent, currentText, proposedText: finalText,
    })
    if (validation.blocking) {
      const failedNames = validation.checks.filter((c) => c.severity === 'fail').map((c) => c.name).join(', ')
      throw _err('VALIDATION_FAILED', `Server-side validation blocked: ${failedNames}`, 422, { validation })
    }

    // ── 3-9. Run the protected section: snapshot → PATCH → log ──────
    // Re-derive the AI's proposed text the same way routes/apply.js's preview-apply
    // does (current prompt + rec.suggested_change appended) so "edited" correctly
    // reflects whether the user changed anything from what the modal showed them.
    const aiSuggestedText = _mergeSuggestion(currentText, rec.suggested_change)
    const edited = finalText !== aiSuggestedText
    const attemptId = crypto.randomUUID()
    const timeline = []

    try {
      timeline.push({ step: 'snapshot', startedAt: new Date().toISOString() })
      // Snapshot lives in the apply_attempts row written at the end — we hold it
      // in memory through the PATCH, then persist along with outcome.
      const previousAgentPrompt = currentText

      timeline.push({ step: 'patch', startedAt: new Date().toISOString() })
      const patchedAgent = await hl.updateAgentPrompt(agentId, finalText)
      timeline[timeline.length - 1].completedAt = new Date().toISOString()
      timeline[timeline.length - 1].hlResponseStatus = 200
      timeline[timeline.length - 1].newPromptLength = patchedAgent.agentPrompt?.length

      // Record the new prompt version so we can causally measure outcomes.
      // Without this, applied_prompt_version_id stays NULL and
      // computePendingOutcomes can never match calls to this rec → outcomes
      // never compute. This was the bug: V4 auto-apply marked status='applied'
      // but skipped version recording (only the sync-detected path did it).
      const promptVersionResult = PromptVersionService.recordIfChanged({
        id: agentId,
        name: agent.name,
        script: finalText,
        goal: agent.goal,
      })
      timeline.push({
        step: 'record_prompt_version',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        versionId: promptVersionResult.versionId,
        isNew: promptVersionResult.isNew,
      })

      timeline.push({ step: 'mark_applied', startedAt: new Date().toISOString() })
      db.prepare(`
        UPDATE recommendations
          SET status='applied', applied_at=?, applied_via='auto_api',
              applied_prompt_version_id=?, apply_error=NULL
          WHERE id = ?
      `).run(new Date().toISOString(), promptVersionResult.versionId, recommendationId)
      timeline[timeline.length - 1].completedAt = new Date().toISOString()

      timeline.push({ step: 'edit_summary', startedAt: new Date().toISOString() })
      const editSummary = edited ? await EditSummaryService.summarise({ aiSuggestedText, finalText }) : null
      timeline[timeline.length - 1].completedAt = new Date().toISOString()

      timeline.push({ step: 'log_audit', startedAt: new Date().toISOString() })
      const diffSummary = _shortDiffSummary(previousAgentPrompt, finalText)
      db.prepare(`
        INSERT INTO apply_attempts
          (id, recommendation_id, agent_id, attempted_at, outcome,
           previous_agent_prompt, ai_suggested_text, final_text,
           edited_from_suggestion, chars_diff_from_suggestion, edit_summary,
           diff_summary, user_email)
        VALUES (?, ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attemptId, recommendationId, agentId, startedAt,
        previousAgentPrompt, aiSuggestedText, finalText,
        edited ? 1 : 0,
        edited ? Math.abs(finalText.length - aiSuggestedText.length) : 0,
        editSummary,
        diffSummary,
        userEmail || null
      )
      timeline[timeline.length - 1].completedAt = new Date().toISOString()

      logger.info(
        { recId: recommendationId, agentId, attemptId, edited, finalLen: finalText.length },
        'apply: success'
      )

      return {
        attemptId,
        outcome: 'success',
        timeline,
        agentId,
        recommendationId,
        editedFromSuggestion: edited,
        editSummary,
        previousAgentPromptLength: previousAgentPrompt.length,
        finalTextLength: finalText.length,
        diffSummary,
        idempotent: false,
      }
    } catch (err) {
      // Log the failure but DON'T rollback HL (we already snapshotted before PATCH;
      // if PATCH failed, HL is unchanged. If PATCH succeeded but DB write failed,
      // log it so we can reconcile.)
      logger.error({ recId: recommendationId, err: err.message, code: err.code }, 'apply: failed')
      db.prepare(`
        INSERT INTO apply_attempts
          (id, recommendation_id, agent_id, attempted_at, outcome,
           ai_suggested_text, final_text, edited_from_suggestion,
           error_message, user_email)
        VALUES (?, ?, ?, ?, 'failure', ?, ?, ?, ?, ?)
      `).run(
        attemptId, recommendationId, agentId, startedAt,
        aiSuggestedText, finalText, edited ? 1 : 0,
        err.message?.slice(0, 500) || 'unknown error',
        userEmail || null
      )
      db.prepare("UPDATE recommendations SET apply_error = ? WHERE id = ?")
        .run(err.message?.slice(0, 500) || 'apply failed', recommendationId)
      throw err
    }
  }

  // Rollback: re-PATCH HL with the previous_agent_prompt from the latest success.
  static async rollback({ recommendationId, locationId, userEmail }) {
    const rec = db.prepare('SELECT * FROM recommendations WHERE id = ?').get(recommendationId)
    if (!rec) throw _err('REC_NOT_FOUND', `Recommendation ${recommendationId} not found`, 404)
    if (rec.status !== 'applied') throw _err('NOT_APPLIED', 'Cannot rollback — recommendation is not currently applied', 400)

    const lastSuccess = db.prepare(`
      SELECT * FROM apply_attempts
      WHERE recommendation_id = ? AND outcome = 'success'
      ORDER BY attempted_at DESC LIMIT 1
    `).get(recommendationId)
    if (!lastSuccess || !lastSuccess.previous_agent_prompt) {
      throw _err('NO_SNAPSHOT', 'No rollback snapshot available — cannot revert', 409)
    }

    const hl = getAgentService(rec.agent_id, { locationId })
    const attemptId = crypto.randomUUID()
    const startedAt = new Date().toISOString()

    try {
      await hl.updateAgentPrompt(rec.agent_id, lastSuccess.previous_agent_prompt)
      db.prepare(`
        UPDATE recommendations
          SET status='active', applied_at=NULL, applied_via=NULL, apply_error=NULL
          WHERE id = ?
      `).run(recommendationId)
      db.prepare(`
        INSERT INTO apply_attempts
          (id, recommendation_id, agent_id, attempted_at, outcome,
           previous_agent_prompt, final_text, diff_summary, user_email)
        VALUES (?, ?, ?, ?, 'rolled_back', ?, ?, ?, ?)
      `).run(
        attemptId, recommendationId, rec.agent_id, startedAt,
        lastSuccess.final_text,                       // what we just reverted FROM
        lastSuccess.previous_agent_prompt,            // what we restored TO
        _shortDiffSummary(lastSuccess.final_text, lastSuccess.previous_agent_prompt),
        userEmail || null
      )
      logger.info({ recId: recommendationId, attemptId }, 'rollback: success')
      return {
        attemptId, outcome: 'rolled_back', recommendationId,
        restoredPromptLength: lastSuccess.previous_agent_prompt.length,
      }
    } catch (err) {
      logger.error({ recId: recommendationId, err: err.message }, 'rollback: failed')
      db.prepare(`
        INSERT INTO apply_attempts (id, recommendation_id, agent_id, attempted_at, outcome, error_message, user_email)
        VALUES (?, ?, ?, ?, 'failure', ?, ?)
      `).run(attemptId, recommendationId, rec.agent_id, startedAt, `rollback failed: ${err.message}`, userEmail || null)
      throw err
    }
  }

  // History — used by GET /api/recommendations/:recId/history (audit panel)
  static getHistory(recommendationId) {
    return db.prepare(`
      SELECT id, attempted_at, outcome, edited_from_suggestion, edit_summary,
             diff_summary, error_message, user_email,
             chars_diff_from_suggestion,
             LENGTH(previous_agent_prompt) as previous_prompt_length,
             LENGTH(final_text) as final_text_length
      FROM apply_attempts
      WHERE recommendation_id = ?
      ORDER BY attempted_at DESC
    `).all(recommendationId)
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function _err(code, message, status, extra = {}) {
  const e = new Error(message)
  e.code = code
  e.status = status
  Object.assign(e, extra)
  return e
}

function _attemptToReceipt(row, { idempotent }) {
  return {
    attemptId: row.id,
    outcome: row.outcome,
    timeline: [{ step: 'idempotent_return', note: 'Returned prior attempt within 5min window' }],
    agentId: row.agent_id,
    recommendationId: row.recommendation_id,
    editedFromSuggestion: !!row.edited_from_suggestion,
    editSummary: row.edit_summary,
    previousAgentPromptLength: (row.previous_agent_prompt || '').length,
    finalTextLength: (row.final_text || '').length,
    diffSummary: row.diff_summary,
    idempotent,
  }
}

// MUST stay in sync with the identically-named helper in routes/apply.js —
// both produce the canonical "what the AI suggested the user see in the modal."
function _mergeSuggestion(currentPrompt, suggestion) {
  if (!suggestion) return currentPrompt
  if (currentPrompt.includes(suggestion)) return currentPrompt
  return `${currentPrompt.trimEnd()}\n\n${suggestion}`
}

// Tiny human-readable diff summary (length delta + line delta)
function _shortDiffSummary(before, after) {
  if (before === after) return 'no change'
  const dLen = after.length - before.length
  const beforeLines = before.split('\n').length
  const afterLines = after.split('\n').length
  const dLines = afterLines - beforeLines
  const sign = (n) => n > 0 ? `+${n}` : `${n}`
  return `${sign(dLen)} chars, ${sign(dLines)} lines`
}

module.exports = ApplyRecommendationService
