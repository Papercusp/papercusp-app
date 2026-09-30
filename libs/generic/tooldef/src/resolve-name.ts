/**
 * Core tool-name resolver (plan `fuzzy-tool-name-resolution-2026-07-02`, P-004).
 *
 * The public, caller-facing contract over P-003's calibrated matcher
 * (`resolve-name-match.ts`, which owns the canonical fold, the group-then-verb scoring and the
 * D-006 gate). This file adds only what a seam needs on top of it:
 *   - a stable result shape `{ match?, ambiguous?, blocked?, alternatives[], via? }` instead of
 *     the matcher's discriminated union (callers render "did you mean …" from `alternatives`);
 *   - D-007's protected population as caller-supplied predicates — `tierOf(tool) === 'high'`
 *     plus an optional `neverFuzzy` (real capability tiers are not write-vs-read: a `flags:set`
 *     can be `medium`, so a mutating-verb heuristic can widen the gate).
 *
 * PURE and domain-free (D-001): the caller hands in the candidate set (D-009 — the tools it can
 * actually dispatch, as canonical `group:verb` names) and the calibrated `{ T, M }`. Miss-path
 * only (D-003): callers try their exact lookup first and invoke this only on a MISS.
 *
 *   `via: 'canonical'` — stage 1 (D-004): case/separator/server-prefix fold equals a candidate.
 *                        Allowed even for high-tier tools; never fuzzy, never ambiguous.
 *   `via: 'fuzzy'`     — stage 2 (D-005/D-006): unique, within `T` per part, `M` raw edits clear.
 *   `ambiguous: true`  — >=2 candidates too close; NEVER guess.
 *   `blocked: true`    — the single best fuzzy hit is high-tier (D-007): reported in
 *                        `alternatives`, never in `match`.
 */
import { matchName, type MatchParams } from './resolve-name-match';
import { FUZZY_RESOLVE_M, FUZZY_RESOLVE_T } from './resolve-name-thresholds';

export interface ResolveNameOptions extends MatchParams {
  /** Capability tier of a candidate; `'high'` (D-007) is never fuzzy-resolved. */
  readonly tierOf?: (tool: string) => string | undefined;
  /** Extra never-fuzzy predicate widening D-007 beyond `tierOf === 'high'`. */
  readonly neverFuzzy?: (tool: string) => boolean;
}

/** The frozen, sweep-calibrated `{ T, M }` (P-003, `resolve-name-thresholds.ts`) — the seam default. */
export const DEFAULT_RESOLVE_PARAMS: MatchParams = { T: FUZZY_RESOLVE_T, M: FUZZY_RESOLVE_M };

export type ResolveVia = 'canonical' | 'fuzzy';

export interface ResolveNameResult {
  /** The tool to dispatch. Present only when the resolver is willing to auto-resolve. */
  readonly match?: string;
  /** >=2 plausible candidates and the margin is too thin — never guess. */
  readonly ambiguous?: boolean;
  /** The single best fuzzy hit was withheld by the D-007 gate (see `alternatives`). */
  readonly blocked?: boolean;
  /** Resolved / plausible candidate names, best first ("did you mean" material). */
  readonly alternatives: readonly string[];
  /** How `match` was found; absent when nothing was resolved. */
  readonly via?: ResolveVia;
  /** Raw edit count of the best candidate (0 for canonical); absent when nothing is close. */
  readonly distance?: number;
}

/** Resolve a possibly-mangled tool name against `candidates`. Total — never throws. */
export function resolveToolName(
  input: string,
  candidates: readonly string[],
  opts: ResolveNameOptions,
): ResolveNameResult {
  const isHigh = (tool: string): boolean => opts.tierOf?.(tool) === 'high' || opts.neverFuzzy?.(tool) === true;
  const o = matchName(input, candidates, { T: opts.T, M: opts.M }, isHigh);
  switch (o.kind) {
    case 'exact':
      return { match: o.tool, alternatives: [o.tool], via: 'canonical', distance: 0 };
    case 'fuzzy':
      return { match: o.tool, alternatives: [o.tool], via: 'fuzzy', distance: o.raw };
    case 'ambiguous':
      return { ambiguous: true, alternatives: o.candidates, distance: o.raw };
    case 'blocked-high-tier':
      return { blocked: true, alternatives: [o.tool], distance: o.raw };
    case 'none':
      return { alternatives: [] };
  }
}
