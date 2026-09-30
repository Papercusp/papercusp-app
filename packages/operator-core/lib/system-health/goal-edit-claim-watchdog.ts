/**
 * goal-edit-claim-watchdog (EI-20581177540737568 half 2; P-008 of
 * goal-mode-design-intent-hardening-2026-08-16) — alert on the FIRST edit-claim by a
 * goal-mode owner, in near-real time.
 *
 * THE BUG THIS CLOSES, measured (WI-39348, 2026-08-16): a grader rated the run's
 * `never-implements` criterion exemplary — CORRECT at that moment — and the subject's
 * first edit landed 28 minutes later. A grader SAMPLING a run always loses to a
 * violation between samples; `never-implements` is monotonic-downward (one edit
 * falsifies it permanently), so only a continuous instrument can hold the line.
 *
 * THE INSTRUMENT IS DETERMINISTIC: every Edit/Write in an agent session acquires a
 * file lock, and the grant writes a `harness_shared.edit_attribution_ledger` row
 * (agent_id NOT NULL). A ledger row whose agent is a goal-mode owner IS an edit-claim
 * — no prose, no self-report. Sessions in scope: `agent_modes` rows with mode='goal'
 * whose subject names an ACTIVE goal (a lingering mode row after goal closure does
 * not alarm).
 *
 * ON VIOLATION the watchdog REPORTS + INJECTS, never blocks (D-001 assigns hard
 * blocking to the enforcement sibling EI-20581099901890760; this one keeps the
 * GRADING loop honest):
 *  - escalation of record (openEscalation, PG-dedup'd per owner+goal — "first
 *    edit-claim" alarms once, repeats coalesce);
 *  - `goal:edit-claim:<goalId>` awaited event — a grader parks on it (events:await)
 *    so the violation wakes the grading, instead of waiting to be sampled;
 *  - directed WAKES for the subject and every grade-mode session in the workspace
 *    (wakeRecipients, fail-soft) — the woken turn folds the open escalation in, which
 *    is the "coord-inject both the subject and its grader" the design note requires.
 *
 * SWEEP MECHANICS. Steady-state reads are keyed on the ledger's PRIMARY KEY
 * (`id > high-water-mark`), so a tick costs an index range over only the rows written
 * since the last tick — which is what lets the interval sit at seconds, not minutes.
 * The first sweep of a process has no high-water mark and uses a bounded ts-window
 * lookback instead, so violations during a restart gap are not silently skipped.
 *
 * THE CONSERVATIVE RULE, inherited from the goal watchdog family: a degraded read
 * suppresses, never false-alarms — and every side effect is per-alert contained.
 *
 * Runtime gate: FLAGS.GOAL_EDIT_CLAIM_WATCHDOG (default ON; kill-switch at
 * /admin/features), checked per tick like its siblings.
 */
import type { Sql } from 'postgres';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

/** Near-real-time: the 28-minute measured staleness gap closes to ≤~2 min. The
 *  steady-state query is a pkey range scan over rows written since the last tick,
 *  so the short interval is cheap by construction. */
export const GOAL_EDIT_CLAIM_SWEEP_INTERVAL_MS = 90_000;

/** First sweep of a process: how far back the ts-window lookback reaches. Covers a
 *  restart gap without rescanning history — an edit-claim older than this was either
 *  already alarmed (escalation dedup makes re-alarming idempotent anyway) or predates
 *  the watchdog entirely. */
export const GOAL_EDIT_CLAIM_BOOT_LOOKBACK_MS = 15 * 60_000;

/** Per-sweep row cap — bounds one tick's work; the next tick continues from the
 *  advanced high-water mark, so a burst is drained across ticks, never dropped. */
export const GOAL_EDIT_CLAIM_SWEEP_ROW_CAP = 500;

/** How many claimed files an alert names inline (the rest are counted). */
const ALERT_FILE_SAMPLE = 5;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'goal-edit-claim-watchdog',
  ownerLabel: 'system · goal edit claims',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One edit-attribution ledger row by a goal-mode owner, reduced to this verdict's needs. */
export interface EditClaimRowLike {
  ledgerId: number;
  /** The editing session (edit_attribution_ledger.agent_id = the ownerId the lock
   *  hook stamped). */
  agentId: string;
  workspaceId: string;
  /** The ACTIVE goal the owner's goal-mode registration names (agent_modes.subject). */
  goalId: string;
  file: string;
  repo: string | null;
  tsMs: number;
}

