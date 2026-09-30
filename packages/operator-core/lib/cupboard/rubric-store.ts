/**
 * Local rubric store (local-first-party-rubric-bundling-2026-07-07) — the data layer
 * behind the BUNDLED first-party rubrics. Mirrors template-store.ts (the templates-v1
 * design, owner-directed 2026-07-07: install the first-party content locally + ship it
 * in release builds, designed for the v2 Cupboard marketplace).
 *
 * The ONE structural difference from templates: a rubric IS a plan row
 * (template:'rubric' in harness_shared.harness_plans) with ratify/trend/scorecard
 * machinery keyed off the DB — so the bundled layer cannot be read through directly;
 * it SEEDS into the workspace rubric store (rubrics.ts ensureFirstPartyRubricsSeeded:
 * idempotent, no-clobber — an existing workspace rubricId always wins, so local
 * ratified edits are never overwritten). The seed also fixes cold-start: a fresh
 * install has ZERO rubric rows until it runs (the Overwatch's mandatory
 * pot-coordination-health scorecard had nothing to grade against).
 *
 * The store is a resolved rubrics root, LAYERED (same shape as template-store):
 *   - bundled (read-only): ships in-app. Release: Tauri main.rs sets
 *     PAPERCUSP_RUBRICS_DIR → <resources>/sidecar/rubrics. Dev: the in-repo
 *     `rubrics/` dir (resolved relative to this file). Holds the first-party set.
 *   - user (writable): <papercuspRoot>/rubrics — EMPTY in v1; v2's Cupboard
 *     `kind='rubric'` install target (flag `papercusp-rubrics-marketplace`).
 *
 * Each rubric is a SELF-DESCRIBING subdir: `rubric.json` (the manifest — the
 * rubricTemplateDataSchema fields + title/version/source) + `listing.json`
 * (storefront metadata, the template-listing field shape) + optional `METHOD.md`
 * (the method_ref runbook — the GUIDE.md analog). "Install a rubric" is just "drop a
 * self-describing dir into the user layer", the seam v2 user-install reuses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { papercuspPath } from '../papercusp-root';
import {
  bundledDirFromEnv,
  inRepoFallbackDir,
  selfDescribingRoots,
  enumerateSelfDescribingDirs,
} from './self-describing-store';

/** One gradeable criterion as authored in rubric.json — field-for-field the store's
 *  RubricCriterion (rubrics.ts), so the seed passes criteria straight to proposeRubric
 *  (which fail-loud validates against rubricTemplateDataSchema). */
export interface LocalRubricCriterion {
  key: string;
  title: string;
  model: string;
  method: string;
  driftMarkers: string;
  ratingScale?: string[];
  /** The criterion's own REPLICATION DRILL (optional; see rubric-template.ts / WI-4287). */
  replication?: string;
}

/** A rubric resolved from the local store (a single self-describing subdir). */
export interface LocalRubric {
  /** The subdir name; equals rubricId for the first-party set. */
  ref: string;
  rubricId: string;
  title: string;
  characteristic: string;
  description: string;
  ratingScale: string[];
  methodRef: string | null;
  criteria: LocalRubricCriterion[];
  version: string;
  /** 'first-party' for the bundled set; v2 installs may mark 'installed'. */
  source: string;
  /** Absolute path to the rubric's content dir. */
  dir: string;
  layer: 'bundled' | 'user';
}

/** Fields the existing seed/no-clobber path needs. An already pinned package
 * has these values but must not consult its mutable source directory again. */
export type RubricSeedSource = Pick<LocalRubric,
  'rubricId' | 'title' | 'characteristic' | 'description' | 'criteria' | 'ratingScale' | 'methodRef'>;

export interface RubricRoot {
  dir: string;
  layer: 'bundled' | 'user';
}

// Dev fallback for the bundled layer: the in-repo `rubrics/` dir, resolved by
// walking up to the monorepo root so it survives esbuild bundling (a fixed `..`
// count overshoots when the host boots from apps/operator/dist-host/ — WI-3398
// 2026-07-08). Mirrors template-store.ts's inRepoTemplatesDir.
const inRepoRubricsDir = inRepoFallbackDir('rubrics', import.meta.url);

