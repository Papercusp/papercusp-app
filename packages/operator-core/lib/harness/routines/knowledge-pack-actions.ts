/**
 * Knowledge-pack maintenance system actions
 * (knowledge-pack-loop-integrity-2026-07-19 P-006 delivery + P-008 hygiene).
 *
 *   - `system:knowledge-pack-delivery` — the fleet-lessons LAST MILE
 *     (lib/knowledge-packs/delivery.ts): bounded per tick, per-hive opt-out via
 *     the muted-packs setting, D-003 preserved (clashes skip, nothing is ever
 *     overwritten). Fixes EI-18106997081327607 (zero pools carried the pack).
 *   - `system:knowledge-pack-hygiene` — the automatic cleanup routine
 *     (lib/knowledge-packs/hygiene.ts, owner-asked 2026-07-19): stale-item
 *     re-review, emergent-contradiction sweep (auto-resolve ONLY pristine-pack
 *     vs organic; everything else FILED), dismissed-candidate prune.
 *
 * Both gated by FLAGS.KNOWLEDGE_PACKS — the same master flag that gates
 * seeding and every knowledge_packs verb (the automation is part of that
 * feature surface, not a new one; reuse-first). Numeric caps are env-tunable
 * (launch-time config, not feature gates). Routine rows are seeded by
 * seed-improvement-routines.ts alongside the improvement set.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { resolveKnowledgePackKnobs } from '../../knowledge-packs/config';
import { runFleetLessonsDeliveryTick } from '../../knowledge-packs/delivery';
import {
  runKnowledgeHygieneTick,
  type HygieneConflictPair,
  type HygieneDeps,
  type HygienePackItem,
} from '../../knowledge-packs/hygiene';
import { FLEET_LESSONS_PACK_ID } from '../../knowledge-packs/candidates-shared';

registerSystemAction('knowledge-pack-delivery', async (ctx: SystemActionCtx): Promise<void> => {
  if (!(await getFlag(FLAGS.KNOWLEDGE_PACKS, 'system').catch(() => true))) {
    console.log('[knowledge-pack-delivery] knowledge-packs flag off — delivery skipped');
    return;
  }
  // knowledge-pack-settings P-002: stored → env → default (env name unchanged).
  const maxHivesPerTick = (await resolveKnowledgePackKnobs()).deliveryMaxHivesPerTick;
  const r = await runFleetLessonsDeliveryTick({ workspaceId: ctx.workspaceId, maxHivesPerTick });
  const summary =
    r.packVersion === null
      ? 'fleet-lessons pack absent/empty — nothing to deliver'
      : `fleet-lessons v${r.packVersion}: ${r.hivesSeen} hive(s) seen, ${r.hivesDelivered} delivered ` +
        `(${r.installed} installed, ${r.skipped} skipped, ${r.failed} failed), ${r.hivesSkipped} current/muted` +
        (r.capped ? ' [capped — next tick continues]' : '');
  console.log(`[knowledge-pack-delivery] ${summary}`);
});

/* ── hygiene live deps (the PG/fs/LLM glue behind lib/knowledge-packs/hygiene.ts) ── */

