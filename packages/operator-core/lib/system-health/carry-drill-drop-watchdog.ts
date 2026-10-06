/**
 * carry-drill-drop-watchdog (EI-12755) — real-time escalation for dropped
 * P-020 carry drills.
 *
 * Every carry-drill terminal outcome (delivered / dropped / respawn-failed,
 * incl. the EI-12655 busy-gate-expired and EI-12754 re-armed drops) is durably
 * mirrored to the shared ledger (~/.papercusp/psu-pty/carry-drills.events.jsonl),
 * and `session:carry-drill op:'verify' / op:'report'` expose them ON DEMAND —
 * but a dropped carry still surfaced only when a caller polled. The 2/2 silent
 * drill failures of 2026-07-15 sat unnoticed ~40 minutes (EI-12655). This
 * watchdog tails the ledger on a managed timer and opens ONE escalation per
 * dropped drill, so a drop reaches the attention queue in ~a minute.
 *
 * EI-18168050721107453 extends that SAME timer across production carry-respawns.
 * Production outcomes live in per-owner host ledgers rather than the shared
 * drill ledger. The watchdog reads only recently-modified bounded tails and
 * alarms when fewer than half of at least 20 terminal outcomes in the trailing
 * hour delivered their carry. The metric is deliberately terminal-outcome based:
 * `respawned` is written BEFORE first-prompt injection, so counting it beside a
 * later dropped row would double-count one attempt and overstate success.
 *
 * WI-10001537 adds a THIRD sweep on the same timer: ORPHANED respawns. The two
 * sweeps above both judge rows that EXIST — a terminal drop, or a rate computed
 * from terminal outcomes. An orphan is the opposite shape: a `pending` row whose
 * host died, so no terminal row is ever written and there is nothing for either
 * to see. It contributes to neither the numerator nor the denominator of the
 * production rate, making a single orphaned session invisible to that metric BY
 * CONSTRUCTION. The pre-existing orphan DETECTOR
 * (`carry-respawn-outcome.ts`) only writes a banner into an agent's own context,
 * which by definition cannot reach the case that matters: the CLI is gone, so
 * nobody reads it and the owner must notice by hand. This sweep is the
 * out-of-process half. It is deliberately ALARM-ONLY — it never relaunches a
 * session (owner decision, 2026-09-16).
 *
 * Design notes:
 *  - `managedSetInterval` (never a bare setInterval) — visible in
 *    schedule:inventory, category 'watchdog', like its system-health siblings.
 *  - Runtime gate: FLAGS.CARRY_DRILL_DROP_WATCHER (default ON — flip OFF at
 *    /admin/features to silence; no ad-hoc env boolean per lint:env-feature-gates).
 *  - Dedup is delegated to openEscalation's own (dedupKind, subjectSignature)
 *    PG-locked dedup — cluster-safe with zero new state surface. An in-process
 *    time watermark (boot backfill BACKFILL_MS) keeps each tick incremental and
 *    stops ancient rows from re-alerting after the escalation is resolved.
 *  - Escalations from this system identity carry no options, so the attention
 *    reader demotes them to the alert tier and the reconcile sweep TTL-reaps
 *    them — noise-bounded by construction.
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import {
  readColdBootDrillLedger,
  scanCarryDrillDrops,
  type CarryDrillDropAlert,
  type ColdBootDrillLedgerEvent,
} from '../cold-boot-drill-live';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import {
  PSU_PTY_DIR,
  findLiveHost,
  readHostEventTailAsync,
  type PtyHostEvent,
} from '../events/await/psu-pty-discovery';
import {
  LOST_RESPAWN_AMBIENT_MAX_AGE_MS,
  isDelayedPendingRespawn,
  readPriorRespawnOutcome,
  type PriorRespawn,
} from '../carry-respawn-outcome';

export const CARRY_DRILL_DROP_SWEEP_INTERVAL_MS = 60_000;
/** How far back the first tick after boot looks — covers a restart gap without
 *  re-alerting the whole ledger (open-escalation dedup absorbs any overlap). */
