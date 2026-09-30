/**
 * createK6HonoRoutes — a Hono convenience router over the framework-agnostic
 * k6 cores in ./k6 (Phase 1 of universal-testing-domains-generic-2026-06-03).
 *
 * Kept OUT of the ./server barrel so importing `@papercusp/testing-shell/server`
 * never requires the optional `hono` peer dep (D-006). Hono consumers import
 * this subpath explicitly: `@papercusp/testing-shell/server/k6-routes`.
 * Non-Hono hosts (e.g. the operator's defineTool) wrap the ./k6 cores directly.
 *
 * The host injects `resolvePaths` to map the optional `?project=` query to its
 * own repo/script/result dirs — that's the only project-specific seam.
 */
import { Hono } from 'hono';
import { listK6Scripts, listK6Results, getK6Result, runK6Stream, stopK6, K6_ID_RE } from './k6';

export interface K6RoutesConfig {
  /** Absolute path to the k6 binary. */
  k6Bin: string;
  /** Map an optional project id to its repo/script/result dirs. */
  resolvePaths: (project: string | undefined) => { repoRoot: string; scriptsDir: string; resultsDir: string };
}

export function createK6HonoRoutes(cfg: K6RoutesConfig): Hono {
  const app = new Hono();

  app.get('/scripts', (c) => {
    const { scriptsDir } = cfg.resolvePaths(c.req.query('project') ?? undefined);
    return c.json({ scripts: listK6Scripts(scriptsDir) });
  });

  app.post('/run', async (c) => {
    let body: { project?: string; scriptId?: string; vus?: number; duration?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const { project, scriptId, vus, duration } = body;
    if (!scriptId || !K6_ID_RE.test(scriptId)) {
      return c.json({ error: 'Missing or invalid scriptId' }, 400);
    }
    const { repoRoot, scriptsDir, resultsDir } = cfg.resolvePaths(project);
    const stream = runK6Stream({ k6Bin: cfg.k6Bin, scriptId, scriptsDir, resultsDir, repoRoot, vus, duration, project });
    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  });

  app.post('/stop', (c) => c.json({ ok: stopK6() }));

  app.get('/results', (c) => {
    const { resultsDir } = cfg.resolvePaths(c.req.query('project') ?? undefined);
    return c.json({ results: listK6Results(resultsDir) });
  });

  app.get('/results/:id', (c) => {
    const { resultsDir } = cfg.resolvePaths(c.req.query('project') ?? undefined);
    const result = getK6Result(resultsDir, c.req.param('id'));
    if (!result) return c.json({ error: 'Not found' }, 404);
    return c.json(result);
  });

  return app;
}