/** One alert: a goal-mode owner claimed edits. Grouped per (workspace, goal, owner). */
export interface GoalEditClaimAlert {
  workspaceId: string;
  goalId: string;
  agentId: string;
  /** First-observed claim in this batch (ms epoch) — "the moment of violation". */
  firstTsMs: number;
  /** Total claims in this batch. */
  claimCount: number;
  /** Up to {@link ALERT_FILE_SAMPLE} distinct claimed files (dedup'd, first-seen order). */
  files: string[];
  /** The newest ledger id folded into this alert (diagnostic drill-back key). */
  maxLedgerId: number;
}

/**
 * PURE: group a batch of edit-claim rows into one alert per (workspace, goal, owner).
 * Rows arrive ledger-ordered (id ASC), so first-seen order is claim order.
 */
export function groupEditClaims(rows: readonly EditClaimRowLike[]): GoalEditClaimAlert[] {
  const byKey = new Map<string, GoalEditClaimAlert & { fileSet: Set<string> }>();
  for (const row of rows) {
    const key = `${row.workspaceId}:${row.goalId}:${row.agentId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        workspaceId: row.workspaceId,
        goalId: row.goalId,
        agentId: row.agentId,
        firstTsMs: row.tsMs,
        claimCount: 1,
        files: [row.file],
        maxLedgerId: row.ledgerId,
        fileSet: new Set([row.file]),
      });
      continue;
    }
    existing.claimCount += 1;
    existing.firstTsMs = Math.min(existing.firstTsMs, row.tsMs);
    existing.maxLedgerId = Math.max(existing.maxLedgerId, row.ledgerId);
    if (!existing.fileSet.has(row.file) && existing.files.length < ALERT_FILE_SAMPLE) {
      existing.fileSet.add(row.file);
      existing.files.push(row.file);
    }
  }
  return [...byKey.values()].map(({ fileSet: _fileSet, ...alert }) => alert);
}

export interface GoalEditClaimSweepDeps {
  /** New edit-claims by goal-mode owners. `sinceLedgerId === null` = the boot sweep
   *  (ts-window lookback); a number = the pkey range scan. Also returns the ledger's
   *  CURRENT max id so the high-water mark advances even on a claim-free tick (the
   *  sweep, not the reader, decides how far — see advanceHighWaterMark). */
  readNewEditClaims: (
    sinceLedgerId: number | null,
  ) => Promise<{ rows: EditClaimRowLike[]; ledgerMaxId: number }>;
  /** ownerIds of grade-mode sessions per workspace (the graders to inject). */
  resolveGraders: (workspaceIds: string[]) => Promise<Map<string, string[]>>;
  escalate: (alert: GoalEditClaimAlert) => Promise<void>;
  /** Directed wake of subject + graders — fail-soft, like every wake fan. */
  notify: (alert: GoalEditClaimAlert, graders: string[]) => Promise<void>;
  /** Emit goal:edit-claim:<goalId> so parked waiters (graders) fire immediately. */
  emitEditClaim: (alert: GoalEditClaimAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_EDIT_CLAIM_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

function makeReadNewEditClaims(sql: Sql): GoalEditClaimSweepDeps['readNewEditClaims'] {
  return async (sinceLedgerId) => {
    // The join is the instrument: a ledger row (agent_id = the lock hook's stamped
    // ownerId) by an owner whose goal-mode registration names an ACTIVE goal. A
    // format mismatch between the two identity columns degrades to zero rows —
    // silence, never a false alarm (the conservative rule).
    const rows =
      sinceLedgerId === null
        ? await sql<
            { id: string; agent_id: string; workspace_id: string; goal_id: string; file: string; repo: string | null; ts_ms: string }[]
          >`
      SELECT l.id, l.agent_id, m.workspace_id, m.subject AS goal_id, l.file, l.repo,
             (extract(epoch FROM l.ts) * 1000)::bigint AS ts_ms
        FROM harness_shared.edit_attribution_ledger l
        JOIN harness_shared.agent_modes m
          ON m.owner_id = l.agent_id AND m.mode = 'goal' AND m.subject IS NOT NULL
        JOIN harness_shared.goals g
          ON g.id = m.subject AND g.workspace_id = m.workspace_id AND g.status = 'active'
       WHERE l.ts > now() - make_interval(secs => ${GOAL_EDIT_CLAIM_BOOT_LOOKBACK_MS / 1000})
       ORDER BY l.id ASC
       LIMIT ${GOAL_EDIT_CLAIM_SWEEP_ROW_CAP}`
        : await sql<
            { id: string; agent_id: string; workspace_id: string; goal_id: string; file: string; repo: string | null; ts_ms: string }[]
          >`
      SELECT l.id, l.agent_id, m.workspace_id, m.subject AS goal_id, l.file, l.repo,
             (extract(epoch FROM l.ts) * 1000)::bigint AS ts_ms
        FROM harness_shared.edit_attribution_ledger l
        JOIN harness_shared.agent_modes m
          ON m.owner_id = l.agent_id AND m.mode = 'goal' AND m.subject IS NOT NULL
        JOIN harness_shared.goals g
          ON g.id = m.subject AND g.workspace_id = m.workspace_id AND g.status = 'active'
       WHERE l.id > ${sinceLedgerId}
       ORDER BY l.id ASC
       LIMIT ${GOAL_EDIT_CLAIM_SWEEP_ROW_CAP}`;
    const [{ max_id }] = await sql<{ max_id: string }[]>`
      SELECT COALESCE(max(id), 0)::bigint AS max_id FROM harness_shared.edit_attribution_ledger`;
    return {
      rows: rows.map((r) => ({
        ledgerId: Number(r.id),
        agentId: r.agent_id,
        workspaceId: r.workspace_id,
        goalId: r.goal_id,
        file: r.file,
        repo: r.repo,
        tsMs: Number(r.ts_ms),
      })),
      ledgerMaxId: Number(max_id),
    };
  };
}

/**
 * PURE: where the next sweep resumes. A capped batch must NOT advance past its own
 * tail — the next tick continues draining the overflow instead of skipping it; an
 * uncapped batch advances to the ledger's current max so a claim-free tick still
 * moves forward. Exported for tests.
 */
export function advanceHighWaterMark(
  rows: readonly EditClaimRowLike[],
  ledgerMaxId: number,
  rowCap: number = GOAL_EDIT_CLAIM_SWEEP_ROW_CAP,
): number {
  if (rows.length >= rowCap) return rows[rows.length - 1].ledgerId;
  return ledgerMaxId;
}

function makeResolveGraders(sql: Sql): GoalEditClaimSweepDeps['resolveGraders'] {
  return async (workspaceIds) => {
    const out = new Map<string, string[]>();
    if (workspaceIds.length === 0) return out;
    const rows = await sql<{ workspace_id: string; owner_id: string }[]>`
      SELECT DISTINCT workspace_id, owner_id
        FROM harness_shared.agent_modes
       WHERE mode = 'grade' AND workspace_id IN ${sql(workspaceIds)}`;
    for (const r of rows) {
      const list = out.get(r.workspace_id) ?? [];
      list.push(r.owner_id);
      out.set(r.workspace_id, list);
    }
    return out;
  };
}

async function defaultEscalate(alert: GoalEditClaimAlert): Promise<void> {
  const fileList = alert.files.join(', ');
  const more = alert.claimCount > alert.files.length ? ` (+${alert.claimCount - alert.files.length} more claims)` : '';
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal-mode owner ${alert.agentId} claimed an EDIT (${alert.files[0]}) — ` +
      `never-implements is falsified for goal '${alert.goalId}'`,
    body:
      `Session ${alert.agentId}, registered in GOAL mode on goal '${alert.goalId}' ` +
      `(workspace ${alert.workspaceId}), acquired edit lock(s) at ` +
      `${new Date(alert.firstTsMs).toISOString()}: ${fileList}${more}.\n\n` +
      `The GOAL contract's never-implements clause is MONOTONIC-DOWNWARD: one edit-claim ` +
      `falsifies it permanently — no later virtue restores it (EI-20581177540737568; the ` +
      `measured failure was a grade that went stale 28 minutes after an honest interim ` +
      `'exemplary'). This alert is the deterministic instrument: an ` +
      `edit_attribution_ledger row by a goal-mode owner, not prose.\n\n` +
      `Remedies:\n` +
      `  • Subject (${alert.agentId}): stop editing; file the work instead ` +
      `(work_items:create) so the goal's drain lane executes it.\n` +
      `  • Grader: any interim rating of never-implements (or another violatable ` +
      `criterion) for this run is now stale — re-evaluate before the card is treated as ` +
      `final. Provisional cards (scorecards:emit without terminal:true) already do not ` +
      `count toward the trend.\n\n` +
      `Reported + injected (wakes + goal:edit-claim event), never auto-blocked: hard ` +
      `enforcement is EI-20581099901890760's lane; keeping the grading honest is this one's.`,
    meta: {
      dedupKind: 'goal-edit-claim',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}:${alert.agentId}`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      subjectAgentId: alert.agentId,
      files: alert.files,
      claimCount: alert.claimCount,
      firstClaimAt: new Date(alert.firstTsMs).toISOString(),
      maxLedgerId: alert.maxLedgerId,
    },
  });
}

async function defaultNotify(alert: GoalEditClaimAlert, graders: string[]): Promise<void> {
  const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
  const recipients = [...new Set([alert.agentId, ...graders])];
  await wakeRecipients(recipients, {
    summary:
      `goal-edit-claim: goal-mode owner ${alert.agentId} claimed edit(s) on goal ` +
      `'${alert.goalId}' (${alert.files[0]}${alert.claimCount > 1 ? `, +${alert.claimCount - 1}` : ''}) — ` +
      `never-implements falsified; graders must re-evaluate violatable interim ratings`,
    payload: {
      goalId: alert.goalId,
      agentId: alert.agentId,
      files: alert.files,
      claimCount: alert.claimCount,
      firstClaimAt: new Date(alert.firstTsMs).toISOString(),
    },
    source: 'goal-edit-claim-watchdog',
    workspaceId: alert.workspaceId,
  });
}

async function defaultEmitEditClaim(alert: GoalEditClaimAlert): Promise<void> {
  const { emitAwaitedEvent } = await import('../events/await/engine');
  await emitAwaitedEvent({
    key: `goal:edit-claim:${alert.goalId}`,
    workspaceId: alert.workspaceId,
    source: 'goal-edit-claim-watchdog',
    payload: {
      goalId: alert.goalId,
      agentId: alert.agentId,
      files: alert.files,
      claimCount: alert.claimCount,
      firstClaimAt: new Date(alert.firstTsMs).toISOString(),
    },
  });
}

function sweepDeps(sql: Sql, overrides: Partial<GoalEditClaimSweepDeps>): GoalEditClaimSweepDeps {
  return {
    readNewEditClaims: makeReadNewEditClaims(sql),
    resolveGraders: makeResolveGraders(sql),
    escalate: defaultEscalate,
    notify: defaultNotify,
    emitEditClaim: defaultEmitEditClaim,
    flagEnabled: defaultFlagEnabled,
    ...overrides,
  };
}

/**
 * One sweep. Returns the advanced high-water mark; failures are contained per-alert
 * (escalation-side dedup makes the next tick's retry idempotent). Exported for tests.
 */
export async function runGoalEditClaimSweepOnce(
  sql: Sql,
  sinceLedgerId: number | null,
  overrides: Partial<GoalEditClaimSweepDeps> = {},
): Promise<{ scanned: number; alerted: number; skipped: boolean; nextSinceLedgerId: number | null }> {
  const deps = sweepDeps(sql, overrides);
  if (!(await deps.flagEnabled())) {
    return { scanned: 0, alerted: 0, skipped: true, nextSinceLedgerId: sinceLedgerId };
  }

  const { rows, ledgerMaxId } = await deps.readNewEditClaims(sinceLedgerId);
  const nextSinceLedgerId = advanceHighWaterMark(rows, ledgerMaxId);
  const alerts = groupEditClaims(rows);
  let alerted = 0;
  const graderMap =
    alerts.length > 0
      ? await deps.resolveGraders([...new Set(alerts.map((a) => a.workspaceId))]).catch(
          // Grader resolution degrading must not suppress the alert itself — the
          // subject wake + escalation still carry it; graders catch up via the event.
          () => new Map<string, string[]>(),
        )
      : new Map<string, string[]>();
  for (const alert of alerts) {
    try {
      await deps.escalate(alert);
      alerted += 1;
    } catch (e) {
      console.warn(
        `[goal-edit-claim-watchdog] escalate failed for ${alert.goalId}/${alert.agentId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      await deps.notify(alert, graderMap.get(alert.workspaceId) ?? []);
    } catch (e) {
      console.warn(
        `[goal-edit-claim-watchdog] notify failed for ${alert.goalId}/${alert.agentId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      await deps.emitEditClaim(alert);
    } catch (e) {
      console.warn(
        `[goal-edit-claim-watchdog] event emit failed for ${alert.goalId}/${alert.agentId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { scanned: rows.length, alerted, skipped: false, nextSinceLedgerId };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the goal edit-claim watchdog: a recurring process-level sweep. Idempotent.
 * Runtime gate: FLAGS.GOAL_EDIT_CLAIM_WATCHDOG (checked per tick).
 */
export function startGoalEditClaimWatchdog(sql: Sql, opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? GOAL_EDIT_CLAIM_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  // High-water mark lives in the start closure: null = boot sweep (ts lookback);
  // afterwards the pkey range scan carries it forward. A flag-skipped tick keeps it
  // unchanged, so re-enabling the flag resumes from where the last real sweep ended.
  let sinceLedgerId: number | null = null;
  watchdogTimer = managedSetInterval(
    'goal-edit-claim-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runGoalEditClaimSweepOnce(sql, sinceLedgerId)
        .then((r) => {
          sinceLedgerId = r.nextSinceLedgerId;
        })
        .catch((e) => {
          console.warn(
            `[goal-edit-claim-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // 'timeout-reaper' like its goal-watchdog siblings: the ledger write emits no
    // event this watchdog can subscribe to, so a timed sweep over the new-row range
    // is the trigger available. The pkey-range read is what keeps it cheap.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}
