/**
 * /api/harness/:slug/pty/* + /pi-sessions/audit/* — pseudo-terminal
 * bridge for embedded TUI panes. Phase A2 (endpoint-hono-elimination-
 * 2026-05-21). Ported off `_hono/pty.ts` (mounted via `registerPty`).
 * URLs unchanged.
 *
 *   POST /api/harness/:slug/pty/spawn
 *   POST /api/harness/:slug/pty/resolve
 *   POST /api/harness/:slug/pty/prewarm
 *   GET  /api/harness/:slug/pty/:id/stream         (SSE — events: data, exit)
 *   POST /api/harness/:slug/pty/:id/input
 *   POST /api/harness/:slug/pty/:id/resize
 *   POST /api/harness/:slug/pty/:id/kill
 *   GET  /api/harness/:slug/pi-sessions/audit
 *   GET  /api/harness/:slug/pi-sessions/audit/:filename
 *   GET  /api/harness/:slug/pty/tools
 *
 * The control and read surfaces are loopback-tier routes. No WebSocket here:
 * terminal output streams over SSE, input over POST. The route stack still
 * admits a verified remote operator session through its central remote-auth
 * policy, while unauthenticated/off-box callers cannot enumerate or replay
 * terminal output and exported session transcripts.
 * The prewarm pool (previously a closure inside `registerPty`) is now
 * module-level state — same one-instance-per-process lifetime.
 *
 * NOT A FALLBACK FOR THE WS TRANSPORT UNDER CLUSTERING. It is tempting to read
 * "output over SSE, input over POST" as an independent path that survives when the
 * pty WS server refuses to start — it is not. Every route below that reaches a
 * terminal resolves it through the SAME in-process `pty-bridge` handles map the WS
 * leg uses, so multi-worker clustering breaks both identically: a handle spawned on
 * one worker is invisible to the (workers-1)/workers of later requests routed
 * elsewhere. The registry-backed routes therefore share the WS leg's refusal
 * (`ptyRegistryClusterRefusal`) and return 503 rather than the false
 * `404 unknown pty id` that misdiagnosis cost this investigation twice
 * (WI-10001638). The disk-backed routes — the audit-transcript reads and the tool
 * inventory, listed in `PTY_CLUSTER_SAFE_PATHS` — are unaffected and stay enabled.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sseResponse } from '@papercusp/sse';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import {
  killPty, markActive, resizePty, spawnGovernedPty, writePty, getPty, getPtyMeta, getHistory, PtyError,
  ptyRegistryClusterRefusal,
  type PtyHandle,
} from '../../../pty-bridge';
import {
  issuePtyTicket,
  localPtyHostId,
  ptyAccessScopeKey,
  type PtyAccessScope,
} from '../../../pty-ticket';
import { papercuspPath } from '../../../papercusp-root';
import { resolveProjectDir, resolveStateDir, resolveSpawnCwd, resolveContextEnv } from '../../../spawn-config';
import { buildKickoffPromptFile } from '../../../agent-kickoff/prompt-file';
import { activeWorkspaceId } from '../../../workspace-registry';
import { requestWorkspaceId } from '../../../remote-auth-policy';
import { defineTool, type Principal } from '@papercusp/agent-mcp';

interface SpawnBody {
  command?: string;
  args?: readonly string[];
  laneId?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  resumePtyId?: string;
}

export const LOCAL_PTY_PRINCIPAL_ID = 'local-loopback';

/**
 * Resolve the authorization scope already established by the route stack.
 * Direct-remote PTY requests always arrive with a verified, workspace-bound
 * principal. Local/SSH-forwarded compatibility gets one explicit loopback
 * identity instead of silently sharing a wildcard/global handle namespace.
 */
