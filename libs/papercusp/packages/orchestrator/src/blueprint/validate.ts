/**
 * `validateBlueprint` — semantic validation of a resolved blueprint, beyond what
 * the Zod schema enforces structurally (`harness-blueprint-orchestration-2026-06-03`
 * P-005 / A4). Run author-time (the `blueprint:*` tools) AND on load (the
 * loader), so a malformed spine never reaches the durable pipeline.
 *
 * Pure. Checks, per the A4 spec:
 *   - reachability — every declared role is referenced somewhere; at least one
 *     terminal outcome is reachable.
 *   - termination — a terminal is reachable and `maxTurns` is finite/positive.
 *   - every node has an exit — every spine edge maps to a valid action (the
 *     schema guarantees this) and a `default` exists.
 *   - guards well-formed — reactive rules carry at least one condition.
 *   - bounded recursion — recursion, when enabled, declares a trigger and a
 *     finite depth.
 *   - work-item payload valid — `workItem.kind` is present (schema-enforced).
 *
 * `errors` make a blueprint unrunnable (reject); `warnings` are authoring smells
 * (e.g. a spine edge that dispatches a role with no prompt — the vestigial
 * tester/test-writer/monitor verbs kept for switch parity) that don't block.
 */
import type { Blueprint } from './schema.js';
import { finalizeEntryRole } from './schema.js';
import { dataConditionSchema } from '@papercusp/rules';
import { CHILD_BLUEPRINT_PARAM_RE, isChildBlueprintParam } from './resolve-child.js';
import { RESERVED_LAYERS, SLOT_IDS, slotSpec } from './slots.js';

/** A step/gate `when` is valid iff it's a serializable `@papercusp/rules` DataCondition. */
function isValidWhen(when: unknown): boolean {
  return dataConditionSchema.safeParse(when).success;
}

export interface BlueprintIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

export interface BlueprintValidation {
  ok: boolean;
  errors: BlueprintIssue[];
  warnings: BlueprintIssue[];
}

export interface ValidateOptions {
  /**
   * The set of registered coord-op names (the coord-op registry's keys). When
   * provided, a program step / gate branch that names an op NOT in the set is an
   * error (`unknown-op`). The pure lib doesn't own the registry (it lives in
   * operator-core — D-001/D-004), so the operator passes this on load/projection;
   * omitted → the op-name check is skipped (author-time validation in the lib
   * still catches every structural + expression problem).
   */
  knownOps?: Set<string>;
  /**
   * The set of LIVE agent-role ids — the `AGENT_ROLES` registry's keys
   * (`deterministic-blueprints-migration-2026-06-13` P-001). When provided, the
   * "undeclared role" warning family (`decider-undeclared`,
   * `dispatch-undeclared-role`, `reactive-undeclared-role`,
   * `reactive-unknown-anchor`, `finalize-unknown-role`) is SUPPRESSED for a role
   * that is a live agent role: a spine may reference a built-in role (e.g.
   * `worker`) without re-declaring it in `roles[]` — prompt-resolve resolves it
   * via the global persona fallback, so it is NOT a ghost. A role that is neither
   * declared NOR live still warns (a genuine typo / dead role). Same layering as
   * `knownOps` — the pure lib doesn't own the role registry (it lives in
   * `@papercusp/agent-mcp` / operator-core), so the operator passes it on
   * load/projection/authoring; omitted → the checks fall back to declared-only
   * (the pre-P-001 behavior, so every existing caller is byte-unchanged).
   */
  knownRoles?: Set<string>;
}

const TERMINAL = new Set(['done', 'escalate', 'idle']);
/** Ephemeral-tier cadence floor (seconds) + the coarseness above which durable cron is the better fit (P-010 / D-006). */
const EPHEMERAL_MIN_INTERVAL_SEC = 1;
const EPHEMERAL_SUGGEST_DURABLE_SEC = 60;
/**
 * WI-1406487: the cadence above which an ephemeral schedule is not merely coarse but
 * STRUCTURALLY UNFIREABLE, so it is an ERROR rather than the advisory warning above.
 *
 * The ephemeral executor arms an in-process `managedSetInterval` (ephemeral-executor.ts
 * `armOne`), which accrues NO progress across a process restart — it re-arms from zero on
 * every bg-host boot. So an ephemeral routine can only ever fire if its period is shorter
 * than the host's mean time between restarts. `corpus-term-df` sat at 21600s (360 min)
 * against a measured maximum bg-host uptime of 336 min and therefore never fired ONCE in
 * 35.7h — while reporting `active:true` and logging an "armed" line on every boot, with no
 * error anywhere. The soft `ephemeral-interval-coarse` warning below already covered it and
 * was not enough, because a warning ships.
 *
 * 3600s is chosen against evidence, not taste: the longest surviving ephemeral cadence is
 * `pot-git-gc` at exactly 3600s (so `>` keeps it legal), and that leaves ~5.6x margin under
 * the 336-min observed uptime ceiling. Anything coarser belongs on the durable tier, whose
 * `next_fire_at` is a Postgres column and therefore survives the restart.
 */
