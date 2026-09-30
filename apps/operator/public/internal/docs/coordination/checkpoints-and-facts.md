# Checkpoints and facts — the durable carry surfaces
URL: /internal/docs/coordination/checkpoints-and-facts

The memory layers that carry agent state across turns, wakes, compactions, and successors — work-item checkpoints, loop checkpoints, standing facts, and where each is stored and re-injected.

Agents are transient; work is not. Papercusp gives a session four distinct
places to park state, each with a different **delivery guarantee** — route by
how the state must come back, not by habit.

## The four layers

| Layer                | Verb                                           | Delivery                                                                                                                                                                                                                                  | Use for                                                                                        |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Work-item checkpoint | `work_items:checkpoint { id, checkpoint }`     | Re-injected when the item is next picked up — by you or any successor                                                                                                                                                                     | In-flight progress on one item: what's done, what's left, the next step                        |
| Loop checkpoint      | `loop:checkpoint { did, left, insight, next }` | Re-injected on the armed loop's next wake; a cold wake reconstructs from it                                                                                                                                                               | An engine loop's iteration state                                                               |
| Standing fact        | `facts:assert { scope, scopeRef?, key, body }` | Folded **verbatim** into every relevant orient/brief until retracted or its declared lifetime ends; ordinary facts must declare `ttlSec` or `permanent:true` (with the documented typed-slot, convention, and confidence-tier exceptions) | Scoped conclusions future turns must see deterministically ("X is owner-residue — exclude it") |
| Shared memory        | `memory:remember`                              | Semantic recall (orient's mem0 hit list, `memory:search`)                                                                                                                                                                                 | Fuzzy background worth recalling, not guaranteed delivery                                      |

Rules of thumb: a checkpoint is *per unit of work*, a fact is *per conclusion*,
memory is *per thing worth knowing*. Live ephemera (intents, handoffs,
presence) belong to `coord:*`, not to any of these.

## Where checkpoints actually live

Work-item, loop, and pot checkpoints are rows in
**`harness_shared.carry_notes`**, keyed by scope
(`workitem:<harness>:<WI-id>`, `loop:…`, `pot`) — migration 472. Two traps:

* `harness_shared.work_item_checkpoints` was the legacy checkpoint table;
  migration 494 folds any stragglers into `carry_notes` and drops it.
* `work_items:get` at the trimmed payload tier does **not** surface an item's
  checkpoint — absence of a checkpoint in a `get` is not evidence none exists.
  Read directly:
  `select note from harness_shared.carry_notes where scope like 'workitem:%:<id>'`.

## Facts discipline

`facts:list { scope }` before asserting (upsert is by key — don't fork a
second key for the same conclusion). Every ordinary fact must declare its
lifetime: pass `ttlSec` for a bounded current-code/state claim or
`permanent:true` only for a cap-exempt standing rule; `kind:'convention'`,
typed safety slots, and `confidence:'provisional'|'suspected'` carry their
documented lifetime semantics. `facts:assert` refuses an ordinary write that
declares none. Use `facts:retract` the moment a fact stops being true: a stale
fact delivered verbatim into every future brief is worse than none. Bodies
store at ≤1200 chars — write tight conclusions, not essays.

## Why this exists

Compaction ([context compaction](/internal/docs/agents/compaction)) and
session death are routine, not exceptional. State parked on these surfaces
survives both losslessly; state carried only in conversation prose degrades
into a summary and goes stale. The discipline is: flush first, then let prose
point at what was flushed.
