# The gym cycle's in-process judge/proposer bypass the inference gateway (FB-16)
URL: /internal/docs/agent-insights/gym-cycle-inprocess-llm-bypasses-gateway

>-

## The trap

The inference gateway (`papercusp-inference-gateway` flag) routes LLM egress
through a localhost pacing proxy (`127.0.0.1:8788`) that strips + reinjects the
bound pool account's auth — so even when the org has disabled Claude
*subscription* access (an OAuth 401), calls through the gateway succeed.

The catch: the gateway env (`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`) is
applied **at the spawn chokepoint** — `operator-spawn.ts` merges
`resolveSpawnGatewayEnv({ ownerId, account, role, model, … })` (the
backend-aware wrapper in `inference-gateway/spawn-env.ts` that resolves the
account/pin/priority and internally calls `gatewaySpawnEnv`) into each
**spawned cup's** environment. An **in-process** LLM call never passes through
that chokepoint, so it never receives the gateway env.

The gym cycle (`runOneAutoloopCycle`) has both kinds of LLM call:

* **Pipeline agents** run as spawned cups (the gym-operator's orchestrator
  spawns scoper→…→curator via `claude -p`) → they get `ANTHROPIC_BASE_URL` →
  they route through the gateway and work.
* **Judge + proposer** are *in-process* `llmCall`s (`ab-runner-real.ts` /
  `loop-deps.ts` `judgeCall` / `proposerCall` → the anthropic-direct SDK in
  `chat-stream.ts`) → they never touched the spawn chokepoint → they hit
  `api.anthropic.com` directly with the org-blocked OAuth → **`LlmCallError:
  401 authentication_error: Invalid authentication credentials`**.

This is why the live :3070 autoloop showed `gym-cycle:error` with 10
consecutive errors while the implement-lane workers (spawned cups) ran fine on
the same gateway: the cycle booted clean (EI-368 is contained), the pipeline
agents ran, then the judge 401'd "before completing" and the circuit opened.

Originally compounding it: `anthropicDirectTransport` (`chat-stream.ts`) read
`process.env.PAPERCUSP_ANTHROPIC_URL ?? 'https://api.anthropic.com'` — it honored
the papercusp-specific override but **not** the standard `ANTHROPIC_BASE_URL` that
the gateway sets for the CLI, so the two LLM legs keyed off different env vars.
**This is now fixed** — it reads
`PAPERCUSP_ANTHROPIC_URL ?? ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'`
(`chat-stream.ts` `resolveAnthropicBaseUrl`, currently around line 651), so an
in-process call picks up the gateway env even when only `ANTHROPIC_BASE_URL` is
set.

## The fix (2026-06-13, FB-16 of self-improvement-consume-edges)

A pure helper `gatewayLlmEnv(enabled)` (`inference-gateway/spawn-env.ts`)
returns BOTH `ANTHROPIC_BASE_URL` (CLI subprocesses) **and**
`PAPERCUSP_ANTHROPIC_URL` (the in-process anthropic-direct SDK) pointed at the
localhost gateway. `runOneAutoloopCycle` applies it (respecting any pre-set
override) when `getFlag(FLAGS.INFERENCE_GATEWAY, 'system')` is ON, so every gym
LLM call — spawned or in-process — egresses through the bound pool account.
Flag-OFF → unchanged (direct).

Proven 2026-06-13: a real `GYM_LOOP_MAX_CYCLES=1` cycle with the gateway env set
ran end-to-end — clean boot, judge scored the variant (composite 8 / 6.75),
`breakerTripped: false`, $0.56 spend, `GYM-LOOP: OK` — i.e. the exact judge step
that 401'd on the live host now completes through the gateway.

## Two gotchas for the next agent

* **`getFlag(FLAGS.INFERENCE_GATEWAY)` resolves `false` in a standalone CLI/tsx
  context** (it falls back to `FLAG_DEFAULTS`, where the flag is OFF), even
  though the PG override / MCP `flags:get` reports it ON. The flag resolves ON
  only inside a full operator process (PostHog + PG override). So a manual
  `gym-loop-run.ts` proof must set the gateway env explicitly; the flag-gated
  auto-apply fires on the live `:3070` operator.
* **The broader latent gap (now closed at the shared transport)**: the
  `anthropicDirectTransport` fallback to `ANTHROPIC_BASE_URL` is implemented
  (`chat-stream.ts` `resolveAnthropicBaseUrl`), so any in-process anthropic-direct consumer that routes
  through it (e.g. the `su` llm-test target) now picks up the gateway env. A consumer that
  resolves its own URL without going through `anthropicDirectTransport` still needs the same
  `?? ANTHROPIC_BASE_URL` fallback applied locally.