export const CARRY_DRILL_DROP_BACKFILL_MS = 15 * 60_000;

export const PRODUCTION_CARRY_WINDOW_MS = 60 * 60_000;
export const PRODUCTION_CARRY_MIN_TERMINAL_OUTCOMES = 20;
export const PRODUCTION_CARRY_DELIVERY_RATE_FLOOR = 0.5;
/** The host writer caps each per-owner ledger at 256 KiB. Reading that same
 *  ceiling makes the watchdog bounded without discarding rows the writer still
 *  retains from a busy trailing hour. */
export const PRODUCTION_CARRY_SCAN_TAIL_BYTES = 256 * 1024;

/**
 * An orphan older than this is history, not news — the same horizon
 * {@link LOST_RESPAWN_AMBIENT_MAX_AGE_MS} uses for the in-context ambient
 * warning, imported rather than re-declared so the two surfaces cannot drift
 * about what counts as recent.
 */
export const ORPHANED_RESPAWN_MAX_AGE_MS = LOST_RESPAWN_AMBIENT_MAX_AGE_MS;

const HOST_EVENT_SUFFIX = '.events.jsonl';
const SHARED_DRILL_LEDGER = 'carry-drills.events.jsonl';

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'carry-drill-drop-watchdog',
  ownerLabel: 'system · carry-drill drops',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface CarryDrillDropSweepDeps {
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]>;
  escalate: (alert: CarryDrillDropAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
}

export interface ProductionCarryDeliveryReading {
  windowStartMs: number;
  windowEndMs: number;
  delivered: number;
  dropped: number;
  respawnFailed: number;
  /**
   * Host RETIREMENT rows (`respawn-carry-dropped {reason:'superseded'}`, WI-10005752): a real
   * successor already existed, so a moot older request was retired. NOT a delivery outcome —
   * excluded from `dropped`, `terminalOutcomes`, `deliveryRate` and `failureReasons`, and
   * surfaced here so the exclusion is visible rather than silent.
   */
  retiredSuperseded: number;
  terminalOutcomes: number;
  /** `null` means the window had no terminal outcomes, not a 0% delivery rate. */
  deliveryRate: number | null;
  failureReasons: Record<string, number>;
}

/** One session whose carry-respawn will never be delivered by anyone. */
export interface OrphanedRespawnAlert {
  ownerId: string;
  /** The host's own reason on the pending row (e.g. busy-gate-expired), if any. */
  reason: string | null;
  /** ISO timestamp of the pending row — also the dedup subject. */
  ts: string | null;
  ageMs: number;
  capMs: number | null;
}

