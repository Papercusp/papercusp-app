/**
 * Autonomy trust-scan system action (queen-autonomy-policy-2026-06-13 B-16 /
 * P-080, P-081, P-082) — `system:autonomy-trust-scan`, the cadence that runs the
 * two legs over the tripwire ledger: (1) evaluate armed tripwires → trip
 * (revert + demote + notify) / clear; (2) recount per-(category, class) clean
 * passes → raise graduated_level within the ceiling + file owner
 * "graduation-eligible" reports. It NEVER raises a ceiling itself (owner
 * authority — the report is the ask).
 *
 * GATED on `papercusp-queen-autonomy-armed` (P-092): unarmed ⇒ the scan no-ops
 * (and there are no tripwire rows anyway, since nothing auto-decides unarmed),
 * so arming autonomy is the single switch that lights the trust loop —
 * behavior-neutral until then (D-007). Thresholds tune from payload_template
 * (threshold, recurrenceWindowDays, lookbackDays, maxReportsPerTick;
 * `mineOnly: true` is the supervised dry mode). Runs as ONE durable step and
 * never throws (the try/catch); idempotent (clears/trips CAS on armed, reports
 * dedup on their watchdogKey, graduated_level writes are no-ops at the earned level).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import {
  autonomyTrustScanOptionsFromPayload,
  defaultAutonomyTrustScanDeps,
  runAutonomyTrustScan,
  type AutonomyTrustScanDeps,
} from '../../autonomy/tripwire/scan';

/** The deps seam — injectable for tests (mirrors setGraduationTickDeps). */
let _deps: AutonomyTrustScanDeps | null = null;
/** Override the scan deps (tests). Pass null to restore the live PG-backed deps. */
export function setAutonomyTrustScanDeps(deps: AutonomyTrustScanDeps | null): void {
  _deps = deps;
}

registerSystemAction('autonomy-trust-scan', async (ctx: SystemActionCtx) => {
  try {
    const deps =
      _deps ??
      defaultAutonomyTrustScanDeps(
        (await import('@papercusp/db-org')).getOrgPg().sql,
        ctx.workspaceId,
      );
    const opts = autonomyTrustScanOptionsFromPayload(ctx.payloadTemplate);
    const outcome = await runAutonomyTrustScan(deps, opts);
    if (!outcome.ran) {
      console.log(
        '[autonomy-trust-scan] papercusp-queen-autonomy-armed is OFF (P-092 owner gate) — ' +
          'skipping (no auto-decisions exist unarmed)',
      );
      return;
    }
    const s = outcome.sweep;
    const g = outcome.graduation;
    console.log(
      `[autonomy-trust-scan] sweep: ${s?.armed ?? 0} armed → ${s?.cleared ?? 0} cleared, ` +
        `${s?.tripped ?? 0} tripped (${s?.reverted ?? 0} reverted) · ` +
        `graduation: ${g?.classes ?? 0} class(es), raised ${g?.raised.length ?? 0}, ` +
        `${g?.eligible.length ?? 0} eligible, filed ${g?.filed.length ?? 0} · ` +
        `rails: gym ${s?.legs.gym ? 'live' : 'inactive'}, ekg ${s?.legs.ekg ? 'live' : 'inactive'}`,
    );
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[autonomy-trust-scan] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
