/**
 * WI-10002822 — the background host's boot migration gate, with in-place retry.
 *
 * host-bootstrap withholds every schema-dependent background subsystem (routines,
 * the P2P substrate, reapers) until pending migrations apply, because running them
 * against an older schema turns one pending migration into a fleet-wide retry storm.
 * That gate used to be ONE-SHOT: a failed boot apply logged "restart this host" and
 * returned, and nothing ever re-checked. On 2026-09-23 two migrations failed at
 * 21:50Z (pre-destructive snapshot admission refused), were applied out of band at
 * 23:29Z, and the tower's whole P2P substrate stayed down until a human restarted
 * bg-host at 23:44Z — 1h54m with every pot's replication dark and no alarm, while
 * the request plane and routines made the host look healthy.
 *
 * This module is the durable fix: while the gate is failed it re-runs the apply on a
 * bounded tick (the migration ledger makes an out-of-band apply visible within one
 * tick, and db-boot-migrate's per-file cooldown throttles real re-attempts), pages
 * ONCE per episode when the background plane has been withheld past a threshold, and
 * RETURNS on success so the caller falls through into the normal background startup
 * — the substrate boots in place, no restart. The routing latch needs no surgery:
 * `bootSubstrateWithFallback` → `setSubstrateBootDefaults` already clears the
 * fail-closed marker that `markSubstrateBootRoutingFailed` set.
 *
 * Deps are injected so the whole episode (fail → still failing → alarm → repaired →
 * recovered) is unit-testable without Postgres, timers or a coord bus.
 */
import type { BootMigrateResult } from './db-boot-migrate';

/** How often a withheld host re-checks its migrations. One tick is also the
 *  worst-case delay between an out-of-band apply and the substrate booting. */
export const BOOT_MIGRATION_RETRY_INTERVAL_MS = 60_000;

/** How long the background plane may stay withheld before the host pages. Long
 *  enough to ride out a migration waiting behind an in-flight backup snapshot,
 *  short enough that an outage is not discovered by a peer an hour later. */
export const BOOT_MIGRATION_ALARM_AFTER_MS = 10 * 60_000;

export interface BootMigrationGateAlarm {
  /** One-line reason the plane is withheld (the pending/failed files). */
  failureSummary: string;
  /** Epoch ms the gate first failed this process. */
  withheldSince: number;
  /** How long it has been withheld at the moment of the call. */
  withheldMs: number;
  /** Completed retry attempts so far (not counting the first boot apply). */
  retries: number;
}

export interface BootMigrationGateDeps {
  /** The first, boot-time apply (the once-per-process `applyPendingMigrationsAtBoot`). */
  applyAtBoot: () => Promise<BootMigrateResult | null>;
  /**
   * A retry apply. MUST NOT be `applyPendingMigrationsAtBoot` — its once-per-process
   * guard returns `null` on every later call, which reads as "migration state could
   * not be determined" forever. Use `applyPendingMigrationsNow({ broadcast: false })`.
   */
  applyRetry: () => Promise<BootMigrateResult | null>;
  /** Called once, on the first failure: publish the fail-closed routing decision. */
  onWithheld: (failureSummary: string) => void | Promise<void>;
  /** Page once per episode after `alarmAfterMs` withheld. Must not throw. */
  raiseAlarm: (alarm: BootMigrationGateAlarm) => Promise<void>;
  /** Retract the page when the gate recovers. Called only if `raiseAlarm` ran. */
  clearAlarm: (alarm: BootMigrationGateAlarm) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  error?: (line: string) => void;
  retryIntervalMs?: number;
  alarmAfterMs?: number;
}

export interface BootMigrationGateOutcome {
  /** The successful apply result the caller proceeds on. */
  result: BootMigrateResult;
  /** True when the first boot apply failed and a later retry passed the gate. */
  recoveredInPlace: boolean;
  retries: number;
  /** How long the background plane was withheld (0 when the first apply passed). */
  withheldMs: number;
  alarmed: boolean;
}

/** A result passes the gate only when it is conclusive AND failure-free. */
export function bootMigrationGatePassed(result: BootMigrateResult | null): result is BootMigrateResult {
  return result !== null && result.failed.length === 0;
}

export function bootMigrationFailureSummary(result: BootMigrateResult | null): string {
  if (!result) return 'migration state could not be determined';
  return `${result.failed.length} migration(s) remain pending: ${result.failed.map((f) => f.file).join(', ')}`;
}

function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // unref: a withheld gate must never be the thing that keeps a stopping host alive.
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Resolve once pending migrations are applied — immediately on a clean boot, or after
 * however many retries it takes on a withheld one. Never throws for a failed apply
 * (only a throwing dep can reject it); never returns while the gate is still failed.
 */
