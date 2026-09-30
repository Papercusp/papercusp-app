# Effort-scoped continuity — write at the level the lesson belongs to
URL: /internal/docs/agent-insights/effort-scoped-continuity-write-at-the-level

A weeks-long effort's knowledge survives because the checkpoint ring is on and the note is written at the item, plan or goal level it belongs to — not because anyone remembered to promote it.

An effort that runs for weeks is worked by a dozen sessions that never overlap. Everything one of them learns has to reach the next through a durable surface, and until 2026-09-02 two of those surfaces were quietly destroying knowledge rather than carrying it.

## The two measured failures

**A work-item checkpoint was replace-on-write.** Week 3's agent overwrote week 1's reasoning with no trace and no warning. Measured 2026-09-02: 10,326 `workitem`-scoped rows in `harness_shared.carry_notes`, **zero** carrying a journal entry — while the `loop` scope, on the *same substrate with the same code*, had accumulated 29,377. The ring was never missing. It was switched off at one call site (`journal: false` in `setWorkItemCheckpoint`). This is the failure mode that touches 100% of work-items rather than the \~6% that carry a plan.

**A lesson could only be written at one level.** An agent who ruled on something the whole plan depends on filed it on the single item that happened to surface it — invisible to every sibling lane, and unfindable by the agent who picks up a different item next week.

## What the surface is now

**The ring is on.** `work_items:checkpoint` journals. It is bounded on all three axes (15 entries, 600 chars each, 6KB total), adds no query and no lock — it rides the row the write transaction already `SELECT ... FOR UPDATE`s — and changes what is **stored**, not what is delivered. Claim-time delivery still reads `{ checkpoint, checkpointAgeMs }`; the ring's reader is the claim-time briefing, which spends it against an explicit budget.

One behaviour change that is easy to miss: with journaling on, *clearing* a checkpoint no longer deletes the row while the ring is non-empty. `note` still reads back `null`, so every existing reader is unaffected.

**Write at the level.** `learnedLevel: 'work_item' | 'plan' | 'goal'` on `work_items:checkpoint` and `loop:checkpoint`. The level of the note matches the level of the insight: an implementer writes at the item, a leader reconciling lanes writes at the plan.

* The default is `work_item`, because that is the level 94% of work actually has (measured: 15,791 of 16,792 open items carry neither a plan nor a goal).
* **Nothing is ever promoted, lifted, or copied between levels.** Promotion existed only while an agent could write at exactly one level; once the write attaches correctly in the first place, a plan read includes it because a plan's history contains its own posts. Any mechanism that ends in "and the agent should remember to call X" fails — do not reintroduce a promote verb.
* A level the item does not *have* falls back to the nearest level it does, and **reports the demotion** (`fellBack: true`). A note is never silently dropped.
* The write **fails soft**. It rides along a checkpoint, and a failed capture must never fail the checkpoint it accompanied — the checkpoint is the thing the successor cannot do without.

**The tool tells you what your prose will yield.** The reader's compression ladder is keyword-matched: `rootCauses` exists only when the author happened to write "root cause" or "originates at". Measured across the live corpora, 95.6% of work-item checkpoints yield no root cause and 97.5% no false premise — the reader cannot compress structure the write side never produced. So the reader's own extractor runs at **write** time and hands back what it found, as feedback rather than a gate. Heed it while you still hold the context: an agent re-reading its own note finds it clear, because it still holds the context the note depends on. The reader is weeks later, in a different session, possibly a different model.

**The briefing serves any item.** It used to require a plan pointer and returned zero bytes without one — which excluded the overwhelming majority of items. It now resolves the containment tree from edges that already exist (`work_items.source_plan_slug`, `work_items.goal_id`, `harness_plans.goal_id`) and serves an orphan from its own history, at the `self` rung.

## Reading a rollup without being lied to

Descent is the expensive direction and it is **opt-in**: `direction` defaults to `up` (ancestors only), which is the member-safe read. A rollup is a *leader* read.

When you do descend, three fields exist so a bounded answer can never pass as a complete one:

* `descended` — `false` means "not asked for", **not** "none exist". Do not guess.
* `fanOut.truncated` + `fanOut.total` — the read is a sample, and how big the real set was.
* `omittedDescendants` (+ `omittedDescendantsTruncated`) — every child the cap left out, **named by ref**, and whether even that list was cut.

The cap is 24 against a measured population of 409 plans carrying items (avg 7.8, p90 16, worst 126): it admits the p90 plan whole and discloses the tail of the long one. A rollup that silently drops children is exactly the failure this disclosure exists to prevent.

## The goal rung is admitted, not tuned

`goal` is a legal containment level, thread parent kind, and scope rung. Nothing wires a goal rollup into a member's claim path, deliberately: measured 2026-09-02 there were 12 distinct goals, 30 open items carrying a `goal_id`, and exactly **one** goal with any plan attached. Tuning a two-level rollup against n=1 is tuning against noise. The ontology admits the level so the data can accumulate; build the rung when there is a population to build it against.

## The falsifier

If `rootCause` incidence on new checkpoints does not rise from its 4.4% baseline, the write-time advisory's diagnosis was wrong — agents do not *know* the root causes rather than not knowing the words — and the real problem is the capture **moment**, which is a different plan.
