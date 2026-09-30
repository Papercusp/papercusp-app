/**
 * behaviour-suite/runner-node — the LIVE node wiring for the (pure) runner.ts orchestration.
 *
 * runner.ts is deterministic + fs-free (injected RunnerDeps). This module supplies the real
 * side effects for the desktop path: a node `fs` port (dir listing + recursive jsonl glob +
 * readFile), a `psu` spawn as the launch, and a best-effort teardown. Kept OUT of runner.ts
 * so the orchestration stays unit-testable with fakes and this thin I/O shim carries the only
 * fs/child_process imports.
 *
 * Node-only (fs, os, child_process) — import from a tool handler / CLI, never from the pure
 * scoring path.
 */
import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { FoundFile, RunnerDeps, LaunchSpec } from './runner';

/** Expand a leading `~` to the user's home dir (the omp-homes root is written with `~`). */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

async function listDirsNode(dir: string): Promise<string[]> {
  const abs = expandHome(dir);
  if (!existsSync(abs)) return [];
  const ents = await fsp.readdir(abs, { withFileTypes: true });
  return ents.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function listFilesRecNode(dir: string, ext: string): Promise<FoundFile[]> {
  const abs = expandHome(dir);
  if (!existsSync(abs)) return [];
  const out: FoundFile[] = [];
  const walk = async (d: string): Promise<void> => {
    let ents: import('node:fs').Dirent[];
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith(ext)) {
        try {
          const st = await fsp.stat(full);
          out.push({ path: full, mtimeMs: st.mtimeMs });
        } catch {
          /* raced deletion — skip */
        }
      }
    }
  };
  await walk(abs);
  return out;
}

/** How to fire the visible launch. `psu` shells out to the superuser launcher (the CI /
 *  standalone path); `fleetLaunchOnPlan` lets a tool handler inject the fleet:launch-on-plan
 *  server call (the preferred desktop path, which passes --agent/--model for us). */
export interface NodeRunnerConfig {
  /** Absolute path to the workspace root (cwd for the psu spawn). */
  workspaceRoot: string;
  /** Launch mechanism. Default 'psu'. */
  launchVia?: 'psu' | 'inject';
  /** When launchVia:'inject', the closure that performs the real launch (e.g. fleet:launch-on-plan). */
  injectedLaunch?: (spec: LaunchSpec) => Promise<void>;
  /** When launchVia:'inject', the closure that performs teardown (e.g. fleet:cancel + plans archive). */
  injectedTeardown?: (spec: LaunchSpec) => Promise<void>;
  /** psu binary (default 'psu' on PATH). */
  psuBin?: string;
  /** Extra env for the psu spawn. */
  env?: Record<string, string>;
  /** Injected clock — default Date.now (overridable in tests). */
  now?: () => number;
}

/** Build the LIVE RunnerDeps for a desktop behaviour run. */
export function createNodeRunnerDeps(cfg: NodeRunnerConfig): RunnerDeps {
  const launchVia = cfg.launchVia ?? 'psu';
  const now = cfg.now ?? Date.now;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const psuLaunch = (spec: LaunchSpec): Promise<void> => {
    const bin = cfg.psuBin ?? 'psu';
    const args = [
      '--no-picker',
      `--agent=${spec.agent}`,
      `--model=${spec.model}`,
      `--plan=${spec.planSlug}`,
    ];
    if (spec.fleet) args.push(`--fleet=${spec.fleet}`);
    for (const [k, v] of Object.entries(spec.extra ?? {})) {
      if (typeof v === 'string' || typeof v === 'number') args.push(`--${k}=${v}`);
    }
    return new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: cfg.workspaceRoot,
        env: { ...process.env, ...(cfg.env ?? {}) },
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', reject);
      // psu backgrounds the actual agent; resolve as soon as the launcher is spawned. The
      // runner then polls the fs for the session it produces (it does not need the pid).
      child.unref();
      resolve();
    });
  };

  const launch =
    launchVia === 'inject'
      ? cfg.injectedLaunch ??
        (() => Promise.reject(new Error('runner-node: launchVia:inject but no injectedLaunch supplied')))
      : psuLaunch;

  const teardown = launchVia === 'inject' ? cfg.injectedTeardown : undefined;

  return {
    listDirs: listDirsNode,
    listFilesRec: listFilesRecNode,
    readFile: (p: string) => fsp.readFile(expandHome(p), 'utf8'),
    now,
    sleep,
    launch,
    teardown,
  };
}

/** Resolve a past session's transcript file path by session id (e.g. '9870') WITHOUT a launch —
 *  the "score a run that already happened" path. Returns null if the session or its jsonl is absent. */
export async function resolveSessionTranscript(
  sessionId: string,
  ompHomesRoot = '~/.papercusp/su-omp-homes',
): Promise<string | null> {
  const subtree = `${ompHomesRoot.replace(/\/$/, '')}/session-${sessionId}/agent/sessions`;
  const files = await listFilesRecNode(subtree, '.jsonl');
  if (!files.length) return null;
  return files.reduce((best, f) => (f.mtimeMs > best.mtimeMs ? f : best)).path;
}

/** The cwd-slug omp uses for a workspace (leading sep + path with `/` → `-`), e.g.
 *  `/home/x/papercusp` → `-home-x-papercusp`. Exposed for callers that want to target one cwd. */
export function cwdSlug(absPath: string): string {
  return absPath.split(sep).join('-');
}