export interface OrphanedRespawnSweepDeps {
  /** mtime-banded candidate owners; see {@link listOrphanCandidateOwners}. */
  listCandidates: (now: number) => Promise<string[]>;
  readPrior: (ownerId: string, now: number) => Promise<PriorRespawn>;
  /** Liveness of the owner's pty host. Throwing is treated as ALIVE (stay quiet). */
  hostLive: (ownerId: string) => boolean;
  escalate: (alert: OrphanedRespawnAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
  maxAgeMs: number;
}

export interface ProductionCarryDeliverySweepDeps {
  readEvents: (now: number, windowMs: number) => Promise<PtyHostEvent[]>;
  escalate: (reading: ProductionCarryDeliveryReading) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
  windowMs: number;
  minTerminalOutcomes: number;
  deliveryRateFloor: number;
}

function eventTimeMs(event: PtyHostEvent): number | null {
  if (typeof event.ts !== 'string') return null;
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Summarize production carry-respawn TERMINAL outcomes in one trailing window.
 *
 * `respawned` is intentionally absent. The host writer emits it after the new
 * child spawns but before carry injection; every such row can later be followed
 * by either delivered or dropped. The honest attempt-level numerator and
 * denominator are therefore the mutually-exclusive terminal rows below.
 */
export function summarizeProductionCarryDelivery(
  events: readonly PtyHostEvent[],
  now: number = Date.now(),
  windowMs: number = PRODUCTION_CARRY_WINDOW_MS,
): ProductionCarryDeliveryReading {
  const windowStartMs = now - windowMs;
  let delivered = 0;
  let dropped = 0;
  let respawnFailed = 0;
  let retiredSuperseded = 0;
  const failureReasons = new Map<string, number>();

  for (const event of events) {
    const ts = eventTimeMs(event);
    if (ts == null || ts < windowStartMs || ts > now || event.mode !== 'carry-respawn') continue;

    const kind = typeof event.kind === 'string' ? event.kind : '';
    if (kind === 'respawn-carry-delivered') {
      delivered += 1;
      continue;
    }
    if (kind !== 'respawn-carry-dropped' && kind !== 'respawn-failed') continue;
    // A retirement is not a failed delivery (see carry-respawn-outcome RESPAWN_RETIRED_REASON):
    // counting it measured ~5.4k such rows against ~1.6k deliveries across the owner ledgers,
    // which would pin the rate under the floor with no continuation actually lost.
    if (kind === 'respawn-carry-dropped' && event.reason === 'superseded') {
      retiredSuperseded += 1;
      continue;
    }

    const reason = typeof event.reason === 'string' && event.reason.trim() ? event.reason.trim() : 'unknown';
    const reasonKey = kind === 'respawn-failed' ? `respawn-failed:${reason}` : reason;
    failureReasons.set(reasonKey, (failureReasons.get(reasonKey) ?? 0) + 1);
    if (kind === 'respawn-carry-dropped') dropped += 1;
    else respawnFailed += 1;
  }

  const terminalOutcomes = delivered + dropped + respawnFailed;
  return {
    windowStartMs,
    windowEndMs: now,
    delivered,
    dropped,
    respawnFailed,
    retiredSuperseded,
    terminalOutcomes,
    deliveryRate: terminalOutcomes > 0 ? delivered / terminalOutcomes : null,
    failureReasons: Object.fromEntries([...failureReasons.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/**
 * Read recently-modified per-owner event ledgers, bounded to the writer's own
 * 256 KiB cap. The shared drill ledger is excluded: some production drop rows
 * are mirrored there for drill-report compatibility and would be double-counted.
 */
export async function readRecentProductionCarryEvents(
  dir: string = PSU_PTY_DIR,
  now: number = Date.now(),
  windowMs: number = PRODUCTION_CARRY_WINDOW_MS,
  maxBytes: number = PRODUCTION_CARRY_SCAN_TAIL_BYTES,
): Promise<PtyHostEvent[]> {
  const events: PtyHostEvent[] = [];
  for (const ownerId of await listRecentHostEventOwners(dir, now - windowMs)) {
    events.push(...(await readHostEventTailAsync(ownerId, dir, maxBytes)));
  }
  return events;
}

/**
 * Owners whose per-owner event ledger was modified at or after `cutoff` (mtime).
 *
 * ASYNC ON PURPOSE, and this is the load-bearing property (WI-10004559). The watchdog
 * calls this twice a minute on the operator's main thread, against a directory that
 * holds thousands of ledgers and is written by every psu host on the box. When the
 * ext4 journal stalls, a host creating a file there holds the directory's inode lock,
 * and a reader waits in D-state behind it. Done synchronously, that wait froze the
 * whole operator; the event-loop sentinel then killed it, dropping every in-flight MCP
 * request (46 of 66 :3070 kills in 24h were blocked in `iterate_dir` on this
 * directory). Async moves the wait onto one libuv worker thread.
 *
 * The stats run ONE AT A TIME rather than in parallel: under a stall each pending stat
 * pins a worker thread, and the pool (4 by default) is shared with every other async
 * fs call in the process. Sequential holds at most one.
 */
async function listRecentHostEventOwners(dir: string, cutoff: number): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const owners: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(HOST_EVENT_SUFFIX) || entry.name === SHARED_DRILL_LEDGER) {
      continue;
    }
    try {
      if ((await fsp.stat(join(dir, entry.name))).mtimeMs < cutoff) continue;
    } catch {
      continue;
    }
    owners.push(entry.name.slice(0, -HOST_EVENT_SUFFIX.length));
  }
  return owners;
}

/**
 * PURE: is this owner's carry-respawn ORPHANED — i.e. will nobody ever deliver it?
 *
 * THREE conjuncts, and the third is the one that makes this honest:
 *  1. the last respawn is still `pending` (no terminal row ever landed);
 *  2. it has outstayed its own observed wait interval plus slack
 *     ({@link isDelayedPendingRespawn});
 *  3. the owner has NO live pty host.
 *
 * Conjunct 3 is LOAD-BEARING, not belt-and-braces. `carry-respawn-outcome.ts`
 * states the rule this obeys: "Inspect host/controller evidence to establish
 * loss; an elapsed timer alone cannot do so." A host that is still up may
 * legitimately retry across SEVERAL capMs windows, so 1+2 alone describe a
 * DELAY, never a loss.
 *
 * Measured false positive that conjunct 3 suppresses (WI-10001537, the 2026-09-16
 * incident): `deriveLastRespawnOutcome` counts `respawned` as pending only when
 * `mode === 'carry-respawn'`, so an owner's manual recovery — which writes
 * `mode:'self-relaunch'` — is skipped, and the scan keeps returning the STALE
 * earlier pending row. On that session that left a ~5.5 minute window
 * (00:54:09 → 00:59:47Z) in which a timer-only reconciler would have alarmed on a
 * session that was alive and working. Host liveness is what makes it silent.
 *
 * Returns null (stay quiet) for every uncertain case — an alarm is only ever
 * emitted on evidence, the same rule `lostRespawnAmbientLine` follows.
 */
export function orphanedRespawnAlert(
  ownerId: string,
  prior: PriorRespawn | null | undefined,
  hostLive: boolean,
  opts: { maxAgeMs?: number } = {},
): OrphanedRespawnAlert | null {
  if (!prior || prior.outcome !== 'pending') return null;
  if (!isDelayedPendingRespawn(prior)) return null;
  if (hostLive) return null;
  const maxAge = opts.maxAgeMs ?? ORPHANED_RESPAWN_MAX_AGE_MS;
  // An unknown age is NOT treated as recent — same reasoning as the ambient
  // line: guessing "recent" on the rows we know least about nags forever.
  if (prior.ageMs == null || !Number.isFinite(prior.ageMs) || prior.ageMs > maxAge) return null;
  return {
    ownerId,
    reason: prior.reason ?? null,
    ts: prior.ts ?? null,
    ageMs: prior.ageMs,
    capMs: prior.capMs ?? null,
  };
}

/**
 * Candidate owners for the orphan scan, bounded by ledger mtime.
 *
 * THIS BOUND IS NOT OPTIONAL. Per-owner event ledgers are never pruned (only the
 * `.json` discovery files are, by `pruneDeadDiscoveryFiles`): measured on this box
 * 2026-09-16, ~/.papercusp/psu-pty held 14,638 `*.events.jsonl` against 28 `.json`.
 * Parsing all of them every tick would be absurd. An orphan's ledger stops being
 * written the moment its host dies, so its mtime freezes at (approximately) the
 * pending row — which means a recency band over mtime is both cheap and correct.
 * The precise cap+grace verdict still comes from the event timestamp, never mtime.
 */
export function listOrphanCandidateOwners(
  dir: string = PSU_PTY_DIR,
  now: number = Date.now(),
  maxAgeMs: number = ORPHANED_RESPAWN_MAX_AGE_MS,
): Promise<string[]> {
  return listRecentHostEventOwners(dir, now - maxAgeMs);
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.CARRY_DRILL_DROP_WATCHER, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

async function defaultEscalate(alert: CarryDrillDropAlert): Promise<void> {
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Carry drill ${alert.kind === 'carry-drill-respawn-failed' ? 'respawn FAILED' : 'carry DROPPED'} ` +
      `(${alert.reason}) — drill ${alert.drillId.slice(0, 8)}… on ${alert.ownerId} [${alert.sessionClass}]`,
    body:
      `The P-020 cold-boot drill ${alert.drillId} for session owner ${alert.ownerId} ` +
      `(class ${alert.sessionClass}) ended in a terminal ${alert.kind} at ${alert.ts} ` +
      `(reason: ${alert.reason}).\n\n` +
      `The requesting session may be gone (drills cut the process), so this is surfaced here ` +
      `instead of waiting for someone to poll session:carry-drill { op:'report' }. ` +
      `Triage: session:carry-drill { op:'verify', drillId } from the requester, or read the shared ` +
      `ledger at ~/.papercusp/psu-pty/carry-drills.events.jsonl. Recurring busy-gate-expired drops ` +
      `mean the subject's turns outrun the re-arm cap (PAPERCUSP_PSU_PTY_REARM_CAP_MS); ` +
      `respawn-failed means the actuator itself broke — see EI-12655/EI-12754 for the failure taxonomy.`,
    meta: {
      dedupKind: 'carry-drill-drop',
      subjectSignature: `${alert.drillId}:${alert.kind}`,
      drillId: alert.drillId,
      drillOwnerId: alert.ownerId,
      sessionClass: alert.sessionClass,
      reason: alert.reason,
    },
  });
}

async function defaultEscalateProduction(reading: ProductionCarryDeliveryReading): Promise<void> {
  const rate = Math.round((reading.deliveryRate ?? 0) * 100);
  const reasons = Object.entries(reading.failureReasons)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'blocker',
    summary:
      `Production carry delivery fell to ${rate}% ` +
      `(${reading.delivered}/${reading.terminalOutcomes}) in the trailing hour`,
    body:
      `Across production carry-respawns in ~/.papercusp/psu-pty/*.events.jsonl, ` +
      `${reading.delivered}/${reading.terminalOutcomes} terminal outcomes delivered their ` +
      `carry in the trailing hour (${rate}%; alarm floor ` +
      `${Math.round(PRODUCTION_CARRY_DELIVERY_RATE_FLOOR * 100)}%, minimum sample ` +
      `${PRODUCTION_CARRY_MIN_TERMINAL_OUTCOMES}). Failures: ${reasons || 'none classified'}.\n\n` +
      `Metric definition: delivered / (delivered + dropped + respawn-failed). ` +
      `Do not substitute respawned / (respawned + dropped): the host writes respawned ` +
      `before first-prompt injection, so that formula double-counts an attempt that later drops. ` +
      `Triage the dominant reason in the per-owner ledgers and the psu-host/busy-gate path. ` +
      `Background: EI-18168050721107453 / WI-5623.`,
    meta: {
      dedupKind: 'production-carry-delivery-rate',
      subjectSignature: 'rolling-60m',
      delivered: reading.delivered,
      dropped: reading.dropped,
      respawnFailed: reading.respawnFailed,
      terminalOutcomes: reading.terminalOutcomes,
      deliveryRate: reading.deliveryRate,
      failureReasons: reading.failureReasons,
      windowStartMs: reading.windowStartMs,
      windowEndMs: reading.windowEndMs,
    },
  });
}

