/**
 * Deterministic fuzzy matcher for tool-name resolution — the GATE of D-004..D-007
 * (plan `fuzzy-tool-name-resolution-2026-07-02`, P-003; reused by P-004's resolver).
 *
 * Pure: no registry access, no I/O. The caller hands it the candidate set (D-009: the
 * caller's resolvable set) and, optionally, a predicate marking high-tier tools (D-007).
 *
 * Pipeline (stage 1 is the pre-existing `normalizeMcpName`; this file adds stage 2):
 *   1. canonical key — lowercase, strip a well-formed `mcp__<server>__` prefix, fold every
 *      separator run `[:_.\-]+` to `:`   (mirrors `normalizeMcpName`; pinned by test)
 *   2. token clean-up — drop empty tokens (a stray leading/trailing separator) and leading
 *      tokens within {@link PREFIX_TOKEN_MAX_EDITS} edits of a known server-prefix token
 *      (a MANGLED prefix, `mcp:papercuss:u:…`, survives stage 1 as leading tokens)
 *   3. group-then-verb scoring (D-005) — split the input tokens at the candidate's own
 *      group/verb boundary (trying boundary ±1 to absorb a lost/added separator) and take
 *      Levenshtein on the GROUP and on the VERB separately
 *   4. gate — a candidate is ELIGIBLE iff BOTH parts are within `T` normalized
 *      (edits / max(len), per part, so a short verb is not over-forgiving and a long shared
 *      group prefix cannot launder a different verb). Resolve iff the best-by-RAW-edits
 *      candidate is eligible AND every OTHER candidate (eligible or not) is at least `M`
 *      raw edits farther. Uniqueness/margin are judged on RAW edit counts: normalizing by
 *      length makes the longer of two raw-tied names look strictly nearer
 *      (`accounts:npin` is 1 edit from both `pin` and `unpin`).
 *   5. D-007 — a fuzzy (not stage-1-exact) hit on a high-tier tool is NEVER resolved
 *
 * DEVIATION from D-006's wording, deliberate: D-006 lets a runner-up OUTSIDE `T` be ignored;
 * here a raw-close runner-up blocks the resolve regardless of `T`, so the margin cannot be
 * defeated by shrinking T. Strictly safer; recorded in the P-003 sweep decision.
 */

/** Same fold as `normalizeMcpName` (tool-projection.ts); `resolve-name-match.test.ts` pins the agreement. */
export function canonicalKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mcp__[^_]+(?:[^_]|_(?!_))*__/, '')
    .replace(/[:_.\-]+/g, ':');
}

/** Known server-prefix tokens a model mangles (`mcp` + the `papercusp-su` server name). */
export const PREFIX_TOKENS: readonly string[] = ['mcp', 'papercusp', 'su'];
/** A leading token is a (mangled) prefix token when within this many edits of a known one. */
export const PREFIX_TOKEN_MAX_EDITS = 2;

/**
 * Optimal-string-alignment distance: Levenshtein + ADJACENT TRANSPOSITION as one edit.
 * Models transpose letters (`palns`, `mmeory`) far more than plain Levenshtein's 2-edit
 * cost admits; charging 2 forced T up to 0.4 just to recover them (P-003 sweep).
 * Named `levenshtein` for call-site continuity with the corpora's `editDistance`.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1);
    row[0] = i;
    rows.push(row);
  }
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = v;
    }
  }
  return rows[a.length]![b.length]!;
}

/** edits / max(len) — D-006's normalized distance. */
export function normalizedDistance(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : levenshtein(a, b) / max;
}

/**
 * Input tokens for fuzzy matching: canonical fold, empty tokens dropped, leading mangled
 * server-prefix tokens dropped (always leaving at least 2 tokens, so a real short name is
 * never eaten).
 */
export function matchTokens(input: string): { tokens: string[]; edge: number } {
  // `/` and whitespace are separators a model uses (`coord/send`) that `normalizeMcpName`'s
  // fold does not cover; split on them here so they reach the matcher as raw-0 separators.
  const all = canonicalKey(input).split(/[:/\s]+/);
  const tokens = all.filter((t) => t.length > 0);
  // A STRAY edge separator (`coord:handoff-`) is NOT free noise: it may be a truncated letter
  // (`handoffs`), so it costs one raw edit per side. Free noise is only separators BETWEEN tokens.
  const edge = (all.length > 1 && all[0] === '' ? 1 : 0) + (all.length > 1 && all[all.length - 1] === '' ? 1 : 0);
  let i = 0;
  while (
    i < tokens.length - 2 &&
    tokens[i]!.length <= 'papercusp'.length + 2 &&
    PREFIX_TOKENS.some((p) => levenshtein(tokens[i]!, p) <= PREFIX_TOKEN_MAX_EDITS)
  ) {
    i++;
  }
  return { tokens: tokens.slice(i), edge };
}

