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
[Click ♻️ Flywheel tab]

> "And here's the framing the FSB doc calls the **Validation Flywheel**. Five stages — Ingest, Score, Recommend, Apply, Measure — and unlike a typical analytics tool, we don't stop at 'here's a recommendation.' We measure whether the fix actually improved the score."

[Click the **Measure** stage to expand it]

> "Look at this: this period **3 recommendations were applied** to agent prompts, all 3 were **measured against the prior version**, and the average score improvement was **+12.5 points**. That's 100% success rate — causal proof that AI Copilot's recommendations actually work. The Flywheel closes."

#### 1:45 — Patterns: see the recurring issues (30s)
[Click 🔍 Patterns]

> "Issues don't happen once. The Patterns view clusters them: 'Capture Lead Data' — **detected in 3 calls, all 3 failed, on FrontDoor AI.** That `recurring` badge means this isn't a one-off; it's a systemic issue worth fixing once instead of triaging three times."

[Expand the top critical pattern, reveal the per-agent breakdown + the AI's paste-ready suggested change + the `▶ Apply to FrontDoor AI` button]

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

> "Modal shows the current 5,000-character agent prompt on the left, the AI-suggested addition on the right — fully editable if I want to tune wording. Five validators ran live: variables, length, brand voice, safety check, call-length impact — all green."

[Click `▶ Apply AI suggestion`]

> "Two seconds. We **snapshotted the previous prompt**, **PATCHed the live HighLevel Voice AI agent**, marked the recommendation applied. Receipt shows every step with timestamps. The agent is now running the new prompt — next inbound call hits it."

[Point at the receipt timeline · then close]

> "If the next batch of calls regresses the score, I click Rollback — previous prompt restored in one second. **Detection → fix in production → measurement → optional revert. End-to-end loop closed in under 30 seconds per fix.**"

---

### ACT 4 · TRIAGE + VALIDATE (3:30 – 4:15)

#### 3:30 — Action queue (covers FSB "Use Actions") (20s)
[Click ⚠️ Actions]

> "Actions queue is the FSB-required **Use Actions** surface — moments the AI flagged for human follow-up. Pending tab, plus resolved / dismissed / escalated history. Each row links directly to the flagged turn in the transcript — one click and the call opens scrolled to that moment."

[Click one `call XXXXX ↗` link to demonstrate the turn-scroll]

#### 3:50 — Credibility: this works on real HighLevel data (25s)
[Switch to a second terminal]

```bash
bash .runtime/use-data.sh live
```

[Refresh the dashboard browser tab]

> "Everything you just saw was the test dataset — covers every customer pain point with comprehensive seeded scenarios. Now switch to live mode. Same UI. **Now it's pulling 9 real Voice AI agents from my HighLevel sandbox via OAuth, with real call transcripts, real KPI scoring.** Same pipeline, mock or production. The Apply button writes to the real HL agent via the Voice AI API."

---

### ACT 5 · CLOSE (4:15 – 4:30)

> "Built solo over a few days. Node + Vue, SQLite via the built-in `node:sqlite`, OpenAI structured output, embedded in HighLevel via Marketplace App OAuth — dashboard sits in the HL left nav as a Custom Menu Link. V4 one-click apply against the HL Voice AI API is live and battle-tested — 27 of 27 regression assertions passing against the real sandbox. Architecture docs, V4 plan, full regression suite all in the GitHub README."

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
- [ ] GitHub repo URL: https://github.com/UdayAppam/voice-ai-observability-copilot
- [ ] Cloudflared tunnel URL (or stable demo URL) tested 5 min before sending — verify a fresh browser can load `/dashboard/`
- [ ] Brief reviewer note in submission body: "Demo on test data; live HL data toggle shown at ~3:50"
