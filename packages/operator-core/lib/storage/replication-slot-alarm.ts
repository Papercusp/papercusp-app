/**
 * Replication-slot WAL-retention alarm (infra-perf-reliability-audit-round4-2026-06-19
 * P-009, su-6a14a). The original framing was "monitor the local→Hetzner pg-tunnel
 * logical-replication SPOF". Verify-before-fix (this plan's round-2 D-001, recorded
 * as D-004) found that framing mis-grounded:
 *
 *   - the cluster's steady state is ZERO replication slots / ZERO walsenders, so a
 *     "is a replica connected" probe would false-positive constantly;
 *   - the only publications are retired-Zero vestiges (zero_publication on the
 *     `restart` db); and
 *   - the autossh pg-tunnel is a platform systemd service (it already auto-respawns)
 *     for intermittent Hetzner federation/deployment access, not a standing replica.
 *
 * The REAL danger is the classic logical-replication footgun: an INACTIVE
 * replication slot pins WAL, and under `max_slot_wal_keep_size = -1` (PG's
 * default) Postgres never invalidates it — so the retained WAL grows
 * UNBOUNDED → the data volume silently fills → the whole cluster goes down. A
 * dropped federation subscriber or a stuck retired-Zero slot leaves exactly such a
 * slot. This is the missing guard: a periodic READ-ONLY check that warns when a slot
 * is inactive (or its WAL is already at risk) while retaining WAL past an absolute
 * ceiling — EARLY warning, before the disk fills, and silent on the normal 0-slot
 * steady state.
 *
 * Stateless by design — an absolute ceiling cannot false-NEGATIVE on a runaway the
 * way a growth-rate heuristic (needing persisted history) can. Read-only +
 * best-effort: it never throws (mirrors storage-growth-alarm + the other periodic
 * monitors), so it can never affect the cluster it watches.
 */
import { generated, getOrgPg } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { escalateAlarm } from '../alarm-attention';
import { notifySyncInvalidate } from '../sync-sse';

const GIB = 1024 ** 3;
const TOAST_RING_BUFFER = 2000;
const REPLSLOT_ESCALATE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const REPLSLOT_ESCALATION_TITLE = 'Replication slot WAL critical';

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Absolute WAL-retention ceiling (GiB) for an INACTIVE slot. An inactive slot
 *  should retain ~nothing, so this is tight — any inactive slot pinning more than
 *  this is the disk-fill SPOF (max_slot_wal_keep_size=-1). Env-overridable. */
export function inactiveCeilingBytes(): number {
  return envNum('PAPERCUSP_REPLSLOT_ALARM_INACTIVE_GB', 2) * GIB;
}

/** Absolute WAL-retention ceiling (GiB) for an ACTIVE slot. An active subscriber
 *  legitimately lags under load, so this is looser. Env-overridable. */
export function activeCeilingBytes(): number {
  return envNum('PAPERCUSP_REPLSLOT_ALARM_ACTIVE_GB', 10) * GIB;
}

export interface SlotRow {
  slotName: string;
  slotType: string; // 'logical' | 'physical'
  active: boolean;
  retainedWalBytes: number;
  /** pg_replication_slots.wal_status (PG13+): reserved | extended | unreserved | lost. */
  walStatus: string | null;
}

export type SlotBreachReason = 'wal-at-risk' | 'inactive-retaining' | 'active-lagging';

export interface SlotBreach {
  slotName: string;
  slotType: string;
  active: boolean;
  retainedWalBytes: number;
  walStatus: string | null;
  reason: SlotBreachReason;
  ceilingBytes: number;
}

/** Pure breach detection over a slot snapshot — unit-testable without PG. Severity
 *  order: `wal-at-risk` (PG is already recycling WAL this slot still needs → the
 *  subscriber WILL break) > `inactive-retaining` (an abandoned slot pinning WAL —
 *  the silent disk-fill SPOF) > `active-lagging` (a slow but live subscriber). The
 *  normal 0-slot steady state returns [] — no false positives. */
export function detectSlotBreaches(slots: SlotRow[]): SlotBreach[] {
  const inactiveCeil = inactiveCeilingBytes();
  const activeCeil = activeCeilingBytes();
  const breaches: SlotBreach[] = [];
  for (const s of slots) {
    const ws = (s.walStatus ?? '').toLowerCase();
    if (ws === 'lost' || ws === 'unreserved') {
      breaches.push({ ...s, reason: 'wal-at-risk', ceilingBytes: 0 });
    } else if (!s.active && s.retainedWalBytes > inactiveCeil) {
      breaches.push({ ...s, reason: 'inactive-retaining', ceilingBytes: inactiveCeil });
    } else if (s.active && s.retainedWalBytes > activeCeil) {
      breaches.push({ ...s, reason: 'active-lagging', ceilingBytes: activeCeil });
    }
  }
  return breaches;
}

function fmtGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

const REASON_LABEL: Record<SlotBreachReason, string> = {
  'wal-at-risk': 'WAL AT RISK — Postgres is recycling WAL this slot still needs; the subscriber will break',
  'inactive-retaining': 'inactive slot pinning WAL — silent disk-fill risk if max_slot_wal_keep_size is unbounded',
  'active-lagging': 'active subscriber lagging far behind',
};

/** Build the toast body for a set of slot breaches. Pure — unit-testable. An
 *  at-risk slot is an `error`; a merely-retaining/lagging slot is a `warning`. */
