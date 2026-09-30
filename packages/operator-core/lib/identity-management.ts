/** P-011 identity library, explain/diff, and live-stack mutation on existing stores. */
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, rmdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { getOrgPg } from '@papercusp/db-org';
import { BlueprintSourceDocumentSchema, resolveBlueprintSource,
  type ResolvedAgentSpecification, type SessionActivation } from '@papercusp/orchestrator/blueprint';
import {
  attachLayer,
  bindingRefs,
  detachLayer,
  stackBindingFromRefs,
  type MutationDelivery,
  type SlotId,
  SLOT_SPECS,
} from '@papercusp/orchestrator/blueprint';
import { listIdentitySources, getIdentitySource, inspectIdentitySource,
  identityLaunchCompatibility } from './agent-identities/source';
import { availableBlueprintSources, operatorResolveExtends } from './blueprint/installed-blueprints';
import { papercuspPathForWorkspace } from './papercusp-root';
import { provisionLaunchIdentityResources } from './role-launch-spec';
import { resolveProjectDir } from './spawn-config';
import {
  IDENTITY_HISTORY_LIMIT,
  parseSuLaunchSpecRecord,
  rebuildSuLaunchArtifact,
  type SuLaunchArtifactHistoryEntry,
  type SuLaunchSpecRecord,
  type SelectedIdentityPin,
} from './su-persona-render';
import { requestSessionIdentityActivationInTransaction } from './agent-tools/coordination/control-anchor';
import { findLiveHost, injectIntoHost } from './events/await/psu-pty-discovery';
import { tagTurnForInjection } from './turn-provenance/turn-provenance';

const HISTORY_LIMIT = IDENTITY_HISTORY_LIMIT;
const TRANSITION_LIMIT = 30;

interface SessionRow {
  id: number | string;
  coord_owner_id: string;
  mode: string;
  launch_spec: unknown;
  control_state: Record<string, unknown> | null;
}

interface TransitionRow {
  phase: 'desired' | 'prepared' | 'applied' | 'failed';
  source: string;
  specification_revision: string;
  state_revision: string;
  stack_refs: unknown;
  failure: string | null;
  recorded_at: Date | string;
}

export interface IdentityDiffRow {
  field: string;
  applied: unknown;
  selected: unknown;
  origin: string | null;
}

export interface IdentitySurface {
  workspaceId: string;
  ownerId: string | null;
  identities: Awaited<ReturnType<typeof listIdentitySources>>['identities'];
  unreadable: Awaited<ReturnType<typeof listIdentitySources>>['unreadable'];
  catalogAfter: string | null;
  catalogNextAfter: string | null;
  catalogScanned: number;
  session: null | {
    ownerId: string;
    agent: string;
    principalId: string;
    harnessSlug: string | null;
    explicitStack: string[];
    effectiveStack: string[];
    appliedStack: string[];
    specificationRevision: string | null;
    stateRevision: string | null;
    activation: SessionActivation | null;
    artifact: ResolvedAgentSpecification | null;
    appliedArtifact: ResolvedAgentSpecification | null;
    history: SuLaunchArtifactHistoryEntry[];
  };
  transitions: Array<{
    phase: TransitionRow['phase'];
    source: string;
    specificationRevision: string;
    stateRevision: string;
    stackRefs: string[];
    failure: string | null;
    recordedAt: string;
  }>;
  bindings: { available: false; milestone: 'M3'; message: string };
}

function stringRefs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function activationFromControl(value: Record<string, unknown> | null): SessionActivation | null {
  const activation = value?.activation;
  return activation && typeof activation === 'object' ? (activation as SessionActivation) : null;
}

