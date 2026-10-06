/**
 * dev:restart — the blessed path to restart the operator dev server (P-027)
 * OR the staging operator (`target: 'staging'`, WI-4221).
 *
 * The canonical wrapper for the destructive "restart the dev/staging server"
 * action: it acquires exclusive(<target>-server) with a drain (existing
 * users finish, new ones are refused), then restarts, then releases (which
 * broadcasts "back up"). Use this instead of a raw `systemctl restart` so
 * peers are coordinated.
 *
 * Safe by default on a shared box:
 *   - No `confirm` → DRY RUN. Reports what it would do; takes NO lock,
 *     drains nobody, restarts nothing.
 *   - `confirm: true` WITHOUT the enablement gate (`PAPERCUSP_ALLOW_DEV_RESTART=1`
 *     or per-call `authorize: true`) → REFUSED outright, before any side effect:
 *     ok:false, reason:'restart_withheld', nothing locked, nothing drained.
 *   - `confirm: true` WITH the gate → acquires + drains, then restarts.
 *
 * EI-18643120769203916: that refusal used to happen INSIDE the drain block, so an
 * un-enabled call acquired the lock, DRAINED every current user, and then reported
 * `ok:true, drained:true, restarted:false`. Two defects: it half-executed (leaving
 * the target quiesced on old code — worse than either doing nothing or restarting),
 * and `ok:true` reads as success, so an agent firing the documented call and
 * checking `ok` concluded the restart had landed. That is the likeliest driver of
 * EI-18642482762875484, where six workers re-learned the bg-host stale-runtime
 * lesson over ~5 days while the restart never actually fired.
 *
 * WI-4221 (staging debounce/coalescing): `papercup-staging-api.service` was
 * being restarted raw (uncoordinated `systemctl`) every ~5-6min for hours —
 * every agent's own "test a live edit" workflow firing its own restart, each
 * one a real (if brief) outage AND the trigger that made EI-9748 (headless
 * children reaped by the service's cgroup on every restart) fire constantly.
 * `target: 'staging'` additionally debounces: on a REAL restart it acquires
 * `staging-server-cooldown` (exclusive, TTL=STAGING_COOLDOWN_SEC) and
 * deliberately does NOT release it — it is left to expire. A restart request
 * that lands while that cooldown is still held is COALESCED: no second
 * restart fires, the caller is told a peer already restarted recently and
 * :3170 should already be back up. `target: 'dev'` (default) is unchanged —
 * :3070 restarts are already infrequent (auto-deploy-pipeline-driven), so no
 * cooldown is applied there.
 *
 * EI-11137 (phantom-coalesce fix): a held cooldown marker is NOT proof a
 * restart happened — it can be held while none did (a withheld/failed restart,
 * or a stale marker perpetually re-observed on a busy fleet), and the old code
 * trusted it blindly, silently wedging EVERY subsequent restart for the TTL.
 * That bit bg-host hardest (it re-bundles the working tree ONLY on restart, so
 * fixes never went live). Before honoring a coalesce we now CROSS-CHECK the
 * service's real last-start via systemd (probeServiceStart): coalesce only when
 * the service genuinely restarted within the window; a phantom marker is
 * refused and a real restart fires. Every real-restart result also surfaces
 * `restartedFromPid` + `verifyWith` so the caller can confirm the PID cycled.
 *
 * EI-13307 (bg-host's REAL cost is ~13min, not ~2min): bg-host was sharing the
 * generic 2-minute GATEWAY_COOLDOWN_SEC used by gateway/embed-sidecar, but its
 * actual restart cost is the ~13-minute cross-machine peer-log/swarm rejoin
 * freeze (EI-13317) — a restart storm from several agents each independently
 * "fixing their own thing" a few minutes apart kept the federation rails down
 * almost continuously for over an hour (LIVE-1 drill, 2026-07-17). bg-host now
 * gets its OWN, much wider cooldown window (BG_HOST_COOLDOWN_SEC, ~13min) —
 * cooldown windows are per-target, not global — and a real (non-coalesced)
 * bg-host restart's result states the rail-freeze cost explicitly so callers
 * understand what they just did. Detecting "peer-log reader still catching
 * up" and refusing/queuing a restart during that window is NOT implemented
 * here — it depends on a health signal EI-13317 doesn't yet expose; that is
 * EI-13317's job, not this tool's.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { readProcessCgroupPath } from '../../task-manager/cgroup-read';
import { createTextCollector } from '../../child-output';
import { promisify } from 'node:util';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { readIdentity } from '../locks/identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { guardResource } from '../locks/resource-lock-guard';
import { resourceLockDomain } from '../locks/coordination-domain';
import { tryAcquireResource, tryReleaseResource, type ResourceHolder } from '../locks/su-lock-store';
import { inWorkspaceTxn } from '../locks/in-workspace-txn';
import { acquireWithContentionRetry } from '../locks/contention-retry';
import { workspaceTxnOptionsForExclusiveWait } from '../locks/resource-acquire-wait';
import { probeServiceStart, probeSystemdDaemonReloadNeed, type ServiceStartInfo } from './systemd-service-probe';
import { RESTART_TARGET_UNITS } from './restart-target-units';
import { preflightRestartTarget, prepareStagingSchemaForRestart } from './restart-preflight';
import { peerInFlightEditsNote, readPeerInFlightEdits, type PeerInFlightEdits } from './restart-peer-edits';
import {
  checkBgHostQuiesce,
  isQuiesceSensitiveTarget,
  type QuiesceMarker,
  type QuiesceVerdict,
} from './bg-host-quiesce-guard';
import { DESKTOP_DEV_RESOURCE, resolveDesktopDevListener, restartDesktopDev } from './desktop-dev-restart';
import { activeWorkspaceId } from '../../workspace-registry';
import { probeHttpReachable, type HttpProbeResult } from '../../escalating-http-probe';
import { listListeningSockets } from '../../listening-sockets';
import { integrationTreeRoots } from '../../harness/routines/restricted-tree-skip';
import { restrictedTreeHoldRefusal, type RestrictedHoldRefusal } from '../testing/restricted-hold-fence';
import {
  acquireGitSyncRestartBarrier,
  GIT_SYNC_RESTART_BARRIER_DRAIN_SEC,
  checkGateCollision,
  checkGitSyncCollision,
  checkStagingSyncCollision,
  isGateSensitiveTarget,
  isGitSyncSensitiveTarget,
} from '../../release/gate-collision-guard';

const MAX_DRAIN_SEC = 300;
const DEFAULT_DRAIN_SEC = 120;
/**
 * The gateway restart is detached so the caller's transport survives the
 * operator-side systemd bounce. A changed MainPID is still only process-start
 * evidence: the gateway can take a moment longer before it binds :8788. Keep
 * the PID-cycle wait bounded, then use the shared escalating HTTP probe for
 * the listener contract.
 */
const GATEWAY_RESTART_PID_WAIT_MS = 20_000;
const GATEWAY_RESTART_PID_POLL_MS = 250;
/**
 * Staging restarts are detached too, but unlike the :3070 target they do not
 * kill this tool's own HTTP transport. Observe the systemd/listener transition
 * before claiming success so a rejected detached command cannot return the
 * historical false-green `ok:true, restarted:true` (EI-21580132226178416).
 */
const STAGING_RESTART_OBSERVE_MS = 10_000;
const STAGING_RESTART_POLL_MS = 250;
const BG_HOST_RESTART_OBSERVE_MS = 30_000;
const BG_HOST_RESTART_POLL_MS = 250;
const STAGING_SYNC_LOCK_HANDOFF_TIMEOUT_MS = 5_000;
const STAGING_SYNC_LOCK_HANDOFF_READY = 'papercup-staging-sync-lock-acquired';

type StagingRestartHandoff =
  | { acquired: true; start: () => void; abort: () => void }
  | {
      acquired: false;
      reason: 'lock-busy' | 'handoff-failed';
      exitCode?: number | null;
      detail?: string;
    };

/**
 * Reserve the staging checkout's read window in the detached systemctl process.
 * The earlier collision probe is only an observation; staging-sync can acquire
 * exclusive after it returns. `flock` takes shared+nonblocking after that probe,
 * reports the acquisition over fd 3, then waits for the parent to release the
 * one-second systemctl delay over fd 4. Its lock stays held while systemd runs
 * ExecStartPre, whose bundle read takes the same shared lock.
 */
