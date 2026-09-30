/**
 * The /api/harness/projects/lite payload, extracted from the route so the
 * sync resolver (`harnessProjects.lite`, EI-206) and the registry write seam
 * can share it without importing the endpoint-route module.
 *
 * Cache notes (moved verbatim from the route): the payload is workspace-
 * dependent (loadHarnessRegistry resolves the request-scoped workspace via
 * the x-papercusp-workspace ALS), so entries are KEYED BY WORKSPACE — a
 * single global entry let one window's payload serve ANOTHER workspace's
 * callers for up to the TTL (dock.spec 404 flap, 2026-06-10 forensics).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import { loadHarnessRegistry, isEphemeralForeignProject } from '../harness-registry';
import { harnessDir } from '../harness-core';
import { groupByHive, isRepoLessHiveHome, type HiveGroup, type HiveGroupProject } from './hive-groups';
import { activeWorkspaceId } from '../workspace-registry';

export interface ProjectsLiteEntry {
  slug: string;
  path: string;
  harness_kind: string | null;
  /** A `harness_kind:'hive'` home that IS its own repo checkout (self-hive) — stays selectable. */
  self_repo: boolean | null;
  hive_slug: string | null;
  parent_slug: string | null;
  is_shared: boolean;
  hasState: boolean;
  hasSpec: boolean;
  /**
   * A one-line "brief" for the pot — the first human-meaningful line of its
   * SPEC.md (headings/blank/list markers skipped, capped). Powers the
   * Description column on the All-Pots Working list (PotWorkspaceCards). Null
   * when the pot has no SPEC.md or no usable prose line. This is the
   * "best-available" description: pots carry no first-class description field,
   * and SPEC.md is the one brief nearly every pot has.
   */
  description: string | null;
  harnessDir: string;
}

/**
 * First human-meaningful line of a pot's SPEC.md — a "brief description" for the
 * All-Pots list. Skips markdown headings (`#`), blank lines, and list / quote /
 * code-fence markers; strips light emphasis; caps length. Returns null when the
 * file is unreadable or has no usable prose line. Cheap: scans only until the
 * first hit (SPEC files are small; the lite payload is cached).
 */
async function readPotBrief(specPath: string): Promise<string | null> {
  try {
    const txt = await readFile(specPath, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue; // blank
      if (line.startsWith('#')) continue; // markdown heading
      if (line.startsWith('<!--')) continue; // html comment
      if (/^[-*>|]|^```/.test(line)) continue; // list / quote / table / code fence
      const clean = line.replace(/^\*\*(.*)\*\*$/, '$1').replace(/`/g, '').trim();
      if (!clean) continue;
      return clean.length > 200 ? `${clean.slice(0, 197)}…` : clean;
    }
  } catch {
    /* ignore — unreadable spec = no description */
  }
  return null;
}

export interface ProjectsLitePayload {
  projects: ProjectsLiteEntry[];
  hives: HiveGroup<HiveGroupProject>[];
}

interface LiteCacheEntry {
  ts: number;
  payload: ProjectsLitePayload;
}
// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair: hand-rolling still fixes correctness, but
// the key is invisible to listModuleDuplications(), which then reports a
// confident `[]` while this module is split (EI-19479108855357092).
const __liteState = pinModuleState<{ cache: Map<string, LiteCacheEntry> }>(
  '@papercusp/operator-core.harnessProjectsLiteCache',
  () => ({ cache: new Map() }),
);
const LITE_TTL_MS = 1000;

/**
 * Drop every workspace's cached lite payload (call after a registry write).
 *
 * Clears the pinned map in place. The previous form deleted the globalThis slot
 * outright — reaching past the module into its storage location, which keeps
 * compiling and silently stops busting anything once the state moves.
 */
export function bustProjectsLiteCache(): void {
  __liteState.cache.clear();
}

