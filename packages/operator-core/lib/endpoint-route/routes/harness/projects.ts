/**
 * Top-level harness registry routes:
 *
 *   GET    /api/harness/projects/lite     — small payload for sidebar polling
 *   GET    /api/harness/projects          — full enriched list (parent_slug + hasState + hasSpec)
 *   POST   /api/harness/projects          — register a new harness in the workspace
 *   DELETE /api/harness/projects/:slug    — remove a harness from the workspace
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 44 — the final batch; harness.ts itself is empty after this).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  loadHarnessRegistry,
  mutateHarnessRegistry,
  isEphemeralForeignProject,
  type ProjectEntry,
} from '../../../harness-registry';
import { harnessDir } from '../../../harness-core';
import { HIVE_KIND } from '../../../harness/hive-groups';
import {
  buildProjectsLitePayload,
  bustProjectsLiteCache,
} from '../../../harness/projects-lite';
import { defineTool } from '@papercusp/agent-mcp';

// SSR self-fetch site for /harness/<slug>/page.tsx — every page render
// fans through here. The payload build + per-workspace cache live in
// ../../../harness/projects-lite so the sync resolver (harnessProjects.lite,
// EI-206) shares them.
const lite = defineTool({
  method: 'GET',
  path: '/harness/projects/lite',
  auth: 'public',
  async handler() {
    return Response.json(await buildProjectsLitePayload());
  },
});

// Cache the /projects payload — the underlying data (registry contents,
// SPEC.md presence, parent_slug, hasState) only changes when a harness is
// spawned/forked/deleted. Without this, /projects opens N per-slug PG
// connections per call; under c=10 that's 10×70 ≈ 700 connections in
// flight. With a 5s TTL keyed on the registry mtime, concurrent callers
// share one walk; the cache busts when the registry file is rewritten.
interface ProjectsCacheEntry {
  sig: string;
  expires: number;
  inflight: Promise<unknown[]> | null;
  value: unknown[] | null;
}
// Realm-pinned rather than hand-rolled on globalThis. This cache exists so that
// concurrent callers SHARE one registry walk (see the ~700-connections note above),
// and that sharing is only real if every caller reaches the SAME entry: a split
// module record would give each copy its own `inflight`, silently restoring the
// connection stampede this was written to prevent. Key string unchanged.
const __projectsCache: ProjectsCacheEntry = pinModuleState<ProjectsCacheEntry>(
  'papercusp.harnessProjectsCache',
  () => ({ sig: '', expires: 0, inflight: null, value: null }),
);

export interface EnrichedProject extends ProjectEntry {
  hasState: boolean;
  hasSpec: boolean;
  harnessDir: string;
  parent_slug: string | null;
}

/**
 * Probe which of `slugs` have any pipeline state, in ONE batched query on the
 * shared org pool (EI-64). The previous shape opened a PER-SLUG PG pool per
 * project (getLegacyClient(slug) → getHarnessPg) to query the now-removed
 * harness_features relation — N pool opens that blew the 30s route budget on a
 * cold cache (76s/HTTP 408 on :3070). work_items is the unified work surface
 * (D-015) the old "has pipeline state" semantics map to.
 */
async function fetchHasStateSlugsFromOrgPg(slugs: readonly string[]): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const { sql } = getOrgPg();
  const rows = await sql<{ harness_slug: string }[]>`
    SELECT DISTINCT harness_slug
      FROM harness_shared.work_items
     WHERE harness_slug = ANY(${slugs as string[]})
  `;
  return new Set(rows.map((r) => r.harness_slug));
}

/**
 * Enrich the registry projects for GET /api/harness/projects: hasState (one
 * batched probe), hasSpec + parent_slug (per-project fs stat/read), harnessDir.
 *
 * The hasState probe is injected (`fetchHasStateSlugs`) so the cold-path cost
 * model is unit-testable: the regression this guards (EI-64) was N per-slug PG
 * pool opens, so the test pins that the fetcher is called EXACTLY ONCE with all
 * slugs — never once per project. Exported for that test.
 */
export async function enrichProjects(
  projects: readonly ProjectEntry[],
  fetchHasStateSlugs: (slugs: readonly string[]) => Promise<Set<string>> = fetchHasStateSlugsFromOrgPg,
): Promise<EnrichedProject[]> {
  let hasStateSlugs: Set<string> = new Set();
  try {
    hasStateSlugs = await fetchHasStateSlugs(projects.map((p) => p.slug));
  } catch {
    /* degrade: hasState=false for all, as before */
  }
  return Promise.all(projects.map(async (p) => {
    const cfgPath = join(p.path, '.papercusp', 'config.json');
    const specPath = join(p.path, 'SPEC.md');
    let parentSlug: string | null = null;
    try {
      if (existsSync(cfgPath)) {
        const j = JSON.parse(await readFile(cfgPath, 'utf8'));
        parentSlug = typeof j?.parent_slug === 'string' && j.parent_slug ? j.parent_slug : null;
      }
    } catch {
      parentSlug = null;
    }
    return {
      ...p,
      hasState: hasStateSlugs.has(p.slug),
      hasSpec: existsSync(specPath),
      harnessDir: harnessDir(p),
      parent_slug: parentSlug,
    };
  }));
}

