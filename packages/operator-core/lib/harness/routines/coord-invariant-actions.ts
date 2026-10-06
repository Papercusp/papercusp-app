/**
 * coord-invariant-actions.ts — Layer D of coord-system-e2e-testing-2026-06-10:
 * the live fleet's coordination-substrate watchers (P-012 + P-013). This module
 * is the ONE home for substrate monitor routines — the shared-hive-loop plan's
 * P-012/P-013 monitor family (double-completion detector, convergence-lag
 * probe, outbox depth, orphaned-lease sweep) plugs in here as further checks
 * rather than growing a second framework.
 *
 *   - `system:coord-probe-canary` (P-012, every 15 min): two synthetic probe
 *     identities run the live verb cycle — baseline → ping → inbox → ack →
 *     file-lock acquire → contend-busy → release → contender wins — through the
 *     REAL host adapters (sendMessage/readInbox/appendAck, tryAcquire/tryRelease
 *     over the live su-lock store). The leading `baseline` step is a control
 *     DB round-trip (SELECT 1) that touches neither the coord writer nor its
 *     notification triggers. This is a reference measurement, not a cause
 *     isolator: the ping timer covers sendMessage, and the ack timer covers
 *     appendAck plus readback. Reports preserve these measured boundaries without
 *     attributing their latency to a specific database or notification layer.
 *     Per-step latency + a 30s total-cycle SLO (EI-401 owner ruling: a 10s SLO
 *     false-alarmed on transient shared-box peak-load write spikes). A failed
 *     step or a coord-attributed SLO breach files a forensics-laden improvement
 *     (coord-log + lock-table rows) through the watchdog capture core (deduped,
 *     dedupScope 'open'); a pure breach with a slow baseline control follows the
 *     owner-ratified note policy (breachDisposition), without asserting a root
 *     cause. Probe
 *     hygiene: rows older than 24h are swept each fire, so the canary never
 *     becomes its own bloat incident.
 *
 *   - `system:coord-invariant-monitor` (P-013, hourly): cheap SQL/adapter
 *     snapshots checked against thresholds —
 *       · handoffs stuck pending          (open > stuckHandoffHours, def 12)
 *       · operational escalations undrained (operational + open past the reconcile
 *                                          TTL + a grace window — the substrate's own
 *                                          drain is failing; EI-6910: was "any open
 *                                          escalation past 6h", which fired perpetually
 *                                          on the human's normal decision backlog;
 *                                          EI-7087: the grace absorbs the normal
 *                                          reconcile-tick-vs-check-tick cadence race)
 *       · locks held past TTL, unswept    (expired > expiredLockGraceMin, def 60)
 *       · presence ghosts                 (heartbeat stale > presenceGhostHours,
 *                                          def 72, rows never cleaned)
 *       · wake-queue depth / age          (pending_wakes > wakeQueueDepthMax, def 250,
 *                                          or oldest past the auto-expiry deadline
 *                                          pendingWakeStaleHours + grace — a sweep
 *                                          failure, not the human's normal review
 *                                          backlog; EI-8664)
 *       · session_turn_parts COPY convoy (a long-running COPY or queued lock
 *                                          waiters on the faithful transcript table)
 *     Each violation files ONE deduped improvement with a STABLE title (the
 *     dedup key), so a persisting violation never floods the backlog.
 *
 *   - `system:claim-integrity-sweep` (fleet-reliability-verification-2026-07-10
 *     P-001 / EI-8999, every 10 min): a LIVE double-placement risk, not a slow
 *     leak, so unlike the two checks above it ALARMS — a directed, WOKEN message
 *     to the holder + its fleet leader — in addition to filing the durable
 *     dedup record. Two desyncs —
 *       · orphaned wip           (work_item `wip` + null taken_by, but its linked
 *                                 plan item shows a LIVE claim held by a
 *                                 presence-live owner — the work-item's own
 *                                 tracking desynced from the authoritative
 *                                 plan-item lease)
 *       · unbacked active assignment (an ACTIVE plan_item_assignments row whose
 *                                 assignee is presence-live, but no live
 *                                 plan_item_claims lease backs it — the
 *                                 stale-claims.ts reapers only clean this up
 *                                 once the holder goes dead/stalls; this is
 *                                 their live-holder complement)
 *     Pure planner `planClaimIntegrityAlarms` (holder + leader targets) is
 *     exported for unit tests; the leader lookup is injectable via
 *     `resolveLeadersForHolders`.
 *
 * All three handlers are replay-safe (read-only checks + idempotent probe
 * writes + dedup-gated filing) and every check is isolated — one failing query
 * degrades that check, never the fire. Pure planners (`evaluateProbe`,
 * `evaluateInvariants`, `planClaimIntegrityAlarms`) are exported for unit
 * tests; the probe cycle takes an injectable deps bag for the same reason.
 *
 * Seed: seed-coord-invariant-routines.ts. Registered via register-system-actions.
 */
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
// Reuse the per-handle drain GC's retention window + batch bounds so the global
// sweep below (EI-436) stays consistent with the inline GC it backstops.
import {
  OUTBOX_GC_AGE_MS,
  OUTBOX_GC_BATCH,
  OUTBOX_GC_BUDGET_MS,
} from '../../sync/hyperbee/outbox-drain';
// EI-21096375006041139: whether this process currently holds a booted
// substrate handle for a scope — see the `residentInProcess` opt threaded into
// runSharedHiveMonitorPass/scanOutboxHealth below for why this matters.
import { getBootedHarness } from '../../sync/hyperbee/boot-all';
// EI-21111467164675531: a harness_slug with no registry entry / started bit
// can NEVER boot a drain loop, so it must never reach the per-harness scans
// below either — see `filterSharedHiveScopes`'s `knownOwnerSlugs` doc.
import { loadKnownOutboxOwnerSlugs } from '../../substrate-outbox-backstop-gc';
import { listStartedPots } from '../../pot/started';
import { captureImprovement } from '../improvements/capture-core';
import { lockAuthorityForHive } from '../../authority/lock-authority';
import { isWorkspaceGlobalLabel } from '../../pot-membership';
// EI-21100148946854844: a work-item id can never be a genuine harness_slug — see
// `looksLikeWorkItemId`'s doc comment below for why this must be excluded from
// scope discovery the same way `isWorkspaceGlobalLabel` already is. Reusing the
// canonical id-shape constant (rather than re-deriving a `WI|EI|F` regex here)
// keeps this exclusion in agreement with every other id-shape check in the repo.
import { WORK_ITEM_ID_PATTERN } from '../../work-items';
import {
  runSharedHiveMonitorPass,
  type LeaseHolderRow,
  type MonitorIncident,
  type PresenceRow,
} from '../../shared-pot-loop/fleet-monitors';
import { sendMessage, readInbox, appendAck, readAckedMsgIds } from '../../agent-tools/coordination/messages';
import { listHandoffs, acceptHandoff } from '../../agent-tools/coordination/handoffs';
import { listEscalations } from '../../agent-tools/coordination/escalations';
// EI-6910: the escalation invariant measures coordination-SUBSTRATE drain-health, so it
// must know (a) which escalations the substrate is responsible for draining
// (isOperationalEscalation — the same queue-pending-accuracy D-005 classifier the
// reader + reconcile sweep already agree on) and (b) the reconcile drain deadline
// (OPERATIONAL_ESCALATION_TTL_MS — the single source of truth in reconcile-escalations.ts).
import { isOperationalEscalation } from '../../attention/adapters';
import {
  isEmitterOwnedRow,
  OPERATIONAL_ESCALATION_TTL_MS,
  reconcileStaleEscalationsOnce,
} from '../../attention/reconcile-escalations';

/**
 * EI-7087: grace window added ON TOP of OPERATIONAL_ESCALATION_TTL_MS before the
 * invariant flags an undrained escalation. Without it, this check false-positives
 * on ordinary tick-cadence drift, not a real drain failure: the reconcile sweep
 * fires hourly at :20 (attentionReconcileTick) and this invariant checks hourly at
 * :37 (seed-coord-invariant-routines) — 17 minutes later. An operational escalation
 * that crosses the 48h TTL boundary in the 17–43min window BETWEEN a reconcile tick
 * and the next one is, by construction, still open when this check runs, even
 * though the reconcile sweep is working perfectly and will drain it at its very
 * next tick. Given the near-continuous operational-escalation traffic (e.g.
 * system:infra-liveness-alarm bursts), that race hits often enough to keep this
 * "minor" EI perpetually re-opening despite zero real backlog (verified live,
 * 2026-07-04: max age of any open operational escalation was 46.4h — under the
 * 48h TTL — at the moment this fired citing "still open past TTL").
 * One hour comfortably covers the normal cadence race (which is at most ~43min)
 * with margin, while staying tiny next to what a GENUINE drain failure looks like
 * (reconcile repeatedly shed/stuck for multiple hours against a fast-growing
 * operational-escalation stream) — so this still catches the real failure this
 * invariant exists for, just not the tick-timing noise.
 */
export const ESCALATION_RECONCILE_GRACE_MS = (() => {
  const env = Number(process.env.PAPERCUSP_ESCALATION_RECONCILE_GRACE_MS);
  return Number.isFinite(env) && env > 0 ? env : 60 * 60 * 1000;
})();
import { sweepDeadOwnerPendingWakes, sweepStalePendingWakes } from '../../agent-tools/coordination/pending-wakes';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import {
  ensureBootstrap,
  getTxPool,
  normalizePaths,
  tryAcquire,
  tryRelease,
} from '../../agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from '../../agent-tools/locks/in-workspace-txn';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import { fetchPresenceFleet } from '../../agent-tools/coordination/presence-fleet';
import { getFleet } from '../../agent-fleets-store';

// ── P-012: probe-pair canary ────────────────────────────────────────────────

export const PROBE_A = 'coord-probe-canary-a';
export const PROBE_B = 'coord-probe-canary-b';
/** Synthetic coordination domain — never a real repo, so the scope guard keeps
 *  these locks local and no live agent ever contends with the probe. */
export const PROBE_DOMAIN = 'coord-probe-canary';
const PROBE_PATH = 'probe/canary.lock';

export interface ProbeStep {
  step: string;
  ok: boolean;
  ms: number;
  detail?: string;
  /** True when this step failed SOLELY because its per-workspace txn could not
   *  serialize in time — a `WorkspaceContendedError` (pg 55P03 lock_timeout /
   *  57014 statement_timeout), i.e. transient shared-box contention, NOT a coord
   *  correctness regression. Drives the file-vs-note disposition (EI-3019). */
  contended?: boolean;
}

/** PG SQLSTATEs / error shapes that mean "same-workspace contention timeout"
 *  (advisory-lock lock_timeout 55P03 / statement_timeout 57014) — the locks layer
 *  maps these into a `WorkspaceContendedError`. We detect by name OR raw code so
 *  the check is robust whether the wrapper or the raw postgres error propagates. */
const CONTENTION_PG_CODES = new Set(['55P03', '57014']);

/** Pure: was a thrown error a transient same-workspace contention timeout (vs a
 *  real correctness/logic failure)? Exported for unit tests. */
export function isContentionTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; pgCode?: string };
  if (e.name === 'WorkspaceContendedError') return true;
  return (
    (typeof e.pgCode === 'string' && CONTENTION_PG_CODES.has(e.pgCode)) ||
    (typeof e.code === 'string' && CONTENTION_PG_CODES.has(e.code))
  );
}

export interface ProbeVerdict {
  ok: boolean;
  totalMs: number;
  /** First failed step, when any. */
  failedStep?: string;
  /** True when every step passed but the cycle blew the total SLO. */
  sloBreached: boolean;
}

/** Pure: judge a completed probe cycle against the total-cycle SLO.
 *
 *  A cycle that measured NOTHING is never green. Without this guard
 *  `evaluateProbe([], slo)` returns ok:true — there is no failed step to find,
 *  and totalMs 0 is <= any SLO — i.e. a GREEN VERDICT OVER ZERO MEASUREMENTS.
 *  That is the "passing probe that never read the value" class: the reduce and
 *  the find are both vacuously satisfied by an empty array, so the verdict is
 *  indistinguishable from a real all-steps-passed cycle.
 *
 *  Not reachable from the live caller today: runProbeCycle always pushes
 *  `baseline` first, and its `timed()` helper pushes a step on the throw path
 *  too, so every early return carries >= 1 step. This keeps the failure mode
 *  unrepresentable for the NEXT caller of this exported pure function rather
 *  than relying on that invariant holding elsewhere.
 *
 *  Fails OPEN by design: 'no-steps' matches no real ProbeStep, so
 *  breachDisposition() finds no `contended` step to downgrade on and returns
 *  'file' — a probe that measured nothing raises a bug instead of reporting ok. */
export function evaluateProbe(steps: ProbeStep[], totalSloMs: number): ProbeVerdict {
  if (steps.length === 0) {
    return { ok: false, totalMs: 0, failedStep: 'no-steps', sloBreached: false };
  }
  const totalMs = steps.reduce((n, s) => n + s.ms, 0);
  const failed = steps.find((s) => !s.ok);
  return {
    ok: !failed && totalMs <= totalSloMs,
    totalMs,
    failedStep: failed?.step,
    sloBreached: !failed && totalMs > totalSloMs,
  };
}

/** Triage labels for measured round-trip boundaries, not root-cause claims.
 *  'baseline-slow' means the SELECT 1 control exceeded its threshold;
 *  'coord-operations-slow' means the end-to-end ping or ack operation did;
 *  'unattributed' means neither comparison identifies a component; 'none'
 *  means no baseline was sampled. */
export type BreachClass = 'baseline-slow' | 'coord-operations-slow' | 'unattributed' | 'none';

/** Pure: compare the control `baseline` round-trip with end-to-end ping/ack
 *  durations. These comparisons classify measurements but do not isolate a
 *  lower-level cause. The result drives the report wording and note policy. */
