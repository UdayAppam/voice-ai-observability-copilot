# Regression Suite

Comprehensive scenario harness covering every FSB customer pain point + every Validation Flywheel state.

## What it covers

| Scenario | Pain point | FSB requirement validated |
|---|---|---|
| S1: Happy path lead-gen | Baseline (does pass detection work?) | Monitor — pass status |
| S2: Skipped qualifying questions | Agent goes off-script | Monitor — deviations |
| S3: Restates price on objection | Most common conversion killer | Analyze — recommendations |
| S4: Hallucinated price/feature | AI safety / brand liability | Hallucination validator |
| S5: Missed obvious upsell | Volunteered expansion signal ignored | Monitor — missed opportunities |
| S6: Frustrated caller not recovered | Caller satisfaction failure | Sentiment KPI + Use Action |
| S7: Caller requests human, not escalated | Pipeline leak | Escalation KPI + Use Action |
| S8a-c: Same issue across 3 calls | Pattern detection | Patterns clustering, `occurrence_count` |
| S9a-b + S10a-b: Prompt change with measured outcome | Validation Flywheel closes | Apply stage + Measure stage |
| (system) Receptionist with 0 calls | UX correctness | "No calls yet" rendering |
| (system) Triage 3 use_actions | Action queue lifecycle | resolve / dismiss / escalate verbs |

## Usage

```bash
cd backend

# Reset DB + seed all scenarios + run OpenAI on each + simulate flywheel
node scripts/regression/run.js --seed

# Run assertions against current DB state
node scripts/regression/run.js --verify

# Both, sequentially
node scripts/regression/run.js --full
```

## Safety

`--seed` wipes the regression-affected tables:
- `agents`, `kpi_definitions`, `calls`, `analyses`, `recommendations`, `agent_prompt_versions`, `agent_insights`, `use_action_statuses`

It preserves `oauth_installations` so HL OAuth state survives.

The script auto-writes a scenario→callId map at `.last-seed-map.json` (gitignored) so `--verify` knows which call belongs to which scenario.

## Cost

Each `--seed` run does ~13 OpenAI calls (`gpt-4o-mini`, json_schema). Expect ~$0.05–$0.10 per seed at current OpenAI pricing. `--verify` is free (pure SQL).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All assertions passed |
| 1 | One or more assertions failed |
| 2 | Bad CLI args or missing seed map |
| 3 | Runtime error during seed/verify |

## Adding scenarios

1. Append to `SCENARIOS` in `scenarios.js`
2. Add an `expect: { … }` block describing what the analysis SHOULD produce
3. Re-run `--full`. The runner picks them up automatically.

## What this proves (and what it doesn't)

**Proves:**
- The full pipeline works end-to-end on realistic inputs
- Every PDF Core Functionality sub-item produces detectable evidence
- The Validation Flywheel closes (active → applied → measured) with real before/after data
- The Action queue lifecycle handles all 3 verbs
- Edge cases (zero-call agent, pattern recurrence) render correctly

**Doesn't prove:**
- Live HL Voice AI API integration (use `TRANSCRIPT_PROVIDER=highlevel` for that)
- Exact LLM output stability (assertions use ranges, not exact strings)
- Frontend rendering (use Playwright/Cypress for that — not in scope)
