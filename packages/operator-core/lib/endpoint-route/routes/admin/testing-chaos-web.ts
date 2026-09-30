/**
 * POST /api/admin/testing/chaos-web — raw-NDJSON stream of a browser chaos run
 * (the `chaos` browser variant).
 *
 * Thin operator mount over `@papercusp/testing-shell/server`'s
 * `spawnChaosWebStream` (Phase 6 of universal-testing-domains-generic-2026-06-03):
 * the spawn/stream substance + the shared headless-Chromium clicker
 * (`chaos-runner.mjs`) now live in the lib, so this route only validates the
 * base URL, resolves the repo root, and returns the stream. Deliberately raw
 * NDJSON (not `sseResponse`): the shared <ChaosWebPanel> (also used by Restart)
 * parses NDJSON lines, so the framing must match across both hosts.
 *
 * The default baseUrl is the BUILT operator SPA on :3070 (the port the desktop
 * webview loads) — NOT the :3055 Vite HMR server, which fails to render
 * `createHotContext` in a plain headless browser.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnChaosWebStream, ALLOWED_BASE, clampMaxSteps } from '@papercusp/testing-shell/server';
import { defineTool } from '@papercusp/agent-mcp';

// The :3070 host runs with cwd = apps/operator; the lib resolves chaos-runner.mjs
// from <repoRoot>/libs/testing-shell/. Tolerate cwd = repo root too.
function resolveRepoRoot(): string {
  const up = path.resolve(process.cwd(), '..', '..');
  return existsSync(path.join(up, 'libs', 'testing-shell')) ? up : process.cwd();
}

export default defineTool({
  method: 'POST',
  path: '/admin/testing/chaos-web',
  auth: { trust: ['verified', 'trusted'] },
  sampleRate: 0,
  async handler(req): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { baseUrl?: string; maxSteps?: number } | null;
    const baseUrl =
      typeof body?.baseUrl === 'string'
        ? body.baseUrl
        : process.env.CHAOS_WEB_BASE_URL ?? 'http://127.0.0.1:3070/';
    if (!ALLOWED_BASE.test(baseUrl)) return new Response('baseUrl must be a localhost http(s) URL', { status: 400 });

    const stream = spawnChaosWebStream({
      baseUrl,
      maxSteps: clampMaxSteps(body?.maxSteps),
      repoRoot: resolveRepoRoot(),
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  },
});
