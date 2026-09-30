/**
 * POST /api/admin/testing/ai-explore — SSE stream of an AI browser exploration
 * run (stagehand-runner subprocess).
 *
 * Thin operator mount over `@papercusp/testing-shell/server` (Phase 6 of
 * universal-testing-domains-generic-2026-06-03): the runner, config parsing, and
 * spawn now live in the lib (`parseAiExploreConfig` / `spawnAiExplore` /
 * `parseAiExploreLine`). This route keeps the operator's `defineTool` +
 * `sseResponse` wrapper (typed vocab + heartbeats) and injects the Anthropic key
 * from the operator credential store. Hono consumers (Restart) use
 * `spawnAiExploreSSE` directly.
 */
import { createInterface } from 'node:readline';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { sseResponse } from '@papercusp/sse';
import { parseAiExploreConfig, spawnAiExplore, parseAiExploreLine } from '@papercusp/testing-shell/server';
import { readCredentials } from '../../../credentials';
import { defineTool } from '@papercusp/agent-mcp';

type AiExploreVocab = {
  start: { goal: string; model: string; startUrl: string };
  step: { n: number; action: string; ok: boolean; durationMs: number; result?: string | null };
  log: { level: string; line: string };
  metrics: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
  done: { totalMs: number; steps: number; costUsd: number; exitCode: number };
  error: { message: string };
}

// The :3070 host runs with cwd = apps/operator; the lib resolves the bundled
// stagehand-runner.mjs from <repoRoot>/libs/testing-shell/. Tolerate cwd = repo root too.
function resolveRepoRoot(): string {
  const up = path.resolve(process.cwd(), '..', '..');
  return existsSync(path.join(up, 'libs', 'testing-shell')) ? up : process.cwd();
}

/**
 * The inference gateway ROOT — deliberately NOT `/v1`-suffixed. Stagehand routes an
 * `anthropic/*` model through @anthropic-ai/sdk, which appends `/v1/messages` itself, so a
 * `/v1` base would resolve to `/v1/v1/messages` and 404. (agent-loop/provider-router.ts's
 * private helper DOES append `/v1` because it feeds the OpenAI-compatible AI-SDK path — the
 * two are not interchangeable.)
 */
function gatewayRootUrl(): string {
  const port = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 8788}`;
}

export default defineTool({
  method: 'POST',
  path: '/admin/testing/ai-explore',
  auth: { trust: ['verified', 'trusted'] },
  sampleRate: 0,
  async handler(req): Promise<Response> {
    const body = await req.json().catch(() => null);
    // Project-agnostic (D-002): the AI walk drives whatever startUrl it's given;
    // the operator's default is its own :3055 SPA, overridable via AI_EXPLORE_BASE_URL.
    const parsed = parseAiExploreConfig(body, {
      defaultStartUrl: process.env.AI_EXPLORE_BASE_URL ?? 'http://127.0.0.1:3055/',
    });
    if (!parsed.ok) return new Response(parsed.msg, { status: 400 });

    // WI-37573 removed the raw-key requirement this route used to carry. The blocker was real
    // but narrow: the runner handed Stagehand `{ modelName, apiKey }` with no baseURL seam, so
    // there was nowhere to point at the gateway. Stagehand's ModelConfiguration is
    // `ClientOptions & { modelName }` and ClientOptions already carries `baseURL`, so the seam
    // only had to be threaded — see spawnAiExplore's `baseUrl`.
    //
    // A configured raw key still WINS (unchanged behavior, and the escape hatch when someone
    // wants to bypass the pool). Otherwise this routes through the gateway's
    // Anthropic-compatible surface on the default account, which is what every other former
    // anthropic_api_key consumer already does.
    const creds = await readCredentials();
    const rawKey = creds.anthropic_api_key?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
    // The gateway strips inbound `authorization`/`x-api-key` (STRIP_REQUEST) and substitutes the
    // resolved account's own credential plus the `anthropic-beta: oauth-2025-04-20` header an
    // OAuth-bearer subscription needs — so this placeholder is never sent upstream. It is still
    // required because the Anthropic SDK throws locally on a missing key before any request.
    const apiKey = rawKey || 'gateway-routed-placeholder';
    const baseUrl = rawKey ? undefined : gatewayRootUrl();

    const repoRoot = resolveRepoRoot();

    return sseResponse<AiExploreVocab>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: async (sink) => {
        const child = spawnAiExplore(parsed.cfg, { repoRoot, apiKey, baseUrl });
        if (!child) {
          if (!sink.closed) sink.event('error', { message: `stagehand-runner not found under ${repoRoot}` });
          sink.done();
          return;
        }

        const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        rl.on('line', (line) => {
          if (sink.closed) return;
          const evt = parseAiExploreLine(line);
          if (!evt) return;
          const { type, ...payload } = evt;
          sink.event(type as keyof AiExploreVocab, payload as AiExploreVocab[keyof AiExploreVocab]);
        });

        const errRl = createInterface({ input: child.stderr!, crlfDelay: Infinity });
        errRl.on('line', (line) => {
          if (!sink.closed) sink.event('log', { level: 'error', line: line.slice(0, 500) });
        });

        child.on('error', (err) => {
          if (!sink.closed) sink.event('error', { message: String(err?.message ?? err) });
        });

        child.on('exit', (code) => {
          if (sink.closed) return;
          sink.event('done', { totalMs: 0, steps: 0, costUsd: 0, exitCode: code ?? -1 });
          sink.done();
        });

        // Kill child if client aborts.
        req.signal.addEventListener('abort', () => {
          try { child.kill('SIGTERM'); } catch { /* already dead */ }
        });
      },
    });
  },
});
