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
const CF_API = 'https://api.cloudflare.com/client/v4';
const MAX_FILES_PER_BATCH = 5000;
const MAX_BYTES_PER_BATCH = 45 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
async function readConfig(ctx) {
    const { promises: fs } = await Promise.resolve().then(() => __importStar(require('node:fs')));
    const { join } = await Promise.resolve().then(() => __importStar(require('node:path')));
    try {
        return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8'));
    }
    catch {
        return { accountId: '', projectName: '', exportDir: 'out', branch: 'main' };
    }
}
async function readToken() {
    // Mirrors realSecretsService in apps/web/lib/plugin-host.ts: prefer the
    // secrets file (~/.papercusp/secrets/<NAME>) so operators can keep tokens
    // out of process env; fall back to env. The capability check at the
    // registry boundary already gated us on `secrets:read:CLOUDFLARE_API_TOKEN`.
    const { readFile } = await Promise.resolve().then(() => __importStar(require('node:fs/promises')));
    const { existsSync, readFileSync } = await Promise.resolve().then(() => __importStar(require('node:fs')));
    const { homedir } = await Promise.resolve().then(() => __importStar(require('node:os')));
    const { join } = await Promise.resolve().then(() => __importStar(require('node:path')));
    // Resolve workspace-aware root (mirrors operator/CLI resolver).
    //
    // Honor PAPERCUSP_WORKSPACES_ROOT before falling back to homedir() — a bare
    // homedir() here resolves to a NESTED registry when this plugin runs with
    // HOME remapped to a per-workspace dir (P-051 spawned-child case). See
    // agent-insights/workspaces-root-vs-remapped-home and the same env-first
    // resolver in @papercusp/operator-core's workspace-registry.ts.
    const workspacesRootDir = () => {
        const env = process.env.PAPERCUSP_WORKSPACES_ROOT;
        if (env && env.trim())
            return env;
        return join(homedir(), '.papercusp-workspaces');
    };
    const root = (() => {
        if (process.env.PAPERCUSP_HOME)
            return process.env.PAPERCUSP_HOME;
        const wsIndex = join(workspacesRootDir(), 'registry.json');
        if (existsSync(wsIndex)) {
            try {
                const parsed = JSON.parse(readFileSync(wsIndex, 'utf8'));
                if (parsed.current) {
                    const cand = join(workspacesRootDir(), parsed.current, '.papercusp');
                    if (existsSync(cand))
                        return cand;
                }
            }
            catch { /* fall through */ }
        }
        const def = join(workspacesRootDir(), 'default', '.papercusp');
        if (existsSync(def))
            return def;
        return join(homedir(), '.papercusp');
    })();
    try {
        const v = await readFile(join(root, 'secrets', 'CLOUDFLARE_API_TOKEN'), 'utf8');
        const trimmed = v.trimEnd();
        if (trimmed.length > 0)
            return trimmed;
    }
    catch {
        /* fall through */
    }
    return process.env.CLOUDFLARE_API_TOKEN ?? null;
}
function contentTypeFor(ext) {
    switch (ext) {
        case '.html': return 'text/html; charset=utf-8';
        case '.css': return 'text/css; charset=utf-8';
        case '.js': return 'application/javascript; charset=utf-8';
        case '.mjs': return 'application/javascript; charset=utf-8';
        case '.json': return 'application/json; charset=utf-8';
        case '.svg': return 'image/svg+xml';
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.webp': return 'image/webp';
        case '.ico': return 'image/x-icon';
        case '.woff': return 'font/woff';
        case '.woff2': return 'font/woff2';
        case '.ttf': return 'font/ttf';
        case '.txt': return 'text/plain; charset=utf-8';
        case '.xml': return 'application/xml';
        case '.wasm': return 'application/wasm';
        case '.map': return 'application/json; charset=utf-8';
        default: return 'application/octet-stream';
    }
}
async function pickHasher() {
    // Cloudflare Pages indexes uploaded assets by BLAKE3(base64(content) + extWithoutDot)
    // (first 32 hex chars). Wrangler's source is the canonical reference. If the host
    // process tree exposes @noble/hashes/blake3, use it — that's what enables Cloudflare
    // to dedup repeat assets on re-publish. If not, fall back to SHA-256 (deploys still
    // succeed; only dedup is lost).
    // @noble/hashes ships its blake3 entry under different subpaths depending
    // on version: '.../blake3' (older) vs '.../blake3.js' (newer with strict
    // exports map). Try both before giving up.
    for (const subpath of ['@noble/hashes/blake3', '@noble/hashes/blake3.js']) {
        try {
            const mod = await Promise.resolve(`${subpath}`).then(s => __importStar(require(s)));
            const blake3 = mod.blake3
                ?? mod.default?.blake3;
            if (typeof blake3 === 'function') {
                const enc = new TextEncoder();
                const hash = (input) => Buffer.from(blake3(enc.encode(input))).toString('hex').slice(0, 32);
                return { hash, algo: 'blake3' };
            }
        }
        catch {
            /* try next subpath */
        }
    }
    const { createHash } = await Promise.resolve().then(() => __importStar(require('node:crypto')));
    const hash = (input) => createHash('sha256').update(input).digest('hex').slice(0, 32);
    return { hash, algo: 'sha256' };
}
async function walkExport(root, log) {
    const { promises: fs } = await Promise.resolve().then(() => __importStar(require('node:fs')));
    const { join, relative, extname, sep } = await Promise.resolve().then(() => __importStar(require('node:path')));
    const picked = await pickHasher();
    log?.(`publish: hasher=${picked.algo}`);
    const { hash } = picked;
    const out = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch (e) {
            if (e?.code === 'ENOENT')
                continue;
            throw e;
        }
        for (const ent of entries) {
            const full = join(dir, ent.name);
            if (ent.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!ent.isFile())
                continue;
            const buf = await fs.readFile(full);
            if (buf.byteLength > MAX_FILE_BYTES) {
                throw new Error(`cloudflare-pages: ${full} exceeds 25 MiB Pages asset limit`);
            }
            const extWithDot = extname(ent.name).toLowerCase();
            const extNoDot = extWithDot.startsWith('.') ? extWithDot.slice(1) : extWithDot;
            const base64 = buf.toString('base64');
            const rel = relative(root, full).split(sep).join('/');
            out.push({
                path: '/' + rel,
                hash: hash(base64 + extNoDot),
                base64,
                contentType: contentTypeFor(extWithDot),
            });
        }
    }
    return out;
}
async function cfFetch(url, init, signal, label) {
    const r = await fetch(url, { ...init, signal });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body?.success === false) {
        const errs = Array.isArray(body?.errors) ? body.errors.map((e) => e?.message ?? String(e)).join('; ') : '';
        throw new Error(`cloudflare-pages: ${label} → HTTP ${r.status}${errs ? ' — ' + errs : ''}`);
    }
    return body;
}
async function getUploadJwt(token, accountId, projectName, signal) {
    const url = `${CF_API}/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/upload-token`;
    const body = await cfFetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
    }, signal, 'upload-token');
    const jwt = body?.result?.jwt;
    if (typeof jwt !== 'string' || jwt.length === 0)
        throw new Error('cloudflare-pages: upload-token returned no jwt');
    return jwt;
}
async function checkMissing(jwt, hashes, signal) {
    const missing = new Set();
    for (let i = 0; i < hashes.length; i += MAX_FILES_PER_BATCH) {
        const slice = hashes.slice(i, i + MAX_FILES_PER_BATCH);
        const body = await cfFetch(`${CF_API}/pages/assets/check-missing`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${jwt}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ hashes: slice }),
        }, signal, 'check-missing');
        for (const h of body?.result ?? [])
            missing.add(h);
    }
    return missing;
}
async function uploadAssets(jwt, assets, signal) {
    let batch = [];
    let bytes = 0;
    const flush = async () => {
        if (batch.length === 0)
            return;
        const payload = batch.map((a) => ({
            key: a.hash,
            value: a.base64,
            base64: true,
            metadata: { contentType: a.contentType },
        }));
        await cfFetch(`${CF_API}/pages/assets/upload`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${jwt}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
        }, signal, `assets/upload (${batch.length} files)`);
        batch = [];
        bytes = 0;
    };
    for (const a of assets) {
        const sz = a.base64.length;
        if (batch.length >= MAX_FILES_PER_BATCH || bytes + sz > MAX_BYTES_PER_BATCH)
            await flush();
        batch.push(a);
        bytes += sz;
    }
    await flush();
}
async function createDeployment(token, accountId, projectName, manifest, branch, signal) {
    const url = `${CF_API}/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments`;
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append('branch', branch);
    const body = await cfFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
    }, signal, 'deployments');
    return { url: body?.result?.url ?? null, id: body?.result?.id ?? null };
}
const plugin = {
    kind: 'plugin',
    name: '@papercupai/cloudflare-pages',
    version: '0.1.0',
    papercusp: '^0.1.0',
    description: 'Publish the harness static export to Cloudflare Pages.',
    capabilities: [
        'secrets:read:CLOUDFLARE_API_TOKEN',
        'http:fetch:api.cloudflare.com',
        'ui:dashboard-tab',
        'events:listen:mission-done',
    ],
    actions: [
        {
            name: 'publish',
            label: 'Publish to Cloudflare Pages',
            surfaces: ['mission-done', 'harness-toolbar'],
            capabilities: ['secrets:read:CLOUDFLARE_API_TOKEN', 'http:fetch:api.cloudflare.com'],
            serverHandler: { timeoutSec: 120 },
        },
    ],
    routines: [
        {
            name: 'auto-publish-on-done',
            trigger: { kind: 'webhook', tokenEnv: 'CLOUDFLARE_AUTOPUBLISH_TOKEN' },
            targetRole: 'cloudflare-pages-publisher',
            payloadTemplate: { dryRun: false },
            concurrency: 'queue',
            catchup: 'skip-old',
        },
    ],
    async init(ctx) {
        // ctx.actions is non-null in init() (the plugin-host always provides it);
        // it's only optional on the shared type because fire-hook lifecycle ctx
        // doesn't include it.
        ctx.actions.register('publish', async (innerCtx, params, signal) => {
            return runPublish(innerCtx, (params ?? {}), signal);
        });
    },
    hooks: {
        // Auto-publish on mission completion. Silent skip (ok:true, skipped:true)
        // if the harness has the plugin enabled but no accountId/projectName —
        // i.e. enabled-but-not-configured-for-auto. Logs+swallows real errors;
        // we never want a CF blip to be reported as a mission failure.
        async afterDone(ctx) {
            const cfg = await readConfig(ctx);
            if (!cfg.accountId || !cfg.projectName) {
                ctx.log('cloudflare-pages: afterDone — skipped (accountId/projectName not configured)');
                return;
            }
            try {
                const r = await runPublish(ctx, {}, undefined);
                if (r.ok) {
                    ctx.log(`cloudflare-pages: afterDone published → ${r.result?.url ?? '(no url)'}`);
                }
                else {
                    ctx.log(`cloudflare-pages: afterDone publish failed — ${r.error}`);
                }
            }
            catch (e) {
                ctx.log(`cloudflare-pages: afterDone publish threw — ${e?.message ?? String(e)}`);
            }
        },
    },
};
async function runPublish(ctx, p, signal) {
    const config = await readConfig(ctx);
    if (!config.accountId || !config.projectName) {
        return {
            ok: false,
            error: 'cloudflare-pages: accountId or projectName not configured (run `papercusp plugin enable`)',
        };
    }
    const { join, isAbsolute, resolve } = await Promise.resolve().then(() => __importStar(require('node:path')));
    const exportDirRel = config.exportDir ?? 'out';
    const exportRoot = isAbsolute(exportDirRel) ? exportDirRel : resolve(join(ctx.projectDir, exportDirRel));
    const branch = config.branch ?? 'main';
    if (p.dryRun) {
        let fileCount = 0;
        try {
            const assets = await walkExport(exportRoot, ctx.log);
            fileCount = assets.length;
        }
        catch {
            /* dry-run is best-effort */
        }
        return {
            ok: true,
            result: {
                dryRun: true,
                wouldPublishTo: `https://${config.projectName}.pages.dev`,
                account: config.accountId,
                branch,
                exportDir: exportRoot,
                fileCount,
            },
        };
    }
    const token = await readToken();
    if (!token) {
        return { ok: false, error: 'cloudflare-pages: CLOUDFLARE_API_TOKEN not set in env (write to ~/.papercusp/secrets/CLOUDFLARE_API_TOKEN or export it on the substrate process)' };
    }
    try {
        ctx.log(`publish: walking ${exportRoot}`);
        const assets = await walkExport(exportRoot, ctx.log);
        if (assets.length === 0) {
            return { ok: false, error: `cloudflare-pages: no files found under ${exportRoot}` };
        }
        const manifest = {};
        for (const a of assets)
            manifest[a.path] = a.hash;
        ctx.log(`publish: ${assets.length} files; fetching upload jwt`);
        const jwt = await getUploadJwt(token, config.accountId, config.projectName, signal);
        const missing = await checkMissing(jwt, [...new Set(assets.map((a) => a.hash))], signal);
        ctx.log(`publish: ${missing.size}/${assets.length} assets missing — uploading`);
        const seen = new Set();
        const toUpload = [];
        for (const a of assets) {
            if (!missing.has(a.hash) || seen.has(a.hash))
                continue;
            seen.add(a.hash);
            toUpload.push(a);
        }
        if (toUpload.length > 0)
            await uploadAssets(jwt, toUpload, signal);
        ctx.log('publish: creating deployment');
        const dep = await createDeployment(token, config.accountId, config.projectName, manifest, branch, signal);
        return {
            ok: true,
            result: {
                url: dep.url,
                deploymentId: dep.id,
                uploaded: toUpload.length,
                files: assets.length,
                branch,
            },
        };
    }
    catch (e) {
        if (e?.name === 'AbortError')
            return { ok: false, error: 'cloudflare-pages: aborted (timeout)' };
        return { ok: false, error: e?.message ?? String(e) };
    }
}
exports.default = plugin;
