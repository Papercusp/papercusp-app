/**
 * Harness Blueprint — the Zod schema (validator-of-record).
 *
 * `harness-blueprint-orchestration-2026-06-03` P-001 / D-001 / D-008.
 *
 * A Blueprint is the entire declarative shape of a harness: its work-item type,
 * role set, orchestration spine, planner, reactive overlay, gates, recursion,
 * gym rubric, and knobs. It is **agent-authorable** (validated `blueprint:*`
 * tools), **inheritable** (`extends`), and **versioned** (git-canonical
 * `.papercusp/blueprint.yaml`, projected to PG — D-006/D-021).
 *
 * This module defines the **resolved** schema — the shape a fully-merged
 * blueprint must satisfy. Inheritance is resolved by deep-merging the raw
 * on-disk objects (child over parent) BEFORE a single `BlueprintSchema.parse`,
 * so `.default()`s apply exactly once on the merged result and an absent child
 * field correctly inherits the parent's value (a default applied per-file would
 * clobber inheritance). The loader (P-002) does the merge; this file is the
 * contract both it and the authoring tools (P-007) validate against.
 *
 * Relationship to `HarnessConfig` (`types.ts`): the blueprint is a superset of
 * HarnessConfig's **shape/knob** fields only (see `knobs` below). Per-install
 * **instance** fields — `phase`, `phases` (port/dbPath), `dept` — stay in
 * `.papercusp/config.json`; they describe *this* install, not the harness shape.
 */
import { z } from 'zod';
import { dataConditionSchema } from '@papercusp/rules';
import { BUNDLE_KINDS } from './slots.js';
import { InjectionPointSchema, validateInjectionPoint } from './injection-points.js';
import { FIRST_PARTY_INPUT_KIND, resolveFirstPartyContextClass } from './first-party-classes.js';

/**
 * The work unit the director schedules/executes. Maps onto the canonical
 * `work_items(kind, payload)` table (D-013). `kind` is the discriminator
 * (`feature` for coding, `research-task` for research); `idPrefix` shapes the
 * human id (`F` → `F-001`). `payload` is a loose authoring/doc descriptor — the
 * authoritative per-kind payload validation lives in code, not here.
 */
