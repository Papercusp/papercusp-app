/**
 * @papercusp/ranked-selection — pick an ordered menu from a ranked candidate
 * list under a NAMED bounds policy.
 *
 * The algorithm is small and the reason it is a library is not code volume, it
 * is that several call sites must agree on it. Two behaviours are load-bearing:
 *
 *  1. **Qualified-first, then a bounded fill.** Candidates that cleared the
 *     caller's qualification floor are taken best-first up to `max`. Only if
 *     that yields fewer than `min` does the selector reach into the full ranked
 *     pool — and it fills to `min`, never to `max`. Filling to `max` would
 *     silently convert a cap into a quota and pull unqualified candidates in
 *     whenever the qualified pool merely ran short.
 *
 *  2. **A fill pick is LABELLED, never blended.** Every result carries
 *     `via: 'floor' | 'minimum'`. A caller that cannot tell a qualified pick
 *     from a below-floor fill will eventually treat the two as equivalent
 *     evidence; keeping the label on the record is what lets a downstream
 *     consumer refuse to let a fill outrank a qualified pick (see `outranks`).
 *
 * The policy registry exists so that call sites which are supposed to share a
 * setting actually read the SAME value at runtime, instead of each hard-coding
 * its own copy and drifting. Register bounds once at host startup; read them by
 * key at each call site.
 *
 * Zero I/O and zero domain coupling: the candidate type is a type parameter and
 * the only thing this module requires of a candidate is a stable identity, which
 * the caller projects.
 */
import { pinModuleState } from '@papercusp/module-singleton';

/**
 * How a candidate entered the selected set.
 *
 * `'floor'` — cleared the caller's qualification floor.
 * `'minimum'` — did NOT clear it, and was taken as best-available to honour
 * `min`. Labelled so it can never be mistaken for a qualified pick.
 */
export type SelectionVia = 'floor' | 'minimum';

/** Inclusive bounds on a selected menu. `min` is clamped into `[0, max]`. */
export interface SelectionBounds {
  /**
   * Select at least this many even when the qualification floor filters
   * everyone out. 0 restores pure floor selection (no fill at all).
   */
  min: number;
  /** Hard cap on the selected menu. */
  max: number;
}

export interface Selected<C> {
  candidate: C;
  via: SelectionVia;
}

export interface SelectRankedParams<C> {
  /** Candidates that cleared the qualification floor, best first. */
  qualified: readonly C[];
  /**
   * ALL ranked candidates, best first — the fill pool. Expected to be a
   * superset of `qualified`; anything already picked is skipped by identity, so
   * passing the same list twice is harmless.
   */
  allCandidates: readonly C[];
  /** The bounds to select under — usually `selectionPolicy('<key>')`. */
  bounds: SelectionBounds;
  /** Stable identity used to de-duplicate across the two pools. */
  identity: (candidate: C) => string;
  /**
   * Caller-owned selectability gate (e.g. "is this candidate reachable?").
   * A candidate failing it is skipped for BOTH qualified picks and fills, so a
   * minimum that can only be filled by an unselectable candidate stays
   * UNFILLED. An honest short menu beats an unusable pick.
   */
  isSelectable?: (candidate: C) => boolean;
}

/**
 * Deterministic and pure. Returns the ordered menu — never a parallel-wake set;
 * how the menu is delivered is the caller's concern.
 */
export function selectRanked<C>(params: SelectRankedParams<C>): Array<Selected<C>> {
  const selectable = params.isSelectable ?? ((): boolean => true);
  const max = Math.max(0, Math.floor(params.bounds.max));
  const min = Math.min(Math.max(0, Math.floor(params.bounds.min)), max);

  const picked: Array<Selected<C>> = [];
  const seen = new Set<string>();

  for (const candidate of params.qualified) {
    if (picked.length >= max) break;
    const id = params.identity(candidate);
    if (seen.has(id) || !selectable(candidate)) continue;
    picked.push({ candidate, via: 'floor' });
    seen.add(id);
  }

  // Fill to `min`, deliberately NOT to `max` — see the header note.
  if (picked.length < min) {
    for (const candidate of params.allCandidates) {
      if (picked.length >= min) break;
      const id = params.identity(candidate);
      if (seen.has(id) || !selectable(candidate)) continue;
      picked.push({ candidate, via: 'minimum' });
      seen.add(id);
    }
  }

  return picked;
}

