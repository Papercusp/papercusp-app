/**
 * Local plan-template store — the on-disk layer behind the Cupboard's
 * `kind='plan'` listings (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-009/P-010).
 *
 * The third consumer of `self-describing-store.ts`, which anticipated exactly this:
 * its header records the extraction as "a candidate for a later lift to a generic lib
 * if a third kind appears". A plan template is a self-describing subdir:
 *
 *   <ref>/plan.md       — the SANITIZED plan markdown (the manifest AND the content;
 *                         see below — there is deliberately no second copy of it)
 *   <ref>/listing.json  — storefront metadata only (description, version, source)
 *
 * WHY plan.md IS THE MANIFEST (D-005)
 * -----------------------------------
 * Every other kind here carries a JSON manifest beside its content (rubric.json,
 * template.yaml). A plan template could too — and it would be a second, hand-
 * maintained copy of facts the markdown already owns: title and slug are frontmatter,
 * the item DAG is the item lines, the rubric requirements are derivable from the body.
 * That is the derived-truth ladder's rung-4 case with no justification: a manifest
 * restating what the content already states drifts the first time someone edits one
 * of them. So the markdown IS the manifest, parsed by the plan parser the rest of the
 * system already trusts, and `listing.json` carries only what the markdown genuinely
 * does not know — storefront presentation.
 *
 * WHY A DISK LAYER AT ALL, when installing ends in a Postgres plan row
 * --------------------------------------------------------------------
 * Same two-step as a rubric install, for the same reason: the DB row is
 * WORKSPACE-scoped and the disk layer is MACHINE-scoped. Installing a plan template
 * once makes it instantiable in every workspace on the box, and a workspace switch (or
 * a wiped dev DB) re-seeds from disk instead of re-downloading. It also gives the
 * PUBLISH path somewhere to materialize its export so the publisher has a real
 * directory to push to the mirror repo — a plan, unlike a rubric, has no dir on disk
 * until something writes one.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlan } from '@papercusp/plan-parser';
import { papercuspPath } from '../papercusp-root';
import {
  bundledDirFromEnv,
  inRepoFallbackDir,
  selfDescribingRoots,
  enumerateSelfDescribingDirs,
} from './self-describing-store';
import { parseRequiredRubrics, type RubricRequirement } from './types';
import { deriveRequiredRubrics, type PlanTemplateExport } from './plan-template-serialize';

/** The manifest file that MAKES a subdir a plan template (see D-005 above). */
export const PLAN_TEMPLATE_MANIFEST = 'plan.md';

export interface PlanTemplateRoot {
  dir: string;
  layer: 'bundled' | 'user';
}

/** A plan template resolved from the local store (one self-describing subdir). */
export interface LocalPlanTemplate {
  /** The subdir name. Equals the template's declared slug for a normal export. */
  ref: string;
  /** The slug the sanitized frontmatter declares — the plan slug an install seeds. */
  templateSlug: string;
  title: string;
  description: string;
  /** Item / decision counts, so a storefront card can show the shape without
   *  shipping the whole document into the listing row. */
  itemCount: number;
  decisionCount: number;
  /** The rubric dependency declaration (worker migration 015). */
  requiresRubrics: RubricRequirement[];
  version: string;
  /** 'installed' for a user-layer dir, else whatever listing.json declares. */
  source: string;
  /** The sanitized plan markdown — what an install seeds as the plan row's content. */
  markdown: string;
  dir: string;
  layer: 'bundled' | 'user';
}

// Dev fallback for the bundled layer, resolved by walking up to the monorepo root so
// it survives esbuild bundling (WI-3398). The dir need not exist — a missing root is
// an empty layer, and there is no first-party bundled plan-template set today.
const inRepoPlanTemplatesDir = inRepoFallbackDir('plan-templates', import.meta.url);

/** The bundled (read-only) plan-templates dir: env override → in-repo dev fallback. */
export function bundledPlanTemplatesDir(): string {
  return bundledDirFromEnv('PAPERCUSP_PLAN_TEMPLATES_DIR', inRepoPlanTemplatesDir);
}

/** The writable user plan-templates dir — the Cupboard `kind='plan'` install target
 *  AND the publish path's export destination. */
export function userPlanTemplatesDir(): string {
  return papercuspPath('plan-templates');
}