export const WorkItemSchema = z.object({
  kind: z.string().min(1),
  idPrefix: z.string().default('W'),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A role in the blueprint. `id` resolves a prompt via the tiered `prompt-resolve`
 * lookup (`prompts/<id>.md` by default; `prompt` overrides with an explicit path
 * relative to the blueprint dir). `tools`/`capabilities` are retained only so a
 * legacy blueprint receives the semantic validator's targeted P-033 error
 * instead of having an unknown key stripped silently. New authoring declares
 * import requirements once in top-level `dependencies.*`; the distinct,
 * enforced role ceiling lives in `fleet.workerRoles[].capabilities`.
 * `reactive: true` marks a role that belongs to the condition-triggered overlay,
 * not the spine.
 *
 * `isolation` declares the filesystem-isolation a dispatch of this role wants —
 * `worktree` runs it in its own git worktree so parallel dispatches of the same
 * role (e.g. `migration`'s per-site transformer) don't collide, mirroring the
 * Agent/Workflow layer's `isolation: 'worktree'`. It is the role-level
 * *declaration*; honoring it at dispatch time is the orchestrator's job, and
 * parallel dispatch of an isolated role is gated on the same fan-out capability
 * the decider spine doesn't yet have (today the engine dispatches sequentially —
 * the declaration is correct + validated, the parallel honoring is a follow-up).
 * `none` (the default on omit) keeps a role in the shared tree (existing behavior).
 */
export const BlueprintRoleSchema = z.object({
  id: z.string().min(1),
  /**
   * Default identity binding for this launch role. Entries use the same
   * `slot:document-id` wire form as the live stack/control anchor; launch-time
   * validation resolves the slot registry and rejects conflicts before render.
   */
  stack: z.array(z.string().min(3)).max(40).optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  /** @deprecated use top-level dependencies.tools (kept for a targeted validation error). */
  tools: z.array(z.string()).optional(),
  /** @deprecated use dependencies.tools; enforced ceilings use fleet.workerRoles[].capabilities. */
  capabilities: z.array(z.string()).optional(),
  reactive: z.boolean().default(false),
  isolation: z.enum(['none', 'worktree']).optional(),
  description: z.string().optional(),
});

/**
 * A spine edge's action — what happens when the decider emits a given verb.
 * This is the data form of `classifyDecision`'s switch arms (`PipelineAction`):
 *
 *   - `done` / `escalate` / `idle` → terminal (finalize / stop).
 *   - `role` → dispatch a role and loop. `extras` are templated with `{feature}`
 *     and `{arg}` (e.g. `FEATURE_ID={feature}`, `VAL_ID={arg}`). `rejectWhenParallel`
 *     turns an `N=k` (parallel-lane) decision into `unsupported` for this verb —
 *     parallel lanes are the global orchestrator's job, not the per-feature
 *     pipeline's (D-001); today only `NEXT_WORKER` sets it.
 *   - `unsupported` → warn + stop (a global-only verb the per-feature pipeline
 *     deliberately does not run).
 */
export const SpineActionSchema = z.discriminatedUnion('to', [
  z.object({ to: z.literal('done') }),
  z.object({
    to: z.literal('escalate'),
    /** Static reason, or pull it from the decision arg with `reasonFrom: 'arg'`. */
    reason: z.string().optional(),
    reasonFrom: z.enum(['arg']).optional(),
  }),
  z.object({ to: z.literal('idle') }),
  z.object({
    to: z.literal('role'),
    role: z.string().min(1),
    extras: z.array(z.string()).default([]),
    rejectWhenParallel: z.boolean().default(false),
  }),
  z.object({ to: z.literal('unsupported') }),
]);

/**
 * A coord-op spine **step** — the first-class declarative composition unit of the
 * coordination-ops layer (`coordination-ops-as-blueprint-primitives-2026-06-04`
 * D-002/D-003/D-005). A step invokes a coord op (`coord:thread-open`,
 * `coord:collect`, `vote:aggregate`, …) with `{{ path }}`-templated `args`, binds
 * the op's result into the spine scope under `bind`, and may be guarded by a
 * `when` boolean expression over the bound scope. The ops are the `what`; the
 * spine `steps` are `how` (D-002 — the four-layer stack). Result-binding +
 * conditions are the load-bearing new infra the executor (P-005) runs durably.
 */
export const CoordOpStepSchema = z.object({
  /** Human/debug id, also the DBOS step name (`op-<id>`). Unique within a spine. */
  id: z.string().min(1),
  /** The coord-op to invoke — a name in the coord-op registry (D-001/D-004). */
  op: z.string().min(1),
  /** Op args, `{{ path }}`-interpolated against the bound scope before invoke. */
  args: z.record(z.string(), z.unknown()).default({}),
  /** Scope key to bind the op's result under (later steps + the gate read it). */
  bind: z.string().optional(),
  /**
   * Optional condition over the scope — skip the step when false. The canonical
   * `@papercusp/rules` `MatchMap`/`DataCondition` (adopt-event-rules-engines
   * D-002): dot-path → operator-test (`{ "asked.answered": { truthy: false } }`),
   * with `all`/`any`/`not` combinators. Evaluated by `evaluateDataCondition`
   * (injected as the spine's `WhenEval`) — one condition language across the
   * event-reaction rules, the gate, and these steps.
   */
  when: dataConditionSchema.optional(),
});

/**
 * A spine **gate** branch — the conditional decision after the steps run (the
 * `resolve` / `escalate` fork of the vote worked example, D-006). The first
 * branch whose `when` is true fires its `op` (with interpolated `args`); a branch
 * with `else: true` (or no `when`) is the fallback. A well-formed program gate
 * MUST have a fallback so it always resolves (validated — P-005).
 */
export const GateBranchSchema = z.object({
  /** Condition over the scope (the canonical `@papercusp/rules` `DataCondition` —
   *  see {@link CoordOpStepSchema} `when`); omit (or set `else`) for the fallback. */
  when: dataConditionSchema.optional(),
  /** Marks the fallback branch (sugar; an omitted `when` is equivalent). */
  else: z.boolean().default(false),
  /** The coord-op this branch fires (e.g. `resolve`, `coord:escalate`). */
  op: z.string().min(1),
  /** Op args, `{{ path }}`-interpolated against the bound scope. */
  args: z.record(z.string(), z.unknown()).default({}),
});

/**
 * The orchestration spine. Two coexisting, additive models (D-002):
 *
 *  - **decider model** (`edges` + `default`) — a flat declared graph (D-024): the
 *    `decider` role emits a verb each turn; `deriveNext` looks it up in `edges`,
 *    falling back to `default`. The behavior-preserving lift of the legacy
 *    director loop + `classifyDecision` switch (coding/research/gym).
 *  - **coord-op program** (`steps` + `gate`) — an ordered list of coord-op steps
 *    with result-binding + conditions, then a decision gate (vote/deliberate,
 *    D-006). No decider: the program IS the orchestration. Run by the durable
 *    `coordProgramWorkflow` (P-005).
 *
 * A spine declares EXACTLY ONE model (validated — `spine-mode` in validate.ts). A
 * blueprint may mix both across composition (a `deliberate` program step invokes
 * a `coord:vote` op which runs the `vote` program) — recursion bounded by the
 * depth cap (D-008). `edges` is optional so a program-mode spine omits it.
 */
export const SpineSchema = z.object({
  decider: z.string().min(1).default('director'),
  /**
   * Roles a deploy/install may swap in as the decider (e.g. the pot's `queen`
   * persona for placement automation — local-hive P-030). Declarative: the
   * validator treats these as live roles, not dead ones; the engine still
   * reads `decider` for the active choice.
   */
  deciderAlternatives: z.array(z.string().min(1)).optional(),
  /**
   * How agents ACQUIRE work (coordination-topology lift — benchmark-coordination-topologies).
   * `decider-dispatch` (default = today's behavior): the `decider` role dispatches each step.
   * `self-claim-fifo` / `self-claim-priority`: NO central decider — peer agents pull the next ready
   * work-item themselves (FIFO arrival order, or plan-priority order) from the shared queue. Self-claim
   * is how the flat-DISTRIBUTED (no-Queen) topologies are expressed; under it the `decider` field is
   * unused for dispatch (validate.ts relaxes the decider/edges requirement for self-claim spines).
   * Additive + defaulted, so every pre-existing blueprint parses unchanged as `decider-dispatch`.
   */
  claimModel: z.enum(['decider-dispatch', 'self-claim-fifo', 'self-claim-priority']).default('decider-dispatch'),
  /** Hard iteration cap (was `MAX_TURNS`; promoted to a blueprint field — P-004). */
  maxTurns: z.number().int().positive().default(200),
  /** verb → action (decider model). Keys are the blueprint's verb vocabulary. */
  edges: z.record(z.string(), SpineActionSchema).optional(),
  /** Action for a null/unparseable decision or an unmapped verb (decider model). */
  default: SpineActionSchema.default({ to: 'idle' }),
  /** Ordered coord-op steps (program model — D-002). */
  steps: z.array(CoordOpStepSchema).optional(),
  /** The decision gate fired after the steps (program model — D-006). */
  gate: z.array(GateBranchSchema).optional(),
});

/**
 * The planner that generates the Level-2 runtime task DAG (the per-goal plan).
 * `features-import` = the existing plans→features import (coding's Level-2 DAG —
 * waves + blocked_by parallelism). `inline` = the decider plans within its own
 * loop (research default — D-016). `none` = no separate planner.
 */
export const PlannerSchema = z.object({
  kind: z.enum(['features-import', 'inline', 'none']).default('none'),
  config: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A reactive-overlay rule (layer 3 — 3T/blackboard): a condition-triggered role
 * that can preempt the spine. v1 covers coding's debugger-before-worker gate
 * (`beforeRole: 'worker'`, `minAttempts: <threshold>`, `unless: 'debug-note'`).
 * `cond` is the escape hatch for conditions the structured fields can't
 * express — the canonical `@papercusp/rules` `DataCondition` (the same `when`
 * language as the coord-op steps + gate branches; adopt-event-rules-engines
 * D-002), evaluated over the dispatch scope by `evaluateDataCondition`. It
 * replaces the retired `custom: string` named-host-predicate hatch (a second,
 * non-serializable condition language with zero authors and zero consumers).
 */
export const ReactiveRuleSchema = z.object({
  role: z.string().min(1),
  when: z.object({
    beforeRole: z.string().optional(),
    afterRole: z.string().optional(),
    minAttempts: z.number().int().nonnegative().optional(),
    unless: z.string().optional(),
    cond: dataConditionSchema.optional(),
  }),
  /** true → can interrupt the spine (3T reactive preemption); false → advisory. */
  preempt: z.boolean().default(false),
});

/**
 * A `gates.finalize` entry: usually just a role/step name (the plain-string
 * form, e.g. `'curator'` / `'archive'`), or — when the launch needs
 * parameterizing beyond the outcome-derived extras (`TRIGGER`/`FEATURE_ID`/
 * `REASON`/`OUTPUT_KIND`) — an object naming the role plus extra `KEY=VALUE`
 * env entries appended to that role's invoke (unify-agent-launches-as-
 * blueprints D-007/EI-421: "the finalizer is declared, not a fake pipeline" —
 * this closes the remaining hardcoded part, letting a fork parameterize its
 * curator/documenter launch the way the bespoke pre-blueprint path could).
 * `archive` / `postCuratorOutputs` (non-role finalize steps) only take the
 * plain-string form — `extras` has no effect on them.
 */
export const FinalizeEntrySchema = z.union([
  z.string(),
  z
    .object({
      role: z.string().min(1),
      /** Extra `KEY=VALUE` env entries appended after this role's outcome-derived extras. */
      extras: z.array(z.string()).default([]),
    })
    .strict(),
]);

/**
 * Gates: the finalize-recipe (what runs on a terminal outcome — promoted from a
 * hardcoded constant, P-004) plus named human-approval gates.
 */
export const GatesSchema = z.object({
  finalize: z
    .object({
      /** Roles/steps run on `done` — e.g. `['curator','documenter','archive']`,
       *  or `[{ role: 'documenter', extras: ['OUTPUT_KIND=artifacts'] }]`. */
      onDone: z.array(FinalizeEntrySchema).default([]),
      /** Roles/steps run on `escalate` — e.g. `['curator']`. */
      onEscalate: z.array(FinalizeEntrySchema).default([]),
    })
    .optional(),
  approvals: z
    .array(
      z.object({
        id: z.string().min(1),
        role: z.string().optional(),
        blocking: z.boolean().default(true),
      }),
    )
    .default([]),
});

/** The role/step name of a finalize entry, whichever form it's declared in —
 *  the one place every consumer (validation, docs, the planner) should read
 *  this from so the two forms never drift apart. */
export function finalizeEntryRole(entry: z.infer<typeof FinalizeEntrySchema>): string {
  return typeof entry === 'string' ? entry : entry.role;
}

/** The declared extra `KEY=VALUE` env entries for a finalize entry (empty for
 *  the plain-string form, or any non-role step). */
export function finalizeEntryExtras(entry: z.infer<typeof FinalizeEntrySchema>): string[] {
  return typeof entry === 'string' ? [] : entry.extras;
}

/**
 * Harness-boundary recursion (layer 4 — Erlang/OTP supervision): a role spawns a
 * durable sub-harness with a declared restart/escalation strategy. Off for
 * coding (per-feature pipelines don't recurse); on for research overflow (spawn
 * a sub-research-harness) and monorepo sub-projects (D-016/D-023). Recursion is
 * at the *harness* boundary — preserving durability, gates, and observability.
 */
export const RecursionSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Blueprint a spawned child uses. Three forms (D-008):
   *   - omitted      → self;
   *   - a literal id → that blueprint;
   *   - `$param`     → a PARAMETERIZED child bound at spawn time via
   *                    `resolveChildBlueprint(bp, { <param>: id })` — the gym
   *                    declares `$target` and binds the blueprint-under-
   *                    optimization (the former undeclared runtime override).
   */
  childBlueprint: z.string().optional(),
  spawnOn: z
    .object({
      role: z.string().optional(),
      verb: z.string().optional(),
      custom: z.string().optional(),
    })
    .optional(),
  strategy: z.enum(['one-for-one', 'rest-for-one', 'escalate']).default('escalate'),
  maxDepth: z.number().int().nonnegative().default(1),
});

/**
 * The judge rubric a gym run scores against. Structurally mirrors the gym's
 * `GymJudgeRubric` (`apps/operator/lib/gym/judge-scoring.ts`) without importing
 * it (that lives in the operator; this is a lib). The operator's gym maps this
 * onto its concrete rubric type.
 */
export const GymRubricSchema = z.object({
  version: z.string().default('v1'),
  model: z.string().optional(),
  temperature: z.number().optional(),
  thinkingBudgetTokens: z.number().int().optional(),
  weights: z.record(z.string(), z.number()).optional(),
  dimensions: z.record(z.string(), z.string()).optional(),
});

/**
 * Per-blueprint gym configuration (the self-improving layer). `collectTrace` is
 * the fifth seam (D-015) that breaks the gym's repo-coupling: `git-diff` for
 * coding (diff over the substrate clone), `work-item-output` for research
 * (work-item output + transcript), or a named custom collector. `signals` are
 * deterministic, un-gameable guardrails resolved by name host-side
 * (`regressionsFromTests`, `plantedBugCaught`). The *target* blueprint declares
 * this; the `gym` blueprint reads it (D-022).
 */
export const GymSchema = z.object({
  collectTrace: z.union([z.enum(['git-diff', 'work-item-output']), z.string()]).default('work-item-output'),
  signals: z.array(z.string()).default([]),
  rubric: GymRubricSchema.optional(),
});

/**
 * Acceptance — how a hive/harness decides a unit of work is DONE, decoupled from
 * "tests pass" (hive-blueprint-generalization Phase 3, consumed by P-009). `tests`
 * runs the blueprint's verified test command (the coding default → green-checkpoint);
 * `judge` scores the run's output against `rubric` via the shared gym judge
 * (`gym:judge`); `human-gate` blocks finalization on an explicit human approval;
 * `none` (default) keeps today's behavior (finalize straight through `gates.finalize`).
 * `rubric` (only meaningful for `judge`) reuses the gym's rubric shape.
 */
export const AcceptanceSchema = z.object({
  kind: z.enum(['tests', 'judge', 'human-gate', 'none']).default('none'),
  rubric: GymRubricSchema.optional(),
});

/**
 * Output sink — where a finished unit of work LANDS (hive-blueprint-generalization
 * Phase 3, consumed by P-010). `repo-commit` (the coding default) leaves the change in
 * the tree for git-sync → checkpoint → deploy; `artifacts` persists a document/report
 * via the artifacts store; `external-action` performs an outward action (post/send/file)
 * via a tool; `work-item-payload` serializes the result onto the work item.
 */
export const OutputSchema = z.object({
  kind: z.enum(['repo-commit', 'artifacts', 'external-action', 'work-item-payload']).default('repo-commit'),
});

/**
 * Affinity — the seam the Queen uses to co-locate/decompose work onto bees
 * (hive-blueprint-generalization Phase 3, consumed by P-011). `file-overlap` (the
 * coding default) ranks by shared files (a bee's `current_files` vs the task's files);
 * `topic-overlap` by shared work-item topics; `entity-overlap` by shared entity scope.
 * The single knob that de-codes the Queen's "cut briefs on file-scope" into "cut on
 * <scope-seam>".
 */
export const AffinitySchema = z.object({
  kind: z.enum(['file-overlap', 'topic-overlap', 'entity-overlap']).default('file-overlap'),
});

/**
 * Lexicon — per-hive domain noun overrides (hive-blueprint-generalization Phase 4 /
 * P-016). Promotes the presentation-only `papercusp-the-hive` strings into the
 * blueprint so personas + UI read in the hive's own domain ("feature"/"PR" for a coding
 * hive, "deliverable"/"report" for a generic one). A loose string→string map; consumers
 * fall back to the built-in noun when a key is absent.
 */
export const LexiconSchema = z.record(z.string(), z.string());

/**
 * Fleet — the placeable worker roster a Queen dispatches onto, lifted from the global
 * role-config / role-envelopes into the blueprint (hive-blueprint-generalization Phase 4
 * / P-012). Each worker role names its ENFORCED capability envelope; `watcher` is the
 * read-only observer role(s) (sentinel; overwatch for an ops/coding hive — D-006).
 */
export const FleetSchema = z.object({
  workerRoles: z.array(z.object({ id: z.string().min(1), capabilities: z.array(z.string()).default([]) })).default([]),
  watcher: z.union([z.string(), z.array(z.string())]).optional(),
});

/**
 * Wake — the Queen's event-subscription policy, lifted from the hardcoded
 * `wake-defaults.ts` (hive-blueprint-generalization Phase 4 / P-013). The hive
 * deliberately has NO cron; it self-declares its next wake. `subscriptions` are the
 * default event keys that wake the Queen; `kickoffTemplate` seeds the first wake.
 */
export const WakeSchema = z.object({
  subscriptions: z.array(z.object({ on: z.string().min(1), note: z.string().optional() })).default([]),
  kickoffTemplate: z.string().optional(),
});

/**
 * Knowledge — which shared-memory Knowledge Pack seeds the pot
 * (cupboard-public-release-2026-07-12 P-001; formerly `learning.pack`).
 * `pack` omitted ⇒ the default pack; 'none' ⇒ seed nothing.
 */
export const KnowledgeSchema = z.object({
  pack: z.string().optional(),
});

/**
 * Learning — which learning LOOPS the pot provisions, lifted from the hardcoded
 * hive-create path (hive-blueprint-generalization Phase 4 / P-014).
 *
 * The seed-pack key moved OUT of this block to `knowledge.pack` in the
 * learning→knowledge-packs rename: the learning LOOPS (gym, scout, regret-mine)
 * are a different system from Knowledge Packs and keep their name — only the
 * PACK moved. `pack` survives here as a DEPRECATED read-side key: a blueprint
 * authored before the rename (including any installed in a user's tree, which we
 * do not rewrite) still declares `learning.pack`, and blueprint YAML is a true
 * boundary per knowledge-packs-2026-07-11 D-001. Readers MUST prefer
 * `knowledge.pack` and fall back to this. New blueprints must not set it.
 */
export const LearningSchema = z.object({
  /** @deprecated authored blueprints use `knowledge.pack`; read-only compat. */
  pack: z.string().optional(),
  loops: z.array(z.string()).default([]),
});

/**
 * Placement — the Queen's placement-policy knobs, lifted from the hardcoded
 * `fleet:place_batch` defaults (hive-blueprint-generalization Phase 4 / P-015).
 */
export const PlacementSchema = z.object({
  injectLoadThreshold: z.number().int().positive().optional(),
  maxInjectPerBee: z.number().int().positive().optional(),
  strategy: z.enum(['free-slot-first', 'warm-inject-first', 'balanced']).optional(),
});

/** Per-role / default AI-backend invocation knob (mirrors HarnessConfig's
 *  `AiBackendRoleConfig`). `.passthrough` so non-secret extras survive. */
const AiBackendRoleKnobSchema = z.object({
  engine: z.enum(['subprocess', 'loop']).optional(),
  agentCmd: z.string().optional(),
  model: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
});

/**
 * Knobs — the shape/knob subset of `HarnessConfig` that becomes part of the
 * harness *shape* (vs the per-install instance fields that stay in config.json).
 * `.catchall(unknown)` keeps forward-unknown knobs rather than stripping them.
 */
export const KnobsSchema = z
  .object({
    harnessKind: z.string().optional(),
    maxCostUsd: z.number().optional(),
    logRetention: z.number().int().optional(),
    branchIsolation: z.object({ enabled: z.boolean().optional(), baseBranch: z.string().optional() }).optional(),
    worktrees: z.object({ enabled: z.boolean().optional() }).optional(),
    reviewer: z.object({ replanOnAccept: z.boolean().optional() }).optional(),
    product: z
      .object({
        enabled: z.boolean().optional(),
        triggerOnNearDone: z.boolean().optional(),
        nearDoneThreshold: z.number().optional(),
        mode: z.enum(['auto-apply', 'propose-only']).optional(),
        replanOnAccept: z.boolean().optional(),
      })
      .optional(),
    /** Promotion-gate SHAPE knobs (`deprecate-harness-config-json-2026-06-06` —
     *  the last config.json knob without a declared home). `<from>_to_<to>` edge
     *  keys carry per-edge `criteria` overrides; `smokeBuild.enabled` opts into the
     *  pre-handoff smoke build. `.loose` because the edge keys are dynamic. Per-install
     *  overrides live in PG `configOverrides`, not the blueprint. */
    promotion: z
      .looseObject({
        smokeBuild: z.looseObject({ enabled: z.boolean().optional() }).optional(),
      })
      .optional(),
    models: z.record(z.string(), z.string()).optional(),
    /** debugger-before-worker gate threshold (attempts ≥ n fires the gate). */
    debuggerThreshold: z.number().int().nonnegative().optional(),
    /** The repo's verified test command (P-009 generate-from-repo detects + runs it once;
     *  consumed by the worker/validator gate + the gym signals). */
    testCommand: z.string().optional(),
    /** UI-QA opt-in for frontend repos (P-009 sets this when a frontend is detected). */
    uiQa: z.object({ enabled: z.boolean().optional() }).optional(),
    /** Does instantiating this blueprint require a git repo? (P-008; coding=true, research=false.) */
    requiresRepo: z.boolean().default(true),
    /** Per-hive staging→main release gate (per-hive-git-and-release-gate-2026-06-29
     *  D-001/D-002). `enabled` ⇒ this (coding) hive runs green-checkpoint: run the
     *  green command in an isolated `<slug>-checkpoint` checkout and fast-forward
     *  `releaseRef` (default `main`) from `integrationBranch` (default `staging`)
     *  only when green. `greenCmd` defaults to the existing `testCommand` knob
     *  (auto-detected by harness:generate-from-repo), else build/typecheck — the
     *  gate consumes the SAME command the worker/gym already run (D-004), never a
     *  parallel test path. `deploy` opts a hive into leg 3 (auto-deploy: drain →
     *  swap release checkout → migrate → restart → health); omit ⇒ green-gate only.
     *  Non-coding (`work`) blueprints set `enabled:false` — their repo, if any, is
     *  backup-only and never gated. Effective gate also requires the hive to
     *  actually have a repo (belt-and-suspenders, enforced at seed time). */
    releaseGate: z
      .object({
        enabled: z.boolean().optional(),
        integrationBranch: z.string().optional(),
        releaseRef: z.string().optional(),
        greenCmd: z.string().nullable().optional(),
        /** WI-2833: opt-in for a hive that carries its OWN operator SPA — the workspace
         *  name (e.g. `@my-org/my-spa`) the gate's SPA-build leg should build. Omitted
         *  (the common case — no subject hive carries an operator SPA today) ⇒
         *  hive-release-env.ts's resolveHiveReleaseGate defaults to '' (skip), same as
         *  before this field existed. Was previously undeclared here, so zod's default
         *  unknown-key stripping silently dropped it before resolveHiveReleaseGate ever
         *  saw it — see hive-release-env.integration.test.ts's pinned WI-2833 test. */
        spaBuildWorkspace: z.string().optional(),
        deploy: z
          .object({
            systemdUnit: z.string().optional(),
            healthUrl: z.string().optional(),
          })
          .nullable()
          .optional(),
      })
      .optional(),
    // ── Residual config.json → knobs migration (cloud-deployment-layer P-006) ──
    // These five had no declared blueprint home; they now do. config.json keeps
    // instance-override precedence (resolved by readEffectiveConfig's overlay).
    /** Per-role INSTANCE/experiment specialization (config
     *  `promptOverrides.<role>` = a full replacement / specialization string).
     *  A blueprint may use this for a live/global role it does not author; P-033
     *  validation rejects restating one of this blueprint's own `roles[]`, whose
     *  persona authority is `roles[].prompt` / its conventional prompt path. */
    promptOverrides: z.record(z.string(), z.string()).optional(),
    /** Per-harness AI backend: a `default` invocation + per-role overrides
     *  (agentCmd / model / extraArgs). Secrets never go here — see HarnessConfig. */
    aiBackend: z
      .object({
        default: AiBackendRoleKnobSchema.optional(),
        roles: z.record(z.string(), AiBackendRoleKnobSchema).optional(),
      })
      .optional(),
    /** Worker-lane config WITHIN a feature (distinct from `dispatch.concurrency`,
     *  which is cross-feature pipeline concurrency). `.loose` preserves stale
     *  config keys while the retired chunk-loop knobs are ignored. */
    parallelWorkers: z
      .looseObject({
        max: z.number().int().positive().optional(),
        maxFeaturesInFlight: z.number().int().positive().optional(),
        synthesizeSingle: z.boolean().optional(),
        mode: z.string().optional(),
      })
      .optional(),
    /** Scoper SHAPE knobs (`outputMode` proposal|plan, `backend`). `.loose` so any
     *  transient scoper run-state keys still parse (those move to PG under P-008). */
    scoper: z
      .looseObject({
        outputMode: z.enum(['proposal', 'plan']).optional(),
        backend: z.string().optional(),
      })
      .optional(),
    /** How many snapshot dirs to keep before pruning (read-site default 50). */
    snapshotRetention: z.number().int().nonnegative().optional(),
  })
  .catchall(z.unknown());

/**
 * Scheduler defaults the blueprint declares; `harness:create` materializes them
 * into `harness_shared.routines` (D-018). The routine's target is the
 * `system:blueprint-run` action — NOT a `pending_events` consumer (that hop is
 * retired). Runtime-editable after creation (pause/retime via upsert).
 */
export const TriggersSchema = z.object({
  schedule: z
    .array(
      z.object({
        cron: z.string().min(1).optional(),
        /**
         * Execution tier (schedule-inventory-and-ephemeral-tier-2026-06-26 P-010 / D-006).
         * 'durable' (default) — a `cron` routine fired by the DBOS `routinesTick` (the
         * existing behavior). 'ephemeral' — a FREQUENT, non-DBOS cadence that rides the
         * in-process scheduled-registry (`managedSetInterval`); it carries `intervalSec`
         * (not `cron`) and fires a DETERMINISTIC `action` (never the default
         * `system:blueprint-run`). `blueprint:validate` enforces the ephemeral contract.
         */
        tier: z.enum(['durable', 'ephemeral']).default('durable'),
        /**
         * Ephemeral cadence in SECONDS (tier:'ephemeral' only; ignored for durable cron).
         * The min-interval floor is enforced by `blueprint:validate`, not the schema, so the
         * pure parse stays permissive and the contract error is friendly/iterable.
         */
        intervalSec: z.number().int().positive().optional(),
        action: z.string().default('system:blueprint-run'),
        /**
         * Workspace-SINGLETON trigger (deterministic-blueprints-migration-2026-06-13
         * D-018). When true, `materializeBlueprintTriggers` upserts EXACTLY ONE
         * routine per workspace (idempotent across every install of this blueprint),
         * seeded INACTIVE/dark, under a reserved synthetic host-slug rather than the
         * real install slug — so a workspace-global learning loop (regret-mine,
         * gym-cycle, …) can declare its own cadence WITHOUT N-duplicating into N
         * redundant ACTIVE pulses on N harness installs (the D-010/D-012 objection).
         * The routine name carries the blueprint id (blueprint-unique under the
         * shared reserved slug). Omitted/false → per-install trigger, keyed on the
         * install slug and seeded ACTIVE (the existing behavior).
         */
        singleton: z.boolean().default(false),
        /**
         * For a `singleton` trigger: seed the workspace routine ACTIVE on FIRST creation
         * (D-024) rather than dark. Use for an always-on workspace loop (bookkeeping like
         * change-ledger, structural like scout) that should run out-of-the-box on a fresh
         * workspace — as opposed to a frontier learning loop, which stays dark until the owner
         * arms it at the P-001 gate. Either way a re-materialize PRESERVES the live `active`
         * state (the hardened singleton upsert never darkens an armed loop). Ignored unless
         * `singleton` is true.
         */
        singletonActive: z.boolean().default(false),
      }),
    )
    .default([]),
  /**
   * The event key that fires this blueprint as a coord-op program
   * (`coordination-ops-as-blueprint-primitives-2026-06-04` D-007). An
   * [[event-reaction-system-2026-06-04]] rule matching this key invokes the
   * program (`startCoordProgram`); the blueprint is ALSO directly invocable as a
   * tool (D-009, e.g. `coord:vote`). Declared here as the firing seam — the
   * event-reaction system (a separate plan) is the matcher that consumes it.
   */
  event: z.string().optional(),
});

/**
 * The autoloop **dispatch policy** — `autoloop-pot-operator-rebuild-2026-06-05`
 * D-005 (P-005/P-006): the last "lift hardcoded → declarative" for the autoloop.
 * Roles/spine/triggers/gates were already declared; the dispatch policy
 * (readiness + priority + concurrency + cost cap + safety ceiling — the
 * `computeFrontier` gates in `operator-core/lib/dbos/orchestrator-loop.ts`) was
 * hardcoded. This section declares it per blueprint, so `coding` runs 4 feature
 * pipelines at once while `research` runs 1 — per-harness-type autoloop
 * behaviors, all declared.
 *
 * OPTIONAL on a blueprint: launch/program blueprints (pot, vote, deliberate, …)
 * have no work-item autoloop and declare none — the orchestrator then keeps the
 * legacy config-only resolution. Resolution order at dispatch time: the
 * per-install `.papercusp/config.json` (`parallelWorkers.*`, `maxCostUsd`)
 * overrides the blueprint's declared policy (instance refines shape); the
 * blueprint fills where config is silent; and the orchestrator's imperative
 * `SAFETY_CEILING` clamps everything (D-007: safety gates stay deterministic
 * code — a blueprint can tighten the ceiling, never raise it).
 */
export const DispatchSchema = z.object({
  /** Max concurrent pipelines (work items in flight) for harnesses of this
   *  shape. Filled when the per-install `parallelWorkers` config is silent. */
  concurrency: z.number().int().positive().optional(),
  /** Candidate ordering. `plan-order` = strict plan priority (lower first,
   *  no-plan last), within a plan by (feature_order ASC NULLS LAST, id) — the
   *  greedy fill `computeFrontier` implements. The only mode today; a new mode
   *  lands WITH its frontier implementation, never as a dangling enum value. */
  priority: z.enum(['plan-order']).default('plan-order'),
  /** Work-item statuses eligible for dispatch. Default = the legacy needs-work
   *  set (`pending`/`failed` are FeatureRecord aliases kept for safety). */
  readiness: z.array(z.string().min(1)).nonempty().default(['todo', 'failing', 'pending', 'failed']),
  /** Autoloop spend ceiling (USD) — over it, no new pipelines start. The
   *  per-install `maxCostUsd` config overrides when set. */
  costCapUsd: z.number().positive().optional(),
  /** Declared concurrency ceiling — clamps the resolved cap for this shape.
   *  The orchestrator's hard imperative SAFETY_CEILING still applies on top
   *  (D-007): tighten-only, never a raise. */
  safetyCeiling: z.number().int().positive().optional(),
});

/**
 * Tool/pack/plugin dependencies the blueprint's roles need. The distribution
 * plan's import-time validation (su-4b6ce distribution P-003/P-004) resolves
 * these against the catalog + Cupboard listings and fails upfront with
 * "needs plugin X", closing the call-time-only `unknown_tool` gap.
 *
 * Deps are declared on TOOLS (capabilities) and resolved to their providing
 * pack/plugin/built-in; `packs` is a convenience for a whole curated
 * capability set (a plugin is a runtime-bearing pack, so a `packs` entry
 * resolves against plugins too). `tool-distribution-granularity-2026-06-05`
 * D-001/D-002.
 */
export const DependenciesSchema = z.object({
  tools: z.array(z.string()).default([]),
  packs: z.array(z.string()).default([]),
  plugins: z.array(z.string()).default([]),
  /** Work-blueprints this blueprint's roles SPAWN as sub-harnesses (e.g. a hive
   *  whose bees spin up `coding` / `research`). Resolved like packs/plugins:
   *  installed → satisfied, Cupboard-listed → installable, neither → hard failure;
   *  the install path pulls the closure (blueprint-role-bundling P-007 — this is the
   *  `memberBlueprints` mechanism of hive-blueprint-generalization D-004). */
  blueprints: z.array(z.string()).default([]),
  /** First-class **datatypes** this blueprint's roles read/write (the shared
   *  entity TYPES — `bet`, `wager`, `forecast`, … — produced by
   *  `meta:define-datatype`). A datatype is the SAME kind of reusable,
   *  independently-distributable artifact as a tool/plugin, so it gets its own
   *  registry and is REFERENCED by name here (NOT embedded). A blueprint's OWN
   *  work-unit shape stays inline (`workItem.kind` + `payload`); promote an inline
   *  payload to a referenced datatype when a SECOND blueprint needs it. Resolved
   *  like blueprints at import: workspace-registered / built-in → satisfied,
   *  Cupboard-listed → installable, neither → hard "needs datatype X". Backward-
   *  compatible: a blueprint that declares none is unaffected.
   *  (`reflexive-platform-extensibility-datatypes-2026-06-24` P-012, D-009.) */
  datatypes: z.array(z.string()).default([]),
});

/** A long-running background service the harness's environment needs (a dev
 *  server, a DB, a cache). The deployment driver starts these on the frame and
 *  (optionally) waits for `healthcheck` before marking the frame ready. */
export const EnvServiceSchema = z.object({
  /** Stable service name (for logs / health reporting). */
  name: z.string().min(1),
  /** The command that starts the service (run + supervised on the frame). */
  command: z.string().min(1),
  /** Port the service listens on, if any (also implies it in `ports`). */
  port: z.number().int().positive().optional(),
  /** A command or URL the driver probes to confirm the service is up. */
  healthcheck: z.string().optional(),
});

/**
 * The harness's build/run **environment spec** (`cloud-deployment-layer-2026-06-06`
 * P-007) — the declarative "what to stand up on a frame". The deployment driver's
 * `install()` (P-010) runs `setup`→`install`→`build`, the validator/gym run
 * `test`, and `run` + `services` are the long-lived processes; `ports` are
 * exposed and `env` (NON-SECRET vars only — secrets ride `credentialRef`) is set.
 * First-class on the blueprint (alongside `dispatch`/`gates`) so the SHAPE is
 * placement-agnostic and identical local vs cloud; per-repo commands can be
 * detected (harness:generate-from-repo) and refined per instance. Empty arrays
 * (the default) ⇒ nothing to stand up — today's local-only behavior.
 */
export const EnvironmentSpecSchema = z.object({
  /** One-time machine setup (apt/toolchain installs) run once per frame. */
  setup: z.array(z.string()).default([]),
  /** Dependency install (e.g. `npm ci`). */
  install: z.array(z.string()).default([]),
  /** Build commands (e.g. `npm run build`). */
  build: z.array(z.string()).default([]),
  /** Test command(s) the validator/gym run. */
  test: z.array(z.string()).default([]),
  /** Long-running app/dev-server start commands. */
  run: z.array(z.string()).default([]),
  /** Background services (DB / cache / dev servers) supervised on the frame. */
  services: z.array(EnvServiceSchema).default([]),
  /** Ports the frame must expose. */
  ports: z.array(z.number().int().positive()).default([]),
  /** NON-SECRET env vars to set on the frame (secrets ride `credentialRef`). */
  env: z.record(z.string(), z.string()).default({}),
});

/**
 * A declared, UI-introspectable tunable —
 * `psu-isolation-and-blueprint-aware-harness-ui-2026-06-09` P-006 / D-003 / D-007.
 * The settings UI renders one control per ParamSpec; the value lives at the param's
 * KEY — a dot-path into the PER-HARNESS INSTANCE CONFIG (the `config.json` /
 * `HarnessConfig` namespace the settings panel reads + writes), e.g.
 * `parallelWorkers.max`, `debugger.threshold`, `aiBackend.default.model`. (That
 * namespace deliberately differs from the blueprint-`knobs` namespace — the
 * knobs→config overlay drops the `knobs.` prefix and renames `debuggerThreshold`→
 * `debugger.threshold` — so the param keys the path the UI actually persists, NOT
 * the blueprint path.) This is a PRESENTATION/metadata projection that declares HOW
 * to surface + edit a value that already has a home; the Zod schema above stays the
 * validator-of-record for the blueprint shape.
 */
export const ParamOptionSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  label: z.string().min(1),
});
export const ParamSpecSchema = z.object({
  /** Human label for the control (rendered through `useLexicon` for cup-themed nouns). */
  label: z.string().min(1),
  /** Control type. `enum` requires `options`; `number` honors min/max/step. */
  type: z.enum(['number', 'boolean', 'string', 'enum']),
  /**
   * Default shown when neither the instance config nor the blueprint sets a value.
   * OMIT when the blueprint/Zod schema already supplies the default (e.g.
   * `dispatch.concurrency`) — the UI then reads the effective value and this never
   * drifts from the validator-of-record (D-007).
   */
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  /** `enum` options (value + display label). Ignored for non-enum types. */
  options: z.array(ParamOptionSchema).optional(),
  /** Help text shown under the control. */
  description: z.string().default(''),
  /** One line: which role / gate / dispatch field this tunes (a UI hint). */
  affects: z.string().optional(),
  /** UI section to group the control under (e.g. 'Dispatch', 'Worker lane'). */
  group: z.string().optional(),
  /**
   * true → this value is a SECRET: the settings UI routes it through the credential
   * store, never the instance config (the P-008 plaintext-secrets fix). The declared
   * param then carries only the credential REF, never the secret itself.
   */
  secret: z.boolean().default(false),
});

