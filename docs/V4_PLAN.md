# V4 Plan — Close the Apply Loop (Voice AI edition)

Direct one-click application of AI recommendations into the live HighLevel Voice AI agent, replacing the manual paste-into-HL step that's the only remaining friction in V3.

Status: **scoped + grounded in live API discovery**. V3 is the FSB submission; V4 is the immediate next iteration.

> **2026-06-07 — Plan v4 update**: The original plan assumed HighLevel's Agent Studio API (node-graph editing). Live API probing against the sandbox **invalidated that assumption**: Voice AI agents have a single `agentPrompt` string, NOT a node graph. This dramatically simplifies the architecture (no graph traversal, no draft/promote, no node resolution). Effort dropped from ~27 h to ~14-16 h. See §3.

---

## 1. Goal, stated plainly

Replace the only manual step in the V3 loop:

> V3 today: AI surfaces recommendation → user **copies suggested text** → opens HL Voice AI agent settings → finds where in the prompt to paste it → edits prompt → saves → comes back.

> V4: AI surfaces recommendation → user clicks **"Apply to {Agent}"** → diff modal with editable prompt → click confirm → HL agent's `agentPrompt` is updated + measurement starts.

Time saved per fix: **3-5 min of context switching → ~5 seconds of confirmation**.

---

## 2. Ruthless in/out

### IN (V4 ships)

| Item | Why |
|---|---|
| `POST /api/agents/:agentId/recommendations/:recId/apply` — backend orchestrator | The one-button-click endpoint |
| `HLVoiceAgentService` — wraps HL `/voice-ai/agents/*` read + write API | Single source of truth for HL Voice AI mutation |
| LLM-assisted **prompt-merge** (not node selection) — proposes where in the long `agentPrompt` to insert the change | The agent's `agentPrompt` is ~5K chars; users need to see WHERE in it the change lands |
| Editable diff modal — user can tune the proposed prompt before commit | Industry-standard pattern (Copilot, Cursor, ChatGPT); drives adoption + unlocks edit-driven product intelligence (§12.11) |
| Pre-apply validator pipeline (5 validators) — runs live as user types | Catches broken template vars, length issues, tone drift, forbidden content, before push |
| **Snapshot-based rollback** — store previous `agentPrompt` in our DB, restore on rollback | HL Voice AI has no native versioning; rollback is our problem to solve |
| Diff-preview modal showing old vs new prompt with highlights | Nobody applies blind to a 5K-char prompt |
| Post-apply receipt — timeline of every API call we made, with timestamps | Trust + audit |
| Rollback button on every applied recommendation | Safety: 1-click revert |
| `applied_via`, `final_text`, edit-tracking columns | Product intelligence (§12.11) |
| Failure-aware UI: "Apply failed — fall back to manual paste" with copy-button | HL API outages must not block the workflow |

### CUT (do not ship in V4)

| Item | Why cut |
|---|---|
| Editing `actions[]` (function-calling tools) | Separate surface; V5 — focus V4 on `agentPrompt` text |
| Editing `welcomeMessage` separately | V4.1 — same PATCH endpoint, just separate UI affordance |
| Bulk Apply across N agents | Wait until single-rec apply is trusted in production |
| Fully autonomous apply (no confirmation modal) | Voice AI calls real customers; never auto-apply without human review in V4 |
| Cross-agent fix propagation ("apply to all matching agents") | V5 — needs single-agent flow proven first |
| A/B testing infrastructure (canary new prompt on 10% of traffic) | Voice AI itself doesn't expose A/B at the API level; V5+ |
| Auto-rollback on score regression | V5 — requires alerting infrastructure first |

---

## 3. Live API discovery findings (Phase 1, completed 2026-06-07)

### What we confirmed via real curls against the sandbox

