/**
 * carry-fact-staleness — embedding staleness-check of carried facts at build
 * time (deterministic-context-carry-2026-07-14 P-026, WI-5001/WI-5141 leg (b)).
 *
 * A carried fact (agent-facts/store.ts) is a deterministic, scoped CONCLUSION
 * folded VERBATIM into every relevant brief until it expires or is retracted —
 * by design the fold never re-verifies the fact against its source. For a
 * fact whose `sourceRef` resolved to a VERIFIED typed ref at ASSERT time
 * (source-provenance-resolve.ts stamped `sourceProvenance.quote`), the
 * SOURCE can drift after the fact was written: the referenced work-item's
 * title/summary/state changes, the coord thread moves on — yet the fact's
 * body keeps shipping unchanged, unaware its premise may have moved.
 *
 * This module is the drift DETECTOR, not a corrector: at carry-build time,
 * re-hydrate the SAME typed ref (agent-tools/coordination/ref-hydrate — the
 * exact machinery used at assert time) to get the CURRENT snippet, embed
 * both the stored (assert-time) quote and the fresh snippet through the
 * shared embedder cascade, and flag a cosine distance over a threshold as
 * `possibly-stale`. This mirrors search/embed-space-self-check.ts's
 * re-embed-and-compare pattern (proven at WI-3644/EI-8913) — applied here to
 * CONTENT drift of a fact's source instead of embedder-space desync.
 *
 * Deliberately conservative about WHAT it checks: only facts with a
 * `sourceProvenance.verified === true` quote AND a re-hydratable ref kind
 * (`work-item` | `msg`) are compared — everything else (free-text anchors,
 * unverified refs, owner-turn quotes with nothing durable to re-fetch,
 * plan-item/gate refs with no installed hydrate resolver) reports `unknown`,
 * never a false `possibly-stale`. Fail-soft by contract, like every carry-brief
 * leg: a hydrate/embed/store failure degrades that ONE fact to `unknown`,
 * never fails the whole check or the brief it feeds.
 *
 * Import discipline: only `parseRefToken` (ref-hydrate.ts is explicitly
 * documented "pure + import-free") is a STATIC value import here. `hydrateRefs`
 * (ref-hydrate-resolve.ts, the IO half — transitively pulls in coord messages /
 * work-items / plans / events, which themselves register top-level flag
 * listeners) and the embedder cascade (embed-backfill.ts /
 * embed-space-self-check.ts — memory/configure, embed-admission,
 * embed-sidecar-wiring) are DYNAMICALLY imported inside the functions that use
 * them. This module is imported STATICALLY by carry-brief.ts, which many
 * narrowly-mocked tests (e.g. compact-reprime.test.ts's `@papercusp/flags/server`
 * stub) also import statically — a static pull of the heavy IO graph here would
 * fatten carry-brief.ts's own import surface and break every one of them at
 * module-evaluation time, not just at call time. Mirrors the SAME dynamic-import
 * discipline compact-reprime.ts already uses for its own carry-brief dependency.
 */
import type { ResolvedEmbedder } from '@papercusp/memory';
import { parseRefToken, type HydratableRef } from './agent-tools/coordination/ref-hydrate';
import type { FactSourceProvenance } from './agent-facts/store';

/** The subset of a carried fact this check needs — callers with only some of
 *  {@link CarryBrief}'s `facts` (or a narrower read) can still run the check.
 *  `sourceRef`/`sourceProvenance` are OPTIONAL (not just nullable) so a
 *  `CarryBrief.facts` entry — where they're optional for back-compat with
 *  every pre-existing `{ key, body }` literal — is assignable as-is. */
export interface FactStalenessInput {
  key: string;
  sourceRef?: string | null;
  sourceProvenance?: FactSourceProvenance | null;
}

export type FactStalenessVerdict = 'fresh' | 'possibly-stale' | 'unknown';

export interface FactStalenessResult {
  key: string;
  verdict: FactStalenessVerdict;
  /** Cosine distance between the assert-time quote and the current snippet —
   *  null when `verdict === 'unknown'` (nothing was compared). */
  distance: number | null;
  /** Why `unknown` (skip reason) or absent for fresh/possibly-stale. */
  reason?: string;
}

/**
 * Looser than embed-space-self-check's 0.05 (DEFAULT_DISTANCE_ALERT_THRESHOLD)
 * on purpose: that check flags embedder IDENTITY drift, where even float noise
 * should land near 0. This flags CONTENT drift — a paraphrase or a minor title
 * tweak is harmless and should NOT alarm; only a materially different snippet
 * (the work-item retitled/resolved differently, the thread moved to a new
 * conclusion) should. 0.15 is a judgment call pending real-world tuning
 * against the P-020 cold-boot drill corpus — adjust here, not per-callsite.
 */
export const DEFAULT_FACT_DRIFT_THRESHOLD = 0.15;

const HYDRATABLE_KINDS = new Set(['work-item', 'msg']);

/** Matches ref-hydrate-resolve.ts's `hydrateRefs` shape without a static import of it. */
export type HydrateRefsFn = (
  refs: HydratableRef[],
  opts?: { budget?: unknown; resolvers?: unknown },
) => Promise<Array<{ ok: boolean; snippet: string; error?: string }>>;

export interface CheckCarriedFactsStalenessDeps {
  hydrateRefsFn?: HydrateRefsFn;
  resolveEmbedderFn?: () => Promise<ResolvedEmbedder>;
  distanceThreshold?: number;
}

/** The real hydrateRefs — dynamically imported so a STATIC import of this module
 *  (carry-brief.ts) never pulls in ref-hydrate-resolve.ts's heavy IO graph. */
