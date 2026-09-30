/**
 * Leader-registered CUSTOM fleet invariants, evaluated on every
 * `fleet:leader-brief` (fleet-leadership-continuity-and-actuation-2026-08-01
 * P-014, migration 713).
 *
 * WHAT THIS ADDS THAT THE BUILT-INS DO NOT: leader-brief already computes
 * stranded-fleet, spec-starved, idle-with-claimable, floor-starved and dormant
 * alerts. Every one of those is a check somebody thought to build IN ADVANCE.
 * The motivating incident was the opposite shape — during the 2026-07-26
 * push-not-poll run a leader wrote a ~6-line ad-hoc check cross-referencing each
 * member's parked event keys against the ASSIGNEE of the work-items named in
 * them, it caught a real problem no built-in counter surfaced, and it died with
 * the turn that wrote it. This is where that check now lives.
 *
 * CONTRACT: rows returned == VIOLATED, and those rows ARE the evidence the
 * leader sees. Zero rows == satisfied. The invariant is always reported as
 * evaluated either way, so a check that has quietly stopped matching is
 * distinguishable from one that was never run — the failure mode a bare
 * "no alerts" summary cannot express.
 *
 * SAFETY: this module never executes SQL itself. Evaluation goes through
 * `pgReadQuery()`, whose READ ONLY transaction is the real write enforcement
 * (PG rejects INSERT/UPDATE/DDL — not a regex that can be talked around), plus
 * statement_timeout, LIMIT-wrap + row cap, and a single-statement assertion.
 * On top of that envelope this module applies its OWN tighter per-invariant
 * caps (below), because a brief is read on a monitor tick and must stay cheap.
 *
 * EVERY EVALUATION IS BEST-EFFORT AND ISOLATED: one malformed or slow invariant
 * reports itself as `status:'error'` and never blocks the brief or the other
 * invariants. That mirrors the discipline the existing spec-effect preview in
 * leader-brief already uses ("never block the brief on a preview failure").
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { pgReadQuery } from '../../pg-read-query';

// `@papercusp/db-org` does not export an `OrgSql` type — importing one from there is a hard
// TS2305 that reds the fleet's typecheck gate. Derive it from getOrgPg (already imported above),
// which is exactly what pg-read-query.ts does. Deliberately NOT imported from
// operator-core/lib/work-items (which does export it): that would pull this leaf module into a
// heavy sibling for a type that is one line to restate.
type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * Per-invariant caps, deliberately tighter than pgReadQuery's own defaults
 * (200 rows / 5000ms). A brief is read on a monitor tick, often every wake, so
 * an invariant is a GLANCE not a report: enough rows to see the shape of the
 * violation and go look, not enough to flood the leader's context.
 */
export const INVARIANT_MAX_ROWS = 20;
export const INVARIANT_TIMEOUT_MS = 3_000;
/** Ceiling on invariants evaluated per brief, so a registry cannot grow into a
 *  per-wake cost nobody is watching. Registration refuses past this. */
export const INVARIANT_MAX_PER_FLEET = 10;

export type InvariantSeverity = 'warn' | 'critical';

export interface FleetInvariant {
  id: string;
  workspaceId: string;
  harnessSlug: string | null;
  fleetSlug: string;
  name: string;
  description: string | null;
  querySql: string;
  severity: InvariantSeverity;
  active: boolean;
  createdBy: string | null;
}

export interface InvariantEvaluation {
  name: string;
  severity: InvariantSeverity;
  description?: string;
  /** 'violated' = returned rows · 'satisfied' = zero rows · 'error' = did not run. */
  status: 'satisfied' | 'violated' | 'error';
  violationCount?: number;
  /** The offending rows themselves, capped at INVARIANT_MAX_ROWS. */
  rows?: Record<string, unknown>[];
  /** True when more rows existed than the cap returned. */
  truncated?: boolean;
  error?: string;
  elapsedMs: number;
}

/**
 * Substitute the strictly-typed placeholders an invariant may reference.
 *
 * WHY THIS EXISTS rather than making leaders hardcode their fleet slug: an
 * invariant is the kind of thing that gets copied between fleets, and a
 * hardcoded slug survives the copy silently — the invariant keeps passing
 * because it is still checking the ORIGINAL fleet, which is the exact
 * false-clean shape this whole feature exists to surface. `{{fleet}}` makes a
 * copied invariant correct by construction.
 *
 * Values come from the resolved brief context (never from caller input at
 * evaluation time) and are emitted as single-quoted literals with quote
 * doubling, PG's own escape. PURE — exported for direct unit test.
 */
