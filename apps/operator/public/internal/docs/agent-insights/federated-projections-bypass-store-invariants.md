# Auditing a federated table: migrations that MIRROR a working federation don't mirror its code — the writer, the invariants, and the op semantics all stay unimplemented
URL: /internal/docs/agent-insights/federated-projections-bypass-store-invariants

Four bugs, one root cause: a capture trigger was copied onto a table whose ROUTING KEY nothing writes — or that doesn't even have the column. Three were release-blocking p2p memory bugs (memory_canonical mirrored agent_facts' MIGRATIONS, none of its CODE); the fourth made two tables unwritable in the git-export lane. Depending on the destination column's nullability the same defect either strands silently or aborts the caller's write. How to find it.

## The pattern

`memory_canonical`'s federation was built by **mirroring `agent_facts`** — migrations 562/563/564 each say so in their header ("mirrors mig 461", "mirrors the agent\_facts capture triggers"). The *schema* was faithfully copied. **None of the code was.** `agent_facts` federates because `assertFact` stamps the routing key, refuses an unroutable share, and its store maintains the table's side state. Memory got the columns and the triggers, and nothing that fills or honours them.

Three bugs, one table (`harness_shared.memory_canonical`), three days, all release-blocking for p2p — send side, receive side, and op semantics:

|                                | Promised                                                                                                | What the code actually did                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **EI-10432** (the writer)      | mig 564: `harness_slug` = *"the Hive home slug (**federation identity carrier**)"*                      | **Nothing ever wrote it.** The table's only local writer is mem0's `CanonicalVectorStore.insert`, which inserts `(id, payload, created_at, updated_at)` — the federation columns are invisible to it. So a `shareable: true` memory was captured into the outbox under a **NULL** slug; the drain selects `WHERE harness_slug = $slug`, which NULL never matches; the op was stranded and later reaped by the backstop GC. It federated to **nobody** and errored **nowhere**. |
| **EI-10393** (op semantics)    | mig 563's comment: *"flipping shareable off captures once (peers apply **the retraction of sharing**)"* | Upserted every well-formed put. Un-sharing a memory kept its **full content** on every peer; a hostile peer could push never-shareable rows and we stored them.                                                                                                                                                                                                                                                                                                                |
| **EI-10405** (store invariant) | EI-9308's design: *"federate the memory TEXT … and **let each peer re-embed locally**"*                 | Wrote `memory_canonical` only. `memory_vec_*` rows are written **exclusively** by `CanonicalVectorStore.insert` — which the projection bypasses. A federated memory therefore had **no vector in any mode**, and recall's primary path JOINs the vec table, so it could never be returned.                                                                                                                                                                                     |

Note the symmetry that makes this class so durable: **each bug alone is sufficient to make the feature do nothing, so fixing any one of them changes no observable behaviour.** Nothing gets better until all three are fixed — which is exactly why none of them produced a bug report, and why "it worked in a test" kept being true.

Two of the three are *silent-success* shapes, the nastiest kind:

* **EI-10405**: the row *looks* fine everywhere a human checks — listed on the settings page, exported, `get(id)`-able — and the plan's own live-witness item (P-009: "verify it federates + projects as `origin=remote`") would have **passed green** while recall stayed broken. It surfaced only through the embed-free *lexical fallback*, which runs when the embedder is **down**: the feature "worked" precisely when the system was degraded.
* **EI-10432**: `memory:remember { shareable: true }` returned **ok**. The memory was stored, the `shareable` column was `true`, the capture trigger fired. Every local signal said success. The op simply never left the machine.

`agent_facts` avoids EI-10432 explicitly, and its own comment names the hazard — which is the tell that the pattern was *known* and just never carried across:

> "the capture triggers fire but route nowhere, so the fact is captured then stranded (dropped on every peer). **Refuse LOUDLY rather than silently strand**"

## Why the existing guards don't catch it

