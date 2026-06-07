// HLVoiceAgentService — wraps HighLevel's Voice AI agent read + write API.
//
// Endpoints used:
//   GET   /voice-ai/agents/:agentId?locationId=…    → fetch single agent (full shape)
//   PATCH /voice-ai/agents/:agentId?locationId=…    → partial update (e.g. just agentPrompt)
//
// Required scopes:
//   voice-ai-agents.readonly   (for reads — already in our existing OAuth)
//   voice-ai-agents.write      (for the PATCH path — must be granted on the OAuth install or PIT)
//
// Auth resolution order (mirrors HighLevelTranscriptProvider's pattern):
//   1. Explicit token passed to constructor (for testing)
//   2. OAuth installation in DB for the given locationId
//   3. HL_PIT_TOKEN env var (single-tenant developer fallback)
//
// Phase 1 discovery (2026-06-07) confirmed:
//   - Voice AI agents have a single `agentPrompt` string (no node/edge graph)
//   - No native versioning fields → rollback handled by us via apply_attempts.previous_agent_prompt
//   - The 401 returned on PATCH without write scope confirms the endpoint exists

const logger = require('../logger')
const HLAuthService = require('./HLAuthService')

const HL_API_BASE    = process.env.HL_API_BASE    || 'https://services.leadconnectorhq.com'
const HL_API_VERSION = process.env.HL_API_VERSION || '2023-02-21'

// Typed errors so the orchestrator + route layer can branch on them sensibly.
class HLApiError extends Error {
  constructor(message, { status, body, code } = {}) {
    super(message)
    this.name = 'HLApiError'
    this.status = status
    this.body = body
    this.code = code
  }
}
class HLScopeError extends HLApiError {
  constructor(message, opts = {}) { super(message, { ...opts, code: 'SCOPE_MISSING' }); this.name = 'HLScopeError' }
}
class HLAuthExpiredError extends HLApiError {
  constructor(message, opts = {}) { super(message, { ...opts, code: 'AUTH_EXPIRED' }); this.name = 'HLAuthExpiredError' }
}
class HLNotFoundError extends HLApiError {
  constructor(message, opts = {}) { super(message, { ...opts, code: 'NOT_FOUND' }); this.name = 'HLNotFoundError' }
}

class HLVoiceAgentService {
  constructor({ locationId, token } = {}) {
    this.locationId = locationId || process.env.HL_LOCATION_ID
    this.explicitToken = token
    this.authService = new HLAuthService()
    if (!this.locationId) {
      throw new Error('HLVoiceAgentService: locationId required (constructor or HL_LOCATION_ID env)')
    }
  }

  // ── PUBLIC API ─────────────────────────────────────────────────────────

  // Fetch the full Voice AI agent shape. Returns the HL response unchanged
  // so downstream callers can pull whichever fields they need.
  // Caller-facing normalised fields: id, agentName, agentPrompt, welcomeMessage.
  async getAgent(agentId) {
    return this._request('GET', `/voice-ai/agents/${agentId}`)
  }

  // Update a Voice AI agent. `patchBody` is sent as-is — caller controls
  // which fields go in. Most common case: { agentPrompt: '...' }.
  // Returns the updated agent shape (HL responds with the full object on 200).
  async updateAgent(agentId, patchBody) {
    if (!patchBody || typeof patchBody !== 'object' || Object.keys(patchBody).length === 0) {
      throw new Error('HLVoiceAgentService.updateAgent: patchBody must be a non-empty object')
    }
    return this._request('PATCH', `/voice-ai/agents/${agentId}`, patchBody)
  }

  // Convenience wrapper for the V4 happy path: update just the agentPrompt.
  async updateAgentPrompt(agentId, newAgentPrompt) {
    if (typeof newAgentPrompt !== 'string' || newAgentPrompt.length === 0) {
      throw new Error('HLVoiceAgentService.updateAgentPrompt: newAgentPrompt must be a non-empty string')
    }
    return this.updateAgent(agentId, { agentPrompt: newAgentPrompt })
  }

  // ── INTERNAL ────────────────────────────────────────────────────────────

  // Resolves the bearer token used for the call, with OAuth taking priority
  // over PIT. Reuses the install's access_token (no refresh attempt here —
  // refresh is triggered reactively on 401 below).
  _resolveToken() {
    if (this.explicitToken) return { token: this.explicitToken, source: 'explicit' }
    const install = this.authService.getInstallation(this.locationId)
    if (install?.access_token) return { token: install.access_token, source: 'oauth' }
    const pit = process.env.HL_PIT_TOKEN
    if (pit) return { token: pit, source: 'pit' }
    throw new HLApiError('No HL credentials available (no OAuth installation, no HL_PIT_TOKEN)', { status: 0, code: 'NO_AUTH' })
  }

  async _request(method, path, body = null, { _isRetry = false } = {}) {
    const { token, source } = this._resolveToken()

    // locationId is required on every Voice AI request — append unless already there
    const sep = path.includes('?') ? '&' : '?'
    const url = `${HL_API_BASE}${path}${sep}locationId=${encodeURIComponent(this.locationId)}`

    const init = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: HL_API_VERSION,
        Accept: 'application/json',
      },
    }
    if (body) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }

    const start = Date.now()
    const res = await fetch(url, init)
    const latencyMs = Date.now() - start

    let parsed
    const text = await res.text()
    try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { message: text } }

    logger.info(
      { method, path, status: res.status, latencyMs, authSource: source },
      `HL Voice AI request: ${method} ${path}`
    )

    if (res.ok) return parsed

    // Map HL's error responses to typed errors the orchestrator can pattern-match.
    if (res.status === 401) {
      const isScope = typeof parsed.message === 'string' && /scope/i.test(parsed.message)
      if (isScope) {
        throw new HLScopeError(
          `HL rejected scope on ${method} ${path}: ${parsed.message}. ` +
          `For PATCH you need voice-ai-agents.write — add it to the PIT in HL Sandbox ` +
          `(Settings → Private Integrations) or re-install the Marketplace App with the scope.`,
          { status: 401, body: parsed }
        )
      }
      // Try a refresh once for OAuth tokens (HL access tokens expire after ~24h)
      if (!_isRetry && source === 'oauth') {
        try {
          await this.authService.refreshToken(this.locationId)
          return this._request(method, path, body, { _isRetry: true })
        } catch (refreshErr) {
          throw new HLAuthExpiredError(
            `HL token expired and refresh failed: ${refreshErr.message}. User must re-install the Marketplace App.`,
            { status: 401, body: parsed }
          )
        }
      }
      throw new HLAuthExpiredError(`HL auth rejected: ${parsed.message || res.statusText}`, { status: 401, body: parsed })
    }

    // HL returns 403 for "not in this location" — semantically same as 404 for our purposes
    if (res.status === 404 || res.status === 403) {
      throw new HLNotFoundError(
        `HL ${method} ${path} returned ${res.status} — agent not found in this location (or no access)`,
        { status: res.status, body: parsed }
      )
    }

    throw new HLApiError(
      `HL ${method} ${path} failed: ${res.status} ${res.statusText} — ${parsed.message || text}`,
      { status: res.status, body: parsed }
    )
  }
}

module.exports = HLVoiceAgentService
module.exports.HLApiError = HLApiError
module.exports.HLScopeError = HLScopeError
module.exports.HLAuthExpiredError = HLAuthExpiredError
module.exports.HLNotFoundError = HLNotFoundError
