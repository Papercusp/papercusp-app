/**
 * AI Explore backend core (Phase 3 of universal-testing-domains-generic-2026-06-03).
 *
 * Framework-agnostic substance behind the operator's testing-ai-explore route,
 * generalized so any project drives its own base URL. Spawns the bundled
 * ../server/stagehand-runner.mjs with a JSON config on stdin and surfaces its
 * NDJSON events. The operator wraps spawnAiExplore + parseAiExploreLine in its
 * defineTool/sseResponse sink (keeping heartbeats); Hono consumers (Restart)
 * return spawnAiExploreSSE() directly.
 *
 * @browserbasehq/stagehand is an OPTIONAL peer dep — only `import()`ed inside
 * the runner subprocess, so importing this module never requires it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface AiExploreModel {
  /** Provider/model id passed to the runner (e.g. 'anthropic/claude-sonnet-4-6'). */
  value: string;
  label: string;
  /** USD per 1M input / output tokens (for the cost estimate the runner emits). */
  inputPer1M: number;
  outputPer1M: number;
}

/** Default model menu (mirrors the runner's ANTHROPIC_PRICING). Each app may override via the panel's `models` prop. */
export const DEFAULT_MODELS: AiExploreModel[] = [
  { value: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6 (default)', inputPer1M: 3.0, outputPer1M: 15.0 },
  { value: 'anthropic/claude-haiku-4-5', label: 'Haiku 4.5 (cheaper)', inputPer1M: 1.0, outputPer1M: 5.0 },
  { value: 'anthropic/claude-opus-4-7', label: 'Opus 4.7 (slowest, smartest)', inputPer1M: 15.0, outputPer1M: 75.0 },
];

export interface AiExploreConfig {
  goal: string;
  startUrl: string;
  model: string;
  maxSteps: number;
  maxCostUsd: number;
  headless: boolean;
}

export interface AiExploreEvent {
  type: string;
  [k: string]: unknown;
}

export interface ParseConfigOpts {
  /** Default base URL when the body omits startUrl. The lib bakes in none — the caller supplies its app's URL. */
  defaultStartUrl?: string;
  defaultModel?: string;
}

/**
 * Validate + normalize a request body into an AiExploreConfig (no apiKey — the
 * route injects that from its own credential store). Lifted from the operator
 * route's parseConfig; the only generalization is that the startUrl default is
 * a parameter, not a hardcoded :3055.
 */
export function parseAiExploreConfig(
  body: unknown,
  opts: ParseConfigOpts = {},
): { ok: true; cfg: AiExploreConfig } | { ok: false; msg: string } {
  if (!body || typeof body !== 'object') return { ok: false, msg: 'invalid body' };
  const b = body as Record<string, unknown>;
  const goal = typeof b.goal === 'string' ? b.goal.trim() : '';
  if (!goal) return { ok: false, msg: 'goal is required' };
  const startUrl = typeof b.startUrl === 'string' && b.startUrl.trim() ? b.startUrl.trim() : (opts.defaultStartUrl ?? '');
  if (!startUrl) return { ok: false, msg: 'startUrl is required' };
  return {
    ok: true,
    cfg: {
      goal,
      startUrl,
      model: typeof b.model === 'string' ? b.model : (opts.defaultModel ?? 'anthropic/claude-sonnet-4-6'),
      maxSteps: Math.max(1, Math.min(50, Number(b.maxSteps ?? 20))),
      maxCostUsd: Math.max(0.05, Math.min(20, Number(b.maxCostUsd ?? 1.0))),
      headless: b.headless !== false,
    },
  };
}

/** Resolve the bundled stagehand-runner.mjs from a consumer's repoRoot, or null. */
export function resolveStagehandRunner(repoRoot: string): string | null {
  const p = join(repoRoot, 'libs', 'testing-shell', 'src', 'server', 'stagehand-runner.mjs');
  return existsSync(p) ? p : null;
}

/** Parse one runner NDJSON line into an event; falls back to a log event for non-JSON. */
export function parseAiExploreLine(line: string): AiExploreEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const evt = JSON.parse(trimmed);
    if (typeof evt?.type !== 'string') return null;
    return evt as AiExploreEvent;
  } catch {
    return { type: 'log', level: 'info', line: trimmed.slice(0, 500) };
  }
}

