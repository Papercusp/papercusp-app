# OMP (pi) inference-gateway routing via a session models.yml
URL: /internal/docs/agent-insights/omp-gateway-routing-via-models-yml

How an OMP/pi agent is account-pinned + routed through the Papercusp inference gateway — a per-session models.yml that defines a dedicated `papercusp-gateway` provider (baseUrl → gateway, x-papercusp-account header). The OMP peer of codex's CODEX_HOME config.toml writer. Verified end-to-end on real omp.

import { Aside } from '@astrojs/starlight/components';

OMP (the `pi` / `@oh-my-pi/cli` backend) reaches Tier-1 parity with Claude and Codex for
**inference-gateway routing + account-pinning**. Plan: `omp-account-pinning-gateway-2026-06-29`.

## The mechanism (no new gateway protocol)

pi reads its model config from `<HOME>/.omp/agent/models.yml` (legacy `models.json`
auto-migrates). A per-provider entry supports `{ baseUrl, apiKey, api, auth, headers, models }`.
So routing an OMP session through the gateway is a **config write**, not a protocol — the
OMP peer of codex's per-session `CODEX_HOME/config.toml` `[model_providers.*]` writer.

`ompGatewayModelsConfig()` (`omp-models-config.ts`) emits a **dedicated `papercusp-gateway`
provider**:

```yaml
providers:
  papercusp-gateway:
    baseUrl: "http://127.0.0.1:8788"     # gateway root (anthropic) or /v1 (openai)
    apiKey: "papercusp-gateway"           # inert; the gateway strips+reinjects the account OAuth
    api: anthropic-messages               # or openai-responses for an OpenAI/codex account
    auth: apiKey
    headers:
      "x-papercusp-account": "<acct>"     # the account pin the gateway routes on
      "x-papercusp-owner": "<spawnId>"
    models:
      - id: "claude-sonnet-4-6"             # a VALID dated id — bare `claude-sonnet-4` 404s
        api: anthropic-messages
        # ...
```

…and the session selects `--model papercusp-gateway/<model>` (the helper returns this as
`modelSelector`). omp then POSTs `/v1/messages` to the gateway carrying the pin header, in the
exact wire shape the existing **anthropic** (or **openai-compatible**) gateway adapter expects —
reusing the shipped Claude/Codex gateway infrastructure. There is **no bespoke "omp" protocol**;
`provider-adapters.ts`'s `omp` row is a diagnostics view that delegates to the anthropic adapter
(the gateway dispatches by request *path*, never by a per-backend omp adapter).

pi's canonical-model equivalence resolves a built-in id like `claude-sonnet-4` to cloud
gateways (amazon-bedrock / cloudflare-ai-gateway) **before** a built-in-provider `baseUrl`
override applies. A unique provider id (`papercusp-gateway/...`) is selected deterministically.
Overriding `providers.anthropic.baseUrl` does **not** reliably capture the traffic.

## Two delivery paths

The `omp` CLI reads models config **user-level only** from `os.homedir()/.omp/agent` — there is
no `--models` flag and no agent-dir env var, so a session override must ride `HOME`.

* **Power-user connect (shipped):** `/api/agent-bundle` computes the models.yml
  (`resolveOmpGatewayModels`, gated on the gateway flag + a pool account + the capability matrix)
  and ships it in `omp_gateway_models`. The `@papercusp/omp` client (`connect.ts`
  `installOmpModelsConfig`) **temp-installs** it at `~/.omp/agent/models.yml` — backing up any
  existing `models.yml`/`models.json` and **restoring on exit** (incl. SIGINT/SIGTERM), so there
  is no permanent `~/.omp` edit — and selects `--model papercusp-gateway/<model>`.