function historyArtifact(
  record: SuLaunchSpecRecord,
  revision: { specificationRevision: string; stateRevision: string } | null,
) {
  if (!revision) return null;
  if (
    record.specificationRevision === revision.specificationRevision &&
    record.stateRevision === revision.stateRevision
  )
    return record.specificationArtifact ?? null;
  return (
    record.identityHistory?.find(
      (entry) =>
        entry.specificationRevision === revision.specificationRevision &&
        entry.stateRevision === revision.stateRevision,
    )?.specificationArtifact ?? null
  );
}

export async function readIdentitySurface(input: {
  workspaceId: string;
  ownerId?: string | null;
  after?: string | null;
  limit?: number;
  sql?: Sql;
}): Promise<IdentitySurface> {
  const sql = input.sql ?? getOrgPg().sql;
  const ownerId = input.ownerId?.trim() || null;
  const rows = ownerId
    ? await sql<SessionRow[]>`
        SELECT a.id, a.coord_owner_id, a.mode,
               to_jsonb(a)->'launch_spec' AS launch_spec, b.control_state
          FROM harness_shared.adv_sessions a
          LEFT JOIN harness_shared.session_briefs b
            ON b.workspace_id = a.workspace_id AND b.owner_id = a.coord_owner_id
         WHERE a.workspace_id = ${input.workspaceId}
           AND a.coord_owner_id = ${ownerId}
         ORDER BY (a.ended_at IS NULL AND a.ended_by IS NULL) DESC, a.started_at DESC, a.id DESC
         LIMIT 1
      `
    : [];
  const row = rows[0] ?? null;
  const record = row ? parseSuLaunchSpecRecord(row.launch_spec) : null;
  const repoDir = record?.harnessSlug
    ? await resolveProjectDir(record.harnessSlug, input.workspaceId).catch(() => null)
    : papercuspPathForWorkspace(input.workspaceId);
  const catalog = await listIdentitySources({ ...(repoDir ? { repoDir } : {}),
    after: input.after?.trim() || undefined, limit: input.limit ?? 30 });
  const events = ownerId
    ? await sql<TransitionRow[]>`
        SELECT phase, source, specification_revision, state_revision,
               stack_refs, failure, recorded_at
          FROM harness_shared.session_identity_activation_events
         WHERE workspace_id = ${input.workspaceId} AND owner_id = ${ownerId}
         ORDER BY recorded_at DESC, id DESC
         LIMIT ${TRANSITION_LIMIT}
      `
    : [];
  const transitions = events.map((event) => ({
    phase: event.phase,
    source: event.source,
    specificationRevision: event.specification_revision,
    stateRevision: event.state_revision,
    stackRefs: stringRefs(event.stack_refs),
    failure: event.failure,
    recordedAt: new Date(event.recorded_at).toISOString(),
  }));
  const activation = activationFromControl(row?.control_state ?? null);
  const applied = activation?.applied ?? null;
  const appliedEvent = transitions.find(
    (event) =>
      event.phase === 'applied' &&
      (!applied ||
        (event.specificationRevision === applied.specificationRevision &&
          event.stateRevision === applied.stateRevision)),
  );
  return {
    workspaceId: input.workspaceId,
    ownerId,
    identities: catalog.identities,
    unreadable: catalog.unreadable,
    catalogAfter: input.after?.trim() || null,
    catalogNextAfter: catalog.nextAfter,
    catalogScanned: catalog.scanned,
    session:
      row && record
        ? {
            ownerId: row.coord_owner_id,
            agent: record.agent,
            principalId: record.principalId ?? row.coord_owner_id,
            harnessSlug: record.harnessSlug,
            explicitStack: [...(record.stack ?? [])],
            effectiveStack: stringRefs(row.control_state?.stack),
            appliedStack: appliedEvent?.stackRefs ?? [],
            specificationRevision: record.specificationRevision ?? null,
            stateRevision: record.stateRevision ?? null,
            activation,
            artifact: record.specificationArtifact ?? null,
            appliedArtifact: historyArtifact(record, applied),
            history: record.identityHistory ?? [],
          }
        : null,
    transitions,
    bindings: {
      available: false,
      milestone: 'M3',
      message: 'Provider bindings arrive in M3. Existing pot bindings remain unchanged.',
    },
  };
}

