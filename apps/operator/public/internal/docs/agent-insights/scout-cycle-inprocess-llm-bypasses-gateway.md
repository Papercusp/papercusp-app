# The Scout cycle's in-process ideators/critics bypass the inference gateway (same class as the gym's FB-16)
URL: /internal/docs/agent-insights/scout-cycle-inprocess-llm-bypasses-gateway

>-

## Symptom

The Scout loop looks like it's running but produces nothing. In
`harness_shared.scout_ticks` you see, over and over:

```
status=ran   ideas_generated=0   ideas_routed=0   budget_used_usd=0
detail = {"stop":"no-ideas","reason":"idle-capacity",...}
```

`stop:"no-ideas"` (not `empty-digest`) means the corpus digest was **non-empty**
— the cycle got past `digestIsEmpty(digest)` — but `ideate()` returned an empty
array. Combined with **`budget_used_usd = 0`**, that means the ideators ran but
**every ideator LLM call failed before charging** (the per-ideator `try/catch` in
`ideators.ts` isolates the throw, records `ok:false`, and the error never reaches
`scout_ticks`). Real-world incidence: the `@singleton` Scout produced 0 ideas
across **49/49** ran-ticks for \~4 days after the 2026-06-14 re-scope, $0 every
time, while the old `papercup`-scoped Scout had spent \~$2/cycle for 24 ideas.

## Root cause

Scout's ideator/critic/recombine calls are **in-process** `anthropic-direct`
`llmCall`s (`register-scout-action.ts` → `cycle-deps.ts` → `ideators.ts`). The
inference gateway is only wired onto **spawned subprocesses**: `operator-spawn.ts`
merges `gatewaySpawnEnv()` (`ANTHROPIC_BASE_URL=http://127.0.0.1:<gatewayPort>`)
at the spawn chokepoint, and cups egress through the gateway, which **strips** the
incoming `authorization`/`x-api-key` and **injects** `Authorization: Bearer <bound-account-token>` + `anthropic-beta: oauth-2025-04-20` (the gateway's
`CLAUDE_OAUTH_BETA`, `credential-store.ts`). That beta header is **mandatory** for a
Claude Max **subscription OAuth** token on a direct-API call. An in-process call
**never passes that chokepoint**, so Scout hits `api.anthropic.com` directly with the
subscription OAuth token (the operator has no `ANTHROPIC_API_KEY` — `llm-client.ts`
defaults to `~/.claude/.credentials.json`) but **without the oauth-beta** → Anthropic
rejects every ideator INSTANTLY with `403 permission_error: "OAuth authentication is
currently not allowed for this organization"` → `no-ideas`, `$0`, fast (no retries —
403 is non-transient).

This is **the same bug class** the gym hit (see
[gym-cycle-inprocess-llm-bypasses-gateway](/agent-insights/gym-cycle-inprocess-llm-bypasses-gateway),
FB-16) — a 401/403 OAuth/org error, identical mechanism: in-process anthropic-direct
egress bypassing the gateway's oauth-beta injection. Cups work because the gateway
adds the beta for them.

Why it's easy to misdiagnose: (1) the rate-governor buckets show opus with headroom
and several accounts available — those reflect the **gateway** pool, which Scout
isn't in. (2) The cycle SWALLOWS the per-ideator error (`ideators.ts` try/catch →
`info.error`, never persisted to `scout_ticks`), so all you see is `$0`/no-ideas —
which looks identical whether the cause is a 429 (rate) or a 403 (auth). To get the
real error, call `runIdeators(digest, {llmCall, maxIdeators})` standalone and inspect
`result.ideators[i].error` (an EARLIER pass here mis-read it as a 429 — it is a 403).

## Fix

Mirror the gym (`autoloop-cycle.ts`): when `FLAGS.INFERENCE_GATEWAY` is on, point
the in-process SDK at the localhost gateway before the cycle's LLM calls. In
`productionScoutRunner` (`register-scout-action.ts`):

```ts
const { FLAGS } = await import('@papercusp/flags');
const { getFlag } = await import('@papercusp/flags/server');
if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
  const { gatewayLlmEnv } = await import('../inference-gateway/spawn-env');
  for (const [k, v] of Object.entries(gatewayLlmEnv(true))) {
    if (!process.env[k]) process.env[k] = v; // respect a pre-set override
  }
}
```

Key detail: the in-process `anthropic-direct` transport
(`chat-stream.ts` `resolveAnthropicBaseUrl()`) reads **`PAPERCUSP_ANTHROPIC_URL`**,
NOT the standard `ANTHROPIC_BASE_URL` (which only the `claude` CLI honors).
`gatewayLlmEnv(true)` sets both, so subprocess + in-process egress both route
through the gateway.

## Caveat — the fix depends on the gateway's credential injection being healthy

Routing Scout through the gateway only helps if the gateway actually **strips the
org-blocked OAuth + reinjects Bearer + `oauth-2025-04-20` beta** for the in-process
SDK request. If the gateway is **degraded** — e.g. its account-pool load is failing
(`account-resolver.loadPoolOrThrow` fail-closed) or `:8788` is flapping — it can't
resolve a bound account to inject, so the original org-blocked token passes through
and you get the **same 403 even through the gateway** (observed 2026-06-18: a
standalone repro through `:8788` still 403'd during a pool-load flap, while the gym's
in-process egress was simultaneously down for the same reason). So a `403` *through*
the gateway points at the gateway's credential layer, not the Scout fix. Verify the
gateway is healthy (pool loaded, `:8788` stable) before concluding the routing fix
failed. If the gateway genuinely can't inject for the in-process path, the alternates
are: set a real `ANTHROPIC_API_KEY` (a direct-API key sidesteps the oauth-beta
requirement entirely), or egress ideators via the `claude -p` CLI path cups use.
