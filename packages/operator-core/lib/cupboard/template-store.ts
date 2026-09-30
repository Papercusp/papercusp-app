/**
 * Local template store (plan local-first-party-template-bundling-2026-07-07) — the
 * data layer behind the LOCAL half of the `templates:*` verbs.
 *
 * v1 ships the first-party "Papercusp Official" templates IN the app and resolves
 * them from disk (offline, no Cupboard/GitHub round-trip). The remote Cupboard
 * marketplace stays a wired-but-dormant v2 seam (flag `papercusp-templates-marketplace`).
 *
 * The store is a resolved templates root, LAYERED:
 *   - bundled (read-only): ships in-app. Release: Tauri main.rs sets
 *     PAPERCUSP_TEMPLATES_DIR → <resources>/sidecar/templates. Dev: the in-repo
 *     `templates/` dir (resolved relative to this file). Holds the first-party set.
 *   - user (writable): <papercuspRoot>/templates — EMPTY in v1; v2's
 *     `templates:install` writes marketplace templates here.
 *
 * Each template is a SELF-DESCRIBING subdir: `listing.json`
 * (ref/title/description/category/scope) + `template.yaml` + `GUIDE.md`
 * (+ `COMPONENT_CATALOG.md`). The store enumerates subdirs across layers (a user-
 * layer ref shadows a bundled one), so "install a template" is just "drop a
 * self-describing dir into the user layer" — the seam that makes v2 user-install
 * reuse this exact resolution + materialize path, with no first-party special case.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '../papercusp-root';
import type { TemplateListing } from './templates';
import {
  bundledDirFromEnv,
  inRepoFallbackDir,
  selfDescribingRoots,
  enumerateSelfDescribingDirs,
} from './self-describing-store';
import type { ShadowEvent } from './self-describing-store';

/** A template resolved from the local store (a single self-describing subdir). */
export interface LocalTemplate {
  ref: string;
  id: string;
  title: string;
  description: string;
  category: string | null;
  scope: string | null;
  version: string;
  /** 'first-party' for the bundled set; v2 installs may mark 'installed'. */
  source: string;
  /** Absolute path to the template's content dir (the overlay source). */
  dir: string;
  layer: 'bundled' | 'user';
  /**
   * Whether the dir carried a listing.json (the rich metadata). A dir with only
   * template.yaml still resolves — that is the supported v2 install shape — but
   * it is NOT allowed to silently degrade an official template it collides with
   * (WI-37781).
   */
  hasListing: boolean;
  /**
   * RETIRED refs this template answers to (listing.json `aliases`), so a
   * template that absorbed others keeps their handles resolving (plan
   * unified-app-template-2026-08-23 D-002).
   *
   * A ref is a durable public handle: it is what `templates:new-app` and
   * `templates:get-guide` take, what live tool descriptions name, and what an
   * in-flight materialize is already holding. Retiring a template therefore
   * cannot just delete its ref — the alias is how the handle outlives the
   * directory. An alias NEVER shadows a real ref (see the lookup order in
   * `resolveLocalTemplateWithShadows`), so re-introducing a template with a
   * retired name takes its handle back automatically.
   */
  aliases: string[];
}

export interface TemplateRoot {
  dir: string;
  layer: 'bundled' | 'user';
}

// Dev fallback for the bundled layer: the in-repo `templates/` dir, resolved by
// walking up to the monorepo root so it stays correct when this module is esbuild-
// BUNDLED (the staging/bg host boots from apps/operator/dist-host/, a shallower dir
// than the source lib/cupboard/ — a fixed `..` count overshot the root and returned
// count:0, WI-3398 2026-07-08). A fresh checkout with no PAPERCUSP_TEMPLATES_DIR env
// still resolves the first-party set.
const inRepoTemplatesDir = inRepoFallbackDir('templates', import.meta.url);

/** The bundled (read-only) templates dir: env override → in-repo dev fallback. */
export function bundledTemplatesDir(): string {
  return bundledDirFromEnv('PAPERCUSP_TEMPLATES_DIR', inRepoTemplatesDir);
}

/** The writable user templates dir (v2 install target). Empty in v1. */
export function userTemplatesDir(): string {
  return papercuspPath('templates');
}

/**
 * The layered roots, in RESOLUTION order — later layers shadow earlier ones on a
 * ref collision, so the writable user layer wins over the bundled first-party set.
 */
export function templateRoots(): TemplateRoot[] {
  return selfDescribingRoots({
    envVar: 'PAPERCUSP_TEMPLATES_DIR',
    devFallbackDir: inRepoTemplatesDir,
    userSubdir: 'templates',
  });
}

/** Read a template subdir's self-describing metadata into a LocalTemplate.
 *  Exported so the cupboard install-template path (P-003) can validate + read a
 *  freshly-cloned `<ref>/` dir with the SAME parser the store enumeration uses. */