export function substituteInvariantPlaceholders(
  sql: string,
  vars: { fleet: string; workspace: string },
): string {
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  return sql
    .replace(/\{\{\s*fleet\s*\}\}/g, lit(vars.fleet))
    .replace(/\{\{\s*workspace\s*\}\}/g, lit(vars.workspace));
}

/**
 * Roll the per-invariant results into the counts a leader's monitor loop keys
 * on. PURE — exported for direct unit test, same as the built-in compute*Alert
 * family it sits beside.
 */
export function summarizeInvariantEvaluations(evaluations: InvariantEvaluation[]): {
  evaluated: number;
  violated: number;
  criticalViolated: number;
  errored: number;
} {
  let violated = 0;
  let criticalViolated = 0;
  let errored = 0;
  for (const e of evaluations) {
    if (e.status === 'error') errored += 1;
    else if (e.status === 'violated') {
      violated += 1;
      if (e.severity === 'critical') criticalViolated += 1;
    }
  }
  return { evaluated: evaluations.length, violated, criticalViolated, errored };
}

/**
 * The brief-facing alert line, shaped exactly like the built-in
 * compute*Alert functions (`{ reason } | undefined`) so it surfaces through the
 * same path rather than inventing a second alert channel.
 *
 * An ERRORED invariant is reported even when nothing is violated: a check that
 * silently stopped running is indistinguishable from a passing one otherwise,
 * which would reintroduce the false-clean failure at one level up.
 * PURE — exported for direct unit test.
 */
export function computeCustomInvariantAlert(
  evaluations: InvariantEvaluation[],
): { reason: string } | undefined {
  const { violated, criticalViolated, errored } = summarizeInvariantEvaluations(evaluations);
  if (violated === 0 && errored === 0) return undefined;

  const parts: string[] = [];
  if (violated > 0) {
    const names = evaluations
      .filter((e) => e.status === 'violated')
      .map((e) => `${e.name}(${e.violationCount ?? 0}${e.truncated ? '+' : ''})`)
      .join(', ');
    parts.push(
      `${violated} custom invariant(s) VIOLATED — ${names}` +
        (criticalViolated > 0 ? ` — ${criticalViolated} of them critical` : ''),
    );
  }
  if (errored > 0) {
    const names = evaluations
      .filter((e) => e.status === 'error')
      .map((e) => e.name)
      .join(', ');
    parts.push(
      `${errored} invariant(s) FAILED TO RUN (${names}) — a check that cannot run is not a ` +
        'passing check; fix or deactivate it, because it is currently telling you nothing',
    );
  }
  parts.push('see customInvariants[] for the offending rows');
  return { reason: parts.join('; ') };
}

