/**
 * connect.ts — orchestrate one power-user OMP session.
 *
 * Flow (docs/plans/omp-power-user-bundle-2026-05-20.md §4.3):
 *   1. Fetch the bundle with the access token.
 *   2. Write the session-scratch profile.
 *   3. Place `.mcp.json` where OMP discovers it (the project dir),
 *      backing up any pre-existing one.
 *   4. Spawn `omp` as a child and stay attached for its lifetime.
 *   5. Refresh the access token in the background, ~5 min before expiry.
 *   6. On OMP exit: restore the backed-up `.mcp.json`, remove the
 *      scratch dir, exit.
 *
 * The refresh token lives only in this process's memory (D-009).
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  fetchBundle,
  refreshAccessToken,
  refreshUrlFor,
  isHttpStatus,
  type AgentBundle,
} from './bundle-client.js';
import {
  writeProfile,
  rewriteAccessToken,
  cleanupProfile,
  type SessionProfile,
} from './profile-writer.js';

export interface ConnectOptions {
  /** Full URL of the /api/agent-bundle endpoint. */
  bundleUrl: string;
  /** Short-lived access token. */
  accessToken: string;
  /** Long-lived refresh token — kept in memory only. */
  refreshToken: string;
  /** Directory OMP runs in (file ops, bash, git). Default: process.cwd(). */
  ompCwd: string;
  /** auth_session_id — names the scratch dir. */
  authSessionId: string;
  /** When set, passed through to underlying `omp -r <id>` so the
   *  spawned OMP resumes the named session instead of starting fresh.
   *  The id is whatever `omp` itself exposes (its session/thread id) —
   *  papercusp-omp doesn't interpret it. */
  resumeSessionId?: string;
}

/** Refresh this many ms before the access token expires. */
const REFRESH_LEAD_MS = 5 * 60 * 1000;
/** Never schedule a refresh sooner than this (clock-skew / short TTL guard). */
const MIN_REFRESH_DELAY_MS = 10 * 1000;

function log(msg: string): void {
  process.stderr.write(`[papercusp-omp] ${msg}\n`);
}

/**
 * Place `.mcp.json` into the project dir OMP will discover. Returns a
 * restore function that puts the directory back the way it was found.
 */
function installMcpConfig(profile: SessionProfile, ompCwd: string): () => void {
  const target = join(ompCwd, '.mcp.json');
  const backup = join(ompCwd, '.mcp.json.pre-papercusp');
  let hadExisting = false;
  if (existsSync(target)) {
    hadExisting = true;
    renameSync(target, backup);
  }
  copyFileSync(profile.mcpConfigPath, target);
  return () => {
    try {
      rmSync(target, { force: true });
      if (hadExisting && existsSync(backup)) renameSync(backup, target);
    } catch {
      /* best-effort restore */
    }
  };
}

/**
 * Temp-install the per-session OMP gateway `models.yml` into `~/.omp/agent` so
 * the session routes through the Papercusp inference gateway (P-005 / D-006).
 * Mirrors installMcpConfig: backs up any existing `models.yml` AND `models.json`
 * (pi migrates json→yml on load, which would clobber ours), writes ours, and
 * returns a restore fn that undoes it on exit. No-op — and no `~/.omp` touch —
 * when the bundle carries no gateway config (gateway off / not account-pinned).
 */
export function installOmpModelsConfig(bundle: AgentBundle): () => void {
  const models = bundle.omp_gateway_models;
  if (!models?.content) return () => {};
  const agentDir = join(homedir(), '.omp', 'agent');
  const target = join(agentDir, 'models.yml');
  const legacyJson = join(agentDir, 'models.json');
  const backupYml = `${target}.pre-papercusp`;
  const backupJson = `${legacyJson}.pre-papercusp`;
  let hadYml = false;
  let hadJson = false;
  try {
    mkdirSync(agentDir, { recursive: true });
    if (existsSync(target)) { hadYml = true; renameSync(target, backupYml); }
    if (existsSync(legacyJson)) { hadJson = true; renameSync(legacyJson, backupJson); }
    writeFileSync(target, models.content, { mode: 0o600 });
    log(`gateway routing on — installed ~/.omp/agent/models.yml (model ${models.modelSelector})`);
  } catch (err) {
    log(`gateway models install failed (continuing on direct egress): ${err instanceof Error ? err.message : String(err)}`);
  }
  return () => {
    try {
      rmSync(target, { force: true });
      if (hadYml && existsSync(backupYml)) renameSync(backupYml, target);
      if (hadJson && existsSync(backupJson)) renameSync(backupJson, legacyJson);
    } catch {
      /* best-effort restore */
    }
  };
}

