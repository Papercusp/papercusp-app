# Don't infer the fleet's inference plan from credential presence — check the wire
URL: /internal/docs/agent-insights/fleet-inference-auth

Agents repeatedly conclude "the fleet runs on the Claude Max subscription" from the presence of a `subscriptionType: max` OAuth in `~/.claude/.credentials.json`, without checking what the spawned `claude -p` cup actually presents on the wire. Credential presence ≠ the subscription serving the workload. Cost telemetry and 429s reinforce the wrong conclusion. Run `npm run check:fleet-auth` for the ground truth — and note the 2026-06-11 addendum: cups present `~/.papercusp/claude-token` (CLAUDE_CODE_OAUTH_TOKEN), NOT the global OAuth your probe uses; A/B both credentials before declaring auth healthy.

## The recurring mistake

When the fleet is rate-limited and someone asks "are we on the API or the Max plan?", agents
check `~/.claude/.credentials.json`, see a `claudeAiOauth` block with `subscriptionType: max`, and
conclude **"we're on Max, this is just a transient throttle."** This conclusion is reached over and
over, and it skips the one thing that actually answers the question: **what the spawned `claude -p`
process authenticates with on the wire, and whether that auth is the right one for a headless fleet.**

The presence of OAuth credentials does **not** prove the subscription is usefully serving the
workload. Two signals actively mislead:

1. **Cost telemetry looks like API billing.** claude-code reports a **non-zero `total_cost_usd`
   even on a subscription** — it's an *equivalent-cost estimate* (tokens × list price), not a bill.
   `harness_shared.agent_usage_samples` stores it with `cost_source: provider`. So agents see real
   dollar figures and conclude "API key." Wrong — the number is the same shape on both plans.
2. **It 429s, so it "looks like it's working, just busy."** A rate-limited cup is *authenticated*
   (429, not 401), so the auth obviously "works" — which gets read as "Max is fine, back off and
   retry." But on a consumer subscription driven headless at fleet concurrency, the throttle is the
   **structural** symptom, not a transient blip.

## The ground truth: check the wire, not the config

Run:

```bash
npm run check:fleet-auth        # scripts/check-fleet-auth.mjs
```

It runs one real `claude -p` call with `ANTHROPIC_LOG=debug` (the SDK's HTTP logging — **this**, not
the `--debug` flag, dumps the request) and classifies the **actual request auth**:

* **`x-api-key` header present** ⇒ an **API key** (pay-per-token, proper API rate-limit tiers).
* **`authorization: Bearer …` + `anthropic-beta: oauth-…`** ⇒ the **subscription OAuth**.

It also greps every spawn-relevant env (`process.env`, `.env.local`, the `papercup-{dev,staging}-api`
host process envs via `/proc`) for `ANTHROPIC_API_KEY` — the only thing that flips a `claude` spawn
off the OAuth path (claude precedence: `ANTHROPIC_API_KEY` env → `apiKeyHelper` → OAuth file).

## What was verified on this box (2026-06-08)

Every layer was traced, not inferred:

| Layer           | Finding                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Command         | `AGENT_CMD=claude` on both hosts → cups run raw `claude -p` (not omp/Meridian)                                                         |
| API key         | **None** anywhere — host envs, `.env.local`, shell, `~/.claude.json`, `settings.json`, no `apiKeyHelper`/`forceLoginMethod`            |
| Per-spawn creds | `writeSpawnClaudeConfig` (spawn-mcp.ts) **symlinks `~/.claude/.credentials.json`** (the Max OAuth) into each cup's `CLAUDE_CONFIG_DIR` |
| **Wire**        | request sends `authorization: Bearer …` + `anthropic-beta: oauth-2025-04-20` — **subscription OAuth, not `x-api-key`**                 |

So the fleet **does** authenticate with the Max OAuth. But that is the trap's other half:

## The part that matters — a consumer subscription is the wrong auth for a headless fleet

