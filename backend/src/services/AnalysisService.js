const OpenAI = require('openai')
const crypto = require('crypto')
const db = require('../db/database')
const logger = require('../logger')
const RecommendationService = require('./RecommendationService')
const PromptVersionService = require('./PromptVersionService')

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

// JSON schema enforced via OpenAI structured output (strict: true)
const ANALYZE_CALL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    overallScore: { type: 'integer', minimum: 0, maximum: 100 },
    kpiScores: {
      type: 'object',
      properties: {
        call_completion:   { type: 'integer', minimum: 0, maximum: 100 },
        script_adherence:  { type: 'integer', minimum: 0, maximum: 100 },
        objection_handling:{ type: 'integer', minimum: 0, maximum: 100 },
        sentiment_score:   { type: 'integer', minimum: 0, maximum: 100 },
        response_quality:  { type: 'integer', minimum: 0, maximum: 100 },
        escalation_rate:   { type: 'integer', minimum: 0, maximum: 100 },
      },
      required: ['call_completion','script_adherence','objection_handling',
                 'sentiment_score','response_quality','escalation_rate'],
      additionalProperties: false,
    },
    rootCauses: { type: 'array', items: { type: 'string' } },
    deviations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turnIndex:   { type: 'integer' },
          type:        { type: 'string', enum: ['missed_step','wrong_response','off_script'] },
          description: { type: 'string' },
        },
        required: ['turnIndex','type','description'],
        additionalProperties: false,
      },
    },
    missedOpportunities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turnIndex:   { type: 'integer' },
          opportunity: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['turnIndex','opportunity','description'],
        additionalProperties: false,
      },
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type:            { type: 'string', enum: ['prompt','script','training'] },
          severity:        { type: 'string', enum: ['critical','warning','suggestion'] },
          title:           { type: 'string' },
          detail:          { type: 'string' },
          suggestedChange: { type: 'string' },
        },
        required: ['type','severity','title','detail','suggestedChange'],
        additionalProperties: false,
      },
    },
    useActions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turnIndex:          { type: 'integer' },
          reason:             { type: 'string' },
          actionType:         { type: 'string', enum: ['human_intervention','script_training','escalation'] },
          transcript_segment: { type: 'string' },
        },
        required: ['turnIndex','reason','actionType','transcript_segment'],
        additionalProperties: false,
      },
    },
    hallucinations: {
      type: 'array',
      description: 'Specific agent turns where the AI stated facts NOT supported by the conversation context, invented policies/prices/capabilities, or made unverifiable claims. This is distinct from script deviations.',
      items: {
        type: 'object',
        properties: {
          turnIndex:  { type: 'integer' },
          type:       { type: 'string', enum: ['fabricated_fact','invented_policy','made_up_capability','wrong_price','unverified_claim'] },
          claim:      { type: 'string', description: "The exact quote from the agent that constitutes the hallucination" },
          confidence: { type: 'string', enum: ['high','medium','low'] },
          impact:     { type: 'string', description: 'Brief explanation of why this hallucination matters' },
        },
        required: ['turnIndex','type','claim','confidence','impact'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary','overallScore','kpiScores','rootCauses',
             'deviations','missedOpportunities','recommendations','useActions','hallucinations'],
  additionalProperties: false,
}

function buildSystemPrompt(agent) {
  const kpiList = db
    .prepare('SELECT name, label, weight, threshold, description FROM kpi_definitions WHERE agent_id = ?')
    .all(agent.id)
    .map((k) => `- ${k.label} (${k.name}): weight=${k.weight}, pass threshold=${k.threshold}/100 — ${k.description}`)
    .join('\n')

  return `You are a Voice AI performance analyst. Your job is to evaluate call transcripts for AI voice agents and produce structured, actionable analysis.

AGENT CONTEXT
Name: ${agent.name}
Goal: ${agent.goal}

AGENT SCRIPT (steps the agent must follow in order):
${agent.script}

KPI DEFINITIONS (score each 0-100):
${kpiList}

SCORING RULES
- call_completion: 100 if goal achieved (booked/qualified/renewed), 0 if caller left without outcome
- script_adherence: deduct points for each script step skipped or done out of order
- objection_handling: 100 if agent pivots to value on objection; 0 if agent simply restates the price or accepts rejection
- sentiment_score: assess caller's emotional tone arc across the call (start vs end)
- response_quality: score how relevant, natural, and goal-advancing each agent response is
- escalation_rate: 100 if NO escalation needed; 0 if call required human handoff

OVERALLSCORE: provide your best estimate 0-100. The backend will RECOMPUTE this deterministically from your per-KPI scores × stored weights — your value is only used as a sanity check. Focus on the per-KPI scores; those are what matter.

MISSED OPPORTUNITIES: Identify moments where the agent COULD have offered something valuable (upsell, alternative, deeper engagement) but did not. Reference the specific turn.

HALLUCINATIONS: Identify any agent turns where the AI made claims NOT supported by its script or the conversation context — e.g. inventing prices, fabricating policies, claiming capabilities it doesn't have, asserting facts with no basis, or making unverifiable promises. Each hallucination MUST quote the exact agent text. Use 'high' confidence only when the claim clearly contradicts the documented script.

DEVIATIONS: Identify where the agent deviated from the numbered script steps above.

RECOMMENDATIONS: Must reference specific transcript content. suggestedChange must be actual script text the agent could use, not vague advice.

Be precise and specific — reference actual turns and exact quotes where possible.`
}

function buildUserPrompt(call, agent) {
  const turns = call.transcript
    .map((t) => `[Turn ${t.turnIndex}] ${t.speaker === 'agent' ? agent.name : 'Caller'}: ${t.text}`)
    .join('\n')

  const duration = call.duration ? `${Math.floor(call.duration / 60)}m ${call.duration % 60}s` : 'unknown'
  const totalTurns = call.transcript.length
  const agentTurns = call.transcript.filter((t) => t.speaker === 'agent').length
  const talkRatio = Math.round((agentTurns / totalTurns) * 100)

  return `Analyze the following call transcript.

CALL METADATA
Call ID: ${call.id}
Duration: ${duration}
Total turns: ${totalTurns}
Agent talk ratio: ${talkRatio}% of turns
Recorded outcome: ${call.outcome || 'unknown'}

TRANSCRIPT
${turns}

Provide a complete structured analysis per the schema.`
}

class AnalysisService {
  async analyze(call, agent) {
    const start = Date.now()
    logger.info({ callId: call.id, agentId: agent.id }, 'analysis: starting')

    try {
      db.prepare("UPDATE calls SET analysis_status = 'analyzing' WHERE id = ?").run(call.id)

      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt(agent) },
          { role: 'user',   content: buildUserPrompt(call, agent) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'analyze_call',
            strict: true,
            schema: ANALYZE_CALL_SCHEMA,
          },
        },
        temperature: 0.2,
      })

      const latencyMs = Date.now() - start
      const usage = response.usage
      logger.info(
        { callId: call.id, latencyMs, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens },
        'analysis: OpenAI call complete'
      )

      const result = JSON.parse(response.choices[0].message.content)

      // Trust OpenAI for SEMANTIC scoring (per-KPI 0-100).
      // Do NOT trust it for ARITHMETIC — recompute overall_score from KPI
      // scores × stored weights so the number matches docs/§3.6 exactly.
      const kpiDefs = db
        .prepare('SELECT name, weight FROM kpi_definitions WHERE agent_id = ?')
        .all(agent.id)
      const totalWeight = kpiDefs.reduce((s, k) => s + k.weight, 0) || 1
      const computedOverall = Math.round(
        kpiDefs.reduce((sum, k) => sum + (result.kpiScores[k.name] || 0) * k.weight, 0) / totalWeight
      )

      if (Math.abs(computedOverall - result.overallScore) >= 3) {
        logger.info(
          { callId: call.id, openai: result.overallScore, computed: computedOverall },
          'overall_score: replacing LLM value with deterministic weighted formula'
        )
      }
      result.overallScore = computedOverall

      const status = computedOverall >= 70 ? 'pass' : computedOverall >= 50 ? 'warning' : 'fail'

      db.prepare(`
        INSERT INTO analyses
          (id, call_id, overall_score, status, summary, root_causes_json,
           kpi_scores_json, deviations_json, missed_opportunities_json,
           recommendations_json, use_actions_json, hallucinations_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        call.id,
        computedOverall,
        status,
        result.summary,
        JSON.stringify(result.rootCauses),
        JSON.stringify(result.kpiScores),
        JSON.stringify(result.deviations),
        JSON.stringify(result.missedOpportunities),
        JSON.stringify(result.recommendations),
        JSON.stringify(result.useActions),
        JSON.stringify(result.hallucinations || [])
      )

      db.prepare("UPDATE calls SET analysis_status = 'completed' WHERE id = ?").run(call.id)
      logger.info({ callId: call.id, overallScore: computedOverall, status }, 'analysis: stored')

      // Promote each recommendation into the first-class recommendations table
      // so it's tracked across the lifecycle (active → applied → measured).
      const currentVersionId = PromptVersionService.getCurrentVersionId(agent.id)
      await RecommendationService.persistFromAnalysis(agent.id, call.id, result.recommendations, currentVersionId)
      // Compute outcomes for any applied recs that now have enough post-apply calls
      RecommendationService.computePendingOutcomes()

      return result
    } catch (err) {
      db.prepare("UPDATE calls SET analysis_status = 'failed' WHERE id = ?").run(call.id)
      logger.warn({ callId: call.id, err: err.message }, 'analysis: failed')
      return null
    }
  }

  async analyzeAgentInsights(agent) {
    const analyses = db.prepare(`
      SELECT a.overall_score, a.kpi_scores_json, a.deviations_json,
             a.missed_opportunities_json, a.recommendations_json, a.use_actions_json
      FROM analyses a
      JOIN calls c ON c.id = a.call_id
      WHERE c.agent_id = ? AND a.status IS NOT NULL
      ORDER BY a.analyzed_at DESC
      LIMIT 30
    `).all(agent.id)

    if (analyses.length === 0) return null

    const avgScore = Math.round(analyses.reduce((s, a) => s + a.overall_score, 0) / analyses.length)

    const allRecs = analyses.flatMap((a) => JSON.parse(a.recommendations_json))
    const allMissed = analyses.flatMap((a) => JSON.parse(a.missed_opportunities_json))
    const allUseActions = analyses.flatMap((a) => JSON.parse(a.use_actions_json))

    const useActionSummary = allUseActions.reduce((acc, u) => {
      acc[u.actionType] = (acc[u.actionType] || 0) + 1
      return acc
    }, {})

    const prompt = `You are analyzing performance patterns across ${analyses.length} calls for the voice AI agent "${agent.name}".
Agent goal: ${agent.goal}
Average overall score across calls: ${avgScore}/100

RECURRING RECOMMENDATIONS (most common issues found per-call):
${allRecs.slice(0, 15).map((r) => `- [${r.severity}] ${r.title}: ${r.detail}`).join('\n')}

RECURRING MISSED OPPORTUNITIES:
${allMissed.slice(0, 10).map((m) => `- ${m.opportunity}: ${m.description}`).join('\n')}

Identify the top 3 most impactful patterns. For each pattern provide:
1. A pattern name
2. Estimated frequency as a percentage
3. How many of the ${analyses.length} calls it affects
4. A specific, actionable recommendation with exact suggested script change

Respond as JSON: { "summary": string, "patterns": [{ "pattern": string, "frequency": number, "affectedCalls": number, "recommendation": { "type": string, "severity": string, "title": string, "detail": string, "suggestedChange": string } }] }`

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    })

    const result = JSON.parse(response.choices[0].message.content)

    const insightId = crypto.randomUUID()
    db.prepare(`
      INSERT INTO agent_insights (id, agent_id, summary, patterns_json, use_action_summary_json, call_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      insightId, agent.id,
      result.summary,
      JSON.stringify(result.patterns || []),
      JSON.stringify(useActionSummary),
      analyses.length  // call_count = number of analyses that fed into this insight
    )

    result.callCount = analyses.length
    result.useActionSummary = useActionSummary

    logger.info({ agentId: agent.id, callCount: analyses.length }, 'insights: generated and cached')
    return result
  }
}

module.exports = AnalysisService
