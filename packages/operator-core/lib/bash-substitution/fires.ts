/**
 * Per-fire telemetry for the substitution registry
 * (plan `bash-substitution-reachable-ceiling-2026-08-01`, P-003).
 *
 * WHAT WAS MISSING: the registry could say which rows exist and what verdict the
 * audit gave, but not whether a rule had ever fired or whether anyone complied.
 * Every iteration in that plan — the Phase 5 tier promotions, the Phase 6
 * before/after, D-042's auto-substitution — is unmeasurable without it.
 *
 * `false_positive_count` is not a substitute and must not be read as one: it is
 * 0 on every row and is pinned at 0 BY CONSTRUCTION (D-042), because nothing
 * increments it. A counter nobody writes reads exactly like a clean bill of
 * health.
 *
 * TWO SURFACES, deliberately. A hot counter pair on the registry row
 * (`match_count`, `last_fired_at`) is cheap and always current; the append-only
 * `bash_tool_substitution_fires` table is complete but expensive. Neither
 * replaces the other — the counter cannot say WHO fired or whether they
 * complied, and rendering a count from an aggregate over the event table would
 * put a scan on a path that runs once per shell command per agent.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { SubstitutionMatch } from './match';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * The tool whose invocation must never count as compliance: the gate's own.
 *
 * `locks:check_command` is what a PreToolUse hook calls to GET the advisory, so
 * it is very often the firing session's chronologically next tool call. Counting
 * it would measure the hook calling itself, and — because it fires on the same
 * commands the advisory targets — would do so in a way that correlates with the
 * rules being evaluated. Not an edge case: it would be the dominant signal.
 */
export const GATE_TOOL_NAME = 'locks:check_command';

/**
 * `call_origin` value marking an invocation a HOOK emitted rather than the agent
 * chose. Excluded from "the next call" for the same reason as
 * {@link GATE_TOOL_NAME} — and it is the general form of that rule.
 *
 * Naming ONE hook tool was not enough, and could never have been. The advisory
 * fires at PreToolUse of a shell command; that command then runs; the PostToolUse
 * activity-report hook then calls `activity:report`. So a hook row is interposed
 * between the fire and any agent action BY CONSTRUCTION, and the position-1
 * comparison lands on the hook rather than on whatever the agent did next —
 * whether or not the agent complied. Measured 2026-09-05, before this predicate
 * existed: of 71,086 resolved fires exactly 5 recorded `complied = true` (0.007%),
 * and hook-origin rows were 189,576 of 301,133 invocations (63%) in one day.
 *
 * DO NOT cite this exclusion as having EXPLAINED that near-zero — an earlier
 * revision of this comment did, and it was wrong. Recomputing the corrected
 * predicate read-only over 7,599 fires since 2026-09-03: 7,430 had a next
 * agent-chosen call and 6 complied = 0.081%, against 0.007% on the stored
 * column. That is real and it is ~10x — of a ~1000x gap. Hook interposition was
 * a confound ON the instrument, not the cause of the reading.
 *
 * The dominant cause is adoption surface, and it makes most of the volume
 * unmeasurable rather than merely low: every bucket whose named tool has a
 * CLIENT-NATIVE equivalent reads ~0 (`capability:read` and `capability:git`
 * together are 89% of fire volume), because `tool_invocations` records MCP
 * calls ONLY — the native Read/Bash an agent actually reached for leaves no row
 * at all. Absence of a compliant call in this ledger is therefore not evidence
 * of non-compliance for those buckets. See
 * `bash-substitution-reachable-ceiling-2026-08-01#D-076`, which restricts
 * reporting to the MCP-only buckets and records the rest as
 * UNMEASURABLE-BY-CONSTRUCTION rather than as 0% compliance.
 *
 * Filter on the COLUMN, not on a list of tool names: `call_origin = 'hook'` is
 * DECLARED by the emitting hook (`call_origin_source = 'declared'`), whereas
 * 'agent'/'unknown' are derived. A hand-maintained name list is second-copy
 * metadata that rots silently — this one was written when `locks:check_command`
 * was the only hook tool and was never updated as `activity:report` (142,068
 * calls/day, 100% hook-origin) and `coord:glance` (29,627) joined it.
 *
 * `IS DISTINCT FROM` rather than `= 'agent'` on purpose: only 'hook' is
 * authoritative, so an unclassified row stays eligible. Skipping a NULL/'unknown'
 * row would silently advance "the next call" past a real agent action, which
 * biases compliance UPWARD — the direction that flatters the intervention.
 */
export const HOOK_CALL_ORIGIN = 'hook';