export async function awaitBootMigrationGate(deps: BootMigrationGateDeps): Promise<BootMigrationGateOutcome> {
  const sleep = deps.sleep ?? unrefSleep;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const retryIntervalMs = deps.retryIntervalMs ?? BOOT_MIGRATION_RETRY_INTERVAL_MS;
  const alarmAfterMs = deps.alarmAfterMs ?? BOOT_MIGRATION_ALARM_AFTER_MS;

  const first = await deps.applyAtBoot();
  if (bootMigrationGatePassed(first)) {
    return { result: first, recoveredInPlace: false, retries: 0, withheldMs: 0, alarmed: false };
  }

  const withheldSince = now();
  let failureSummary = bootMigrationFailureSummary(first);
  error(
    `[boot-migrate] 🚨 BACKGROUND STARTUP WITHHELD: ${failureSummary}. ` +
      'The request plane may still start after its bounded gate timeout, but schema-dependent background machinery ' +
      `(routines, the P2P substrate) stays off. This host re-checks every ${Math.round(retryIntervalMs / 1000)}s and ` +
      'starts the background plane IN PLACE once the migrations are applied — no restart needed.',
  );
  await deps.onWithheld(failureSummary);

  let retries = 0;
  let alarmed = false;
  const snapshot = (): BootMigrationGateAlarm => ({
    failureSummary,
    withheldSince,
    withheldMs: now() - withheldSince,
    retries,
  });

  for (;;) {
    await sleep(retryIntervalMs);
    const result = await deps.applyRetry();
    retries += 1;
    if (bootMigrationGatePassed(result)) {
      const recovered = snapshot();
      log(
        `[boot-migrate] ✅ migration gate RECOVERED after ${Math.round(recovered.withheldMs / 1000)}s withheld ` +
          `(${retries} retr${retries === 1 ? 'y' : 'ies'}); starting the background plane in place.`,
      );
      if (alarmed) await deps.clearAlarm(recovered);
      return { result, recoveredInPlace: true, retries, withheldMs: recovered.withheldMs, alarmed };
    }
    const nextSummary = bootMigrationFailureSummary(result);
    if (nextSummary !== failureSummary) {
      failureSummary = nextSummary;
      error(`[boot-migrate] background plane still withheld: ${failureSummary}`);
    }
    if (!alarmed && now() - withheldSince >= alarmAfterMs) {
      alarmed = true;
      await deps.raiseAlarm(snapshot());
    }
  }
}

/** Stable per-host condition key, so the recovery broadcast resolves the same alarm. */
export function bootMigrationGateConditionKey(host: string): string {
  return `boot-migration-gate-withheld:${host}`;
}

/**
 * Production alarm: an urgent owner-attention notification plus a one-shot severe
 * broadcast carrying a condition key that the recovery leg resolves. Best-effort by
 * contract — a paging failure is logged, never allowed to wedge the retry loop.
 */
export async function raiseBootMigrationGateAlarm(alarm: BootMigrationGateAlarm, host: string): Promise<void> {
  const minutes = Math.round(alarm.withheldMs / 60_000);
  const summary =
    `🚨 ${host}: background plane (routines + P2P substrate) WITHHELD for ${minutes}m — ${alarm.failureSummary}. ` +
    'Every pot replicating through this host is dark until the migrations apply.';
  const body =
    `The boot migration gate failed at ${new Date(alarm.withheldSince).toISOString()} and has not passed in ` +
    `${alarm.retries} retries. Repair/apply the pending migration (db:migrate, or fix the cause the boot log names); ` +
    'the host re-checks every minute and boots the background plane in place, so a restart is NOT required. ' +
    'Do not force-restart just to clear this page: a restart cannot apply a migration that is still failing.';
  try {
    const { notifyAttention } = await import('./attention-notify');
    await notifyAttention({
      kind: 'intervention',
      title: `Background plane withheld on ${host}: boot migrations pending`,
      body: `${summary}\n\n${body}`,
      importance: 'urgent',
      data: { host, withheldSince: alarm.withheldSince, retries: alarm.retries, failure: alarm.failureSummary },
    });
  } catch (e) {
    console.warn(`[boot-migrate] gate alarm notify failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
  try {
    const { broadcastSevereEvent } = await import('./severe-event-broadcast');
    await broadcastSevereEvent({
      summary,
      body,
      category: 'severe-event',
      conditionKey: bootMigrationGateConditionKey(host),
      oneShot: true,
    });
  } catch (e) {
    console.warn(`[boot-migrate] gate alarm broadcast failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}

export async function clearBootMigrationGateAlarm(alarm: BootMigrationGateAlarm, host: string): Promise<void> {
  try {
    const { broadcastSevereEventResolved } = await import('./severe-event-broadcast');
    await broadcastSevereEventResolved({
      conditionKey: bootMigrationGateConditionKey(host),
      summary:
        `${host}: boot migration gate RECOVERED after ${Math.round(alarm.withheldMs / 60_000)}m — ` +
        'the background plane (routines + P2P substrate) is starting in place.',
    });
  } catch (e) {
    console.warn(`[boot-migrate] gate alarm resolve failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}
