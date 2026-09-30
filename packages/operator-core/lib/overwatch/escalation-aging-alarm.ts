/**
 * overwatch/escalation-aging-alarm — the deterministic periodic ACTOR for the
 * `escalation-aging` anomaly (EI-16151).
 *
 * `detectAnomalies` (compute-brief.ts) emits an `escalation-aging` anomaly with a
 * FIXED, count-free `conditionKey` (`anomalyConditionKey('escalation-aging')`)
 * whenever `plans.agingEscalations > 0`, and brief-types.ts's renderer instructs the
 * LLM Kettle to copy that exact string into `coord:escalate`'s `conditionKey`
 * argument so repeated firings coalesce onto ONE open row (EI-13557). That
 * enforcement is PURE PROMPT INSTRUCTION — nothing in code requires the Kettle to
 * follow it. A wake that forgets, or invents its own ad-hoc signature (embedding
 * the live count/duration straight into the summary — exactly the original
 * EI-13557 failure mode), opens a brand-new permanently-open escalation instead of
 * bumping the existing one. Verified via direct DB query (EI-16151): 18+ distinct
 * open rows since 2026-07-16, one per Kettle wake, each with a DIFFERENT
 * self-invented subjectSignature ("escalation-aging-313",
 * "kettle-escalation-aging-backlog", "papercusp-escalation-aging-backlog", …), none
 * matching the canonical key — so the "N escalations aging" advisory
 * self-inflates the very backlog it exists to report.
 *
 * NOTE this is NOT the `agingEscalations`/`escalation-aging` COUNT itself being
 * wrong — `computeEscalationsHealth` (system-health/compute.ts) already correctly
 * excludes the operational/auto-GC'd flood from that count (EI-1490). The count is
 * real; only the advisory ABOUT the count was self-inflating.
 *
 * Mirrors condition-staleness-alarm.ts / liveness-alarm.ts's architecture: a
 * DETERMINISTIC actor — never LLM-dependent — reconciles a SINGLE durably-tracked
 * advisory escalation. Unlike condition-staleness-alarm.ts (whose summary embeds a
 * live "OPEN for Nm" figure and therefore relies on ITS OWN pre-check against
 * derived-from-summary signatures to avoid re-forking a row), this alarm keeps
 * "does a row already exist" independent of the live count entirely: it lists any
 * currently-OPEN row filed under its own identity FIRST, and only escalates when
 * none exists. One alarm, one row, however the count drifts tick to tick. It also
 * passes the canonical key as `meta.subjectSignature` (the field `openEscalation`'s
 * dedup logic — and `coord:escalate`'s own `conditionKey` mapping — actually reads),
 * so even a duplicate direct call coalesces at the `openEscalation` layer too.
 *
 * Runs independently of whether the LLM Kettle ALSO escalates: both paths target
 * the same `subjectSignature`, so a Kettle-opened row and this alarm's row coalesce
 * (bump `repeatCount`) instead of drifting into two.
 *
 * Fires under `system:escalation-aging-alarm` — the `system:` prefix makes
 * `isOperationalEscalation` correctly exclude the alarm's OWN row from the
 * human-attention count it is reporting on (otherwise the alarm would inflate the
 * very metric it alarms about, the same shape as EI-1490's placement-watchdog flood).
 *
 * Best-effort + fail-soft: never throws, never blocks the request worker it runs on.
 */
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { readSharedSystemHealthSnapshot } from '../system-health/compute';
import type { SystemHealth } from '../system-health/types';
import { activeWorkspaceId } from '../workspace-registry';
import {
  openEscalation,
  listEscalationsPaginated,
  resolveEscalation,
  type EscalationRecord,
} from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { SELF_RECONCILING_META_KEY } from '../attention/reconcile-escalations';
import { anomalyConditionKey } from './compute-brief';

