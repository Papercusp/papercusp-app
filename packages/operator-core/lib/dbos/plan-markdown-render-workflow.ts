/**
 * plan-markdown-render-workflow.ts — the DBOS scheduled wrapper for the
 * auto-render projection (plan-markdown-auto-render-2026-06-06).
 *
 * Every 30s, project every changed + settled PG-canonical plan to its on-disk
 * markdown mirror under `apps/operator/docs/plans/<slug>.md` (archived →
 * `archive/`), and sweep orphans. All of the real logic (incremental watermark,
 * coalescing, settle guard, orphan sweep) lives in
 * `lib/harness/plan-markdown-render/` and is unit-tested without DBOS; this file
 * is the thin durable-scheduling shell.
 *
 * Opt-in (PAPERCUSP_DBOS_PLAN_RENDER=1 → dbosPlanRenderActive): `bootstrap.ts`
 * imports this module only when the flag is set, so the side-effecting
 * `DBOS.registerScheduled` below runs exactly once, before launch.
 *
 * Read-only projection: PG stays canonical; the mirror is derived and never read
 * back. git-sync commits the rendered files (that's the point — git-visible plans).
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';
import { planMarkdownRenderTick, RENDER_CRONTAB } from '../harness/plan-markdown-render';

async function planMarkdownRenderTickWf(): Promise<void> {
  await DBOS.runStep(
    async () => {
      const r = await planMarkdownRenderTick();
      if (r.rendered.length || r.removedOrphans.length) {
        console.log(
          `[plan-markdown-render] rendered ${r.rendered.length}` +
            (r.adopted.length ? `, adopted ${r.adopted.length}` : '') +
            (r.skippedUnsettled.length ? `, ${r.skippedUnsettled.length} unsettled` : '') +
            (r.removedOrphans.length ? `, removed ${r.removedOrphans.length} orphan(s)` : ''),
        );
      }
    },
    // The render is idempotent (write-on-drift), so a light retry covers a
    // transient PG/fs hiccup; the next 30s tick is the real backstop.
    { name: 'plan-markdown-render', retriesAllowed: true, maxAttempts: 2, intervalSeconds: 15 },
  );
}

const planMarkdownRenderWorkflow = idempotentRegisterWorkflow('planMarkdownRender', () =>
  DBOS.registerWorkflow(planMarkdownRenderTickWf, {
    name: 'planMarkdownRender',
    maxRecoveryAttempts: 5,
  }),
);

// Default skip-missed mode — a long-closed desktop must not backfill a storm of
// ticks; the next live tick renders whatever changed while it was down.
DBOS.registerScheduled(planMarkdownRenderWorkflow, {
  name: 'planMarkdownRender',
  crontab: RENDER_CRONTAB,
});
