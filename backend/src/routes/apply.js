// V4 — One-click apply + rollback + live validate + preview + history.
// Mounted at /api in app.js — handles routes under /agents/:id and /recommendations/:id.

const express = require('express')
const db = require('../db/database')
const httpError = require('../utils/httpError')
const ApplyRecommendationService = require('../services/ApplyRecommendationService')
const RecommendationValidatorService = require('../services/RecommendationValidatorService')
const HLVoiceAgentService = require('../services/HLVoiceAgentService')
const PromptStructureService = require('../services/PromptStructureService')
const db2 = require('../db/database')

const router = express.Router()

// GET /api/recommendations/:recId/preview-apply
// Initial diff-modal load: returns current HL prompt, AI-suggested text, initial validators.
router.get('/recommendations/:recId/preview-apply', async (req, res, next) => {
  try {
    const rec = db.prepare('SELECT * FROM recommendations WHERE id = ?').get(req.params.recId)
    if (!rec) return next(httpError('REC_NOT_FOUND', `Recommendation ${req.params.recId} not found`, 404))

    // Detect synthetic test-DB recommendations (agent IDs prefixed `reg-` from the
    // regression seed). Apply requires a real HL agent — short-circuit with a
    // friendly UI-facing message instead of leaking the HL 403.
    if (_isDemoAgent(rec.agent_id)) {
      return next(httpError(
        'DEMO_AGENT',
        'This agent is a regression-test scenario and doesn\'t exist in HighLevel. Switch to LIVE mode (bash .runtime/use-data.sh live) to try Apply on a real HL Voice AI agent.',
        409
      ))
    }

    const locationId = process.env.HL_LOCATION_ID
    const hl = new HLVoiceAgentService({ locationId })
    const agent = await hl.getAgent(rec.agent_id)

    // V4.2: section-aware insertion. Parse the prompt into sections (cached),
    // then ask the LLM where the suggestion belongs + produce the modified
    // section verbatim. Splice it back into the full prompt. If anything fails,
    // fall back to V4's blind-append behavior so the modal still renders.
    //
    // ?targetSectionId=<id>  (V4.6) — user-chosen section override. Skips the
    // LLM's section selection and forces the modification onto the chosen one.
    const userChosenSectionId = req.query.targetSectionId || null
    let aiSuggestedText
    let sections = null
    let insertionProposal = null
    let targetSection = null
    try {
      const promptVersionId = _currentPromptVersionId(rec.agent_id)
      sections = await PromptStructureService.parseSections({
        promptText: agent.agentPrompt,
        promptVersionId,
        agentGoal: agent.goal || agent.agentName,
      })
      const insertion = await PromptStructureService.proposeInsertion({
        currentPrompt: agent.agentPrompt,
        sections,
        suggestion: rec.suggested_change || '',
        agentName: agent.agentName,
        agentGoal: agent.goal,
        forcedSectionId: userChosenSectionId,
      })
      aiSuggestedText = insertion.mergedPrompt
      insertionProposal = insertion.proposal
      targetSection = insertion.targetSection || null
    } catch (err) {
      // Section-aware path failed (LLM hiccup, parse miss, etc) — fall back
      // to the V4 blind-append merge. The modal still works; validators still run.
      // Logged so we can monitor fallback frequency.
      require('../logger').warn({ err: err.message, recId: rec.id }, 'V4.2 section-aware merge failed; falling back to append')
      aiSuggestedText = _mergeSuggestion(agent.agentPrompt, rec.suggested_change)
    }

    const validation = await RecommendationValidatorService.validate({
      agent,
      currentText: agent.agentPrompt,
      proposedText: aiSuggestedText,
      sections,
      targetSectionId: insertionProposal?.targetSectionId,
    })

    res.json({
      recommendation: {
        id: rec.id, title: rec.title, severity: rec.severity,
        suggestedChange: rec.suggested_change,
      },
      agent: {
        id: agent.id, name: agent.agentName,
        currentPromptLength: agent.agentPrompt.length,
      },
      currentText: agent.agentPrompt,
      aiSuggestedText,
      validation,
      // V4.2: structured insertion metadata for the UI
      sectionAware: insertionProposal ? {
        targetSectionId:   insertionProposal.targetSectionId,
        targetSectionName: targetSection?.name || insertionProposal.targetSectionId,
        targetSectionText: targetSection?.text || null,
        modifiedSectionText: insertionProposal.modifiedSectionText,
        insertionMode:     insertionProposal.insertionMode,
        reasoning:         insertionProposal.reasoning,
        confidence:        insertionProposal.confidence,
        fallback:          insertionProposal._fallback || null,
        userForcedSection: insertionProposal.userForcedSection || false,
        // Now includes text length per section so the UI can show "Persona (320 chars)"
        sections:          sections?.map((s) => ({ id: s.id, name: s.name, summary: s.summary, textLength: s.text?.length || 0 })),
      } : null,
    })
  } catch (err) {
    next(err)
  }
})