/**
 * The blueprint's declared tunables, KEYED BY DOT-PATH into the per-harness instance
 * config (`parallelWorkers.max`, `debugger.threshold`, `aiBackend.default.model`,
 * …) — the `config.json` namespace the settings panel reads + writes (see
 * {@link ParamSpecSchema}). A RECORD, not an array, ON PURPOSE: the loader
 * deep-merges raw blueprint objects child-over-parent and REPLACES arrays wholesale
 * but UNIONS object keys — so `base` declares the universal params every harness
 * shows and a concrete blueprint (`coding`/`research`/…) ADDS its own, and an
 * `extends: base` child gets base ∪ its-own without re-declaring base's. The
 * settings UI (P-008) introspects this to render the right controls per harness
 * type — so any blueprint, including a Cupboard-installed third-party one, gets a
 * working settings panel for free (D-003).
 */
export const ParamsSchema = z.record(z.string(), ParamSpecSchema);

/**
 * The resolved Blueprint — the validator-of-record. A fully-merged blueprint
 * (after `extends` resolution) must satisfy this.
 */
/**
 * The declarative COORDINATION PROTOCOL (benchmark-coordination-topologies). A blueprint already
 * declares the CHOREOGRAPHY (the spine: who acts when); this declares HOW peers coordinate — the
 * layer that was previously runtime/tool-driven + Queen-only, which is why the flat-distributed,
 * peer-review, blackboard, and pair topologies could not be expressed (the expressiveness gaps).
 * All fields optional + defaulted to today's behavior, so every pre-existing blueprint parses
 * unchanged. The runtime honors these in concert with `spine.claimModel`.
 */
