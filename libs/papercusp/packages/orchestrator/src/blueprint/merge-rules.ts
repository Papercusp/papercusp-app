/**
 * MERGE_RULES — the composition algebra DECLARED beside the schema, one rule per
 * `BlueprintSchema` leaf (`identities-v1-2026-08-30` P-001/P-019, revised by
 * P-039 / D-029). `merge.ts` consumes this registry and `resolveLayers` labels
 * each call as peer-module assembly or inheritance for conflict provenance.
 *
 * WHY. `mergeRaw` is last-writer-wins ("objects deep-merge, child wins on leaf
 * keys; arrays and scalars are replaced wholesale") — which cannot express any of
 * the composition rules an identity stack needs. Hardcoding those into the merger
 * would make every new field compose by an unstated rule; declaring them here,
 * keyed by schema path, makes "no field composes by an unstated rule" executable —
 * `merge-rules.test.ts` fails on both a leaf with no rule and a rule with no leaf.
 *
 * THE FIVE RULES (applied per leaf, parent-first, over the ordered stack):
 *   - `set-union`              — structural array values accumulate; equal values
 *                                deduplicate and an empty array never removes prior
 *                                declarations.
 *   - `keyed-overlay`          — records or keyed arrays retain every key; a later
 *                                restatement deep-merges the fields it names. Keys
 *                                commute, colliding values do not.
 *   - `explicit-replacement`   — a present child value replaces the prior whole
 *                                value; absence inherits. This is the operation that
 *                                permits an authored empty value to remove content.
 *   - `constraint-intersection` — numeric upper bounds take the minimum; equal policy
 *                                values agree; non-comparable values conflict rather
 *                                than silently becoming a permissive replacement.
 *   - `hard-conflict`           — the document retains keyed declarations while a
 *                                source-aware loader check rejects incompatible
 *                                claimants (exclusive `slots` today).
 *
 * LEAF = the unit a rule applies to. Objects are descended (a rule per field);
 * an ARRAY, a RECORD, a UNION and a LAZY schema are each ONE leaf (the rule
 * governs the whole value); an object's `.catchall` / `.looseObject` unknown keys
 * are the `<path>.*` leaf. Wrappers (`optional`/`default`/`prefault`/`nullable`)
 * are transparent.
 *
 * BYTE-EQUIVALENCE CONSTRAINT. Every pre-existing blueprint must resolve to the
 * same document under the rule-driven merger — `merge.test.ts`'s GOLDEN walks
 * every builtin under both algebras and fails on the first differing path. The
 * default assignment reproduces pre-P-019 behaviour — scalars / arrays / unions
 * use explicit replacement and records use keyed overlay — with declared changes
 * for `slots` (hard conflict), bundles/roles (keyed overlay), grants and declaration
 * sets (set union), and safety caps (constraint intersection). A merger that
 * honours the cap rule turns a parent-200 / child-500 `maxTurns` into 200 — the
 * intended fix, asserted explicitly by `merge.test.ts`; the one builtin parent
 * whose children RAISED a cap under last-writer-wins (`single-agent`,
 * `spine.maxTurns` 40) was re-authored to the loosest bound (200) so the rule
 * clamped no live blueprint (D-020). D-029 intentionally adds source-aware exact
 * bundle-pin conflicts and fail-closed non-comparable constraints beyond that
 * historical byte-equivalence evidence.
 */
import type { z } from 'zod';
import { BlueprintSchema } from './schema.js';

export type MergeRuleKind =
  | 'set-union'
  | 'keyed-overlay'
  | 'explicit-replacement'
  | 'constraint-intersection'
  | 'hard-conflict';

export interface MergeRule {
  rule: MergeRuleKind;
  /** For an ARRAY under `keyed-overlay` / `hard-conflict`: the field(s) that identify an element. */
  key?: string | readonly string[];
  /** Why this leaf composes this way — the decision, or "today's behaviour". */
  note?: string;
}

/** A merge-unit of the schema: one entry per rule. */
export interface SchemaLeaf {
  /** Dot path from the document root; `<path>.*` for an object's catchall keys. */
  path: string;
  kind: 'scalar' | 'array' | 'record' | 'union' | 'lazy' | 'catchall';
  /** The zod `def.type` at the leaf (`string`, `array`, `record`, `enum`, …). */
  type: string;
}

const WRAPPERS: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'nonoptional',
  'readonly',
  'catch',
]);

// zod 4 exposes a schema's shape on `def` (`type`, `shape`, `element`, `valueType`,
// `innerType`, `catchall`) — the introspection surface `enumerateSchemaLeaves` walks.
type AnyDef = { type: string; shape?: Record<string, z.ZodType>; innerType?: z.ZodType; catchall?: z.ZodType };
function defOf(s: z.ZodType): AnyDef {
  return (s as unknown as { def: AnyDef }).def;
}

