/**
 * Is a dispatched release-fixer still alive? (EI-18672078222841101)
 *
 * WHY THIS IS ITS OWN MODULE. This lived in `harness/routines/release-actions.ts`, which
 * calls `registerSystemAction('green-checkpoint', ...)` / `('release-trigger', ...)` at
 * MODULE SCOPE. Importing it registers those system actions as a side effect — fine for the
 * routine host, wrong for a read-side surface like the pipeline snapshot that only wants to
 * report who owns the current red. Splitting the function out (rather than copying it) keeps
 * ONE liveness definition: the renderer that tells agents "someone is on it" and the
 * dispatcher that decides "don't spawn another one" must never be able to disagree.
 */
import type postgres from 'postgres';
import { hostname } from 'node:os';
import { STALE_MS } from '../liveness';
import {
  FIRST_OUTPUT_STALL_MS,
  isSpawnProcessAlive,
  launcherBootId,
  spawnRowKind,
} from '../fleet/spawn-reclaim';

/** The durable escalation phase for a release-fixer that died before its first turn. */
export const RELEASE_FIXER_NO_TURN_PHASE = 'green-checkpoint-release-fixer-no-turn';

/** Keep the legacy task-to-spawn temporal join deliberately narrow. */
const LEGACY_TASK_LINK_SKEW_SEC = 5;
type ReleaseFixerSql = Pick<postgres.Sql, 'unsafe'>;

interface TerminalReleaseFixerEvidence {
  spawnTerminal: boolean;
  taskScopeEnded: boolean;
}

/**
 * Recover the one liveness fact that is safe to derive after the broad liveness query fails.
 *
 * The normal probe intentionally has several joins and host/PID checks, so a transient catalog
 * or connection failure must remain `null` for ordinary rows. A terminal spawned-agent row plus
 * an exact terminal task_ledger scope is different: those two durable rows are the handoff's
 * completion record and are enough to prove that THIS fixer cannot still be running. Keeping this
 * fallback narrow prevents a query failure from turning into a false death while eliminating the
 * false `null` observed during queue retirement (EI-22026318885195355).
 */
async function readTerminalReleaseFixerEvidence(
  sql: ReleaseFixerSql,
  spawnId: string,
): Promise<TerminalReleaseFixerEvidence | null> {
  try {
    const rows = (await sql.unsafe(
      `SELECT EXISTS (
                SELECT 1
                  FROM harness_shared.spawned_agents sa
                 WHERE sa.spawn_id = $1
                   AND sa.status NOT IN ('running','restarting')
              ) AS spawn_terminal,
              EXISTS (
                SELECT 1
                  FROM harness_shared.spawned_agents sa
                  JOIN harness_shared.task_ledger tl
                    ON tl.workspace_id = sa.workspace_id
                   AND tl.class = 'agent-session'
                   AND tl.launched_by = 'orchestrator:release-fixer'
                   AND tl.detail->>'spawnRecordId' = sa.spawn_id
                   AND tl.state NOT IN ('pending','running')
                 WHERE sa.spawn_id = $1
              ) AS task_scope_ended`,
      [spawnId],
    )) as Array<{ spawn_terminal?: boolean; task_scope_ended?: boolean }>;
    const row = rows[0];
    if (!row) return null;
    return {
      spawnTerminal: row.spawn_terminal === true,
      taskScopeEnded: row.task_scope_ended === true,
    };
  } catch {
    return null;
  }
}

/**
 * A launch-blueprint row should reach /invoke admission (PID/session/output/tool pickup)
 * well inside one supervisor heartbeat.  This is deliberately shorter than the generic
 * five-minute first-output allowance: the latter protects a child that is already admitted
 * and starting its model turn, while this guard detects a request that never produced a
 * child at all (EI-21144257978207759).
 */
export const RELEASE_FIXER_LAUNCH_PICKUP_GRACE_MS = 60_000;

export interface ReleaseFixerNoTurnEscalationInput {
  installSlug: string;
  workspaceId: string;
  spawnId: string;
  candidate?: string | null;
  failingTests?: readonly string[] | null;
  errorMessage: string;
  nowMs?: number;
}

/**
 * The classifier's no-turn wording is deliberately shared by all spawn paths. Keep this
 * predicate here too, so the release-fixer escalation does not grow a second parser for
 * invoke-outcome's diagnostics.
 */