async function defaultEscalateOrphan(alert: OrphanedRespawnAlert): Promise<void> {
  const ageSec = Math.round(alert.ageMs / 1000);
  const capSec = alert.capMs != null ? Math.round(alert.capMs / 1000) : null;
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Carry-respawn ORPHANED on ${alert.ownerId} — pending ${ageSec}s with no live host` +
      (alert.reason ? ` (${alert.reason})` : ''),
    body:
      `Session owner ${alert.ownerId} has a carry-respawn still \`pending\` from ${alert.ts ?? 'an untimestamped row'} ` +
      `(${ageSec}s ago${capSec != null ? `, wait interval ${capSec}s` : ''}` +
      `${alert.reason ? `, reason: ${alert.reason}` : ''}), and it has NO live pty host — ` +
      `\`findLiveHost\` finds no process with a live socket and a matching psu cmdline.\n\n` +
      `So no successor is coming and nothing will ever record an outcome: the CLI died holding the ` +
      `request. Any dialog that session had open was destroyed with it, and its agent is not going to ` +
      `notice, because the existing orphan DETECTOR only writes a banner into the context of a session ` +
      `that is still alive to read it (WI-10001537).\n\n` +
      `Triage: \`psu --resume <nativeId>\` recovers the work — read the nativeId from the last ` +
      `\`respawned\` row in ~/.papercusp/psu-pty/${alert.ownerId}.events.jsonl, or via ` +
      `\`latestRespawnNativeSession(ownerId)\`. This alarm is deliberately ALARM-ONLY: it never ` +
      `relaunches a session by itself (owner decision, 2026-09-16).\n\n` +
      `Why the sibling production-carry sweep cannot see this: that metric is delivered / ` +
      `(delivered + dropped + respawn-failed) over TERMINAL rows. An orphan produces no terminal row ` +
      `at all, so it lands in neither numerator nor denominator and is invisible to it by construction.`,
    meta: {
      dedupKind: 'orphaned-carry-respawn',
      // One escalation per orphaned ATTEMPT, not one per tick: the pending row's
      // ts is stable for as long as the orphan persists, so the 60s sweep
      // re-fires into openEscalation's own PG dedup instead of stacking rows.
      subjectSignature: `${alert.ownerId}:${alert.ts ?? 'unknown'}`,
      orphanOwnerId: alert.ownerId,
      pendingTs: alert.ts,
      pendingAgeMs: alert.ageMs,
      capMs: alert.capMs,
      reason: alert.reason,
    },
  });
}