export function readTemplateDir(dir: string, ref: string, layer: 'bundled' | 'user'): LocalTemplate | null {
  const listingPath = join(dir, 'listing.json');
  const manifestPath = join(dir, 'template.yaml');
  // A template dir MUST carry a template.yaml (the manifest). listing.json is the
  // rich metadata; when absent we fall back to the manifest so a v2-installed dir
  // that only shipped template.yaml still resolves.
  const hasManifest = existsSync(manifestPath);
  const hasListing = existsSync(listingPath);
  if (!hasManifest && !hasListing) return null;

  let listing: Record<string, unknown> = {};
  if (hasListing) {
    try {
      listing = JSON.parse(readFileSync(listingPath, 'utf8')) as Record<string, unknown>;
    } catch {
      listing = {};
    }
  }
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined;

  // Manifest scalars as a fallback for category/scope/id/version when listing.json
  // is thin (bounded regex over our own YAML — see gen-listings).
  let mText = '';
  if (hasManifest) {
    try {
      mText = readFileSync(manifestPath, 'utf8');
    } catch {
      mText = '';
    }
  }
  const yscalar = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(mText);
    return m ? m[1].replace(/^["']|["']$/g, '').trim() || undefined : undefined;
  };

  const id = str(listing.id) ?? yscalar('id') ?? ref;
  // Aliases come ONLY from listing.json — a retirement is a deliberate,
  // reviewed act, so there is no manifest fallback that could invent one.
  // Non-string and blank entries are dropped rather than failing the read: a
  // malformed alias must not make an otherwise-valid template unresolvable.
  const aliases = Array.isArray(listing.aliases)
    ? [...new Set(listing.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim()))]
    : [];
  return {
    ref,
    id,
    aliases,
    title: str(listing.title) ?? id,
    description: str(listing.description) ?? '',
    category: str(listing.category) ?? yscalar('category') ?? null,
    scope: str(listing.scope) ?? yscalar('scope') ?? null,
    version: str(listing.version) ?? yscalar('version') ?? '0.1.0',
    source: str(listing.source) ?? (layer === 'user' ? 'installed' : 'first-party'),
    dir,
    layer,
    hasListing,
  };
}

/**
 * Shadow policy (WI-37781). The user layer is the v2 install target and normally
 * wins on a ref collision — that is deliberate. What is NOT acceptable is an
 * INCOMPLETE user dir (no listing.json) silently replacing a COMPLETE official
 * template, which downgrades it to an untitled, undescribed, non-official entry
 * with no signal anywhere. That is the shape a half-written install leaves
 * behind: an interrupted clone, a partial v2 marketplace write, a hand-copied
 * dir. A listing-less user dir with no bundled collision still resolves fine, so
 * the supported v2 "template.yaml only" install is unaffected.
 */
export function mayTemplateShadow(
  next: LocalTemplate,
  prev: LocalTemplate,
): { allow: boolean; reason?: string } {
  if (next.layer === 'user' && !next.hasListing && prev.hasListing) {
    return {
      allow: false,
      reason:
        `user-layer dir ${next.dir} has no listing.json and would downgrade the ` +
        `${prev.source} template "${prev.title}" to an untitled entry — keeping the ${prev.layer} one. ` +
        `Add listing.json to that dir, or remove it if it is stale residue.`,
    };
  }
  return { allow: true };
}

/**
 * Enumerate every template across the layered roots. A user-layer ref shadows a
 * bundled one. Non-dir entries (README.md) and dirs without a manifest are skipped.
 */
export function listLocalTemplates(roots: TemplateRoot[] = templateRoots()): LocalTemplate[] {
  return listLocalTemplatesWithShadows(roots).templates;
}

/**
 * Same enumeration, but ALSO returns every cross-layer ref collision — allowed
 * or refused. Callers that render a template list should surface `shadows` so a
 * degraded/overridden official template is visible instead of silent (WI-37781).
 */
export function listLocalTemplatesWithShadows(roots: TemplateRoot[] = templateRoots()): {
  templates: LocalTemplate[];
  shadows: ShadowEvent[];
} {
  // Enumeration + user-shadows-bundled + sort live in the shared read core
  // (self-describing-store.ts, extracted for the rubric-store sibling).
  const shadows: ShadowEvent[] = [];
  const templates = enumerateSelfDescribingDirs(roots, readTemplateDir, {
    mayShadow: mayTemplateShadow,
    onShadow: (e) => shadows.push(e),
  });
  return { templates, shadows };
}

/**
 * Resolve one template by ref (or id), together with any cross-layer collision
 * affecting THAT template (WI-37839 follow-up).
 *
 * `resolveLocalTemplate` discards the shadow report, which meant a REFUSED shadow
 * was silent on the materialize path: `templates:list` showed the collision, but a
 * builder going straight to get-guide / new-app got no hint that the user-layer dir
 * they had just installed was being ignored. The refusal still protected them; they
 * simply could not tell it had happened, which is the half of "refuse OR visibly
 * report" that was missing.
 */
