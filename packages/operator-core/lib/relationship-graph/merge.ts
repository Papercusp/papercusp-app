/**
 * Clustering and field merge for the platform relationship graph (crm-agent-sales-onboarding-
 * apps-2026-10-06 P-002, D-011 point 4). Pure: no database, no I/O.
 *
 * The resolver loads the per-source records of one datatype, clusters the ones that share an
 * identity key (transitively: A~B by email and B~C by phone puts A, B, C together), and merges
 * each cluster into ONE canonical record. Every merged field carries provenance:
 *
 *   { source: { kind: 'record', recordId, dataSourceId, provider } | { kind: 'accepted' } | { kind: 'derived', from },
 *     observedAt, acceptedBy }
 *
 * Merge policy, per field:
 *   - a value a person ACCEPTED (acceptEntityField) wins over every observed value;
 *   - otherwise a scalar takes the most recently observed non-empty value (ties → lower record id);
 *   - a list (emails, phones, domains) is the union of every member's normalized values, each
 *     value carrying the provenance of its most recent observation.
 */
import { normalizeDomain, normalizeEmail, normalizePhone } from './identity-keys';

/** One per-source record as the resolver loaded it. */
export interface SourceEntityRecord {
  /** The record's work_items id (`DSR-...`). */
  id: string;
  harness: string;
  dataSourceId: string | null;
  provider: string | null;
  /** ISO time the source last reported this record's state. */
  observedAt: string;
  createdTs: number;
  payload: Record<string, unknown>;
}

export type ProvenanceSource =
  | { kind: 'record'; recordId: string; dataSourceId: string | null; provider: string | null }
  | { kind: 'accepted' }
  | { kind: 'derived'; from: string };

export interface FieldProvenance {
  source: ProvenanceSource;
  observedAt: string;
  acceptedBy: string | null;
}

/** A value a person confirmed on the canonical record; it outranks every observed value. */
export interface AcceptedValue {
  value: string;
  acceptedBy: string;
  acceptedAt: string;
}

export interface EntityFieldSpec {
  /** Scalar fields merged by recency. */
  scalars: readonly string[];
  /** List fields merged by union, each with its normalizer and the payload fields it reads. */
  lists: Readonly<Record<string, { read: readonly string[]; normalize: (raw: unknown) => string | null }>>;
}

export const PERSON_FIELDS: EntityFieldSpec = {
  scalars: ['displayName', 'givenName', 'familyName', 'title', 'organizationName', 'location', 'url'],
  lists: {
    emails: { read: ['emails', 'email'], normalize: normalizeEmail },
    phones: { read: ['phones', 'phone'], normalize: normalizePhone },
  },
};

export const ORGANIZATION_FIELDS: EntityFieldSpec = {
  scalars: ['name', 'website', 'industry', 'size', 'location'],
  lists: {
    domains: { read: ['domains', 'domain', 'website'], normalize: normalizeDomain },
    phones: { read: ['phones', 'phone'], normalize: normalizePhone },
  },
};

/** Provenance map key of one list value: `emails:ada@acme.com`. */
export function listProvenanceKey(field: string, value: string): string {
  return `${field}:${value}`;
}

/**
 * Group records that share at least one key, transitively (union-find). Deterministic: members
 * are sorted by id and clusters by their first member's id, whatever the input order.
 */
export function clusterByKeys<T extends { id: string }>(records: readonly T[], keysOf: (record: T) => readonly string[]): T[][] {
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const owner = new Map<string, number>();
  sorted.forEach((record, i) => {
    for (const key of keysOf(record)) {
      const seen = owner.get(key);
      if (seen === undefined) {
        owner.set(key, i);
        continue;
      }
      const a = find(seen);
      const b = find(i);
      // The lower index stays root, so a cluster's root is its lowest-id member.
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const groups = new Map<number, T[]>();
  sorted.forEach((record, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(record);
    else groups.set(root, [record]);
  });
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, group]) => group);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function rawValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        return obj.value ?? obj.address ?? obj.email ?? obj.number ?? obj.phone;
      }
      return item;
    });
  }
  return value === undefined || value === null ? [] : [value];
}

/** Newer observation first; a tie goes to the lower record id so the merge is deterministic. */
function newer(a: SourceEntityRecord, b: SourceEntityRecord): boolean {
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt;
  return a.id < b.id;
}

/** `derivedFrom` of a person record projected from an interaction participant (plan D-013). */
export const PARTICIPANT_DERIVATION = 'interaction-participant';

/** A value a source states about the entity (1) outranks one read off an interaction header (0). */
function directness(record: SourceEntityRecord): number {
  return record.payload.derivedFrom === PARTICIPANT_DERIVATION ? 0 : 1;
}

/** Scalar winner order: a direct record over a participant-derived one, then the newer observation. */
function outranks(a: SourceEntityRecord, b: SourceEntityRecord): boolean {
  const da = directness(a);
  const db = directness(b);
  if (da !== db) return da > db;
  return newer(a, b);
}

function recordSource(record: SourceEntityRecord): ProvenanceSource {
  return { kind: 'record', recordId: record.id, dataSourceId: record.dataSourceId, provider: record.provider };
}

export interface MergedEntity {
  fields: Record<string, string | string[]>;
  provenance: Record<string, FieldProvenance>;
}

/** Merge one cluster's records (plus any accepted values) into canonical fields with provenance. */
export function mergeEntity(
  spec: EntityFieldSpec,
  members: readonly SourceEntityRecord[],
  accepted: Readonly<Record<string, AcceptedValue>> = {},
): MergedEntity {
  const fields: Record<string, string | string[]> = {};
  const provenance: Record<string, FieldProvenance> = {};

  for (const field of spec.scalars) {
    const acceptedValue = accepted[field];
    if (acceptedValue && text(acceptedValue.value)) {
      fields[field] = text(acceptedValue.value);
      provenance[field] = { source: { kind: 'accepted' }, observedAt: acceptedValue.acceptedAt, acceptedBy: acceptedValue.acceptedBy };
      continue;
    }
    let best: SourceEntityRecord | null = null;
    for (const member of members) {
      if (!text(member.payload[field])) continue;
      if (!best || outranks(member, best)) best = member;
    }
    if (best) {
      fields[field] = text(best.payload[field]);
      provenance[field] = { source: recordSource(best), observedAt: best.observedAt, acceptedBy: null };
    }
  }

  for (const [field, { read, normalize }] of Object.entries(spec.lists)) {
    const latest = new Map<string, SourceEntityRecord>();
    for (const member of members) {
      for (const payloadField of read) {
        for (const raw of rawValues(member.payload[payloadField])) {
          const value = normalize(raw);
          if (!value) continue;
          const seen = latest.get(value);
          if (!seen || newer(member, seen)) latest.set(value, member);
        }
      }
    }
    const acceptedValue = accepted[field];
    const acceptedNormalized = acceptedValue ? normalize(acceptedValue.value) : null;
    if (latest.size === 0 && !acceptedNormalized) continue;
    const values = new Set(latest.keys());
    if (acceptedNormalized) values.add(acceptedNormalized);
    const ordered = [...values].sort();
    fields[field] = ordered;
    for (const value of ordered) {
      const key = listProvenanceKey(field, value);
      if (acceptedNormalized === value && acceptedValue) {
        provenance[key] = { source: { kind: 'accepted' }, observedAt: acceptedValue.acceptedAt, acceptedBy: acceptedValue.acceptedBy };
      } else {
        const member = latest.get(value)!;
        provenance[key] = { source: recordSource(member), observedAt: member.observedAt, acceptedBy: null };
      }
    }
  }

  return { fields, provenance };
}
