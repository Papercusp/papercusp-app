/**
 * Datatype destination sinks for connector records (plan
 * generalized-integrations-google-migration-cupboard-workflows-2026-10-05, P-010 / D-015).
 *
 * The host-owned connector driver ingests every provider record through
 * `ingestExternalTriggerEvent`. These sinks put the record where its DATATYPE belongs,
 * decided by two inputs only — the datatype registry's `nature` for the datatype and the
 * data source's `destination_policy` — never by which provider produced it:
 *
 *   - `record`   -> one work_items row per (source, datatype, native id), payload merged on
 *                   every new version, then the source's admission rules (a record is DATA,
 *                   never claimable; an enabled rule may admit it as work).
 *   - `event`    -> one create-once work_items row per (source, datatype, native id).
 *   - `document` -> one documents-corpus row, routed by the source's scope through
 *                   `corpusRouteFor` (personal Vault, pot, or organization + permission list).
 *
 * A datatype is written only when the source routes it to the datatype's own nature, and a
 * routed record/event datatype must be a registered generic-kind (else `createWorkItem` would
 * mint it as claimable agent work), so a missing registry row fails closed.
 *
 * Every write is idempotent on deterministic ids / dedupe keys, so the driver's replay of an
 * uncommitted page converges on the same rows. Admission is its own sink so a failed rule
 * evaluation is recorded on its own delivery ledger row and never undoes the stored record.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getDatatype } from '../datatype-registry-store';
import {
  createWorkItem as defaultCreateWorkItem,
  mergeWorkItemPayload as defaultMergeWorkItemPayload,
  type CreateWorkItemInput,
} from '../work-items';
import type { CanonicalExternalEvent, ExternalTriggerSink } from '../external-triggers/ingestion';
import { corpusRouteFor, ensurePermissionList, writeCorpusDocument } from './chat-retrieval-units';
import { refreshAdmittedFromSource } from '../work-admission/admit';
import { applySourceLifecycle } from '../work-admission/lifecycle';
import { evaluateAdmissionRules, type RuleEvaluation } from '../work-admission/admission-rules';
import { RECORD_SOURCE_KIND, recordSnapshot } from '../work-admission/record-source';

/** Identity work_items rows written by connector records are created under. */
export const DATA_SOURCE_CREATED_BY = 'data-source:connector';

export interface DatatypeDestinationDeps {
  createWorkItem?: (input: CreateWorkItemInput) => Promise<unknown>;
  mergeWorkItemPayload?: (id: string, patch: Record<string, unknown>, opts: { harness?: string }) => Promise<unknown>;
  admitRecord?: (input: {
    workspaceId: string;
    recordId: string;
    dataSourceId: string;
    payload: Record<string, unknown>;
  }) => Promise<RuleEvaluation>;
  refreshAdmitted?: typeof refreshAdmittedFromSource;
  /** Outside close / cancel / reopen of an admitted record (work-admission/lifecycle.ts, P-003). */
  applyLifecycle?: (input: { workspaceId: string; recordId: string; payload: Record<string, unknown> }) => Promise<unknown>;
}

interface DestinationSourceRow {
  id: string;
  workspaceId: string;
  kind: string;
  ownerUserId: string | null;
  providerAccountId: string | null;
  config: Record<string, unknown>;
  scope: string;
  scopeRef: string | null;
  datatypeMappings: Record<string, unknown>;
  destinationPolicy: Record<string, unknown>;
  permissionMapping: Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}

/** Deterministic id of a connector record row: the same remote object always lands on one row. */
export function dataSourceRecordId(workspaceId: string, sourceId: string, datatype: string, nativeId: string): string {
  return `DSR-${digest([workspaceId, sourceId, datatype, nativeId])}`;
}

/** Deterministic id of a connector event row. */
export function dataSourceEventId(workspaceId: string, sourceId: string, datatype: string, nativeId: string): string {
  return `DSE-${digest([workspaceId, sourceId, datatype, nativeId])}`;
}

/** Stable corpus key: `<datatype>:<sourceId>:<nativeId>` (D-010: the source id is part of the key). */
export function dataSourceDocumentDedupeKey(datatype: string, sourceId: string, nativeId: string): string {
  return `${datatype}:${sourceId}:${nativeId}`;
}

async function loadSource(sql: Sql, workspaceId: string, sourceId: string): Promise<DestinationSourceRow> {
  const rows = await sql<DestinationSourceRow[]>`
    SELECT id::text, workspace_id AS "workspaceId", kind, owner_user_id::text AS "ownerUserId",
           provider_account_id AS "providerAccountId", config, scope, scope_ref AS "scopeRef",
           datatype_mappings AS "datatypeMappings", destination_policy AS "destinationPolicy",
           permission_mapping AS "permissionMapping"
      FROM harness_shared.data_sources
     WHERE workspace_id = ${workspaceId} AND id = ${sourceId}::uuid`;
  if (!rows[0]) throw new Error(`data_source_missing:${sourceId}`);
  return rows[0];
}

