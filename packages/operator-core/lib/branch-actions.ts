/**
 * Per-branch action registry.
 *
 * Discovers actions from two sources for each branch:
 *
 *   1. Harness-shipped:  <staging>/.papercusp/actions/<branch>/<name>.sh
 *      Optional manifest sibling: <name>.manifest.json
 *
 *   2. Plugin-contributed: each enabled plugin's papercusp.json may
 *      declare a `branchActions` map. Each entry's name becomes
 *      `<plugin-slug>:<action-name>` to avoid collisions; its scriptPath
 *      is resolved relative to the plugin install dir.
 *
 * Branches: staging | testing | production. The branch concept is
 * substrate-level; actions are user/plugin contributions on top.
 *
 * Spawning is bash <script> with env merged from:
 *   - process.env (so $HOME, $PATH propagate)
 *   - resolved manifest env (plugin-config / harness-env / literal)
 *   - PAPERCUSP_BRANCH, PAPERCUSP_PROJECT_DIR, PAPERCUSP_PHASE_DIR,
 *     PAPERCUSP_HARNESS_SLUG, PAPERCUSP_ACTION_NAME, PAPERCUSP_RUN_ID
 *
 * Logs land at <staging>/.papercusp/action-runs/<branch>/<name>/<runId>.log
 * with sibling <runId>.json capturing exit code + timing.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseSseStream } from '@papercusp/sse';
import { selfUrl } from './self-url';
import {
  type ActionManifest,
  type PluginActionManifest,
  type ButtonsManifest,
  normalizeButtonDecl,
  resolveEnv,
  readInlineManifest,
} from './branch-action-manifest';

export type Branch = 'staging' | 'testing' | 'production';
export const BRANCHES: Branch[] = ['staging', 'testing', 'production'];

export function isBranch(s: unknown): s is Branch {
  return s === 'staging' || s === 'testing' || s === 'production';
}

export interface ActionDescriptor {
  name: string;
  /** Path on disk for script-based sources. Empty string for HTTP buttons. */
  scriptPath: string;
  branch: Branch;
  /**
   *  - 'harness'        = local .sh in staging worktree (no plugin)
   *  - 'plugin'         = bash script contributed by a plugin (branchActions field)
   *  - 'plugin-button'  = HTTP endpoint contributed by a plugin (buttons field)
   */
  source: 'harness' | 'plugin' | 'plugin-button';
  /** When source includes 'plugin', the contributing plugin's name. */
  pluginSlug?: string;
  /** Optional manifest (env requirements + display metadata). */
  manifest?: ActionManifest;
  /** When source==='plugin-button', the URL the substrate POSTs to. */
  buttonUrl?: string;
  /** When source==='plugin-button', the HTTP method (default POST). */
  buttonMethod?: 'POST' | 'GET';
}

export interface RunMeta {
  runId: string;
  harness: string;
  branch: Branch;
  name: string;
  scriptPath: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  status: 'running' | 'completed' | 'failed';
}

// Names can't start with a dot and can't contain two consecutive dots —
// blocks `..evil`, `.hidden`, and traversal attempts even though the
// readdir-based discovery already constrains the lookup to one directory.
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function actionsDir(stagingPath: string, branch: Branch): string {
  return join(stagingPath, '.papercusp', 'actions', branch);
}

/** Sanitise an action name (which may include `:` or `@scope/`) for a path. */
function safeNameForFs(name: string): string {
  return name.replace(/[/:@]/g, '_');
}

export function runRoot(stagingPath: string, branch: Branch, name: string): string {
  return join(stagingPath, '.papercusp', 'action-runs', branch, safeNameForFs(name));
}

export function runLogPath(stagingPath: string, branch: Branch, name: string, runId: string): string {
  return join(runRoot(stagingPath, branch, name), `${runId}.log`);
}

export function runMetaPath(stagingPath: string, branch: Branch, name: string, runId: string): string {
  return join(runRoot(stagingPath, branch, name), `${runId}.json`);
}