export interface MatchParams {
  /** Max per-part (group AND verb) normalized distance for a candidate to be eligible. */
  readonly T: number;
  /** Required RAW-edit gap between the best candidate and every other candidate. */
  readonly M: number;
}

export interface Scored {
  readonly tool: string;
  /** group edits + verb edits (raw) at the best boundary — the ranking + margin measure */
  readonly raw: number;
  /** max(group normalized, verb normalized) at that boundary — the eligibility measure */
  readonly part: number;
}

/** Score one candidate against pre-tokenized input (best of boundary kg-1 / kg / kg+1). */
export function scoreCandidate(tokens: readonly string[], tool: string, edge = 0): Scored | null {
  const colon = tool.indexOf(':');
  const group = canonicalKey(colon < 0 ? tool : tool.slice(0, colon));
  const verb = canonicalKey(colon < 0 ? '' : tool.slice(colon + 1));
  const kg = group.split(':').length;
  let best: Scored | null = null;
  for (const split of [kg, kg - 1, kg + 1]) {
    if (split < 1 || split > tokens.length - 1) continue; // need a non-empty group AND verb side
    const g = tokens.slice(0, split).join(':');
    const v = tokens.slice(split).join(':');
    const eg = levenshtein(g, group);
    const ev = levenshtein(v, verb);
    const raw = eg + ev + edge;
    const part = Math.max(eg / Math.max(g.length, group.length), ev / Math.max(v.length, verb.length), edge / Math.max(1, g.length + v.length));
    if (best === null || raw < best.raw || (raw === best.raw && part < best.part)) best = { tool, raw, part };
  }
  return best;
}

/** Every scorable candidate, best first (raw edits, then part-normalized, then name for determinism). */
export function rankCandidates(input: string, candidates: readonly string[]): Scored[] {
  const { tokens, edge } = matchTokens(input);
  if (tokens.length < 2) return [];
  const out: Scored[] = [];
  for (const tool of candidates) {
    const s = scoreCandidate(tokens, tool, edge);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.raw - b.raw || a.part - b.part || (a.tool < b.tool ? -1 : 1));
}

export type MatchOutcome =
  /** canonical-equal (stage-1 territory — no threshold involved) */
  | { readonly kind: 'exact'; readonly tool: string }
  | { readonly kind: 'fuzzy'; readonly tool: string; readonly raw: number; readonly part: number }
  /** best is eligible but another candidate is within the margin — "did you mean", never guess */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[]; readonly raw: number }
  /** best is eligible and unique but is a high-tier tool (D-007) — never auto-executed */
  | { readonly kind: 'blocked-high-tier'; readonly tool: string; readonly raw: number; readonly part: number }
  | { readonly kind: 'none' };

/** Apply the full gate. Float comparisons use an epsilon so `0.2 <= 0.2` holds. */
export function matchName(
  input: string,
  candidates: readonly string[],
  params: MatchParams,
  isHighTier: (tool: string) => boolean = () => false,
): MatchOutcome {
  const EPS = 1e-9;
  const inCanon = canonicalKey(input);
  const exact = candidates.find((c) => canonicalKey(c) === inCanon);
  if (exact !== undefined) return { kind: 'exact', tool: exact };

  const ranked = rankCandidates(input, candidates);
  const best = ranked[0];
  if (!best) return { kind: 'none' };
  // raw 0 = the only defect was separator / case / server-prefix noise (incl. a MANGLED
  // prefix and `/`), i.e. an exact-after-canonicalize match in D-004/D-007's sense: no guess
  // was made, so no threshold and no high-tier gate apply.
  if (best.raw === 0) return { kind: 'exact', tool: best.tool };
  if (best.part > params.T + EPS) return { kind: 'none' };
  // M < 1 would let a raw TIE resolve (a coin flip); a margin is at least one edit.
  const margin = Math.max(1, params.M);
  const crowd = ranked.slice(1).filter((r) => r.raw - best.raw < margin);
  if (crowd.length > 0) return { kind: 'ambiguous', candidates: [best.tool, ...crowd.map((r) => r.tool)], raw: best.raw };
  if (isHighTier(best.tool)) return { kind: 'blocked-high-tier', tool: best.tool, raw: best.raw, part: best.part };
  return { kind: 'fuzzy', tool: best.tool, raw: best.raw, part: best.part };
}
