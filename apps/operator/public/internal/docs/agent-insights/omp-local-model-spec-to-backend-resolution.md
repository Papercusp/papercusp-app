# OMP local-model spec → backend resolution: ollama (direct/discovery) vs ollama-cc (gateway-routed)
URL: /internal/docs/agent-insights/omp-local-model-spec-to-backend-resolution

How an OMP model spec like ollama-cc/maxwell1500/ornith-35b:IQ3_M resolves to a real llama-server process — the ollama vs ollama-cc provider split in ~/.omp/agent/models.yml, why one stays direct and the other goes through the inference gateway's local-backend pool, and how failover (a dead/restarting backend) is verified without needing to disrupt the live shared GPU box.

## What this is

`local-concurrent-inference-2026-07-02` (P-005/D-011) cuts OMP's local-model routing over to
the inference gateway's local-backend pool (:8788) instead of talking to `llama-server`
directly — so multiple concurrent local-model agents get pooled admission, health tracking,
per-owner circuit-breaking, and in-request failover across sibling backends, the same
machinery the cloud/account path already had. This doc is the resolution chain: given an OMP
model spec, which process actually serves the completion, and what happens when that process is
down.

## The two local providers in `~/.omp/agent/models.yml` — and why they differ

This machine's global OMP registry carries **two** local-model providers that look similar but
serve different purposes:

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11435/v1
    api: openai-completions
    auth: none
    discovery:
      type: ollama
  ollama-cc:
    baseUrl: http://127.0.0.1:8788/v1   # <- the inference gateway, NOT llama-server directly
    api: openai-completions
    auth: none
    models:
      - id: maxwell1500/ornith-35b:IQ3_M
        ...