/** The layered roots, in RESOLUTION order — the user layer shadows the bundled one. */
export function planTemplateRoots(): PlanTemplateRoot[] {
  return selfDescribingRoots({
    envVar: 'PAPERCUSP_PLAN_TEMPLATES_DIR',
    devFallbackDir: inRepoPlanTemplatesDir,
    userSubdir: 'plan-templates',
  });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function readJsonOrNull(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Read a plan-template subdir. `plan.md` is REQUIRED and must parse as a structured
 * plan — a legacy/frontmatter-less document has no reliable item structure, and a
 * store that surfaced one would hand the installer a document whose statuses were
 * never reset. Null ⇒ not a plan-template dir (skipped by enumeration, 422 by the
 * installer, which is the point of sharing ONE reader between them).
 */
function readPlanTemplateDir(
  dir: string,
  ref: string,
  layer: 'bundled' | 'user',
): LocalPlanTemplate | null {
  const mdPath = join(dir, PLAN_TEMPLATE_MANIFEST);
  let markdown: string;
  try {
    if (!existsSync(mdPath)) return null;
    markdown = readFileSync(mdPath, 'utf8');
  } catch {
    return null;
  }
  const parsed = parsePlan(markdown);
  if (parsed.isLegacy || !parsed.frontmatter.slug) return null;

  const listing = readJsonOrNull(join(dir, 'listing.json')) ?? {};
  // The declaration is listing.json's when it carries one (the publisher's explicit
  // choice, and the same value the listing row was published with); otherwise derive
  // it from the markdown, so a hand-assembled dir still declares its dependencies.
  const declared = listing.requires_rubrics;
  const requiresRubrics = Array.isArray(declared)
    ? parseRequiredRubrics(JSON.stringify(declared))
    : deriveRequiredRubrics(markdown, parsed.frontmatter.slug);

  return {
    ref,
    templateSlug: parsed.frontmatter.slug,
    title: parsed.frontmatter.title ?? str(listing.title) ?? ref,
    description: str(listing.description) ?? '',
    itemCount: parsed.items.length,
    decisionCount: parsed.decisions.length,
    requiresRubrics,
    version: str(listing.version) ?? '0.1.0',
    source: str(listing.source) ?? (layer === 'user' ? 'installed' : 'first-party'),
    markdown,
    dir,
    layer,
  };
}

/**
 * Read a candidate dir as a USER-layer plan template, for the Cupboard install path.
 * Deliberately the SAME reader the enumeration uses (mirroring
 * `readLocalRubricDirForInstall`): a dir that installs is exactly a dir that will
 * later resolve, so an install can never "succeed" into something the store then
 * silently skips.
 */
export function readPlanTemplateDirForInstall(dir: string, ref: string): LocalPlanTemplate | null {
  return readPlanTemplateDir(dir, ref, 'user');
}

/** Enumerate every plan template across the layered roots (user shadows bundled). */
export function listLocalPlanTemplates(
  roots: PlanTemplateRoot[] = planTemplateRoots(),
): LocalPlanTemplate[] {
  return enumerateSelfDescribingDirs(roots, readPlanTemplateDir);
}

/** Resolve one plan template by subdir ref or by its declared template slug. */
export function resolveLocalPlanTemplate(
  idOrRef: string,
  roots: PlanTemplateRoot[] = planTemplateRoots(),
): LocalPlanTemplate | null {
  const key = (idOrRef ?? '').trim();
  if (!key) return null;
  return listLocalPlanTemplates(roots).find((p) => p.ref === key || p.templateSlug === key) ?? null;
}

/** Same safe-single-segment rule the generic installer enforces on a listing ref —
 *  applied here too because this path writes a directory named by caller input. */
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export interface WrittenPlanTemplate {
  ref: string;
  dir: string;
  markdownPath: string;
  listingPath: string;
}

/**
 * Materialize a sanitized export as a self-describing dir in the writable user layer
 * — the WRITE half, deliberately not generalized (the shared core is the read half).
 *
 * This is what gives `cupboard:publish-plan` something to push: the publisher runs the
 * export, gets a real directory back, pushes it to the mirror repo, and the listing
 * points at it. Overwrites an existing dir of the same ref, because the publisher
 * re-exporting their own template is the normal case and a stale half of a previous
 * export left in place would be published as if current.
 */
export function writePlanTemplateDir(
  exported: PlanTemplateExport,
  opts: { ref?: string; version?: string; targetDir?: string } = {},
): WrittenPlanTemplate {
  const ref = (opts.ref ?? exported.templateSlug).trim();
  if (!SAFE_REF_RE.test(ref)) {
    throw new Error(`unsafe plan-template ref ${JSON.stringify(ref)}`);
  }
  const root = opts.targetDir ?? userPlanTemplatesDir();
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });

  const markdownPath = join(dir, PLAN_TEMPLATE_MANIFEST);
  writeFileSync(markdownPath, exported.markdown, 'utf8');

  // listing.json carries ONLY what the markdown does not already state (D-005). The
  // rubric declaration is included because it is the value the listing row is
  // published with — keeping the two in one file is what stops an installed dir from
  // declaring different dependencies than the listing the installer read.
  const listingPath = join(dir, 'listing.json');
  writeFileSync(
    listingPath,
    `${JSON.stringify(
      {
        kind: 'plan',
        id: exported.templateSlug,
        title: exported.title,
        description: exported.description,
        version: opts.version ?? '0.1.0',
        source: 'exported',
        item_count: exported.itemCount,
        decision_count: exported.decisionCount,
        ...(exported.requiresRubrics.length > 0
          ? { requires_rubrics: exported.requiresRubrics }
          : {}),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return { ref, dir, markdownPath, listingPath };
}
