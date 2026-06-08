# Demo Script (2-5 min Loom)

Story-driven walkthrough built around the FSB rubric: **Problem → Solution → Validation**. Every section ties back to a concrete agency-owner pain point and shows the working product solving it. V4 one-click apply is the climax, not a footnote.

Target: **4 minutes** (range 3:30 – 4:45).

---

## Before recording

- [ ] Test DB populated (gives you the seeded scenarios with measured outcomes)
      `bash .runtime/use-data.sh status` → test row should show ~4 agents · 14 calls
      If empty: `bash .runtime/use-data.sh seed-test` (one-time, ~$0.10 OpenAI)
- [ ] Start backend + tunnel on the **TEST DB** in one command:
      `bash .runtime/run-persistent.sh restart --db=test`
      Note the printed PUBLIC URL.
- [ ] Open a second terminal alongside the browser — you'll use it ~2:30 for the live-data toggle
- [ ] Browser zoom 100%, window 1440×900, no other tabs visible, address bar clean (no PATs in URL)
- [ ] Dismiss the Overview welcome card before recording (or leave it as part of the opener — your call)
- [ ] Mic level checked, Loom ready

---

## Script — 4-minute story arc

### ACT 1 · THE PROBLEM (0:00 – 0:30)

#### 0:00 — Hook with concrete pain (15s)
> "If you're a HighLevel agency running 5, 10, 20 Voice AI agents for your clients, today there's no way to know if any of them is hallucinating prices, missing leads, or going off-script — unless you listen to every call. Most agency owners don't have that time. Issues compound silently."

[Open the dashboard URL — full-screen]

#### 0:15 — Scale of the problem in numbers (15s)
> "Here's a sample sub-account: 4 agents, 14 calls in the last month. To audit those by hand is roughly 5 hours of listening. Multiply that across an agency with 20 agents — nobody does it. **AI Copilot does it for you, in seconds, every time a call lands.**"

[Point at the hero metric cards on Overview]

---

### ACT 2 · MONITOR + ANALYZE (0:30 – 2:15) — the FSB Core Functionality

#### 0:30 — Monitor: every call auto-scored (30s)
[Stay on Overview]

> "This is the **Monitor** half. Every Voice AI call is ingested from HighLevel, scored against the agent's own KPIs — Call Completion, Script Adherence, Objection Handling, six in total — and rolled up here. The WHY line at the top of the Monitor strip tells me what's moving: **Objection Handling fell hardest this period.** I don't have to dig — the dashboard already opened the right rock."

[Point at MonitorAnalyzeHero · then briefly the AgentStatusStrip]

#### 1:00 — The Validation Flywheel (45s) — the FSB framing concept
[Click ♻️ Flywheel tab — opens to a clean 2-hero layout]

> "And here's the FSB's framing — the **Validation Flywheel**. But notice what's NOT here: a wall of charts. The page answers two questions in 3 seconds. Hero 1: **+8 significant improvements** — that's the headline. Hero 2: **What's blocking us next.** Below, a one-line lifecycle: **11 issues → 25 recs generated → 9 applied → 9 measured → 8 improved** — the loop in a sentence."

[Point at the headline metric and the lifecycle sentence — the leak step shows in red if any]

> "Unlike a typical analytics tool, we don't stop at 'here's a recommendation.' We **causally measure** — Δ≥2 points AND n≥3 calls — whether each fix actually improved scores. **8 of 9 measured outcomes** improved significantly. Cycle time: **1.1 days** from issue detected to fix applied. The Flywheel closes — with significance, not just claims."

[Optionally click "▸ Drill in" to reveal funnel + per-stage operational cards if pacing allows]

#### 1:45 — Patterns: per-agent rollup, no fake duplicates (30s)
[Click 🔍 Patterns]

> "Issues recur across agents. Each pattern card now shows an **apply-state pill**: this one says **Applied 1 of 2 — 1 still needed**. That's because the same recommendation is applied for Maya but still active for FrontDoor — not a duplicate, it's per-agent work. Expand the card and the view **splits**: '⚠ Still needs apply on FrontDoor AI' with an inline [Apply] button, plus '✓ Already applied on Maya' below for context. The product knows the difference between cross-agent work and a stale duplicate — and semantic dedup catches near-duplicate titles like 'Capture Caller Details' ≈ 'Capture Caller Information' before they even appear."

