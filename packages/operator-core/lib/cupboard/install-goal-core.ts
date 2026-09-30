/**
 * Install a goal PACKAGE from the Cupboard into the local goal-package store
 * (work-on-everything-goal-2026-08-23 P-006).
 *
 * The pure half: clone the mirror repo, validate `<listing_ref>/` is a goal
 * package dir (`goal.json` that passes the store's strict reader), place it
 * under `<papercuspRoot>/goal-packages/<ref>/`. Nothing DB-shaped happens here
 * — the seed into an INACTIVE goal stub is `install-goal-io`'s third step,
 * exactly as the plan installer splits dir-placement from seeding.
 *
 * Everything mechanical is `install-self-describing-core` (D-003): the
 * GitHub-URL guard, the safe-ref guard, the clone-to-tmp, the path-escape
 * assertions, the validate-BEFORE-copy ordering, the guaranteed tmp cleanup.
 * This file is the goal kind's spec — four fields — and nothing else.
 */
import {
  readGoalPackageDirForInstall,
  userGoalPackagesDir,
  GOAL_PACKAGE_MANIFEST,
  type LocalGoalPackage,
} from './goal-package-store';
import {
  installSelfDescribingFromCupboard,
  type InstallSelfDescribingDeps,
  type InstallSelfDescribingInput,
  type SelfDescribingKindSpec,
  type VerifiedContentPin,
} from './install-self-describing-core';

export {
  InstallSelfDescribingError as InstallGoalError,
} from './install-self-describing-core';

export interface InstallGoalCoreResult {
  ok: true;
  /** The installed package's ref (its user-layer subdir name). */
  ref: string;
  /** The full parsed package — what a seed writes as the stub's defaults. */
  pkg: LocalGoalPackage;
  source: string;
  installedTo: string;
  /** The content pin this install VERIFIED (P-002), or null for an unverified tip clone. */
  pin: VerifiedContentPin | null;
}

/** The goal kind's slice of the generic installer. */
const GOAL_KIND_SPEC: SelfDescribingKindSpec<LocalGoalPackage> = {
  label: 'goal package',
  manifestFile: GOAL_PACKAGE_MANIFEST,
  readDir: (dir, ref) => readGoalPackageDirForInstall(dir, ref),
  userDir: userGoalPackagesDir,
};

export async function installGoalFromCupboardCore(
  input: InstallSelfDescribingInput,
  deps: InstallSelfDescribingDeps,
): Promise<InstallGoalCoreResult> {
  const r = await installSelfDescribingFromCupboard(input, GOAL_KIND_SPEC, deps);
  return {
    ok: true,
    ref: r.ref,
    pkg: r.meta,
    source: r.source,
    installedTo: r.installedTo,
    pin: r.pin,
  };
}
