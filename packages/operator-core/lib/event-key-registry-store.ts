/**
 * Event-key registry store — identities-v1 P-029 half (a) / D-010, D-011, D-058, D-061.
 *
 * Mirrors capability-class-registry-store.ts deliberately (same workspace isolation,
 * same review gating, same tsv/embedding discovery) rather than inventing a parallel
 * discovery surface for events.
 *
 * THE LOAD-BEARING SPLIT (D-058 route (a)). The table holds two populations governed
 * differently, and this module is where that split is ENFORCED rather than merely
 * documented:
 *
 *   CURATED (rung 4)   — title/description/key_pattern/contributor/status/review.
 *                        Written by `registerEventKey`.
 *   DERIVED (rungs 1-3) — emitter/emitter_exists/emit_site_count. NULL means
 *                        NOT-YET-DERIVED. Written ONLY by `recordEventKeyDerivation`,
 *                        which requires the scan provenance that dates the reading.
 *
 * `registerEventKey` has no parameter that can reach a derived column. That is the
 * point: a `false` written by hand would read as "measured, and the answer is no"
 * when nothing measured anything — the exact hand-authored lie EVENT_CATALOG drifted
 * into, and which this item exists to end.
 *
 * Rung-3 ATTESTATION is a LIVE JOIN to harness_shared.event_key_fires via the
 * `event_key_registry_attested` view (D-061), never stored columns here — copying
 * fire counts in would create a second copy of a truth another relation owns.
 */

import type postgres from 'postgres';

/** Lifecycle INTENT — a decision, never a measurement. See `emitterExists` for the measurement. */
export type EventKeyStatus = 'active' | 'retired' | 'superseded';

/** D-057: the `event` Cupboard listing kind publishes review-gated `pending`. */
export type EventKeyReviewStatus = 'none' | 'pending' | 'approved' | 'rejected';

export const EVENT_KEY_STATUSES: readonly EventKeyStatus[] = ['active', 'retired', 'superseded'];
export const EVENT_KEY_REVIEW_STATUSES: readonly EventKeyReviewStatus[] = [
  'none',
  'pending',
  'approved',
  'rejected',
];

export interface EventKeyRow {
  workspaceId: string;
  eventKey: string;
  title: string;
  description: string;
  keyPattern: string | null;
  contributor: string | null;
  status: EventKeyStatus;
  published: boolean;
  reviewStatus: EventKeyReviewStatus;
  tags: string[];
  /**
   * CURATED (1171). The intended shape of this key's emitted payload, as a JSON
   * object; `events:await` consumers read it to know what a fired payload carries.
   *
   * ⚠ ITS `null` IS NOT THE `null` BELOW. Here it means NO PAYLOAD CONTRACT HAS
   * BEEN DECLARED — a curation state. The three derived fields' `null` means
   * NOT-YET-DERIVED, an un-run measurement. Same literal, different claim.
   */
  payloadSchema: Record<string, unknown> | null;
  /**
   * DERIVED. `null` is NOT-YET-DERIVED and is a different claim from a measured
   * absence — read `derivedAt` before concluding anything from these three.
   */
  emitter: string | null;
  emitterExists: boolean | null;
  emitSiteCount: number | null;
  /** `null` here is the authoritative "no scan has ever run" signal. */
  derivedAt: string | null;
  derivedFrom: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  score?: number;
}

/** A registry row joined to its live fire ledger (the `event_key_registry_attested` view). */
export interface AttestedEventKeyRow extends Omit<EventKeyRow, 'score'> {
  firstFiredAt: string | null;
  lastFiredAt: string | null;
  lastFiredBy: string | null;
  fireCount: number;
  /**
   * The scan said no emitter exists, yet the key has actually fired. A TRUE here
   * means the derivation is wrong, not that the key is — investigate the scan.
   */
  contradictsScan: boolean;
}

