/**
 * Production wiring for the deploy mechanics — plan
 * release-gate-ready-branch-2026-06-04 (D-005/D-006/D-007/D-008).
 *
 * Each DeployDep maps to a real subsystem:
 *   withDrain        → guardResource(dev-server, exclusive) — the SAME drain
 *                      `dev:restart` uses, so it quiesces the same peers (D-006).
 *   snapshot/restore → the Kopia backup substrate (workspace files + PG dump, D-008).
 *   runSetup         → setup-release-checkout.sh (FF release tree + submodules + nm).
 *   migrate          → applyStagedMigrations, fail-loud (D-007).
 *   restart          → systemctl restart of the operator + background units (gated, shared-box safe).
 *   health/verify    → probeHealth + verify-release-paths (D-011d + Phase-0 isolation).
 *   broadcast        → coord:send "deployed <sha>".
 *
 * Kept separate from deploy.ts so the orchestration stays light + stub-testable;
 * this file pulls the heavy operator-core deps only on the real path.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { guardResource } from '@papercusp/operator-core/lib/agent-tools/locks/resource-lock-guard';
import { describeStaleHolderVerdict } from '@papercusp/operator-core/lib/agent-tools/locks/resource-acquire-wait';
import { hostGlobalLockDomain } from '@papercusp/operator-core/lib/agent-tools/locks/coordination-domain';
import { sendMessage } from '@papercusp/operator-core/lib/agent-tools/coordination/messages';
import type { AgentIdentity } from '@papercusp/operator-core/lib/agent-tools/coordination/identity';
import { activeWorkspaceId } from '@papercusp/operator-core/lib/workspace-registry';
import { operatorHomeHarnessSlug } from '@papercusp/operator-core/lib/harness/operator-home-harness';
import { readReleaseTriggerControl as readReleaseTriggerControlRow } from '@papercusp/operator-core/lib/git-pipeline-stats';
import { readLiveReleaseCertification } from '@papercusp/operator-core/lib/release/live-release-certification';
// Side-effect: wires the operator host binding (getSql / workspacesRoot /
// admin-URL) into @papercusp/backup. The standalone deploy doesn't go through
// the operator boot path that normally triggers this, so without it the
// snapshot step throws "configureBackup() must be called before using the
// backup API" and aborts the deploy → rollback (observed 2026-06-05).
import '@papercusp/operator-core/lib/backup/configure';
import { workspaceBackupFor } from '@papercusp/backup';
import type { BackupMigrationLockWaitInfo } from '@papercusp/backup';
import { toolingRoot, type ReleaseConfig } from './release-config';
import { VERIFY_RESULT_MARKER } from './verify-release-paths';
import type { DeployDeps, SnapshotInfo } from './deploy';
import { applyStagedMigrations } from './migrate';
import { fetchServingSha, probeHealth } from './health-probe';

// EI-13729: this MUST be per-PROCESS-unique, generated ONCE at module load —
// NOT a shared static string. resource-lock-store.ts's exclusive-acquire check
// is `holders.some(h => h.mode === 'exclusive' && h.owner !== owner)`: two
// concurrent deploy-cli processes that both used the same static ownerId each
// had their acquire treated as "the same owner refreshing its own lock" and
// silently GRANTED instead of drained/refused — the root cause of the observed
// :3070 old/new-build flap (both processes believed they alone held the lock
// and raced runSetup/migrate/restart against the same shared release
// checkout). `ownerLabel` stays the stable human-readable 'release-deploy' for
// broadcasts/telemetry; only the lock-identity `ownerId` needs to be unique.
const DEPLOY_OWNER = `release-deploy:${process.pid}:${randomUUID()}`;
const DEFAULT_DRAIN_SEC = 120;

function formatWaitDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
}

/** Human-readable progress line for a healthy deploy waiting on backup/migration rendezvous. */
export function formatMigrationLockWait(
  info: BackupMigrationLockWaitInfo,
  nowMs = Date.now(),
): string {
  const holder = info.holderPid === null ? 'unknown holder' : `pid ${info.holderPid}`;
  const application = info.holderApplicationName ?? 'unknown application';
  const startedAt = info.holderQueryStartedAt ? Date.parse(info.holderQueryStartedAt) : NaN;
  const held = Number.isFinite(startedAt) && startedAt <= nowMs
    ? formatWaitDuration(nowMs - startedAt)
    : 'unknown age';
  const state = info.holderState ? `, state ${info.holderState}` : '';
  return (
    `[deploy] ▶ snapshot: waiting on advisory lock ${info.lockKey} held by ${holder} ` +
    `(${application}${state}, held ${held}; waited ${formatWaitDuration(info.waitedMs)})`
  );
}

