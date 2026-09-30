/**
 * Conflict-on-write LLM check.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 4, P-017).
 *
 * P-016's dedup-on-write catches *near-duplicate wording*, but two
 * memories can be semantically related yet directly contradict (e.g.,
 * "Dev prefers terse responses" vs "Dev prefers verbose responses" —
 * closely related, but in conflict). This module runs a small Haiku
 * call against the top-K nearest neighbors to detect that.
 *
 * ⚠ P-016 does NOT decide semantically, and does not run by default.
 * It RETRIEVES top-K neighbours by vector/hybrid search, but the verdict
 * is `lexicalSimilarity` (trigram-Jaccard >= 0.9) on the full text —
 * EI-10544: the live hybrid backend scores by RRF, an ORDINAL quantity
 * (top hit ~1/61 whether or not it is a byte-identical duplicate), so a
 * fused score cannot make a metric call. And it is gated OFF unless
 * PAPERCUSP_MEMORY_DEDUP=on. So a REWORDED duplicate is refused by
 * neither gate at write time; recall-side Gate 2.5 (recall-admission.ts,
 * word-token Jaccard >= 0.82) is what actually collapses duplicates
 * today, and it is lexical too. Measured residual: EI-19484539329069426.
 *
 * Reuses the top-K results from P-016's dedup search (no double-pay).
 * Pure function: takes the new text + neighbor texts + an injected
 * `llmJudge` callback. The remember.ts caller wires the real Anthropic
 * client; tests mock the callback.
 *
 * Feature-flagged via PAPERCUSP_MEMORY_CONFLICT_CHECK — default ON
 * (learning-system-audit-improvements-2026-06-09 P-050: the check is
 * advisory hygiene, cheap per write, and never blocks the caller);
 * set =off as the kill switch.
 */

export interface NeighborMemory {
  id: string;
  text: string;
  score?: number;
}

export interface ConflictReport {
  conflicts: Array<{
    memory_id: string;
    summary: string;
  }>;
}

export type LlmJudge = (input: {
  newText: string;
  neighbors: NeighborMemory[];
}) => Promise<ConflictReport>;

export function conflictCheckEnabled(): boolean {
  return process.env.PAPERCUSP_MEMORY_CONFLICT_CHECK !== 'off';
}

/**
 * Run the conflict check. Returns:
 *   - { conflicts: [...] } when LLM reports direct contradiction(s)
 *   - { conflicts: [] }    when no conflict found / nothing to check
 *
 * Defensive: any failure of the judge (LLM timeout, parse error, etc.)
 * is treated as "no conflict found" so the write proceeds. Conflict
 * check is hygiene, never load-bearing — same posture as dedup.
 */
export async function checkConflicts(opts: {
  newText: string;
  neighbors: NeighborMemory[];
  judge: LlmJudge;
}): Promise<ConflictReport> {
  if (!conflictCheckEnabled()) return { conflicts: [] };
  if (opts.neighbors.length === 0) return { conflicts: [] };

  try {
    const result = await opts.judge({
      newText: opts.newText,
      neighbors: opts.neighbors,
    });
    if (!result || !Array.isArray(result.conflicts)) {
      return { conflicts: [] };
    }
    // Validate each conflict has the expected shape
    const valid = result.conflicts.filter(
      (c) =>
        typeof c?.memory_id === 'string' &&
        typeof c?.summary === 'string' &&
        c.memory_id.length > 0,
    );
    return { conflicts: valid };
  } catch {
    return { conflicts: [] };
  }
}

/**
 * Build the prompt body for a Haiku-class model. Returns the user
 * message text; the caller wraps it with system prompt + model
 * configuration. Exposed so callers can audit / swap prompt strategy
 * without touching this module.
 */
export function buildConflictPrompt(opts: {
  newText: string;
  neighbors: NeighborMemory[];
}): string {
  const neighborBlock = opts.neighbors
    .map((n, i) => `[${i + 1}] id=${n.id}: ${n.text}`)
    .join('\n');

  return [
    'You are checking whether a NEW memory directly contradicts any EXISTING memory.',
    '',
    'A "contradiction" means: both cannot be true at the same time about the same subject.',
    'Examples:',
    '  - "user prefers vim" vs "user prefers emacs" → CONTRADICTION',
    '  - "we use PostgreSQL" vs "we use MySQL" → CONTRADICTION (about the same component)',
    '  - "user prefers terse" vs "user uses TypeScript" → NOT a contradiction (unrelated)',
    '  - "use Postgres for storage" vs "Postgres is our default for new state" → NOT a contradiction (consistent)',
    '',
    'NEW memory:',
    opts.newText,
    '',
    'EXISTING memories:',
    neighborBlock,
    '',
    'Respond ONLY with a JSON object of the form:',
    '{"conflicts": [{"memory_id": "<id from above>", "summary": "<1-sentence why it conflicts>"}]}',
    '',
    'If there are no contradictions, respond exactly:',
    '{"conflicts": []}',
  ].join('\n');
}

/**
 * Parse a Haiku response into a ConflictReport. Tolerates surrounding
 * whitespace / code fences (Haiku sometimes wraps JSON in ```json).
 * Returns `{ conflicts: [] }` on any parse failure.
 */
export function parseConflictResponse(raw: string): ConflictReport {
  if (typeof raw !== 'string' || !raw.trim()) return { conflicts: [] };
  // Strip code fences if present
  let body = raw.trim();
  const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fenceMatch) body = fenceMatch[1].trim();

  // Extract the first {...} block — Haiku sometimes adds prose before it
  const objStart = body.indexOf('{');
  const objEnd = body.lastIndexOf('}');
  if (objStart < 0 || objEnd <= objStart) return { conflicts: [] };
  const slice = body.slice(objStart, objEnd + 1);

  try {
    const parsed = JSON.parse(slice) as unknown;
    if (!parsed || typeof parsed !== 'object') return { conflicts: [] };
    const c = (parsed as { conflicts?: unknown }).conflicts;
    if (!Array.isArray(c)) return { conflicts: [] };
    const valid = c.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const it = item as { memory_id?: unknown; summary?: unknown };
      if (typeof it.memory_id !== 'string' || !it.memory_id) return [];
      if (typeof it.summary !== 'string') return [];
      return [{ memory_id: it.memory_id, summary: it.summary }];
    });
    return { conflicts: valid };
  } catch {
    return { conflicts: [] };
  }
}

export const _testing = {
  conflictCheckEnabled,
};
