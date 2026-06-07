require('dotenv').config()

const express = require('express')
const path = require('path')
const logger = require('./logger')
const db = require('./db/database')
const auth = require('./middleware/auth')
const errorHandler = require('./middleware/errorHandler')

const app = express()

app.use(express.json({ limit: '2mb' }))

// Iframe-safe headers — dashboard MUST be embeddable inside HighLevel and the
// local test harness. Removing X-Frame-Options + setting permissive CSP frame-ancestors
// lets it load inside any iframe. (Acceptable for assignment scope.)
app.use((_req, res, next) => {
  res.removeHeader('X-Frame-Options')
  res.setHeader('Content-Security-Policy', "frame-ancestors *")
  next()
})

// Dev-only CORS for Vite dev server (localhost:5173/5174). In production, frontend
// is served from the same origin as the API so no CORS is needed.
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*')
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key')
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })
}

// Health check — no auth required, used by hosting platforms + uptime monitors
app.get('/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get()
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() })
  } catch (err) {
    logger.error({ err }, 'health check DB failure')
    res.status(503).json({ status: 'error', db: 'disconnected' })
  }
})

// Serve built Vue.js SPA — same origin as API, no CORS needed.
// Force index.html to never be cached so new builds are visible immediately.
const dashboardPath = path.join(__dirname, '../public/dashboard')
app.use('/dashboard', express.static(dashboardPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate')
    } else {
      // Hashed assets — safe to cache aggressively
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    }
  },
}))
app.get('/dashboard/*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate')
  res.sendFile(path.join(dashboardPath, 'index.html'))
})

// Auto-seed mock data on first start if DB is empty
async function autoSeed() {
  const count = db.prepare('SELECT COUNT(*) as n FROM agents').get()
  if (count.n === 0) {
    logger.info('auto-seed: database empty, seeding mock data')
    const provider = process.env.TRANSCRIPT_PROVIDER === 'highlevel'
      ? new (require('./providers/HighLevelTranscriptProvider'))()
      : new (require('./providers/MockTranscriptProvider'))()
    const IngestionService = require('./services/IngestionService')
    await new IngestionService(provider).seedAll()
  }
}

autoSeed().catch((err) => logger.error({ err }, 'auto-seed failed'))

// OAuth routes — NO X-API-Key required (HL itself is the caller)
app.use('/api/oauth',    require('./routes/oauth'))
app.use('/api/webhooks', require('./routes/oauth'))

// All other /api/* routes require API key auth
app.use('/api', auth)

app.use('/api/dashboard',       require('./routes/dashboard'))
app.use('/api/agents',          require('./routes/agents'))
app.use('/api/calls',           require('./routes/calls'))
app.use('/api/transcripts',     require('./routes/transcripts'))
app.use('/api/recommendations', require('./routes/recommendations'))
app.use('/api/flywheel',        require('./routes/flywheel'))
app.use('/api/patterns',        require('./routes/patterns'))
app.use('/api/actions',         require('./routes/actions'))
app.use('/api',                 require('./routes/apply'))   // V4: /agents/:id/recommendations/:rid/apply, /recommendations/:rid/{rollback,validate,preview-apply,history}

// Must be last — catches errors from all routes
app.use(errorHandler)

const PORT = Number(process.env.PORT) || 3000
app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'server started')
})

module.exports = app