function sweepDeps(overrides: Partial<CarryDrillDropSweepDeps>): CarryDrillDropSweepDeps {
  return {
    readLedger: readColdBootDrillLedger,
    escalate: defaultEscalate,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    ...overrides,
  };
}

function productionSweepDeps(overrides: Partial<ProductionCarryDeliverySweepDeps>): ProductionCarryDeliverySweepDeps {
  return {
    readEvents: (now, windowMs) => readRecentProductionCarryEvents(PSU_PTY_DIR, now, windowMs),
    escalate: defaultEscalateProduction,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    windowMs: PRODUCTION_CARRY_WINDOW_MS,
    minTerminalOutcomes: PRODUCTION_CARRY_MIN_TERMINAL_OUTCOMES,
    deliveryRateFloor: PRODUCTION_CARRY_DELIVERY_RATE_FLOOR,
    ...overrides,
  };
}

/**
 * One incremental sweep: scan ledger drops newer than `sinceMs`, escalate each,
 * return the advanced watermark. A failed escalate keeps the OLD watermark so
 * the whole batch retries next tick — the open-escalation (dedupKind,
 * subjectSignature) dedup makes that retry idempotent. Exported for tests.
 */
export async function runCarryDrillDropSweepOnce(
  sinceMs: number,
  overrides: Partial<CarryDrillDropSweepDeps> = {},
): Promise<{ watermarkMs: number; escalated: number; skipped: boolean }> {
  const deps = sweepDeps(overrides);
  if (!(await deps.flagEnabled())) return { watermarkMs: sinceMs, escalated: 0, skipped: true };
  const events = await deps.readLedger();
  const { alerts, watermarkMs } = scanCarryDrillDrops(events, sinceMs);
  let escalated = 0;
  for (const alert of alerts) {
    try {
      await deps.escalate(alert);
      escalated += 1;
    } catch {
      // Keep the pre-scan watermark so this row is retried next tick; the
      // escalation-side dedup absorbs any double-fire from the overlap.
      return { watermarkMs: sinceMs, escalated, skipped: false };
    }
  }
  return { watermarkMs, escalated, skipped: false };
}

