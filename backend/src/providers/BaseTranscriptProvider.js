// Interface contract — all providers must implement these three methods.
// Swap TRANSCRIPT_PROVIDER env var to change the source without touching any other code.
class BaseTranscriptProvider {
  // Returns Agent[] — { id, name, goal, script, kpiDefinitions[] }
  async fetchAgents() {
    throw new Error(`${this.constructor.name} must implement fetchAgents()`)
  }

  // Returns CallMeta[] — { id, agentId, callerNumber, duration, outcome, callTimestamp }
  async fetchCalls(_agentId) {
    throw new Error(`${this.constructor.name} must implement fetchCalls()`)
  }

  // Returns Transcript — { ...callMeta, transcript: Turn[] }
  // Turn: { turnIndex, speaker, text, timestamp, confidence }
  async fetchTranscript(_callId) {
    throw new Error(`${this.constructor.name} must implement fetchTranscript()`)
  }
}

module.exports = BaseTranscriptProvider