export const CoordinationSchema = z.object({
  /** How an agent publishes progress/findings to peers. 'none' = isolated (no peer comms); 'topic' =
   *  broadcast to a shared topic peers subscribe to (the flat-distributed self-correction channel). */
  broadcast: z.enum(['none', 'topic']).default('none'),
  /** Peer review before a result is finalized. 'none'; 'peer' = a nominated peer reviews/critiques the
   *  output pre-submit (distributed peer-review; the pair navigator). */
  review: z.enum(['none', 'peer']).default('none'),
  /** The medium peers coordinate THROUGH. 'messages' = direct coord:send; 'blackboard' = ONLY shared
   *  work-item / scratchpad state, no direct messaging (stigmergic); 'both'. */
  sharedState: z.enum(['messages', 'blackboard', 'both']).default('both'),
  /** Coordination GROUPING granularity. 'per-backlog' (one shared queue for the whole team);
   *  'per-repo' (same-repo agents form a huddle); 'per-task' (multiple agents collaborate on ONE
   *  task — pair / ensemble). */
  team: z.enum(['per-backlog', 'per-repo', 'per-task']).default('per-backlog'),
  /** Post-hoc AGGREGATION across a per-task team's INDEPENDENT attempts (ensemble). 'none'; 'judge-best'
   *  = N agents solve the same task independently, then a judge role picks/merges the best solution.
   *  Only meaningful with team:'per-task' (the agents don't coordinate DURING — they aggregate AFTER). */
  aggregate: z.enum(['none', 'judge-best']).default('none'),
  /** Intra-team COORDINATOR (the hierarchical pole — benchmark-coordination-topologies). 'none' = flat
   *  (peers self-organize, no lead); 'elected-lead' = ONE lead agent runs a coordination pass over the
   *  team's backlog (plan/assign/strategize, charged as coordination overhead against the iso-budget),
   *  then the workers execute under it. Distinct from `kind:'hive'` central placement: the lead is a PEER
   *  WITHIN the team, not the system Queen. Tests whether an in-team coordinator beats flat self-claim. */
  coordinator: z.enum(['none', 'elected-lead']).default('none'),
  /** Enforce a coordination DISCIPLINE by gating which coord/* tools roles may use (e.g. a
   *  blackboard-only topology forbids `coord:send`). `allow` = allow-list; `forbid` = deny-list. */
  discipline: z
    .object({ allow: z.array(z.string()).optional(), forbid: z.array(z.string()).optional() })
    .optional(),
});

