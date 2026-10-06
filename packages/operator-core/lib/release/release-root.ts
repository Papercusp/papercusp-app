/**
 * The ONE place that decides where this box's release checkout (the deploy artifact
 * `:3070` serves, pinned to green `main`) lives on disk. WI-10005161.
 *
 * Four readers used to derive it independently as `dirname(<the serving process's
 * integration root>)/papercup-release` (release-config.ts, dev-deploy-state.ts,
 * migration-drift.ts, desktop-install/workspace-map.ts). That is right for `:3070`
 * (integration root `…/papercusp` → `…/papercup-release`) and WRONG for the staging
 * operator `:3170`: its tracked 95-bundled-entry drop-in exports the integration root
 * as the PHYSICAL generation (`pwd -P` → `…/papercusp-staging.generations/
 * .candidate-<sha>.<rand>/checkout`), so the sibling is `…/.candidate-<sha>.<rand>/
 * papercup-release`, which never exists. Every `deploy.3070.sha` read served by
 * `:3170` then reported `resolver-failed`, and a predicate await over it could not
 * observe a real deploy (measured 2026-10-02: await 214913 timed out blind).
 *
 * The release checkout is a property of the BOX LAYOUT — a sibling of the tree agents
 * edit — not of whichever checkout happens to be serving. So the precedence is:
 *
 *   1. an explicit caller override (release-config's `overrides.releaseRoot`);
 *   2. `PAPERCUSP_RELEASE_ROOT` (bg-host declares it);
 *   3. the sibling of `PAPERCUSP_CANONICAL_TREE` — the declared edit tree, set exactly
 *      on the hosts whose serving checkout differs from it (`:3170`);
 *   4. the sibling of the serving integration root (`:3070`, CLIs, dev shells).
 *
 * Pure: no fs, no git, no process.env read unless the caller passes none. Callers keep
 * their own integration-root resolution (each has different, deliberate semantics).
 */
import * as path from 'node:path';

/** Basename of the release checkout beside the edit tree on a dev box. */
export const RELEASE_CHECKOUT_DIRNAME = 'papercup-release';

export type ReleaseRootSource =
  | 'override'
  | 'PAPERCUSP_RELEASE_ROOT'
  | 'canonical-tree-sibling'
  | 'integration-root-sibling';

export interface ReleaseRootInput {
  /** The caller's serving integration root (used only as the last-resort anchor). */
  integrationRoot: string;
  /** An explicit caller override; wins over every env value when non-empty. */
  override?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface ReleaseRootResolution {
  root: string;
  source: ReleaseRootSource;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Where the release checkout is, and which rule produced it. */
export function describeReleaseRoot(input: ReleaseRootInput): ReleaseRootResolution {
  const env = input.env ?? process.env;
  const override = nonEmpty(input.override);
  if (override) return { root: override, source: 'override' };
  const declared = nonEmpty(env.PAPERCUSP_RELEASE_ROOT);
  if (declared) return { root: declared, source: 'PAPERCUSP_RELEASE_ROOT' };
  const canonical = nonEmpty(env.PAPERCUSP_CANONICAL_TREE);
  if (canonical) {
    return {
      root: path.join(path.dirname(canonical), RELEASE_CHECKOUT_DIRNAME),
      source: 'canonical-tree-sibling',
    };
  }
  return {
    root: path.join(path.dirname(input.integrationRoot), RELEASE_CHECKOUT_DIRNAME),
    source: 'integration-root-sibling',
  };
}

/** The release checkout path. See {@link describeReleaseRoot} for the precedence. */
export function resolveReleaseRoot(input: ReleaseRootInput): string {
  return describeReleaseRoot(input).root;
}