async function liveHygieneDeps(workspaceId: string): Promise<HygieneDeps> {
  const [
    { loadKnowledgePack, sharedKnowledgePacksRoot },
    { memoryTextOf, parseManifest },
    manage,
    { anthropicDistillerLlm },
    { getMemoryBackend },
    { hiveScopeKey },
    { loadHarnessRegistry },
    { getOrgPg },
  ] = await Promise.all([
    import('../../knowledge-packs/load-packs'),
    import('../../knowledge-packs/pack-format'),
    import('../../knowledge-packs/manage'),
    import('../../transfer/live-deps'),
    import('../../memory/backend'),
    import('../../memory/hive-scope'),
    import('../../harness-registry'),
    import('@papercusp/db-org'),
  ]);
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');

  const backend = getMemoryBackend();
  const packDir = join(sharedKnowledgePacksRoot(), FLEET_LESSONS_PACK_ID);
  const loadPack = () => loadKnowledgePack(FLEET_LESSONS_PACK_ID).then((l) => l?.pack ?? null);
  const localHives = async () => {
    const reg = await loadHarnessRegistry(workspaceId);
    return reg.projects
      .filter((p) => p.harness_kind === 'hive' && (p as { remote_hive?: boolean }).remote_hive !== true)
      .map((p) => p.slug);
  };
  /** row → pristine-pack verdict: provenance says pack AND text matches the
   *  resolvable pack item's canonical render. Unresolvable ⇒ NOT pristine
   *  (never delete what we cannot re-derive). */
  const pristineOf = async (meta: Record<string, unknown> | undefined, text: string): Promise<boolean> => {
    if (meta?.source !== 'pack' || typeof meta?.pack_id !== 'string') return false;
    const loaded = await loadKnowledgePack(meta.pack_id as string).catch(() => null);
    const item = loaded?.pack.items.find((i) => i.id === meta.pack_item_id);
    return item ? memoryTextOf(item) === text : false;
  };

  return {
    listPackItems: async (): Promise<HygienePackItem[]> => {
      const pack = await loadPack();
      if (!pack) return [];
      const { sql } = getOrgPg();
      const rows = (await sql`
        SELECT pack_item_id, decided_at FROM harness_shared.knowledge_pack_candidates
         WHERE status = 'adopted' AND pack_id = ${FLEET_LESSONS_PACK_ID}`) as Array<
        Record<string, unknown>
      >;
      const adoptedAt = new Map(
        rows
          .filter((r) => typeof r.pack_item_id === 'string' && r.decided_at)
          .map((r) => [r.pack_item_id as string, new Date(r.decided_at as string | Date).toISOString()]),
      );
      return pack.items.map((i) => ({
        itemId: i.id,
        title: i.title,
        text: i.text,
        adoptedAt: adoptedAt.get(i.id) ?? null,
      }));
    },
    distiller: anthropicDistillerLlm(),
    retirePackItem: async (itemId, reason) => {
      await fs.rm(join(packDir, `${itemId}.md`), { force: true });
      const raw = await fs.readFile(join(packDir, 'manifest.yaml'), 'utf8').catch(() => null);
      const parsed = raw ? parseManifest(raw) : { manifest: undefined };
      if (parsed.manifest) {
        const { bumpPatchVersion } = await import('../../knowledge-packs/candidates');
        const version = bumpPatchVersion(parsed.manifest.version);
        await fs.writeFile(
          join(packDir, 'manifest.yaml'),
          raw!.replace(/^version:.*$/m, `version: "${version}"`),
          'utf8',
        );
      }
      const { sql } = getOrgPg();
      await sql`
        UPDATE harness_shared.knowledge_pack_candidates
           SET decision_note = coalesce(decision_note, '') || ${` | retired ${new Date().toISOString().slice(0, 10)}: ${reason}`}
         WHERE status = 'adopted' AND pack_id = ${FLEET_LESSONS_PACK_ID} AND pack_item_id = ${itemId}`;
    },
    forgetPristinePoolRows: async (itemId) => {
      const pack = await loadPack();
      const item = pack?.items.find((i) => i.id === itemId);
      let forgotten = 0;
      for (const hive of await localHives()) {
        const entries = await backend.list({ scope: hiveScopeKey(hive) }).catch(() => []);
        for (const e of entries) {
          const m = e.metadata ?? {};
          if (m.source !== 'pack' || m.pack_id !== FLEET_LESSONS_PACK_ID || m.pack_item_id !== itemId) continue;
          // item deleted from the pack already ⇒ compare against its last render if resolvable, else keep
          const pristine = item ? memoryTextOf(item) === e.text : false;
          if (!pristine) continue; // edited rows are the user's words — kept (D-003)
          await backend.forget(e.id).catch(() => {});
          forgotten += 1;
        }
      }
      return forgotten;
    },
    listHives: localHives,
    sweepConflicts: async (hive): Promise<HygieneConflictPair[]> => {
      const entries = await backend.list({ scope: hiveScopeKey(hive) }).catch(() => []);
      const byId = new Map(entries.map((e) => [e.id, e]));
      const sweep = await manage.sweepHiveConflicts({ potSlug: hive });
      return Promise.all(
        sweep.pairs.map(async (p) => {
          const a = byId.get(p.aId);
          const b = byId.get(p.bId);
          return {
            hive,
            aId: p.aId,
            aText: p.aText,
            bId: p.bId,
            bText: p.bText,
            summary: p.summary,
            aPristinePack: a ? await pristineOf(a.metadata, a.text) : false,
            bPristinePack: b ? await pristineOf(b.metadata, b.text) : false,
          };
        }),
      );
    },
    forgetRow: (id) => backend.forget(id),
    fileConflict: async (pair) => {
      const { captureImprovement } = await import('../improvements/capture-core');
      await captureImprovement({
        title: `Hive ${pair.hive} memory contradiction (knowledge-hygiene): ${pair.summary.slice(0, 140)}`,
        kind: 'change',
        severity: 'minor',
        body:
          `The knowledge-hygiene sweep found a contradiction it will NOT auto-resolve ` +
          `(only a pristine-pack-vs-organic pair auto-resolves; this one is not):\n\n` +
          `A (${pair.aId}): ${pair.aText.slice(0, 500)}\n\nB (${pair.bId}): ${pair.bText.slice(0, 500)}\n\n` +
          `Judge summary: ${pair.summary}\n\nResolve by forgetting/editing one side in the ${pair.hive} Learnings view.`,
        foundDuring: 'system:knowledge-pack-hygiene',
      });
    },
    pruneDismissed: async (olderThanDays) => {
      const { sql } = getOrgPg();
      const rows = (await sql`
        DELETE FROM harness_shared.knowledge_pack_candidates
         WHERE status = 'dismissed' AND decided_at < now() - make_interval(days => ${olderThanDays})
         RETURNING id`) as unknown as Array<unknown>;
      return rows.length;
    },
  };
}

registerSystemAction('knowledge-pack-hygiene', async (ctx: SystemActionCtx): Promise<void> => {
  if (!(await getFlag(FLAGS.KNOWLEDGE_PACKS, 'system').catch(() => true))) {
    console.log('[knowledge-pack-hygiene] knowledge-packs flag off — hygiene skipped');
    return;
  }
  const deps = await liveHygieneDeps(ctx.workspaceId);
  // knowledge-pack-settings P-002: knobs resolve stored → env → default, so a
  // memory-settings edit takes effect on the NEXT tick with no restart (the
  // env names above keep working as boot-time fallbacks).
  const knobs = await resolveKnowledgePackKnobs();
  const r = await runKnowledgeHygieneTick(
    {
      minAgeDays: knobs.minAgeDays,
      maxReviewsPerTick: knobs.maxReviewsPerTick,
      maxHivesPerTick: knobs.hygieneMaxHivesPerTick,
      pruneDismissedDays: knobs.pruneDismissedDays,
    },
    deps,
  );
  const summary =
    `re-reviewed ${r.itemsReviewed} (retired ${r.itemsRetired}, ${r.poolRowsForgotten} pool rows forgotten, ` +
    `${r.reviewErrors} judge errors); swept ${r.hivesSwept} hive(s) ` +
    `(${r.conflictsAutoResolved} auto-resolved, ${r.conflictsFiled} filed); pruned ${r.dismissedPruned} dismissed`;
  console.log(`[knowledge-pack-hygiene] ${summary}`);
});
