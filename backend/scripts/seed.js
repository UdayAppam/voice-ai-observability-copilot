require('dotenv').config()

const db = require('../src/db/database')
const logger = require('../src/logger')
const IngestionService = require('../src/services/IngestionService')

const PROVIDER = process.env.TRANSCRIPT_PROVIDER || 'mock'

async function main() {
  const isTruncate = process.argv.includes('--fresh')

  if (isTruncate) {
    logger.info('seed: truncating existing data')
    db.exec('DELETE FROM agent_insights')
    db.exec('DELETE FROM analyses')
    db.exec('DELETE FROM calls')
    db.exec('DELETE FROM kpi_definitions')
    db.exec('DELETE FROM agents')
  }

  let Provider
  if (PROVIDER === 'mock') {
    Provider = require('../src/providers/MockTranscriptProvider')
  } else {
    Provider = require('../src/providers/HighLevelTranscriptProvider')
  }

  const provider = new Provider()
  const service = new IngestionService(provider)

  await service.seedAll()
  logger.info('seed: done — run `npm run analyze-all` to trigger OpenAI analysis')
  process.exit(0)
}

main().catch((err) => {
  logger.error({ err }, 'seed: failed')
  process.exit(1)
})