export interface SpawnAiExploreOpts {
  /** Dir whose node_modules has @browserbasehq/stagehand + where the runner lives. */
  repoRoot: string;
  /** Anthropic (or provider) API key, injected by the caller's credential store. */
  apiKey: string;
  /**
   * Optional provider base URL for the runner's Stagehand model client — the ROOT of an
   * Anthropic-compatible surface (e.g. an inference gateway at `http://127.0.0.1:8788`),
   * NOT a `/v1` suffixed one: the Anthropic SDK appends `/v1/messages` itself, so a `/v1`
   * base silently 404s on `/v1/v1/messages`.
   *
   * When this points at a credential-injecting gateway, `apiKey` is a placeholder the proxy
   * discards (its STRIP_REQUEST drops inbound `authorization`/`x-api-key` and substitutes the
   * resolved account's own credential + the `anthropic-beta: oauth-2025-04-20` header an
   * OAuth-bearer subscription needs). It is still REQUIRED because the Anthropic SDK throws
   * locally on a missing key before any request is made.
   */
  baseUrl?: string;
}

/**
 * The runner's stdin payload. `baseUrl` is included ONLY when set, so the no-gateway path
 * stays byte-identical to what it was before that seam existed. Shared by both spawners so
 * the two cannot drift on which fields reach the subprocess.
 */
function runnerPayload(cfg: AiExploreConfig, opts: SpawnAiExploreOpts): string {
  return JSON.stringify({
    ...cfg,
    apiKey: opts.apiKey,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  });
}

/**
 * Spawn the stagehand runner with `cfg` (+apiKey, +baseUrl) written to stdin. Returns the
 * child; the caller reads child.stdout NDJSON (via parseAiExploreLine). Returns
 * null when the runner can't be resolved.
 */
export function spawnAiExplore(cfg: AiExploreConfig, opts: SpawnAiExploreOpts): ChildProcess | null {
  const runner = resolveStagehandRunner(opts.repoRoot);
  if (!runner) return null;
  const child = spawn(process.execPath, [runner], {
    cwd: opts.repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  child.stdin?.write(runnerPayload(cfg, opts));
  child.stdin?.end();
  return child;
}

const enc = new TextEncoder();
function sseFrame(type: string, payload: Record<string, unknown>): Uint8Array {
  return enc.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Convenience SSE producer for Hono consumers: spawn + relay the runner's
 * NDJSON as `event: <type>\ndata: <payload>\n\n` frames (the wire format
 * AiExplorePanel parses). stderr → `log` frames; child exit → a `done` frame
 * with exitCode. Returns a 400-style error frame stream if the runner is absent.
 */
export function spawnAiExploreSSE(cfg: AiExploreConfig, opts: SpawnAiExploreOpts): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const runner = resolveStagehandRunner(opts.repoRoot);
      if (!runner) {
        controller.enqueue(sseFrame('error', { message: `stagehand-runner not found under ${opts.repoRoot}` }));
        controller.close();
        return;
      }
      const child = spawn(process.execPath, [runner], { cwd: opts.repoRoot, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
      child.stdin?.write(runnerPayload(cfg, opts));
      child.stdin?.end();

      let outBuf = '';
      const pump = (chunk: Buffer, stderr: boolean) => {
        outBuf += chunk.toString();
        const lines = outBuf.split('\n');
        outBuf = lines.pop() ?? '';
        for (const line of lines) {
          if (stderr) {
            const t = line.trim();
            if (t) { try { controller.enqueue(sseFrame('log', { level: 'error', line: t.slice(0, 500) })); } catch { /* closed */ } }
            continue;
          }
          const evt = parseAiExploreLine(line);
          if (!evt) continue;
          const { type, ...payload } = evt;
          try { controller.enqueue(sseFrame(type, payload)); } catch { /* closed */ }
        }
      };
      child.stdout?.on('data', (b: Buffer) => pump(b, false));
      child.stderr?.on('data', (b: Buffer) => pump(b, true));
      child.on('error', (err: Error) => {
        try { controller.enqueue(sseFrame('error', { message: String(err?.message ?? err) })); } catch { /* closed */ }
      });
      child.on('exit', (code: number | null) => {
        try {
          controller.enqueue(sseFrame('done', { totalMs: 0, steps: 0, costUsd: 0, exitCode: code ?? -1 }));
          controller.close();
        } catch { /* already closed */ }
      });
    },
  });
}