const list = defineTool({
  method: 'GET',
  path: '/harness/projects',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const reg = await loadHarnessRegistry();
    const filterParentSlug = url.searchParams.get('parent_slug');

    // WI-1937: an ephemeral P-104 foreign-clone row is not a real harness a
    // human registered — never list it on the main /api/harness/projects
    // enumeration. (A slug-scoped lookup elsewhere, e.g. scan-subharnesses,
    // is unaffected — this filter is this enumeration route only.)
    const listedProjects = reg.projects.filter((p) => !isEphemeralForeignProject(p));

    // The registry is PG-canonical (mig 025) — derive the signature from its
    // CONTENTS. The previous signature additionally stat'd two dead files
    // (<workspace-root>/registry.json + ~/.restart-harness-projects.json),
    // so path/hive edits with an unchanged slug list never busted the cache
    // (audit P-005).
    const sig = JSON.stringify(listedProjects);

    const now = Date.now();
    const TTL_MS = 5_000;

    let enriched = __projectsCache.value;
    if (!(enriched && __projectsCache.sig === sig && __projectsCache.expires > now)) {
      if (!__projectsCache.inflight || __projectsCache.sig !== sig) {
        __projectsCache.sig = sig;
        __projectsCache.inflight = (async () => {
          // ONE batched probe on the shared org pool (audit P-005, EI-64) +
          // per-project fs stats — see enrichProjects. The previous shape opened
          // a PER-SLUG PG pool per project, blowing the 30s route budget cold.
          const out = await enrichProjects(listedProjects);
          __projectsCache.value = out;
          __projectsCache.expires = Date.now() + TTL_MS;
          __projectsCache.inflight = null;
          return out;
        })();
      }
      enriched = await __projectsCache.inflight;
    }

    const filtered = filterParentSlug
      ? (enriched as Array<{ parent_slug: string | null }>).filter((p) => p.parent_slug === filterParentSlug)
      : enriched;
    return Response.json({ projects: filtered });
  },
});

