# 2. Vocabulary
URL: /internal/docs/spec/vocabulary

Canonical definitions for Papercusp domain terms and the live Cupboard listing-kind contract.

:::caution\[**Mug**, **Kettle** and **Cup** below are RETIRED roles — the Pot is not]
The Mug · Kettle · Cup/nursery **role tier** was **retired 2026-08-09** (owner-directed), so
the present-tense definitions below ("the Mug decides which Cups run", "the Mug places a work
item onto a Cup") describe a tier that no longer runs. `cup:spawn` **refuses**, and
`RETIRED_TIER_ROLES = {mug, kettle, cup}` is enforced after alias canonicalisation, so
`queen`/`bee`/`overwatch` are caught too. **su + GOAL mode are the only way to drive the app**;
fan out with `fleet:launch-on-plan`. See
[the Mug · Kettle · Cup tier is retired](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired).

The entries are **kept as vocabulary**: these words appear throughout the code, the schema and
the older docs, so a reader still needs to know what they mean. The **Pot** itself is NOT
retired — the pot substrate is explicitly kept (D-003).
:::

Term
Definition
Example

Harness
A long-running iteration loop made of named roles invoked with fresh contexts that hand off via a structured state store.
The role substrate in libs/papercusp/packages/harness/.

Pot
An operator over a fleet — a root install minted from a kind:'pot' blueprint. Its single judgment layer (the Mug) surveys the blackboard, decides with agency, creates/supervises harnesses, and declares its own next wake. Distinct from a kind:'harness' blueprint, which is a feature pipeline the Pot creates.
A coding Pot from the coding blueprint, placing work onto Cups and spinning up coding-factory harnesses per feature.

Blueprint
The recipe that superseded template — a declared spine of roles, models, dispatch/triggers, and recommended plugins. kind:'pot' blueprints mint a Pot operator; kind:'harness' blueprints mint a feature pipeline.
coding (pot), coding-factory (default pipeline harness), coding-solo (single-worker baseline), research.

Cup
The generic operator-world worker the Mug places ranked work + a brief onto. Carries no pipeline spine and no chunk requirement (decoupled from the pipeline worker guards); the pipeline roles apply only when a Cup explicitly spins up a coding harness.
The Mug places a work item onto a Cup, which does the task or spins up a coding-factory harness for it.

Mug
The Pot blueprint's placement-specialist decider — the operator role tuned toward placement: cup:spawn/drain and work-list shaping. Same judgment layer as the operator, dial turned toward fleet management.
The Mug decides which Cups run, drains idle ones, and shapes the ranked work list each wake.

Install
A specific configured harness — its goal, its plugins, its UI, its DB schema. An install is what users actually run.
A coding Pot spun up from the coding blueprint. (The original Papercup 5-director autonomous-AI-company demo is retired — preserved-not-active in \_retired/papercup; migration 192 dropped the org-simulation tables.)

Role
A named agent invocation — a prompt file + an entry in the orchestrator's decision table. Always with fresh context.
The shipped pipeline roles are Scoper, Architect, Worker, Validator, Reviewer, Debugger, Documenter, Curator (the coding-factory pipeline runs scoper → architect → worker → validator → reviewer → documenter → curator). Orchestrator is a separate coordinator/decider role, not a pipeline stage — see AGENT\_ROLES in packages/agent-mcp/src/role-config.ts. Plus user-defined roles via plugins.

Harness template
A reusable recipe for spinning up a harness. One template → many concrete harness instances; each instance has its own goal, project dir, state. Templates declare their roles, default models, and the plugins they recommend.
The shipped coding blueprints: coding (the kind:'pot' Pot operator), coding-factory (the default per-feature pipeline harness), and coding-solo (the single-worker baseline). One user spins up one instance per project. (The retired papercup-org 5-department company is no longer a spinnable template.)

Plugin
A package that extends one or more harness instances with new capabilities — actions (buttons), routes, lifecycle hooks, DB schemas, custom UI tabs. Plugins are installed once globally and mounted into harness instances at runtime; their behaviour is gated by capability tiers (§10).
@papercupai/cloudflare-pages contributes a "Publish" button; @papercupai/slack-notifier sends a Slack message on mission-done. The retired @papercupai/vscode-server pilot used to contribute a code-server tab; IDE tabs remain plugin-shaped, not core. Multiple plugins compose per instance.

Marketplace package kind
The discriminator that tells the marketplace + Cupboard which install pipeline a published artifact follows. Implemented as a ten-kind storefront (LISTING\_KINDS in packages/operator-core/lib/cupboard/types.ts): harness (repo→Pot lookup), blueprint (fork), plugin, pack, knowledge-pack, template, app, rubric, plan, and recipe. The last three distribute grading contracts, reusable plan templates, and runnable tool orchestrations; tool-pack/learning-pack remain normalized aliases and snapshot is retired.
All ten go through the same publish + retraction infrastructure; the consumer action and install handler differ by kind. blueprint, knowledge-pack, rubric, plan, and recipe listings publish pending and surface only after operator approval.

Goal
The top-level mission. Every task traces back to a goal through a parent chain. Goals can themselves nest.
"Build a habit-tracker mobile app and ship to TestFlight" or "Run an autonomous marketing agency."

Pending event
An entry in the queue the orchestrator reads on each tick. Sources: cron routines, webhooks, API triggers, completion deltas.
Routine "weekly-briefing" fires at 9am Monday → inserts \{\{role: narrator, due: 09:00}}.