[Expand one partial-state pattern to show the split sections]

---

### ACT 3 · ACT — V4 ONE-CLICK APPLY (2:15 – 3:30) — the climax

#### 2:15 — The wow moment: see the actual issue first (30s)
[Click into one of the failing calls — pick S4 / Maya for the hallucination card, or FrontDoor for a pattern-driven one]

> "Before I fix it, let me see what actually went wrong on a call. The transcript is annotated — and this red card here is the one I worry about most: **the AI agent made an unverified claim.** Said we're HIPAA-certified, SOC 2 audited — those aren't in the agent's script. It made them up. That's brand damage and legal exposure in one turn."

[Point at the structured "what the agent said / why flagged / why it matters / what to do" card]

> "Each flagged moment explains itself in plain English — what the agent said, why we flagged it, why it matters for your business, and what to do. No AI jargon."

#### 2:45 — V4 Apply: one click fixes the live agent (45s) — **the killer feature**
[Back to /patterns, click `▶ Apply to FrontDoor AI` on a critical pattern]

> "Now here's the part no observability tool I know does. Watch this."

[Diff modal opens]

> "Modal opens **focused on the one section being changed** — not the whole 5,000-character prompt. I see the original section on the left, the AI's modified version on the right with **the added text highlighted in green**. The product parsed this agent's prompt into **10 named sections** — Persona, Goals, Information Gathering, Script — and decided this fix belongs in **Information Gathering** with high confidence. If I disagree, the **'Place this fix in'** picker lets me re-target any section. Seven validators ran live: variables, length, brand voice, safety, call-length, plus V4.2's section-fit and context-consistency — all green."

[Click `▶ Apply AI suggestion`]

> "Two seconds. We **snapshotted the previous prompt**, **PATCHed the live HighLevel Voice AI agent**, **recorded a new prompt version**, and **linked the recommendation to that version**. That last step is what closes the measurement loop — the next call ingested under the new prompt automatically triggers `computePendingOutcomes`. Receipt shows every step with timestamps."

[Point at the receipt timeline — note the `record_prompt_version` step · then close]

> "If the next batch of calls regresses the score, I click Rollback — previous prompt restored in one second. **Detection → fix in production → automatic measurement → optional revert. End-to-end loop closed.**"

---

### ACT 4 · TRIAGE + VALIDATE (3:30 – 4:15)

#### 3:30 — Action queue (covers FSB "Use Actions") (20s)
[Click ⚠️ Actions]

> "Actions queue is the FSB-required **Use Actions** surface — moments the AI flagged for human follow-up. Pending tab, plus resolved / dismissed / escalated history. Each row links directly to the flagged turn in the transcript — one click and the call opens scrolled to that moment."

[Click one `call XXXXX ↗` link to demonstrate the turn-scroll]

#### 3:50 — Credibility: same pipeline against real HighLevel data (25s)
[Switch to a second terminal]

```bash
bash .runtime/use-data.sh live
```

[Refresh the dashboard browser tab]

> "Everything you just saw — including the **Apply flow with the section-focused editor** — already ran end-to-end against the test dataset. The test DB uses a `LocalAgentService` adapter that mirrors HighLevel's interface, so the full V4 chain (snapshot → patch → version recording → mark applied → audit → measure) works offline. Now switch to live mode. Same UI. **Now it's pulling 9 real Voice AI agents from my HighLevel sandbox via OAuth, with real call transcripts, real KPI scoring.** Same pipeline — only difference is the Apply button now PATCHes the real HL Voice AI agent."

---

### ACT 5 · CLOSE (4:15 – 4:30)

> "Built solo. Node + Vue, SQLite via the built-in `node:sqlite`, OpenAI structured output, embedded in HighLevel via Marketplace App OAuth — dashboard sits in the HL left nav as a Custom Menu Link. V4 one-click apply against the HL Voice AI API is live and battle-tested — **27/27 V4 regression assertions** and **14/14 V4.2 validator assertions** passing against the real sandbox. The V4.3 measurement chain was found broken by PM-style audit and fixed; verified end-to-end on live data. Architecture docs, V4 plan, full regression suite all in the GitHub README."