export function classifyBreach(steps: ProbeStep[], slowMs = 2_000): BreachClass {
  const ms = (step: string) => steps.find((s) => s.step === step)?.ms;
  const baseline = ms('baseline');
  if (baseline == null) return 'none';
  const ping = ms('ping') ?? 0;
  const ack = ms('ack') ?? 0;
  if (baseline > slowMs) return 'baseline-slow';
  if (Math.max(ping, ack) > slowMs) return 'coord-operations-slow';
  return 'unattributed';
}

/** Pure: a one-line summary of measured control and operation timings. It does
 *  not assign those timings to a lower-level source. */
export function attributeBreach(steps: ProbeStep[], slowMs = 2_000): string {
  const ms = (step: string) => steps.find((s) => s.step === step)?.ms;
  const baseline = ms('baseline');
  const ping = ms('ping') ?? 0;
  const ack = ms('ack') ?? 0;
  switch (classifyBreach(steps, slowMs)) {
    case 'none':
      return 'Attribution: no baseline control sampled.';
    case 'baseline-slow':
      return `Attribution: SELECT 1 baseline control took ${baseline}ms; this single round-trip does not distinguish connection-pool wait, query execution, or a broader database issue.`;
    case 'coord-operations-slow':
      return `Attribution: SELECT 1 baseline control took ${baseline}ms; end-to-end coord ping took ${ping}ms and ack-plus-readback took ${ack}ms. These measurements do not isolate coord_event_log INSERT/commit/NOTIFY or show that these steps dominate the full cycle.`;
    case 'unattributed':
      return `Attribution: baseline ${baseline}ms, ping ${ping}ms, ack-plus-readback ${ack}ms; these measurements do not isolate the cause of the full-cycle delay.`;
  }
}

/** Pure: should a non-clean cycle FILE an EI, or downgrade to a logged NOTE?
 *  EI-401 owner ruling ("accept + tune", 2026-06-13): a *pure* SLO breach (no
 *  step failed) with a slow baseline control follows the owner-ratified note
 *  policy. The control is not sufficient to establish why it was slow. Everything
 *  else still files: failed steps and total-cycle breaches that the measurements
 *  do not explain remain visible for investigation (fail open). */
export function breachDisposition(verdict: ProbeVerdict, steps: ProbeStep[]): 'ok' | 'note' | 'file' {
  if (verdict.ok) return 'ok';
  if (verdict.sloBreached && classifyBreach(steps) === 'baseline-slow') return 'note';
  // EI-3019: a step that failed SOLELY because its per-workspace txn could not
  // serialize in time (WorkspaceContendedError — pg 55P03/57014) is the same
  // transient shared-box contention as the db-wide SLO breach above, just
  // surfacing as a step failure rather than an SLO breach — downgrade it instead
  // of minting a bogus correctness bug. A GENUINE correctness failure
  // (mutual-exclusion breach, regrant refused, dead query) returns {ok:false}
  // WITHOUT throwing, so `contended` stays false and it still FILES (fail open).
  if (verdict.failedStep) {
    const failed = steps.find((s) => s.step === verdict.failedStep);
    if (failed?.contended) return 'note';
  }
  return 'file';
}

/** The verb cycle, over an injectable deps bag (unit tests run on fakes). */
export interface ProbeDeps {
  /** Reference round-trip (SELECT 1); it does not isolate all database/pool
   *  costs from the multi-query coordination operations. */
  baseline: () => Promise<{ ok: boolean; detail?: string }>;
  send: (from: AgentIdentity, to: string, summary: string) => Promise<{ msg_id: string; ts: string }>;
  inboxHas: (owner: string, msgId: string, sinceTs: string) => Promise<boolean>;
  ack: (acker: AgentIdentity, msgId: string, from: string) => Promise<void>;
  ackedHas: (acker: string, msgId: string) => Promise<boolean>;
  acquire: (owner: string) => Promise<{ ok: boolean; busyOwner?: string }>;
  release: (owner: string) => Promise<void>;
  now?: () => number;
}

export async function runProbeCycle(deps: ProbeDeps, idA: AgentIdentity, idB: AgentIdentity): Promise<ProbeStep[]> {
  const now = deps.now ?? Date.now;
  const steps: ProbeStep[] = [];
  const timed = async (step: string, fn: () => Promise<{ ok: boolean; detail?: string }>) => {
    const t0 = now();
    try {
      const r = await fn();
      steps.push({ step, ok: r.ok, ms: now() - t0, detail: r.detail });
      return r.ok;
    } catch (err) {
      steps.push({
        step,
        ok: false,
        ms: now() - t0,
        detail: err instanceof Error ? err.message : String(err),
        contended: isContentionTimeout(err),
      });
      return false;
    }
  };

  // 0. Baseline control: a trivial DB round-trip that does NOT touch coordination
  //    writes or their notification triggers. It is a reference measurement only:
  //    a slow result does not localize pool wait vs query execution, and a fast
  //    result does not localize costs within the multi-query ping/ack operations.
  //    A hard failure means the DB is unreachable, so the rest of the cycle would
  //    fail anyway — abort.
  if (!(await timed('baseline', () => deps.baseline()))) return steps;
  // 1. ping A→B …
  let msgId = '';
  let sentTs = '';
  if (
    !(await timed('ping', async () => {
      const env = await deps.send(idA, idB.ownerId, `probe ping ${new Date(now()).toISOString()}`);
      msgId = env.msg_id;
      sentTs = env.ts;
      return { ok: !!msgId };
    }))
  ) {
    return steps;
  }
  // 2. … lands in B's inbox …
  if (!(await timed('inbox', async () => ({ ok: await deps.inboxHas(idB.ownerId, msgId, sentTs) })))) return steps;
  // 3. … B acks, and the ack is readable.
  if (
    !(await timed('ack', async () => {
      await deps.ack(idB, msgId, idA.ownerId);
      return { ok: await deps.ackedHas(idB.ownerId, msgId) };
    }))
  ) {
    return steps;
  }
  // 4. A takes the probe lock.
  if (!(await timed('lock-acquire', async () => deps.acquire(idA.ownerId)))) return steps;
  // 5. B contends and MUST be refused (mutual exclusion live).
  if (
    !(await timed('lock-contend', async () => {
      const r = await deps.acquire(idB.ownerId);
      return {
        ok: !r.ok && r.busyOwner === idA.ownerId,
        detail: r.ok ? 'contender was GRANTED a held lock' : undefined,
      };
    }))
  ) {
    // Leave no probe debris even on the failure path.
    await deps.release(idA.ownerId).catch(() => {});
    return steps;
  }
  // 6. A releases…
  if (
    !(await timed('lock-release', async () => {
      await deps.release(idA.ownerId);
      return { ok: true };
    }))
  ) {
    return steps;
  }
  // 7. …and the former contender now wins.
  await timed('lock-regrant', async () => {
    const r = await deps.acquire(idB.ownerId);
    if (r.ok) await deps.release(idB.ownerId);
    return { ok: r.ok };
  });
  return steps;
}

function probeIdentity(ownerId: string, workspaceId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'omp-hook-session', workspaceId, userId: null } as AgentIdentity;
}

/** The real-seam deps the live routine composes. */
function liveProbeDeps(): ProbeDeps {
  return {
    baseline: async () => {
      // Control: pure connection-acquire + query, no coord write, no NOTIFY.
      const { sql } = getOrgPg();
      await sql`SELECT 1`;
      return { ok: true };
    },
    send: async (from, to, summary) => {
      const env = await sendMessage(from, { to: [to], summary, category: 'probe-canary' });
      return { msg_id: env.msg_id, ts: env.ts };
    },
    inboxHas: async (owner, msgId, sinceTs) => {
      // since strictly-later would exclude the probe itself — back off 1ms.
      const since = new Date(Date.parse(sinceTs) - 1).toISOString();
      const inbox = await readInbox(owner, { since_ts: since });
      return inbox.some((l) => l.msg_id === msgId);
    },
    ack: async (acker, msgId, from) => {
      await appendAck(acker, msgId, from);
    },
    ackedHas: async (acker, msgId) => (await readAckedMsgIds(acker)).has(msgId),
    acquire: async (owner) => {
      const r = await inWorkspaceTxn(PROBE_DOMAIN, owner, (tx) =>
        tryAcquire(tx, {
          coordinationDomain: PROBE_DOMAIN,
          owner,
          ownerLabel: `probe:${owner}`,
          paths: normalizePaths([PROBE_PATH]),
          intent: 'coord probe-pair canary',
          ttlSec: 120,
        }),
      );
      if (r.ok) return { ok: true };
      return { ok: false, busyOwner: r.busy[0]?.owner };
    },
    release: async (owner) => {
      await inWorkspaceTxn(PROBE_DOMAIN, owner, (tx) =>
        tryRelease(tx, { coordinationDomain: PROBE_DOMAIN, owner, allMine: true }),
      );
    },
  };
}