/**
 * How long a fire waits before the resolver will judge it.
 *
 * The question is "what did this session do NEXT", so resolving immediately
 * would race the answer into existence — the next call has not happened yet, and
 * a fire judged at t+0 would resolve against whatever the agent happened to be
 * doing concurrently. 60s is comfortably longer than the gap between an agent's
 * consecutive tool calls and far shorter than a session.
 */
export const COMPLIANCE_SETTLE_MS = 60_000;

/**
 * How long the resolver waits before concluding a session made no further call
 * at all. Past this the fire is marked resolved with `complied` left NULL — an
 * explicit "no evidence", never a `false`. See the migration's index comment for
 * why that distinction is load-bearing.
 */
export const COMPLIANCE_ABANDON_MS = 60 * 60_000;

/**
 * Coerce a timestamptz returned by the pooled postgres client to epoch ms.
 *
 * The canonical org pool uses `prepare: false`, so PostgreSQL timestamp columns
 * arrive as wire-format strings there; the direct testcontainer client returns
 * `Date` objects. Comparing the string directly with a `Date` makes JavaScript
 * coerce the string to `NaN`, so the abandonment branch silently never runs.
 */
function timestampMs(value: Date | string): number | null {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Record that these registry rows claimed an atom, and bump their hot counters.
 *
 * BEST EFFORT BY CONTRACT. The caller is `locks:check_command`, whose whole
 * design property is that it is fail-open and strictly additive: an error in the
 * substitution path must never change the lock decision or wedge a gate that
 * every agent's every shell command passes through. So this swallows its own
 * errors and returns how many fires it managed to write. Telemetry that can
 * block a command is worse than no telemetry.
 *
 * Callers should NOT await this on the hot path — see `recordFiresDetached`.
 */
export async function recordSubstitutionFires(opts: {
  workspaceId: string;
  ownerId: string | null;
  matches: SubstitutionMatch[];
  client?: OrgSql;
}): Promise<number> {
  const { workspaceId, ownerId, matches } = opts;
  if (matches.length === 0) return 0;

  try {
    const sql = opts.client ?? getOrgPg().sql;
    let written = 0;

    for (const match of matches) {
      // Joined on (workspace_id, intent_label) — the registry's unique key — so
      // the fire carries the row's real id without the caller having to know it.
      // A match whose row has since been deleted inserts nothing rather than
      // failing: the atom was claimed by a rule that no longer exists, which is
      // not an event worth recording and definitely not one worth throwing over.
      const rows = (await sql`
        INSERT INTO harness_shared.bash_tool_substitution_fires
          (workspace_id, row_id, intent_label, tool_name, session_id, command, tier)
        SELECT ${workspaceId}, s.id, s.intent_label, s.tool_name,
               ${ownerId}, ${match.atom}, ${match.tier}
          FROM harness_shared.bash_tool_substitutions s
         WHERE s.workspace_id = ${workspaceId}
           AND s.intent_label = ${match.intentLabel}
        RETURNING row_id
      `) as Array<{ row_id: string }>;

      if (rows.length === 0) continue;
      written += rows.length;

      await sql`
        UPDATE harness_shared.bash_tool_substitutions
           SET match_count = match_count + 1,
               last_fired_at = now()
         WHERE workspace_id = ${workspaceId}
           AND intent_label = ${match.intentLabel}
      `;
    }

    return written;
  } catch {
    return 0;
  }
}

/**
 * Fire-and-forget wrapper for the hot path.
 *
 * Deliberately not awaited by the gate: the advisory is already computed and the
 * agent is waiting on it, so making them wait on two writes to learn something
 * only we will read is the wrong trade. The rejection handler is required rather
 * than decorative — an unhandled rejection in the operator process is a real
 * crash, and "the telemetry took the operator down" would be a spectacular way
 * to fail at measuring compliance.
 */
export function recordFiresDetached(opts: {
  workspaceId: string;
  ownerId: string | null;
  matches: SubstitutionMatch[];
}): void {
  void recordSubstitutionFires(opts).catch(() => undefined);
}

/** Postgres `undefined_table`. */
const PG_UNDEFINED_TABLE = '42P01';

/**
 * Is this the telemetry tables simply not existing yet?
 *
 * Migration 720 adds an ACCESS EXCLUSIVE-requiring column to
 * `bash_tool_substitutions`, a table every operator process reads on a 30s cache
 * cycle — so it lands during a restart window rather than against a live fleet,
 * and the code ships BEFORE the schema does. That gap is expected and bounded,
 * but a sweep that runs every routines tick must not spend it crying wolf: a
 * warning per tick for a known-pending migration trains the reader to ignore the
 * channel, so the real failure — the one this sweep exists to surface — arrives
 * into a log nobody trusts.
 */
function isMissingTelemetrySchema(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === PG_UNDEFINED_TABLE;
}

export interface ComplianceResolution {
  /** Fires examined this pass. */
  examined: number;
  /** Fires that got a real true/false measurement. */
  measured: number;
  /** Fires closed with `complied` NULL — the session made no further call. */
  noFollowUp: number;
}

/**
 * Resolve `complied` for fires that have settled.
 *
 * Compliance is defined by P-003 as "did that session's next tool call use the
 * named tool". This finds the firing session's chronologically next AGENT-CHOSEN
 * invocation after the fire and compares its tool name.
 *
 * "Agent-chosen" is doing real work here, and both exclusions are load-bearing:
 * {@link GATE_TOOL_NAME} is the hook asking about the very command that fired,
 * and {@link HOOK_CALL_ORIGIN} removes every other hook-emitted row — most
 * importantly the PostToolUse activity-report that necessarily lands between the
 * fire and the agent's next move. Without the second filter the comparison is
 * made against a hook's tool name rather than the agent's, so `complied` can
 * essentially never be true and the metric reads as agent defiance when it is
 * measuring its own instrumentation.
 *
 * Runs as a sweep rather than inline because the answer does not exist at fire
 * time. Idempotent: it only touches rows with `resolved_at IS NULL`.
 */
export async function resolveFireCompliance(opts: {
  workspaceId: string;
  limit?: number;
  client?: OrgSql;
  now?: Date;
}): Promise<ComplianceResolution> {
  const sql = opts.client ?? getOrgPg().sql;
  const now = opts.now ?? new Date();
  const settledBefore = new Date(now.getTime() - COMPLIANCE_SETTLE_MS);
  const abandonedBefore = new Date(now.getTime() - COMPLIANCE_ABANDON_MS);
  const limit = opts.limit ?? 500;

  let pending: Array<{
    id: string;
    session_id: string | null;
    tool_name: string;
    fired_at: Date | string;
  }>;
  try {
    pending = (await sql`
      SELECT id, session_id, tool_name, fired_at
        FROM harness_shared.bash_tool_substitution_fires
       WHERE workspace_id = ${opts.workspaceId}
         AND resolved_at IS NULL
         AND fired_at < ${settledBefore}
       ORDER BY fired_at
       LIMIT ${limit}
    `) as typeof pending;
  } catch (e) {
    // Schema not migrated yet — quietly a no-op, not an alarm. Any OTHER error
    // still propagates to the caller, which is the point: swallowing everything
    // here would hide a genuinely broken resolver behind the same silence.
    if (isMissingTelemetrySchema(e)) return { examined: 0, measured: 0, noFollowUp: 0 };
    throw e;
  }

  let measured = 0;
  let noFollowUp = 0;

  for (const fire of pending) {
    // A fire with no session id can never be resolved — there is nobody whose
    // next call to inspect. Close it as "no evidence" rather than leaving it to
    // be re-scanned forever.
    const next = fire.session_id
      ? ((await sql`
          SELECT tool_name
            FROM harness_shared.tool_invocations
           WHERE coord_owner_id = ${fire.session_id}
             AND invoked_at > ${fire.fired_at}
             AND tool_name <> ${GATE_TOOL_NAME}
             AND call_origin IS DISTINCT FROM ${HOOK_CALL_ORIGIN}
           ORDER BY invoked_at
           LIMIT 1
        `) as Array<{ tool_name: string }>)
      : [];

    if (next.length > 0) {
      const complied = next[0].tool_name === fire.tool_name;
      await sql`
        UPDATE harness_shared.bash_tool_substitution_fires
           SET complied = ${complied}, resolved_at = now()
         WHERE id = ${fire.id}
      `;
      measured += 1;
      continue;
    }

    // No subsequent call yet. Before the abandonment window that is simply "too
    // early to tell" and the fire is left alone; after it, the session is gone
    // and the honest record is resolved-with-no-verdict.
    const firedAtMs = timestampMs(fire.fired_at);
    if (firedAtMs !== null && firedAtMs < abandonedBefore.getTime()) {
      await sql`
        UPDATE harness_shared.bash_tool_substitution_fires
           SET resolved_at = now()
         WHERE id = ${fire.id}
      `;
      noFollowUp += 1;
    }
  }

  return { examined: pending.length, measured, noFollowUp };
}