There is a `federated-column-completeness` guard (EI-9430 lineage): every column must be carried, PROVENANCE-stamped, or reasoned NOT\_FEDERATED. It is a guard on whether a column is **carried on the wire**. None of these three bugs is about that:

* **nobody-writes-it** has no guard — the column is dutifully carried; it is simply always NULL, because adding a column in a migration does not make any code populate it.
* **op-semantics completeness** has no guard — nothing checks that the apply side handles every op *meaning* the capture side can emit (a `put` that means "retract").
* **invariant completeness** has no guard — nothing checks that a raw-SQL writer upholds what the table's real writer guarantees (here: *every memory row has a vector row in the active mode, or it is invisible to recall*).

## It is not a federation bug — it is a CAPTURE-TRIGGER bug (EI-10521)

The same root cause turned up a fourth time in a lane that has nothing to do with p2p: **git-export**. `capture_git_export_outbox()` — whose header says it *"mirrors `capture_substrate_outbox`"* — routes every export by `row->>'harness_slug'`. Two tables were registered as git docs without a harness scope: `goals` (its column is `install_slug`) and `project_spec_revisions` (project-scoped, no slug at all). Neither has a `harness_slug` column, so the trigger read **NULL** on every write.

And here is the generalization worth carrying, because it inverts the symptom:

> **The routing key is unwritable in both cases. What decides whether you get a silent strand or an outage is the NULLABILITY OF THE DESTINATION COLUMN.**
>
> * `substrate_outbox.harness_slug` is **nullable** → the op is enqueued with a NULL key, the drain's `WHERE harness_slug = $1` never selects it, the GC reaps it. **Silent strand** (EI-10432): federated to nobody, errored nowhere.
> * `git_export_outbox.harness_slug` is **NOT NULL** → the trigger's INSERT raises `23502`, and because it raises *inside an AFTER trigger* it **aborts the statement that fired it**. **Outage** (EI-10521): every INSERT/UPDATE/DELETE on `goals` and `project_spec_revisions` failed, so both tables sat at **zero rows** — the features had never once worked, despite live writers (`goal-lineage.ts`, and an HTTP route for spec revisions).

Same defect, opposite failure mode. So don't ask only "is the key written?" — ask "**and what does the destination do with a NULL?**" One answer hides the bug forever; the other converts a missing export into a broken write path.

**The bitterest part, and the actual lesson:** this had already happened, been diagnosed, and been written down. `table-registry.ts` carries a comment explaining that `llm_test_fixtures` / `llm_test_claims` / `llm_test_findings` were removed from the git-doc set because *"the harness-keyed git\_export\_outbox capture (`harness_slug` NOT NULL) **crashed every insert** … a fresh llm-test run couldn't persist."* `goals` and `project_spec_revisions` sat **five lines below that comment**, with the identical defect, for as long as it existed.

> **A diagnosis in a code comment does not prevent recurrence. Only a mechanical guard does.** The comment was correct, prominent, and adjacent — and the bug shipped twice more anyway. If you find yourself *explaining* an invariant in prose, that is the moment to write the test instead.

The fix has three parts, and the shape generalizes to any capture lane:

1. **Make the capture trigger refuse to enqueue an unroutable op — never fatal.** `capture_work_items_outbox` already did exactly this (`IF v_slug IS NULL OR v_slug = '' THEN RETURN v_rec; END IF;`); the git twin that claimed to mirror it omitted the guard. A missed export is a bug; a core write path that always throws is an outage.
2. **Fix the registry, not just the trigger.** Part 1 alone would convert the loud break into a silent no-export — i.e. it would turn EI-10521 *into* EI-10432. An unroutable table is a **misclassification**: a git doc is exported into one harness's `.papercusp/state/` dir, so an install-/project-/workspace-scoped table is not a git doc.
3. **Guard it mechanically** (`git-export-slug-coverage.integration.test.ts`): every registered git doc, in the real migrated schema, must carry a NOT NULL `harness_slug`. That is the test the llm\_test\_\* comment should have been.