/** CURATED fields only. There is deliberately no way to set a derived column here. */
export interface RegisterEventKeyInput {
  workspaceId: string;
  eventKey: string;
  title: string;
  description: string;
  /** The template as agents type it into `events:await` (e.g. `work-item:done:*`). */
  keyPattern?: string | null;
  /** Provenance of the registration: 'core', 'plugin:<id>', 'blueprint:<id>'. */
  contributor?: string | null;
  status?: EventKeyStatus;
  tags?: string[];
  /**
   * The payload contract, as a JSON object. OMITTING IT CLEARS a previously
   * declared contract — exactly as omitting `keyPattern`/`contributor` clears
   * those. A curation write states the whole curated state; it is not a patch.
   * (`embedding` is the deliberate exception, being expensive to recompute.)
   */
  payloadSchema?: Record<string, unknown> | null;
  embedding?: number[] | null;
  createdBy?: string | null;
}

/**
 * The scan provenance that DATES a derived reading. Required, because the table's
 * `event_key_registry_derived_dated_ck` refuses a derived value without it — a
 * reading nobody can date is indistinguishable from a hand-set one.
 */
export interface RecordEventKeyDerivationInput {
  workspaceId: string;
  eventKey: string;
  emitter: string | null;
  emitterExists: boolean;
  emitSiteCount: number;
  /** What the derivation ran against — a commit sha or buildKey. */
  derivedFrom: string;
  /** Defaults to now(); pass an explicit ISO stamp when replaying a recorded scan. */
  derivedAt?: string;
}

interface EventKeyDbRow {
  workspace_id: string;
  event_key: string;
  title: string;
  description: string;
  key_pattern: string | null;
  contributor: string | null;
  status: string;
  published: boolean;
  review_status: string;
  tags: string[] | null;
  payload_schema: Record<string, unknown> | null;
  emitter: string | null;
  emitter_exists: boolean | null;
  emit_site_count: number | string | null;
  derived_at: Date | string | null;
  derived_from: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  score?: number | string | null;
}

interface AttestedDbRow extends EventKeyDbRow {
  first_fired_at: Date | string | null;
  last_fired_at: Date | string | null;
  last_fired_by: string | null;
  fire_count: number | string | null;
  contradicts_scan: boolean | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toInt(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function mapRow(row: EventKeyDbRow): EventKeyRow {
  const mapped: EventKeyRow = {
    workspaceId: row.workspace_id,
    eventKey: row.event_key,
    title: row.title,
    description: row.description,
    keyPattern: row.key_pattern,
    contributor: row.contributor,
    status: row.status as EventKeyStatus,
    published: row.published,
    reviewStatus: row.review_status as EventKeyReviewStatus,
    tags: row.tags ?? [],
    payloadSchema: row.payload_schema ?? null,
    emitter: row.emitter,
    emitterExists: row.emitter_exists,
    emitSiteCount: toInt(row.emit_site_count),
    derivedAt: toIso(row.derived_at),
    derivedFrom: row.derived_from,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
  const score = toInt(row.score ?? null);
  if (score !== null && !Number.isNaN(score)) mapped.score = score;
  return mapped;
}

function mapAttestedRow(row: AttestedDbRow): AttestedEventKeyRow {
  const base = mapRow(row);
  delete base.score;
  return {
    ...base,
    firstFiredAt: toIso(row.first_fired_at),
    lastFiredAt: toIso(row.last_fired_at),
    lastFiredBy: row.last_fired_by,
    fireCount: toInt(row.fire_count) ?? 0,
    contradictsScan: row.contradicts_scan === true,
  };
}

/**
 * Trim and validate an event key. Returns the canonical form.
 *
 * Deliberately does NOT lowercase or rewrite separators: an event key is matched
 * EXACTLY by `events:await`, so silently normalizing one here would register a key
 * that no listener can ever rendezvous with.
 */
export function normalizeEventKey(value: string): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) {
    throw new Error('event key must be a non-empty string');
  }
  return trimmed;
}

/**
 * Validate a curated payload contract and serialize it for `::jsonb`.
 *
 * `event_key_registry_payload_schema_ck` already refuses anything but a JSON
 * object; this states the SAME rule where the caller can act on it. A constraint
 * violation names the constraint, not the field the caller got wrong — and the
 * shapes it catches (a scalar, a string, a top-level array) are exactly the ones
 * that pass as valid JSON and then fail whoever reads them as a schema.
 */
export function normalizePayloadSchema(
  value: Record<string, unknown> | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('payloadSchema must be a JSON object (not an array or a scalar)');
  }
  return JSON.stringify(value);
}

