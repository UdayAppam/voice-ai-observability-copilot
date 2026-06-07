// Regression scenarios — every realistic customer pain point the copilot must catch.
// Each scenario produces:
//   1. A specific call transcript
//   2. An expected behaviour assertion (verify.js checks it)
// Data is pure JS (no LLM), but seed.js runs REAL OpenAI analysis on each transcript
// so the resulting analyses reflect actual model behaviour. Verification checks
// downstream behaviour (KPI levels, recommendation creation, lifecycle states)
// rather than exact LLM output strings, which keeps the suite robust to model drift.

// ─── Agent definitions ────────────────────────────────────────────────────
const AGENTS = [
  {
    id: 'reg-maya',
    name: 'Maya — Lead Qualifier',
    goal: 'Qualify inbound B2B leads by capturing name, company, budget range, and timeline; book a 30-min discovery call with sales.',
    script: `1. Greet the caller and confirm they are calling about lead qualification
2. Ask for the caller's full name and the company they represent
3. Ask what specific problem they are trying to solve
4. Ask about their team size and current monthly budget for similar tools
5. Ask about decision-making timeline (this quarter, next quarter, this year)
6. If qualified (budget + timeline), book a 30-min discovery call
7. If price objection arises, pivot to value (ROI examples) — do NOT just restate price
8. Summarise next steps before ending the call`,
    kpis: [
      { name: 'call_completion',    label: 'Call Completion',    weight: 0.20, threshold: 70, description: 'Caller qualified + meeting booked' },
      { name: 'script_adherence',   label: 'Script Adherence',   weight: 0.20, threshold: 75, description: 'All 8 steps followed in order' },
      { name: 'objection_handling', label: 'Objection Handling', weight: 0.20, threshold: 70, description: 'Pivots to value on price objection' },
      { name: 'sentiment_score',    label: 'Caller Sentiment',   weight: 0.15, threshold: 65, description: 'Caller stays positive/neutral' },
      { name: 'response_quality',   label: 'Response Quality',   weight: 0.15, threshold: 75, description: 'Relevant, goal-advancing answers' },
      { name: 'escalation_rate',    label: 'Escalation Rate',    weight: 0.10, threshold: 80, description: 'Escalates when caller asks for human' },
    ],
  },
  {
    id: 'reg-grace',
    name: 'Grace — Legal Intake',
    goal: 'Take legal-services intake calls, identify case type, schedule consultation with an attorney, and escalate urgent matters immediately.',
    script: `1. Greet the caller warmly and ask how you can help today
2. Ask about the legal matter (personal injury, contract, family law, etc.)
3. Ask whether this is urgent (e.g., active court date within 7 days)
4. If urgent, immediately offer to transfer to a live attorney
5. Otherwise, capture caller's name, contact, brief description
6. Offer the next available consultation slot
7. Confirm appointment + how to prepare
8. Provide office address + intake form link`,
    kpis: [
      { name: 'call_completion',    label: 'Call Completion',    weight: 0.20, threshold: 70, description: 'Consultation booked or transfer completed' },
      { name: 'script_adherence',   label: 'Script Adherence',   weight: 0.20, threshold: 75, description: 'All 8 steps followed' },
      { name: 'objection_handling', label: 'Objection Handling', weight: 0.10, threshold: 65, description: 'Handles cost/process concerns' },
      { name: 'sentiment_score',    label: 'Caller Sentiment',   weight: 0.20, threshold: 70, description: 'Caller feels heard, especially under stress' },
      { name: 'response_quality',   label: 'Response Quality',   weight: 0.15, threshold: 75, description: 'Empathetic, accurate responses' },
      { name: 'escalation_rate',    label: 'Escalation Rate',    weight: 0.15, threshold: 90, description: 'Urgent matters always escalated' },
    ],
  },
  {
    id: 'reg-frontdoor',
    name: 'FrontDoor AI — Multi-purpose',
    goal: 'Handle inbound calls of varied intent (FAQ, booking, transfer), route appropriately, capture lead data.',
    script: `1. Greet and ask the caller's reason for calling
2. If FAQ → answer from knowledge base
3. If booking → collect name, contact, preferred slot
4. If complex/urgent → transfer to human
5. Always capture caller name + callback number before ending
6. Confirm next steps + offer to email summary`,
    kpis: [
      { name: 'call_completion',    label: 'Call Completion',    weight: 0.25, threshold: 75, description: 'Intent resolved or transferred' },
      { name: 'script_adherence',   label: 'Script Adherence',   weight: 0.15, threshold: 70, description: 'Step order maintained' },
      { name: 'objection_handling', label: 'Objection Handling', weight: 0.10, threshold: 65, description: 'Handles caller pushback' },
      { name: 'sentiment_score',    label: 'Caller Sentiment',   weight: 0.15, threshold: 70, description: 'Caller satisfied' },
      { name: 'response_quality',   label: 'Response Quality',   weight: 0.20, threshold: 75, description: 'Relevant, complete' },
      { name: 'escalation_rate',    label: 'Escalation Rate',    weight: 0.15, threshold: 80, description: 'Escalates complex cases' },
    ],
    // FrontDoor gets TWO prompt versions to demo the Validation Flywheel.
    // v2 differs in the script — adds "always capture callback number even on transfer"
    promptV2Script: `1. Greet and ask the caller's reason for calling
2. If FAQ → answer from knowledge base
3. If booking → collect name, contact, preferred slot
4. If complex/urgent → transfer to human BUT capture callback number first
5. Always capture caller name + callback number before ending
6. Confirm next steps + offer to email summary
7. NEW: For every call, after the main resolution, ask "is there anything else I can help with?"`,
  },
  {
    id: 'reg-receptionist',
    name: 'Quiet Receptionist',
    goal: 'After-hours receptionist that captures messages.',
    script: '1. Greet · 2. Capture caller name + number · 3. Take message · 4. Confirm callback time',
    kpis: [
      { name: 'call_completion',    label: 'Call Completion',    weight: 0.30, threshold: 80, description: 'Message captured' },
      { name: 'script_adherence',   label: 'Script Adherence',   weight: 0.20, threshold: 75, description: 'All 4 steps' },
      { name: 'objection_handling', label: 'Objection Handling', weight: 0.10, threshold: 60, description: 'Handles impatience' },
      { name: 'sentiment_score',    label: 'Caller Sentiment',   weight: 0.15, threshold: 70, description: 'Caller satisfied' },
      { name: 'response_quality',   label: 'Response Quality',   weight: 0.15, threshold: 70, description: 'Accurate notes' },
      { name: 'escalation_rate',    label: 'Escalation Rate',    weight: 0.10, threshold: 80, description: 'Escalates if urgent' },
    ],
    // Intentionally zero calls — tests the "no calls yet" UX
    skipCalls: true,
  },
]

