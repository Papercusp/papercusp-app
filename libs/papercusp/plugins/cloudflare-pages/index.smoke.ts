/**
 * Smoke test for @papercupai/cloudflare-pages.
 *
 * Verifies the full Direct Upload flow against an in-process mock of
 * api.cloudflare.com — no real Cloudflare account or token required.
 *
 *   1. dryRun reports correct file count + target URL
 *   2. Asset hashing matches Pages convention (sha256(b64+ext)[:32])
 *   3. publish() walks the export, fetches a JWT, checks-missing,
 *      uploads only the missing assets, and POSTs a manifest deployment
 *   4. AbortSignal cancels in-flight uploads
 *
 * Run with:
 *   cd plugins/cloudflare-pages && npx tsx index.smoke.ts
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import plugin from './index';

// Match the plugin's hash selection: BLAKE3 if available, SHA-256 otherwise.
async function makeHasher(): Promise<{ hash: (s: string) => string; algo: 'blake3' | 'sha256' }> {
  for (const subpath of ['@noble/hashes/blake3', '@noble/hashes/blake3.js']) {
    try {
      const mod = await import(subpath as string);
      const blake3 = (mod as any).blake3 ?? (mod as any).default?.blake3;
      if (typeof blake3 === 'function') {
        const enc = new TextEncoder();
        return { hash: (s) => Buffer.from(blake3(enc.encode(s))).toString('hex').slice(0, 32), algo: 'blake3' };
      }
    } catch { /* try next */ }
  }
  return { hash: (s) => createHash('sha256').update(s).digest('hex').slice(0, 32), algo: 'sha256' };
}

type FetchCall = { url: string; init: RequestInit };

function makeMockFetch(opts: {
  knownHashes?: Set<string>;
  failUploadOnce?: boolean;
} = {}) {
  const calls: FetchCall[] = [];
  const known = opts.knownHashes ?? new Set<string>();
  let uploadedHashes: string[] = [];
  let manifest: Record<string, string> | null = null;
  let uploadCalls = 0;

  const mockFetch: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    const i = (init ?? {}) as RequestInit;
    calls.push({ url, init: i });

    if (i.signal?.aborted) {
      const err = new Error('aborted'); (err as any).name = 'AbortError'; throw err;
    }

    if (url.endsWith('/upload-token')) {
      return new Response(JSON.stringify({ success: true, result: { jwt: 'mock-jwt' } }), { status: 200 });
    }
    if (url.endsWith('/pages/assets/check-missing')) {
      const body = JSON.parse(String(i.body));
      const missing = (body.hashes as string[]).filter((h) => !known.has(h));
      return new Response(JSON.stringify({ success: true, result: missing }), { status: 200 });
    }
    if (url.endsWith('/pages/assets/upload')) {
      uploadCalls++;
      if (opts.failUploadOnce && uploadCalls === 1) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'simulated 500' }] }), { status: 500 });
      }
      const body = JSON.parse(String(i.body)) as Array<{ key: string }>;
      for (const a of body) uploadedHashes.push(a.key);
      return new Response(JSON.stringify({ success: true, result: null }), { status: 200 });
    }
    if (url.endsWith('/deployments')) {
      const form = i.body as FormData;
      manifest = JSON.parse(String(form.get('manifest')));
      return new Response(JSON.stringify({ success: true, result: { id: 'dep-123', url: 'https://abc.example.pages.dev' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'unmocked: ' + url }] }), { status: 404 });
  };

  return { mockFetch, calls, get uploadedHashes() { return uploadedHashes; }, get manifest() { return manifest; }, get uploadCalls() { return uploadCalls; } };
}

// Will be set by main() once we've picked the hasher.
let _hasher: (s: string) => string = () => { throw new Error('hasher not ready'); };
function expectedHash(content: Buffer, extWithDot: string): string {
  const extNoDot = extWithDot.startsWith('.') ? extWithDot.slice(1) : extWithDot;
  return _hasher(content.toString('base64') + extNoDot);
}

