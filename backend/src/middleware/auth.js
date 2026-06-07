const logger = require('../logger')

function auth(req, res, next) {
  const key = req.headers['x-api-key']

  if (!key || key !== process.env.API_KEY) {
    logger.warn({ ip: req.ip, path: req.path }, 'unauthorized request rejected')
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid API key',
        status: 401,
      },
    })
  }

  next()
}

module.exports = auth
