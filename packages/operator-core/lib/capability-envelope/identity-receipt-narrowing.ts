/**
 * Narrow a launch record's `identityHistory` to the receipts a reader needs, IN
 * PostgreSQL, before the record reaches a Node request worker (WI-10004801,
 * owner directive #1155).
 *
 * WHY. `adv_sessions.launch_spec.identityHistory` keeps up to 12 earlier
 * receipts, each with its own `specificationArtifact` (~1 MB of JSON). Measured
 * 2026-10-01 on live rows: one record reached 13.2 MB of JSON text, and across
 * 146 live owners identityHistory was 175 of 270 MB. The identity gate's body
 * read (`loadIdentityLaunchRecord`, 64,266 calls in ~39 h per
 * pg_stat_statements) needs at most the receipt matching ONE applied revision
 * pair, yet it shipped and `JSON.parse`d the whole record on the worker's main
 * thread. A worker with a cold or evicted identity cache did that for every
 * active owner at once. That matches the observed `postgres.js` json-parse heap
 * spikes (to 3.7 GB) and 21-24 s event-loop stalls that recycle :3070 workers
 * and drop their MCP connections.
 *
 * CONTRACT. The narrowed record is the stored record with identityHistory
 * replaced by the entries whose `specificationRevision` AND `stateRevision` are
 * jsonb-equal (type included, like JS `===` on parsed JSON) to one of the
 * requested pairs, in the stored order. Every top-level field is untouched.
 * Since `selectAppliedReceipt` takes the FIRST match across
 * `[record, ...identityHistory]`, and a filtered list keeps every match in
 * order, the receipt it selects is unchanged for every requested pair. A
 * non-object record, or a record whose identityHistory is not an array, comes
 * back exactly as stored. `revisionsParam` returns null for a malformed pair,
 * and null means "read the whole record": a narrowing that cannot be exact is
 * never applied.
 *
 * {@link narrowIdentityHistory} is the JavaScript statement of the same
 * contract. The real-PostgreSQL test holds the SQL to it.
 */
import type { Fragment, Sql } from 'postgres';

/** The pair a receipt is selected by (the kernel's `KernelExecutionRevision`). */
export interface IdentityReceiptRevision {
  specificationRevision: string;
  stateRevision: string;
}

/**
 * The jsonb parameter for {@link selectNarrowedLaunchSpecBody}: the requested
 * pairs as a JSON array, or `null` when any pair is not a pair of strings.
 * Strict on purpose: PostgreSQL's jsonb equality and JS `===` agree only for
 * the string-valued pairs the kernel produces.
 */
