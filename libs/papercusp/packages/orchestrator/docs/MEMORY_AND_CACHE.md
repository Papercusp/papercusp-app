# Memory layers + prompt cache discipline

How the harness composes context for an LLM invocation, what's cached
and what isn't, and the rules new sections must follow.

## The four memory channels

| Channel | Source | Read by | Lifetime |
|---|---|---|---|
| **Prompt-injected (composed)** | `prompt-build.ts` assembles substrate + role + override + memory + identity + feature-history sections | Always — every `invoke()` call | Per call |
| **MCP tool–callable** | `@papercusp/agent-mcp` (`features:*`, `messages:*`, `search:*`, `audit:*`, etc.) | Agent on demand via tool call | Per call (agent-driven) |
| **omp autoload** (project context, system prompt) | `AGENTS.md`, `.omp/SYSTEM.md`, etc. found by walking up cwd | Always — silently injected by omp | Until file changes |
| **omp autonomous memory** (`recall`/`reflect`) | omp's local or hindsight backend | Agent on demand | Per call (agent-driven) |

**Rules:**
- Prompt-injected is for what *every turn needs*.
- MCP-tool-callable is for what *the agent might need*.
- omp autoload is **disabled** for harness invokes (we own the prompt).
- omp autonomous memory backend is **off** for harness invokes — see
  `tools/hindsight/recall.ts` deprecation note. Don't add a new fuzzy
  retrieval channel without an explicit gap finding.

## Prompt assembly order (cache-optimized)

`prompt-build.ts` produces this order. **Any new section must respect
the lifetime category and append to the trailing volatile zone** — never
inject before the cacheable preamble.

```
1. Substrate context        ← per-iteration (~minutes-stable)
2. Role prompt file         ← per-mission (effectively static)
3. Per-role override        ← per-mission
4. Memory summary           ← per-iteration
5. Role identity            ← per-mission
6. Runtime context          ← per-call (extras, runId, cwd)
7. Feature history          ← per-call, per-feature      (added 2026-05-09)
   incl. Notes / Debugger findings / Recent activity / Related features
       / Messages from other features
   (Related features added Phase 2; Messages added Phase 3 — both 2026-05-09)
```

The first dynamic content invalidates everything after it under
prefix-based prompt caching. The runtime context (line 6) already
breaks the cache per call, so feature history (line 7) and future
trailing sections don't make things worse — they only add tokens
proportional to actual feature complexity.

To improve cache hits later, we have two options, both deferred:
- (a) Reorder to put `runtime context` last; substrate above it. Requires
  updating role prompts that reference "the substrate above."
- (b) Use Anthropic's `cache_control: ephemeral` breakpoint after the
  static preamble (lines 2–5). Requires plumbing through invoke.ts to
  the agent CLI flag set, and the agent backend must support it.

## Architectural principles for memory

These are non-negotiable for new code under this package and the
operator's harness API:

1. **PG canonical, no FS mirrors.** Persisted state lives in Postgres.
   Don't write a state file *and* a PG row to keep them in sync — pick
   one. Files are acceptable for: (a) markdown intentionally exposed
   to humans, (b) code/config that ships with the package. State
   tables are the rule.

2. **DB is not a transport.** If two processes need to communicate,
   use memory transport (HTTP, SSE, in-process call). Persist after
   for audit if needed. Never "write to PG, then poll for the row" as
   a substitute for a message channel.

3. **If a file is required, wrap PG.** When a downstream tool needs a
   filesystem path, write a function that materializes the file from
   PG on demand (or read PG into memory and pass content). Don't
   maintain a mirror that drifts.

## Compliant patterns (post 2026-05-09 refactor)

- `harness_feature_notes` (operator-notes): **PG canonical, FS on
  demand**. `appendOperatorNote()` writes PG only. The orchestrator's
  `feature-notes.ts:materializeFeatureNote()` reads PG and writes
  `<stateDir>/notes/<fid>.md` just-in-time before each
  worker/validator/debugger invocation.
- `harness_feature_debug_notes` (debugger findings): **PG canonical,
  FS on demand**. The debugger role still writes `<stateDir>/debug/<fid>.md`
  via its prompt (we can't redirect agent file writes), but
  immediately after the debugger invoke returns,
  `feature-debug-notes.ts:captureDebuggerOutput()` UPSERTs the file
  contents into PG. Subsequent worker/validator/debugger invocations
  call `materializeFeatureDebugNote()` to refresh the file from PG.
  The FS file is therefore always either freshly captured (just
  written by the agent and persisted to PG) or freshly materialized
  (sourced from PG) — never independently durable.

## Remaining violations (cleanup backlog)

(none in the orchestrator surface as of 2026-05-09 — all per-feature
state stores are PG canonical with FS-on-demand wrappers where needed.)

New code (`feature-history.ts`, `feature-notes.ts`,
`feature-debug-notes.ts`) reads PG-only — that's the discipline going
forward.

## Adding a new prompt section

1. Decide the lifetime category (per-mission / per-iteration / per-call
   / per-feature). Per-call and per-feature go in the trailing zone.
2. Add a `*Source` field to `BuildPromptInput` in `prompt-build.ts`.
3. Compute it in `invoke.ts` BEFORE the `buildPrompt` call (sync where
   possible, async where reading PG).
4. Update `prompt-budget` log line to include its char count.
5. Test snapshot the rendered output and the cap behavior.