export function resolvePtyAccessScope(
  req: Request,
  principal: Principal | null,
  harnessSlug: string,
): PtyAccessScope | null {
  const explicitWorkspace = requestWorkspaceId(req);
  if (principal) {
    if (!explicitWorkspace || explicitWorkspace !== principal.workspaceId) return null;
    return {
      tenantId: principal.workspaceId,
      workspaceId: principal.workspaceId,
      harnessSlug,
      hostId: localPtyHostId(),
      principalId: principal.slug,
    };
  }
  const workspaceId = explicitWorkspace && explicitWorkspace !== '*'
    ? explicitWorkspace
    : activeWorkspaceId();
  return {
    tenantId: workspaceId,
    workspaceId,
    harnessSlug,
    hostId: localPtyHostId(),
    principalId: LOCAL_PTY_PRINCIPAL_ID,
  };
}

function scopeOrDenial(
  req: Request,
  principal: Principal | null,
  harnessSlug: string,
): PtyAccessScope | Response {
  const scope = resolvePtyAccessScope(req, principal, harnessSlug);
  return scope ?? Response.json(
    { error: 'pty scope does not match the authenticated workspace' },
    { status: 403 },
  );
}

/**
 * Paths served ENTIRELY from disk, which multi-worker clustering therefore does not
 * break: the exported-transcript reads and the static tool inventory. They are
 * deliberately NOT cluster-guarded — refusing them would delete working functionality.
 * Kept as an explicit declaration (rather than left implicit) so the cluster-refusal
 * test can require that EVERY pty route is classified one way or the other, and a new
 * route added later cannot quietly default into the unguarded set.
 */
/**
 * Machine-readable discriminator on the cluster refusal. Exported so callers (and the
 * test) identify the refusal by code rather than by its 503, which these routes also
 * return for unrelated transient spawn failures.
 */
export const PTY_CLUSTER_UNSERVICEABLE_CODE = 'pty_cluster_unserviceable';

export const PTY_CLUSTER_SAFE_PATHS: ReadonlySet<string> = new Set([
  '/harness/:slug/pi-sessions/audit',
  '/harness/:slug/pi-sessions/audit/:filename',
  '/harness/:slug/pty/tools',
]);

/**
 * The refusal every registry-backed pty route returns while this process is one of
 * several cluster workers, or `null` when terminals are serviceable here.
 *
 * WHY A REFUSAL AND NOT A RETRY: the handles map these routes read is per-process
 * (see `ptyRegistryClusterRefusal`), and spawn requests round-robin across workers,
 * so a pty spawned on worker A is permanently invisible to the (workers-1)/workers of
 * later requests that land elsewhere. There is no cross-worker lookup to fall back to.
 *
 * WHY 503 AND NOT THE STATUS QUO: untreated, this path fails as
 * `404 {error:'unknown pty id'}` — a statement that is FALSE (the pty usually exists,
 * in another worker) and that cost this investigation two wrong root-cause theories
 * before the string itself was identified as the misdirection (WI-10001638). 503 says
 * the honest thing: the server cannot service terminals in this configuration, it is
 * not the caller's id that is wrong, and retrying will not help.
 *
 * NO EXISTENCE ORACLE: this is decided from configuration ALONE and returned before
 * any registry lookup, so the response is byte-identical for a live pty id, a dead
 * one, and one that never existed — preserving the property the WS leg's
 * indistinguishable rejection was built to hold.
 */
function clusterRefusal(): Response | null {
  const workers = ptyRegistryClusterRefusal();
  if (workers == null) return null;
  return Response.json(
    {
      // 503 is already used on these routes for unrelated transient failures
      // ('prewarm spawn failed', a governed-spawn PtyError), so the status alone
      // cannot tell a caller which one happened. This code is the discriminator:
      // it means "disabled by configuration", never "your request failed".
      code: PTY_CLUSTER_UNSERVICEABLE_CODE,
      error: 'terminals are disabled in this process',
      reason:
        `multi-worker clustering is ACTIVE (${workers} workers) and the pty registry is ` +
        `per-process, so only 1-in-${workers} operations could ever find their handle. ` +
        `This is a server configuration state, NOT an unknown or expired pty id — ` +
        `retrying will not help.`,
      remedy:
        'To run terminals set PAPERCUSP_CLUSTER_WORKERS=0 (or PAPERCUSP_CLUSTER=0) on this service.',
      clusterWorkers: workers,
    },
    { status: 503, headers: { 'cache-control': 'no-store' } },
  );
}

