/**
 * Doc claim: CLAUDE.md's `cd` section states that a persisted IN-TREE cwd changes which
 * `package.json` a later ROOT `npm run <script>` resolves against — npm walks up to the
 * NEAREST enclosing workspace, so a root-only script dies with `Missing script: "<name>"`
 * naming a workspace the caller never intended.
 *
 * The expensive half of that claim is the READING, not the mechanism: "Missing script"
 * invites "that script does not exist, so there is nothing to run" when the truth is
 * "wrong directory, and NOTHING was measured". This module is the pin that keeps the
 * clause honest — if the root commands CLAUDE.md prescribes ever become resolvable from
 * a workspace subdir, the claim has gone false and the prose must be revisited.
 *
 * Pure judge (no fs, no npm): the test supplies both synthetic fixtures and the real tree.
 */

/** One `package.json` covering some directory, reduced to what script resolution needs. */
export interface CoveringPackage {
  /** Directory the package.json sits in. */
  readonly dir: string;
  /** `name` field, used only to reproduce npm's error text. */
  readonly name?: string;
  /** Script names declared by that package.json. */
  readonly scripts: readonly string[];
}

export interface ResolutionQuery {
  /** Directory the Bash call is actually sitting in when `npm run` is invoked. */
  readonly cwd: string;
  /** Every covering package.json, in any order; the NEAREST ancestor wins. */
  readonly packages: readonly CoveringPackage[];
  /** The script name the caller typed. */
  readonly script: string;
}

export interface ResolutionVerdict {
  /** Directory of the package.json npm resolves against, or null when none covers `cwd`. */
  readonly governingDir: string | null;
  /** `name` of that package.json, when it declares one. */
  readonly governingName: string | null;
  /** Does the script actually run? */
  readonly resolves: boolean;
  /**
   * `missing-script` when npm reports `Missing script`, `no-package` when nothing covers
   * cwd at all, and null when the script resolves.
   */
  readonly failure: 'missing-script' | 'no-package' | null;
  /**
   * True when the script IS declared at some ancestor further up but NOT at the governing
   * one — i.e. exactly the misdirection the doc clause warns about: the command is real
   * and runnable, just not from here.
   */
  readonly shadowedByNearerPackage: boolean;
}

/** Is `dir` an ancestor of (or equal to) `cwd`, on POSIX-style paths? */
function covers(dir: string, cwd: string): boolean {
  if (dir === cwd) return true;
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  return cwd.startsWith(prefix);
}

/** Path depth, used to pick the NEAREST covering package.json. */
function depth(dir: string): number {
  return dir.split('/').filter(Boolean).length;
}

/**
 * Reproduce npm's script resolution: the nearest enclosing package.json wins, and a script
 * declared only further up is NOT reachable from here.
 */
export function judgeNpmScriptResolution(query: ResolutionQuery): ResolutionVerdict {
  const covering = query.packages
    .filter((pkg) => covers(pkg.dir, query.cwd))
    .sort((a, b) => depth(b.dir) - depth(a.dir));

  const governing = covering[0];
  if (!governing) {
    return {
      governingDir: null,
      governingName: null,
      resolves: false,
      failure: 'no-package',
      shadowedByNearerPackage: false,
    };
  }

  const resolves = governing.scripts.includes(query.script);
  const declaredHigherUp = covering
    .slice(1)
    .some((pkg) => pkg.scripts.includes(query.script));

  return {
    governingDir: governing.dir,
    governingName: governing.name ?? null,
    resolves,
    failure: resolves ? null : 'missing-script',
    shadowedByNearerPackage: !resolves && declaredHigherUp,
  };
}

/**
 * The root commands CLAUDE.md tells an agent to run, whose failure from a workspace subdir
 * is the misreading the clause exists to prevent. Kept small and load-bearing on purpose:
 * these are prescribed by name in the guide, so their absence from a workspace is the
 * claim, not an incidental statistic.
 */
export const ROOT_PRESCRIBED_SCRIPTS = ['test:affected', 'install:safe', 'doctor'] as const;

/** Sentence fragments the CLAUDE.md clause must keep carrying for the claim to be stated. */
export const CLAUDE_MD_CLAUSE_MARKERS = [
  'NEAREST enclosing workspace',
  'The trap is the READING, not the error',
] as const;