* **Fleet / autonomous spawns (shipped):** `resolveSpawnGatewayEnv` (operator-core) emits the
  models.yml **bytes** + selector as env — `PAPERCUSP_OMP_MODELS_YML` + `PAPERCUSP_OMP_MODEL_SELECTOR`
  alongside `PAPERCUSP_ACCOUNT_ID` — so the canonical builder stays in operator-core (no orchestrator
  duplication; the orchestrator package can't import operator-core, and OMP has no `CODEX_HOME`
  equivalent — its only config-home lever is `HOME`). The orchestrator spawn path (`invoke.ts`) reads
  `process.env.PAPERCUSP_OMP_MODELS_YML` and, for an omp spawn, mints a per-spawn HOME via
  `writeSpawnOmpHome` (the peer of `writeSignedSpawnCodexHome`): a fresh `mkdtemp` HOME whose
  `.omp/agent` **symlinks** the source essentials (`auth.json`, `agent.db`, `config.yml`, `mcp.json`,
  `extensions/` — no credential copy) and **authors** the gateway `models.yml`, then sets
  `spawnEnv.HOME` to it (overriding `resolveSpawnHome`) and force-selects `--model
  papercusp-gateway/<model>` (it must win over any role/AGENT\_CMD `--model`, per the dedicated-provider
  gotcha above — stripped via `stripExplicitModelFlags`). Cleaned up on spawn close/error. Per-spawn
  HOME isolation is collision-free under concurrent pins and leaves no persistent `~/.omp` mutation;
  git identity comes from the injected `gitConfigNoPushEnv`, not HOME's `.gitconfig`, so a fresh HOME
  is fine for autonomous spawns.

## Account pinning

`accountProviderForInteractiveBackend('omp')` resolves to `'claude'` — an OMP session pins to a
**Claude/anthropic** pool account (the dominant case; OpenAI-account OMP is a later extension).
For omp, `resolveSpawnGatewayEnv` / the bootstrap-su resolver emit `PAPERCUSP_ACCOUNT_ID` **plus**
the per-session `PAPERCUSP_OMP_MODELS_YML` (the gateway provider config) + `PAPERCUSP_OMP_MODEL_SELECTOR`
— never the claude-CLI `ANTHROPIC_BASE_URL`/`ANTHROPIC_CUSTOM_HEADERS` env, which pi does not read.
The models.yml exposes the writer's **default** model per wire (`claude-sonnet-4` for a Claude
account); per-role model fidelity through the gateway is a tracked follow-up (the chokepoint that
builds the models.yml does not resolve the role's configured model, and the orchestrator can't
regenerate it — it can only pass the bytes through).

## The third surface: the `psu` interactive `omp-su` launch (global config)

The two delivery paths above both inject a **session-scoped** models.yml. The **`psu`
interactive `omp-su` launch** (`apps/operator/scripts/psu-launcher.mjs` → raw `omp --approval-mode yolo --append-system-prompt <playbook> -e <coord>`) does **neither** — it
runs against the **global `~/.omp/agent/`** config and the owner's own in-OMP model
selection. Per the owner steer (2026-06-29) this surface must **not** force a model; the fix
is to make the global config's providers *work*, not to inject routing. Two ways an
interactive OMP session reaches real Claude:

1. **Native / direct (claude-parity):** pi's built-in `anthropic` provider + the owner's own
   OMP login in `~/.omp/agent/auth.json` → `api.anthropic.com` directly — the same
   direct-subscription path claude uses (no shared pool). An expired stored token degrades
   silently to local ollama; an `omp` re-login restores it.
2. **Managed gateway:** a persistent `papercusp-gateway` provider in `~/.omp/agent/models.yml`
   carrying **`x-papercusp-priority: interactive`** and **no account pin** — so the gateway
   picks an available pool account and admits at **tier-1**, ahead of the cup fleet. Selected
   as `papercusp-gateway/claude-sonnet-4-6`. (When the fleet has saturated the whole pool,
   even a tier-1 interactive request gets a `rate_limit_error`; that is a transient pool
   condition, not a routing fault — the native/direct path or local ollama is the fallback.)

A box can carry a **stale** `providers.anthropic.baseUrl: http://127.0.0.1:3456` (header
`x-meridian-agent: pi`) pointing at a local LLM router that is **no longer running** (e.g.
host `:3458` reassigned to an unrelated container). Every Claude selection then silently
routes nowhere and OMP falls back to a local ollama model — and `ornith:fast` is **32k +
text-only**, so it overflows the SU tool/prompt context (\~33k) on the very first turn:
`request … exceeds the available context size (32768)` + `snapcompact needs a vision-capable
active model` + `Operation aborted`. Remove the dead override; the only live model egress is
local ollama + the inference gateway (`:8788`).

