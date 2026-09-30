# 4. The four core roles
URL: /internal/docs/spec/roles



The Papercusp specification defines four core roles. Which
of these are required depends on the install's declared shape
(see §4.1) — the most common shape (`iterative`) requires
all four; specialized shapes can opt out. Plugins may register
additional roles regardless of shape.

Role
When invoked
Reads
Writes

Planner
Once, at install activation; or when the goal materially changes
`goals`, install spec
`tasks` (initial breakdown), `validation_contract`

Implementation note: in the shipped Papercup pipeline the
single "Planner" role above is realized as two roles — Scoper
(scope + acceptance) followed by Architect (technical
breakdown). The canonical role ids live in AGENT\_ROLES
(packages/agent-mcp/src/role-config.ts), where the registry
list order is scoper → architect → worker → validator → reviewer →
debugger → documenter → curator. That list order is not
the dispatch pipeline: the executable per-feature spine lives in the
coding-factory blueprint
(libs/papercusp/packages/harness/blueprints/coding-factory/blueprint.yaml),
and runs scoper → architect → worker → validator → reviewer →
documenter → curator — with debugger excluded from
the spine. (The coding id was reused by the 2026-06-18 rename
for the Pot/Mug blueprint — kind: pot, only
DONE/ESCALATE/IDLE edges — so it
carries no scoper→…→curator spine; look at coding-factory,
not coding, for the pipeline.) Two refinements the registry
order hides: reviewer is not a per-feature director verb but
a PR-boundary approval gate (gates.approvals),
so the verbs that actually dispatch are scoper/architect/worker/validator/documenter/curator;
and debugger is a reactive overlay that fires
read-only before a worker retry once a feature accrues
knobs.debuggerThreshold failed attempts (alongside the opt-in
security-reviewer/crosscheck/ui-qa
reactive roles). The coordinator/cross-cutting role is
orchestrator; operator and oracle
are chat-surface roles, grouped separately in the registry.
On a terminal DONE the finalize recipe runs
curator → postCuratorOutputs → documenter → archive — i.e.
curator precedes documenter, opposite of the registry list order. A
planner role id exists since 2026-06-09, but it is an
interactive plan-authoring session (pot-agent-tabs), not this
spec-level Planner pipeline role. Full current registry:
Roles — the operational
reference.

Worker
Every iteration with a `todo`/`failing` task
`tasks`, `issues`, `worker_log`, parent goal lineage
Domain output (code/text/etc.) + status update on the task

Validator
Every iteration with a `validating` task
`validation_contract`, the task's domain output, parent goal lineage
`issues`, sets task status (`passed`/`failing`)

Orchestrator
Every tick (timer-based OR event-triggered)
All of the above + `pending_events`
One decision verb (above)

Roles are defined by prompt files, not code. Improvements compound without a deploy, branches are mergeable, and the cache key (the prompt content) is stable for a given role-version.

### 4.1 Install shapes — which roles a given install must implement

Design spec — not yet implemented as written. The shipped substrate
configures harnesses through blueprints (see
blueprint:create / blueprint:catalog and the
@papercusp/orchestrator/blueprint package), which declare their
roles, spine model, triggers, and dispatch policy directly (per-role model
selection rides the role-level model field / knobs.models,
not a blueprint-level tier). There is no
defineManifest helper and no shape enum
(iterative/scheduled/reactive/passive)
in code today; the section below is the original role-requirement design.

Not every install runs an iterative plan-then-build loop. A pure
scheduling install (cron + alerting, no goals) has no use for a
planner or validator — forcing it to ship no-op stubs invites
copy-paste smell. The install's `shape` in its manifest
determines which roles are required:

Shape
Required roles
Use case
Examples

`iterative` (default)
planner + worker + validator + orchestrator
Goal-driven work that breaks down into validated tasks. The historical Papercusp shape.
Papercup, sheets-clone, habit-tracker, any product-build install

`scheduled`
worker + orchestrator
Recurring or routine-driven work without explicit goal/task decomposition. Plan and validation aren't applicable.
weekly-briefings, daily-cost-report, nightly-backup

`reactive`
orchestrator only
Pure event-handling — orchestrator dispatches plugin-defined roles in response to `pending_events`. No first-party worker.
webhook-router, slack-bot, on-call-escalator

`passive`
none (zero roles)
Pure consumer — listens to hooks, contributes UI surface, queries other plugins' data via `data:read:*` capabilities, but never invokes an LLM. No prompts to author. Schema may still be declared (for the plugin's own storage).
dashboard-widgets, status-monitors, audit-loggers, read-only reports

Why `passive` matters: dashboard widgets and observability
plugins shouldn't be forced to ship even a `worker` stub.
A passive install can register hooks, contribute UI, declare its own
schema, and read other plugins' data — all without paying any LLM
budget or implementing role prompts. Most "extension" plugins (those
that augment, rather than build) belong in this shape.

```typescript
// In an install's manifest:
export default defineManifest({
name: 'weekly-briefings',
shape: 'scheduled',                      // → only requires worker + orchestrator
// planner/validator omitted; substrate doesn't error
capabilities: ['routines:write', 'http:fetch:slack.com'],
routines: [{ name: 'weekly-summary', trigger: { kind: 'cron', expr: '0 9 * * MON' } }],
});
```

The substrate validates the shape contract at install time — a
`scheduled` install that ships only an orchestrator is
rejected with a clear error pointing at the missing worker. A
`reactive` install that ships a worker is accepted (extra
roles are always fine; missing required ones are not).

Authors writing a new install pick the most restrictive shape that
fits — it keeps the contract honest and saves them from writing
no-op prompts. The default is `iterative` for backward
compatibility with installs that pre-date this section.
