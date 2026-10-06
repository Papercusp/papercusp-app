/**
 * The `record` admission source (enterprise-data-sources-2026-10-01 P-020, D-011, D-030).
 *
 * A record is an ingested ticket (or any record-nature datatype) stored as a work_items row
 * tagged nature='record' — the deterministic row the connector driver's datatype destination
 * sink writes (generalized-integrations-google-migration-cupboard-workflows-2026-10-05 D-015).
 * A record is DATA: it is never claimable. Admitting it mints a separate issue-family work item
 * that links back to the record with rel 'about'.
 *
 * Identity: the record's own id. It is deterministic over (workspace, data source, datatype,
 * provider object), so it is stable across re-syncs and re-ingest.
 *
 * Write-back, dispatched by CAPABILITY (D-015.5; linear-asana-task-sync P-002):
 *   - `<datatype>.comment`    a plain-text comment on the source object;
 *   - `<datatype>.transition` a move to a canonical workflow category (ticket-vocabulary).
 * The record's data source names its provider (resolved from the source id, never from a
 * provider name); that provider must offer the capability and is invoked through a host.fetch
 * bound to exactly that one source. The coordinates come from the durable admission's
 * source_ref, never from the caller. A provider that does not offer the capability is refused
 * with `provider_capability_unsupported:<provider>:<capability>` before any host.fetch exists.
 * Field authority is unchanged: a transition sends only the target category, never the
 * source-owned title, description or assignee.
 */
import type postgres from 'postgres';
import type { HostFetch } from '@papercusp/plugin-sdk';
import { pinModuleState } from '@papercusp/module-singleton';
import { providerRegistry, type ProviderRegistry, type RegisteredProvider } from '../integrations/provider-registry';
import { createSourceHostFetch } from '../integrations/source-host-fetch';
import { ProviderCapabilityUnsupported } from '../capability-verbs/provider-dispatch';
import { isTicketStatusCategory, TICKET_STATUS_CATEGORIES } from '../data-sources/ticket-vocabulary';
import {
  DEFAULT_FIELD_AUTHORITY,
  registerAdmissionSource,
  type AdmissionDb,
  type AdmissionRefusal,
  type AdmissionRow,
  type AdmissionSourceResolver,
  type ResolvedAdmissionSource,
} from './admission-sources';

export const RECORD_SOURCE_KIND = 'record';

export interface RecordRef {
  recordId: string;
}

export interface RecordSourceDeps {
  registry?: ProviderRegistry;
  /** host.fetch bound to exactly the record's source. Production: createSourceHostFetch. */
  hostFetchFor?: (
    db: postgres.Sql,
    input: { workspaceId: string; providerId: string; sourceId: string; harness: string },
  ) => HostFetch;
}

/** The capability a record of `datatype` is written back through: `<datatype>.comment`. */
export function recordWriteBackCapability(datatype: string): string {
  return `${datatype.replace(/-/g, '')}.comment`;
}

/** The capability that moves a record of `datatype` to a workflow category: `<datatype>.transition`. */
export function recordTransitionCapability(datatype: string): string {
  return `${datatype.replace(/-/g, '')}.transition`;
}