/** Probe hygiene + failure forensics live on the same tables. */
async function sweepProbeRows(workspaceId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.coord_event_log
    WHERE workspace_id = ${workspaceId}
      AND writer_key IN (${PROBE_A}, ${PROBE_B})
      AND ts < now() - interval '24 hours'`;
}

async function probeForensics(workspaceId: string): Promise<string> {
  const parts: string[] = [];
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ surface: string; msg_id: string; ts: string; writer_key: string | null }[]>`
      SELECT surface, msg_id, ts::text, writer_key
      FROM harness_shared.coord_event_log
      WHERE workspace_id = ${workspaceId} AND writer_key IN (${PROBE_A}, ${PROBE_B})
      ORDER BY id DESC LIMIT 20`;
    parts.push(
      `coord_event_log (probe rows, newest 20):\n${rows.map((r) => `  ${r.ts} ${r.surface} ${r.msg_id} by ${r.writer_key}`).join('\n') || '  (none)'}`,
    );
  } catch (err) {
    parts.push(`coord_event_log forensics unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const sql = getTxPool();
    const locks = await sql<{ path: string; owner: string; expires_ts: string }[]>`
      SELECT path, owner, expires_ts::text FROM agent_file_locks
      WHERE coordination_domain = ${PROBE_DOMAIN} LIMIT 20`;
    parts.push(
      `agent_file_locks (probe domain):\n${locks.map((l) => `  ${l.path} held by ${l.owner} until ${l.expires_ts}`).join('\n') || '  (none)'}`,
    );
  } catch (err) {
    parts.push(`lock-table forensics unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parts.join('\n\n');
}

registerSystemAction('coord-probe-canary', async (ctx: SystemActionCtx) => {
  // Default 30s (EI-401): a 10s cycle SLO false-alarmed on transient peak-load coord-write
  // spikes on a shared dev box. The live value is the routine's payload_template.totalSloMs.
  const sloMs = Number((ctx.payloadTemplate?.totalSloMs as number | undefined) ?? 30_000);
  await ensureBootstrap();
  const idA = probeIdentity(PROBE_A, ctx.workspaceId);
  const idB = probeIdentity(PROBE_B, ctx.workspaceId);

  const steps = await runProbeCycle(liveProbeDeps(), idA, idB);
  const verdict = evaluateProbe(steps, sloMs);

  await sweepProbeRows(ctx.workspaceId).catch(() => {});

  const disposition = breachDisposition(verdict, steps);
  if (disposition !== 'ok') {
    const stepLines = steps
      .map((s) => `  ${s.ok ? '✓' : '×'} ${s.step} ${s.ms}ms${s.detail ? ` — ${s.detail}` : ''}`)
      .join('\n');

    // EI-401 (owner-ratified "accept + tune", 2026-06-13): a pure SLO breach the
    // baseline control is slow follows the owner-ratified note policy. That policy
    // is a disposition rule, not proof that a shared-box condition caused the
    // breach. The probe-row sweep above already ran, so this path leaves no debris.
    // A failed step or any other total-cycle breach still files for investigation.
    if (disposition === 'note') {
      console.warn(
        `[coord-probe-canary] SLO breach DOWNGRADED to note (not filed) — completed in ${verdict.totalMs}ms (SLO ${sloMs}ms).\n` +
          `Cycle:\n${stepLines}\n${attributeBreach(steps)}`,
      );
      return;
    }

    await captureImprovement({
      title: verdict.failedStep
        ? `coord probe-pair canary failed at '${verdict.failedStep}'`
        : 'coord probe-pair canary breached its cycle SLO',
      kind: 'bug',
      severity: verdict.failedStep ? 'major' : 'minor',
      dedupScope: 'open',
      // P-004 (silent-intake, EI-22068807981214694): a stable recurrence identity —
      // cross-tick dedup becomes an exact indexed payload.watchdogKey lookup, so a
      // repeat breach COALESCES onto one open canonical row (and REOPENS a
      // watchdog-auto-resolved one) instead of minting a sibling per breach
      // (measured: 10 open twins of the SLO title, filed over several days).
      watchdogKey: verdict.failedStep
        ? `coord-probe-canary:step:${verdict.failedStep}`
        : 'coord-probe-canary:cycle-slo',
      // Live detection, evidenced NOW — lets the stale-lookback rail distinguish a
      // genuine recurrence from collector lookback junk.
      evidenceAt: new Date().toISOString(),
      foundDuring: 'system:coord-probe-canary',
      subTopic: 'coordination',
      body:
        `The scheduled probe-pair canary (coord-system-e2e P-012) ${verdict.failedStep ? `failed at step '${verdict.failedStep}'` : `completed but took ${verdict.totalMs}ms (SLO ${sloMs}ms)`}.\n\n` +
        `Cycle:\n${stepLines}\n\n` +
        (verdict.sloBreached ? `${attributeBreach(steps)}\n\n` : '') +
        `${await probeForensics(ctx.workspaceId)}`,
    });
  }
});

// ── P-013: invariant monitors ───────────────────────────────────────────────

export interface InvariantThresholds {
  stuckHandoffHours: number;
  // NOTE (EI-6910): the old `staleEscalationHours` (6h) was removed. It measured the
  // human's normal decision backlog (any open escalation past 6h), which is NEVER a
  // substrate leak, so it fired a perpetual, un-closeable bug. The escalation check now
  // follows the reconcile drain deadline (OPERATIONAL_ESCALATION_TTL_MS) instead — the
  // substrate is only responsible for draining OPERATIONAL escalations.
  expiredLockGraceMin: number;
  presenceGhostHours: number;
  /**
   * The RAW pending_wakes count above which the depth leg fires — a genuine-runaway
   * bloat backstop (a wake-creation storm / owners drowning), independent of age.
   *
   * EI-10177: this was 50, which fired on EXPECTED live-owner review backlog. A busy
   * manual-mode fleet legitimately stages many young wakes for LIVE owners (observed
   * live: 57 wakes across 8 live owners, 0 stale, one owner alone at 32) — none of which
   * the in-pass sweeps can or should reap (dead-owner + >staleHours only), so the alarm
   * re-filed a non-actionable EI every hour (recurred 5×). That is the EI-6910/EI-8664
   * anti-pattern (a "warn early" count threshold measuring the human's normal review
   * backlog — the pui wake board is that review surface, not a filed bug), one leg removed
   * from the AGE alarm. The count is now set well above realistic busy-fleet backlog so it
   * catches only a genuine runaway, yet stays BELOW BOARD_READ_LIMIT (500, pending-wakes.ts)
   * so the wake board still renders the full queue when this backstop does fire.
   */
  wakeQueueDepthMax: number;
  /** WI-3097: auto-EXPIRE any staged wake (live owner or dead) past this age
   *  (sweepStalePendingWakes, run in-pass just before the invariant check). EI-8664:
   *  this is ALSO the sole basis for the wake-queue AGE alarm — a wake aged UNDER it is
   *  EXPECTED live-owner review backlog the sweep will reap (the pui wake board is the
   *  owner's review surface, not a filed EI); a wake that SURVIVES past it
   *  (+ WAKE_QUEUE_STALE_GRACE_MS) means the sweep is genuinely not keeping up, the only
   *  real substrate leak. There is deliberately NO separate lower "alert" threshold — a
   *  lower one fires an EI on the human's normal review backlog every hour, the EI-6910
   *  anti-pattern (and the two knobs could silently drift apart, reopening the gap). */
  pendingWakeStaleHours: number;
  /** WI-3959: a coord_event_log-touching pg_stat_statements entry averaging more
   *  rows/call than this is flagged as a "furnace" — an unbounded full-surface
   *  read (the WI-3937/WI-3869 class: readLines-shaped, no LIMIT/id-cursor). The
   *  original WI-3937 incident sustained ~28k rows/call across 285k calls before
   *  it was caught, so 50k comfortably clears any legitimate bounded read
   *  (a single page, a small delta) while still catching the class early. */
  coordLogFurnaceRowsPerCall: number;
  /** A coord_event_log statement averaging slower than this (ms) is ALSO flagged
   *  as a furnace, even under the rows/call threshold — a slow-but-not-huge scan
   *  (e.g. missing an index) is the same drain-starving pattern the rows check
   *  exists to catch. */
  coordLogFurnaceMeanExecMs: number;
  /** EI-9420: gates the MEAN-EXEC-TIME leg only (never the rows/call leg —
   *  see evaluateInvariants). pg_stat_statements aggregates a statement's stats
   *  over its WHOLE LIFETIME since the last reset, which can span many hours or
   *  days — well past whenever a fix for that exact query actually landed and
   *  deployed. A query fixed hours ago (a new index, an added LIMIT) can still
   *  carry a catastrophic lifetime MEAN forever, dragged up purely by historical
   *  calls from BEFORE the fix — that is stale debris, not a live problem
   *  (verified live 2026-07-11 / EI-9420: 3 "furnace" alarms all had
   *  min_exec_time in the single-digit-to-low-hundreds ms range alongside a
   *  multi-second mean and a 300s+ max — a proven-fast path exists NOW, the
   *  bad mean is history). A genuinely still-unbounded scan has no fast path at
   *  all, so even its single BEST call (min_exec_time) is slow. Set comfortably
   *  above the observed cost of a legitimate bounded/indexed coord_event_log
   *  read (~0.1-140ms) and well under the multi-second genuine-furnace range. */
  coordLogFurnaceProvenFastPathMs: number;
  /** EI-21363741549000811: a faithful transcript COPY should not hold an
   *  AccessShareLock for longer than this after the backup hook's data
   *  exclusion. A queued waiter is actionable even when the COPY is young. */
  sessionTurnPartsCopyMaxSeconds: number;
  /** A queued relation lock waiter alongside an active COPY is a convoy. The
   *  default zero means any waiter observed by the hourly monitor is a breach. */
  sessionTurnPartsCopyQueuedWaitersMax: number;
}

export const DEFAULT_THRESHOLDS: InvariantThresholds = {
  stuckHandoffHours: 12,
  expiredLockGraceMin: 60,
  presenceGhostHours: 72,
  // EI-10177: raised 50 → 250. 50 fired on normal live-owner review backlog (see the
  // wakeQueueDepthMax doc comment). 250 is ~4× the observed busy-fleet peak (57) yet stays
  // below BOARD_READ_LIMIT (500) so the wake board renders whole when the runaway backstop fires.
  wakeQueueDepthMax: 250,
  pendingWakeStaleHours: 24,
  coordLogFurnaceRowsPerCall: 50_000,
  coordLogFurnaceMeanExecMs: 2_000,
  coordLogFurnaceProvenFastPathMs: 500,
  sessionTurnPartsCopyMaxSeconds: 60,
  sessionTurnPartsCopyQueuedWaitersMax: 0,
};

/**
 * EI-8664: grace added on top of pendingWakeStaleHours before the wake-queue AGE alarm
 * fires. The auto-expiry sweep (sweepStalePendingWakes) runs in the SAME pass immediately
 * before the check and reaps every wake past pendingWakeStaleHours, so any wake surviving
 * past that deadline already means the sweep is failing. This grace only absorbs the
 * boundary/clock race (a row that was a hair under the cap at sweep time, now a hair over
 * at measure time) so a single hourly pass never false-fires on the 24h edge — only a
 * genuinely-stuck queue keeps a wake past the deadline + grace. One hour matches the
 * hourly monitor cadence.
 */
export const WAKE_QUEUE_STALE_GRACE_MS = 60 * 60 * 1000;

/** One open escalation, reduced to what the substrate-drain invariant needs to tell a
 *  genuine human decision (the human's attention queue — never a substrate leak) from an
 *  OPERATIONAL escalation the substrate auto-drains. */
export interface OpenEscalationLite {
  ts: string;
  from: string | null;
  hasOptions: boolean;
  /** WI-206095: preserve the reconcile sweep's explicit emitter-owned guards. */
  livenessSignature?: unknown;
  selfReconciling?: unknown;
}

/** One pg_stat_statements row touching `coord_event_log` — raw, NOT yet
 *  threshold-judged (evaluateInvariants does the judging, same split as every
 *  other check here). Populated best-effort: empty when pg_stat_statements is
 *  not installed (it is superuser-only / opt-in — see sql/002-tables.sql). */
export interface CoordLogFurnaceStatement {
  queryid: string;
  /** Truncated query text — enough to identify the call site, never the full
   *  (potentially huge) statement. */
  queryPreview: string;
  calls: number;
  rowsPerCall: number;
  meanExecMs: number;
  /** EI-9420: this statement's single FASTEST call (pg_stat_statements
   *  min_exec_time) in the current stats window — the proven-fast-path
   *  discriminator (see InvariantThresholds.coordLogFurnaceProvenFastPathMs).
   *  Optional so a hand-built test snapshot (or a pg_stat_statements version
   *  lacking the column) can omit it; evaluateInvariants treats an absent
   *  value as "unknown" and does NOT suppress on it. */
  minExecMs?: number;
}

/** A CURRENTLY-RUNNING pg_stat_activity row whose query text also touches
 *  `coord_event_log` — best-effort forensics so a furnace violation can name
 *  the offending client (application_name/pid) when caught in the act, not
 *  just the aggregate historical pattern. Correlation is by text pattern, not
 *  a precise queryid join (pg_stat_activity carries no queryid column here). */
export interface CoordLogActiveOffender {
  pid: number;
  applicationName: string | null;
  durationSeconds: number;
}

/** A currently-running COPY of the faithful transcript parts table. */
export interface SessionTurnPartsCopyHolder {
  pid: number;
  applicationName: string | null;
  durationSeconds: number;
}

/** A backend waiting on a relation lock for the faithful transcript parts
 *  table. Query text is bounded for incident evidence. */
export interface SessionTurnPartsLockWaiter {
  pid: number;
  applicationName: string | null;
  mode: string;
  durationSeconds: number;
  queryPreview: string | null;
}

/** A relation-level AccessExclusiveLock waiter, reduced to bounded incident
 * evidence. A waiting DDL is dangerous when ordinary AccessShare readers are
 * queued behind it on the same relation. */
export interface AccessExclusiveLockWaiter {
  relation: string;
  pid: number;
  applicationName: string | null;
  durationSeconds: number;
  queryPreview: string | null;
}

/** A relation-level AccessShareLock waiter observed alongside a waiting DDL. */
export interface AccessShareLockWaiter {
  relation: string;
  pid: number;
  applicationName: string | null;
  durationSeconds: number;
  queryPreview: string | null;
}

export interface InvariantSnapshot {
  openHandoffTs: string[];
  openEscalations: OpenEscalationLite[];
  /** Locks whose expiry is older than the grace window and still present. */
  longExpiredLocks: number;
  /** Presence rows whose heartbeat is stale past the ghost window. */
  presenceGhosts: number;
  wakeQueueDepth: number;
  wakeQueueOldestMs: number | null;
  /** WI-3959: coord_event_log-touching pg_stat_statements rows (raw, unjudged). */
  coordLogFurnaces: CoordLogFurnaceStatement[];
  /** WI-3959: currently-running queries matching the same pattern, for naming
   *  the live offender when one is caught mid-scan. */
  coordLogActiveOffenders: CoordLogActiveOffender[];
  /** EI-21363741549000811: active faithful-parts COPY holders and bounded
   *  relation-lock waiters observed in the same monitor pass. */
  sessionTurnPartsCopyHolders: SessionTurnPartsCopyHolder[];
  sessionTurnPartsLockWaiters: SessionTurnPartsLockWaiter[];
  /** EI-21374588273323330: bounded generic relation-lock snapshots. */
  accessExclusiveLockWaiters: AccessExclusiveLockWaiter[];
  accessShareLockWaiters: AccessShareLockWaiter[];
}

export interface Violation {
  /** STABLE dedup title — a persisting violation re-files into its open issue. */
  title: string;
  detail: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
}

/**
 * EI-9506 / EI-9533 / EI-21896608538525240: a backup / maintenance / ad-hoc-diagnostic
 * statement — a `pg_dump`-style `COPY harness_shared.coord_event_log (...) TO stdout`,
 * an autovacuum/maintenance `VACUUM [ANALYZE]` / `ANALYZE harness_shared.coord_event_log`,
 * or a one-off `CREATE TABLE ... AS SELECT ... FROM harness_shared.coord_event_log`
 * diagnostic materialization (e.g. an operator investigating this very detector via
 * `dev:pg_query`/`dev:pg_mutate`, snapshotting rows into a scratch table such as
 * `su_probe.cel`) — legitimately touches the WHOLE table: that is what a backup / table
 * maintenance / one-time forensic snapshot is FOR, not a recurring application read
 * pattern to bound. These are issued by the backup process (kopia/pg_dump), the
 * autovacuum daemon / a maintenance job, or a human/agent's own manual `psql`/tool
 * session — never by the app in its normal request path — so the furnace detector must
 * never treat them as furnaces. The rows/call leg would otherwise flag a full-table dump
 * (~100k rows/call) as an "unbounded scan", and the MEAN-exec leg flags a slow
 * `VACUUM ANALYZE` / `ANALYZE` (live-observed 2.4–3.4s on this table) — and, critically,
 * the EI-9420 min_exec suppression cannot rescue any of these: it gates only the MEAN-exec
 * leg (so the rows/call leg stands alone for the dump/snapshot), and none of these has a
 * fast path (every call scans/materializes the whole matched set, so min_exec is high too
 * — nothing to suppress on). Worse for the `CREATE TABLE ... AS SELECT` case specifically:
 * because pg_stat_statements accumulates the statement's stats FOREVER (until a stats
 * reset or Postgres restart), a single historical one-off snapshot query keeps getting
 * re-observed with byte-identical calls/rows/exec-time on every later watchdog tick and
 * re-files as a "new" furnace each time (observed live 2026-08-30: the exact same
 * queryid, calls=3, rows/call=82647 was independently filed as EI-21896608538525240 at
 * 16:37Z and again as EI-21900571774725690 at 17:40Z — no NEW activity occurred between
 * the two ticks, only the same stale cumulative counter being re-read) — an unbounded,
 * un-fixable stream of near-duplicate bug reports about an agent's own past forensic
 * query, not a live app bug. VACUUM/ANALYZE escape flagging today ONLY incidentally
 * (rows/call=0 keeps them below the top-N-by-rows/call gather window), so this is the
 * durable fix that classifies all three by STATEMENT KIND rather than relying on that
 * ranking accident. Match on the leading keyword of the (already length-clamped) query
 * preview — anchored at start + a word boundary so a SELECT that merely mentions
 * COPY/VACUUM/ANALYZE/CREATE in a string/column is never a false positive; the CREATE
 * TABLE leg allows an optional TEMP(ORARY)/UNLOGGED modifier so any one-off scratch
 * materialization is covered, not just a plain permanent table. Exported for unit tests.
 */
export function isBackupOrMaintenanceStatement(queryPreview: string): boolean {
  return /^\s*(?:COPY|VACUUM|ANALYZE|CREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE)\b/i.test(queryPreview);
}

/** Pure: judge a snapshot against the thresholds. */
export function evaluateInvariants(snap: InvariantSnapshot, t: InvariantThresholds, nowMs: number): Violation[] {
  const out: Violation[] = [];
  const olderThanH = (tsList: string[], hours: number) =>
    tsList.filter((ts) => nowMs - Date.parse(ts) > hours * 3_600_000).length;

  const stuckHandoffs = olderThanH(snap.openHandoffTs, t.stuckHandoffHours);
  if (stuckHandoffs > 0) {
    out.push({
      title: `coord invariant: handoffs stuck pending past ${t.stuckHandoffHours}h`,
      detail: `${stuckHandoffs} open handoff(s) older than ${t.stuckHandoffHours}h — work is parked with no acceptor.`,
      severity: 'minor',
    });
  }
  // EI-6910: This check measures coordination-SUBSTRATE drain-health, NOT the human's
  // decision backlog. The substrate auto-drains only OPERATIONAL escalations
  // (system/infra-emitter, option-less) — via the hourly attention-reconcile sweep on the
  // OPERATIONAL_ESCALATION_TTL_MS (48h) deadline (reconcile-escalations.ts). GENUINE
  // human-decision escalations are surfaced + tiered in the attention queue and are, by
  // design, NEVER substrate-drained (a human clears them). The old "open escalation past
  // 6h" count included those, so it fired on the normal steady-state human backlog (554+
  // open) and minted an un-closeable bug that re-filed every hour. So the invariant now
  // fires only on a genuine substrate DRAIN FAILURE: an operational escalation still open
  // past the reconcile TTL, i.e. the reconcile sweep is not keeping up. Mirrors the sibling
  // handoff invariant (auto-accept stale before measure, F-FIX-037) and the wake-queue
  // invariant (sweep dead-owner wakes before measure, EI-314): measure genuine stalls, not
  // expected/human-owned state.
  const undrainedOperationalEsc = snap.openEscalations.filter((e) => {
    if (!isOperationalEscalation(e.from, e.hasOptions)) return false;
    // Match reconcile-escalations.ts: these rows are the emitter's own
    // suppressor and are intentionally exempt from TTL reconciliation.
    if (isEmitterOwnedRow(e)) return false;
    const openedMs = Date.parse(e.ts);
    // EI-7087: TTL + a grace window, not the bare TTL — see ESCALATION_RECONCILE_GRACE_MS
    // doc comment for why (absorbs the normal reconcile-tick-vs-invariant-check cadence
    // race instead of false-firing on it every time an escalation crosses the TTL boundary
    // between two reconcile ticks).
    return (
      Number.isFinite(openedMs) && nowMs - openedMs > OPERATIONAL_ESCALATION_TTL_MS + ESCALATION_RECONCILE_GRACE_MS
    );
  }).length;
  if (undrainedOperationalEsc > 0) {
    const ttlHours = Math.round((OPERATIONAL_ESCALATION_TTL_MS + ESCALATION_RECONCILE_GRACE_MS) / 3_600_000);
    out.push({
      title: 'coord invariant: operational escalations undrained past reconcile TTL',
      detail: `${undrainedOperationalEsc} operational escalation(s) still open past the ${ttlHours}h attention-reconcile TTL (${Math.round(OPERATIONAL_ESCALATION_TTL_MS / 3_600_000)}h TTL + ${Math.round(ESCALATION_RECONCILE_GRACE_MS / 3_600_000)}h grace) — the reconcile sweep (reconcile-escalations.ts) is not draining them.`,
      severity: 'minor',
    });
  }
  if (snap.longExpiredLocks > 0) {
    out.push({
      title: 'coord invariant: file locks held past TTL without sweep',
      detail: `${snap.longExpiredLocks} lock row(s) expired more than ${t.expiredLockGraceMin}min ago and still present — heartbeat/sweep failure or orphaned holder.`,
      severity: 'minor',
    });
  }
  if (snap.presenceGhosts > 0) {
    out.push({
      title: `coord invariant: presence ghosts lingering past ${t.presenceGhostHours}h`,
      detail: `${snap.presenceGhosts} presence row(s) with a heartbeat older than ${t.presenceGhostHours}h never cleaned up.`,
      severity: 'nit',
    });
  }
  const oldestH = snap.wakeQueueOldestMs == null ? 0 : (nowMs - snap.wakeQueueOldestMs) / 3_600_000;
  // EI-8664: the AGE alarm fires on the auto-EXPIRY deadline (pendingWakeStaleHours + a
  // small boundary grace), NOT a separate lower "alert" threshold. sweepStalePendingWakes
  // runs in-pass immediately before this check and reaps every wake past
  // pendingWakeStaleHours, so a wake that survives past it means that sweep is genuinely
  // failing — a real substrate leak. A wake aged UNDER the deadline is expected live-owner
  // review backlog (the pui wake board is the owner's review surface, not a filed EI);
  // alarming on it is the EI-6910 anti-pattern (measuring the human's normal backlog as a
  // leak) and re-files a non-actionable EI every hour.
  const graceH = WAKE_QUEUE_STALE_GRACE_MS / 3_600_000;
  const wakeAgeAlarmH = t.pendingWakeStaleHours + graceH;
  if (snap.wakeQueueDepth > t.wakeQueueDepthMax || oldestH > wakeAgeAlarmH) {
    out.push({
      title: 'coord invariant: wake-queue depth/age growth',
      detail: `pending_wakes depth=${snap.wakeQueueDepth} (max ${t.wakeQueueDepthMax}), oldest=${oldestH.toFixed(1)}h (auto-expiry ${t.pendingWakeStaleHours}h + ${graceH.toFixed(0)}h grace) — the stale-wake sweep is not keeping the queue bounded.`,
      severity: 'minor',
    });
  }
  // EI-21363741549000811: the backup hook excludes session_turn_parts data and
  // bounds its pg_dump session. This catches an older/deployed hook or another
  // dump path that still runs a long COPY, especially when application writers
  // are queued behind its AccessShareLock. The monitor samples only currently
  // active COPYs and a bounded waiter list, so it never turns the detector into
  // another unbounded diagnostic query.
  const longPartsCopies = snap.sessionTurnPartsCopyHolders.filter(
    (copy) => copy.durationSeconds > t.sessionTurnPartsCopyMaxSeconds,
  );
  const queuedPartsWaiters = snap.sessionTurnPartsLockWaiters.length;
  if (
    snap.sessionTurnPartsCopyHolders.length > 0 &&
    (longPartsCopies.length > 0 || queuedPartsWaiters > t.sessionTurnPartsCopyQueuedWaitersMax)
  ) {
    const holderDetail = snap.sessionTurnPartsCopyHolders
      .map((copy) => `pid=${copy.pid} app=${copy.applicationName ?? 'unknown'} running=${copy.durationSeconds.toFixed(1)}s`)
      .join(', ');
    const waiterDetail = snap.sessionTurnPartsLockWaiters.length
      ? `; waiters: ${snap.sessionTurnPartsLockWaiters
          .map((waiter) => `pid=${waiter.pid} mode=${waiter.mode} app=${waiter.applicationName ?? 'unknown'} running=${waiter.durationSeconds.toFixed(1)}s${waiter.queryPreview ? ` query=${waiter.queryPreview}` : ''}`)
          .join(' | ')}`
      : '';
    out.push({
      title: 'coord invariant: session_turn_parts COPY lock convoy',
      detail:
        `${snap.sessionTurnPartsCopyHolders.length} active COPY holder(s) on harness_shared.session_turn_parts ` +
        `(long-copy threshold ${t.sessionTurnPartsCopyMaxSeconds}s): ${holderDetail}; ` +
        `${queuedPartsWaiters} queued relation-lock waiter(s)${waiterDetail}`,
      severity: 'major',
    });
  }
  // EI-21374588273323330: PostgreSQL queues ordinary AccessShare readers
  // behind a waiting AccessExclusive DDL request. This is the generic form of
  // the migration-947 incident; keep it separate from the session_turn_parts
  // COPY-specific detector because it must catch any relation and any DDL
  // writer, including an older/deployed migration path.
  const waitingDdlByRelation = new Map<string, AccessExclusiveLockWaiter[]>();
  for (const waiter of snap.accessExclusiveLockWaiters ?? []) {
    const rows = waitingDdlByRelation.get(waiter.relation) ?? [];
    rows.push(waiter);
    waitingDdlByRelation.set(waiter.relation, rows);
  }
  const queuedReadersByRelation = new Map<string, AccessShareLockWaiter[]>();
  for (const reader of snap.accessShareLockWaiters ?? []) {
    if (!waitingDdlByRelation.has(reader.relation)) continue;
    const rows = queuedReadersByRelation.get(reader.relation) ?? [];
    rows.push(reader);
    queuedReadersByRelation.set(reader.relation, rows);
  }
  const lockConvoys = [...queuedReadersByRelation.entries()]
    .map(([relation, readers]) => ({
      relation,
      ddl: waitingDdlByRelation.get(relation) ?? [],
      readers,
    }))
    .filter(({ ddl, readers }) =>
      readers.some((reader) => ddl.some((waiter) => reader.pid !== waiter.pid)),
    );
  if (lockConvoys.length > 0) {
    const detail = lockConvoys
      .map(({ relation, ddl, readers }) => {
        const ddlDetail = ddl
          .map((waiter) =>
            `pid=${waiter.pid} app=${waiter.applicationName ?? 'unknown'} running=${waiter.durationSeconds.toFixed(1)}s${waiter.queryPreview ? ` query=${waiter.queryPreview}` : ''}`,
          )
          .join(' | ');
        const readerDetail = readers
          .map((reader) =>
            `pid=${reader.pid} app=${reader.applicationName ?? 'unknown'} running=${reader.durationSeconds.toFixed(1)}s${reader.queryPreview ? ` query=${reader.queryPreview}` : ''}`,
          )
          .join(' | ');
        return `${relation}: waiting AccessExclusiveLock [${ddlDetail}]; queued AccessShareLock [${readerDetail}]`;
      })
      .join('\n');
    out.push({
      title: 'coord invariant: waiting AccessExclusiveLock queues AccessShare readers',
      detail:
        `${lockConvoys.length} relation-level lock convoy(s) detected — a waiting DDL is blocking ordinary readers; ` +
        `this is the migration/backup lock-order inversion class.\n${detail}`,
      severity: 'major',
    });
  }
  // WI-3959: recurrence guard for the WI-3937/WI-3869 class — an unbounded
  // full-surface read against coord_event_log (8.04B rows / 48h of DB time in
  // the original incident, which starved the bg-host substrate drain into its
  // pass timeout). Fires MAJOR (not minor, like the other substrate-hygiene
  // checks above) because this class has already once taken the whole drain
  // down, not just left debris.
  const furnaces = snap.coordLogFurnaces.filter((f) => {
    // EI-9506: a backup/maintenance dump (pg_dump `COPY ... TO stdout`) reads the
    // whole table BY DESIGN — it is never an application furnace to bound. Exclude
    // it BEFORE any threshold leg: the rows/call leg below is immune to EI-9420's
    // min_exec suppression, so a full-table dump (~100k rows/call) would otherwise
    // flag as an unbounded scan forever with nothing to fix.
    if (isBackupOrMaintenanceStatement(f.queryPreview)) return false;
    // The rows/call leg stands on its own — a query that habitually returns a
    // huge row count IS the WI-3937 class regardless of how fast any one call
    // runs (see the "fires on rows/call alone" test).
    if (f.rowsPerCall > t.coordLogFurnaceRowsPerCall) return true;
    if (f.meanExecMs <= t.coordLogFurnaceMeanExecMs) return false;
    // EI-9420: the mean-exec-time leg alone is suppressed when this exact
    // statement has ALSO run fast at least once (min_exec_time under the
    // proven-fast-path bar) — proof the CURRENTLY DEPLOYED code already has a
    // bounded/indexed route for it, so the alarming mean is lifetime-average
    // debris from before that fix landed, not a live furnace. Unknown
    // min_exec_time (older snapshot shape) never suppresses.
    return f.minExecMs === undefined || f.minExecMs > t.coordLogFurnaceProvenFastPathMs;
  });
  if (furnaces.length > 0) {
    const lines = furnaces.map(
      (f) =>
        `  queryid=${f.queryid} calls=${f.calls} rows/call=${Math.round(f.rowsPerCall)} mean_exec_ms=${Math.round(f.meanExecMs)}${
          f.minExecMs !== undefined ? ` min_exec_ms=${Math.round(f.minExecMs)}` : ''
        } :: ${f.queryPreview}`,
    );
    const offenders = snap.coordLogActiveOffenders.length
      ? `\nCurrently-active client(s) matching the pattern (best-effort text correlation): ${snap.coordLogActiveOffenders
          .map((o) => `pid=${o.pid} app=${o.applicationName ?? 'unknown'} running=${o.durationSeconds.toFixed(1)}s`)
          .join(', ')}`
      : '';
    out.push({
      title: 'coord invariant: unbounded coord_event_log read pattern (furnace class)',
      detail: `${furnaces.length} coord_event_log-touching statement(s) averaging > ${t.coordLogFurnaceRowsPerCall} rows/call or > ${t.coordLogFurnaceMeanExecMs}ms mean exec time — an unbounded/near-unbounded scan (WI-3937/WI-3869 class):\n${lines.join('\n')}${offenders}`,
      severity: 'major',
    });
  }
  return out;
}

/** Coord identity for the monitor's own auto-remediation writes (mirrors the
 *  improvement-watchdog's synthetic identity, known-open-aging.ts). A system
 *  action runs in-process, so it attributes as a `principal` — never a real
 *  fleet agent, and never the bogus `'system-action'` that is not an
 *  IdentitySource (the original F-FIX-037 attempt did not type-check). */
const MONITOR_IDENTITY: AgentIdentity = {
  ownerId: 'system:coord-invariant-monitor',
  ownerLabel: 'system · coord-invariant-monitor',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Pure: the msg_ids of open handoffs older than the threshold — the set the
 *  monitor auto-accepts so a handoff nobody ever picked up is reaped instead of
 *  re-firing the stuck-handoff invariant every hour. Strict boundary, matching
 *  evaluateInvariants (age must EXCEED the window). Exported for unit tests. */
export function planStaleHandoffAccepts(
  open: { msg_id: string; ts: string }[],
  thresholdHours: number,
  nowMs: number,
): string[] {
  const threshold = thresholdHours * 3_600_000;
  return open.filter((h) => nowMs - Date.parse(h.ts) > threshold).map((h) => h.msg_id);
}

/** Auto-accept handoffs older than the threshold, BEFORE gatherSnapshot, so a
 *  handoff nobody ever accepted is reaped (with an audited `handoff_accepted`
 *  event that notifies the original hander) instead of persisting as a stuck
 *  invariant violation that re-files every pass. Best-effort — a failure never
 *  aborts the pass. Returns the count of auto-accepted handoffs. */
async function autoAcceptStaleHandoffs(thresholdHours: number): Promise<number> {
  try {
    const open = await listHandoffs({ status: 'open' });
    const toAccept = planStaleHandoffAccepts(
      open.map((h) => ({ msg_id: h.record.msg_id, ts: h.record.ts })),
      thresholdHours,
      Date.now(),
    );
    let count = 0;
    for (const msgId of toAccept) {
      const accepted = await acceptHandoff(
        MONITOR_IDENTITY,
        msgId,
        `auto-accepted after ${thresholdHours}h pending (system:coord-invariant-monitor)`,
      );
      if (accepted) count++;
    }
    return count;
  } catch {
    // Best-effort — a failure here never aborts the pass.
    return 0;
  }
}

/**
 * EI-8786: drain stale OPERATIONAL escalations IN-PASS, immediately before the
 * invariant measures them — exactly like the sibling handoff check
 * (autoAcceptStaleHandoffs) and wake-queue checks (sweepDeadOwnerPendingWakes /
 * sweepStalePendingWakes) already do above. Before this, the escalation invariant
 * ONLY measured, relying on the SEPARATE hourly attentionReconcile DBOS tick (:20)
 * having drained the operational backlog before this monitor runs (:37). A missed /
 * shed / stalled / cadence-lagged reconcile tick then leaves an operational
 * escalation past the TTL at measure time, firing this "minor" EI on tick-timing
 * noise rather than a genuine drain failure — the ESCALATION_RECONCILE_GRACE_MS 1h
 * grace only partially covers the tick cadence race and does NOT cover a missed/down
 * tick at all (observed live: an operational escalation open at 49.5h while the
 * separate reconcile tick had not resolved anything for 8h). Draining here makes the
 * check SELF-HEALING: after this the invariant fires ONLY when the reconcile ITSELF
 * cannot drain an operational escalation (a real stuck row), never because a separate
 * tick was late or down. Best-effort — a drain failure never aborts the pass (the
 * invariant then measures the un-drained state and files, which is the correct
 * fail-open behavior). The reconcile is injectable for unit tests; the default is the
 * live sweep, scoped (like gatherSnapshot) to this monitor's active workspace.
 * Returns the number of escalations resolved.
 */
export async function drainOperationalEscalationsBeforeMeasure(
  reconcile: () => Promise<{ resolved: number }> = reconcileStaleEscalationsOnce,
): Promise<number> {
  try {
    const r = await reconcile();
    return r.resolved;
  } catch {
    return 0;
  }
}

/**
 * WI-3959: pg_stat_statements rows touching `coord_event_log`, top-N by
 * rows/call. Best-effort — the extension is superuser-only / opt-in (see
 * sql/002-tables.sql), so an unavailable extension (undefined_table /
 * undefined_function) degrades to an empty list, same as every other check
 * here. Exported for unit tests (injectable sql).
 */
export async function gatherCoordLogFurnaceStatements(
  sql: postgres.Sql,
  limit = 10,
): Promise<CoordLogFurnaceStatement[]> {
  const rows = await sql<
    { queryid: string; query_preview: string; calls: string; rows: string; mean_exec_time: number; min_exec_time: number }[]
  >`
    SELECT
      queryid::text AS queryid,
      -- EI-9447: 300 was cutting off a query's trailing clauses (a real
      -- LIMIT clause routinely fell just past the boundary) — the forensics
      -- then read identically to a genuinely-unbounded scan, misdirecting
      -- triage toward the wrong fix. 600 comfortably covers every real
      -- coord_event_log statement in this codebase (verified: none exceeds
      -- ~420 chars) while still never returning a truly huge ad-hoc string.
      LEFT(query, 600) AS query_preview,
      calls::text AS calls,
      rows::text AS rows,
      mean_exec_time,
      min_exec_time
    FROM pg_stat_statements
    WHERE query ILIKE '%coord_event_log%'
      AND calls > 0
      -- EI-9506 / EI-9533: exclude backup/maintenance statements — a pg_dump-style
      -- COPY ... TO stdout, and autovacuum/maintenance VACUUM [ANALYZE] / ANALYZE.
      -- None is an application read pattern, so none must be judged a furnace nor
      -- consume a top-N diagnostic slot. The COPY dump (ranked by rows/call DESC)
      -- always would -- ~100k rows/call outranks every real query, masking a genuine
      -- furnace at rank 11+; a slow VACUUM/ANALYZE (live-observed 2.4–3.4s on this
      -- table) would trip the MEAN-exec leg. evaluateInvariants excludes the same set
      -- via isBackupOrMaintenanceStatement, as defense-in-depth. (Prefix ILIKEs, not a
      -- regex word boundary: Postgres regex treats \b as backspace, so ~* '\bVACUUM'
      -- would not match — the JS predicate uses \b correctly in its own regex flavor.)
      AND query NOT ILIKE 'COPY %'
      AND query NOT ILIKE 'VACUUM %'
      AND query NOT ILIKE 'ANALYZE %'
    ORDER BY (rows::float8 / GREATEST(calls, 1)) DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => {
    const calls = Number(r.calls);
    return {
      queryid: r.queryid,
      queryPreview: r.query_preview,
      calls,
      rowsPerCall: Number(r.rows) / Math.max(calls, 1),
      meanExecMs: r.mean_exec_time,
      // EI-9420: proven-fast-path discriminator — see CoordLogFurnaceStatement.minExecMs.
      minExecMs: r.min_exec_time,
    };
  });
}

