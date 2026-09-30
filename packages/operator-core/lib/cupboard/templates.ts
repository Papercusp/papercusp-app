/**
 * Cupboard app-template read helpers (WI-3198) — the data layer behind the
 * `templates:*` MCP verbs.
 *
 * The whole Cupboard/marketplace surface is HTTP-only (`/api/cupboard/*` proxy →
 * the operator-public CF worker); its clients were the desktop UI + the Rust TUI.
 * An agent working through MCP with no shell could SEE that app-templates exist
 * (plan app-templates-2026-07-04 publishes them as `kind=template` listings) but
 * had no verb to browse them or read a template's GUIDE. These helpers wrap the
 * live Cupboard so `templates:list` / `templates:get-guide` (and later
 * `templates:new-app`) can reach it — reusing the same `resolveCupboardBaseUrl()`
 * the publish/install proxies use.
 *
 * Template CONTENT is NOT in this checkout — it lives in the public mirror repo
 * (`github_url`, e.g. https://github.com/Papercusp/templates), one subdir per
 * template keyed by `listing_ref` (e.g. `papercusp-app`). GUIDE.md is read
 * straight from raw.githubusercontent (public mirror ⇒ no auth, no clone needed).
 */
import { resolveCupboardBaseUrl } from './base-url';

const UA = { 'User-Agent': 'papercusp-operator/1' } as const;
const TIMEOUT_MS = 10_000;

/** A Cupboard `kind=template` listing, normalized to the fields agents care about. */
export interface TemplateListing {
  /** Listing uuid (stable id for detail / materialize). */
  id: string;
  /** listing_ref — the within-repo subdir AND the human handle (e.g. `papercusp-app`). */
  ref: string;
  title: string;
  description: string;
  /** The mirror repo the template lives in (e.g. https://github.com/Papercusp/templates). */
  githubUrl: string;
  /** Browse axis (app|agentic|shell|data|search|ui|release|design) — present when the worker returns it. */
  category?: string;
  /** Structural axis (app|aspect) — present when the worker returns it. */
  scope?: string;
  reviewStatus?: string;
}

function toListing(row: Record<string, unknown>): TemplateListing | null {
  const id = typeof row.id === 'string' ? row.id : '';
  const ref = typeof row.listing_ref === 'string' ? row.listing_ref : '';
  if (!id && !ref) return null;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  return {
    id,
    ref,
    title: str(row.title) ?? ref,
    description: str(row.description) ?? '',
    githubUrl: str(row.github_url) ?? '',
    category: str(row.category),
    scope: str(row.scope),
    reviewStatus: str(row.review_status),
  };
}

export interface FetchTemplatesResult {
  /** false ⇒ the Cupboard was unreachable / errored (the caller should say so, not "none exist"). */
  reachable: boolean;
  templates: TemplateListing[];
}

/**
 * GET {cupboard}/listings?kind=template — the app-template storefront.
 * `q` is forwarded to the worker's server-side search. Never throws — an
 * unreachable Cupboard returns { reachable:false, templates:[] }.
 */
