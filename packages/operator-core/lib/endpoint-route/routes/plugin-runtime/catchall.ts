/**
 * POST /api/plugin-runtime/:slug/:plugin/<service>/<method>
 *
 * Phase 6b — server-side plugin runtime dispatcher. Builds a per-plugin
 * PapercuspApi from the manifest's capabilities and invokes the named
 * service.method with body.args. MissingCapabilityError → 403.
 *
 * Ported from app/api/plugin-runtime/[slug]/[plugin]/[...path]/route.ts.
 * `auth: 'loopback'` (auth-tier Wave 1).
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { buildPluginRuntime } from '../../../plugin-host';
import type { Capability, Plugin } from '@papercusp/plugin-sdk';
import { papercuspRoot } from '../../../papercusp-root';
import { defineTool } from '@papercusp/agent-mcp';

/**
 * Path-segment confinement (audit P-026): slug + plugin become directory
 * names under papercuspRoot() via join(), so they must be single, plain
 * segments — no dots-only names, no separators, no traversal. Mirrors the
 * harness-slug grammar (mig 044) plus the dot npm-style plugin dirs use.
 * (The URL layer already collapses well-formed `..` segments before
 * routing; this guard is the in-handler backstop for smuggled escapes —
 * double-encoded `%252e`, backslashes, raw-socket clients.) Exported for
 * tests.
 */
const SAFE_SEGMENT_RE = /^(?!\.)[a-z0-9._-]+$/i;
export function isSafeSegment(s: string): boolean {
  return SAFE_SEGMENT_RE.test(s) && !s.includes('..') && !s.includes('/') && !s.includes('\\');
}

interface ManifestShape {
  name: string;
  version: string;
  capabilities?: string[];
  papercusp?: string;
  description?: string;
}

async function readManifestForPlugin(slug: string, pluginName: string): Promise<ManifestShape | null> {
  const candidates = [
    join(papercuspRoot(), 'harnesses', slug, 'plugins', pluginName, 'papercusp.json'),
    join(papercuspRoot(), 'global-plugins', pluginName, 'papercusp.json'),
  ];
  // perf:allow A1 — find-first over 2 bounded manifest candidates, return on first valid.
  for (const path of candidates) {
    try {
      const raw = await fs.readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as ManifestShape;
      if (parsed?.name && parsed?.version) return parsed;
    } catch { /* try next */ }
  }
  return null;
}

const ALLOWED_SERVICES = new Set([
  'tasks', 'goals', 'pendingEvents', 'routines', 'comments',
  'secrets', 'fetch', 'storage', 'db',
]);

export default defineTool({
  method: 'POST',
  path: '/plugin-runtime/:slug/:plugin/*',
  auth: 'loopback',
  async handler(req, ctx) {
    // The dispatcher reaches secrets/db/fetch/storage services — loopback-only
    // (audit P-026). Legitimate callers (Tauri webview, harness agents, the
    // operator itself) are all on-box.

    const slug = ctx.params.slug as string;
    const pluginName = ctx.params.plugin as string;
    if (!isSafeSegment(slug) || !isSafeSegment(pluginName)) {
      return Response.json(
        { error: 'badIdent', detail: 'slug/plugin must be plain path segments' },
        { status: 400 },
      );
    }
    // Hono's `*` wildcard captures the remainder as a single string;
    // split into service/method segments.
    const url = new URL(req.url);
    const m = url.pathname.match(/\/plugin-runtime\/[^/]+\/[^/]+\/(.+)$/);
    const remainder = m ? m[1] : '';
    const path = remainder.split('/').filter(Boolean);

    if (path.length < 2) {
      return Response.json(
        { error: 'badPath', detail: 'expected /<service>/<method>' },
        { status: 400 },
      );
    }
    const [service, method] = path;

    if (!ALLOWED_SERVICES.has(service)) {
      return Response.json({ error: 'unknownService', service }, { status: 400 });
    }

    let body: { args?: unknown[] } = {};
    try {
      body = (await req.json()) as { args?: unknown[] };
    } catch {
      body = {};
    }
    const args = Array.isArray(body.args) ? body.args : [];

    const manifest = await readManifestForPlugin(slug, pluginName);
    if (!manifest) {
      return Response.json(
        { error: 'pluginNotFound', plugin: pluginName, slug },
        { status: 404 },
      );
    }

    const fakePlugin: Plugin = {
      name: manifest.name,
      version: manifest.version,
      papercusp: manifest.papercusp ?? '*',
      description: manifest.description ?? '',
      capabilities: (manifest.capabilities ?? []) as Capability[],
    };

    const runtime = buildPluginRuntime({ slug, plugin: fakePlugin });
    const target = (runtime.api as any)[service];
    if (!target || typeof target !== 'object') {
      return Response.json({ error: 'serviceNotResolved', service }, { status: 500 });
    }
    const fn = target[method];
    if (typeof fn !== 'function') {
      return Response.json({ error: 'unknownMethod', service, method }, { status: 400 });
    }

    try {
      const result = await fn.apply(target, args);
      return Response.json({ ok: true, result }, { status: 200 });
    } catch (e: any) {
      const name = e?.name ?? 'Error';
      if (name === 'MissingCapabilityError') {
        return Response.json(
          { error: 'missingCapability', detail: String(e?.message ?? e), capability: e?.capability },
          { status: 403 },
        );
      }
      if (name === 'UnknownMethodError') {
        return Response.json(
          { error: 'unknownMethod', detail: String(e?.message ?? e) },
          { status: 400 },
        );
      }
      if (name === 'NotYetWiredError') {
        return Response.json(
          { error: 'notYetWired', detail: String(e?.message ?? e) },
          { status: 501 },
        );
      }
      return Response.json(
        { error: 'runtime', detail: String(e?.message ?? e) },
        { status: 500 },
      );
    }
  },
});
