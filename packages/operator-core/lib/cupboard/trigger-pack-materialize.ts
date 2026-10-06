/**
 * Materialize a Cupboard trigger pack into one harness
 * (generalized-integrations-google-migration-cupboard-workflows-2026-10-05 P-012,
 * governed by plan Decision D-013).
 *
 * A trigger pack is pure manifest data. Before P-012 an install only reported
 * manifest counts, and the installer had to hand-create every plan and binding.
 * Materializing turns the declaration into real, DISARMED runtime rows through
 * the existing seams — nothing here dispatches anything:
 *
 *   - plan targets   → plans via `ensureFlagshipPlan` (template install + BAR seeding)
 *   - external bindings → disarmed `trigger_bindings` via `createExternalTriggerBinding`
 *     (the function behind `triggers:bind`), bound to an installer-local data source
 *   - `binding-run-completed` edges → disarmed bindings on the workspace's internal
 *     `trigger-pack-edge` source, filtered on the upstream binding id; the binding
 *     engine ingests the edge event when the upstream run succeeds
 *   - manual bindings → recorded entry points (`plans:run-now`), no binding row
 *
 * Every refusal happens in a write-free PREFLIGHT, so an unsupported pack never
 * leaves half a graph behind. The `trigger_pack_installations` row is written
 * FIRST with the planned plan slugs, so a retry after a mid-way failure adopts
 * what the earlier attempt created instead of refusing it as a slug conflict.
 * Re-materializing (configure) is idempotent: a binding whose resolved shape is
 * unchanged is reused, armed state included; a changed one is detached and
 * replaced by a new disarmed binding, which sends it back to review.
 */
import { promises as fs } from 'node:fs';
import { resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type postgres from 'postgres';
import type {
  PluginTriggerPack,
  PluginTriggerPackBinding,
  PluginTriggerPackPlanTarget,
} from '@papercusp/plugin-sdk';
import { validateTriggerPackDeclaration } from '@papercusp/plugin-sdk';
import { parsePlan } from '@papercusp/plan-parser';
import { acceptanceBarSourceContractProblems, validateAcceptanceBarSource } from '../acceptance-bar-seed';
import { getDatatype, installPublishedDatatype } from '../datatype-registry-store';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import {
  createExternalTriggerBinding,
  createExternalTriggerSource,
  detachExternalTriggerBinding,
} from '../external-triggers/admin';
import {
  TRIGGER_PACK_EDGE_EVENT,
  TRIGGER_PACK_EDGE_SOURCE_KIND,
  TRIGGER_RUN_COMPLETION_DATATYPE,
} from '../external-triggers/binding-engine';
import { ensureFlagshipPlan } from '../external-triggers/flagship-plan';
import { providerRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { reconcileTriggerPackReview, sha256 } from './trigger-pack-lifecycle';

/** The edge event key every edge binding listens on. */
export const TRIGGER_PACK_EDGE_EVENT_KEY = `ext:${TRIGGER_PACK_EDGE_SOURCE_KIND}:${TRIGGER_PACK_EDGE_EVENT}`;

const FILTER_COMBINATOR_KEYS = new Set(['all', 'any', 'not', 'some']);

export interface TriggerPackManifest {
  name: string;
  version: string;
  kind?: string;
  triggerPack: PluginTriggerPack;
  configSchema?: Record<string, unknown>;
  oauth?: Array<{ provider: string; scopes?: string[]; fieldName: string }>;
}

export interface MaterializeTriggerPackInput {
  manifest: TriggerPackManifest;
  /** Directory holding the pack's files (plan templates are read relative to it). */
  pluginDir: string;
  harnessSlug: string;
  /** Pack binding id → installer-chosen local `data_sources` id. */
  sourceMappings?: Record<string, string>;
  /** Installer input values, validated against `triggerPack.inputs`. */
  inputs?: Record<string, unknown>;
  createdBy?: string | null;
}

export interface MaterializeTriggerPackDeps {
  /** Provider registry used to resolve portable datatype sources (tests inject one). */
  registry?: Pick<ProviderRegistry, 'get'>;
}

export type TriggerPackRequirement =
  | { kind: 'source'; sourceKind: string }
  | { kind: 'source'; datatype: string; capabilities: string[] }
  | { kind: 'upstream'; upstreamBindingId: string }
  | { kind: 'inputs'; errors: string[] };

export interface TriggerPackUnmet {
  /** Pack binding id, or `inputs` for the workflow-level input requirement. */
  bindingId: string;
  reason: 'no-candidate' | 'ambiguous' | 'upstream-unmet' | 'inputs-invalid';
  requirement: TriggerPackRequirement;
  /** Local `data_sources` ids that satisfy the requirement (ambiguous case). */
  candidates: string[];
}

export interface TriggerPackResources {
  /**
   * Pack target id → the plan this installation owns, with the sha256 of the
   * pack's template (P-013: the review covers the template, not the live plan,
   * whose content moves with every run).
   */
  plans: Record<string, { planSlug: string; templateSha256?: string }>;
  /** Pack binding id → the trigger binding this installation owns. */
  bindings: Record<string, { triggerBindingId: string; sourceId: string; kind: 'external' | 'edge' }>;
  /** Manual bindings: launched by `plans:run-now`, so they own no binding row. */
  entryPoints: Array<{ bindingId: string; targetId: string; planSlug: string }>;
  /** The workspace's internal edge source, when the pack declares edges. */
  edgeSourceId: string | null;
}

export interface TriggerPackInstallation {
  id: string;
  workspaceId: string;
  harnessSlug: string;
  pluginName: string;
  pluginVersion: string;
  status: 'needs-configuration' | 'configured';
  sourceMappings: Record<string, string>;
  inputs: Record<string, unknown>;
  resources: TriggerPackResources;
  unmet: TriggerPackUnmet[];
  /**
   * True only when an unchanged re-configure kept a reviewed pack armed (P-013,
   * D-016). A fresh install, an update, or any change to the review is never
   * armed: arming stays the separate, reviewed `trigger-packs:arm`.
   */
  armed: boolean;
  /** The current review fingerprint and whether the installation is armed against it. */
  review: { fingerprint: string; reviewed: boolean };
}

/** A refusal raised before any write. `code` is stable for callers to branch on. */
export class TriggerPackMaterializeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TriggerPackMaterializeError';
  }
}