/** A named composition is another validated abstract blueprint source in the
 * existing local library. Its SU role stack preserves the exact selected slot
 * of each component without assigning a slot to the composition container. */
export async function previewNamedIdentityComposition(input: {
  id: string;
  description?: string;
  componentRefs: string[];
  repoDir: string;
}) {
  if (!/^[a-z][a-z0-9._-]{1,119}$/.test(input.id)) {
    throw new Error('identity name must be a lowercase blueprint id');
  }
  if (input.componentRefs.length < 1 || input.componentRefs.length > 40) {
    throw new Error('named identity needs 1-40 selected components');
  }
  const ids = new Set<string>();
  const sources = new Map(availableBlueprintSources({ localDirs: [
    join(input.repoDir, '.papercusp', 'blueprints'),
  ] }).map((entry) => [entry.id, entry]));
  const components = [] as Array<{ ref: string; id: string; tier: string; version: string | null;
    sourceRevision: string }>;
  for (const ref of input.componentRefs) {
    const matched = /^([a-z][a-z0-9-]*):([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(ref);
    if (!matched) throw new Error(`invalid component ref ${ref}`);
    const [, slot, id] = matched;
    if (ids.has(id!)) throw new Error(`identity component ${id} was selected twice`);
    ids.add(id!);
    const selected = await getIdentitySource(id!, { repoDir: input.repoDir });
    if (!selected.ok || !selected.identity.slots.some((entry) => entry.slot === slot)) {
      throw new Error(`component ${ref} is unavailable or does not declare its selected slot`);
    }
    components.push({ ref, id: id!, tier: sources.get(id!)?.tier ?? 'unknown',
      version: selected.identity.version ?? null,
      sourceRevision: selected.contentHash });
  }
  const existing = await getIdentitySource(input.id, { repoDir: input.repoDir });
  if (existing.ok || !('error' in existing) || existing.error !== 'identity-not-found') {
    throw new Error(`identity ${input.id} already exists or shadows another source`);
  }
  const source = { id: input.id, extends: components.map((entry) => entry.id),
    version: '1.0.0', description: input.description?.trim() || `Named composition ${input.id}`,
    slots: [] as [], roles: [{ id: 'su', stack: components.map((entry) => entry.ref) }] };
  const inspected = inspectIdentitySource(source, { repoDir: input.repoDir });
  if (!inspected.ok) {
    const details = 'errors' in inspected && Array.isArray(inspected.errors)
      ? inspected.errors.map((issue) => `${issue.code}: ${issue.message}`).join('; ') : '';
    throw new Error(details || ('error' in inspected ? String(inspected.error) : 'identity composition is invalid'));
  }
  const resolve = operatorResolveExtends({ localDirs: [join(input.repoDir, '.papercusp', 'blueprints')] });
  const resolved = resolveBlueprintSource(source, { resolve });
  if (!resolved.validation.ok) throw new Error('identity composition failed source resolution');
  const configuration = BlueprintSourceDocumentSchema.parse(resolved.merged);
  return { id: source.id, source, yaml: stringifyYaml(source, { lineWidth: 100 }),
    components, preview: {
      layers: resolved.layers.map((layer) => ({ id: layer.id, revision: layer.contentHash })),
      bundles: configuration.bundles ?? [], grants: configuration.grants ?? null,
      knobs: configuration.knobs ?? null, contributions: configuration.contributions ?? [],
      launchCompatibility: identityLaunchCompatibility(configuration, source.slots),
    } };
}

export async function saveNamedIdentityComposition(input: Parameters<typeof previewNamedIdentityComposition>[0]) {
  const prepared = await previewNamedIdentityComposition(input);
  const root = await realpath(input.repoDir);
  const parent = join(root, '.papercusp', 'blueprints');
  await mkdir(parent, { recursive: true });
  const actualParent = await realpath(parent);
  const within = relative(root, actualParent);
  if (within === '..' || within.startsWith('../') || isAbsolute(within)) {
    throw new Error('identity library escapes the selected workspace');
  }
  const target = join(actualParent, prepared.id);
  await mkdir(target);
  const temporary = join(target, `.blueprint-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, prepared.yaml, { flag: 'wx' });
    await rename(temporary, join(target, 'blueprint.yaml'));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    await rmdir(target).catch(() => {});
    throw error;
  }
  return { ok: true as const, id: prepared.id, preview: prepared.preview,
    components: prepared.components };
}

function flatten(value: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (out.size >= 200) return out;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flatten(entry, `${prefix}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (prefix) out.set(prefix, value);
  return out;
}

export function diffIdentitySpecifications(
  applied: ResolvedAgentSpecification | null | undefined,
  selected: ResolvedAgentSpecification | null | undefined,
): IdentityDiffRow[] {
  const a = flatten(
    applied
      ? {
          configuration: applied.configuration,
          inputs: applied.inputs.map(({ kind, ...rest }) => ({
            kind,
            ...('bytes' in rest ? { ...rest, bytes: `[${String(rest.bytes).length} bytes]` } : rest),
          })),
        }
      : null,
  );
  const b = flatten(
    selected
      ? {
          configuration: selected.configuration,
          inputs: selected.inputs.map(({ kind, ...rest }) => ({
            kind,
            ...('bytes' in rest ? { ...rest, bytes: `[${String(rest.bytes).length} bytes]` } : rest),
          })),
        }
      : null,
  );
  const provenance = new Map((selected?.provenance ?? []).map((entry) => [entry.path, entry.sourceRef]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((field) => JSON.stringify(a.get(field)) !== JSON.stringify(b.get(field)))
    .slice(0, 200)
    .map((field) => ({
      field,
      applied: a.get(field) ?? null,
      selected: b.get(field) ?? null,
      origin: provenance.get(field) ?? null,
    }));
}

export type IdentityMutationAction = 'preview' | 'attach' | 'switch' | 'detach' | 'rollback';

export interface IdentityMutationInput {
  workspaceId: string;
  ownerId: string;
  action: IdentityMutationAction;
  identityId?: string | null;
  slot?: string | null;
  operatorBaseUrl: string;
  modeSection: string;
}

export interface IdentityMutationResult {
  ok: true;
  changed: boolean;
  action: IdentityMutationAction;
  delivery: MutationDelivery | null;
  stack: string[];
  replaced: string | null;
  specificationRevision: string;
  stateRevision: string;
  diff: IdentityDiffRow[];
  activation: SessionActivation | null;
  nudge: { queued: boolean; reason: string | null };
}

function historyWithCurrent(record: SuLaunchSpecRecord): SuLaunchArtifactHistoryEntry[] {
  const current =
    record.specificationArtifact && record.specificationRevision && record.stateRevision
      ? [
          {
            stack: [...(record.stack ?? [])],
            ...(record.selectedIdentity !== undefined
              ? { selectedIdentity: record.selectedIdentity } : {}),
            specificationRevision: record.specificationRevision,
            stateRevision: record.stateRevision,
            specificationArtifact: record.specificationArtifact,
            recordedAt: new Date().toISOString(),
          } satisfies SuLaunchArtifactHistoryEntry,
        ]
      : [];
  const seen = new Set<string>();
  return [...current, ...(record.identityHistory ?? [])]
    .filter((entry) => {
      const key = `${entry.specificationRevision}:${entry.stateRevision}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, HISTORY_LIMIT);
}

export async function resolveIdentityStackMutation(
  input: IdentityMutationInput,
  record: SuLaunchSpecRecord,
  repoDir: string | null,
): Promise<{ stack: string[]; selectedIdentity: SelectedIdentityPin | null;
  delivery: MutationDelivery | null; replaced: string | null; changed: boolean }> {
  if (input.action === 'rollback') {
    const prior = record.identityHistory?.[0];
    if (!prior) throw new Error('No prior identity revision is available to roll back to.');
    return { stack: [...prior.stack], selectedIdentity: prior.selectedIdentity ?? null,
      delivery: 'relaunch-with-carry', replaced: null, changed: true };
  }
  const identityId = input.identityId?.trim() || '';
  const slotRaw = input.slot?.trim() || '';
  if (!identityId) throw new Error('identityId is required');
  const identity = await getIdentitySource(identityId, { ...(repoDir ? { repoDir } : {}) });
  if (!identity.ok) {
    const validationDetail =
      'errors' in identity && Array.isArray(identity.errors)
        ? identity.errors
            .map((entry) => {
              if (!entry || typeof entry !== 'object') return String(entry);
              const value = entry as { code?: unknown; message?: unknown };
              return [value.code, value.message].filter(Boolean).join(': ');
            })
            .filter(Boolean)
            .join('; ')
        : '';
    throw new Error(
      identity.error ||
        validationDetail ||
        `Unable to read identity source ${identityId}`,
    );
  }
  const declared = identity.identity.slots.find((entry) => !slotRaw || entry.slot === slotRaw);
  if (!declared)
    throw new Error(
      slotRaw ? `${identityId} does not declare slot ${slotRaw}` : `${identityId} declares no selectable slot`,
    );
  const slot = declared.slot as SlotId;
  const binding = stackBindingFromRefs(record.stack ?? []);
  const mutation =
    input.action === 'detach'
      ? detachLayer(binding, { slot, id: identityId })
      : attachLayer(binding, { slot, id: identityId });
  if (input.action === 'switch' && SLOT_SPECS[slot].cardinality !== 'exclusive') {
    throw new Error(`switch requires an exclusive slot; ${slot} is additive`);
  }
  return {
    stack: bindingRefs(mutation.after),
    selectedIdentity: mutation.changed ? null : record.selectedIdentity ?? null,
    delivery: mutation.changed ? mutation.delivery : null,
    replaced: mutation.replaced?.id ?? null,
    changed: mutation.changed,
  };
}

async function nudgeOwner(
  ownerId: string,
  delivery: MutationDelivery | null,
): Promise<{ queued: boolean; reason: string | null }> {
  if (!delivery) return { queued: false, reason: null };
  const host = findLiveHost(ownerId);
  if (!host)
    return {
      queued: false,
      reason: 'session host is not currently reachable; wake or resume the session, then retry delivery',
    };
  const message =
    delivery === 'relaunch-with-carry'
      ? 'A domain/client identity change is ready and requires a fresh context. Finish the atomic step in hand, checkpoint current work, then call session:request-compaction at the clean boundary. The successor will rebuild from the new explicit identity stack; do not treat the desired identity as applied before that acknowledgement.'
      : 'A soft identity stack change is ready. Continue normally; the control transition attached to this turn carries the validated layer and the host acknowledgement records when it becomes applied.';
  let data = message;
  try {
    data = tagTurnForInjection({ sid: ownerId, origin: 'coord-inject:identity-management', text: message }).taggedText;
  } catch {
    /* a provenance write must not hide the delivery failure */
  }
  const queued = await injectIntoHost(host.sock, { mode: 'turn', data, ownerId });
  return {
    queued,
    reason: queued ? null : 'the session host refused the delivery nudge; retry after the session is idle',
  };
}

export async function mutateIdentityStack(input: IdentityMutationInput): Promise<IdentityMutationResult> {
  const sql = getOrgPg().sql;
  const rows = await sql<SessionRow[]>`
    SELECT a.id, a.coord_owner_id, a.mode,
           to_jsonb(a)->'launch_spec' AS launch_spec, b.control_state
      FROM harness_shared.adv_sessions a
      LEFT JOIN harness_shared.session_briefs b
        ON b.workspace_id = a.workspace_id AND b.owner_id = a.coord_owner_id
     WHERE a.workspace_id = ${input.workspaceId} AND a.coord_owner_id = ${input.ownerId}
     ORDER BY (a.ended_at IS NULL AND a.ended_by IS NULL) DESC, a.started_at DESC, a.id DESC
     LIMIT 1
  `;
  const row = rows[0];
  const record = parseSuLaunchSpecRecord(row?.launch_spec);
  if (!row || !record) throw new Error('The selected session has no mutable launch specification.');
  const repoDir = record.harnessSlug
    ? await resolveProjectDir(record.harnessSlug, input.workspaceId).catch(() => null)
    : null;
  const mutation = await resolveIdentityStackMutation(input, record, repoDir);
  const rebuilt = await rebuildSuLaunchArtifact({
    ownerId: input.ownerId,
    operatorBaseUrl: input.operatorBaseUrl,
    record,
    stack: mutation.stack,
    selectedIdentity: mutation.selectedIdentity,
    modeSection: input.modeSection,
  });
  const diff = diffIdentitySpecifications(
    historyArtifact(record, activationFromControl(row.control_state)?.applied ?? null),
    rebuilt.artifact.specificationArtifact,
  );
  if (input.action === 'preview' || !mutation.changed) {
    return {
      ok: true,
      changed: mutation.changed,
      action: input.action,
      delivery: mutation.delivery,
      stack: mutation.stack,
      replaced: mutation.replaced,
      specificationRevision: rebuilt.artifact.specificationRevision,
      stateRevision: rebuilt.artifact.stateRevision,
      diff,
      activation: activationFromControl(row.control_state),
      nudge: { queued: false, reason: null },
    };
  }
  await provisionLaunchIdentityResources(rebuilt.artifact, sql, { ownerId: input.ownerId });
  const nextRecord: SuLaunchSpecRecord = {
    ...record,
    stack: rebuilt.artifact.stack,
    selectedIdentity: mutation.selectedIdentity,
    specificationRevision: rebuilt.artifact.specificationRevision,
    stateRevision: rebuilt.artifact.stateRevision,
    specificationArtifact: rebuilt.artifact.specificationArtifact,
    identityHistory: historyWithCurrent(record),
  };
  const anchor = await sql.begin(async (tx) => {
    const transaction = tx as unknown as Sql;
    const updated = await transaction<Array<{ id: number | string }>>`
      UPDATE harness_shared.adv_sessions
         SET launch_spec = ${JSON.stringify(nextRecord)}::jsonb
       WHERE id = ${row.id}
         AND workspace_id = ${input.workspaceId}
         AND coord_owner_id = ${input.ownerId}
         AND launch_spec = ${JSON.stringify(row.launch_spec)}::jsonb
      RETURNING id
    `;
    if (updated.length === 0)
      throw new Error('The session identity changed concurrently; reload and review the new diff.');
    return requestSessionIdentityActivationInTransaction({
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      revision: {
        specificationRevision: rebuilt.artifact.specificationRevision,
        stateRevision: rebuilt.artifact.stateRevision,
      },
      attribution: {
        actorId: input.ownerId,
        principalId: record.principalId ?? input.ownerId,
        sessionId: input.ownerId,
      },
      source: 'restart',
      sql: transaction,
    });
  });
  const nudge = await nudgeOwner(input.ownerId, mutation.delivery);
  return {
    ok: true,
    changed: true,
    action: input.action,
    delivery: mutation.delivery,
    stack: mutation.stack,
    replaced: mutation.replaced,
    specificationRevision: rebuilt.artifact.specificationRevision,
    stateRevision: rebuilt.artifact.stateRevision,
    diff,
    activation: anchor.state.activation ?? null,
    nudge,
  };
}