// Helper — find the prompt_version_id currently associated with this agent's
// latest prompt. Used so the PromptStructureService cache key is stable.
function _currentPromptVersionId(agentId) {
  const row = db2.prepare(
    'SELECT id FROM agent_prompt_versions WHERE agent_id = ? ORDER BY first_seen_at DESC LIMIT 1'
  ).get(agentId)
  return row?.id || null
}

// POST /api/recommendations/:recId/validate
// Live re-validation for the editable textarea (frontend debounces 300ms).
// Body: { proposedText: '<user-edited text>' }
router.post('/recommendations/:recId/validate', async (req, res, next) => {
  try {
    const rec = db.prepare('SELECT * FROM recommendations WHERE id = ?').get(req.params.recId)
    if (!rec) return next(httpError('REC_NOT_FOUND', `Recommendation ${req.params.recId} not found`, 404))
    if (!req.body?.proposedText) return next(httpError('INVALID_BODY', 'proposedText required', 400))
    if (_isDemoAgent(rec.agent_id)) {
      return next(httpError('DEMO_AGENT', 'Validate not available — this is a demo agent. Switch to LIVE mode.', 409))
    }

    const locationId = process.env.HL_LOCATION_ID
    const hl = new HLVoiceAgentService({ locationId })
    const agent = await hl.getAgent(rec.agent_id)
    const validation = await RecommendationValidatorService.validate({
      agent, currentText: agent.agentPrompt, proposedText: req.body.proposedText,
    })
    res.json(validation)
  } catch (err) {
    next(err)
  }
})

// POST /api/agents/:agentId/recommendations/:recId/apply
// The one-click action. Body: { finalText, userEmail }
router.post('/agents/:agentId/recommendations/:recId/apply', async (req, res, next) => {
  try {
    if (_isDemoAgent(req.params.agentId)) {
      return next(httpError(
        'DEMO_AGENT',
        'Cannot apply — this is a regression-test agent that doesn\'t exist in HighLevel. Switch to LIVE mode to try Apply on a real HL Voice AI agent.',
        409
      ))
    }
    const locationId = process.env.HL_LOCATION_ID
    const receipt = await ApplyRecommendationService.apply({
      recommendationId: req.params.recId,
      agentId:          req.params.agentId,
      locationId,
      finalText:        req.body?.finalText,
      userEmail:        req.body?.userEmail,
    })
    res.json(receipt)
  } catch (err) {
    next(err)
  }
})

// POST /api/recommendations/:recId/rollback
router.post('/recommendations/:recId/rollback', async (req, res, next) => {
  try {
    const locationId = process.env.HL_LOCATION_ID
    const receipt = await ApplyRecommendationService.rollback({
      recommendationId: req.params.recId,
      locationId,
      userEmail: req.body?.userEmail,
    })
    res.json(receipt)
  } catch (err) {
    next(err)
  }
})

// GET /api/recommendations/:recId/history
router.get('/recommendations/:recId/history', (req, res, next) => {
  try {
    const rec = db.prepare('SELECT id FROM recommendations WHERE id = ?').get(req.params.recId)
    if (!rec) return next(httpError('REC_NOT_FOUND', `Recommendation ${req.params.recId} not found`, 404))
    res.json({ recommendationId: req.params.recId, attempts: ApplyRecommendationService.getHistory(req.params.recId) })
  } catch (err) {
    next(err)
  }
})

// Regression-suite agents are seeded with IDs prefixed `reg-` (per scenarios.js).
// Apply doesn't work on them because they aren't real HL agents — fail loudly
// but kindly so test-mode users know what's going on.
function _isDemoAgent(agentId) {
  return typeof agentId === 'string' && agentId.startsWith('reg-')
}

function _mergeSuggestion(currentPrompt, suggestion) {
  if (!suggestion) return currentPrompt
  if (currentPrompt.includes(suggestion)) return currentPrompt
  return `${currentPrompt.trimEnd()}\n\n${suggestion}`
}

module.exports = router