async function defaultHydrateRefs(refs: HydratableRef[]) {
  const { hydrateRefs } = await import('./agent-tools/coordination/ref-hydrate-resolve');
  return hydrateRefs(refs);
}

/** The real embedder cascade — dynamically imported for the same reason. */
async function defaultResolveEmbedder(): Promise<ResolvedEmbedder> {
  const { resolveBackfillEmbedder } = await import('./search/embed-backfill');
  return resolveBackfillEmbedder();
}

/** Cosine DISTANCE (1 - cosine similarity) — duplicated from (rather than
 *  imported from) search/embed-space-self-check.ts on purpose: that module's
 *  OTHER exports drag in embed-backfill.ts + agent-tools/coordination/escalations.ts,
 *  and this formula is 8 lines of pure math not worth a heavy static import for.
 *  Keep in sync with embed-space-self-check.ts's `cosineDistance` if either changes. */
function cosineDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** A fact qualifies only with a verified, quoted, re-hydratable-kind provenance stamp. */
function isCheckable(f: FactStalenessInput): boolean {
  const p = f.sourceProvenance;
  return Boolean(p && p.verified && p.quote && HYDRATABLE_KINDS.has(p.kind));
}

/**
 * Check ONE fact. Exported separately from the batch form so a caller with a
 * single fact (e.g. a just-asserted one) doesn't pay for an unused batch loop.
 */
export async function checkFactStaleness(
  fact: FactStalenessInput,
  deps: CheckCarriedFactsStalenessDeps = {},
): Promise<FactStalenessResult> {
  if (!isCheckable(fact)) {
    return { key: fact.key, verdict: 'unknown', distance: null, reason: 'no_verified_quote' };
  }
  let resolved: ResolvedEmbedder;
  try {
    resolved = await (deps.resolveEmbedderFn ?? defaultResolveEmbedder)();
  } catch {
    return { key: fact.key, verdict: 'unknown', distance: null, reason: 'embedder_resolve_failed' };
  }
  if (resolved.mode === 'disabled') {
    return { key: fact.key, verdict: 'unknown', distance: null, reason: 'embedder_disabled' };
  }

  const ref = fact.sourceRef ? parseRefToken(fact.sourceRef) : null;
  if (!ref || (ref.kind !== 'work-item' && ref.kind !== 'msg')) {
    return { key: fact.key, verdict: 'unknown', distance: null, reason: 'unresolvable_ref' };
  }

  const hydrate = deps.hydrateRefsFn ?? defaultHydrateRefs;
  try {
    const [hydrated] = await hydrate([ref]);
    if (!hydrated.ok || !hydrated.snippet) {
      return {
        key: fact.key,
        verdict: 'unknown',
        distance: null,
        reason: hydrated.error ?? 'source_gone',
      };
    }
    const [origVec, currVec] = await Promise.all([
      resolved.embed(fact.sourceProvenance!.quote!),
      resolved.embed(hydrated.snippet),
    ]);
    const distance = cosineDistance(origVec, currVec);
    const threshold = deps.distanceThreshold ?? DEFAULT_FACT_DRIFT_THRESHOLD;
    return { key: fact.key, verdict: distance > threshold ? 'possibly-stale' : 'fresh', distance };
  } catch {
    return { key: fact.key, verdict: 'unknown', distance: null, reason: 'check_failed' };
  }
}

/**
 * Check a batch of carried facts at build time. Resolves the embedder ONCE
 * (skipped entirely when no fact in the batch qualifies — the common case for
 * a facts list with no typed/verified sources) and reuses it across facts;
 * each fact's hydrate+embed pair still runs independently so one bad fact
 * (a deleted work-item, an embed-admission shed) degrades only that fact to
 * `unknown` instead of failing the batch.
 */
export async function checkCarriedFactsStaleness(
  facts: readonly FactStalenessInput[],
  deps: CheckCarriedFactsStalenessDeps = {},
): Promise<FactStalenessResult[]> {
  if (facts.length === 0) return [];
  if (!facts.some(isCheckable)) {
    return facts.map((f) => ({ key: f.key, verdict: 'unknown' as const, distance: null, reason: 'no_verified_quote' }));
  }

  let resolved: ResolvedEmbedder;
  try {
    resolved = await (deps.resolveEmbedderFn ?? defaultResolveEmbedder)();
  } catch {
    return facts.map((f) => ({ key: f.key, verdict: 'unknown' as const, distance: null, reason: 'embedder_resolve_failed' }));
  }
  if (resolved.mode === 'disabled') {
    return facts.map((f) => ({ key: f.key, verdict: 'unknown' as const, distance: null, reason: 'embedder_disabled' }));
  }

  // Reuse the already-resolved embedder for every fact via checkFactStaleness's
  // own injectable dep — one resolve, N checks.
  const resolveEmbedderFn = async () => resolved;
  return Promise.all(facts.map((f) => checkFactStaleness(f, { ...deps, resolveEmbedderFn })));
}

/** Render a compact warning block for the facts flagged `possibly-stale` —
 *  null when nothing is stale (the caller's existing "nothing to inject"
 *  contract, mirroring {@link renderCarryQueryHandlesBlock}). Never lists
 *  `fresh`/`unknown` facts — this is a warning surface, not a status dump. */
export function renderFactsStalenessWarning(results: readonly FactStalenessResult[]): string | null {
  const stale = results.filter((r) => r.verdict === 'possibly-stale');
  if (stale.length === 0) return null;
  const lines = stale.map(
    (r) => `- ${r.key} (source drifted, distance=${r.distance?.toFixed(3) ?? '?'}) — re-verify before relying on it`,
  );
  return `⚠ Possibly-stale carried facts (source content changed since assert time):\n${lines.join('\n')}`;
}