/**
 * WI-3959: currently-running queries whose text also touches
 * `coord_event_log` — best-effort forensics (pg_stat_activity, mirrors
 * dev:pg_active_queries) so a furnace violation can name a live offender's
 * application_name/pid when caught mid-scan. Exported for unit tests.
 */
export async function gatherCoordLogActiveOffenders(sql: postgres.Sql, limit = 10): Promise<CoordLogActiveOffender[]> {
  const rows = await sql<{ pid: number; application_name: string | null; duration_seconds: number }[]>`
    SELECT pid, application_name, EXTRACT(EPOCH FROM (now() - query_start))::float AS duration_seconds
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND state = 'active'
      AND query ILIKE '%coord_event_log%'
    ORDER BY query_start ASC NULLS LAST
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ pid: r.pid, applicationName: r.application_name, durationSeconds: r.duration_seconds }));
}

/** EI-21363741549000811: gather only the live COPY holders and queued relation
 *  waiters for the faithful transcript parts table. Both result sets are
 *  explicitly capped because this routine runs on the hourly monitor path. */
export async function gatherSessionTurnPartsCopyLocks(
  sql: postgres.Sql,
  holderLimit = 10,
  waiterLimit = 20,
): Promise<{
  copyHolders: SessionTurnPartsCopyHolder[];
  lockWaiters: SessionTurnPartsLockWaiter[];
}> {
  const holders = await sql<
    { pid: number; application_name: string | null; duration_seconds: number }[]
  >`
    SELECT DISTINCT ON (a.pid)
      a.pid,
      a.application_name,
      COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start)), 0)::float AS duration_seconds
    FROM pg_stat_activity a
    JOIN pg_locks l
      ON l.pid = a.pid
     AND l.relation = 'harness_shared.session_turn_parts'::regclass
     AND l.granted
    WHERE a.datname = current_database()
      AND a.state = 'active'
      AND a.query ~* '^[[:space:]]*COPY[[:space:]]+harness_shared[.]session_turn_parts([[:space:](]|$)'
    ORDER BY a.pid, a.query_start ASC
    LIMIT ${holderLimit}
  `;
  const waiters = await sql<
    { pid: number; application_name: string | null; mode: string; duration_seconds: number; query_preview: string | null }[]
  >`
    SELECT
      a.pid,
      a.application_name,
      l.mode,
      COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start)), 0)::float AS duration_seconds,
      LEFT(a.query, 400) AS query_preview
    FROM pg_stat_activity a
    JOIN pg_locks l
      ON l.pid = a.pid
     AND l.relation = 'harness_shared.session_turn_parts'::regclass
     AND NOT l.granted
    WHERE a.datname = current_database()
      AND a.pid <> pg_backend_pid()
    ORDER BY a.query_start ASC NULLS LAST
    LIMIT ${waiterLimit}
  `;
  return {
    copyHolders: holders.map((row) => ({
      pid: row.pid,
      applicationName: row.application_name,
      durationSeconds: Number(row.duration_seconds),
    })),
    lockWaiters: waiters.map((row) => ({
      pid: row.pid,
      applicationName: row.application_name,
      mode: row.mode,
      durationSeconds: Number(row.duration_seconds),
      queryPreview: row.query_preview,
    })),
  };
}

/** EI-21374588273323330: gather bounded generic relation-lock waiters. The
 * two snapshots are intentionally separate so evaluateInvariants can require
 * same-relation overlap; a lone waiting DDL or lone queued reader is not yet
 * the lock-order inversion this detector exists to catch. */
export async function gatherGenericRelationLockWaiters(
  sql: postgres.Sql,
  limit = 20,
): Promise<{
  accessExclusiveWaiters: AccessExclusiveLockWaiter[];
  accessShareWaiters: AccessShareLockWaiter[];
}> {
  type Row = {
    relation: string;
    pid: number;
    application_name: string | null;
    duration_seconds: number;
    query_preview: string | null;
  };
  const [exclusiveRows, shareRows] = await Promise.all([
    sql<Row[]>`
      SELECT
        n.nspname || '.' || c.relname AS relation,
        a.pid,
        a.application_name,
        COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start)), 0)::float AS duration_seconds,
        LEFT(a.query, 400) AS query_preview
      FROM pg_stat_activity a
      JOIN pg_locks l
        ON l.pid = a.pid
       AND l.locktype = 'relation'
       AND l.mode = 'AccessExclusiveLock'
       AND NOT l.granted
      JOIN pg_class c ON c.oid = l.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.datname = current_database()
        AND a.pid <> pg_backend_pid()
      ORDER BY a.query_start ASC NULLS LAST
      LIMIT ${limit}
    `,
    sql<Row[]>`
      SELECT
        n.nspname || '.' || c.relname AS relation,
        a.pid,
        a.application_name,
        COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start)), 0)::float AS duration_seconds,
        LEFT(a.query, 400) AS query_preview
      FROM pg_stat_activity a
      JOIN pg_locks l
        ON l.pid = a.pid
       AND l.locktype = 'relation'
       AND l.mode = 'AccessShareLock'
       AND NOT l.granted
      JOIN pg_class c ON c.oid = l.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.datname = current_database()
        AND a.pid <> pg_backend_pid()
      ORDER BY a.query_start ASC NULLS LAST
      LIMIT ${limit}
    `,
  ]);
  const mapRow = (row: Row) => ({
    relation: row.relation,
    pid: row.pid,
    applicationName: row.application_name,
    durationSeconds: Number(row.duration_seconds),
    queryPreview: row.query_preview,
  });
  return {
    accessExclusiveWaiters: exclusiveRows.map(mapRow),
    accessShareWaiters: shareRows.map(mapRow),
  };
}

/** Gather the live snapshot. Every leg is isolated — a failing query zeroes
 *  its own check (and notes it), never the fire. */
async function gatherSnapshot(t: InvariantThresholds): Promise<InvariantSnapshot> {
  const snap: InvariantSnapshot = {
    openHandoffTs: [],
    openEscalations: [],
    longExpiredLocks: 0,
    presenceGhosts: 0,
    wakeQueueDepth: 0,
    wakeQueueOldestMs: null,
    coordLogFurnaces: [],
    coordLogActiveOffenders: [],
    sessionTurnPartsCopyHolders: [],
    sessionTurnPartsLockWaiters: [],
    accessExclusiveLockWaiters: [],
    accessShareLockWaiters: [],
  };
  try {
    snap.openHandoffTs = (await listHandoffs({ status: 'open' })).map((h) => h.record.ts);
  } catch {
    /* check degraded */
  }
  try {
    snap.openEscalations = (await listEscalations({ status: 'open' })).map((e) => ({
      ts: e.ts,
      from: e.from ?? null,
      hasOptions: Array.isArray(e.options) && e.options.length > 0,
      // Escalation metadata is flattened onto the record by openEscalation;
      // carry the explicit emitter-owned markers into the invariant snapshot.
      livenessSignature: (e as Record<string, unknown>).livenessSignature,
      selfReconciling: (e as Record<string, unknown>).selfReconciling,
    }));
  } catch {
    /* check degraded */
  }
  try {
    const sql = getTxPool();
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM agent_file_locks
      WHERE expires_ts < now() - make_interval(mins => ${t.expiredLockGraceMin})`;
    snap.longExpiredLocks = Number(rows[0]?.n ?? 0);
  } catch {
    /* check degraded */
  }
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.coord_presence
      WHERE heartbeat_at < now() - make_interval(hours => ${t.presenceGhostHours})`;
    snap.presenceGhosts = Number(rows[0]?.n ?? 0);
  } catch {
    /* check degraded */
  }
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ n: string; oldest: string | null }[]>`
      SELECT count(*)::text AS n, min(created_at)::text AS oldest
      FROM harness_shared.pending_wakes`;
    snap.wakeQueueDepth = Number(rows[0]?.n ?? 0);
    snap.wakeQueueOldestMs = rows[0]?.oldest ? Date.parse(rows[0].oldest) : null;
  } catch {
    /* check degraded */
  }
  try {
    const { sql } = getOrgPg();
    snap.coordLogFurnaces = await gatherCoordLogFurnaceStatements(sql);
  } catch {
    // pg_stat_statements is superuser-only / opt-in — commonly absent (embedded-pg,
    // a fresh/unprivileged box). Degrades to an empty list, same as every other leg.
  }
  try {
    const { sql } = getOrgPg();
    snap.coordLogActiveOffenders = await gatherCoordLogActiveOffenders(sql);
  } catch {
    /* check degraded */
  }
  try {
    const { sql } = getOrgPg();
    const partsLocks = await gatherSessionTurnPartsCopyLocks(sql);
    snap.sessionTurnPartsCopyHolders = partsLocks.copyHolders;
    snap.sessionTurnPartsLockWaiters = partsLocks.lockWaiters;
  } catch {
    /* check degraded */
  }
  try {
    const { sql } = getOrgPg();
    const relationLocks = await gatherGenericRelationLockWaiters(sql);
    snap.accessExclusiveLockWaiters = relationLocks.accessExclusiveWaiters;
    snap.accessShareLockWaiters = relationLocks.accessShareWaiters;
  } catch {
    /* check degraded */
  }
  return snap;
}

// ── shared-hive-loop P-012/P-013: the multi-swarm dispatch checks ───────────
// (shared-hive-loop-e2e-testing-2026-06-10; plugs into THIS home per both
// briefs — checks live in shared-pot-loop/fleet-monitors.ts, proven on the
// hermetic 2-swarm rig. Scope discovery: every harness with work_item_claims
// rows in this workspace — i.e. exactly where the distributed lease layer is
// actually in use; zero rows ⇒ the leg is a no-op.)

/** Stable dedup titles per incident kind (a persisting incident re-files into
 *  its open improvement instead of flooding).
 *
 * ⚠ EI-20579195481991931 — THE TITLE ALONE IS NOT A SIGNAL IDENTITY, AND RELYING
 * ON IT SILENTLY LOSES EVERY SCOPE BUT THE FIRST. These titles differ only by a
 * harness proper noun, and `captureImprovement`'s HARD-semantic dedup band scores
 * that pair as the same signal — so the second scope to breach in a pass is
 * declined as a duplicate of the first. MEASURED on the 2026-08-16T11:40Z pass:
 * `…silence in hello-world-3-pot` was created 11:40:06.128Z (2 of 3 logs silent)
 * and `…silence in papercusp` was swallowed as `duplicate` 11:40:08.172Z — the
 * WORSE breach (20 of 21 logs silent, and the scope the original report was
 * about) absorbed into the milder one, with the winner decided by nothing more
 * than the unordered `GROUP BY harness_slug` scan order. Proof survives in
 * `harness_shared.work_item_occurrences` (report_kind='duplicate').
 *
 * `watchdogKey` is the fix the capture rail already provides: a candidate
 * carrying a DIFFERENT key is a different signal and can never decline this
 * capture, while the SAME key stays an exact indexed match — so cross-TICK
 * dedup (the behaviour these stable titles exist for) is preserved, and only
 * the cross-SCOPE collapse is removed.
 */
export function planSharedHiveCapture(
  incident: MonitorIncident,
  harness: string,
): { title: string; severity: 'critical' | 'major' | 'minor' | 'nit'; watchdogKey: string } | null {
  // Returning an orphaned claim to the backlog is the monitor's intended,
  // healthy recovery path—not a defect. Keep the incident available to the
  // caller for the holder notification below, but do not manufacture a
  // permanent backlog bug for every successful sweep.
  if (incident.kind === 'orphaned-taken-by') return null;

  // Per-(kind, harness) so two scopes breaching the same way in one pass are two
  // signals. Built here rather than at the call site so title and identity cannot
  // drift apart — a per-harness title with a shared key is the same bug again.
  const key = `shared-hive:${incident.kind}:${harness}`;
  switch (incident.kind) {
    case 'double-completion':
      return {
        title: `shared-hive invariant: cross-swarm double completion in ${harness}`,
        severity: 'major',
        watchdogKey: key,
      };
    case 'outbox-health':
      // Harness-scoped like every sibling: `scanOutboxHealth` is already called
      // per harness, so a single global title made harness A's depth breach mask
      // harness B's — the same collapse as above, reached through the title
      // instead of the semantic band.
      return {
        title: `shared-hive invariant: substrate outbox depth/age breach in ${harness}`,
        severity: 'major',
        watchdogKey: key,
      };
    case 'presence-ghost':
      return {
        title: `shared-hive invariant: presence ghost anchoring live leases in ${harness}`,
        severity: 'minor',
        watchdogKey: key,
      };
    // EI-20579195481991931 — a peer that stops federating is the failure a p2p
    // system must not miss, so it outranks the local-hygiene incidents above.
    case 'peer-federation-silence':
      return {
        title: `shared-hive invariant: peer federation silence in ${harness}`,
        severity: 'major',
        watchdogKey: key,
      };
    // EI-21322935352272541 — "this host admits no remote log in ANY scope" is a
    // fact about the HOST, exactly like `monitor-scope-empty` below is a fact
    // about the pass, so it takes the same NON-harness-scoped key. Scoping it per
    // harness is the defect: 45 scopes on this host held durable remote cursors
    // while 101/101 admitted only their own log, so one condition would file up
    // to 45 majors — and which of them fired was decided by the unrelated
    // scope-dormancy guard, not by the fault. No scope-local action can clear any
    // of them, because admission is not a per-scope capability.
    case 'host-admits-no-remote-logs':
      return {
        title: 'shared-hive invariant: this host admits NO remote log in ANY booted scope',
        severity: 'major',
        watchdogKey: `shared-hive:${incident.kind}`,
      };
    case 'monitor-scope-empty':
      // Deliberately NOT harness-scoped: "the pass resolved zero scopes" is a
      // fact about the whole pass, so there is no harness to scope it to.
      return {
        title: 'shared-hive invariant: monitor resolved ZERO scopes on a federating host',
        severity: 'major',
        watchdogKey: `shared-hive:${incident.kind}`,
      };
  }
}

/** A scope-discovery row before the workspace-global-label filter is applied. */
export interface RawSharedHiveScope {
  harness_slug: string;
  pot_slug: string | null;
}

// EI-21051034011804969: `work_item_claims`/`plan_item_claims` legitimately key an
// OPERATOR-SCOPE issue claim's `harness_slug` as the workspace-global label
// `operator:<workspaceId>` (get-next.ts's `operatorScopeSlug`) — never a real,
// bootable Pot/harness identity. That label is NOT a scope any of the four
// per-harness shared-hive invariants below (double-completion, outbox health,
// presence ghosts, orphaned taken_by) can be meaningfully computed against:
// `capture_work_items_outbox()`'s own operator-scope branch (mig 454/829)
// NEVER writes that literal string into `substrate_outbox.harness_slug` — it
// always resolves to the workspace's single Pot home slug, or drops the write
// entirely (with a `substrate_outbox_gap` notify) when 0/>1 Pot homes exist.
// So a transient/mis-routed capture that DOES carry a workspace-global label
// (the same "workspace mis-route to a non-Pot scope" class
// substrate-outbox-backstop-gc.ts's NON_REGISTRY reap already exists for) is
// orphaned debris the backstop GC is already responsible for reaping — not a
// genuine per-harness drain-loop defect a worker can fix. Filing a
// "shared-hive invariant" bug against a phantom `operator:<ws>` pseudo-harness
// is the exact perpetual-false-positive shape outbox-drain-quarantine-runbook.md
// documents, just reached via scope DISCOVERY instead of the SLO query itself.
// `isWorkspaceGlobalLabel` (pot-membership.ts, P-005) is the existing,
// purpose-built classifier for exactly this distinction — reused here rather
// than re-deriving a second `operator:` prefix check.
//
// Extracted as its own exported, PG-free function (rather than left inline) so
// THIS fix carries a direct regression test: a revert that dropped the
// `operator:` prefix exclusion (or the call to it below) fails
// `filterSharedHiveScopes`'s suite in coord-invariant-actions.test.ts without
// needing a full PG-backed `runSharedHiveLeg` fixture.

/**
 * EI-21100148946854844 — a WORK-ITEM ID is not a harness/Pot scope either, and
 * for the identical reason `isWorkspaceGlobalLabel` above exists: a bogus
 * `harness_slug` value that reached one of the three scope-discovery sources
 * (`work_item_claims`/`plan_item_claims`/`substrate_outbox`) — e.g. a caller
 * that passed a work-item id where a harness slug was expected — produces a
 * "shared-hive invariant: … breach in WI-40022" alarm that nobody can ever act
 * on: `WI-40022` is not a registered harness, so there is no drain loop to fix
 * and no owner who could green it. Every real harness slug this repo mints is
 * lowercase kebab-case (`harness:create`'s own `^[a-z0-9][a-z0-9-]*$`), which a
 * `(WI|F|EI)-<digits>` id can never match (the family prefix is upper-case),
 * so this exclusion can never falsely drop a genuine harness/Pot scope.
 *
 * Reuses the canonical `WORK_ITEM_ID_PATTERN` (work-items.ts) rather than
 * re-deriving the family-prefix regex here, so this check tracks that pattern
 * if it is ever extended with a new family prefix.
 */
const WORK_ITEM_ID_RE = new RegExp(WORK_ITEM_ID_PATTERN);

/** Is `slug` shaped like a work-item id (`WI-123`, `EI-456`, `F-789`) rather
 *  than a harness/Pot slug? Exported for the regression test (mirrors
 *  `isWorkspaceGlobalLabel`'s own exported-for-testing shape). */
export function looksLikeWorkItemId(slug: string): boolean {
  return WORK_ITEM_ID_RE.test(slug.trim());
}

export function filterSharedHiveScopes(
  rawScopes: readonly RawSharedHiveScope[],
  workspaceId: string,
  /**
   * EI-21111467164675531 — harness slugs with a possible drain-loop owner
   * right now (a `harness_registry` entry or a currently-started pot; see
   * `loadKnownOutboxOwnerSlugs`, substrate-outbox-backstop-gc.ts). A scope
   * whose harness_slug is ABSENT from this set can never boot a drain loop —
   * its undrained rows are the backstop GC's job alone (that module's
   * NON_REGISTRY reap leg), not a genuine per-harness defect this monitor can
   * ever get anyone to fix. `undefined` (the default) preserves today's
   * unconditional scope-inclusion behavior — e.g. when the registry lookup
   * itself failed, this MUST fail OPEN (scan every scope) rather than
   * silently suppressing all of them, the same "omitted preserves prior
   * behavior" contract `scanOutboxHealth`'s `residentInProcess` already uses.
   */
  knownOwnerSlugs?: ReadonlySet<string>,
): RawSharedHiveScope[] {
  return rawScopes.filter(
    (s) =>
      !isWorkspaceGlobalLabel(s.harness_slug, workspaceId) &&
      !looksLikeWorkItemId(s.harness_slug) &&
      (knownOwnerSlugs === undefined || knownOwnerSlugs.has(s.harness_slug)),
  );
}

async function runSharedHiveLeg(ctx: SystemActionCtx): Promise<void> {
  const { sql } = getOrgPg();
  // EI-20579195481991931 — SCOPE DISCOVERY USED TO READ `work_item_claims` ALONE,
  // and that table is EMPTY GLOBALLY on this deployment (0 rows; the live claim
  // layer is `plan_item_claims`, and `work_item_claims` has no production
  // writers left — only tests, migrations and one identity-rebind UPDATE). Zero
  // scopes ⇒ the loop below never executed ⇒ the ENTIRE shared-hive monitor
  // family (outbox health, double-completion, presence ghosts, orphan sweep) was
  // a silent no-op on a host carrying 245,717 outbox rows across 10 harnesses.
  // The old comment called that intended ("zero rows ⇒ the leg is a no-op") on
  // the premise that claims exist wherever the lease layer is in use; the
  // premise is false, and its failure was indistinguishable from health.
  //
  // Discovery now unions the LEASE layers with `substrate_outbox` itself. That
  // last source is the load-bearing one: the outbox is the very thing
  // `scanOutboxHealth` measures, so including it makes it IMPOSSIBLE for a
  // harness with outbox rows to fall outside the scan's scope — the coverage
  // gap is closed by construction rather than by remembering to add sources.
  const rawScopes = await sql<{ harness_slug: string; pot_slug: string | null }[]>`
    SELECT harness_slug, MIN(pot_slug) AS pot_slug FROM (
      SELECT harness_slug, pot_slug FROM harness_shared.work_item_claims
       WHERE workspace_id = ${ctx.workspaceId}
      UNION
      SELECT harness_slug, NULL::text AS pot_slug FROM harness_shared.plan_item_claims
       WHERE workspace_id = ${ctx.workspaceId}
      UNION
      SELECT harness_slug, NULL::text AS pot_slug FROM harness_shared.substrate_outbox
       WHERE workspace_id = ${ctx.workspaceId}
    ) s
     GROUP BY harness_slug`;

  // EI-21051034011804969 — see `filterSharedHiveScopes`'s doc comment above for
  // why a workspace-global pseudo-harness label (e.g. `operator:<workspaceId>`)
  // must never reach the per-harness shared-hive scans below.
  const scopes = filterSharedHiveScopes(rawScopes, ctx.workspaceId);

  // THE CLASS FIX: a monitor that resolved nothing to monitor must never return
  // quietly. If we federate (outbox rows exist) yet resolved zero scopes, the
  // pass did not run — a fact that is otherwise reported as, and acted on as,
  // health. File it as loudly as any invariant breach.
  if (scopes.length === 0) {
    const [{ n: outboxRows } = { n: 0 }] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox
       WHERE workspace_id = ${ctx.workspaceId}`;
    if (outboxRows > 0) {
      await captureImprovement({
        title: 'shared-hive invariant: monitor resolved ZERO scopes on a federating host',
        kind: 'bug',
        severity: 'major',
        dedupScope: 'open',
        foundDuring: 'system:coord-invariant-monitor (shared-hive leg)',
        subTopic: 'shared-hive',
        body:
          `The shared-hive monitor leg resolved 0 scopes while harness_shared.substrate_outbox holds ${outboxRows} row(s) ` +
          `for this workspace. Every downstream scan (outbox health, double-completion, presence ghosts, peer federation ` +
          `silence, orphan sweep) was therefore SKIPPED — the pass reported nothing because it examined nothing, which is ` +
          `not the same as healthy.\n\n(EI-20579195481991931; check source: ` +
          `packages/operator-core/lib/harness/routines/coord-invariant-actions.ts runSharedHiveLeg.)`,
      }).catch(() => {
        /* the contradiction report must not abort the pass */
      });
    }
  }

  for (const scope of scopes) {
    try {
      // The orphan sweep runs only on the elected authority for the scope
      // (sweepOrphanedTakenBy's contract); resolution failure ⇒ scan-only.
      let isAuthority = false;
      try {
        isAuthority = (await lockAuthorityForHive(scope.pot_slug ?? scope.harness_slug)).isSelf;
      } catch {
        isAuthority = false;
      }
      let presence: PresenceRow[] = [];
      let liveLeases: LeaseHolderRow[] = [];
      try {
        const rows = await sql<{ device_pubkey: string; last_seen_ms: string }[]>`
          SELECT device_pubkey, (extract(epoch FROM last_seen_at) * 1000)::bigint::text AS last_seen_ms
            FROM harness_shared.shared_presence
           WHERE workspace_id = ${ctx.workspaceId}
             AND ${scope.pot_slug ? sql`pot_slug = ${scope.pot_slug}` : sql`TRUE`}`;
        presence = rows.map((r) => ({ devicePubkey: r.device_pubkey, lastSeenMs: Number(r.last_seen_ms) }));
        const leases = await sql<{ work_item_id: string; holder_pubkey: string | null; expires_ms: string }[]>`
          SELECT work_item_id, holder_pubkey, (extract(epoch FROM expires_ts) * 1000)::bigint::text AS expires_ms
            FROM harness_shared.work_item_claims
           WHERE workspace_id = ${ctx.workspaceId} AND harness_slug = ${scope.harness_slug}`;
        liveLeases = leases.map((l) => ({
          workItemId: l.work_item_id,
          holderPubkey: l.holder_pubkey,
          expiresTsMs: Number(l.expires_ms),
        }));
      } catch {
        /* presence/lease legs degraded — the PG scans below still run */
      }
      // EI-21096375006041139: this process's own boot-residency for the scope —
      // if `getBootedHarness` is null, no outbox-drain loop can possibly be
      // running for it right now, so an aged (but not oversized) backlog is
      // expected/self-healing, not a stuck drain. See scanOutboxHealth's
      // `residentInProcess` doc for the full rationale; the DEPTH leg (storage
      // bloat) is unaffected and still fires unconditionally.
      const residentInProcess = getBootedHarness(ctx.workspaceId, scope.harness_slug) != null;
      await runSharedHiveMonitorPass({
        sql,
        workspaceId: ctx.workspaceId,
        harness: scope.harness_slug,
        isAuthority,
        presence,
        liveLeases,
        residentInProcess,
        fileIncident: async (incident) => {
          const plan = planSharedHiveCapture(incident, scope.harness_slug);
          if (plan) {
            await captureImprovement({
              title: plan.title,
              kind: 'bug',
              severity: plan.severity,
              dedupScope: 'open',
              // EI-20579195481991931: without this, the second scope to breach in a
              // pass is declined as a hard-semantic duplicate of the first (see
              // planSharedHiveCapture). Same key across ticks still dedups exactly.
              watchdogKey: plan.watchdogKey,
              foundDuring: 'system:coord-invariant-monitor (shared-hive leg)',
              subTopic: 'shared-hive',
              body: `${incident.title}\n\nForensics: ${JSON.stringify(incident.detail)}\n(shared-hive-loop-e2e-testing-2026-06-10 P-012/P-013; check source: packages/operator-core/lib/shared-pot-loop/fleet-monitors.ts.)`,
            }).catch(() => {
              /* a capture failure must not abort the remaining incidents */
            });
          }
          // WI-39736 fix property 2 — an involuntary release must NOTIFY the holder,
          // not only leave an audit trail. The filed improvement above is a backlog
          // row nobody reads in time; the holder is the one party who is, right now,
          // still working an item it no longer holds.
          if (incident.kind === 'orphaned-taken-by') {
            await notifySweptHolders(ctx.workspaceId, scope.harness_slug, incident.detail).catch(() => {
              /* a notice-delivery failure must not abort the remaining incidents */
            });
          }
        },
      });
    } catch {
      /* one scope's failure never aborts the others */
    }
  }
}