async function listHarnessActions(stagingPath: string, branch: Branch): Promise<ActionDescriptor[]> {
  const dir = actionsDir(stagingPath, branch);
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    // Parallelize per-action manifest reads. See /docs/performance #A1.
    const results = await Promise.all(
      ents
        .filter((e) => e.isFile() && e.name.endsWith('.sh') && NAME_RE.test(e.name.replace(/\.sh$/, '')))
        .map(async (e): Promise<ActionDescriptor> => {
          const name = e.name.replace(/\.sh$/, '');
          const manifest = (await readInlineManifest(stagingPath, branch, name)) ?? undefined;
          return {
            name, branch, source: 'harness',
            scriptPath: join(dir, e.name),
            manifest,
          };
        }),
    );
    return results;
  } catch {
    return [];
  }
}

interface PluginManifestForActions {
  name?: string;
  branchActions?: Record<string, PluginActionManifest>;
  buttons?: ButtonsManifest;
}

/**
 * Walk the harness's enabled-plugins set and pull every `branchActions`
 * declaration that matches `branch`. Each contributed action's name is
 * prefixed with the plugin slug (`<plugin>:<name>`) so two plugins can
 * both ship a "deploy" action without colliding.
 */
async function listPluginActions(args: {
  harnessConfigsDir: string;
  globalPluginsDir: string;
  branch: Branch;
}): Promise<ActionDescriptor[]> {
  const enabledRaw = await readJsonSafe<{ enabled?: Record<string, { version?: string }> }>(
    join(args.harnessConfigsDir, 'enabled-plugins.json'),
  );
  const enabledKeys = new Set(Object.keys(enabledRaw?.enabled ?? {}));
  if (enabledKeys.size === 0) return [];

  // Walk global-plugins/<scope>/<name> and global-plugins/<name>.
  // Parallelize the @scope-subdir scan AND the per-plugin manifest reads.
  // Previously serial across ~30 plugin dirs × ~150ms per fs.readFile in
  // Next.js dev mode = 4.5s. See /docs/performance #A1.
  let tryDirs: string[] = [];
  try {
    const top = await fs.readdir(args.globalPluginsDir, { withFileTypes: true });
    const nested = await Promise.all(top.map(async (e) => {
      if (!e.isDirectory()) return [] as string[];
      const p = join(args.globalPluginsDir, e.name);
      if (e.name.startsWith('@')) {
        const inner = await fs.readdir(p, { withFileTypes: true });
        return inner.filter((i) => i.isDirectory()).map((i) => join(p, i.name));
      }
      return [p];
    }));
    tryDirs = nested.flat();
  } catch { return []; }

  // Read every plugin manifest in parallel, then build the descriptor list.
  // The descriptor build is fully synchronous, so we materialize the
  // in-order list after the parallel reads complete.
  const manifestEntries = await Promise.all(tryDirs.map(async (pdir) => ({
    pdir,
    manifest: await readJsonSafe<PluginManifestForActions>(join(pdir, 'papercusp.json')),
  })));

  const out: ActionDescriptor[] = [];
  for (const { pdir, manifest } of manifestEntries) {
    if (!manifest) continue;
    const hasBranchActions = !!manifest.branchActions;
    const hasButtons = !!manifest.buttons;
    if (!hasBranchActions && !hasButtons) continue;
    const slug = manifest.name ?? basename(pdir);
    const dirBase = basename(pdir);
    if (!enabledKeys.has(slug) && !enabledKeys.has(dirBase)) continue;

    // Script-based contributions (bash scripts shipped inside the plugin)
    if (manifest.branchActions) {
      for (const [actName, m] of Object.entries(manifest.branchActions)) {
        if (!NAME_RE.test(actName)) continue;
        const branches = m.branches ?? ['staging', 'testing', 'production'];
        if (!branches.includes(args.branch)) continue;
        const scriptPath = join(pdir, m.scriptPath);
        if (!existsSync(scriptPath)) continue;
        out.push({
          name: `${slug}:${actName}`,
          branch: args.branch,
          source: 'plugin',
          pluginSlug: slug,
          scriptPath,
          manifest: m,
        });
      }
    }

    // URL-based contributions (HTTP buttons hitting the plugin's apiRoutes)
    if (manifest.buttons) {
      const branchButtons = manifest.buttons[args.branch];
      if (branchButtons) {
        for (const [btnName, decl] of Object.entries(branchButtons)) {
          if (!NAME_RE.test(btnName)) continue;
          const norm = normalizeButtonDecl(decl);
          if (!norm.url) continue;
          out.push({
            name: `${slug}:${btnName}`,
            branch: args.branch,
            source: 'plugin-button',
            pluginSlug: slug,
            scriptPath: '',
            buttonUrl: norm.url,
            buttonMethod: norm.method,
            manifest: {
              displayName: norm.displayName,
              description: norm.description,
            },
          });
        }
      }
    }
  }
  return out;
}

