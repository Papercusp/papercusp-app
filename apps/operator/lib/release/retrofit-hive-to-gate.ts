/**
 * retrofit-hive-to-gate — bring an EXISTING code-bearing harness (a self_repo home OR a
 * create_from_repo member, e.g. `oddsmith`) onto the staging→main green gate, so it works
 * like a coding hive created fresh under per-hive-git-and-release-gate-2026-06-29 (P-015).
 *
 *   DRY-RUN (default):  tsx retrofit-hive-to-gate.ts --slug oddsmith
 *   APPLY (owner-only):  tsx retrofit-hive-to-gate.ts --slug oddsmith --apply
 *
 * DRY-RUN is READ-ONLY: it inspects the harness + prints the exact steps + the GitHub
 * side-effects, and mutates NOTHING. --apply performs them. The apply touches a real remote
 * (it pushes a `staging` branch), so it is owner-gated by policy — do not run --apply without
 * explicit owner approval. Everything it does is reversible (delete origin/staging + the
 * green-checkpoint routine + repoint git-sync back to the old default branch).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { greenCheckpointCronForInstall } from '@papercusp/operator-core/lib/release/green-checkpoint-schedule';

interface RetrofitPlan {
  slug: string;
  path: string;
  hasGit: boolean;
  origin: string | null;
  currentBranch: string | null;
  currentDefaultBranch: string | undefined;
  targetIntegrationBranch: string;
  targetReleaseRef: string;
  hasStagingLocal: boolean;
  hasStagingRemote: boolean;
  greenCmd: string;
  gateEnabled: boolean;
  gitSyncSeeded: boolean;
  greenCheckpointSeeded: boolean;
  flagOn: boolean;
}

function git(cwd: string, ...args: string[]): string {
  try {
    // stderr ignored: a `rev-parse --verify <missing-branch>` prints "fatal: Needed a single
    // revision" — expected during inspection, not an error worth surfacing.
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

async function buildPlan(slug: string): Promise<RetrofitPlan> {
  const { loadHarnessRegistry } = await import('@papercusp/operator-core/lib/harness-registry');
  const { resolveHiveReleaseGate } = await import(
    '@papercusp/operator-core/lib/harness/routines/hive-release-env'
  );
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const { getOrgPg } = await import('@papercusp/db-org');

  const reg = await loadHarnessRegistry();
  const entry = reg.projects.find((p) => p.slug === slug);
  if (!entry) throw new Error(`no registry entry for slug '${slug}'`);
  const path = entry.path;
  const hasGit = existsSync(join(path, '.git'));
  const gate = resolveHiveReleaseGate(path, (entry as { github_default_branch?: string }).github_default_branch);
  const { sql } = getOrgPg();
  const routines = (await sql`
    SELECT name FROM harness_shared.routines WHERE install_slug = ${slug}
  `) as Array<{ name: string }>;
  const names = new Set(routines.map((r) => r.name));
  const integrationBranch = gate?.integrationBranch ?? 'staging';

  return {
    slug,
    path,
    hasGit,
    origin: hasGit ? git(path, 'remote', 'get-url', 'origin') || null : null,
    currentBranch: hasGit ? git(path, 'branch', '--show-current') || null : null,
    currentDefaultBranch: (entry as { github_default_branch?: string }).github_default_branch,
    targetIntegrationBranch: integrationBranch,
    targetReleaseRef: gate?.releaseRef ?? 'main',
    hasStagingLocal: hasGit ? git(path, 'rev-parse', '--verify', integrationBranch) !== '' : false,
    hasStagingRemote: hasGit ? git(path, 'rev-parse', '--verify', `origin/${integrationBranch}`) !== '' : false,
    greenCmd: gate?.greenCmd ?? gate?.testCommand ?? 'npm run build',
    gateEnabled: gate?.enabled ?? false,
    gitSyncSeeded: names.has('git-sync'),
    greenCheckpointSeeded: names.has('green-checkpoint'),
    flagOn: await getFlag(FLAGS.PER_POT_RELEASE_GATE, 'system'),
  };
}

function printPlan(p: RetrofitPlan): void {
  const log = (s: string) => console.log(s);
  log(`\n=== Retrofit DRY-RUN: ${p.slug} ===`);
  log(`  path:             ${p.path}`);
  log(`  origin:           ${p.origin ?? '(none)'}`);
  log(`  current branch:   ${p.currentBranch ?? '(no .git)'}`);
  log(`  default branch:   ${p.currentDefaultBranch ?? '(unset → uses checkout branch)'}`);
  log(`  gate enabled:     ${p.gateEnabled}  greenCmd: ${p.greenCmd}`);
  log(`  staging exists:   local=${p.hasStagingLocal} remote=${p.hasStagingRemote}`);
  log(`  git-sync seeded:  ${p.gitSyncSeeded}   green-checkpoint seeded: ${p.greenCheckpointSeeded}`);
  log(`  PER_POT_RELEASE_GATE flag: ${p.flagOn ? 'ON' : 'OFF'}`);
  log(`\n  Steps --apply WOULD take:`);
  if (!p.hasGit) {
    log(`   ✗ NOT a git repo — cannot gate. (Is this the metadata home rather than the code harness?)`);
    return;
  }
  if (!p.gateEnabled) log(`   ! gate resolves DISABLED — check the blueprint (non-coding?).`);
  if (!p.hasStagingRemote) {
    log(`   1. git checkout -b ${p.targetIntegrationBranch} (from ${p.currentBranch}) + git push -u origin ${p.targetIntegrationBranch}`);
    log(`      → CREATES branch '${p.targetIntegrationBranch}' on ${p.origin}  ← the only GitHub mutation`);
  } else {
    log(`   1. (skip) origin/${p.targetIntegrationBranch} already exists`);
  }
  log(`   2. registry: set github_default_branch '${p.currentDefaultBranch ?? '(unset)'}' → '${p.targetIntegrationBranch}'; repoint git-sync to push '${p.targetIntegrationBranch}'`);
  log(`   3. seed green-checkpoint for install_slug='${p.slug}' (greenCmd: ${p.greenCmd}) — '${p.targetReleaseRef}' becomes green-only`);
  if (!p.flagOn) log(`      ⚠ requires PER_POT_RELEASE_GATE flag ON (currently OFF) — seeding self-gates on it.`);
  log(`\n  Net: work flows to '${p.targetIntegrationBranch}'; '${p.targetReleaseRef}' fast-forwards only when '${p.greenCmd}' passes.`);
  log(`  Reversible: delete origin/${p.targetIntegrationBranch} + the green-checkpoint routine + repoint git-sync to '${p.currentDefaultBranch ?? 'main'}'.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const slug = argv[argv.indexOf('--slug') + 1];
  const apply = argv.includes('--apply');
  if (!slug || slug.startsWith('--')) {
    console.error('usage: tsx retrofit-hive-to-gate.ts --slug <harness-slug> [--apply]');
    process.exit(2);
  }
  const plan = await buildPlan(slug);
  printPlan(plan);
  if (apply) {
    if (!plan.hasGit) throw new Error(`${slug} is not a git repo — nothing to gate`);
    if (!plan.gateEnabled) throw new Error(`${slug} gate resolves DISABLED — refusing to apply`);
    await applyRetrofit(plan);
  }
}

/**
 * Perform the retrofit (owner-approved). Pauses git-sync FIRST so the branch switch can't
 * race a tick; on any failure it reactivates git-sync on its ORIGINAL branch (never leaves
 * it paused) and re-throws. The green-checkpoint is seeded EXPLICITLY (flag-independent) —
 * this is a deliberate canary, distinct from the flag-gated auto-seeding at create.
 */