## The audit, when you touch any federated table

1. **For every federation column, name the line of code that writes it — then prove it against live data.** This is the cheapest and highest-yield check, and it is one query:

   ```sql
   SELECT count(*) FILTER (WHERE harness_slug IS NOT NULL) FROM harness_shared.memory_canonical;  -- 0 of 10323
   ```

   A federation column that is NULL on **100%** of rows is not a "not used yet" column — it is a routing key nobody writes, and every op that depends on it is being dropped. Contrast it against a table that *does* federate (`agent_facts`: 2 shareable rows, both carrying a slug). `grep` the writer, too: `harness_slug` had **zero** hits across all of `libs/generic/memory/src`.

2. **Diff the promises against the code.** Read the migration comments, the plan decisions, and the originating proposal — then grep for each promised behavior. `shareable` appeared in `p2p-memories.ts` **only in comments**. A word that lives exclusively in prose is a promise nobody implemented. Treat *"mirrors mig NNN"* in a migration header as a **claim to verify, not a citation**: it means the schema was copied, and says nothing about the code.

3. **Ask who else writes this table locally, and what does that writer guarantee?** Find the store/DAO class. Enumerate its invariants (side tables it maintains, derived rows, columns it fills). A raw-SQL projection inherits **none** of them — and, symmetrically, a *generic* store (mem0's, here) knows nothing about the federation columns a migration bolted onto its table. Both directions leak.

4. **Ask how the row is READ, not just whether it landed** — and whether it ever LEAVES, not just whether it was written. "It projected" is not "it works"; "it stored" is not "it sent." Trace the row into the *primary* read path, and trace the outbox op to the drain's actual `WHERE` clause. A row that only surfaces via a fallback path, or an op the drain can never select, is a bug wearing a passing test.

## The trap when fixing it: don't reach for the GENERATED column

On a table whose every other derived scalar is `GENERATED ALWAYS AS (payload->>'…')`, "just make `harness_slug` generated too" looks obviously right. It would have **broken the receive side**: the projection inserts `harness_slug` explicitly, and Postgres rejects an explicit value for a generated column. That is not hypothetical — the identical mistake on `workspace_id` threw on **every** federated write until P-007 caught it, and the scar tissue is a 13-line comment in `p2p-memories.ts`.

The constraint that resolves it: the **row** must carry the key (the wire row *is* `to_jsonb(row)`, and the receiver validates the slug is a non-empty string), so the stamp must be atomic with the INSERT — but it must also yield to an explicitly-supplied value. That is exactly a `BEFORE INSERT/UPDATE` trigger that fills the column **only when NULL**: mem0's local insert gets stamped from the payload; the projection's remote apply keeps the peer's authoritative slug. Read the existing writers' *shapes* before choosing where a value gets filled in.

## Fixing an invariant a projection can't uphold inline

Don't reach for the obvious "just do it in `writeToPg`." A projection runs inside the **hyperbee apply loop**, shared by every federated table. A per-row network call there (an embed: \~100ms–6s, and the sidecar can be down or quota-cooled) stalls the whole substrate's apply pipeline, and a failure strands the row permanently with nothing to retry it.

The shape that works, and that this repo already had twice over (the memory write-journal drain, and now the federated-vec backfill), is a **bounded, non-fatal, self-healing sweep** hung on an existing tick:

* select the rows that *are missing the invariant* (not "the rows we just wrote" — that's not self-healing),
* do the expensive work outside the apply loop, sequentially (a shared embedder/sidecar is saturable),
* a failure just leaves the row in the queue: an outage **delays** the invariant instead of losing it,
* and it converges — the next pass finds nothing.

The price is that the invariant lags the write by up to one tick. Say so out loud; it is almost always the right side of the trade against stalling a shared pipeline.