function exactRequestOrigin(req: Request): string | null {
  const origin = req.headers.get('origin')?.trim();
  if (!origin || origin === 'null') return null;
  try {
    return new URL(origin).origin === origin ? origin : null;
  } catch {
    return null;
  }
}

const stateDirForSlug = resolveStateDir;

/**
 * Build a markdown system-prompt fragment describing the feature pi is
 * scoped to. Thin wrapper around the shared kickoff factory.
 */
async function buildFeaturePromptFile(
  slug: string,
  featureId: string,
  _stateDir: string,
): Promise<string | null> {
  return buildKickoffPromptFile({ kind: 'feature', harnessSlug: slug, featureId });
}

/** pi/omp session jsonls created within `windowMs` of the pty's startup. */
function findRecentSessionFiles(agentDir: string, startedAtMs: number, _windowMs: number): string[] {
  const sessionsRoot = join(agentDir, 'sessions');
  if (!existsSync(sessionsRoot)) return [];
  const out: string[] = [];
  let workspaces: string[];
  try { workspaces = readdirSync(sessionsRoot); } catch { return []; }
  for (const ws of workspaces) {
    const wsDir = join(sessionsRoot, ws);
    let entries: string[];
    try { entries = readdirSync(wsDir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const full = join(wsDir, e);
      try {
        const st = statSync(full);
        if (st.mtimeMs >= startedAtMs - 5_000) out.push(full);
      } catch { /* file vanished */ }
    }
  }
  return out;
}

/** Best-effort: export pi/omp sessions from this pty's lifetime to HTML. */
function exportPiSessions(opts: {
  agentDir: string; auditDir: string; startedAtMs: number; ompBin: string; tagPrefix: string;
}): void {
  const { agentDir, auditDir, startedAtMs, ompBin, tagPrefix } = opts;
  setImmediate(() => {
    const files = findRecentSessionFiles(agentDir, startedAtMs, 24 * 60 * 60 * 1000);
    if (files.length === 0) return;
    try { mkdirSync(auditDir, { recursive: true }); } catch { return; }
    for (const sessionFile of files) {
      const stem = basename(sessionFile, '.jsonl');
      const desiredPath = join(auditDir, `${tagPrefix}-${stem}.html`);
      const ompDefaultPath = join(auditDir, `omp-session-${stem}.html`);
      const child = spawnChild(ompBin, ['--export', sessionFile], {
        cwd: auditDir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('error', () => {});
      child.on('exit', (code) => {
        if (code !== 0) return;
        try {
          if (existsSync(ompDefaultPath) && !existsSync(desiredPath)) {
            renameSync(ompDefaultPath, desiredPath);
          }
        } catch { /* keep omp's default name */ }
      });
    }
  });
}

/** Resolve the agent terminal binary (claude-code vs omp), probing known paths. */
function resolveAgentTerminalBinary(): string {
  const cmdEnv = (process.env.AGENT_CMD ?? '').trim();
  if (cmdEnv) {
    const first = cmdEnv.split(/\s+/)[0];
    if (first) return first;
  }
  const backend = (process.env.AGENT_BACKEND ?? '').trim().toLowerCase();
  const wantClaude = backend === 'claude-code' || backend === 'claude';
  if (wantClaude) {
    const candidates = [
      process.env.PAPERCUSP_CLAUDE_BIN,
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      join(homedir(), '.local', 'bin', 'claude'),
      join(homedir(), '.claude', 'local', 'claude'),
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    for (const p of candidates) if (existsSync(p)) return p;
    return 'claude';
  }
  const candidates = [
    process.env.PAPERCUSP_PI_BIN,
    '/usr/local/bin/omp',
    '/opt/homebrew/bin/omp',
    join(homedir(), '.cargo', 'bin', 'omp'),
    join(homedir(), '.local', 'bin', 'omp'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const p of candidates) if (existsSync(p)) return p;
  return 'omp';
}

function resolvePiBinary(): string {
  return resolveAgentTerminalBinary();
}

/* ─── Prewarm pool ───────────────────────────────────────────────────── */
// Keyed by `<slug>|<laneId>|<command>`. A /pty/prewarm reserves a warm
// pty; /pty/spawn adopts it, eliminating omp's ~1.2s startup from the
// critical path. The slot stores a Promise so /spawn can await an
// in-flight prewarm. Module-level (was a closure inside `registerPty`).

type PrewarmEntry = {
  promise: Promise<PtyHandle | null>;
  reaper: NodeJS.Timeout | null;
};
const prewarmed = new Map<string, PrewarmEntry>();
const PREWARM_TTL_MS = 60_000;

function prewarmKey(accessScope: PtyAccessScope, laneId: string | undefined, command: string): string {
  return `${ptyAccessScopeKey(accessScope)}|${laneId ?? ''}|${command}`;
}

function reservePrewarmSlot(opts: {
  slug: string;
  accessScope: PtyAccessScope;
  laneId: string | undefined;
  command: string;
  buildCfg: () => Promise<
    | { kind: 'ok'; command: string; args: readonly string[]; cwd: string; env: Record<string, string>; sd: string | null }
    | { kind: 'unknown-slug' }
  >;
}): PrewarmEntry {
  const { slug, accessScope, laneId, command, buildCfg } = opts;
  const key = prewarmKey(accessScope, laneId, command);
  const existing = prewarmed.get(key);
  if (existing) return existing;

  let resolveHandle: (h: PtyHandle | null) => void = () => {};
  const entry: PrewarmEntry = {
    promise: new Promise<PtyHandle | null>((r) => { resolveHandle = r; }),
    reaper: null,
  };
  // Register the slot SYNCHRONOUSLY so a concurrent /pty/spawn sees it.
  prewarmed.set(key, entry);

  setImmediate(async () => {
    try {
      const cfg = await buildCfg();
      if (cfg.kind === 'unknown-slug') {
        if (prewarmed.get(key) === entry) prewarmed.delete(key);
        resolveHandle(null);
        return;
      }
      const handle = await spawnGovernedPty({
        accessScope,
        command: cfg.command, args: cfg.args, cwd: cfg.cwd, cols: 80, rows: 24, env: cfg.env,
      }, {
        workspaceId: accessScope.workspaceId,
        idempotencyKey: `pty-prewarm:${randomUUID()}`,
        owner: accessScope.principalId,
        payloadRef: `pty-prewarm:${slug}:${laneId ?? 'default'}`,
      });
      attachAuditExport(handle, cfg.sd, cfg.command, laneId);
      entry.reaper = setTimeout(() => {
        if (prewarmed.get(key) === entry) prewarmed.delete(key);
        try { killPty(handle.id, accessScope); } catch { /* ignore */ }
      }, PREWARM_TTL_MS);
      entry.reaper.unref?.();

      // Hold the slot for PREWARM_BOOT_MS before marking it adoptable so
      // omp's MCP-connection chatter is past before the client adopts.
      const PREWARM_BOOT_MS = 1500;
      let resolved = false;
      const ready = () => {
        if (resolved) return;
        resolved = true;
        resolveHandle(handle);
      };
      const bootTimer = setTimeout(ready, PREWARM_BOOT_MS);
      bootTimer.unref?.();
      handle.onExit.add(() => {
        clearTimeout(bootTimer);
        ready();
      });
    } catch {
      if (prewarmed.get(key) === entry) prewarmed.delete(key);
      resolveHandle(null);
    }
  });

  return entry;
}

async function buildSpawnConfig(opts: {
  slug: string;
  body: SpawnBody;
  requestUrl: string;
}): Promise<{ kind: 'ok'; command: string; args: readonly string[]; cwd: string; env: Record<string, string>; sd: string | null } | { kind: 'unknown-slug' }> {
  const { slug, body, requestUrl } = opts;
  const command = body.command ?? resolvePiBinary();

  const projectDir = await resolveProjectDir(slug);
  if (!projectDir) return { kind: 'unknown-slug' };

  const sd = await resolveStateDir(slug);
  const cwd = resolveSpawnCwd({ projectDir, stateDir: sd, laneId: body.laneId });
  const env = resolveContextEnv({ slug, stateDir: sd, requestUrl });

  const piExtensionPath = papercuspPath('global-plugins', 'pi', 'extension.ts');
  const piExtensionAvailable = existsSync(piExtensionPath);

  let args: readonly string[];
  if (body.args) {
    args = body.args;
  } else if (command.includes('omp')) {
    const baseArgs: string[] = ['--no-pty'];
    if (piExtensionAvailable) {
      baseArgs.push('-e', piExtensionPath);
    }
    if (body.laneId && sd) {
      const promptPath = await buildFeaturePromptFile(slug, body.laneId, sd);
      if (promptPath) baseArgs.push(`--append-system-prompt=${promptPath}`);
    }
    args = baseArgs;
  } else {
    args = [];
  }

  return { kind: 'ok', command, args, cwd, env: { ...env, ...body.env }, sd };
}

function attachAuditExport(handle: PtyHandle, sd: string | null, command: string, laneId?: string): void {
  if (!sd || !command.includes('omp')) return;
  const agentDir = join(sd, 'pi-sessions');
  const auditDir = join(sd, 'audit', 'pi-sessions');
  const tagPrefix = laneId ?? `pid${handle.pty.pid}`;
  const startedAtMs = handle.startedAtMs;
  handle.onExit.add(() => {
    exportPiSessions({ agentDir, auditDir, startedAtMs, ompBin: command, tagPrefix });
  });
}

/* ─── Routes ─────────────────────────────────────────────────────────── */

const spawn = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/spawn',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug ?? '';
    const accessScope = scopeOrDenial(req, ctx.principal, slug);
    if (accessScope instanceof Response) return accessScope;
    const refusal = clusterRefusal();
    if (refusal) return refusal;
    let body: SpawnBody;
    try { body = ((await req.json()) as SpawnBody) ?? {}; } catch { body = {}; }

    const cols = Math.max(20, Math.min(500, Math.floor(body.cols ?? 80)));
    const rows = Math.max(5, Math.min(200, Math.floor(body.rows ?? 24)));

    // Resume path: adopt an alive pty by id (PiPanel remount fast path).
    if (body.resumePtyId) {
      const existing = getPtyMeta(body.resumePtyId, accessScope);
      if (existing) {
        try { resizePty(body.resumePtyId, cols, rows, accessScope); } catch { /* ignore */ }
        return Response.json({ ...existing, resumed: true });
      }
    }

    // Compute the prewarm key synchronously so we can adopt an in-flight
    // prewarm slot without awaiting buildSpawnConfig.
    const command = body.command ?? resolvePiBinary();
    const key = prewarmKey(accessScope, body.laneId, command);
    const reserved = prewarmed.get(key);
    const refill = () => {
      setImmediate(() => {
        try {
          reservePrewarmSlot({
            slug,
            accessScope,
            laneId: body.laneId,
            command,
            buildCfg: () => buildSpawnConfig({ slug, body, requestUrl: req.url }),
          });
        } catch { /* best-effort */ }
      });
    };

    if (reserved) {
      const handle = await reserved.promise;
      if (prewarmed.get(key) === reserved) prewarmed.delete(key);
      if (reserved.reaper) clearTimeout(reserved.reaper);
      if (handle && !handle.killed) {
        try { handle.pty.resize(cols, rows); } catch { /* ignore */ }
        refill();
        return Response.json({
          id: handle.id,
          command: handle.command,
          args: handle.args,
          cwd: handle.cwd,
          pid: handle.pty.pid,
          prewarmed: true,
        });
      }
      // prewarm failed or its handle died — fall through to a cold spawn.
    }

    const cfg = await buildSpawnConfig({ slug, body, requestUrl: req.url });
    if (cfg.kind === 'unknown-slug') {
      return Response.json({ error: 'unknown harness slug', slug }, { status: 404 });
    }

    try {
      const handle = await spawnGovernedPty({
        accessScope,
        command: cfg.command, args: cfg.args, cwd: cfg.cwd, cols, rows, env: cfg.env,
      }, {
        workspaceId: accessScope.workspaceId,
        idempotencyKey: `pty-http:${randomUUID()}`,
        owner: accessScope.principalId,
        payloadRef: `pty-http:${slug}:${body.laneId ?? 'default'}`,
      });
      attachAuditExport(handle, cfg.sd, cfg.command, body.laneId);
      refill();
      return Response.json({
        id: handle.id,
        command: handle.command,
        args: handle.args,
        cwd: handle.cwd,
        pid: handle.pty.pid,
      });
    } catch (err) {
      if (err instanceof PtyError) {
        return Response.json({ error: err.message, code: err.code }, { status: 503 });
      }
      return Response.json({ error: (err as Error).message, code: 'UNKNOWN' }, { status: 500 });
    }
  },
});

const resolve = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/resolve',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug ?? '';
    const accessScope = scopeOrDenial(req, ctx.principal, slug);
    if (accessScope instanceof Response) return accessScope;
    const refusal = clusterRefusal();
    if (refusal) return refusal;
    let body: SpawnBody;
    try { body = ((await req.json()) as SpawnBody) ?? {}; } catch { body = {}; }
    const cfg = await buildSpawnConfig({ slug, body, requestUrl: req.url });
    if (cfg.kind === 'unknown-slug') {
      return Response.json({ error: 'unknown harness slug', slug }, { status: 404 });
    }
    return Response.json({ command: cfg.command, args: cfg.args, cwd: cfg.cwd, env: cfg.env });
  },
});