function orphanSweepDeps(overrides: Partial<OrphanedRespawnSweepDeps>): OrphanedRespawnSweepDeps {
  return {
    listCandidates: (now) => listOrphanCandidateOwners(PSU_PTY_DIR, now),
    readPrior: (ownerId, now) => readPriorRespawnOutcome(ownerId, { dir: PSU_PTY_DIR, now }),
    hostLive: (ownerId) => findLiveHost(ownerId) != null,
    escalate: defaultEscalateOrphan,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    maxAgeMs: ORPHANED_RESPAWN_MAX_AGE_MS,
    ...overrides,
  };
}

/**
 * One orphaned-carry-respawn sweep: alarm on every pending respawn past
 * cap+grace whose host is gone. Exported for focused tests.
 *
 * Per-owner failures are swallowed rather than aborting the sweep — one
 * unreadable ledger must not hide every other orphan. A failed escalate is also
 * non-fatal: the pending row is still there next tick, and the
 * (dedupKind, subjectSignature) dedup makes the retry idempotent.
 */
export async function runOrphanedRespawnSweepOnce(
  overrides: Partial<OrphanedRespawnSweepDeps> = {},
): Promise<{ scanned: number; alerts: number; escalated: number; skipped: boolean }> {
  const deps = orphanSweepDeps(overrides);
  if (!(await deps.flagEnabled())) return { scanned: 0, alerts: 0, escalated: 0, skipped: true };

  const now = deps.now();
  const owners = await deps.listCandidates(now);
  let alerts = 0;
  let escalated = 0;

  for (const ownerId of owners) {
    let prior: PriorRespawn;
    try {
      prior = await deps.readPrior(ownerId, now);
    } catch {
      continue;
    }
    let live: boolean;
    try {
      live = deps.hostLive(ownerId);
    } catch {
      // FAIL SAFE TOWARD SILENCE: liveness is the evidence that turns a delay
      // into a loss. If we could not measure it, we have not established loss —
      // assume alive and stay quiet rather than alarm on a session that is fine.
      live = true;
    }
    const alert = orphanedRespawnAlert(ownerId, prior, live, { maxAgeMs: deps.maxAgeMs });
    if (!alert) continue;
    alerts += 1;
    try {
      await deps.escalate(alert);
      escalated += 1;
    } catch {
      /* retried next tick; escalation-side dedup absorbs the overlap */
    }
  }

  return { scanned: owners.length, alerts, escalated, skipped: false };
}