/**
 * One HARNESS-PROVIDED deterministic step-op the blueprint ships
 * (`harness-provided-cadence-ops-2026-06-26` D-001). A blueprint may declare ops
 * its spine references (`spine.steps[].op` / a gate-branch `op`) WITHOUT the op
 * being compiled into operator-core: on admission the platform registers a PROXY
 * CoordOp per entry into the coord-op registry — so `validateBlueprint({knownOps})`
 * resolves it and `coordProgramWorkflow` checkpoints it exactly like a built-in op
 * — and the proxy's `run()` DISPATCHES the call over the harness transport to the
 * harness's OWN runtime (its sidecar / deployed frame), which executes the op
 * against its connectors/DB and returns a result the proxy validates against
 * `resultSchema`. Out-of-process BY DESIGN: operator-core never loads or imports
 * harness code (the security + repo/process/DB isolation boundary, D-001). This
 * generalizes the hand-wired `setOddsmithProspectDeps` bridge into a first-class
 * mechanism. Schemas are JSON Schema (NOT Zod fns) because the manifest crosses the
 * repo boundary + is persisted/serialized; the registrar compiles them to the
 * proxy's args/result validators.
 */
export const OpManifestEntrySchema = z.object({
  /** The op name the spine references (`<domain>:<verb>`, e.g. `oddsmith:prospect`).
   *  Must match a `spine.steps[].op` / gate-branch `op`; registered as a proxy CoordOp. */
  name: z.string().min(1),
  /** One line: what the op does (surfaced in the registry / tool projection). */
  description: z.string().default(''),
  /** JSON Schema for the op's args — compiled to the proxy's `argsSchema` so the
   *  program runner validates interpolated step args before dispatch. `{}` ⇒ accept any. */
  argsSchema: z.record(z.string(), z.unknown()).default({}),
  /** JSON Schema for the op's result — the proxy validates the harness's response
   *  against this before binding it into program data (the trust boundary). `{}` ⇒ accept any. */
  resultSchema: z.record(z.string(), z.unknown()).default({}),
  /** How the proxy reaches the implementation. `'dispatch'` (the only kind today):
   *  POST to the harness runtime's `/api/op/<name>` over the harness transport. */
  handler: z.object({ kind: z.literal('dispatch').default('dispatch') }).prefault({}),
});

// A blueprint operation is an externally invocable task definition. It lives in
// the existing blueprint document, separate from `ops` (harness-provided
// deterministic spine steps). The composition compiler pins this whole manifest
// in its immutable specificationRevision; P-004 admission must verify the
// referenced hashes against their owning stores before accepting work.
const OperationNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]*$/);
const OperationContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex');
const OperationReferenceFields = {
  ref: z.string().min(1),
  revision: z.string().min(1),
  contentHash: OperationContentHashSchema,
};
const PlanTemplateOperationRefSchema = z.object({ kind: z.literal('plan-template'), ...OperationReferenceFields }).strict();
const RecipeOperationRefSchema = z.object({ kind: z.literal('recipe'), ...OperationReferenceFields }).strict();
const ArtifactOperationRefSchema = z.object({ kind: z.literal('artifact'), ...OperationReferenceFields }).strict();
const IdentityOperationRefSchema = z.object({ kind: z.literal('identity'), ...OperationReferenceFields }).strict();
const BlueprintOperationRefSchema = z.object({ kind: z.literal('blueprint'), ...OperationReferenceFields }).strict();
const RubricOperationRefSchema = z.object({ kind: z.literal('rubric'), ...OperationReferenceFields }).strict();
export const BlueprintOperationPinnedRefSchema = z.discriminatedUnion('kind', [
  PlanTemplateOperationRefSchema,
  RecipeOperationRefSchema,
  ArtifactOperationRefSchema,
  IdentityOperationRefSchema,
  BlueprintOperationRefSchema,
  RubricOperationRefSchema,
]);

/** JSON Schema crosses the blueprint/PG/process boundary as data, not a Zod fn.
 * Empty schemas would silently accept anything in the existing JSON-Schema
 * adapter, so an operation must declare at least a root type/union/literal. */
const OperationJsonTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const OperationJsonSchema = z.record(z.string(), z.unknown()).refine(
  (schema) => {
    const validType = schema.type === undefined ||
      (typeof schema.type === 'string' && OperationJsonTypes.has(schema.type)) ||
      (Array.isArray(schema.type) && schema.type.length > 0 && schema.type.every((type) => typeof type === 'string' && OperationJsonTypes.has(type)));
    const typed = schema.type !== undefined ||
      (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) ||
      (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) ||
      (Array.isArray(schema.enum) && schema.enum.length > 0) ||
      Object.prototype.hasOwnProperty.call(schema, 'const');
    return validType && typed;
  },
  'operation JSON Schema must declare type, anyOf, oneOf, enum, or const',
);
const OperationInputSchema = OperationJsonSchema.refine(
  (schema) => schema.type === 'object',
  'operation inputSchema must declare a top-level object',
);
const OperationModelPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('exact'), models: z.tuple([z.string().min(1)]), effort: z.string().min(1).optional(), onUnavailable: z.enum(['wait', 'fail']).default('wait') }).strict(),
  z.object({ mode: z.literal('allowed'), models: z.array(z.string().min(1)).min(1), effort: z.string().min(1).optional(), onUnavailable: z.enum(['wait', 'fail']).default('wait') }).strict(),
  z.object({ mode: z.literal('preferred'), models: z.array(z.string().min(1)).min(1), effort: z.string().min(1).optional(), onUnavailable: z.enum(['wait', 'fail']).default('wait') }).strict(),
]);

export const BlueprintOperationSchema = z.object({
  id: OperationNameSchema,
  version: z.string().min(1),
  description: z.string().optional(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('work-item'), itemKind: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('plan'), template: PlanTemplateOperationRefSchema }).strict(),
  ]),
  execution: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('agent'), role: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('program'), blueprint: BlueprintOperationRefSchema.optional() }).strict(),
    z.object({ kind: z.literal('recipe'), recipe: RecipeOperationRefSchema }).strict(),
  ]).optional(),
  inputSchema: OperationInputSchema,
  acceptance: z.object({
    resultSchema: OperationJsonSchema,
    rubric: RubricOperationRefSchema.optional(),
  }).strict(),
  // These are requirements to intersect with the live principal/role ceiling;
  // a blueprint declaration never grants a tool or revives a revoked grant.
  policy: z.object({
    identity: IdentityOperationRefSchema.optional(),
    requiredTools: z.array(z.string().min(1)).default([]),
    model: OperationModelPolicySchema.optional(),
  }).prefault({}),
  artifacts: z.array(ArtifactOperationRefSchema).default([]),
  signals: z.record(OperationNameSchema, z.object({ payloadSchema: OperationJsonSchema }).strict()).default({}),
  waits: z.record(OperationNameSchema, z.object({ responseSchema: OperationJsonSchema }).strict()).default({}),
}).strict().superRefine((operation, context) => {
  // Only a direct agent work item has an applied worker receipt and a
  // provider response seam. A plan/program/recipe result cannot attest the
  // operation-level model policy, so reject it before admission creates work.
  if (operation.policy.model &&
      (operation.target.kind !== 'work-item' || operation.execution?.kind !== 'agent')) {
    context.addIssue({ code: 'custom', path: ['policy', 'model'],
      message: 'model policy requires a direct agent work-item operation' });
  }
});
export type BlueprintOperation = z.infer<typeof BlueprintOperationSchema>;

// ── identities-v1-2026-08-30 P-001: the identity extension of the blueprint document ──
//
// An identity IS a blueprint document (D-013 — no parallel store, no new Cupboard
// kind): the same schema, loader, extends-walk and projection. The five sections
// below are what P-001 ADDS so a document can be an identity. `slots:` is the
// discriminator — present (even empty) ⇒ identity; absent ⇒ ordinary blueprint —
// so it stays `.optional()` with NO default (a default would erase the distinction).

/**
 * One slot the document fills (D-007). `slot` is an OPEN string validated
 * against the slot registry by `validateBlueprint` (`slot-unknown`), mirroring
 * `unknown-op`: a new axis is a registry row (`slots.ts`), never a document-
 * format change, and an installed identity naming a slot this platform does not
 * know fails with a diagnosable validation issue rather than a parse throw.
 * `cardinality` is OPTIONAL and, when present, must AGREE with the registry
 * (`slot-cardinality-mismatch`) — the registry is authoritative; the restatement
 * is for the reader.
 */
