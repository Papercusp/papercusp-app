/**
 * expert-model-allowlist.ts — the RANKED list of models allowed to ANSWER a
 * consult (plan consult-expert-routing-2026-09-22, D-004).
 *
 * [owner 2026-09-22] "Lets create a setting exposed in the gui for selecting a
 * list of models allowed to be experts and rank them"; seed: "any opus/fable for
 * claude and any sol/astra for chatgpt".
 *
 * WHAT THIS IS NOT. It does not govern whose TRANSCRIPT counts (D-003): a Luna's
 * transcript can still be the knowledge source while an allowed model reasons
 * over it. The router picks the SOURCE by relevance; this list picks who ANSWERS
 * from that source — which is exactly how the "dumb lunas answering consults"
 * concern is met without throwing away their knowledge.
 *
 * ORDER IS THE POLICY. `rank` ascending is the walk order the dispatcher uses
 * (consult-dispatch.ts): rank 1 is tried first, and each later rank is the
 * fallback for a walled account, an unforkable source, or a failed launch.
 *
 * P-005 replaces `loadRanks` with the Postgres-backed setting the GUI (P-006)
 * writes; the seed below stays as the value a workspace starts with and the
 * fallback when the setting has never been written.
 */

/** The backends a launch can actually run on (psu's `--agent`). */
export type ExpertBackend = 'claude' | 'codex' | 'omp';

export interface AllowedExpertModel {
  /** 1-based walk position. Lower is tried first; ties break on array order. */
  rank: number;
  /** Backend that runs this model — decides fork vs convert against the source. */
  agent: ExpertBackend;
  /**
   * The model spec handed to `psu --model`. Kept as the ALIAS the launcher
   * accepts (`opus`, `sol`) rather than a pinned provider id, so the allowlist
   * does not have to be re-authored every time a family's concrete id rolls.
   */
  model: string;
}

/**
 * The seeded allowlist (D-004, owner-stated). Claude's premium families first,
 * then ChatGPT's — a workspace that never opens the GUI gets exactly the owner's
 * stated policy.
 */
export const DEFAULT_EXPERT_MODEL_ALLOWLIST: readonly AllowedExpertModel[] = Object.freeze([
  { rank: 1, agent: 'claude', model: 'fable' },
  { rank: 2, agent: 'claude', model: 'opus' },
  { rank: 3, agent: 'codex', model: 'sol' },
  { rank: 4, agent: 'codex', model: 'gpt-6-astra' },
] as const);

/** Settings seam — P-005 binds the Postgres read; unbound falls back to the seed. */
export interface ExpertModelAllowlistDeps {
  loadRanks?: (workspaceId: string) => Promise<readonly AllowedExpertModel[] | null>;
}

const BACKENDS: ReadonlySet<string> = new Set<ExpertBackend>(['claude', 'codex', 'omp']);

/**
 * Normalize a stored/authored list into the walk order.
 *
 * Deliberately total (never throws): a malformed row is DROPPED rather than
 * failing the consult, because this list is read on the dispatch critical path
 * and an unparseable setting must degrade to "fewer ranks", never to "no expert
 * routing at all". An entry surviving normalization is launchable by
 * construction — a backend psu accepts and a non-empty model spec.
 */
export function normalizeExpertModelAllowlist(
  raw: unknown,
): AllowedExpertModel[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entries: AllowedExpertModel[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const agent = String((row as { agent?: unknown }).agent ?? '').trim().toLowerCase();
    const model = String((row as { model?: unknown }).model ?? '').trim();
    if (!BACKENDS.has(agent) || !model) continue;
    // One (backend, model) pair can only occupy one rank: a duplicate would
    // spend a walk step re-attempting an identical launch that just failed.
    const key = `${agent}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rank = Number((row as { rank?: unknown }).rank);
    entries.push({
      rank: Number.isFinite(rank) && rank > 0 ? Math.floor(rank) : entries.length + 1,
      agent: agent as ExpertBackend,
      model,
    });
  }
  // Stable sort on rank, then re-number densely so the walk cannot skip or
  // repeat a position after a GUI reorder left gaps (1, 4, 7 → 1, 2, 3).
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.rank - b.entry.rank || a.index - b.index)
    .map(({ entry }, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * The ranked allowlist for a workspace, best-first. Falls back to the seed when
 * no setting is stored, when the stored value is unusable, and when the loader
 * itself fails — the dispatcher must always have a list to walk.
 */
export async function resolveExpertModelAllowlist(
  workspaceId: string,
  deps: ExpertModelAllowlistDeps = {},
): Promise<AllowedExpertModel[]> {
  if (deps.loadRanks) {
    try {
      const stored = await deps.loadRanks(workspaceId);
      const normalized = normalizeExpertModelAllowlist(stored);
      if (normalized.length > 0) return normalized;
    } catch {
      // A settings read failure is not authority to route a consult to an
      // unvetted model, and it is not a reason to refuse one either. The seed
      // IS the owner-stated policy, so falling back to it is the safe answer.
    }
  }
  return normalizeExpertModelAllowlist([...DEFAULT_EXPERT_MODEL_ALLOWLIST]);
}
