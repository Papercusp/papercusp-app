/**
 * cell-suggest.ts — AFTERCARE FOR A READ THAT FOUND NOTHING, and the `self`
 * subject shorthand. P-002 + P-003 of state-plane-interest-and-hardening-2026-08-21.
 *
 * ── WHY AN ABSENT READ NEEDS AFTERCARE ──────────────────────────────────────
 *
 * `absent` is deliberately a dead end for INFORMATION (P-019: unregistered and
 * out-of-audience must stay indistinguishable, or the refusal becomes an oracle
 * for enumerating narrow cells). It is not, and should not be, a dead end for
 * NAVIGATION. The measured evidence that these are different problems: over the
 * plane's first two weeks agents spent reads guessing at names that do not exist
 * — `host.load` (2 callers), `release.gate`, a bare `gate.greenCheckpoint`,
 * `gate.greenCheckpoint.noSuchCellZZQQ` — each a well-formed call answered with
 * a correct, unhelpful refusal.
 *
 * ⚠ THE ONE RULE THAT MAKES THIS SAFE: suggestions are drawn ONLY from the
 * caller's OWN audience-filtered directory (`listCells(reader)`), never from
 * `listCellsUnchecked`. A near-miss over the full registry would leak the
 * existence — and the NAME — of exactly the cells the absent verdict exists to
 * hide, which is strictly worse than the friction it fixes.
 *
 * ── AND WHY SOME MISSES ARE NOT NEAR-MISSES AT ALL ──────────────────────────
 *
 * `host.load` is not a mistyped cell; it is a field the caller ALREADY HAS in
 * their orient payload. Fuzzy matching would answer it with the nearest cell
 * name, which is a confidently wrong redirect. So known non-cells get an
 * explicit, hand-declared answer that names the real surface — and the table is
 * pinned by a test asserting each key is NOT a registered cell, so an entry that
 * later becomes a real cell fails the suite instead of silently shadowing it.
 */

import type { CellSpec } from './cell-registry';

/**
 * Values agents demonstrably ask this door for that are NOT cells and never
 * should be — each with the surface that actually answers it. Keys are matched
 * case-insensitively.
 */
const NON_CELL_REDIRECTS: ReadonlyMap<string, string> = new Map([
  ['host.load', 'the host load average is already in your coord:orient payload as `host.load` — call nothing.'],
  ['host.cores', 'core count is already in your coord:orient payload as `host.cores` — call nothing.'],
  ['host.now', 'the current time is already in your coord:orient payload as `host.now` (ISO-8601 UTC) — call nothing.'],
  ['host.memfreepct', 'free-memory percentage is in your coord:orient payload as `host.memFreePct`; the PRESSURE verdict is the cell `host.memoryPressure`.'],
  ['release.gate', 'the gate verdict is the cell `gate.greenCheckpoint.verdict`; "is my change live, and what is blocking it" is dev:pipeline_position { path }.'],
  ['gate.greencheckpoint', 'that is a cell NAMESPACE, not a cell — the leaves are gate.greenCheckpoint.verdict (is it red), .candidate (which sha is judged, per-path via `as`), and .ownership (who owns the red).'],
  ['deploy.sha', 'the deployed sha is the cell `deploy.3070.sha`.'],
]);

/** Normalised token set for the similarity leg — dots and case carry no meaning
 *  in a cell id guess ("gate greenCheckpoint" and "gate.greencheckpoint" are the
 *  same intent). */