async function readJsonSafe<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
}

export interface ListActionsOpts {
  /** When provided, also lists plugin-contributed actions. */
  harnessConfigsDir?: string;
  globalPluginsDir?: string;
}

export async function listActions(
  stagingPath: string, branch: Branch, opts: ListActionsOpts = {},
): Promise<ActionDescriptor[]> {
  const out = await listHarnessActions(stagingPath, branch);
  if (opts.harnessConfigsDir && opts.globalPluginsDir) {
    out.push(...await listPluginActions({
      harnessConfigsDir: opts.harnessConfigsDir,
      globalPluginsDir: opts.globalPluginsDir,
      branch,
    }));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function listAllActions(
  stagingPath: string, opts: ListActionsOpts = {},
): Promise<Record<Branch, ActionDescriptor[]>> {
  const out: Record<Branch, ActionDescriptor[]> = {
    staging: [], testing: [], production: [],
  };
  for (const b of BRANCHES) out[b] = await listActions(stagingPath, b, opts);
  return out;
}

export interface RunOpts {
  stagingPath: string;
  /** Phase worktree path; falls back to stagingPath if absent. */
  phasePath?: string;
  harness: string;
  branch: Branch;
  name: string;
  /** Extra env to merge over the defaults. */
  extraEnv?: Record<string, string>;
  /** Where plugin-configs/* and env.json live. Required for plugin-contributed
   *  actions and for any action whose manifest declares env requirements. */
  harnessConfigsDir?: string;
  globalPluginsDir?: string;
  /** When true, skip the missing-env check (caller has already prompted). */
  skipEnvCheck?: boolean;
}

export interface RunHandle {
  runId: string;
  meta: RunMeta;
  /** Resolves once the child has exited and meta is flushed. */
  done: Promise<RunMeta>;
}

export class MissingEnvError extends Error {
  constructor(public missing: import('./branch-action-manifest').MissingEnvEntry[]) {
    super(`required env not configured: ${missing.map((m) => m.name).join(', ')}`);
    this.name = 'MissingEnvError';
  }
}

/**
 * Validate name + branch, ensure script exists, then spawn it. The child
 * runs detached enough that the SSE stream can attach later; output is
 * captured to the log file. The promise on `done` resolves when the child
 * exits — the route does NOT wait for it.
 */
export async function runAction(opts: RunOpts): Promise<RunHandle> {
  const { stagingPath, phasePath, harness, branch, name, extraEnv } = opts;
  if (!isBranch(branch)) throw new Error(`invalid branch: ${branch}`);
  // Plugin-contributed actions are named `<slug>:<action>` — extend the
  // regex check to allow `:` and `/` (for scoped slugs like `@scope/x:run`).
  if (!/^[A-Za-z0-9_@/:][A-Za-z0-9._@/:-]*$/.test(name)) {
    throw new Error(`invalid action name: ${name}`);
  }

  const all = await listActions(stagingPath, branch, {
    harnessConfigsDir: opts.harnessConfigsDir,
    globalPluginsDir: opts.globalPluginsDir,
  });
  const desc = all.find((a) => a.name === name);
  if (!desc) throw new Error(`action not found: ${branch}/${name}`);

  // Resolve env from manifest before spawn / dispatch.
  let resolvedEnv: Record<string, string> = {};
  if (desc.manifest?.env && opts.harnessConfigsDir) {
    const r = await resolveEnv(desc.manifest, {
      harnessConfigsDir: opts.harnessConfigsDir,
      contributingPlugin: desc.pluginSlug,
    });
    if (r.missing.length > 0 && !opts.skipEnvCheck) {
      throw new MissingEnvError(r.missing);
    }
    resolvedEnv = r.env;
  }

  // For 'plugin-button' sources, dispatch HTTP instead of bash.
  if (desc.source === 'plugin-button') {
    return runButtonAction({
      desc,
      harness,
      branch,
      stagingPath,
      resolvedEnv,
    });
  }

  const cwd = phasePath && existsSync(phasePath) ? phasePath : stagingPath;
  const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const root = runRoot(stagingPath, branch, name);
  await fs.mkdir(root, { recursive: true });
  const logPath = runLogPath(stagingPath, branch, name, runId);
  const metaPath = runMetaPath(stagingPath, branch, name, runId);

  // Best-effort pre-destructive snapshot. The harness branch action
  // runner is the largest single source of file mutations in the
  // operator — wrap each run in a backup safety net. Errors are
  // swallowed: backup unavailability must never block a run.
  try {
    const [{ triggerSnapshotEvent }, { activeWorkspaceId }] = await Promise.all([
      import('./backup'),
      import('./workspace-registry'),
    ]);
    await triggerSnapshotEvent(activeWorkspaceId(), 'pre_destructive', {
      op: 'branch_action_run', harness, branch, name, runId,
    }).catch(() => { /* ignore */ });
  } catch { /* backup module not loaded — fine */ }

  const startedAt = new Date().toISOString();
  const meta: RunMeta = {
    runId, harness, branch, name,
    scriptPath: desc.scriptPath,
    startedAt,
    status: 'running',
  };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  const logFh = await fs.open(logPath, 'w');
  // Header so attached clients see what they're streaming.
  await logFh.write(`::papercusp::action-started\t${JSON.stringify({
    runId, harness, branch, name, scriptPath: desc.scriptPath,
    cwd, startedAt,
  })}\n`);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...resolvedEnv,
    PAPERCUSP_BRANCH: branch,
    PAPERCUSP_PROJECT_DIR: cwd,
    PAPERCUSP_STAGING_DIR: stagingPath,
    PAPERCUSP_PHASE_DIR: cwd,
    PAPERCUSP_HARNESS_SLUG: harness,
    PAPERCUSP_ACTION_NAME: name,
    PAPERCUSP_RUN_ID: runId,
    ...(extraEnv ?? {}),
  };

  // Resolve the bus publisher BEFORE spawning. There must be NO `await`
  // between spawn() and registering the child's 'close' listener (below):
  // a fast child can run, exit, and have its stdio streams close *during*
  // a cold dynamic import(), emitting 'close' before the listener attaches —
  // so `done` would hang forever (and the log FileHandle would leak, surfacing
  // later as an ERR_INVALID_STATE GC error). This bit only the FIRST runAction
  // call per worker (the import is cold); warm calls resolve it synchronously,
  // which is why it looked like a flake / a "stderr-only" bug.
  const { publish: publishAction } = await import('./branch-action-bus');
  // Bus channel key — same shape /action-stream subscribes against.
  const channelKey = `${harness}:${runId}`;

  const child = spawn('bash', [desc.scriptPath], { cwd, env });

  publishAction(channelKey, 'started', '', {
    runId, harness, branch, name, scriptPath: desc.scriptPath, cwd, startedAt,
  });

  const t0 = Date.now();
  const writeLine = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const text = chunk.toString('utf8');
    // Disk write stays — backfill on connect + post-hoc replay still
    // read from the log file. Bus is the live channel.
    if (stream === 'stderr') {
      const lines = text.split('\n');
      const tagged = lines.map((l, i) => (l.length > 0 ? `::papercusp::stderr\t${l}` : (i < lines.length - 1 ? '' : ''))).join('\n');
      logFh.write(tagged).catch(() => undefined);
      publishAction(channelKey, 'stderr', text);
    } else {
      logFh.write(text).catch(() => undefined);
      publishAction(channelKey, 'output', text);
    }
  };
  child.stdout.on('data', (b: Buffer) => writeLine(b, 'stdout'));
  child.stderr.on('data', (b: Buffer) => writeLine(b, 'stderr'));

  const done = new Promise<RunMeta>((resolve) => {
    child.on('close', async (code, signal) => {
      const endedAt = new Date().toISOString();
      const final: RunMeta = {
        ...meta,
        endedAt,
        exitCode: code,
        signal: signal as string | null,
        durationMs: Date.now() - t0,
        status: code === 0 ? 'completed' : 'failed',
      };
      try {
        await logFh.write(`\n::papercusp::action-${final.status}\t${JSON.stringify({
          runId, exitCode: code, signal, durationMs: final.durationMs, endedAt,
        })}\n`);
      } catch { /* ignore */ }
      try { await logFh.close(); } catch { /* ignore */ }
      try { await fs.writeFile(metaPath, JSON.stringify(final, null, 2), 'utf8'); } catch { /* ignore */ }
      const terminalKind: 'completed' | 'failed' = final.status === 'completed' ? 'completed' : 'failed';
      publishAction(channelKey, terminalKind, '', {
        runId, exitCode: code, signal, durationMs: final.durationMs, endedAt,
      });

      // Fire the `post_run` backup trigger — /settings/backups renders it as "After
      // each {pot} run" and it ships ON by default (event_triggers_json), but NOTHING
      // emitted it, so the checkbox was inert (settings-audit 2026-07-09). This runner
      // is the operator's run lifecycle: it already fires `pre_destructive` before the
      // child starts (see above), so its terminal `close` is the symmetric home for the
      // post-run snapshot. Fires on BOTH outcomes — a failed run mutates the tree just
      // as a successful one does, and that is precisely the state worth capturing.
      // Best-effort + swallowed: a backup failure must never change the run's result.
      try {
        const [{ triggerSnapshotEvent }, { activeWorkspaceId }] = await Promise.all([
          import('./backup'),
          import('./workspace-registry'),
        ]);
        await triggerSnapshotEvent(activeWorkspaceId(), 'post_run', {
          op: 'branch_action_run', harness, branch, name, runId,
          exitCode: code, status: final.status, durationMs: final.durationMs,
        }).catch(() => { /* ignore */ });
      } catch { /* backup module not loaded — fine */ }

      resolve(final);
    });
  });

  return { runId, meta, done };
}

