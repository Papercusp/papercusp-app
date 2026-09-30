/**
 * EI-19455334047866968: a work-item id written into a comment / completion is never
 * checked for existence, so a PHANTOM ref reads identically to a real one.
 *
 * This is the REF-shaped sibling of `unresolvedPathsInCompletion` (complete.ts,
 * EI-20093150500083378). Same defect in a different field, so deliberately the same
 * shape: detect what the caller asserted, resolve it, warn — advisory, fail-open,
 * never blocking. One validator class, two field types.
 *
 * ## Why prose care does not bind this
 *
 * Measured twice in ~20 minutes by ONE agent (su-de6e9643, 2026-08-03), the second
 * time AFTER it had explicitly drawn the lesson from the first:
 *   - comment on EI-19447204017443244 said "Filed as EI-19453856572431492";
 *     the real filing was EI-19454705610327667.
 *   - completion on EI-19453451501516567 said "Filed separately as
 *     EI-19455206485565591"; the real filing was EI-19455262557905604.
 *
 * The mechanism is structural, not a lapse of care: the referencing sentence is
 * composed in the SAME step as the call that MINTS the id. `improvements:capture` /
 * `work_items:create` return the id, but the sentence citing it is already written by
 * then. Resolve-harder demonstrably does not fix it; a mechanical check does.
 *
 * ## Why it is worth catching
 *
 * A phantom `EI-`/`WI-` id is indistinguishable from a real one to every later reader
 * — same shape, same confidence — and it appears in exactly the high-trust surfaces
 * (completion evidence, correction notes, handoff comments) successors are told to
 * rely on WITHOUT re-checking. The failure is silent: a reader follows the pointer,
 * finds nothing, and cannot tell whether the item was deleted, lives in another
 * harness, or never existed at all. Cross-references are the ledger's connective
 * tissue and this rots them invisibly.
 *
 * ## Reuse: BOTH halves already existed
 *
 * `detectBodyRefs` (ref-hydrate.ts) is the SAME parse the hydration path uses — so a
 * ref this warns about is exactly a ref that would have failed to hydrate, and the two
 * can never drift into disagreeing about what counts as a ref. It is pure and
 * import-free, so importing it pulls in no DB/flags graph.
 *
 * Resolution goes through `getWorkItem` via a DYNAMIC import (the
 * `bodyRefWorkItemResolver` precedent): several suites that consume the write verbs
 * partial-mock `@papercusp/flags/server`, and a new STATIC store chain re-arms that
 * trap (EI-9727 / EI-13504). Consumers that already import `getWorkItem` may inject it
 * directly and skip the dynamic hop entirely.
 *
 * ## What `not_found` may honestly claim — the subtlety that shapes the wording
 *
 * `getWorkItem(id)` resolves the issue family UNSCOPED and the feature family scoped
 * to the active workspace. `EI-<snowflake>` ids are globally unique, so non-resolution
 * is trustworthy. `WI-<n>` ids are NOT globally unique — D-008 (migration
 * 142-work-items-unify.sql) mints them from `harness_shared.work_item_seq`, a
 * PER-DATABASE sequence starting at 1, so WI-1/WI-2/WI-3 exist in every long-lived
 * store. A `WI-<n>` that does not resolve HERE may well exist elsewhere.
 *
 * Hence the warning says "does not resolve in this workspace" and never "does not
 * exist": the former is what was actually measured, the latter is a claim this check
 * is not entitled to make. (F- ids are excluded upstream by `detectBodyRefs` as too
 * collision-prone in prose, which also keeps them out of this warning.)
 *
 * ## Fail-open, at every step
 *
 * A legitimately-unresolvable ref exists — another harness, a federated peer, an item
 * since hard-deleted, or a body deliberately QUOTING a phantom id (a retraction
 * documenting a miscitation is the ironic case, and this will flag it). Refusing the
 * write would be far worse than the defect it prevents, so this can only ever nudge.
 * A resolver that THROWS is treated as "cannot judge" and stays silent — only a clean
 * "resolved to nothing" is ever reported. That distinction is the whole safety margin:
 * a PG hiccup must never manufacture a phantom-ref accusation.
 */
import { detectBodyRefs, type HydratableRef } from '../coordination/ref-hydrate';

/**
 * Bounds the work: a pathological body must never turn a comment into N round-trips.
 * Well above the ~1-3 refs a real body carries, low enough to stay a rounding error.
 */
export const MAX_REFS_PROBED = 12;

/** Resolve a work-item id → truthy when it exists. Injectable so this is unit-testable
 *  without a DB, and so a consumer holding `getWorkItem` already can skip the dynamic
 *  import. MUST reject/throw (not return null) when it cannot judge — see below. */
export type WorkItemRefProbe = (id: string) => Promise<unknown>;

/** The real probe: dynamically imported so this module adds no static store chain to
 *  whichever write verb imports it (EI-9727 / EI-13504 flags/server partial-mock trap). */
