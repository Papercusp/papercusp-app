/**
 * Lost-wake watchdog collector (EI-10869).
 *
 * Wires `events/await/lost-wake-detect.ts`'s pure rate-scan + witness detector into the
 * fleet-visible improvement pipeline (mirrors dark-flag-age-detect.ts / release-deploy-staleness-
 * detect.ts: a pure detector + a thin IO collector, own structural type so it needs no import
 * from the large watchdog.ts).
 *
 * ONLY CONVICTED findings page — a SUSPECT (no independent witness, or the witness could not
 * confirm the underlying condition occurred) is deliberately never surfaced here. Paging on an
 * unwitnessed suspect is exactly the false-positive machine the module doc warns about (a
 * legitimately-rare event's healthy timeout-heavy rate would page constantly). Suspects stay
 * visible via the on-demand `events:lost-wake-check` reader for manual review.
 *
 * WORKSPACE-GLOBAL (`harness_shared.event_awaits` lives in the one coord workspace, not
 * per-harness) — deliberately NOT a HARNESS_SCOPED_WATCHDOG_SOURCES entry.
 */
import { findLostWakes, type LostWakeFinding } from '../../events/await/lost-wake-detect';

/** Structurally a WatchdogSignal (own type so this pure-ish module needs no import from the
 *  large watchdog.ts) — mapped 1:1 onto one at the collector-registration site. */
export interface LostWakeSignal {
  source: 'lost-wake';
  key: string;
  title: string;
  body: string;
  severity: 'major';
  kind: 'bug';
  scope: 'operator';
  paths: string[];
}

/** Pure: convicted findings → signals. Reuses `findLostWakes`'s verdict directly — this module
 *  adds no detection logic of its own, only the "make it fleet-visible" wire. */
export function detectLostWakes(findings: readonly LostWakeFinding[]): LostWakeSignal[] {
  return findings
    .filter((f): f is LostWakeFinding & { witness: NonNullable<LostWakeFinding['witness']> } => f.verdict === 'convicted' && f.witness != null)
    .map((f) => ({
      source: 'lost-wake' as const,
      // stable per-key dedup — a re-fire within the same lost-wake episode collapses to one open EI.
      key: `lost-wake:${f.eventKey}`,
      title: `Awaitable event '${f.eventKey}' has a degenerate real-fire rate — awaiters are silently timing out instead of waking`,
      body:
        `Watchdog signal (lost-wake, EI-10869's detector): '${f.eventKey}' settled ${f.settled} awaits in the ` +
        `window (${f.fired} by event, ${f.timedOut} by timeout — ${f.pctRealFire}% real-fire rate).\n\n` +
        `Independent witness (${f.witness.name}, owner ${f.witness.owner}): ${f.witness.evidence}\n\n` +
        `This is EI-10800's class: the condition PRODUCED a verdict AND the awaits parked ACROSS that ` +
        `verdict failed to wake — see the witness evidence above for the overlap counts, which are what ` +
        `convict. (A low overall real-fire rate on its own is NOT this and never convicts: an awaiter only ` +
        `wakes if the condition resolves during its own parked window, so a rare event is timeout-heavy ` +
        `while perfectly healthy — EI-20323150675466298.)\n\n` +
        `Start at the emit call site for '${f.eventKey}' in ${f.witness.owner}. ⚠ Do NOT assume the classic ` +
        `fire-and-forget \`void emitAwaitedEvent(...)\` teardown race: it was already remediated for the ` +
        `gate-verdict keys under EI-10800, so VERIFY the emit is un-awaited before "fixing" it. If it is ` +
        `already awaited, the defect is downstream — the delivery/registration path, not the emit.`,
      severity: 'major' as const,
      kind: 'bug' as const,
      scope: 'operator' as const,
      // The path that OWNS the emit, per the witness that convicted — not this detector. Hardcoding
      // the detector path here sent seven successive sessions to the measuring code instead of the
      // suspect code (EI-20323150675466298); the owning path was already in hand and thrown away.
      paths: [f.witness.owner],
    }));
}

/**
 * The collector: reads the live rate scan + runs witnesses, then maps convicted findings onto
 * signals. Fail-soft: any error is a note, never a throw (a watchdog collector that crashes its
 * host guards nothing).
 */
export async function collectLostWakeSignals(opts: {
  sinceMs?: number;
} = {}): Promise<{ signals: LostWakeSignal[]; note?: string }> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const findings = await findLostWakes(getOrgPg().sql, { sinceMs: opts.sinceMs });
    return { signals: detectLostWakes(findings) };
  } catch (e) {
    return { signals: [], note: `lost-wake collector errored: ${e instanceof Error ? e.message : String(e)}` };
  }
}