A consumer **Pro/Max** subscription is gated for **interactive, single-session** Claude Code.
Driving it **headless (`claude -p`) at fleet concurrency** (a pot of opus-xhigh agents + N cups
through one OAuth) gets throttled hard — `"Server is temporarily limiting requests (not your usage
limit)"`. The subscription is technically the auth, but the fleet is **not getting usable Max
throughput** from it. In the sense that matters, *the Max subscription is not actually serving the
fleet* — which is the real thing to discover, and the thing the "creds exist → Max → fine" shortcut
misses.

**The fix for a production fleet is a real `ANTHROPIC_API_KEY`** (or Bedrock / Vertex) with an
appropriate rate-limit tier — set it in the spawning host's env so `claude` picks it up
(`x-api-key`), and lean on the API's proper rate-limit headers instead of fighting a consumer
throttle. The fleet's AIMD concurrency back-off + the Apiary runner's rate-limit relaunch
(`cup-instance.ts`) mitigate the throttle but cannot fix an auth/workload mismatch.

## Addendum (2026-06-11) — there are TWO credentials; probe the one the workload presents

The 2026-06-08 table above is one layer stale: since the fleet-token staging landed, cups no longer
ride the symlinked global OAuth. `fleet-claude-token.ts` (orchestrator) reads
`~/.papercusp/claude-token` (a dedicated long-lived `claude setup-token`, staged so a psu `/login`
can't rotate it away) and `invoke.ts` exports it as `CLAUDE_CODE_OAUTH_TOKEN` for everything the
fleet spawns — and that env var **outranks the credentials file**. The box therefore carries TWO
independent Claude credentials with independent usage limits:

| Credential                                              | Who presents it                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `~/.claude/.credentials.json` (rotating OAuth family)   | interactive sessions, psu shells, bare `claude -p` probes, **`npm run check:fleet-auth` itself** |
| `~/.papercusp/claude-token` → `CLAUDE_CODE_OAUTH_TOKEN` | every fleet cup / invoke-once child                                                              |

**Failure signature when the FLEET token's Max session window is exhausted:** every cup dies in
\~8s (rc=0 *or* 1) with empty `output_tail`, no transcript, and no `[dbos-invoke]` log line on rc=0 —
while interactive sessions and bare probes work and the wire check passes. The cup's first turn
returned `You've hit your session limit · resets 7:30pm (America/New_York)` and the envelope was
swallowed (the WI-111/WI-108 observability gap).

The 30-second diagnostic — A/B the two credentials:

```bash
# global (what YOU and check:fleet-auth probe with)
echo "say OK" | env -u CLAUDE_CONFIG_DIR claude -p --model claude-haiku-4-5-20251001
# fleet (what every cup presents)
echo "say OK" | env -u CLAUDE_CONFIG_DIR CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.papercusp/claude-token)" \
  claude -p --model claude-haiku-4-5-20251001
```

`check:fleet-auth` has exactly this blind spot — it probes with its own env (the global credential),
so it can report healthy auth while every cup is dead. Until it grows a fleet-token probe, run the
A/B above whenever cups fail fast. (Live incident: 2026-06-11, WI-111 thread — cups 8s-dead all
afternoon while every probe and wire check passed. Related but separate: `cup:spawn model=` with a
raw model id reroutes via the model catalog to omp/amazon-bedrock and dies on a missing provider key
— pass tier names or aliases, never raw ids.)

## TL;DR for the next agent

* **Do not** answer "API vs subscription" from `~/.claude/.credentials.json`. Run `npm run check:fleet-auth`.
* A non-zero `total_cost_usd` does **not** mean API billing (it's an estimate even on a subscription).
* A 429 means *authenticated-but-throttled*, not "working fine."
* If the fleet is persistently rate-limited on subscription OAuth, that's a structural mismatch —
  recommend a real API key, don't just back off.
* The box has **TWO credentials**: cups present `~/.papercusp/claude-token`
  (`CLAUDE_CODE_OAUTH_TOKEN`), not the global `~/.claude` OAuth your probe uses — A/B both before
  declaring auth healthy. Cups dying in \~8s with empty output while probes pass = the fleet token's
  session limit, not the pipeline.
