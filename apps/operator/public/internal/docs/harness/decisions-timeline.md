# Decision telemetry & ghost rate
URL: /internal/docs/harness/decisions-timeline

Every director decision verb is persisted and auditable, and unparseable decisions are tracked as "ghosts" — a health signal, not an invisible stall.

Each iteration of a feature pipeline ends with the deciding agent emitting one
**decision verb**. The harness treats that stream of verbs as first-class
telemetry: every decision is persisted, and outputs that fail to parse as a
known verb are counted as **ghosts** — because a failed parse means the engine
saw no decision at all.

## The decision-verb model today

The per-feature **director**
(`libs/papercusp/packages/harness/blueprints/base/prompts/director.md`)
emits `NEXT_WORKER` / `NEXT_ARCHITECT` / `NEXT_VALIDATOR` / `DONE` /
`ESCALATE`. The durable pipeline interprets the parsed verb through the
blueprint spine's `deriveNext` interpreter
(`packages/operator-core/lib/dbos/orchestrator-workflow.ts`), so what each
verb *does* is declared by the blueprint, not hardcoded.

The director spine is the built-in **`coding-factory`** blueprint
(`spine.decider: director`, the strict scoper → architect → worker →
validator loop this page describes). The `coding` id no longer points
here: the 2026-06-18 POT rename repurposed it into the POT/Mug operator
blueprint (`kind: pot`, `spine.decider: mug`), so a reader looking for
the director spine under `coding` will find the Mug instead. The durable
workflow loads `coding-factory` as its behavior-preserving default spine.

The full verb vocabulary (including legacy/global verbs) is still classified
defensively in `classifyDecision`
(`packages/operator-core/lib/dbos/orchestrator-decide.ts`) so a stray verb
never dead-ends a pipeline: lifecycle verbs dispatch a role, `DONE`/`ESCALATE`
finalize, benign global verbs stop cleanly, and genuinely unsupported verbs
(parallel-lane forms, `NEXT_HARNESS`, `NEXT_WORKER_CEO_MODE`) stop. In the
live durable workflow those unsupported verbs are recorded as the terminal
`lastVerb` (`UNSUPPORTED:<verb>`) and break the pipeline cleanly — no console
warning. The "warn and stop" framing belonged to the legacy bash main-loop;
`classifyDecision` itself just returns `{ kind: 'unsupported' }`.
`classifyDecision` is retained as the **golden-reference oracle**:
`derive-next-equivalence.test.ts` asserts the `coding-factory` blueprint's
spine never silently drifts from it. `CHECKPOINT` is deprecated — it now
finalizes as an escalation (milestone gates became `needs-human` plan items).

## Persistence: the decisions timeline

Decision events persist to Postgres (`harness_shared.harness_decisions`) via
`POST /api/internal/decision-event`
(`packages/operator-core/lib/endpoint-route/routes/internal/decision-event.ts`,
bearer-token-authenticated per harness), each row carrying timestamp, verb,
args, iteration, and an `isGhost` flag. The UI reads the chronological
timeline through the `harnessDecisions.byHarness` sync resolver
(`packages/operator-core/lib/sync-resolver/index.ts`).

## Ghost rate

The deciding agent sometimes wraps its verb in a markdown fence or decorates
it; the parser strips what it can, but an unrecognized output is a **ghost** —
the engine saw no decision. In the bash era, tracking `ghosts / total`
surfaced a real masked bug: \~8% of orchestrator outputs were being silently
ghost-classified; one anti-fence prompt rule dropped it below 1%. The lesson
stuck: parse failures must be a visible rate, not silent stalls.

Today the harness health read computes ghost rate from the run log's
`ORCH decision:` lines against the known-verb set
(`packages/operator-core/lib/harness-readers.ts` — `NEXT_WORKER`,
`NEXT_VALIDATOR`, `NEXT_ARCHITECT`, `ESCALATE`, `CONVERTED`, `DONE`), and
**`low_ghost_rate`** (ghosts ≥ 10% fails) is one of the composite health
checks alongside `features_present`, `not_escalated`,
`no_pending_checkpoints`, `smoke_test_clean`, `recent_activity`, and
`not_stuck`.

## Why this is uncommon

Most agent frameworks treat orchestrator output as opaque — a parse failure
just looks like an idle loop. Persisting every verb and exposing the ghost
rate as a health signal lets a prompt regression show up on a dashboard
within one mission instead of as a mysterious stall three missions later.

## Related

* [Why fresh contexts per role](/internal/docs/harness/decisions/fresh-contexts) —
  the decision verb is how "try again" works without conversational memory
* [Orchestrator + pending\_events](/internal/docs/spec/orchestrator) — the
  durable pipeline that consumes these decisions