// ── WI-39736: tell a swept holder its claim was taken ────────────────────────
//
// `sweepOrphanedTakenBy` clears a claim whose holder it judges DEAD (no live and
// no briefly-parked presence row, EI-20723522274831539). That judgement has ONE
// deliberate blind spot, documented on the sweep's victim predicate: it does NOT
// copy the sibling reaper's WI-1999 known-holder clause, because requiring it
// would defer the dead peer-SWARM reclaim this sweep exists for. So a holder that
// is genuinely ALIVE on another machine, with no local coord_presence row, is
// still swept — and until this notice it was swept SILENTLY. That is exactly the
// shape of the WI-39736 incident: the agent keeps working an item the fleet has
// already handed to someone else, and neither side is told.
//
// The notice is best-effort by design. A truly dead holder cannot be woken, and
// the filed improvement above remains the durable record for that case; the wake
// costs nothing when it misses and is the whole point when it lands.

export interface OrphanSweepNotice {
  /** Holder + its fleet leader (when resolvable), the wake/send targets. */
  targets: string[];
  holderOwnerId: string;
  workItemIds: string[];
  summary: string;
}

/**
 * Pure: group one pass's swept rows by HOLDER (one notice per holder, never one
 * per item — a swarm death frees many items in a single statement and N wakes to
 * the same owner is a storm, not a signal) and address each notice to the holder
 * plus its fleet leader. Exported for unit tests.
 */