/** Re-copy the (refreshed) scratch `.mcp.json` into the project dir. */
function syncMcpConfig(profile: SessionProfile, ompCwd: string): void {
  try {
    copyFileSync(profile.mcpConfigPath, join(ompCwd, '.mcp.json'));
  } catch {
    /* the next session start will pick up the scratch copy regardless */
  }
}

/** Spawn `omp` with the profile's flags. Resolves with its exit code. */
function spawnOmp(
  profile: SessionProfile,
  ompCwd: string,
  resumeSessionId?: string,
  modelSelector?: string,
): Promise<number> {
  const args = ['--append-system-prompt', profile.systemPromptPath];
  for (const hook of profile.hookPaths) {
    args.push('--hook', hook);
  }
  // Gateway routing (P-005): select the papercusp-gateway provider's model so the
  // session uses the models.yml we installed, not pi's default/equivalenced model.
  if (modelSelector) {
    args.push('--model', modelSelector);
  }
  if (resumeSessionId) {
    args.push('-r', resumeSessionId);
  }
  return new Promise((resolve, reject) => {
    const child = spawn('omp', args, { cwd: ompCwd, stdio: 'inherit' });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'omp not found on PATH. Install it with: npm i -g @oh-my-pi/cli',
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

/**
 * Background access-token refresh. Returns a stop() that cancels the
 * pending timer. The refresh token never leaves this closure.
 */
function startRefreshLoop(
  bundleUrl: string,
  refreshToken: string,
  bundle: AgentBundle,
  profile: SessionProfile,
  ompCwd: string,
  firstExpiresAt: string,
): () => void {
  const refreshUrl = refreshUrlFor(bundleUrl);
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const schedule = (expiresAtIso: string): void => {
    if (stopped) return;
    const expMs = Date.parse(expiresAtIso);
    const delay = Number.isFinite(expMs)
      ? Math.max(expMs - Date.now() - REFRESH_LEAD_MS, MIN_REFRESH_DELAY_MS)
      : REFRESH_LEAD_MS;
    timer = setTimeout(tick, delay);
    // Don't keep the process alive solely for a refresh — OMP's exit
    // is what ends the session.
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const r = await refreshAccessToken(refreshUrl, refreshToken);
      rewriteAccessToken(profile, bundle, r.access_token);
      syncMcpConfig(profile, ompCwd);
      log('access token refreshed');
      schedule(r.access_expires_at);
    } catch (err) {
      if (isHttpStatus(err, 401)) {
        log('refresh rejected (session revoked or refresh token expired) — not retrying');
        return;
      }
      log(`refresh failed: ${err instanceof Error ? err.message : String(err)} — retrying in 30s`);
      timer = setTimeout(tick, 30 * 1000);
      timer.unref?.();
    }
  };

  schedule(firstExpiresAt);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Run a full power-user OMP session. Resolves with OMP's exit code.
 * Always tears down the scratch dir and restores `.mcp.json`.
 */
export async function connect(opts: ConnectOptions): Promise<number> {
  log(`fetching bundle from ${opts.bundleUrl}`);
  const bundle = await fetchBundle(opts.bundleUrl, opts.accessToken);
  log(
    `bundle: workspace="${bundle.workspace.name}" user="${bundle.user.displayName}" ` +
      `skills=${bundle.skills.length} hooks=${bundle.hooks.length}`,
  );

  const profile = writeProfile(opts.authSessionId, bundle, opts.accessToken);
  const restoreMcp = installMcpConfig(profile, opts.ompCwd);
  const restoreOmpModels = installOmpModelsConfig(bundle);

  const stopRefresh = startRefreshLoop(
    opts.bundleUrl,
    opts.refreshToken,
    bundle,
    profile,
    opts.ompCwd,
    bundle.expires_at,
  );

  const teardown = (): void => {
    stopRefresh();
    restoreMcp();
    restoreOmpModels();
    cleanupProfile(profile);
  };
  // Cover the SIGINT/SIGTERM paths too — `omp` shares the terminal's
  // process group, but if this wrapper is signalled directly we still
  // want the scratch dir gone.
  let toreDown = false;
  const once = (): void => {
    if (toreDown) return;
    toreDown = true;
    teardown();
  };
  process.once('SIGINT', once);
  process.once('SIGTERM', once);

  try {
    const code = await spawnOmp(
      profile,
      opts.ompCwd,
      opts.resumeSessionId,
      bundle.omp_gateway_models?.modelSelector,
    );
    log(`omp exited (code ${code})`);
    return code;
  } finally {
    once();
  }
}