export function isReleaseFixerNoTurnFailure(errorMessage: string | null | undefined): boolean {
  return typeof errorMessage === 'string' &&
    /(?:produced no turn|before producing a turn|before (?:the agent|it) produced a turn)/i.test(errorMessage);
}

/**
 * The fire-and-forget fallback gets one local retry only for an unclassified
 * launcher/host death. Capacity sheds already have their own gateway retry
 * semantics, while auth/quota/context failures need their underlying cause
 * fixed before another launch can help.
 */
export function isRetryableReleaseFixerNoTurnFailure(errorMessage: string | null | undefined): boolean {
  return isReleaseFixerNoTurnFailure(errorMessage) && /^\s*infra_loss\s*:/i.test(errorMessage ?? '');
}

/** Pure, bounded payload for the existing `harness_escalations` surface. */
export function releaseFixerNoTurnEscalationBody(opts: ReleaseFixerNoTurnEscalationInput): string {
  const candidate = typeof opts.candidate === 'string' ? opts.candidate.slice(0, 12) : null;
  const failingTests = (opts.failingTests ?? []).filter((test): test is string => typeof test === 'string').slice(0, 20);
  const errorMessage = opts.errorMessage.slice(-1600);
  const timedOut = /timedOut=true|timed out before/i.test(opts.errorMessage);
  return JSON.stringify({
    kind: 'release-fixer-no-turn',
    harness_slug: opts.installSlug,
    workspace_id: opts.workspaceId,
    spawnId: opts.spawnId,
    candidate,
    failingTests,
    timedOut,
    emitted_at: opts.nowMs ?? Date.now(),
    detail:
      `release-fixer ${opts.spawnId} produced no turn${timedOut ? ' before the invoke timeout expired' : ''}; ` +
      `the release gate remains red and this launch did not provide a diagnosis. Inspect the launcher ` +
      `termination record plus account/gateway telemetry, then allow the liveness-aware dispatcher to ` +
      `send a fresh fixer after the cause is understood.`,
    errorMessage,
  });
}

/**
 * Persist a no-turn escalation idempotently on the existing escalation table. Returns true
 * only when this call opened a previously-clear row; callers can use that edge for a single
 * log/notification without turning repeated retries into an alert storm.
 */