export function formatSlotBreachToast(breaches: SlotBreach[]): {
  level: string;
  message: string;
  description: string;
} {
  const lines = breaches
    .map(
      (b) =>
        `• ${b.slotName} (${b.slotType}, active=${b.active}, wal_status=${b.walStatus ?? 'n/a'}): retaining ${fmtGb(
          b.retainedWalBytes,
        )} — ${REASON_LABEL[b.reason]}`,
    )
    .join('\n');
  const atRisk = breaches.some((b) => b.reason === 'wal-at-risk');
  return {
    level: atRisk ? 'error' : 'warning',
    message: `Replication-slot WAL alarm — ${breaches.length} slot(s) retaining unsafe WAL`,
    description:
      `These Postgres replication slots are pinning WAL dangerously (the silent disk-fill SPOF; ` +
      `under max_slot_wal_keep_size=-1 PG will not cap it at all — see pg-tuning-drift, which ` +
      `alarms when that bound is not applied):\n${lines}\n\n` +
      `An abandoned slot (a dropped federation subscriber, or a stale retired-Zero slot) keeps WAL forever → ` +
      `the data volume fills → the whole cluster goes down. Drop the dead slot ` +
      `(SELECT pg_drop_replication_slot('<name>')) or reconnect its subscriber. Tune ceilings via ` +
      `PAPERCUSP_REPLSLOT_ALARM_INACTIVE_GB / PAPERCUSP_REPLSLOT_ALARM_ACTIVE_GB.`,
  };
}

/** Build the human-facing escalation for WAL loss or an abandoned slot. */
export function formatSlotEscalation(critical: SlotBreach[]): { title: string; body: string } {
  const body = formatSlotBreachToast(critical).description;
  return {
    title: REPLSLOT_ESCALATION_TITLE,
    body: `Replication-slot attention required now. ${body}`,
  };
}

export interface SlotAlarmDeps {
  /** Injectable for tests — defaults to a read-only pg_replication_slots scan. */
  fetchSlots?: () => Promise<SlotRow[]>;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
  /** Injectable for tests — defaults to the shared attention-notify rail. */
  escalate?: (t: { title: string; body: string }) => Promise<void>;
  /** Injectable for tests — the persistent cross-restart cooldown floor. */
  recentlyEscalated?: () => Promise<boolean>;
}

async function defaultFetchSlots(): Promise<SlotRow[]> {
  const { sql } = getOrgPg();
  // Cluster-wide view (visible from any DB). The recovery-safe LSN expression keeps
  // this correct if it ever runs on a standby (pg_current_wal_lsn throws in recovery).
  const rows = await sql<
    {
      slot_name: string;
      slot_type: string;
      active: boolean;
      retained_wal_bytes: string | number | null;
      wal_status: string | null;
    }[]
  >`
    select
      slot_name,
      slot_type,
      active,
      coalesce(
        pg_wal_lsn_diff(
          case when pg_is_in_recovery() then pg_last_wal_replay_lsn() else pg_current_wal_lsn() end,
          restart_lsn
        ),
        0
      )::bigint as retained_wal_bytes,
      wal_status
    from pg_replication_slots
  `;
  return rows.map((r) => ({
    slotName: r.slot_name,
    slotType: r.slot_type,
    active: r.active === true,
    retainedWalBytes: Number(r.retained_wal_bytes ?? 0),
    walStatus: r.wal_status,
  }));
}

async function defaultEmitToast(t: { level: string; message: string; description: string }): Promise<void> {
  const tl = generated.toastLogInHarnessShared;
  const { db } = getOrgPg();
  await db.insert(tl).values({
    level: t.level,
    message: t.message,
    description: t.description,
    harnessSlug: null,
    createdAt: Date.now(),
    actionLabel: null,
    actionHref: null,
  });
  // Bound the ring buffer (mirrors storage-growth-alarm / agent-governor-observer).
  void (async () => {
    const stale = await db
      .select({ id: tl.id })
      .from(tl)
      .orderBy(desc(tl.createdAt))
      .offset(TOAST_RING_BUFFER);
    if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
  })().catch(() => {});
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
}

/** One read-only pass: inspect replication slots, toast on any unsafe-WAL breach.
 *  Never throws — observability is best-effort, mirroring the other periodic monitors. */
export async function runReplicationSlotAlarmOnce(
  deps: SlotAlarmDeps = {},
): Promise<{ checked: number; breaches: SlotBreach[] }> {
  const fetchSlots = deps.fetchSlots ?? defaultFetchSlots;
  const emitToast = deps.emitToast ?? defaultEmitToast;
  const escalate = deps.escalate;
  const recentlyEscalated = deps.recentlyEscalated;

  let slots: SlotRow[] = [];
  try {
    slots = await fetchSlots();
  } catch (err) {
    console.warn(
      `[replication-slot-alarm] slot scan skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`,
    );
    return { checked: 0, breaches: [] };
  }

  const breaches = detectSlotBreaches(slots);
  if (breaches.length > 0) {
    try {
      await emitToast(formatSlotBreachToast(breaches));
    } catch (err) {
      console.warn(
        `[replication-slot-alarm] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }
  // An active subscriber that is merely lagging remains warning-only. WAL that
  // is already at risk, or pinned by an inactive slot, is an actionable
  // failure mode and reaches the human rail.
  const critical = breaches.filter((b) => b.reason === 'wal-at-risk' || b.reason === 'inactive-retaining');
  if (critical.length > 0) {
    await escalateAlarm(
      {
        ...formatSlotEscalation(critical),
        cooldownMs: REPLSLOT_ESCALATE_COOLDOWN_MS,
        source: 'replication-slot-alarm',
      },
      { notify: escalate, recentlyEscalated },
    );
  }
  return { checked: slots.length, breaches };
}
