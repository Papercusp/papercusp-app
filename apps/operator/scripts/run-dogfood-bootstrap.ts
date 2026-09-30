/**
 * One-shot driver for the P-014 + P-024 boot helpers. Validates them
 * against the live PG without restarting the user's running operator.
 *
 * What this does (same code paths instrumentation-node.ts runs on
 * every boot):
 *   1. ensurePapercuspWorkspace() — registry.json entry.
 *   2. registerPapercupHarness() — PG row in harness_shared.harness_registry
 *      scoped to the sentinel workspace (the papercup REPO as a private coding
 *      harness — the standalone-flow leg).
 *   3. ensurePapercuspHive() — ship Papercusp as a shared HIVE by default
 *      (domain-generic-hive P-029, D-010): a generic `coding` (kind:'hive') hive
 *      `papercusp`, idempotent + private/no-announce. The shared-hive-flow leg.
 *
 * Run with:
 *   cd apps/operator && npx tsx scripts/run-dogfood-bootstrap.mts
 */

import { ensurePapercuspWorkspace, PAPERCUSP_WORKSPACE_ID } from '@papercusp/operator-core/lib/harness/papercusp-workspace';
import { registerPapercupHarness } from '@papercusp/operator-core/lib/harness/register-papercusp';
import { ensurePapercuspHive, PAPERCUSP_HIVE_SLUG } from '@papercusp/operator-core/lib/harness/ensure-papercusp-hive';
import { loadHarnessRegistry } from '@papercusp/operator-core/lib/harness-registry';
import { readRegistry } from '@papercusp/operator-core/lib/workspace-registry';
import { operatorHomeHarnessSlug } from '@papercusp/operator-core/lib/harness/operator-home-harness';
import { checkHomeHarnessResolves } from '@papercusp/operator-core/lib/harness-core';

async function main(): Promise<void> {
  console.log('=== STEP 1: ensurePapercuspWorkspace ===');
  const wsEntry = ensurePapercuspWorkspace();
  console.log(`workspace entry: id=${wsEntry.id}, name=${wsEntry.name}, createdAt=${wsEntry.createdAt}`);

  const reg = readRegistry();
  console.log(`workspaces total: ${reg.workspaces.length}, current: ${reg.current}`);
  const sentinelInList = reg.workspaces.find((w) => w.id === PAPERCUSP_WORKSPACE_ID);
  if (!sentinelInList) {
    console.error('FAIL: sentinel not in registry after ensure');
    process.exit(1);
  }
  console.log(`✓ sentinel '${PAPERCUSP_WORKSPACE_ID}' present in registry`);

  console.log('\n=== STEP 2: registerPapercupHarness ===');
  const result = await registerPapercupHarness();
  console.log(`state: ${result.state}`);
  console.log(`path: ${result.path ?? '(null)'}`);
  if (result.reason) console.log(`reason: ${result.reason}`);

  console.log('\n=== STEP 3: ensurePapercuspHive (ship Papercusp as a shared hive by default) ===');
  const hiveRes = await ensurePapercuspHive();
  console.log(`state: ${hiveRes.state}`);
  console.log(`slug: ${hiveRes.slug ?? '(null)'}`);
  if (hiveRes.reason) console.log(`reason: ${hiveRes.reason}`);

  console.log('\n=== STEP 4: verify PG rows ===');
  const hReg = await loadHarnessRegistry(PAPERCUSP_WORKSPACE_ID);
  console.log(`harness_registry@${PAPERCUSP_WORKSPACE_ID}: ${hReg.projects.length} projects`);
  for (const p of hReg.projects) {
    console.log(`  - ${p.slug}  →  ${p.path}`);
  }
  // EI-2224 recurrence guard: assert the configured operator-home harness slug
  // resolves to a registered project (alias-aware) — fail LOUD at boot instead of
  // 404ing SILENTLY at dispatch time. A rename that leaves PAPERCUSP_POT_HOME_SLUG
  // (or a fire-path env) on the retired slug used to dark the dispatcher ~34h.
  const homeSlug = operatorHomeHarnessSlug();
  const homeCheck = await checkHomeHarnessResolves(homeSlug);
  if (!homeCheck.ok) {
    console.error(`FAIL: ${homeCheck.message}`);
    process.exit(1);
  }
  console.log(
    homeCheck.aliased
      ? `⚠ ${homeCheck.message}` // resolves, but only via the deprecated alias — clean up the pointer
      : `✓ ${homeSlug} resolves to a registered project`,
  );

  // Guard the EXACT env that caused EI-2224: a stale PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS
  // pointing at an unregistered slug starves the auto-implement lane. Only checked when set
  // (unset ⇒ the routine defaults to its own install slug — WI-290).
  const runnerEnv = process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS?.trim();
  if (runnerEnv) {
    const runnerCheck = await checkHomeHarnessResolves(runnerEnv);
    if (!runnerCheck.ok) {
      console.error(`FAIL: PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS=${runnerEnv} — ${runnerCheck.message}`);
      process.exit(1);
    }
    console.log(
      runnerCheck.aliased
        ? `⚠ PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS=${runnerEnv} resolves only via the retired-slug alias → "${runnerCheck.resolvedSlug}"; update it to drop the alias`
        : `✓ PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS=${runnerEnv} resolves to a registered project`,
    );
  }
  // The shared hive is best-effort (skipped in a packaged install / on a transient
  // PG hiccup) — present it, but do NOT fail the bootstrap on a non-'skipped' miss.
  const papercuspHive = hReg.projects.find((p) => p.slug === PAPERCUSP_HIVE_SLUG);
  console.log(
    papercuspHive
      ? `✓ ${PAPERCUSP_HIVE_SLUG} shared hive present (${hiveRes.state})`
      : `· ${PAPERCUSP_HIVE_SLUG} shared hive not present (${hiveRes.state}${hiveRes.reason ? `: ${hiveRes.reason}` : ''})`,
  );

  console.log('\n=== PASS — dogfooding flipped on ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e?.stack ?? e);
  process.exit(1);
});
