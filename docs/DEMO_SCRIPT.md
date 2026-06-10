# Demo script — Voice Agent Flywheel

A conversational 4–5 minute walkthrough of the product, written the way I'd actually talk to a camera. The structure is **pain → the loop → measurement proof → how a fix actually ships** — every section is something I can demonstrate live, on real data, in real time.

This script is what I read off-screen while recording. The tone is deliberately informal — the reviewer should feel like they're being shown something working, not pitched at.

---

## Before I press record

A short pre-flight, because the demo only flows if the data does:

- [ ] Decide which DB I'm opening on — the test DB has the cleanest measurement-proof story; the live DB has real HighLevel calls. I open on test, switch to live around 3:50.
  ```bash
  bash .runtime/use-data.sh status        # see what's in each
  bash .runtime/use-data.sh test          # start on test
  ```
- [ ] Persistent server + tunnel up:
  ```bash
  bash .runtime/run-persistent.sh restart --db=test
  ```
  Wait for the printed `PUBLIC URL` and confirm it loads `/dashboard/` in an incognito window.
- [ ] Window cleanup — 1440×900, 100% zoom, no other tabs visible, no PAT in the URL bar, Slack and notifications muted.
- [ ] Browser already navigated to the Overview page so the first frame the reviewer sees is the dashboard, not a loading state.
- [ ] Mic check, Loom ready, water nearby.

If anything in the prep feels off (stale data, tunnel slow, server logging warnings) I stop and fix it. The script depends on the product feeling alive.

---

## The script

### 0:00 — Cold open: the pain in plain language (30 seconds)

> "If you run a HighLevel agency and you've deployed a Voice AI agent for one of your clients — let alone five or ten — there's a problem nobody talks about. You have no way to know if the agent is hallucinating, missing leads, or skipping its script. Not unless you sit and listen to every call. And nobody does that.
>
> So things compound silently. The agent makes things up, the lead doesn't book, and you find out three weeks later when the client is upset.
>
> I built this to fix that. It watches every call, scores it against the agent's own goals, tells you exactly what's wrong, and — this is the part I'll spend most time on — when you apply a fix, it measures whether the fix actually worked. End to end, no manual listening."

*(Show the Overview page in the background — let the metrics breathe for a second.)*

---

### 0:30 — What the dashboard answers in 10 seconds (1 minute)

> "Top of the page. Six numbers. That's the agency-wide pulse: 14 calls last week, 21% conversion, 67% KPI pass rate, average score 71, four actions needing human follow-up, mood mostly neutral.
>
> The strip below isn't decoration — it tells me **why** each number moved. The product has a short, deterministic narrative for each step. So instead of staring at a chart and guessing, it just says, in English, 'Objection Handling fell the hardest this period — three calls in a row failed to ask about budget.' That's the dashboard pointing at the right rock before I even ask."

*(Hover the WHY line on the Monitor strip so the tooltip pops.)*

> "Below that, every agent in the sub-account, ranked by health. Red dot means an agent is dragging — that's where I'm clicking next."