const prewarm = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/prewarm',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug ?? '';
    const accessScope = scopeOrDenial(req, ctx.principal, slug);
    if (accessScope instanceof Response) return accessScope;
    const refusal = clusterRefusal();
    if (refusal) return refusal;
    let body: SpawnBody;
    try { body = ((await req.json()) as SpawnBody) ?? {}; } catch { body = {}; }

    const command = body.command ?? resolvePiBinary();
    const key = prewarmKey(accessScope, body.laneId, command);
    const existing = prewarmed.get(key);
    if (existing) {
      const handle = await existing.promise.catch(() => null);
      if (handle && !handle.killed) return Response.json({ reserved: true, reused: true });
      if (existing.reaper) clearTimeout(existing.reaper);
      if (prewarmed.get(key) === existing) prewarmed.delete(key);
    }

    const entry = reservePrewarmSlot({
      slug,
      accessScope,
      laneId: body.laneId,
      command,
      buildCfg: () => buildSpawnConfig({ slug, body, requestUrl: req.url }),
    });
    const handle = await entry.promise;
    if (!handle) {
      return Response.json({ error: 'prewarm spawn failed' }, { status: 503 });
    }
    return Response.json({ reserved: true });
  },
});

const ticket = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/:id/ticket',
  auth: 'loopback',
  handler(req, ctx) {
    const slug = ctx.params.slug ?? '';
    const accessScope = scopeOrDenial(req, ctx.principal, slug);
    if (accessScope instanceof Response) return accessScope;
    const refusal = clusterRefusal();
    if (refusal) return refusal;
    const origin = exactRequestOrigin(req);
    if (!origin) {
      return Response.json({ error: 'an exact Origin header is required' }, { status: 403 });
    }
    const handle = getPty(ctx.params.id, accessScope);
    if (!handle) {
      return Response.json({ error: 'unknown pty id', id: ctx.params.id }, { status: 404 });
    }
    const issued = issuePtyTicket({
      ...accessScope,
      ptyId: handle.id,
      origin,
    });
    return Response.json(issued, {
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
      },
    });
  },
});

