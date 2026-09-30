/**
 * Atomic feature checkout for the worker dispatch loop.
 *
 * Uses Postgres `FOR UPDATE SKIP LOCKED` so multiple workers running in
 * parallel each grab a different row without contention. Tasks have
 * `taken_by` + `taken_at` + `expires_at` columns set on checkout.
 *
 * Recovery: any feature whose `expires_at` has passed without status
 * transitioning is released back to the pool by `releaseExpired()`.
 */

import type { Sql } from 'postgres';

export interface CheckoutOptions {
  /** Worker identifier — written to taken_by. */
  workerId: string;
  /** Lease duration in seconds. Default 30 minutes. */
  leaseSec?: number;
  /** Filter to specific status values. Default: ['todo', 'failing']. */
  statuses?: string[];
  /** Optional project filter. */
  projectId?: string;
}

export interface CheckedOutFeature {
  harnessSlug: string;
  featureId: string;
  title: string;
  status: string;
  attempts: number;
  takenBy: string;
  takenAt: Date;
  expiresAt: Date;
}

function validateSchema(schemaName: string): void {
  if (!/^harness_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error(`invalid schema name: ${schemaName}`);
  }
}

/**
 * Atomically check out the next available feature for a worker.
 *
 * Returns null if no feature is available. Returns the locked row otherwise.
 *
 * Concurrent calls each get a different row (or null) — never the same row.
 *
 * Caller MUST release the lock when done by:
 *   - setStatusAndRelease() — set status to terminal value + clear lock
 *   - releaseLock() — clear lock without status change
 */
export async function checkoutNextFeature(
  sql: Sql,
  schemaName: string,
  harnessSlug: string,
  opts: CheckoutOptions
): Promise<CheckedOutFeature | null> {
  validateSchema(schemaName);
  const leaseSec = opts.leaseSec ?? 30 * 60;
  const statuses = opts.statuses ?? ['todo', 'failing'];

  // postgres-js's tag function: schema name interpolated via sql() helper.
  const tableRef = sql(`${schemaName}.harness_features`);

  // Optional project filter
  const projectClause = opts.projectId
    ? sql`AND project_id = ${opts.projectId}`
    : sql``;

  const rows = await sql<{
    harness_slug: string;
    feature_id: string;
    title: string;
    status: string;
    attempts: number;
    taken_by: string;
    taken_at: Date;
    expires_at: Date;
  }[]>`
    UPDATE ${tableRef}
       SET taken_by   = ${opts.workerId},
           taken_at   = now(),
           expires_at = now() + ${leaseSec + ' seconds'}::interval,
           attempts   = attempts + 1,
           status     = CASE WHEN status = 'todo' THEN 'in_progress' ELSE status END,
           updated_ts = (extract(epoch from now()) * 1000)::bigint
     WHERE (harness_slug, feature_id) = (
       SELECT harness_slug, feature_id
         FROM ${tableRef}
        WHERE harness_slug = ${harnessSlug}
          AND status = ANY(${statuses}::text[])
          AND taken_by IS NULL
          ${projectClause}
        ORDER BY created_ts ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING harness_slug, feature_id, title, status, attempts,
               taken_by, taken_at, expires_at
  `;

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    harnessSlug: row.harness_slug,
    featureId: row.feature_id,
    title: row.title,
    status: row.status,
    attempts: Number(row.attempts),
    takenBy: row.taken_by,
    takenAt: row.taken_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Release expired locks. Called periodically by the substrate to recover
 * orphaned checkouts (worker crashed / process killed before completing).
 *
 * Returns the number of features released.
 */
export async function releaseExpired(sql: Sql, schemaName: string): Promise<number> {
  validateSchema(schemaName);
  const tableRef = sql(`${schemaName}.harness_features`);
  const result = await sql`
    UPDATE ${tableRef}
       SET taken_by = NULL,
           taken_at = NULL,
           expires_at = NULL,
           status = CASE WHEN status = 'in_progress' THEN 'todo' ELSE status END,
           updated_ts = (extract(epoch from now()) * 1000)::bigint
     WHERE expires_at < now()
       AND taken_by IS NOT NULL
  `;
  return Number((result as { count: number }).count ?? 0);
}

/**
 * Manually drop a lock without changing status. For abort cases.
 */
export async function releaseLock(
  sql: Sql,
  schemaName: string,
  harnessSlug: string,
  featureId: string,
  workerId: string
): Promise<boolean> {
  validateSchema(schemaName);
  const tableRef = sql(`${schemaName}.harness_features`);
  const result = await sql`
    UPDATE ${tableRef}
       SET taken_by = NULL,
           taken_at = NULL,
           expires_at = NULL,
           updated_ts = (extract(epoch from now()) * 1000)::bigint
     WHERE harness_slug = ${harnessSlug}
       AND feature_id   = ${featureId}
       AND taken_by     = ${workerId}
  `;
  return Number((result as { count: number }).count ?? 0) > 0;
}

/**
 * Set status (passed/failing/etc) AND release the lock. Atomic.
 */
export async function setStatusAndRelease(
  sql: Sql,
  schemaName: string,
  harnessSlug: string,
  featureId: string,
  workerId: string,
  status: 'passed' | 'failing' | 'validating' | 'blocked' | 'todo'
): Promise<boolean> {
  validateSchema(schemaName);
  const tableRef = sql(`${schemaName}.harness_features`);
  const result = await sql`
    UPDATE ${tableRef}
       SET status = ${status},
           taken_by = NULL,
           taken_at = NULL,
           expires_at = NULL,
           updated_ts = (extract(epoch from now()) * 1000)::bigint
     WHERE harness_slug = ${harnessSlug}
       AND feature_id   = ${featureId}
       AND taken_by     = ${workerId}
  `;
  return Number((result as { count: number }).count ?? 0) > 0;
}
