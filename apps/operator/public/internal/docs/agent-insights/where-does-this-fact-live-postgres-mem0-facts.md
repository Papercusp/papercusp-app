# Where does this fact live? Postgres vs mem0 vs facts
URL: /internal/docs/agent-insights/where-does-this-fact-live-postgres-mem0-facts

The deciding principle for routing durable state between Postgres, mem0 and facts:assert: what does a MISS mean? Postgres absence is an answer you can branch on; mem0 absence is noise. Includes an ordered gate, the three-store retrieval-model split, and the failure modes in each direction.

## The principle: what does a *miss* mean?

One question decides it. Everything else is a corollary.

* **Postgres:** a miss is an **answer**. Zero rows is authoritative absence — you can branch on it.
* **mem0:** a miss is **noise**. No hits means the embedding didn't match, or you phrased it differently, or it is sitting at rank 11. You can never conclude absence from it.

> **If anything needs to distinguish "not there" from "not retrieved," it cannot live in mem0.**

That is a capability boundary, not a style preference. mem0 is a *ranker*, not a *set*.

This is the same false-zero family the repo warns about everywhere else — a `head`-truncated grep, `pgrep -q`, a wrong-relation SQL query returning zero rows, a `find` that skipped a symlinked sibling checkout. mem0 is a permanent false-zero machine **by design**. That is not a defect; it is what makes fuzzy associative recall work. It just means absence is never information.

## The ordered gate — first YES wins Postgres

These are not four coequal tests. Ask them in order and stop at the first yes.

### 1. If this becomes wrong, must the correction be *reliable*?

This decides most real cases, and the reason is subtler than "mem0 can't be corrected." It can.

**What mem0 actually supports here.** `memory:update` edits a memory's content and/or metadata **in place, preserving its id and lifecycle**; `memory:forget` removes one. So a stored memory is genuinely amendable — do not repeat the folk claim that mem0 is append-only.

**The catch is how you reach one.** `memory:update` takes an **id**, and the documented route to an id is `memory:search` — the same ranked retrieval whose misses are uninterpretable. There is no update-by-key and no reliable enumeration. So:

> **Your ability to correct a mem0 memory is bounded by your ability to retrieve it.** A stale memory you cannot surface is one you cannot fix — and you will not know it is there.

Postgres has no such coupling: `UPDATE … WHERE key = ?` applies or does not, and the rowcount tells you which. That difference — *verifiable* correction versus *best-effort* correction — is the real line.

So the question is not "can it change?" but **"if this goes wrong, does someone need a guarantee it got fixed everywhere?"** Yes → Postgres.

This is also why `facts:assert` forces you to declare a lifetime — a claim about current code or state takes a finite `ttlSec`, a standing decision takes `kind:'convention'`. Expiry is correction you do not have to remember to perform.

### 2. Does code branch on it?

If an `if` depends on the value, it is a row. Branching on a mem0 hit makes behavior depend on embedding similarity — nondeterministic, untestable, and it fails **open** in a way nobody notices.

mem0's consumer should always be **a mind forming judgment**, never a conditional.

### 3. Does anything reference it by ID, join to it, count it, or enforce on it?

Foreign keys, aggregates, `WHERE status='open'`, uniqueness, a gate. mem0 has no relational structure and no transactions. If you would ever want it in a `WHERE` clause, it is a row.

### 4. Does someone need to be able to *cite* it back at you?

A ruling nobody can re-read at a stable address is not a ruling. This is the whole reason a cross-lane decision is `plans:add-decision` and not a coord message: a message is not addressable after delivery, so a peer who received a wrong paraphrase has no way back to the source.

## The positive case for mem0

Without this section the answer collapses to "always Postgres," which is wrong.

**mem0 answers questions you didn't know to ask.** A table requires you to already know the predicate. mem0 surfaces something at a moment you were not querying for it at all.

So the right content is precisely what you would never think to look up: traps, conventions, preferences, hard-won gotchas, "here is how to think about X." Its value is associative, and its failure mode — not surfacing — costs a rediscovery, not a correctness bug.

### The one-line test

> **If this silently returns nothing, is something *wrong*, or just *slower*?**
>
> Wrong → Postgres. Slower → mem0.

## There are three stores, not two

`facts:assert` sits between them, and conflating it with mem0 is a common error. A fact is **injected verbatim** into every orientation rather than retrieved — so it costs context budget on every single turn and is rationed accordingly.