export interface SystemdRestartCommand {
  unit: string;
  bin: string;
  args: string[];
}

/**
 * Build the command used to restart one configured systemd unit.
 *
 * A unit name uses the normal `systemctl --user restart <unit>` shape. The
 * existing release config also permits a complete command string for local
 * wrappers/tests, so preserve that form when the value contains spaces.
 */
export function systemdRestartCommand(unit: string): SystemdRestartCommand {
  const parts = unit.includes(' ')
    ? unit.split(' ')
    : ['systemctl', '--user', 'restart', unit];
  const [bin, ...args] = parts;
  if (!bin || args.length === 0 || args.every((arg) => arg === '')) {
    throw new Error(`invalid systemd restart command: ${JSON.stringify(unit)}`);
  }
  return { unit, bin, args };
}

/**
 * Return the ordered restart commands for a deploy. The background unit is
 * optional by design: an explicit empty value leaves operator-only deployments
 * unchanged, while the default config activates the long-lived worker host.
 */
export function systemdRestartCommands(
  cfg: Pick<ReleaseConfig, 'systemdUnit' | 'backgroundSystemdUnit'>,
): SystemdRestartCommand[] {
  return [cfg.systemdUnit, cfg.backgroundSystemdUnit]
    .filter((unit) => unit.length > 0)
    .map(systemdRestartCommand);
}

/**
 * EI-18674647773291145: the inverse of the `${process.pid}` embedding above —
 * extracts the pid back out of a `release-deploy:<pid>:<uuid>` owner string so a
 * blocked acquire can check whether that holder is still alive on THIS host. Any
 * other owner shape (a differently-labelled resource holder, a malformed/legacy
 * row) returns null, which is a no-op for the reclaim path — same as omitting it.
 */