async function setupHarness() {
  const root = await mkdtemp(join(tmpdir(), 'cfp-smoke-'));
  const projectDir = join(root, 'project');
  const stateDir = join(root, '.papercusp');
  const pluginDataDir = join(stateDir, 'plugins', '_papercupai_cloudflare-pages');
  const exportDir = join(projectDir, 'out');
  await mkdir(exportDir, { recursive: true });
  await mkdir(pluginDataDir, { recursive: true });
  await writeFile(join(exportDir, 'index.html'), '<!doctype html><title>hi</title>');
  await mkdir(join(exportDir, 'assets'), { recursive: true });
  await writeFile(join(exportDir, 'assets', 'app.js'), 'console.log("hi")');
  await writeFile(join(exportDir, 'assets', 'styles.css'), 'body{font:14px sans-serif}');
  await writeFile(join(pluginDataDir, 'config.json'), JSON.stringify({
    accountId: 'acct-1234',
    projectName: 'demo-site',
    exportDir: 'out',
    branch: 'main',
  }));
  return { root, projectDir, stateDir, pluginDataDir };
}

function makeCtx(slug: string, projectDir: string, stateDir: string, pluginDataDir: string) {
  const handlers: Record<string, Function> = {};
  const ctx: any = {
    installSlug: slug,
    projectDir,
    stateDir,
    pluginDataDir,
    log: () => {},
    actions: {
      register: (name: string, fn: Function) => { handlers[name] = fn; },
    },
  };
  return { ctx, handlers };
}