export const SlotDeclarationSchema = z.object({
  slot: z.string().min(1),
  cardinality: z.enum(['exclusive', 'additive']).optional(),
});

/**
 * A Cupboard item bundled BY REFERENCE (D-011: ONE uniform list for every
 * distributable layer — recipes, rubrics, knowledge packs, datatypes, event
 * vocabularies and rules — never a bespoke field per layer, never a by-value
 * copy). `kind` is the CLOSED D-011 vocabulary (`BUNDLE_KINDS`; no `skill`).
 * `ref` is the listing id; `version` pins a listing version when the stack must.
 */
export const BundleRefSchema = z
  .object({
    kind: z.enum(BUNDLE_KINDS),
    ref: z.string().min(1),
    version: z.string().min(1).optional(),
    /**
     * An intentional exact-pin override (D-029). The higher-precedence layer
     * names every exact version it replaces and records why. Merely restating a
     * keyed bundle at a different version is a conflict, never an implicit win.
     */
    versionOverride: z
      .object({
        replaces: z.array(z.string().min(1)).min(1),
        reason: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    if (!bundle.versionOverride) return;
    if (!bundle.version) {
      ctx.addIssue({ code: 'custom', path: ['version'], message: 'versionOverride requires the replacement version' });
    }
    if (bundle.version && bundle.versionOverride.replaces.includes(bundle.version)) {
      ctx.addIssue({ code: 'custom', path: ['versionOverride', 'replaces'], message: 'an override cannot replace its own version' });
    }
    if (new Set(bundle.versionOverride.replaces).size !== bundle.versionOverride.replaces.length) {
      ctx.addIssue({ code: 'custom', path: ['versionOverride', 'replaces'], message: 'replaced versions must be unique' });
    }
  });

/** A portable capability-class request: namespaced id + major only. The pinned
 * input always records the exact `class@version` the pot selected. */
export const CAPABILITY_CLASS_MAJOR_REF = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+@(?:0|[1-9][0-9]*)$/;

/** An exact registered class version — the key a pot binding is stored under:
 * the registry's class id grammar + `@` + its semver grammar (operator-core
 * capability-class-registry-store, pinned by a test there). Grants name these;
 * a tool id is never a capability need (portable-identity-packages D-040). */
export const CAPABILITY_CLASS_EXACT_REF = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** One component contribution bound to an existing compiled input. The source and
 * refresh metadata describe how the input is produced; they never grant authority.
 * Package refs use `<packageKind>:<ref>` so the exact package pin is unambiguous. */
export const BlueprintContributionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  purpose: z.enum(['prompt', 'resource', 'operational']),
  source: z.enum(['fixed', 'provider']),
  refresh: z.enum(['source-change', 'launch', 'turn', 'on-demand']),
  inputKind: z.enum(['prompt-file', 'addressed-document', 'package', 'capability-provider', 'setting']),
  ref: z.string().min(1),
  /** Existing producer/service reference; required for generated contributions. */
  producerRef: z.string().min(1).optional(),
  /** A generated provider may be conditionally absent. The caller must still
   * supply an explicit omission receipt; absence alone is never success. */
  availability: z.enum(['required', 'optional']).optional(),
  /** Context capability (portable-identity-packages P-004): a capability-provider
   * contribution that names a portable `class@major` also names the contract verb
   * whose output it contributes. The pot's binding supplies the implementation, so
   * the class itself is the declared producer and `producerRef` must equal `ref`.
   * A setting or prompt-file provider names the verb of its first-party class
   * (P-005, D-039). */
  verb: z.string().regex(/^[a-z][a-zA-Z0-9_.-]*$/).max(120).optional(),
  /** Declared injection point (portable-identity-packages P-010): the sink(s),
   * trigger, token budget, priority and over-budget behavior of this provider's
   * output. A request only; the host allocates one aggregate budget per sink. */
  injection: InjectionPointSchema.optional(),
}).strict().superRefine((value, ctx) => {
  // Shape errors already surface from the `injection` field itself; add only the
  // cross-field rules (provider source, injectable kind, renderable sink, cadence).
  if (value.injection !== undefined && InjectionPointSchema.safeParse(value.injection).success) {
    for (const issue of validateInjectionPoint(value)) {
      ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
    }
  }
  const majorRef = CAPABILITY_CLASS_MAJOR_REF.test(value.ref);
  if (value.verb !== undefined && value.source !== 'provider') {
    ctx.addIssue({ code: 'custom', path: ['verb'], message: 'only a provider contribution names a verb' });
  }
  // D-003/D-039: a provider names the class@major that produces it, never a
  // function path. A setting or prompt-file output has an in-process producer,
  // so it must name a first-party class whose verb and output kind match.
  if (value.producerRef !== undefined && !CAPABILITY_CLASS_MAJOR_REF.test(value.producerRef)) {
    ctx.addIssue({ code: 'custom', path: ['producerRef'], message: 'producerRef names a class@major, not a function path' });
  }
  if (value.source === 'provider' && value.inputKind !== 'capability-provider' && value.producerRef !== undefined &&
      CAPABILITY_CLASS_MAJOR_REF.test(value.producerRef)) {
    const firstParty = resolveFirstPartyContextClass(value.producerRef);
    if (!firstParty) {
      ctx.addIssue({ code: 'custom', path: ['producerRef'], message: `${value.inputKind} output needs a first-party class; ${value.producerRef} has no in-process provider` });
    } else {
      if (value.verb !== firstParty.verb) {
        ctx.addIssue({ code: 'custom', path: ['verb'], message: `${firstParty.id} is produced by its ${firstParty.verb} verb` });
      }
      if (FIRST_PARTY_INPUT_KIND[firstParty.outputKind] !== value.inputKind) {
        ctx.addIssue({ code: 'custom', path: ['inputKind'], message: `${firstParty.id} outputs ${firstParty.outputKind}, which binds ${FIRST_PARTY_INPUT_KIND[firstParty.outputKind]}` });
      }
    }
  }
  if (value.inputKind === 'capability-provider' && majorRef && value.verb === undefined) {
    ctx.addIssue({ code: 'custom', path: ['verb'], message: 'a class@major context capability names its contract verb' });
  }
  if (value.verb !== undefined && value.inputKind === 'capability-provider' && !majorRef) {
    ctx.addIssue({ code: 'custom', path: ['ref'], message: 'a context capability names a portable class@major, not an exact version' });
  }
  if (value.verb !== undefined && value.inputKind === 'capability-provider' && value.producerRef !== undefined &&
      value.producerRef !== value.ref) {
    ctx.addIssue({ code: 'custom', path: ['producerRef'], message: 'a context capability is produced by its class; producerRef must equal ref' });
  }
  const kinds = {
    prompt: ['prompt-file', 'addressed-document'],
    resource: ['package', 'capability-provider'],
    operational: ['setting'],
  } as const;
  if (!(kinds[value.purpose] as readonly string[]).includes(value.inputKind)) {
    ctx.addIssue({ code: 'custom', path: ['inputKind'], message: `${value.purpose} cannot bind ${value.inputKind}` });
  }
  if (value.source === 'fixed' && value.refresh !== 'source-change') {
    ctx.addIssue({ code: 'custom', path: ['refresh'], message: 'fixed content refreshes on source-change' });
  }
  if (value.source === 'provider' && value.refresh === 'source-change') {
    ctx.addIssue({ code: 'custom', path: ['refresh'], message: 'provider content needs launch, turn or on-demand refresh' });
  }
  if (value.source === 'provider' && !value.producerRef) {
    ctx.addIssue({ code: 'custom', path: ['producerRef'], message: 'provider contribution needs producerRef' });
  }
  if (value.source === 'fixed' && value.producerRef) {
    ctx.addIssue({ code: 'custom', path: ['producerRef'], message: 'fixed content does not name a provider' });
  }
  if ((value.inputKind === 'addressed-document' || value.inputKind === 'package') && value.source !== 'fixed') {
    ctx.addIssue({ code: 'custom', path: ['source'], message: `${value.inputKind} is fixed content` });
  }
  if ((value.inputKind === 'capability-provider' || value.inputKind === 'setting') && value.source !== 'provider') {
    ctx.addIssue({ code: 'custom', path: ['source'], message: `${value.inputKind} is supplied by a provider` });
  }
});

/** Trusted build metadata feeds the existing runtime mode APIs. `policyRef`
 * names code-backed enforcement; installed definitions cannot change the
 * built-in activation metadata, even with a moderated text replacement. */
export const BlueprintModeDeclarationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  policyRef: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  title: z.string().trim().min(1),
  oneLiner: z.string().trim().min(1).refine((value) => !value.includes('\n'), 'oneLiner must be one line'),
  definitionContributionId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  implies: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)).max(16)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate mode implication').optional(),
  requiresSubject: z.boolean().optional(),
  launchable: z.boolean().optional(),
  /** Runtime carry variants share this identity and its host policy. */
  aliases: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    title: z.string().trim().min(1),
    oneLiner: z.string().trim().min(1).refine((value) => !value.includes('\n'), 'oneLiner must be one line'),
    definitionHeading: z.string().regex(/^#{1,6} [^\n]+$/),
    implies: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)).max(16),
    requiresSubject: z.boolean(),
    launchable: z.boolean(),
  }).strict()).max(16).optional(),
  /** An approved replacement must name the exact catalog revision it supersedes. */
  replacesRevision: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex').optional(),
}).strict();

/**
 * Grants name registered capability CLASSES at exact class@version refs, split
 * into `requires` (blocks install until satisfied) and `optional` (installs with
 * a visible gap), with publisher `suggestedProviders` hints (class → provider).
 * Install-time resolution and provider selection are P-017; runtime grants still
 * narrow the pot/role ceiling and never widen it (D-004/D-005).
 */
const GrantClassRefSchema = z.string().regex(CAPABILITY_CLASS_EXACT_REF,
  'a grant names a capability class at an exact class@version, never a tool id');

export const GrantsSchema = z.object({
  requires: z.array(GrantClassRefSchema).default([]),
  optional: z.array(GrantClassRefSchema).default([]),
  suggestedProviders: z.record(z.string(), z.string()).default({}),
});

/** Who publishes this layer (the publisher/author of P-001's manifest). */
export const PublisherSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  url: z.string().optional(),
});

/**
 * Publisher attestation over THIS layer's content: `contentHash` must equal the
 * layer's own content hash (`layerContentHash` — sha256 over the raw document
 * with `attestation` itself excluded; the loader checks it,
 * `attestation-hash-mismatch`). `signature` / `signedBy` bind it to a publisher
 * key (M2 reuses `lib/identity/attest.ts` + `hive-keypair.ts`); the format check
 * is the schema's, the signature check is the installer's.
 */
export const AttestationSchema = z.object({
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex'),
  signedBy: z.string().min(1),
  signature: z.string().optional(),
  signedAt: z.string().optional(),
});