/**
 * Register (or update) the CURATED half of an event key.
 *
 * Re-registering an existing key refreshes its curated fields and leaves every
 * derived column exactly as it was — a curation edit is not a measurement and must
 * never look like one.
 */
export async function registerEventKey(
  sql: postgres.Sql,
  input: RegisterEventKeyInput,
): Promise<EventKeyRow> {
  const eventKey = normalizeEventKey(input.eventKey);
  const status = input.status ?? 'active';
  if (!EVENT_KEY_STATUSES.includes(status)) {
    throw new Error(`invalid event key status: ${status}`);
  }
  const tags = input.tags ?? [];
  const payloadSchema = normalizePayloadSchema(input.payloadSchema);
  const embedding = input.embedding ? JSON.stringify(input.embedding) : null;

  const rows = await sql<EventKeyDbRow[]>`
    INSERT INTO harness_shared.event_key_registry (
      workspace_id, event_key, title, description, key_pattern,
      contributor, status, tags, payload_schema, embedding, created_by
    ) VALUES (
      ${input.workspaceId}, ${eventKey}, ${input.title}, ${input.description},
      ${input.keyPattern ?? null}, ${input.contributor ?? null}, ${status},
      ${tags}, ${payloadSchema}::jsonb, ${embedding}::vector, ${input.createdBy ?? null}
    )
    ON CONFLICT (workspace_id, event_key) DO UPDATE SET
      title       = EXCLUDED.title,
      description = EXCLUDED.description,
      key_pattern = EXCLUDED.key_pattern,
      contributor = EXCLUDED.contributor,
      status      = EXCLUDED.status,
      tags        = EXCLUDED.tags,
      -- Plain assignment, NOT COALESCE: payload_schema is curated like key_pattern
      -- and contributor, so a re-registration states the whole curated state.
      -- The embedding below is the deliberate exception: expensive to recompute.
      payload_schema = EXCLUDED.payload_schema,
      embedding   = COALESCE(EXCLUDED.embedding, harness_shared.event_key_registry.embedding),
      updated_at  = now()
    RETURNING *
  `;
  return mapRow(rows[0]);
}

export async function getEventKey(
  sql: postgres.Sql | postgres.TransactionSql,
  workspaceId: string,
  eventKey: string,
): Promise<EventKeyRow | null> {
  const rows = await sql<EventKeyDbRow[]>`
    SELECT * FROM harness_shared.event_key_registry
     WHERE workspace_id = ${workspaceId}
       AND event_key = ${normalizeEventKey(eventKey)}
     LIMIT 1
  `;
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export interface ListEventKeysOptions {
  /** Full-text query over title + description (the `title_tsv` generated column). */
  query?: string;
  tag?: string;
  /** Include `retired` / `superseded` rows. Default false. */
  includeInactive?: boolean;
  reviewStatus?: EventKeyReviewStatus;
  contributor?: string;
  limit?: number;
}

export async function listEventKeys(
  sql: postgres.Sql,
  workspaceId: string,
  options: ListEventKeysOptions = {},
): Promise<EventKeyRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const query = options.query?.trim();

  const rows = await sql<EventKeyDbRow[]>`
    SELECT *${
      query
        ? sql`, ts_rank(title_tsv, plainto_tsquery('english', ${query})) AS score`
        : sql``
    }
      FROM harness_shared.event_key_registry
     WHERE workspace_id = ${workspaceId}
       ${options.includeInactive ? sql`` : sql`AND status = 'active'`}
       ${query ? sql`AND title_tsv @@ plainto_tsquery('english', ${query})` : sql``}
       ${options.tag ? sql`AND ${options.tag} = ANY(tags)` : sql``}
       ${options.reviewStatus ? sql`AND review_status = ${options.reviewStatus}` : sql``}
       ${options.contributor ? sql`AND contributor = ${options.contributor}` : sql``}
     ORDER BY ${query ? sql`score DESC,` : sql``} event_key ASC
     LIMIT ${limit}
  `;
  return rows.map(mapRow);
}

/**
 * Move a key through the review lifecycle. `published` is set only by an `approved`
 * review — D-057: the most actuating listing kinds must not be the ones that
 * auto-approve, so publication is never a side effect of registration.
 */
