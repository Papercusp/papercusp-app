/**
 * build-stamp — stamp a db diagnostic with the BUILD that emitted it.
 *
 * ## Why this exists (EI-19484133375867605)
 *
 * A long-lived host loads its code once and never reloads it. `:3070` serves the
 * green-release checkout; a Tauri desktop's own spawned operator has no file-watch
 * at all. So a deploy fixes the SOURCE while every already-running process keeps
 * emitting the old string — for hours.
 *
 * That makes a corrected error MESSAGE uniquely hard to dedup. For an ordinary bug
 * "does it still reproduce" is checkable by re-running; for an error message the
 * observed string IS the evidence, and the observed string is precisely what
 * changed. The reporter's evidence and the current source therefore disagree, and
 * the natural reading is "the fix didn't work" rather than "I am talking to an old
 * process". Search-first dedup cannot rescue it either: searching the quoted string
 * finds nothing current, because the string no longer exists in the tree.
 *
 * Measured cost: `[connect-phase-deadline]` was corrected at 10479ae8 and deployed,
 * then re-filed as a live defect FOUR times (EI-19448289533526248,
 * EI-19448631268088238, EI-19448665862739845, WI-10613) — the last of them 8h after
 * the fix shipped. Every filing was a legitimate first-hand observation; no reporter
 * did anything wrong. A pasted string simply carried no provenance.
 *
 * With a stamp the pasted text answers the question itself:
 *
 *     [connect-phase-deadline @ 10479ae8] could not obtain a database connection…
 *
 * ## Why a SEAM and not a direct read
 *
 * The build identity is HOST policy, and the only correct source for it in this
 * repo is `packages/operator-core/lib/build-info.ts` — which this package cannot
 * import (db-org sits below operator-core; the dependency runs the other way).
 *
 * Re-reading `PAPERCUSP_BUILD_SHA` here instead would be a second, WRONGER copy of
 * that truth: `getBuildInfo()` deliberately reports `sha: null` for a bundled
 * artifact carrying no baked sha, precisely so a bundle cannot claim the current
 * checkout's HEAD as the bytes it is running. A stamp that lies about which build
 * is talking is worse than no stamp at all — it is the exact failure this file
 * exists to prevent, one level up. So the resolver stays host-registered and there
 * remains exactly ONE policy owner.
 *
 * This is the same split `libs/generic/tooldef/src/server-vintage.ts` already makes
 * (library owns the seam, host owns the policy); it is a separate port only because
 * db-org cannot depend on a tool-definition package without inverting the layering.
 * Both ports are wired from that same `getBuildInfo()`.
 *
 * Default is unregistered, and an unregistered stamp renders the tag EXACTLY as it
 * read before (`[connect-phase-deadline]`), so every existing consumer, log grep and
 * assertion is behaviour-neutral until a host opts in.
 */

import { pinModuleState } from '@papercusp/module-singleton';

/** Returns the emitting process's short build id, or null when it cannot prove one. */
export type BuildStampResolver = () => string | null;

interface BuildStampState {
  resolver: BuildStampResolver | null;
}

// Module-scoped mutable state in a shared package: pinned, never a hand-rolled
// globalThis+Symbol.for pair, so a split module record cannot leave the host's
// registration invisible to the emitting copy (see acquire-registry.ts).
const STATE = pinModuleState<BuildStampState>('@papercusp/db-org.build-stamp', () => ({
  resolver: null,
}));

/**
 * Register the host's build-stamp resolver (last registration wins; null clears).
 *
 * Must be cheap and SYNCHRONOUS — it runs while constructing an error on a path that
 * is already failing, and in the saturated-pool case the database is exactly what is
 * unavailable. A host needing I/O caches out-of-band and reads only the cache, the
 * contract `getBuildInfo()` already keeps.
 */
export function setBuildStampResolver(fn: BuildStampResolver | null): void {
  STATE.resolver = fn;
}

/** Clear the registered resolver — test seam + host teardown. */
export function resetBuildStampResolver(): void {
  STATE.resolver = null;
}

/**
 * The emitting build's short id, or null when no resolver is registered, the host
 * cannot prove its build, or the resolver throws. NEVER lets a broken resolver fail
 * the diagnostic it is only trying to annotate.
 */
export function readBuildStamp(): string | null {
  const fn = STATE.resolver;
  if (!fn) return null;
  let raw: string | null;
  try {
    raw = fn();
  } catch {
    return null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

/**
 * Render a diagnostic's leading tag, stamped when the host knows its build:
 * `[connect-phase-deadline @ 10479ae8]`, else the bare `[connect-phase-deadline]`.
 *
 * Pass the tag WITHOUT brackets; this owns the bracketing so the stamp can never
 * land outside them, which is what keeps the tag greppable as one token.
 */
export function stampedTag(tag: string): string {
  const stamp = readBuildStamp();
  return stamp ? `[${tag} @ ${stamp}]` : `[${tag}]`;
}
