/**
 * freshness/stamp — the WRITE half of the declared-dependency axis
 * (agent-protocol-authority-semantics-2026-07-26 P-007, D-013).
 *
 * `computeFreshness` ({@link ./index}) is the READ half: given stamps + current
 * tokens, it returns a verdict. This is the other side — given what an author
 * DECLARED, resolve each dep to a version token and produce the payload to store.
 *
 * ## Why this is its own module rather than living at a call site
 *
 * It was inline in `work-item-checkpoint.ts` while that was the only carry-note
 * surface with a freshness axis. The loop carry-note is the second (EI-19470389781357111),
 * and the two surfaces sit on the SAME substrate (`harness_shared.carry_notes`,
 * whose `deps` column is scope-agnostic), so a second copy would have been two
 * implementations of one contract diverging over exactly the subtleties that are
 * easy to get wrong and silent when wrong:
 *
 *   - an unresolvable dep must be DROPPED, never stamped — stamping it makes it
 *     read as CHANGED the moment it first resolves, a manufactured false stale;
 *   - nothing stampable must CLEAR rather than preserve the prior note's stamps,
 *     or this note gets judged by the PREVIOUS note's dependency set (a false fresh);
 *   - `recomputed` is decided against the UNION of old and new deps, so the verdict
 *     is computed against real tokens even when the dep set itself changed.
 *
 * Each of those is a wrong-in-the-trusting-direction failure: they make a note
 * read as MORE trustworthy than it is, which is the one error class the freshness
 * axis exists to remove.
 *
 * ## Not in `./index`, deliberately
 *
 * {@link ./index} is import-free BY DESIGN so its eventual move to
 * `libs/generic/*` stays mechanical. This file needs the resolvers (which touch
 * pg + the filesystem), so it lives beside it instead of inside it. Callers own
 * their own scoped read of the prior deps — `priorDeps` is a parameter, not a
 * lookup — because the two surfaces resolve their rows differently: the work-item
 * checkpoint reads one workspace, while the loop note takes the NEWEST row across
 * all workspaces with the pinned coord workspace only as a tie-break.
 */
import {
  DECLARED_DEPS_VERSION,
  computeFreshness,
  shouldMarkRecomputed,
  type DeclaredDeps,
  type DepStamp,
} from './index';
import {
  describeUnresolvedFileDep,
  normalizeDep,
  resolveCurrentTokens,
  splitDep,
  validateDep,
} from './resolvers';

export interface StampDeclaredDepsInput {
  /** What the author declared, as raw `kind:ref` tags. `[]` is an explicit clear. */
  declared: readonly string[];
  /**
   * The stamps currently stored for this note, or null when it declared nothing.
   *
   * Accepts a THUNK so an explicit clear (`declared: []`) costs no read: that path
   * returns before the prior deps are ever needed, and the callers' reads are real
   * database round-trips on a write path. Passing a plain value is equivalent for
   * callers that already hold it.
   */
  priorDeps: DeclaredDeps | null | (() => Promise<DeclaredDeps | null>);
  /** Concrete workspace id used to resolve `work-item:` / `plan:` refs. */
  workspaceId: string;
  /** Harness scope for resolution, and for the sibling-checkout probe on `file:` refs. */
  harness: string | null;
  /** Stamp instant; defaults to now. Injectable so tests need no clock control. */
  now?: number;
}

export interface StampDeclaredDepsResult {
  /**
   * The payload to store: `null` means CLEAR (either an explicit `[]`, or nothing
   * in the declaration could be resolved). A reader treats `null` as `undeclared`
   * and falls back to the time heuristics — an honest "we don't know" rather than
   * a confident wrong answer.
   */
  payload: DeclaredDeps | null;
  /** Per-dep author-facing complaints: invalid tags, and refs that would not resolve. */
  warnings: string[];
  /** True only when `recomputed` actually landed on a stored payload. */
  recomputed: boolean;
}

/**
 * Resolve a declared dependency set to stamped version tokens.
 *
 * Pure with respect to storage: it reads the world (to resolve tokens) but writes
 * nothing. The caller stamps `payload` onto its own row inside whatever
 * transaction it already holds, so the stamp records the world as it was when the
 * note was authored.
 */
export async function stampDeclaredDeps(input: StampDeclaredDepsInput): Promise<StampDeclaredDepsResult> {
  // Agents routinely have the work-item id already in hand and pass `WI-123`
  // instead of the typed `work-item:WI-123` form. Normalize recognized ids before
  // validation/resolution so the note records the dependency rather than accepting
  // it and silently dropping its freshness edge.
  const declared = [...new Set(input.declared.map(normalizeDep))];
  if (declared.length === 0) {
    // Explicit clear — returns BEFORE resolving `priorDeps`, which is what keeps a
    // clear from paying for a read it cannot use.
    return { payload: null, warnings: [], recomputed: false };
  }

  const priorDeps = typeof input.priorDeps === 'function' ? await input.priorDeps() : input.priorDeps;
  // Resolve the UNION of prior and declared so the prior note's verdict (which
  // decides `recomputed`) is computed against real tokens even when the dep set
  // changed out from under it.
  const union = [...new Set([...declared, ...(priorDeps?.stamps.map((s) => s.dep) ?? [])])];
  const tokens = await resolveCurrentTokens(union, {
    workspaceId: input.workspaceId,
    harness: input.harness,
  });
  let recomputed = shouldMarkRecomputed(
    priorDeps ? computeFreshness({ deps: priorDeps, currentTokens: tokens }).verdict : null,
  );

  const now = input.now ?? Date.now();
  const stamps: DepStamp[] = [];
  const warnings: string[] = [];
  for (const dep of declared) {
    const invalid = validateDep(dep);
    if (invalid) {
      warnings.push(invalid);
      continue;
    }
    const token = tokens.get(dep);
    if (token == null) {
      // Stamping an unresolvable dep would make it read as CHANGED the moment it
      // first resolves — a manufactured false stale. Drop it and say so.
      // EI-22169368425533789: for a `file:` ref, "unresolvable" is ALSO the
      // signature of an accurate citation into a sibling checkout in this
      // multi-repo workspace — probe for that before reporting a dead end.
      const parts = splitDep(dep);
      warnings.push(
        parts?.kind === 'file'
          ? describeUnresolvedFileDep(dep, { harness: input.harness })
          : `"${dep}" could not be resolved right now and was not stamped`,
      );
      continue;
    }
    stamps.push({ dep, token, at: now });
  }

  // Nothing stampable ⇒ CLEAR (null), deliberately, rather than preserving the
  // prior note's stamps. Preserving them would judge THIS note by the PREVIOUS
  // note's dependency set, which can read `fresh` for a note whose own declaration
  // wholly failed — a false fresh. `null` yields `undeclared`, which routes readers
  // to the time heuristics, and `warnings` tells the author to fix the refs.
  const payload: DeclaredDeps | null =
    stamps.length > 0 ? { v: DECLARED_DEPS_VERSION, stamps, ...(recomputed ? { recomputed: true } : {}) } : null;
  // Only claim `recomputed` if it actually landed on a stored payload.
  if (payload === null) recomputed = false;

  return { payload, warnings, recomputed };
}