export async function setEventKeyReviewStatus(
  sql: postgres.Sql,
  workspaceId: string,
  eventKey: string,
  reviewStatus: EventKeyReviewStatus,
): Promise<EventKeyRow | null> {
  if (!EVENT_KEY_REVIEW_STATUSES.includes(reviewStatus)) {
    throw new Error(`invalid review status: ${reviewStatus}`);
  }
  const rows = await sql<EventKeyDbRow[]>`
    UPDATE harness_shared.event_key_registry
       SET review_status = ${reviewStatus},
           published = ${reviewStatus === 'approved'},
           updated_at = now()
     WHERE workspace_id = ${workspaceId}
       AND event_key = ${normalizeEventKey(eventKey)}
     RETURNING *
  `;
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * THE ONLY writer for the derived columns (D-058).
 *
 * Requires `derivedFrom` and stamps `derivedAt`, so every derived reading carries the
 * provenance that dates it. A caller that wants to say "no emitter exists" must have
 * run a scan to say it — which is what makes NULL and FALSE distinguishable forever
 * after.
 */
export async function recordEventKeyDerivation(
  sql: postgres.Sql,
  input: RecordEventKeyDerivationInput,
): Promise<EventKeyRow | null> {
  const derivedFrom = (input.derivedFrom ?? '').trim();
  if (derivedFrom.length === 0) {
    throw new Error('recordEventKeyDerivation requires derivedFrom (a commit sha or buildKey)');
  }
  if (!Number.isInteger(input.emitSiteCount) || input.emitSiteCount < 0) {
    throw new Error('emitSiteCount must be a non-negative integer');
  }
  const rows = await sql<EventKeyDbRow[]>`
    UPDATE harness_shared.event_key_registry
       SET emitter         = ${input.emitter},
           emitter_exists  = ${input.emitterExists},
           emit_site_count = ${input.emitSiteCount},
           derived_at      = COALESCE(${input.derivedAt ?? null}::timestamptz, now()),
           derived_from    = ${derivedFrom},
           updated_at      = now()
     WHERE workspace_id = ${input.workspaceId}
       AND event_key = ${normalizeEventKey(input.eventKey)}
     RETURNING *
  `;
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * Read a key joined to its LIVE fire ledger (rung-3 attestation, D-061).
 * Never a stored column — `event_key_fires` owns these facts.
 */
export async function getAttestedEventKey(
  sql: postgres.Sql,
  workspaceId: string,
  eventKey: string,
): Promise<AttestedEventKeyRow | null> {
  const rows = await sql<AttestedDbRow[]>`
    SELECT * FROM harness_shared.event_key_registry_attested
     WHERE workspace_id = ${workspaceId}
       AND event_key = ${normalizeEventKey(eventKey)}
     LIMIT 1
  `;
  return rows.length > 0 ? mapAttestedRow(rows[0]) : null;
}

/**
 * The audit this table exists to make cheap: registered keys NO scan has ever looked
 * at, plus ones a scan proved have no emitter. Backed by `event_key_registry_underived_idx`.
 *
 * The two are returned together but mean different things — read `derivedAt` to tell
 * "never measured" from "measured, and there is no emitter".
 */
export async function listUnderivedEventKeys(
  sql: postgres.Sql,
  workspaceId: string,
  limit = 100,
): Promise<EventKeyRow[]> {
  const rows = await sql<EventKeyDbRow[]>`
    SELECT * FROM harness_shared.event_key_registry
     WHERE workspace_id = ${workspaceId}
       AND status = 'active'
       AND (derived_at IS NULL OR emitter_exists IS FALSE)
     ORDER BY derived_at NULLS FIRST, event_key ASC
     LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `;
  return rows.map(mapRow);
}

/**
 * Keys the scan declared emitter-less that have nevertheless FIRED. Each row is a
 * refutation of the derivation, not of the key — this is the check that would have
 * caught EVENT_CATALOG recording the system's most-fired key as unregistered.
 */
export async function listScanContradictions(
  sql: postgres.Sql,
  workspaceId: string,
  limit = 100,
): Promise<AttestedEventKeyRow[]> {
  const rows = await sql<AttestedDbRow[]>`
    SELECT * FROM harness_shared.event_key_registry_attested
     WHERE workspace_id = ${workspaceId}
       AND contradicts_scan
     ORDER BY fire_count DESC, event_key ASC
     LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `;
  return rows.map(mapAttestedRow);
}
