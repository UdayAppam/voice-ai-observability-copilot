# Demo Script (2-5 min Loom)

Walkthrough script that proves every FSB rubric item with live data and shows the live ↔ test data toggle. Target: ~4 minutes.

---

## Before recording

- [ ] Test DB populated
      `bash .runtime/use-data.sh status` → test row should show ~4 agents · 14 calls
      If empty: `bash .runtime/use-data.sh seed-test` (one-time, ~$0.10 OpenAI)
- [ ] Start the backend + tunnel on the **TEST DB** in one command — no prompt, no follow-up:
      ```
      bash .runtime/run-persistent.sh restart --db=test
      ```
      Skip the `restart` if nothing is running. Note the printed PUBLIC URL.
- [ ] Open a second terminal alongside the browser — you'll use it for the live-data toggle near the end
- [ ] Browser zoom 100%, window 1440×900, no other tabs visible
- [ ] Mic check, Loom ready

---

## Script

### 0:00 — Hook (15s)
> "HighLevel agencies running Voice AI today have no way to know if their agents are actually performing — someone is listening to recordings by hand. This is **AI Copilot** — an observability layer that monitors every call, scores it against custom KPIs, surfaces what went wrong, and **measures whether your prompt changes actually worked**."

Open the dashboard URL.

### 0:15 — Monitor → Analyze hero (30s)
> "Top of the Overview shows the Monitor-Analyze loop in action. The AI ingested 14 calls across four agents, scored them against each agent's specific KPIs, surfaced 7 failed status calls, and generated 25 recommendations — automatically. The WHY line tells me objection handling is the biggest mover."

Point at MonitorAnalyzeHero. Hover to show the WHY line.

### 0:45 — Validation Flywheel (60s) — the differentiator
> "Click the Flywheel tab. This is what nothing else in the market does — we don't just flag problems, we close the loop and **measure** whether the fix worked."

Click `♻️ Flywheel`.

> "Top is the Validation Funnel — 7 issues funneled through 17 root causes, 28 recommendations, 3 auto-applied when a prompt changed, and **3 outcomes measured** — all 3 of which improved the score by an average of 12.5 points. That's 100% success rate."

Click the **Score** stage card to expand.

> "Each stage explains itself with what / why / evidence / action. Score is showing a 65/100 average — and it tells me **exactly which KPI fell hardest**, with the specific calls that caused the drop."

Click the **Measure** stage.

> "Measure shows the causal proof. Best fix this period: 'Encourage Further Engagement' — applied to FrontDoor AI's prompt, +12.5 points across the next sample. That's the loop closing."

### 1:45 — Patterns (40s)
> "Patterns clusters failures across agents. Instead of seeing the same issue 5 times across 5 agents, I see it once with the affected-agent count."

Click `🔍 Patterns`.

> "Top critical: 'Capture Lead Data' — affecting one agent, 3 occurrences. The lifecycle bar shows the active vs applied vs dismissed mix. Click to expand for the per-agent breakdown with the exact suggested prompt change ready to paste."

Expand one card.

### 2:25 — Actions queue (30s)
> "Actions is the inbox for moments the AI flagged for human follow-up — script training, escalations, intervention. Resolve, Dismiss, or Escalate with one click."

Click `⚠️ Actions`.

> "I've got pending, plus resolved/dismissed/escalated from earlier triage. Tab badges update live. Click Resolve — the row disappears optimistically and the counter updates."

Click Resolve on one row.

### 2:55 — Call Detail with hallucination flag (40s)
Click any failing call from the queue (S4 — Maya / hallucination is best).

> "Inside a call you see the full transcript, annotated. **Red rings** are use actions, amber are missed opportunities, **red triangles are hallucinations** — moments where the AI stated something not supported by its script. Here, the agent invented HIPAA + SOC 2 + ISO 27001 compliance claims that aren't in the agent's goal or knowledge base. That's an AI safety win — it catches brand-damage moments before they compound."

Scroll the transcript, highlight the hallucination chip in the header.

### 3:35 — Per-agent flywheel + KPI editor (25s)
Click into FrontDoor AI from the agent strip.

> "Per-agent flywheel — same 5 stages, scoped to one agent. And here's the per-agent KPI editor —"

Click `✎ Edit weights & thresholds`.

> "— adjust weights for this specific agent. Lead-gen agent? Weight call completion higher. Validation enforces the weights sum to 1.0."

### 3:55 — V4 one-click Apply (35s) — the killer moment

In the second terminal (or browser, switch to **live** mode first via `bash .runtime/use-data.sh live`):

Open `/patterns`. Expand any critical recommendation on FrontDoor AI.

> "And here's V4 — the close. Watch this."

Click `▶ Apply to FrontDoor AI` on any active row.

> "Modal opens with the current 4.7K-char agent prompt on the left, AI-suggested addition on the right. I can edit it — validators re-run live, all green. Let me leave it as-is and click Confirm."

Click `▶ Apply AI suggestion`.

> "About 2 seconds — we snapshotted the previous prompt, PATCHed the live HighLevel agent, marked the recommendation applied. Receipt panel shows every step with timestamps."

[Receipt panel renders with timeline]

> "That live HighLevel Voice AI agent just got updated. Next inbound call hits the new prompt. Within a few calls, the Flywheel Measure stage tells me the score delta. If it regresses, click Rollback on the card — the previous prompt is restored in one second. End-to-end: detection → fix in production → measurement → optional revert. That's the agency-life-easier promise made real."

[Optional: click Done, then Rollback on the card to demonstrate the safety net]

### 4:30 — Live data switch (20s) — the credibility moment
> "One more thing. Everything you just saw is on the test dataset — comprehensive scenarios covering every customer pain point. Now watch this."

In a terminal next to the browser:
```
bash .runtime/use-data.sh live
```

Refresh the dashboard.

> "Same UI, now running on real Voice AI agents pulled from my HighLevel sandbox via OAuth. Nine real agents. The system is built provider-agnostic — mock data, regression scenarios, or live HL — same pipeline, same dashboard."

### 4:50 — Close (10s)
> "Built solo. Node + Vue, SQLite, OpenAI structured output, embedded in HighLevel via Custom JS or Marketplace App OAuth — both shipped. V4 one-click apply via HL Voice AI API closes the loop end-to-end. Architecture docs and full regression suite — including V4 live tests against the HL sandbox — in the README."

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

> The mid-session toggle (`use-data.sh`) is the one the demo uses at 4:00 — it keeps the tunnel URL stable so the dashboard reloads in place without a new URL flashing up.

---

## Final pass before publishing

- [ ] Watch full recording, cut any silences
- [ ] First 30 seconds must show actual product, not slides
- [ ] Audio normalised, no background noise
- [ ] Length 2:00–5:00 (target 4:00)
- [ ] Click sounds + cursor visible throughout
- [ ] No personal info, OpenAI key, or HL token visible in URL bar or DevTools
- [ ] Make sure you finish on the LIVE-data refresh — that's the "this is real" moment

## Submission checklist

- [ ] Loom URL added to README
- [ ] GitHub repo URL added to submission
- [ ] Cloudflared tunnel URL (or other publicly-reachable URL) tested fresh before sending
