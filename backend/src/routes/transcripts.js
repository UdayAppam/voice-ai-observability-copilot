const express = require('express')
const { body, validationResult } = require('express-validator')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const IngestionService = require('../services/IngestionService')
const AnalysisService = require('../services/AnalysisService')
const db = require('../db/database')
const logger = require('../logger')

const router = express.Router()
const analysisService = new AnalysisService()

const ingestValidation = [
  body('agentId').isString().notEmpty().withMessage('agentId is required'),
  body('transcript').isArray({ min: 1 }).withMessage('transcript must be a non-empty array'),
  body('transcript.*.speaker').isIn(['agent', 'human']).withMessage('speaker must be "agent" or "human"'),
  body('transcript.*.text').isString().notEmpty().withMessage('each turn requires a text field'),
  body('transcript.*.turnIndex').isInt({ min: 0 }).withMessage('turnIndex must be a non-negative integer'),
  body('outcome').optional().isIn(['booked', 'no_booking', 'escalated', 'dropped']),
  body('duration').optional().isInt({ min: 0 }),
]

// POST /api/transcripts/ingest
// Ingests a call transcript, stores it, runs analysis synchronously
// Also used by the "Simulate New Call" demo feature (Phase 6)
router.post('/ingest', ingestValidation, async (req, res, next) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: { code: 'INVALID_TRANSCRIPT', message: errors.array(), status: 400 },
    })
  }

  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.body.agentId)
    if (!agent) {
      return res.status(404).json({
        error: { code: 'AGENT_NOT_FOUND', message: `Agent ${req.body.agentId} not found`, status: 404 },
      })
    }

    const callId = req.body.callId || `call_live_${crypto.randomUUID().slice(0, 8)}`
    const callTimestamp = req.body.callTimestamp || new Date().toISOString()

    const callData = {
      id: callId,
      agentId: req.body.agentId,
      callerNumber: req.body.callerNumber || null,
      duration: req.body.duration || null,
      outcome: req.body.outcome || null,
      transcript: req.body.transcript,
      callTimestamp,
    }

    // Use IngestionService to insert (handles agent_insights cache invalidation)
    const ingestionService = new IngestionService(null)
    await ingestionService.ingestOne(callData)

    // Run analysis synchronously — FSB requires "immediate recommendations"
    const callForAnalysis = { ...callData }
    logger.info({ callId }, 'transcripts: running analysis after ingest')
    const result = await analysisService.analyze(callForAnalysis, agent)

    const status = result ? 'completed' : 'failed'
    const overallScore = result ? result.overallScore : null

    res.json({ callId, status, overallScore })
  } catch (err) {
    next(err)
  }
})

// POST /api/transcripts/simulate/:agentId
// Provider-aware "ingest new call" button — powers the dashboard's Sim/Sync button.
//
// MOCK mode      → injects a canned demo transcript (great for offline demos)
// HIGHLEVEL mode → pulls latest call logs from HL and ingests any not yet seen.
//                  If no new calls exist, re-analyses the most recent one so the
//                  pipeline is still visibly exercised for the demo.
router.post('/simulate/:agentId', async (req, res, next) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.agentId)
    if (!agent) {
      return res.status(404).json({
        error: { code: 'AGENT_NOT_FOUND', message: `Agent ${req.params.agentId} not found`, status: 404 },
      })
    }

    const providerName = process.env.TRANSCRIPT_PROVIDER || 'mock'

    if (providerName === 'highlevel') {
      return handleHighLevelSync(agent, res, next)
    }
    return handleMockSimulate(agent, res, next)
  } catch (err) {
    next(err)
  }
})

async function handleMockSimulate(agent, res, next) {
  try {
    const demoPath = path.join(__dirname, '../../mock-data/demo-calls', `${agent.id}_demo.json`)
    if (!fs.existsSync(demoPath)) {
      return res.status(404).json({
        error: {
          code: 'DEMO_NOT_FOUND',
          message: `No demo transcript configured for ${agent.id}. Add mock-data/demo-calls/${agent.id}_demo.json or switch to TRANSCRIPT_PROVIDER=highlevel.`,
          status: 404,
        },
      })
    }

    const demo = JSON.parse(fs.readFileSync(demoPath, 'utf8'))
    const callData = {
      ...demo,
      id: `call_sim_${crypto.randomUUID().slice(0, 8)}`,
      callTimestamp: new Date().toISOString(),
    }

    const ingestionService = new IngestionService(null)
    await ingestionService.ingestOne(callData)
    logger.info({ callId: callData.id, agentId: agent.id }, 'simulate: mock ingested')
    const result = await analysisService.analyze(callData, agent)

    res.json({
      mode: 'mock',
      action: 'ingested_demo',
      callId: callData.id,
      status: result ? 'completed' : 'failed',
      overallScore: result ? result.overallScore : null,
      newCallsCount: 1,
    })
  } catch (err) {
    next(err)
  }
}