export function parseDeployOwnerPid(owner: string): number | null {
  const m = /^release-deploy:(\d+):/.exec(owner);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * EI-18833814302562374: the stale-holder reclaim hook, shared by BOTH locks a
 * deploy takes. A killed deploy leaks `release-deploy` AND `dev-server` — same
 * process, same `release-deploy:<pid>:<uuid>` owner, same host-global domain —
 * so wiring the self-heal onto only one of them (as this file did) leaves the
 * other squatting for its full TTL and FATALs every subsequent deploy. Anything
 * that acquires under DEPLOY_OWNER must pass this plus `parseDeployOwnerPid`.
 */
function onStaleDeployHolderReclaimed(resource: string) {
  return async (info: {
    holder: { owner: string };
    pid: number | null;
    verdict: 'pid-dead' | 'session-ended';
  }): Promise<void> => {
    const detail =
      `reclaimed dead ${resource} holder ${info.holder.owner} (${describeStaleHolderVerdict(info)}); ` +
      `this deploy is retrying the acquire`;
    // Loud: this must never look like a normal quiet coalesce (Defect 1's "a
    // leaked lock currently looks identical to healthy single-flighting").
    console.error(`[deploy] STALE LOCK RECLAIMED — ${detail}`);
    await recordStaleLockReclaim(detail);
  };
}

/** Best-effort pipeline-history breadcrumb for a reclaim — never lets a telemetry
 *  failure affect the deploy path (mirrors `recordEvent`'s lazy import below). */
async function recordStaleLockReclaim(detail: string): Promise<void> {
  try {
    const { appendPipelineEvent } = await import(
      '@papercusp/operator-core/lib/harness/git-sync/pipeline-events'
    );
    await appendPipelineEvent({
      workspaceId: safeWorkspaceId() ?? '*',
      installSlug: process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug(),
      kind: 'deploy',
      status: 'stale-lock-reclaimed',
      detail,
    });
  } catch {
    /* best-effort */
  }
}

function deployIdentity(): AgentIdentity {
  return {
    ownerId: DEPLOY_OWNER,
    ownerLabel: 'release-deploy',
    source: 'static-client',
    workspaceId: safeWorkspaceId(),
    userId: null,
  };
}

/**
 * EI-13729: the single-flight lock around deploy-cli.ts main()'s ENTIRE
 * gather+execute flow — the one chokepoint all three deploy triggers (the
 * auto-serve release-trigger routine, a manual `deploy-cli --execute`, and
 * `release:deploy { op: 'trigger' }`) funnel through. TRY-ONLY (`maxDrainSec:
 * 0`): a concurrent attempt COALESCES (returns `acquired: false`) instead of
 * draining and then redeploying a plan that may already be stale by the time
 * it would run — see the migration registering the `release-deploy` resource
 * (libs/papercusp/packages/locks/src/sql/021-register-release-deploy-resource.sql)
 * for the full incident writeup.
 */
export async function realRunUnderDeployLock<T>(
  fn: () => Promise<T>,
): Promise<
  | { acquired: true; result: T }
  // EI-18833814302562374: `holderAlive` must stay in lockstep with the injected
  // `runUnderDeployLock` type in deploy-cli.ts — this annotation is a SECOND
  // declaration of the same contract, and updating only the other one compiles
  // nowhere but passes every test (vitest is type-blind).
  | { acquired: false; holder: string | null; holderAlive: boolean | null }
> {
  const id = deployIdentity();
  const outcome = await guardResource(
    {
      // EI-18674647773291145 Defect 2: 'release-deploy' is host-global (there is
      // one shared release checkout) — it must NOT be keyed by whichever tree
      // this process's code happened to load from (lockCoordinationDomain()),
      // or a manual deploy-cli run from the staging tree fails to serialize
      // against the operator's own :3070 process (which loads from
      // papercup-release) and locks:list run from a third tree falsely reports
      // no holders. See hostGlobalLockDomain()'s doc comment.
      coordinationDomain: hostGlobalLockDomain(),
      ownerId: id.ownerId,
      ownerLabel: id.ownerLabel,
      coordIdentity: id,
      resource: 'release-deploy',
      mode: 'exclusive',
      maxDrainSec: 0,
      reason: 'deploy-cli main() gather+execute (single-flight)',
      // EI-18674647773291145: without this, a deploy process that dies mid-flight
      // (e.g. reaped by a service restart) leaks the exclusive for its full 20-min
      // TTL — every subsequent trigger (auto-serve, manual --execute) silently
      // COALESCES and exits 0, so a green build can sit unshipped for 20 minutes
      // with no alarm. hostLocalOwnerPid resolves the pid this process itself
      // embedded in DEPLOY_OWNER; if that pid is verifiably dead on this host, the
      // stale holder is reclaimed and the acquire retried once — turning the silent
      // 20-minute outage into a sub-second self-heal.
      hostLocalOwnerPid: parseDeployOwnerPid,
      onStaleHolderReclaimed: onStaleDeployHolderReclaimed('release-deploy'),
    },
    fn,
  );
  if (outcome.acquired) return { acquired: true, result: outcome.result };
  const exclusiveHolder = outcome.holders.find((h) => h.mode === 'exclusive');
  const blocking = exclusiveHolder ?? outcome.holders[0];
  // EI-18833814302562374: report the FULL owner (`release-deploy:<pid>:<uuid>`),
  // not the `owner_label` — the label is the constant string "release-deploy",
  // which is what made the observed refusal ("holders: release-deploy") useless
  // for deciding whether anything was actually running.
  const holder = blocking?.owner ?? blocking?.owner_label ?? null;
  return { acquired: false, holder, holderAlive: hostLocalOwnerAlive(blocking?.owner) };
}

/**
 * EI-18833814302562374: is the holder's host-local pid still running?
 *   true  — running (a genuine concurrent deploy; coalescing is correct)
 *   false — verifiably gone (a LEAKED lease; the reclaim should have taken it)
 *   null  — owner carries no host-local pid, so liveness is genuinely unknowable
 * Never throws: liveness reporting must not be able to fail a deploy.
 */
function hostLocalOwnerAlive(owner: string | undefined): boolean | null {
  if (!owner) return null;
  const pid = parseDeployOwnerPid(owner);
  if (pid == null) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process. EPERM = exists but owned by another user.
    return (e as NodeJS.ErrnoException)?.code === 'ESRCH' ? false : true;
  }
}

function safeWorkspaceId(): string | null {
  try {
    return activeWorkspaceId();
  } catch {
    return null;
  }
}