*(Click into the worst-performing agent — for the test DB demo, that's Maya or Grace.)*

---

### 1:30 — Agent Detail: the new calls list + the unverified-claim story (1.5 minutes)

This is the section that changed most recently, and it's the section the reviewer will spend the longest looking at. I narrate around it carefully.

> "Agent page. Top, the health donut, four key stats — calls, conversion rate, KPI pass rate, average cycle time from issue detection to fix. The notable bit: this agent has 8 calls flagged with **unverified claims**. That's a red badge for a reason — it's the highest-stakes signal we surface."

*(Scroll down to the calls list. The calls list is the V5.9 redesign, so this is where I show off the recent work.)*

> "Here's the calls list. The reason I'm pointing at it: the original version of this list was a bug factory. It said 'Calls (47)' at the top but only showed 20. No load-more, no sort, no search. Every reviewer would notice. So I rewrote it.
>
> First — the count is now **truthful**. 'Showing 20 of 47, in the last 30 days'. Change the time window at the top — every count on this page moves together. One source of truth.
>
> Second — every row is two lines now. Status badge, score, caller phone, duration, time-ago on the first line. Top issue and use-action badge on the second. Day grouping headers: Today, Yesterday, Mon Jun 8. If I'm scanning for a Friday spike, I can see it.
>
> Third — sort, search, and filter chips at the top. I can sort by lowest score to see the worst calls first. I can filter to just the ones with unverified claims. I can search by caller number."

*(Click the ⚠ Unverified filter chip. The calls with red banners stay; everything else disappears.)*

> "And this is the part I'm proudest of from a design standpoint. The calls where the AI made up facts get visual treatment proportional to the risk — red border on the left, amber banner up top, plain-English label saying 'two unverified claims.' Hover the banner..."

*(Hover one of the banner rows. Tooltip shows the actual claim text.)*

> "...and you see the actual claim, verbatim. 'We're HIPAA-certified and SOC 2 audited.' That's not in this agent's script — the model made it up. I can triage 47 calls without opening any of them, because the highest-risk ones literally pop off the page."

*(Click into one of the flagged calls to show the structured detail card — 'what the agent said / why we flagged it / why it matters / what to do.')*

> "Inside the call, the structured card explains it in business terms. No AI jargon. 'Said we're HIPAA-certified — that's a regulated claim, not in script, brand and legal exposure. Add a guardrail in Information Gathering.' The product is doing the analysis the agency owner would do, if they had time."

---

### 3:00 — Recommendations + one-click apply (1 minute)

*(Back to the agent page → scroll to AI Insights, or click the Recommendations tab.)*

> "Cross-call patterns. The product clusters similar issues by failure mode. This card here says 'Skipped budget question' affects 17 of 48 calls — 35%. The recommended fix is a specific edit to the Information Gathering section of the prompt. I click Apply."

*(Click Apply. The diff modal opens.)*

> "This is the apply modal. It opens **focused on the one section being changed**, not the whole 5,000-character prompt. Old text on the left, new text on the right with the added words highlighted in green. The product parsed this agent's prompt into ten named sections automatically — Persona, Goals, Information Gathering, Script — and decided this fix belongs in Information Gathering. If I disagree, the 'Place this fix in' picker lets me re-target.
>
> Seven validators run live. Variables still resolve, length within tolerance, brand voice consistent, safety checks pass, section-fit and context-consistency green."

*(Click Apply AI suggestion.)*

> "Two seconds. The receipt shows every step. Snapshot the previous prompt — we keep it so rollback is a one-click revert. Patch the live HighLevel Voice AI agent over their API. Record a new prompt version with a SHA-256 hash. Link the recommendation to that version — that last step is what closes the measurement loop.
>
> Now if the next batch of calls regresses, I see it. If it improves, I see that too. Either way, I'm not guessing."

---

### 4:00 — The proof: Recently Applied (40 seconds)

*(Scroll up on the agent page to "Recently Applied — measurement proof".)*

> "Here's the part most observability tools don't do. When I apply a fix, the system watches the next set of calls under the new prompt version and **causally measures** whether the fix moved the score. Delta of at least two points, sample size of three or more — that's the bar for a 'significant improvement.'
>
> This row: 'Follow the Script Steps' — applied yesterday, four post-apply calls — **+20 points**. Significant green check. The fix actually worked.
>
> This row: 'Capture Caller Details' — applied earlier, one post-apply call so far — **−3 points**. Marked as regression. That's the system catching a mistake. I'd roll back that one.
>
> And these waiting rows — they're not stuck. They're literally waiting for new calls to land under the freshly-applied prompt. The system knows it's measuring rather than silently failing. As soon as a call comes in, it auto-triggers the comparison."

---

### 4:40 — Switch to live DB, brief close (20 seconds)

*(Open a second terminal alongside the browser.)*

```bash
bash .runtime/use-data.sh live
```

*(Refresh the dashboard tab — same URL, the tunnel doesn't change.)*

> "Same UI, but now this is connected to my real HighLevel sandbox. Nine real Voice AI agents, real call transcripts via OAuth, real KPI scoring. The Apply button on this page patches the live agent over HL's Voice AI API for real. The test DB and the live DB run through the same pipeline — the test DB just swaps in a local adapter so the apply flow works offline.
>
> Built solo. Node and Vue, SQLite for storage, OpenAI for analysis, embedded inside HighLevel as a Marketplace App custom page. The architecture doc, the data model, the API spec, and the implementation log are all in the repo. Thanks for watching."

*(End on a frame with the Recently Applied section visible — that's the strongest closing image.)*

---

## Why this script lands

A few choices worth flagging — these are deliberate.

| Choice | Reason |
|---|---|
| Cold open is the pain, not the product | Agency owners care about the pain in the first 15 seconds. UI tours bore reviewers. |
| The unverified-claim treatment gets ~45 seconds of airtime | It's the highest-stakes signal we surface and it's a strong visual moment. Reviewers remember the red banner with the actual claim quoted. |
| The Apply flow is the climax, not the opener | Demo arcs need a peak. Apply is the moment "observability tool" turns into "improvement tool" — that's the differentiation. |
| Measurement proof is shown last, not first | Without the loop closing, all the prior work is just a pretty dashboard. Saving it for the end makes it the takeaway. |
| Honest about the "waiting" state | The live DB has 4 waiting + 1 measured. Pretending otherwise breaks trust. Naming it out loud — "the system knows it's measuring rather than silently failing" — actually strengthens the narrative. |
| Live-DB switch happens at the end, not the start | Test DB has the cleanest measurement story; live DB proves the pipeline. Going test→live lets the reviewer build trust then verify it. |

---

## Timing reference

| Section | Length | Cumulative |
|---|---|---|
| Cold open | 0:30 | 0:30 |
| Dashboard pulse | 1:00 | 1:30 |
| Agent Detail + calls list + unverified claims | 1:30 | 3:00 |
| Recommendations + Apply | 1:00 | 4:00 |
| Recently Applied measurement proof | 0:40 | 4:40 |
| Live-DB switch + close | 0:20 | 5:00 |

Target 5:00 with ±30s headroom for natural pacing. Don't sprint — let the visuals settle.

---

## Mid-recording rescue commands

If something looks off mid-take, these are the only commands I run without stopping:

```bash
# Switch DB without restarting the tunnel (URL stays the same)
bash .runtime/use-data.sh test
bash .runtime/use-data.sh live

# If the page caches stale data, restart the server in place
bash .runtime/run-persistent.sh restart --db=test
```

If anything more invasive is needed (re-seed, OpenAI re-run, prompt-version backfill), I stop the recording and reset. Don't try to fix it on camera.

---

## Recording polish

A few things that quietly raise the production value:

- **Cursor moves deliberately.** No jitter. Pause half a second after each click so the UI fully settles before I speak again.
- **Receipt timeline gets silence.** When the apply receipt renders, let the steps animate. Don't talk over the visual climax.
- **No dev tools, no extensions visible.** Reviewers notice.
- **The tooltip on the unverified-claim banner needs to be readable on Loom playback.** Test it once at recording resolution before going live — Loom compresses small text.
- **No background noise**, no breath sounds. Normalize the audio after.
- **The first 15 seconds must hook on the pain, not the UI.** If I open with "let me show you the dashboard" the reviewer tunes out.

---

## Closing checklist before publishing

- [ ] Length between 4:00 and 5:30. Trim if over.
- [ ] No PAT, no API key, no personal phone number visible anywhere in the recording.
- [ ] Audio normalized.
- [ ] First-frame is the Overview page already loaded, not a blank tab.
- [ ] Last-frame is Recently Applied — the loop visible closing.
- [ ] Loom URL added to the README and the submission form.
- [ ] Cloudflared tunnel URL tested in an incognito window 5 minutes before sending.
- [ ] Brief note in the submission body: "Demo opens on test DB for the cleanest measurement story; live HL toggle at ~4:40 proves the same pipeline against real OAuth-pulled call data."

That's the demo. Honest, paced, and showing the actual product.