const stream = defineTool({
  method: 'GET',
  path: '/harness/:slug/pty/:id/stream',
  // PTY output is private terminal content. Keep it on the same perimeter as
  // input/resize/kill; the central route stack admits an explicitly verified
  // remote operator, while a network-exposed unauthenticated caller gets 403.
  auth: 'loopback',
  // Pure SSE transport — don't flood route_invocations per connection.
  sampleRate: 0,
  handler(req, ctx) {
    const slug = ctx.params.slug ?? '';
    const accessScope = scopeOrDenial(req, ctx.principal, slug);
    if (accessScope instanceof Response) return accessScope;
    const refusal = clusterRefusal();
    if (refusal) return refusal;
    const id = ctx.params.id;
    const handle = getPty(id, accessScope);
    if (!handle) {
      return Response.json({ error: 'unknown pty id', id }, { status: 404 });
    }

    return sseResponse({
      signal: req.signal,
      heartbeatMs: 15_000,
      setup: (sink) => {
        const onData = (chunk: Buffer) => {
          if (sink.closed) return;
          sink.eventRaw('data', chunk.toString('base64'));
        };
        const onExit = (code: number) => {
          if (sink.closed) return;
          sink.event('exit', { code });
          sink.close();
        };

        // Replay full session history into the new subscriber.
        const history = getHistory(id, accessScope);
        if (history && history.length > 0) {
          try { onData(history); } catch { /* see onData */ }
        }

        handle.onData.add(onData);
        handle.onExit.add(onExit);

        if (handle.killed) {
          onExit(handle.exitCode ?? 0);
          return;
        }

        // Keep the SSE consumer counted as activity so the reaper spares it.
        const ticker = managedSetInterval('pty-sse-active-ticker', 15_000, () => {
          if (!sink.closed) markActive(id, accessScope);
        }, { category: 'lifecycle', instanced: true });

        sink.onClose(() => {
          ticker.stop();
          handle.onData.delete(onData);
          handle.onExit.delete(onExit);
          // Don't kill the pty on SSE disconnect — PiPanel unmounts on
          // every dashboard tab switch.
        });
      },
    });
  },
});