async function applyRetrofit(plan: RetrofitPlan): Promise<void> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { activeWorkspaceId } = await import('@papercusp/operator-core/lib/workspace-registry');
  const { loadHarnessRegistry, saveHarnessRegistry } = await import(
    '@papercusp/operator-core/lib/harness-registry'
  );
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const ib = plan.targetIntegrationBranch;
  const originalBranch = plan.currentDefaultBranch ?? 'main';

  // 1. Pause git-sync so it can't commit/push the OLD branch mid-switch.
  await sql`UPDATE harness_shared.routines SET active=false, updated_at=now()
            WHERE install_slug=${plan.slug} AND name='git-sync'`;
  console.log('[apply] paused git-sync');

  try {
    // 2. Create + push the integration branch (the GitHub mutation).
    if (!plan.hasStagingLocal) {
      execFileSync('git', ['-C', plan.path, 'checkout', '-b', ib], { stdio: 'inherit' });
    } else {
      execFileSync('git', ['-C', plan.path, 'checkout', ib], { stdio: 'inherit' });
    }
    if (!plan.hasStagingRemote) {
      execFileSync('git', ['-C', plan.path, 'push', '-u', 'origin', ib], { stdio: 'inherit' });
    }
    console.log(`[apply] '${ib}' created + pushed to ${plan.origin}`);

    // 3. Registry: repoint the default branch to the integration branch.
    const reg = await loadHarnessRegistry(ws);
    const entry = reg.projects.find((p) => p.slug === plan.slug);
    if (entry) {
      (entry as { github_default_branch?: string }).github_default_branch = ib;
      await saveHarnessRegistry(reg, ws);
    }
    console.log(`[apply] registry github_default_branch '${originalBranch}' → '${ib}'`);

    // 4. Repoint + REACTIVATE git-sync to push the integration branch.
    await sql`UPDATE harness_shared.routines
              SET active=true,
                  trigger_config = jsonb_set(coalesce(trigger_config, '{}'::jsonb), '{branch}', ${JSON.stringify(ib)}::jsonb),
                  updated_at=now()
              WHERE install_slug=${plan.slug} AND name='git-sync'`;
    console.log(`[apply] git-sync reactivated → pushes '${ib}'`);

    // 5. Seed the green-checkpoint (EXPLICIT canary — flag-independent). '<releaseRef>'
    //    becomes green-only: it fast-forwards from green '<integrationBranch>' only.
    const id = `rt_${plan.slug}_green_checkpoint`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    await sql`INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         concurrency, catchup, active, next_fire_at)
      VALUES (${id}, ${plan.slug}, ${ws}, 'green-checkpoint', 'cron',
              ${JSON.stringify({ cron: greenCheckpointCronForInstall(plan.slug) })}::text::jsonb, 'system:green-checkpoint',
              'skip', 'skip-old', true, now())
      ON CONFLICT (install_slug, name) DO UPDATE SET
        active=true, trigger_config=EXCLUDED.trigger_config, target_role=EXCLUDED.target_role,
        workspace_id=EXCLUDED.workspace_id, updated_at=now()`;
    console.log(`[apply] green-checkpoint seeded (canary) — '${plan.targetReleaseRef}' is now green-only (greenCmd: ${plan.greenCmd})`);
    console.log(`\n[apply] DONE — ${plan.slug} now works '${ib}' → green '${plan.targetReleaseRef}'.`);
  } catch (e) {
    // NEVER leave git-sync paused: reactivate it on the original branch and surface the error.
    await sql`UPDATE harness_shared.routines
              SET active=true,
                  trigger_config = jsonb_set(coalesce(trigger_config, '{}'::jsonb), '{branch}', ${JSON.stringify(originalBranch)}::jsonb),
                  updated_at=now()
              WHERE install_slug=${plan.slug} AND name='git-sync'`.catch(() => {});
    console.error('[apply] FAILED — git-sync reactivated on the original branch; no further changes.');
    throw e;
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[retrofit] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
