/**
 * `system:reconcile-silent-halts` — the registration seam for {@link sweepSilentHalts}
 * (WI-35718).
 *
 * Thin by design, matching `stalled-loops-action.ts`: the sweep logic lives in
 * `silent-halt-reconcile.ts`; this file only puts it on a cadence.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `dry_run` — report halts without paging the owner.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sweepSilentHalts, SILENT_HALT_MAX_PAGES_PER_SWEEP } from './silent-halt-reconcile';

registerSystemAction('reconcile-silent-halts', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const result = await sweepSilentHalts({ workspaceId: ctx.workspaceId, dryRun: cfg.dry_run === true });

  if (result.halted.length > 0) {
    console.warn(
      `[reconcile-silent-halts] SILENTLY HALTED ${result.halted.length}/${result.checked} autonomous ` +
        `session(s) — process alive, autonomy posture registered, loop inactive, no pending await, no ` +
        `recent turn. Nothing will wake these without a human: ${result.halted.join(', ')}` +
        (result.dryRun ? ' (dry_run — no owner page sent)' : ` — paged ${result.paged.length}`),
    );
  }

  // A mass halt is ONE incident (a wedged host, a deploy, an operator restart), not N independent
  // faults — so the page count is capped and the CAP ITSELF is the newsworthy line. Without this,
  // a fleet-wide event reads in the log as a handful of unrelated pages.
  if (result.pageCapReached) {
    console.warn(
      `[reconcile-silent-halts] PAGE CAP hit — ${result.halted.length} halted sessions exceeded the ` +
        `${SILENT_HALT_MAX_PAGES_PER_SWEEP}-page cap, so only a sample was paged. A halt cluster this ` +
        `size is usually one systemic event (wedged host, deploy, operator restart), not N independent ` +
        `agent faults — chase the common cause, not the sample.`,
    );
  }

  // Diagnostic value INVERTED from its siblings, and this is the line to read when the module looks
  // quiet. `exempt` names why each live candidate was spared; a healthy fleet is mostly
  // `pending-await` (an await IS a wake source — 63 of 67 live candidates at authoring time). If
  // this collapses to mostly `no-presence-row`, the liveness join has stopped matching and the
  // sweep has quietly reverted to the 4,037-row metronome this module exists to avoid.
  const exemptions = Object.values(result.exempt);
  if (exemptions.length > 0 && result.halted.length === 0) {
    const byKind = exemptions.reduce<Record<string, number>>((acc, e) => {
      const kind = e.split(' ')[0] ?? 'unspecified';
      acc[kind] = (acc[kind] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `[reconcile-silent-halts] clean — ${result.checked} live candidate(s), 0 halted; exempt by: ` +
        Object.entries(byKind)
          .map(([k, n]) => `${k}=${n}`)
          .join(', '),
    );
  }
});