function tokens(id: string): string[] {
  return id
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Similarity for a name GUESS: shared-token overlap (Jaccard), plus credit for a
 * substring relationship, which is how the observed misses actually failed —
 * `gate.greenCheckpoint` is a strict prefix of three real cells, and a pure token
 * metric already ranks those highly. Deliberately simple and dependency-free: the
 * job is ordering a handful of candidates, not scoring a corpus.
 */
export function cellNameSimilarity(guess: string, candidate: string): number {
  const g = tokens(guess);
  const c = tokens(candidate);
  if (g.length === 0 || c.length === 0) return 0;
  const gs = new Set(g);
  const cs = new Set(c);
  let shared = 0;
  for (const t of gs) if (cs.has(t)) shared += 1;
  const jaccard = shared / (gs.size + cs.size - shared);
  const gl = guess.toLowerCase();
  const cl = candidate.toLowerCase();
  const substring = cl.startsWith(gl) || cl.includes(gl) || gl.includes(cl) ? 0.35 : 0;
  return Math.min(1, jaccard + substring);
}

/** Below this, a "suggestion" is noise — and noise on a refusal channel is how a
 *  channel stops being read (the EI-10949 lesson this plane keeps re-learning). */
const SUGGEST_FLOOR = 0.3;
const SUGGEST_MAX = 3;

export interface AbsentReadAftercare {
  /** Cell ids from the reader's OWN directory, best first. Never out-of-audience. */
  didYouMean?: string[];
  /** A hand-declared answer for a known non-cell — takes precedence over fuzzy hits. */
  notACell?: string;
}

/**
 * Aftercare for an absent read. `visible` MUST be the audience-filtered directory
 * (`listCells(reader)`); passing the unchecked registry would turn this into the
 * enumeration oracle P-019 forbids.
 *
 * Returns an EMPTY object when there is nothing useful to say — a caller then
 * renders the plain refusal rather than an empty "did you mean:" that reads like
 * a broken feature.
 */
export function absentReadAftercare(guess: string, visible: readonly CellSpec[]): AbsentReadAftercare {
  const out: AbsentReadAftercare = {};
  const redirect = NON_CELL_REDIRECTS.get(guess.trim().toLowerCase());
  if (redirect) {
    out.notACell = redirect;
    return out; // A declared answer beats a guessed one; never render both.
  }
  const scored = visible
    .map((s) => ({ cell: s.cell, score: cellNameSimilarity(guess, s.cell) }))
    .filter((r) => r.score >= SUGGEST_FLOOR)
    .sort((a, b) => (b.score - a.score) || a.cell.localeCompare(b.cell))
    .slice(0, SUGGEST_MAX);
  if (scored.length > 0) out.didYouMean = scored.map((r) => r.cell);
  return out;
}

/** Test seam / doc surface: the declared non-cell keys, so a test can assert none
 *  of them is a registered cell. */
export function declaredNonCellKeys(): string[] {
  return [...NON_CELL_REDIRECTS.keys()];
}

/**
 * P-003 — THE `self` SUBJECT SHORTHAND.
 *
 * Every coord tool accepts the literal `"self"` for "me"; the plane did not, so a
 * caller-relative cell keyed on an agent identity required pasting your own uuid.
 * `agent.goal` sits at 14 calls / 2 callers, and that friction is the cheapest
 * available explanation.
 *
 * Applied ONLY when the cell's declared param is an IDENTITY param — resolving
 * `self` for a per-PATH cell would silently answer about a file literally named
 * "self". The param names are matched against the identity set below rather than
 * inferred, for the same reason `callerRelativity` is declared and not inferred:
 * an inference here is wrong in the confident direction.
 *
 * ⚠ NOT an identity override, and it cannot become one: it resolves to the
 * CALLER'S OWN ownerId, and the audience check runs on the caller regardless
 * (see `canReadCell`) — naming a subject never widens what you may see.
 */
const IDENTITY_PARAMS: ReadonlySet<string> = new Set(['ownerid', 'owner_id', 'agentid', 'agent_id', 'sessionowner', 'subjectownerid']);

export function isIdentityParam(param: string): boolean {
  return IDENTITY_PARAMS.has(param.trim().toLowerCase());
}

/**
 * Resolve an `as` argument for one cell. Returns the subject to use — `self`
 * becomes the caller's ownerId for an identity-keyed cell, and every other value
 * (and every non-identity param) passes through untouched.
 */
export function resolveSelfSubject(
  as: string | undefined,
  spec: Pick<CellSpec, 'callerRelativity'>,
  callerOwnerId: string,
): string | undefined {
  if (as === undefined) return undefined;
  if (as.trim().toLowerCase() !== 'self') return as;
  const rel = spec.callerRelativity;
  if (rel.kind !== 'parameter' || !isIdentityParam(rel.param)) return as;
  return callerOwnerId;
}
