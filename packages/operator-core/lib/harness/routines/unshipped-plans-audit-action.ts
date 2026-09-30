/**
 * `system:unshipped-plans-audit` — the registered read-only portfolio audit.
 *
 * This action is intentionally NOT seeded onto a cadence. The owner invokes it
 * through `plans:audit-unshipped`, matching the existing git-sync:run and
 * release:checkpoint-run manual system-action pattern. Registration keeps the
 * action on the routines engine's one canonical action seam without authoring a
 * cron row or allowing the audit to mutate lifecycle state.
 */
import { runUnshippedPlansAudit } from '../../unshipped-plans-audit';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const UNSHIPPED_PLANS_AUDIT_ACTION = 'unshipped-plans-audit';

export async function fireUnshippedPlansAudit(ctx: SystemActionCtx) {
  const result = await runUnshippedPlansAudit({
    workspaceId: ctx.workspaceId,
    artifactHarness: ctx.installSlug,
  });
  console.log(
    `[unshipped-plans-audit] ${ctx.workspaceId}: classified ${result.manifest.rows.length} nonterminal plan(s); ` +
      `protected ${result.manifest.bands.protected}, blockers ${result.manifest.bands.blockerClaims}, ` +
      `supersede/retire ${result.manifest.bands.supersedeOrRetire}`,
  );
}

registerSystemAction(UNSHIPPED_PLANS_AUDIT_ACTION, fireUnshippedPlansAudit);
