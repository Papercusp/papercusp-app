/**
 * `system:pot-git-gc` — the ephemeral cadence that bounds a pot-git bare
 * store's namespace-ref growth (G-9, p2p-git-live-activation-2026-07-09 /
 * P-205). Config (routine `trigger_config`, from hive-git-gc-routine.ts):
 *   - `pot_home_slug` / `repo_key` — storage.ts's `hiveGitRepoPath` inputs.
 *     `hive_home_slug` is still READ as a fallback: the key lives in row DATA,
 *     and P-051 migrated only the rows visible in this workspace, so a row in
 *     another workspace may still carry the pre-rename spelling.
 *   - `keep_published_refs_per_namespace` — optional (default gc.ts's own).
 *
 * SELF-GATES on the hive's `hiveGit.mode` (hive-git-mode.ts): a `legacy` hive
 * has no multi-namespace hive-git store worth gc'ing (git-sync-action.ts
 * never engages the p2p plane for it) — the tick no-ops rather than running
 * `git gc --prune=now` against a store nothing publishes into. This mirrors
 * the established "self-gates on hive-specific state" idiom used by
 * `system:scout-cycle` / `system:wake-brain` etc., so the ROW can be armed
 * platform-wide without a bespoke reconcile sweep: activation is still owned
 * by upsertHiveGitGcRoutine's caller (the mode-flip path), the self-gate is a
 * defense-in-depth no-op, not the primary gate.
 *
 * Runs as ONE durable-ish step (best-effort by construction — gcHiveGitRepo
 * itself never throws on a bad ref/gc failure, folding errors into its result
 * instead) — safe to re-run from the top.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { gcHiveGitRepo } from '../../sync/pot-git/gc';
import { hiveGitRepoPath } from '../../sync/pot-git/storage';
import { getPotGitMode } from '../git-sync/hive-git-mode';
import type { RepoIdentityEntry } from '../../sync/pot-git/repo-identity';
import {
  liveGcRepoKey,
  loadPotRepoEntries,
  reclaimSupersededStores,
} from '../../sync/pot-git/superseded-store-reclaim';

const potGitGcTick = async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const potHomeSlug =
    typeof cfg.pot_home_slug === 'string'
      ? cfg.pot_home_slug
      : typeof cfg.hive_home_slug === 'string'
        ? cfg.hive_home_slug
        : ctx.installSlug;
  const repoKey = typeof cfg.repo_key === 'string' ? cfg.repo_key : null;
  if (!repoKey) {
    console.warn(`[pot-git-gc] ${potHomeSlug}: missing trigger_config.repo_key — skipping tick`);
    return;
  }

  const mode = await getPotGitMode(ctx.workspaceId, potHomeSlug);
  if (mode === 'legacy') {
    // Self-gate: nothing publishes into the hive-git namespace tree for a legacy hive.
    return;
  }

  // WI-10003689: the pot's registry entries. They tell us whether the configured key
  // was abandoned by a later re-key, and which stores are superseded aliases. Fails
  // open: an unreadable registry means gc the configured store and reclaim nothing.
  let entries: RepoIdentityEntry[] | null = null;
  try {
    entries = await loadPotRepoEntries(ctx.workspaceId, potHomeSlug);
  } catch (e) {
    console.warn(`[pot-git-gc] ${potHomeSlug}: registry unreadable (${(e as Error)?.message ?? e}); superseded-store reclaim skipped`);
  }
  const gcKey = entries ? liveGcRepoKey(repoKey, entries) : repoKey;
  if (gcKey !== repoKey) {
    console.warn(
      `[pot-git-gc] ${potHomeSlug}: trigger_config.repo_key=${repoKey} was superseded by a re-key; gc'ing the live store ${gcKey}`,
    );
  }

  const keepPublishedRefsPerNamespace = Number(cfg.keep_published_refs_per_namespace);
  const repoPath = hiveGitRepoPath(potHomeSlug, gcKey);
  const result = await gcHiveGitRepo(repoPath, {
    ...(Number.isFinite(keepPublishedRefsPerNamespace) && keepPublishedRefsPerNamespace > 0
      ? { keepPublishedRefsPerNamespace }
      : {}),
  });
  if (entries) {
    for (const o of await reclaimSupersededStores(potHomeSlug, entries)) {
      const size = o.bytes == null ? 'unknown size' : `${(o.bytes / 1024 / 1024).toFixed(0)} MiB`;
      const line = `[pot-git-gc] ${potHomeSlug}: superseded store ${o.repoKey}.git (${size}, live key ${o.canonicalKey}) ${o.action}: ${o.reason}`;
      if (o.action === 'reclaimed') console.log(line);
      else console.warn(line);
    }
  }
  console.log(
    `[pot-git-gc] ${potHomeSlug}/${gcKey} (mode=${mode}): ` +
      `deleted ${result.deletedRefs.length} ref(s), archived ${result.archivedNamespaces.length} namespace(s), ` +
      `kept ${result.keptRefs.length}` +
      (result.errors.length ? `, ${result.errors.length} error(s)` : ''),
  );
  if (result.errors.length) {
    for (const e of result.errors) console.warn(`[pot-git-gc]   ! ${e}`);
  }
};

/**
 * CANONICAL NAME (retire-mug-kettle-su-only-2026-08-09 P-051 / D-045). This is
 * POT SUBSTRATE — it gc's the p2p git store behind a Pot's git plane and
 * consults no retirement flag — so the settlement was RENAME, not retire.
 */
// `scheduling: 'on-demand'` (EI-18752496371939475): one row per POT, armed as pots are
// created — not a standing workspace-wide row to seed.
registerSystemAction('pot-git-gc', potGitGcTick, { scheduling: 'on-demand' });

/*
 * NO `hive-git-gc` ALIAS. It existed transiently during P-051 to cover the
 * bg-host restart window, and was deleted in the same change once the ROUTINE-ROW
 * census came back clean: platform-wide (ALL workspaces, not just this one) zero
 * `harness_shared.routines` rows target `system:hive-git-gc`. The name is only
 * ever reached through a row's `target_role` — there are no code callers — so
 * with no such row there is nothing left to alias. Pinned by a test.
 *
 * ⚠ "census" HERE MEANS THE DB-ROW CENSUS ONLY — a `SELECT ... FROM
 * harness_shared.routines`. It is NOT the mug/kettle SOURCE census
 * (`scripts/mug-kettle-surface-census.mjs` + the `lint:no-ungated-mug-kettle`
 * ratchet), which scans source text and never reads a routine row. The two
 * answer different questions, and conflating them has already misled one reader
 * into thinking this note asserted a green ratchet. It did not, and the ratchet
 * was in fact STALE across this rename: its baseline stayed keyed on the old
 * name, which masked the new one (see D-044 — a name-keyed registry fails
 * SILENTLY under a rename, and a ratchet cannot catch it because the count goes
 * DOWN, never up). Re-keyed in `scripts/ungated-mug-kettle-baseline.json`.
 */