export function revisionsParam(revisions: readonly unknown[]): string | null {
  const pairs: IdentityReceiptRevision[] = [];
  for (const revision of revisions) {
    const value = revision as Partial<IdentityReceiptRevision> | null | undefined;
    if (!value || typeof value.specificationRevision !== 'string' || typeof value.stateRevision !== 'string') {
      return null;
    }
    pairs.push({ specificationRevision: value.specificationRevision, stateRevision: value.stateRevision });
  }
  return JSON.stringify(pairs);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** The JavaScript statement of the narrowing contract (see the module doc). */
export function narrowIdentityHistory(record: unknown, revisions: readonly unknown[]): unknown {
  const param = revisionsParam(revisions);
  if (param === null || !isObject(record) || !Array.isArray(record.identityHistory)) return record;
  const wanted = JSON.parse(param) as IdentityReceiptRevision[];
  return {
    ...record,
    identityHistory: record.identityHistory.filter((entry) =>
      isObject(entry) && wanted.some((pair) =>
        entry.specificationRevision === pair.specificationRevision &&
        entry.stateRevision === pair.stateRevision)),
  };
}

/**
 * The narrowing as ONE SQL fragment over `n.launch_spec`: the caller selects
 * its launch record into a derived table aliased `n` and interpolates this as
 * the output column. Both selections (the gate's body read below, and
 * control-anchor's `readGateSelectedLaunchSpec`) share it, so the SQL that
 * the real-PostgreSQL test holds to {@link narrowIdentityHistory} is the SQL
 * every reader runs. `revisions: null`, or a malformed pair, keeps the value
 * whole.
 */
export function narrowedLaunchSpecSql(sql: Sql, revisions: readonly unknown[] | null): Fragment {
  const want = revisions === null ? null : revisionsParam(revisions);
  if (want === null) return sql`n.launch_spec`;
  return narrowCaseSql(sql, want);
}

/**
 * {@link narrowedLaunchSpecSql} for a reader whose pair differs per ROW, so it
 * cannot be one bound parameter (WI-10004803: the wedged-identity watchdog
 * reads every owner's `control_state->activation->applied`). The derived table
 * `n` carries a second column, `n.applied_pair`: a jsonb object with the pair.
 * Strict like {@link revisionsParam}: unless BOTH revisions are jsonb strings
 * the record stays whole, so the narrowing is only applied where it is exact.
 */
export function narrowedLaunchSpecToAppliedPairSql(sql: Sql): Fragment {
  return sql`CASE
      WHEN jsonb_typeof(n.applied_pair->'specificationRevision') = 'string'
       AND jsonb_typeof(n.applied_pair->'stateRevision') = 'string'
      THEN ${narrowCaseSql(sql, sql`jsonb_build_array(n.applied_pair)`)}
      ELSE n.launch_spec
    END`;
}

/** The one copy of the narrowing SQL. `want` is the requested pairs as a JSON
 * array: a bound text parameter, or a SQL expression evaluating to one. */
function narrowCaseSql(sql: Sql, want: string | Fragment): Fragment {
  // `::text::jsonb`, never a bare `::jsonb`: a parameter the server types as
  // jsonb is JSON-encoded AGAIN by postgres.js, turning the array into a jsonb
  // string that matches no receipt (the WI-10002717 seeding trap).
  return sql`CASE
      WHEN jsonb_typeof(n.launch_spec) = 'object'
       AND jsonb_typeof(n.launch_spec->'identityHistory') = 'array'
      THEN jsonb_set(n.launch_spec, '{identityHistory}', COALESCE((
             SELECT jsonb_agg(e.h ORDER BY e.ord)
               FROM jsonb_array_elements(n.launch_spec->'identityHistory') WITH ORDINALITY AS e(h, ord)
              WHERE jsonb_typeof(e.h) = 'object'
                AND EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements(${want}::text::jsonb) AS r(v)
                   WHERE e.h->'specificationRevision' = r.v->'specificationRevision'
                     AND e.h->'stateRevision' = r.v->'stateRevision')
           ), '[]'::jsonb))
      ELSE n.launch_spec
    END`;
}

/**
 * Read one launch record body with identityHistory narrowed to `revisions`, at
 * the row version it was read at. Selection is the identity gate's body read
 * verbatim (row id + owner + workspace). `revisions: null` reads the record whole.
 */
export async function selectNarrowedLaunchSpecBody(
  sql: Sql,
  input: {
    advSessionId: number | string;
    ownerId: string;
    workspaceId: string;
    revisions: readonly unknown[] | null;
  },
): Promise<Array<{ launch_spec: unknown; launch_spec_xmin: string | null }>> {
  return sql<Array<{ launch_spec: unknown; launch_spec_xmin: string | null }>>`
    SELECT ${narrowedLaunchSpecSql(sql, input.revisions)} AS launch_spec, n.launch_spec_xmin
      FROM (
        SELECT s.launch_spec, s.xmin::text AS launch_spec_xmin
          FROM harness_shared.adv_sessions s
         WHERE s.id = ${input.advSessionId} AND s.coord_owner_id = ${input.ownerId} AND s.workspace_id = ${input.workspaceId}
         LIMIT 1
      ) AS n
  `;
}