/** One rolling-window production carry-health sweep. Exported for focused tests. */
export async function runProductionCarryDeliverySweepOnce(
  overrides: Partial<ProductionCarryDeliverySweepDeps> = {},
): Promise<{ reading: ProductionCarryDeliveryReading | null; escalated: boolean; skipped: boolean }> {
  const deps = productionSweepDeps(overrides);
  if (!(await deps.flagEnabled())) return { reading: null, escalated: false, skipped: true };

  const now = deps.now();
  const reading = summarizeProductionCarryDelivery(await deps.readEvents(now, deps.windowMs), now, deps.windowMs);
  const breached =
    reading.terminalOutcomes >= deps.minTerminalOutcomes &&
    reading.deliveryRate != null &&
    reading.deliveryRate < deps.deliveryRateFloor;
  if (!breached) return { reading, escalated: false, skipped: false };

  await deps.escalate(reading);
  return { reading, escalated: true, skipped: false };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the carry-drill drop watchdog: a recurring process-level sweep.
 * Idempotent. Runtime gate: FLAGS.CARRY_DRILL_DROP_WATCHER (checked per tick).
 */
export function startCarryDrillDropWatchdog(opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? CARRY_DRILL_DROP_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let watermarkMs = Date.now() - CARRY_DRILL_DROP_BACKFILL_MS;
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'carry-drill-drop-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void (async () => {
        try {
          const result = await runCarryDrillDropSweepOnce(watermarkMs);
          watermarkMs = result.watermarkMs;
        } catch (e) {
          console.warn(
            `[carry-drill-drop-watchdog] drill sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        try {
          await runProductionCarryDeliverySweepOnce();
        } catch (e) {
          console.warn(
            `[carry-drill-drop-watchdog] production sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        try {
          await runOrphanedRespawnSweepOnce();
        } catch (e) {
          console.warn(
            `[carry-drill-drop-watchdog] orphan sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })().finally(() => {
        sweeping = false;
      });
    },
    { category: 'watchdog' },
  );
}
