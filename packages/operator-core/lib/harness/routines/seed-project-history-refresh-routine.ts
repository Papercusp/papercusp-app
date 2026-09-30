/**
 * Seed a `project-history-refresh` routine — `system:project-history-refresh` →
 * `project-history-refresh-action.ts`, the refresh owner for a hive's committed
 * Project History artifact (EI-20475585438015488, cause 3).
 *
 * Defaults describe SIDESTAGE, the first hive to ship a History tab, but every
 * field is a flag: a second hive seeds another row and needs no code change.
 *
 *   tsx seed-project-history-refresh-routine.ts                    # seed sidestage ACTIVE
 *   tsx seed-project-history-refresh-routine.ts --inactive         # seed off
 *   tsx seed-project-history-refresh-routine.ts --harness other \
 *        --repo-root /path/to/hive --output apps/api/src/history.ts \
 *        --project-id other --project-name Other --export-name HISTORY
 *
 * CADENCE: every 2 hours at :50. Offset from the :15 green-checkpoint, :35
 * gitnexus-reindex and :45 cargo-test so a generation never starts in the same tick
 * minute as the release gate.
 *
 * Two hours is a MEASURED choice, not a guess (2026-08-17):
 *   - COST: a full SideStage generation ran in 30s (51 plans, ~2.2MB artifact). That
 *     is cheap enough that the cadence is bounded by taste, not by budget.
 *   - DRIFT: `--check` (which normalises `generatedAt` before comparing, so it is a
 *     genuine CONTENT test) reported the artifact ALREADY STALE ~3.5h after a fresh
 *     generation. Plans and work-items move continuously on this fleet, so a 6h
 *     cadence would leave the History tab visibly behind for most of every window.
 * A regeneration that yields identical bytes is a git no-op, so the cost of running
 * more often than strictly needed is 30s of subprocess, while the cost of running
 * less often is the stale archive this routine exists to prevent.
 *
 * ⚠ REPO ROOT: the canonical SideStage tree is the HIVE tree
 * (`~/.papercusp/hives/sidestage`), which is what the running API serves from
 * (it executes `src/main.ts` under tsx, so it reads SRC, not dist). The sibling
 * `papercupai-workspace/sidestage` checkout is VESTIGIAL. Pointing this routine at
 * the vestigial tree would regenerate an artifact nothing serves, and the History
 * tab would keep decaying while the routine reported success every six hours.
 *
 * Seeded ACTIVE by default: the action is precondition-gated (it refuses rather
 * than writing when the CLI or `ptool` cannot be resolved), bounded by a timeout,
 * and writes exactly one artifact path that an operator supplied explicitly — so
 * an active routine is safe from the moment it exists. Finished work never ships
 * dark (CLAUDE.md). `--inactive` seeds it off for an explicit dark launch.
 */
import * as os from 'node:os';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  return fallback;
}

/**
 * Where the hive trees live.
 *
 * ⚠ PAPERCUSP_HOME IS NOT RELIABLE HERE and is deliberately tried SECOND. On this box
 * it is workspace-scoped (`~/.papercusp-workspaces/<ws>/.papercusp`), so preferring it
 * resolved the SideStage root to
 * `~/.papercusp-workspaces/papercusp-workspace/.papercusp/hives/sidestage` — a path
 * that does not exist. That seeded a live routine whose every tick would have skipped
 * on "repo_root does not exist", i.e. a refresher that reports healthy while
 * refreshing nothing: precisely the silent decay this work-item exists to end
 * (caught 2026-08-17 by seeding it for real and reading the path back).
 *
 * So: return the first CANDIDATE THAT ACTUALLY EXISTS, and let main() refuse loudly if
 * none does, rather than emitting a plausible-looking path nobody checked.
 */
function hiveRootCandidates(slug: string): string[] {
  const home = process.env.PAPERCUSP_HOME?.trim();
  return [
    path.join(os.homedir(), '.papercusp', 'hives', slug),
    ...(home ? [path.join(home, 'hives', slug)] : []),
  ];
}

function defaultHiveRoot(slug: string): string {
  const candidates = hiveRootCandidates(slug);
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

/** Every 2h at :50 — clear of green-checkpoint (:15), gitnexus-reindex (:35), cargo-test (:45). */
const CRON = '0 50 */2 * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const harness = flag('harness', 'sidestage');
  const repoRoot = flag('repo-root', defaultHiveRoot(harness));
  const output = flag('output', 'apps/api/src/build-history/build-history.snapshot.ts');
  const projectId = flag('project-id', harness);
  const projectName = flag('project-name', harness === 'sidestage' ? 'SideStage' : harness);
  const exportName = flag('export-name', harness === 'sidestage' ? 'BUILD_HISTORY_SNAPSHOT' : 'PROJECT_HISTORY');
  const planPrefix = flag('plan-prefix', '');

  if (!existsSync(repoRoot)) {
    console.error(
      `[seed-project-history-refresh-routine] REFUSING: repo_root does not exist: ${repoRoot}\n` +
        '  A routine seeded against a missing tree ticks forever, skips every time, and reports healthy\n' +
        '  while refreshing nothing. Pass --repo-root <absolute path to the hive repo> explicitly.\n' +
        `  Tried: ${hiveRootCandidates(harness).join(', ')}`,
    );
    process.exit(1);
  }

  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'project-history-refresh';
  const id = `rt_${harness}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    repo_root: repoRoot,
    output,
    project_id: projectId,
    project_name: projectName,
    export_name: exportName,
    plan_prefix: planPrefix,
    format: output.endsWith('.ts') ? 'typescript' : 'json',
    harness,
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at)
    VALUES (${id}, ${harness}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:project-history-refresh', 'skip', 'skip-old', ${active}, 'durable', now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      tier = EXCLUDED.tier,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-project-history-refresh-routine] seeded "${name}" for "${harness}" (ws=${ws}, active=${active}) — ` +
      `cron "${CRON}" (every 2h at :50), regenerating ${path.join(repoRoot, output)}. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-project-history-refresh-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