const input = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/:id/input',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug ?? '';
    const accessScope = scopeOrDenial(req, ctx.principal, slug);
    if (accessScope instanceof Response) return accessScope;
    const refusal = clusterRefusal();
    if (refusal) return refusal;
    const id = ctx.params.id;
    let body: { data?: string };
    try { body = ((await req.json()) as { data?: string }) ?? {}; } catch { body = {}; }
    if (!body.data) return Response.json({ error: 'missing data' }, { status: 400 });
    const ok = writePty(id, Buffer.from(body.data, 'base64'), accessScope);
    if (!ok) return Response.json({ error: 'unknown or killed pty' }, { status: 404 });
    return new Response(null, { status: 204 });
  },
});

const resize = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/:id/resize',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug ?? '';
    const accessScope = scopeOrDenial(req, ctx.principal, slug);
    if (accessScope instanceof Response) return accessScope;
    const refusal = clusterRefusal();
    if (refusal) return refusal;
    const id = ctx.params.id;
    let body: { cols?: number; rows?: number };
    try { body = ((await req.json()) as { cols?: number; rows?: number }) ?? {}; } catch { body = {}; }
    const cols = Math.max(20, Math.min(500, Math.floor(body.cols ?? 80)));
    const rows = Math.max(5, Math.min(200, Math.floor(body.rows ?? 24)));
    const ok = resizePty(id, cols, rows, accessScope);
    if (!ok) return Response.json({ error: 'unknown or killed pty' }, { status: 404 });
    return new Response(null, { status: 204 });
  },
});

