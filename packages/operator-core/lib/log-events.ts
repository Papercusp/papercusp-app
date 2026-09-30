/**
 * Structured log-event substrate. Mirrors the JSONL shape that
 * libs/papercusp/packages/harness/run.sh writes for harness-side events.
 *
 * Every entry is one line of JSON in <harness>/.papercusp/logs/run.log.jsonl,
 * read by the operator's SSE handler and the LogView UI.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel =
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'decision'
  | 'iteration'
  | 'plan';

export interface LogEvent {
  /** ISO-8601 timestamp. */
  ts: string;
  /**
   * Where the line came from. Conventional values:
   *   - 'harness'             — run.sh's own log() function
   *   - 'plugin:<slug>'       — output from a plugin (ctx.log + console.* hooks)
   *   - 'claude'              — claude CLI invocations (future)
   *   - 'browser'             — playwright / browser-use console (future)
   */
  source: string;
  level: LogLevel;
  msg: string;
  /** Correlation id threading the lines from a single user action / invocation. */
  corrId?: string;
  /** Free-form structured attrs (e.g. { url, deploymentId } from a publish). */
  attrs?: Record<string, unknown>;
}

/**
 * Per-plugin invocation context tracked across awaits via AsyncLocalStorage.
 * console.log/.warn/.error calls inside an async stack with this set get
 * attributed to the right plugin + harness, even across deep promise chains.
 */
interface PluginExecutionContext {
  pluginSlug: string;
  harnessSlug: string;
  corrId?: string;
  /** Path to the harness's run.log.jsonl. */
  jsonlPath: string;
}

// `AsyncLocalStorage` is Node-only; guard construction so this server module
// can be transitively imported by the client (operator-vite) bundle without
// throwing "undefined is not a constructor" at module load. The accessors
// no-op safely in the browser (plugin-exec context is server-only).
const pluginExecCtx =
  typeof AsyncLocalStorage === 'function'
    ? new AsyncLocalStorage<PluginExecutionContext>()
    : undefined;

/** Return the active plugin-execution context, if any. */
export function currentPluginExecCtx(): PluginExecutionContext | undefined {
  return pluginExecCtx?.getStore();
}

/** Run `fn` with a plugin-execution context attached to its async stack. */
export function runWithPluginExecCtx<T>(
  ctx: PluginExecutionContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return pluginExecCtx ? pluginExecCtx.run(ctx, fn) : fn();
}

/**
 * Resolve the run.log.jsonl path for a harness slug. The harness layout
 * is .papercusp/logs/run.log.jsonl under the project root, but in some
 * code paths we get a stateDir directly — accept either.
 */
export function jsonlPathForStateDir(stateDir: string): string {
  return join(stateDir, 'logs', 'run.log.jsonl');
}

/**
 * Append a structured event to a harness's run.log.jsonl.
 *
 * Best-effort: if the harness logs dir doesn't exist or the write fails
 * (disk full, permissions), we swallow the error rather than crashing
 * a plugin handler. Logs are diagnostic — they shouldn't be load-bearing
 * to the operator's runtime.
 */
export async function appendLogEvent(jsonlPath: string, event: LogEvent): Promise<void> {
  try {
    const dir = dirname(jsonlPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(event) + '\n';
    await appendFile(jsonlPath, line, 'utf8');
  } catch {
    /* swallow — see jsdoc */
  }
}

/** Synchronous variant for code that can't await (e.g. in console interceptors). */
export function appendLogEventSync(jsonlPath: string, event: LogEvent): void {
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const dir = dirname(jsonlPath);
    if (!existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(jsonlPath, line, 'utf8');
  } catch {
    /* swallow */
  }
}

/**
 * Format console.* args the way Node's util.format does — concatenates
 * primitives with spaces, formats objects as inspect output. Used by the
 * console.* interceptor so a plugin's `console.log({a: 1}, 'foo')` lands
 * in JSONL as `{ a: 1 } foo` (matching what they'd see in their terminal).
 */
export function formatConsoleArgs(args: unknown[]): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { format } = require('node:util') as typeof import('node:util');
  return format(...args);
}

/**
 * Install a console.* interceptor at module-load time. Wraps the global
 * `console.log/.warn/.error` once; calls inside a `pluginExecCtx.run()`
 * scope get attributed to the plugin, calls outside pass through unchanged.
 *
 * Idempotent — safe to call multiple times (the second call is a no-op).
 */
const __installedFlag = Symbol.for('papercusp.console.intercepted');
type FlaggedConsole = Console & { [k: symbol]: boolean };

export function installConsoleInterceptor(): void {
  const c = console as FlaggedConsole;
  if (c[__installedFlag]) return;

  const realLog = console.log.bind(console);
  const realWarn = console.warn.bind(console);
  const realError = console.error.bind(console);

  const wrap = (level: LogLevel, real: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      const exec = pluginExecCtx.getStore();
      if (exec) {
        appendLogEventSync(exec.jsonlPath, {
          ts: new Date().toISOString(),
          source: `plugin:${exec.pluginSlug}`,
          level,
          msg: formatConsoleArgs(args),
          ...(exec.corrId ? { corrId: exec.corrId } : {}),
        });
      }
      real(...args);
    };

  console.log = wrap('info', realLog);
  console.warn = wrap('warn', realWarn);
  console.error = wrap('error', realError);
  c[__installedFlag] = true;
}
