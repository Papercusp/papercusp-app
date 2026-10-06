/**
 * The WORKSPACE-scoped identity resolver of the platform relationship graph
 * (crm-agent-sales-onboarding-apps-2026-10-06 P-002, D-001 / D-011 point 4).
 *
 * Connector sources write one `person` / `organization` row per (source, native id) through the
 * datatype destination sink (`DSR-...` work_items rows, nature `record`). This resolver merges
 * the rows that describe one real human (shared email or phone) or one organization (shared
 * domain) into ONE canonical row per entity:
 *
 *   PER-<digest>  canonical person        ORG-<digest>  canonical organization
 *
 * Canonical rows are work_items rows of the same datatype (no new table, D-011), created by
 * `relationship-graph:resolver`, whose payload carries the merged fields, per-field provenance
 * (source, observed-at, accepted-by), the member record ids, and the identity keys. Each member
 * row is stamped with `personId` / `organizationId` = its canonical id plus its own
 * `identityKeys`, which is how an incremental resolve finds a record's cluster without
 * scanning every record.
 *
 * Identity of a canonical row is STABLE: CRM objects key to it (D-001). A cluster keeps the
 * oldest canonical id its members already point at; when two clusters merge, the younger
 * canonical row is retired with `mergedInto` naming the survivor (readers follow it). A new
 * id is minted only for a cluster with no canonical row yet, from its oldest member.
 *
 * Writes go through createWorkItem / mergeWorkItemPayload like the sink, and every write is
 * idempotent, so a replayed delivery converges on the same rows. Concurrent resolves of one
 * (workspace, datatype) serialize on a session advisory lock.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  createWorkItem as defaultCreateWorkItem,
  mergeWorkItemPayload as defaultMergeWorkItemPayload,
  type CreateWorkItemInput,
} from '../work-items';
import {
  type IdentityKey,
  interactionParticipantKeys,
  organizationIdentityKeys,
  personIdentityKeys,
  personOrganizationDomain,
} from './identity-keys';
import {
  type AcceptedValue,
  type EntityFieldSpec,
  type FieldProvenance,
  type SourceEntityRecord,
  clusterByKeys,
  mergeEntity,
  ORGANIZATION_FIELDS,
  PERSON_FIELDS,
} from './merge';

export const PERSON_DATATYPE = 'person';
export const ORGANIZATION_DATATYPE = 'organization';
export type GraphEntityDatatype = typeof PERSON_DATATYPE | typeof ORGANIZATION_DATATYPE;
export const GRAPH_ENTITY_DATATYPES: readonly GraphEntityDatatype[] = [PERSON_DATATYPE, ORGANIZATION_DATATYPE];

/** Identity canonical rows are created under. */
export const RELATIONSHIP_GRAPH_CREATED_BY = 'relationship-graph:resolver';
/** `provider` of a canonical row: the graph itself is the source of the merged record. */
export const RELATIONSHIP_GRAPH_PROVIDER = 'relationship-graph';

/** Cap on cluster-expansion rounds of an incremental resolve (each round is one query). */
const MAX_EXPANSION_ROUNDS = 8;
/** Cap on `mergedInto` hops a reader follows. */
const MAX_MERGE_HOPS = 10;

export function isGraphEntityDatatype(datatype: string): datatype is GraphEntityDatatype {
  return (GRAPH_ENTITY_DATATYPES as readonly string[]).includes(datatype);
}

