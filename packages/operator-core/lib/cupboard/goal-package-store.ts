/**
 * Local goal-package store — the on-disk layer behind the Cupboard's
 * `kind='goal'` listings (work-on-everything-goal-2026-08-23 P-006).
 *
 * The fourth consumer of `self-describing-store.ts`. A goal package is a
 * self-describing subdir:
 *
 *   <ref>/goal.json     — the package manifest AND content: the goal's DEFAULTS
 *                         (title, duties body, standing flag, kill criterion,
 *                         tripwire/budget-window/launch-setting defaults, IO
 *                         schemas). Never live state — see below.
 *   <ref>/listing.json  — storefront metadata only (description, version,
 *                         source, requires_rubrics echo)
 *
 * WHY goal.json CARRIES DEFAULTS, NEVER LIVE STATE (D-002)
 * --------------------------------------------------------
 * A goal row in `harness_shared.goals` fuses a reusable SHAPE (what the goal
 * pursues, its rails, its IO contract) with live run state (status, spend,
 * tripwire `current` readings, per-instance inputs, pause records). Publishing
 * the live half would hand an installer another workspace's telemetry as their
 * starting point, so the package format simply has no place for it: the reader
 * DROPS `current` from tripwires and the serializer (publish-goal-core) never
 * writes status / inputs / metadata. Install lands an INACTIVE STUB — no agent,
 * no spend — and starting it is a separate deliberate act (P-017's door).
 *
 * WHY A DISK LAYER AT ALL, when installing ends in a Postgres goal row
 * --------------------------------------------------------------------
 * Same two-step as a plan template, for the same reason: the DB row is
 * WORKSPACE-scoped and the disk layer is MACHINE-scoped. Installing a goal
 * package once makes it seedable in every workspace on the box, and a wiped dev
 * DB re-seeds from disk instead of re-downloading. It also gives the PUBLISH
 * path somewhere to materialize its export so the publisher has a real
 * directory to push to the mirror repo. The bundled layer EXISTING is this
 * file's shape; SEEDING from the bundle at release time is P-007's, not ours.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '../papercusp-root';
import {
  bundledDirFromEnv,
  inRepoFallbackDir,
  selfDescribingRoots,
  enumerateSelfDescribingDirs,
} from './self-describing-store';
import { parseRequiredRubrics, type RubricRequirement } from './types';
import { assertIdentityClean } from './identity-scrub';

/** The manifest file that MAKES a subdir a goal package. */
export const GOAL_PACKAGE_MANIFEST = 'goal.json';

/** The OPTIONAL constructor script beside goal.json (P-022): a pure, sandboxed
 *  `(typedInputs) => spec` run at START, never install (package-constructor.ts
 *  is the runtime; start-from-package.ts the one call site). Its PRESENCE makes
 *  the package constructible. It rides install unchanged (the installer copies
 *  the whole validated dir); publish-from-row never emits one — a construct
 *  script is package-AUTHORED, and nothing on a goal row serializes to it. */
export const GOAL_PACKAGE_CONSTRUCT_FILE = 'construct.js';

/** Read the package's construct script. `null` = a static package (no file).
 *  An EXISTING but unreadable/empty file is not silently "static": empty
 *  content is returned as-is and refused by the runtime with a typed error. */
