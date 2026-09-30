export interface SubmoduleInstallProblem {
  /** Repo-relative submodule path, as declared in .gitmodules. */
  path: string;
  /** What is wrong, in a form a human can act on. */
  reason: string;
  /** The exact command that repairs it. */
  fix: string;
}

export function binShimNames(
  pkgName: string,
  binField: string | Record<string, string> | undefined | null,
): string[];

export function repairCommand(submodulePath: string): string;

export function rootWorkspacePatterns(repoRoot: string): string[];

export function isRootWorkspace(submodulePath: string, patterns: string[]): boolean;

export function findIncompleteSubmoduleInstalls(args: {
  repoRoot: string;
  submodulePaths: string[];
  /** Defaults to the root package.json's `workspaces`; injectable for tests. */
  rootWorkspaces?: string[];
}): SubmoduleInstallProblem[];

export function formatProblems(problems: SubmoduleInstallProblem[]): string;