interface EntitySpec {
  prefix: 'PER' | 'ORG';
  canonicalField: 'personId' | 'organizationId';
  fields: EntityFieldSpec;
  keysOf: (payload: Record<string, unknown>) => IdentityKey[];
  titleOf: (fields: Record<string, string | string[]>) => string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function first(value: unknown): string {
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '';
}

const SPECS: Record<GraphEntityDatatype, EntitySpec> = {
  person: {
    prefix: 'PER',
    canonicalField: 'personId',
    fields: PERSON_FIELDS,
    keysOf: personIdentityKeys,
    titleOf: (f) =>
      str(f.displayName) || [str(f.givenName), str(f.familyName)].filter(Boolean).join(' ') ||
      first(f.emails) || first(f.phones) || 'Unnamed person',
  },
  organization: {
    prefix: 'ORG',
    canonicalField: 'organizationId',
    fields: ORGANIZATION_FIELDS,
    keysOf: organizationIdentityKeys,
    titleOf: (f) => str(f.name) || first(f.domains) || 'Unnamed organization',
  },
};

/** The fields a person may accept on a canonical row (scalars, list values, and the org link). */
export function acceptableFields(datatype: GraphEntityDatatype): string[] {
  const spec = SPECS[datatype];
  const extra = datatype === PERSON_DATATYPE ? ['organizationId'] : [];
  return [...spec.fields.scalars, ...Object.keys(spec.fields.lists), ...extra];
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}

/** Deterministic id of the canonical row minted for a cluster anchored at `anchorRecordId`. */
export function canonicalEntityId(workspaceId: string, datatype: GraphEntityDatatype, anchorRecordId: string): string {
  return `${SPECS[datatype].prefix}-${digest([workspaceId, datatype, anchorRecordId])}`;
}

export function isCanonicalEntityId(datatype: GraphEntityDatatype, id: string): boolean {
  return id.startsWith(`${SPECS[datatype].prefix}-`);
}

export interface ResolverDeps {
  createWorkItem?: (input: CreateWorkItemInput) => Promise<unknown>;
  mergeWorkItemPayload?: (
    id: string,
    patch: Record<string, unknown>,
    opts: { harness?: string; unset?: readonly string[] },
  ) => Promise<unknown>;
  /** Clock seam for tests. */
  now?: () => Date;
}

interface EntityRow {
  feature_id: string;
  harness_slug: string;
  created_ts: string | number | null;
  updated_ts: string | number | null;
  payload: Record<string, unknown> | null;
}

interface CanonicalRow {
  id: string;
  harness: string;
  createdTs: number;
  payload: Record<string, unknown>;
  memberRecordIds: string[];
  accepted: Record<string, AcceptedValue>;
  mergedInto: string | null;
}

function toNumber(value: string | number | null): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isoOf(value: unknown, fallbackTs: number): string {
  const parsed = Date.parse(str(value));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date(fallbackTs > 0 ? fallbackTs : 0).toISOString();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function acceptedMap(value: unknown): Record<string, AcceptedValue> {
  const out: Record<string, AcceptedValue> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
    const v = raw as Partial<AcceptedValue> | null;
    if (v && str(v.value) && str(v.acceptedBy) && str(v.acceptedAt)) {
      out[field] = { value: str(v.value), acceptedBy: str(v.acceptedBy), acceptedAt: str(v.acceptedAt) };
    }
  }
  return out;
}

function toSourceRecord(row: EntityRow): SourceEntityRecord {
  const payload = row.payload ?? {};
  const fallback = toNumber(row.updated_ts) || toNumber(row.created_ts);
  return {
    id: row.feature_id,
    harness: row.harness_slug,
    dataSourceId: str(payload.dataSourceId) || null,
    provider: str(payload.provider) || null,
    observedAt: isoOf(payload.observedAt || payload.updatedAt, fallback),
    createdTs: toNumber(row.created_ts),
    payload,
  };
}

function toCanonicalRow(row: EntityRow): CanonicalRow {
  const payload = row.payload ?? {};
  return {
    id: row.feature_id,
    harness: row.harness_slug,
    createdTs: toNumber(row.created_ts),
    payload,
    memberRecordIds: stringArray(payload.memberRecordIds),
    accepted: acceptedMap(payload.accepted),
    mergedInto: str(payload.mergedInto) || null,
  };
}

async function selectAll(sql: Sql, workspaceId: string, datatype: GraphEntityDatatype): Promise<EntityRow[]> {
  return sql<EntityRow[]>`
    SELECT feature_id, harness_slug, created_ts, updated_ts, payload FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND item_kind = ${datatype} AND nature = 'record'`;
}

async function selectConnected(
  sql: Sql,
  workspaceId: string,
  datatype: GraphEntityDatatype,
  ids: readonly string[],
  keys: readonly string[],
): Promise<EntityRow[]> {
  return sql<EntityRow[]>`
    SELECT feature_id, harness_slug, created_ts, updated_ts, payload FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND item_kind = ${datatype} AND nature = 'record'
       AND (feature_id = ANY(${sql.array([...ids])}::text[])
            OR payload->'identityKeys' ?| ${sql.array([...keys])}::text[]
            OR payload->'memberRecordIds' ?| ${sql.array([...ids])}::text[])`;
}

/**
 * Load the connected component of `recordIds`: every record and canonical row reachable through
 * shared identity keys (fresh from the payload AND last stamped, so a record whose email changed
 * still pulls its old cluster in and can split from it), canonical stamps and member lists.
 */
async function loadComponent(
  sql: Sql,
  workspaceId: string,
  datatype: GraphEntityDatatype,
  recordIds: readonly string[],
): Promise<EntityRow[]> {
  const spec = SPECS[datatype];
  const rows = new Map<string, EntityRow>();
  const ids = new Set(recordIds);
  const keys = new Set<string>();
  for (let round = 0; round < MAX_EXPANSION_ROUNDS; round += 1) {
    const found = await selectConnected(sql, workspaceId, datatype, [...ids], [...keys]);
    let grew = false;
    for (const row of found) {
      if (!rows.has(row.feature_id)) {
        rows.set(row.feature_id, row);
        grew = true;
      }
      const payload = row.payload ?? {};
      const more = [
        ...(isCanonicalEntityId(datatype, row.feature_id) ? stringArray(payload.memberRecordIds) : spec.keysOf(payload)),
        ...stringArray(payload.identityKeys),
      ];
      for (const value of more) {
        const target = value.includes(':') ? keys : ids;
        if (!target.has(value)) {
          target.add(value);
          grew = true;
        }
      }
      const stamp = str(payload[spec.canonicalField]);
      if (stamp && !ids.has(stamp)) {
        ids.add(stamp);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return [...rows.values()];
}

async function rowExists(sql: Sql, workspaceId: string, id: string): Promise<boolean> {
  const rows = await sql<Array<{ one: number }>>`
    SELECT 1 AS one FROM harness_shared.work_items WHERE workspace_id = ${workspaceId} AND feature_id = ${id} LIMIT 1`;
  return rows.length > 0;
}

/** Hold a session advisory lock on one (workspace, datatype) while `fn` runs. */
async function withResolveLock<T>(sql: Sql, workspaceId: string, datatype: string, fn: () => Promise<T>): Promise<T> {
  const reserve = (sql as unknown as { reserve?: () => Promise<Sql & { release: () => void }> }).reserve;
  if (typeof reserve !== 'function') return fn();
  const key = `relationship-graph:${workspaceId}:${datatype}`;
  const reserved = await reserve.call(sql);
  let acquired = false;
  try {
    await reserved`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
    acquired = true;
    return await fn();
  } finally {
    if (acquired) await reserved`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`.catch(() => {});
    reserved.release();
  }
}

export interface ResolvedCanonical {
  id: string;
  memberRecordIds: string[];
  created: boolean;
}

export interface ResolveResult {
  datatype: GraphEntityDatatype;
  canonical: ResolvedCanonical[];
  /** Canonical rows retired this pass, with the survivor they now point at (null = orphaned). */
  retired: Array<{ id: string; mergedInto: string | null }>;
  /** Member rows whose stamp (canonical id / identity keys) changed. */
  stamped: number;
}

interface OrganizationLink {
  organizationId: string;
  provenance: FieldProvenance;
}

/** Live canonical organization ids by `domain:` key, for the person resolver. */
async function organizationsByDomain(sql: Sql, workspaceId: string, domains: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (domains.length === 0) return out;
  const keys = domains.map((d) => `domain:${d}`);
  const rows = await sql<Array<{ feature_id: string; keys: unknown }>>`
    SELECT feature_id, payload->'identityKeys' AS keys FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND item_kind = ${ORGANIZATION_DATATYPE} AND nature = 'record'
       AND feature_id LIKE 'ORG-%' AND NOT (payload ? 'mergedInto')
       AND payload->'identityKeys' ?| ${sql.array(keys)}::text[]
     ORDER BY created_ts, feature_id`;
  for (const row of rows) {
    for (const key of stringArray(row.keys)) {
      if (key.startsWith('domain:') && !out.has(key.slice(7))) out.set(key.slice(7), row.feature_id);
    }
  }
  return out;
}

/** Canonical organization ids of linked organization records (`organizationWorkItemId` stamps). */
async function organizationsByRecord(sql: Sql, workspaceId: string, recordIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (recordIds.length === 0) return out;
  const rows = await sql<Array<{ feature_id: string; org: string | null }>>`
    SELECT feature_id, payload->>'organizationId' AS org FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND item_kind = ${ORGANIZATION_DATATYPE}
       AND feature_id = ANY(${sql.array([...recordIds])}::text[])`;
  for (const row of rows) if (row.org) out.set(row.feature_id, row.org);
  return out;
}

/**
 * The organization a person cluster belongs to: an explicit link from a member's organization
 * record (the sink's `organizationWorkItemId` stamp) beats an email-domain match.
 */
function organizationLinkFor(
  members: readonly SourceEntityRecord[],
  byRecord: ReadonlyMap<string, string>,
  byDomain: ReadonlyMap<string, string>,
): OrganizationLink | null {
  const ordered = [...members].sort((a, b) => (a.observedAt === b.observedAt ? (a.id < b.id ? -1 : 1) : a.observedAt > b.observedAt ? -1 : 1));
  for (const member of ordered) {
    const recordId = str(member.payload.organizationWorkItemId);
    const org = recordId ? byRecord.get(recordId) : undefined;
    if (org) {
      return {
        organizationId: org,
        provenance: { source: { kind: 'derived', from: `organization-record:${recordId}` }, observedAt: member.observedAt, acceptedBy: null },
      };
    }
  }
  for (const member of ordered) {
    const domain = personOrganizationDomain(member.payload);
    const org = domain ? byDomain.get(domain) : undefined;
    if (org) {
      return {
        organizationId: org,
        provenance: { source: { kind: 'derived', from: `email-domain:${domain}` }, observedAt: member.observedAt, acceptedBy: null },
      };
    }
  }
  return null;
}

/** What {@link assignCanonicalIds} needs to know about an existing canonical row. */
export interface CanonicalCandidate {
  id: string;
  createdTs: number;
  retired: boolean;
  memberRecordIds: readonly string[];
}

function byAge(a: { createdTs: number; id: string }, b: { createdTs: number; id: string }): number {
  return a.createdTs - b.createdTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Give each cluster its canonical id. Pure and deterministic.
 *
 * Canonical ids are what other objects key to (D-001), so they must move as little as possible:
 *   - existing canonical rows are handed out OLDEST FIRST (live before retired), each to the
 *     unassigned cluster holding most of its former members; a tie goes to the cluster with the
 *     oldest member. So a MERGE keeps the oldest id, and a SPLIT leaves the id with the side
 *     that kept most of the old members;
 *   - a cluster left without one mints `mint(oldest member id)`.
 * A cluster's `candidateIds` are every canonical row any of its members pointed at.
 */
export function assignCanonicalIds<T extends { id: string; createdTs: number }>(
  clusters: ReadonlyArray<readonly T[]>,
  canonical: readonly CanonicalCandidate[],
  stampOf: (member: T) => string | null,
  mint: (anchorRecordId: string) => string,
): Array<{ id: string; members: T[]; candidateIds: string[] }> {
  const formerMembers = new Map(canonical.map((c) => [c.id, new Set(c.memberRecordIds)]));
  const refsOf = clusters.map((members) => {
    const refs = new Map<string, number>();
    for (const member of members) {
      const owners = new Set<string>();
      const stamp = stampOf(member);
      if (stamp) owners.add(stamp);
      for (const c of canonical) if (formerMembers.get(c.id)!.has(member.id)) owners.add(c.id);
      for (const owner of owners) refs.set(owner, (refs.get(owner) ?? 0) + 1);
    }
    return refs;
  });
  const oldestMember = clusters.map((members) => [...members].sort(byAge)[0]!);

  const chosen = new Array<string | undefined>(clusters.length);
  const taken = new Set<string>();
  const ordered = [...canonical].sort((a, b) => Number(a.retired) - Number(b.retired) || byAge(a, b));
  for (const candidate of ordered) {
    let best = -1;
    for (let i = 0; i < clusters.length; i += 1) {
      if (chosen[i] !== undefined) continue;
      const overlap = refsOf[i]!.get(candidate.id) ?? 0;
      if (overlap === 0) continue;
      if (best < 0) {
        best = i;
        continue;
      }
      const bestOverlap = refsOf[best]!.get(candidate.id) ?? 0;
      if (overlap > bestOverlap || (overlap === bestOverlap && byAge(oldestMember[i]!, oldestMember[best]!) < 0)) best = i;
    }
    if (best >= 0) {
      chosen[best] = candidate.id;
      taken.add(candidate.id);
    }
  }

  return clusters.flatMap((members, i) => {
    let id = chosen[i];
    if (id === undefined) {
      id = [...members].sort(byAge).map((m) => mint(m.id)).find((c) => !taken.has(c));
      if (id === undefined) return [];
      taken.add(id);
    }
    const candidateIds = [...refsOf[i]!.keys()].filter((c) => formerMembers.has(c)).sort();
    return [{ id, members: [...members], candidateIds }];
  });
}

function sameStrings(a: unknown, b: readonly string[]): boolean {
  const left = stringArray(a);
  return left.length === b.length && left.every((v, i) => v === b[i]);
}

/**
 * Resolve identities of one datatype. With `recordIds`, only the connected component of those
 * records is resolved (the per-delivery path); without, every record of the workspace is (the
 * backfill path).
 */
export async function resolveIdentities(
  sql: Sql,
  input: { workspaceId: string; datatype: GraphEntityDatatype; recordIds?: readonly string[] },
  deps: ResolverDeps = {},
): Promise<ResolveResult> {
  return withResolveLock(sql, input.workspaceId, input.datatype, () => resolveUnlocked(sql, input, deps));
}

async function resolveUnlocked(
  sql: Sql,
  input: { workspaceId: string; datatype: GraphEntityDatatype; recordIds?: readonly string[] },
  deps: ResolverDeps,
): Promise<ResolveResult> {
  const { workspaceId, datatype } = input;
  const spec = SPECS[datatype];
  const create = deps.createWorkItem ?? defaultCreateWorkItem;
  const merge = deps.mergeWorkItemPayload ?? defaultMergeWorkItemPayload;
  const now = (deps.now ?? (() => new Date()))().toISOString();

  const rows = input.recordIds
    ? await loadComponent(sql, workspaceId, datatype, input.recordIds)
    : await selectAll(sql, workspaceId, datatype);
  const canonicalRows = new Map<string, CanonicalRow>();
  const sources: SourceEntityRecord[] = [];
  for (const row of rows) {
    if (isCanonicalEntityId(datatype, row.feature_id)) canonicalRows.set(row.feature_id, toCanonicalRow(row));
    else sources.push(toSourceRecord(row));
  }

  const clusters = clusterByKeys(sources, (r) => spec.keysOf(r.payload));

  const assignments = assignCanonicalIds(
    clusters,
    [...canonicalRows.values()].map((row) => ({
      id: row.id,
      createdTs: row.createdTs,
      retired: Boolean(row.mergedInto),
      memberRecordIds: row.memberRecordIds,
    })),
    (member) => str(member.payload[spec.canonicalField]) || null,
    (anchorRecordId) => canonicalEntityId(workspaceId, datatype, anchorRecordId),
  ).map(({ id, members, candidateIds }) => ({
    id,
    members,
    absorbed: candidateIds.map((c) => canonicalRows.get(c)).filter((row): row is CanonicalRow => row !== undefined),
  }));
  const taken = new Set(assignments.map((a) => a.id));

  // Organization links for person clusters, fetched in one query each.
  let byRecord = new Map<string, string>();
  let byDomain = new Map<string, string>();
  if (datatype === PERSON_DATATYPE) {
    const orgRecordIds = new Set<string>();
    const domains = new Set<string>();
    for (const source of sources) {
      const linked = str(source.payload.organizationWorkItemId);
      if (linked) orgRecordIds.add(linked);
      const domain = personOrganizationDomain(source.payload);
      if (domain) domains.add(domain);
    }
    [byRecord, byDomain] = await Promise.all([
      organizationsByRecord(sql, workspaceId, [...orgRecordIds]),
      organizationsByDomain(sql, workspaceId, [...domains]),
    ]);
  }

  const result: ResolveResult = { datatype, canonical: [], retired: [], stamped: 0 };
  const survivorOf = new Map<string, string>();

  for (const { id, members, absorbed } of assignments) {
    const existing = canonicalRows.get(id) ?? null;
    // Accepted values survive a MERGE: the rows this cluster absorbs (kept by no other cluster)
    // hand theirs to the survivor, whose own acceptances win a conflict. On a SPLIT, a row kept
    // by another cluster keeps its acceptances; they are not copied onto this one.
    const accepted: Record<string, AcceptedValue> = {};
    for (const row of [...absorbed].reverse()) {
      if (row.id === id || !taken.has(row.id)) Object.assign(accepted, row.accepted);
    }
    if (existing) Object.assign(accepted, existing.accepted);

    const merged = mergeEntity(spec.fields, members, accepted);
    const fields: Record<string, unknown> = { ...merged.fields };
    const provenance: Record<string, FieldProvenance> = { ...merged.provenance };
    if (datatype === PERSON_DATATYPE) {
      const acceptedOrg = accepted.organizationId;
      const link = acceptedOrg
        ? { organizationId: acceptedOrg.value, provenance: { source: { kind: 'accepted' as const }, observedAt: acceptedOrg.acceptedAt, acceptedBy: acceptedOrg.acceptedBy } }
        : organizationLinkFor(members, byRecord, byDomain);
      if (link) {
        fields.organizationId = link.organizationId;
        provenance.organizationId = link.provenance;
      }
      const domain = members.map((m) => personOrganizationDomain(m.payload)).find((d): d is string => d !== null);
      if (domain) fields.organizationDomain = domain;
    }

    const memberRecordIds = members.map((m) => m.id).sort();
    const identityKeys = [...new Set(members.flatMap((m) => spec.keysOf(m.payload)))].sort();
    const payload: Record<string, unknown> = {
      provider: RELATIONSHIP_GRAPH_PROVIDER,
      externalId: id,
      canonical: true,
      ...fields,
      provenance,
      accepted,
      memberRecordIds,
      identityKeys,
      resolvedAt: now,
    };
    const title = spec.titleOf(merged.fields);
    const anchor = [...members].sort((a, b) => a.createdTs - b.createdTs || (a.id < b.id ? -1 : 1))[0]!;
    const harness = existing?.harness ?? anchor.harness;

    let created = false;
    if (existing || (await rowExists(sql, workspaceId, id))) {
      const stale = [
        ...spec.fields.scalars,
        ...Object.keys(spec.fields.lists),
        ...(datatype === PERSON_DATATYPE ? ['organizationId', 'organizationDomain'] : []),
      ].filter((field) => !(field in fields));
      await merge(id, payload, { harness, unset: [...stale, 'mergedInto', 'retiredAt'] });
      await sql`
        UPDATE harness_shared.work_items SET title = ${title}, updated_ts = ${Date.now()}
         WHERE workspace_id = ${workspaceId} AND feature_id = ${id} AND title IS DISTINCT FROM ${title}`;
    } else {
      try {
        await create({
          id,
          kind: datatype as CreateWorkItemInput['kind'],
          title,
          summary: title,
          harness,
          workspaceId,
          payload,
          createdBy: RELATIONSHIP_GRAPH_CREATED_BY,
        });
        created = true;
      } catch (error) {
        // A concurrent writer (outside this lock, e.g. another host) won the race: converge.
        if (!(await rowExists(sql, workspaceId, id))) throw error;
        await merge(id, payload, { harness, unset: ['mergedInto', 'retiredAt'] });
      }
    }
    result.canonical.push({ id, memberRecordIds, created });
    for (const member of members) survivorOf.set(member.id, id);

    for (const member of members) {
      const keys = spec.keysOf(member.payload);
      if (str(member.payload[spec.canonicalField]) === id && sameStrings(member.payload.identityKeys, keys)) continue;
      await merge(member.id, { [spec.canonicalField]: id, identityKeys: keys }, { harness: member.harness });
      result.stamped += 1;
    }
  }

  // Retire every loaded canonical row no cluster kept.
  for (const row of canonicalRows.values()) {
    if (taken.has(row.id)) continue;
    // Already retired by an earlier pass: leave its `mergedInto` pointer alone (readers follow
    // the chain), or a backfill would orphan every row it once retired.
    if (row.memberRecordIds.length === 0 && (row.mergedInto || str(row.payload.retiredAt))) continue;
    const survivor = row.memberRecordIds.map((m) => survivorOf.get(m)).find((s): s is string => Boolean(s)) ?? null;
    await merge(
      row.id,
      survivor
        ? { mergedInto: survivor, memberRecordIds: [], identityKeys: [], retiredAt: now }
        : { memberRecordIds: [], identityKeys: [], retiredAt: now },
      { harness: row.harness, unset: survivor ? [] : ['mergedInto'] },
    );
    result.retired.push({ id: row.id, mergedInto: survivor });
  }

  return result;
}

/**
 * After organizations change, re-resolve the persons whose organization link may have moved:
 * persons pointing at an email domain or an organization record of the resolved organizations.
 */
export async function relinkPersonsForOrganizations(
  sql: Sql,
  input: { workspaceId: string; organizationIds: readonly string[] },
  deps: ResolverDeps = {},
): Promise<ResolveResult | null> {
  if (input.organizationIds.length === 0) return null;
  const orgs = await sql<Array<{ keys: unknown; members: unknown }>>`
    SELECT payload->'identityKeys' AS keys, payload->'memberRecordIds' AS members FROM harness_shared.work_items
     WHERE workspace_id = ${input.workspaceId} AND feature_id = ANY(${sql.array([...input.organizationIds])}::text[])`;
  const domains = orgs.flatMap((o) => stringArray(o.keys)).filter((k) => k.startsWith('domain:')).map((k) => k.slice(7));
  const orgRecords = orgs.flatMap((o) => stringArray(o.members));
  if (domains.length === 0 && orgRecords.length === 0) return null;
  const persons = await sql<Array<{ feature_id: string }>>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE workspace_id = ${input.workspaceId} AND item_kind = ${PERSON_DATATYPE} AND nature = 'record'
       AND feature_id NOT LIKE 'PER-%'
       AND (payload->>'organizationWorkItemId' = ANY(${sql.array(orgRecords)}::text[])
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(payload->'identityKeys', '[]'::jsonb)) k
                        WHERE k LIKE 'email:%' AND split_part(k, '@', 2) = ANY(${sql.array(domains)}::text[])))`;
  if (persons.length === 0) return null;
  return resolveIdentities(sql, { workspaceId: input.workspaceId, datatype: PERSON_DATATYPE, recordIds: persons.map((p) => p.feature_id) }, deps);
}

export interface CanonicalEntity {
  id: string;
  datatype: GraphEntityDatatype;
  title: string;
  payload: Record<string, unknown>;
}

/** A canonical row by id, following `mergedInto` to the survivor. Null when absent. */
export async function getCanonicalEntity(
  sql: Sql,
  workspaceId: string,
  datatype: GraphEntityDatatype,
  id: string,
): Promise<CanonicalEntity | null> {
  let current = id;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    const [row] = await sql<Array<{ feature_id: string; title: string; payload: Record<string, unknown> | null }>>`
      SELECT feature_id, title, payload FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND item_kind = ${datatype} AND feature_id = ${current}`;
    if (!row) return null;
    const next = str(row.payload?.mergedInto);
    if (!next) return { id: row.feature_id, datatype, title: row.title, payload: row.payload ?? {} };
    current = next;
  }
  return null;
}

/** The live canonical entity holding one identity key (`email:...`, `phone:...`, `domain:...`). */
export async function findEntityByIdentity(
  sql: Sql,
  workspaceId: string,
  datatype: GraphEntityDatatype,
  key: IdentityKey,
): Promise<CanonicalEntity | null> {
  const [row] = await sql<Array<{ feature_id: string; title: string; payload: Record<string, unknown> | null }>>`
    SELECT feature_id, title, payload FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND item_kind = ${datatype} AND nature = 'record'
       AND feature_id LIKE ${`${SPECS[datatype].prefix}-%`} AND NOT (payload ? 'mergedInto')
       AND payload->'identityKeys' ? ${key}
     ORDER BY created_ts, feature_id LIMIT 1`;
  return row ? { id: row.feature_id, datatype, title: row.title, payload: row.payload ?? {} } : null;
}

/**
 * The graph persons taking part in one interaction (an email-message, calendar-event,
 * chat-message or call payload), resolved by participant email/phone. Keys no person holds are
 * returned as `unresolved` rather than dropped.
 */
export async function resolveInteractionParticipants(
  sql: Sql,
  workspaceId: string,
  datatype: string,
  payload: Record<string, unknown>,
): Promise<{ personIds: string[]; unresolved: IdentityKey[] }> {
  const keys = interactionParticipantKeys(datatype, payload);
  if (keys.length === 0) return { personIds: [], unresolved: [] };
  const rows = await sql<Array<{ feature_id: string; keys: unknown }>>`
    SELECT feature_id, payload->'identityKeys' AS keys FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND item_kind = ${PERSON_DATATYPE} AND nature = 'record'
       AND feature_id LIKE 'PER-%' AND NOT (payload ? 'mergedInto')
       AND payload->'identityKeys' ?| ${sql.array([...keys])}::text[]
     ORDER BY feature_id`;
  const held = new Set(rows.flatMap((r) => stringArray(r.keys)));
  return {
    personIds: rows.map((r) => r.feature_id),
    unresolved: keys.filter((k) => !held.has(k)),
  };
}

export class AcceptFieldError extends Error {
  constructor(readonly code: 'unknown_field' | 'entity_missing' | 'empty_value', message: string) {
    super(message);
  }
}

/**
 * Record a person's confirmation of one field value on a canonical entity; it outranks every
 * observed value from then on (provenance `acceptedBy`). Returns the re-resolved entity.
 */
export async function acceptEntityField(
  sql: Sql,
  input: { workspaceId: string; datatype: GraphEntityDatatype; canonicalId: string; field: string; value: string; acceptedBy: string },
  deps: ResolverDeps = {},
): Promise<CanonicalEntity> {
  if (!acceptableFields(input.datatype).includes(input.field)) {
    throw new AcceptFieldError('unknown_field', `${input.field} is not an acceptable ${input.datatype} field (${acceptableFields(input.datatype).join(', ')})`);
  }
  if (!str(input.value) || !str(input.acceptedBy)) {
    throw new AcceptFieldError('empty_value', 'value and acceptedBy are required');
  }
  const entity = await getCanonicalEntity(sql, input.workspaceId, input.datatype, input.canonicalId);
  if (!entity) throw new AcceptFieldError('entity_missing', `${input.datatype} ${input.canonicalId} not found`);
  const merge = deps.mergeWorkItemPayload ?? defaultMergeWorkItemPayload;
  const [row] = await sql<Array<{ harness_slug: string }>>`
    SELECT harness_slug FROM harness_shared.work_items WHERE workspace_id = ${input.workspaceId} AND feature_id = ${entity.id}`;
  const acceptedAt = (deps.now ?? (() => new Date()))().toISOString();
  const accepted = {
    ...acceptedMap(entity.payload.accepted),
    [input.field]: { value: str(input.value), acceptedBy: str(input.acceptedBy), acceptedAt },
  };
  await merge(entity.id, { accepted }, { harness: row?.harness_slug });
  const members = stringArray(entity.payload.memberRecordIds);
  if (members.length > 0) {
    await resolveIdentities(sql, { workspaceId: input.workspaceId, datatype: input.datatype, recordIds: members }, deps);
  }
  const refreshed = await getCanonicalEntity(sql, input.workspaceId, input.datatype, entity.id);
  if (!refreshed) throw new AcceptFieldError('entity_missing', `${input.datatype} ${entity.id} vanished while accepting`);
  return refreshed;
}