async function handleHighLevelSync(agent, res, next) {
  try {
    const HighLevelProvider = require('../providers/HighLevelTranscriptProvider')
    const provider = new HighLevelProvider()

    logger.info({ agentId: agent.id }, 'sync: fetching latest from HL')
    const liveCalls = await provider.fetchCalls(agent.id)

    // Find which ones we haven't ingested yet
    const knownIds = new Set(
      db.prepare('SELECT id FROM calls WHERE agent_id = ?').all(agent.id).map((r) => r.id)
    )
    const newOnes = liveCalls.filter((c) => !knownIds.has(c.id))

    logger.info(
      { agentId: agent.id, liveCount: liveCalls.length, newCount: newOnes.length },
      'sync: HL call diff'
    )

    const ingestionService = new IngestionService(provider)
    const analysed = []

    if (newOnes.length > 0) {
      // Ingest + analyse each new call
      for (const meta of newOnes) {
        const full = await provider.fetchTranscript(meta.id)
        await ingestionService.ingestOne(full)
        const result = await analysisService.analyze(full, agent)
        analysed.push({ callId: full.id, overallScore: result?.overallScore ?? null })
      }

      return res.json({
        mode: 'highlevel',
        action: 'ingested_new',
        newCallsCount: newOnes.length,
        results: analysed,
      })
    }

    // No new calls — re-analyse the most recent existing call so the demo still
    // shows the pipeline running.
    const mostRecent = db.prepare(`
      SELECT c.* FROM calls c WHERE c.agent_id = ?
      ORDER BY c.call_timestamp DESC LIMIT 1
    `).get(agent.id)

    if (!mostRecent) {
      return res.json({
        mode: 'highlevel',
        action: 'no_calls_available',
        message: 'No calls exist for this agent in HighLevel yet. Make a real call and try again.',
        newCallsCount: 0,
      })
    }

    db.prepare('DELETE FROM analyses WHERE call_id = ?').run(mostRecent.id)
    db.prepare("UPDATE calls SET analysis_status = 'pending' WHERE id = ?").run(mostRecent.id)

    const call = {
      id: mostRecent.id,
      agentId: mostRecent.agent_id,
      duration: mostRecent.duration,
      outcome: mostRecent.outcome,
      transcript: JSON.parse(mostRecent.transcript_json),
    }
    const result = await analysisService.analyze(call, agent)

    res.json({
      mode: 'highlevel',
      action: 're_analysed_latest',
      callId: mostRecent.id,
      status: result ? 'completed' : 'failed',
      overallScore: result ? result.overallScore : null,
      newCallsCount: 0,
    })
  } catch (err) {
    logger.error({ err: err.message, agentId: agent.id }, 'sync: HL failure')
    next(err)
  }
}

// POST /api/transcripts/sync-all
// Pulls latest calls from HL for EVERY agent in our DB. Ingests + analyzes any
// not yet seen. Returns per-agent counts so the dashboard can show what changed.
router.post('/sync-all', async (_req, res, next) => {
  if (process.env.TRANSCRIPT_PROVIDER !== 'highlevel') {
    return res.status(400).json({
      error: { code: 'NOT_HL_MODE', message: 'sync-all only works in highlevel mode', status: 400 },
    })
  }

  try {
    const HighLevelProvider = require('../providers/HighLevelTranscriptProvider')
    const provider = new HighLevelProvider()
    const ingestionService = new IngestionService(provider)

    // Step 1: reconcile agent list — discover and persist any NEW agents
    // created in HL since the last sync. Otherwise sync-all would silently
    // skip newly-created Voice AI agents and their calls would never appear.
    const liveAgents = await provider.fetchAgents()
    const knownAgentIds = new Set(
      db.prepare('SELECT id FROM agents').all().map((r) => r.id)
    )
    const newAgents = liveAgents.filter((a) => !knownAgentIds.has(a.id))
    for (const agent of newAgents) {
      ingestionService.upsertAgent(agent)
    }
    if (newAgents.length > 0) {
      logger.info(
        { newAgentCount: newAgents.length, names: newAgents.map((a) => a.name) },
        'sync-all: discovered new HL agents'
      )
    }

    // Step 2: walk every agent (existing + newly discovered) and ingest new calls
    const agents = db.prepare('SELECT * FROM agents').all()
    logger.info({ agentCount: agents.length, newAgentCount: newAgents.length }, 'sync-all: starting call sync')

    const results = []
    let totalNew = 0
    const newAgentCount = newAgents.length

    for (const agent of agents) {
      try {
        const liveCalls = await provider.fetchCalls(agent.id)
        const knownIds = new Set(
          db.prepare('SELECT id FROM calls WHERE agent_id = ?').all(agent.id).map((r) => r.id)
        )
        const newOnes = liveCalls.filter((c) => !knownIds.has(c.id))

        const analyzed = []
        for (const meta of newOnes) {
          const full = await provider.fetchTranscript(meta.id)
          await ingestionService.ingestOne(full)
          const result = await analysisService.analyze(full, agent)
          analyzed.push({ callId: full.id, overallScore: result?.overallScore ?? null })
        }

        totalNew += newOnes.length
        results.push({
          agentId: agent.id,
          agentName: agent.name,
          newCallsCount: newOnes.length,
          analyzed,
        })
      } catch (err) {
        logger.warn({ err: err.message, agentId: agent.id }, 'sync-all: agent failed')
        results.push({
          agentId: agent.id,
          agentName: agent.name,
          error: err.message,
        })
      }
    }

    logger.info({ totalNew, newAgentCount, agentCount: agents.length }, 'sync-all: complete')
    res.json({ totalNew, newAgentCount, agentsScanned: agents.length, results })
  } catch (err) {
    next(err)
  }
})

module.exports = router