export const BlueprintSchema = z.object({
  id: z.string().min(1),
  /** Parent blueprint id(s); resolved local → installed → built-in. */
  extends: z.union([z.string(), z.array(z.string())]).optional(),
  /**
   * The privileged-blueprint discriminator (swarm-coordination D-018 / local-hive
   * D-009). `'harness'` (the default — every existing blueprint, no field needed)
   * is a general harness: a pipeline/research/gym/launch blueprint that recurses
   * freely (a bee spins one up for structured work). `'hive'` is the privileged
   * Queen blueprint (the `pot`): launchable ONLY as a ROOT, never with a parent —
   * hives are flat PEERS, never nested (the no-nest guard, `assertNotNestedHive`,
   * enforces this in code so a stray child-hive launch can't break the flat-peer
   * budget-federation invariant). Additive + optional-with-default, so every
   * pre-existing blueprint parses unchanged as a `'harness'`.
   */
  // pot-rename SLICE-2 CONTRACT: `pot` is the canonical privileged kind (was
  // `hive`; every shipped blueprint.yaml now declares pot/harness and the
  // blueprints projection table held no legacy rows at contract time). A
  // kind:'pot' blueprint still provisions a harness_kind:'hive' home; the p2p
  // Hive ENTITY name is unchanged — intentional asymmetry.
  kind: z.enum(['pot', 'harness']).default('harness'),
  version: z.string().default('0.1.0'),
  description: z.string().optional(),
  /**
   * Structured retirement marker (WI-5645 — no-retirement-launch-guard). Before
   * this, "retired" was ONLY a human-readable convention inside `description`
   * (see CLAUDE.md "Retired / preserved-not-active surfaces") — nothing machine
   * checked it, so an autoloop (gym or otherwise) could spend real LLM cost
   * against a blueprint everyone believed was dormant (EI-18177667809538623:
   * $14.51+ spent optimizing the retired `coding-factory` via `external-bench`,
   * which `extends: coding-factory`).
   *
   * Deep-merges like any other object field (loader.ts `mergeRaw`): a child that
   * does not declare its own `retired` INHERITS its parent's — retirement
   * propagates down an `extends` chain by default, so marking an ancestor
   * retired automatically retires every undeclared descendant. A child may
   * explicitly REVIVE by setting `retired: null` (a non-plain-object child value
   * replaces the parent's wholesale, per `mergeRaw`).
   *
   * Read via `blueprintRetirement()` (retirement.ts) — the one place that turns
   * this into a launch-eligibility verdict; don't hand-check `.retired` at call
   * sites.
   */
  retired: z
    .object({
      /** When it was retired (free-form — a date or a plan/decision reference). */
      at: z.string().optional(),
      /** Why, and what (if anything) it takes to revive it. */
      reason: z.string().optional(),
    })
    .nullable()
    .optional(),
  workItem: WorkItemSchema,
  roles: z.array(BlueprintRoleSchema).default([]),
  spine: SpineSchema,
  // `.prefault({})` (not `.default`) so an absent field is parsed THROUGH the
  // sub-schema — filling its inner defaults fully and idempotently. A plain
  // `.default({})` short-circuits and would leave inner defaults unfilled until
  // a second parse (breaking validator-of-record round-tripping).
  planner: PlannerSchema.prefault({}),
  reactive: z.array(ReactiveRuleSchema).default([]),
  gates: GatesSchema.prefault({}),
  recursion: RecursionSchema.prefault({}),
  gym: GymSchema.optional(),
  /** Hive/harness DOMAIN-PROFILE sections (hive-blueprint-generalization Phase 3).
   *  Optional + additive: an absent section ⇒ undefined and the consumer applies the
   *  default kind, so every pre-existing blueprint parses unchanged. The concrete
   *  hives override (generic-hive: judge / artifacts / topic-overlap; coding-hive:
   *  tests / repo-commit / file-overlap). */
  acceptance: AcceptanceSchema.optional(),
  output: OutputSchema.optional(),
  affinity: AffinitySchema.optional(),
  /** Hive fleet/policy sections — the rest of the domain profile (Phase 4). All
   *  optional + additive: a non-hive blueprint declares none. Lifted from the
   *  hardcoded create/runtime path so a hive blueprint is self-describing. */
  lexicon: LexiconSchema.optional(),
  fleet: FleetSchema.optional(),
  wake: WakeSchema.optional(),
  knowledge: KnowledgeSchema.optional(),
  learning: LearningSchema.optional(),
  placement: PlacementSchema.optional(),
  /** Declarative coordination protocol — HOW peers acquire work + communicate (CoordinationSchema).
   *  Optional + defaulted; absent ⇒ today's behavior (decider-dispatch + direct messages). Pairs with
   *  `spine.claimModel` to express central / flat-distributed / blackboard / pair / ensemble topologies. */
  coordination: CoordinationSchema.optional(),
  knobs: KnobsSchema.prefault({}),
  triggers: TriggersSchema.optional(),
  /** The autoloop dispatch policy (D-005). Optional: launch/program blueprints
   *  declare none and the orchestrator keeps its legacy config-only resolution. */
  dispatch: DispatchSchema.optional(),
  dependencies: DependenciesSchema.optional(),
  /** HARNESS-PROVIDED deterministic step-ops (harness-provided-cadence-ops D-001).
   *  Each entry's `name` is registered as a PROXY CoordOp on admission so the spine
   *  may reference an op that lives in + executes from the HARNESS (not operator-core);
   *  the proxy dispatches to the harness runtime. Additive + optional (default []) —
   *  a blueprint with no harness ops parses unchanged. */
  ops: z.array(OpManifestEntrySchema).default([]),
  /** Named external task operations. Absent on legacy blueprints to preserve
   *  their resolved configuration bytes and specification revisions. */
  operations: z.array(BlueprintOperationSchema).optional(),
  /** The build/run environment spec — "what to stand up on a frame" (P-007). The
   *  deployment driver reads it to bootstrap a cloud frame; absent ⇒ nothing to
   *  stand up (today's local-only behavior). */
  environment: EnvironmentSpecSchema.optional(),
  /** Declared UI-introspectable tunables (P-006 / D-003). Keyed by dot-path into the
   *  resolved config; `base` declares the universal params, a child ADDS its own (the
   *  record unions across `extends`). Default {} ⇒ no declared params (the schema-driven
   *  settings panel renders nothing extra for this blueprint). */
  params: ParamsSchema.default({}),
  // ── identities-v1 P-001 (D-007 / D-011 / D-013 / D-004) ────────────────────
  /** The slots this document fills — PRESENT ⇒ the document is an identity. No default. */
  slots: z.array(SlotDeclarationSchema).optional(),
  /** Cupboard items bundled by reference (D-011). Uniform across kinds; composes by union. */
  bundles: z.array(BundleRefSchema).default([]),
  /** Fixed and generated content, resource and operational declarations share one layer vocabulary. */
  contributions: z.array(BlueprintContributionSchema).optional(),
  /** Optional mode catalog view over this component; enforcement remains in the host registry. */
  mode: BlueprintModeDeclarationSchema.optional(),
  /** RESERVED capability-class grants (D-004; refused non-empty until M3 — D-014). */
  grants: GrantsSchema.optional(),
  /** The layer's publisher/author. */
  publisher: PublisherSchema.optional(),
  /** Publisher attestation over this layer's content (checked by the loader). */
  attestation: AttestationSchema.optional(),
});

// ── identities-v1 P-037: source / runnable / resolved / activation contracts ──

/**
 * A git-authored blueprint source before inheritance/default resolution.  Every
 * top-level field must belong to the one Blueprint envelope, but runnable-only
 * fields may be absent because abstract parents and identity modules are valid
 * source documents.  Parsing this schema is validation only; callers that need
 * the author's exact bytes/field presence should retain their original object.
 */
export const BlueprintSourceDocumentSchema = BlueprintSchema.partial()
  .extend({
    id: BlueprintSchema.shape.id,
    /** Package-catalog metadata consumed before resolution, not runtime configuration. */
    visibility: z.enum(['public', 'private']).optional(),
  })
  .strict();

/**
 * An identity SOURCE is a blueprint-envelope source with its own `slots:`
 * declaration. It may also be runnable (several adversarial and standalone
 * fixtures intentionally are); source kind and runnable capability are
 * orthogonal contracts rather than two mutually exclusive shapes.
 *
 * Contribution fields are nevertheless constrained: the strict parent schema
 * permits only package metadata plus fields derived from `BlueprintSchema`, and
 * slot-specific authority is enforced by `identity-lint` over those typed
 * fields. Unknown fields never disappear silently during resolution.
 */
export const IdentitySourceDocumentSchema = BlueprintSourceDocumentSchema.extend({
  slots: z.array(SlotDeclarationSchema),
});

export const BlueprintSourceKindSchema = z.enum(['blueprint', 'identity']);
export type BlueprintSourceKind = z.infer<typeof BlueprintSourceKindSchema>;
/** Schema-derived top-level contribution vocabulary; never a parallel hand-maintained list. */
export const BlueprintContributionFieldSchema = BlueprintSchema.keyof();
export type BlueprintContributionField = z.infer<typeof BlueprintContributionFieldSchema>;
const BLUEPRINT_CONTRIBUTION_FIELDS = new Set<string>(BlueprintContributionFieldSchema.options);

export function isBlueprintContributionField(value: string): value is BlueprintContributionField {
  return BLUEPRINT_CONTRIBUTION_FIELDS.has(value);
}
export type BlueprintSourceDocument = z.input<typeof BlueprintSourceDocumentSchema>;
export type IdentitySourceDocument = z.input<typeof IdentitySourceDocumentSchema>;

export type ParsedBlueprintSourceDocument =
  | { readonly kind: 'blueprint'; readonly document: BlueprintSourceDocument }
  | { readonly kind: 'identity'; readonly document: IdentitySourceDocument };

function hasOwnSlots(value: unknown): value is Record<string, unknown> & { slots: unknown } {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, 'slots');
}

/**
 * Validate and classify one authored layer BEFORE inheritance.  The returned
 * document is the caller's original object, not a default-filled Zod clone, so
 * own-field presence and the signed source content remain authoritative.
 */
export function parseBlueprintSourceDocument(value: unknown): ParsedBlueprintSourceDocument {
  if (hasOwnSlots(value)) {
    IdentitySourceDocumentSchema.parse(value);
    return { kind: 'identity', document: value as IdentitySourceDocument };
  }
  BlueprintSourceDocumentSchema.parse(value);
  return { kind: 'blueprint', document: value as BlueprintSourceDocument };
}

/** Type guard over an already-parsed SOURCE wrapper, never over a merged result. */
export function isIdentitySourceDocument(
  value: ParsedBlueprintSourceDocument,
): value is Extract<ParsedBlueprintSourceDocument, { kind: 'identity' }> {
  return value.kind === 'identity';
}

/**
 * A fully inherited/defaulted executable blueprint.  The brand prevents APIs
 * from accidentally accepting an authored fragment where execution requires a
 * resolved runnable configuration.
 */
