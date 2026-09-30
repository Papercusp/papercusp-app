// WI-6539 — the dev server's inotify watch set, trimmed to what it actually needs.
//
// MEASURED PROBLEM (2026-07-28). A *cold* operator-vite dev server — 30 seconds
// old, zero requests served — held 11,959 inotify watches against a
// PERF_BUDGETS.inotifyPerProcWarn of 10,000. So this is not drift and not an
// artifact of a long-lived process: any dev server on this tree breaches the
// per-process budget within a second of starting. (The standing 11-day-old
// :3055 server held 12,337 — i.e. eleven days of running added only 378, 3%.)
//
// An inode-join of /proc/<pid>/fdinfo against the repo tree showed what those
// watches were actually on:
//
//     5,194  42.1%  stale `.old.<pid>` docs-swap trees
//     3,566  28.9%  build output under apps/operator-vite/dist/
//     2,341  19.0%  static docs under publicDir (apps/operator/public/internal/docs)
//     1,116   9.0%  REAL SOURCE — the module graph
//       120   1.0%  other publicDir static
//
// 91% of the watch budget was being spent on build output, served-static content
// and pure garbage. None of the three categories can ever produce a meaningful
// dev-server event:
//
//   • `.old.<pid>` trees are swap leftovers from the docs atomic-publish
//     (apps/operator-docs/scripts/postbuild-copy.sh). They are gitignored, never
//     imported, and nothing reads them — the desktop sidecar build already
//     purges them from its own output copy for exactly this reason.
//   • `dist/` is build OUTPUT. The dev server serves modules from source; it has
//     no reason to watch what a build wrote. (Under the chunk-retention regime
//     dist/ only grows, so this term grows with it.)
//   • `public/internal/docs` is the built Starlight/pagefind site — ~3,200
//     .pf_fragment shards plus .md/.html. It is *served*, never imported, and in
//     dev `/internal/docs` is PROXIED to the Hono host (:3070) anyway (see the
//     server.proxy block in vite.config.ts), so the copy under publicDir is not
//     even the one being read. Watching it can only ever trigger a pointless
//     full-reload — and HMR is off by default here regardless.
//
// Ignoring the three leaves the 1,116 module-graph watches: 0.11x budget.
//
// WHY A PREDICATE AND NOT GLOB STRINGS: Vite 8 is chokidar v4, which DROPPED
// glob support in `ignored` — a `'**/dist/**'` string there is matched as a
// literal path and silently never fires. A function is the one form whose
// semantics are unambiguous across the version, and it is directly unit-testable.

/** Absolute path of the operator-vite package root (the Vite `root`). */
export interface WatchIgnoreDirs {
  /** Vite root — the operator-vite package dir. Its `dist/` is build output. */
  viteRoot: string;
  /** apps/operator — owns `public/`, which Vite watches as publicDir. */
  operatorRoot: string;
}

/** Matches a docs-swap leftover dir (`docs.old.12345`) at any depth. */
const OLD_SWAP_SEGMENT = /(^|\/)[^/]+\.old\.\d+(\/|$)/;

/**
 * Build the `server.watch.ignored` predicate for the operator-vite dev server.
 *
 * Returns true for paths the dev server must NOT watch. Vite merges this with
 * its own defaults (node_modules, .git, …) rather than replacing them, so this
 * only has to describe the repo-specific dead weight.
 *
 * Note the deliberate asymmetry: we ignore the CONTENTS of these trees *and*
 * the tree roots themselves. Chokidar will not descend into a directory it is
 * told to ignore, so matching the root is what actually prevents the walk —
 * matching only `…/dist/` would still cost a walk of every entry beneath it.
 */
export function createDevWatchIgnore(dirs: WatchIgnoreDirs): (path: string) => boolean {
  const distRoot = `${dirs.viteRoot}/dist`;
  const publicDocs = `${dirs.operatorRoot}/public/internal/docs`;

  return (path: string): boolean => {
    // Normalise Windows separators so the predicate is platform-agnostic.
    const p = path.replace(/\\/g, '/');

    // Build output — the dev server serves from source, never from dist/.
    if (p === distRoot || p.startsWith(`${distRoot}/`)) return true;

    // The built docs site under publicDir. Matched STRICTLY (exact dir, or a
    // path beneath it) so a future sibling like `docs-authoring/` is not caught
    // by a loose prefix; the `docs.old.<pid>` siblings are handled by the
    // swap-leftover rule below rather than by prefix accident.
    if (p === publicDocs || p.startsWith(`${publicDocs}/`)) return true;

    // Any docs-swap leftover, wherever it landed.
    if (OLD_SWAP_SEGMENT.test(p)) return true;

    return false;
  };
}
