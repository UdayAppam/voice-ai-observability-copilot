# V4 API Discovery — confirmed against HL sandbox 2026-06-07

Real probes against `https://services.leadconnectorhq.com` using PIT auth and our sandbox `locationId=omDv2HsBjkQE7wZJZ8io`.

## Endpoints used by V4

| Method | Path | Confirmed status | Notes |
|---|---|---|---|
| GET | `/voice-ai/agents?locationId=…` | **200** | List — returns 9 agents with full shape |
| GET | `/voice-ai/agents/:agentId?locationId=…` | **200** | Single agent — 22 top-level fields |
| **PATCH** | `/voice-ai/agents/:agentId?locationId=…` | **200** | **Partial body accepted** — `{agentPrompt: "..."}` alone works |

## Headers + auth

- `Authorization: Bearer <token>` — both PIT and OAuth tokens work
- `Version: 2023-02-21` — Voice AI API version
- `Content-Type: application/json` — for PATCH bodies

## Required scopes

Confirmed working on the PIT in the sandbox (`pit-b5ceff90...`):
- `voice-ai-agents.readonly` — GET
- `voice-ai-agents.write` — PATCH

## Agent shape (22 top-level fields)

```
id, locationId, agentName, businessName, welcomeMessage, agentPrompt,
voiceId, responsiveness, maxCallDuration, sendUserIdleReminders,
reminderAfterIdleTimeSeconds, inboundNumbers, callEndWorkflowIds,
sendPostCallNotificationTo, agentWorkingHours, timezone,
isAgentAsBackupDisabled, translation, toolCallStrictMode, actions, prompts
```

- `agentPrompt` — the editable prompt string (~5K chars on our sample)
- `prompts` — empty object `{}` on all 9 observed agents; ignorable for V4
- `actions[]` — function-calling tools `{id, actionType, name, actionParameters}`; V5 scope
- **No native versioning fields** — no `version`, `revision`, `updated`, `modified` → we snapshot for rollback

## PATCH behavior

- Partial body works: `PATCH /voice-ai/agents/:id` with just `{agentPrompt: "new text"}` → 200 OK
- Latency: ~900ms on observed calls
- Response: full agent shape (same as GET)
- **No native versioning** — PATCH overwrites in place. Rollback strategy: snapshot `previous_agent_prompt` to our `apply_attempts` table BEFORE issuing PATCH.

## Error responses observed

| HL status | When | Our handling |
|---|---|---|
| 401 with `"not authorized for this scope"` | Token missing required scope | `HLScopeError` — surface in UI with re-install guidance |
| 401 (token expired) | Access token past `expires_at` | Auto-refresh via OAuth refresh_token (one retry); fail with `HLAuthExpiredError` if refresh fails |
| 403 | Agent not in this location | Mapped to `HLNotFoundError` (semantically equivalent for our use case) |
| 404 | Endpoint or agent path doesn't exist | `HLNotFoundError` |
| 422 (untested) | Invalid PATCH body (e.g. bad template var) | Generic `HLApiError` with `body` containing HL's error message — surface in UI |
| 5xx (untested) | HL outage | Generic `HLApiError` — UI shows "Apply failed, fall back to manual paste" |

## What this unblocks

- **All V4 phases can proceed** — no architectural rewrite needed
- **PATCH-in-place is fine** — no draft/promote semantics to figure out
- **Snapshot-based rollback** is the right design (no native HL versioning to lean on)
- **Partial PATCH** keeps payloads small and surgical
- **PIT works for full V4 flow** — OAuth re-install can be deferred without blocking V4 build/test
