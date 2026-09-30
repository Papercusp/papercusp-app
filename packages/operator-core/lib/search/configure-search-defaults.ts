/**
 * Papercusp's ENGINE-LEVEL search ranking policy (P-017).
 *
 * This is the one place the domain knowledge lives. `@papercusp/search` holds
 * the mechanism (`configureSearchDefaults`) and no thresholds; this module
 * supplies the thresholds and no mechanism.
 *
 * WHY THIS EXISTS — measured 2026-08-03 across the 8 real `runHybridSearch`
 * call sites in this repo: exactly ONE passed `minScore` and ONE passed
 * `recency`. Every ranking feature the engine grew had landed as an optional
 * per-call field, so it reached the single surface whose bug prompted it and
 * had to be hand-propagated everywhere else — which never happened. The
 * embedding floor is the expensive case: on a sparsely-embedded corpus the
 * vector leg returns its k nearest rows whether or not any of them is a
 * match, and RRF then hands rank-1 noise the same weight as a rank-1 real
 * hit. Six surfaces had no floor at all.
 *
 * Registering here flips that default: a surface inherits the floor by
 * existing, and opts OUT explicitly (`minScore: false`) if it must.
 */

import { configureSearchDefaults, type SearchDefaultsContext } from '@papercusp/search';
// ⚠ The LEAF registry, never `agent-tools/search/embedder` — which re-exports
// `embedderModeOf` from here and is therefore a drop-in-looking import that
// silently re-arms the exact coupling the registry was extracted to break.
// `embedder.ts` statically reaches `memory/configure.ts`, which opens a PG
// connection AT IMPORT; because this module self-installs on import, every
// `runHybridSearch` caller inherited that connection just by installing the
// ranking policy. Measured 2026-08-04: importing `agent-tools/plans/search.ts`
// alone pinned the store identity to the dev cluster within ~3s, which then
// made every plans PG-fixture integration test observe a WRONG STORE. Guard:
// `configure-search-defaults-import-purity.test.ts`.
import { embedderModeOf, embedderProvenanceOf } from './embedder-mode-registry';
import { proseMinScoreFloors } from './prose-min-score';

/**
 * Resolve the floors for one search from the EMBEDDER IT WILL USE.
 *
 * The safety property that makes a global default sound: a cosine floor is
 * only meaningful in the space it was measured in, so this keys off the
 * embedder instance rather than assuming every search runs in the prose
 * space. `embedderModeOf` returns `undefined` for an embedder this host did
 * not build — a caller's own, or one from another space — and
 * `proseMinScoreFloors(undefined)` is `undefined`, i.e. FLOOR NOTHING.
 *
 * So the failure mode is "a surface keeps today's unfloored behavior", never
 * "a surface silently has a foreign space's threshold applied to it". That
 * asymmetry is deliberate: an over-applied floor deletes real hits and is
 * near-invisible, while a missing floor is what we already had.
 */
function minScore(ctx: SearchDefaultsContext) {
  // A fulltext-only search has no vector leg, so there is no embedding floor
  // to resolve. The lexical floor is deliberately undefined (see
  // prose-min-score.ts: no one has measured a ts_rank_cd distribution here,
  // and an invented lexical floor would delete real hits for no evidenced
  // gain), so this is an early-out for clarity, not a behavior change.
  if (ctx.mode === 'fulltext') return undefined;
  return proseMinScoreFloors(embedderModeOf(ctx.embedder));
}

function embeddingProfile(ctx: SearchDefaultsContext) {
  if (ctx.mode === 'fulltext') return undefined;
  const provenance = embedderProvenanceOf(ctx.embedder);
  if (!provenance?.profileId) return undefined;
  return { profileId: provenance.profileId, legacyMode: provenance.mode };
}

let installed = false;

/**
 * Install the ranking policy. Idempotent — safe to call from more than one
 * boot path (the operator host, the bg-host, a test harness) without the
 * second call meaning something different from the first.
 *
 * NOTE recency is deliberately NOT registered as a global default. It is not
 * a correctness floor but a per-surface product judgement: "prefer recent" is
 * right for a transcript/session search and wrong for a code-recipe or docs
 * lookup, where the best answer is often the oldest stable one. Registering
 * one globally would be inventing a policy nobody measured — the exact
 * mistake this module exists to make unnecessary. The seam takes it the day
 * someone measures it; until then those two surfaces pass it explicitly.
 */
export function installSearchDefaults(): void {
  if (installed) return;
  installed = true;
  configureSearchDefaults({ minScore, embeddingProfile });
}

/** Test seam: forget that the policy was installed. */
export function _resetInstalledForTests(): void {
  installed = false;
}

// Self-install on import, mirroring the `configureLexicon` / `configureMemory`
// bindings: the policy must be in force before any search runs, and a policy
// that depends on someone remembering to call a boot hook is the same
// hand-propagation failure P-017 exists to remove — it would just move the
// omission from 8 call sites to N process entry points, where it is HARDER to
// notice (a missed boot path degrades silently to today's unfloored search).
// `lib/agent-tools/search/sources.ts` imports this for its side effect, so
// every surface that uses the shared prose sources is covered by construction.
installSearchDefaults();