/**
 * Authority comparison between two selection provenances.
 *
 * A floor pick outranks a minimum-fill pick; anything else is a tie. This is
 * the generic kernel of "a below-floor participant must not silently supersede
 * a qualified one" — a rule that only exists because `via` is on the record.
 * Returns true when `a` strictly outranks `b`.
 */
export function outranks(a: SelectionVia, b: SelectionVia): boolean {
  return a === 'floor' && b === 'minimum';
}

/** Every distinct `via` present in a selection, in first-seen order. */
export function selectionProvenance<C>(selected: ReadonlyArray<Selected<C>>): SelectionVia[] {
  const out: SelectionVia[] = [];
  for (const s of selected) if (!out.includes(s.via)) out.push(s.via);
  return out;
}

// ── policy registry ────────────────────────────────────────────────────────
// Pinned through @papercusp/module-singleton rather than a bare module-scoped
// Map: several loader seams (a bundled copy beside source, a bare-specifier and
// relative-path import of the same file, a symlinked node_modules entry) each
// produce their own module record, and a split registry answers reads from one
// record with writes made to another. Nothing throws — the caller just sees a
// policy it registered come back missing. Never hand-roll the Symbol.for pair:
// a hand-rolled key is invisible to listModuleDuplications().
const state = pinModuleState('@papercusp/ranked-selection.policies', () => ({
  policies: new Map<string, SelectionBounds>(),
}));

export class UnknownSelectionPolicyError extends Error {
  readonly key: string;
  readonly known: string[];
  constructor(key: string, known: string[]) {
    super(
      `no selection policy registered under '${key}'` +
        (known.length ? ` — registered: ${known.join(', ')}` : ' — no policies are registered at all') +
        '. Call configureSelectionPolicies() during host startup before selecting.',
    );
    this.name = 'UnknownSelectionPolicyError';
    this.key = key;
    this.known = known;
  }
}

function assertValidBounds(key: string, bounds: SelectionBounds): void {
  if (!Number.isFinite(bounds.min) || !Number.isFinite(bounds.max)) {
    throw new TypeError(`selection policy '${key}' must have finite min/max`);
  }
  if (bounds.min < 0 || bounds.max < 0) {
    throw new RangeError(`selection policy '${key}' must not be negative`);
  }
  if (bounds.min > bounds.max) {
    throw new RangeError(
      `selection policy '${key}' has min ${bounds.min} > max ${bounds.max} — ` +
        'a minimum that exceeds the cap can never be honoured',
    );
  }
}

/**
 * Host seam. Registers (or replaces) named bounds. Call it once at startup with
 * the full set; later calls merge, so a test can override one key without
 * clearing the rest.
 */
export function configureSelectionPolicies(policies: Readonly<Record<string, SelectionBounds>>): void {
  for (const [key, bounds] of Object.entries(policies)) {
    assertValidBounds(key, bounds);
    state.policies.set(key, { min: bounds.min, max: bounds.max });
  }
}

/**
 * Read a registered policy. Throws when the key is unknown — deliberately, and
 * deliberately not a silent default: a missing policy that quietly resolved to
 * some built-in would reintroduce exactly the per-call-site drift this registry
 * exists to remove, while looking like it was working.
 */
export function selectionPolicy(key: string): SelectionBounds {
  const found = state.policies.get(key);
  if (!found) throw new UnknownSelectionPolicyError(key, [...state.policies.keys()].sort());
  return { min: found.min, max: found.max };
}

/** Whether a policy is registered, without throwing. */
export function hasSelectionPolicy(key: string): boolean {
  return state.policies.has(key);
}

/** Every registered policy, for diagnostics and startup assertions. */
export function listSelectionPolicies(): Record<string, SelectionBounds> {
  return Object.fromEntries([...state.policies.entries()].map(([k, v]) => [k, { min: v.min, max: v.max }]));
}

/** Test-only: drop all registered policies. */
export function resetSelectionPolicies(): void {
  state.policies.clear();
}
