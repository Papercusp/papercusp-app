/**
 * recipes:sweep — retire the stale long-tail of never-reused one-off code:run
 * RECIPES so the corpus doesn't accumulate dead weight (mirror
 * knowledge_packs:sweep; code-recipes-2026-06-21 Phase 4, P-010).
 *
 * Selects ACTIVE recipes whose last_run_at is older than `staleDays` AND whose
 * run_count is at or below `maxRunCount` (one-offs nobody reused), and flips them
 * to status='retired'. It NEVER touches a hot recipe (run_count over the cap), a
 * recipe run recently, or a promoted / merged / already-retired one (the
 * status='active' filter) — hygiene can't strand a graduated or consolidated
 * recipe. Reversible (a status flip).
 *
 * PREVIEW-FIRST: dryRun defaults to TRUE — the first call returns the candidates
 * WITHOUT changing anything; pass dryRun:false to actually retire them. A REVIEW
 * / curation action (not bee-authored) → SU_ROLES only.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { sweepRecipes } from '../../code-recipes-store';

export default defineTool({
  name: 'recipes:sweep',
  description:
    'Retire the stale long-tail of never-reused one-off code:run RECIPES (active, last run older than ' +
    'staleDays AND run_count <= maxRunCount). NEVER retires a hot, recently-run, promoted, or merged ' +
    'recipe. dryRun (DEFAULT TRUE) previews the candidates without changing anything — pass ' +
    'dryRun:false to actually retire. Reversible (a status flip). `ids` instead retires exactly those ' +
    'recipes at any age/run-count (still active + non-promoted only), reporting misses in `skipped`.',
  guidance: {
    when:
      'Periodic hygiene (an idle-turn task) to clear the long tail of one-off recipes that were ' +
      'authored on a single run and never reused. ALWAYS run it once with the default dryRun:true to ' +
      'review the candidates, then dryRun:false to retire them.',
    notWhen:
      'To merge near-duplicates (recipes:merge) or to find promote candidates (recipes:candidates). ' +
      'Don\'t lower staleDays/raise maxRunCount to reach ONE specific recipe — that is what `ids` is ' +
      'for; widening the heuristic retires the whole long tail with it (on this corpus the 30-day ' +
      'default matches 0 while staleDays:1 matches thousands).',
    chaining:
      'recipes:sweep { dryRun: true } (review the would-retire list) → recipes:sweep { dryRun: false } ' +
      '(commit). recipes:get { id } to inspect any candidate before committing.',
    seeAlso: [
      'recipes:merge (collapse near-duplicates instead of retiring)',
      'recipes:candidates (find promote candidates in the same pass)',
      'recipes:get (inspect a would-retire recipe first)',
    ],
  },
  // Mutates the recipe corpus on a real run; dryRun is a preview WITHIN the write
  // tool (the same dryRun-on-a-write-capability shape recipes:run uses).
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    staleDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Retire recipes last run more than this many days ago (default 30).'),
    maxRunCount: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Only retire recipes run at most this many times — the one-off cap (default 1).'),
    dryRun: z
      .boolean()
      .optional()
      .describe('Preview only — return the candidates without retiring them. DEFAULTS TO TRUE; pass false to commit.'),
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .optional()
      .describe(
        'TARGETED retire of exactly these recipe ids, instead of the staleDays/maxRunCount heuristic ' +
          '(which cannot reach one specific recipe without sweeping the whole long tail with it). Still ' +
          'retires only ACTIVE, non-promoted recipes; every requested id not retired comes back in `skipped` ' +
          'with a reason (not_found / promoted / not_active). dryRun still defaults to TRUE.',
      ),
  }),
  async handler(args, ctx) {
    // Preview-first: default to dryRun unless the caller explicitly commits.
    const dryRun = args.dryRun ?? true;
    const { swept, skipped } = await sweepRecipes(getOrgPg().sql, {
      staleDays: args.staleDays,
      maxRunCount: args.maxRunCount,
      ids: args.ids,
      dryRun,
    });

    // Live-update the /admin/recipes dashboard (P-009): a real sweep that retired
    // anything shifts the list + the candidate worklist. A dryRun mutates nothing,
    // so it never invalidates. Best-effort.
    if (!dryRun && swept.length > 0) {
      const { notifyRecipesChanged } = await import('../code/capture-recipe');
      await notifyRecipesChanged((msg) => ctx.log(msg));
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            dryRun,
            ...(args.ids ? { targeted: true } : {}),
            count: swept.length,
            recipes: swept.map((r) => ({
              id: r.id,
              title: r.title,
              runCount: r.runCount,
              successCount: r.successCount,
              lastRunAt: r.lastRunAt,
              status: r.status,
            })),
            // A targeted sweep reports the ids it did NOT retire: a short `recipes`
            // list is otherwise indistinguishable from a typo'd or already-retired id.
            ...(skipped && skipped.length > 0 ? { skipped } : {}),
          }),
        },
      ],
    };
  },
});
