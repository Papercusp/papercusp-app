/**
 * `system:acceptance-drain-sweep` — P-020 of design-to-code-coverage-seam-2026-09-02.
 *
 * The EXIT half of the acceptance gate. `system:plan-drain-sweep` (its sibling in
 * this directory) pushes plans INTO `awaiting-acceptance`; nothing pulled them
 * out, and nothing told anyone they were there. This tick files ONE claimable
 * work item per held plan, naming the gate's actual first blocker.
 *
 * Thin registration seam only: all logic — every exclusion, the cap, and the
 * reasons for both — lives in `agent-tools/plans/acceptance-drain-sweep.ts`, and
 * the authoritative verdict stays in `evaluatePlanAcceptanceGate`, the same
 * evaluator `plans:set-plan-status` enforces. No second definition of "may this
 * ship" is introduced here; a read that disagreed with the real refusal would be
 * worse than no read at all.
 *
 * Config (routine `trigger_config`, optional):
 *   - `maxFilings` — override ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN (25), the
 *     per-tick bound on items FILED. Bounds the first tick against the measured
 *     187-plan accumulated backlog.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { runAcceptanceDrainSweepOnce } from '../../agent-tools/plans/acceptance-drain-sweep';

registerSystemAction('acceptance-drain-sweep', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const maxFilings = Number(cfg.maxFilings);
  const result = await runAcceptanceDrainSweepOnce(
    Number.isFinite(maxFilings) && maxFilings > 0 ? { maxFilings } : {},
  );

  // Quiet on a clean no-op tick — the steady state once the backlog drains. A
  // tick that FILED something, DEFERRED past the cap, errored, or found a plan
  // shippable-right-now gets a line. A permanently nonzero `deferred` means the
  // cap is below the arrival rate and must be visible rather than quietly lossy;
  // a persistent `shippableNow` means finished plans are one call from shipped
  // and nobody is making it, which is its own thing to see.
  if (
    result.filed.length > 0 ||
    result.deferred > 0 ||
    result.errors.length > 0 ||
    result.shippableNow > 0 ||
    result.refreshed > 0 ||
    result.ready > 0 ||
    result.unknown > 0 ||
    result.escalated > 0 ||
    result.reconciled > 0 ||
    result.skipped
  ) {
    console.log(`[acceptance-drain-sweep] ${ctx.installSlug}: ${result.summary}`);
    // One line per filing. Work filed against a historical plan must never be
    // traceable only to "a sweep did it".
    for (const f of result.filed) {
      console.log(
        `[acceptance-drain-sweep]   ${f.harnessSlug}/${f.planSlug}: ${f.code} → ${f.workItemId ?? '(no id)'}`,
      );
    }
    for (const e of result.errors) console.warn(`[acceptance-drain-sweep]   ${e}`);
  }
});