Use a fact when all three hold: the claim must be in context *without anyone querying for it*; it changes what you do on the very next turn; and you can state its lifetime.

The clean way to hold the distinction is by **retrieval model**:

| store        | retrieval model          | absence means              | correction                         |
| ------------ | ------------------------ | -------------------------- | ---------------------------------- |
| **Postgres** | you ask                  | not there                  | by key, verifiable                 |
| **mem0**     | you might get reminded   | nothing — uninterpretable  | by id, only if you can retrieve it |
| **facts**    | you are told, every time | never asserted, or expired | retract, or let the TTL do it      |

## Worked examples

| Thing                                             | Store                           | Why                                                                                           |
| ------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `WI-1234` is done                                 | Postgres                        | counted, assigned, joined, has a lifecycle                                                    |
| A cross-lane ruling (D-007 etc.)                  | plan Decision (PG)              | other lanes must follow it; must be citable **and** supersedable                              |
| "migration 727 is the latest"                     | Postgres (`schema_migrations`)  | rots instantly; a mem0 copy you cannot recall is one you cannot fix                           |
| "the gate is red"                                 | **neither** — `state:read` cell | a live value; not durable at all                                                              |
| A tool's `cwd` trap that breaks resolution        | mem0                            | a trap whose value is surfacing to someone who did not know to ask                            |
| "prefers breaking changes over back-compat shims" | mem0                            | a standing disposition, not a predicate anything queries                                      |
| "coord:send clips bodies past \~600 chars"        | mem0                            | pure gotcha; a miss costs one rediscovery, not a wrong answer                                 |
| "this session is in AUTO mode"                    | Postgres (mode registry)        | authority is *computed* from it — a miss would silently widen or narrow what the agent may do |
| A real owner gate blocking a ship                 | `facts:assert` + TTL            | must be in context unasked, changes the next turn, has a stated lifetime                      |

## Who decides — and when

**The writer, at write time.** Not a curator later, and not the reader.

That follows from gate 1. A curator *is* possible for mem0 — `memory:search → memory:update` is exactly that workflow, and it is the right tool for metadata hygiene. But a curator can only fix what it can retrieve, so curation is best-effort by construction and cannot be relied on as the safety net for a routing mistake.

The person holding the fact when it forms is the one with the most context about its lifetime, and the only one guaranteed to be looking at it. Route it then.

## Failure modes, both directions

**Putting a Postgres-shaped fact in mem0** — the expensive one. It looks fine for weeks. Then the fact goes stale. Note the specific trap: the natural correction is to `memory:remember` the new value, which creates a **second memory competing with the first at retrieval**; actually superseding it requires `memory:search → memory:update` on the original id, which is the path almost nobody reaches for. Worse, an agent concludes *absence* from a non-hit and branches on it.

**Putting a mem0-shaped fact in Postgres** — mostly harmless, occasionally wasteful. The cost is that nobody ever retrieves it, because retrieving it requires already knowing the predicate. A gotcha filed as a row is a gotcha nobody reads. If you find yourself inventing a table to hold "things agents should know," that is this error.

**Putting either in `facts:assert`** — spends everyone's context budget on every turn, forever, for a claim most turns do not need. Facts are the rationed tier; treat an unbounded-lifetime fact as a bug.

## Provenance and limits of this doc

* **Corrected on first publication.** The initial revision asserted that mem0 exposes "no supersede-by-key verb" and that a misplacement there is therefore permanent. That was **wrong** — `memory:update` preserves the id and `memory:forget` removes — and it was written from recalled tool knowledge without reading `agent-tools/memory/update.ts`. The corrected argument is narrower and survives: correction is real but *retrieval-bounded*. Recorded here rather than silently edited, because the original framing is the intuitive one and will be re-derived.
* Claims about mem0's *internal* consolidation behavior are `[inferred]` and deliberately not relied on; the argument holds either way, because the point is what the caller can verify.
* Originated from an owner question on 2026-09-22 ("what is the right principle deciding if something should go in a durable Postgres store vs mem0?"), written up at the owner's direction. Tracked as `WI-10002420`.
* Related but answering a *different* question — whether to introduce a graph store at all: `docs/reports/postgresql-mem0-graph-follow-up-2026-09-14`.
