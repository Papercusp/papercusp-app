/**
 * Device harness routes — Phase E4 batch M4 (endpoint-unification-2026-05-21).
 * Ported off `_hono/mobile.ts`.
 *
 *   GET  /device/harnesses                      device JWT
 *   GET  /device/harnesses/:slug                device JWT
 *   POST /device/harnesses/:slug/replan         device JWT
 *   POST /device/harnesses/:slug/smoke-test     device JWT
 *   POST /device/harnesses/:slug/cleanup        device JWT
 *   GET  /device/harnesses/:slug/log/stream     device JWT (SSE)
 *   GET  /device/running                        device JWT
 */
import { join } from 'node:path';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { sseResponse } from '@papercusp/sse';
import { defineTool } from '@papercusp/agent-mcp';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { listHarnessesFor, harnessExistsInWorkspace } from '../../../device-harnesses';
import { currentlyRunning } from '../../../device-feeds';
import { phasePhaseLabel } from '../../../harness-phases';
import { resolvePhasedProject, harnessDir } from '../../../harness-core';

/**
 * Proxy a device harness mutation to the desktop's own
 * `/api/harness/:slug/*` endpoint. The slug is verified to exist in the
 * phone's paired workspace first; the action runs against the desktop's
 * active workspace (matching workspace_id is required for the desktop
 * endpoint to find the slug — a mismatch surfaces as the proxied 404).
 */
async function shimHarnessAction(
  workspaceId: string,
  slug: string,
  path: string,
  body: unknown = {},
): Promise<Response> {
  if (!(await harnessExistsInWorkspace(workspaceId, slug))) {
    return Response.json({ error: 'harness_not_in_workspace' }, { status: 404 });
  }
  const base = process.env.MOBILE_SELF_BASE ?? `http://localhost:${process.env.PORT ?? 3055}`;
  const res = await fetch(`${base}/api/harness/${encodeURIComponent(slug)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

/** GET /device/harnesses — every harness in the device's workspace. */
const harnessesList = defineTool({
  method: 'GET',
  path: '/device/harnesses',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const harnesses = await listHarnessesFor(devicePrincipal(ctx).workspaceId);
    return Response.json({ harnesses });
  },
});

/**
 * GET /device/harnesses/:slug — per-harness status. Same shape as the
 * desktop `/api/harness/:slug/status` so the Rust client + desktop see
 * identical fields.
 */
const harnessDetail = defineTool({
  method: 'GET',
  path: '/device/harnesses/:slug',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    const slug = ctx.params.slug;
    if (!(await harnessExistsInWorkspace(principal.workspaceId, slug))) {
      return Response.json({ error: 'harness_not_in_workspace' }, { status: 404 });
    }
    const { getHarnessStatusFull } = await import('../../../harness-core');
    // P-008: the device detail must not push the 20MB features array to a paired
    // phone — the mobile UI works off `counts` (its slim list route already does).
    const status = await getHarnessStatusFull(slug, undefined, { includeFeatures: false });
    if (!status) return Response.json({ error: 'harness_not_found' }, { status: 404 });
    return Response.json(status);
  },
});

const harnessReplan = defineTool({
  method: 'POST',
  path: '/device/harnesses/:slug/replan',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const body = await req.json().catch(() => ({}));
    return shimHarnessAction(devicePrincipal(ctx).workspaceId, ctx.params.slug, '/replan', body);
  },
});

const harnessSmokeTest = defineTool({
  method: 'POST',
  path: '/device/harnesses/:slug/smoke-test',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    return shimHarnessAction(devicePrincipal(ctx).workspaceId, ctx.params.slug, '/smoke-test/run');
  },
});

const harnessCleanup = defineTool({
  method: 'POST',
  path: '/device/harnesses/:slug/cleanup',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    return shimHarnessAction(devicePrincipal(ctx).workspaceId, ctx.params.slug, '/cleanup');
  },
});

/**
 * GET /device/harnesses/:slug/log/stream — SSE. Mirrors the desktop
 * `/api/harness/:slug/log/stream` (events: log / backfill-done) but
 * gated on the device JWT. Workspace check enforced; `?phase=` override.
 */
const harnessLogStream = defineTool({
  method: 'GET',
  path: '/device/harnesses/:slug/log/stream',
  auth: DEVICE_AUTH,
  cors: true,
  // Pure transport — don't flood route_invocations with one row per
  // long-lived SSE connection.
  sampleRate: 0,
  async handler(req, ctx) {
    const principal = devicePrincipal(ctx);
    const slug = ctx.params.slug;
    if (!(await harnessExistsInWorkspace(principal.workspaceId, slug))) {
      return Response.json({ error: 'harness_not_in_workspace' }, { status: 404 });
    }
    const url = new URL(req.url);
    const project = await resolvePhasedProject(slug, phasePhaseLabel(url.searchParams.get('phase') ?? undefined));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const jsonlPath = join(harnessDir(project), 'logs', 'run.log.jsonl');
    const tailSize = Math.min(
      Math.max(parseInt(url.searchParams.get('tail') ?? '500', 10) || 500, 1),
      5000,
    );

    return sseResponse({
      signal: req.signal,
      heartbeatMs: 15_000,
      setup: async (sink) => {
        // Backfill: read the last 1 MiB of jsonl, replay up to tailSize
        // valid lines as `event: log`, then `event: backfill-done`.
        try {
          const stat = statSync(jsonlPath);
          const tailBytes = 1024 * 1024;
          const start = Math.max(0, stat.size - tailBytes);
          const len = stat.size - start;
          const buf = Buffer.alloc(len);
          const fd = openSync(jsonlPath, 'r');
          try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
          let chunk = buf.toString('utf8');
          if (start > 0) {
            const firstNl = chunk.indexOf('\n');
            if (firstNl >= 0) chunk = chunk.slice(firstNl + 1);
          }
          const allLines = chunk.split('\n').filter(Boolean);
          const toReplay = allLines.slice(-tailSize);
          let count = 0;
          for (const raw of toReplay) {
            if (sink.closed) break;
            try { JSON.parse(raw); } catch { continue; }
            sink.eventRaw('log', raw);
            count++;
          }
          sink.eventRaw('backfill-done', String(count));
        } catch {
          sink.eventRaw('backfill-done', '0');
        }

        // Live updates via the in-process log bus.
        const { subscribe: logSubscribe } = await import('../../../harness-log-bus');
        const sub = logSubscribe(`${project.slug}:log`, (env) => {
          if (sink.closed) return;
          try { JSON.parse(env.line); } catch { return; }
          sink.eventRaw('log', env.line);
        });
        for (const env of sub.recent) {
          if (sink.closed) break;
          try { JSON.parse(env.line); } catch { continue; }
          sink.eventRaw('log', env.line);
        }
        sink.onClose(() => sub.unsubscribe());
      },
    });
  },
});

/** GET /device/running — active operator scan + active harness phases. */
const running = defineTool({
  method: 'GET',
  path: '/device/running',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    return Response.json(await currentlyRunning(devicePrincipal(ctx).workspaceId));
  },
});

export default [
  harnessesList,
  harnessDetail,
  harnessReplan,
  harnessSmokeTest,
  harnessCleanup,
  harnessLogStream,
  running,
];
