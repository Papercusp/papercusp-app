/**
 * The bundle-identity COMPARISON, isolated from the code that computes it
 * (EI-15848).
 *
 * WHY ITS OWN FILE, and not a sibling export in `spa-build-status.ts`: that
 * module reads the filesystem, so its top-level imports are `node:fs`,
 * `node:path` and `node:crypto`. `BundleFreshnessNotice` runs in the BROWSER and
 * reaches into this tree through operator-vite's `@` alias, so importing the
 * predicate from there would pull those builtins into the client graph for the
 * sake of one three-line pure function. Splitting the pure half out is the
 * standard fix for that cross-tree alias trap (AGENT-ENV.md), and it keeps the
 * server and the client provably agreeing on one definition of "stale" rather
 * than each carrying its own `!==`.
 */

/**
 * Should the UI offer a reload? True only when BOTH ids are known AND differ.
 *
 * The two null cases are the whole reason this is a named function rather than
 * a `!==` at the call site. `loaded == null` means the page booted from a shell
 * that injected no id (the Vite dev server, which has HMR, or a build predating
 * this feature); `served == null` means the bundle is missing or mid-swap. In
 * both, a bare `loaded !== served` evaluates TRUE while the honest answer is
 * "unknown" — so the notice would fire on every rebuild and on every
 * pre-feature page. That false-positive class is what gets a notice muted, and
 * a muted notice is silent for the one case it was built for.
 */
export function shouldOfferReload(loaded: string | null, served: string | null): boolean {
  if (!loaded || !served) return false;
  return loaded !== served;
}