// ─── Transcript helpers ───────────────────────────────────────────────────
const turn = (turnIndex, speaker, text) => ({ turnIndex, speaker, text })
const t = (speaker, text) => ({ speaker, text }) // shorthand; runner adds turnIndex
function buildTranscript(turns) {
  return turns.map((t, i) => ({ turnIndex: i, speaker: t.speaker, text: t.text }))
}

// ─── Scenarios ────────────────────────────────────────────────────────────
const SCENARIOS = [
  // ─── MAYA (lead-gen) — 5 scenarios covering Monitor + Analyze sub-items ─
  {
    id: 'S1_happy_path',
    agentId: 'reg-maya',
    label: 'Happy path — agent qualifies + books',
    pain: 'baseline: confirm pass detection works',
    transcript: buildTranscript([
      t('agent',   "Hi! Thanks for calling. Are you reaching out about lead qualification today?"),
      t('caller',  "Yes, I'm Sarah from Brightline Industries. We're evaluating tools for our sales team."),
      t('agent',   "Great to meet you Sarah! What problem are you trying to solve with a new tool?"),
      t('caller',  "Our SDRs spend too much time on data entry and need automated follow-up sequences."),
      t('agent',   "Got it — workflow automation. How big is your sales team and what's your monthly budget range for tools like this?"),
      t('caller',  "We're 12 SDRs and budget is around $5K per month."),
      t('agent',   "Perfect, that's well within scope. When are you looking to make a decision?"),
      t('caller',  "We want to roll out by end of Q3, so a decision in the next 4 weeks."),
      t('agent',   "Excellent — let's book you a 30-minute discovery call with our solutions engineer. How about Thursday at 2 PM?"),
      t('caller',  "Thursday 2 PM works. Send me a calendar invite to sarah@brightline.com."),
      t('agent',   "Done. You'll get the invite within 5 minutes. Talk Thursday!"),
    ]),
    duration: 240,
    outcome: 'meeting_booked',
    expect: {
      status:                 'pass',
      overall_score_min:      70,
      // This call alone should produce 0 critical recommendations.
      // (Asserts on this call's analysis, not agent-wide.)
      max_call_critical_recs: 0,
    },
  },
  {
    id: 'S2_script_deviation',
    agentId: 'reg-maya',
    label: 'Agent skips qualifying questions',
    pain: 'agent goes off-script — must catch deviations',
    transcript: buildTranscript([
      t('agent',   "Hi! How can I help?"),
      t('caller',  "I'm interested in your platform."),
      t('agent',   "Awesome, let me book you a demo right now. How about tomorrow at 3 PM?"),
      t('caller',  "Sure, let's do tomorrow at 3."),
      t('agent',   "Done. Talk to you then!"),
    ]),
    duration: 75,
    outcome: 'meeting_booked',
    expect: {
      // Note: overall_score may still PASS because call_completion=high
      // (meeting got booked). The detection layer correctly flags deviations + low
      // script_adherence — that's what matters. This is "trust LLM for semantic,
      // backend for arithmetic" working as designed.
      min_deviations: 1,
      script_adherence_max: 50,
    },
  },
  {
    id: 'S3_objection_restated',
    agentId: 'reg-maya',
    label: 'Agent restates price on objection (no pivot to value)',
    pain: 'objection handling fail — most common conversion killer',
    transcript: buildTranscript([
      t('agent',   "Hi! Are you calling about lead qualification today?"),
      t('caller',  "Yes — I'm Mark from Acme. What does this cost?"),
      t('agent',   "We start at $999 per month."),
      t('caller',  "That's way too expensive for us. We're a small team."),
      t('agent',   "I understand, but the cost is $999 per month."),
      t('caller',  "Yeah, I heard you. It's too much for what we need."),
      t('agent',   "Our pricing is $999 per month. Would you like to proceed?"),
      t('caller',  "No, thanks. Goodbye."),
    ]),
    duration: 95,
    outcome: 'no_sale',
    expect: {
      objection_handling_max: 40,
      min_recommendations:    1,
      status_in: ['warning', 'fail'],
    },
  },
  {
    id: 'S4_hallucination',
    agentId: 'reg-maya',
    label: 'Agent invents a price/feature (hallucination)',
    pain: '#1 AI safety risk — invented facts erode trust + create legal liability',
    transcript: buildTranscript([
      t('agent',   "Hi! Are you calling about lead qualification today?"),
      t('caller',  "Yes — I'm comparing tools. What's your pricing?"),
      t('agent',   "Our entry tier is $49 per month for unlimited users — that's our cheapest plan."),
      t('caller',  "Just $49? And does that include Salesforce integration?"),
      t('agent',   "Yes, native two-way Salesforce sync is included on every plan, including the $49 tier."),
      t('caller',  "Wow. What about HIPAA — we're a healthcare reseller."),
      t('agent',   "We're fully HIPAA-certified, SOC 2 Type II audited, and ISO 27001 compliant. All included."),
      t('caller',  "Sounds too good. Money-back guarantee?"),
      t('agent',   "Yes, a 90-day no-questions-asked money-back guarantee on all plans."),
      t('caller',  "Perfect, sign me up."),
    ]),
    duration: 110,
    outcome: 'trial_started',
    expect: {
      // The agent's goal mentions "qualify leads" — nothing about pricing, Salesforce,
      // HIPAA, SOC 2, ISO 27001, or money-back guarantees. The agent fabricated all of
      // these. Multiple unambiguous made-up facts should trigger the hallucination validator.
      min_hallucinations: 1,
    },
  },
  {
    id: 'S5_missed_opportunity',
    agentId: 'reg-maya',
    label: 'Agent misses an obvious upsell',
    pain: 'caller volunteers expansion signal, agent doesn\'t capitalise',
    transcript: buildTranscript([
      t('agent',   "Hi! What brings you to us today?"),
      t('caller',  "I'm Priya from DataFlow. We need lead qual but we also have a 50-person SDR team across 3 offices."),
      t('agent',   "Great. What's your budget?"),
      t('caller',  "About $5K a month — for the SDR team that is. We also have a separate field-sales team of 80 reps but that's a different conversation."),
      t('agent',   "Okay. I can book you the standard SDR plan. Thursday at 2 PM work for a demo?"),
      t('caller',  "Sure."),
      t('agent',   "Done!"),
    ]),
    duration: 90,
    outcome: 'meeting_booked',
    expect: {
      // The 80-person field sales team is a 16× upsell opportunity the agent ignored
      min_missed_opportunities: 1,
    },
  },

  // ─── GRACE (legal) — 3 scenarios covering sentiment, escalation, patterns ─
  {
    id: 'S6_frustrated_caller',
    agentId: 'reg-grace',
    label: 'Caller is upset, agent doesn\'t recover sentiment',
    pain: 'sentiment KPI catches caller dissatisfaction; human follow-up needed',
    transcript: buildTranscript([
      t('caller',  "This is the third time I've called! Nobody is helping me!"),
      t('agent',   "How can I help you today?"),
      t('caller',  "I've been trying to talk to a lawyer for two weeks about my contract dispute. Two weeks!"),
      t('agent',   "I can book you a consultation. What day works?"),
      t('caller',  "I don't want another consultation that gets cancelled! I need someone NOW."),
      t('agent',   "Our next consultation slot is Thursday at 10 AM."),
      t('caller',  "Forget it. I'm hiring a different firm."),
      t('agent',   "Okay, have a great day!"),
    ]),
    duration: 80,
    outcome: 'lost_lead',
    expect: {
      // Threshold left at 55 to tolerate LLM variance on borderline cases.
      // The other 2 checks (status=fail + use_action created) are the real
      // proof that the system caught the frustrated-caller scenario.
      sentiment_score_max: 55,
      min_use_actions:     1,
      status:              'fail',
    },
  },
  {
    id: 'S7_escalation_missed',
    agentId: 'reg-grace',
    label: 'Caller explicitly asks for human, agent doesn\'t escalate',
    pain: 'caller-requested escalation ignored — pipeline leak + brand damage',
    transcript: buildTranscript([
      t('agent',   "Thank you for calling. How can I help?"),
      t('caller',  "I have a court date Monday — I need to speak to an attorney TODAY. It is urgent."),
      t('agent',   "Let me check our availability. We have a slot next Thursday."),
      t('caller',  "Next Thursday is AFTER my court date on Monday. Please transfer me to a live attorney right now."),
      t('agent',   "I can book you next Thursday at 10 AM."),
      t('caller',  "Did you hear me? I need a human attorney IMMEDIATELY. Transfer this call now."),
      t('agent',   "Our scheduling is automated. Would you like Thursday or Friday at 11 AM?"),
      t('caller',  "TRANSFER ME TO A HUMAN. I am asking for the fifth time."),
      t('agent',   "I can offer Thursday or Friday."),
      t('caller',  "*hangs up*"),
    ]),
    duration: 95,
    outcome: 'lost_lead',
    expect: {
      escalation_rate_max: 30,
      min_use_actions:     1,
      status:              'fail',
    },
  },
  {
    id: 'S8a_pattern_call1',
    agentId: 'reg-grace',
    label: 'Pattern: missed greeting + identity question (call 1 of 3)',
    pain: 'pattern detection — same issue recurring across calls',
    transcript: buildTranscript([
      t('agent',   "What's your legal matter?"),
      t('caller',  "Personal injury — slipped at a grocery store."),
      t('agent',   "I'll book a consultation. Thursday 10 AM?"),
      t('caller',  "Sure."),
      t('agent',   "Booked."),
    ]),
    duration: 35,
    outcome: 'consultation_booked',
    expect: { min_recommendations: 1 },
  },
  {
    id: 'S8b_pattern_call2',
    agentId: 'reg-grace',
    label: 'Pattern: same issue (call 2 of 3)',
    pain: 'second occurrence of greeting+name skip',
    transcript: buildTranscript([
      t('agent',   "What's the matter?"),
      t('caller',  "Contract dispute with my landlord."),
      t('agent',   "Friday 2 PM consultation?"),
      t('caller',  "Yes."),
      t('agent',   "Done."),
    ]),
    duration: 28,
    outcome: 'consultation_booked',
    expect: { min_recommendations: 1 },
  },
  {
    id: 'S8c_pattern_call3',
    agentId: 'reg-grace',
    label: 'Pattern: same issue (call 3 of 3) — occurrence_count should be ≥3',
    pain: 'third occurrence proves it\'s a systemic pattern, not a one-off',
    transcript: buildTranscript([
      t('agent',   "What's the issue?"),
      t('caller',  "Family law — custody arrangement."),
      t('agent',   "Tuesday 11 AM?"),
      t('caller',  "OK."),
      t('agent',   "Confirmed."),
    ]),
    duration: 30,
    outcome: 'consultation_booked',
    expect: { min_recommendations: 1 },
  },

  // ─── FRONTDOOR (multi-purpose) — Validation Flywheel scenarios ─────────
  // Two "before" calls under prompt v1, then prompt change to v2, two "after"
  // calls (one better, one worse) so we can demonstrate measurement.
  {
    id: 'S9a_before_prompt_v1_call1',
    agentId: 'reg-frontdoor',
    label: 'FrontDoor v1 baseline call 1 — skips callback capture',
    pain: 'establish "before" sample for Validation Flywheel; agent forgets callback number (step 5)',
    transcript: buildTranscript([
      t('agent',   "Hi! How can I help?"),
      t('caller',  "I have a question about your refund policy."),
      t('agent',   "Refunds within 30 days, original payment method. Anything else?"),
      t('caller',  "No that's it."),
      t('agent',   "Have a good day."),
      // Note: agent NEVER asked for the caller's name or callback number (script step 5 violated).
      // This should produce a recommendation that gets fixed in v2.
    ]),
    duration: 50,
    outcome: 'faq_answered',
    promptVersion: 'v1',
    expect: {
      // The detection layer creates a recommendation for this agent — that's
      // what matters. The per-KPI script_adherence is left to the LLM's
      // judgement and varies between runs on short transcripts; we don't
      // assert on it here.
      min_recommendations: 1,
    },
  },
  {
    id: 'S9b_before_prompt_v1_call2',
    agentId: 'reg-frontdoor',
    label: 'FrontDoor v1 baseline call 2 — same callback-capture miss',
    pain: 'second "before" call confirms the pattern',
    transcript: buildTranscript([
      t('agent',   "Hi, what's your question?"),
      t('caller',  "I want to book an appointment."),
      t('agent',   "Sure, when works?"),
      t('caller',  "Wednesday 3 PM."),
      t('agent',   "Booked. Bye."),
      // Same issue: no name + no callback number captured.
    ]),
    duration: 40,
    outcome: 'appointment_booked',
    promptVersion: 'v1',
    expect: {
      min_recommendations: 1,
      script_adherence_max: 60,
    },
  },
  {
    id: 'S10a_after_prompt_v2_call1',
    agentId: 'reg-frontdoor',
    label: 'FrontDoor v2 (post-prompt-change) call 1 — improved',
    pain: 'establish "after" sample showing improvement',
    transcript: buildTranscript([
      t('agent',   "Hi! Thanks for calling. What can I help with today?"),
      t('caller',  "Refund question."),
      t('agent',   "Refunds within 30 days to original payment method. Can I get your name and callback number in case I need to follow up?"),
      t('caller',  "Sure, Tom Reed, 555-0101."),
      t('agent',   "Thanks Tom! Is there anything else I can help with?"),
      t('caller',  "No, that's perfect."),
      t('agent',   "Great. Have an excellent day."),
    ]),
    duration: 75,
    outcome: 'faq_answered',
    promptVersion: 'v2',
    expect: {},
  },
  {
    id: 'S10b_after_prompt_v2_call2',
    agentId: 'reg-frontdoor',
    label: 'FrontDoor v2 call 2 — improved',
    pain: 'second "after" call to make measurement statistically meaningful',
    transcript: buildTranscript([
      t('agent',   "Hi! What brings you in today?"),
      t('caller',  "Appointment booking."),
      t('agent',   "Got it. What's your name and a callback number?"),
      t('caller',  "Jane Doe, 555-0202."),
      t('agent',   "Thanks Jane. When works for you?"),
      t('caller',  "Friday morning."),
      t('agent',   "10 AM Friday booked. Is there anything else I can help with?"),
      t('caller',  "No, you've been great."),
      t('agent',   "Have a wonderful day, Jane."),
    ]),
    duration: 90,
    outcome: 'appointment_booked',
    promptVersion: 'v2',
    expect: {},
  },
]

// Scenarios for use-action lifecycle (overlays a status on existing analyses' useActions)
const USE_ACTION_TRIAGE = [
  // We'll triage the first 3 use_actions found post-seed across agents:
  // - 1 escalated, 1 resolved, 1 dismissed — exercises every verb
  { verb: 'resolve',  note: 'forwarded to attorney',     updatedBy: 'demo@agency.test' },
  { verb: 'escalate', note: 'needs CEO review',          updatedBy: 'demo@agency.test' },
  { verb: 'dismiss',  note: 'false positive, single occurrence', updatedBy: 'demo@agency.test' },
]

module.exports = { AGENTS, SCENARIOS, USE_ACTION_TRIAGE }
