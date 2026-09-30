/**
 * Install a plan TEMPLATE from the Cupboard into the local plan-template store
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-010).
 *
 * The pure half: clone the mirror repo, validate `<listing_ref>/` is a plan-template
 * dir (`plan.md` that parses as a structured plan), place it under
 * `<papercuspRoot>/plan-templates/<ref>/`. Nothing DB-shaped happens here — the
 * seed into a workspace plan row is `install-plan-io`'s second step, exactly as the
 * rubric installer splits dir-placement from seeding.
 *
 * Everything mechanical is `install-self-describing-core` (D-003): the GitHub-URL
 * guard, the safe-ref guard, the clone-to-tmp, the path-escape assertions, the
 * validate-BEFORE-copy ordering, the guaranteed tmp cleanup. This file is the plan
 * kind's spec — four fields — and nothing else, which is the point of having
 * generalized that core when the rubric kind was built rather than after the third
 * copy of it existed.
 */
import {
  readPlanTemplateDirForInstall,
  userPlanTemplatesDir,
  PLAN_TEMPLATE_MANIFEST,
  type LocalPlanTemplate,
} from './plan-template-store';
import {
  installSelfDescribingFromCupboard,
  type InstallSelfDescribingDeps,
  type InstallSelfDescribingInput,
  type SelfDescribingKindSpec,
  type VerifiedContentPin,
} from './install-self-describing-core';
import type { RubricRequirement } from './types';

export {
  InstallSelfDescribingError as InstallPlanError,
} from './install-self-describing-core';

export interface InstallPlanCoreResult {
  ok: true;
  /** The installed template's ref (its user-layer subdir name). */
  ref: string;
  /** The plan slug the template declares — the slug a seed would create. */
  templateSlug: string;
  title: string;
  description: string;
  itemCount: number;
  decisionCount: number;
  /** The rubric dependencies the INSTALLED DIR declares. Cross-checked against the
   *  listing's own declaration by the caller — a mismatch means the mirror repo and
   *  the listing row disagree, which the installer must not paper over. */
  requiresRubrics: RubricRequirement[];
  /** The sanitized markdown, ready to seed as the plan row's content. */
  markdown: string;
  version: string;
  source: string;
  installedTo: string;
  /** The content pin this install VERIFIED (P-002), or null for an unverified tip clone. */
  pin: VerifiedContentPin | null;
}

/** The plan kind's slice of the generic installer. `plan.md` is BOTH the manifest and
 *  the content (D-005) — there is deliberately no second JSON copy of what the
 *  markdown already declares. */
const PLAN_KIND_SPEC: SelfDescribingKindSpec<LocalPlanTemplate> = {
  label: 'plan template',
  manifestFile: PLAN_TEMPLATE_MANIFEST,
  readDir: (dir, ref) => readPlanTemplateDirForInstall(dir, ref),
  userDir: userPlanTemplatesDir,
};

export async function installPlanFromCupboardCore(
  input: InstallSelfDescribingInput,
  deps: InstallSelfDescribingDeps,
): Promise<InstallPlanCoreResult> {
  const r = await installSelfDescribingFromCupboard(input, PLAN_KIND_SPEC, deps);
  return {
    ok: true,
    ref: r.ref,
    templateSlug: r.meta.templateSlug,
    title: r.meta.title,
    description: r.meta.description,
    itemCount: r.meta.itemCount,
    decisionCount: r.meta.decisionCount,
    requiresRubrics: r.meta.requiresRubrics,
    markdown: r.meta.markdown,
    version: r.meta.version,
    source: r.source,
    installedTo: r.installedTo,
    pin: r.pin,
  };
}