const create = defineTool({
  method: 'POST',
  path: '/harness/projects',
  auth: 'loopback',
  // The GitHub-URL entry clones before it registers, which can far exceed the
  // default route timeout (same budget as /harness/pots/from-repo).
  timeoutSec: 600,
  async handler(req) {
    const body = (await req.json()) as Record<string, unknown>;
    const slug = String(body.slug ?? '').trim();
    if (!slug) return Response.json({ error: 'slug required' }, { status: 400 });

    const reg = await loadHarnessRegistry();
    if (reg.projects.some((p) => p.slug === slug)) {
      return Response.json({ error: 'slug already exists' }, { status: 409 });
    }

    // P-011 (harnesses-tab-hive-model) — "add into hive": when the picker's
    // add-into-hive mode passes `hive` (the current `?slug=` scope), stamp the
    // membership edge to that scope. Validate FAIL-FAST here, before any dir/
    // clone side effect (mirrors harness:create's gate). Membership precedence
    // matches the grouping (hive-groups.ts): a FORMAL `kind:'hive'` home → the
    // `hive_slug` registry field (shared-hive-federation); a legacy root scope →
    // `parent_slug` in the new harness's .papercusp/config.json (the Phase-1
    // edge). Either way the new harness groups under that scope in the rail.
    const hiveScope = typeof body.hive === 'string' ? body.hive.trim() : '';
    const membershipResult = resolveProjectHiveMembership(reg.projects, hiveScope);
    if (!membershipResult.ok) {
      return Response.json({ error: membershipResult.error, code: membershipResult.code }, { status: 404 });
    }
    const membership = membershipResult.membership;

    // Resolve the harness path from the body shape — supports three
    // entry points so far (papercusp-dogfood-v5 §3 P-008/P-009/P-010):
    //   Entry 1 — new local dir:    { slug, parentDir, folderName }
    //                              → mkdir + git init then falls through.
    //   Entry 3 — existing folder:  { slug, path }
    //   Entry 2 — GitHub URL:       { slug, githubUrl, shallow? }
    //                              → clones to ~/.papercusp-workspaces/clones/<repo>
    //                                then falls through to the path flow.
    let path: string;
    let cloneInfo: { url: string; owner: string; repo: string } | null = null;
    // P-002 (hive-from-github-url-2026-06-11): upstream coords persisted on the
    // registry entry so the directory announce derivation (member_repos) and the
    // fork-PR repo-context fallback can read them later.
    let githubCoords: {
      github_remote: string;
      github_repository_id?: number;
      github_default_branch?: string;
    } | null = null;
    let initInfo: { parentDir: string; folderName: string; initialized: boolean } | null = null;

    const githubUrl = typeof body.githubUrl === 'string' ? body.githubUrl.trim() : '';
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    const parentDir = typeof body.parentDir === 'string' ? body.parentDir.trim() : '';
    const folderName = typeof body.folderName === 'string' ? body.folderName.trim() : '';

    if (parentDir && folderName) {
      const { initLocalHarnessDir, InitLocalDirError } = await import('../../../harness/init-local-dir');
      try {
        const initResult = await initLocalHarnessDir({ parentDir, folderName });
        path = initResult.path;
        initInfo = { parentDir, folderName, initialized: initResult.initialized };
      } catch (e: unknown) {
        if (e instanceof InitLocalDirError) {
          const httpStatus =
            e.code === 'invalid_path'   ? 400 :
            e.code === 'parent_missing' ? 400 :
            e.code === 'dest_exists'    ? 409 :
            e.code === 'git_missing'    ? 500 :
                                          500;
          return Response.json(
            { error: e.message, code: e.code, detail: e.detail },
            { status: httpStatus },
          );
        }
        throw e;
      }
    } else if (githubUrl) {
      const { cloneGithubRepo, isCloneError } = await import('../../../harness/clone-github');
      const cloneResult = await cloneGithubRepo(githubUrl, {
        shallow: body.shallow === true,
      });
      if (isCloneError(cloneResult)) {
        const httpStatus =
          cloneResult.code === 'invalid_url'    ? 400 :
          cloneResult.code === 'dest_exists'    ? 409 :
          cloneResult.code === 'auth_required'  ? 401 :
          cloneResult.code === 'not_found'      ? 404 :
          cloneResult.code === 'git_missing'    ? 500 :
                                                  502;
        return Response.json(
          { error: cloneResult.message, code: cloneResult.code },
          { status: httpStatus },
        );
      }
      path = cloneResult.path;
      cloneInfo = {
        url: githubUrl,
        owner: cloneResult.parsed.owner,
        repo: cloneResult.parsed.repo,
      };
      githubCoords = {
        github_remote: cloneResult.parsed.cloneUrl,
        ...(cloneResult.defaultBranch ? { github_default_branch: cloneResult.defaultBranch } : {}),
      };
      // Best-effort API enrichment: the immutable repo id + the authoritative
      // default branch need gh auth; an unauthenticated public clone still
      // registers with the clone-derived branch only.
      try {
        const { getOctokit } = await import('../../../identity/octokit-client');
        const octokit = await getOctokit();
        if (octokit) {
          const { data } = await octokit.rest.repos.get({
            owner: cloneResult.parsed.owner,
            repo: cloneResult.parsed.repo,
          });
          githubCoords.github_repository_id = data.id;
          if (data.default_branch) githubCoords.github_default_branch = data.default_branch;
        }
      } catch { /* best-effort — registration proceeds without API coords */ }
    } else if (rawPath) {
      path = resolve(rawPath);
      if (!existsSync(path)) {
        return Response.json({ error: 'path does not exist' }, { status: 400 });
      }
    } else {
      return Response.json(
        { error: 'one of `path` or `githubUrl` is required' },
        { status: 400 },
      );
    }

    // FORMAL membership rides on the registry entry; legacy membership is written
    // to the new harness's config.json below (after the dir exists).
    // Atomic insert (audit P-006 / EI-82): the dup check at the top of the
    // handler raced any concurrent register between our read and this save —
    // re-check inside the serialized mutation.
    let dupRace = false;
    await mutateHarnessRegistry((cur) => {
      if (cur.projects.some((p) => p.slug === slug)) {
        dupRace = true;
        return cur;
      }
      const entry = {
        slug,
        path,
        ...(membership?.kind === 'hive_slug' ? { hive_slug: membership.value } : {}),
        ...(githubCoords ?? {}),
      };
      return { ...cur, projects: [...cur.projects, entry] };
    });
    if (dupRace) {
      return Response.json({ error: 'slug already exists' }, { status: 409 });
    }

    // Legacy `parent_slug` membership (the Phase-1 edge): self-describing in the
    // new harness's .papercusp/config.json, same shape registerSubs writes.
    if (membership?.kind === 'parent_slug') {
      try {
        const { writeFile, mkdir } = await import('node:fs/promises');
        const cfgDir = join(path, '.papercusp');
        const cfgPath = join(cfgDir, 'config.json');
        let prior: Record<string, unknown> = {};
        try {
          if (existsSync(cfgPath)) prior = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
        } catch { /* malformed = overwrite with our addition */ }
        if (prior.parent_slug !== membership.value) {
          if (!existsSync(cfgDir)) await mkdir(cfgDir, { recursive: true });
          await writeFile(cfgPath, JSON.stringify({ ...prior, parent_slug: membership.value }, null, 2), 'utf8');
        }
      } catch { /* best-effort — registration succeeded; membership is a soft edge */ }
    }
    // Bust the lite/projects caches so the new member appears in the rail + the
    // hive grouping on the next poll (membership changed the grouping).
    bustProjectsLiteCache();
    __projectsCache.expires = 0;

    // Entry-seam migration (deprecate-harness-config-json-2026-06-06): a harness
    // that ARRIVES with a legacy `.papercusp/config.json` (a gym substrate, an
    // externally-scaffolded repo, a clone) gets its instance content (phase/phases/
    // dept + knob overrides like parallelWorkers.workingStateCheck) lifted into the
    // workspace-PG registry HERE — the live config path never reads the file.
    // Best-effort: never blocks registration.
    let migratedConfigFields: string[] = [];
    try {
      const { migrateConfigJsonToInstance } = await import('../../../deployment/instance-config');
      const { activeWorkspaceId } = await import('../../../workspace-registry');
      const r = await migrateConfigJsonToInstance(slug, activeWorkspaceId());
      migratedConfigFields = r.fields;
    } catch { /* ignore — registration succeeded; config lift is best-effort */ }

    let provisioning: { ok: true } | { ok: false; error: string };
    try {
      const { scaffoldHarnessSchema } = await import('../../../scaffold-harness-schema');
      await scaffoldHarnessSchema(slug);
      provisioning = { ok: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      provisioning = { ok: false, error: msg.slice(0, 300) };
    }

    // P-010 (hive-from-github-url / D-007) — standalone-from-URL: a cloned repo
    // gets a detection-generated blueprint so it is immediately runnable, like
    // the from-repo hive path. EI-665: Entry 1 (fresh `parentDir`+`folderName`
    // init) and Entry 3 (`path`, an existing folder) hit this SAME registration
    // route but previously got NEITHER a blueprint NOR (for Entry 1) an initial
    // commit — diverging from harness:create's documented contract ("writes the
    // git-canonical .papercusp/blueprint.yaml") and leaving Entry 1's fresh repo
    // on an unborn HEAD ("does not have any commits yet"). Extend the same
    // best-effort detection-generated blueprint to those two entries too; opt out
    // with generateBlueprint:false. runTests defaults FALSE in this HTTP path (no
    // 2-min verify inline) — re-verify later via harness:generate-from-repo.
    let blueprint: import('../../../harness/generate-blueprint-for-clone').GenerateBlueprintForCloneResult | undefined;
    if ((cloneInfo || initInfo || rawPath) && body.generateBlueprint !== false) {
      const { generateBlueprintForClone } = await import(
        '../../../harness/generate-blueprint-for-clone'
      );
      blueprint = await generateBlueprintForClone(slug, path, {
        runTests: body.runTests === true,
      });
    }

    // EI-665 cont'd: a fresh Entry-1 `git init` is a bare repo with no commit and
    // no branch — the same "unborn HEAD freezes origin" hazard `createPotHarness`
    // guards against for a new Hive home (per-hive-git-and-release-gate D-003).
    // Give Entry 1 / Entry 3 harnesses the same initial-commit treatment: stage
    // the now-written scaffold and commit on `staging`. No-op (committed:false)
    // when the repo already has history (a re-registered existing folder) or no
    // `.git` at all (a repo-less/non-git existing folder) — safe to call
    // unconditionally. Best-effort: never fails the create.
    let repoInit: import('../../../harness/hive-repo-init').CommitInitialResult | undefined;
    if (initInfo || rawPath) {
      try {
        const { commitInitialHiveRepo } = await import('../../../harness/hive-repo-init');
        repoInit = await commitInitialHiveRepo({ path, slug });
      } catch (e) {
        console.warn(
          `[harness/projects] initial-commit failed (${slug}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return Response.json({
      ok: true,
      project: { slug, path },
      provisioning,
      ...(membership ? { membership: { hive: membership.value, edge: membership.kind } } : {}),
      ...(migratedConfigFields.length > 0 ? { migratedConfig: migratedConfigFields } : {}),
      ...(cloneInfo
        ? {
            clone: {
              ...cloneInfo,
              ...(githubCoords?.github_repository_id !== undefined
                ? { repoId: githubCoords.github_repository_id }
                : {}),
              ...(githubCoords?.github_default_branch
                ? { defaultBranch: githubCoords.github_default_branch }
                : {}),
            },
          }
        : {}),
      ...(initInfo ? { init: initInfo } : {}),
      ...(blueprint ? { blueprint } : {}),
      ...(repoInit ? { repoInit } : {}),
    });
  },
});

/**
 * P-010 (harnesses-tab-hive-model) — "new hive from blueprint": stand up a new
 * Hive home (a `kind:'hive'` harness running the pot/Queen blueprint). The thin
 * HTTP face over the canonical `createPotHarness` primitive (hive-tool-namespace
 * `pot:create`) so the CreateHarnessPicker's new-hive mode reaches it without an
 * MCP round-trip — reuses the team's transactional provision (no duplication).
 */
const createHive = defineTool({
  method: 'POST',
  path: '/harness/pots',
  auth: 'loopback',
  // Provisioning (dir, git init, blueprint, knowledge pack, repo publish) takes
  // 10–25s at normal load and minutes on a busy box; the 30s default answered
  // 408 for pots that were then created (WI-10003268).
  timeoutSec: 180,
  async handler(req) {
    let body: { slug?: string; path?: string; parentDir?: string; wakeInSeconds?: number; knowledgePack?: string | null; blueprintId?: string } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty body */ }
    const slug = String(body.slug ?? '').trim();
    if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return Response.json({ error: 'a valid lowercase slug is required', code: 'invalid_slug' }, { status: 400 });
    }
    // domain-generic-hive P-006: the picker's domain headings (work hive,
    // Comb-blueprint) pick a NON-default kind:'hive' blueprint. Absent ⇒
    // createPotHarness's default (the coding `hive`). createPotHarness
    // resolves + validates kind:'hive', so an invalid id surfaces as a 400.
    const blueprintId = typeof body.blueprintId === 'string' && body.blueprintId.trim() ? body.blueprintId.trim() : undefined;
    const { createPotHarness } = await import('../../../agent-tools/pot/_create');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    // LINK-EXISTING ("every created Pot is a hive"): a `path` body field links an
    // existing local repo in place as the hive home (existingPath → use AS-IS, no
    // fresh dir, no delete-on-rollback). Otherwise fall through to the fresh-dir
    // path under `parentDir/slug`.
    const linkPath = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : '';
    const res = await createPotHarness({
      slug,
      workspaceId: activeWorkspaceId(),
      ...(linkPath
        ? { existingPath: linkPath }
        : { parentDir: typeof body.parentDir === 'string' && body.parentDir.trim() ? body.parentDir.trim() : undefined }),
      wakeInSeconds: typeof body.wakeInSeconds === 'number' ? body.wakeInSeconds : undefined,
      // knowledge-packs P-005/P-006: '' and null ⇒ seed nothing; absent ⇒ default pack.
      ...(body.knowledgePack === null || typeof body.knowledgePack === 'string'
        ? { knowledgePack: body.knowledgePack === '' ? null : body.knowledgePack }
        : {}),
      ...(blueprintId ? { blueprintId } : {}),
    });
    if (!res.ok) {
      const status = res.error === 'slug_exists' || res.error === 'dest_exists' ? 409 : 400;
      return Response.json({ error: res.message, code: res.error }, { status });
    }
    // Bust the registry caches so the new Hive home appears in the selector + grouping.
    bustProjectsLiteCache();
    __projectsCache.expires = 0;
    return Response.json({
      ok: true,
      project: { slug: res.slug, path: res.path },
      hive: true,
      waked: res.waked,
      ...(res.seededLearnings ? { seededLearnings: res.seededLearnings } : {}),
    });
  },
});

/**
 * hive-from-github-url-2026-06-11 P-006 — "create a Hive from a GitHub URL":
 * the HTTP face the CreateHarnessPicker's GitHub-URL entry drives. Thin over
 * the canonical `createPotFromRepo` composition (pot:create_from_repo) —
 * lookup (join offer) → clone → blueprint detection → home + member →
 * auto-publish (visibility derived from repo privacy, never sent by the client).
 * Long timeout: clone + the test-verify run.
 */
const createHiveFromRepoRoute = defineTool({
  method: 'POST',
  path: '/harness/pots/from-repo',
  // Mutating route → loopback per the Wave-1 rule (auth-tier rollout).
  auth: 'loopback',
  // Clone + the blueprint test-verify run can far exceed the default route timeout.
  timeoutSec: 600,
  async handler(req) {
    let body: {
      githubUrl?: string;
      slug?: string;
      shallow?: boolean;
      runTests?: boolean;
      force?: boolean;
      intoHive?: string;
      progressId?: string;
      knowledgePack?: string | null;
      integrationMode?: string;
    } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty body */ }
    const githubUrl = String(body.githubUrl ?? '').trim();
    if (!githubUrl) {
      return Response.json({ error: 'githubUrl required', code: 'invalid_url' }, { status: 400 });
    }
    const { createPotFromRepo } = await import('../../../agent-tools/pot/_create_from_repo');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const { parseIntegrationModeAnswer } = await import('../../../harness/git-sync/integration-mode-question');
    const integrationMode = parseIntegrationModeAnswer(body.integrationMode);
    const res = await createPotFromRepo({
      githubUrl,
      ...(typeof body.slug === 'string' && body.slug.trim() ? { slug: body.slug.trim() } : {}),
      ...(body.shallow !== undefined ? { shallow: body.shallow === true } : {}),
      // D-001 (hardening): test-verify EXECUTES repo code — explicit true only.
      ...(body.runTests === true ? { runTests: true } : {}),
      ...(body.force !== undefined ? { force: body.force === true } : {}),
      ...(typeof body.intoHive === 'string' && body.intoHive.trim()
        ? { intoHive: body.intoHive.trim() }
        : {}),
      // knowledge-packs P-005/P-006: pack picker selection — string pack id,
      // null = seed nothing, absent = default pack.
      ...(body.knowledgePack === null || typeof body.knowledgePack === 'string'
        ? { knowledgePack: body.knowledgePack === '' ? null : body.knowledgePack }
        : {}),
      // P-008: real step progress over the sync channel (client-minted id).
      ...(typeof body.progressId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.progressId)
        ? { progressId: body.progressId }
        : {}),
      // P-017 (D-007): the "where should the agents' work go" answer. Only a
      // known mode is forwarded; anything else reads as unanswered (direct).
      ...(integrationMode ? { integrationMode } : {}),
      workspaceId: activeWorkspaceId(),
    });
    if (!res.ok) {
      const status =
        res.error === 'invalid_url' || res.error === 'invalid_slug' ? 400 :
        res.error === 'hive_not_found' ? 404 :
        res.error === 'slug_exhausted' || res.error.startsWith('clone_dest_exists') ? 409 :
        res.error === 'clone_auth_required' ? 401 :
        res.error === 'clone_not_found' ? 404 :
                                          502;
      return Response.json({ error: res.message ?? res.error, code: res.error, ...(res.cleanup ? { cleanup: res.cleanup } : {}) }, { status });
    }
    // Bust the registry caches so the new Hive + member appear immediately.
    bustProjectsLiteCache();
    __projectsCache.expires = 0;
    return Response.json(res);
  },
});

const remove = defineTool({
  method: 'DELETE',
  path: '/harness/projects/:slug',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    // Atomic remove (audit P-006 / EI-82): the old load→filter→save raced any
    // concurrent registry write — the second save reverted the first.
    let removed = false;
    // Intentional-removal path: deleting the last harness legitimately
    // empties the registry, so opt out of the catastrophic-empty guard.
    await mutateHarnessRegistry((cur) => {
      const projects = cur.projects.filter((p) => p.slug !== slug);
      if (projects.length === cur.projects.length) return cur;
      removed = true;
      return { ...cur, projects };
    }, undefined, { allowEmpty: true });
    if (!removed) return Response.json({ error: 'not found' }, { status: 404 });
    // Bust the registry caches so the removed harness disappears immediately.
    bustProjectsLiteCache();
    __projectsCache.expires = 0;
    return Response.json({ ok: true });
  },
});

/**
 * P-010 — sub-harness classifier (read-only diagnostic).
 *
 * POST /api/harness/projects/scan-subharnesses { slug }
 * Returns the SubmoduleNode list `classify-tree` would register, with
 * each node's qualifiedSlug. Persists nothing — callers preview the
 * result before invoking /register-subs.
 */
const scanSubharnesses = defineTool({
  method: 'POST',
  path: '/harness/projects/scan-subharnesses',
  auth: 'loopback',
  async handler(req) {
    let body: { slug?: string } = {};
    try { body = (await req.json()) as { slug?: string }; } catch { /* empty */ }
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    if (!slug) return Response.json({ error: 'slug required' }, { status: 400 });

    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) return Response.json({ error: 'unknown harness slug' }, { status: 404 });

    const { walkHarnessTree } = await import('../../../harness/classify-tree');
    const nodes = walkHarnessTree(project.path, { parentSlug: slug });
    const submodules = nodes
      .filter((n) => n.kind === 'submodule')
      .map((n) => ({
        relPath: n.relPath,
        absPath: n.absPath,
        qualifiedSlug: (n as { qualifiedSlug: string }).qualifiedSlug,
        gitDirTarget: (n as { gitDirTarget: string }).gitDirTarget,
      }));
    // P-002 (hive-pr-rollup-and-subharness-membership): preview the membership
    // edge /register-subs would write, so the UI preview and the write can't
    // diverge. hive_slug = formal hive membership; parent_slug = legacy edge.
    const potSlug = resolveSubHarnessHiveSlug(project);
    const membership = potSlug
      ? { kind: 'hive_slug' as const, value: potSlug }
      : { kind: 'parent_slug' as const, value: slug };
    return Response.json({
      ok: true,
      rootSlug: slug,
      rootPath: project.path,
      membership,
      submodules,
    });
  },
});

/**
 * P-011 — persist sub-harness registration.
 *
 * POST /api/harness/projects/register-subs { rootSlug }
 * For each submodule the classifier returns, register a
 * `ProjectEntry { slug: qualifiedSlug, path: absPath, harness_kind: 'sub-harness' }`
 * and write `<absPath>/.papercusp/config.json:{ parent_slug: rootSlug }`.
 * Idempotent: skips slugs that already exist but reconciles parent_slug
 * on disk if it drifted. Per D-006 (on-demand) + D-007 (self-describing
 * config).
 */
const registerSubs = defineTool({
  method: 'POST',
  path: '/harness/projects/register-subs',
  auth: 'loopback',
  async handler(req) {
    let body: { rootSlug?: string } = {};
    try { body = (await req.json()) as { rootSlug?: string }; } catch { /* empty */ }
    const rootSlug = typeof body.rootSlug === 'string' ? body.rootSlug.trim() : '';
    if (!rootSlug) return Response.json({ error: 'rootSlug required' }, { status: 400 });

    const reg = await loadHarnessRegistry();
    const root = reg.projects.find((p) => p.slug === rootSlug);
    if (!root) return Response.json({ error: 'unknown root harness slug' }, { status: 404 });

    const { walkHarnessTree } = await import('../../../harness/classify-tree');
    const { writeFile, mkdir } = await import('node:fs/promises');
    const nodes = walkHarnessTree(root.path, { parentSlug: rootSlug });
    const submodules = nodes.filter((n): n is import('../../../harness/classify-tree').SubmoduleNode => n.kind === 'submodule');

    // P-001 (hive-pr-rollup-and-subharness-membership / EI-332): subs of a
    // hive resolve into FORMAL membership — stamp hive_slug on their registry
    // entries so they group as members (hive-groups precedence: formal wins)
    // instead of riding the legacy parent_slug fallback. parent_slug still
    // goes to config.json below for self-description (dogfood-v5 D-007).
    const potSlug = resolveSubHarnessHiveSlug(root);

    const registered: Array<{ slug: string; path: string; created: boolean }> = [];
    const reconciled: Array<{ slug: string; path: string }> = [];
    const errors: Array<{ slug: string; error: string }> = [];

    for (const node of submodules) {
      const subSlug = node.qualifiedSlug;
      const subPath = node.absPath;
      // P-021 safety: reject sub-harness slugs containing path-traversal
      // segments or absolute-path prefixes. classify-tree builds qualifiedSlug
      // from a sanitized relPath, but a defensive check at the registration
      // boundary keeps a malformed classifier output from corrupting the registry.
      if (!isSafeSubHarnessSlug(subSlug)) {
        errors.push({ slug: subSlug, error: 'unsafe slug rejected (path-traversal / absolute / control chars)' });
        continue;
      }
      try {
        const existing = reg.projects.find((p) => p.slug === subSlug);
        let created = false;
        if (!existing) {
          reg.projects.push({
            slug: subSlug,
            path: subPath,
            harness_kind: 'sub-harness',
            ...(potSlug ? { hive_slug: potSlug } : {}),
          });
          created = true;
        }
        // Self-describing parent_slug on disk per D-007.
        const cfgDir = join(subPath, '.papercusp');
        const cfgPath = join(cfgDir, 'config.json');
        let prior: Record<string, unknown> = {};
        try {
          if (existsSync(cfgPath)) {
            prior = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
          }
        } catch { /* malformed = overwrite with our additions */ }
        const desired = { ...prior, parent_slug: rootSlug };
        if (prior.parent_slug !== rootSlug) {
          if (!existsSync(cfgDir)) await mkdir(cfgDir, { recursive: true });
          await writeFile(cfgPath, JSON.stringify(desired, null, 2), 'utf8');
          if (!created) reconciled.push({ slug: subSlug, path: subPath });
        }
        if (created) registered.push({ slug: subSlug, path: subPath, created: true });
      } catch (e) {
        errors.push({ slug: subSlug, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // hive_slug stamped onto ALREADY-registered sub rows whose edge was
    // missing/drifted — re-running Register sub-harnesses IS the backfill
    // path (P-001; no migration, registry blob field).
    const hiveReconciled: string[] = [];
    if (registered.length > 0 || reconciled.length > 0 || potSlug) {
      // Atomic re-apply against the CURRENT registry (audit P-006 / EI-82):
      // the walk above worked on a snapshot; re-insert only what's still new.
      const erroredSlugs = new Set(errors.map((e) => e.slug));
      await mutateHarnessRegistry((cur) => {
        const have = new Set(cur.projects.map((p) => p.slug));
        const additions = registered
          .filter((r) => !have.has(r.slug))
          .map((r) => ({
            slug: r.slug,
            path: r.path,
            harness_kind: 'sub-harness',
            ...(potSlug ? { hive_slug: potSlug } : {}),
          }));
        let changed = additions.length > 0;
        let projects = changed ? [...cur.projects, ...additions] : cur.projects;
        if (potSlug) {
          const subSlugs = new Set(submodules.map((n) => n.qualifiedSlug));
          projects = projects.map((p) => {
            // Only this root's classified subtree; never slugs the loop errored on.
            if (!subSlugs.has(p.slug) || p.slug === rootSlug) return p;
            if (erroredSlugs.has(p.slug)) return p;
            if (p.harness_kind !== 'sub-harness' || p.hive_slug === potSlug) return p;
            hiveReconciled.push(p.slug);
            changed = true;
            return { ...p, hive_slug: potSlug };
          });
        }
        return changed ? { ...cur, projects } : cur;
      });
      // Bust the lite-cache so consumers see the new tree on next poll.
      bustProjectsLiteCache();
      __projectsCache.expires = 0;
    }

    return Response.json({
      ok: true,
      rootSlug,
      discovered: submodules.length,
      membership: potSlug
        ? { kind: 'hive_slug' as const, value: potSlug }
        : { kind: 'parent_slug' as const, value: rootSlug },
      registered,
      reconciled,
      hiveReconciled,
      errors,
    });
  },
});

/**
 * Resolve the membership edge for an "add into hive" create (harnesses-tab P-011).
 *
 * Decides which edge a new harness should carry when the picker's add-into-hive
 * mode passes a `hive` scope (the current `?slug=`):
 *   - empty scope        → no membership (a standalone harness).
 *   - unknown scope       → error (the scope must exist in this workspace).
 *   - FORMAL `kind:'hive'` home → `hive_slug` (shared-hive-federation membership).
 *   - any other scope     → `parent_slug` (the Phase-1 legacy sub-harness edge).
 *
 * Pure over the registry projects so the formal-vs-legacy precedence is
 * unit-tested without fs/PG (mirrors `resolveCreatePotMembership`). Exported
 * for tests + the POST handler.
 */
export function resolveProjectHiveMembership(
  projects: ReadonlyArray<{ slug: string; harness_kind?: string }>,
  hiveScope: string,
):
  | { ok: true; membership: { kind: 'hive_slug' | 'parent_slug'; value: string } | null }
  | { ok: false; error: string; code: 'hive_not_found' } {
  const scope = hiveScope.trim();
  if (!scope) return { ok: true, membership: null };
  const target = projects.find((p) => p.slug === scope);
  if (!target) {
    return { ok: false, error: `hive '${scope}' not found in this workspace`, code: 'hive_not_found' };
  }
  return {
    ok: true,
    membership: {
      kind: target.harness_kind === HIVE_KIND ? 'hive_slug' : 'parent_slug',
      value: scope,
    },
  };
}

/**
 * Resolve the FORMAL hive membership that registering sub-harnesses under
 * `root` should stamp (EI-332 / hive-pr-rollup-and-subharness-membership
 * P-001). Mirrors `resolveProjectHiveMembership`'s formal-vs-legacy
 * precedence, one level up: a `kind:'hive'` home owns its subs directly; a
 * root that is itself a hive MEMBER passes its home through (so a sub of a
 * member groups with the hive instead of orphaning); a plain root confers no
 * formal membership (legacy parent_slug only). Pure; exported for tests +
 * the scan/register handlers.
 */
export function resolveSubHarnessHiveSlug(
  root: Pick<ProjectEntry, 'slug' | 'harness_kind' | 'hive_slug'>,
): string | null {
  if (root.harness_kind === HIVE_KIND) return root.slug;
  return root.hive_slug?.trim() || null;
}

/**
 * Sub-harness slug guard for P-021. Rejects slugs that would either
 * (a) traverse out of the root harness's directory or (b) break the
 * slug → path mapping downstream. Exported only for tests.
 */
export function isSafeSubHarnessSlug(slug: string): boolean {
  if (typeof slug !== 'string' || slug.length === 0) return false;
  if (slug.length > 200) return false;
  if (slug.startsWith('/') || slug.startsWith('\\')) return false;
  // Split into segments — any segment that is exactly '..' or '.' is rejected.
  const segments = slug.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
    // No control chars, no whitespace.
    if (/[\x00-\x20]/.test(seg)) return false;
  }
  return true;
}

export default [lite, list, create, createHive, createHiveFromRepoRoute, remove, scanSubharnesses, registerSubs];