async function rowExists(sql: Sql, workspaceId: string, id: string): Promise<boolean> {
  const rows = await sql<Array<{ one: number }>>`
    SELECT 1 AS one FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND feature_id = ${id} LIMIT 1`;
  return rows.length > 0;
}

/** Create the row, or report that it already existed (also when a concurrent writer won the race). */
async function createOnce(
  sql: Sql,
  workspaceId: string,
  input: CreateWorkItemInput & { id: string },
  create: NonNullable<DatatypeDestinationDeps['createWorkItem']>,
): Promise<boolean> {
  if (await rowExists(sql, workspaceId, input.id)) return false;
  try {
    await create(input);
    return true;
  } catch (error) {
    if (await rowExists(sql, workspaceId, input.id)) return false;
    throw error;
  }
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function kebabToCamel(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Link fields: a payload field `<datatype>ExternalId` that names a registered RECORD datatype
 * gets `<datatype>WorkItemId` = that record's deterministic row id from the same source. The
 * relation is derived from the registry, so it works for any record datatype.
 */
async function withRecordLinks(
  sql: Sql,
  source: DestinationSourceRow,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out = { ...payload };
  for (const [key, value] of Object.entries(payload)) {
    const match = /^([a-z][A-Za-z0-9]*)ExternalId$/.exec(key);
    const nativeId = str(value);
    if (!match || !nativeId) continue;
    const datatype = camelToKebab(match[1]!);
    const def = await getDatatype(sql, source.workspaceId, datatype);
    if (!def || (def as { nature?: string }).nature !== 'record') continue;
    out[`${kebabToCamel(datatype)}WorkItemId`] = dataSourceRecordId(source.workspaceId, source.id, datatype, nativeId);
  }
  return out;
}

/**
 * The harness a record/event row from this source is written under: the source's own
 * `config.harnessSlug`, else the caller's `defaultHarness`. Without either it fails closed, so a
 * datatype with no defined home is never written under a guessed harness.
 */
function harnessOf(source: DestinationSourceRow, defaultHarness?: string): string {
  const harness = str(source.config?.harnessSlug) || str(defaultHarness);
  if (!harness) throw new Error(`data_source_harness_missing:${source.id}`);
  return harness;
}

function linkedExternalId(payload: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(payload)) {
    if (key !== 'externalId' && key.endsWith('ExternalId') && str(value)) return str(value);
  }
  return '';
}

function eventTitle(payload: Record<string, unknown>, datatype: string, nativeId: string): string {
  const title = str(payload.title);
  if (title) return title;
  const composed = [linkedExternalId(payload), str(payload.transition)].filter(Boolean).join(' ');
  return composed || `${datatype} ${nativeId}`;
}

function requireGenericKind(def: Awaited<ReturnType<typeof getDatatype>>, datatype: string, nature: string): void {
  if (!def || def.status !== 'active' || def.tier !== 'generic-kind' || def.workItemKind !== datatype) {
    throw new Error(`datatype_destination_unregistered:${datatype}:${nature}`);
  }
}

/**
 * The sinks a connector record of `datatype` from `sourceId` is delivered to, in delivery order.
 * Empty when the source does not route the datatype to the datatype's nature.
 */
export async function createDatatypeDestinationSinks(
  sql: Sql,
  input: {
    workspaceId: string;
    sourceId: string;
    datatype: string;
    /**
     * Harness for record/event rows when the source names none (`config.harnessSlug`). A
     * personal-scope source belongs to no harness; the caller that owns the datatype's home
     * (the relationship graph for `person` / `organization`) supplies it.
     */
    defaultHarness?: string;
  },
  deps: DatatypeDestinationDeps = {},
): Promise<ExternalTriggerSink[]> {
  const source = await loadSource(sql, input.workspaceId, input.sourceId);
  const datatype = input.datatype;
  const def = await getDatatype(sql, source.workspaceId, datatype);
  const nature = (def as { nature?: string } | null)?.nature ?? '';
  const routed = source.destinationPolicy?.[datatype];
  if (!nature || !Array.isArray(routed) || !routed.includes(nature)) return [];

  const create = deps.createWorkItem ?? defaultCreateWorkItem;
  const merge = deps.mergeWorkItemPayload ?? defaultMergeWorkItemPayload;
  const ref = `${source.id}:${datatype}`;

  if (nature === 'record') {
    requireGenericKind(def, datatype, nature);
    const harness = harnessOf(source, input.defaultHarness);
    const admitRecord = deps.admitRecord ?? ((args) => evaluateAdmissionRules(args, { sql }));
    const refreshAdmitted = deps.refreshAdmitted ?? refreshAdmittedFromSource;
    const applyLifecycle = deps.applyLifecycle ?? ((input) => applySourceLifecycle(sql, input));
    /** Which records this delivery created (vs updated), handed from the record sink to admission. */
    const created = new Map<string, boolean>();
    const recordSink: ExternalTriggerSink = {
      kind: 'data-source-record',
      ref,
      async deliver(event: CanonicalExternalEvent) {
        const payload = await withRecordLinks(sql, source, { ...event.payload, dataSourceId: source.id });
        const id = dataSourceRecordId(source.workspaceId, source.id, datatype, event.externalId);
        const snap = recordSnapshot(payload);
        const isNew = await createOnce(sql, source.workspaceId, {
          id,
          kind: datatype as CreateWorkItemInput['kind'],
          title: snap.title || `${datatype} ${event.externalId}`,
          summary: snap.body,
          harness,
          workspaceId: source.workspaceId,
          payload,
          createdBy: DATA_SOURCE_CREATED_BY,
        }, create);
        if (!isNew) {
          // mergeWorkItemPayload returns null when it cannot see the row; counting that as
          // stored would drop the new version silently, so it fails this delivery instead.
          const merged = await merge(id, payload, { harness });
          if (!merged) throw new Error(`data_source_record_merge_failed:${id}`);
        }
        created.set(event.dedupeKey, isNew);
      },
    };
    const admissionSink: ExternalTriggerSink = {
      kind: 'data-source-admission',
      ref,
      async deliver(event: CanonicalExternalEvent) {
        const id = dataSourceRecordId(source.workspaceId, source.id, datatype, event.externalId);
        const payload = { ...event.payload, dataSourceId: source.id };
        if (created.get(event.dedupeKey) === false) {
          await refreshAdmitted(source.workspaceId, { kind: RECORD_SOURCE_KIND, key: id }, recordSnapshot(payload), { sql });
        }
        const evaluation = await admitRecord({ workspaceId: source.workspaceId, recordId: id, dataSourceId: source.id, payload });
        // After evaluation, so a record admitted by this delivery starts its category baseline now.
        await applyLifecycle({ workspaceId: source.workspaceId, recordId: id, payload });
        const refused = evaluation.results.filter(({ result }) => !result.ok);
        if (refused.length > 0) {
          const codes = refused.map(({ result }) => ('code' in result ? String(result.code) : 'refused'));
          throw new Error(`data_source_admission_refused:${id}:${codes.join(',')}`);
        }
      },
    };
    return [recordSink, admissionSink];
  }

  if (nature === 'event') {
    requireGenericKind(def, datatype, nature);
    const harness = harnessOf(source, input.defaultHarness);
    return [{
      kind: 'data-source-event',
      ref,
      async deliver(event: CanonicalExternalEvent) {
        const payload = await withRecordLinks(sql, source, { ...event.payload, dataSourceId: source.id });
        const title = eventTitle(payload, datatype, event.externalId);
        await createOnce(sql, source.workspaceId, {
          id: dataSourceEventId(source.workspaceId, source.id, datatype, event.externalId),
          kind: datatype as CreateWorkItemInput['kind'],
          title,
          summary: title,
          harness,
          workspaceId: source.workspaceId,
          payload,
          createdBy: DATA_SOURCE_CREATED_BY,
        }, create);
      },
    }];
  }

  if (nature === 'document') {
    const route = corpusRouteFor(
      {
        kind: source.kind,
        scope: source.scope,
        scope_ref: source.scopeRef,
        owner_user_id: source.ownerUserId,
        provider_account_id: source.providerAccountId,
        datatype_mappings: source.datatypeMappings,
        destination_policy: source.destinationPolicy,
        permission_mapping: source.permissionMapping,
      } as Parameters<typeof corpusRouteFor>[0],
      { mappingKey: datatype, defaultDatatype: datatype },
    );
    if (!route.write) return [];
    return [{
      kind: 'data-source-document',
      ref,
      async deliver(event: CanonicalExternalEvent) {
        const payload = await withRecordLinks(sql, source, { ...event.payload, dataSourceId: source.id });
        const listId = route.scope === 'organization'
          ? (await ensurePermissionList(sql, source.workspaceId, route.source, source.id)).id
          : null;
        const author = str(payload.author);
        const linked = linkedExternalId(payload);
        await writeCorpusDocument(sql, source.workspaceId, route, source.id, listId, {
          source: route.source,
          kind: datatype,
          dedupeKey: dataSourceDocumentDedupeKey(datatype, source.id, event.externalId),
          externalId: event.externalId,
          occurredAt: event.occurredAt ?? null,
          participants: author ? [author] : [],
          title: str(payload.title) || (linked ? `${linked} ${datatype}` : `${datatype} ${event.externalId}`),
          text: typeof payload.text === 'string' ? payload.text : typeof payload.body === 'string' ? payload.body : '',
          metadata: payload,
        });
      },
    }];
  }

  return [];
}
