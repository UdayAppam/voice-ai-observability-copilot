const express = require('express')
const HLAuthService = require('../services/HLAuthService')
const IngestionService = require('../services/IngestionService')
const HighLevelTranscriptProvider = require('../providers/HighLevelTranscriptProvider')
const logger = require('../logger')

const router = express.Router()

// GET /api/oauth/callback?code=...&locationId=...
// HL redirects here after a sub-account user installs the app.
// Exchanges the auth code for tokens, persists them, then triggers an initial
// transcript sync so the dashboard has data immediately.
router.get('/callback', async (req, res, next) => {
  const { code, error, error_description } = req.query

  if (error) {
    logger.warn({ error, error_description }, 'OAuth callback received error')
    return res.status(400).send(`Install cancelled or failed: ${error_description || error}`)
  }
  if (!code) {
    return res.status(400).send('Missing ?code query param — invalid OAuth callback')
  }

  try {
    const authService = new HLAuthService()
    const { locationId } = await authService.exchangeCode(code)

    // Initial seed for this location so the dashboard is populated on first open
    const provider = new HighLevelTranscriptProvider({ locationId })
    const ingestionService = new IngestionService(provider)
    ingestionService.seedAll().catch((err) =>
      logger.error({ err: err.message, locationId }, 'oauth: initial seed failed')
    )

    // Redirect to the dashboard — when loaded as a Custom Page inside HL,
    // the user will see it directly in the sub-account left nav.
    res.redirect(`/dashboard/?locationId=${locationId}`)
  } catch (err) {
    next(err)
  }
})

// POST /api/webhooks/install (optional but recommended)
// HL fires this when an app is installed. Lets us know about installs
// even if the user never completes the redirect flow.
router.post('/webhooks/install', express.json(), (req, res) => {
  logger.info({ payload: req.body }, 'oauth: install webhook received')
  res.json({ ok: true })
})

// GET /api/oauth/installations — debug helper, lists installed locations
router.get('/installations', (_req, res) => {
  const list = new HLAuthService().listInstallations().map((i) => ({
    locationId: i.location_id,
    companyId: i.company_id,
    scope: i.scope,
    installedAt: i.installed_at,
    expiresAt: i.expires_at,
  }))
  res.json({ count: list.length, installations: list })
})

module.exports = router
