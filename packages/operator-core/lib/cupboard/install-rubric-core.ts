/**
 * Install a rubric FROM the Cupboard into the LOCAL rubric store
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-004).
 *
 * This is the install target `rubric-store.ts` was BUILT for and left dormant. Its
 * header states the contract verbatim: the writable user layer
 * (`<papercuspRoot>/rubrics`) is "EMPTY in v1; v2's Cupboard `kind='rubric'` install
 * target", and "install a rubric" is "just 'drop a self-describing dir into the user
 * layer', the seam v2 user-install reuses". This file is that reuse — it adds no new
 * storage concept.
 *
 * A `kind='rubric'` listing is mirror-repo-backed exactly like a template: the
 * listing points at a repo whose `<listing_ref>/` subdir holds `rubric.json` (the
 * manifest) + `listing.json` (storefront metadata) + optional `METHOD.md` (the
 * method_ref runbook). Installing = clone, validate, and place the dir under
 * `<papercuspRoot>/rubrics/<ref>/` — the layer the layered store resolves OVER the
 * bundled first-party floor (user shadows bundled).
 *
 * WHAT HAPPENS NEXT — and why this core deliberately stops here.
 * The store's dir is NOT the live rubric. A rubric IS a plan row (template='rubric'
 * in harness_shared.harness_plans) with ratify/trend/scorecard machinery keyed off
 * the DB, so the dir must be SEEDED into the workspace. That seed already exists and
 * is already correct: `ensureFirstPartyRubricsSeeded` (rubrics.ts) reads the same
 * layered roots and is idempotent + no-clobber — an existing workspace rubricId
 * always wins, so an install can never overwrite a locally-ratified rubric, and the
 * `seedContentHash` path upgrades only rows still untouched since their last seed
 * write. Re-implementing any of that here would fork the one no-clobber guarantee
 * the rubric store makes. So: this core lands the dir; the caller (install-rubric-io)
 * runs the EXISTING seed.
 */
import { readLocalRubricDirForInstall, userRubricsDir, type LocalRubric } from './rubric-store';
import {
  installSelfDescribingFromCupboard,
  type InstallSelfDescribingDeps,
  type InstallSelfDescribingInput,
  type SelfDescribingKindSpec,
  type VerifiedContentPin,
} from './install-self-describing-core';

export {
  InstallSelfDescribingError as InstallRubricError,
} from './install-self-describing-core';

export interface InstallRubricCoreResult {
  ok: true;
  /** The installed rubric's ref (its user-layer subdir name). */
  ref: string;
  /** The rubric id the seed will key on (rubric.json `rubricId`, else the ref). */
  rubricId: string;
  title: string;
  characteristic: string;
  version: string;
  /** Whether the rubric shipped a METHOD.md runbook (methodRef non-null). */
  hasMethod: boolean;
  source: string;
  installedTo: string;
  /** The content pin this install VERIFIED (P-002), or null for an unverified tip clone. */
  pin: VerifiedContentPin | null;
}

/** The rubric kind's slice of the generic installer. `source` is forced to
 *  'installed' by the reader for a user-layer dir, which is what marks a
 *  Cupboard-installed rubric apart from a first-party bundled one. */
const RUBRIC_KIND_SPEC: SelfDescribingKindSpec<LocalRubric> = {
  label: 'rubric',
  manifestFile: 'rubric.json',
  readDir: (dir, ref) => readLocalRubricDirForInstall(dir, ref),
  userDir: userRubricsDir,
};

export async function installRubricFromCupboardCore(
  input: InstallSelfDescribingInput,
  deps: InstallSelfDescribingDeps,
): Promise<InstallRubricCoreResult> {
  const r = await installSelfDescribingFromCupboard(input, RUBRIC_KIND_SPEC, deps);
  return {
    ok: true,
    ref: r.ref,
    rubricId: r.meta.rubricId,
    title: r.meta.title,
    characteristic: r.meta.characteristic,
    version: r.meta.version,
    hasMethod: r.meta.methodRef !== null,
    source: r.source,
    installedTo: r.installedTo,
    pin: r.pin,
  };
}
