/**
 * substrate-active-set-facts.ts — gather the activation facts the PURE
 * {@link ./substrate-active-set-policy} decides on (P-010).
 *
 * The impure half of the pure/impure split: this module does the I/O, the policy
 * module does the deciding. Kept separate so the rule stays provable without PG.
 *
 * COST. Two GROUPED queries for the WHOLE sweep, not one per harness — the
 * per-harness fs/PG probe this replaces would have been an O(N) serial-IO loop
 * (`/internal/docs/performance` A-series), i.e. the very cost P-010 exists to
 * remove. Both queries ride an existing composite index:
 *   - substrate_outbox_drain_idx (workspace_id, harness_slug, drained_at, id)
 *   - shared_presence_recent_idx (workspace_id, harness_slug, last_seen_at DESC)
 * `federating` / `pinned` come from the registry payload the sweep has ALREADY
 * loaded to discover slugs, so they cost nothing at all.
 *
 * FAIL-OPEN IS THE WHOLE SAFETY STORY. Every failure path here returns facts
 * that make the policy ACTIVATE. A probe that cannot see pending writes must
 * never be read as "there are none" — that would silently dark a harness that
 * owes the hive a write (the EI-126 divergence class). Degraded facts therefore
 * cost footprint (an eager boot, i.e. today's behaviour), never correctness.
 */

import type { HarnessActivationFacts } from './substrate-active-set-policy';

/** The registry fields that decide `federating` / `pinned`, already in hand. */
export interface ActivationRegistryEntry {
  workspaceId: string;
  harnessSlug: string;
  /** Registry `harness_kind` — 'hive' marks a Hive HOME (repo-less state dir). */
  harnessKind?: string;
  /** Registry `hive_slug` — present ⇒ this harness is a member of that Hive. */
  potSlug?: string;
}

/** Injected I/O, so the gatherer unit-tests without PG. */
export interface ActivationFactDeps {
  /** Undrained `substrate_outbox` row counts, keyed `workspaceId::harnessSlug`. */
  pendingOutboxCounts: () => Promise<Map<string, number>>;
  /** Most recent `shared_presence.last_seen_at` (epoch ms), same key shape. */
  lastPresenceMs: () => Promise<Map<string, number>>;
}

function factsKey(workspaceId: string, harnessSlug: string): string {
  return `${workspaceId}::${harnessSlug}`;
}

/**
 * A harness FEDERATES when it is a Hive home (`harness_kind:'hive'`) or points at
 * one (`hive_slug`). This is deliberately the same pure-membership notion
 * `potHomeSlugForHarness` uses — "is a member", independent of whether the
 * binding currently RESOLVES. A member whose hive lookup is merely
 * un-backfilled or unpublished still has a remote writer, so treating it as
 * non-federating (and therefore deferrable) would be exactly the wrong call.
 */
export function isFederatingEntry(entry: ActivationRegistryEntry): boolean {
  return entry.harnessKind === 'hive' || (entry.potSlug != null && entry.potSlug !== '');
}

/**
 * Build the activation facts for one sweep. `pinnedKeys` lets the caller pin
 * extra harnesses (the active workspace's own harness, an explicit keep).
 *
 * On ANY dependency failure this returns MAXIMALLY-ACTIVATING facts for every
 * entry (pending=1) rather than propagating — see the fail-open note above.
 */
export async function gatherActivationFacts(
  entries: readonly ActivationRegistryEntry[],
  deps: ActivationFactDeps,
  pinnedKeys: ReadonlySet<string> = new Set(),
): Promise<HarnessActivationFacts[]> {
  let pending: Map<string, number>;
  let presence: Map<string, number>;
  try {
    // Independent reads — issue them together rather than serially.
    [pending, presence] = await Promise.all([deps.pendingOutboxCounts(), deps.lastPresenceMs()]);
  } catch (e) {
    console.warn(
      '[substrate-active-set] activation probe failed — booting EVERY harness eagerly (fail-open):',
      e instanceof Error ? e.message : String(e),
    );
    return entries.map((entry) => ({
      key: factsKey(entry.workspaceId, entry.harnessSlug),
      pinned: true,
      pendingOutboxRows: 1,
      lastPresenceMs: null,
      federating: isFederatingEntry(entry),
    }));
  }

  return entries.map((entry) => {
    const key = factsKey(entry.workspaceId, entry.harnessSlug);
    return {
      key,
      pinned: entry.harnessKind === 'hive' || pinnedKeys.has(key),
      pendingOutboxRows: pending.get(key) ?? 0,
      lastPresenceMs: presence.get(key) ?? null,
      federating: isFederatingEntry(entry),
    };
  });
}

/** The real PG-backed deps. Both queries are grouped + index-backed. */
export function createPgActivationFactDeps(
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>,
  /** Ignore presence rows older than this (they cannot mark anything live).
   *  Keeps the presence scan bounded as `shared_presence` grows. */
  presenceHorizonMs: number = 60 * 60 * 1000,
): ActivationFactDeps {
  return {
    async pendingOutboxCounts(): Promise<Map<string, number>> {
      const rows = (await sql`
        SELECT workspace_id, harness_slug, count(*)::bigint AS n
        FROM harness_shared.substrate_outbox
        WHERE drained_at IS NULL
        GROUP BY workspace_id, harness_slug
      `) as Array<{ workspace_id: string; harness_slug: string; n: string | number }>;
      const out = new Map<string, number>();
      for (const r of rows) out.set(factsKey(r.workspace_id, r.harness_slug), Number(r.n));
      return out;
    },
    async lastPresenceMs(): Promise<Map<string, number>> {
      const horizon = new Date(Date.now() - presenceHorizonMs);
      const rows = (await sql`
        SELECT workspace_id, harness_slug, max(last_seen_at) AS last_seen
        FROM harness_shared.shared_presence
        WHERE last_seen_at > ${horizon}
        GROUP BY workspace_id, harness_slug
      `) as Array<{ workspace_id: string; harness_slug: string; last_seen: Date | string }>;
      const out = new Map<string, number>();
      for (const r of rows) {
        const ms = new Date(r.last_seen).getTime();
        if (Number.isFinite(ms)) out.set(factsKey(r.workspace_id, r.harness_slug), ms);
      }
      return out;
    },
  };
}
