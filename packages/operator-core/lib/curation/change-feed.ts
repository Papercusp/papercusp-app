/**
 * change-feed.ts — the Change Feed (P-050): a derived projection over completion
 * records (work_item completions, gym proposals, plan runs, auto-implements).
 *
 * Plan: self-learning-central-2026-06-06 (D-005) — "Change Feed is a derived
 * view over completion records, summaries referencing the originals, the
 * rationale:feed / docs-engine pattern. Never a duplicated event log."
 *
 * The feed is:
 * - DERIVED: it reads from existing completion sources, not a primary log.
 * - REGENERABLE: querying the sources again produces the same feed state.
 * - RANKED by salience + recency (one calm rollup per tick).
 * - REFERENCED: each entry carries a `ref` back to the original, never duplicated.
 *
 * Pure, side-effect-free, testable with injected readers (like fleet-signals).
 */

/**
 * A change-feed entry — a completion event that shaped the system. Structured
 * so a tool can rank + render it without re-querying the originals.
 */
export interface ChangeFeedEntry {
  /** Stable id for dedup across ticks, e.g. "wi:F-012", "gym:proposal-id". */
  id: string;
  /** The kind of change: 'completion' | 'proposal' | 'plan-run'. */
  kind: 'completion' | 'proposal' | 'plan-run';
  /** One-line summary (what was completed). */
  title: string;
  /** Optional detail (e.g. test counts, status). */
  detail?: string;
  /** Owning harness, when applicable. */
  harness?: string;
  /** The work-item id, when applicable (F-/EI-/WI-/etc). */
  workItemId?: string;
  /**
   * Drill-in reference to the original (rationale:feed pattern):
   * the agent can call plans:get / docs:get / work_items:get with this.
   * E.g. "wi:F-012", "gym:proposal-abc", "plan:self-learning-central-2026-06-06".
   */
  ref: string;
  /** ISO timestamp of completion. */
  ts: string;
  /** Was this change user-requested (vs fleet-internal)? Influences ranking. */
  userRequested?: boolean;
}

/** The injectable source bag — each reader returns completions from one source. */
export interface ChangeFeedReaders {
  /** Work-item completions (items that reached terminal status). */
  workItemCompletions(): Promise<ChangeFeedEntry[]>;
  /** Gym proposals (prompt changes accepted / rejected). */
  gymProposals(): Promise<ChangeFeedEntry[]>;
  /** Plan runs that finished. */
  planRuns(): Promise<ChangeFeedEntry[]>;
}

/** Run a reader defensively, returning `[]` on error — one bad source won't kill the feed. */
async function safe<T>(fn: () => Promise<T[]>, label: string): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
     
    console.warn(`[change-feed] reader "${label}" failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Gather + normalize completions from all sources into one `ChangeFeedEntry[]`,
 * de-duplicated by `id`, sorted newest-first (the salience engine will rank further).
 * Pure over the injected readers.
 */
export async function gatherCompletions(readers: ChangeFeedReaders): Promise<ChangeFeedEntry[]> {
  const [wis, gyms, plans] = await Promise.all([
    safe(() => readers.workItemCompletions(), 'workItemCompletions'),
    safe(() => readers.gymProposals(), 'gymProposals'),
    safe(() => readers.planRuns(), 'planRuns'),
  ]);

  const entries: ChangeFeedEntry[] = [...wis, ...gyms, ...plans];
  return dedupById(entries).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

/** First-wins de-dup by `id`. */
export function dedupById(entries: readonly ChangeFeedEntry[]): ChangeFeedEntry[] {
  const seen = new Set<string>();
  const out: ChangeFeedEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/**
 * Filter + rank entries for the feed display. Ranks by:
 * 1. userRequested first (user-facing changes surface first).
 * 2. Newest first (recency).
 * 3. Limit to N most recent.
 */
export function rankChangeFeed(
  entries: readonly ChangeFeedEntry[],
  opts: { limit?: number; userRequestedOnly?: boolean } = {}
): ChangeFeedEntry[] {
  const limit = opts.limit ?? 100;
  let rows = [...entries];

  if (opts.userRequestedOnly) {
    rows = rows.filter((r) => r.userRequested === true);
  }

  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      // User-requested first.
      if ((a.r.userRequested ?? false) !== (b.r.userRequested ?? false)) {
        return a.r.userRequested ? -1 : 1;
      }
      // Newest first (recency) — compare ts directly so the fn honors its
      // "newest first" contract on ANY input order, not only a caller that
      // pre-sorts (CUR-1). The input index is the final tie-break, keeping the
      // sort stable for entries that share a ts.
      if (a.r.ts !== b.r.ts) return a.r.ts < b.r.ts ? 1 : -1;
      return a.i - b.i;
    })
    .map(({ r }) => r)
    .slice(0, limit);
}