async function main() {
  let pass = 0, fail = 0;
  const log = (label: string, ok: boolean, detail?: string) => {
    console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };

  const hasher = await makeHasher();
  _hasher = hasher.hash;
  console.log(`(hasher: ${hasher.algo})`);

  const origFetch = globalThis.fetch;
  const origToken = process.env.CLOUDFLARE_API_TOKEN;

  const { root, projectDir, stateDir, pluginDataDir } = await setupHarness();
  const indexHash = expectedHash(Buffer.from('<!doctype html><title>hi</title>'), '.html');
  const jsHash    = expectedHash(Buffer.from('console.log("hi")'), '.js');
  const cssHash   = expectedHash(Buffer.from('body{font:14px sans-serif}'), '.css');

  try {
    // ── 1. dryRun ─────────────────────────────────────────────────
    {
      const { ctx, handlers } = makeCtx('demo', projectDir, stateDir, pluginDataDir);
      await plugin.init!(ctx);
      const r = await handlers.publish(ctx, { dryRun: true }, undefined);
      log('dryRun ok=true', r.ok === true, JSON.stringify(r));
      log('dryRun fileCount=3', r.result?.fileCount === 3);
      log('dryRun target', r.result?.wouldPublishTo === 'https://demo-site.pages.dev');
    }

    // ── 2. publish requires CLOUDFLARE_API_TOKEN ──────────────────
    {
      delete process.env.CLOUDFLARE_API_TOKEN;
      const { ctx, handlers } = makeCtx('demo', projectDir, stateDir, pluginDataDir);
      await plugin.init!(ctx);
      const r = await handlers.publish(ctx, {}, undefined);
      log('publish without token errors', r.ok === false && /CLOUDFLARE_API_TOKEN/.test(r.error ?? ''));
    }

    // ── 3. publish with all assets missing ────────────────────────
    {
      process.env.CLOUDFLARE_API_TOKEN = 'test-token';
      const m = makeMockFetch();
      globalThis.fetch = m.mockFetch as typeof fetch;

      const { ctx, handlers } = makeCtx('demo', projectDir, stateDir, pluginDataDir);
      await plugin.init!(ctx);
      const r = await handlers.publish(ctx, {}, undefined);
      log('publish ok=true', r.ok === true, r.error);
      log('publish url returned', r.result?.url === 'https://abc.example.pages.dev');
      log('publish uploaded all 3', r.result?.uploaded === 3, `got ${r.result?.uploaded}`);
      log('manifest has all paths', !!m.manifest && m.manifest['/index.html'] === indexHash && m.manifest['/assets/app.js'] === jsHash && m.manifest['/assets/styles.css'] === cssHash);
      log('check-missing called', m.calls.some((c) => c.url.endsWith('/check-missing')));
      log('upload-token called', m.calls.some((c) => c.url.endsWith('/upload-token')));
      log('deployment created', m.calls.some((c) => c.url.endsWith('/deployments')));
    }

    // ── 4. publish with some assets already cached ────────────────
    {
      const m = makeMockFetch({ knownHashes: new Set([jsHash]) });
      globalThis.fetch = m.mockFetch as typeof fetch;

      const { ctx, handlers } = makeCtx('demo', projectDir, stateDir, pluginDataDir);
      await plugin.init!(ctx);
      const r = await handlers.publish(ctx, {}, undefined);
      log('cache-hit publish ok', r.ok === true, r.error);
      log('cache-hit uploaded only 2', r.result?.uploaded === 2, `got ${r.result?.uploaded}`);
      log('cache-hit jsHash NOT uploaded', !m.uploadedHashes.includes(jsHash));
    }

    // ── 5. abort cancels in-flight upload ─────────────────────────
    {
      const m = makeMockFetch();
      globalThis.fetch = m.mockFetch as typeof fetch;
      const ctrl = new AbortController();
      const { ctx, handlers } = makeCtx('demo', projectDir, stateDir, pluginDataDir);
      await plugin.init!(ctx);
      ctrl.abort();
      const r = await handlers.publish(ctx, {}, ctrl.signal);
      log('abort surfaces ok=false', r.ok === false && /aborted/.test(r.error ?? ''), r.error);
    }

    // ── 6. deployment-API failure surfaces ────────────────────────
    {
      const m = makeMockFetch({ failUploadOnce: true });
      globalThis.fetch = m.mockFetch as typeof fetch;
      const { ctx, handlers } = makeCtx('demo', projectDir, stateDir, pluginDataDir);
      await plugin.init!(ctx);
      const r = await handlers.publish(ctx, {}, undefined);
      log('upload 500 surfaces ok=false', r.ok === false && /HTTP 500|simulated 500/.test(r.error ?? ''), r.error);
    }

    // ── 7. afterDone hook fires + publishes when configured ───────
    {
      process.env.CLOUDFLARE_API_TOKEN = 'test-token';
      const m = makeMockFetch();
      globalThis.fetch = m.mockFetch as typeof fetch;
      const logs: string[] = [];
      const { ctx } = makeCtx('demo', projectDir, stateDir, pluginDataDir);
      ctx.log = (s: string) => logs.push(s);
      await plugin.hooks!.afterDone!(ctx);
      log('afterDone called Cloudflare', m.calls.some((c) => c.url.endsWith('/deployments')));
      log('afterDone logged success URL', logs.some((s) => /afterDone published.*pages\.dev/.test(s)), logs.join(' || '));
    }

    // ── 8. afterDone silent-skips when not configured ─────────────
    {
      // Empty config → no accountId/projectName
      const emptyDataDir = join(root, 'empty-plugin-data');
      await mkdir(emptyDataDir, { recursive: true });
      await writeFile(join(emptyDataDir, 'config.json'), '{}');
      const m = makeMockFetch();
      globalThis.fetch = m.mockFetch as typeof fetch;
      const logs: string[] = [];
      const { ctx } = makeCtx('demo', projectDir, stateDir, emptyDataDir);
      ctx.log = (s: string) => logs.push(s);
      await plugin.hooks!.afterDone!(ctx);
      log('afterDone no-CF: no Cloudflare calls', !m.calls.some((c) => c.url.includes('cloudflare.com')));
      log('afterDone no-CF: skip message logged', logs.some((s) => /skipped.*not configured/.test(s)), logs.join(' || '));
    }

    // ── 9. afterDone swallows publish errors ──────────────────────
    {
      // Force an error: make fetch always 500
      const failingFetch: typeof fetch = async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'boom' }] }), { status: 500 });
      globalThis.fetch = failingFetch;
      const logs: string[] = [];
      const { ctx } = makeCtx('demo', projectDir, stateDir, pluginDataDir);
      ctx.log = (s: string) => logs.push(s);
      let threw = false;
      try { await plugin.hooks!.afterDone!(ctx); } catch { threw = true; }
      log('afterDone swallows errors (no throw)', !threw);
      log('afterDone logs failure', logs.some((s) => /publish failed|publish threw/.test(s)), logs.join(' || '));
    }

  } finally {
    globalThis.fetch = origFetch;
    if (origToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = origToken;
    await rm(root, { recursive: true, force: true });
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