export function planOrphanSweepNotices(
  cleared: ReadonlyArray<{ workItemId: string; takenBy: string }>,
  leaderByOwner: ReadonlyMap<string, string | null>,
  harness: string,
): OrphanSweepNotice[] {
  const byHolder = new Map<string, string[]>();
  for (const row of cleared) {
    const holder = (row.takenBy ?? '').trim();
    // A reaper marker can never be a real ownerId; a blank holder has nobody to tell.
    if (!holder || holder.startsWith('reaper:') || holder.startsWith('system:')) continue;
    const ids = byHolder.get(holder) ?? [];
    if (row.workItemId) ids.push(row.workItemId);
    byHolder.set(holder, ids);
  }
  const notices: OrphanSweepNotice[] = [];
  for (const [holderOwnerId, workItemIds] of byHolder) {
    const leader = leaderByOwner.get(holderOwnerId) ?? null;
    const targets = leader && leader !== holderOwnerId ? [holderOwnerId, leader] : [holderOwnerId];
    const shown = workItemIds.slice(0, 5).join(', ');
    const more = workItemIds.length > 5 ? ` (+${workItemIds.length - 5} more)` : '';
    notices.push({
      targets,
      holderOwnerId,
      workItemIds,
      summary:
        `Your claim on ${workItemIds.length} item(s) was RELEASED by the orphan sweep (${harness}): ` +
        `${shown}${more} — re-claim if you are still working them.`,
    });
  }
  return notices;
}