const defaultProbe: WorkItemRefProbe = async (id) => {
  const { getWorkItem } = await import('../../work-items');
  return getWorkItem(id);
};

export interface UnresolvedRefsOptions {
  /** Injectable resolution seam (default: dynamic `getWorkItem`). */
  probe?: WorkItemRefProbe;
  /** Ids to treat as resolved without probing — e.g. the item being written to, which
   *  the caller has already loaded. Case-insensitive. */
  known?: readonly string[];
  /** Cap on refs probed (default {@link MAX_REFS_PROBED}). */
  max?: number;
}

/**
 * Find work-item refs in `text` that resolve to nothing.
 *
 * Returns `undefined` when there is nothing to say — no refs, all resolved, or the
 * probe could not judge. Never throws: a failure to check is silence, never a warning.
 */
export async function unresolvedRefsInBody(
  text: string | null | undefined,
  opts: UnresolvedRefsOptions = {},
): Promise<{ missing: string[] } | undefined> {
  const body = (text ?? '').trim();
  if (!body) return undefined;

  const max = Math.max(0, opts.max ?? MAX_REFS_PROBED);
  if (max === 0) return undefined;

  // The SAME detection the hydration path uses — never a second, drifting parser.
  let refs: HydratableRef[];
  try {
    refs = detectBodyRefs(body, max);
  } catch {
    return undefined; // cannot judge → say nothing
  }
  if (!refs.length) return undefined;

  const probe = opts.probe ?? defaultProbe;
  const known = new Set((opts.known ?? []).map((k) => (k ?? '').trim().toUpperCase()).filter(Boolean));

  const ids = refs
    .filter((r): r is Extract<HydratableRef, { kind: 'work-item' }> => r.kind === 'work-item')
    .map((r) => r.id)
    .filter((id) => !known.has(id.toUpperCase()));
  if (!ids.length) return undefined;

  const verdicts = await Promise.all(
    ids.map(async (id) => {
      try {
        const found = await probe(id);
        // A CLEAN null is the only thing that earns a warning. A throw means the store
        // could not answer, which is emphatically not evidence the ref is phantom.
        return { id, judged: true, resolved: Boolean(found) };
      } catch {
        return { id, judged: false, resolved: false };
      }
    }),
  );

  // `known` ids are already resolved by the caller (for example, the item whose
  // checkpoint is being written), so include exact known refs found in this body
  // in the prefix fence too. Otherwise a body containing the known full id and a
  // human-readable shorthand probes only the shorthand and falsely warns about it.
  const knownResolvedIds = refs
    .filter((r): r is Extract<HydratableRef, { kind: 'work-item' }> => r.kind === 'work-item')
    .map((r) => r.id)
    .filter((id) => known.has(id.toUpperCase()))
    .map((id) => id.toUpperCase());
  const resolvedIds = [
    ...knownResolvedIds,
    ...verdicts
      .filter((v) => v.judged && v.resolved)
      .map((v) => v.id.toUpperCase()),
  ];
  const missing = verdicts
    .filter((v) => v.judged && !v.resolved)
    .map((v) => v.id)
    // Agents often write a human-readable shorthand after the exact id returned by a
    // create call. Suppress that shorthand only when exactly one longer, resolvable ref
    // in this same body has the prefix; multiple candidates remain an honest warning.
    .filter((id) => {
      const upper = id.toUpperCase();
      const longerMatches = resolvedIds.filter(
        (resolvedId) => resolvedId.length > upper.length && resolvedId.startsWith(upper),
      );
      return longerMatches.length !== 1;
    });
  return missing.length > 0 ? { missing } : undefined;
}

/**
 * The advisory sentence attached to a write whose body cites refs that resolve to
 * nothing. Phrased to be IGNORABLE — the legitimate causes are named up front — and to
 * say "does not resolve in this workspace" rather than "does not exist", which is the
 * only claim the resolution above actually supports (see the WI-/EI- note in the module
 * docstring).
 */
export function unresolvedRefsWarning(subjectId: string, missing: readonly string[]): string {
  const plural = missing.length === 1 ? 'a work-item ref that does' : `${missing.length} work-item refs that do`;
  return (
    `the text written to ${subjectId} cites ${plural} NOT resolve in this workspace: ${missing.join(', ')}. ` +
    `The write is RECORDED and this changes nothing about it. But a phantom id is indistinguishable from a real ` +
    `one to every later reader, and it lands in exactly the surfaces successors trust without re-checking — a ` +
    `reader who follows it cannot tell whether the item was deleted, lives in another harness, or never existed. ` +
    `Measured 2026-08-03: one agent miscited a freshly-minted id twice in 20 minutes, the second time after ` +
    `explicitly drawing the lesson from the first — the citing sentence is composed in the same step that mints ` +
    `the id, so care does not bind it. If these refs are federated, from another harness, deliberately quoted as ` +
    `phantoms, or are illustrative slash-separated id shapes in prose, ignore this advisory. Otherwise re-read ` +
    `the id off the call that returned it and post a correction.`
  );
}
