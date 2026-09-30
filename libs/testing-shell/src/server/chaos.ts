/**
 * chaos-web backend core (Phase 2 of universal-testing-domains-generic-2026-06-03).
 *
 * Framework-agnostic spawn/stream substance behind the chaos-web routes that
 * both Restart (Hono) and the operator (defineTool + sseResponse) duplicated.
 * It spawns the shared headless-Chromium clicker `../web/chaos-runner.mjs` and
 * forwards its NDJSON stdout verbatim, wrapping stderr as an error event. Each
 * app keeps a ~5-line route that adds auth + framing and returns this stream.
 *
 * Playwright is an OPTIONAL peer dep — it's only `import()`ed inside the runner
 * subprocess, so importing this module never requires it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** chaos drives a same-box dev origin only — never an arbitrary URL. */
export const ALLOWED_BASE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/** Bound a requested step count to [1, 200]; NaN/≤0 → the 25-step default. */
export function clampMaxSteps(n: unknown): number {
  return Math.max(1, Math.min(200, Math.floor(Number(n)) || 25));
}

/**
 * Resolve the shared chaos-runner.mjs from a consumer's repoRoot (the submodule
 * always lives at the same repo-relative path in both repos). Returns null when
 * absent so the caller can surface a clean error.
 */
export function resolveChaosRunner(repoRoot: string): string | null {
  const p = join(repoRoot, 'libs', 'testing-shell', 'src', 'web', 'chaos-runner.mjs');
  return existsSync(p) ? p : null;
}

// One chaos run at a time per process (mirrors the load-tests single-child model).
let runningChild: ChildProcess | null = null;

export interface ChaosWebOpts {
  baseUrl: string;
  maxSteps: number;
  /** Dir whose node_modules has playwright + where chaos-runner.mjs lives. */
  repoRoot: string;
}

/**
 * Spawn chaos-runner.mjs and stream its NDJSON stdout verbatim. Runner stderr
 * (e.g. a failed chromium launch) is surfaced as a single `{type:'error'}` NDJSON
 * line. Caller is responsible for validating `baseUrl` against ALLOWED_BASE.
 */
export function spawnChaosWebStream({ baseUrl, maxSteps, repoRoot }: ChaosWebOpts): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const runner = resolveChaosRunner(repoRoot);
      if (!runner) {
        controller.enqueue(enc.encode(JSON.stringify({ type: 'error', message: `chaos-runner not found under ${repoRoot}` }) + '\n'));
        controller.close();
        return;
      }
      const child = spawn(process.execPath, [runner, baseUrl, String(maxSteps)], {
        cwd: repoRoot, // so chaos-runner's import('playwright') resolves from <repoRoot>/node_modules
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      runningChild = child;

      child.stdout?.on('data', (b: Buffer) => {
        try { controller.enqueue(enc.encode(b.toString())); } catch { /* stream closed */ }
      });
      child.stderr?.on('data', (b: Buffer) => {
        const msg = b.toString().trim();
        if (msg) {
          try { controller.enqueue(enc.encode(JSON.stringify({ type: 'error', message: msg }) + '\n')); } catch { /* closed */ }
        }
      });

      const finish = () => {
        try { controller.close(); } catch { /* already closed */ }
        if (runningChild === child) runningChild = null;
      };
      child.on('close', finish);
      child.on('error', (err: Error) => {
        try { controller.enqueue(enc.encode(JSON.stringify({ type: 'error', message: err.message }) + '\n')); } catch { /* closed */ }
        finish();
      });
    },
    cancel() {
      try { runningChild?.kill('SIGTERM'); } catch { /* already dead */ }
    },
  });
}

/** Kill the active chaos run, if any. Returns whether one was running. */
export function stopChaosWeb(): boolean {
  if (!runningChild) return false;
  try { runningChild.kill('SIGTERM'); } catch { /* already dead */ }
  runningChild = null;
  return true;
}
