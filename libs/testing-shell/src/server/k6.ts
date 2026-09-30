/**
 * k6 load-test backend core (Phase 1 of universal-testing-domains-generic-2026-06-03).
 *
 * Framework-agnostic — NO React, NO Hono. Lifted from Restart's
 * apps/web/app/api/_hono/load-tests.ts so any project (Restart now; papercup
 * once it has scripts) drives k6 through the lib instead of a bespoke route.
 * Each app keeps a thin route wrapper that resolves its own script/result dirs
 * and mounts these cores (see createK6HonoRoutes in ./k6-routes for the Hono
 * convenience router, or wrap runK6Stream directly in any framework).
 *
 * The category taxonomy + colors live in the React-free `../k6` module
 * (k6CategoryColor/K6_CATEGORIES) and are reused by the panel — not duplicated
 * here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface K6ScriptMeta {
  id: string;
  name: string;
  description: string;
  category: string;
  estimatedDuration: string;
  defaultVUs: number;
}

export interface K6ResultMeta {
  id: string;
  /** Persisted as an explicit `null` when no project was supplied (stable JSON shape). */
  project?: string | null;
  scriptId: string;
  scriptName: string;
  startedAt: string;
  exitCode: number | null;
  log: string[];
}

/** A valid k6 script/result id — single path segment, no traversal. */
export const K6_ID_RE = /^[a-z0-9-]+$/;

/**
 * Pure: parse the `@name`/`@description`/`@category`/`@estimatedDuration`/
 * `@defaultVUs` doc-comment tags out of a script's source. Content is injected
 * (not read here) so this is unit-testable without the filesystem.
 */
export function parseScriptMeta(content: string, fileName: string): K6ScriptMeta {
  const id = fileName.replace(/\.js$/, '');
  const get = (tag: string): string => {
    const m = content.match(new RegExp(`@${tag}\\s+([^\\n*]+)`));
    return m ? m[1].trim() : '';
  };
  return {
    id,
    name: get('name') || id,
    description: get('description') || '',
    category: get('category') || 'load',
    estimatedDuration: get('estimatedDuration') || '',
    defaultVUs: parseInt(get('defaultVUs') || '10', 10),
  };
}

/** List every `*.js` k6 script in `scriptsDir` with parsed metadata. `[]` if the dir is missing/unreadable. */
export function listK6Scripts(scriptsDir: string): K6ScriptMeta[] {
  if (!existsSync(scriptsDir)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(scriptsDir).filter((f) => f.endsWith('.js'));
  } catch {
    return [];
  }
  return files.map((f) => {
    let content = '';
    try {
      content = readFileSync(join(scriptsDir, f), 'utf-8');
    } catch {
      /* unreadable — emit metadata with defaults */
    }
    return parseScriptMeta(content, f);
  });
}

/** List completed results (newest first) from the `*.meta.json` sidecars in `resultsDir`. */
export function listK6Results(resultsDir: string): K6ResultMeta[] {
  if (!existsSync(resultsDir)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(resultsDir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(resultsDir, f), 'utf-8')) as K6ResultMeta;
      } catch {
        return null;
      }
    })
    .filter((r): r is K6ResultMeta => r !== null)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

/** Read one result sidecar by id, or null if absent/unreadable. */
export function getK6Result(resultsDir: string, id: string): K6ResultMeta | null {
  if (!K6_ID_RE.test(id)) return null;
  const metaPath = join(resultsDir, `${id}.meta.json`);
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8')) as K6ResultMeta;
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();
function sse(obj: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

// One run at a time per process (mirrors Restart's single-child model).
let runningChild: ChildProcess | null = null;
let runningResultId: string | null = null;

export interface RunK6Opts {
  k6Bin: string;
  scriptId: string;
  scriptsDir: string;
  resultsDir: string;
  repoRoot: string;
  vus?: number;
  duration?: string;
  project?: string;
  /** Injectable clock for deterministic result ids in tests. */
  now?: () => number;
}

/**
 * Spawn `k6 run <script>`, streaming SSE frames `data: {type:'log'|'done'|'error', …}`.
 * Writes a `<resultId>.meta.json` sidecar (script name + collected log + exit code)
 * on close so listK6Results/getK6Result can surface it. Returns the SSE body stream.
 */
export function runK6Stream(opts: RunK6Opts): ReadableStream<Uint8Array> {
  const { k6Bin, scriptId, scriptsDir, resultsDir, repoRoot, vus, duration, project } = opts;
  const now = opts.now ?? (() => Date.now());
  const scriptPath = join(scriptsDir, `${scriptId}.js`);
  const resultId = `${now()}-${scriptId}`;
  const resultJsonPath = join(resultsDir, `${resultId}.json`);
  const scriptMeta = parseScriptMeta(
    (() => {
      try {
        return readFileSync(scriptPath, 'utf-8');
      } catch {
        return '';
      }
    })(),
    `${scriptId}.js`,
  );
  const startedAt = new Date(now()).toISOString();

  const args = ['run', '--out', `json=${resultJsonPath}`];
  if (vus) args.push('--vus', String(vus));
  if (duration) args.push('--duration', duration);
  args.push(scriptPath);

  const collectedLines: string[] = [];

  return new ReadableStream<Uint8Array>({
    start(controller) {
      mkdirSync(resultsDir, { recursive: true });
      const child = spawn(k6Bin, args, {
        cwd: repoRoot,
        env: {
          ...process.env,
          K6_WEB_DASHBOARD: 'true',
          K6_WEB_DASHBOARD_PORT: '5665',
          K6_WEB_DASHBOARD_OPEN: 'false',
        },
      });
      runningChild = child;
      runningResultId = resultId;

      const onData = (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line) {
            collectedLines.push(line);
            try {
              controller.enqueue(sse({ type: 'log', message: line }));
            } catch {
              /* stream closed */
            }
          }
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      child.on('close', (code: number | null) => {
        const exitCode = code ?? -1;
        try {
          writeFileSync(
            join(resultsDir, `${resultId}.meta.json`),
            JSON.stringify({
              id: resultId,
              project: project ?? null,
              scriptId,
              scriptName: scriptMeta.name,
              startedAt,
              exitCode,
              log: collectedLines,
            } satisfies K6ResultMeta),
            'utf-8',
          );
        } catch {
          /* non-fatal */
        }
        try {
          controller.enqueue(sse({ type: 'done', code: exitCode, resultId }));
          controller.close();
        } catch {
          /* already closed */
        }
        if (runningResultId === resultId) {
          runningChild = null;
          runningResultId = null;
        }
      });

      child.on('error', (err: Error) => {
        try {
          controller.enqueue(sse({ type: 'error', message: err.message }));
          controller.close();
        } catch {
          /* already closed */
        }
        if (runningResultId === resultId) {
          runningChild = null;
          runningResultId = null;
        }
      });
    },
    cancel() {
      try {
        runningChild?.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    },
  });
}

/** Kill the active k6 run, if any. Returns whether one was running. */
export function stopK6(): boolean {
  if (!runningChild) return false;
  try {
    runningChild.kill('SIGTERM');
  } catch {
    /* already dead */
  }
  runningChild = null;
  runningResultId = null;
  return true;
}