interface SourceRow {
  id: string;
  kind: string;
}

interface PlannedPlan {
  target: PluginTriggerPackPlanTarget;
  planSlug: string;
  content: string;
}

type ResolvedSource =
  | { ok: true; sourceId: string; sourceKind: string }
  | { ok: false; unmet: TriggerPackUnmet };

function emptyResources(): TriggerPackResources {
  return { plans: {}, bindings: {}, entryPoints: [], edgeSourceId: null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resourcesFrom(value: unknown): TriggerPackResources {
  const raw = asRecord(value);
  return {
    plans: asRecord(raw.plans) as TriggerPackResources['plans'],
    bindings: asRecord(raw.bindings) as TriggerPackResources['bindings'],
    entryPoints: Array.isArray(raw.entryPoints) ? (raw.entryPoints as TriggerPackResources['entryPoints']) : [],
    edgeSourceId: typeof raw.edgeSourceId === 'string' ? raw.edgeSourceId : null,
  };
}

function refuse(code: string, message: string): never {
  throw new TriggerPackMaterializeError(code, message);
}

async function readPackTemplate(pluginDir: string, relPath: string, targetId: string): Promise<string> {
  const root = resolve(pluginDir);
  const inside = (path: string) => path === root || path.startsWith(root + sep);
  const planPath = resolve(root, relPath);
  if (!inside(planPath)) refuse('trigger_pack_template_unsafe', `plan target "${targetId}" path escapes the pack`);
  let real: string;
  try {
    real = await fs.realpath(planPath);
  } catch {
    refuse('trigger_pack_template_unreadable', `plan target "${targetId}" template not readable at ${relPath}`);
  }
  if (!inside(real)) refuse('trigger_pack_template_unsafe', `plan target "${targetId}" template symlink escapes the pack`);
  return fs.readFile(real, 'utf8');
}

/**
 * Is the template startable once installed? The plan insert trigger puts every
 * new plan under the acceptance-BAR contract, and `ensureFlagshipPlan` seeds the
 * BARs from the template's own `## Requirements` inside its transaction. A
 * template without a complete BAR source would abort that install part-way, so
 * it is refused here, before any write.
 */
function templateBarProblems(content: string): string[] {
  const source = validateAcceptanceBarSource(content);
  if (!source.ok) return source.problems.map((problem) => problem.code);
  return acceptanceBarSourceContractProblems(source.bars, source.mappings).map((problem) => problem.code);
}

/** Pack binding ids in an order where every edge's upstream precedes its downstream. */
function topologicalBindings(pack: PluginTriggerPack, upstreamOf: Map<string, string>): PluginTriggerPackBinding[] {
  const byId = new Map(pack.bindings.map((binding) => [binding.id, binding]));
  const ordered: PluginTriggerPackBinding[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      refuse('trigger_pack_edge_cycle', `trigger-pack edges form a cycle through binding "${id}"`);
    }
    state.set(id, 'visiting');
    const upstream = upstreamOf.get(id);
    if (upstream) visit(upstream);
    state.set(id, 'done');
    const binding = byId.get(id);
    if (binding) ordered.push(binding);
  };
  for (const binding of pack.bindings) visit(binding.id);
  return ordered;
}

async function candidateSources(
  sql: postgres.Sql,
  workspaceId: string,
  binding: PluginTriggerPackBinding,
  registry: Pick<ProviderRegistry, 'get'>,
): Promise<SourceRow[]> {
  if (binding.source.kind !== 'external') return [];
  const rows = await sql<SourceRow[]>`
    SELECT id::text AS id, kind FROM harness_shared.data_sources AS source
     WHERE workspace_id = ${workspaceId}
       AND kind <> ${TRIGGER_PACK_EDGE_SOURCE_KIND}
       AND status <> 'disabled'
     ORDER BY source.created_at, source.id`;
  const source = binding.source;
  if (source.sourceKind) return rows.filter((row) => row.kind === source.sourceKind);
  const datatype = source.datatype!;
  const capabilities = source.capabilities ?? [];
  return rows.filter((row) => {
    const descriptor = registry.get(row.kind)?.descriptor;
    return (
      Boolean(descriptor) &&
      descriptor!.datatypes.includes(datatype) &&
      capabilities.every((capability) => descriptor!.capabilities.includes(capability))
    );
  });
}

function sourceRequirement(binding: PluginTriggerPackBinding): TriggerPackRequirement {
  const source = binding.source;
  if (source.kind === 'external' && source.sourceKind) return { kind: 'source', sourceKind: source.sourceKind };
  if (source.kind === 'external') {
    return { kind: 'source', datatype: source.datatype!, capabilities: [...(source.capabilities ?? [])].sort() };
  }
  return { kind: 'upstream', upstreamBindingId: '' };
}

/**
 * The write-free half: validate the declaration, refuse every unsupported
 * construct, and resolve each external binding to an installer-local source.
 */
async function preflight(
  sql: postgres.Sql,
  workspaceId: string,
  input: MaterializeTriggerPackInput,
  registry: Pick<ProviderRegistry, 'get'>,
) {
  const { manifest } = input;
  const pack = manifest.triggerPack;
  const issues = validateTriggerPackDeclaration(manifest);
  if (issues.length > 0) refuse('trigger_pack_invalid', `trigger-pack manifest invalid: ${issues.join('; ')}`);

  for (const target of pack.targets) {
    if (target.kind === 'recipe') {
      // D-013 §4: the binding engine has no headless recipe route; a trigger
      // has no caller role for recipes:run's role-scoped envelope.
      refuse('trigger_pack_unsupported_target:recipe', `recipe target "${target.id}" has no event-driven executor`);
    }
  }
  for (const edge of pack.edges) {
    if (edge.event === 'plan-completed') {
      // D-013 §5: nothing emits a plan-completion event today.
      refuse('trigger_pack_unsupported_edge:plan-completed', `edge ${edge.from} → ${edge.to} needs a plan-completed emitter`);
    }
  }

  const bindingById = new Map(pack.bindings.map((binding) => [binding.id, binding]));
  const upstreamOf = new Map<string, string>();
  for (const edge of pack.edges) {
    const from = bindingById.get(edge.from);
    const to = bindingById.get(edge.to);
    if (!from || !to) refuse('trigger_pack_invalid', `edge ${edge.from} → ${edge.to} references an unknown binding`);
    if (to.source.kind !== 'internal' || to.source.event !== edge.event) {
      refuse('trigger_pack_invalid', `edge target "${edge.to}" must declare an internal ${edge.event} source`);
    }
    if (from.source.kind === 'manual') {
      // A plans:run-now launch is not a binding run, so it can never emit the edge.
      refuse('trigger_pack_unsupported_edge:manual-upstream', `edge ${edge.from} → ${edge.to} starts at a manual binding`);
    }
    if (upstreamOf.has(edge.to)) {
      refuse('trigger_pack_unsupported_edge:fan-in', `binding "${edge.to}" has more than one upstream edge`);
    }
    upstreamOf.set(edge.to, edge.from);
  }
  for (const binding of pack.bindings) {
    if (binding.source.kind === 'internal') {
      if (binding.source.event === 'plan-completed') {
        refuse('trigger_pack_unsupported_edge:plan-completed', `binding "${binding.id}" listens for plan-completed`);
      }
      if (!upstreamOf.has(binding.id)) {
        refuse('trigger_pack_invalid', `internal binding "${binding.id}" has no incoming edge`);
      }
      const filter = asRecord(binding.filter);
      if (Object.keys(filter).some((key) => FILTER_COMBINATOR_KEYS.has(key))) {
        refuse(
          `trigger_pack_unsupported_edge_filter:${binding.id}`,
          `edge binding "${binding.id}" filter must be a plain field match`,
        );
      }
    }
  }
  const ordered = topologicalBindings(pack, upstreamOf);

  const existing = await sql<Array<{ id: string; resources: unknown }>>`
    SELECT id::text AS id, resources FROM harness_shared.trigger_pack_installations
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${input.harnessSlug}
       AND plugin_name = ${manifest.name}`;
  const priorResources = resourcesFrom(existing[0]?.resources);
  const ownedSlugs = new Set(Object.values(priorResources.plans).map((plan) => plan.planSlug));

  const plans = new Map<string, PlannedPlan>();
  for (const target of pack.targets) {
    if (target.kind !== 'plan') continue;
    const content = await readPackTemplate(input.pluginDir, target.path, target.id);
    const parsed = parsePlan(content);
    const planSlug = parsed.frontmatter.slug;
    if (parsed.isLegacy || !planSlug) {
      refuse('trigger_pack_template_invalid', `plan target "${target.id}" is not a structured plan template`);
    }
    const problems = templateBarProblems(content);
    if (problems.length > 0) {
      refuse(
        `trigger_pack_plan_template_unstartable:${target.id}`,
        `plan target "${target.id}" template cannot seed its acceptance bars (${[...new Set(problems)].join(', ')})`,
      );
    }
    if (!ownedSlugs.has(planSlug)) {
      // A plan slug is a WORKSPACE-level identity for acceptance gating (the
      // acceptance-rubric uniqueness index in migration 1004 is keyed by workspace
      // and subjectPlan, not harness), so a same-slug plan in ANY harness is a clash.
      const clash = await sql<Array<{ harnessSlug: string }>>`
        SELECT harness_slug AS "harnessSlug" FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId}
           AND plan_slug = ${planSlug}
         LIMIT 1`;
      if (clash[0]) {
        refuse(
          'trigger_pack_plan_slug_conflict',
          `plan "${planSlug}" already exists in harness ${clash[0].harnessSlug} of this workspace and is not owned by this pack installation`,
        );
      }
    }
    plans.set(target.id, { target, planSlug, content });
  }

  const sourceMappings = { ...(input.sourceMappings ?? {}) };
  for (const bindingId of Object.keys(sourceMappings)) {
    const binding = bindingById.get(bindingId);
    if (!binding || binding.source.kind !== 'external') {
      refuse('trigger_pack_source_mapping_invalid', `source mapping names "${bindingId}", which is not an external binding`);
    }
  }
  const resolved = new Map<string, ResolvedSource>();
  const datatypes = new Set<string>();
  for (const binding of ordered) {
    if (binding.source.kind !== 'external') continue;
    if (binding.source.datatype) datatypes.add(binding.source.datatype);
    const candidates = await candidateSources(sql, workspaceId, binding, registry);
    const mapped = sourceMappings[binding.id];
    if (mapped) {
      const chosen = candidates.find((candidate) => candidate.id === mapped);
      if (!chosen) {
        refuse(
          'trigger_pack_source_mapping_invalid',
          `source ${mapped} cannot serve binding "${binding.id}" (${JSON.stringify(sourceRequirement(binding))})`,
        );
      }
      resolved.set(binding.id, { ok: true, sourceId: chosen.id, sourceKind: chosen.kind });
    } else if (candidates.length === 1) {
      resolved.set(binding.id, { ok: true, sourceId: candidates[0]!.id, sourceKind: candidates[0]!.kind });
    } else {
      resolved.set(binding.id, {
        ok: false,
        unmet: {
          bindingId: binding.id,
          reason: candidates.length === 0 ? 'no-candidate' : 'ambiguous',
          requirement: sourceRequirement(binding),
          candidates: candidates.map((candidate) => candidate.id),
        },
      });
    }
  }
  for (const datatype of datatypes) {
    if (await getDatatype(sql, workspaceId, datatype)) continue;
    const catalog = await sql<Array<{ id: string }>>`
      SELECT id FROM harness_shared.datatype_registry
       WHERE id = ${datatype} AND review_status = 'approved' LIMIT 1`;
    if (!catalog[0]) {
      refuse(`trigger_pack_unknown_datatype:${datatype}`, `no installed or approved catalog datatype "${datatype}"`);
    }
  }
  if (pack.edges.length > 0 && !(await getDatatype(sql, workspaceId, TRIGGER_RUN_COMPLETION_DATATYPE))) {
    const catalog = await sql<Array<{ id: string }>>`
      SELECT id FROM harness_shared.datatype_registry
       WHERE id = ${TRIGGER_RUN_COMPLETION_DATATYPE} AND review_status = 'approved' LIMIT 1`;
    if (!catalog[0]) {
      refuse(
        `trigger_pack_unknown_datatype:${TRIGGER_RUN_COMPLETION_DATATYPE}`,
        'the trigger-run-completion catalog datatype is missing (migration 1362)',
      );
    }
  }

  const inputs = { ...(input.inputs ?? {}) };
  const inputCheck = checkAgainstJsonSchema(pack.inputs, inputs);
  const inputsUnmet: TriggerPackUnmet | null = inputCheck.ok
    ? null
    : {
        bindingId: 'inputs',
        reason: 'inputs-invalid',
        requirement: { kind: 'inputs', errors: inputCheck.errors },
        candidates: [],
      };

  return { ordered, upstreamOf, plans, resolved, datatypes, sourceMappings, inputs, inputsUnmet, priorResources };
}

async function ensureEdgeSource(
  sql: postgres.Sql,
  workspaceId: string,
  createdBy: string | null,
): Promise<string> {
  const existing = await sql<Array<{ id: string }>>`
    SELECT id::text AS id FROM harness_shared.data_sources AS source
     WHERE workspace_id = ${workspaceId} AND kind = ${TRIGGER_PACK_EDGE_SOURCE_KIND}
     ORDER BY source.created_at, source.id LIMIT 1`;
  if (existing[0]) return existing[0].id;
  const created = await createExternalTriggerSource(sql, workspaceId, {
    kind: TRIGGER_PACK_EDGE_SOURCE_KIND,
    status: 'ready',
    config: { internal: true, purpose: 'trigger-pack edges' },
    createdBy,
  });
  return created.id;
}

interface BindingShape {
  sourceId: string;
  planHarnessSlug: string;
  planSlug: string;
  eventPattern: string;
  eventFilter: Record<string, unknown>;
  datatypeId: string | null;
  planInput: Record<string, unknown>;
}

/** Reuse the recorded binding when its shape is unchanged; otherwise replace it disarmed. */
async function reuseOrCreateBinding(
  sql: postgres.Sql,
  workspaceId: string,
  installationId: string,
  recordedId: string | undefined,
  shape: BindingShape,
  stormPolicy: Record<string, unknown> | undefined,
  createdBy: string | null,
): Promise<string> {
  if (recordedId) {
    const rows = await sql<
      Array<{
        sourceId: string;
        planHarnessSlug: string | null;
        planSlug: string | null;
        eventPattern: string;
        eventFilter: Record<string, unknown>;
        datatypeId: string | null;
        action: Record<string, unknown>;
      }>
    >`
      SELECT source_id::text AS "sourceId", plan_harness_slug AS "planHarnessSlug", plan_slug AS "planSlug",
             event_pattern AS "eventPattern", event_filter AS "eventFilter", datatype_id AS "datatypeId", action
        FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${workspaceId} AND id = ${recordedId}::uuid
         AND pack_installation_id = ${installationId}::uuid
         AND detached_at IS NULL`;
    const row = rows[0];
    if (
      row &&
      row.sourceId === shape.sourceId &&
      row.planHarnessSlug === shape.planHarnessSlug &&
      row.planSlug === shape.planSlug &&
      row.eventPattern === shape.eventPattern &&
      isDeepStrictEqual(asRecord(row.eventFilter), shape.eventFilter) &&
      row.datatypeId === shape.datatypeId &&
      isDeepStrictEqual(asRecord(asRecord(row.action).input), shape.planInput)
    ) {
      return recordedId;
    }
    if (row) await detachExternalTriggerBinding(sql, workspaceId, recordedId);
  }
  const created = await createExternalTriggerBinding(sql, workspaceId, {
    sourceId: shape.sourceId,
    planHarnessSlug: shape.planHarnessSlug,
    planSlug: shape.planSlug,
    eventPattern: shape.eventPattern,
    eventFilter: shape.eventFilter,
    datatypeId: shape.datatypeId,
    ...(Object.keys(shape.planInput).length > 0 ? { planInput: shape.planInput } : {}),
    ...(stormPolicy ? { stormPolicy } : {}),
    packInstallationId: installationId,
    createdBy,
  });
  return created.id;
}

/**
 * Install (or re-configure) a trigger pack into `harnessSlug`. Returns the
 * installation with every resource id it owns and every unmet requirement.
 * Nothing is armed; arming stays the separate, autonomy-gated `triggers:arm`.
 */
export async function materializeTriggerPack(
  sql: postgres.Sql,
  workspaceId: string,
  input: MaterializeTriggerPackInput,
  deps: MaterializeTriggerPackDeps = {},
): Promise<TriggerPackInstallation> {
  const registry = deps.registry ?? providerRegistry();
  const createdBy = input.createdBy?.trim() || null;
  const { manifest } = input;
  const pack = manifest.triggerPack;
  const plan = await preflight(sql, workspaceId, input, registry);

  // ── 1. The installation row first, carrying the planned plan slugs ─────────
  const resources: TriggerPackResources = {
    ...emptyResources(),
    bindings: { ...plan.priorResources.bindings },
    edgeSourceId: plan.priorResources.edgeSourceId,
  };
  for (const [targetId, planned] of plan.plans) {
    resources.plans[targetId] = { planSlug: planned.planSlug, templateSha256: sha256(planned.content) };
  }
  const upserted = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_pack_installations
      (workspace_id, harness_slug, plugin_name, plugin_version, source_mappings, inputs, resources, manifest, created_by)
    VALUES (
      ${workspaceId}, ${input.harnessSlug}, ${manifest.name}, ${manifest.version},
      ${JSON.stringify(plan.sourceMappings)}::text::jsonb, ${JSON.stringify(plan.inputs)}::text::jsonb,
      ${JSON.stringify(resources)}::text::jsonb, ${JSON.stringify(manifest)}::text::jsonb, ${createdBy}
    )
    ON CONFLICT (workspace_id, harness_slug, plugin_name) DO UPDATE SET
      plugin_version = EXCLUDED.plugin_version,
      manifest = EXCLUDED.manifest,
      source_mappings = EXCLUDED.source_mappings,
      inputs = EXCLUDED.inputs,
      resources = harness_shared.trigger_pack_installations.resources
                  || jsonb_build_object('plans', EXCLUDED.resources -> 'plans'),
      updated_at = now()
    RETURNING id::text AS id`;
  const installationId = upserted[0]!.id;

  // ── 2. Plan targets through the existing template installer ───────────────
  for (const planned of plan.plans.values()) {
    await ensureFlagshipPlan(sql, workspaceId, {
      harnessSlug: input.harnessSlug,
      planSlug: planned.planSlug,
      content: planned.content,
      inputSchema: planned.target.inputSchema,
    });
  }

  // ── 3. Edge source + its canonical datatype, only when the pack has edges ──
  if (pack.edges.length > 0) {
    resources.edgeSourceId = await ensureEdgeSource(sql, workspaceId, createdBy);
  }
  for (const datatype of [...plan.datatypes, ...(pack.edges.length > 0 ? [TRIGGER_RUN_COMPLETION_DATATYPE] : [])]) {
    if (!(await getDatatype(sql, workspaceId, datatype))) {
      const installed = await installPublishedDatatype(sql, datatype, workspaceId);
      if (!installed.ok && installed.reason !== 'already_present') {
        throw new Error(`trigger_pack_datatype_install_failed:${datatype}:${installed.reason}`);
      }
    }
  }

  // ── 4. Bindings, upstream before downstream, all disarmed ─────────────────
  const unmet: TriggerPackUnmet[] = plan.inputsUnmet ? [plan.inputsUnmet] : [];
  const bound = new Map<string, string>();
  const nextBindings: TriggerPackResources['bindings'] = {};
  const defaultStorm = pack.defaultStormPolicy as Record<string, unknown> | undefined;
  for (const binding of plan.ordered) {
    const planned = plan.plans.get(binding.target)!;
    if (binding.source.kind === 'manual') {
      resources.entryPoints.push({ bindingId: binding.id, targetId: binding.target, planSlug: planned.planSlug });
      continue;
    }
    const stormPolicy = (binding.stormPolicy as Record<string, unknown> | undefined) ?? defaultStorm;
    let shape: BindingShape;
    let kind: 'external' | 'edge';
    if (binding.source.kind === 'external') {
      const resolved = plan.resolved.get(binding.id)!;
      if (!resolved.ok) {
        unmet.push(resolved.unmet);
        continue;
      }
      const pattern = binding.eventPattern!.trim();
      shape = {
        sourceId: resolved.sourceId,
        planHarnessSlug: input.harnessSlug,
        planSlug: planned.planSlug,
        eventPattern: binding.source.datatype ? `ext:${resolved.sourceKind}:${pattern.slice('ext:*:'.length)}` : pattern,
        eventFilter: asRecord(binding.filter),
        datatypeId: binding.source.datatype ?? null,
        planInput: plan.inputs,
      };
      kind = 'external';
    } else {
      const upstreamPackId = plan.upstreamOf.get(binding.id)!;
      const upstreamBindingId = bound.get(upstreamPackId);
      if (!upstreamBindingId) {
        unmet.push({
          bindingId: binding.id,
          reason: 'upstream-unmet',
          requirement: { kind: 'upstream', upstreamBindingId: upstreamPackId },
          candidates: [],
        });
        continue;
      }
      shape = {
        sourceId: resources.edgeSourceId!,
        planHarnessSlug: input.harnessSlug,
        planSlug: planned.planSlug,
        eventPattern: TRIGGER_PACK_EDGE_EVENT_KEY,
        eventFilter: { ...asRecord(binding.filter), upstreamBindingId },
        datatypeId: TRIGGER_RUN_COMPLETION_DATATYPE,
        planInput: plan.inputs,
      };
      kind = 'edge';
    }
    const triggerBindingId = await reuseOrCreateBinding(
      sql,
      workspaceId,
      installationId,
      resources.bindings[binding.id]?.triggerBindingId,
      shape,
      stormPolicy,
      createdBy,
    );
    bound.set(binding.id, triggerBindingId);
    nextBindings[binding.id] = { triggerBindingId, sourceId: shape.sourceId, kind };
  }
  // A previously bound binding that is now unmet must stop: detach it.
  for (const [packBindingId, recorded] of Object.entries(resources.bindings)) {
    if (!nextBindings[packBindingId]) await detachExternalTriggerBinding(sql, workspaceId, recorded.triggerBindingId);
  }
  resources.bindings = nextBindings;

  // ── 5. Finalize: status follows the unmet list ────────────────────────────
  const status = unmet.length === 0 ? 'configured' : 'needs-configuration';
  await sql`
    UPDATE harness_shared.trigger_pack_installations
       SET resources = ${JSON.stringify(resources)}::text::jsonb,
           unmet = ${JSON.stringify(unmet)}::text::jsonb,
           status = ${status},
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND id = ${installationId}::uuid`;

  // ── 6. Update returns to review (P-013, D-016 §4) ─────────────────────────
  // The plugin version is part of the review, so every version update differs;
  // an identical re-configure keeps a reviewed pack armed.
  const review = await reconcileTriggerPackReview(sql, workspaceId, installationId);

  return {
    id: installationId,
    workspaceId,
    harnessSlug: input.harnessSlug,
    pluginName: manifest.name,
    pluginVersion: manifest.version,
    status,
    sourceMappings: plan.sourceMappings,
    inputs: plan.inputs,
    resources,
    unmet,
    armed: review.current && review.armedBindingCount > 0,
    review: { fingerprint: review.fingerprint, reviewed: review.current },
  };
}