[End on the dashboard with the Flywheel measure stage visible — closes with the "loop is closed" image]

---

## Why this script structure works for FSB scoring

| FSB rubric criterion | Where the script hits it |
|---|---|
| **Product Thinking + UI/UX** — customer-centric | ACT 1 opens with agency-owner pain in their language (no AI jargon for the first 30s) |
| **Completeness** — closes the loop raw logs → actionable recommendations | ACT 2 + ACT 3 walk the loop end-to-end; ACT 3 climax shows the loop *physically closing* via V4 Apply |
| **Technical Integrity** — observability arch + recommendations logic | ACT 2 names the architecture concepts (Monitor / Analyze / Validation Flywheel — FSB's own terms); ACT 4 cites scope (Voice AI API), tests (27/27), and infra (OAuth) |
| **Manual Code Review** — non-slop signal | ACT 5 cites the architecture docs + regression suite — invites the reviewer in |
| **Required deliverables** — workflow, dashboard, insight | ACT 2 covers all three: ingestion (the WHY line implies it), unified dashboard (Overview + Flywheel), insight per agent (Patterns + Apply receipt) |
| **Demo length 2-5 min** | Target 4:00 — within range, with 30s headroom for narration pacing |

---

## Toggle commands referenced in the script

```bash
# Start fresh on a specific DB — skips the interactive prompt
bash .runtime/run-persistent.sh restart --db=test    # demo prep
bash .runtime/run-persistent.sh restart --db=live    # live HL demo

# Or start with an interactive prompt (shows row counts for each DB)
bash .runtime/run-persistent.sh

# Mid-session — switch without restarting the tunnel (URL stays the same)
bash .runtime/use-data.sh status
bash .runtime/use-data.sh test
bash .runtime/use-data.sh live

# Re-seed the test DB from scratch (costs ~$0.10 OpenAI)
bash .runtime/use-data.sh seed-test
```

> The mid-session toggle (`use-data.sh`) is the one the demo uses at ~3:50 — it keeps the tunnel URL stable so the dashboard reloads in place without a new URL flashing up.

---

## Optional 90-second cut (if you want a shorter Loom)

If you want a tighter "trailer" version under 2 minutes, drop ACT 2's Patterns walk and ACT 4's Actions queue. Keep:

- 0:00–0:30 — Problem (cold open)
- 0:30–1:00 — Overview + Flywheel (Monitor + framing)
- 1:00–2:00 — V4 Apply (the climax)
- 2:00–2:15 — Close

That's 2:15 total. Loses depth but hits the FSB rubric items.

---

## Filming notes — visual polish

| Detail | Why it matters |
|---|---|
| Show the cursor moving deliberately (no jitter) | Reviewer follows your attention |
| Pause 0.5s after each click so the UI fully settles before narration continues | Looks confident, not rushed |
| When the Apply receipt panel renders, let the timeline animate fully before talking over it | Receipt is the wow — let it land |
| Keep tabs/extensions/notifications hidden | Distractions cost credibility |
| Mouse over the WHY line at 0:30 so the reviewer sees the AI explanation appear | Demonstrates the "deterministic narrative" feature without naming it |

---

## Final pass before publishing

- [ ] Watch full recording — cut any silences > 1.5s
- [ ] First 15 seconds must hook the viewer with the customer pain — not the UI tour
- [ ] V4 Apply receipt panel is the visual climax — make sure it renders cleanly and you don't talk over the timeline animation
- [ ] Audio normalised, no background noise, no breath sounds
- [ ] Length 2:00–5:00 (target 4:00). Trim if over 4:45.
- [ ] No personal info, OpenAI key, HL PAT, or company name visible in URL bar or DevTools
- [ ] End on the LIVE-data refresh + a stable Flywheel-measure image — that's the "this is real and works" moment

## Submission checklist

- [ ] Loom URL added to README + submission form
- [ ] GitHub repo URL: https://github.com/UdayAppam/voice-agent-flywheel
- [ ] Cloudflared tunnel URL (or stable demo URL) tested 5 min before sending — verify a fresh browser can load `/dashboard/`
- [ ] Brief reviewer note in submission body: "Demo on test data; live HL data toggle shown at ~3:50"
