const logger = require('../logger')

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const status = err.status || 500
  const code = err.code || 'INTERNAL_ERROR'
  const message = err.message || 'An unexpected error occurred'

  if (status >= 500) {
    logger.error({ err, path: req.path, method: req.method }, 'server error')
  } else {
    logger.warn({ code, path: req.path }, message)
  }

  res.status(status).json({ error: { code, message, status } })
}

module.exports = errorHandler
