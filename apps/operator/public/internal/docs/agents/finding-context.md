# Finding context
URL: /internal/docs/agents/finding-context

The retrieval surfaces every spawned agent has access to, and which to reach for when.

# Finding context

You have several ways to find context. This page tells you which to reach for, in what order.

`docs:*` (outline / get / search) is context-aware and resolves **three** sources, picked by your context — same tool, same shape:

* **In a harness** → your harness's docs.
* **No harness, but `PAPERCUSP_PROJECT_DOCS_ROOT` is set** (the project shell — e.g. the omp-su wrapper) → your project's docs. This branch wins over the engineering reference whenever the env var is present.
* **No harness and no project-docs root** → the Papercusp framework engineering reference, **but only for papercusp-su callers** (the audience of this page). A non-SU caller in this case gets a `no_docs_source` error rather than the engineering reference.

## Decision table

| Question                                                                 | Reach for                                                                                  | Notes                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "What's documented for what I'm working on?" (SPEC, plans, architecture) | `docs:outline` → `docs:get`                                                                | Outline is cached per run. Resolves your harness's docs, your project's docs (when `PAPERCUSP_PROJECT_DOCS_ROOT` is set), or the engineering reference. For long pages, refine with `docs:get { slugs: [slug], heading: 'anchor-id' }`.                   |
| Same question, but a keyword you have in mind                            | `docs:search`                                                                              | Use when the section name is non-obvious.                                                                                                                                                                                                                 |
| "What's the current state of this harness?"                              | `harness:status`, `harness:list_features`, `harness:pending_reviews`, `harness:escalation` | Runtime state — features, open reviews, escalations.                                                                                                                                                                                                      |
| "What's the history of this feature?"                                    | `features:history`                                                                         | Long-running feature state across turns.                                                                                                                                                                                                                  |
| "What did we decide about X in chat / escalation?"                       | Exact phrase or keyword → `search:fulltext`; paraphrased concept → `search:semantic`       | PG-stored prose recall over four surfaces — chats (turns), escalations, brainstorms, and decisions. `search:semantic` defaults to `mode=hybrid` (RRF fusion of BM25 + embeddings) and degrades gracefully to BM25 alone when embeddings aren't populated. |
| "What `[[name]]` references this thing?"                                 | `wiki:backlinks`                                                                           | Cross-references inside the harness.                                                                                                                                                                                                                      |
| "What tools are available to me?"                                        | `agent_tools:list`                                                                         | The catalog — describes every tool you can call.                                                                                                                                                                                                          |

## Order of operations

For any task that needs context:

1. **Your docs first.** `docs:outline` (cheap, cached). Pick a slug. `docs:get { slugs: [...] }`. For long pages, refine with `{ slugs: [slug], heading: 'anchor-id' }`.
2. **Keyword lookup if needed.** `docs:search` when you have a term but no slug.
3. **Runtime state.** `harness:status` / `harness:list_features`. Don't grep code for state PG owns.
4. **Prose recall last.** Use `search:fulltext` when you have an exact term or phrase. Use `search:semantic` when you are paraphrasing or searching by concept; its default `mode=hybrid` combines BM25 + embeddings via RRF and falls back to BM25 when embeddings are unavailable. Both tools cover all four prose surfaces by default — chats (turns), escalations, brainstorms, and decisions.

## Role-flavored starting points

* **Scoper** — `search:fulltext "scope"` + `docs:outline` (SPEC + prior plans).
* **Architect** — `docs:outline` (plans + design rationale).
* **Worker** — `docs:get` on the validation contract + the chunk's spec.
* **Validator** — `harness:status` (open issues) + the validation contract.
* **Debugger** — `search:fulltext "escalation"` + `features:history` on the failing feature.
* **Reviewer** — `docs:get` on the plan being reviewed + recent commits via shell.

## Anti-patterns

* **Don't read code before checking what's documented.** Most "how does this work?" has a doc page; find it before grepping.
* **Don't call `docs:get` without first calling `docs:outline`** (unless you already know the exact slug). Outline tells you what exists; without it, you guess.
* **Don't re-fetch the outline mid-run** — it's cached per run. Use what you already have.
* **Don't use `search:fulltext` for current state.** Use `harness:status` or `harness:list_features` instead — those are authoritative.
* **Don't trust a code comment as fact.** Verify it — see below.

## When you read code: trust what RUNS, not what the comments say

Code comments, doc-strings, and `## STATUS` / `## HISTORY` headers describe intent **when they were written** — they drift, and stale ones are common: a `// the single source of truth` on a function something newer has since superseded; a "this is the only caller" that's no longer true; a "deprecated" that's actually live, or live-looking code that's actually dead. Before you rely on ANY claim a comment makes, **verify it against the live call graph**:

* **Grep the call sites + imports.** "X is canonical / the only Y / deprecated / always / never" is a *hypothesis* — confirm it by where X is actually called and used, not by what its header says.
* **Tell live code from dead code.** A file or function can exist, read plausibly, and never run. Check it's reached (imported, wired, behind an *active* flag) before trusting it — `_archived/`, retired surfaces, and flag-off branches are traps.
* **Two things can both claim to be "the source of truth."** When a comment says so, check whether something newer superseded it (e.g. a runtime const that replaced an older filesystem walk, or vice-versa).

Trust what the code **does** (call sites, usage, the path that actually runs), not what a comment **says** it does. A comment is a lead to verify, never the verdict.

## Escalating

If the docs are wrong or missing, surface the gap via a supervisor note or by listing it as a finding in your next artifact. Don't silently work around — the next agent will hit the same wall. Existing issues are readable via `work_items:list` (issues are work-items of kind bug/change).