export function resolveLocalTemplateWithShadows(
  idOrRef: string,
  roots: TemplateRoot[] = templateRoots(),
): { template: LocalTemplate | null; shadows: ShadowEvent[] } {
  const key = (idOrRef ?? '').trim();
  if (!key) return { template: null, shadows: [] };
  const { templates, shadows } = listLocalTemplatesWithShadows(roots);
  // ORDER IS LOAD-BEARING (D-002): a real ref/id ALWAYS beats an alias, so a
  // retired name that is later reused by a genuine template takes its handle
  // back automatically, and no alias can ever shadow a live template. Only
  // when nothing owns the key do we fall through to the retirement aliases.
  const template =
    templates.find((t) => t.ref === key || t.id === key) ??
    templates.find((t) => t.aliases.includes(key)) ??
    null;
  return {
    template,
    shadows: template ? shadows.filter((s) => s.ref === template.ref) : [],
  };
}

/** Resolve one template by ref (or id) from the local store, or null. */
export function resolveLocalTemplate(
  idOrRef: string,
  roots: TemplateRoot[] = templateRoots(),
): LocalTemplate | null {
  return resolveLocalTemplateWithShadows(idOrRef, roots).template;
}

/** Identity of the checkout a resolved template dir was read FROM. */
export interface CheckoutProvenance {
  /** Absolute path of the git repo root containing the resolved dir. */
  root: string;
  /** Full HEAD commit sha, or null if unresolved. */
  sha: string | null;
  /** Current branch name, or null on detached HEAD / unresolved. */
  branch: string | null;
}

/**
 * Resolve which checkout a template's local dir was read from — its git root,
 * HEAD sha, and branch (EI-21909845207308404). `templates:new-app` executes
 * inside the operator, and the operator's serving checkout is NOT always the
 * canonical templates repo (e.g. the release checkout can lag staging by a
 * whole green-checkpoint window) — a stale-checkout mismatch is invisible in
 * the tool's result today. Reporting the source checkout's identity alongside
 * the materialized files makes that mismatch diagnosable in the result itself
 * instead of a filesystem-wide grep.
 *
 * Tolerant of a non-git dir: `dir` is normally inside a real checkout, but a
 * provenance lookup failing must never turn into a materialize failure — it
 * returns null rather than throwing.
 */
export function resolveCheckoutProvenance(dir: string): CheckoutProvenance | null {
  const git = (args: string[]): string | null => {
    try {
      const out = execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.trim() || null;
    } catch {
      return null;
    }
  };
  const root = git(['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const sha = git(['rev-parse', 'HEAD']);
  const branchRaw = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;
  return { root, sha, branch };
}

// ── GUIDE read (local mirror of fetchTemplateGuide) ───────────────────────────

/** Guide payloads land in an agent's context — cap the biggest field (matches remote). */
const GUIDE_MAX_CHARS = 60_000;

export interface LocalTemplateGuide {
  ref: string;
  /** 'local' — the store analog of fetchTemplateGuide's git branch. */
  branch: string;
  guide: string;
  guideTruncated: boolean;
  componentCatalog: string | null;
  manifest: string | null;
  fetchedFiles: string[];
}

function readFileOrNull(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Read GUIDE.md (+ COMPONENT_CATALOG.md + template.yaml) from a local template dir. */
export function readLocalGuide(
  t: Pick<LocalTemplate, 'ref' | 'dir'>,
): LocalTemplateGuide | { error: string; status: number } {
  const rawGuide = readFileOrNull(join(t.dir, 'GUIDE.md'));
  if (rawGuide == null) {
    return { error: `GUIDE.md not found for local template "${t.ref}"`, status: 404 };
  }
  const componentCatalog = readFileOrNull(join(t.dir, 'COMPONENT_CATALOG.md'));
  const manifest =
    readFileOrNull(join(t.dir, 'template.yaml')) ?? readFileOrNull(join(t.dir, 'template.yml'));
  const guideTruncated = rawGuide.length > GUIDE_MAX_CHARS;
  const guide = guideTruncated ? rawGuide.slice(0, GUIDE_MAX_CHARS) : rawGuide;
  const fetchedFiles = ['GUIDE.md'];
  if (componentCatalog) fetchedFiles.push('COMPONENT_CATALOG.md');
  if (manifest) fetchedFiles.push(existsSync(join(t.dir, 'template.yaml')) ? 'template.yaml' : 'template.yml');
  return { ref: t.ref, branch: 'local', guide, guideTruncated, componentCatalog, manifest, fetchedFiles };
}

/**
 * Normalize a LocalTemplate to the same TemplateListing shape the remote Cupboard
 * path returns, so `templates:list` can present local + (v2) remote uniformly.
 * `githubUrl` is empty for a local template (the content is on-disk, not cloned).
 */
export function toTemplateListing(t: LocalTemplate): TemplateListing {
  return {
    id: t.id,
    ref: t.ref,
    title: t.title,
    description: t.description,
    githubUrl: '',
    category: t.category ?? undefined,
    scope: t.scope ?? undefined,
    reviewStatus: t.source === 'first-party' ? 'official' : 'local',
  };
}
