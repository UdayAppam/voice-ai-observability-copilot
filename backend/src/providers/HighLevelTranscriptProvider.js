const BaseTranscriptProvider = require('./BaseTranscriptProvider')
const HLAuthService = require('../services/HLAuthService')
const logger = require('../logger')

/**
 * HighLevel Voice AI Transcript Provider
 *
 * Activate by setting:
 *   TRANSCRIPT_PROVIDER=highlevel
 *   HL_PIT_TOKEN=pit-...                           (Private Integration Token)
 *   HL_LOCATION_ID=<your sub-account locationId>
 *   HL_API_BASE=https://services.leadconnectorhq.com  (default)
 *   HL_API_VERSION=2023-02-21                          (default — Voice AI API version)
 *
 * Required scopes (Marketplace App → Auth, OR Sub-Account → Private Integrations):
 *   - voice-ai-dashboard.readonly  (for call-logs endpoints)
 *   - voice-ai-agents.readonly     (for agents endpoint)
 *   - locations.readonly           (optional — for locationId discovery)
 *
 * Endpoints used:
 *   GET /voice-ai/agents?locationId={loc}                       → list agents
 *   GET /voice-ai/dashboard/call-logs?locationId={loc}&agentId  → list calls
 *   GET /voice-ai/dashboard/call-logs/{callId}                  → fetch full call + transcript
 */
class HighLevelTranscriptProvider extends BaseTranscriptProvider {
  // Auth resolution order:
  //   1. Explicit token passed in config (testing)
  //   2. OAuth installation in DB for the given locationId (Marketplace App flow)
  //   3. HL_PIT_TOKEN env var (PIT flow — single-tenant developer use)
  constructor(config = {}) {
    super()
    this.locationId = config.locationId || process.env.HL_LOCATION_ID
    this.explicitToken = config.token
    this.base = config.base || process.env.HL_API_BASE || 'https://services.leadconnectorhq.com'
    this.version = config.version || process.env.HL_API_VERSION || '2023-02-21'
    this.authService = new HLAuthService()

    if (!this.locationId) {
      throw new Error('HighLevelTranscriptProvider: locationId required (config or HL_LOCATION_ID)')
    }
  }

  _resolveToken() {
    if (this.explicitToken) return { token: this.explicitToken, source: 'explicit' }

    // Prefer OAuth installation (proper Marketplace App flow)
    const install = this.authService.getInstallation(this.locationId)
    if (install) return { token: install.access_token, source: 'oauth' }

    // Fallback: PIT from env var (single-tenant dev flow)
    if (process.env.HL_PIT_TOKEN) {
      return { token: process.env.HL_PIT_TOKEN, source: 'pit' }
    }

    throw new Error(
      `No HL auth for location ${this.locationId} — install the Marketplace app or set HL_PIT_TOKEN`
    )
  }

