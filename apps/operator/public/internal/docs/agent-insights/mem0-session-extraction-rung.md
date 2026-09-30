# mem0 extraction rides the Claude session — and the OAuth cache must never live forever
URL: /internal/docs/agent-insights/mem0-session-extraction-rung

Fact extraction's cascade rung #1 is claude-haiku-4-5 on the anthropic-direct transport (Claude Code's own OAuth session) — no API key, $0 marginal. The gotcha that made memory stillborn once — an auth error silently swallowed into no-op writes — is structurally closed by the 401 → cache-invalidate → re-read → retry-once → LOUD sticky-demote protocol. Know the rungs before debugging a "memory writes nothing" report.

import { Aside } from '@astrojs/starlight/components';

## The path (mem0-extraction-via-claude-session-2026-06-06)

mem0's fact-extraction LLM (the model that distills `remember(raw)` into
facts and decides ADD/UPDATE/DELETE) resolves through a **three-rung
cascade** (`resolveExtractionLlmConfig`, `libs/generic/memory/src/mem0-client.ts`):

1. **claude-session** — `SessionExtractionLlm`
   (`packages/operator-core/lib/memory/session-extraction-llm.ts`):
   `claude-haiku-4-5` direct to api.anthropic.com, authenticated with Claude
   Code's own OAuth token (`~/.claude/.credentials.json` →
   `claudeAiOauth.accessToken`, header `anthropic-beta: oauth-2025-04-20`).
   Probe-validated at client build (models-endpoint GET — only an explicit
   401/403 disqualifies; network blips pass so an offline box keeps its
   extractor). Strict-JSON output with ONE repair retry, then a throw that
   the cascade serves from the next rung — mem0 never sees unparseable text.
2. **Anthropic API key** (probe-validated, `LLM_MODEL` Haiku).
3. **OpenAI `gpt-4o-mini`** (the understudy the whole fleet ran on while the
   Anthropic key was stale — and the extractor behind the scorecard's
   misleading 0/6 near-dup result; under Haiku it's 4/6, see
   `.papercusp/bench-reports/memory-dedup-haiku-2026-06-07T00-44-05-016Z.md`).

The session rung is injected through the host seam
(`MemoryHost.getExtractionLlm`, wired in
`packages/operator-core/lib/memory/configure.ts`) — `libs/generic/memory`
stays domain-free and only knows the mem0ai custom-LLM interface +
a generic `FallbackExtractionLlm` primary→fallback wrapper.

## The gotcha: a forever-cached OAuth token in a long-lived process

`resolveStatelessTransport()` caches the Claude token **per process**
(`_claudeTokenCache`). Fine for a short-lived CLI; in the long-lived
operator the claude CLI **rotates the credentials file under you**, and a
forever-cache eventually serves an expired token. The first time this class
of failure hit (a stale Anthropic *API key*, pre-session-rung), mem0
swallowed the 401s inside `Memory.add()` and returned `{results: []}` —
**every write a silent no-op for weeks** ("stillborn",
memory-backend-benchmark D-007).

The session rung closes the class structurally (D-004):

* On 401/403: invalidate the token cache → re-read
  `~/.claude/.credentials.json` → retry **once**.
* Still failing: throw `ExtractionAuthError` → `FallbackExtractionLlm`
  **sticky-demotes** the rung for the process lifetime (re-probed next
  boot) and serves the call from the key rungs — with a `warnOnce`
  (`[mem0-session]` / `[memory]` prefixes).
* No fallback available: the error **rethrows WITH the warning fired** —
  visible, never silent.

The loudness contract is pinned by tests: a dead token must yield
*successful writes via the next rung plus a fired warning*
(`session-extraction-llm.test.ts` in operator-core;
`extraction-llm.test.ts` in `libs/generic/memory`).

Check the rungs in order. `PAPERCUSP_MEM0_SESSION_EXTRACTION=0` disables
rung 1 entirely (escape hatch). A `[mem0-session] … auth-rejected by the
probe` warning means the session token is dead → key rungs. If you see
NO warning and no stored facts, suspect the embedder ('disabled' is a
hard stop for the whole client) — not extraction.

## Verifying it live

* **Round-trip probe** (isolated schema; exit 2 = skip without a session):
  `npx tsx packages/operator-core/lib/memory/session-extraction-live.ts` —
  also registered in the `/adv` Tests tab (Memory → Live). Proof-of-rung is the
  adapter's own usage counters (`sessionExtractionUsage()`), not just a
  stored row.
* **Telemetry**: every session-rung call lands a usage sample in
  `harness_shared.agent_usage_samples` (provider `anthropic`, class `haiku`)
  via the shared stateless usage sink — tokens are metered against the Max quota
  even though marginal cost is \~$0.
* A staging (`:3170`) `memory:remember` whose stored text comes back
  **rewritten** (not your verbatim input) is extraction working; verbatim
  echo means the write skipped extraction (`verbatim: true`) or the client
  fell back to a degraded path.

## Two test-side gotchas (from the Phase 1/2 build)

1. **mem0ai's `memory` vector-store provider is NOT in-process-only.** It
   persists to `~/.mem0/vector_store.db` (+ `vector_store_entities.db`) by
   default, so a "hermetic" test pollutes the homedir — and later runs
   **hash-dedup against the stale rows, silently returning `[]` on add**.
   Pass `dbPath: ':memory:'` in `vectorStore.config` (see the comment in
   `libs/generic/memory/src/extraction-llm.test.ts`).
2. **`getMemoryClient()` cannot run under vitest** — the bundler-dodging
   `new Function('return import(...)')` dynamicImport has no import
   callback in vitest's runner. That's why the loudness test composes
   `SessionExtractionLlm` + `FallbackExtractionLlm` + a real `Memory`
   manually, and why live verification is a **tsx runner**, not a vitest
   file (`mem0-client.test.ts` header documents it).