export const ESCALATION_AGING_ALARM_IDENTITY: AgentIdentity = {
  ownerId: 'system:escalation-aging-alarm',
  ownerLabel: 'system · escalation-aging-alarm',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** The canonical, count-free dedup key — the SAME one `detectAnomalies` emits. */
export const ESCALATION_AGING_CONDITION_KEY = anomalyConditionKey('escalation-aging');

const OPEN_SCAN_WINDOW = 50;
const DEFAULT_INTERVAL_MS = 5 * 60_000;

export interface EscalationAgingAlarmDeps {
  /** Read the current human-attention aging-escalation count. Default: a fresh
   *  shared SystemHealth snapshot's `panels.escalations.data.aging`
   *  (the SAME count `detectAnomalies` sources via the C-1 brief mapping). */
  readAging?: () => Promise<number | null>;
  /** Test seam for the production shared-snapshot reader. Null means unknown;
   *  it never falls back to a request-worker `computeSystemHealth`. */
  readSharedHealth?: (workspaceId: string) => Promise<SystemHealth | null>;
  escalate?: (input: {
    severity: 'advisory';
    summary: string;
    body?: string;
    meta?: Record<string, unknown>;
  }) => Promise<unknown>;
  listOpen?: () => Promise<EscalationRecord[]>;
  resolve?: (msg_id: string, choice: string, note: string) => Promise<unknown>;
}

async function defaultReadAging(
  readHealth: (workspaceId: string) => Promise<SystemHealth | null> = readSharedSystemHealthSnapshot,
): Promise<number | null> {
  const health = await readHealth(activeWorkspaceId());
  if (!health) return null;
  const panel = health.panels.escalations;
  if (panel.status === 'unknown' || panel.error != null) return null;
  const aging = panel.data?.aging;
  return typeof aging === 'number' && Number.isFinite(aging) ? aging : null;
}

/**
 * One tick: read the current aging-escalation count and reconcile a SINGLE
 * durably-tracked advisory row under `ESCALATION_AGING_ALARM_IDENTITY`.
 *
 *  - aging === 0 → resolve any open row(s) under this identity (cleared).
 *  - aging > 0 and a row is already open under this identity → leave it (never
 *    fork a second row while one is open — this IS the EI-16151 fix).
 *  - aging > 0 and none open → escalate once, keyed by `ESCALATION_AGING_CONDITION_KEY`.
 */
export async function runEscalationAgingAlarmTick(
  deps: EscalationAgingAlarmDeps = {},
): Promise<{ aging: number | null; fired: boolean; resolved: string[] }> {
  const readAging = deps.readAging ?? (() => defaultReadAging(deps.readSharedHealth));
  const escalate =
    deps.escalate ?? ((input) => openEscalation(ESCALATION_AGING_ALARM_IDENTITY, input));
  const listOpen =
    deps.listOpen ??
    (async () => {
      // EI-19403159016550818: scope the read to THIS alarm server-side — see the
      // note in condition-staleness-alarm.ts. A workspace-wide page + JS `from`
      // filter silently returns [] once this alarm's rows fall past the window,
      // which reads as "nothing of mine is open" and makes auto-resolve a no-op.
      // Measured 2026-08-03: this alarm's 1 open row sat at position 567 of 607.
      const { escalations } = await listEscalationsPaginated({
        status: 'open',
        maxRecords: OPEN_SCAN_WINDOW,
        from: ESCALATION_AGING_ALARM_IDENTITY.ownerId,
      });
      return escalations;
    });
  const resolve =
    deps.resolve ??
    ((msg_id, choice, note) =>
      resolveEscalation({
        msg_id,
        choice,
        note,
        resolver: ESCALATION_AGING_ALARM_IDENTITY.ownerId,
      }));

  let aging: number | null = null;
  try {
    aging = await readAging();
  } catch {
    // A read failure must never crash the request worker nor look like "all clear".
    return { aging: null, fired: false, resolved: [] };
  }
  // Missing/stale shared evidence is unknown: do not list, resolve, or open an
  // escalation from a value we could not observe.
  if (aging === null) return { aging: null, fired: false, resolved: [] };

  let openRows: EscalationRecord[] = [];
  try {
    openRows = await listOpen();
  } catch {
    openRows = [];
  }

  const resolved: string[] = [];
  if (aging === 0) {
    for (const rec of openRows) {
      try {
        await resolve(
          rec.msg_id,
          'auto-resolved',
          'escalation-aging cleared — no human-attention escalations aging past the threshold',
        );
        resolved.push(rec.msg_id);
      } catch {
        /* a resolve failure must never crash the request worker */
      }
    }
    return { aging, fired: false, resolved };
  }

  if (openRows.length > 0) {
    // Already reporting this — never fork a second row while one is open (EI-16151).
    return { aging, fired: false, resolved };
  }

  let fired = false;
  try {
    await escalate({
      severity: 'advisory',
      summary: `${aging} human-attention escalation(s) aging past the attention threshold`,
      body:
        `Detected by the deterministic escalation-aging actor (EI-16151) — reconciles the same ` +
        `signal detectAnomalies's 'escalation-aging' anomaly reports, under the shared ` +
        `conditionKey '${ESCALATION_AGING_CONDITION_KEY}', so this row coalesces with any the ` +
        `Kettle also opens instead of forking a duplicate. Review the Planning Needs queue to ` +
        `resolve, answer, or dismiss the aging items; the Mug cannot clear owner-decision ` +
        `backlog by being nudged.`,
      // WI-36214: this alarm gates its own re-fire on an open row (the
      // `openRows.length > 0` branch above) AND resolves that row itself when
      // `aging === 0` — so the attention TTL sweep must not GC it. Without this
      // marker the sweep resolved the row every 2 days and the very next tick
      // re-opened it: measured 6 such resolve→re-fire pairs in 14 days, each
      // announced as a resolution.
      meta: {
        subjectSignature: ESCALATION_AGING_CONDITION_KEY,
        [SELF_RECONCILING_META_KEY]: true,
      },
    });
    fired = true;
  } catch {
    /* an alarm-send failure must never crash the request worker */
  }
  return { aging, fired, resolved };
}

/**
 * Start the alarm on a request-worker loop, mirroring startConditionStalenessAlarm's
 * shape (unref'd timer, env-killable, interval overridable). Wire alongside
 * startInfraLivenessAlarm()/startConditionStalenessAlarm() in bin/hono-host.ts.
 */
export function startEscalationAgingAlarm(opts: { intervalMs?: number } = {}): { stop(): void } {
  if (process.env.PAPERCUSP_ESCALATION_AGING_ALARM === '0') return { stop() {} };
  const envMs = Number(process.env.PAPERCUSP_ESCALATION_AGING_ALARM_MS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  const timer = managedSetInterval(
    'escalation-aging-alarm',
    intervalMs,
    () => runEscalationAgingAlarmTick().then(() => undefined, () => undefined),
    { category: 'watchdog' },
  );
  return {
    stop() {
      timer.stop();
    },
  };
}
