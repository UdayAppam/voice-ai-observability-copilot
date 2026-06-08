// LocalAgentService — V4.8
// Mirror of HLVoiceAgentService's public interface for test/demo agents (`reg-*`
// IDs) that don't exist in HighLevel. Reads + writes the local `agents` table,
// so the entire V4 apply orchestration (snapshot → "PATCH" → record version →
// mark applied → audit → measure) works against test DB without HL connectivity.
//
// Used by the adapter factory in ApplyRecommendationService.js + routes/apply.js
// to swap behind the existing apply pipeline. Live agents continue to use
// HLVoiceAgentService unchanged.

const db = require('../db/database')
const logger = require('../logger')

class LocalAgentService {
  constructor() {
    // No HL credentials needed — purely local.
  }

  // Matches HLVoiceAgentService.getAgent shape so downstream callers
  // (preview-apply, ApplyRecommendationService, validators) don't notice
  // the difference. The HL response uses `agentName` / `agentPrompt`; our
  // local table stores them as `name` / `script`.
  async getAgent(agentId) {
    const row = db.prepare(
      'SELECT id, name, goal, script FROM agents WHERE id = ?'
    ).get(agentId)
    if (!row) {
      const err = new Error(`LocalAgentService: agent ${agentId} not found in local agents table`)
      err.status = 404
      err.code = 'LOCAL_AGENT_NOT_FOUND'
      throw err
    }
    return {
      id:           row.id,
      agentName:    row.name,
      agentPrompt:  row.script || '',
      goal:         row.goal  || '',
    }
  }

  // Mirror of HLVoiceAgentService.updateAgent. Accepts the same patchBody
  // shape (`{ agentPrompt, agentName, goal }`) for symmetry. Writes go to the
  // local agents table; returns the post-update agent shape.
  async updateAgent(agentId, patchBody) {
    if (!patchBody || typeof patchBody !== 'object' || Object.keys(patchBody).length === 0) {
      throw new Error('LocalAgentService.updateAgent: patchBody must be a non-empty object')
    }
    const setClauses = []
    const params = []
    if (patchBody.agentPrompt !== undefined) {
      setClauses.push('script = ?')
      params.push(patchBody.agentPrompt)
    }
    if (patchBody.agentName !== undefined) {
      setClauses.push('name = ?')
      params.push(patchBody.agentName)
    }
    if (patchBody.goal !== undefined) {
      setClauses.push('goal = ?')
      params.push(patchBody.goal)
    }
    if (setClauses.length === 0) {
      throw new Error(`LocalAgentService.updateAgent: no recognised fields in patchBody (got ${Object.keys(patchBody).join(',')})`)
    }
    setClauses.push("updated_at = datetime('now')")
    params.push(agentId)
    const result = db.prepare(
      `UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...params)
    if (result.changes === 0) {
      const err = new Error(`LocalAgentService.updateAgent: agent ${agentId} not found`)
      err.status = 404
      err.code = 'LOCAL_AGENT_NOT_FOUND'
      throw err
    }
    logger.info(
      { agentId, patched: Object.keys(patchBody) },
      'LocalAgentService: agent updated (test-DB mock for HL PATCH)'
    )
    return this.getAgent(agentId)
  }

  async updateAgentPrompt(agentId, newAgentPrompt) {
    if (typeof newAgentPrompt !== 'string' || newAgentPrompt.length === 0) {
      throw new Error('LocalAgentService.updateAgentPrompt: newAgentPrompt must be a non-empty string')
    }
    return this.updateAgent(agentId, { agentPrompt: newAgentPrompt })
  }
}

// Factory — picks the right service for the given agent ID. Test/demo agents
// (id LIKE 'reg-%') are served by LocalAgentService; everything else hits HL.
// Centralised here so callers in apply.js + ApplyRecommendationService stay
// agnostic to which backend will serve the request.
function getAgentService(agentId, { locationId } = {}) {
  if (typeof agentId === 'string' && agentId.startsWith('reg-')) {
    return new LocalAgentService()
  }
  // Lazy import to avoid circular dep risk (HLVoiceAgentService pulls in HLAuth)
  const HLVoiceAgentService = require('./HLVoiceAgentService')
  return new HLVoiceAgentService({ locationId })
}

module.exports = LocalAgentService
module.exports.getAgentService = getAgentService
