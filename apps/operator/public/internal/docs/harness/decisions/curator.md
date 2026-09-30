# Why a curator role
URL: /internal/docs/harness/decisions/curator

Without compaction, raw observations grow unboundedly — a dedicated role owns distilling them into bounded, auto-injected memory.

The curator is the harness's memory-compaction role: the one place where noisy
raw observations get distilled into the bounded, durable memory every other
role reads. It is the only role allowed to *delete* memory. Without it, the
append-only observation log grows linearly with iterations and no other role
has the bandwidth to read it.

The design predates the current engine (it was one of the original
bash-harness roles) and survived into the blueprint era nearly unchanged.

:::caution\[Status: the curator pipeline is DORMANT — this page is design rationale, not live mechanics]
Every mechanism described below is still **accurately** declared in the tree, but
**nothing currently runs a curator pass.** `coding-factory` is the only blueprint
that declares a `curator` role, and it was **retired 2026-06-24** (owner ownerhandle4) —
its `director` autoloop last fired 2026-05-01 and nothing instantiates it
(`libs/papercusp/packages/harness/blueprints/coding-factory/blueprint.yaml`, the
structured `retired:` block). Do not wire new work to it, and read the present-tense
sections below as *"how it is declared to work"*, not *"what is running today"*.

The retirement is machine-checked, not just prose: before the structured `retired:`
field existed it was human-readable only, so nothing checked it before spending — an
autoloop burned $14.51+ against this blueprint via `external-bench`, which
`extends: coding-factory` (WI-5645, EI-18177667809538623). The block **deep-merges
through `extends`**, so every descendant that does not declare its own `retired`
inherits it. To revive: delete the block (or set `retired: null` on one child to
un-retire just that child) and restore the director dispatch.
:::

## When the curator fires

The curator is a role in the `coding-factory` blueprint — the strict
scoper-to-curator spine
(`libs/papercusp/packages/harness/blueprints/coding-factory/blueprint.yaml`).
There it sits at the end of the spine
(`scoper → architect → worker → validator → reviewer → documenter → curator`)
and runs in the finalize recipe on **both** terminal outcomes:
`onDone: [curator, postCuratorOutputs, documenter, archive]` and
`onEscalate: [curator]`. Same contract as the original design: terminal
events always get a curation pass.

A naming note: the 2026-06-18 rename
(\[\[domain-generic-pot-architecture-2026-06-18]] D-011) moved this spine from
the id `coding` to `coding-factory`, and reused `coding` for the Pot (Mug +
coding cups). So the live default `coding` blueprint is now the single-role
Pot operator — it has **no** curator role and no `gates.finalize`; the curator
pipeline lives only in `coding-factory`, which the Pot falls back to per-repo
(`extends: coding-factory`). The blueprint-id aliases deliberately have no
`coding → coding-factory` entry — a bare `coding` resolves to the new Pot
(`libs/papercusp/packages/orchestrator/src/blueprint-aliases.ts`).

## What the curator does (per its persona)

The persona (`libs/papercusp/packages/harness/blueprints/base/prompts/curator.md`,
inherited by `coding-factory`) is explicit and ordered:

1. **Process pending issues first.** Validator findings land as pending
   issues; the curator triages them in two distinct steps. First the
   **operator** runs the dedup against open/acknowledged issues — exact
   `codePointer` match **or** ≥0.85 Jaccard title overlap collapses a finding
   into the existing one (`attempts++`, a "Resurfaced" note, severity
   bump-up); genuinely-new findings get fresh `I-NNNN` ids. Then the
   **curator** itself auto-closes the stale ones: any open/acknowledged issue
   whose `codePointer` is verified passing this round (its feature is `passed`
   and no new pending entry mentions the same pointer).
2. **Merge raw observations into `MEMORY.md`** — the full curated store at
   `.papercusp/memory/MEMORY.md`, deduplicated, bounded at \~200 lines, and
   organized under four fixed headings: `## Decisions`, `## Context`,
   `## History`, and `## Lessons` — the persona flags **Lessons** as the most
   important section (generalized statements future runs can act on).
3. **Re-derive `summary.md`** — `.papercusp/memory/summary.md`, **hard-capped
   at 40 lines / \~800 tokens**, auto-injected into every future role's prompt
   (it rides the cacheable preamble — see
   [Why prompt-cache-dominant](/internal/docs/harness/decisions/prompt-cache)).
   The curator is the **one role that does not** receive the auto-injected
   `summary.md` — it would be self-referential and it changes every pass, so
   the prompt builder excludes it
   (`libs/papercusp/packages/orchestrator/src/prompt-build.ts`). The curator
   instead reads `raw.md` / `MEMORY.md` from disk with a deliberately fresh
   context: "nothing is in your head; everything is on disk."
4. **Truncate `raw.md`** — `.papercusp/memory/raw.md` is the append-only
   one-liner log any role writes to; after curation only a short
   recent-history tail remains.
5. **Maintain per-role identity files** — `identity/<role>.md` carries lessons
   *across* missions (MEMORY.md is mission-scoped). The orchestrator mirrors
   these into Postgres (`harness_shared.identity_files`) via
   `POST /api/internal/identity-snapshot`, so the durable, queryable copy is
   the PG row; the curator authors by writing the file. The concrete
   worker → curator promotion path is the **TRICK convention**: workers prefix
   a `raw.md` entry with `TRICK:` to flag a discovered pattern, and the curator
   promotes any TRICK seen by **≥2 distinct worker invocations** (distinct
   feature ids) to `identity/worker.md` under "Patterns I've learned." A
   codebase-specific TRICK goes to this mission's `MEMORY.md` Lessons instead.
   Either way it leaves `raw.md` after truncation.

## Why compaction is a separate role

Other frameworks bundle memory maintenance into every agent. The result:
workers spend tokens deciding what's worth remembering, different workers
disagree about what matters, and mid-mission deletions churn shared state.
Splitting compaction into one role gives:

* **One place to review** the "what should we remember" prompt.
* **Atomic mutations** — the curator runs, and every subsequent spawn sees the
  new memory.
* **Auditable history** — `raw.md` is the working set; `MEMORY.md` is what the
  curator distilled from it.
* **Bounded growth** — the 40-line summary and \~200-line store mean the
  system can't ingest more than later spawns can afford to re-read.

Any role appends to `raw.md` without coordination; the curator decides where
an observation belongs (mission memory vs cross-mission identity). The worker
flags; the curator files.

## Where this stands today

**The role is dormant; the idea moved up a level.** Memory compaction is the
curator's pipeline job within the `coding-factory` spine — and that spine is
retired (see the status note above), so no live blueprint runs a curator pass.
`coding-factory` is the only blueprint in the tree declaring `id: curator`. The
live default `coding` blueprint is the Pot (the 2026-06-18 rename), which has
**no** curator role and no `gates.finalize`, so the file-based `raw.md` →
`MEMORY.md` → `summary.md` cycle is not executing anywhere today.

What survived is the *instinct*, re-implemented one level up and very much alive:
the `curation:*` tools (`packages/operator-core/lib/agent-tools/curation/` —
`curation:feed`, `curation:change-feed`, `curation:state-of-pot`) project
completed work and fleet-wide meta-patterns for supervising agents. Distilling a
noisy stream into a bounded, grounded digest is now an operator-level read
surface rather than a per-mission file-writing pass — which is why this page is
still worth reading as rationale even though the pipeline it describes is idle.

Personal/cross-client semantic memory is a separate system (the `memory:*`
tools over the canonical PG store); the curator owns the *harness's* working
memory. See [Memory](/internal/docs/harness/memory) for the full layering.
