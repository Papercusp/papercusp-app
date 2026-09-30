/**
 * @papercupai/github-repo — provision a GitHub repo for each new harness.
 *
 * Triggers on the `onHarnessCreated` lifecycle hook the substrate fires
 * after `papercusp init` succeeds. Reads per-harness config (token, owner,
 * repo, visibility, defaultBranch, pushOnCreate), creates the repo via
 * github API, and (optionally) does an initial git push from the harness
 * project dir.
 *
 * Why per-harness credentials: one harness might push to a personal repo,
 * another to an org repo, with different tokens scoped to different orgs.
 * The token lives in the plugin's per-harness config alongside everything
 * else — no substrate-level GitHub credential involvement.
 */
import type { Plugin, PapercuspContext } from '@papercusp/plugin-sdk';

interface Config {
  github_token?: string;
  owner?: string;
  repo?: string;
  visibility?: 'public' | 'private';
  description?: string;
  defaultBranch?: string;
  pushOnCreate?: boolean;
}

const GITHUB_API = 'https://api.github.com';

async function readConfig(ctx: PapercuspContext): Promise<Config> {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  try {
    return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8')) as Config;
  } catch {
    return {};
  }
}

interface RepoResult {
  ok: boolean;
  repo?: { fullName: string; cloneUrl: string; sshUrl: string; htmlUrl: string };
  pushed?: boolean;
  error?: string;
  reused?: boolean;
}