const EPHEMERAL_MAX_INTERVAL_SEC = 3600;
/** The default schedule action — a whole blueprint RUN; forbidden for the deterministic ephemeral tier. */
const BLUEPRINT_RUN_ACTION = 'system:blueprint-run';
/** Finalize-recipe entries that are pipeline STEPS, not dispatchable roles. */
const FINALIZE_STEPS = new Set(['archive', 'postCuratorOutputs']);

export function validateBlueprint(bp: Blueprint, opts: ValidateOptions = {}): BlueprintValidation {
  const errors: BlueprintIssue[] = [];
  const warnings: BlueprintIssue[] = [];
  const err = (code: string, message: string) => errors.push({ level: 'error', code, message });
  const warn = (code: string, message: string) => warnings.push({ level: 'warning', code, message });

  const roleIds = new Set(bp.roles.map((r) => r.id));
  // A role REFERENCE is "live" if the blueprint declares it OR it is a live agent
  // role the operator passed in `knownRoles` (P-001 — the global-persona-fallback
  // case). Without `knownRoles` this is just `roleIds.has`, so the no-opts default
  // is byte-identical to the pre-P-001 behavior.
  const isLiveRole = (id: string): boolean => roleIds.has(id) || (opts.knownRoles?.has(id) ?? false);

  // ── role declarations ──────────────────────────────────────────────────────
  const seen = new Set<string>();
  for (const r of bp.roles) {
    if (seen.has(r.id)) err('duplicate-role', `role "${r.id}" is declared more than once`);
    seen.add(r.id);
  }

  // One authored fact must have one authority. These blueprint fields grew at
  // different times and several pairs look interchangeable in YAML even though
  // their consumers give them different force (P-033). Reject the ambiguous
  // combinations at the authoring/load chokepoint instead of letting whichever
  // reader happens to run first decide which declaration wins.
  validateDeclarationAuthorities(bp, err, warn);

  if (!Number.isFinite(bp.spine.maxTurns) || bp.spine.maxTurns < 1) {
    err('bad-max-turns', `spine.maxTurns must be a finite positive integer (got ${bp.spine.maxTurns})`);
  }

  // ── identity extension: slots / bundles / grants (identities-v1 P-001) ─────
  validateIdentityDeclarations(bp, err);
  validateOperationDeclarations(bp, isLiveRole, err);

  // ── spine mode: a spine declares EXACTLY ONE model (D-002) ──────────────────
  const hasEdges = bp.spine.edges != null && Object.keys(bp.spine.edges).length > 0;
  const hasSteps = bp.spine.steps != null && bp.spine.steps.length > 0;
  const dispatched = new Set<string>();
  // A SELF-CLAIM spine (claimModel: self-claim-* — the flat-distributed topologies) has NO central
  // decider and NO program: peer agents pull the next ready work-item themselves and run their worker
  // role end-to-end. So "neither edges nor steps" is VALID under self-claim (the claim loop IS the
  // orchestration). decider-dispatch still requires exactly one model (edges XOR steps).
  const selfClaim = bp.spine.claimModel != null && bp.spine.claimModel !== 'decider-dispatch';
  if (hasEdges && hasSteps) {
    err('spine-mode', 'spine declares BOTH edges (decider model) and steps (program model) — choose one');
  } else if (!hasEdges && !hasSteps) {
    if (!selfClaim) {
      err('empty-spine', 'spine declares neither edges (decider model) nor steps (program model)');
    }
  } else if (hasSteps) {
    validateProgramSpine(bp, opts, err, warn);
  } else {
    validateDeciderSpine(bp, isLiveRole, dispatched, err, warn);
  }

  // ── reactive overlay: guards well-formed ───────────────────────────────────
  for (const rule of bp.reactive) {
    const w = rule.when;
    const hasCond =
      w.beforeRole != null || w.afterRole != null || w.minAttempts != null || w.cond != null;
    if (!hasCond) {
      err('empty-reactive-guard', `reactive rule for "${rule.role}" has no trigger condition`);
    }
    if (!isLiveRole(rule.role)) {
      warn('reactive-undeclared-role', `reactive rule targets role "${rule.role}" not in roles[]`);
    }
    for (const ref of [w.beforeRole, w.afterRole]) {
      if (ref && !isLiveRole(ref) && !dispatched.has(ref)) {
        warn('reactive-unknown-anchor', `reactive rule references unknown role "${ref}"`);
      }
    }
  }

  // ── gates: finalize-recipe roles ───────────────────────────────────────────
  // `bp.gates` is schema-prefaulted ({}) for a parsed blueprint, but this fn is
  // also the author-time "secondary net" over RAW (un-parsed) blueprints (see
  // validate-program.test.ts), so guard the defaulted field.
  const finalize = bp.gates?.finalize;
  if (finalize) {
    for (const entry of [...finalize.onDone, ...finalize.onEscalate]) {
      const step = finalizeEntryRole(entry);
      if (!FINALIZE_STEPS.has(step) && !isLiveRole(step)) {
        warn('finalize-unknown-role', `gates.finalize references "${step}" which is neither a step nor a declared role`);
      }
    }
  }

  // ── recursion: bounded ─────────────────────────────────────────────────────
  // Defaulted ({}) for a parsed blueprint; guard for the raw-blueprint path.
  const recursion = bp.recursion;
  if (recursion?.enabled) {
    if (!recursion.spawnOn) {
      warn('recursion-no-trigger', 'recursion.enabled but no spawnOn trigger declared — it can never recurse');
    }
    if (!Number.isFinite(recursion.maxDepth) || recursion.maxDepth < 0) {
      err('recursion-unbounded', `recursion.maxDepth must be a finite non-negative integer (got ${recursion.maxDepth})`);
    }
    // A `$param` childBlueprint (D-008 — the gym's `$target`) must be a
    // well-formed placeholder; the binding itself is a spawn-time concern
    // (resolveChildBlueprint), not statically checkable here.
    const child = recursion.childBlueprint;
    if (isChildBlueprintParam(child) && !CHILD_BLUEPRINT_PARAM_RE.test(child as string)) {
      err(
        'recursion-bad-param',
        `recursion.childBlueprint ${JSON.stringify(child)} is not a valid placeholder — expected \`$\` + identifier (e.g. \`$target\`)`,
      );
    }
  }

  // ── triggers: durable|ephemeral schedule contract (P-010 / D-006) ──────────
  // `triggers` is schema-optional; guard for the raw-blueprint secondary-net path.
  for (const s of bp.triggers?.schedule ?? []) {
    if (s.tier === 'ephemeral') {
      // Deterministic-action-only: an ephemeral cadence fires a bounded ACTION in-process
      // (a sweep), NOT a whole blueprint run. The default action is system:blueprint-run,
      // so an ephemeral entry that omits `action` trips this — the author must override it.
      if (s.action === BLUEPRINT_RUN_ACTION) {
        err(
          'ephemeral-blueprint-run-action',
          `tier:ephemeral schedule must declare a DETERMINISTIC action (a concrete system:<action> or role) — never the default ${BLUEPRINT_RUN_ACTION}, which launches a whole blueprint run`,
        );
      }
      if (s.intervalSec == null) {
        err('ephemeral-no-interval', 'tier:ephemeral schedule requires intervalSec (the cadence in seconds)');
      } else if (s.intervalSec < EPHEMERAL_MIN_INTERVAL_SEC) {
        err('ephemeral-interval-floor', `tier:ephemeral intervalSec must be ≥ ${EPHEMERAL_MIN_INTERVAL_SEC}s (got ${s.intervalSec})`);
      } else if (s.intervalSec > EPHEMERAL_MAX_INTERVAL_SEC) {
        err(
          'ephemeral-interval-ceiling',
          `tier:ephemeral intervalSec ${s.intervalSec}s > ${EPHEMERAL_MAX_INTERVAL_SEC}s is STRUCTURALLY UNFIREABLE: the ephemeral tier arms an in-process timer that restarts from zero on every host restart, so a period longer than the host's uptime never reaches its own deadline (WI-1406487 — corpus-term-df at 21600s did not fire once in 35.7h while reporting active:true). Declare it as tier:durable with a cron, whose next_fire_at survives the restart`,
        );
      } else if (s.intervalSec >= EPHEMERAL_SUGGEST_DURABLE_SEC) {
        warn(
          'ephemeral-interval-coarse',
          `tier:ephemeral intervalSec ${s.intervalSec}s ≥ ${EPHEMERAL_SUGGEST_DURABLE_SEC}s — a coarse cadence is better declared as tier:durable with a cron`,
        );
      }
      if (s.cron != null) {
        warn('ephemeral-cron-ignored', 'cron is ignored for tier:ephemeral (the cadence comes from intervalSec)');
      }
    } else if (s.cron == null) {
      err('durable-no-cron', 'tier:durable schedule requires a cron expression');
    }
  }

  // ── reachability: declared-but-unused roles (dead roles) ───────────────────
  // Decider-mode only: program-mode roles (voter / advocate) are spawned by a
  // `spawn-roles` op step, not by a spine edge, so `dispatched` is empty and the
  // dead-role heuristic would wrongly flag every program role.
  if (!hasSteps) {
    for (const id of roleIds) {
      const used =
        id === bp.spine.decider ||
        // A declared decider ALTERNATIVE (e.g. the pot's `queen`) is a live
        // role an install may swap in — not a dead one (local-hive P-030).
        (bp.spine.deciderAlternatives ?? []).includes(id) ||
        dispatched.has(id) ||
        (bp.operations ?? []).some((op) => op.execution?.kind === 'agent' && op.execution.role === id) ||
        bp.reactive.some((r) => r.role === id) ||
        (finalize
          ? [...finalize.onDone, ...finalize.onEscalate].some((entry) => finalizeEntryRole(entry) === id)
          : false);
      if (!used) {
        warn('unused-role', `role "${id}" is declared but never dispatched, reactive, or in finalize`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

type Reporter = (code: string, message: string) => void;

/** An operation narrows the existing runtime authority; it cannot invent an
 * executor, tool grant, or a second plan launcher by declaration alone. */
function validateOperationDeclarations(bp: Blueprint, isLiveRole: (id: string) => boolean, err: Reporter): void {
  const ids = new Set<string>();
  const importedTools = new Set(bp.dependencies?.tools ?? []);
  for (const operation of bp.operations ?? []) {
    if (ids.has(operation.id)) err('duplicate-operation', `operation "${operation.id}" is declared more than once`);
    ids.add(operation.id);
    if (operation.target.kind === 'plan' && operation.execution) {
      err('plan-operation-executor', `plan operation "${operation.id}" uses its pinned template; it cannot declare another executor`);
    }
    if (operation.target.kind === 'work-item' && !operation.execution) {
      err('work-item-operation-executor', `work-item operation "${operation.id}" must declare an agent, program or recipe executor`);
    }
    if (operation.execution?.kind === 'agent' && !isLiveRole(operation.execution.role)) {
      err('operation-unknown-role', `operation "${operation.id}" references unknown role "${operation.execution.role}"`);
    }
    if (operation.execution?.kind === 'program' && !operation.execution.blueprint && !(bp.spine.steps?.length)) {
      err('operation-no-program', `operation "${operation.id}" selects this blueprint's program, but spine.steps is empty`);
    }
    for (const tool of operation.policy.requiredTools) {
      if (!importedTools.has(tool)) {
        err('operation-undeclared-tool', `operation "${operation.id}" requires "${tool}" outside dependencies.tools`);
      }
    }
    for (const channel of Object.keys(operation.signals)) {
      if (Object.prototype.hasOwnProperty.call(operation.waits, channel)) {
        err('operation-channel-collision', `operation "${operation.id}" declares "${channel}" as both a signal and wait`);
      }
    }
  }
}

/**
 * P-033 — collapse duplicate blueprint declaration sites.
 *
 * The canonical sites are:
 *   - persona document: `roles[].prompt` (or its conventional prompt path);
 *     `knobs.promptOverrides` is an instance/experiment specialization only;
 *   - import dependencies: top-level `dependencies.*`; role-local
 *     `tools`/`capabilities` are legacy advisory hints;
 *   - enforced role ceiling: `fleet.workerRoles[].capabilities`;
 *   - seed pack: `knowledge.pack`; `learning.pack` is read-side legacy compat;
 *   - completion rubric: `acceptance.rubric`; `gym.rubric` scores optimizer
 *     trials and is not a second completion rubric.
 *
 * The legacy knowledge key remains valid on its own because installed blueprint
 * YAML is a compatibility boundary. Its consumer (`resolveSeedPackKey`) derives
 * the canonical seed choice and reports the deprecation. All other ambiguous
 * pairs fail validation so a blueprint cannot silently drift between readers.
 */
function validateDeclarationAuthorities(bp: Blueprint, err: Reporter, warn: Reporter): void {
  const roles = bp.roles ?? [];
  const promptOverrides = bp.knobs?.promptOverrides ?? {};
  for (const role of roles) {
    if (Object.prototype.hasOwnProperty.call(promptOverrides, role.id)) {
      err(
        'duplicate-persona-authority',
        `role "${role.id}" declares its persona through roles[].prompt (or the conventional prompts/${role.id}.md path) AND knobs.promptOverrides.${role.id}; roles[].prompt is the authored persona authority, while knobs.promptOverrides is only an instance/experiment specialization — keep the stable persona at the role prompt and remove the blueprint override`,
      );
    }

    const roleTools = role.tools ?? [];
    const roleCapabilities = role.capabilities ?? [];
    if (roleTools.length === 0 && roleCapabilities.length === 0) continue;

    const enforced = bp.fleet?.workerRoles?.find((worker) => worker.id === role.id)?.capabilities ?? [];
    if (roleCapabilities.length > 0 && enforced.length > 0) {
      err(
        'duplicate-capability-authority',
        `role "${role.id}" declares capabilities in BOTH roles[].capabilities and fleet.workerRoles[].capabilities; the former is only a legacy import hint, while fleet.workerRoles[].capabilities is the ENFORCED allow-list — declare import requirements once in dependencies.tools and keep only the enforced fleet ceiling`,
      );
      continue;
    }

    err(
      'role-dependency-authority',
      `role "${role.id}" declares ${roleTools.length > 0 ? 'roles[].tools' : 'roles[].capabilities'}, a legacy advisory dependency site; dependencies.tools is the single import-time authority, while fleet.workerRoles[].capabilities is reserved for the ENFORCED allow-list — move these requirements to dependencies.tools`,
    );
  }

  const knowledgePack = bp.knowledge?.pack?.trim();
  const learningPack = bp.learning?.pack?.trim();
  if (knowledgePack && learningPack) {
    err(
      'duplicate-knowledge-pack-authority',
      `seed pack is declared in BOTH knowledge.pack ("${knowledgePack}") and deprecated learning.pack ("${learningPack}"); knowledge.pack is authoritative — remove learning.pack`,
    );
  } else if (learningPack) {
    warn(
      'deprecated-learning-pack',
      `learning.pack is a read-side compatibility key; its value "${learningPack}" is derived as the seed choice today, but new authoring must use the single authority knowledge.pack`,
    );
  }

  if (bp.gym?.rubric && bp.acceptance?.rubric) {
    err(
      'duplicate-rubric-authority',
      'blueprint declares BOTH gym.rubric and acceptance.rubric; acceptance.rubric ENFORCES completion for acceptance.kind=judge, while gym.rubric scores optimizer trials — do not duplicate one rubric across both sites; keep only the authority for the lifecycle this blueprint runs',
    );
  }
}

/** Decider-model spine checks (edges + termination + reachability). */
function validateDeciderSpine(
  bp: Blueprint,
  isLiveRole: (id: string) => boolean,
  dispatched: Set<string>,
  err: Reporter,
  warn: Reporter,
): void {
  const edges = bp.spine.edges ?? {};
  // A terminal must be reachable — via some edge OR the default — else the loop
  // can only ever spin until maxTurns.
  const anyTerminalEdge = Object.values(edges).some((a) => TERMINAL.has(a.to));
  const defaultTerminal = TERMINAL.has(bp.spine.default.to);
  if (!anyTerminalEdge && !defaultTerminal) {
    err('no-terminal', 'no terminal outcome is reachable (no terminal edge and a non-terminal default)');
  }
  // Decider should resolve to a declared OR live agent role (prompt-resolve has
  // global fallbacks, so a warning rather than a hard error — P-001).
  if (!isLiveRole(bp.spine.decider)) {
    warn('decider-undeclared', `spine.decider "${bp.spine.decider}" is not in roles[]`);
  }
  // Dispatch targets that resolve to neither a declared nor a live agent role →
  // likely vestigial/dormant verbs (typo / dead role).
  for (const [verb, action] of Object.entries(edges)) {
    if (action.to === 'role') {
      dispatched.add(action.role);
      if (!isLiveRole(action.role)) {
        warn(
          'dispatch-undeclared-role',
          `spine edge ${verb} dispatches role "${action.role}" which is not declared in roles[]`,
        );
      }
    }
  }
}

/**
 * Program-model spine checks (`coordination-ops-as-blueprint-primitives` P-005;
 * extended by `deterministic-blueprints-migration-2026-06-13` P-010): unique step
 * ids, parseable `when` expressions, a gate that always resolves (a fallback
 * branch) WHEN one is declared, and — when `knownOps` is supplied — that every op
 * exists.
 *
 * Two program shapes, discriminated by the gate's presence (no schema field — the
 * blueprint stays a declarative shape, D-002):
 *   - **decision program** (steps + gate — vote/deliberate): the gate forks the
 *     outcome (resolve / escalate) and MUST always resolve (a fallback branch).
 *   - **deterministic pipeline** (steps, NO gate — a migrated learning loop, P-010):
 *     runs its steps to completion; "resolving" means "ran every step", there is no
 *     decision fork. A gateless program is therefore valid — it is the deterministic
 *     step kind the migration promotes to first-class.
 */
function validateProgramSpine(
  bp: Blueprint,
  opts: ValidateOptions,
  err: Reporter,
  warn: Reporter,
): void {
  const steps = bp.spine.steps ?? [];
  const gate = bp.spine.gate ?? [];
  const known = opts.knownOps;

  const seenIds = new Set<string>();
  const boundNames = new Set<string>();
  for (const s of steps) {
    if (seenIds.has(s.id)) err('duplicate-step', `program step id "${s.id}" is declared more than once`);
    seenIds.add(s.id);
    if (known && !known.has(s.op)) {
      err('unknown-op', `program step "${s.id}" invokes unknown op "${s.op}"`);
    }
    if (s.when != null && !isValidWhen(s.when)) {
      err('bad-step-when', `program step "${s.id}" has an invalid when (not a DataCondition): ${JSON.stringify(s.when)}`);
    }
    if (s.bind) boundNames.add(s.bind);
  }
  void boundNames; // reserved for a future "gate reads an unbound name" lint

  // No gate ⇒ a deterministic pipeline (P-010): the steps ARE the program; it
  // resolves by running every one. Nothing further to validate on the gate.
  if (gate.length === 0) return;
  const hasFallback = gate.some((b) => b.else === true || b.when == null);
  if (!hasFallback) {
    err('gate-no-fallback', 'gate has no fallback branch (else / no-when) — some scopes would never resolve');
  }
  for (let i = 0; i < gate.length; i++) {
    const b = gate[i]!;
    if (known && !known.has(b.op)) err('unknown-op', `gate branch ${i} fires unknown op "${b.op}"`);
    if (b.when != null && !isValidWhen(b.when)) {
      err('bad-gate-when', `gate branch ${i} has an invalid when (not a DataCondition): ${JSON.stringify(b.when)}`);
    }
  }
}

/**
 * The identity extension's semantic checks (`identities-v1-2026-08-30` P-001):
 *   - `slots[]` — every slot is a registry slot (`slot-unknown`), not a reserved
 *     layer (`slot-reserved-layer`: the kernel is sealed, the instance tier is the
 *     per-pot override), declared once (`slot-duplicate`), and a restated
 *     cardinality agrees with the registry (`slot-cardinality-mismatch`, D-007 —
 *     the registry is authoritative).
 *   - `bundles[]` — a `(kind, ref)` pair is referenced once (`bundle-duplicate`).
 *   - `grants` — exact class@version refs, no duplicate or required/optional
 *     overlap, and suggestions only for a class the identity actually grants
 *     (D-004 / P-017).
 * Cross-LAYER checks (two documents on one exclusive slot, attestation vs layer
 * hash) need the stack and live in the loader (`resolveBlueprint`).
 * Guards every field: this fn is also the author-time secondary net over RAW
 * (un-parsed) documents.
 */
export function validateIdentityDeclarations(
  bp: Partial<Pick<Blueprint, 'slots' | 'bundles' | 'contributions' | 'grants'>>,
  err: Reporter,
): void {
  const seenSlots = new Set<string>();
  for (const d of bp.slots ?? []) {
    if (seenSlots.has(d.slot)) err('slot-duplicate', `slot "${d.slot}" is declared more than once in slots[]`);
    seenSlots.add(d.slot);
    if (RESERVED_LAYERS.has(d.slot)) {
      err(
        'slot-reserved-layer',
        `"${d.slot}" is a reserved LAYER, not a declarable slot — the kernel is sealed (D-009) and the instance tier is the per-pot override; declarable slots: ${SLOT_IDS.join(', ')}`,
      );
      continue;
    }
    const spec = slotSpec(d.slot);
    if (!spec) {
      err('slot-unknown', `slot "${d.slot}" is not in the slot registry (known: ${SLOT_IDS.join(', ')})`);
      continue;
    }
    if (d.cardinality != null && d.cardinality !== spec.cardinality) {
      err(
        'slot-cardinality-mismatch',
        `slot "${d.slot}" restates cardinality "${d.cardinality}" but the registry rules it "${spec.cardinality}" (${spec.decision}) — the registry is authoritative: omit cardinality or match it`,
      );
    }
  }

  const seenBundles = new Set<string>();
  for (const b of bp.bundles ?? []) {
    const k = `${b.kind}:${b.ref}`;
    if (seenBundles.has(k)) err('bundle-duplicate', `bundle ${k} is referenced more than once in bundles[]`);
    seenBundles.add(k);
  }

  const seenContributions = new Set<string>();
  for (const contribution of bp.contributions ?? []) {
    if (seenContributions.has(contribution.id)) {
      err('contribution-duplicate', `contribution "${contribution.id}" is declared more than once in contributions[]`);
    }
    seenContributions.add(contribution.id);
  }

  const g = bp.grants;
  if (g) {
    const exactRef = /^[a-z0-9][a-z0-9.-]*@[0-9A-Za-z][0-9A-Za-z._+-]*$/;
    const required = g.requires ?? [];
    const optional = g.optional ?? [];
    const requiredSet = new Set<string>();
    const optionalSet = new Set<string>();
    const validateRefs = (
      refs: readonly string[],
      field: 'requires' | 'optional',
      seen: Set<string>,
    ): void => {
      for (const ref of refs) {
        if (!exactRef.test(ref)) {
          err(
            'grant-class-ref-invalid',
            'grants.' + field + ' must name an exact normalized class@version ref; got ' + JSON.stringify(ref),
          );
        }
        if (seen.has(ref)) {
          err('grant-duplicate', 'grants.' + field + ' declares ' + JSON.stringify(ref) + ' more than once');
        }
        seen.add(ref);
      }
    };
    validateRefs(required, 'requires', requiredSet);
    validateRefs(optional, 'optional', optionalSet);
    for (const ref of requiredSet) {
      if (optionalSet.has(ref)) {
        err(
          'grant-required-optional-overlap',
          'capability class ' + JSON.stringify(ref) + ' cannot be both required and optional',
        );
      }
    }
    const declared = new Set([...requiredSet, ...optionalSet]);
    for (const [classRef, provider] of Object.entries(g.suggestedProviders ?? {})) {
      if (!exactRef.test(classRef)) {
        err(
          'grant-class-ref-invalid',
          'grants.suggestedProviders key must be an exact normalized class@version ref; got ' +
            JSON.stringify(classRef),
        );
        continue;
      }
      if (!declared.has(classRef)) {
        err(
          'grant-suggestion-undeclared',
          'suggested provider for ' + JSON.stringify(classRef) +
            ' is invalid because the class is not present in grants.requires or grants.optional',
        );
      }
      if (!provider.trim()) {
        err('grant-provider-invalid', 'suggested provider for ' + JSON.stringify(classRef) + ' is blank');
      }
    }
  }
}
