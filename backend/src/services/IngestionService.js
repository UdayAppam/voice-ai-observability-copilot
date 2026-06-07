const crypto = require('crypto')
const db = require('../db/database')
const logger = require('../logger')
const PromptVersionService = require('./PromptVersionService')
const RecommendationService = require('./RecommendationService')

const DEFAULT_KPI_DEFINITIONS = [
  { name: 'call_completion', label: 'Call Completion', weight: 0.25, threshold: 75,
    description: 'Call reaches its intended outcome per the agent goal (booking, qualification, renewal, etc.)' },
  { name: 'script_adherence', label: 'Script Adherence', weight: 0.20, threshold: 70,
    description: 'Agent follows the defined script steps in order without skipping required steps' },
  { name: 'objection_handling', label: 'Objection Handling', weight: 0.20, threshold: 65,
    description: 'Agent effectively addresses caller objections by pivoting to value, not just restating facts' },
  { name: 'sentiment_score', label: 'Caller Sentiment', weight: 0.15, threshold: 60,
    description: 'Overall caller sentiment arc across the call — positive, neutral, or negative' },
  { name: 'response_quality', label: 'Response Quality', weight: 0.15, threshold: 70,
    description: 'Agent responses are relevant, on-topic, natural, and move the conversation forward' },
  { name: 'escalation_rate', label: 'Escalation Rate', weight: 0.05, threshold: 90,
    description: 'Call did NOT require human escalation or handoff (higher score = no escalation needed)' },
]

class IngestionService {
  constructor(provider) {
    this.provider = provider
  }

  async seedAll() {
    logger.info('ingestion: starting full seed')

    const agents = await this.provider.fetchAgents()

    for (const agent of agents) {
      await this.upsertAgent(agent)

      const calls = await this.provider.fetchCalls(agent.id)
      logger.info({ agentId: agent.id, callCount: calls.length }, 'ingestion: fetched calls')

      for (const callMeta of calls) {
        const existing = db
          .prepare('SELECT id FROM calls WHERE id = ?')
          .get(callMeta.id)

        if (existing) continue // already ingested — skip

        const full = await this.provider.fetchTranscript(callMeta.id)
        this._insertCall(full)
      }
    }

    const totals = db.prepare('SELECT COUNT(*) as n FROM calls').get()
    logger.info({ totalCalls: totals.n }, 'ingestion: seed complete')
  }

  async ingestOne(callData) {
    const agentExists = db.prepare('SELECT id FROM agents WHERE id = ?').get(callData.agentId)
    if (!agentExists) {
      throw Object.assign(new Error(`Agent ${callData.agentId} not found`), {
        code: 'AGENT_NOT_FOUND', status: 404,
      })
    }

    const existing = db.prepare('SELECT id FROM calls WHERE id = ?').get(callData.id)
    if (existing) {
      logger.warn({ callId: callData.id }, 'ingestion: call already exists, skipping')
      return existing
    }

    this._insertCall(callData)

    // Invalidate agent_insights cache — new call changes the picture
    db.prepare('DELETE FROM agent_insights WHERE agent_id = ?').run(callData.agentId)
    logger.info({ agentId: callData.agentId }, 'ingestion: agent_insights cache invalidated')

    return { id: callData.id }
  }

  upsertAgent(agent) {
    const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(agent.id)

    if (!existing) {
      db.prepare(`
        INSERT INTO agents (id, name, goal, script, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(agent.id, agent.name, agent.goal, agent.script || null)

      const kpiDefs = agent.kpiDefinitions || DEFAULT_KPI_DEFINITIONS
      for (const kpi of kpiDefs) {
        db.prepare(`
          INSERT INTO kpi_definitions (id, agent_id, name, label, weight, threshold, description)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(), agent.id,
          kpi.name, kpi.label, kpi.weight, kpi.threshold, kpi.description
        )
      }

      logger.info({ agentId: agent.id, name: agent.name }, 'ingestion: agent seeded')
    } else {
      // Keep name/goal/script in sync with HL so prompt-version detection sees
      // the latest text on subsequent syncs.
      db.prepare(`
        UPDATE agents SET name = ?, goal = ?, script = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(agent.name, agent.goal, agent.script || null, agent.id)
    }

    // Detect and record prompt version. If it's a new version that replaced
    // a prior one → auto-mark all 'active' recommendations as 'applied'.
    const { versionId, isNew, prevVersionId } = PromptVersionService.recordIfChanged(agent)
    if (isNew && prevVersionId) {
      RecommendationService.markActiveAsApplied(agent.id, versionId)
    }
    return versionId
  }

  _insertCall(call) {
    // Link the call to the agent's CURRENT prompt version so we can later
    // attribute score deltas to specific prompt changes.
    const promptVersionId = PromptVersionService.getCurrentVersionId(call.agentId)
    if (promptVersionId) PromptVersionService.incrementCallCount(promptVersionId)

    db.prepare(`
      INSERT INTO calls (id, agent_id, caller_number, duration, outcome, transcript_json,
                         analysis_status, prompt_version_id, call_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      call.id,
      call.agentId,
      call.callerNumber || null,
      call.duration || null,
      call.outcome || null,
      JSON.stringify(call.transcript),
      promptVersionId,
      call.callTimestamp
    )

    logger.info({ callId: call.id, agentId: call.agentId, promptVersionId }, 'ingestion: call inserted')
  }
}

module.exports = IngestionService