export async function buildProjectsLitePayload(
  opts: { bypassCache?: boolean; includeHiveHomes?: boolean } = {},
): Promise<ProjectsLitePayload> {
  const now = Date.now();
  // The selectable `projects` list varies by includeHiveHomes, so the variant is
  // part of the cache key (the default — repo-less Hive homes hidden — is what the
  // psu/GUI selectors read).
  const cacheKey = `${activeWorkspaceId()}|${opts.includeHiveHomes ? 'h' : ''}`;
  if (!opts.bypassCache) {
    const hit = __liteState.cache.get(cacheKey);
    if (hit && now - hit.ts < LITE_TTL_MS) return hit.payload;
  }
  const reg = await loadHarnessRegistry();
  // P-012: surface `parent_slug` + `harness_kind` so the AdvShell selector can
  // render a tree (P-014) without paying the full /projects round-trip.
  // parent_slug is a scaffold-time harness contract artifact in
  // .papercusp/config.json (NOT a migrated HarnessConfig field —
  // deprecate-harness-config-json-2026-06-06 D-005); the file persists for it.
  // WI-1937: an ephemeral P-104 foreign-clone registry row is not a real
  // harness a human registered — never surface it to the UI/GUI selectors or
  // the Hive grouping. (A slug-scoped `.find()` lookup elsewhere is UNaffected
  // — this filter is enumeration-only, per the ProjectEntry.ephemeral_foreign
  // doc comment.)
  const registeredProjects = reg.projects.filter((p) => !isEphemeralForeignProject(p));
  const allProjects = await Promise.all(registeredProjects.map(async (p): Promise<ProjectsLiteEntry> => {
    const hDir = harnessDir(p);
    const cfgPath = join(p.path, '.papercusp', 'config.json');
    let parentSlug: string | null = null;
    try {
      if (existsSync(cfgPath)) {
        const txt = await readFile(cfgPath, 'utf8');
        const j = JSON.parse(txt) as { parent_slug?: unknown };
        parentSlug = typeof j?.parent_slug === 'string' && j.parent_slug ? j.parent_slug : null;
      }
    } catch { /* ignore — bad config = no parent */ }
    const isShared = existsSync(join(p.path, '.papercusp', 'shared.json'));
    const specPath = join(p.path, 'SPEC.md');
    const hasSpec = existsSync(specPath);
    // Best-available one-line brief for the All-Pots list (SPEC.md first prose
    // line). Read only when a SPEC exists; cheap + parallel with the config read.
    const description = hasSpec ? await readPotBrief(specPath) : null;
    return {
      slug: p.slug,
      path: p.path,
      harness_kind: (p as { harness_kind?: string }).harness_kind ?? null,
      self_repo: (p as { self_repo?: boolean }).self_repo ?? null,
      // FORMAL Hive membership (shared-hive-federation): a registry field, so
      // grouping over it needs no PG `hives`-table read (harnesses-tab P-021).
      hive_slug: (p as { hive_slug?: string }).hive_slug ?? null,
      parent_slug: parentSlug,
      is_shared: isShared,
      hasState: existsSync(hDir),
      hasSpec,
      description,
      harnessDir: hDir,
    };
  }));
  // P-021 — the registry exposes the Hive grouping NATIVELY so the client
  // (buildHarnessSelectOptions, member rail, all-mode cards) stops
  // tree-inferring it. Grouped over the formal `harness_kind:'hive'` home +
  // `hive_slug`, with `parent_slug` legacy fallback (D-002/D-008 seam).
  // Grouping is computed over ALL projects (incl. repo-less Hive homes) so the
  // Hive-grouping consumers (PR settings, member rail) keep the full structure.
  const hives = groupByHive(allProjects as unknown as HiveGroupProject[]);
  // `projects` is the flat SELECTABLE list the psu/GUI harness selectors read: hide
  // repo-less Hive homes by default (self-hives like papercusp keep their repo + stay).
  const projects = opts.includeHiveHomes
    ? allProjects
    : allProjects.filter((p) => !isRepoLessHiveHome(p));
  const payload: ProjectsLitePayload = { projects, hives };
  __liteState.cache.set(cacheKey, { ts: Date.now(), payload });
  return payload;
}
