const db = require('../db/database')
const logger = require('../logger')

const HL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token'
const HL_LOCATION_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/locationToken'
const HL_API_VERSION = '2023-02-21'

class HLAuthService {
  constructor(config = {}) {
    this.clientId = config.clientId || process.env.HL_CLIENT_ID
    this.clientSecret = config.clientSecret || process.env.HL_CLIENT_SECRET
    this.redirectUri = config.redirectUri || process.env.HL_REDIRECT_URI

    if (!this.clientId || !this.clientSecret) {
      logger.warn('HLAuthService: HL_CLIENT_ID / HL_CLIENT_SECRET not set — OAuth disabled')
    }
  }

  // Exchanges the `?code=...` callback param for an access token + refresh token.
  // Called from /api/oauth/callback after a sub-account user installs the app.
  //
  // HL returns either:
  //   - Location token (sub-account-scoped app) → has locationId, store as-is
  //   - Company token  (agency-scoped app)      → no locationId, must convert
  //     via /oauth/locationToken using a known locationId (HL_LOCATION_ID env
  //     or the install webhook payload).
  async exchangeCode(code) {
    const res = await fetch(HL_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'authorization_code',
        code,
        user_type: 'Location',          // requested — HL may downgrade to Company
        redirect_uri: this.redirectUri,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      logger.error({ status: res.status, body }, 'HL token exchange failed')
      throw new Error(`HL token exchange failed: ${res.status} — ${body}`)
    }

    const data = await res.json()
    // Verbose enough to debug install-context mismatches without leaking tokens.
    logger.info(
      {
        userType:    data.userType,
        locationId:  data.locationId || null,
        companyId:   data.companyId  || null,
        scope:       data.scope      || null,
        expiresIn:   data.expires_in,
      },
      'HL token exchange OK'
    )

    // Case 1: response has locationId → it's a Location token, store directly
    if (data.locationId) {
      return this._persistTokens(data)
    }

    // Case 2: Company token — convert to Location token(s)
    if (data.userType === 'Company' && data.companyId) {
      const targetLocationId = process.env.HL_LOCATION_ID
      if (!targetLocationId) {
        throw new Error(
          'Received Company token but HL_LOCATION_ID not set. ' +
          'Either set HL_LOCATION_ID env var OR change app distribution type to "Sub-Account" in HL Developer Portal.'
        )
      }
      logger.info({ companyId: data.companyId, targetLocationId }, 'Converting Company → Location token')
      return this.convertToLocationToken(data.access_token, data.companyId, targetLocationId)
    }

    throw new Error('Token response unrecognised: no locationId and no companyId')
  }

  // Converts an agency (Company) access token to a sub-account (Location) token.
  // Required when the app distribution type is "Agency" but we need per-location API access.
  async convertToLocationToken(companyAccessToken, companyId, locationId) {
    const res = await fetch(HL_LOCATION_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${companyAccessToken}`,
        Version: HL_API_VERSION,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ companyId, locationId }),
    })

    if (!res.ok) {
      const body = await res.text()
      logger.error({ status: res.status, body, locationId, companyId }, 'HL locationToken conversion failed')
      // Add the locationId we tried + the most common cause so debugging the
      // error message alone is enough — no log-diving required.
      throw new Error(
        `Location token conversion failed: ${res.status} — ${body}\n` +
        `  → tried locationId="${locationId}" for companyId="${companyId}".\n` +
        `  → Cause: that company doesn't own that location. Either (a) change the app's distribution to "Sub-Account" in the HL Marketplace so locationId is auto-resolved, OR (b) set HL_LOCATION_ID to a sub-account that the installing company owns.`
      )
    }

    const data = await res.json()
    return this._persistTokens({
      ...data,
      locationId,
      companyId,
      userType: 'Location',
    })
  }

  // Refreshes a single installation's token. Called automatically when an API
  // request fails with 401 (see HighLevelTranscriptProvider).
  async refreshToken(locationId) {
    const install = this.getInstallation(locationId)
    if (!install) throw new Error(`No installation found for location ${locationId}`)

    const res = await fetch(HL_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: install.refresh_token,
        user_type: 'Location',
        redirect_uri: this.redirectUri,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      logger.error({ locationId, status: res.status, body }, 'HL token refresh failed')
      throw new Error(`HL refresh failed: ${res.status}`)
    }

    return this._persistTokens(await res.json())
  }

  getInstallation(locationId) {
    return db
      .prepare('SELECT * FROM oauth_installations WHERE location_id = ?')
      .get(locationId)
  }

  listInstallations() {
    return db.prepare('SELECT * FROM oauth_installations ORDER BY installed_at DESC').all()
  }

  _persistTokens(tokenData) {
    const locationId = tokenData.locationId || tokenData.location_id
    const companyId = tokenData.companyId || tokenData.company_id
    if (!locationId) {
      throw new Error('Token response missing locationId — app may not be sub-account scoped')
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in - 60) * 1000).toISOString()

    db.prepare(`
      INSERT INTO oauth_installations
        (location_id, company_id, user_type, access_token, refresh_token, scope, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(location_id) DO UPDATE SET
        company_id    = excluded.company_id,
        user_type     = excluded.user_type,
        access_token  = excluded.access_token,
        refresh_token = excluded.refresh_token,
        scope         = excluded.scope,
        expires_at    = excluded.expires_at,
        updated_at    = datetime('now')
    `).run(
      locationId,
      companyId || '',
      tokenData.userType || 'Location',
      tokenData.access_token,
      tokenData.refresh_token,
      tokenData.scope || '',
      expiresAt
    )

    logger.info({ locationId, companyId, scope: tokenData.scope }, 'HL token stored')
    return { locationId, companyId, scope: tokenData.scope, expiresAt }
  }
}

module.exports = HLAuthService
