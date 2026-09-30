/**
 * learning-hive-read.ts — the read behind the Learning tab's "Learnings" view
 * (learning-packs-2026-06-11 P-008).
 *
 * One hive's shared memory pool (`hive:<slug>`, P-004), annotated with pack
 * provenance so the UI can keep the boundary legible between "what Papercusp
 * (or an installed pack) gave you" and "what your hive learned":
 *
 *   - a row whose metadata carries `{source:'pack', pack_id, pack_version,
 *     pack_item_id}` is PACK-SEEDED → badge it; `packState` says whether its
 *     text still matches the pack's canonical render (`pristine`) or was
 *     edited (`modified`, compared via memoryTextOf against the currently
 *     resolvable pack of the same id);
 *   - any other row is ORGANIC — recorded by the hive's own agents/owner.
 *
 * Per-pack rollups also count `notPresent` (pack items with no row — removed
 * by the user OR filtered at seed time by applies_to; the store can't
 * distinguish, so the UI words it as "not seeded / removed").
 *
 * Pure over injected deps (backend list + pack loader) so the resolver test
 * pins it without PG/FS; the index.ts entry wires the real impls.
 */

import type { MemoryEntry } from '../memory/backend';
import { memoryTextOf, type KnowledgePack } from '../knowledge-packs/pack-format';
import { createReadDeadline, type WithinBudget } from './read-deadline';

/**
 * This read's share of the sync layer's `RESOLVER_READ_TIMEOUT_MS` ceiling.
 * Matches the sibling resolver budgets (`LIST_READ_BUDGET_MS`,
 * `RESOLVER_FANOUT_BUDGET_MS`) so one wedged pack store degrades this panel
 * instead of 500-ing the query.
 */
export const HIVE_LEARNINGS_BUDGET_MS = 6_000;

export interface HiveLearningRow {
  id: string;
  text: string;
  kind?: string;
  /** Pack provenance (absent on organic rows). */
  packId?: string;
  packVersion?: string;
  packItemId?: string;
  /** pack rows only: text matches the resolvable pack's canonical render? */
  packState?: 'pristine' | 'modified';
  appliesTo?: string[];
  createdBy?: string;
}

export interface HivePackRollup {
  packId: string;
  /** Version stamped on the seeded rows (first seen). */
  packVersion?: string;
  /** Rows present, of which `modified` were user-edited. */
  present: number;
  modified: number;
  /** Items in the resolvable pack with no row (removed or never seeded). */
  notPresent: number;
  /** Item count of the currently resolvable pack (absent when unresolvable). */
  packTotal?: number;
  /** Decorated by the resolver (P-009): injection on/off for this hive. */
  enabled?: boolean;
  /** Decorated by the resolver (P-013): a newer pack version is adoptable. */
  updateAvailable?: boolean;
  availableVersion?: string;
}

export interface HiveLearningsSnapshot {
  hive: string;
  rows: HiveLearningRow[];
  packs: HivePackRollup[];
  organicCount: number;
  /** True when the memory store was unreachable (UI renders "unavailable"). */
  unavailable?: boolean;
  /**
   * WHY the store was unreachable, verbatim from the backend. Previously the
   * catch below swallowed this and the UI could only say "Shared memory
   * unavailable" — a dead end for the reader (owner report 2026-07-25, whose
   * actual cause was a corrupted `mem0ai` install: "Cannot find package
   * .../mem0ai/node_modules/uuid"). An unavailability the user cannot act on
   * is a bug in the message, not just the backend.
   */
  unavailableReason?: string;
}

export interface HiveLearningsDeps {
  /** One pool, or several read as one (the backend's ListOptions.scope already
   *  accepts `string | readonly string[]`). */
  listPool: (scope: string | readonly string[]) => Promise<MemoryEntry[]>;
  loadPack: (packId: string) => Promise<{ pack: KnowledgePack } | null>;
  /**
   * Every pot slug in the workspace — consulted ONLY for the "All Pots" ('')
   * lens (WI-6384). Optional so existing single-pot callers are unaffected; a
   * caller that omits it simply cannot serve the rollup, and says so honestly
   * rather than returning a silent empty.
   */
  listPotSlugs?: () => Promise<string[]>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * One pot's retained-learnings pool — or, when `potSlug` is '' (the "All Pots"
 * lens), every pot's pools read as one.
 *
 * WI-6384: the '' case used to be refused by the caller with a hard-coded empty
 * snapshot, so selecting the BROADEST lens produced the EMPTIEST view — an empty
 * list and `organicCount: 0` rendered beside the workspace-wide "banked this
 * week" strip, two numbers from different populations sitting side by side. The
 * tab's own contract (LearningTab.tsx: "All Pots => '' => the workspace-wide
 * rollup each hive-aware view already supports") always said this should work;
 * every sibling hive-aware view already honoured it. Retain was the exception.
 */
