const crypto = require('crypto')
const db = require('../db/database')
const logger = require('../logger')

// Tracks every distinct version of an agent's prompt/script.
// Each call links to the prompt_version_id that was active at ingest time —
// so when a user updates the HL agent prompt, we can causally compare
// before-prompt-change calls vs after-prompt-change calls.
class PromptVersionService {
  // Hash deterministically over the things that matter for behaviour:
  // the script (prompt) and the goal. Whitespace-normalised so trivial
  // edits don't churn versions.
  static hashPrompt(agent) {
    const normalized = [
      (agent.script || '').trim().replace(/\s+/g, ' '),
      (agent.goal || '').trim().replace(/\s+/g, ' '),
    ].join('|')
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  }

  // Called whenever we fetch an agent from HL. Returns:
  //   { versionId, isNew: bool, prevVersionId: <if changed>|null }
  static recordIfChanged(agent) {
    const hash = this.hashPrompt(agent)
    const existing = db
      .prepare('SELECT id FROM agent_prompt_versions WHERE agent_id = ? AND prompt_hash = ?')
      .get(agent.id, hash)

    if (existing) {
      db.prepare(
        'UPDATE agent_prompt_versions SET last_seen_at = datetime(\'now\') WHERE id = ?'
      ).run(existing.id)
      return { versionId: existing.id, isNew: false, prevVersionId: null }
    }

    // It's a new (or first-ever) version for this agent.
    // Find prior version so caller can react (e.g. mark recs applied).
    const prev = db
      .prepare(
        `SELECT id FROM agent_prompt_versions
         WHERE agent_id = ? ORDER BY first_seen_at DESC LIMIT 1`
      )
      .get(agent.id)

    const id = crypto.randomUUID()
    db.prepare(`
      INSERT INTO agent_prompt_versions
        (id, agent_id, prompt_hash, prompt_text, goal_text)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, agent.id, hash, agent.script || '', agent.goal || '')

    logger.info(
      { agentId: agent.id, agentName: agent.name, newVersionId: id, prevVersionId: prev?.id ?? null },
      prev ? 'prompt-version: NEW version detected (prior prompt replaced)' : 'prompt-version: initial version recorded'
    )

    return { versionId: id, isNew: true, prevVersionId: prev?.id ?? null }
  }

  static getCurrentVersionId(agentId) {
    const row = db
      .prepare(
        `SELECT id FROM agent_prompt_versions
         WHERE agent_id = ? ORDER BY first_seen_at DESC LIMIT 1`
      )
      .get(agentId)
    return row?.id ?? null
  }

  static incrementCallCount(versionId) {
    db.prepare(
      'UPDATE agent_prompt_versions SET call_count = call_count + 1 WHERE id = ?'
    ).run(versionId)
  }
}

module.exports = PromptVersionService
