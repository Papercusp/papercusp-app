// Type declarations for check-generic-independence.mjs — a plain ESM script
// with no build step, consumed both as a CLI (`node scripts/check-generic-independence.mjs`)
// and, for its pure core, imported from a Vitest test
// (packages/operator-core/lib/__tests__/check-generic-independence.test.ts).

export interface GenericIndependenceFinding {
  severity: 'private-target' | 'hard-section';
  lib: string;
  path: string;
  dep: string;
  section: string;
  submodule: boolean;
}

export interface ComputeFindingsOptions {
  /** [path, category, fallbackDesc?][] — defaults to the real curated BORROWABLE list. */
  borrowable?: Array<[string, string, string?]>;
  /** submodule path -> git url — defaults to a fresh parseGitmodules() read of .gitmodules. */
  submodules?: Record<string, string>;
  /** package.json reader — defaults to the real filesystem read (readPkg). */
  readPkgFn?: (path: string) => { name: string; [key: string]: unknown };
}

export const HARD_SECTIONS: string[];

export function computeFindings(
  options?: ComputeFindingsOptions,
): GenericIndependenceFinding[];
