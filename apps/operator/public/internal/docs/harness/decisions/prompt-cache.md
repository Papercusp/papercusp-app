# Why prompt-cache-dominant
URL: /internal/docs/harness/decisions/prompt-cache

The harness is designed so the Anthropic prompt cache absorbs the cost of fresh-context-per-role — prefix stability is an explicit, tested property of the prompt assembler.

The harness spawns a [fresh agent process per role
invocation](/internal/docs/harness/decisions/fresh-contexts). That is only
affordable because the prompt assembler is designed for Anthropic's prompt
cache: keep the expensive prefix byte-stable across spawns, and only a small
volatile tail is fresh-billed.

## The design, in the current code

`buildPromptParts` (`libs/papercusp/packages/orchestrator/src/prompt-build.ts`)
assembles every pipeline spawn's prompt as two halves — the file's header
documents this as the explicit "cache discipline":

* **Cacheable preamble** — byte-stable across spawns of the same role, ordered
  by *descending stability* so a change invalidates the smallest possible
  suffix: the role's prompt file → per-role config override → tools playbook +
  shared guides → MCP-tool-access recipe → shared-base constants → per-role
  identity (`identity/<role>.md`, cross-mission, append-oriented) → curated
  memory (`memory/summary.md`) last, because it changes most often. The
  **MCP-tool-access recipe** (section 2d, after the shared guides and before
  the shared-base constants) is static text too: it teaches the deferred-tools
  `ToolSearch` contract and the sanctioned `mcp-call.mjs` curl-fallback, so a
  spawned backend that defers or drops its MCP tools reloads them rather than
  improvising raw curl or going silent. The **shared-base constants** are a
  growing set of exported strings in `prompt-build.ts` — memory discipline, the
  friction trip-wire and observation-rubric nudge, the yield policy, the
  account-routing/concurrency-first/deploy-pipeline notes, the reuse-first
  nudge, the testing/verification standard, and an optional per-pot vocabulary
  block — several gated by role (the curator skips memory discipline, friction,
  the observation-rubric nudge, and curated memory).
* **Volatile tail** — per-spawn content (live substrate context, runtime
  context, the Mug/Overwatch wake-briefs, the spawn/wake handoff hydration
  block, brief, plan context, feature history) appended *after* the preamble so
  it never invalidates it. The Mug and Overwatch wake-briefs ride the tail as
  `<system-reminder>` blocks (each wake changes them), the handoff hydration
  block rides the tail too, and remote-authored content (plan context /
  feature history when `featureOrigin === 'remote'`) is wrapped in
  `<untrusted-peer-content>` delimiters — all reinforcing that the tail never
  invalidates the preamble.

The split is exposed precisely so tests can assert the preamble is
byte-identical across volatile-input changes (the prefix-hash assertion in
`prompt-build.ts`'s test suite). Prefix stability is a **tested invariant**,
not a hope. The newer per-pot knobs are tuned to preserve it: `acceptanceKind`
and `lexicon` both *default* to emitting the coding-default text (the
`tests`/undefined acceptance kind picks the testing standard; an absent or empty
lexicon emits no vocabulary block) precisely so the coding fleet's cached prefix
stays byte-identical — a generic pot opts into the divergent text, the coding
fleet never moves.

Cache behavior is also observable: every sampled spawn records
`cache_read_tokens` and `cache_creation_tokens` alongside input/output tokens
and cost to Postgres (`usage-sample-pg.ts`), so a cache-hit-rate regression is
a queryable signal. Samples also carry `session_id`, `plan_id`, and
`tool_name`, so the analysis goes beyond per-spawn hit-rate: grouping by
`session_id` makes a warm-inject/resume cup's **carry-cost** — `cache_read`
growth across successive tasks within one native session — queryable, while
`plan_id`/`tool_name` give per-plan and per-tool cache attribution.

## What the bash era measured

The numbers that motivated this design (measured on the first-generation bash
harness, 5-iteration mission, 13 role invocations):

| Metric             | Value                                                |
| ------------------ | ---------------------------------------------------- |
| Cache read tokens  | 180,049,624                                          |
| Fresh input tokens | 106,471                                              |
| **Cache hit rate** | **99.94%**                                           |
| Output tokens      | 24,533                                               |
| Total cost         | \~$0.31 (vs \~$3.10 if everything were fresh-billed) |

A non-cached harness cost \~10× more. The cache hit rate was treated as a
primary observability signal — a sudden drop means *something is rewriting
state the design expects to be stable*.

## How to keep the hit rate near 100%

The levers are the same today as in the bash era, mapped to current surfaces:

1. **Stable role prompts.** Don't edit a role's prompt file mid-mission; each
   edit costs one cache-miss spawn per role. Role prompts resolve from the
   blueprint extends-chain — `blueprints/<blueprintId>/prompts/<role>.md`, then
   each ancestor, then `blueprints/base/prompts/<role>.md` (the universal role
   library, always consulted) — under
   `libs/papercusp/packages/harness/`. There is **no** legacy global
   `prompts/<role>.md` tier (it was deleted in Phase 5 of blueprint-role-bundling,
   D-012 option A). Concretely, the spine roles (scoper, reviewer, curator, …)
   resolve from `blueprints/base/prompts/`, and the coding POT roles
   (mug/cup/operator/overwatch) from `blueprints/coding/prompts/`.
2. **Append-oriented identity files.** The curator appends to
   `identity/<role>.md` rather than rewriting (its persona instructs exactly
   this), so each change shifts the cache key minimally.
3. **Bounded curated memory.** `memory/summary.md` is hard-capped (40 lines /
   \~800 tokens, enforced by the curator persona) and sits **last** in the
   preamble — a curator pass costs one miss, then subsequent spawns hit again.
4. **Volatile content at the end.** Anything per-spawn rides the tail, never
   the preamble.

What still breaks the cache: editing prompt sources mid-run, rewriting (vs
appending) identity/summary files, or switching model mid-mission (the cache
is keyed on model).

## Where this stands today

The discipline was re-audited and re-asserted in the DBOS era
(`token-usage-reduction-audit-2026-06-09` P-009 — the header of
`prompt-build.ts` cites it): the preamble/tail split, the stability ordering,
and the prefix-hash test all live in the current assembler. The same instinct
applies beyond spawn prompts — e.g. long-lived interactive sessions schedule
their idle wake-ups around the cache TTL — but the load-bearing, tested
implementation is the pipeline prompt assembler above.
