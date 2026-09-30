/** Every package.json under `dir` that declares a `typecheck` script. `relativeTo` only shapes
 *  the human-readable `rel` label (the repo root in production, a fixture root in tests) —
 *  discovery itself is driven entirely by `dir`.
 *
 *  DISCOVERY, not a hardcoded list. A new package that adds a `typecheck` script is gated the
 *  moment it lands; a hardcoded roster would reproduce the exact silently-not-gated defect these
 *  items are about, one level further down. */
export function discover(dir: any, depth?: number, relativeTo?: any): any;
/** Every directory under `dir` that HAS a tsconfig.json but declares NO `typecheck` script.
 *
 *  This is the population EI-19376779013716004 is really about, and the one the WI-6841 fan-out
 *  cannot reach by construction: discovery there is by OPT-IN (the package declares a script),
 *  so a package that never declares one is not "passing" — it is INVISIBLE to every routine
 *  gate, and no amount of running the fan-out will ever say so. Reporting it is what turns the
 *  ABSENCE of a gate into a finding rather than silence.
 *
 *  Deliberately report-only at this stage. 61 such directories exist as of 2026-08-02 under
 *  apps/*, packages/* and libs/generic/* — the live count is printed on every run, so trust that
 *  over this comment. None of them has ever been typechecked by anything; making absence blocking
 *  in the same change that first measures it would red-pin the shared gate for the whole fleet —
 *  inflicting precisely the failure the item exists to prevent, with its own fix. */
export function discoverInvisible(dir: any, depth?: number, relativeTo?: any): any;
/** tsc under fleet load gets OOM-killed; that is an INFRASTRUCTURE outcome, never a verdict
 *  about the code (EI-18667028218882894). Detect it so we retry-then-skip instead of reddening
 *  the release gate for a condition no commit caused. */
export function looksOom(res: any): boolean;
export function runOne(pkg: any, spawn?: (pkg: any) => any, warn?: (...data: any[]) => void): any;
/**
 * Run every package, print a per-package line with its timing, then one coherent failure block.
 * Returns the results plus the counts, so the caller decides what is fatal — the same fan-out
 * is BLOCKING for libs/papercusp and, per-package, advisory for a newly-covered root.
 */
export function runPackages({ packages, label, unreadableCount, spawn, blockersOf, log, warn, error, }: {
    packages: any;
    label: any;
    unreadableCount?: number | undefined;
    spawn?: ((pkg: any) => any) | undefined;
    /** OPTIONAL dependency short-circuit: given a package, the `rel`s it depends on. When one of
     *  those already failed, the package is reported BLOCKED instead of compiled into a cascade.
     *  Requires `packages` to already be in dependency order. */
    blockersOf?: ((pkg: any) => Iterable<string>) | null | undefined;
    log?: ((...data: any[]) => void) | undefined;
    warn?: ((...data: any[]) => void) | undefined;
    error?: ((...data: any[]) => void) | undefined;
}): {
    results: any[];
    failed: any[];
    skipped: any[];
    passed: any[];
    blocked: any[];
};
export const SKIP_DIRS: Set<string>;
/** Deep enough for packages/harness/docs-viewer (3), with headroom; bounded so a symlink loop
 *  or a stray vendored tree can never turn discovery into an unbounded walk. */
export const MAX_DEPTH: 5;
/** The argv a package is typechecked with. `npm run typecheck` when it declares one;
 *  otherwise whatever the caller supplied via `pkg.command`.
 *
 *  The seam exists so a package can be gated on its TSCONFIG rather than on having
 *  remembered to add a script (EI-19409185011887864). Requiring the script made
 *  coverage a ROSTER — every new package uncovered until someone hand-enrolls it —
 *  which is exactly what this fan-out's "Discovery, not a roster" design rejects. */
export const commandFor: (pkg: any) => string[];
export function realSpawn(pkg: any): any;