  async _request(path, { isRetry = false } = {}) {
    const { token, source } = this._resolveToken()
    const url = `${this.base}${path}`

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: this.version,
        Accept: 'application/json',
      },
    })

    if (res.ok) return res.json()

    const body = await res.text()
    let parsed
    try { parsed = JSON.parse(body) } catch { parsed = { raw: body } }

    // 401 on an OAuth-sourced token → attempt one refresh then retry once
    if (res.status === 401 && source === 'oauth' && !isRetry) {
      logger.info({ locationId: this.locationId }, 'HL 401 — refreshing OAuth token')
      try {
        await this.authService.refreshToken(this.locationId)
        return this._request(path, { isRetry: true })
      } catch (refreshErr) {
        logger.error({ err: refreshErr.message }, 'HL token refresh failed — user must reinstall')
      }
    }

    if (res.status === 401 && parsed.message?.includes('scope')) {
      logger.error(
        { url, status: res.status, message: parsed.message },
        'HL scope error — add voice-ai-dashboard.readonly + voice-ai-agents.readonly'
      )
    } else {
      logger.error({ url, status: res.status, body: parsed }, 'HL API request failed')
    }

    const err = new Error(`HL ${res.status}: ${parsed.message || body}`)
    err.status = res.status
    err.code = parsed.statusCode || 'HL_API_ERROR'
    throw err
  }

  async fetchAgents() {
    const params = new URLSearchParams({ locationId: this.locationId })
    const data = await this._request(`/voice-ai/agents?${params}`)

    // Normalize to internal Agent shape. HL responses vary slightly across versions —
    // try common field paths.
    const list = data.agents || data.data || data.items || []

    // Confirmed HL response shape:
    //   { id, locationId, agentName, businessName, welcomeMessage, agentPrompt, ... }
    return list.map((a) => ({
      id: a.id || a._id || a.agentId,
      name: a.agentName || a.name || a.displayName || 'Unnamed Agent',
      // No dedicated "goal" field — derive from businessName + first line of prompt
      goal: a.businessName
        ? `Voice AI agent for ${a.businessName}`
        : (a.welcomeMessage || '').slice(0, 200),
      // Full prompt is the agent's "script" for our analysis
      script: a.agentPrompt || a.prompt || a.script || '',
      // KPI defs not provided by HL — we use the default set seeded by IngestionService
      kpiDefinitions: undefined,
    }))
  }

  async fetchCalls(agentId) {
    // HL paginates via page/pageSize (1-based). pageSize max is 50 per request.
    // The list endpoint INCLUDES the full transcript string per call, so we cache
    // each call here for fetchTranscript() to reuse — no second request needed.
    // Auto-paginate until we have everything (cap at 10 pages = 500 calls).
    this._callCache = this._callCache || new Map()
    const list = []
    for (let page = 1; page <= 10; page++) {
      const params = new URLSearchParams({
        locationId: this.locationId,
        agentId,
        pageSize: '50',
        page: String(page),
      })
      const data = await this._request(`/voice-ai/dashboard/call-logs?${params}`)
      const batch = data.callLogs || []
      list.push(...batch)
      for (const call of batch) this._callCache.set(call.id, call)
      if (batch.length < 50) break  // last page
    }

    return list.map((c) => ({
      id: c.id,
      agentId: c.agentId,
      callerNumber: c.contactId || null,    // HL gives contactId, not phone
      duration: c.duration,
      outcome: this._normaliseOutcome(c),
      callTimestamp: c.createdAt,
    }))
  }

  async fetchTranscript(callId) {
    // Use cached call from fetchCalls() if available, else hit the detail endpoint.
    let data = this._callCache?.get(callId)
    if (!data) {
      data = await this._request(`/voice-ai/dashboard/call-logs/${callId}`)
    }

    return {
      id: data.id,
      agentId: data.agentId,
      callerNumber: data.contactId || null,
      duration: data.duration,
      outcome: this._normaliseOutcome(data),
      callTimestamp: data.createdAt,
      transcript: this._parseTranscript(data.transcript),
    }
  }

  // Parses HL's newline-separated "bot:...\nhuman:..." transcript string into
  // our internal turn array shape. Each line starts with "bot:" or "human:".
  // A turn body may span multiple lines until the next role prefix.
  _parseTranscript(raw) {
    if (!raw || typeof raw !== 'string') return []

    const lines = raw.split('\n')
    const turns = []
    let current = null

    for (const line of lines) {
      const match = line.match(/^(bot|human|user|agent|assistant|ai)\s*:\s*(.*)$/i)
      if (match) {
        if (current) turns.push(current)
        current = {
          turnIndex: turns.length,
          speaker: this._normaliseSpeaker(match[1]),
          text: match[2].trim(),
          timestamp: turns.length,    // HL doesn't expose per-turn timestamps
          confidence: 1.0,
        }
      } else if (current && line.trim()) {
        // Continuation line for the current turn
        current.text = (current.text + ' ' + line.trim()).trim()
      }
    }
    if (current) turns.push(current)

    return turns.filter((t) => t.text)
  }

  _normaliseSpeaker(role) {
    if (!role) return 'agent'
    const r = String(role).toLowerCase()
    if (['agent', 'assistant', 'ai', 'bot'].includes(r)) return 'agent'
    return 'human'
  }

  _normaliseOutcome(call) {
    // HL exposes executedCallActions array (e.g. appointment_booked, contact_created)
    const actions = (call.executedCallActions || call.actions || []).map((a) =>
      String(a).toLowerCase()
    )

    if (actions.some((a) => a.includes('appointment') || a.includes('booking'))) return 'booked'
    if (actions.some((a) => a.includes('transfer') || a.includes('escalat'))) return 'escalated'
    if ((call.duration ?? 999) < 30) return 'dropped'
    return 'no_booking'
  }
}

module.exports = HighLevelTranscriptProvider
