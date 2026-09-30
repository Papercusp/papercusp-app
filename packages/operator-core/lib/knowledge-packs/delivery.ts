/**
 * delivery — the fleet-lessons LAST MILE (knowledge-pack-loop-integrity-2026-07-19
 * P-006, fixing EI-18106997081327607).
 *
 * Before this module, an adopted fleet lesson was INERT: adoption bumped the
 * pack version, but `updateAvailable` only lights for pools ALREADY carrying
 * the pack, no hive had ever installed it, and nothing scheduled ran the
 * upgrade — so zero pool rows existed fleet-wide. This tick closes the loop:
 *
 *   for each LOCAL hive (bounded per tick), unless the hive muted the pack
 *   (`knowledge-packs:disabled` — the per-hive opt-out):
 *     planPackUpgrade(fleet-lessons)  → the NEW-items set (for a pool with
 *       zero pack rows that is the WHOLE pack, so install and upgrade are ONE
 *       code path)
 *     applyPackInstall(defaults)      → clean items install; duplicates and
 *       conflicts SKIP (D-003 preserved — existing pool content outranks the
 *       incoming pack; nothing is ever overwritten)
 *
 * Gated by FLAGS.KNOWLEDGE_PACKS at the action layer (the same master flag
 * that gates seeding + every knowledge_packs verb — the automation is part of
 * the same feature surface, not a new one). Deps injectable; unit tests run
 * with fakes, zero PG/LLM/fs.
 */
import { FLEET_LESSONS_PACK_ID } from './candidates-shared';
import { filterByDomains, type KnowledgePack } from './pack-format';
import type { ApplyInstallResult, InstallReview, UpgradePlanResult } from './manage';

export interface DeliveryHive {
  slug: string;
  remote?: boolean;
}

export interface DeliveryTickDeps {
  /** Resolve the fleet-lessons pack (null ⇒ nothing to deliver). */
  loadPack: () => Promise<KnowledgePack | null>;
  /** The workspace's LOCAL hives (remote hives are skipped — not ours to write). */
  listHives: () => Promise<DeliveryHive[]>;
  /** The hive's muted-pack ids (`knowledge-packs:disabled`). */
  disabledPacks: (potSlug: string) => Promise<string[]>;
  /** The hive's declared topical domains (`knowledge-packs:domains`); undefined ⇒ untagged items only. */
  declaredDomains: (potSlug: string) => Promise<string[] | undefined>;
  plan: (potSlug: string, pack: KnowledgePack) => Promise<UpgradePlanResult>;
  apply: (potSlug: string, pack: KnowledgePack, review: InstallReview) => Promise<ApplyInstallResult>;
}

export interface DeliveryTickResult {
  packVersion: string | null;
  hivesSeen: number;
  hivesSkipped: number;
  hivesDelivered: number;
  installed: number;
  skipped: number;
  failed: number;
  /** True when the hive cap cut the sweep short (the next tick continues). */
  capped: boolean;
}

async function realDeps(workspaceId: string): Promise<DeliveryTickDeps> {
  const [{ loadKnowledgePack }, manage, { loadHarnessRegistry }] = await Promise.all([
    import('./load-packs'),
    import('./manage'),
    import('../harness-registry'),
  ]);
  return {
    loadPack: async () => (await loadKnowledgePack(FLEET_LESSONS_PACK_ID))?.pack ?? null,
    listHives: async () => {
      const reg = await loadHarnessRegistry(workspaceId);
      return reg.projects
        .filter((p) => p.harness_kind === 'hive')
        .map((p) => ({ slug: p.slug, remote: (p as { remote_hive?: boolean }).remote_hive === true }));
    },
    disabledPacks: (potSlug) => manage.disabledPacksFor(workspaceId, potSlug),
    declaredDomains: (potSlug) => manage.declaredDomainsFor(workspaceId, potSlug),
    plan: (potSlug, pack) => manage.planPackUpgrade({ potSlug, pack }),
    apply: (potSlug, pack, review) =>
      manage.applyPackInstall({
        workspaceId,
        potSlug,
        pack,
        review,
        createdBy: 'knowledge-pack-delivery',
      }),
  };
}

/**
 * One bounded delivery pass. Best-effort per hive — one failing hive never
 * stops the sweep, and every skip/failure is counted so the action log tells
 * the truth.
 */
export async function runFleetLessonsDeliveryTick(
  opts: { workspaceId: string; maxHivesPerTick?: number },
  deps?: DeliveryTickDeps,
): Promise<DeliveryTickResult> {
  const d = deps ?? (await realDeps(opts.workspaceId));
  const maxHives = Math.max(1, opts.maxHivesPerTick ?? 10);
  const result: DeliveryTickResult = {
    packVersion: null,
    hivesSeen: 0,
    hivesSkipped: 0,
    hivesDelivered: 0,
    installed: 0,
    skipped: 0,
    failed: 0,
    capped: false,
  };

  const pack = await d.loadPack();
  if (!pack || pack.items.length === 0) return result;
  result.packVersion = pack.manifest.version;

  const hives = await d.listHives();
  const local = hives.filter((h) => h.remote !== true);
  const batch = local.slice(0, maxHives);
  result.capped = local.length > batch.length;

  for (const hive of batch) {
    result.hivesSeen += 1;
    try {
      const disabled = await d.disabledPacks(hive.slug).catch(() => [] as string[]);
      if (disabled.includes(FLEET_LESSONS_PACK_ID)) {
        result.hivesSkipped += 1; // the per-hive opt-out — muted packs are never written
        continue;
      }
      // Domain targeting (EI-18121672688225947): tagged items reach only hives
      // declaring a matching domain; untagged items are unaffected. Filter the
      // pack ONCE and hand the same filtered view to plan AND apply, so the
      // upgrade planner never proposes an item apply would then be given.
      const declared = await d.declaredDomains(hive.slug).catch(() => undefined);
      const eligibleItems = filterByDomains(pack.items, declared);
      if (eligibleItems.length === 0) {
        result.hivesSkipped += 1; // every item is domain-tagged elsewhere
        continue;
      }
      const packForHive = { manifest: pack.manifest, items: eligibleItems };
      const plan = await d.plan(hive.slug, packForHive);
      if (plan.newItems.items.length === 0) {
        result.hivesSkipped += 1; // fully current (or everything present)
        continue;
      }
      const applied = await d.apply(hive.slug, packForHive, plan.newItems);
      result.hivesDelivered += 1;
      result.installed += applied.installed;
      result.skipped += applied.skipped;
      result.failed += applied.failed;
    } catch (e) {
      result.failed += 1;
      console.warn(
        `[knowledge-pack-delivery] hive ${hive.slug} delivery failed (best-effort): ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return result;
}