/** Every active invariant registered for one fleet. */
export async function listFleetInvariants(
  args: { workspaceId: string; fleetSlug: string; includeInactive?: boolean },
  sqlOverride?: OrgSql,
): Promise<FleetInvariant[]> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT id, workspace_id, harness_slug, fleet_slug, name, description,
           query_sql, severity, active, created_by
      FROM harness_shared.fleet_invariants
     WHERE workspace_id = ${args.workspaceId}
       AND fleet_slug = ${args.fleetSlug}
       ${args.includeInactive ? sql`` : sql`AND active`}
     ORDER BY name
  `) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    harnessSlug: r.harness_slug == null ? null : String(r.harness_slug),
    fleetSlug: String(r.fleet_slug),
    name: String(r.name),
    description: r.description == null ? null : String(r.description),
    querySql: String(r.query_sql),
    severity: (r.severity === 'critical' ? 'critical' : 'warn') as InvariantSeverity,
    active: r.active === true,
    createdBy: r.created_by == null ? null : String(r.created_by),
  }));
}

/**
 * Register (or replace, by name) one invariant for a fleet.
 *
 * REGISTRATION PROVES THE CHECK RUNS — it does not merely store SQL. The
 * original implementation asserted only that `querySql` was a single read
 * STATEMENT, which is a claim about its shape, not about whether it can
 * execute. A statement that is well-formed but references a column, cast or
 * placeholder that does not resolve therefore registered cleanly and then
 * reported `status:'error'` on every future brief — precisely what the
 * write-time rejection above it says it exists to prevent. So registration now
 * EXECUTES the prepared statement once, through the same `pgReadQuery` path
 * evaluation uses, and refuses a check that cannot run.
 *
 * `falsifierSql` closes the harder half. This registry's contract is ROWS ==
 * VIOLATED, so ZERO ROWS IS THE SAFE READING — which means a check that can
 * never match is indistinguishable from a fleet that is healthy, and reports
 * "satisfied" forever while protecting nothing. That is the same hazard
 * `dev:pg_query` already names with `positiveControlSql` ("use when zero rows
 * will support an absence claim"), so this is that primitive ported to the
 * surface with the same contract, rather than a second mechanism. The
 * falsifier is a deliberately-wrong-input companion — typically the invariant
 * with its pin negated — that MUST return at least one row. Zero rows from it
 * means the instrument cannot fire, and registration is refused.
 *
 * The falsifier is proof-at-registration and is deliberately NOT persisted:
 * proving fire-ability at the moment of the claim needs no new column, and the
 * staleness/re-verification loop that WOULD need one is not implemented here.
 */
export async function registerFleetInvariant(
  args: {
    workspaceId: string;
    harnessSlug?: string | null;
    fleetSlug: string;
    name: string;
    description?: string | null;
    querySql: string;
    falsifierSql?: string | null;
    severity?: InvariantSeverity;
    active?: boolean;
    createdBy?: string | null;
  },
  sqlOverride?: OrgSql,
  deps: { runQuery?: typeof pgReadQuery } = {},
): Promise<{ ok: true; id: string; falsifierRows?: number } | { ok: false; error: string }> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const runQuery = deps.runQuery ?? pgReadQuery;

  // Reject at WRITE time what would otherwise fail on every future brief. A
  // registry whose entries error on each read is worse than an empty one.
  const prepared = substituteInvariantPlaceholders(args.querySql, {
    fleet: args.fleetSlug,
    workspace: args.workspaceId,
  });
  try {
    const { assertSingleReadStatement } = await import('../../pg-read-query');
    assertSingleReadStatement(prepared);
  } catch (e) {
    return { ok: false, error: `querySql is not a single read statement: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Shape was necessary but never sufficient: execute it once, the same way a
  // brief will, so an unrunnable check is refused here instead of erroring on
  // every future read.
  try {
    await runQuery(prepared, { maxRows: INVARIANT_MAX_ROWS, timeoutMs: INVARIANT_TIMEOUT_MS });
  } catch (e) {
    return {
      ok: false,
      error:
        `querySql is a valid single read statement but did not RUN: ${e instanceof Error ? e.message : String(e)} — ` +
        'registration executes the check once so it cannot register clean and then error on every brief',
    };
  }

  // Prove it can FIRE. Without this, zero rows means "satisfied" whether the
  // fleet is healthy or the check is dead, and the two are not distinguishable
  // by reading the brief.
  let falsifierRows: number | undefined;
  if (args.falsifierSql != null && args.falsifierSql.trim() !== '') {
    const preparedFalsifier = substituteInvariantPlaceholders(args.falsifierSql, {
      fleet: args.fleetSlug,
      workspace: args.workspaceId,
    });
    try {
      const { assertSingleReadStatement } = await import('../../pg-read-query');
      assertSingleReadStatement(preparedFalsifier);
    } catch (e) {
      return { ok: false, error: `falsifierSql is not a single read statement: ${e instanceof Error ? e.message : String(e)}` };
    }
    let rows: unknown[];
    try {
      const result = await runQuery(preparedFalsifier, {
        maxRows: INVARIANT_MAX_ROWS,
        timeoutMs: INVARIANT_TIMEOUT_MS,
      });
      rows = result.rows ?? [];
    } catch (e) {
      return {
        ok: false,
        error: `falsifierSql did not RUN: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (rows.length === 0) {
      return {
        ok: false,
        error:
          'falsifierSql returned ZERO rows, so this check is not proven able to fire — a guard that ' +
          'cannot return rows reports "satisfied" forever and protects nothing. The falsifier must be ' +
          'a deliberately-wrong input (usually the invariant with its pin negated) that DOES match.',
      };
    }
    falsifierRows = rows.length;
  }

  const existing = await listFleetInvariants(
    { workspaceId: args.workspaceId, fleetSlug: args.fleetSlug, includeInactive: true },
    sql,
  );
  if (
    existing.length >= INVARIANT_MAX_PER_FLEET &&
    !existing.some((e) => e.name === args.name)
  ) {
    return {
      ok: false,
      error:
        `fleet already has ${existing.length} invariant(s) (cap ${INVARIANT_MAX_PER_FLEET}) — ` +
        'these run on every brief, so remove one before adding another',
    };
  }

  const id = randomUUID();
  const rows = (await sql`
    INSERT INTO harness_shared.fleet_invariants
      (id, workspace_id, harness_slug, fleet_slug, name, description, query_sql, severity, active, created_by)
    VALUES (${id}, ${args.workspaceId}, ${args.harnessSlug ?? null}, ${args.fleetSlug}, ${args.name},
            ${args.description ?? null}, ${args.querySql}, ${args.severity ?? 'warn'},
            ${args.active ?? true}, ${args.createdBy ?? null})
    ON CONFLICT (workspace_id, fleet_slug, name) DO UPDATE
       SET query_sql   = EXCLUDED.query_sql,
           description = EXCLUDED.description,
           severity    = EXCLUDED.severity,
           active      = EXCLUDED.active,
           harness_slug = EXCLUDED.harness_slug,
           updated_at  = now()
    RETURNING id
  `) as unknown as { id: string }[];
  return {
    ok: true,
    id: rows[0]?.id ?? id,
    ...(falsifierRows === undefined ? {} : { falsifierRows }),
  };
}

/** Remove one invariant by name. Returns whether a row was actually deleted. */
export async function removeFleetInvariant(
  args: { workspaceId: string; fleetSlug: string; name: string },
  sqlOverride?: OrgSql,
): Promise<{ removed: boolean }> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    DELETE FROM harness_shared.fleet_invariants
     WHERE workspace_id = ${args.workspaceId}
       AND fleet_slug = ${args.fleetSlug}
       AND name = ${args.name}
    RETURNING id
  `) as unknown as { id: string }[];
  return { removed: rows.length > 0 };
}

/**
 * Evaluate invariants, each in isolation. Never throws: a failure becomes that
 * invariant's own `status:'error'`, so one bad entry cannot take down the brief
 * or hide its siblings' results.
 */
export async function evaluateFleetInvariants(
  args: {
    invariants: FleetInvariant[];
    workspaceId: string;
    fleetSlug: string;
    maxRows?: number;
    timeoutMs?: number;
  },
  deps: { runQuery?: typeof pgReadQuery } = {},
): Promise<InvariantEvaluation[]> {
  const runQuery = deps.runQuery ?? pgReadQuery;
  const maxRows = args.maxRows ?? INVARIANT_MAX_ROWS;
  const timeoutMs = args.timeoutMs ?? INVARIANT_TIMEOUT_MS;

  const out: InvariantEvaluation[] = [];
  for (const inv of args.invariants) {
    const startedAt = Date.now();
    const base = {
      name: inv.name,
      severity: inv.severity,
      ...(inv.description ? { description: inv.description } : {}),
    };
    try {
      const prepared = substituteInvariantPlaceholders(inv.querySql, {
        fleet: args.fleetSlug,
        workspace: args.workspaceId,
      });
      const result = await runQuery(prepared, { maxRows, timeoutMs });
      const rows = result.rows ?? [];
      out.push({
        ...base,
        status: rows.length > 0 ? 'violated' : 'satisfied',
        elapsedMs: Date.now() - startedAt,
        ...(rows.length > 0
          ? { violationCount: rows.length, rows, ...(result.truncated ? { truncated: true } : {}) }
          : {}),
      });
    } catch (e) {
      out.push({
        ...base,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - startedAt,
      });
    }
  }
  return out;
}

/**
 * Read and evaluate the registry as one leader-brief-safe operation.
 *
 * `evaluateFleetInvariants` already turns a failure of ONE invariant into that
 * invariant's own error row. The orchestration around it used to have a wider
 * failure hole, though: a registry-read failure (or an unexpected evaluator
 * failure) was caught by leader-brief and collapsed to an absent/empty
 * `customInvariants` array. That is the exact false-clean state this feature is
 * meant to prevent — the reader cannot distinguish "no checks registered" from
 * "the checks could not be read".
 *
 * `undefined` therefore means ONLY a successful registry read with zero active
 * invariants. Every failure becomes a synthetic critical error evaluation so
 * the existing alert roll-up and response shape carry it without a parallel
 * health channel.
 */
export async function readFleetInvariantEvaluations(
  args: { workspaceId: string; fleetSlug: string },
  deps: {
    list?: typeof listFleetInvariants;
    evaluate?: typeof evaluateFleetInvariants;
  } = {},
): Promise<InvariantEvaluation[] | undefined> {
  const startedAt = Date.now();
  try {
    const registered = await (deps.list ?? listFleetInvariants)({
      workspaceId: args.workspaceId,
      fleetSlug: args.fleetSlug,
    });
    if (registered.length === 0) return undefined;
    return await (deps.evaluate ?? evaluateFleetInvariants)({
      invariants: registered,
      workspaceId: args.workspaceId,
      fleetSlug: args.fleetSlug,
    });
  } catch (error) {
    return [
      {
        name: 'fleet-invariant-registry',
        severity: 'critical',
        status: 'error',
        error: `custom invariant registry/evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        elapsedMs: Date.now() - startedAt,
      },
    ];
  }
}