/** Run a shell command, capturing stdout/stderr; reject on non-zero exit. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    // Bound the run (preflight uses this): a child that hangs at import (e.g. a
    // top-level await that never resolves) is itself a deploy-abort signal, not a
    // wedge to wait on forever. SIGKILL + reject; a fired+cleared timer is a no-op.
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        reject(new Error(`${cmd} ${args.join(' ')} timed out after ${opts.timeoutMs}ms:\n${stderr}\n${stdout}`));
      }, opts.timeoutMs);
      timer.unref?.();
    }
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      code === 0
        ? resolve({ stdout, stderr })
        // Include BOTH streams: a failing verify-paths prints its human text to
        // stderr but the machine-readable marker line to stdout — the caller
        // parses the marker out of this message on the failure path.
        : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}:\n${stderr}\n${stdout}`));
    });
  });
}

export interface RealDepsOpts {
  drainSec?: number;
  /** Skip the drain (testing / explicit). */
  noDrain?: boolean;
  log?: (s: string) => void;
}

export function realDeps(cfg: ReleaseConfig, opts: RealDepsOpts = {}): DeployDeps {
  const log = opts.log ?? ((s: string) => console.log(`[deploy] ${s}`));
  const allowRestart = process.env.PAPERCUSP_ALLOW_DEV_RESTART === '1';

  return {
    async withDrain<T>(fn: () => Promise<T>): Promise<T> {
      if (opts.noDrain) return fn();
      const id = deployIdentity();
      const outcome = await guardResource(
        {
          // EI-18676514870990022: 'dev-server' has the SAME cross-tree domain
          // defect release-deploy had (EI-18674647773291145 Defect 2) — it names
          // the one shared :3070 process, not a physical file tree, so it must
          // resolve to the fixed hostGlobalLockDomain() regardless of which
          // checkout this deploy process loaded its code from, or a manual
          // deploy-cli run from the staging tree (or dev:restart, or
          // system-health's read) would land in a different domain and silently
          // fail to serialize / see the held lock. See coordination-domain.ts's
          // HOST_GLOBAL_RESOURCES / resourceLockDomain doc comments.
          coordinationDomain: hostGlobalLockDomain(),
          ownerId: id.ownerId,
          ownerLabel: id.ownerLabel,
          coordIdentity: id,
          resource: 'dev-server',
          mode: 'exclusive',
          maxDrainSec: opts.drainSec ?? DEFAULT_DRAIN_SEC,
          reason: 'release deploy (drain before swap)',
          // EI-18833814302562374: a deploy killed mid-flight (the MCP client's
          // 300s idle abort is the reliable way to do this) leaks BOTH its locks.
          // `release-deploy` self-healed via this same hook while `dev-server`
          // did not, so the next deploy got PAST the coalesce and then died on
          // `could not acquire exclusive(dev-server): held_exclusive` for the
          // holder's full 20-min TTL. maxDrainSec does NOT cover this: the drain
          // wait applies to SHARED holders, and an exclusive conflict returns
          // immediately — so without this the waiting path had LESS recovery
          // than the no-wait one.
          hostLocalOwnerPid: parseDeployOwnerPid,
          onStaleHolderReclaimed: onStaleDeployHolderReclaimed('dev-server'),
        },
        fn,
      );
      if (!outcome.acquired) {
        throw new Error(
          `could not acquire exclusive(dev-server) to deploy: ${outcome.reason} ` +
            `(holders: ${outcome.holders.map((h) => h.owner_label ?? h.owner).join(', ') || 'none'})`,
        );
      }
      return outcome.result;
    },

    async readReleaseTriggerControl() {
      // Match the routine/pipeline event slug resolution used by this same
      // standalone deploy process. Errors propagate so the chokepoint fails an
      // ordinary deploy closed instead of treating an unreadable control as ON.
      return readReleaseTriggerControlRow(
        process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug(),
      );
    },

    async readLiveReleaseCertification(targetSha: string) {
      return readLiveReleaseCertification(targetSha);
    },

    async snapshot(reason: string): Promise<SnapshotInfo | null> {
      const ws = safeWorkspaceId();
      if (!ws) {
        log('no active workspace — snapshot skipped (rollback will be code-only)');
        return null;
      }
      const r = await workspaceBackupFor(ws).snapshot(
        'pre-deploy',
        { op: 'release-deploy', reason },
        {
          onMigrationLockWaiting: (info) => {
            log(formatMigrationLockWait(info));
          },
        },
      );
      log(`snapshot ${r.kopiaSnapshotId.slice(0, 12)} (#${r.snapshotId}, ${r.bytesAdded}B)`);
      return { snapshotId: r.snapshotId, kopiaSnapshotId: r.kopiaSnapshotId };
    },

    async runSetup(targetSha): Promise<void> {
      // P-019: script from the TOOLING tree; --integration (below) is the SUBJECT.
      const script = path.join(toolingRoot(), 'apps/operator/bin/release/setup-release-checkout.sh');
      await run('bash', [
        script,
        '--ref', targetSha,
        '--integration', cfg.integrationRoot,
        '--release', cfg.releaseRoot,
        // ALWAYS 'auto' (P-015): the git-based lockfile signal was structurally blind —
        // package-lock.json is GITIGNORED, so `git diff` could never see it (the flag was
        // permanently false). 'auto' defers to the setup script's ON-DISK comparison
        // (lockfile cmp + @papercusp/@papercup scope listing), which is the real truth.
        // ('skip' once broke the SPA build when a staging dep never reached the release
        // node_modules — 2026-06-09 @dnd-kit/core, every auto-deploy failed for hours.)
        '--node-modules', 'auto',
        // operator-vite/dist is UNTRACKED — without this the swap serves a STALE SPA
        // (server code moves, UI doesn't; bitten 2026-06-06: /admin/git was missing from
        // the deployed SPA). Deploys build it; checkpoints skip it.
        '--build-spa',
      ]);
      log(`release checkout swapped to ${targetSha.slice(0, 8)} (node_modules: auto; SPA rebuilt)`);
    },

    async migrate(deployedSha) {
      return applyStagedMigrations({
        releaseRoot: cfg.releaseRoot,
        deployedSha,
        log: (s) => log(`migrate: ${s}`),
      });
    },

    async bundleHost(): Promise<void> {
      const script = path.join(cfg.releaseRoot, 'apps/operator/bin/bundle-host.sh');
      await run('bash', [script], {
        cwd: path.join(cfg.releaseRoot, 'apps/operator'),
        timeoutMs: 10 * 60_000,
      });
      log('host bundle rebuilt from the release checkout');
    },

    async restart(): Promise<void> {
      if (!allowRestart) {
        throw new Error('restart withheld — set PAPERCUSP_ALLOW_DEV_RESTART=1 to enable the real deploy restart');
      }
      for (const command of systemdRestartCommands(cfg)) {
        await run(command.bin, command.args);
        log(`restarted ${command.unit}`);
      }
    },

    async health() {
      // WI-109: Harden the run-check to detect broken MCP before traffic cutover.
      // Probe both /api/health and POST /api/mcp initialize → 200 event-stream.
      // EI-10361: also probe the live memory recall canary (unless policy='off')
      // — 'report' (default) never fails the deploy on it; 'block' does.
      return probeHealth(cfg.operatorHealthUrl, {
        log: (s) => log(s),
        probeMcp: true,
        probeMemoryCanary: cfg.memoryCanaryPolicy !== 'off',
        memoryCanaryPolicy: cfg.memoryCanaryPolicy === 'block' ? 'block' : 'report',
      });
    },

    async servingSha() {
      return fetchServingSha(cfg.operatorHealthUrl);
    },

    async verifyPaths() {
      // Run the integration tree's verify script with cwd = the release tree, so
      // process.cwd()-based resolution checks the release checkout. (Integration
      // tsx/script are always present — avoids a first-deploy chicken-and-egg.)
      // P-019: tsx + the verify SCRIPT come from the TOOLING tree (the subject's checkout may
      // lack them); verify-release-paths.ts reads the SUBJECT release root from cfg/env.
      const tsx = path.join(toolingRoot(), 'node_modules/.bin/tsx');
      const script = path.join(toolingRoot(), 'apps/operator/lib/release/verify-release-paths.ts');
      // The verify script prints exactly one marker-delimited JSON line on
      // stdout; everything else (human text, stray PG NOTICEs from imported
      // modules) is noise we must skip. Parse the marker line, not the whole
      // stream — JSON.parse(stdout) broke on the trailing OK line (2026-06-05).
      const parseMarker = (stream: string): { ok: boolean; failures: string[] } | null => {
        const line = stream
          .split('\n')
          .find((l) => l.includes(VERIFY_RESULT_MARKER));
        if (!line) return null;
        try {
          const json = JSON.parse(line.slice(line.indexOf(VERIFY_RESULT_MARKER) + VERIFY_RESULT_MARKER.length).trim());
          return { ok: !!json.ok, failures: Array.isArray(json.failures) ? json.failures : [] };
        } catch {
          return null;
        }
      };
      try {
        const { stdout } = await run(tsx, [script, cfg.releaseRoot], {
          cwd: path.join(cfg.releaseRoot, 'apps/operator'),
          env: { PAPERCUSP_RELEASE_ROOT: cfg.releaseRoot },
        });
        const parsed = parseMarker(stdout);
        if (parsed) return parsed;
        return { ok: false, failures: [`verify-paths: no ${VERIFY_RESULT_MARKER} line in output`] };
      } catch (e) {
        // Non-zero exit = verification failed; the marker line is still on the
        // captured stdout (run() includes it in the thrown error's message).
        const msg = e instanceof Error ? e.message : String(e);
        const parsed = parseMarker(msg);
        if (parsed) return parsed;
        const m = msg.match(/"failures":\s*(\[[^\]]*\])/);
        return { ok: false, failures: m ? (JSON.parse(m[1]) as string[]) : [msg] };
      }
    },

    async preflight(): Promise<{ ok: boolean; error?: string }> {
      // Import-resolution smoke (mcp-host-availability-resilience-2026-06-22 P-001):
      // load the side-effect-free host-handler module graph (all routes + the
      // agent-tools/MCP registry) in the RELEASE checkout, resolving against ITS
      // node_modules, WITHOUT starting a server or running bootstrap. A missing /
      // incomplete dep throws MODULE_NOT_FOUND at import — caught HERE, before the
      // live :3070 cutover, instead of crash-looping systemd after the restart
      // (the documented @dnd-kit/core / setup-script entry-set-blind-spot class).
      // Mirrors the systemd launch: cwd = release apps/operator, source .env.local,
      // `npx tsx` (so it resolves exactly as the real boot will).
      const appDir = path.join(cfg.releaseRoot, 'apps/operator');
      const handlerPath = path.join(cfg.releaseRoot, 'apps/operator/bin/host-handler.ts');
      const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
      const smoke =
        `import(${JSON.stringify(handlerPath)})` +
        `.then(() => { console.log('PREFLIGHT_OK'); process.exit(0); })` +
        `.catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });`;
      const bashCmd = `set -a; [ -f .env.local ] && . ./.env.local; set +a; exec npx tsx -e ${sq(smoke)}`;
      try {
        await run('bash', ['-c', bashCmd], { cwd: appDir, timeoutMs: 90_000 });
        log('preflight: release checkout module graph resolves (host-handler imported clean) — safe to cut over');
        return { ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log(`preflight FAILED — release checkout would not boot, refusing cutover: ${error.slice(0, 400)}`);
        return { ok: false, error: error.slice(0, 1200) };
      }
    },

    async restoreSnapshot(snap: SnapshotInfo): Promise<void> {
      const ws = safeWorkspaceId();
      if (!ws) throw new Error('cannot restore snapshot: no active workspace');
      log(`restoring workspace from snapshot ${snap.kopiaSnapshotId.slice(0, 12)}`);
      await workspaceBackupFor(ws).restoreInPlace({ kopiaSnapshotId: snap.kopiaSnapshotId });
    },

    async broadcast(summary: string, body?: string): Promise<void> {
      await sendMessage(deployIdentity(), {
        to: ['*'],
        summary,
        body,
        category: 'service-health',
      });
    },

    async emitEvent(opts): Promise<void> {
      // WI-2399: the ONE real forwarder from executeDeploy's injected emit seam to
      // the await/notify bus (release:deployed / release:deploy-failed). Making
      // this a dep — instead of a hard `await import(engine)` inside executeDeploy —
      // is what closes the class EI-7287 patched per-file: TypeScript now forces a
      // DeployDeps at every call site to provide an emitter, so a unit test can't
      // fire a REAL event by forgetting to mock the engine. Lazy-imported so a
      // plain `import` of this module stays light (mirrors recordEvent below).
      const { emitAwaitedEvent } = await import(
        '@papercusp/operator-core/lib/events/await/engine'
      );
      await emitAwaitedEvent(opts);
    },

    async recordEvent(ev): Promise<void> {
      // The /admin/git deploy history (mig 177). Recorded by the DEPLOY process
      // (which survives the :3070 restart it performs) — the release-trigger
      // routine's host does not (deployer-dies-with-deployed, 2026-06-06).
      const { appendPipelineEvent } = await import(
        '@papercusp/operator-core/lib/harness/git-sync/pipeline-events'
      );
      await appendPipelineEvent({
        workspaceId: safeWorkspaceId() ?? '*',
        installSlug: process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug(),
        kind: 'deploy',
        status: ev.status,
        detail: ev.detail,
      });
    },

    log,
  };
}
