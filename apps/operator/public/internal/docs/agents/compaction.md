# Context compaction — surviving the window limit
URL: /internal/docs/agents/compaction

What happens when an agent session outgrows its context window — auto-compaction, the flush-before-summarize discipline, and the carry surfaces that make continuity lossless.

Every agent session has a finite context window. A long-running session
eventually **compacts**: the conversation so far is summarized, the summary
replaces the history, and the session continues with a fresh window. Done
naively this loses state — the summary is prose, prose drifts, and a live
multi-agent system's facts go stale the moment they're written. Papercusp's
answer is a discipline plus purpose-built carry surfaces.

## The two kinds of compaction

* **Deliberate** — the agent notices context filling (the \~80% rule) and
  requests compaction at a clean boundary, *after* flushing state.
* **Auto** — the runtime compacts mid-task because the window filled. The
  summary must then carry the unflushed detail verbatim and instruct the
  successor to park it properly on its first turn.

## Flush BEFORE you summarize

The core rule: **externalize state to re-injected surfaces, then let the
summary carry pointers, not copies.** The surfaces:

| State                        | Surface                                                | Re-injected when                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-flight work-item progress | `work_items:checkpoint { id, checkpoint }`             | The item's next invocation (yours or a successor's)                                                                                                                                                              |
| An armed loop's progress     | `loop:checkpoint { did, left, insight, next }`         | The next loop wake                                                                                                                                                                                               |
| Scoped standing conclusions  | `facts:assert { scope, scopeRef?, key, body, ttlSec }` | Every future orient/brief, verbatim, until retracted or its declared lifetime ends; ordinary facts must declare `ttlSec` or `permanent:true` (documented typed-slot, convention, and confidence-tier exceptions) |

Standing facts have no silent ordinary lifetime. For a bounded claim about current code
or state, pass `ttlSec`; use `permanent:true` only for cap-exempt standing rules.
`kind:'convention'`, typed safety slots (`slot:'wall'|'dead-end'|'guard-rail'`), and
`confidence:'provisional'|'suspected'` provide their documented lifetime semantics.
The writer refuses an ordinary fact that declares none. Retract a fact as soon as its
conclusion stops being true; a stale fact is worse than no fact because it is delivered
verbatim.
\| Fuzzy background knowledge | `memory:remember` | Semantic recall (`coord:orient` / `memory:search`) |

Checkpoints and facts live in Postgres (`harness_shared.carry_notes` — see
[checkpoints and facts](/internal/docs/coordination/checkpoints-and-facts)), so
they survive compaction *losslessly* while summary prose degrades.

## What the summary itself should be

An **index into live sources to re-verify**, not a state dump: the identity
block (session id, fleet, harness), session-mode flags, open commitments and
owner-gated walls verbatim, named artifacts (plan slugs, WI-/F- ids, files),
and the next concrete action — opening with an instruction to re-run
`coord:orient` and reconcile before trusting any liveness claim. The
per-machine compaction strategy is versioned at
`~/.papercusp/compaction-strategy.md` and injected into every session's
instructions.

## Enforcement

A compaction-compliance watchdog audits sessions that compacted without
flushing (see `packages/operator-core/lib/system-health/` — the
`compaction-compliance-watchdog` suite). The failure it exists to catch: a
session auto-compacts mid-task, the successor trusts a stale prose claim, and
work is silently redone or dropped.