async function notifySweptHolders(
  workspaceId: string,
  harness: string,
  detail: MonitorIncident['detail'],
): Promise<void> {
  const cleared = Array.isArray(detail)
    ? (detail as Array<{ workItemId?: unknown; takenBy?: unknown }>)
        .filter((r) => r && typeof r.workItemId === 'string' && typeof r.takenBy === 'string')
        .map((r) => ({ workItemId: r.workItemId as string, takenBy: r.takenBy as string }))
    : [];
  if (cleared.length === 0) return;
  const leaderByOwner = await resolveLeadersForHolders(workspaceId, [
    ...new Set(cleared.map((c) => c.takenBy)),
  ]).catch(() => new Map<string, string | null>());
  for (const notice of planOrphanSweepNotices(cleared, leaderByOwner, harness)) {
    try {
      await sendMessage(MONITOR_IDENTITY, {
        to: notice.targets,
        summary: notice.summary,
        body:
          `The hourly coord-invariant-monitor orphan sweep judged you DEAD (no live and no briefly-parked ` +
          `presence heartbeat) and returned these items to the backlog on harness ${harness}: ` +
          `${notice.workItemIds.join(', ')}.\n\n` +
          `Their taken_by/taken_at were cleared and last_released_by set to 'reaper:orphan-sweep'. If you ` +
          `are in fact still working any of them, RE-CLAIM now (work_items:claim) — the scheduler can hand ` +
          `them to another agent while you hold nothing, which is a genuine double-placement.\n\n` +
          `(WI-39736 / EI-20723522274831539; check source: ` +
          `packages/operator-core/lib/shared-pot-loop/fleet-monitors.ts sweepOrphanedTakenBy.)`,
        category: 'orphan-sweep-release',
      });
      await wakeRecipients(notice.targets, {
        summary: notice.summary,
        source: MONITOR_IDENTITY.ownerId,
      });
    } catch {
      /* one holder's notice failing never suppresses the rest */
    }
  }
}

// ── EI-8999 / fleet-reliability-verification-2026-07-10 P-001: claim-integrity
//    invariant sweep ──────────────────────────────────────────────────────────
//
// Every OTHER check in this file files a deduped `captureImprovement` — a
// backlog bug nobody urgently looks at (the right shape for "handoffs stuck
// pending" or "presence ghosts lingering", which are slow leaks). Claim
// integrity is different: it is a LIVE double-placement risk RIGHT NOW — two
// agents can genuinely collide on the same item while the desync persists.
// P-001 (2026-07-09/10 night shift, found-by-hand 6x: WI-3487 x4, WI-3490,
// WI-3583) asks for an ALARM — a directed, woken message to the affected
// holder AND its fleet leader — not a nudge. This still ALSO files a deduped
// improvement (the durable audit trail + the catch-all when nobody is
// reachable to wake), but the alarm is the primary signal.
//
// ORPHANED WIP — a work_item is `wip` with taken_by/assignee NULL, yet its
// linked plan-item shows a LIVE (non-expired) plan_item_claims lease held by
// someone with a fresh presence heartbeat. The work-item's own claim tracking
// (taken_by) has desynced from the plan-item claim (the authoritative live
// lease) while a real session is still working it — a genuine desync worth an
// alarm.
//
// EI-10506 — a SECOND check ("unbacked active assignment": an active
// plan_item_assignments row whose live assignee holds no plan_item_claims
// lease) was REMOVED here. Its premise ("the durable assignment is
// unprotected: a peer can double-claim this item right now") is FALSE: an
// assignment is the anti-double-claim anchor, not a gap. `claimPlanItem`
// (liveness.ts, D-004) REFUSES any non-assignee claim on an assigned item
// "even when currently unclaimed/lapsed — the assignment anchors it, so a
// sleeper's work is never stolen." So `assigned-idle` (assigned + no live
// claim) is a first-class, EXPECTED disposition — a solo agent working a lane
// one item at a time legitimately leaves the rest assigned-but-unclaimed. The
// check fired for exactly this normal state (only for presence-LIVE holders;
// DEAD/STALLED holders are excluded and already handled by the stale-claims.ts
// reapers), so it produced pure false positives — the same
// normal-backlog-re-filed-hourly anti-pattern this file has repeatedly closed
// (EI-6910 / EI-8664 / EI-10177). Removing it loses no coverage.

/** How fresh a presence heartbeat must be to count as "session LIVE" for the
 *  claim-integrity checks. Deliberately generous (vs the 60s liveness ladder
 *  elsewhere): a long single turn between heartbeats must never mask a real
 *  desync as "holder went away". */
export const CLAIM_INTEGRITY_PRESENCE_GRACE_SEC = 15 * 60;

export type ClaimIntegrityViolationKind = 'orphaned-wip';

export interface ClaimIntegrityViolation {
  kind: ClaimIntegrityViolationKind;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  /** The live session that should be alarmed as the holder. */
  holderOwnerId: string;
  holderOwnerLabel: string | null;
  detail: string;
}

interface OrphanedWipRow {
  harness_slug: string;
  feature_id: string;
  title: string | null;
  plan_slug: string;
  item_id: string;
  claim_owner: string;
  claim_owner_label: string | null;
}

/** (a) ORPHANED WIP: a `wip` work-item with no assignee whose linked plan item
 *  shows a live claim held by a presence-live owner. One isolated query — a
 *  failure degrades this leg only (caller wraps with `.catch(() => [])`). */
export async function findOrphanedWipClaims(
  sql: postgres.Sql,
  workspaceId: string,
  opts: { presenceGraceSec?: number } = {},
): Promise<ClaimIntegrityViolation[]> {
  const graceSec = Math.max(1, Math.round(opts.presenceGraceSec ?? CLAIM_INTEGRITY_PRESENCE_GRACE_SEC));
  const rows = await sql<OrphanedWipRow[]>`
    SELECT wi.harness_slug, wi.feature_id, wi.title, wi.source_plan_slug AS plan_slug,
           pic.item_id, pic.owner AS claim_owner, pic.owner_label AS claim_owner_label
      FROM harness_shared.work_items wi
      JOIN harness_shared.plan_item_claims pic
        ON pic.workspace_id = wi.workspace_id
       AND pic.harness_slug = wi.harness_slug
       AND pic.plan_slug = wi.source_plan_slug
       AND pic.item_id = ANY(wi.source_plan_item_ids)
       AND pic.expires_ts > clock_timestamp()
      JOIN harness_shared.coord_presence cp
        ON cp.owner_id = pic.owner
       AND cp.heartbeat_at > now() - make_interval(secs => ${graceSec})
     WHERE wi.workspace_id = ${workspaceId}
       AND wi.status = 'wip'
       AND (wi.taken_by IS NULL OR wi.taken_by = '')
       AND wi.source_plan_slug IS NOT NULL
       AND wi.source_plan_item_ids IS NOT NULL`;
  return rows.map((r) => ({
    kind: 'orphaned-wip' as const,
    harnessSlug: r.harness_slug,
    planSlug: r.plan_slug,
    itemId: r.item_id,
    holderOwnerId: r.claim_owner,
    holderOwnerLabel: r.claim_owner_label,
    detail:
      `work-item ${r.harness_slug}/${r.feature_id}${r.title ? ` ("${r.title}")` : ''} is 'wip' with NO assignee ` +
      `(taken_by is null/empty), but its linked plan item ${r.plan_slug}#${r.item_id} shows a LIVE claim held ` +
      `by ${r.claim_owner_label ?? r.claim_owner} (fresh presence heartbeat) — the work-item's own claim ` +
      `tracking has desynced from the authoritative plan-item lease while a real session works it.`,
  }));
}

