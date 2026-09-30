/**
 * GET /api/harness/:slug/branch/:branch/action-stream?runId=&name=
 *
 * SSE stream of a single action run. Backfill from log file + live bus.
 *
 * Ported from app/api/harness/[slug]/branch/[branch]/action-stream/route.ts.
 * `auth: 'public'`.
 */
import { promises as fs } from 'node:fs';
import { sseResponse } from '@papercusp/sse';
import { loadHarnessRegistry } from '../../../harness-registry';
import { isBranch, runLogPath } from '../../../branch-actions';
import { subscribe as subscribeAction } from '../../../branch-action-bus';
import { defineTool } from '@papercusp/agent-mcp';

type Events = {
  attached: { runId: string; slug: string; branch: string; name: string };
  'action-started': Record<string, unknown>;
  'action-completed': Record<string, unknown>;
  'action-failed': Record<string, unknown>;
  output: { line: string };
  stderr: { line: string };
  done: { reason: string; kind: string };
}

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/branch/:branch/action-stream',
  auth: 'public',
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const branch = ctx.params.branch as string;
    if (!isBranch(branch)) return new Response('invalid branch', { status: 400 });
    const url = new URL(req.url);
    const name = url.searchParams.get('name') ?? '';
    const runId = url.searchParams.get('runId');
    if (!name) return new Response('name required', { status: 400 });
    if (!runId) return new Response('runId required', { status: 400 });
    if (!/^run-[A-Za-z0-9_-]+$/.test(runId)) {
      return new Response('invalid runId', { status: 400 });
    }

    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) return new Response('unknown project', { status: 404 });

    const logPath = runLogPath(project.path, branch, name, runId);

    return sseResponse<Events>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: false,
      setup: async (sink) => {
        sink.event('attached', { runId, slug, branch, name });

        let terminalFromBackfill = false;
        const emitLineFromLog = (line: string): void => {
          if (line.startsWith('::papercusp::action-started\t')) {
            sink.event('action-started', JSON.parse(line.slice('::papercusp::action-started\t'.length)));
          } else if (line.startsWith('::papercusp::action-completed\t')) {
            sink.event('action-completed', JSON.parse(line.slice('::papercusp::action-completed\t'.length)));
            sink.event('done', { reason: 'terminal-during-backfill', kind: 'completed' });
            terminalFromBackfill = true;
          } else if (line.startsWith('::papercusp::action-failed\t')) {
            sink.event('action-failed', JSON.parse(line.slice('::papercusp::action-failed\t'.length)));
            sink.event('done', { reason: 'terminal-during-backfill', kind: 'failed' });
            terminalFromBackfill = true;
          } else if (line.startsWith('::papercusp::stderr\t')) {
            sink.event('stderr', { line: line.slice('::papercusp::stderr\t'.length) });
          } else {
            sink.event('output', { line });
          }
        };

        try {
          const raw = await fs.readFile(logPath, 'utf8');
          for (const line of raw.split('\n')) {
            if (line.length === 0) continue;
            emitLineFromLog(line);
            if (terminalFromBackfill) {
              sink.close();
              return;
            }
          }
        } catch { /* file not present yet */ }

        const channelKey = `${slug}:${runId}`;
        const sub = subscribeAction(channelKey, (env) => {
          if (sink.closed) return;
          if (env.kind === 'started') {
            sink.event('action-started', env.meta ?? {});
          } else if (env.kind === 'completed') {
            sink.event('action-completed', env.meta ?? {});
            sink.event('done', { reason: 'terminal', kind: 'completed' });
            sink.close();
          } else if (env.kind === 'failed') {
            sink.event('action-failed', env.meta ?? {});
            sink.event('done', { reason: 'terminal', kind: 'failed' });
            sink.close();
          } else if (env.kind === 'stderr') {
            for (const line of env.text.split('\n')) {
              if (line.length > 0) sink.event('stderr', { line });
            }
          } else if (env.kind === 'output') {
            for (const line of env.text.split('\n')) {
              if (line.length > 0) sink.event('output', { line });
            }
          }
        });
        sink.onClose(sub.unsubscribe);
      },
    });
  },
});