export async function recordReleaseFixerNoTurnEscalation(
  sql: postgres.Sql,
  opts: ReleaseFixerNoTurnEscalationInput,
): Promise<boolean> {
  try {
    const prior = (await sql<Array<{ escalation?: string | null }>>`
      SELECT escalation FROM harness_shared.harness_escalations
        WHERE harness_slug = ${opts.installSlug} AND phase = ${RELEASE_FIXER_NO_TURN_PHASE}
        LIMIT 1
    `) as Array<{ escalation?: string | null }>;
    await sql`
      INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
      VALUES (${opts.installSlug}, ${RELEASE_FIXER_NO_TURN_PHASE}, ${releaseFixerNoTurnEscalationBody(opts)}, ${opts.nowMs ?? Date.now()}, ${opts.workspaceId})
      ON CONFLICT (harness_slug, phase)
      DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms
    `;
    return !prior[0]?.escalation;
  } catch (error) {
    // A diagnostic escalation must never turn a failed fixer into a second workflow failure.
    console.warn(
      `[release-fixer] no-turn escalation write failed (${opts.installSlug}/${opts.spawnId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Is the recorded release-fixer spawn still ALIVE? Prefer the task-manager's
 * named-scope row when present: `systemd-run --scope` can finish its client while
 * the real agent payload keeps running, and the task reconciler is the authority
 * that follows that handoff (WI-37509 / EI-21065737245117808). Otherwise retain
 * the existing `running`/`restarting` + fresh-heartbeat/PID rules.
 * Returns `null` when there's no spawn id to check (a DBOS-durable fire / legacy
 * record), which the decision treats as "presumed covered". Fail-soft: a query
 * error returns null (presumed covered) rather than hammering a re-dispatch.
 *
 * EI-21019097008328015: a settled task_ledger row for THIS exact spawn id
 * (`detail->>'spawnRecordId'`) outranks the raw pid check too — not just a LIVE
 * one. Every agent-role spawn on this host (bees, system routines, and
 * release-fixers alike) launches through the identical `invoke-once` binary, so
 * `isSpawnProcessAlive`'s cmdline substring check only proves "some invoke-once
 * process is running at this pid", never that it is THIS spawn's own process.
 * Once a spawn's own recorded child exits, the kernel can — and on a busy fleet
 * routinely does — reassign that exact pid to an unrelated invoke-once-launched
 * process (a bee, or the very green-checkpoint routine that dispatched this
 * fixer) within the ~10-minute heartbeat grace window below, and that unrelated
 * process reads as "alive" purely because it also matches 'invoke-once'. The
 * task_ledger row is keyed on the exact spawn id, so it never aliases a
 * different process: once it settles terminal, THIS spawn's own tracked process
 * is confirmed gone, and no pid reading (which may now name someone else's
 * still-running process) may override that.
 *
 * EI-21078838719843567: older task-manager rows have neither spawnRecordId nor
 * spawnId in detail. For those rows, use exactly one release-fixer
 * agent-session task with a validated `pc-*.scope` and a started_at close to
 * the spawn row. A fresh live row preserves coverage; a terminal/stale row
 * proves the legacy task is gone, while multiple candidates are ambiguous and
 * therefore fail closed to null.
 */
export async function releaseFixerSpawnAlive(
  sql: ReleaseFixerSql,
  spawnId: string | null | undefined,
): Promise<boolean | null> {
  if (!spawnId) return null;
  const graceSec = Math.max(1, Math.round(STALE_MS / 1000));
  const preTurnGraceSec = Math.max(1, Math.round(FIRST_OUTPUT_STALL_MS / 1000));
  const launchPickupGraceSec = Math.max(1, Math.round(RELEASE_FIXER_LAUNCH_PICKUP_GRACE_MS / 1000));
  try {
    const rows = (await sql.unsafe(
      `SELECT sa.launcher_host, sa.launcher_boot_id, sa.pid, sa.run_id,
              (sa.status IN ('running','restarting')
                AND sa.heartbeat_at IS NOT NULL
                AND (now() - sa.heartbeat_at) < make_interval(secs => $2)) AS spawn_lease_live,
              EXISTS (
                SELECT 1
                  FROM harness_shared.task_ledger tl
                 WHERE tl.workspace_id = sa.workspace_id
                   AND tl.class = 'agent-session'
                   AND tl.launched_by = 'orchestrator:release-fixer'
                   AND tl.state IN ('pending','running')
                   AND tl.detail->>'spawnRecordId' = sa.spawn_id
                   AND tl.last_seen_at IS NOT NULL
                   AND (now() - tl.last_seen_at) < make_interval(secs => $2)
              ) AS live_task_scope,
              EXISTS (
                SELECT 1
                  FROM harness_shared.task_ledger tl
                 WHERE tl.workspace_id = sa.workspace_id
                   AND tl.class = 'agent-session'
                   AND tl.launched_by = 'orchestrator:release-fixer'
                   AND tl.state NOT IN ('pending','running')
                   AND tl.detail->>'spawnRecordId' = sa.spawn_id
              ) AS task_scope_ended
              ,(
                sa.status NOT IN ('running','restarting')
                AND EXISTS (
                  SELECT 1
                    FROM harness_shared.task_ledger tl
                   WHERE tl.workspace_id = sa.workspace_id
                     AND tl.class = 'agent-session'
                     AND tl.launched_by = 'orchestrator:release-fixer'
                     AND tl.state NOT IN ('pending','running')
                     AND tl.detail->>'spawnRecordId' = sa.spawn_id
                )
              ) AS terminal_fixer_evidence
              ,(
                (
                  sa.status IN ('running','restarting')
                  AND sa.started_at >= now() - make_interval(secs => $4)
                )
                OR sa.last_output_at IS NOT NULL
                OR EXISTS (
                  SELECT 1
                    FROM harness_shared.tool_invocations ti
                   WHERE ti.workspace_id = sa.workspace_id
                     AND ti.spawn_id = sa.spawn_id
                )
              ) AS task_scope_progress_eligible
              ,(
                sa.started_at >= now() - ($5::double precision * interval '1 second')
                OR sa.pid IS NOT NULL
                OR sa.session_id IS NOT NULL
                OR sa.last_output_at IS NOT NULL
                OR EXISTS (
                  SELECT 1
                    FROM harness_shared.tool_invocations ti
                   WHERE ti.workspace_id = sa.workspace_id
                     AND ti.spawn_id = sa.spawn_id
                )
              ) AS launch_pickup_eligible
              ,legacy_task.candidate_count AS legacy_task_candidate_count,
              legacy_task.live AS legacy_task_live
         FROM harness_shared.spawned_agents sa
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS candidate_count,
                  CASE
                    WHEN COUNT(*) = 1 THEN bool_or(
                      tl.state IN ('pending','running')
                      AND tl.last_seen_at IS NOT NULL
                      AND (now() - tl.last_seen_at) < make_interval(secs => $2)
                    )
                    ELSE NULL
                  END AS live
             FROM harness_shared.task_ledger tl
            WHERE tl.workspace_id = sa.workspace_id
              AND tl.class = 'agent-session'
              AND tl.launched_by = 'orchestrator:release-fixer'
              AND tl.detail->>'spawnRecordId' IS NULL
              AND tl.detail->>'spawnId' IS NULL
              AND tl.scope_unit ~ '^pc-[^.]+\\.scope$'
              AND abs(EXTRACT(EPOCH FROM (tl.started_at - sa.started_at))) <= $3
         ) AS legacy_task ON TRUE
        WHERE sa.spawn_id = $1
        LIMIT 1`,
      [spawnId, graceSec, LEGACY_TASK_LINK_SKEW_SEC, preTurnGraceSec, launchPickupGraceSec],
    )) as Array<{
      launcher_host?: string | null;
      launcher_boot_id?: string | null;
      pid?: number | string | null;
      run_id?: string | null;
      spawn_lease_live?: boolean;
      live_task_scope?: boolean;
      task_scope_ended?: boolean;
      terminal_fixer_evidence?: boolean;
      task_scope_progress_eligible?: boolean;
      launch_pickup_eligible?: boolean;
      legacy_task_candidate_count?: number | string;
      legacy_task_live?: boolean | null;
    }>;
    const row = rows[0];
    if (!row) return false;

    // The named scope owns the real payload after systemd-run's client handoff, but
    // its task_ledger heartbeat proves only that the cgroup exists. Before the
    // first-output grace expires that is enough to cover normal CLI startup, but
    // only while the launch row remains active. A terminal/reclaimed launch must
    // provide concrete child output or a tool call from this exact spawn to remain
    // covered; otherwise an idle Node/Claude/socat scope can mask a failed
    // pre-turn spawn forever and prevent the serialized repair queue from advancing
    // (WI-40422 / EI-21135879707775738).
    // EI-21019097008328015: the task reconciler already proved THIS spawn's own
    // process ended. That is decisive even though the spawn row itself still
    // reads `running` with a fresh heartbeat (a `loopbackFetch` heartbeat that
    // was never refreshed after the fixer died at launch stays inside the grace
    // window below) — a pid-reuse false-alive can only mislead the checks that
    // follow, never this one, because it is keyed on the exact spawn id.
    // A terminal launch and its exact task scope are durable completion evidence. Evaluate this
    // before any PID/heartbeat fallback so a reused PID or stale heartbeat cannot resurrect a
    // fixer that the task reconciler has already closed.
    if (row.terminal_fixer_evidence || row.task_scope_ended) return false;

    const taskScopeProgressEligible = row.task_scope_progress_eligible === true;
    if (row.live_task_scope && taskScopeProgressEligible) return true;

    // Legacy task-manager rows have no spawn id in detail. A single matching
    // scope/time candidate is safe to use; no candidate means this fallback is
    // inapplicable, while multiple candidates must not guess which fixer owns
    // the spawn.
    const legacyCandidateCount = Number(row.legacy_task_candidate_count ?? 0);
    if (legacyCandidateCount > 1) return null;
    if (legacyCandidateCount === 1) {
      if (row.legacy_task_live !== true) return false;
      if (taskScopeProgressEligible) return true;
      // A heartbeat-only legacy scope beyond the pre-turn grace does not outrank
      // the exact spawn lease. Fall through so a failed/stale spawn returns false.
    }

    if (!row.spawn_lease_live) return false;

    // EI-21144257978207759: a launch heartbeat proves only that the process which
    // issued the HTTP request is/was alive.  Past one heartbeat cadence it is not
    // evidence that /invoke ever admitted a child.  Require an admission/pickup
    // signal before calling a null-session/null-PID/null-output row owned-live.
    if (row.launch_pickup_eligible !== true) return false;

    // A PID is only meaningful within the launcher boot that recorded it. A
    // same-host row from an earlier boot is provably orphaned even when its
    // heartbeat was refreshed before the host noticed the restart; treating the
    // heartbeat as proof here is exactly how release:trace rendered a dead
    // release-fixer as owned-live (EI-20984152070842112).
    const localHost = hostname();
    const sameHost = row.launcher_host === localHost;
    if (sameHost && row.launcher_boot_id && row.launcher_boot_id !== launcherBootId()) return false;

    // For a same-host row with recorded process ownership, use the existing
    // row-kind-aware PID probe: launch-* means the pre-handoff firing process;
    // invoke-launch-* means the admitted invoke-once child. Missing PIDs retain
    // the heartbeat fallback only during the bounded pickup grace (or when another
    // concrete pickup signal above proves admission).
    if (sameHost && row.pid != null) {
      const pid = Number(row.pid);
      const kind = spawnRowKind({ spawnId, runId: row.run_id ?? null, pid });
      return isSpawnProcessAlive(pid, kind);
    }
    return true;
  } catch {
    // A transient failure in the broad probe used to oscillate a terminal fixer between false and
    // null. Re-read only the durable terminal pair: if it is present, false is still provable;
    // otherwise preserve the fail-closed unknown result for all less-conclusive shapes.
    const terminal = await readTerminalReleaseFixerEvidence(sql, spawnId);
    return terminal?.spawnTerminal === true && terminal.taskScopeEnded === true ? false : null;
  }
}

/** P-005: classification of a DEAD release-fixer spawn for attempt-refund purposes. */
export interface DeadReleaseFixerClassification {
  /**
   * True when the fixer provably never did any repair work — zero tool invocations
   * recorded for the spawn (an agent that attempted repair makes tool calls), or no
   * spawn row at all (the launch was never even recorded). These are the free-retry
   * classes P-005 names: spawn failures, provider-capacity rejections, permission
   * faults, first-turn guillotine kills.
   */
  infrastructure: boolean;
  /** Bounded human-readable evidence for the gate log / alarm. */
  reason: string;
}

/**
 * P-005: classify a release-fixer spawn that liveness already judged DEAD. The decisive
 * predicate is ZERO recorded tool invocations for the spawn id — evidence-based (the same
 * `tool_invocations` join `releaseFixerSpawnAlive` uses for progress eligibility), covering
 * every named infrastructure class at once without a fragile error-message taxonomy. The
 * spawn row's terminal status/error only ENRICH the reason string. Fail-CLOSED: any query
 * error returns null and the caller must treat the death as a normally-burned attempt —
 * a refund must never be granted on missing evidence.
 */
export async function classifyDeadReleaseFixerSpawn(
  sql: postgres.Sql,
  spawnId: string | null | undefined,
): Promise<DeadReleaseFixerClassification | null> {
  if (!spawnId) return null;
  try {
    const rows = (await sql.unsafe(
      // `error_message` is the real column on harness_shared.spawned_agents. This read
      // said `sa.error` for its whole life, which Postgres rejects with 42703 — and the
      // fail-closed catch below turned that into `null`, i.e. "no evidence, burn the
      // attempt". So P-005's refund could NEVER be granted in production: every
      // unproductive infrastructure death (provider usage-wall, spawn failure, permission
      // fault) burned a real attempt and marched the queue to hold-exhausted. The unit
      // tests could not see it because a stubbed `sql` never validates a column name;
      // fixer-liveness.integration.test.ts now runs this exact statement against the
      // migrated schema.
      `SELECT sa.status, sa.error_message AS error,
              EXISTS (
                SELECT 1
                  FROM harness_shared.tool_invocations ti
                 WHERE ti.workspace_id = sa.workspace_id
                   AND ti.spawn_id = sa.spawn_id
              ) AS worked
         FROM harness_shared.spawned_agents sa
        WHERE sa.spawn_id = $1
        LIMIT 1`,
      [spawnId],
    )) as Array<{ status?: string | null; error?: string | null; worked?: boolean }>;
    const row = rows[0];
    if (!row) {
      return {
        infrastructure: true,
        reason: 'no spawned_agents row — the launch was never recorded, so no repair work can have happened',
      };
    }
    if (row.worked === true) {
      return {
        infrastructure: false,
        reason: `spawn made tool calls before dying (status=${row.status ?? 'unknown'}) — a real repair attempt`,
      };
    }
    const errorTail = typeof row.error === 'string' && row.error.length > 0 ? ` error: ${row.error.slice(-200)}` : '';
    return {
      infrastructure: true,
      reason: `zero tool invocations recorded (status=${row.status ?? 'unknown'}${errorTail}) — died before doing any repair work`,
    };
  } catch {
    return null; // fail-closed: no refund without evidence
  }
}