interface RecordRow {
  feature_id: string;
  kind: string | null;
  title: string | null;
  summary: string | null;
  nature: string | null;
  payload: Record<string, unknown> | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function refuse(code: string, message: string): AdmissionRefusal {
  return { refused: true, code, message };
}

/** The resolved snapshot of a record row. Exported so the rule path and the re-sync share it. */
export function recordSnapshot(payload: Record<string, unknown>, rowTitle?: string | null): {
  title: string;
  body: string;
  permalink: string | null;
} {
  const externalId = str(payload.externalId);
  const title = str(payload.title) || str(rowTitle) || externalId;
  return {
    title: externalId && title !== externalId ? `${externalId}: ${title}` : title,
    body: typeof payload.body === 'string' ? payload.body : '',
    permalink: str(payload.url) || null,
  };
}

function defaultHostFetchFor(
  db: postgres.Sql,
  input: { workspaceId: string; providerId: string; sourceId: string; harness: string },
): HostFetch {
  return createSourceHostFetch(db, {
    providerId: input.providerId,
    workspaceId: input.workspaceId,
    harness: input.harness,
    sourceIds: [input.sourceId],
  });
}

export function createRecordAdmissionSource(deps: RecordSourceDeps = {}): AdmissionSourceResolver<RecordRef> {
  const registryOf = () => deps.registry ?? providerRegistry();
  const hostFetchFor = deps.hostFetchFor ?? defaultHostFetchFor;
  return {
    kind: RECORD_SOURCE_KIND,
    parseRef(raw) {
      const recordId = str(raw.recordId);
      if (!recordId) throw new Error('admission_source_invalid: record source needs { recordId }');
      if (recordId.length > 200) throw new Error('admission_source_invalid: recordId is too long');
      return { recordId };
    },
    async resolve(ctx, ref): Promise<ResolvedAdmissionSource | AdmissionRefusal> {
      const [row] = await ctx.db<RecordRow[]>`
        SELECT feature_id, item_kind AS kind, title, summary, nature, payload
          FROM harness_shared.work_items
         WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ${ref.recordId}
         LIMIT 1`;
      if (!row) return refuse('source_not_found', `no record '${ref.recordId}' in this workspace`);
      if (row.nature !== 'record') {
        return refuse('not_a_record', `'${ref.recordId}' is not a record (nature=${row.nature ?? 'work'}); only DATA is admitted`);
      }
      const payload = row.payload ?? {};
      const dataSourceId = str(payload.dataSourceId) || null;
      const snap = recordSnapshot(payload, row.title);
      return {
        dataSourceId,
        sourceKey: row.feature_id,
        title: snap.title,
        body: snap.body,
        permalink: snap.permalink,
        recordWorkItemId: row.feature_id,
        sourceRef: {
          recordId: row.feature_id,
          ...(str(row.kind) ? { datatype: str(row.kind) } : {}),
          ...(str(payload.provider) ? { provider: str(payload.provider) } : {}),
          ...(str(payload.externalId) ? { externalId: str(payload.externalId) } : {}),
          ...(str(payload.container) ? { container: str(payload.container) } : {}),
          ...(Number.isInteger(payload.number) ? { number: payload.number } : {}),
          ...(snap.permalink ? { url: snap.permalink } : {}),
        },
        fieldAuthority: DEFAULT_FIELD_AUTHORITY,
      };
    },
    async writeBack({ db, admission, text }) {
      const target = await resolveRecordTarget(db, admission, recordWriteBackCapability, registryOf());
      const result = await invokeRecordTarget(target, hostFetchFor, { externalId: target.externalId, text });
      return { posted: true, externalRef: str(result.externalRef) || null, updateId: str(result.updateId) || null };
    },
    async transition({ db, admission, toCategory }) {
      if (!isTicketStatusCategory(toCategory)) {
        throw new Error(`transition_category_invalid:${toCategory} (expected one of ${TICKET_STATUS_CATEGORIES.join('|')})`);
      }
      const target = await resolveRecordTarget(db, admission, recordTransitionCapability, registryOf());
      // Only the category travels: title, description and assignee belong to the source (D-004).
      const result = await invokeRecordTarget(target, hostFetchFor, { externalId: target.externalId, toCategory });
      return {
        transitioned: result.changed !== false,
        updateId: str(result.updateId) || null,
        externalRef: str(result.externalRef) || null,
      };
    },
  };
}

interface RecordTarget {
  sql: postgres.Sql;
  workspaceId: string;
  sourceId: string;
  harness: string;
  externalId: string;
  provider: RegisteredProvider;
  capability: string;
  /** The source's config, handed to the provider as `syncPage` gets it (a write may need its mapping). */
  config: Record<string, unknown>;
}

/**
 * The provider, capability and coordinates a write to this admission's record goes through.
 * The provider is the one registered for the record's data source KIND (looked up by source id);
 * a provider without the capability is refused here, before any host.fetch is built.
 */
async function resolveRecordTarget(
  db: AdmissionDb,
  admission: AdmissionRow,
  capabilityFor: (datatype: string) => string,
  registry: ProviderRegistry,
): Promise<RecordTarget> {
  const ref = admission.sourceRef;
  const sourceId = str(admission.dataSourceId);
  const datatype = str(ref.datatype);
  const externalId = str(ref.externalId);
  if (!sourceId || !datatype || !externalId) throw new Error('write_back_coordinates_missing');
  const sql = db as unknown as postgres.Sql;
  const [source] = await sql<Array<{ kind: string; config: Record<string, unknown> | null }>>`
    SELECT kind, config FROM harness_shared.data_sources
     WHERE workspace_id = ${admission.workspaceId} AND id = ${sourceId}::uuid`;
  if (!source) throw new Error(`write_back_source_missing:${sourceId}`);
  const provider = registry.get(source.kind);
  if (!provider) throw new Error(`write_back_provider_not_registered:${source.kind}`);
  const capability = capabilityFor(datatype);
  if (!provider.descriptor.capabilities.includes(capability)) {
    throw new ProviderCapabilityUnsupported(provider.descriptor.id, capability);
  }
  const harness = str(source.config?.harnessSlug);
  if (!harness) throw new Error(`write_back_source_harness_missing:${sourceId}`);
  return { sql, workspaceId: admission.workspaceId, sourceId, harness, externalId, provider, capability, config: source.config ?? {} };
}

async function invokeRecordTarget(
  target: RecordTarget,
  hostFetchFor: NonNullable<RecordSourceDeps['hostFetchFor']>,
  args: Record<string, unknown>,
): Promise<{ externalRef?: unknown; updateId?: unknown; changed?: unknown }> {
  const fetch = hostFetchFor(target.sql, {
    workspaceId: target.workspaceId,
    providerId: target.provider.descriptor.id,
    sourceId: target.sourceId,
    harness: target.harness,
  });
  const result = await target.provider.adapter.invoke(
    { source: target.sourceId, capability: target.capability, args, config: target.config },
    { fetch },
  );
  return result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
}

/** The process-wide registration. Idempotent across module re-imports (same object). */
export const recordAdmissionSource = pinModuleState(
  '@papercusp/operator-core.work-admission.record-source',
  () => createRecordAdmissionSource(),
);
registerAdmissionSource(recordAdmissionSource);