export async function fetchCupboardTemplates(
  opts: { q?: string; limit?: number } = {},
): Promise<FetchTemplatesResult> {
  const base = resolveCupboardBaseUrl();
  const url = new URL(`${base}/listings`);
  url.searchParams.set('kind', 'template');
  url.searchParams.set('limit', String(Math.min(Math.max(opts.limit ?? 50, 1), 200)));
  if (opts.q && opts.q.trim()) url.searchParams.set('q', opts.q.trim());
  try {
    const res = await fetch(url.toString(), { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { reachable: false, templates: [] };
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> } | null;
    const templates = (data?.results ?? [])
      .map(toListing)
      .filter((t): t is TemplateListing => t !== null);
    return { reachable: true, templates };
  } catch {
    return { reachable: false, templates: [] };
  }
}

/**
 * Resolve a template by listing id (uuid) OR listing_ref (the human handle like
 * `papercusp-app`). Tries the detail endpoint first (uuid), then falls back to
 * a kind=template scan matched by ref/id. Kind-checked: a non-template listing is
 * rejected so this can't be pointed at a blueprint/plugin repo.
 */
export async function resolveTemplateListing(
  idOrRef: string,
): Promise<TemplateListing | { error: string; status: number }> {
  const key = (idOrRef ?? '').trim();
  if (!key) return { error: 'template id or ref required', status: 400 };
  const base = resolveCupboardBaseUrl();
  // Detail-by-id first (the uuid path). A ref (non-uuid) usually 404s here → the scan below.
  try {
    const res = await fetch(`${base}/listings/${encodeURIComponent(key)}`, {
      headers: UA,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown> | null;
      const row =
        (data?.harness as Record<string, unknown> | undefined) ??
        (data?.listing as Record<string, unknown> | undefined) ??
        (data as Record<string, unknown> | undefined);
      if (row) {
        if (row.listing_kind != null && row.listing_kind !== 'template') {
          return { error: `listing ${key} is kind=${String(row.listing_kind)}, not a template`, status: 422 };
        }
        const t = toListing(row);
        if (t && (t.id || t.ref)) return t;
      }
    }
  } catch {
    /* fall through to the ref scan */
  }
  const { reachable, templates } = await fetchCupboardTemplates({ limit: 200 });
  if (!reachable) return { error: 'cupboard_unreachable', status: 503 };
  const hit = templates.find((t) => t.ref === key || t.id === key);
  if (!hit) return { error: `template not found: ${key}`, status: 404 };
  return hit;
}

// ── GUIDE fetch: read the build knowledge without a full clone ────────────────

/** listing_ref is a within-repo path segment we interpolate into a URL — bound it. */
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

/** https://github.com/<owner>/<repo>(.git)? → https://raw.githubusercontent.com/<owner>/<repo> */
export function rawBaseFromGithub(githubUrl: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec((githubUrl ?? '').trim());
  if (!m) return null;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}`;
}

export interface TemplateGuide {
  ref: string;
  branch: string;
  guide: string;
  guideTruncated: boolean;
  componentCatalog: string | null;
  /** Raw template.yaml (the checks/components manifest) if present. */
  manifest: string | null;
  fetchedFiles: string[];
}

/** Guide payloads are read into an agent's context — cap the biggest field. */
const GUIDE_MAX_CHARS = 60_000;

async function fetchRaw(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Fetch a template's GUIDE.md (+ COMPONENT_CATALOG.md + template.yaml) from the
 * public mirror at `<repo>/<ref>/`, trying `main` then `master`. Read-only; the
 * mirror is public so no git-clone / auth is needed for the build knowledge.
 */
export async function fetchTemplateGuide(t: {
  githubUrl: string;
  ref: string;
}): Promise<TemplateGuide | { error: string; status: number }> {
  if (!SAFE_REF_RE.test(t.ref)) return { error: `unsafe template ref ${JSON.stringify(t.ref)}`, status: 400 };
  const rawBase = rawBaseFromGithub(t.githubUrl);
  if (!rawBase) return { error: `template github_url is not a github repo: ${t.githubUrl}`, status: 422 };
  for (const branch of ['main', 'master']) {
    const rawGuide = await fetchRaw(`${rawBase}/${branch}/${t.ref}/GUIDE.md`);
    if (rawGuide == null) continue; // not on this branch — try the next
    const [componentCatalog, manifestYaml, manifestYml] = await Promise.all([
      fetchRaw(`${rawBase}/${branch}/${t.ref}/COMPONENT_CATALOG.md`),
      fetchRaw(`${rawBase}/${branch}/${t.ref}/template.yaml`),
      fetchRaw(`${rawBase}/${branch}/${t.ref}/template.yml`),
    ]);
    const guideTruncated = rawGuide.length > GUIDE_MAX_CHARS;
    const guide = guideTruncated ? rawGuide.slice(0, GUIDE_MAX_CHARS) : rawGuide;
    const manifest = manifestYaml ?? manifestYml;
    const fetchedFiles = ['GUIDE.md'];
    if (componentCatalog) fetchedFiles.push('COMPONENT_CATALOG.md');
    if (manifest) fetchedFiles.push(manifestYaml ? 'template.yaml' : 'template.yml');
    return { ref: t.ref, branch, guide, guideTruncated, componentCatalog, manifest, fetchedFiles };
  }
  return { error: `GUIDE.md not found for template "${t.ref}" on main or master`, status: 404 };
}