const kill = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/:id/kill',
  auth: 'loopback',
  handler(req, ctx) {
    const slug = ctx.params.slug ?? '';
    const accessScope = scopeOrDenial(req, ctx.principal, slug);
    if (accessScope instanceof Response) return accessScope;
    const refusal = clusterRefusal();
    if (refusal) return refusal;
    const ok = killPty(ctx.params.id, accessScope);
    if (!ok) return Response.json({ error: 'unknown pty' }, { status: 404 });
    return new Response(null, { status: 204 });
  },
});

const auditList = defineTool({
  method: 'GET',
  path: '/harness/:slug/pi-sessions/audit',
  // Exported session HTML can contain prompts, tool arguments, and file
  // contents. It is a local/operator surface, never a public listing.
  auth: 'loopback',
  async handler(_req, ctx) {
    const slug = ctx.params.slug ?? '';
    const sd = await stateDirForSlug(slug);
    if (!sd) return Response.json({ error: 'unknown harness slug', slug }, { status: 404 });
    const auditDir = join(sd, 'audit', 'pi-sessions');
    if (!existsSync(auditDir)) return Response.json({ sessions: [] });

    let entries: string[];
    try { entries = readdirSync(auditDir); } catch { return Response.json({ sessions: [] }); }

    const sessions = entries
      .filter((e) => e.endsWith('.html'))
      .map((e) => {
        const full = join(auditDir, e);
        try {
          const st = statSync(full);
          const stem = e.slice(0, -'.html'.length);
          const m = stem.match(/^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)$/);
          return {
            filename: e,
            tag: m?.[1] ?? null,
            timestamp: m?.[2] ?? null,
            sessionId: m?.[3] ?? null,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
          };
        } catch {
          return { filename: e };
        }
      })
      .sort((a, b) => ((b as { mtimeMs?: number }).mtimeMs ?? 0) - ((a as { mtimeMs?: number }).mtimeMs ?? 0));

    return Response.json({ sessions });
  },
});