The gateway forwards the model id **verbatim** to `api.anthropic.com`, which rejects the bare
alias: `404 not_found_error — model: claude-sonnet-4`. Use the dated ids `claude-sonnet-4-6`,
`claude-opus-4-8` (or `-4-7`), `claude-haiku-4-5`. **`omp-models-config.ts` `DEFAULT_MODELS`
still ships the bare `claude-sonnet-4` / `gpt-5-codex` fallback** — any caller that does not
pass `opts.models` inherits an id that 404s against a real account (the shipped verification
used a local probe "model", so it never surfaced). Fix the default to a valid dated id.

### MCP discovery is inherited from Claude

OMP discovers MCP servers from `~/.claude.json` **and `~/.claude/plugins/installed_plugins.json`**
(a `ClaudePlugins` discovery helper) **and** the cwd `.mcp.json`. Two consequences for a `psu`
SU omp session:

* The `github` / `cloudflare:*` / `context7` **failures are shared Claude plugins** — `github`
  uses `Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}` (unset → "Authorization header is badly
  formatted"); the cloudflare-api/bindings/builds/observability servers need an un-done OAuth
  flow (→ `invalid_token`); only public `cloudflare-docs` connects. These fail **identically in
  claude** — **not** an OMP-specific gap.
* A **role-scoped** cwd `.mcp.json` (a signed role URL → a per-role MCP host on `:9071`) left
  behind by a prior role session in the launch dir **leaks into the SU session** and produces a
  30s `Connection to MCP server "papercusp" timed out`. An SU omp session needs only the
  user-level `papercusp-su` and should not load a role-scoped cwd `.mcp.json`.

## Gotcha (RESOLVED in omp 16.2.5): omp headless boot + `proxy-agent`

Headless `omp -p` on omp **15.5.13** crashed at boot with `Cannot find package 'proxy-agent'`
from `@puppeteer/browsers@2.13.2/.../httpUtil.js` — that version eagerly imported
`proxy-agent@^6.5.0`, which the install only hoisted nested under `pi-voice`. A symlink to the top
level was the temporary stopgap. **Resolved by the omp 16.2.5 upgrade (WI-934, verified live):**
`@puppeteer/browsers@3.0.5` no longer eagerly imports `proxy-agent` (it is now an OPTIONAL peer),
and `proxy-agent@8.0.1` is hoisted as a real top-level dep — so headless omp boots with no symlink.
Recurrence guard: `packages/operator-core/lib/omp-headless-boot.test.ts` boots `omp -p` against an
isolated empty HOME and fails if the crash signature regresses; it self-skips where `omp` is not on
PATH (CI has no omp binary — the regression only manifests on a dev/release box with the real
install, e.g. after a release node\_modules swap).

## Verification

The routing was **verified end-to-end on real omp 15.5.13** with a local probe "model" (no real
Claude account/quota, per the owner steer): the exact `ompGatewayModelsConfig` output drove omp to
`POST /v1/messages` carrying `x-papercusp-account`. Verified for **both** delivery paths — the
connect path (D-006) and the **fleet path from a home produced by the real `writeSpawnOmpHome` +
`ompGatewayModelsConfig`** (D-008), which additionally carries the `x-papercusp-priority` tier pin.
Unit coverage: `spawn-mcp.test.ts` (the `writeSpawnOmpHome` seeder — symlinks + authored models.yml

* cleanup), `resolve-spawn-gateway-env.test.ts` (the omp branch emits the models.yml + selector +
  tier pin), `omp-models-config.test.ts`, `provider-adapters.test.ts`, the `backend-parity-smoke-matrix`
  `gateway-account-pin` row, and the omp-plugin `omp-gateway-models-install` test (proves restore =
  no permanent `~/.omp` edit).

The full **real-quota** fleet smoke through the live gateway + pool (P-010) is deferred: it needs an
owner-authorized **isolated** pool account, because an unknown `x-papercusp-account` falls back to
the gateway's `active()` account — which would spend real quota against the owner's "local models
only" steer. The gateway's header-consumption + account-routing (the consumer side of the pin) is
independently covered by the operator-core gateway / account-routing test suite.