async function prepareStagingRestartHandoff(lockPath: string, restartCmd: string): Promise<StagingRestartHandoff> {
  const child = spawn(
    '/usr/bin/flock',
    [
      '--shared',
      '--nonblock',
      '--conflict-exit-code',
      '75',
      lockPath,
      'sh',
      '-c',
      `set -e; printf '${STAGING_SYNC_LOCK_HANDOFF_READY}\\n' >&3; IFS= read -r _ <&4; sleep 1; exec ${restartCmd}`,
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  // Node types extra fds as Readable | Writable; fd 3 is our readiness pipe
  // and fd 4 is the parent's write end.
  const readyStream = child.stdio[3] as Readable | null | undefined;
  const startStream = child.stdio[4] as Writable | null | undefined;
  if (!readyStream || !startStream) {
    child.kill('SIGTERM');
    return { acquired: false, reason: 'handoff-failed', detail: 'lock handoff pipes were unavailable' };
  }

  return await new Promise<StagingRestartHandoff>((resolve) => {
    let settled = false;
    const received = createTextCollector(readyStream);
    const cleanup = (keepStartPipe: boolean) => {
      clearTimeout(timeout);
      readyStream.removeAllListeners('data');
      readyStream.destroy();
      if (!keepStartPipe) startStream.destroy();
    };
    const finish = (result: StagingRestartHandoff) => {
      if (settled) return;
      settled = true;
      cleanup(result.acquired);
      resolve(result);
    };
    const stopChildGroup = () => {
      if (child.pid === undefined) {
        child.kill('SIGTERM');
        return;
      }
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    const timeout = setTimeout(() => {
      finish({ acquired: false, reason: 'handoff-failed', detail: 'timed out waiting for flock acquisition' });
      stopChildGroup();
    }, STAGING_SYNC_LOCK_HANDOFF_TIMEOUT_MS);

    readyStream.on('data', () => {
      // peek(), not text(): text() flushes the decoder and corrupts a character split across chunks.
      if (!received.peek().includes(STAGING_SYNC_LOCK_HANDOFF_READY)) return;
      finish({
        acquired: true,
        start: () => {
          if (startStream.destroyed) throw new Error('staging restart handoff was closed before release');
          startStream.end('go\n');
          child.unref();
        },
        abort: () => {
          startStream.destroy();
          stopChildGroup();
        },
      });
    });
    child.once('close', (exitCode) => {
      finish({
        acquired: false,
        reason: exitCode === 75 ? 'lock-busy' : 'handoff-failed',
        exitCode,
      });
    });
    // Keep an error listener after acquisition so a later child-process error
    // cannot become an unhandled EventEmitter error in the operator host.
    child.on('error', (error) => {
      finish({ acquired: false, reason: 'handoff-failed', detail: error.message });
    });
  });
}
type ExecFileP = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;
let cachedExecFile: ExecFileP | null = null;
const runExecFile = (...args: Parameters<ExecFileP>) => {
  if (cachedExecFile === null) cachedExecFile = promisify(execFile) as unknown as ExecFileP;
  return cachedExecFile(...args);
};

/**
 * A restart must consume the unit/drop-in bytes that are on disk NOW. systemd
 * otherwise restarts from its cached unit definition, so a newly installed
 * Environment= pin can appear to activate (new PID) while the replacement
 * process still receives the previous value (EI-22480835928661383).
 */
export const SYSTEMD_USER_DAEMON_RELOAD = {
  command: 'systemctl',
  args: ['--user', 'daemon-reload'],
} as const;
export const SYSTEMD_DAEMON_RELOAD_TIMEOUT_MS = 20_000;
function isExecFileTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ETIMEDOUT';
}
export type SystemdDaemonReloader = () => Promise<void>;
const defaultSystemdDaemonReloader: SystemdDaemonReloader = async () => {
  await runExecFile(SYSTEMD_USER_DAEMON_RELOAD.command, [...SYSTEMD_USER_DAEMON_RELOAD.args], {
    cwd: process.cwd(),
    timeout: SYSTEMD_DAEMON_RELOAD_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
};
let systemdDaemonReloader = defaultSystemdDaemonReloader;

/** Test seam: confirmed restart tests must never mutate the real user manager. */
export function configureSystemdDaemonReloaderForTests(
  reloader: SystemdDaemonReloader = defaultSystemdDaemonReloader,
): void {
  systemdDaemonReloader = reloader;
}

/**
 * bg-host is the one restart target whose ExecStartPre rebuilds an artifact from
 * the working tree. A recent restart therefore proves only that SOME bundle was
 * built, not that the caller's current tree is in that bundle. Keep this source
 * scope broad enough to include the host entrypoint and operator-core runtime
 * code, but exclude tests so a test-only edit cannot manufacture a stale-runtime
 * warning.
 */
const BG_HOST_BUNDLE_RELATIVE_PATH = 'apps/operator/dist-host/hono-host.mjs';
const BG_HOST_SOURCE_ROOTS = ['apps/operator/bin', 'apps/operator/lib', 'packages/operator-core/lib'] as const;

export type BgHostRestartFreshnessSnapshot = {
  bundleMtimeMs: number | null;
  newestSourceMtimeMs: number | null;
  newestSourcePath: string | null;
};

export type BgHostRestartFreshness = BgHostRestartFreshnessSnapshot & {
  /**
   * `true` means the newest runtime source on disk is newer than the bundle
   * produced for the coalesced restart, so the caller's edit is not loaded.
   * `null` is UNKNOWN — never turn an unreadable artifact/tree into `false`.
   */
  treeChangedSinceRestart: boolean | null;
  checked: boolean;
};

/**
 * PURE — compare the current source graph with the bundle that the recent
 * restart actually produced. This deliberately reports the source-vs-artifact
 * relation rather than restarting eagerly: bg-host restarts can SIGKILL an
 * in-flight git-sync operation, so the temporal throttle remains authoritative.
 */
export function evaluateBgHostRestartFreshness(snapshot: BgHostRestartFreshnessSnapshot): BgHostRestartFreshness {
  const bundleMtimeMs =
    snapshot.bundleMtimeMs != null && Number.isFinite(snapshot.bundleMtimeMs) ? snapshot.bundleMtimeMs : null;
  const newestSourceMtimeMs =
    snapshot.newestSourceMtimeMs != null && Number.isFinite(snapshot.newestSourceMtimeMs)
      ? snapshot.newestSourceMtimeMs
      : null;
  const checked = bundleMtimeMs != null && newestSourceMtimeMs != null;
  return {
    bundleMtimeMs,
    newestSourceMtimeMs,
    newestSourcePath: snapshot.newestSourcePath ?? null,
    treeChangedSinceRestart: checked ? newestSourceMtimeMs > bundleMtimeMs : null,
    checked,
  };
}

export type BgHostRestartFreshnessReader = (integrationRoot: string) => Promise<BgHostRestartFreshnessSnapshot>;

/**
 * Read the bundle and the newest runtime-source mtime without deciding whether
 * to restart. The subprocess is bounded and the whole reader is fail-soft;
 * callers must surface UNKNOWN rather than manufacture a clean result.
 */
const defaultBgHostRestartFreshnessReader: BgHostRestartFreshnessReader = async (integrationRoot) => {
  const bundlePath = resolve(integrationRoot, BG_HOST_BUNDLE_RELATIVE_PATH);
  let bundleMtimeMs: number | null = null;
  try {
    const mtimeMs = statSync(bundlePath).mtimeMs;
    bundleMtimeMs = Number.isFinite(mtimeMs) ? mtimeMs : null;
  } catch {
    // The caller will report UNKNOWN if the bundle is absent or unreadable.
  }

  const { stdout } = await runExecFile(
    'find',
    [
      ...BG_HOST_SOURCE_ROOTS,
      '-type',
      'f',
      '(',
      '-name',
      '*.ts',
      '-o',
      '-name',
      '*.tsx',
      '-o',
      '-name',
      '*.js',
      '-o',
      '-name',
      '*.mjs',
      ')',
      '-not',
      '-name',
      '*.test.ts',
      '-not',
      '-name',
      '*.test.tsx',
      '-not',
      '-name',
      '*.test.js',
      '-not',
      '-name',
      '*.test.mjs',
      '-not',
      '-path',
      '*/__tests__/*',
      '-printf',
      '%T@ %p\n',
    ],
    { cwd: integrationRoot, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
  );

  let newestSourceMtimeMs: number | null = null;
  let newestSourcePath: string | null = null;
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf(' ');
    if (separator <= 0) continue;
    const mtimeMs = Number(line.slice(0, separator)) * 1000;
    if (!Number.isFinite(mtimeMs) || (newestSourceMtimeMs != null && mtimeMs <= newestSourceMtimeMs)) continue;
    newestSourceMtimeMs = mtimeMs;
    newestSourcePath = line.slice(separator + 1);
  }
  return { bundleMtimeMs, newestSourceMtimeMs, newestSourcePath };
};

let bgHostRestartFreshnessReader = defaultBgHostRestartFreshnessReader;

/**
 * Test seam — production uses the bounded filesystem reader above; tests inject
 * a snapshot so the handler's coalesce branch remains deterministic and never
 * shells out to `find`.
 */
export function configureBgHostRestartFreshnessReaderForTests(
  reader: BgHostRestartFreshnessReader = defaultBgHostRestartFreshnessReader,
): void {
  bgHostRestartFreshnessReader = reader;
}

export type BgHostEnvironmentDropInSnapshot = {
  path: string;
  mtimeMs: number;
  contents: string;
};

export type BgHostEnvironmentDropInFreshness = {
  checked: boolean;
  changedPaths: string[];
};

const UNKNOWN_BG_HOST_ENVIRONMENT_FRESHNESS: BgHostEnvironmentDropInFreshness = {
  checked: false,
  changedPaths: [],
};

/**
 * PURE — identify active Environment= drop-ins whose bytes post-date the exact
 * current MainPID start time. Comparing only these files avoids treating
 * unrelated process environment differences (for example PATH) as a stale unit.
 */
export function evaluateBgHostEnvironmentDropInFreshness(
  dropIns: readonly BgHostEnvironmentDropInSnapshot[],
  startedAtMs: number,
): BgHostEnvironmentDropInFreshness {
  if (!Number.isFinite(startedAtMs) || dropIns.some((dropIn) => !Number.isFinite(dropIn.mtimeMs))) {
    return { ...UNKNOWN_BG_HOST_ENVIRONMENT_FRESHNESS };
  }

  const changedPaths = dropIns
    .filter((dropIn) => {
      if (dropIn.mtimeMs <= startedAtMs) return false;
      return dropIn.contents.split(/\r?\n/).some((rawLine) => {
        const line = rawLine.trimStart();
        return !line.startsWith('#') && /^Environment\s*=/.test(line);
      });
    })
    .map((dropIn) => dropIn.path);
  return { checked: true, changedPaths };
}

export type BgHostEnvironmentDropInFreshnessReader = (
  unit: string,
  startedAtMs: number,
) => Promise<BgHostEnvironmentDropInFreshness>;

const defaultBgHostEnvironmentDropInFreshnessReader: BgHostEnvironmentDropInFreshnessReader = async (
  unit,
  startedAtMs,
) => {
  if (process.platform !== 'linux') return { ...UNKNOWN_BG_HOST_ENVIRONMENT_FRESHNESS };
  try {
    const { stdout } = await runExecFile(
      'systemctl',
      ['--user', 'show', '-p', 'DropInPaths', unit],
      { cwd: process.cwd(), timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const dropInLine = stdout.split(/\r?\n/).find((line) => line.startsWith('DropInPaths='));
    if (dropInLine === undefined) return { ...UNKNOWN_BG_HOST_ENVIRONMENT_FRESHNESS };

    const paths = dropInLine
      .slice('DropInPaths='.length)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const snapshots: BgHostEnvironmentDropInSnapshot[] = [];
    for (const path of paths) {
      if (!isAbsolute(path)) return { ...UNKNOWN_BG_HOST_ENVIRONMENT_FRESHNESS };
      const before = statSync(path);
      if (!before.isFile()) return { ...UNKNOWN_BG_HOST_ENVIRONMENT_FRESHNESS };
      const contents = readFileSync(path, 'utf8');
      const after = statSync(path);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
        return { ...UNKNOWN_BG_HOST_ENVIRONMENT_FRESHNESS };
      }
      snapshots.push({ path, mtimeMs: before.mtimeMs, contents });
    }
    return evaluateBgHostEnvironmentDropInFreshness(snapshots, startedAtMs);
  } catch {
    return { ...UNKNOWN_BG_HOST_ENVIRONMENT_FRESHNESS };
  }
};

let bgHostEnvironmentDropInFreshnessReader = defaultBgHostEnvironmentDropInFreshnessReader;

/** Test seam — keep systemctl and filesystem reads out of handler tests. */
export function configureBgHostEnvironmentDropInFreshnessReaderForTests(
  reader: BgHostEnvironmentDropInFreshnessReader = defaultBgHostEnvironmentDropInFreshnessReader,
): void {
  bgHostEnvironmentDropInFreshnessReader = reader;
}

async function readBgHostEnvironmentDropInFreshness(
  unit: string,
  service: ServiceStartInfo,
): Promise<BgHostEnvironmentDropInFreshness> {
  if (
    !service.ok ||
    service.mainPid === undefined ||
    service.mainPid <= 0 ||
    service.startedAtMs === undefined
  ) {
    return { ...UNKNOWN_BG_HOST_ENVIRONMENT_FRESHNESS };
  }
  try {
    return await bgHostEnvironmentDropInFreshnessReader(unit, service.startedAtMs);
  } catch {
    return { ...UNKNOWN_BG_HOST_ENVIRONMENT_FRESHNESS };
  }
}

/**
 * WI-10003606: bg-host bundles from ITS OWN integration root, which is not the
 * root of the operator serving this tool. dev:restart runs inside the :3070 /
 * :3170 operator, whose PAPERCUSP_INTEGRATION_ROOT names papercup-release /
 * papercusp-staging, while papercusp-bg-host.service runs from the canonical
 * tree. Scanning the caller's root compared the wrong bundle with the wrong
 * sources, and reported a confident `treeChangedSinceRestart:false` for an
 * edit the running bg-host had never loaded (measured 2026-09-28 05:44Z).
 *
 * PURE — parse `systemctl --user show <unit> -p Environment -p WorkingDirectory`.
 * The unit's own PAPERCUSP_INTEGRATION_ROOT wins; otherwise the unit's
 * `<root>/apps/operator` WorkingDirectory implies the root. Any other layout
 * is UNKNOWN (null), never a guess.
 */
export function bgHostIntegrationRootFromUnitProperties(stdout: string): string | null {
  let envRoot: string | null = null;
  let workingDirectory: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('Environment=')) {
      const match = /(?:^|\s)"?PAPERCUSP_INTEGRATION_ROOT=([^"\s]+)/.exec(line.slice('Environment='.length));
      if (match) envRoot = match[1]!;
    } else if (line.startsWith('WorkingDirectory=')) {
      workingDirectory = line.slice('WorkingDirectory='.length).trim() || null;
    }
  }
  if (envRoot && isAbsolute(envRoot)) return envRoot;
  const normalizedWorkingDirectory = workingDirectory?.replace(/\/+$/, '') ?? null;
  if (
    normalizedWorkingDirectory &&
    isAbsolute(normalizedWorkingDirectory) &&
    normalizedWorkingDirectory.endsWith('/apps/operator')
  ) {
    return resolve(normalizedWorkingDirectory, '..', '..');
  }
  return null;
}

export type BgHostIntegrationRootResolver = () => Promise<string | null>;

const defaultBgHostIntegrationRootResolver: BgHostIntegrationRootResolver = async () => {
  const { stdout } = await runExecFile(
    'systemctl',
    ['--user', 'show', RESTART_TARGET_UNITS['bg-host'], '-p', 'Environment', '-p', 'WorkingDirectory'],
    { cwd: process.cwd(), timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  return bgHostIntegrationRootFromUnitProperties(stdout);
};

let bgHostIntegrationRootResolver = defaultBgHostIntegrationRootResolver;

/** Test seam — tests pin the bg-host root so they never shell out to systemctl. */
export function configureBgHostIntegrationRootResolverForTests(
  resolver: BgHostIntegrationRootResolver = defaultBgHostIntegrationRootResolver,
): void {
  bgHostIntegrationRootResolver = resolver;
}

/**
 * EI-24790218658923698: which files another agent is mid-edit on in the tree the unit
 * boots from (see restart-peer-edits.ts). Advisory only — fails soft to checked:false.
 */
export type PeerInFlightEditsReader = (
  workingDirectory: string | null,
  selfOwner: string | null,
) => Promise<PeerInFlightEdits>;

const defaultPeerInFlightEditsReader: PeerInFlightEditsReader = (workingDirectory, selfOwner) =>
  readPeerInFlightEdits(workingDirectory, selfOwner);

let peerInFlightEditsReader = defaultPeerInFlightEditsReader;

/** Test seam — tests never read the real lock plane or shell out to git. */
export function configurePeerInFlightEditsReaderForTests(
  reader: PeerInFlightEditsReader = defaultPeerInFlightEditsReader,
): void {
  peerInFlightEditsReader = reader;
}

const UNKNOWN_BG_HOST_FRESHNESS: BgHostRestartFreshness = {
  bundleMtimeMs: null,
  newestSourceMtimeMs: null,
  newestSourcePath: null,
  treeChangedSinceRestart: null,
  checked: false,
};

async function readBgHostRestartFreshness(): Promise<BgHostRestartFreshness> {
  try {
    const integrationRoot = await bgHostIntegrationRootResolver();
    // Never fall back to the serving operator's root: that is the WI-10003606
    // false-fresh verdict. An unresolvable bg-host root is UNKNOWN.
    if (!integrationRoot) return { ...UNKNOWN_BG_HOST_FRESHNESS };
    return evaluateBgHostRestartFreshness(await bgHostRestartFreshnessReader(integrationRoot));
  } catch {
    return { ...UNKNOWN_BG_HOST_FRESHNESS };
  }
}

/** WI-4221: how long a real staging restart's cooldown marker stands before
 *  a subsequent restart request is allowed through again. Long enough to
 *  coalesce a burst of "test my edit" restarts from several agents within
 *  the same short window; short enough that a genuinely new edit a couple
 *  minutes later still gets its own restart promptly. */
const STAGING_COOLDOWN_SEC = 120;

/**
 * EI-10896: the SHARED long-running hosts beyond the operator. Every one of these runs code from the
 * STAGING tree with no deploy hop — the gateway via tsx; bg-host and embed-sidecar via a bundle their
 * unit REBUILDS on every start (ExecStartPre=bundle-host.sh, fail-closed). Either way an edit is on
 * their disk IMMEDIATELY but is NOT loaded until the process restarts — no deploy is involved. Before
 * this, none of them had a sanctioned restart path: the target enum was ['dev','staging'], so the
 * ONLY way to land a gateway fix was the exact raw `systemctl --user restart` this tool's own
 * guidance forbids. A rule you can only obey by not doing your job gets broken — so the rule now
 * has a tool behind it.
 *
 * The GATEWAY is the most shared process in the system (every agent's LLM egress flows through it),
 * which makes coalescing matter MORE here than for :3170, not less: N agents each landing a gateway
 * fix would otherwise mean N fleet-wide outages. It gets a cooldown marker for exactly that reason.
 */
const GATEWAY_COOLDOWN_SEC = 120;

/**
 * EI-13307: bg-host's REAL restart cost is not the ~10s process bounce that
 * the generic GATEWAY_COOLDOWN_SEC window was tuned for — it's the
 * ~13-minute cross-machine peer-log/swarm rejoin freeze documented in
 * EI-13317 (peer-log gossip does not reliably self-heal after a restart). A
 * 2-minute window let a restart storm from several agents, each ~10min
 * apart, keep re-triggering that freeze for over an hour (LIVE-1 drill,
 * 2026-07-17) because each new restart looked "outside the cooldown" under
 * the old window even though the prior rejoin hadn't finished. Widened to
 * the observed cost so a whole storm across that window coalesces into ONE
 * outage instead of a fresh one per restart.
 */
const BG_HOST_COOLDOWN_SEC = 13 * 60; // 780s

type RestartTarget =
  | 'dev'
  | 'staging'
  | 'gateway'
  | 'bg-host'
  | 'embed-sidecar'
  | 'mcp-proxy'
  | 'mcp-proxy-staging'
  | 'email-sidecar'
  | 'calendar-sidecar'
  | 'desktop-dev';

/**
 * Fixed listener ports for restart targets whose useful readiness contract is
 * "something is serving", not "systemd has finished assigning MainPID".
 *
 * Keep this local to the restart tool rather than teaching the systemd probe
 * about application ports: the probe answers service-manager state, while this
 * guidance points callers at the instrument that answers the question they
 * actually have after a restart.
 */
const RESTART_TARGET_PORTS: Partial<Record<RestartTarget, number>> = {
  dev: 3070,
  staging: 3170,
  'embed-sidecar': 3384,
  'mcp-proxy': 9071,
  'mcp-proxy-staging': 9171,
  'email-sidecar': 8791,
  'calendar-sidecar': 8792,
};

/**
 * Return verification guidance that matches the target's real readiness
 * contract. In particular, MainPID=0 while ActiveState=activating is a valid
 * transient startup state; recommending a one-shot MainPID comparison turns
 * that bookkeeping lag into a false failed-restart report.
 */
export function restartVerificationHint(
  target: RestartTarget,
  unit: string,
  beforePid: number | null,
  beforeNRestarts?: number,
): string {
  const port = RESTART_TARGET_PORTS[target];
  if (port !== undefined) {
    return (
      `dev:listening_ports { port: ${port} } (expect ownerVisible:true and a listener pid${
        beforePid ? ` different from ${beforePid}` : ''
      }; compare pid/pids to restartedFromPid. A listener is authoritative while systemd starts — MainPID=0 with ` +
      `ActiveState=activating means still starting, NOT failed; no listener row means unbound.)`
    );
  }

  if (target === 'bg-host') {
    return (
      `Bounded poll (up to ~30s): \`systemctl --user show ${unit} -p MainPID --value\` until MainPID is nonzero${
        beforePid ? ` and differs from ${beforePid}` : ''
      }, while checking \`systemctl --user show ${unit} -p ActiveState --value\`. ` +
      `MainPID=0 with ActiveState=activating means still starting, NOT failed — do not trigger a second restart ` +
      `while this startup poll is in progress. ` +
      // EI-24790218658923698: a crash at module import (e.g. an unrepresentable tool args
      // schema in a peer's uncommitted edit) yields a FRESH, nonzero MainPID that dies
      // seconds later, so the check above alone passes on a crash-loop. systemd's NRestarts
      // counts only its own Restart= restarts, so a deliberate restart leaves it unchanged.
      `Then confirm it STAYS up: ~60s after MainPID appears, re-read \`-p MainPID -p NRestarts\` and expect the same ` +
      `MainPID and NRestarts still ${typeof beforeNRestarts === 'number' ? beforeNRestarts : 'at its pre-restart value'}. ` +
      `A climbing NRestarts is a crash-loop: read logs:read { unit: '${unit}', since: '-5min', level: 'err' } for the ` +
      `boot error, and check peerInFlightEdits (files other agents are mid-edit on) first.`
    );
  }

  // Keep a safe, explicit fallback for a future portless target added to the
  // union before its dedicated readiness contract is registered.
  return (
    `Bounded poll (up to ~30s): \`systemctl --user show ${unit} -p MainPID --value\` and ` +
    `\`systemctl --user show ${unit} -p ActiveState --value\` until MainPID is nonzero${
      beforePid ? ` and differs from ${beforePid}` : ''
    }; MainPID=0 with ActiveState=activating means still starting, NOT failed.`
  );
}

/**
 * Exported for the registry-parity regression test. A target added here is
 * not operable until its resource (and optional cooldown marker) is seeded by
 * a locks-package migration — WI-4780 was the production miss this prevents.
 */
export const RESTART_TARGETS: Record<
  RestartTarget,
  { unit: string; resource: string; cooldownResource?: string; blastRadius: string }
> = {
  // `unit` comes from RESTART_TARGET_UNITS (systemd-service-probe) so the unit
  // names have ONE definition — read-only callers that need "which unit runs
  // this?" import that map instead of this heavyweight module.
  dev: {
    unit: RESTART_TARGET_UNITS.dev,
    resource: 'dev-server',
    blastRadius: 'the :3070 operator (green release checkout)',
  },
  staging: {
    unit: RESTART_TARGET_UNITS.staging,
    resource: 'staging-server',
    cooldownResource: 'staging-server-cooldown',
    blastRadius: 'the :3170 staging operator',
  },
  gateway: {
    unit: RESTART_TARGET_UNITS.gateway,
    resource: 'inference-gateway',
    cooldownResource: 'inference-gateway-cooldown',
    blastRadius:
      'EVERY agent in the fleet — all LLM egress flows through :8788, so in-flight requests are dropped fleet-wide',
  },
  'bg-host': {
    unit: RESTART_TARGET_UNITS['bg-host'],
    resource: 'bg-host',
    cooldownResource: 'bg-host-cooldown',
    blastRadius: 'the background routines/git-sync/DBOS ticker (an in-flight git-sync commit is interrupted)',
  },
  'embed-sidecar': {
    unit: RESTART_TARGET_UNITS['embed-sidecar'],
    resource: 'embed-sidecar',
    cooldownResource: 'embed-sidecar-cooldown',
    blastRadius: 'the shared embedding sidecar (:3384) — semantic search / memory recall degrade until it is back',
  },
  'mcp-proxy': {
    unit: RESTART_TARGET_UNITS['mcp-proxy'],
    resource: 'mcp-proxy',
    cooldownResource: 'mcp-proxy-cooldown',
    blastRadius: 'the shared MCP proxy (:9071) — Papercusp tool calls fail until it is back',
  },
  'mcp-proxy-staging': {
    unit: RESTART_TARGET_UNITS['mcp-proxy-staging'],
    // Both proxy instances share one exclusive lock so they cannot be restarted
    // concurrently. Keep cooldown separate from :9071: restarting that instance
    // must not falsely coalesce a needed :9171 profile activation (or vice versa).
    resource: 'mcp-proxy',
    blastRadius: 'the staging MCP proxy (:9171 → :3170) — pinned staging tool calls fail until it is back',
  },
  // WI-10001633: app sidecars run tsx from their own checkout with no
  // restart-on-change; this is the sanctioned way to load an edit into them.
  'email-sidecar': {
    unit: RESTART_TARGET_UNITS['email-sidecar'],
    resource: 'email-sidecar',
    cooldownResource: 'email-sidecar-cooldown',
    blastRadius:
      'the Email app sidecar (:8791) — the Email app is unavailable until it is back; Gmail sync resumes on boot',
  },
  'calendar-sidecar': {
    unit: RESTART_TARGET_UNITS['calendar-sidecar'],
    resource: 'calendar-sidecar',
    cooldownResource: 'calendar-sidecar-cooldown',
    blastRadius: 'the Calendar app sidecar (:8792) — the Calendar app is unavailable until it is back',
  },
  'desktop-dev': {
    // This is a wrapper label, not a systemd unit. The target branch below
    // validates and signals the wrapper-owned :3270 listener directly.
    unit: 'desktop-dev-wrapper',
    resource: DESKTOP_DEV_RESOURCE,
    blastRadius:
      'the owner-visible :3270 desktop dev operator (SIGUSR2 bounded drain + no-native-teardown hard exit; success waits for a verified wrapper respawn)',
  },
};

/**
 * Per-target cooldown window (EI-10896). Only targets with a cooldownResource
 * coalesce. Windows are per-target, NOT global (EI-13307) — bg-host's is
 * ~13min (its real rejoin cost), everyone else's is the generic ~2min.
 */
const COOLDOWN_SEC: Partial<Record<RestartTarget, number>> = {
  staging: STAGING_COOLDOWN_SEC,
  gateway: GATEWAY_COOLDOWN_SEC,
  'bg-host': BG_HOST_COOLDOWN_SEC,
  'embed-sidecar': GATEWAY_COOLDOWN_SEC,
  'mcp-proxy': GATEWAY_COOLDOWN_SEC,
};

/**
 * Targets that restart network-capable processes directly from Papercusp's
 * integration checkout. `dev` is intentionally absent: its WorkingDirectory
 * is the green release checkout even though its unit exports the integration
 * root for other purposes. The app sidecars use their own repositories, and
 * `desktop-dev` is a wrapper-owned packaged runtime.
 */
const INTEGRATION_TREE_RESTART_TARGETS: ReadonlySet<RestartTarget> = new Set([
  'staging',
  'gateway',
  'bg-host',
  'embed-sidecar',
  'mcp-proxy',
  'mcp-proxy-staging',
]);

type RestartRestrictedHoldCheck = {
  checked: boolean;
  roots: string[];
  refusal: RestrictedHoldRefusal | null;
};

function restrictedHoldRootsForRestart(target: RestartTarget, workingDirectory: string): string[] | null {
  if (!INTEGRATION_TREE_RESTART_TARGETS.has(target)) return null;
  const normalized = workingDirectory.trim();
  if (!normalized || normalized === '[not set]') return [];

  // Most integration services run with <checkout>/apps/operator as their
  // WorkingDirectory. The inference gateway runs from <checkout> itself; feed
  // the same authoritative unit root through the shared helper in either case.
  const resolved = resolve(normalized);
  const operatorWorkingDirectory = /(?:^|[\\/])apps[\\/]operator$/.test(resolved)
    ? resolved
    : resolve(resolved, 'apps', 'operator');
  return integrationTreeRoots({}, operatorWorkingDirectory);
}

async function checkRestrictedHoldBeforeRestart(
  target: RestartTarget,
  workingDirectory: string,
  unit: string,
): Promise<RestartRestrictedHoldCheck | null> {
  const roots = restrictedHoldRootsForRestart(target, workingDirectory);
  if (roots === null) return null;
  if (roots.length === 0) {
    return {
      checked: false,
      roots,
      refusal: {
        error: 'restricted_hold_state_unknown',
        hint: `could not determine ${unit} WorkingDirectory; a confirmed restart was refused because restricted-write holds could not be checked`,
      },
    };
  }
  return { checked: true, roots, refusal: await restrictedTreeHoldRefusal(roots) };
}

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const holderJson = (h: ResourceHolder) => ({
  owner: h.owner,
  owner_label: h.owner_label,
  mode: h.mode,
  status: h.status,
});

export type GatewayRestartReadiness = {
  ready: boolean;
  pidChanged: boolean;
  observedPid: number | null;
  listener: GatewayListenerReadiness | null;
  health: HttpProbeResult | null;
  waitedMs: number;
};

export type GatewayListenerReadiness = {
  port: number;
  checked: boolean;
  ownedByPid: boolean;
  ownerVisible: boolean;
  observedPids: number[];
  detail: string;
};

export type StagingRestartReadiness = {
  ready: boolean;
  observed: boolean;
  outcome: 'ready' | 'starting' | 'failed' | 'not-observed';
  pidChanged: boolean;
  observedPid: number | null;
  activeState: string | null;
  result: string | null;
  listener: GatewayListenerReadiness | null;
  waitedMs: number;
};

export type BgHostRestartReadiness = {
  ready: boolean;
  observed: boolean;
  outcome: 'ready' | 'starting' | 'failed' | 'not-observed';
  pidChanged: boolean;
  observedPid: number | null;
  activeState: string | null;
  result: string | null;
  waitedMs: number;
};

const gatewayPort = () => Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788;
const gatewayHealthUrl = () => `http://127.0.0.1:${gatewayPort()}/healthz`;

function isLiveMainPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Observe the bg-host systemd transition after dev:restart schedules it.
 * A command launch or an accepted systemd job is not completion: success
 * requires a known pre-request state, a changed live MainPID, and ActiveState
 * back at active. Keep the changed PID sticky while systemd finishes starting.
 */
export async function waitForBgHostRestartReadiness(
  before: ServiceStartInfo,
): Promise<BgHostRestartReadiness> {
  const startedAt = Date.now();
  const deadline = startedAt + BG_HOST_RESTART_OBSERVE_MS;
  const baselineKnown = before.ok && typeof before.mainPid === 'number';
  let current: ServiceStartInfo | null = null;
  let changedPid: number | null = null;
  let observed = false;

  while (Date.now() <= deadline) {
    try {
      current = await probeServiceStart(RESTART_TARGET_UNITS['bg-host']);
    } catch {
      current = null;
    }
    const currentPid = current?.mainPid;
    if (
      baselineKnown &&
      isLiveMainPid(currentPid) &&
      (!isLiveMainPid(before.mainPid) || currentPid !== before.mainPid)
    ) {
      changedPid = currentPid;
      observed = true;
    }
    if (current?.activeState === 'activating' && before.ok && before.activeState !== 'activating') {
      observed = true;
    }
    if (current?.activeState === 'failed') {
      return {
        ready: false,
        observed,
        outcome: 'failed',
        pidChanged: changedPid !== null,
        observedPid: changedPid,
        activeState: current.activeState,
        result: current.result ?? null,
        waitedMs: Date.now() - startedAt,
      };
    }
    if (changedPid !== null && currentPid === changedPid && current?.activeState === 'active') {
      return {
        ready: true,
        observed: true,
        outcome: 'ready',
        pidChanged: true,
        observedPid: changedPid,
        activeState: current.activeState,
        result: current.result ?? null,
        waitedMs: Date.now() - startedAt,
      };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(BG_HOST_RESTART_POLL_MS, remainingMs)));
  }

  return {
    ready: false,
    observed,
    outcome: observed ? 'starting' : 'not-observed',
    pidChanged: changedPid !== null,
    observedPid: changedPid,
    activeState: current?.activeState ?? null,
    result: current?.result ?? null,
    waitedMs: Date.now() - startedAt,
  };
}

export type BgHostRestartReadinessReader = (before: ServiceStartInfo) => Promise<BgHostRestartReadiness>;
const defaultBgHostRestartReadinessReader: BgHostRestartReadinessReader = waitForBgHostRestartReadiness;
let bgHostRestartReadinessReader = defaultBgHostRestartReadinessReader;

/** Test seam: confirmed bg-host restart tests must not wait on or inspect systemd. */
export function configureBgHostRestartReadinessReaderForTests(
  reader: BgHostRestartReadinessReader = defaultBgHostRestartReadinessReader,
): void {
  bgHostRestartReadinessReader = reader;
}

/**
 * Prove that the new systemd service owns the gateway's TCP listener before
 * probing HTTP. A reachable /healthz endpoint is not enough: an orphaned
 * process can keep :8788 alive while the replacement exits with EADDRINUSE.
 *
 * The listen-table helper distinguishes "bound but owner hidden" from "not
 * bound". Both are fail-closed here because neither proves that this service
 * owns the port. Gateway launch wrappers may spawn the actual listener as a child.
 */
export function gatewayListenerBelongsToService(
  mainPid: number,
  listenerPid: number,
  readCgroup: (pid: number) => string | null = readProcessCgroupPath,
): boolean {
  if (listenerPid === mainPid) return true;
  const serviceCgroup = readCgroup(mainPid);
  const listenerCgroup = readCgroup(listenerPid);
  if (!serviceCgroup || serviceCgroup === '/' || !listenerCgroup) return false;
  return listenerCgroup === serviceCgroup || listenerCgroup.startsWith(`${serviceCgroup}/`);
}

async function probeGatewayListenerOwnership(pid: number): Promise<GatewayListenerReadiness> {
  const port = gatewayPort();
  try {
    const result = await listListeningSockets({ port, limit: 32 });
    const sockets = result.sockets;
    const observedPids = [
      ...new Set(
        sockets.flatMap((socket) => (socket.pids.length > 0 ? socket.pids : socket.pid == null ? [] : [socket.pid])),
      ),
    ];
    const ownerVisible = sockets.some((socket) => socket.ownerVisible);
    const ownedByPid = sockets.some((socket) =>
      socket.ownerVisible &&
      (socket.pids.length > 0 ? socket.pids : socket.pid == null ? [] : [socket.pid]).some((listenerPid) =>
        gatewayListenerBelongsToService(pid, listenerPid),
      ),
    );

    let detail: string;
    if (ownedByPid) {
      detail = `listener on :${port} belongs to new MainPID ${pid}'s service cgroup`;
    } else if (sockets.length === 0) {
      detail = `no listener was observed on :${port}`;
    } else if (!ownerVisible) {
      detail = `:${port} is listening, but its owning PID is not visible to this process`;
    } else {
      detail = `:${port} is owned by PID(s) ${observedPids.join(', ') || 'unknown'}, outside new MainPID ${pid}'s service cgroup`;
    }

    return {
      port,
      checked: true,
      ownedByPid,
      ownerVisible,
      observedPids,
      detail,
    };
  } catch (error) {
    return {
      port,
      checked: true,
      ownedByPid: false,
      ownerVisible: false,
      observedPids: [],
      detail: `could not verify ownership of :${port}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function probeStagingListenerOwnership(pid: number): Promise<GatewayListenerReadiness> {
  const port = RESTART_TARGET_PORTS.staging!;
  try {
    const result = await listListeningSockets({ port, limit: 32 });
    const sockets = result.sockets;
    const observedPids = [
      ...new Set(
        sockets.flatMap((socket) => (socket.pids.length > 0 ? socket.pids : socket.pid == null ? [] : [socket.pid])),
      ),
    ];
    const ownerVisible = sockets.some((socket) => socket.ownerVisible);
    const ownedByPid = sockets.some(
      (socket) => socket.ownerVisible && (socket.pids.includes(pid) || socket.pid === pid),
    );
    return {
      port,
      checked: true,
      ownedByPid,
      ownerVisible,
      observedPids,
      detail: ownedByPid
        ? `listener on :${port} is owned by new MainPID ${pid}`
        : sockets.length === 0
          ? `no listener was observed on :${port}`
          : !ownerVisible
            ? `:${port} is listening, but its owning PID is not visible to this process`
            : `:${port} is owned by PID(s) ${observedPids.join(', ') || 'unknown'}, not new MainPID ${pid}`,
    };
  } catch (error) {
    return {
      port,
      checked: true,
      ownedByPid: false,
      ownerVisible: false,
      observedPids: [],
      detail: `could not verify ownership of :${port}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Observe the detached staging restart itself, not merely the fact that a shell
 * was spawned. A fresh MainPID owning :3170 is ready; an `activating` state is
 * an observed-but-still-starting execution; a unit that stays failed/unseen for
 * the bounded window is a failed restart and must not be reported as success.
 */
export async function waitForStagingRestartReadiness(before: ServiceStartInfo): Promise<StagingRestartReadiness> {
  const startedAt = Date.now();
  const deadline = startedAt + STAGING_RESTART_OBSERVE_MS;
  const previousPidKnown = isLiveMainPid(before.mainPid);
  let current: ServiceStartInfo | null = null;
  let listener: GatewayListenerReadiness | null = null;

  while (Date.now() <= deadline) {
    try {
      current = await probeServiceStart(RESTART_TARGET_UNITS.staging);
    } catch {
      current = null;
    }
    const currentPid = current?.mainPid;
    const pidChanged = isLiveMainPid(currentPid) && (!previousPidKnown || currentPid !== before.mainPid);
    if (pidChanged) {
      listener = await probeStagingListenerOwnership(currentPid);
      if (listener.ownedByPid) {
        return {
          ready: true,
          observed: true,
          outcome: 'ready',
          pidChanged: true,
          observedPid: currentPid,
          activeState: current?.activeState ?? null,
          result: current?.result ?? null,
          listener,
          waitedMs: Date.now() - startedAt,
        };
      }
      return {
        ready: false,
        observed: true,
        outcome: 'starting',
        pidChanged: true,
        observedPid: currentPid,
        activeState: current?.activeState ?? null,
        result: current?.result ?? null,
        listener,
        waitedMs: Date.now() - startedAt,
      };
    }
    if (current?.activeState === 'activating' && before.activeState !== 'activating') {
      return {
        ready: false,
        observed: true,
        outcome: 'starting',
        pidChanged: false,
        observedPid: null,
        activeState: 'activating',
        result: current.result ?? null,
        listener: null,
        waitedMs: Date.now() - startedAt,
      };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(STAGING_RESTART_POLL_MS, remainingMs)));
  }

  const failed = current?.activeState === 'failed';
  return {
    ready: false,
    observed: false,
    outcome: failed ? 'failed' : 'not-observed',
    pidChanged: false,
    observedPid: isLiveMainPid(current?.mainPid) ? current.mainPid : null,
    activeState: current?.activeState ?? null,
    result: current?.result ?? null,
    listener,
    waitedMs: Date.now() - startedAt,
  };
}

export type StagingRestartReadinessReader = (before: ServiceStartInfo) => Promise<StagingRestartReadiness>;
const defaultStagingRestartReadinessReader: StagingRestartReadinessReader = waitForStagingRestartReadiness;
let stagingRestartReadinessReader = defaultStagingRestartReadinessReader;

/** Test seam: confirmed restart tests must never wait on or inspect real systemd. */
export function configureStagingRestartReadinessReaderForTests(
  reader: StagingRestartReadinessReader = defaultStagingRestartReadinessReader,
): void {
  stagingRestartReadinessReader = reader;
}

/**
 * Wait until the detached gateway restart has produced a new live process, then
 * prove that the process actually owns its HTTP listener. MainPID and /healthz
 * are deliberately separate phases: probing healthz before the PID transition
 * could succeed against the OLD gateway and recreate the original false-green.
 *
 * The service probe is fail-soft in production, but keep the wait fail-soft
 * around injectable/test implementations too. A readiness failure is returned
 * as data so the caller can report "scheduled but not ready" without claiming
 * `restarted:true`.
 *
 * WI-10005747 (EI-24792459933326276): a new MainPID is only process-START evidence —
 * the gateway binds :8788 and answers /healthz moments later. The wait used to probe
 * the listener ONCE at the instant the PID changed and return `ready:false` on the
 * first miss (and on one failed /healthz), reporting a false negative for a restart
 * that succeeded seconds later. The listener + health phases now keep polling to the
 * SAME deadline as the PID phase; `ready:false` means the budget was spent, not that
 * the first look was early.
 */
export type GatewayReadinessDeps = {
  readService: () => Promise<{ mainPid?: number | null } | null | undefined>;
  probeListener: (pid: number) => Promise<GatewayListenerReadiness>;
  probeHealth: () => Promise<HttpProbeResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waitMs: number;
  pollMs: number;
};

function defaultGatewayReadinessDeps(): GatewayReadinessDeps {
  return {
    readService: async () => {
      try {
        return await probeServiceStart(RESTART_TARGET_UNITS.gateway);
      } catch {
        return null;
      }
    },
    probeListener: probeGatewayListenerOwnership,
    probeHealth: async () => {
      try {
        return await probeHttpReachable(gatewayHealthUrl());
      } catch (error) {
        return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    waitMs: GATEWAY_RESTART_PID_WAIT_MS,
    pollMs: GATEWAY_RESTART_PID_POLL_MS,
  };
}

export async function waitForGatewayRestartReadiness(
  beforePid: number | null,
  overrides: Partial<GatewayReadinessDeps> = {},
): Promise<GatewayRestartReadiness> {
  const deps = { ...defaultGatewayReadinessDeps(), ...overrides };
  const startedAt = deps.now();
  const deadline = startedAt + deps.waitMs;
  const previousPidKnown = isLiveMainPid(beforePid);
  let lastLivePid: number | null = null;
  // The replacement PID, once seen, is sticky: a later service read that comes back empty
  // (fail-soft probe) must not make us forget that the restart already cycled the process.
  let changedPid: number | null = null;
  let listener: GatewayListenerReadiness | null = null;
  let health: HttpProbeResult | null = null;

  while (deps.now() <= deadline) {
    const current = await deps.readService();
    const currentPid = current?.mainPid;
    if (isLiveMainPid(currentPid)) {
      lastLivePid = currentPid;
      if (!previousPidKnown || currentPid !== beforePid) changedPid = currentPid;
    }

    if (changedPid !== null) {
      listener = await deps.probeListener(changedPid);
      if (listener.ownedByPid) {
        health = await deps.probeHealth();
        if (health.reachable) {
          return {
            ready: true,
            pidChanged: true,
            observedPid: changedPid,
            listener,
            health,
            waitedMs: deps.now() - startedAt,
          };
        }
      } else {
        health = null;
      }
    }

    const remainingMs = deadline - deps.now();
    if (remainingMs <= 0) break;
    await deps.sleep(Math.min(deps.pollMs, remainingMs));
  }

  return {
    ready: false,
    pidChanged: changedPid !== null,
    observedPid: changedPid ?? lastLivePid,
    listener,
    health,
    waitedMs: deps.now() - startedAt,
  };
}

/**
 * EI-18198340374286980: this tool's own description has always claimed
 * "coordinated (drain + coalesce + audit)" but never actually wrote an
 * `audit_log` row for a real restart — only the resource-lock holder state
 * (ephemeral) and systemd's own logs recorded that it happened. Fire-and-forget,
 * never throws (mirrors process-kill.ts / flag-audit.ts's canonical
 * full-column shape) — the restart itself must never be blocked on this.
 */
  async function writeRestartAudit(
  actor: string,
  details: {
    target: RestartTarget;
    unit: string;
    viaEnv: boolean;
    viaAuthorizeArg: boolean;
    reason: string | null;
    fenceSeq: number;
    phantomCoalesceBroken: boolean;
    /** EI-19385475092979200: what the gate was doing when this restart fired, and
     *  whether the collision guard was deliberately overridden. Recorded so a later
     *  gate red can be ATTRIBUTED to this restart instead of read as a regression. */
    gateCollision?: { kind: string; overridden: boolean; runElapsedSec: number | null } | null;
    /** WI-222053: a real restart that deliberately crossed an in-flight git-sync
     *  operation is attributable from the durable audit row. */
    gitSyncCollision?: { kind: string; overridden: boolean; resources: string[]; pids: number[] } | null;
    /** target:staging: what papercup-staging-sync's checkout lock read when this
     *  restart fired (the final pre-signal re-check wins over the first read). */
    stagingSyncCollision?: { kind: string; lockPath: string; lockHeld: boolean | null } | null;
    /** The shared lock acquired by the detached command after the final probe. */
    stagingSyncHandoff?: { lockPath: string; mode: 'shared'; heldThrough: 'systemctl-restart' } | null;
    /** The atomic legacy-resource barrier intentionally left to expire after
     *  systemctl has crossed the delayed handoff. */
    gitSyncBarrier?: { resource: string; expiresAt: string } | null;
    /** The user manager consumed current unit/drop-in bytes before restart. */
    systemdDaemonReloaded: boolean;
    /** A recent bg-host Environment= drop-in caused a cooldown bypass. */
    unitEnvironmentDropInChange?: { paths: string[]; mainPidStartedAtMs: number } | null;
    /** WI-2140796: a real restart that deliberately crossed an active bg-host
     *  quiesce (override_quiesce:true) is attributable from the durable audit row. */
    quiesceOverridden?: { marker: QuiesceMarker | null } | null;
    /** A paired bg-host request/outcome audit record shares this correlation id. */
    requestId?: string;
    phase?: 'request' | 'outcome';
    beforeMainPid?: number | null;
    restartCommand?: string;
    restartLauncherPid?: number | null;
    restartCommandExitCode?: number | null;
    restartCommandSignal?: string | null;
    restartCommandError?: string | null;
    systemdJobAccepted?: boolean;
    restartObserved?: boolean;
    restarted?: boolean;
    observedMainPid?: number | null;
    observedActiveState?: string | null;
    observedResult?: string | null;
    observationWaitedMs?: number;
  },
): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const id = `restart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, 'dev:restart', details.target, JSON.stringify(details), activeWorkspaceId()],
    );
    return true;
  } catch (err) {
    // Best-effort: the audit write must never block/fail the restart operation.

    console.warn('[dev:restart] audit write failed:', (err as Error)?.message);
    return false;
  }
}

/**
 * EI-21930094737784126: the ONE predicate for "does the cgroup preflight BLOCK this
 * call", read by BOTH the dry-run preview and the confirmed path.
 *
 * It is a single function on purpose. The preview is where an agent decides whether
 * to fire at all, so a preview that predicts a refusal the confirmed call would not
 * make DETERS the correct action — the mirror image of EI-21365722353248238, where a
 * preview promised a restart the confirmed call then refused. Two copies of
 * `blocked && drain === 0` would drift in exactly that direction, silently.
 */
function gitSyncPreflightBlocks(blocked: boolean, drainSec: number): boolean {
  return blocked && drainSec === 0;
}

export default defineTool({
  name: 'dev:restart',
  description:
    'Coordinated restart with drain/coalesce/audit. Targets: "dev" :3070 (default), "staging" :3170, "desktop-dev" :3270, "gateway" :8788, "bg-host" routines/git-sync, "embed-sidecar" :3384, "mcp-proxy" :9071, "mcp-proxy-staging" :9171→:3170, "email-sidecar", "calendar-sidecar". Dry-run unless confirm:true; restart needs PAPERCUSP_ALLOW_DEV_RESTART=1 or audited authorize:true. Cooldown ~2m; bg-host ~13m.',
  guidance: {
    when: 'Load integration-tree edits into long-running hosts (no deploy). desktop-dev recycles the wrapper-owned :3270 listener and waits for a new one. Route desktop→"desktop-dev"; inference-gateway→"gateway"; routines/git-sync→"bg-host"; embeddings→"embed-sidecar"; MCP proxy/transport→"mcp-proxy" (:9071) or "mcp-proxy-staging" (:9171→:3170); shared server→"staging" (probe :3170).',
    notWhen:
      'Probe: service_health. desktop-dev: :3270 only. Gateway restart drops fleet LLM calls. bg-host kills cgroup (spawner, sidecars, pg_dump); drain cannot reach children. No raw systemctl (skips drain/debounce). dev/bg-host refuse git-sync; staging refuses the staging-sync exclusive lock. override_git_sync_collision:true only if wedged. gateway/bg-host/embed-sidecar refuse green-checkpoint; override_gate_collision:true only if blocked.',
    chaining:
      'dry → review holders → { confirm:true, authorize:true, reason:"<why>", target } → restart (or coalesced:true; probe directly). Gateway: status → restart → status.',
    seeAlso: [
      'dev:service_health (check what is down first)',
      'gateway:status (in-flight/admission state — read BEFORE and AFTER a gateway restart)',
      'dev:pipeline_position (is my edit live? — tells you whether a restart or a deploy is what you need)',
      'dev:processes (see the running processes)',
    ],
  },
  capability: 'locks:write',
  timeoutSec: MAX_DRAIN_SEC + 30,
  requirePrincipal: false,
  // EI-18803497769946984: this handler drains, then shells out to systemctl, and never
  // reads ctx.tx — and its own timeoutSec is already well past Postgres's
  // idle_in_transaction_session_timeout (60s), so holding the ambient workspace tx
  // across the wait guarantees the backend is killed and the call fails as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    confirm: z.boolean().optional(),
    max_drain_sec: z.number().int().nonnegative().max(MAX_DRAIN_SEC).optional(),
    target: z
      .enum([
        'dev',
        'staging',
        'gateway',
        'bg-host',
        'embed-sidecar',
        'mcp-proxy',
        'mcp-proxy-staging',
        'email-sidecar',
        'calendar-sidecar',
        'desktop-dev',
      ])
      .optional(),
    /** EI-18198340374286980: in-band alternative to the operator-process-env
     *  PAPERCUSP_ALLOW_DEV_RESTART=1 gate, which an agent cannot set for a
     *  server it did not itself spawn. Only takes effect with confirm:true —
     *  confirm+drain is the deliberate-action gate; this only lifts the env
     *  backstop. Every real restart it enables is written to audit_log. */
    authorize: z.boolean().optional(),
    /** EI-19385475092979200: proceed even though a green-checkpoint run is in
     *  flight (or is about to fire). A gate-sensitive restart is SOFT-blocked,
     *  not hard-blocked — a genuinely wedged sidecar mid-run must still be
     *  restartable — but the override has to be deliberate and stated. */
    override_gate_collision: z
      .boolean()
      .optional()
      .describe(
        'Restart a gate-sensitive target (embed-sidecar/gateway/bg-host) even though a green-checkpoint run is in flight or imminent. Rarely needed: a run in its own transient unit is cgroup-isolated and SURVIVES a restart, so the check reports would_block:false. Pass only when it blocks.',
      ),
    /** WI-222053: a restart can kill the very git-sync commit whose absence
     *  prompted the restart. Keep the escape hatch explicit + audited so a
     *  genuinely wedged operation remains recoverable without making the
     *  feedback loop the default. */
    override_git_sync_collision: z
      .boolean()
      .optional()
      .describe(
        'Restart dev/staging/bg-host even though a live git-sync lock holder is inside that target systemd cgroup. This kills and abandons the commit; pass only when the host itself is wedged and record why.',
      ),
    /**
     * EI-21930094737784126: WAIT for git-sync to drain instead of bouncing off it.
     *
     * Without this, `dev:restart` refuses on the CGROUP PREFLIGHT — "is a git-sync
     * process inside this unit?" — which on bg-host is ~always true, because the
     * git-sync worker IS the host process. Measured 2026-08-31: 20 consecutive
     * confirm:true attempts, 20/20 refused, colliding-resource floor never below 4.
     * The remediation the stale-executor page names was effectively unfireable, and
     * an open page sat unacted for 2h46m as a direct result.
     *
     * The authoritative signal is the `git-sync` barrier LOCK, not the cgroup: fires
     * hold it ~5-10s in bursts, and it measured FREE in 20 of 40 sampled seconds. So
     * with a drain budget the preflight becomes ADVISORY and the barrier arbitrates —
     * and because a draining exclusive refuses NEW shared acquires, the wait actually
     * converges instead of racing the sweep.
     *
     * Omitted/0 keeps today's fast-fail behaviour byte-for-byte.
     */
    git_sync_drain_sec: z
      .number()
      .int()
      .min(0)
      .max(GIT_SYNC_RESTART_BARRIER_DRAIN_SEC)
      .optional()
      .describe(
        "Seconds to WAIT for in-flight git-sync operations to drain instead of refusing immediately. Use this rather than override_git_sync_collision on a merely BUSY host: git-sync fires hold the barrier only ~5-10s, so a short drain usually succeeds where a one-shot attempt always fails. 0/omitted = today's immediate refusal.",
      ),
    /** EI-18661647550414959: restart a target whose tree cannot boot. Only pass when
     *  the restart is itself the remedy — otherwise this hands you the crash-loop the
     *  preflight just predicted. */
    override_boot_integrity: z
      .boolean()
      .optional()
      .describe(
        "Restart even though the target's tree is missing packages it needs to boot. Only when the restart IS the remedy — otherwise it crash-loops the host.",
      ),
    /** WI-2140796: proceed even though bg-host is deliberately quiesced (systemd
     *  masked + a marker at $XDG_RUNTIME_DIR/papercusp-seed-cut.quiesce, written by
     *  cut-seed-quiesced.sh for a P-101 seed cut). Only pass once you have confirmed
     *  with the holder named in the refusal that un-quiescing it now is safe. */
    override_quiesce: z
      .boolean()
      .optional()
      .describe(
        'Restart bg-host even though it is quiesced (masked unit + seed-cut marker). Confirm with the holder first — this can un-quiesce an in-flight seed cut.',
      ),
    /** Short free-text reason, recorded on the audit_log row when a real
     *  restart fires (either enablement route). Optional but encouraged when
     *  using `authorize` in place of the env gate. */
    reason: z
      .string()
      .max(300)
      .optional()
      .describe(
        'Short free-text reason (MAX 300 chars — keep it to one line; a longer diagnosis belongs on the work-item) recorded on the audit_log row. Expected whenever you pass authorize:true.',
      ),
  }),
  async handler(args, ctx) {
    const target: RestartTarget = args.target ?? 'dev';
    const cfg = RESTART_TARGETS[target];
    // ⚠ This IS a raw `systemctl --user restart` — the coordination this tool adds
    // (drain + coalesce + audit + cooldown) is real, but it is ALL lock-shaped: the
    // drain acquires exclusive(<target>-server), i.e. it drains AGENTS USING the
    // resource. It has no notion of the unit's CGROUP CHILDREN, and KillMode is
    // control-group, so the blast radius here is IDENTICAL to the raw command the
    // docs tell agents to use this instead of. Measured 2026-08-04 on bg-host
    // (EI-19479764372783341): TasksCurrent=208 — 5x desktop sidecar/serve.mjs,
    // 4x spawner-sidecar.ts, any in-flight pg_dump, all killed with the unit.
    // Root cause is on the SPAWN side, not here: managedSpawn confines via
    // `systemd-run --user --scope` (a SIBLING transient unit, survives a restart),
    // but fleet/spawner-sidecar-spawn.ts:194 uses a raw spawn(…,{detached:false})
    // and inherits this cgroup. Do NOT "fix" this by widening the drain — a lock
    // drain cannot reach a child process. Fix the spawn site.
    const restartCmd =
      target === 'desktop-dev'
        ? 'SIGUSR2 recycle verified desktop-dev listener on :3270 (wait for verified wrapper respawn)'
        : target === 'bg-host'
          ? `systemctl --user --no-block restart ${cfg.unit}`
        : `systemctl --user restart ${cfg.unit}`;
    const activationCmd = target === 'desktop-dev' ? restartCmd : `systemctl --user daemon-reload && ${restartCmd}`;
    // EI-13307: per-target, not global — computed up front so both the
    // dry-run note and the real debounce path below quote the SAME window.
    const cooldownSec = COOLDOWN_SEC[target] ?? STAGING_COOLDOWN_SEC;

    // EI-21930094737784126: hoisted ABOVE the dry-run branch deliberately. The drain
    // budget changes what the confirmed call would DO, so a preview that cannot see it
    // cannot answer the only question a preview is asked (see gitSyncPreflightBlocks).
    const gitSyncDrainSec = Math.max(0, Math.trunc(args.git_sync_drain_sec ?? 0));
    // The target set is the single source of truth for whether this restart can
    // affect git-sync. In particular, staging (:3170) is not a git-sync host and
    // must not even enter the workspace-wide barrier path.
    const gitSyncSensitive = isGitSyncSensitiveTarget(target);

    // Dry run — ctx-free, takes no lock, drains nobody.
    if (!args.confirm) {
      if (target === 'desktop-dev') {
        // EI-21365722353248238: use the exact same read-only identity resolver
        // as the confirmed path. The old preview emitted a hard-coded
        // "verified" command without checking the listener, so a preview could
        // promise a restart that the immediately-following confirmed call would
        // refuse as desktop_dev_identity_mismatch.
        const listenerPreview = await resolveDesktopDevListener();
        return json({
          ok: true,
          dry_run: true,
          target,
          would_run: listenerPreview.ok ? activationCmd : null,
          listener_identity: {
            checked: true,
            verified: listenerPreview.ok,
            would_block: !listenerPreview.ok,
            ...(listenerPreview.pid === undefined ? {} : { pid: listenerPreview.pid }),
            ...(listenerPreview.reason ? { reason: listenerPreview.reason } : {}),
            note: listenerPreview.note,
          },
          note: `${listenerPreview.ok ? 'Read-only check verified' : 'Read-only check would refuse before draining/signaling'} the owner-visible :3270 listener. Pass confirm:true to acquire exclusive(desktop-dev-server), drain current users, and — only when the identity check passes — ask that child for a SIGUSR2 bounded drain followed by a no-native-teardown hard exit. Success is returned only after a different wrapper-supervised listener is verified; unrelated processes are never signaled. confirm:true alone is not enough — pass authorize:true + a short reason, or set PAPERCUSP_ALLOW_DEV_RESTART=1.`,
        });
      }
      const cooldownNote = cfg.cooldownResource
        ? ` If a peer restarted this target within the last ~${Math.round(cooldownSec / 60)}min, the restart is coalesced (skipped) instead of re-run.${
            target === 'bg-host'
              ? " bg-host's window is wider than the others: a restart freezes the cross-machine peer-log rails for ~13min while the substrate rejoins (EI-13307/EI-13317), so a fresh restart mid-rejoin would just restart the outage."
              : ''
          }`
        : '';
      // EI-19385475092979200: report the gate-collision state in the PREVIEW too. A dry run is
      // where an agent decides whether to act now or wait, so telling it "the gate fires in 40s"
      // here is what prevents the confirm call from being made at all — strictly better than
      // refusing that call afterwards. Read-only; never blocks the dry run.
      const preview = await checkGateCollision(target, args.override_gate_collision === true);
      const gitSyncPreview = gitSyncSensitive
        ? await checkGitSyncCollision(target, args.override_git_sync_collision === true)
        : null;
      const stagingSyncPreview =
        target === 'staging' ? await checkStagingSyncCollision(target) : null;
      // EI-18661647550414959: same reasoning as the gate-collision preview above — the dry
      // run is where the decision is actually made, so "this tree cannot boot" belongs HERE,
      // where it costs nothing, not only in the refusal afterwards.
      const bootPreview = await preflightRestartTarget(target);
      const restrictedHoldPreview = await checkRestrictedHoldBeforeRestart(
        target,
        bootPreview.requestedRoot,
        bootPreview.unit,
      );
      // WI-2140796: same reasoning again — a quiesced bg-host is worth knowing about
      // BEFORE the confirmed call, not only in its refusal.
      const quiescePreview = isQuiesceSensitiveTarget(target)
        ? await checkBgHostQuiesce(target, args.override_quiesce === true)
        : null;
      return json({
        ok: true,
        dry_run: true,
        target,
        would_run: activationCmd,
        boot_integrity: {
          checked: bootPreview.checked,
          would_block: !bootPreview.ok,
          tree: bootPreview.lockRoot,
          ...(bootPreview.missing.length ? { missing: bootPreview.missing } : {}),
          ...(bootPreview.reason ? { reason: bootPreview.reason } : {}),
        },
        ...(restrictedHoldPreview
          ? {
              restricted_hold: {
                checked: restrictedHoldPreview.checked,
                roots: restrictedHoldPreview.roots,
                would_block: restrictedHoldPreview.refusal !== null,
                ...(restrictedHoldPreview.refusal ?? {}),
              },
            }
          : {}),
        ...(quiescePreview
          ? {
              quiesce: {
                checked: !quiescePreview.probeFailed,
                would_block: quiescePreview.blocked,
                quiesced: quiescePreview.quiesced,
                ...(quiescePreview.marker ? { marker: quiescePreview.marker } : {}),
              },
            }
          : {}),
        ...(isGateSensitiveTarget(target)
          ? { gate_collision: { kind: preview.kind, would_block: preview.blocked, ...preview.detail } }
          : {}),
        ...(gitSyncPreview
          ? {
              git_sync_collision: {
                kind: gitSyncPreview.kind,
                // EI-21930094737784126: answer for the call the caller is ACTUALLY
                // about to make, drain budget included — not for a hypothetical one
                // with no budget. Same predicate as the confirmed path below.
                would_block: gitSyncPreflightBlocks(gitSyncPreview.blocked, gitSyncDrainSec),
                ...(gitSyncPreview.blocked && gitSyncDrainSec > 0
                  ? { preflight_advisory: true, drain_sec: gitSyncDrainSec }
                  : {}),
                ...gitSyncPreview.detail,
              },
            }
          : {}),
        ...(stagingSyncPreview
          ? {
              staging_sync_collision: {
                kind: stagingSyncPreview.kind,
                would_block: stagingSyncPreview.blocked,
                ...stagingSyncPreview.detail,
              },
            }
          : {}),
        note: `Pass confirm:true to acquire exclusive(${cfg.resource}), drain current users, then restart. DISRUPTS all agents.${cooldownNote} confirm:true ALONE is not enough — the real restart also needs the enablement gate: pass authorize:true + a short \`reason\` (≤300 chars) in the same call, or set PAPERCUSP_ALLOW_DEV_RESTART=1 on the operator process. Without it the call is REFUSED outright (ok:false, nothing drained).${
          gitSyncPreview?.blocked
            ? gitSyncDrainSec > 0
              ? ` ℹ A git-sync operation shares this cgroup, but you passed git_sync_drain_sec:${gitSyncDrainSec} — on that path the cgroup preflight is ADVISORY and the workspace-wide \`git-sync\` barrier arbitrates instead (fires hold it only ~5-10s). This preview reserves nothing; the confirmed call can still refuse with drain_timeout, which is transient and side-effect-free — retry rather than abandon.`
              : ` ⚠ ${gitSyncPreview.note} On a merely BUSY host the supported way through is git_sync_drain_sec (up to ${GIT_SYNC_RESTART_BARRIER_DRAIN_SEC}s) — WAIT for the drain. override_git_sync_collision is for a WEDGED host: it SIGKILLs an in-flight commit and strands a peer's uncommitted work.`
            : ''
        }${stagingSyncPreview?.blocked ? ` ⚠ ${stagingSyncPreview.note}` : ''}${preview.blocked ? ` ⚠ ${preview.note}` : ''}${quiescePreview?.blocked ? ` ⚠ ${quiescePreview.note}` : ''}`,
      });
    }

    const { ownerId, ownerLabel, coordinationDomain: callerDomain } = readIdentity(ctx);
    // EI-18676514870990022: cfg.resource ('dev-server' for the "dev" target)
    // is HOST-GLOBAL — it names the one shared :3070 operator, not a physical
    // file tree — so it must resolve to hostGlobalLockDomain() regardless of
    // which checkout this call happened to load from, exactly like
    // 'release-deploy' (EI-18674647773291145 Defect 2). Every other current
    // target (staging/gateway/bg-host/embed-sidecar) is NOT in
    // HOST_GLOBAL_RESOURCES yet, so this is a no-op for them — falls straight
    // through to the same callerDomain as before.
    const coordinationDomain = resourceLockDomain(cfg.resource);
    const coordIdentity = resolveAgentIdentity(ctx);
    const enabledByEnv = process.env.PAPERCUSP_ALLOW_DEV_RESTART === '1';
    // EI-18198340374286980: an agent cannot set PAPERCUSP_ALLOW_DEV_RESTART on
    // the already-running operator process (no per-call env injection, and
    // restarting the operator to add it is circular) — `authorize:true` is the
    // in-band equivalent, gated the same way (capability + confirm + drain)
    // and, unlike the raw-systemctl bypass it replaces, always audited below.
    const enabledByArg = args.authorize === true;
    const enabled = enabledByEnv || enabledByArg;

    // EI-18643120769203916: refuse BEFORE any side effect. This check used to
    // live INSIDE guardResource, so a call without the enablement gate acquired
    // exclusive(<resource>), DRAINED every current user, and then reported
    // `ok:true, drained:true, restarted:false`. Two defects in one:
    //   1. It half-executed — the target was left QUIESCED and still running
    //      old code, an end state strictly worse than either doing nothing or
    //      restarting.
    //   2. `ok:true` reads as success. An agent that fires the documented call
    //      and checks `ok` concludes the restart landed. That is the likeliest
    //      driver of EI-18642482762875484 (six workers re-learned the bg-host
    //      stale-runtime lesson over ~5 days while the restart never fired).
    // A withheld restart is a REFUSAL, not a partial success: no lock, no
    // drain, ok:false.
    if (!enabled) {
      return json({
        ok: false,
        target,
        reason: 'restart_withheld',
        restarted: false,
        drained: false,
        note: `Restart REFUSED — the enablement gate is not set, and NOTHING was done: no lock taken, no drain, ${cfg.unit} left running exactly as it was. To actually restart it, re-call with { confirm: true, authorize: true, reason: '<why, ≤300 chars>' } (audited), or set PAPERCUSP_ALLOW_DEV_RESTART=1 on the operator process.`,
      });
    }

    // EI-18661647550414959: refuse to restart a host whose tree cannot boot. Placed HERE
    // deliberately — after the enablement refusal (cheaper still, and no probe) but BEFORE
    // the gate-collision probe, the cooldown marker and the drain, because this is the one
    // check that must happen while the target is STILL RUNNING. Once the drain starts we
    // have already begun disrupting agents for a restart that would only crash-loop.
    // Refusing here leaves the host up on old-but-working code, which is strictly the best
    // available end state (cf. the EI-18643120769203916 half-execution defect above).
    //
    // Soft block, mirroring override_gate_collision: a genuinely wedged host whose remedy
    // IS the restart must stay restartable via override_boot_integrity. Fails OPEN — an
    // unreadable tree reports checked:false and proceeds, and is NEVER treated as clean.
    const bootIntegrity = target === 'desktop-dev' ? null : await preflightRestartTarget(target);
    // D-012: this is an execution-boundary fence, not a restart-health override.
    // It runs before any target-specific preparation, lock, drain, or restart,
    // and its refusal cannot be overridden by override_boot_integrity.
    const restrictedHoldCheck = bootIntegrity
      ? await checkRestrictedHoldBeforeRestart(target, bootIntegrity.requestedRoot, bootIntegrity.unit)
      : null;
    if (restrictedHoldCheck?.refusal) {
      return json({
        ok: false,
        target,
        reason: restrictedHoldCheck.refusal.error,
        restarted: false,
        drained: false,
        restricted_hold: {
          checked: restrictedHoldCheck.checked,
          roots: restrictedHoldCheck.roots,
          ...restrictedHoldCheck.refusal,
        },
        note: `Restart REFUSED — NOTHING was done: no lock taken, no drain, ${cfg.unit} left running exactly as it was. ${restrictedHoldCheck.refusal.hint}`,
      });
    }
    if (bootIntegrity && !bootIntegrity.ok && args.override_boot_integrity !== true) {
      return json({
        ok: false,
        target,
        reason: 'boot_integrity_inconsistent',
        restarted: false,
        drained: false,
        boot_integrity: {
          checked: bootIntegrity.checked,
          tree: bootIntegrity.lockRoot,
          missing: bootIntegrity.missing,
          ...(bootIntegrity.reason ? { skipped: bootIntegrity.reason } : {}),
        },
        note:
          `Restart REFUSED — NOTHING was done: no lock taken, no drain, ${cfg.unit} left running exactly as it was ` +
          `on its current (working) code. ${bootIntegrity.note} Restarting now would take ${cfg.unit} down and ` +
          `crash-loop it instead of bringing it back. Fix the tree first, then re-run this call. If the restart is ` +
          `itself the remedy, re-call with override_boot_integrity:true.`,
      });
    }

    // EI-24790218658923698: a restart boots the unit's WHOLE working tree, including files
    // another agent is mid-edit on. Advisory, never a refusal (a fleet this size always has
    // live edit locks), but it names the suspects up front so a host that does not stay up
    // is diagnosed in one read. Clean deploy checkouts report nothing by construction.
    const peerInFlightEdits: PeerInFlightEdits | null = bootIntegrity
      ? await peerInFlightEditsReader(bootIntegrity.requestedRoot || null, ownerId).catch(() => null)
      : null;

    // WI-2140796: refuse to restart bg-host while a P-101 seed cut (or similar) holds
    // it deliberately quiesced (systemd mask + a marker written by
    // cut-seed-quiesced.sh). Placed HERE for the same reason as the boot-integrity
    // check just above — cheap, no probe cost beyond this, and it must fire before we
    // drain anyone or schedule a restart command that would otherwise either silently
    // no-op against the mask or race the wrapper's own unmask/restart in its EXIT trap.
    const quiesce: QuiesceVerdict | null = isQuiesceSensitiveTarget(target)
      ? await checkBgHostQuiesce(target, args.override_quiesce === true)
      : null;
    if (quiesce && quiesce.blocked) {
      return json({
        ok: false,
        target,
        reason: 'bg_host_quiesced',
        restarted: false,
        drained: false,
        quiesce: {
          quiesced: quiesce.quiesced,
          probeFailed: quiesce.probeFailed,
          ...(quiesce.marker ? { marker: quiesce.marker } : {}),
        },
        note: `Restart REFUSED — NOTHING was done: no lock taken, no drain, ${cfg.unit} left exactly as it was. ${quiesce.note}`,
      });
    }

    // WI-222053: the lock-shaped drain below cannot see processes INSIDE the
    // target's systemd cgroup. Measure the actual destructive mechanism before
    // claiming a cooldown or draining anyone: if a live system:git-sync PID is
    // inside this unit, systemctl restart would SIGKILL its commit and orphan the
    // lease. This covers both scheduled bg-host fires and manual :3070/:3170
    // fires, unlike a target-name-only bg-host check.
    const gitSync = gitSyncSensitive
      ? await checkGitSyncCollision(target, args.override_git_sync_collision === true)
      : null;
    // EI-21930094737784126: this preflight is a CGROUP PROXY ("is a git-sync process
    // inside this unit?"), not the authoritative signal. On bg-host the git-sync worker
    // IS the host process, so the proxy is ~always true while the barrier LOCK it stands
    // in for is free ~half the time. When the caller has given us a drain budget, demote
    // it to ADVISORY and let the barrier below arbitrate — that is the whole difference
    // between a lever that fires and one that refuses 20/20. With no budget it stays a
    // hard refusal, so the default path is unchanged.
    if (gitSync && gitSyncPreflightBlocks(gitSync.blocked, gitSyncDrainSec)) {
      return json({
        ok: false,
        target,
        reason: `git_sync_collision_${gitSync.kind.replace(/-/g, '_')}`,
        restarted: false,
        drained: false,
        git_sync_collision: { kind: gitSync.kind, ...gitSync.detail },
        note: gitSync.note,
      });
    }

    // The staging operator is restarted by a separate sync service. That
    // service's exclusive flock covers checkout mutation and bundle creation;
    // refuse before cooldown or drain if it is still in that phase.
    const stagingSync = target === 'staging' ? await checkStagingSyncCollision(target) : null;
    if (stagingSync?.blocked) {
      return json({
        ok: false,
        target,
        reason: `staging_sync_collision_${stagingSync.kind.replace(/-/g, '_')}`,
        restarted: false,
        drained: false,
        staging_sync_collision: { kind: stagingSync.kind, ...stagingSync.detail },
        note: stagingSync.note,
      });
    }

    // EI-19385475092979200: refuse a gate-sensitive restart while a green-checkpoint run is in
    // flight (or is within the two-sided window around a scheduled fire). Placed HERE
    // deliberately — after the enablement refusal (which is cheaper and needs no probe) and
    // BEFORE the cooldown marker is claimed, so a withheld restart never leaves a cooldown
    // marker held for a restart that did not happen (the EI-11137 phantom-coalesce wedge).
    // Fails OPEN: any probe failure proceeds, saying so. Soft block — `override_gate_collision`
    // is the stated way through, because a genuinely wedged host mid-run must stay restartable.
    const gate = await checkGateCollision(target, args.override_gate_collision === true);
    if (gate.blocked) {
      return json({
        ok: false,
        target,
        reason: `gate_collision_${gate.kind.replace(/-/g, '_')}`,
        restarted: false,
        drained: false,
        gate_collision: { kind: gate.kind, ...gate.detail },
        note: gate.note,
      });
    }

    // EI-24775758523902834: direct target:staging restarts must apply the
    // target tree's pending migrations while the current API is still serving.
    // staging-sync already does this before cutover; without the same step here,
    // dev:restart stopped the only process that could serve while the schema was
    // still behind. Keep it after all soft preflights but before cooldown or drain.
    const stagingSchemaPreparation = stagingSync
      ? await prepareStagingSchemaForRestart(stagingSync.detail.lockPath)
      : null;
    if (stagingSchemaPreparation && !stagingSchemaPreparation.ok) {
      return json({
        ok: false,
        target,
        reason: stagingSchemaPreparation.reason ?? 'staging_migration_preparation_failed',
        restarted: false,
        drained: false,
        staging_schema_preparation: stagingSchemaPreparation,
        note: `Restart REFUSED before cooldown or drain — ${stagingSchemaPreparation.note}`,
      });
    }

    // WI-4221 debounce: for a cooldown-bearing target (staging), try to claim
    // the cooldown marker FIRST, before touching the drain-gate at all. If a
    // peer's real restart already holds it (their restart landed within the
    // last STAGING_COOLDOWN_SEC), coalesce — no drain, no restart, no
    // redundant outage. We deliberately do NOT release this marker on our
    // own successful restart below; it is left to expire via its TTL, which
    // IS the debounce window.
    let cooldownLockId: string | null = null;
    // EI-11137: set when we detect (and refuse to honor) a PHANTOM coalesce —
    // the cooldown marker was held but the service had NOT actually restarted.
    let phantomCoalesceBroken: {
      staleMarkerHolder: string | null;
      serviceSecondsSinceStart: number | null;
      cooldownSec: number;
    } | null = null;
    let bgHostEnvironmentDropInDrift: { changedPaths: string[]; startedAtMs: number } | null = null;
    if (enabled && cfg.cooldownResource) {
      const cd = cfg.cooldownResource;
      // EI-21998059463131681: the cooldown marker is the first staging
      // mutation, so its workspace advisory-lock transaction is exposed
      // directly to same-workspace contention. A single 57014/55P03 here
      // used to abort the restart before it reached the resource drain,
      // even though the contention was transient and the next attempt could
      // proceed. Retry the whole transaction so every attempt gets a fresh
      // connection/transaction after the failed one has rolled back.
      const cooldown = await acquireWithContentionRetry(() =>
        inWorkspaceTxn(
          coordinationDomain,
          ownerId,
          (tx) =>
            tryAcquireResource(tx, {
              coordinationDomain,
              resource: cd,
              mode: 'exclusive',
              owner: ownerId,
              ownerLabel,
              reason: `${target} restart cooldown (WI-4221 / EI-10896)`,
              ttlSec: cooldownSec,
            }),
          workspaceTxnOptionsForExclusiveWait(gitSyncDrainSec),
        ),
      );
      if (!cooldown.ok) {
        const holder = cooldown.holders.find((h) => h.mode === 'exclusive');
        const holderName = holder ? (holder.owner_label ?? holder.owner) : null;
        // EI-11137: the marker alone is NOT proof a restart happened. It can be
        // held while NO real restart occurred (a withheld/failed restart, or a
        // stale marker perpetually re-observed on a busy fleet) — the old code
        // trusted it blindly and returned coalesced:true, silently wedging EVERY
        // subsequent restart for the marker's TTL. bg-host re-bundles the working
        // tree ONLY on restart, so that meant its code fixes never went live.
        // Cross-check the coalesce against the service's REAL last-start.
        const svc = await probeServiceStart(cfg.unit);
        const restartedRecently = svc.ok && svc.secondsSinceStart !== undefined && svc.secondsSinceStart <= cooldownSec;
        if (restartedRecently) {
          // GENUINE coalesce — a peer's restart actually landed within the window.
          const ago = Math.round(svc.secondsSinceStart!);
          // bg-host is special: its restart rebuilds dist-host from the current
          // tree. A genuine recent restart can therefore still be stale relative
          // to a later edit. Diagnose that state, but do not turn the diagnostic
          // into an eager restart — the temporal throttle is also the protection
          // against repeatedly killing in-flight git-sync work.
          const freshness = target === 'bg-host' ? await readBgHostRestartFreshness() : null;
          const environmentDropInFreshness =
            target === 'bg-host' ? await readBgHostEnvironmentDropInFreshness(cfg.unit, svc) : null;
          const environmentDropInChanged =
            environmentDropInFreshness?.checked === true && environmentDropInFreshness.changedPaths.length > 0;
          if (environmentDropInChanged && svc.startedAtMs !== undefined) {
            bgHostEnvironmentDropInDrift = {
              changedPaths: environmentDropInFreshness.changedPaths,
              startedAtMs: svc.startedAtMs,
            };
          }
          const cooldownRemainingSec = Math.max(0, cooldownSec - ago);
          const freshnessFields = freshness
            ? {
                treeChangedSinceRestart: freshness.treeChangedSinceRestart,
                freshnessVerified: freshness.checked,
                ...(freshness.bundleMtimeMs == null
                  ? {}
                  : { bundleMtime: new Date(freshness.bundleMtimeMs).toISOString() }),
                ...(freshness.newestSourceMtimeMs == null
                  ? {}
                  : { newestSourceMtime: new Date(freshness.newestSourceMtimeMs).toISOString() }),
                ...(freshness.newestSourcePath ? { newestSourcePath: freshness.newestSourcePath } : {}),
              }
            : {};
          const environmentDropInFields = environmentDropInFreshness
            ? {
                unitEnvFreshnessVerified: environmentDropInFreshness.checked,
                unitEnvChangedSinceRestart: environmentDropInFreshness.checked
                  ? environmentDropInFreshness.changedPaths.length > 0
                  : null,
                ...(environmentDropInChanged
                  ? { unitEnvChangedDropIns: environmentDropInFreshness.changedPaths }
                  : {}),
              }
            : {};
          const environmentDropInNote =
            environmentDropInFreshness === null
              ? ''
              : !environmentDropInFreshness.checked
                ? ' Unit Environment= drop-in freshness could NOT be verified; do not assume Environment= edits are loaded.'
                : environmentDropInChanged
                  ? ` WARNING: Environment= drop-ins changed after MainPID ${svc.mainPid} started (${environmentDropInFreshness.changedPaths.join(', ')}); retrying under the exclusive restart guard.`
                  : ' Unit Environment= drop-in freshness checked: no active Environment= drop-in is newer than the MainPID start.';
          const freshnessNote =
            freshness == null
              ? ''
              : !freshness.checked
                ? ' Tree/bundle freshness could NOT be verified; do not assume the requested edit is loaded.'
                : freshness.treeChangedSinceRestart
                  ? ` WARNING: the runtime tree is newer than the bundle used by this restart${
                      freshness.newestSourcePath ? ` (newest source: ${freshness.newestSourcePath})` : ''
                    }; the requested edit is NOT loaded. The temporal throttle is preserved; retry after the remaining cooldown (~${cooldownRemainingSec}s) when safe.`
                  : ' Tree/bundle freshness checked: no runtime source is newer than the bundle used by this restart.';
          if (bgHostEnvironmentDropInDrift === null) {
            return json({
              ok: true,
              target,
              restarted: false,
              coalesced: true,
              verified: true,
              restartedSecondsAgo: ago,
              mainPid: svc.mainPid ?? null,
              ...freshnessFields,
              ...environmentDropInFields,
              note: `${cfg.unit} genuinely restarted ~${ago}s ago${
                holderName ? ` (marker held by ${holderName})` : ''
              } — verified via systemd (MainPID ${svc.mainPid}). Skipping a redundant restart; probe it directly.${freshnessNote}${environmentDropInNote}`,
            });
          }
        }
        if (!svc.ok) {
          // Could NOT verify (no systemd / probe failed). Fall back to trusting
          // the marker so we never fire N concurrent outages — but SAY it is
          // unverified so a stale marker is at least visible to the caller.
          return json({
            ok: true,
            target,
            restarted: false,
            coalesced: true,
            verified: false,
            note: `${cfg.unit} appears to have been restarted within the last ~${cooldownSec}s${
              holderName ? ` by ${holderName}` : ' by a peer'
            } — but this could NOT be verified against systemd. Probe it directly; if it is still stale, retry after the cooldown (~${cooldownSec}s) lapses.`,
          });
        }
        // PHANTOM: the marker is held but the service did NOT actually restart
        // within the window (its main process is older than the cooldown, or
        // there is no live main process). This is exactly the wedge EI-11137
        // fixes — do NOT coalesce. Fall through and fire a REAL restart: the
        // stale marker expires on its own TTL, and once our restart lands systemd
        // reflects it so later callers coalesce correctly. We could not acquire
        // the marker (a peer holds it, and tryReleaseResource is owner-scoped so
        // we cannot force-release theirs), so we proceed WITHOUT it — the systemd
        // truth-check above is now the effective debounce.
        phantomCoalesceBroken = {
          staleMarkerHolder: holderName,
          serviceSecondsSinceStart: svc.secondsSinceStart ?? null,
          cooldownSec,
        };
      } else {
        cooldownLockId = cooldown.lock_id;
      }
    }

    const releaseCooldownOnAbort = async () => {
      if (!cooldownLockId) return;
      await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
        tryReleaseResource(tx, { coordinationDomain, owner: ownerId, lockId: cooldownLockId! }),
      ).catch(() => {});
    };

    // EI-21642857846058648: acquire the atomic git-sync barrier BEFORE entering
    // guardResource. The old order drained the target first, then discovered
    // that git-sync had acquired this barrier in the meantime, returning
    // `drained:true` while refusing to restart. A barrier refusal must leave the
    // target untouched, and a held barrier must cover the entire drain through
    // the delayed systemctl handoff.
    let gitSyncBarrier: Awaited<ReturnType<typeof acquireGitSyncRestartBarrier>> | null = null;
    try {
      gitSyncBarrier =
        isGitSyncSensitiveTarget(target) && args.override_git_sync_collision !== true
          ? await acquireWithContentionRetry(() =>
              acquireGitSyncRestartBarrier(ownerLabel, undefined, { maxDrainSec: gitSyncDrainSec }),
            )
          : null;
    } catch (error) {
      await releaseCooldownOnAbort();
      throw error;
    }
    if (gitSyncBarrier && !gitSyncBarrier.acquired) {
      await releaseCooldownOnAbort();
      return json({
        ok: false,
        target,
        reason: `git_sync_barrier_${gitSyncBarrier.reason.replace(/-/g, '_')}`,
        restarted: false,
        drained: false,
        resource: gitSyncBarrier.resource,
        holders: gitSyncBarrier.holders.map((holder) => ({
          owner: holder.owner,
          owner_label: holder.owner_label ?? null,
          mode: holder.mode,
          status: holder.status,
        })),
        note:
          `Restart REFUSED before draining — a git-sync operation holds the atomic ${gitSyncBarrier.resource} ` +
          'barrier after the earlier cgroup preflight. No target users were drained; retry when that operation settles.' +
          // Point at the lever rather than leaving the reader to invent one: a bare
          // refusal here is exactly what made this remediation look unreachable.
          (gitSyncDrainSec === 0
            ? ` git-sync fires hold this barrier only ~5-10s, so pass git_sync_drain_sec (up to ${GIT_SYNC_RESTART_BARRIER_DRAIN_SEC}) to WAIT for it instead of retrying by hand — that is the supported way through on a merely busy host, not override_git_sync_collision.`
            : ` Already waited ${gitSyncDrainSec}s for a drain and it did not clear; the sweep is unusually saturated, so retry shortly rather than forcing.`),
      });
    }

    let restartScheduled = false;
    // A staging restart kills this handler's own process. Run the detached
    // handoff only after guardResource's finally has released staging-server;
    // waiting for readiness inside that guard stranded the exclusive lease.
    const stagingRestartAfterRelease: { run?: () => Promise<ReturnType<typeof json>> } = {};
    let barrierReleaseAttempted = false;
    const releaseGitSyncBarrierOnAbort = async () => {
      if (!gitSyncBarrier?.acquired || restartScheduled || barrierReleaseAttempted) return;
      barrierReleaseAttempted = true;
      await gitSyncBarrier.release().catch(() => {});
    };

    // `daemon-reload` refreshes the whole user manager. Skip that global
    // operation for code-only restarts when systemd confirms this unit's
    // definition is already loaded. If unit files did change (or the probe is
    // inconclusive), reload before guardResource drains target callers so a
    // slow/failed manager reload cannot leave them drained without a restart.
    let systemdDaemonReloaded = false;
    if (target !== 'desktop-dev' && (await probeSystemdDaemonReloadNeed(cfg.unit)) !== 'not-needed') {
      try {
        await systemdDaemonReloader();
        systemdDaemonReloaded = true;
      } catch (error) {
        await releaseCooldownOnAbort();
        await releaseGitSyncBarrierOnAbort();
        const detail = error instanceof Error ? error.message : String(error);
        const timedOut = isExecFileTimeout(error);
        return json({
          ok: false,
          target,
          drained: false,
          restarted: false,
          systemdDaemonReloaded: false,
          reason: timedOut ? 'systemd_daemon_reload_timed_out' : 'systemd_daemon_reload_failed',
          note: timedOut
            ? `Restart REFUSED before draining because systemctl --user daemon-reload exceeded the ${SYSTEMD_DAEMON_RELOAD_TIMEOUT_MS}ms timeout: ${detail}. No target users were drained and ${cfg.unit} was not restarted.`
            : `Restart REFUSED before draining because systemctl --user daemon-reload failed: ${detail}. No target users were drained and ${cfg.unit} was not restarted.`,
        });
      }
    }

    // EI-22040822883429888: guardResource's exclusive drain wait supports an
    // onTick heartbeat (resource-acquire-wait.ts fires it every ~5s while
    // draining), but this call never wired one up — a genuinely-still-draining
    // restart looked indistinguishable from a wedge to an MCP client watching
    // for "response or progress", so a long drain could exceed the transport's
    // idle timeout and come back outcome=unknown even though the server side
    // was still working. Same defensive capture + forwarding shape as
    // db:migrate's onTick->ctx.progress wiring (EI-18769559897594065): ctx.progress
    // refreshes the transport's own idle-timeout deadline (tooldef D2).
    const restartMaxDrainSec = args.max_drain_sec ?? DEFAULT_DRAIN_SEC;
    const emitRestartProgress =
      (ctx as { progress?: (pct: number | undefined, msg?: string) => void }).progress ?? (() => undefined);

    const outcome = await guardResource(
      {
        // coordinationDomain is the resourceLockDomain(cfg.resource) computed
        // above (host-global for 'dev-server', unchanged for everything else) —
        // see that declaration's comment for why.
        coordinationDomain,
        ownerId,
        ownerLabel,
        coordIdentity,
        resource: cfg.resource,
        mode: 'exclusive',
        maxDrainSec: restartMaxDrainSec,
        reason: `${cfg.resource} restart`,
        onTick: ({ waited_sec, holders }) => {
          emitRestartProgress(
            undefined,
            JSON.stringify({
              phase: 'draining',
              elapsed_sec: waited_sec,
              max_drain_sec: restartMaxDrainSec,
              remaining_sec: Math.max(0, restartMaxDrainSec - waited_sec),
              holders: holders.map(holderJson),
            }),
          );
        },
      },
      async (fence) => {
        // NOTE: the `!enabled` refusal happens BEFORE this guard is ever entered
        // (EI-18643120769203916) — reaching here means a real restart is
        // authorized, so the drain we just performed is always followed through.
        // D-001 fencing: re-verify we still hold the effective exclusive at our
        // fence immediately before the destructive restart. A paused/zombie
        // holder whose lease lapsed and was re-granted is rejected here rather
        // than restarting out from under the agent that now owns the resource.
        const fc = await fence.assertCurrent();
        if (!fc.current) {
          return json({
            ok: false,
            target,
            restarted: false,
            reason: `stale_fence_${fc.reason}`,
            fence_seq: fence.seq,
            live_fence_seq: fc.live_fence_seq,
            note: `Restart ABORTED — our exclusive(${cfg.resource}) lease was superseded while we held it. Re-acquire before retrying.`,
          });
        }
        if (target === 'desktop-dev') {
          const desktopRestart = await restartDesktopDev();
          if (!desktopRestart.ok) {
            return json({
              ok: false,
              target,
              drained: true,
              restarted: false,
              reason: desktopRestart.reason ?? 'desktop_dev_restart_failed',
              ...(desktopRestart.pid === undefined ? {} : { listenerPid: desktopRestart.pid }),
              note: desktopRestart.note,
            });
          }
          void writeRestartAudit(ownerId, {
            target,
            unit: cfg.unit,
            viaEnv: enabledByEnv,
            viaAuthorizeArg: enabledByArg,
            reason: args.reason ?? null,
            fenceSeq: fence.seq,
            phantomCoalesceBroken: false,
            gateCollision: null,
            gitSyncCollision: null,
            gitSyncBarrier: null,
            systemdDaemonReloaded: false,
          });
          return json({
            ok: true,
            target,
            drained: true,
            restarted: true,
            listenerPid: desktopRestart.pid,
            ...(desktopRestart.replacementPid === undefined
              ? {}
              : { replacementListenerPid: desktopRestart.replacementPid }),
            fence_seq: fence.seq,
            enabledVia: enabledByEnv ? 'env' : 'authorize_arg',
            audited: true,
            verifyWith:
              'dev:listening_ports { port: 3270 } (the helper already observed a different owner-visible hono-host listener under dev-operator-ifneeded.sh; this is an independent re-check)',
            note: desktopRestart.note,
          });
        }
        // EI-11137: capture the pre-restart MainPID so the caller can VERIFY a
        // real cycle happened (the restart is detached+delayed, so we cannot
        // confirm it synchronously — but a changed MainPID proves it landed).
        const before = await probeServiceStart(cfg.unit);
        let environmentDropInFreshnessAtGuard: BgHostEnvironmentDropInFreshness | null = null;
        if (bgHostEnvironmentDropInDrift !== null) {
          environmentDropInFreshnessAtGuard = await readBgHostEnvironmentDropInFreshness(cfg.unit, before);
          if (!environmentDropInFreshnessAtGuard.checked) {
            await releaseGitSyncBarrierOnAbort();
            await releaseCooldownOnAbort();
            return json({
              ok: false,
              target,
              drained: true,
              restarted: false,
              reason: 'bg_host_freshness_unverified',
              unitEnvFreshnessVerified: false,
              unitEnvChangedSinceRestart: null,
              note: `Restart REFUSED under the exclusive ${cfg.resource} lease because the current MainPID start or active Environment= drop-ins could not be verified. No restart was scheduled; the drain and git-sync barrier are being released. Retry when the service probe is available.`,
            });
          }
          if (environmentDropInFreshnessAtGuard.changedPaths.length === 0) {
            const currentTreeFreshness = await readBgHostRestartFreshness();
            if (!currentTreeFreshness.checked) {
              await releaseGitSyncBarrierOnAbort();
              await releaseCooldownOnAbort();
              return json({
                ok: false,
                target,
                drained: true,
                restarted: false,
                reason: 'bg_host_freshness_unverified',
                treeChangedSinceRestart: null,
                freshnessVerified: false,
                unitEnvFreshnessVerified: true,
                unitEnvChangedSinceRestart: false,
                note: `Restart REFUSED under the exclusive ${cfg.resource} lease because the source/bundle relationship could not be verified after the Environment= drop-in change was rechecked. No restart was scheduled; the drain and git-sync barrier are being released. Retry when freshness can be measured.`,
              });
            }
            if (currentTreeFreshness.treeChangedSinceRestart === false) {
              await releaseGitSyncBarrierOnAbort();
              await releaseCooldownOnAbort();
              return json({
                ok: true,
                target,
                drained: true,
                restarted: false,
                coalesced: true,
                verified: true,
                restartedSecondsAgo: before.secondsSinceStart ?? null,
                mainPid: before.mainPid ?? null,
                treeChangedSinceRestart: false,
                freshnessVerified: true,
                unitEnvFreshnessVerified: true,
                unitEnvChangedSinceRestart: false,
                note: `${cfg.unit} was rechecked under the exclusive ${cfg.resource} lease: no active Environment= drop-in is newer than MainPID ${before.mainPid} and the bundle includes the current source tree. A peer already applied the requested changes, so no restart was scheduled.`,
              });
            }
          }
        }
        // Detached + delayed so this response returns before the service dies.
        // systemd latches a unit after it exceeds StartLimitBurst. A plain
        // `restart` is then rejected with "Start request repeated too quickly"
        // until `reset-failed` clears that manager state. Some user-manager
        // versions retain only Result=exit-code after that refusal, so
        // Result=start-limit-hit is sufficient but not necessary: a known
        // failed unit with no MainPID is also reset before the requested
        // restart. Ordinary active restarts keep their useful metadata.
        const resetFailedBeforeRestart =
          before.ok && before.mainPid === 0 && (before.result === 'start-limit-hit' || before.activeState === 'failed');
        const scheduledRestartCmd = resetFailedBeforeRestart
          ? `systemctl --user reset-failed ${cfg.unit} && ${restartCmd}`
          : restartCmd;
        const performRestart = async () => {
          // The first check protects cooldown/drain. Recheck after that work,
          // immediately before audit+spawn, so a sync that starts in the gap
          // cannot be interrupted by the staging unit restart.
          const finalStagingSyncCheck =
            target === 'staging' ? await checkStagingSyncCollision(target) : null;
          if (finalStagingSyncCheck?.blocked) {
            await releaseGitSyncBarrierOnAbort();
            await releaseCooldownOnAbort();
            return json({
              ok: false,
              target,
              reason: `staging_sync_collision_${finalStagingSyncCheck.kind.replace(/-/g, '_')}`,
              restarted: false,
              drained: true,
              staging_sync_collision: { kind: finalStagingSyncCheck.kind, ...finalStagingSyncCheck.detail },
              note:
                `${finalStagingSyncCheck.note} The staging-server drain has been released; ` +
                'no restart was scheduled and the cooldown marker was released.',
            });
          }
          const stagingLockPath = finalStagingSyncCheck ? finalStagingSyncCheck.detail.lockPath : null;
          const stagingHandoff =
            stagingLockPath !== null
              ? await prepareStagingRestartHandoff(stagingLockPath, scheduledRestartCmd)
              : null;
          if (stagingHandoff && !stagingHandoff.acquired) {
            await releaseGitSyncBarrierOnAbort();
            await releaseCooldownOnAbort();
            const collision = stagingHandoff.reason === 'lock-busy';
            return json({
              ok: false,
              target,
              reason: collision
                ? 'staging_sync_collision_staging_sync_in_flight'
                : 'staging_sync_restart_handoff_failed',
              restarted: false,
              drained: true,
              staging_sync_collision: {
                kind: collision ? 'staging-sync-in-flight' : 'handoff-failed',
                lockPath: stagingLockPath,
                lockHeld: collision ? true : null,
                ...(stagingHandoff.exitCode === undefined ? {} : { exitCode: stagingHandoff.exitCode }),
                ...(stagingHandoff.detail ? { detail: stagingHandoff.detail } : {}),
              },
              note: collision
                ? `Restart REFUSED — papercup-staging-sync acquired its exclusive checkout lock after the final check (${stagingLockPath}). The staging-server drain has been released; no restart was scheduled and the cooldown marker was released. Retry after the sync completes.`
                : `Restart REFUSED — the detached command could not acquire and transfer the shared staging-sync lock (${stagingLockPath}). The staging-server drain has been released; no restart was scheduled and the cooldown marker was released.`,
            });
          }
          let requestId: string | null = null;
          let requestAuditPersisted = true;
          let restartAuditDetails: Parameters<typeof writeRestartAudit>[1] | null = null;
          let restartProcess: ReturnType<typeof spawn> | null = null;
          let restartSpawnError: string | null = null;
          let restartObservationError: string | null = null;
          let restartCommandExitCode: number | null = null;
          let restartCommandSignal: string | null = null;
          let restartCommandExited = false;
          // Typed by assertion, not annotation: a `T | null = null` initializer narrows the
          // variable to `null` in this scope (TS does not see the executor's assignment), so
          // the synchronous catch below would read it as uncallable (WI-10006260).
          let restartCommandClosedResolve = null as (() => void) | null;
          const restartCommandClosed = new Promise<void>((resolve) => {
            restartCommandClosedResolve = resolve;
          });
          try {
            // The staging child is holding the shared lease and waits on fd 4.
            // Invoke the audit before releasing that wait, so audit refusal is
            // never confused with a restart that was actually scheduled.
            restartAuditDetails = {
              target,
              unit: cfg.unit,
              viaEnv: enabledByEnv,
              viaAuthorizeArg: enabledByArg,
              reason: args.reason ?? null,
              fenceSeq: fence.seq,
              phantomCoalesceBroken: phantomCoalesceBroken !== null,
              gateCollision: isGateSensitiveTarget(target)
                ? { kind: gate.kind, overridden: gate.overridden, runElapsedSec: gate.detail.runElapsedSec }
                : null,
              gitSyncCollision: gitSync
                ? {
                    kind: gitSync.kind,
                    overridden: gitSync.overridden,
                    resources: gitSync.detail.collidingResources,
                    pids: gitSync.detail.collidingPids,
                  }
                : null,
              stagingSyncCollision: finalStagingSyncCheck
                ? { kind: finalStagingSyncCheck.kind, ...finalStagingSyncCheck.detail }
                : stagingSync
                  ? { kind: stagingSync.kind, ...stagingSync.detail }
                  : null,
              stagingSyncHandoff:
                stagingHandoff && stagingLockPath !== null
                ? {
                    lockPath: stagingLockPath,
                    mode: 'shared',
                    heldThrough: 'systemctl-restart',
                  }
                : null,
              gitSyncBarrier:
                gitSyncBarrier?.acquired === true
                  ? { resource: gitSyncBarrier.resource, expiresAt: gitSyncBarrier.expiresAt }
                : null,
              systemdDaemonReloaded,
              ...(bgHostEnvironmentDropInDrift
                ? {
                    unitEnvironmentDropInChange: {
                      paths: bgHostEnvironmentDropInDrift.changedPaths,
                      mainPidStartedAtMs: bgHostEnvironmentDropInDrift.startedAtMs,
                    },
                  }
                : {}),
              quiesceOverridden: quiesce?.overridden ? { marker: quiesce.marker } : null,
            };
            if (target === 'bg-host') {
              requestId = randomUUID();
              requestAuditPersisted = await writeRestartAudit(ownerId, {
                ...restartAuditDetails,
                requestId,
                phase: 'request',
                beforeMainPid: before.mainPid ?? null,
                restartCommand: scheduledRestartCmd,
              });
            } else {
              void writeRestartAudit(ownerId, restartAuditDetails);
            }
            if (stagingHandoff?.acquired) {
              restartScheduled = true;
              stagingHandoff.start();
            } else {
              const child = spawn('sh', ['-c', `sleep 1; ${scheduledRestartCmd}`], {
                detached: true,
                stdio: 'ignore',
              });
              restartProcess = child;
              if (target === 'bg-host') {
                child.once('error', (error) => {
                  restartSpawnError = error.message;
                  restartCommandExited = true;
                  restartCommandClosedResolve?.();
                });
                child.once('close', (code, signal) => {
                  restartCommandExitCode = code;
                  restartCommandSignal = signal;
                  restartCommandExited = true;
                  restartCommandClosedResolve?.();
                });
              }
              child.unref();
              restartScheduled = true;
            }
          } catch (error) {
            restartScheduled = false;
            if (stagingHandoff?.acquired) stagingHandoff.abort();
            if (target === 'bg-host') {
              restartSpawnError = error instanceof Error ? error.message : String(error);
              restartCommandExited = true;
              restartCommandClosedResolve?.();
            } else {
              throw error;
            }
          }
          const gatewayReadiness =
            target === 'gateway' ? await waitForGatewayRestartReadiness(before.mainPid ?? null) : null;
          const stagingReadiness = target === 'staging' ? await stagingRestartReadinessReader(before) : null;
          let bgHostReadiness: BgHostRestartReadiness | null = null;
          if (target === 'bg-host') {
            if (restartSpawnError) {
              bgHostReadiness = {
                ready: false,
                observed: false,
                outcome: 'not-observed',
                pidChanged: false,
                observedPid: null,
                activeState: null,
                result: null,
                waitedMs: 0,
              };
            } else {
              try {
                bgHostReadiness = await bgHostRestartReadinessReader(before);
              } catch (error) {
                restartObservationError = error instanceof Error ? error.message : String(error);
                bgHostReadiness = {
                  ready: false,
                  observed: false,
                  outcome: 'not-observed',
                  pidChanged: false,
                  observedPid: null,
                  activeState: null,
                  result: null,
                  waitedMs: 0,
                };
              }
            }
            if (restartProcess && !restartCommandExited) {
              await Promise.race([
                restartCommandClosed,
                new Promise<void>((resolve) => setTimeout(resolve, 250)),
              ]);
            }
            const systemdJobAccepted = restartCommandExitCode === 0 && restartSpawnError === null;
            const bgHostRestarted = bgHostReadiness.ready && systemdJobAccepted;
            const outcomeAuditPersisted = await writeRestartAudit(ownerId, {
              ...(restartAuditDetails ?? { target, unit: cfg.unit, viaEnv: enabledByEnv, viaAuthorizeArg: enabledByArg,
                reason: args.reason ?? null, fenceSeq: fence.seq, phantomCoalesceBroken: phantomCoalesceBroken !== null,
                systemdDaemonReloaded }),
              requestId: requestId ?? 'request-id-unavailable',
              phase: 'outcome',
              beforeMainPid: before.mainPid ?? null,
              restartCommand: scheduledRestartCmd,
              restartLauncherPid: restartProcess?.pid ?? null,
              restartCommandExitCode,
              restartCommandSignal,
              restartCommandError: restartSpawnError,
              systemdJobAccepted,
              restartObserved: bgHostReadiness.observed,
              restarted: bgHostRestarted,
              observedMainPid: bgHostReadiness.observedPid,
              observedActiveState: bgHostReadiness.activeState,
              observedResult: bgHostReadiness.result,
              observationWaitedMs: bgHostReadiness.waitedMs,
            });
            const restartWasScheduled = restartProcess !== null && restartSpawnError === null;
            const restartNote = bgHostRestarted
              ? 'bg-host restart transition observed at active MainPID ' + bgHostReadiness.observedPid +
                ' after ' + bgHostReadiness.waitedMs + 'ms.'
              : restartSpawnError
                ? 'bg-host restart command could not be started: ' + restartSpawnError
                : restartObservationError
                  ? 'bg-host systemd outcome could not be measured: ' + restartObservationError
                  : !systemdJobAccepted
                    ? 'bg-host restart command did not confirm systemd job acceptance (exit code ' +
                      (restartCommandExitCode === null ? 'unknown' : restartCommandExitCode) +
                      '); do not report it as restarted.'
                    : 'bg-host restart was scheduled, but a changed active MainPID was not observed; do not report it as restarted.';
            return json({
              ok: bgHostRestarted,
              target,
              drained: true,
              restarted: bgHostRestarted,
              restartScheduled: restartWasScheduled,
              systemdJobAccepted,
              restartObserved: bgHostReadiness.observed,
              restartRequestId: requestId,
              restartReadiness: bgHostReadiness,
              restartedFromPid: before.mainPid ?? null,
              enabledVia: enabledByEnv ? 'env' : 'authorize_arg',
              audited: requestAuditPersisted && outcomeAuditPersisted,
              requestAuditPersisted,
              outcomeAuditPersisted,
              systemdDaemonReloaded,
              ...(environmentDropInFreshnessAtGuard
                ? {
                    unitEnvFreshnessVerified: environmentDropInFreshnessAtGuard.checked,
                    unitEnvChangedSinceRestart: environmentDropInFreshnessAtGuard.changedPaths.length > 0,
                    ...(environmentDropInFreshnessAtGuard.changedPaths.length > 0
                      ? { unitEnvChangedDropIns: environmentDropInFreshnessAtGuard.changedPaths }
                      : {}),
                  }
                : {}),
              ...(phantomCoalesceBroken ? { phantomCoalesceBroken } : {}),
              ...(resetFailedBeforeRestart ? { resetFailedBeforeRestart: true } : {}),
              ...(gate.overridden ? { gateCollisionOverridden: { kind: gate.kind, ...gate.detail } } : {}),
              ...(gitSync?.overridden ? { gitSyncCollisionOverridden: { kind: gitSync.kind, ...gitSync.detail } } : {}),
              ...(quiesce?.overridden ? { quiesceOverridden: { marker: quiesce.marker } } : {}),
              ...(peerInFlightEdits?.checked && peerInFlightEdits.total > 0 ? { peerInFlightEdits } : {}),
              ...(restartSpawnError
                ? { reason: 'bg_host_restart_command_spawn_failed' }
                : !bgHostRestarted
                  ? { reason: 'bg_host_restart_not_observed' }
                  : {}),
              verifyWith: restartVerificationHint(target, cfg.unit, before.mainPid ?? null, before.nRestarts),
              note: restartNote +
                (environmentDropInFreshnessAtGuard?.changedPaths.length
                  ? ` — restarted to load the newer Environment= drop-in(s): ${environmentDropInFreshnessAtGuard.changedPaths.join(', ')}.`
                  : bgHostEnvironmentDropInDrift
                    ? ' — the Environment= drop-in change was rechecked under the exclusive lease; a peer loaded it while this request drained, and this restart is for the still-stale runtime tree.'
                    : '') +
                ' bg-host restart freezes cross-machine peer-log rails ~13min while the substrate rejoins — see EI-13317.' +
                peerInFlightEditsNote(peerInFlightEdits, cfg.unit),
            });
          }
          if (gatewayReadiness && !gatewayReadiness.ready) {
            return json({
              ok: false,
              target,
              drained: true,
              restarted: false,
              restartScheduled: true,
              fence_seq: fence.seq,
              restartedFromPid: before.mainPid ?? null,
              enabledVia: enabledByEnv ? 'env' : 'authorize_arg',
              audited: true,
              systemdDaemonReloaded,
              ...(phantomCoalesceBroken ? { phantomCoalesceBroken } : {}),
              ...(resetFailedBeforeRestart ? { resetFailedBeforeRestart: true } : {}),
              ...(gate.overridden ? { gateCollisionOverridden: { kind: gate.kind, ...gate.detail } } : {}),
              ...(gitSync?.overridden ? { gitSyncCollisionOverridden: { kind: gitSync.kind, ...gitSync.detail } } : {}),
              ...(quiesce?.overridden ? { quiesceOverridden: { marker: quiesce.marker } } : {}),
              gatewayReadiness,
              verifyWith: `GET ${gatewayHealthUrl()} after a NEW MainPID (bounded wait ~${GATEWAY_RESTART_PID_WAIT_MS / 1000}s)`,
              note:
                `Gateway restart was scheduled (~1s), but readiness was NOT confirmed within the bounded wait. ` +
                `Do not send requests yet; probe ${gatewayHealthUrl()} directly and retry only after the service is ready.` +
                (gatewayReadiness.pidChanged
                  ? ` MainPID changed to ${gatewayReadiness.observedPid}, but the listener probe failed: ${gatewayReadiness.health?.detail ?? 'unknown probe failure'}.`
                  : ` A new live MainPID was not observed (last observed: ${gatewayReadiness.observedPid ?? 'none'}).`),
            });
          }
          if (stagingReadiness && !stagingReadiness.ready) {
            const starting = stagingReadiness.outcome === 'starting';
            return json({
              ok: starting,
              target,
              drained: true,
              restarted: false,
              restartScheduled: true,
              restartObserved: stagingReadiness.observed,
              fence_seq: fence.seq,
              restartedFromPid: before.mainPid ?? null,
              enabledVia: enabledByEnv ? 'env' : 'authorize_arg',
              audited: true,
              systemdDaemonReloaded,
              ...(phantomCoalesceBroken ? { phantomCoalesceBroken } : {}),
              ...(resetFailedBeforeRestart ? { resetFailedBeforeRestart: true } : {}),
              stagingReadiness,
              verifyWith: restartVerificationHint(target, cfg.unit, before.mainPid ?? null),
              note: starting
                ? `Staging restart execution was observed, but :3170 is still starting; restarted remains false until the new MainPID owns the listener.`
                : `Staging restart was scheduled, but no successful systemd/listener transition was observed within the bounded wait. The unit ended ${
                    stagingReadiness.activeState ?? 'unknown'
                  } with Result=${stagingReadiness.result ?? 'unknown'}; do not claim it restarted.`,
            });
          }
          return json({
            ok: true,
            target,
            drained: true,
            restarted: true,
            fence_seq: fence.seq,
            restartedFromPid: before.mainPid ?? null,
            enabledVia: enabledByEnv ? 'env' : 'authorize_arg',
            audited: true,
            systemdDaemonReloaded,
            ...(environmentDropInFreshnessAtGuard
              ? {
                  unitEnvFreshnessVerified: environmentDropInFreshnessAtGuard.checked,
                  unitEnvChangedSinceRestart: environmentDropInFreshnessAtGuard.changedPaths.length > 0,
                  ...(environmentDropInFreshnessAtGuard.changedPaths.length > 0
                    ? { unitEnvChangedDropIns: environmentDropInFreshnessAtGuard.changedPaths }
                    : {}),
                }
              : {}),
            ...(phantomCoalesceBroken ? { phantomCoalesceBroken } : {}),
            ...(resetFailedBeforeRestart ? { resetFailedBeforeRestart: true } : {}),
            ...(gate.overridden ? { gateCollisionOverridden: { kind: gate.kind, ...gate.detail } } : {}),
            ...(gitSync?.overridden ? { gitSyncCollisionOverridden: { kind: gitSync.kind, ...gitSync.detail } } : {}),
            ...(quiesce?.overridden ? { quiesceOverridden: { marker: quiesce.marker } } : {}),
            ...(gitSyncBarrier?.acquired === true
              ? {
                  gitSyncRestartBarrier: {
                    resource: gitSyncBarrier.resource,
                    expiresAt: gitSyncBarrier.expiresAt,
                    release: 'lease-expiry-after-systemctl-handoff',
                  },
                }
              : {}),
            ...(gatewayReadiness ? { gatewayReadiness } : {}),
            ...(stagingReadiness ? { stagingReadiness } : {}),
            ...(peerInFlightEdits?.checked && peerInFlightEdits.total > 0 ? { peerInFlightEdits } : {}),
            ...(stagingSchemaPreparation
              ? {
                  staging_schema_preparation: {
                    prepared: true,
                    integrationRoot: stagingSchemaPreparation.integrationRoot,
                    sqlDir: stagingSchemaPreparation.sqlDir,
                    applied: stagingSchemaPreparation.applied,
                  },
                }
              : {}),
            verifyWith: gatewayReadiness
              ? `GET ${gatewayHealthUrl()} after a NEW MainPID (observed ${gatewayReadiness.observedPid}; bounded wait ~${
                  GATEWAY_RESTART_PID_WAIT_MS / 1000
                }s)`
              : restartVerificationHint(target, cfg.unit, before.mainPid ?? null, before.nRestarts),
            note: gatewayReadiness
              ? `Gateway restart completed: MainPID changed to ${gatewayReadiness.observedPid}; ${gatewayHealthUrl()} responded ${
                  gatewayReadiness.health?.detail ?? 'successfully'
                } after ${gatewayReadiness.waitedMs}ms.`
              : stagingReadiness
                ? `Staging restart completed: MainPID changed to ${stagingReadiness.observedPid} and owns :${
                    stagingReadiness.listener?.port ?? RESTART_TARGET_PORTS.staging
                  } after ${stagingReadiness.waitedMs}ms.${
                    resetFailedBeforeRestart ? ' reset-failed cleared the prior failed/start-limited unit first.' : ''
                  }`
                : `Restart scheduled (~1s)${
                    resetFailedBeforeRestart
                      ? ` — systemd reported start-limit-hit; reset-failed will clear the latched failure before restart.`
                      : ''
                  }${
                    phantomCoalesceBroken
                      ? ' — this BROKE a phantom coalesce marker (the service had NOT actually restarted despite the marker being held)'
                      : ''
                  }${
                    environmentDropInFreshnessAtGuard?.changedPaths.length
                      ? ` — restarted to load the newer Environment= drop-in(s): ${environmentDropInFreshnessAtGuard.changedPaths.join(', ')}`
                      : bgHostEnvironmentDropInDrift
                        ? ' — the Environment= drop-in change was rechecked under the exclusive lease; a peer loaded it while this request drained, and this restart is for the still-stale runtime tree'
                        : ''
                  } — this connection will drop as the operator restarts.${gitSync?.overridden || gitSync?.kind === 'probe-failed' || gitSync?.kind === 'operation-in-flight-unknown' ? ` ⚠ ${gitSync.note}` : ''}${gate.overridden || gate.kind === 'probe-failed' ? ` ⚠ ${gate.note}` : ''}${quiesce?.overridden ? ` ⚠ ${quiesce.note}` : ''}${peerInFlightEditsNote(peerInFlightEdits, cfg.unit)}`,
          });
        };
        if (target === 'staging') {
          stagingRestartAfterRelease.run = performRestart;
          // The real result is produced after the guard releases its lease.
          return json({ ok: true, target, handoffPending: true });
        }
        return performRestart();
      },
    ).catch(async (error) => {
      await releaseGitSyncBarrierOnAbort();
      await releaseCooldownOnAbort();
      throw error;
    });

    if (outcome.acquired) {
      if (stagingRestartAfterRelease.run) {
        try {
          return await stagingRestartAfterRelease.run();
        } catch (error) {
          await releaseGitSyncBarrierOnAbort();
          await releaseCooldownOnAbort();
          throw error;
        }
      }
      if (!restartScheduled) {
        await releaseGitSyncBarrierOnAbort();
        await releaseCooldownOnAbort();
      }
      return outcome.result;
    }
    await releaseGitSyncBarrierOnAbort();
    await releaseCooldownOnAbort();
    return json({
      ok: false,
      target,
      reason: `resource_${outcome.reason}`,
      resource: cfg.resource,
      holders: outcome.holders.map(holderJson),
    });
  },
});