const auditFile = defineTool({
  method: 'GET',
  path: '/harness/:slug/pi-sessions/audit/:filename',
  auth: 'loopback',
  async handler(_req, ctx) {
    const slug = ctx.params.slug ?? '';
    const filename = ctx.params.filename;
    // Defense in depth: simple HTML basename only, no path traversal.
    if (!/^[\w.-]+\.html$/.test(filename)) {
      return Response.json({ error: 'invalid filename' }, { status: 400 });
    }
    const sd = await stateDirForSlug(slug);
    if (!sd) return Response.json({ error: 'unknown harness slug', slug }, { status: 404 });
    const full = join(sd, 'audit', 'pi-sessions', filename);
    if (!existsSync(full)) return Response.json({ error: 'not found' }, { status: 404 });

    let html: Buffer;
    try { html = readFileSync(full); } catch { return Response.json({ error: 'read failed' }, { status: 500 }); }
    // Buffer → ArrayBuffer view for the Web `Response` body (the legacy
    // Hono handler did the same `as unknown as ArrayBuffer` cast).
    return new Response(html as unknown as ArrayBuffer, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
});

const tools = defineTool({
  method: 'GET',
  path: '/harness/:slug/pty/tools',
  // The response includes the absolute extension path and private tool
  // inventory; keep it inside the local/operator perimeter as well.
  auth: 'loopback',
  handler() {
    const piExtensionPath = papercuspPath('global-plugins', 'pi', 'extension.ts');
    if (!existsSync(piExtensionPath)) {
      return Response.json({ extensionAvailable: false, tools: [] });
    }
    return Response.json({
      extensionAvailable: true,
      extensionPath: piExtensionPath,
      tools: [
        { name: 'papercusp_status', label: 'Harness Status', description: 'Mission state, iteration, last decision, cost.' },
        { name: 'papercusp_list_features', label: 'List Features', description: 'List features, optionally filtered by status.' },
        { name: 'papercusp_lineage', label: 'Feature Lineage', description: "Walk a feature's parent_id chain to root goal." },
        { name: 'papercusp_audit', label: 'Feature Audit Log', description: 'Audit log for a specific feature.' },
        { name: 'papercusp_proposals', label: 'Pending Proposals', description: 'Proposals from the scoper role.' },
        { name: 'papercusp_decisions', label: 'Recent Decisions', description: 'Recent orchestrator decisions.' },
        { name: 'papercusp_issues', label: 'Open Issues', description: 'Open issues for the harness.' },
      ],
    });
  },
});

export default [spawn, resolve, prewarm, ticket, stream, input, resize, kill, auditList, auditFile, tools];
