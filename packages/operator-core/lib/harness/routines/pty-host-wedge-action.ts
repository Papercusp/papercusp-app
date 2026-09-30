/**
 * `system:sweep-wedged-pty-hosts` — the registration seam for
 * {@link sweepWedgedPtyHosts} (EI-20287339148365013).
 *
 * Thin by design, matching `stalled-loops-action.ts`: the sweep logic lives in
 * `pty-host-wedge-guard.ts`; this file only puts it on a cadence.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `dry_run` — report matches without broadcasting or paging.
 *   - `min_consecutive_defers`, `min_streak_span_ms`, `recovery_idle_ms` — composer-class
 *     threshold overrides, for tightening the guard from the routine row without a deploy.
 *   - `busy_gate_min_defers`, `busy_gate_min_streak_span_ms`, `busy_gate_max_quiet_fraction`
 *     — the same for the busy-gate class (WI-2141553), kept separate because the two
 *     classes are calibrated against different things.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sweepWedgedPtyHosts } from './pty-host-wedge-guard';

registerSystemAction('sweep-wedged-pty-hosts', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const result = await sweepWedgedPtyHosts({
    dryRun: cfg.dry_run === true,
    ...(typeof cfg.min_consecutive_defers === 'number'
      ? { minConsecutiveDefers: cfg.min_consecutive_defers }
      : {}),
    ...(typeof cfg.min_streak_span_ms === 'number' ? { minStreakSpanMs: cfg.min_streak_span_ms } : {}),
    ...(typeof cfg.recovery_idle_ms === 'number' ? { recoveryIdleMs: cfg.recovery_idle_ms } : {}),
    // Busy-gate class (WI-2141553) — separate dials on purpose; see the guard's options doc.
    // These matter more than the composer ones right now: that class's span floor is
    // reasoned rather than calibrated, so tightening it from the routine row is how it gets
    // tuned against the live population without a deploy.
    ...(typeof cfg.busy_gate_min_defers === 'number' ? { busyGateMinDefers: cfg.busy_gate_min_defers } : {}),
    ...(typeof cfg.busy_gate_min_streak_span_ms === 'number'
      ? { busyGateMinStreakSpanMs: cfg.busy_gate_min_streak_span_ms }
      : {}),
    ...(typeof cfg.busy_gate_max_quiet_fraction === 'number'
      ? { busyGateMaxQuietFraction: cfg.busy_gate_max_quiet_fraction }
      : {}),
  });

  if (result.wedged.length > 0) {
    // WARN, and naming the SAFETY split rather than just the count: the two populations
    // need opposite handling. An `idle` host can be replaced; a `busy` one is still
    // emitting output and must not be touched — it is working, it just cannot be reached.
    const idle = result.wedged.filter((w) => w.recoverySafety === 'idle');
    const busy = result.wedged.filter((w) => w.recoverySafety !== 'idle');
    // Counted by distinct OWNER, not by report: a host can be named by more than one wedge
    // class, and a line that says "3 hosts" about 2 hosts is the kind of inflation nobody
    // re-derives before acting on it.
    const owners = new Set(result.wedged.map((w) => w.ownerId));
    // The CLASS is named per host rather than summarised away, because the two mean
    // different things to whoever reads this: `composer` is deferring against a staged line
    // that never moves, `busy-gate` never reaches its prompt at all.
    console.warn(
      `[sweep-wedged-pty-hosts] WAKE-DEAF ${owners.size}/${result.checked} live pty-host(s). ` +
        `${idle.length} idle (safe to replace), ${busy.length} still emitting (do NOT trample): ` +
        result.wedged.map((w) => `${w.ownerId}[${w.wedgeClass}]×${w.verdict.consecutiveDefers}`).join(', '),
    );
  }

  // An unreadable ledger is an ABSENCE OF EVIDENCE, not a clean bill of health, and it is
  // logged separately for that reason: a rising count here means the guard is going blind
  // (pruned/rotated ledgers, permissions, a renamed dir) while its wedged count — the
  // number anyone actually reads — would keep reporting a reassuring zero.
  if (result.unreadable.length > 0) {
    console.log(
      `[sweep-wedged-pty-hosts] ${result.unreadable.length}/${result.checked} host(s) had no readable ` +
        `lifecycle ledger — NOT a health verdict, these hosts were simply not observable this pass`,
    );
  }
});