export const RunnableBlueprintSchema = BlueprintSchema.brand<'RunnableBlueprint'>();
export type RunnableBlueprint = z.infer<typeof RunnableBlueprintSchema>;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex');

/** Package pins live in the existing specification closure, never a second lockfile. */
export const ResolvedPackageReferenceSchema = z.object({
  packageKind: z.enum(['blueprint', 'pack', 'plugin', ...BUNDLE_KINDS]),
  ref: z.string().min(1),
  revision: z.string().min(1),
  contentHash: Sha256Schema,
}).strict();

export const ResolvedPackageInputSchema = ResolvedPackageReferenceSchema.extend({
  kind: z.literal('package'),
  files: z.array(z.object({
    path: z.string().min(1),
    encoding: z.literal('base64'),
    bytes: z.string(),
    contentHash: Sha256Schema,
  }).strict()),
  dependencies: z.array(ResolvedPackageReferenceSchema),
  /** Parsed asset consumed by the existing seed/registration adapter, also hashed. */
  value: z.unknown().optional(),
}).strict();

export type ResolvedPackageReference = z.infer<typeof ResolvedPackageReferenceSchema>;
export type ResolvedPackageInput = z.infer<typeof ResolvedPackageInputSchema>;

/**
 * Pot-scoped capability-provider choice pinned into the same immutable input
 * closure as every other resolved launch input (identities-v1 P-017).
 */
export const ResolvedCapabilityProviderInputSchema = z
  .object({
    kind: z.literal('capability-provider'),
    ref: z.string().regex(
      /^[a-z0-9][a-z0-9.-]*@[0-9A-Za-z][0-9A-Za-z._+-]*$/,
      'exact normalized capability class@version ref',
    ),
    providerPackage: z.string().min(1),
    providerVersion: z.string().min(1),
    conformanceRunId: z.string().min(1),
    registryRevision: z.string().min(1),
    verbBindings: z.record(z.string(), z.string().min(1)),
    /** Present only for a context capability (portable-identity-packages P-004):
     * the portable request, the one contract verb it contributes, the contract's
     * output schema, and the explicit synchronous execution kind that was pinned.
     * Absent on plain grant providers, so their pinned bytes are unchanged. */
    context: z
      .object({
        requestedRef: z.string().regex(CAPABILITY_CLASS_MAJOR_REF, 'portable class@major ref'),
        verb: z.string().regex(/^[a-z][a-zA-Z0-9_.-]*$/).max(120),
        providerKind: z.enum(['tool', 'recipe']),
        latencyClass: z.literal('sync'),
        outputSchema: z.record(z.string(), z.unknown()),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ResolvedCapabilityProviderInput = z.infer<
  typeof ResolvedCapabilityProviderInputSchema
>;

export const ResolvedAgentInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('blueprint-layer'),
      ref: z.string().min(1),
      revision: z.string().min(1),
      contentHash: Sha256Schema,
      sourceKind: BlueprintSourceKindSchema,
      /** Authored source snapshot for offline replay; older artifacts may lack it. */
      document: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('prompt-file'),
      ref: z.string().min(1),
      contentHash: Sha256Schema,
      bytes: z.string(),
      producerRef: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('addressed-document'),
      ref: z.string().min(1),
      revision: z.string().min(1),
      contentHash: Sha256Schema,
      bytes: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('setting'),
      ref: z.string().min(1),
      revision: z.string().min(1),
      value: z.unknown(),
      producerRef: z.string().min(1).optional(),
    })
    .strict(),
  ResolvedCapabilityProviderInputSchema,
  ResolvedPackageInputSchema,
]);

const ResolvedAgentProvenanceSourceSchema = z
  .object({
    sourceRef: z.string().min(1),
    sourceRevision: z.string().min(1),
  })
  .strict();

export const ResolvedAgentProvenanceSchema = z
  .object({
    path: z.string().min(1),
    sourceRef: z.string().min(1),
    sourceRevision: z.string().min(1),
    producerRef: z.string().min(1).optional(),
    /** How the effective value was selected (declared/default/override/input). */
    decision: z.string().min(1).optional(),
    /** Every contributing source, retained when a value was overridden or unioned. */
    sources: z.array(ResolvedAgentProvenanceSourceSchema).min(1).optional(),
  })
  .strict();

export type ResolvedAgentInput = z.infer<typeof ResolvedAgentInputSchema>;
export type ResolvedAgentProvenance = z.infer<typeof ResolvedAgentProvenanceSchema>;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const RESOLVED_AGENT_SPECIFICATION_SCHEMA_VERSION = 1 as const;

/**
 * Immutable output contract for the P-038 composition compiler.  It requires
 * the exact runnable configuration, complete versioned input closure, prompt
 * bytes, addressed-document revisions and path-level provenance; P-038 owns
 * producing it, while P-037 establishes the validated boundary.
 */
export const ResolvedAgentSpecificationSchema = z
  .object({
    schemaVersion: z.literal(RESOLVED_AGENT_SPECIFICATION_SCHEMA_VERSION),
    specificationRevision: Sha256Schema,
    compilerVersion: z.string().min(1),
    source: z
      .object({
        id: z.string().min(1),
        kind: BlueprintSourceKindSchema,
        contentHash: Sha256Schema,
      })
      .strict(),
    configuration: z.union([RunnableBlueprintSchema, BlueprintSourceDocumentSchema]),
    inputs: z.array(ResolvedAgentInputSchema),
    provenance: z.array(ResolvedAgentProvenanceSchema),
  })
  .strict()
  .transform(deepFreeze);

export type ResolvedAgentSpecification = z.output<typeof ResolvedAgentSpecificationSchema>;

/** Accountable actor/session authority, deliberately independent of worn identity. */
export const ActorPrincipalSchema = z
  .object({
    actorId: z.string().min(1),
    principalId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

const ActivationRevisionSchema = z
  .object({
    specificationRevision: Sha256Schema,
    stateRevision: z.string().min(1),
  })
  .strict();

export const SESSION_ACTIVATION_SCHEMA_VERSION = 1 as const;

/**
 * Structural desired/prepared/applied contract.  P-040 owns acknowledgement,
 * retry and enforcement behavior; this type makes those states explicit now.
 */
export const SessionActivationSchema = z
  .object({
    schemaVersion: z.literal(SESSION_ACTIVATION_SCHEMA_VERSION),
    attribution: ActorPrincipalSchema,
    desired: ActivationRevisionSchema,
    prepared: ActivationRevisionSchema.nullable(),
    applied: ActivationRevisionSchema.nullable(),
    status: z.enum(['desired', 'prepared', 'applied', 'failed']),
    failure: z.string().min(1).optional(),
  })
  .strict()
  .transform(deepFreeze);

export type ActorPrincipal = z.infer<typeof ActorPrincipalSchema>;
export type SessionActivation = z.output<typeof SessionActivationSchema>;

/**
 * Shape-only compatibility name for pre-P-037 callers. It cannot distinguish a
 * raw source from a resolved runnable and therefore MUST NOT drive new source
 * classification. Remove after all call sites use the parsed source wrapper and
 * the P-038 compiler is the sole resolved-specification producer (CONTRACTS.md).
 */
export function isIdentityDocument(value: Pick<Blueprint, 'slots'>): boolean {
  return value.slots != null;
}

/**
 * The on-disk header — just enough to read `id` + `extends` from a raw file
 * before the inheritance merge (the merge happens on the raw plain objects; the
 * merged result is then parsed through `BlueprintSchema`). `.loose()` keeps
 * every other field so the loader can hand the whole object to the merge.
 */
export const BlueprintHeaderSchema = z.looseObject({
  id: z.string().min(1),
  extends: z.union([z.string(), z.array(z.string())]).optional(),
});

export type Blueprint = z.infer<typeof BlueprintSchema>;
/** The privileged-blueprint kind (`'pot' | 'harness'`, default `'harness'`; `pot`
 *  was `hive` before the D-007 rename — the enum is contracted to pot-only. A
 *  kind:'pot' blueprint still provisions a `harness_kind:'hive'` home: the p2p
 *  Hive ENTITY name is unchanged, the intentional federation asymmetry). */
export type BlueprintKind = z.infer<typeof BlueprintSchema.shape.kind>;
export type BlueprintSpine = z.infer<typeof SpineSchema>;
export type SpineAction = z.infer<typeof SpineActionSchema>;
export type CoordOpStep = z.infer<typeof CoordOpStepSchema>;
export type GateBranch = z.infer<typeof GateBranchSchema>;
export type BlueprintRole = z.infer<typeof BlueprintRoleSchema>;
export type BlueprintWorkItem = z.infer<typeof WorkItemSchema>;
export type BlueprintReactiveRule = z.infer<typeof ReactiveRuleSchema>;
export type BlueprintGates = z.infer<typeof GatesSchema>;
/** A single `gates.finalize.onDone`/`onEscalate` entry — see FinalizeEntrySchema. */
export type BlueprintFinalizeEntry = z.infer<typeof FinalizeEntrySchema>;
export type BlueprintRecursion = z.infer<typeof RecursionSchema>;
export type BlueprintGym = z.infer<typeof GymSchema>;
export type BlueprintKnobs = z.infer<typeof KnobsSchema>;
export type BlueprintTriggers = z.infer<typeof TriggersSchema>;
export type BlueprintDispatch = z.infer<typeof DispatchSchema>;
/** The structured `retired` marker's shape (WI-5645) — see `BlueprintSchema.retired`. */
export type BlueprintRetired = z.infer<typeof BlueprintSchema.shape.retired>;
export type BlueprintEnvironment = z.infer<typeof EnvironmentSpecSchema>;
export type BlueprintEnvService = z.infer<typeof EnvServiceSchema>;
export type BlueprintHeader = z.infer<typeof BlueprintHeaderSchema>;
/** A single declared, UI-introspectable tunable (P-006 / D-003). */
export type ParamSpec = z.infer<typeof ParamSpecSchema>;
export type ParamOption = z.infer<typeof ParamOptionSchema>;
/** The blueprint's declared params, keyed by dot-path into the resolved config. */
export type BlueprintParams = z.infer<typeof ParamsSchema>;
// identities-v1 P-001 — the identity extension's types.
/** One `slots[]` entry: the slot filled + an optional (registry-agreeing) cardinality restatement. */
export type SlotDeclaration = z.infer<typeof SlotDeclarationSchema>;
/** One `bundles[]` entry: a Cupboard item by reference (D-011). */
export type BundleRef = z.infer<typeof BundleRefSchema>;
export type BlueprintContribution = z.infer<typeof BlueprintContributionSchema>;
export type BlueprintModeDeclaration = z.infer<typeof BlueprintModeDeclarationSchema>;
/** The RESERVED grants section (D-004 / D-014). */
export type BlueprintGrants = z.infer<typeof GrantsSchema>;
export type BlueprintPublisher = z.infer<typeof PublisherSchema>;
export type BlueprintAttestation = z.infer<typeof AttestationSchema>;