export async function readHiveLearnings(
  potSlug: string,
  deps: HiveLearningsDeps,
  options?: {
    /**
     * The deadline this read's legs share (WI-39849). Injectable so a test can
     * drive an expiry deterministically; defaults to a fresh one so every
     * existing caller is bounded without changing its call site.
     */
    withinBudget?: WithinBudget;
  },
): Promise<HiveLearningsSnapshot> {
  // ONE deadline for the whole read, not one per call: the pack fan-out below is
  // VARIABLE-ARITY (one leg per referenced pack), so per-call budgets would sum
  // to N × the budget and overrun the very resolver timeout this bound exists to
  // stay under. Each leg keeps its own error handling — the deadline only adds
  // the case a `.catch` cannot cover, a leg that never settles at all.
  const withinBudget = options?.withinBudget ?? createReadDeadline(HIVE_LEARNINGS_BUDGET_MS);
  const unavailable = (reason: string): HiveLearningsSnapshot => ({
    hive: potSlug,
    rows: [],
    packs: [],
    organicCount: 0,
    unavailable: true,
    unavailableReason: reason.slice(0, 300),
  });

  let scope: string | readonly string[];
  if (potSlug) {
    scope = `hive:${potSlug}`;
  } else {
    // All Pots. Resolve the pools to read; an empty/absent pot list is reported
    // as unavailable rather than as "this workspace has retained nothing" —
    // those are different facts, and conflating them is the bug being fixed.
    if (!deps.listPotSlugs) return unavailable('workspace rollup unsupported by this caller');
    let slugs: string[];
    try {
      slugs = await withinBudget(deps.listPotSlugs(), 'hiveLearnings listPotSlugs');
    } catch (err) {
      return unavailable(err instanceof Error ? err.message : String(err));
    }
    if (slugs.length === 0) return unavailable('no pots registered in this workspace');
    scope = slugs.map((s) => `hive:${s}`);
  }

  let entries: MemoryEntry[];
  try {
    entries = await withinBudget(deps.listPool(scope), 'hiveLearnings listPool');
  } catch (err) {
    // Carry the reason (see `unavailableReason`) — never swallow it.
    return unavailable(err instanceof Error ? err.message : String(err));
  }

  // Resolve each referenced pack ONCE (batched — never per-row).
  const packIds = [
    ...new Set(
      entries
        .map((e) => (e.metadata?.source === 'pack' ? str(e.metadata?.pack_id) : undefined))
        .filter((v): v is string => !!v),
    ),
  ];
  // VARIABLE-ARITY fan-out (WI-39849): one leg per referenced pack, so the
  // exposure grows with the corpus. The existing `.catch(() => null)` degrades a
  // pack that THROWS; the shared deadline is what degrades one that HANGS.
  const loaded = await Promise.all(
    packIds.map(
      async (id) =>
        [
          id,
          await withinBudget(deps.loadPack(id), `hiveLearnings loadPack ${id}`).catch(() => null),
        ] as const,
    ),
  );
  const packById = new Map(loaded);

  const rows: HiveLearningRow[] = entries.map((e) => {
    const m = e.metadata ?? {};
    const isPack = m.source === 'pack' && str(m.pack_id);
    const base: HiveLearningRow = {
      id: e.id,
      text: e.text,
      ...(e.kind ? { kind: e.kind } : {}),
      ...(Array.isArray(m.applies_to) ? { appliesTo: m.applies_to as string[] } : {}),
      ...(str(m.created_by) ? { createdBy: str(m.created_by) } : {}),
    };
    if (!isPack) return base;
    const packId = str(m.pack_id)!;
    const itemId = str(m.pack_item_id);
    const pack = packById.get(packId)?.pack;
    const item = itemId ? pack?.items.find((i) => i.id === itemId) : undefined;
    return {
      ...base,
      packId,
      ...(str(m.pack_version) ? { packVersion: str(m.pack_version) } : {}),
      ...(itemId ? { packItemId: itemId } : {}),
      // Unresolvable pack/item ⇒ can't compare ⇒ treat as modified (honest:
      // we can't vouch it's pristine).
      packState: item && memoryTextOf(item) === e.text ? 'pristine' : 'modified',
    };
  });

  const packs: HivePackRollup[] = packIds.map((packId) => {
    const mine = rows.filter((r) => r.packId === packId);
    const pack = packById.get(packId)?.pack;
    const presentItemIds = new Set(mine.map((r) => r.packItemId).filter(Boolean));
    return {
      packId,
      ...(mine.find((r) => r.packVersion)?.packVersion
        ? { packVersion: mine.find((r) => r.packVersion)!.packVersion }
        : {}),
      present: mine.length,
      modified: mine.filter((r) => r.packState === 'modified').length,
      notPresent: pack ? pack.items.filter((i) => !presentItemIds.has(i.id)).length : 0,
      ...(pack ? { packTotal: pack.items.length } : {}),
    };
  });

  return {
    hive: potSlug,
    rows,
    packs,
    organicCount: rows.filter((r) => !r.packId).length,
  };
}
