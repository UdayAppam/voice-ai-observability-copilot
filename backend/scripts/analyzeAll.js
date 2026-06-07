require('dotenv').config()

const db = require('../src/db/database')
const logger = require('../src/logger')
const AnalysisService = require('../src/services/AnalysisService')

async function main() {
  const pending = db.prepare(`
    SELECT c.id, c.agent_id, c.transcript_json, c.duration, c.outcome, c.call_timestamp
    FROM calls c
    WHERE c.analysis_status IN ('pending', 'failed')
    ORDER BY c.ingested_at ASC
  `).all()

  if (pending.length === 0) {
    logger.info('analyze-all: no pending calls')
    process.exit(0)
  }

  logger.info({ count: pending.length }, 'analyze-all: starting batch analysis')

  const service = new AnalysisService()
  let passed = 0
  let failed = 0

  for (const row of pending) {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(row.agent_id)
    if (!agent) {
      logger.warn({ callId: row.id }, 'analyze-all: agent not found, skipping')
      failed++
      continue
    }

    const call = {
      id: row.id,
      agentId: row.agent_id,
      duration: row.duration,
      outcome: row.outcome,
      transcript: JSON.parse(row.transcript_json),
    }

    const result = await service.analyze(call, agent)
    if (result) {
      passed++
    } else {
      failed++
    }
  }

  logger.info({ passed, failed, total: pending.length }, 'analyze-all: batch complete')

  const failRate = (failed / pending.length) * 100
  if (failRate > 5) {
    logger.warn({ failRate: failRate.toFixed(1) }, 'analyze-all: fail rate exceeds 5% — check OPENAI_API_KEY and prompts')
  }

  process.exit(0)
}

main().catch((err) => {
  logger.error({ err }, 'analyze-all: fatal error')
  process.exit(1)
})