export function readGoalPackageConstructScript(pkg: Pick<LocalGoalPackage, 'dir'>): string | null {
  const path = join(pkg.dir, GOAL_PACKAGE_CONSTRUCT_FILE);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export interface GoalPackageRoot {
  dir: string;
  layer: 'bundled' | 'user';
}

/** One tripwire DEFAULT — the row shape `harness_shared.goals.tripwires` takes,
 *  minus `current`: a package ships thresholds, never another workspace's
 *  latest observed reading. */
export interface GoalPackageTripwire {
  metric: string;
  label: string;
  threshold: number;
  unit?: string;
}

/** A goal package resolved from the local store (one self-describing subdir). */
export interface LocalGoalPackage {
  /** The subdir name — the package's identity, stamped as `goalPackageRef` on
   *  the seeded stub so a re-install can no-clobber against it. */
  ref: string;
  title: string;
  /** The duties body / kickoff brief. */
  body: string | null;
  /** TRUE for a standing (stewardship) goal package (P-001). */
  standing: boolean;
  killCriterion: string | null;
  tripwires: GoalPackageTripwire[] | null;
  budgetCents: number | null;
  /** Trailing-window denominator for the budget (P-004). Positive int or null. */
  budgetWindowSec: number | null;
  launchSettings: Record<string, unknown> | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  /** Typed property DECLARATIONS (P-023 shape: name → { datatype, default?,
   *  editable_by }), landed on the seeded/minted goal row's `property_schema`.
   *  Declarations are SHAPE — the runtime `properties` VALUES are live state
   *  and never ship in a package. */
  propertySchema: Record<string, unknown> | null;
  description: string;
  /** The rubric dependency declaration (worker migration 015/016). */
  requiresRubrics: RubricRequirement[];
  version: string;
  /** 'installed' for a user-layer dir, else whatever listing.json declares. */
  source: string;
  dir: string;
  layer: 'bundled' | 'user';
}

// Dev fallback for the bundled layer, resolved by walking up to the monorepo
// root so it survives esbuild bundling (WI-3398). The dir need not exist — a
// missing root is an empty layer.
const inRepoGoalPackagesDir = inRepoFallbackDir('goal-packages', import.meta.url);

/** The bundled (read-only) goal-packages dir: env override → in-repo dev fallback. */
export function bundledGoalPackagesDir(): string {
  return bundledDirFromEnv('PAPERCUSP_GOAL_PACKAGES_DIR', inRepoGoalPackagesDir);
}

/** The writable user goal-packages dir — the Cupboard `kind='goal'` install
 *  target AND the publish path's export destination. */
export function userGoalPackagesDir(): string {
  return papercuspPath('goal-packages');
}

/** The layered roots, in RESOLUTION order — the user layer shadows the bundled one. */
export function goalPackageRoots(): GoalPackageRoot[] {
  return selfDescribingRoots({
    envVar: 'PAPERCUSP_GOAL_PACKAGES_DIR',
    devFallbackDir: inRepoGoalPackagesDir,
    userSubdir: 'goal-packages',
  });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function readJsonOrNull(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate + normalize the manifest's tripwire list. Returns undefined on a
 * MALFORMED list (the dir is refused — see the reader's contract) and null for
 * an absent one. `current` is DROPPED, never copied: a package carries
 * defaults, not live state.
 */
function readTripwires(raw: unknown): GoalPackageTripwire[] | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return undefined;
  const out: GoalPackageTripwire[] = [];
  for (const e of raw) {
    if (!isPlainObject(e)) return undefined;
    const metric = str(e.metric);
    const label = str(e.label);
    const threshold = typeof e.threshold === 'number' && Number.isFinite(e.threshold) ? e.threshold : undefined;
    if (!metric || !label || threshold === undefined) return undefined;
    const unit = str(e.unit);
    out.push({ metric, label, threshold, ...(unit ? { unit } : {}) });
  }
  return out;
}

/** An optional plain-object field: absent → null, wrong type → undefined (refuse). */
function readObjectField(raw: unknown): Record<string, unknown> | null | undefined {
  if (raw === undefined || raw === null) return null;
  return isPlainObject(raw) ? raw : undefined;
}

/**
 * Read a goal-package subdir. `goal.json` is REQUIRED and its substantive
 * fields are validated STRICTLY — a malformed field REFUSES the dir (null)
 * rather than degrading to a default, because the degradations are not
 * harmless: a `budgetWindowSec` silently dropped turns a standing goal's
 * windowed ceiling into a lifetime auto-kill (the exact P-004 hazard), and a
 * `standing` flag silently defaulted files an ongoing duty as an outcome goal.
 * Null ⇒ not a goal-package dir (skipped by enumeration, 422 by the installer
 * — the point of sharing ONE reader between them).
 */
function readGoalPackageDir(
  dir: string,
  ref: string,
  layer: 'bundled' | 'user',
): LocalGoalPackage | null {
  const manifest = readJsonOrNull(join(dir, GOAL_PACKAGE_MANIFEST));
  if (!manifest) return null;

  const title = str(manifest.title);
  if (!title) return null;

  const body =
    manifest.body === undefined || manifest.body === null
      ? null
      : typeof manifest.body === 'string'
        ? manifest.body
        : undefined;
  if (body === undefined) return null;

  const standing = manifest.standing === undefined ? false : manifest.standing;
  if (typeof standing !== 'boolean') return null;

  const killCriterion =
    manifest.killCriterion === undefined || manifest.killCriterion === null
      ? null
      : str(manifest.killCriterion);
  if (killCriterion === undefined) return null;

  const budgetCents =
    manifest.budgetCents === undefined || manifest.budgetCents === null
      ? null
      : typeof manifest.budgetCents === 'number' &&
          Number.isInteger(manifest.budgetCents) &&
          manifest.budgetCents >= 0
        ? manifest.budgetCents
        : undefined;
  if (budgetCents === undefined) return null;

  const budgetWindowSec =
    manifest.budgetWindowSec === undefined || manifest.budgetWindowSec === null
      ? null
      : typeof manifest.budgetWindowSec === 'number' &&
          Number.isInteger(manifest.budgetWindowSec) &&
          manifest.budgetWindowSec > 0
        ? manifest.budgetWindowSec
        : undefined;
  if (budgetWindowSec === undefined) return null;

  const tripwires = readTripwires(manifest.tripwires);
  if (tripwires === undefined) return null;

  const launchSettings = readObjectField(manifest.launchSettings);
  if (launchSettings === undefined) return null;
  const inputSchema = readObjectField(manifest.inputSchema);
  if (inputSchema === undefined) return null;
  const outputSchema = readObjectField(manifest.outputSchema);
  if (outputSchema === undefined) return null;
  const propertySchema = readObjectField(manifest.propertySchema);
  if (propertySchema === undefined) return null;

  const listing = readJsonOrNull(join(dir, 'listing.json')) ?? {};
  // The declaration is listing.json's when it carries one (the publisher's
  // explicit choice, the same value the listing row was published with — the
  // no-disagree rationale plan templates established). A goal has no content to
  // DERIVE requirements from, so absent means none.
  const declared = listing.requires_rubrics;
  const requiresRubrics = Array.isArray(declared)
    ? parseRequiredRubrics(JSON.stringify(declared))
    : [];

  return {
    ref,
    title,
    body,
    standing,
    killCriterion: killCriterion ?? null,
    tripwires,
    budgetCents,
    budgetWindowSec,
    launchSettings,
    inputSchema,
    outputSchema,
    propertySchema,
    description: str(listing.description) ?? '',
    requiresRubrics,
    version: str(listing.version) ?? '0.1.0',
    source: str(listing.source) ?? (layer === 'user' ? 'installed' : 'first-party'),
    dir,
    layer,
  };
}

/**
 * Read a candidate dir as a USER-layer goal package, for the Cupboard install
 * path. Deliberately the SAME reader the enumeration uses (mirroring
 * `readPlanTemplateDirForInstall`): a dir that installs is exactly a dir that
 * will later resolve, so an install can never "succeed" into something the
 * store then silently skips.
 */
export function readGoalPackageDirForInstall(dir: string, ref: string): LocalGoalPackage | null {
  return readGoalPackageDir(dir, ref, 'user');
}

/** Enumerate every goal package across the layered roots (user shadows bundled). */
export function listLocalGoalPackages(
  roots: GoalPackageRoot[] = goalPackageRoots(),
): LocalGoalPackage[] {
  return enumerateSelfDescribingDirs(roots, readGoalPackageDir);
}

/** Resolve one goal package by its subdir ref. */
export function resolveLocalGoalPackage(
  ref: string,
  roots: GoalPackageRoot[] = goalPackageRoots(),
): LocalGoalPackage | null {
  const key = (ref ?? '').trim();
  if (!key) return null;
  return listLocalGoalPackages(roots).find((p) => p.ref === key) ?? null;
}

/** Same safe-single-segment rule the generic installer enforces on a listing
 *  ref — applied here too because this path writes a directory named by caller
 *  input. */
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

/** What the publish path serializes a goal row INTO — the package's content,
 *  live state already stripped (publish-goal-core owns the stripping). */
export interface GoalPackageExport {
  title: string;
  body: string | null;
  standing: boolean;
  killCriterion: string | null;
  tripwires: GoalPackageTripwire[] | null;
  budgetCents: number | null;
  budgetWindowSec: number | null;
  launchSettings: Record<string, unknown> | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  /** Typed property declarations (SHAPE) — runtime `properties` values are live
   *  state and are never exported. */
  propertySchema: Record<string, unknown> | null;
  description: string;
  requiresRubrics: RubricRequirement[];
}

export interface WrittenGoalPackage {
  ref: string;
  dir: string;
  manifestPath: string;
  listingPath: string;
}

/**
 * Materialize an export as a self-describing dir in the writable user layer —
 * the WRITE half, mirroring `writePlanTemplateDir`. Overwrites an existing dir
 * of the same ref, because the publisher re-exporting their own package is the
 * normal case and a stale half of a previous export left in place would be
 * published as if current.
 */
export function writeGoalPackageDir(
  exported: GoalPackageExport,
  opts: {
    ref: string;
    version?: string;
    targetDir?: string;
    /** Identity values `scrubIdentityFields` removed upstream. A surviving copy of
     *  one of these anywhere in the serialized bytes refuses the write. */
    knownIdentityValues?: readonly string[];
  },
): WrittenGoalPackage {
  const ref = (opts.ref ?? '').trim();
  if (!SAFE_REF_RE.test(ref)) {
    throw new Error(`unsafe goal-package ref ${JSON.stringify(ref)}`);
  }
  const root = opts.targetDir ?? userGoalPackagesDir();
  const dir = join(root, ref);

  const manifestJson =
    `${JSON.stringify(
      {
        title: exported.title,
        ...(exported.body !== null ? { body: exported.body } : {}),
        ...(exported.standing ? { standing: true } : {}),
        ...(exported.killCriterion !== null ? { killCriterion: exported.killCriterion } : {}),
        ...(exported.tripwires && exported.tripwires.length > 0
          ? { tripwires: exported.tripwires }
          : {}),
        ...(exported.budgetCents !== null ? { budgetCents: exported.budgetCents } : {}),
        ...(exported.budgetWindowSec !== null ? { budgetWindowSec: exported.budgetWindowSec } : {}),
        ...(exported.launchSettings ? { launchSettings: exported.launchSettings } : {}),
        ...(exported.inputSchema ? { inputSchema: exported.inputSchema } : {}),
        ...(exported.outputSchema ? { outputSchema: exported.outputSchema } : {}),
        ...(exported.propertySchema && Object.keys(exported.propertySchema).length > 0
          ? { propertySchema: exported.propertySchema }
          : {}),
      },
      null,
      2,
    )}\n`;

  // listing.json carries ONLY storefront metadata the manifest does not state.
  // The rubric declaration is included because it is the value the listing row
  // is published with — one file, so an installed dir cannot declare different
  // dependencies than the listing the installer read (the plan-kind rationale).
  const listingJson =
    `${JSON.stringify(
      {
        kind: 'goal',
        id: ref,
        title: exported.title,
        description: exported.description,
        version: opts.version ?? '0.1.0',
        source: 'exported',
        ...(exported.requiresRubrics.length > 0
          ? { requires_rubrics: exported.requiresRubrics }
          : {}),
      },
      null,
      2,
    )}\n`;

  // THE GATE (EI-23420285862298325). Run on the EXACT bytes about to be written, and
  // BEFORE mkdir/write, so a refused export leaves nothing on disk to be pushed by a
  // later hand. A published package goes to a PUBLIC mirror repo by design, so this
  // throws rather than reports: a check whose failure cannot stop the write is
  // decoration.
  const scanOpts = opts.knownIdentityValues
    ? { knownIdentityValues: opts.knownIdentityValues }
    : {};
  assertIdentityClean(manifestJson, `goal package ${ref}/${GOAL_PACKAGE_MANIFEST}`, scanOpts);
  assertIdentityClean(listingJson, `goal package ${ref}/listing.json`, scanOpts);

  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, GOAL_PACKAGE_MANIFEST);
  writeFileSync(manifestPath, manifestJson, 'utf8');
  const listingPath = join(dir, 'listing.json');
  writeFileSync(listingPath, listingJson, 'utf8');

  return { ref, dir, manifestPath, listingPath };
}
