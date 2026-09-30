"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.gitPush = gitPush;
const GITHUB_API = 'https://api.github.com';
async function readConfig(ctx) {
    const { promises: fs } = await Promise.resolve().then(() => __importStar(require('node:fs')));
    const { join } = await Promise.resolve().then(() => __importStar(require('node:path')));
    try {
        return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8'));
    }
    catch {
        return {};
    }
}
async function ghFetch(token, path, init = {}) {
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
async function repoExists(token, owner, repo, signal) {
    const r = await ghFetch(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { method: 'GET', signal });
    return r.ok;
}
async function authenticatedLogin(token, signal) {
    const r = await ghFetch(token, '/user', { method: 'GET', signal });
    if (!r.ok)
        return null;
    const j = (await r.json());
    return j.login ?? null;
}
async function gitPush(ctx, cloneUrl, defaultBranch, token) {
    const spawn = ctx.spawn;
    if (!spawn)
        return { ok: false, error: 'ctx.spawn unavailable — host needs compute:exec:git capability wired' };
    // Token-embedded URL avoids prompting for credentials. Format:
    //   https://x-access-token:<TOKEN>@github.com/<owner>/<repo>.git
    const authedUrl = cloneUrl.replace(/^https:\/\//, `https://x-access-token:${encodeURIComponent(token)}@`);
    const projectDir = ctx.projectDir;
    // 1. ensure git initialized
    const gitDir = await (async () => {
        const { existsSync } = await Promise.resolve().then(() => __importStar(require('node:fs')));
        const { join } = await Promise.resolve().then(() => __importStar(require('node:path')));
        return existsSync(join(projectDir, '.git'));
    })();
    if (!gitDir) {
        const init = await spawn('git', ['init', '-b', defaultBranch], { cwd: projectDir });
        if (init.code !== 0)
            return { ok: false, error: `git init failed: ${init.stderr.slice(0, 200)}` };
    }
    // 2. add + commit if there are any uncommitted changes
    const add = await spawn('git', ['add', '-A'], { cwd: projectDir });
    if (add.code !== 0)
        return { ok: false, error: `git add failed: ${add.stderr.slice(0, 200)}` };
    const commit = await spawn('git', ['commit', '-m', 'initial harness state', '--allow-empty'], { cwd: projectDir });
    // commit.code may be non-zero if "nothing to commit" — that's fine, ignore.
    // 3. set/replace origin
    const setUrl = await spawn('git', ['remote', 'set-url', 'origin', authedUrl], { cwd: projectDir });
    if (setUrl.code !== 0) {
        const addRemote = await spawn('git', ['remote', 'add', 'origin', authedUrl], { cwd: projectDir });
        if (addRemote.code !== 0)
            return { ok: false, error: `git remote setup failed: ${addRemote.stderr.slice(0, 200)}` };
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
    const redact = (s) => s.replace(/x-access-token:[^@\s]*@/g, 'x-access-token:***@');
    const resetOrigin = await spawn('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: projectDir });
    if (push.code !== 0)
        return { ok: false, error: `git push failed: ${redact(push.stderr.slice(0, 300) || push.stdout.slice(0, 300))}` };
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
async function createOrReuseRepo(ctx, cfg, signal) {
    const token = cfg.github_token?.trim();
    if (!token)
        return { ok: false, error: 'github_token not configured (set it in /settings/plugins for this harness)' };
    const repoName = cfg.repo?.trim() || ctx.installSlug;
    let owner = cfg.owner?.trim();
    if (!owner) {
        const login = await authenticatedLogin(token, signal);
        if (!login)
            return { ok: false, error: 'failed to resolve owner from token (check it has `repo` scope)' };
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
    const j = (await r.json());
    return {
        ok: true,
        reused: false,
        repo: { fullName: j.full_name, cloneUrl: j.clone_url, sshUrl: j.ssh_url, htmlUrl: j.html_url },
    };
}
const plugin = {
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
        ctx.actions.register('create-repo', async (innerCtx, params, signal) => {
            const cfg = await readConfig(innerCtx);
            const dryRun = !!params?.dryRun;
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
            if (!r.ok)
                return { ok: false, error: r.error };
            let pushed = false;
            if (r.repo && cfg.pushOnCreate !== false) {
                const p = await gitPush(innerCtx, r.repo.cloneUrl, cfg.defaultBranch ?? 'main', cfg.github_token);
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
        async onHarnessCreated(ctx) {
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
                ctx.log(`github-repo: ${r.reused ? 'reused' : 'created'} ${r.repo.fullName} → ${r.repo.htmlUrl}`);
                if (cfg.pushOnCreate !== false && r.repo) {
                    const p = await gitPush(ctx, r.repo.cloneUrl, cfg.defaultBranch ?? 'main', cfg.github_token);
                    if (p.ok)
                        ctx.log(`github-repo: pushed initial state to ${r.repo.fullName}`);
                    else
                        ctx.log(`github-repo: repo ready but push failed — ${p.error}`);
                }
            }
            catch (e) {
                ctx.log(`github-repo: onHarnessCreated threw — ${e?.message ?? String(e)}`);
            }
        },
    },
};
const apiRoutes = {
    async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname.replace(/^.*\/plugins\/[^/]+/, '') || url.pathname;
        if (path === '/ping' || path.endsWith('/ping')) {
            return Response.json({ ok: true, plugin: '@papercupai/github-repo', version: '0.1.0' });
        }
        return Response.json({ error: 'not found', path }, { status: 404 });
    },
};
plugin.apiRoutes = apiRoutes;
exports.default = plugin;