/** Strip the transparent wrappers (`optional` / `default` / `prefault` / `nullable` / …). */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (let guard = 0; guard < 32; guard++) {
    const d = defOf(s);
    if (!WRAPPERS.has(d.type) || !d.innerType) return s;
    s = d.innerType;
  }
  return s;
}

/**
 * Enumerate the merge-units of any zod object schema (see LEAF above). Pure; the
 * walk is over `def`, so it needs no parse and sees `.catchall` keys.
 */
export function enumerateSchemaLeaves(schema: z.ZodType, prefix = ''): SchemaLeaf[] {
  const out: SchemaLeaf[] = [];
  const s = unwrap(schema);
  const d = defOf(s);
  const t = d.type;
  if (t === 'object') {
    for (const [k, v] of Object.entries(d.shape ?? {})) {
      out.push(...enumerateSchemaLeaves(v, prefix ? `${prefix}.${k}` : k));
    }
    const catchall = d.catchall ? unwrap(d.catchall) : null;
    if (catchall && defOf(catchall).type !== 'never') {
      out.push({ path: prefix ? `${prefix}.*` : '*', kind: 'catchall', type: defOf(catchall).type });
    }
    return out;
  }
  const kind: SchemaLeaf['kind'] =
    t === 'array' ? 'array' : t === 'record' ? 'record' : t === 'union' ? 'union' : t === 'lazy' ? 'lazy' : 'scalar';
  out.push({ path: prefix, kind, type: t });
  return out;
}

/** Every merge-unit of `BlueprintSchema` — the population `MERGE_RULES` must cover exactly. */
export function enumerateBlueprintLeaves(): SchemaLeaf[] {
  return enumerateSchemaLeaves(BlueprintSchema);
}

const replace = (note?: string): MergeRule =>
  note ? { rule: 'explicit-replacement', note } : { rule: 'explicit-replacement' };
const setUnion = (note?: string): MergeRule => ({ rule: 'set-union', ...(note ? { note } : {}) });
const overlay = (note?: string, key?: MergeRule['key']): MergeRule => ({
  rule: 'keyed-overlay',
  ...(key ? { key } : {}),
  ...(note ? { note } : {}),
});
const cap = (note: string): MergeRule => ({ rule: 'constraint-intersection', note });

const TODAY_RECORD = 'record: keyed overlay, child wins per key (today’s mergeRaw deep-merge)';
const CAP =
  'numeric upper-bound constraint intersection — the smaller value wins; non-comparable values conflict (D-029)';
const DECLARATION_SET =
  'a declaration set: each layer CONTRIBUTES entries, none wipes a sibling’s (D-020; was array-replace before P-019 — no builtin set it on two layers)';
const LAYER_META =
  'layer metadata: the resolved document carries the leaf’s; per-layer values survive in LoadedBlueprint.layers';
const RUBRIC = {
  version: replace(),
  model: replace(),
  temperature: replace(),
  thinkingBudgetTokens: replace(),
  weights: overlay(TODAY_RECORD),
  dimensions: overlay(TODAY_RECORD),
} as const;
const prefixed = (prefix: string, rules: Readonly<Record<string, MergeRule>>): Record<string, MergeRule> =>
  Object.fromEntries(Object.entries(rules).map(([k, v]) => [`${prefix}.${k}`, v]));

/**
 * The registry, keyed by schema leaf path. Exhaustive over
 * `enumerateBlueprintLeaves()` — both directions asserted by merge-rules.test.ts.
 */