| Probe | Finding | Source |
|---|---|---|
| `GET /voice-ai/agents?locationId=…` | Returns array of agents w/ 21 top-level fields per agent | 200 OK |
| Agent shape — text field | **Single `agentPrompt` string** (5658 chars on sampled agent) | Direct inspection |
| Agent shape — `prompts` object | **Empty `{}`** on all observed agents — ignorable for V4 | Direct inspection |
| Agent shape — `actions[]` | Array of `{id, actionType, name, actionParameters}` — function tools | Direct inspection |
| Agent shape — versioning fields | **NONE** (no `version`, `revision`, `updated`, `modified`) | Direct inspection |
| `GET /voice-ai/agents/:id?locationId=…` | Same shape as list, single agent | 200 OK |
| `PATCH /voice-ai/agents/:id?locationId=…` | **Endpoint exists** (401 = "not authorized for this scope", not 404) | Probe response |
| `PUT /voice-ai/agents/:id?locationId=…` | Same — endpoint exists | Probe response |
| Required scope | `voice-ai-agents.write` (confirmed in our existing OAuth installation's granted scopes) | OAuth scopes from earlier install |
| Voice AI `agentPrompt` is the editable field | The thing humans edit in the HL Voice AI Studio UI | Inspection of 9 different agents — all have it |

### What still needs to be discovered when we add `voice-ai-agents.write` scope

| Unknown | Resolution path | Blocker level |
|---|---|---|
| PATCH vs PUT — which one does HL prefer? | First real write probe with proper scope; if both work, prefer PATCH (partial update) | Low — we can pick either |
| Does PATCH accept partial body (just `{agentPrompt: …}`) or require full agent object? | First real write probe | Medium — affects payload construction |
| Are there per-agent template variables in `{{var}}` syntax? | Inspect actual prompt content + see if HL has a vars-list endpoint | Medium — affects template-var validator |
| Response shape of successful PATCH | First successful probe | Low — just affects what we display in the receipt |

**Action required**: re-install the Marketplace App in your sandbox (the previous install's OAuth token row was lost during the DB cleanup). Once it's back, we can complete these 4 unknowns in 10 more minutes. OR add `voice-ai-agents.write` scope to the PIT in HL sandbox UI.

### Agent Studio — explicitly ruled out

`GET /agent-studio/agents?locationId=…` returned 401 "not authorized for this scope". The endpoint exists but is **a different product surface** (likely HL's general AI builder). Voice AI agents are NOT editable via Agent Studio — they have their own dedicated API surface (`/voice-ai/*`).

This eliminates the entire Agent Studio architecture: no node graph, no draft/promote workflow, no node resolution. **Massive simplification.**

---

## 4. Architecture (revised post-discovery)

```
Frontend
  /patterns or Call Detail → [Apply to {Agent} →] button
                                ↓
                        Diff Preview Modal (editable)
                                ↓ Confirm
                                ↓
Backend
  POST /api/agents/:agentId/recommendations/:recId/apply
                                ↓
  ApplyRecommendationService.run(agentId, recId, finalText, userEmail)
    1. fetch recommendation (DB)
    2. fetch current Voice AI agent       ─── HLVoiceAgentService.getAgent
    3. snapshot previous agentPrompt       ─── store in apply_attempts row BEFORE PATCH
    4. validate (server-side defence)      ─── RecommendationValidatorService
    5. PATCH agent w/ new agentPrompt      ─── HLVoiceAgentService.updateAgentPrompt
    6. update recommendations.status='applied',
       applied_via='auto_api', applied_at=now
    7. log apply_attempts row w/ outcome=success, previous + final text, edit metadata
    8. trigger ingestion sync              ─── IngestionService.syncAgent
    9. return { snapshot, receipt } to UI
                                ↓
Frontend status pill
  "Applying..." → "Applied · waiting for next call" → "Measured: +X pts"

──── Rollback flow ─────────────────────────────────────────────────────
POST /api/recommendations/:recId/rollback
  → fetch latest apply_attempts row for this rec
  → HLVoiceAgentService.updateAgentPrompt(agentId, previous_agent_prompt)
  → mark rec as status='active', applied_at=NULL, log new apply_attempts(outcome='rolled_back')
```

### New code, new files

| File | Purpose | LOC est |
|---|---|---|
| `backend/src/services/HLVoiceAgentService.js` | Wraps `GET/PATCH /voice-ai/agents/:id`; auth via OAuth installation or PIT | ~180 |
| `backend/src/services/ApplyRecommendationService.js` | The orchestrator above + rollback | ~200 |
| `backend/src/services/RecommendationValidatorService.js` | 5 validators (template vars, length, tone, forbidden content, call-length impact) | ~180 |
| `backend/src/services/EditSummaryService.js` | Small LLM call: summarises in 1 line what the user changed vs the AI suggestion | ~60 |
| `backend/src/routes/apply.js` | `POST /apply`, `POST /rollback`, `POST /validate`, `GET /preview-apply` | ~120 |
| `frontend/src/components/ApplyRecommendationButton.vue` | Drop-in button used on Patterns, Call Detail, Agent Detail | ~80 |
| `frontend/src/components/ApplyDiffModal.vue` | Diff + editable textarea + live validator + edit-aware Confirm | ~380 |
| `frontend/src/components/ApplyReceiptPanel.vue` | Post-apply timeline + AI-vs-edit diff section | ~200 |
| `frontend/src/components/ApplyStatusPill.vue` | applied / awaiting / measured / rolled-back + `✎ edited` badge | ~90 |
| `frontend/src/components/RecommendationCardV4.vue` | V4 redesign w/ WHY/WHAT/WHERE | ~200 |
| `frontend/src/composables/useDebouncedValidate.js` | 300ms-debounced wrapper around POST /validate | ~40 |
| `frontend/src/utils/diff.js` | Line-diff for visual rendering (current vs proposed, AI vs edit) | ~120 |

### Schema additions (forward-only migration)

```sql
ALTER TABLE recommendations ADD COLUMN applied_via TEXT;
  -- NULL by default; 'manual' (prompt-version sync detection — V3 behavior)
  --                  | 'auto_api' (V4 one-click)

ALTER TABLE recommendations ADD COLUMN apply_error TEXT;
  -- last error message if apply attempt failed; NULL otherwise

CREATE TABLE IF NOT EXISTS apply_attempts (
  id                          TEXT PRIMARY KEY,
  recommendation_id           TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  agent_id                    TEXT NOT NULL,
  attempted_at                TEXT NOT NULL DEFAULT (datetime('now')),
  outcome                     TEXT NOT NULL,    -- 'success' | 'failure' | 'rolled_back'
  -- Rollback support: snapshot the old prompt BEFORE the PATCH succeeds
  previous_agent_prompt       TEXT,             -- exact prior agentPrompt — used for rollback
  -- Apply payload
  ai_suggested_text           TEXT,             -- what the LLM originally proposed
  final_text                  TEXT,             -- what actually got patched (= ai_suggested_text if not edited)
  -- Edit tracking
  edited_from_suggestion      INTEGER NOT NULL DEFAULT 0,  -- boolean
  chars_diff_from_suggestion  INTEGER,          -- edit distance vs ai_suggested_text
  edit_summary                TEXT,             -- LLM-generated one-line "what changed"
  -- Audit
  diff_summary                TEXT,             -- short human-readable diff (old vs new agentPrompt)
  error_message               TEXT,             -- if outcome != success
  user_email                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_apply_rec ON apply_attempts(recommendation_id, attempted_at DESC);
```

All additive. Existing rows get `applied_via=NULL` and behave exactly as today.

---

## 5. Implementation phases

### Phase 0 — Re-establish write access (15 min)

Pre-req for Phase 1 write probes.

| Task | Effort |
|---|---|
| 0.1 Re-install the Marketplace App in the sandbox to repopulate `oauth_installations` with `voice-ai-agents.write` scope | 5 min (you click) |
| 0.2 Verify token works for write — one real PATCH against a sandbox test agent, body `{agentPrompt: "<same value>"}` (no-op) | 5 min (I run) |
| 0.3 Document the PATCH response shape + correct HTTP method (PATCH vs PUT) in `docs/V4_API_DISCOVERY.md` | 5 min |

### Phase 1 — `HLVoiceAgentService` (1.5 h)

| Task | Effort |
|---|---|
| 1.1 Constructor + auth resolution (mirrors `HighLevelTranscriptProvider`'s OAuth/PIT fallback) | 20 min |
| 1.2 `getAgent(agentId, locationId)` returning normalised `{ id, name, agentPrompt, welcomeMessage }` | 20 min |
| 1.3 `updateAgentPrompt(agentId, locationId, newPrompt)` — single PATCH | 20 min |
| 1.4 Error normalisation (401/403/404/422 → typed errors so the orchestrator can react) | 20 min |
| 1.5 Lightweight unit tests w/ mocked fetch | 30 min |

### Phase 2 — `RecommendationValidatorService` (2 h)

5 validators (we dropped cross-node contradiction since there are no other nodes). Each callable independently for the live-edit revalidation endpoint.

| Validator | What it checks | Severity |
|---|---|---|
| `validateTemplateVars` | Every `{{var}}` in proposed text exists in HL's known Voice AI template var list | ✗ blocking |
| `validateLength` | Proposed text within Voice AI's per-agent prompt limit (HL UI suggests ~10K chars; conservative cap 8000) | ✗ over limit, ⚠ approaching |
| `validateTone` (LLM, cheap) | Proposed text matches the agent's stated goal | ⚠ informational |
| `validateForbiddenContent` (regex + keyword list) | No PII placeholders, HL system tokens, profanity, "TODO" markers | ✗ blocking |
| `predictCallLengthImpact` (deterministic) | Estimates seconds added per call based on added words/questions | ⚠ informational |

### Phase 3 — `ApplyRecommendationService` orchestrator (1.5 h)

| Task | Effort |
|---|---|
| 3.1 `run({recId, finalText, userEmail})` — the 9-step flow above | 45 min |
| 3.2 `rollback(recId)` — fetch latest apply, re-PATCH previous_agent_prompt, log new attempt | 20 min |
| 3.3 Idempotency: if rec already `applied`, return existing receipt instead of double-applying | 15 min |
| 3.4 Transactional cleanup on failure (e.g. PATCH succeeds but local DB write fails → unlikely but handle) | 10 min |

### Phase 4 — `EditSummaryService` (30 min)

Small dedicated LLM call to summarise what the user changed vs the AI suggestion. Powers the receipt panel + edit-driven product intelligence.

### Phase 5 — Backend routes (1.5 h)

| Endpoint | Purpose |
|---|---|
| `POST /api/agents/:agentId/recommendations/:recId/apply` | Trigger apply (body: `{finalText, userEmail}`) |
| `POST /api/recommendations/:recId/rollback` | Rollback |
| `POST /api/recommendations/:recId/validate` | Live validation for edit-as-you-type |
| `GET /api/recommendations/:recId/preview-apply` | Initial modal load: returns `{currentText, aiSuggestedText, validators}` |
| `GET /api/recommendations/:recId/history` | List apply_attempts for audit panel |

### Phase 6 — Frontend Apply UI (5.5 h)

| Component | Effort |
|---|---|
| 6.1 `ApplyRecommendationButton.vue` + drop-in on existing surfaces (Patterns, Call Detail, Agent Detail) | 30 min |
| 6.2 `ApplyDiffModal.vue` — editable textarea + live validator + edit-aware Confirm button + Reset link | 2.5 h |
| 6.3 `ApplyReceiptPanel.vue` — 6-step timeline + AI-vs-edit diff section + rollback affordance | 1 h |
| 6.4 `ApplyStatusPill.vue` — 4 lifecycle states + `✎ edited` badge | 30 min |
| 6.5 `RecommendationCardV4.vue` — V4 redesign w/ WHY/WHAT/WHERE | 1 h |

### Phase 7 — Tests + docs (1.5 h)

| Task | Effort |
|---|---|
| 7.1 3 new regression scenarios: apply-success, apply-failure-with-rollback, edit-then-apply | 45 min |
| 7.2 Update `docs/ARCHITECTURE.md` with the HL write integration | 15 min |
| 7.3 Update `docs/API_SPEC.md` with the 5 new endpoints | 15 min |
| 7.4 Update `docs/DEMO_SCRIPT.md` to add the one-click apply moment | 15 min |

**Total: ~14 hours** (post-discovery, dropped from 27 h estimate). Phase 0 is the gate; everything else is straight code.

---

## 6. UX flow (end-to-end, one click)

1. User on `/patterns` sees the "Capture Lead Data" recommendation card
2. Clicks **"Apply to FrontDoor AI →"** button
3. Backend fires `GET /api/recommendations/:recId/preview-apply` → returns:
   ```
   current agentPrompt (5658 chars, with the relevant block highlighted)
   ai-suggested merged prompt (5734 chars, with the change highlighted)
   validators: all pass
   ```
4. Modal opens with the diff (highlighted region of current vs proposed), editable textarea, validator checks
5. User optionally edits the proposed text (validators re-run live, debounced 300ms)
6. User clicks **Confirm** → frontend fires `POST .../apply` with `{finalText, userEmail}`
7. Backend runs the 9-step orchestration (~2-5 seconds — network-bound on HL API + our sync)
8. Receipt panel renders with timeline; status pill on the card flips: `Applying...` → `Applied · waiting for next call`
9. Backend's Sync All eventually picks up new calls under the new prompt
10. `computePendingOutcomes()` fires → status pill flips: `Measured: +12.5 pts ✓`
11. If anything regresses, user clicks **Rollback** → backend re-PATCHes the snapshotted `previous_agent_prompt` → status: `Rolled back`

---

## 7. Failure modes + mitigations

| Failure | Detection | Mitigation |
|---|---|---|
| HL Voice AI API returns 5xx | Service catches, route returns 502 | UI shows error toast w/ "Apply failed — falling back to manual paste" + copy box with the final text |
| OAuth scope insufficient (`voice-ai-agents.write` missing) | 401 from HL | Surface clearly: "Re-install the Marketplace App to grant `voice-ai-agents.write` scope" |
| PATCH succeeds but our DB write fails | `apply_attempts.outcome` would be inconsistent | Run DB writes BEFORE the PATCH where possible (snapshot first); on post-PATCH local failure, fire a background reconciler |
| User clicks Apply twice fast | Race condition | Idempotency: if status='applied' for this rec within last 5min, return existing receipt |
| Recommendation text breaks the agent (e.g. invalid template variable) | HL likely returns 422 at PATCH time | Surface clearly in UI: "HL rejected the prompt — see error: …"; AND validator catches it pre-PATCH for known cases |
| User wants to undo but rollback fails (HL is down) | rollback returns 502 | UI: "Rollback failed — your previous prompt is stored locally. [ Retry rollback ] or [ Copy previous prompt ]" |
| HL changes the API shape | PATCH starts failing | Contract test in regression suite — weekly no-op PATCH catches drift |

---

## 8. Risks + decisions (resolved post-discovery)

| Decision | Resolution |
|---|---|
| Use Agent Studio vs Voice AI API | **Voice AI** — discovery showed Voice AI has its own self-contained API surface |
| Versioning strategy | **Snapshot-based** — HL has no native versioning, so `previous_agent_prompt` lives in our `apply_attempts` table |
| PATCH vs PUT | **PATCH** preferred (partial update); fall back to PUT if Phase 0 probe shows HL only supports PUT |
| Auto-apply after Confirm vs explicit promote step | **Auto-apply** — Voice AI has no draft/promote concept anyway; PATCH = live |
| Where to surface the Apply button | **Every surface** — Patterns, Call Detail, Agent Detail, Action queue; single reusable component |
| Diff modal: 3-pane vs inline | **Side-by-side with inline highlight** within each panel — best for long-prompt diffs |
| Track who clicked Apply | **userEmail prompt once per browser session, stored in localStorage** — keeps audit trail useful without auth complexity |
| Edit before commit | **YES** — opt-in default; textarea is editable, validators re-run live, Confirm button label switches (`Apply AI suggestion` ↔ `Apply your edit`). See §12.3 |

---

## 9. Demo script delta — what changes in the Loom

V3 demo ends with: *"Today's version saves ~3 hours per QA cycle. The one manual step is pasting the prompt change into HighLevel."*

V4 demo adds:

> "And here's the close. Click Apply on this recommendation."
>
> [diff modal pops up showing the current 5K-char prompt with the proposed addition highlighted]
>
> "I can edit the suggestion if I want — let me soften this question. [types] Validators rerun live, all green. Confirm."
>
> [receipt panel appears with 6-step timeline]
>
> "The live HighLevel Voice AI agent was just updated. Next inbound call will hit the new prompt. Within a few calls, the Measure stage tells me if the fix worked. Total time from problem to fix in production: under 30 seconds."

That's the moment that turns "smart dashboard" into "actual copilot."

---

## 10. Cost + risk summary

| Dimension | V4 cost |
|---|---|
| Engineering effort | ~14 hours (post-discovery; was 27h before we found Voice AI is simpler than Agent Studio) |
| New OpenAI cost per Apply | ~$0.002 (1 small EditSummaryService call + 1 tone-validator call; cached on identical text) |
| New infrastructure | None |
| Schema migrations | 2 additive columns + 1 new table |
| Regression risk to V3 | **Low** — V4 is purely additive; existing manual flow keeps working |
| Risk of breaking customer Voice AI agents | **Medium** — mitigated by validator pipeline + diff confirmation + snapshot-based rollback |
| Demo impact | **High** — moves from "saves QA time" to "actually fixes agents one-click" |

---

## 11. Go/no-go criteria

V4 is approved when:
- [x] **Voice AI agents are editable via API** — confirmed Phase 1 (single `agentPrompt` field, PATCH endpoint exists)
- [ ] OAuth scope `voice-ai-agents.write` confirmed working on a real PATCH (Phase 0, pending re-install)
- [ ] PATCH accepts partial body (or full body if not — minor adjustment) — Phase 0
- [ ] HL's rate limit for PATCH is reasonable — unlikely concern given Voice AI's call volume scale

Phase 0 is the only remaining blocker. ~15 min of work + your re-install of the Marketplace App.

---

## 12. UX + Trust Layer — earning the right to one-click

The mechanical loop (Phases 0–7 above) is the *what*. Below is the *how the user sees it* — without which V4 ships and sits unused because nobody trusts it.

### 12.1 Information hierarchy: every Apply needs 3 layers visible

```
WHY (reasoning)        — why is this fix being suggested?
WHAT (the change)      — what exactly will change in HL?
WHERE (the target)     — which agent, where in its prompt?
```

These three are surfaced at every stage: the recommendation card, the diff modal, the post-apply receipt. No "Apply" button anywhere without all three already in front of the user.

### 12.2 Recommendation card — before the click

```
┌─────────────────────────────────────────────────────────────────────┐
│ ▌🔴 critical  3× across 1 agent      Capture Lead Data              │
│                                                                      │
│   WHY  Detected in 3 FrontDoor AI calls — caller volunteered their  │
│        contact info but the agent never asked. 2 of these calls     │
│        had outcome="no_sale".                                       │
│                                                                      │
│   WHAT The agent's current prompt opens with a single "How can I    │
│        help?" question after the greeting. Suggested addition is    │
│        a name + callback number ask before answering the question.  │
│                                                                      │
│   WHERE FrontDoor AI · in the "qualification" section of the        │
│        5,658-char agent prompt (the AI will show you exactly where) │
│                                                                      │
│   [ ⓘ See evidence (3 call links) ]   [ Apply to FrontDoor AI → ]   │
└─────────────────────────────────────────────────────────────────────┘
```

### 12.3 Diff modal — editable, with live validators

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Apply recommendation: Capture Lead Data           [✕ close]                  │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│ TARGET                                                                       │
│   Agent:  FrontDoor AI                                                       │
│   Prompt length: 5,658 chars (will become ~5,734 if applied)                 │
│                                                                              │
│ ─── DIFF (right panel editable) ──────────────────────────────────────────── │
│  ┌──── CURRENT (relevant section) ──┐    ┌──── PROPOSED (editable) ────────┐│
│  │ ...                              │    │ ┌─────────────────────────────┐ ││
│  │ Hi, how can I help               │    │ │ Hi, before we dive in —     │ ││
│  │ you today?                       │ →  │ │ could you share your name   │ ││
│  │                                  │    │ │ and a callback number?      │ ││
│  │ ...                              │    │ │ Then I'll be happy to help. │ ││
│  │                                  │    │ │                             │ ││
│  │                                  │    │ │ ...                         │ ││
│  └──────────────────────────────────┘    │ └─────────────────────────────┘ ││
│         [ View full prompt ]              │  ⓘ AI suggestion · ✎ 0 edited  ││
│                                           │  ↺ Reset to AI suggestion       ││
│                                           └─────────────────────────────────┘│
│                                                                              │
│ ─── VALIDATORS (live — re-run as you edit) ──────────────────────────────── │
│   ✓  No undefined template variables                                         │
│   ✓  Length within prompt limit (5,734 / 8,000 chars)                        │
│   ✓  Tone consistent with agent goal (passed sentiment check)                │
│   ✓  Forbidden-content check passed                                          │
│   ⚠  Adds a question — average call length may increase 5-8 sec             │
│                                                                              │
│ ─── WHAT WILL HAPPEN ─────────────────────────────────────────────────────── │
│   1. Snapshot the current 5,658-char agentPrompt to our DB (for rollback)    │
│   2. PATCH /voice-ai/agents/{id} with the new agentPrompt (this text)        │
│   3. Mark recommendation as applied in copilot                               │
│   4. Future calls will run on the new prompt — measurement appears in       │
│      the Flywheel after ≥1 post-apply call comes in                         │
│                                                                              │
│ ─── ROLLBACK ─────────────────────────────────────────────────────────────── │
│   If this regresses, click Rollback on the recommendation card. The         │
│   previous prompt (snapshotted in step 1) is restored in 1 second.          │
│                                                                              │
│                              [ Cancel ]    [ ▶ Apply AI suggestion ]         │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Edit-aware Confirm button

| State | Indicator under textarea | Confirm button label |
|---|---|---|
| Untouched (matches AI suggestion exactly) | `ⓘ AI suggestion · ✎ 0 chars edited` | **`▶ Apply AI suggestion`** |
| User edited, validators still pass | `✎ 47 chars edited · validators passed` | **`▶ Apply your edit`** |
| User edited, broke a blocking validator | `✎ 47 chars edited · ✗ 1 blocking issue` | **Disabled** w/ tooltip |
| User clicked "Reset" | back to untouched state | back to `Apply AI suggestion` |

The button-label switch is small but psychologically critical: "Apply **your** edit" makes the user own the change. Reduces "the AI broke my agent" blame.

#### Edge cases the editable textarea handles

| Edge case | Behavior |
|---|---|
| User edits text to empty | Validator: "Prompt cannot be empty" → Confirm disabled |
| User edits to identical to current production | Soft warn: "⚠ No change vs current — Apply will PATCH with same text. Cancel?" |
| User adds an undefined `{{template_var}}` | Validator: "✗ `{{customer_name}}` not defined on this agent" |
| User edits then closes modal | Soft warn: "Discard your edits?" → [Discard] / [Keep editing] |
| User's edit is much longer (>200%) than the suggestion | Informational warn (non-blocking) |

### 12.4 Pre-apply validator pipeline

Validators run in three triggers:

1. **On modal open** — runs against the AI's suggested text, populates initial check list
2. **On every keystroke in the editable textarea** — debounced 300ms via `useDebouncedValidate` composable
3. **On Confirm click** — final pass server-side (defence against client-side bypass)

Server endpoint: `POST /api/recommendations/:recId/validate` → returns `{checks: [...], blocking: bool}`. Target round-trip: <200ms.

### 12.5 Post-apply receipt — what just happened

After Confirm, the modal transitions to a receipt. Two flavours:

#### Receipt — AI suggestion accepted as-is

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ✓ Applied to FrontDoor AI · AI suggestion accepted as-is                     │
├──────────────────────────────────────────────────────────────────────────────┤
│   1. ✓ Snapshotted previous agentPrompt (5,658 chars)  02:14:33 PM           │
│   2. ✓ PATCH /voice-ai/agents/6a23…           02:14:34 PM   (HL response 200)│
│   3. ✓ Recommendation marked applied           02:14:34 PM                   │
│   4. ✓ Synced copilot                          02:14:35 PM                   │
│        1 active rec → applied                                                │
│   5. ⏳ Awaiting next call under the new prompt                              │
│                                                                              │
│   Receipt ID: apply_8a9f3c2 · applied_as: as_suggested                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Receipt — user edited the suggestion

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ✓ Applied to FrontDoor AI · You edited the AI suggestion before applying    │
├──────────────────────────────────────────────────────────────────────────────┤
│   ─── YOUR EDIT vs AI SUGGESTION ────────────────────────────────────────── │
│     • You changed 47 characters from the original AI suggestion              │
│     • Edit summary: "softened the ask + added a please"                      │
│     [ ▾ Show diff: AI suggestion vs your final text ]                        │
│                                                                              │
│   1. ✓ Snapshotted previous agentPrompt (5,658 chars)  02:14:33 PM           │
│   2. ✓ PATCH /voice-ai/agents/6a23…           02:14:34 PM   (HL response 200)│
│   3. ✓ Recommendation marked applied           02:14:34 PM                   │
│   4. ✓ Synced copilot                          02:14:35 PM                   │
│   5. ⏳ Awaiting next call under the new prompt                              │
│                                                                              │
│   Receipt ID: apply_8a9f3c3 · applied_as: user_edited                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

Both receipts include action buttons: `[ Open Flywheel ]   [ Done ]`.

If any step failed mid-flow, that line gets ✗ + error with concrete recovery action inline.

### 12.6 Status pill on the recommendation card

After receipt closes, the rec card on `/patterns` and elsewhere shows a persistent status pill:

```
[ ✓ Applied · 02:14 PM · awaiting first call ]          [ Rollback ↺ ]
   ↓ after first post-apply call:
[ ✓ Applied · awaiting measurement (1 call so far) ]    [ Rollback ↺ ]
   ↓ after measurement fires:
[ ✓ Measured: +12.5 pts (n=3 calls) ]                   [ Rollback ↺ ]
   ↓ if measured negative:
[ ⚠ Measured: -8.2 pts (n=3 calls) ]                    [ Rollback ↺ ] ← red

   With edit badge (when user tuned the suggestion):
[ ✓ Measured: +12.5 pts ] [✎ edited]                    [ Rollback ↺ ]
                            ↑ hover: "You edited 47 chars from the AI suggestion"
                              click → receipt panel w/ diff
```

### 12.7 Failure-aware modal states

Three explicit failure states beyond the happy path:

**A. Validator blocks:**
```
✗ Cannot apply — 2 blocking issues:
   ✗ Template variable {{caller_company}} not defined on this agent
   ✗ Proposed text exceeds prompt limit (8,200 / 8,000 chars)

   [ Copy proposed text to clipboard ]   [ Open agent in HL ]   [ Cancel ]
```

**B. HL API error mid-apply:**
```
✗ Apply failed at step 2
   Step 1 ✓  Snapshotted previous agentPrompt
   Step 2 ✗  PATCH failed: HL returned 422 "Invalid template variable"
              (HL message: "{{unknown_var}} is not a defined variable")

   Your agent is UNCHANGED in HL — the snapshot wasn't needed.
   Recommendation remains active.
   [ Show me the HL error ]   [ Edit and retry ]   [ Cancel ]
```

**C. Rollback failed:**
```
⚠ Rollback partially failed
   The previous prompt is stored in our DB (5,658 chars).
   HL is currently returning 503 — we couldn't restore the prompt right now.

   [ Retry rollback ]   [ Copy previous prompt ]   [ Open HL to paste manually ]
```

### 12.8 Architecture additions to support all of the above

All accounted for in §4. New files include `RecommendationValidatorService`, `EditSummaryService`, `useDebouncedValidate` composable, `RecommendationCardV4`, `ApplyReceiptPanel`, `ApplyStatusPill`, `ApplyDiffModal`, `ApplyRecommendationButton`, `diff.js`.

### 12.9 Effort impact

| Iteration | Total |
|---|---|
| V4 plan v1 (mechanical loop, Agent Studio assumption) | 15 h |
| V4 plan v2 (+ trust layer: validators, diff, receipt) | 24 h |
| V4 plan v3 (+ editable suggestion) | 27 h |
| **V4 plan v4 (Voice AI reality — simpler architecture)** | **~14 h** ← current |

Detailed phase breakdown above in §5. The simplification from v3 → v4 (-13h) comes from:
- Deleted `NodeResolverService` (-2.5h)
- Deleted draft/promote flow in HL client (-1.5h)
- Deleted cross-node contradiction validator (-0.5h)
- Deleted node-selector dropdown in modal (-1h)
- Simplified `HLAgentStudioService` → `HLVoiceAgentService` (~250 → ~180 LOC, -1h)
- Simplified orchestrator (9 steps → 5 steps, -0.5h)
- Frontend modal simpler without node-selector (-2h)
- Schema simpler (no `node_id`) — minor
- Tests scope smaller (-1h)

The trust layer (validators, edit, diff modal, receipt, status pill) is fully preserved — those are the customer-facing features that earn adoption.

### 12.10 Acceptance criteria — UX layer

V4 ships only when ALL of:

- [ ] Every recommendation card shows WHY / WHAT / WHERE before the Apply button is clickable
- [ ] Diff modal renders current vs proposed agentPrompt with the changed region highlighted
- [ ] [ View full prompt ] expand shows the entire 5K-char prompt in context
- [ ] Right panel of the diff modal is an editable textarea pre-filled with the AI suggestion
- [ ] Validators re-run live as user edits (debounced 300ms, <200ms server round-trip)
- [ ] Confirm button label switches between `Apply AI suggestion` and `Apply your edit`
- [ ] "Reset to AI suggestion" link reverts the textarea + re-runs validators
- [ ] All 5 validators run before Confirm becomes clickable; blocking validators disable button
- [ ] Receipt panel shows the 5-step apply timeline with timestamps and outcomes
- [ ] Receipt distinguishes `applied_as: as_suggested` vs `user_edited` with an AI-vs-edit diff
- [ ] Status pill on the rec card updates through 4 lifecycle states (applied → awaiting → measured → optionally rolled-back)
- [ ] Status pill on edited recs shows `✎ edited` badge with hover tooltip + click-to-open receipt
- [ ] Each failure state (validator-blocks / HL-API-error / rollback-fails) has its own modal layout with concrete recovery actions
- [ ] Rollback works in ≤5 seconds and surfaces a receipt confirming the restore
- [ ] Audit: every Apply produces an `apply_attempts` row visible via `GET /api/recommendations/:recId/history`
- [ ] Audit row captures `edited_from_suggestion`, `ai_suggested_text`, `final_text`, `previous_agent_prompt`, `chars_diff_from_suggestion`, `edit_summary`

### 12.11 Edit-driven product intelligence

Edit isn't just UX — it's free training data. Each user edit teaches us where the LLM's suggestions need work.

| Metric | Query | Use |
|---|---|---|
| **Edit rate** | `% of applied recs that were edited` | If >50%, our LLM prompt needs improvement |
| **Edit-vs-asSuggested outcome delta** | Avg score delta split by `applied_as` | Are user edits actually improving outcomes vs as-suggested? |
| **Most-edited rec types** | `GROUP BY recommendation.type` | Which scenarios our LLM handles weakly |
| **Common edit patterns** (LLM-summarised) | Batch summarisation across `edit_summary` rows | Concrete signals to bake into the analysis prompt |

Admin endpoint exposes these:

```
GET /api/admin/edit-insights?days=30
{
  "totalApplied":              42,
  "editRatePct":               38,
  "asSuggestedAvgScoreDelta":  +8.2,
  "userEditedAvgScoreDelta":   +11.7,    ← user edits delivered bigger improvement
  "mostEditedTypes":           [{"type":"prompt","count":12}],
  "topEditPatterns": [
    "users frequently add tone-softener phrases at start",
    "users commonly remove sales-style closing sentences",
    "3 of last 30 edits added Spanish translation"
  ]
}
```

**Edit is product instrumentation disguised as a UX feature.**

---

## 13. After V4 ships

V5 candidates in priority order:

1. **Bulk Apply** — "apply this fix to all 5 agents matching this pattern" with per-agent confirmation
2. **Editing `actions[]`** (Voice AI function-calling tools) — separate UI surface
3. **Editing `welcomeMessage`** as a distinct affordance (same PATCH endpoint)
4. **A/B testing** — needs HL feature support; not yet exposed at the API level
5. **Auto-rollback** — if measured outcome < -5 pts, automatically revert + alert
6. **Slack/email alerts** — fire when a measured outcome lands (improvement OR regression)
7. **Real-time webhook ingestion** — replace Sync All polling with HL `call.completed` push
