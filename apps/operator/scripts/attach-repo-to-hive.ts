/**
 * attach-repo-to-hive — attach an EXISTING local repo harness as a member of a
 * hive, wiring up its git-sync (the "git-sync-any-hive" capability).
 *
 * papercup→papercusp generalization (2026-06-19): the gap the dogfooding exposed
 * was that a plain `pot:create` makes a repo-LESS hive (no member repo, no
 * git-sync). The platform already supports repo-backed hives via member repos +
 * `seedGitSyncRoutineForMember`, but there was no clean entry point to attach an
 * EXISTING local repo to a hive. This script is that entry point (the basis for a
 * proper `pot:add-member` tool — the creation-path hardening).
 *
 * Drives the canonical `addHarnessToPot` helper (sets member.hive_slug, seeds the
 * member's system:git-sync best-effort, idempotent — never clobbers an existing
 * routine). Fully reversible (remove the member's hive_slug).
 *
 * Usage:
 *   npx tsx scripts/attach-repo-to-hive.ts <workspaceId> <potHomeSlug> <memberHarnessSlug>
 */
import { addHarnessToPot } from '@papercusp/operator-core/lib/agent-tools/pot/_add-member';

async function main(): Promise<void> {
  const [workspaceId, potHomeSlug, memberHarnessSlug] = process.argv.slice(2);
  if (!workspaceId || !potHomeSlug || !memberHarnessSlug) {
    console.error('usage: attach-repo-to-hive.ts <workspaceId> <potHomeSlug> <memberHarnessSlug>');
    process.exit(2);
  }
  console.log(`attaching repo harness '${memberHarnessSlug}' → hive '${potHomeSlug}' (ws=${workspaceId})…`);
  const res = await addHarnessToPot({ workspaceId, potHomeSlug, memberHarnessSlug });
  console.log(JSON.stringify(res, null, 1));
  // NOT process.exit(): it does not drain an async pipe write, so piping this result
  // would silently truncate it. See scripts/check-undrained-stdout-exit.mjs.
  process.exitCode = res.ok ? 0 : 1;
}

main().catch((e) => {
  console.error('FATAL:', e?.stack ?? e);
  process.exit(1);
});
