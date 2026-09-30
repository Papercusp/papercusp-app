# Reading the loop-routed triage corpus — three traps that return a wrong number instead of an error
URL: /internal/docs/agent-insights/reading-the-loop-routed-triage-corpus

The scout-routed backlog corpus is now a view. Hand-deriving its predicate has three failure modes that each produce a plausible-looking wrong count rather than an error, and work_items:burn_down cannot produce this census at all.

## Use the views; do not re-derive the predicate

| relation                             | what it answers                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `harness_shared.triage_routed_items` | every loop-routed work-item, dimensions attached, fan-out collapsed, both evidence surfaces unified |
| `harness_shared.triage_burndown`     | why items LEFT the corpus, split by cause                                                           |
| `harness_shared.triage_ledger`       | one row per (snapshot, item): origin, lens, month, cluster, split verdict axes, falsifier           |
| `harness_shared.triage_snapshots`    | one row per stamped census, with a GENERATED `reconciled`                                           |

Corpus 1 is `triage_routed_items` filtered by `non_terminal AND non_observation`, **plus `workspace_id` and `harness_slug`**.

## The three traps

Each of these returns a number that looks entirely reasonable. None of them errors.

### 1. Fan-out — reads 1006 instead of 870

`scout_routed_ideas` is a routing LEDGER, not a registry: **127 items are routed more than once**. Joining it to `work_items` without `DISTINCT` on the routing side inflates the corpus by \~16%. The inflated number is not obviously wrong — it is the right order of magnitude.

Guard: assert `count(*) = count(DISTINCT feature_id)` on the join. If they differ, the DISTINCT is missing.

### 2. Two terminal evidence surfaces, and no route writes both

* a `dropped` close writes **`terminal_completion_ref`** (text)
* a `done` close writes **`payload->'_completionEvidence'`** (jsonb)

A reader that checks only one surface reports the other route's closes as **evidence-free** — which reads as a finding about completion integrity rather than a gap in the query. Measured on this corpus: checking only `terminal_completion_ref` would have called 219 properly-evidenced closes un-evidenced.

Related jsonb trap: empty jsonb casts to the non-empty string `'[]'`, so `completion_ref::text <> ''` is TRUE for every row. Use `IS NOT NULL AND ::text NOT IN ('null','{}','[]','""')`, plus `jsonb_array_length(...) > 0` for arrays.

### 3. Workspace-scoped, but not harness-scoped

The routing ledger is keyed by workspace. Corpus 1 currently happens to be **100% harness `papercusp`** — but the full routed join spans **four harnesses**, so the moment you widen the status filter to include terminal rows (which any drain or burn-down measurement does) you silently mix harnesses. This is safe by accident, not by construction; always filter both.

## `work_items:burn_down` cannot produce this census

It is the right tool for a **terminal audit** — `closureKind`, `evidenceVerdict`, `terminalOwner`, `reopenRecommended` — on a cohort of ≤200 ids. It cannot produce the corpus census, for three independent reasons:

* it exposes **no `origin` field on any row**, neither the bucket rows nor `cohortAudit`;
* it **cannot express the corpus predicate** (a join against `scout_routed_ideas`);
* **`ids` caps at 200** against an \~870-item corpus.

## Federation changes what a verdict means

`work_items.origin` partitions the corpus into what you can act on and what you cannot:

* **state and link writes on `origin='remote'` rows are REFUSED here** ("remote-authored and cannot be mutated locally; its authoring peer must claim/resolve it");
* **comments DO federate** — they land on remote rows normally.

Measured: 39% of this corpus is remote-authored. Two consequences worth internalising:

1. **Report an actionable (local) denominator separately from the total.** A burn-down over the whole corpus misreads a partition boundary as unfinished work.
2. **Remote items are not immortal** — they drain on their authoring peer's schedule. They cannot be *scheduled* from here, which is a different and weaker claim than "stuck forever".

Nothing on the read side tells you an item is remote before you try to write it, so a batch state change across a cluster can half-apply: check `origin` first.

## Measuring drain: separate the cause

Ordinary fleet work drains this corpus continuously even when the idea faucet is paused. Measured 2026-08-22: **482 background closes vs 5 triage-caused** — so a burn-down against a live denominator would credit a triage effort with \~99% drain it did not cause. Materialise a stamped baseline and attribute exits by cause; `triage_burndown` does both.
