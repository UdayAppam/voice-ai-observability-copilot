// V4 — One-click apply + rollback + live validate + preview + history.
// Mounted at /api in app.js — handles routes under /agents/:id and /recommendations/:id.

const express = require('express')
const db = require('../db/database')
const httpError = require('../utils/httpError')
const ApplyRecommendationService = require('../services/ApplyRecommendationService')
const RecommendationValidatorService = require('../services/RecommendationValidatorService')
const HLVoiceAgentService = require('../services/HLVoiceAgentService')

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

    // V4 doesn't yet auto-merge the short suggested_change into the long agentPrompt;
    // we append it as a clearly-marked block. Users can relocate it in the textarea
    // before clicking Apply. V4.1 may add an LLM-driven merge step.
    const aiSuggestedText = _mergeSuggestion(agent.agentPrompt, rec.suggested_change)

    const validation = await RecommendationValidatorService.validate({
      agent, currentText: agent.agentPrompt, proposedText: aiSuggestedText,
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
    })
  } catch (err) {
    next(err)
  }
})

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
