/**
 * Phase 6b — server-side plugin runtime dispatcher.
 *
 * Mounts at: POST /api/plugin-runtime/<slug>/<plugin>/<service>/<method>
 * Body:      { args: unknown[] }
 *
 * Builds a per-plugin PapercuspApi via `buildPluginRuntime()` (using the
 * plugin's manifest-declared capabilities) and dispatches `args` to the
 * named service method. Returns the result as JSON, or a 4xx with a
 * machine-readable error code if the call is invalid / cap-blocked.
 *
 * This is the over-the-wire side of the in-browser PapercuspApi. The
 * client wraps each method in a fetch() that POSTs here.
 *
 * Capability checks happen inside buildPluginRuntime — if the manifest
 * doesn't declare the cap the method needs, the proxy throws
 * MissingCapabilityError; we surface that as HTTP 403.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { buildPluginRuntime } from '@/lib/plugin-host';
import type { Capability, Plugin } from '@papercusp/plugin-sdk';

export const dynamic = 'force-dynamic';

const PAPERCUSP_ROOT = join(homedir(), '.papercusp');

interface ManifestShape {
  name: string;
  version: string;
  capabilities?: string[];
  papercusp?: string;
  description?: string;
}

async function readManifestForPlugin(slug: string, pluginName: string): Promise<ManifestShape | null> {
  // Search order matches the plugin loader: project > harness > global.
  const candidates = [
    join(PAPERCUSP_ROOT, 'harnesses', slug, 'plugins', pluginName, 'papercusp.json'),
    join(PAPERCUSP_ROOT, 'global-plugins', pluginName, 'papercusp.json'),
  ];
  for (const path of candidates) {
    try {
      const raw = await fs.readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as ManifestShape;
      if (parsed?.name && parsed?.version) return parsed;
    } catch {
      // try next
    }
  }
  return null;
}

const ALLOWED_SERVICES = new Set([
  'tasks', 'goals', 'pendingEvents', 'routines', 'comments',
  'secrets', 'fetch', 'storage', 'db',
]);

interface DispatchParams {
  params: Promise<{ slug: string; plugin: string; path: string[] }>;
}

export async function POST(req: NextRequest, ctx: DispatchParams) {
  const { slug, plugin: pluginName, path } = await ctx.params;
  if (!Array.isArray(path) || path.length < 2) {
    return NextResponse.json(
      { error: 'badPath', detail: 'expected /<service>/<method>' },
      { status: 400 },
    );
  }
  const [service, method] = path;

  if (!ALLOWED_SERVICES.has(service)) {
    return NextResponse.json(
      { error: 'unknownService', service },
      { status: 400 },
    );
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
    return NextResponse.json(
      { error: 'pluginNotFound', plugin: pluginName, slug },
      { status: 404 },
    );
  }

  const fakePlugin: Plugin = {
    kind: 'plugin',
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? '',
    capabilities: (manifest.capabilities ?? []) as Capability[],
  } as Plugin;

  const runtime = buildPluginRuntime({ slug, plugin: fakePlugin });
  const target = (runtime.api as any)[service];
  if (!target || typeof target !== 'object') {
    return NextResponse.json(
      { error: 'serviceNotResolved', service },
      { status: 500 },
    );
  }
  const fn = target[method];
  if (typeof fn !== 'function') {
    return NextResponse.json(
      { error: 'unknownMethod', service, method },
      { status: 400 },
    );
  }

  try {
    const result = await fn.apply(target, args);
    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (e: any) {
    const name = e?.name ?? 'Error';
    if (name === 'MissingCapabilityError') {
      return NextResponse.json(
        { error: 'missingCapability', detail: String(e?.message ?? e), capability: e?.capability },
        { status: 403 },
      );
    }
    if (name === 'UnknownMethodError') {
      return NextResponse.json(
        { error: 'unknownMethod', detail: String(e?.message ?? e) },
        { status: 400 },
      );
    }
    if (name === 'NotYetWiredError') {
      return NextResponse.json(
        { error: 'notYetWired', detail: String(e?.message ?? e) },
        { status: 501 },
      );
    }
    return NextResponse.json(
      { error: 'runtime', detail: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