async function ghFetch(token: string, path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

async function repoExists(token: string, owner: string, repo: string, signal?: AbortSignal): Promise<boolean> {
  const r = await ghFetch(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { method: 'GET', signal });
  return r.ok;
}

async function authenticatedLogin(token: string, signal?: AbortSignal): Promise<string | null> {
  const r = await ghFetch(token, '/user', { method: 'GET', signal });
  if (!r.ok) return null;
  const j = (await r.json()) as { login?: string };
  return j.login ?? null;
}

export async function gitPush(
  ctx: PapercuspContext,
  cloneUrl: string,
  defaultBranch: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const spawn = ctx.spawn;
  if (!spawn) return { ok: false, error: 'ctx.spawn unavailable — host needs compute:exec:git capability wired' };

  // Token-embedded URL avoids prompting for credentials. Format:
  //   https://x-access-token:<TOKEN>@github.com/<owner>/<repo>.git
  const authedUrl = cloneUrl.replace(/^https:\/\//, `https://x-access-token:${encodeURIComponent(token)}@`);
  const projectDir = ctx.projectDir;

  // 1. ensure git initialized
  const gitDir = await (async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    return existsSync(join(projectDir, '.git'));
  })();
  if (!gitDir) {
    const init = await spawn('git', ['init', '-b', defaultBranch], { cwd: projectDir });
    if (init.code !== 0) return { ok: false, error: `git init failed: ${init.stderr.slice(0, 200)}` };
  }

  // 2. add + commit if there are any uncommitted changes
  const add = await spawn('git', ['add', '-A'], { cwd: projectDir });
  if (add.code !== 0) return { ok: false, error: `git add failed: ${add.stderr.slice(0, 200)}` };

  const commit = await spawn('git', ['commit', '-m', 'initial harness state', '--allow-empty'], { cwd: projectDir });
  // commit.code may be non-zero if "nothing to commit" — that's fine, ignore.

  // 3. set/replace origin
  const setUrl = await spawn('git', ['remote', 'set-url', 'origin', authedUrl], { cwd: projectDir });
  if (setUrl.code !== 0) {
    const addRemote = await spawn('git', ['remote', 'add', 'origin', authedUrl], { cwd: projectDir });
    if (addRemote.code !== 0) return { ok: false, error: `git remote setup failed: ${addRemote.stderr.slice(0, 200)}` };
  }

  // 4. push
  const push = await spawn('git', ['push', '-u', 'origin', defaultBranch], { cwd: projectDir, timeoutSec: 60 });

  // 5. de-tokenize origin — step 3 set `origin` to `authedUrl`, which embeds
  // the token in plaintext; that must never persist in this harness's own
  // `.git/config` once the push attempt is over (same defect class as
  // WI-3057's shared-harness join clone, fixed there via
  // ensureDetokenizedOrigin — this is the analogous fix for THIS push path).
  // Attempted regardless of push outcome, since step 3 already wrote the
  // token to disk the moment `set-url`/`add remote` ran, independent of
  // whether the subsequent push itself succeeds.
  const redact = (s: string) => s.replace(/x-access-token:[^@\s]*@/g, 'x-access-token:***@');
  const resetOrigin = await spawn('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: projectDir });

  if (push.code !== 0) return { ok: false, error: `git push failed: ${redact(push.stderr.slice(0, 300) || push.stdout.slice(0, 300))}` };
  if (resetOrigin.code !== 0) {
    // The push succeeded, but the token-free reset failed — surface this as a
    // failure (not a silent best-effort) so it isn't mistaken for a clean
    // success while `.git/config` still holds a plaintext token.
    return {
      ok: false,
      error: `push succeeded but failed to remove the embedded token from origin (.git/config may still contain it): ${redact(resetOrigin.stderr.slice(0, 200))}`,
    };
  }
  return { ok: true };
}

async function createOrReuseRepo(
  ctx: PapercuspContext,
  cfg: Config,
  signal?: AbortSignal,
): Promise<RepoResult> {
  const token = cfg.github_token?.trim();
  if (!token) return { ok: false, error: 'github_token not configured (set it in /settings/plugins for this harness)' };

  const repoName = cfg.repo?.trim() || ctx.installSlug;
  let owner = cfg.owner?.trim();
  if (!owner) {
    const login = await authenticatedLogin(token, signal);
    if (!login) return { ok: false, error: 'failed to resolve owner from token (check it has `repo` scope)' };
    owner = login;
  }

  const visibility = cfg.visibility ?? 'private';
  const isPrivate = visibility === 'private';

  // Find-before-create — re-running an event replay (or a re-created harness
  // with the same slug) shouldn't fail or duplicate.
  if (await repoExists(token, owner, repoName, signal)) {
    return {
      ok: true,
      reused: true,
      repo: {
        fullName: `${owner}/${repoName}`,
        cloneUrl: `https://github.com/${owner}/${repoName}.git`,
        sshUrl: `git@github.com:${owner}/${repoName}.git`,
        htmlUrl: `https://github.com/${owner}/${repoName}`,
      },
    };
  }

  // Determine endpoint: /user/repos for the authed user, /orgs/<org>/repos for orgs.
  const authedLogin = await authenticatedLogin(token, signal);
  const isOrg = authedLogin && owner.toLowerCase() !== authedLogin.toLowerCase();
  const path = isOrg ? `/orgs/${encodeURIComponent(owner)}/repos` : '/user/repos';
  const r = await ghFetch(token, path, {
    method: 'POST',
    body: JSON.stringify({
      name: repoName,
      description: cfg.description ?? `Harness ${ctx.installSlug}`,
      private: isPrivate,
      auto_init: false,
    }),
    signal,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return { ok: false, error: `github API ${r.status}${text ? ' — ' + text.slice(0, 300) : ''}` };
  }
  const j = (await r.json()) as { full_name: string; clone_url: string; ssh_url: string; html_url: string };
  return {
    ok: true,
    reused: false,
    repo: { fullName: j.full_name, cloneUrl: j.clone_url, sshUrl: j.ssh_url, htmlUrl: j.html_url },
  };
}

const plugin: Plugin = {
  kind: 'plugin',
  name: '@papercupai/github-repo',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Create a GitHub repo for each new harness using per-harness credentials.',
  capabilities: [
    'http:fetch:api.github.com',
    'compute:exec:git',
    'events:listen:harness-created',
    'storage:plugin-private',
  ],
  actions: [
    {
      name: 'create-repo',
      label: 'Create GitHub repo',
      surfaces: ['harness-toolbar'],
      capabilities: ['http:fetch:api.github.com', 'compute:exec:git'],
      serverHandler: { timeoutSec: 30 },
    },
  ],
  async init(ctx) {
    ctx.actions!.register('create-repo', async (innerCtx, params, signal) => {
      const cfg = await readConfig(innerCtx);
      const dryRun = !!(params as { dryRun?: boolean })?.dryRun;
      if (dryRun) {
        return {
          ok: true,
          result: {
            dryRun: true,
            wouldCreate: {
              owner: cfg.owner ?? '(authenticated user)',
              repo: cfg.repo ?? innerCtx.installSlug,
              visibility: cfg.visibility ?? 'private',
              defaultBranch: cfg.defaultBranch ?? 'main',
              pushOnCreate: cfg.pushOnCreate !== false,
            },
          },
        };
      }
      const r = await createOrReuseRepo(innerCtx, cfg, signal);
      if (!r.ok) return { ok: false, error: r.error };
      let pushed = false;
      if (r.repo && cfg.pushOnCreate !== false) {
        const p = await gitPush(innerCtx, r.repo.cloneUrl, cfg.defaultBranch ?? 'main', cfg.github_token!);
        pushed = p.ok;
        if (!p.ok) {
          // Repo created but push failed — return both pieces of info.
          return { ok: true, result: { ...r.repo, reused: r.reused, pushed: false, pushError: p.error } };
        }
      }
      return { ok: true, result: { ...r.repo, reused: r.reused, pushed } };
    });
  },
  hooks: {
    async onHarnessCreated(ctx: PapercuspContext) {
      const cfg = await readConfig(ctx);
      if (!cfg.github_token) {
        ctx.log('github-repo: onHarnessCreated — skipped (no github_token configured)');
        return;
      }
      try {
        const r = await createOrReuseRepo(ctx, cfg);
        if (!r.ok) {
          ctx.log(`github-repo: onHarnessCreated failed — ${r.error}`);
          return;
        }
        ctx.log(
          `github-repo: ${r.reused ? 'reused' : 'created'} ${r.repo!.fullName} → ${r.repo!.htmlUrl}`,
        );
        if (cfg.pushOnCreate !== false && r.repo) {
          const p = await gitPush(ctx, r.repo.cloneUrl, cfg.defaultBranch ?? 'main', cfg.github_token);
          if (p.ok) ctx.log(`github-repo: pushed initial state to ${r.repo.fullName}`);
          else ctx.log(`github-repo: repo ready but push failed — ${p.error}`);
        }
      } catch (e: any) {
        ctx.log(`github-repo: onHarnessCreated threw — ${e?.message ?? String(e)}`);
      }
    },
  },
};

const apiRoutes = {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/plugins\/[^/]+/, '') || url.pathname;
    if (path === '/ping' || path.endsWith('/ping')) {
      return Response.json({ ok: true, plugin: '@papercupai/github-repo', version: '0.1.0' });
    }
    return Response.json({ error: 'not found', path }, { status: 404 });
  },
};

(plugin as any).apiRoutes = apiRoutes;

export default plugin;