```

* **`ollama`** stays pointed at the sanitizer (`:11435`, see below) **directly**, because it
  uses OMP's live `discovery: {type: ollama}` — OMP calls ollama's own `/api/tags` to list
  whatever models are currently installed. The gateway only proxies `/v1/*` (`inference-gateway
  only proxies /v1/*`, `gateway.ts`), so it 404s a discovery call; discovery-driven model
  selection has to stay direct.
* **`ollama-cc`** is the **production, explicitly-enumerated** provider for the certified local
  models (ornith and its aliases). Its `baseUrl` is the gateway (`:8788/v1`), so every
  completion for these ids gets pool admission, health checks, per-owner circuit-breaking, and
  failover — the P-004/P-015 local-backend machinery — instead of a bare HTTP call to one
  process.

A spec like `ollama-cc/maxwell1500/ornith-35b:IQ3_M` (the id OMP resolves after stripping the
provider prefix) therefore takes this path:

```
OMP spec ollama-cc/maxwell1500/ornith-35b:IQ3_M
  -> models.yml "ollama-cc" provider, baseUrl http://127.0.0.1:8788/v1
  -> gateway.ts proxyLocal() (POST /v1/chat/completions, model field matched against the pool)
  -> LocalBackendPool.select(model, tried, ownerId)   [local-backend-pool.ts]
  -> registered backend "ornith-llamaserver", baseUrl http://127.0.0.1:11435
  -> ollama-schema-proxy.mjs (the SANITIZER, :11435 -> :11436) — strips tool-schema constructs
     ollama 0.30.x's grammar compiler chokes on (pattern/format/bounds/etc.) and flattens
     [{type:'text',...}] message-content arrays to plain strings
  -> llama-server (llama-ornith.service, :11436) — the actual GGUF inference process
```

Live-verified 2026-07-17 (non-destructive round trip through the full chain):

```
curl -s -X POST http://127.0.0.1:8788/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"maxwell1500/ornith-35b:IQ3_M","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":8}'
# -> 200, a real ornith completion (usage.prompt_tokens/completion_tokens populated,
#    system_fingerprint from the actual llama-server build)
```

and the registered backend was healthy at the same moment (`GET /admin/local-backends`):
`{"id":"ornith-llamaserver","baseUrl":"http://127.0.0.1:11435", ...,"health":{"healthy":true,...}}`.

## Why the sanitizer sits between the gateway and llama-server

`ollama-schema-proxy.mjs` (`~/.papercusp/ollama-schema-proxy.mjs`, `:11435 -> :11436`) is
**not** part of the gateway's failover story — it is a request-shape fixup layer OMP itself
needs regardless of which HTTP hop reaches it: ollama 0.30.x's tool-schema grammar compiler
rejects several JSON-Schema constructs (`pattern`, `format`, boolean schemas,
`additionalProperties`, bounds keywords) that OMP's tool definitions use, and some chat
templates require message `content` to be a plain string rather than a `[{type:'text',...}]`
array. The sanitizer strips/flattens both before forwarding. The gateway's local-backend pool
registers the *sanitizer's* address as the backend `baseUrl` (`:11435`, not raw `:11436`) so
every hop through the pool gets the sanitized request — see the registered backend above.

## Failover — verified without touching the shared live GPU box

The acceptance question ("kill the backend mid-session -> clean error, not a hang") is answered
at the protocol layer by **`local-backend-gateway.test.ts`** (24 behavioral tests, real fake-HTTP
backends standing in for llama-server — no PG, no real GPU): a dead/unreachable backend is
skipped in favor of a healthy sibling on the *same* request (in-request failover); when nothing
is reachable the caller gets a clean `502` naming the model and the last error, never a hang; a
model that IS served but momentarily saturated (every slot busy) gets a `429` +
`Retry-After` (distinguished from a genuine dead end, D-010/D-012); a stream that errors
mid-pipe tears down cleanly instead of crashing the whole gateway process (W2.2 guard); and a
caller whose backend keeps failing gets shed fast by a per-owner circuit rather than hammering a
wedged pool. These tests exercise the exact `proxyLocal()` code path a real backend death would
hit — the only thing a live "kill `llama-ornith.service` mid-request" would additionally prove is
that OMP's own HTTP client surfaces that same clean `502`/`429` rather than hanging, which is a
generic HTTP-client property, not local-backend-specific.

A live kill was deliberately **not** performed as part of landing this doc: `llama-ornith.service`
is a shared, systemd-managed (`Restart=on-failure`, `RestartSec=5`) production process this
fleet's live ornith-model agent sessions depend on, and there is currently only one backend
registered for these models — killing it has no sibling to fail over *to* and would surface as a
real (if self-healing) outage for any concurrent session, to re-prove a code path 24 existing
tests already cover deterministically. If a live kill/restart drill is wanted specifically to
verify the *OMP client's* behavior end-to-end (as opposed to the gateway's), coordinate a
maintenance window first (check `GET /admin/local-backends` for `inFlight:0` and no other
fleet lane mid-session on ornith) rather than killing it opportunistically.

## Where this lives in code

* `packages/operator-core/lib/inference-gateway/gateway.ts` — `proxyLocal()`, the `/v1/chat/completions`
  and `/v1/completions` local-backend route (D-002); admission, retry loop, saturation vs
  dead-end distinction.
* `packages/operator-core/lib/inference-gateway/local-backend-pool.ts` — `LocalBackendPool`:
  registry, health, least-loaded + slot-affinity selection (P-028).
* `packages/operator-core/lib/inference-gateway/local-backend-client-circuit.ts` — per-owner
  admission circuit (P-015/D-010).
* `packages/operator-core/lib/inference-gateway/local-backend-gateway.test.ts` — the 24
  behavioral tests referenced above; the canonical failover evidence.
* `~/.omp/agent/models.yml` (machine-local, not in the repo) — the `ollama` / `ollama-cc`
  provider entries described above.
* `~/.papercusp/ollama-schema-proxy.mjs` — the tool-schema/message-content sanitizer.