/**
 * HTTP-button dispatch. Mirrors runAction's spawn flow:
 *   - writes ::papercusp::action-started header to the log
 *   - calls the plugin's URL with body { harness, branch, button, env }
 *   - if response is text/event-stream → forwards every line to the log
 *   - otherwise → captures the body once
 *   - writes ::papercusp::action-completed/failed footer + meta
 *
 * Returns the same RunHandle shape as runAction so callers (route, UI)
 * stay agnostic to the source.
 */
async function runButtonAction(args: {
  desc: ActionDescriptor;
  harness: string;
  branch: Branch;
  stagingPath: string;
  resolvedEnv: Record<string, string>;
}): Promise<RunHandle> {
  const { desc, harness, branch, stagingPath, resolvedEnv } = args;
  const url = desc.buttonUrl!;
  const method = desc.buttonMethod ?? 'POST';
  const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const root = runRoot(stagingPath, branch, desc.name);
  await fs.mkdir(root, { recursive: true });
  const logPath = runLogPath(stagingPath, branch, desc.name, runId);
  const metaPath = runMetaPath(stagingPath, branch, desc.name, runId);

  const startedAt = new Date().toISOString();
  const meta: RunMeta = {
    runId, harness, branch, name: desc.name,
    scriptPath: url,
    startedAt, status: 'running',
  };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  const logFh = await fs.open(logPath, 'w');
  await logFh.write(`::papercusp::action-started\t${JSON.stringify({
    runId, harness, branch, name: desc.name,
    scriptPath: url, source: 'plugin-button', method,
    pluginSlug: desc.pluginSlug, startedAt,
  })}\n`);

  const t0 = Date.now();
  const done = (async () => {
    let exitCode: number | null = 0;
    let signal: string | null = null;
    let status: 'completed' | 'failed' = 'completed';
    try {
      // The plugin's URL is operator-relative. Resolve against the operator's
      // self-URL so this works in standalone + dev modes.
      const base = selfUrl();
      const fullUrl = url.startsWith('http') ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`;

      const res = await fetch(fullUrl, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({
          harness, branch, button: desc.name.split(':').slice(1).join(':'),
          runId, env: resolvedEnv,
        }),
      });

      if (!res.ok) {
        await logFh.write(`::papercusp::stderr\tHTTP ${res.status} ${res.statusText}\n`);
        const text = await res.text().catch(() => '');
        if (text) await logFh.write(text + '\n');
        exitCode = res.status;
        status = 'failed';
      } else {
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('text/event-stream') && res.body) {
          // Forward SSE data lines to the log verbatim. Skip heartbeat
          // frames the @papercusp/sse server emits as keepalives — those
          // are transport noise, not button output. Forward every other
          // event (name-agnostic) so future plugins emitting named
          // events ('progress', 'line', etc.) still flow through.
          for await (const ev of parseSseStream(res.body)) {
            if (ev.event === 'heartbeat') continue;
            await logFh.write(ev.data + '\n');
          }
        } else {
          // One-shot: log the body as output.
          const body = await res.text();
          if (body) await logFh.write(body + (body.endsWith('\n') ? '' : '\n'));
        }
      }
    } catch (e) {
      await logFh.write(`::papercusp::stderr\tdispatch error: ${(e as Error).message}\n`);
      exitCode = -1;
      signal = 'fetch-error';
      status = 'failed';
    }

    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    const final: RunMeta = {
      ...meta, endedAt, exitCode, signal, durationMs, status,
    };
    try {
      await logFh.write(`::papercusp::action-${status}\t${JSON.stringify({
        runId, exitCode, signal, durationMs, endedAt,
      })}\n`);
    } catch { /* ignore */ }
    try { await logFh.close(); } catch { /* ignore */ }
    try { await fs.writeFile(metaPath, JSON.stringify(final, null, 2), 'utf8'); } catch { /* ignore */ }
    return final;
  })();

  return { runId, meta, done };
}

export async function listRuns(
  stagingPath: string, branch: Branch, name: string,
): Promise<RunMeta[]> {
  const dir = runRoot(stagingPath, branch, name);
  try {
    const ents = await fs.readdir(dir);
    // Parallelized — see /docs/performance #A1. Order doesn't matter
    // because we sort below.
    const results = await Promise.all(
      ents.filter((f) => f.endsWith('.json')).map(async (f) => {
        try {
          const raw = await fs.readFile(join(dir, f), 'utf8');
          return JSON.parse(raw) as RunMeta;
        } catch {
          return null;
        }
      }),
    );
    const metas: RunMeta[] = results.filter((m): m is RunMeta => m != null);
    metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

    // Heuristic: if a run is still `running` but its log file hasn't been
    // touched in 5 minutes, the parent worker probably died (HMR restart,
    // crash, etc.). Mark it as failed so the UI doesn't show "running"
    // forever. Cheap fix on read; no background timer needed.
    const STALE_MS = 5 * 60 * 1000;
    const now = Date.now();
    for (const m of metas) {
      if (m.status !== 'running') continue;
      try {
        const st = await fs.stat(join(dir, `${m.runId}.log`));
        if (now - st.mtimeMs > STALE_MS) {
          m.status = 'failed';
          m.endedAt = new Date(st.mtimeMs).toISOString();
          m.exitCode = null;
          m.signal = 'orphaned';
          m.durationMs = st.mtimeMs - new Date(m.startedAt).getTime();
        }
      } catch { /* log gone — leave as-is */ }
    }
    return metas;
  } catch { return []; }
}