/** The bundled (read-only) rubrics dir: env override → in-repo dev fallback. */
export function bundledRubricsDir(): string {
  return bundledDirFromEnv('PAPERCUSP_RUBRICS_DIR', inRepoRubricsDir);
}

/** The writable user rubrics dir (v2 install target). Empty in v1. */
export function userRubricsDir(): string {
  return papercuspPath('rubrics');
}

/**
 * The layered roots, in RESOLUTION order — later layers shadow earlier ones on a
 * ref collision, so the writable user layer wins over the bundled first-party set.
 */
export function rubricRoots(): RubricRoot[] {
  return selfDescribingRoots({
    envVar: 'PAPERCUSP_RUBRICS_DIR',
    devFallbackDir: inRepoRubricsDir,
    userSubdir: 'rubrics',
  });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Tolerant structural read of a rubric.json criteria array. Returns null when any
 *  entry lacks a required string field — the dir is skipped rather than surfaced
 *  broken (deep validation happens again at seed time via rubricTemplateDataSchema). */
function readCriteria(v: unknown): LocalRubricCriterion[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: LocalRubricCriterion[] = [];
  for (const c of v) {
    if (typeof c !== 'object' || c === null) return null;
    const o = c as Record<string, unknown>;
    const key = str(o.key);
    const title = str(o.title);
    const model = str(o.model);
    const method = str(o.method);
    const driftMarkers = str(o.driftMarkers);
    if (!key || !title || !model || !method || !driftMarkers) return null;
    const ratingScale =
      Array.isArray(o.ratingScale) && o.ratingScale.every((s) => typeof s === 'string')
        ? (o.ratingScale as string[])
        : undefined;
    const replication = str(o.replication);
    out.push({
      key,
      title,
      model,
      method,
      driftMarkers,
      ...(ratingScale ? { ratingScale } : {}),
      ...(replication ? { replication } : {}),
    });
  }
  return out;
}

function readJsonOrNull(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Read a rubric subdir's self-describing content into a LocalRubric. rubric.json is
 *  the manifest and is REQUIRED; listing.json fills storefront gaps (description /
 *  version / source) when the manifest lacks them. Null ⇒ not a rubric dir (skipped). */
function readRubricDir(dir: string, ref: string, layer: 'bundled' | 'user'): LocalRubric | null {
  const manifest = readJsonOrNull(join(dir, 'rubric.json'));
  if (!manifest) return null;
  const listing = readJsonOrNull(join(dir, 'listing.json')) ?? {};

  const rubricId = str(manifest.rubricId) ?? str(listing.id) ?? ref;
  const title = str(manifest.title) ?? str(listing.title);
  const characteristic = str(manifest.characteristic) ?? str(listing.category);
  const criteria = readCriteria(manifest.criteria);
  const ratingScale =
    Array.isArray(manifest.ratingScale) && manifest.ratingScale.every((s) => typeof s === 'string')
      ? (manifest.ratingScale as string[])
      : null;
  if (!title || !characteristic || !criteria || !ratingScale || ratingScale.length === 0) return null;

  return {
    ref,
    rubricId,
    title,
    characteristic,
    description: str(manifest.description) ?? str(listing.description) ?? '',
    ratingScale,
    methodRef: str(manifest.methodRef) ?? null,
    criteria,
    version: str(manifest.version) ?? str(listing.version) ?? '0.1.0',
    source: str(manifest.source) ?? str(listing.source) ?? (layer === 'user' ? 'installed' : 'first-party'),
    dir,
    layer,
  };
}

/**
 * Read a candidate rubric dir as a USER-layer rubric, for the Cupboard install path
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-004). Deliberately the SAME
 * `readRubricDir` the store enumeration uses, so a dir that installs is exactly a
 * dir that will later resolve — an installer with its own parser could accept
 * something `listLocalRubrics` then silently skips, which is the failure mode that
 * makes an install look successful and the rubric never appear.
 *
 * Layer is fixed to 'user' because that is the only layer a Cupboard install writes
 * (the bundled layer is read-only and ships in the release build). Null ⇒ not a
 * valid rubric dir; the caller 422s rather than placing it.
 */
export function readLocalRubricDirForInstall(dir: string, ref: string): LocalRubric | null {
  return readRubricDir(dir, ref, 'user');
}

/**
 * Enumerate every rubric across the layered roots. A user-layer ref shadows a
 * bundled one. Non-dir entries (README.md) and dirs without a valid rubric.json are
 * skipped. Sorted by ref for stable output.
 */
export function listLocalRubrics(roots: RubricRoot[] = rubricRoots()): LocalRubric[] {
  // Enumeration + user-shadows-bundled + sort live in the shared read core
  // (self-describing-store.ts) — the Q2 consult outcome: share the read half,
  // keep the write halves (template overlay vs rubric seed) separate.
  return enumerateSelfDescribingDirs(roots, readRubricDir);
}

/** Resolve one rubric by ref (or rubricId) from the local store, or null. */
export function resolveLocalRubric(idOrRef: string, roots: RubricRoot[] = rubricRoots()): LocalRubric | null {
  const key = (idOrRef ?? '').trim();
  if (!key) return null;
  const all = listLocalRubrics(roots);
  return all.find((r) => r.ref === key || r.rubricId === key) ?? null;
}

/** Read a local rubric dir's METHOD.md (the method_ref runbook — GUIDE.md analog), or
 *  null when the rubric ships without one (methodRef null). */
export function readLocalRubricMethod(r: Pick<LocalRubric, 'dir'>): string | null {
  try {
    const path = join(r.dir, 'METHOD.md');
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** The recorded plan owner for a seeded rubric (createdBy/proposedBy/ratifiedBy in
 *  reads). Lives here (not rubrics.ts) so the seed decision core below can gate on it
 *  without an import cycle; rubrics.ts re-exports it. */
export const FIRST_PARTY_RUBRIC_SEED_OWNER = 'first-party-bundle';

/** The bundle-sourced subset of a validated rubric's `template_data`, as the seed decision
 *  core sees it — passed in by the caller (rubrics.ts owns the Zod schema/parse) for a
 *  `valid` row, so `rubricsNeedingSeed` can detect first-party-bundle content drift
 *  (EI-12932) without importing the plan-schema types here. Structurally a subset of
 *  RubricTemplateData; a caller may pass the full validated object (extra fields like
 *  releaseGating/proposedBy/ratifiedBy are simply ignored by the comparison). */
export interface SeedableTemplateData {
  characteristic: string;
  criteria: unknown[];
  ratingScale: string[];
  methodRef?: string | null;
  description?: string;
  /** Recorded by a PRIOR seed/upgrade write (see seedContentHash below); absent for a row
   *  seeded before this field existed, or one the seeder never wrote. */
  seedContentHash?: string;
}

/** An existing workspace rubric plan row, as the seed decision core sees it. `valid` is
 *  whether template_data parses against rubricTemplateDataSchema — computed by the
 *  caller (rubrics.ts owns the schema). `templateData` is present only when `valid`. */
export interface ExistingRubricRow {
  rubricId: string;
  owner: string | null;
  valid: boolean;
  templateData?: SeedableTemplateData | null;
}

type SeedComparableSource = Pick<
  SeedableTemplateData,
  'characteristic' | 'criteria' | 'ratingScale' | 'methodRef' | 'description'
> & {
  /**
   * Acceptance rubrics may delegate their criteria to a standard class. These
   * fields are omitted from first-party seed hashes, but are included when the
   * rubric read path asks for a delegated-class-aware criteria hash.
   */
  delegatedClassRef?: string | null;
  delegatedClassRevision?: number | null;
};

function comparableSeedFields(f: SeedComparableSource): Record<string, unknown> {
  return {
    characteristic: f.characteristic,
    criteria: f.criteria,
    ratingScale: f.ratingScale,
    ...(f.methodRef ? { methodRef: f.methodRef } : {}),
    ...(f.description ? { description: f.description } : {}),
    ...(f.delegatedClassRef !== undefined ? { delegatedClassRef: f.delegatedClassRef } : {}),
    ...(f.delegatedClassRevision !== undefined
      ? { delegatedClassRevision: f.delegatedClassRevision }
      : {}),
  };
}

/** Recursively key-sorted JSON serialization — object property order (source dir authoring
 *  order, jsonb round-tripping) must never affect the hash below; arrays keep their order
 *  (a criteria reorder IS a content change). */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * A stable content hash over a rubric's bundle-sourced fields (EI-12932 first-party-rubric
 * upgrade path). Recorded as `seedContentHash` in template_data by every seed/upgrade
 * write, then recomputed against the LIVE stored fields on a later pass to distinguish
 * "identical to what the seeder last wrote — only the BUNDLE has since changed" (safe to
 * upgrade) from "diverged since the seeder last wrote this" (a local edit; leave it).
 */
export function seedContentHash(f: SeedComparableSource): string {
  return hashPlanContent(stableStringify(comparableSeedFields(f)));
}

/**
 * The seed's PURE decision core (unit-tested without a DB): which bundled rubrics need a
 * seed/upgrade WRITE. No-clobber is the baseline: any rubricId under a REAL owner (any
 * status — active, proposed, retired, even a half-authored row) always wins and is never
 * touched.
 *
 * Two exceptions, both scoped to owner=FIRST_PARTY_RUBRIC_SEED_OWNER rows only:
 *
 *   1. WI-3617 wedge (2026-07-17): a row that is BOTH seeder-owned AND invalid (template_data
 *      fails the schema) is reclaimed — it can only be a wedged placeholder (a raced rename,
 *      a broken restore), it holds no ratified content to lose, it is invisible to reads
 *      (planRowToRubric nulls it), and left in place it blocks its own repair forever.
 *
 *   2. EI-12932 content-drift upgrade: a VALID seeder-owned row is upgraded IN PLACE when the
 *      current bundle's content differs from what was last seeded — but ONLY when the row's
 *      live content still matches its recorded `seedContentHash` (or, for a row seeded before
 *      that field existed, its own current content — trusted once as the unknown baseline
 *      rather than blocking upgrades forever). A row whose live content has since diverged
 *      from that recorded state — e.g. `amendRubric` patched one criterion field while
 *      falling back to the seed owner identity because no explicit `by` was given — is left
 *      untouched: the same no-clobber guarantee every other row gets, extended to a row that
 *      merely INHERITED the seed owner rather than being genuinely unmodified since seeding.
 *
 * Idempotent: a re-run against a fully up-to-date store (or one with no bundle changes)
 * returns [].
 */
export function rubricsNeedingSeed<T extends RubricSeedSource>(bundled: readonly T[], existing: readonly ExistingRubricRow[]): T[] {
  const byId = new Map(existing.map((e) => [e.rubricId, e] as const));
  const out: T[] = [];
  for (const r of bundled) {
    const row = byId.get(r.rubricId);
    if (!row) {
      out.push(r); // brand new — nothing blocks it
      continue;
    }
    if (row.owner !== FIRST_PARTY_RUBRIC_SEED_OWNER) continue; // a real owner always blocks
    if (!row.valid) {
      out.push(r); // WI-3617: a wedged seeder-owned placeholder is reclaimed
      continue;
    }
    if (!row.templateData) continue; // caller didn't supply comparable fields — stay safe, skip
    const liveHash = seedContentHash(row.templateData);
    const trustedBaseline = row.templateData.seedContentHash ?? liveHash;
    if (trustedBaseline !== liveHash) continue; // diverged since the last seed write — a local edit, leave it
    if (seedContentHash(r) !== liveHash) out.push(r); // the bundle has changed since — upgrade
  }
  return out;
}
