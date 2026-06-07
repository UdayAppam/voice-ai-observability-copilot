// Synthetic agent generator for the ?demo-scale=N query-string switch.
// Produces deterministic data per index so the same URL always renders identically.

const KPI_DEFS = [
  { name: 'call_completion',   label: 'Call Completion',   threshold: 75 },
  { name: 'script_adherence',  label: 'Script Adherence',  threshold: 70 },
  { name: 'objection_handling',label: 'Objection Handling',threshold: 65 },
  { name: 'sentiment_score',   label: 'Caller Sentiment',  threshold: 60 },
  { name: 'response_quality',  label: 'Response Quality',  threshold: 70 },
  { name: 'escalation_rate',   label: 'Escalation Rate',   threshold: 90 },
]

// Mulberry32 — tiny seeded RNG. Same seed → same sequence every time.
function seededRandom(seed) {
  let s = seed >>> 0
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NAME_POOL = [
  'Alex','Maya','Sam','Riley','Jordan','Casey','Morgan','Taylor','Jamie','Avery',
  'Quinn','Reese','Skylar','Drew','Cameron','Hayden','Logan','Parker','Rowan','Sage',
  'Adrian','Blake','Charlie','Dana','Emerson','Finley','Gray','Harper','Indigo','Jules',
  'Kai','Lane','Marlowe','Noor','Oakley','Phoenix','Quincy','Remi','Salem','Tatum',
]

export function generateSyntheticAgents(count) {
  return Array.from({ length: count }, (_, i) => {
    const num = i + 1
    const rng = seededRandom(num * 9176 + 31)
    const kpis = KPI_DEFS.map((def, kpiIdx) => {
      const roll = rng()
      let score
      if (roll < 0.55) {
        // ~55% pass
        score = def.threshold + Math.round(rng() * (100 - def.threshold))
      } else if (roll < 0.80) {
        // ~25% warning
        score = def.threshold - Math.round(rng() * 14)
      } else {
        // ~20% fail
        score = Math.round(rng() * (def.threshold - 15))
      }
      score = Math.max(0, Math.min(100, score))
      const status = score >= def.threshold
        ? 'pass'
        : score >= def.threshold - 15 ? 'warning' : 'fail'
      // small chance of no_data for realism
      if (kpiIdx === 5 && rng() < 0.05) {
        return { ...def, score: null, status: 'no_data' }
      }
      return { ...def, score, status }
    })

    return {
      agentId: `demo_agent_${String(num).padStart(3, '0')}`,
      agentName: `${NAME_POOL[i % NAME_POOL.length]} ${Math.floor(i / NAME_POOL.length) || ''}`.trim(),
      callCount: 10 + Math.floor(rng() * 200),
      kpis,
    }
  })
}