export const MERGE_RULES: Readonly<Record<string, MergeRule>> = {
  // ── identity of the resolved document ──────────────────────────────────────
  id: replace('the resolved document IS the child'),
  extends: replace('the composition GRAPH, consumed by resolveLayers — never merged as content'),
  kind: replace(),
  version: replace(),
  description: replace(),
  'retired.at': replace('a child sets `retired: null` to revive (the null replaces the object wholesale)'),
  'retired.reason': replace(),

  // ── identities-v1 P-001: slots / bundles / grants / publisher / attestation ──
  slots: {
    rule: 'hard-conflict',
    key: 'slot',
    note: 'per-slot, cardinality-aware: additive slots union; a second DISTINCT layer on an exclusive slot fails the load (D-007; findExclusiveSlotConflicts)',
  },
  bundles: overlay(
    'keyed overlay by kind/ref; incompatible exact versions fail with layer provenance unless versionOverride validates (D-029)',
    ['kind', 'ref'],
  ),
  contributions: setUnion('component declarations accumulate; conflicting ids are rejected with layer origins by the loader'),
  'mode.id': replace(LAYER_META),
  'mode.policyRef': replace(LAYER_META),
  'mode.title': replace(LAYER_META),
  'mode.oneLiner': replace(LAYER_META),
  'mode.definitionContributionId': replace(LAYER_META),
  'mode.implies': replace(LAYER_META),
  'mode.requiresSubject': replace(LAYER_META),
  'mode.launchable': replace(LAYER_META),
  'mode.aliases': replace(LAYER_META),
  'mode.replacesRevision': replace(LAYER_META),
  'grants.requires': setUnion(
    'grant declaration set; each layer independently vetted (D-003) — RESERVED until M3 (D-004/D-014)',
  ),
  'grants.optional': setUnion('grant declaration set (D-003) — RESERVED until M3 (D-004/D-014)'),
  'grants.suggestedProviders': overlay(`${TODAY_RECORD}; publisher hints — RESERVED until M3`),
  'publisher.id': replace(LAYER_META),
  'publisher.name': replace(LAYER_META),
  'publisher.url': replace(LAYER_META),
  'attestation.contentHash': replace(`${LAYER_META}; verified per layer by resolveBlueprint`),
  'attestation.signedBy': replace(LAYER_META),
  'attestation.signature': replace(LAYER_META),
  'attestation.signedAt': replace(LAYER_META),

  // ── work unit ──────────────────────────────────────────────────────────────
  'workItem.kind': replace(),
  'workItem.idPrefix': replace(),
  'workItem.payload': overlay(TODAY_RECORD),

  // ── roles + spine ──────────────────────────────────────────────────────────
  roles: overlay(
    `${DECLARATION_SET}; keyed by role id — a child restating a role overrides the fields it names and inherits the rest`,
    'id',
  ),
  'spine.decider': replace(),
  'spine.deciderAlternatives': replace(),
  'spine.claimModel': replace(),
  'spine.maxTurns': cap(CAP),
  'spine.edges': overlay(`${TODAY_RECORD} — verb → action`),
  'spine.default': replace(),
  'spine.steps': replace('a program is authored whole'),
  'spine.gate': replace('a gate is authored whole'),

  // ── planner / reactive / gates / recursion ─────────────────────────────────
  'planner.kind': replace(),
  'planner.config': overlay(TODAY_RECORD),
  reactive: setUnion(
    `${DECLARATION_SET}; by structural value — a rule has no natural key, and two rules for one role are two rules`,
  ),
  'gates.finalize.onDone': replace(),
  'gates.finalize.onEscalate': replace(),
  'gates.approvals': replace(),
  'recursion.enabled': replace(),
  'recursion.childBlueprint': replace(),
  'recursion.spawnOn.role': replace(),
  'recursion.spawnOn.verb': replace(),
  'recursion.spawnOn.custom': replace(),
  'recursion.strategy': replace(),
  'recursion.maxDepth': cap(CAP),

  // ── gym / acceptance / output / affinity ───────────────────────────────────
  'gym.collectTrace': replace(),
  'gym.signals': setUnion(`${DECLARATION_SET}; guardrails only ever accumulate down a stack`),
  ...prefixed('gym.rubric', RUBRIC),
  'acceptance.kind': replace(),
  ...prefixed('acceptance.rubric', RUBRIC),
  'output.kind': replace(),
  'affinity.kind': replace(),

  // ── hive domain profile ────────────────────────────────────────────────────
  lexicon: overlay(TODAY_RECORD),
  'fleet.workerRoles': replace(),
  'fleet.watcher': replace(),
  'wake.subscriptions': replace(),
  'wake.kickoffTemplate': replace(),
  'knowledge.pack': replace(),
  'learning.pack': replace('@deprecated read-side compat key'),
  'learning.loops': replace(),
  'placement.injectLoadThreshold': replace(),
  'placement.maxInjectPerBee': replace(),
  'placement.strategy': replace(),
  'coordination.broadcast': replace(),
  'coordination.review': replace(),
  'coordination.sharedState': replace(),
  'coordination.team': replace(),
  'coordination.aggregate': replace(),
  'coordination.coordinator': replace(),
  'coordination.discipline.allow': replace(),
  'coordination.discipline.forbid': replace(),

  // ── knobs ──────────────────────────────────────────────────────────────────
  'knobs.harnessKind': replace(),
  'knobs.maxCostUsd': cap(CAP),
  'knobs.logRetention': replace(),
  'knobs.branchIsolation.enabled': replace(),
  'knobs.branchIsolation.baseBranch': replace(),
  'knobs.worktrees.enabled': replace(),
  'knobs.reviewer.replanOnAccept': replace(),
  'knobs.product.enabled': replace(),
  'knobs.product.triggerOnNearDone': replace(),
  'knobs.product.nearDoneThreshold': replace(),
  'knobs.product.mode': replace(),
  'knobs.product.replanOnAccept': replace(),
  'knobs.promotion.smokeBuild.enabled': replace(),
  'knobs.promotion.smokeBuild.*': replace('loose keys'),
  'knobs.promotion.*': replace('dynamic `<from>_to_<to>` edge keys'),
  'knobs.models': overlay(TODAY_RECORD),
  'knobs.debuggerThreshold': replace(),
  'knobs.testCommand': replace(),
  'knobs.uiQa.enabled': replace(),
  'knobs.requiresRepo': replace(),
  'knobs.releaseGate.enabled': replace(),
  'knobs.releaseGate.integrationBranch': replace(),
  'knobs.releaseGate.releaseRef': replace(),
  'knobs.releaseGate.greenCmd': replace(),
  'knobs.releaseGate.spaBuildWorkspace': replace(),
  'knobs.releaseGate.deploy.systemdUnit': replace(),
  'knobs.releaseGate.deploy.healthUrl': replace(),
  'knobs.promptOverrides': overlay(`${TODAY_RECORD} — per-role prompt specialization`),
  'knobs.aiBackend.default.engine': replace(),
  'knobs.aiBackend.default.agentCmd': replace(),
  'knobs.aiBackend.default.model': replace(),
  'knobs.aiBackend.default.extraArgs': replace(),
  'knobs.aiBackend.roles': overlay(TODAY_RECORD),
  'knobs.parallelWorkers.max': cap(CAP),
  'knobs.parallelWorkers.maxFeaturesInFlight': cap(CAP),
  'knobs.parallelWorkers.synthesizeSingle': replace(),
  'knobs.parallelWorkers.mode': replace(),
  'knobs.parallelWorkers.*': replace('loose keys (retired chunk-loop knobs)'),
  'knobs.scoper.outputMode': replace(),
  'knobs.scoper.backend': replace(),
  'knobs.scoper.*': replace('loose keys (transient scoper run-state)'),
  'knobs.snapshotRetention': replace(),
  'knobs.*': replace('forward-unknown knobs (`.catchall(unknown)`)'),

  // ── triggers / dispatch / dependencies / ops / environment / params ────────
  'triggers.schedule': replace(),
  'triggers.event': replace(),
  'dispatch.concurrency': replace('a target, not a ceiling — the ceiling is safetyCeiling'),
  'dispatch.priority': replace(),
  'dispatch.readiness': replace(),
  'dispatch.costCapUsd': cap(CAP),
  'dispatch.safetyCeiling': cap(`${CAP}; tighten-only by design`),
  'dependencies.tools': setUnion(
    `${DECLARATION_SET}; the pre-M3 grant vocabulary, so it composes like grants (D-003) — folds into capability classes in M3 (D5 → P-016)`,
  ),
  'dependencies.packs': setUnion(DECLARATION_SET),
  'dependencies.plugins': setUnion(DECLARATION_SET),
  'dependencies.blueprints': setUnion(DECLARATION_SET),
  'dependencies.datatypes': setUnion(DECLARATION_SET),
  ops: replace(),
  operations: replace('externally invocable operation manifest is authored whole; absent inherits, a present child replaces it'),
  'environment.setup': replace(),
  'environment.install': replace(),
  'environment.build': replace(),
  'environment.test': replace(),
  'environment.run': replace(),
  'environment.services': replace(),
  'environment.ports': replace(),
  'environment.env': overlay(TODAY_RECORD),
  params: overlay(
    `${TODAY_RECORD} — base ∪ child. STAYS a record (D-020): its keys ARE the config.json dot-paths the settings panel reads and writes, unique by construction, so keyed overlay is the declared rule, not a workaround for array replacement`,
  ),
};

/**
 * The rule for a concrete document path: an exact entry, else the nearest
 * enclosing catchall (`knobs.foo` → `knobs.*`; `knobs.promotion.x_to_y` →
 * `knobs.promotion.*`). Null for a path the registry does not govern.
 */
export function mergeRuleFor(path: string): MergeRule | null {
  const exact = MERGE_RULES[path];
  if (exact) return exact;
  const segs = path.split('.');
  for (let i = segs.length - 1; i >= 1; i--) {
    const candidate = `${segs.slice(0, i).join('.')}.*`;
    const hit = MERGE_RULES[candidate];
    if (hit) return hit;
  }
  return MERGE_RULES['*'] ?? null;
}

/** Leaves of `BlueprintSchema` with no declared rule — the "unstated rule" defect, as data. */
export function missingMergeRules(): SchemaLeaf[] {
  return enumerateBlueprintLeaves().filter((leaf) => MERGE_RULES[leaf.path] == null);
}

/** Rule paths naming no schema leaf — a rule that rotted when its field moved. */
export function danglingMergeRules(): string[] {
  const leafPaths = new Set(enumerateBlueprintLeaves().map((l) => l.path));
  return Object.keys(MERGE_RULES).filter((p) => !leafPaths.has(p));
}
