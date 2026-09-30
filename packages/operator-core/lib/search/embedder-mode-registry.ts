/**
 * embedder-mode-registry — which embedding SPACE a given embedder instance
 * ranks in (P-017 / D-021's safety property).
 *
 * A cosine floor is meaningless outside the space it was measured in, so the
 * ranking policy keys off the embedder INSTANCE rather than a mode string each
 * caller has to plumb. `agent-tools/search/embedder.ts` stamps every embedder
 * it builds into the WeakMap below; `search/configure-search-defaults.ts`
 * reads it back. An embedder this host did not build simply MISSES and gets no
 * floor — the failure direction is "keeps today's unfloored behaviour", never
 * "a foreign space's threshold silently deletes real hits".
 *
 * ─── WHY THIS IS ITS OWN LEAF MODULE ───────────────────────────────────────
 * It used to live inside `agent-tools/search/embedder.ts`. That made the
 * ranking policy — imported for its side effect by EVERY `runHybridSearch`
 * caller — statically depend on the whole embedder-resolution stack, whose
 * chain reaches `memory/configure.ts`, and that module performs FIRE-AND-
 * FORGET PG I/O at module scope (`void initMemoryBackendSelection()`, line
 * ~718). So merely importing the ranking policy opened a database connection
 * at import time.
 *
 * That is not a theoretical tidiness point. Measured 2026-08-04 while
 * migrating plans:search (P-016): the import-time connection PINS the store
 * identity to the dev cluster, so a later testcontainer connection is reported
 * as `[store-identity] 🚨 WRONG STORE` and every PG-fixture integration test on
 * the surface fails — with an error that names a database mismatch and nothing
 * about imports. plans:search had previously reached the embedder only through
 * a DYNAMIC `await import(...)`, which is exactly why it had never surfaced.
 *
 * This module therefore has NO runtime imports — only an erased `import type`.
 * Keep it that way: anything imported here is imported by every search surface
 * in the repo, at load.
 *
 * ⚠ This does NOT fix the import-time I/O itself, which still affects every
 * other importer of `memory/configure.ts` — that is filed separately. It
 * removes the ranking policy from that blast radius, which is correct on its
 * own terms regardless of when the deeper fix lands.
 */

import type { Embedder } from '@papercusp/search';

/** The embedding spaces this host can build a query embedder for. */
export type EmbedderMode = 'openai' | 'local' | 'gemma' | 'harrier';

/** Versioned exact space identity. Kept structurally local so this import-pure
 * leaf never gains a runtime dependency on the memory package. */
export type EmbedderProfileId = `${string}@v${number}`;

/** A WeakMap so a discarded embedder is still collectable. */
const embedderProvenance = new WeakMap<
  Embedder,
  { mode: EmbedderMode; profileId?: EmbedderProfileId }
>();

/**
 * Record the space an embedder ranks in. Called by the ONE embedder factory,
 * on every embedder it hands out, so provenance travels with the instance.
 */
export function stampEmbedderMode(
  embedder: Embedder,
  mode: EmbedderMode,
  profileId?: EmbedderProfileId,
): void {
  embedderProvenance.set(embedder, { mode, profileId });
}

/**
 * The mode of an embedder built by this host, or `undefined` for one it did
 * not build. `undefined` means "unknown space" and callers MUST treat it as
 * "apply nothing space-specific" — never as a default space.
 *
 * ⚠ This is a lookup on the exact function OBJECT. Wrapping an embedder in any
 * closure — a width guard, a timer, a log line — produces a different object,
 * so the lookup misses and the surface silently ranks UNFLOORED while every
 * leg still reports as having run (plan decision D-024). Pass resolved
 * embedders through UNWRAPPED.
 */
export function embedderModeOf(embedder: Embedder | null | undefined): EmbedderMode | undefined {
  return embedder ? embedderProvenance.get(embedder)?.mode : undefined;
}

/** Exact profile id carried by a host-built query embedder. Missing means the
 * instance predates profile-aware provenance or was supplied externally; such
 * an embedder must never be assumed compatible from mode/width alone. */
export function embedderProfileIdOf(
  embedder: Embedder | null | undefined,
): EmbedderProfileId | undefined {
  return embedder ? embedderProvenance.get(embedder)?.profileId : undefined;
}

/** Read both provenance fields atomically so a host can pass the exact profile
 * and its legacy mode alias through one policy resolution. */
export function embedderProvenanceOf(
  embedder: Embedder | null | undefined,
): { mode: EmbedderMode; profileId?: EmbedderProfileId } | undefined {
  return embedder ? embedderProvenance.get(embedder) : undefined;
}
