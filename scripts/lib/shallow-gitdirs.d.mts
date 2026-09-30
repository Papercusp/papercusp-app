export interface ShallowGitdirProblem {
  /** `(superproject)`, or the submodule's gitdir path under `.git/modules` (nested ones are qualified by their parent). */
  label: string;
  /** Absolute path to the gitdir itself. */
  gitdir: string;
  /** Absolute path to the `shallow` graft file that makes it shallow. */
  shallowFile: string;
  /** The graft shas listed in that file; never empty for a reported problem. */
  grafts: string[];
}

/** How the superproject is named in a report, distinct from any submodule path. */
export const SUPERPROJECT_LABEL: string;

/** Graft shas from a `shallow` file; [] when absent, empty, or unreadable. */
export function readGrafts(shallowPath: string): string[];

export function findShallowGitdirs(args: {
  /** `git rev-parse --git-common-dir`, made absolute. */
  gitCommonDir: string;
}): ShallowGitdirProblem[];

/** The verify-parents-then-delete repair sequence for one shallow repository. */
export function repairInstructions(problem: ShallowGitdirProblem): string;

export function formatShallowProblems(problems: ShallowGitdirProblem[]): string;