export interface PlannedClaimIntegrityAlarm {
  violation: ClaimIntegrityViolation;
  /** holder + its fleet leader (when resolvable and distinct), deduped. */
  targets: string[];
  summary: string;
}

/** Pure: turn violations into { targets, summary } alarms — holder + its
 *  fleet leader (when known and different from the holder), deduped. Exported
 *  for unit tests (no DB): the leader lookup is injected as a plain Map. */
export function planClaimIntegrityAlarms(
  violations: ClaimIntegrityViolation[],
  leaderByOwner: ReadonlyMap<string, string | null>,
): PlannedClaimIntegrityAlarm[] {
  return violations.map((v) => {
    const leader = leaderByOwner.get(v.holderOwnerId) ?? null;
    const targets = [...new Set([v.holderOwnerId, ...(leader && leader !== v.holderOwnerId ? [leader] : [])])];
    return {
      violation: v,
      targets,
      summary: `claim-integrity ALARM (${v.kind}): ${v.planSlug}#${v.itemId} — reconcile now, not a backlog item.`,
    };
  });
}

/** System identity for this monitor's own writes (mirrors MONITOR_IDENTITY). */
const CLAIM_INTEGRITY_IDENTITY: AgentIdentity = {
  ownerId: 'system:claim-integrity-monitor',
  ownerLabel: 'system · claim-integrity-monitor',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Resolve each distinct holder's CURRENT fleet leader (null when the holder
 *  has no fleet, or is itself the leader). Best-effort per holder — a lookup
 *  failure degrades that holder to "no leader known" rather than aborting the
 *  pass. Exported for unit tests. */
export async function resolveLeadersForHolders(
  workspaceId: string,
  holderOwnerIds: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (holderOwnerIds.length === 0) return out;
  let fleetByOwner: Map<string, { fleetSlug: string | null; fleetRole: string | null }>;
  try {
    fleetByOwner = await fetchPresenceFleet([...holderOwnerIds]);
  } catch {
    fleetByOwner = new Map();
  }
  const fleetSlugCache = new Map<string, string | null>();
  for (const id of holderOwnerIds) {
    const fleetSlug = fleetByOwner.get(id)?.fleetSlug ?? null;
    if (!fleetSlug) {
      out.set(id, null);
      continue;
    }
    try {
      if (!fleetSlugCache.has(fleetSlug)) {
        const fleet = await getFleet(workspaceId, fleetSlug);
        fleetSlugCache.set(fleetSlug, fleet?.leaderOwnerId ?? null);
      }
      out.set(id, fleetSlugCache.get(fleetSlug) ?? null);
    } catch {
      out.set(id, null);
    }
  }
  return out;
}

registerSystemAction('claim-integrity-sweep', async (ctx: SystemActionCtx) => {
  const presenceGraceSec = Number(
    (ctx.payloadTemplate?.presenceGraceSec as number | undefined) ?? CLAIM_INTEGRITY_PRESENCE_GRACE_SEC,
  );
  const { sql } = getOrgPg();
  // EI-10506: only the ORPHANED-WIP desync remains a real violation. The
  // "unbacked active assignment" leg was removed — an assigned-idle item is
  // anchored (claimPlanItem refuses a non-assignee claim), so it was pure
  // false positives.
  const violations = await findOrphanedWipClaims(sql, ctx.workspaceId, { presenceGraceSec }).catch(() => []);
  if (violations.length === 0) return;

  const leaderByOwner = await resolveLeadersForHolders(
    ctx.workspaceId,
    [...new Set(violations.map((v) => v.holderOwnerId))],
  );
  const planned = planClaimIntegrityAlarms(violations, leaderByOwner);

  for (const alarm of planned) {
    // LOUD: a directed, WOKEN message to the holder + its fleet leader — the
    // primary signal (never blocks the pass on a delivery failure).
    try {
      await sendMessage(CLAIM_INTEGRITY_IDENTITY, {
        to: alarm.targets,
        summary: alarm.summary,
        body:
          `${alarm.violation.detail}\n\n` +
          `This is a LOUD claim-integrity alarm (fleet-reliability-verification-2026-07-10 P-001), not a ` +
          `filed backlog item — reconcile the claim now: confirm who actually holds the work, then either ` +
          `re-claim the plan item (coord:declare-intent / work_items:claim) or release the stale side ` +
          `(work_items:release / plans:set-status) so the two stay in agreement.`,
        category: 'claim-integrity-alarm',
      });
      await wakeRecipients(alarm.targets, { summary: alarm.summary, source: CLAIM_INTEGRITY_IDENTITY.ownerId });
    } catch {
      /* an alarm-delivery failure must not abort the pass — the improvement below still files */
    }
    // Durable audit trail (dedup-scoped): also the catch-all when nobody was
    // reachable to wake (a stale/dead holder — the alarm still records the fact).
    await captureImprovement({
      title: `claim integrity: ${alarm.violation.kind} on ${alarm.violation.planSlug}#${alarm.violation.itemId}`,
      kind: 'bug',
      severity: 'major',
      dedupScope: 'open',
      foundDuring: 'system:claim-integrity-sweep',
      subTopic: 'coordination',
      body: `${alarm.violation.detail}\n\nAlarmed (directed + woken): ${alarm.targets.join(', ')}\n(fleet-reliability-verification-2026-07-10 P-001 / EI-8999)`,
    }).catch(() => {
      /* a capture failure must not abort the remaining alarms */
    });
  }
});

// ── EI-436: dormant-harness substrate_outbox GC ─────────────────────────────
// The inline drain GC (outbox-drain.ts) deletes drained rows >24h ONLY for a
// CURRENTLY-BOOTED harness's own (workspace, slug) — by design, so N booted
// harnesses don't run N concurrent unscoped global DELETEs (the EI-125 trap that
// produced a 102GB table). But a harness that federated then STOPPED booting has
// no drain loop, so its drained rows never GC and leak forever (35,660 rows /
// 4.6GB cold TOAST observed). This is the ONE single-writer global sweep that
// reaches them: run by the hourly coord-invariant-monitor (a single authority),
// BOUNDED + BATCHED with the same window + predicate as the inline GC, but NOT
// scoped to a booted slug — it sweeps every slug in the workspace (the point).

/**
 * Single-writer, bounded+batched GC of drained `substrate_outbox` rows older than
 * the retention window, across EVERY harness_slug in the workspace (incl. dormant
 * ones the per-handle drain can't reach). Same predicate as the inline GC; only
 * the holder of this routine (one authority, hourly) ever runs it, so it is never
 * the unscoped concurrent DELETE storm of EI-125. The production bound is the
 * same wall-time budget as the per-handle GC, rather than an arbitrary row-count
 * ceiling that can strand a large backlog. Returns total rows deleted.
 */
export async function sweepDrainedOutbox(
  sql: postgres.Sql,
  workspaceId: string,
  nowMs: number,
  opts: {
    batch?: number;
    /** Legacy test seam; production leaves this unset and uses budgetMs. */
    maxBatches?: number;
    budgetMs?: number;
    /** Monotonic-clock seam for budget tests; production uses Date.now. */
    now?: () => number;
    ageMs?: number;
  } = {},
): Promise<number> {
  const batch = opts.batch ?? OUTBOX_GC_BATCH;
  const budgetMs = opts.budgetMs ?? OUTBOX_GC_BUDGET_MS;
  const clock = opts.now ?? Date.now;
  const startedAtMs = clock();
  const cutoff = nowMs - (opts.ageMs ?? OUTBOX_GC_AGE_MS);
  let total = 0;
  for (let i = 0; ; i++) {
    // Keep the old maxBatches option as a bounded test/compatibility seam, but
    // never apply an arbitrary row-count ceiling to the production sweep.
    if (opts.maxBatches !== undefined && i >= opts.maxBatches) break;
    if (clock() - startedAtMs >= budgetMs) break;
    // Each batch is its own committed statement — progress survives a host recycle,
    // and the LIMIT keeps any single DELETE bounded (never the unbounded EI-125 one).
    const del = await sql`
      WITH del AS (
        SELECT id
          FROM harness_shared.substrate_outbox
         WHERE workspace_id = ${workspaceId}
           AND drained_at IS NOT NULL
           AND drained_at < ${cutoff}
         LIMIT ${batch}
      )
      DELETE FROM harness_shared.substrate_outbox o
       USING del
       WHERE o.id = del.id`;
    const n = del.count ?? 0;
    total += n;
    if (n < batch) break; // fewer than a full batch ⇒ backlog cleared
  }
  return total;
}

registerSystemAction('coord-invariant-monitor', async (ctx: SystemActionCtx) => {
  const t: InvariantThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(ctx.payloadTemplate as Partial<InvariantThresholds> | null),
  };
  // EI-436: GC drained substrate_outbox rows for DORMANT harnesses (the inline
  // per-handle drain GC only reaches currently-booted slugs). Best-effort — a
  // sweep failure never aborts the pass.
  await sweepDrainedOutbox(getOrgPg().sql, ctx.workspaceId, Date.now()).catch(() => 0);
  // EI-314: GC staged wakes for ENDED sessions before measuring. A manual-mode
  // queue for a gone owner can never be released (only the owner releases it), so
  // it would trip the wake-queue invariant as pure debris and re-file forever.
  // Sweeping first means the violation only fires for a LIVE agent's genuinely-
  // stuck review queue. Best-effort — a sweep failure never aborts the pass.
  await sweepDeadOwnerPendingWakes().catch(() => 0);
  // WI-3097: GC staged wakes past a plain age cap regardless of owner liveness — the
  // dead-owner sweep above only reaps orphaned wakes for a GONE owner; a LIVE owner who
  // never reviews their wake board can otherwise let one sit indefinitely until the
  // wakeQueueAgeHours invariant below files it as a violation. Best-effort, same as the
  // sweep above — a failure never aborts the pass.
  await sweepStalePendingWakes({ staleHours: t.pendingWakeStaleHours }).catch(() => 0);
  // F-FIX-037: Auto-accept handoffs older than the stuck-handoff threshold. This
  // prevents them from persisting as open violations; handoffs waiting >12h for
  // acceptance are auto-accepted by the monitor before the invariant check runs.
  // Best-effort — a failure never aborts the pass.
  await autoAcceptStaleHandoffs(t.stuckHandoffHours).catch(() => 0);
  // EI-8786: Drain stale OPERATIONAL escalations BEFORE measuring, mirroring the
  // handoff auto-accept above and the wake-queue sweeps — so the escalation invariant
  // fires only on a genuine, unrecoverable drain failure, never because the separate
  // hourly attentionReconcile DBOS tick was late / shed / down (see the helper doc).
  // Best-effort — a failure never aborts the pass.
  await drainOperationalEscalationsBeforeMeasure().catch(() => 0);
  const snap = await gatherSnapshot(t);
  const violations = evaluateInvariants(snap, t, Date.now());
  for (const v of violations) {
    await captureImprovement({
      title: v.title,
      kind: 'bug',
      severity: v.severity,
      dedupScope: 'open',
      foundDuring: 'system:coord-invariant-monitor',
      subTopic: 'coordination',
      body: `${v.detail}\n\nSnapshot: ${JSON.stringify(snap)}\nThresholds: ${JSON.stringify(t)}\n(coord-system-e2e-testing-2026-06-10 P-013; shared monitor home for the shared-hive-loop P-012/P-013 checks.)`,
    }).catch(() => {
      /* a capture failure must not abort the remaining violations */
    });
  }
  // The shared-hive-loop leg (P-012/P-013 of that plan) — isolated like every
  // other check: its failure degrades the leg, never the fire.
  //
  // ⚠ EI-20579195481991931 — DEGRADE THE FIRE, NEVER THE VISIBILITY. This used to
  // be `.catch(() => {})`, which discarded the error at a SECOND layer: the scope
  // loop already swallows per-scope failures, so a throw reaching here could only
  // come from BEFORE the loop — scope discovery itself (a three-table UNION), or
  // the pg handle. That is the worst case, not the mildest: it means the ENTIRE
  // shared-hive family (outbox health, double completion, presence ghosts, orphan
  // sweep, peer federation silence) examined NOTHING, and the pass then reported
  // nothing — indistinguishable from health, which is the exact failure this leg's
  // own zero-scopes guard exists to make loud. A silent catch is that guard's blind
  // spot one level up.
  await runSharedHiveLeg(ctx).catch(async (err: unknown) => {
    await captureImprovement({
      title: 'shared-hive invariant: monitor leg THREW before it could examine anything',
      kind: 'bug',
      severity: 'major',
      dedupScope: 'open',
      // Per-signal identity for the same reason every incident above carries one.
      watchdogKey: 'shared-hive:leg-threw',
      foundDuring: 'system:coord-invariant-monitor (shared-hive leg)',
      subTopic: 'shared-hive',
      body:
        `runSharedHiveLeg threw, so every shared-hive scan (outbox health, double-completion, presence ghosts, ` +
        `peer federation silence, orphan sweep) was SKIPPED for this pass. The per-scope loop already isolates ` +
        `individual scope failures, so a throw that reaches here happened BEFORE any scope was examined — most ` +
        `likely scope discovery or the PG handle. The pass reported nothing because it examined nothing, which ` +
        `is not the same as healthy.\n\nError: ${err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)}` +
        `\n\n(EI-20579195481991931; check source: packages/operator-core/lib/harness/routines/coord-invariant-actions.ts.)`,
    }).catch(() => {
      /* the contradiction report must not abort the fire — but it is no longer
         the ONLY record: the throw is re-thrown nowhere, so this capture is the
         last line of defense and its own failure is the only thing we swallow. */
    });
  });
});
