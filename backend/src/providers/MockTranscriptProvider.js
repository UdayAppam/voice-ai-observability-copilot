const fs = require('fs')
const path = require('path')
const BaseTranscriptProvider = require('./BaseTranscriptProvider')

const DATA_DIR = path.join(__dirname, '../../mock-data')

class MockTranscriptProvider extends BaseTranscriptProvider {
  constructor() {
    super()
    this._agents = null
    this._callIndex = new Map() // callId → { agentId, filePath }
  }

  async fetchAgents() {
    if (!this._agents) {
      const raw = fs.readFileSync(path.join(DATA_DIR, 'agents.json'), 'utf8')
      this._agents = JSON.parse(raw)
    }
    return this._agents
  }

  async fetchCalls(agentId) {
    const filePath = path.join(DATA_DIR, 'calls', `${agentId}.json`)
    if (!fs.existsSync(filePath)) return []

    const raw = fs.readFileSync(filePath, 'utf8')
    const calls = JSON.parse(raw)

    // Build index for fetchTranscript
    for (const call of calls) {
      this._callIndex.set(call.id, { agentId, filePath })
    }

    // Return metadata only (strip transcript + scenario from call list)
    return calls.map(({ id, agentId: aId, callerNumber, duration, outcome, callTimestamp }) => ({
      id,
      agentId: aId,
      callerNumber,
      duration,
      outcome,
      callTimestamp,
    }))
  }

  async fetchTranscript(callId) {
    // Build index if not already done
    if (!this._callIndex.has(callId)) {
      const agents = await this.fetchAgents()
      for (const agent of agents) {
        await this.fetchCalls(agent.id)
      }
    }

    const entry = this._callIndex.get(callId)
    if (!entry) throw new Error(`MockTranscriptProvider: callId not found — ${callId}`)

    const raw = fs.readFileSync(entry.filePath, 'utf8')
    const calls = JSON.parse(raw)
    const call = calls.find((c) => c.id === callId)
    if (!call) throw new Error(`MockTranscriptProvider: callId missing in file — ${callId}`)

    // Strip scenario field — OpenAI should infer it from transcript content
    // eslint-disable-next-line no-unused-vars
    const { scenario, ...rest } = call
    return rest
  }

  // Used by the demo "Simulate New Call" feature (Phase 6)
  async fetchDemoCall(agentId) {
    const filePath = path.join(DATA_DIR, 'demo-calls', `${agentId}_demo.json`)
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  }
}

module.exports = MockTranscriptProvider
