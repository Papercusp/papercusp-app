/**
 * Rig-state preflight for the P-505 physical drill
 * (physical-drill-iteration-speed-2026-09-29 P-003, plan R-5).
 *
 * Every check here is a P-505 guard-rail fact turned into an executable
 * refusal. Each one names a rig fault that has already cost a full 18-26 min
 * physical run, and each is a read-only question that answers in seconds. The
 * probe runs `physical-drill-producer rig-preflight` before its first rig ssh,
 * so a known-bad rig is refused with the check's name instead of discovered
 * mid-phase.
 *
 * Nothing here mutates the rig. A check that cannot be evaluated FAILS (the
 * reason says so): an unmeasured guard rail is not a passed one.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { projectDirForSlug } from '../../operator-notes';
import { listCommsTrust, type CommsTrustEntry } from '../../trust/comms-trust';
import { listIntegrationRequests, type IntegrationRequest } from './integration-requests';
import { physicalDrillTarget } from './physical-drill-phase-a';
import { PHASE_D_TIER_HOLD_NOTE_PREFIX, PHASE_D_TIER_HOLD_TIER, PHASE_D_WORKSPACE } from './physical-drill-phase-d';
import { readPhysicalPhaseEMode } from './physical-drill-phase-e';
import { defaultRunGit, hiveGitRepoPath } from './storage';
import { WORKTREE_STAGING_REF } from './worktree-bridge';

export const PHYSICAL_DRILL_PREFLIGHT_SCHEMA = 'hive-git-physical-rig-preflight/v1' as const;

/** Stable check ids. They appear in refusals, facts' recheck commands and `--check`. */
export const PHYSICAL_DRILL_PREFLIGHT_CHECKS = [
  'drill-source-committed',
  'canary-mode-baseline',
  'vm-trust-hold-ready',
  'vm-payload-current',
  'hosts-answering',
  'integration-queue-clear',
] as const;
export type PhysicalDrillPreflightCheckId = (typeof PHYSICAL_DRILL_PREFLIGHT_CHECKS)[number];

/** Greppable refusal marker the probe and the scenario logs key on. */
export const PHYSICAL_DRILL_PREFLIGHT_FAILED = 'PHYSICAL_PREFLIGHT_FAILED' as const;

/** The pot-git module family the VM stages from HEAD via `git archive`. */
export const DRILL_SOURCE_DIR = 'packages/operator-core/lib/sync/pot-git' as const;
/** The Phase D module whose HEAD must carry the live-file-lock fix (WI-10003741). */
export const DRILL_PHASE_D_SOURCE = `${DRILL_SOURCE_DIR}/physical-drill-phase-d.ts` as const;
/** Lock owner prefix `dirtyPhysicalPhaseDWorktree` takes; absent in HEAD = the VM runs the pre-fix Phase D. */
export const DRILL_PHASE_D_LOCK_OWNER_MARKER = 'p505-phase-d:' as const;
/**
 * The pin the probe hands the preflight (p2p-public-release-endgame-2026-09-01#D-086):
 * the superproject commit both hosts run, and the run-private tower snapshot cut from
 * it. Both set = PINNED (verify the snapshot the run executes against that commit;
 * live-tree dirt is irrelevant because it is not part of the run). Neither set =
 * UNPINNED (a standalone preflight: the live tree must be committed). Exactly one set
 * is a wiring fault and fails the check.
 */
export const DRILL_SOURCE_SHA_ENV = 'PHYSICAL_DRILL_SOURCE_SHA' as const;
export const DRILL_TOWER_SOURCE_ENV = 'PHYSICAL_DRILL_TOWER_SOURCE' as const;

/** The canary's recorded original mode (bridged since 2026-07-17; fact guard-rail:p505-phase-e-baseline-and-exit-trap). */
export const DRILL_CANARY_BASELINE_MODE = 'bridged' as const;

/** The VM ssh target comes from the probe (`PCUSP_VM_SSH`); this module hardcodes no host or home path. */
export const DRILL_VM_SSH_ENV = 'PCUSP_VM_SSH' as const;
/** Expanded by the VM's own shell: compose-rig-sidecar-current.sh pushes to ~/rig-sidecar-current there. */
export const DRILL_VM_PAYLOAD_DIR_DEFAULT = '"$HOME/rig-sidecar-current"' as const;
export const DRILL_OWNER_PORT = 3070 as const;
const HARNESS_SU_REL = 'harness/blueprints/base/prompts/su.md';

export type PhysicalDrillPreflightResult = {
  check: PhysicalDrillPreflightCheckId;
  ok: boolean;
  /** Why it failed, or what it confirmed. */
  reason: string;
};

export type PhysicalDrillPreflightReport = {
  schemaVersion: typeof PHYSICAL_DRILL_PREFLIGHT_SCHEMA;
  ok: boolean;
  checks: PhysicalDrillPreflightCheckId[];
  results: PhysicalDrillPreflightResult[];
  firstFailure: PhysicalDrillPreflightResult | null;
  elapsedMs: number;
  observedAt: string;
};

/** Parsed output of the single read-only VM ssh round-trip. */
export type VmPayloadProbe = {
  /** `serveSha256` / `harnessSuSha256` from the VM payload's BUILD-STAMP.txt ('' when absent). */
  stampServeSha256: string;
  stampHarnessSuSha256: string;
  /** Actual hashes of the VM payload's serve.mjs and harness su.md ('' when unreadable). */
  serveSha256: string;
  harnessSuSha256: string;
  /** HTTP status of the VM owner's /api/health ('000' when it did not answer). */
  ownerHealthStatus: string;
};

export type TowerComposedStamp = { serveSha256: string; harnessSuSha256: string; composedAt: string };

/** Repo-relative path -> git blob id, restricted to drill source (see isDrillSourcePath). */
export type DrillSourceBlobs = ReadonlyMap<string, string>;

/** What `drill-source-committed` judges; gathered by observeDrillSource. */
export type DrillSourceObservation =
  | {
      /** The probe pinned the run: judge the snapshot it EXECUTES against the commit it names. */
      pinned: true;
      sha: string;
      commitBlobs: DrillSourceBlobs;
      executedBlobs: DrillSourceBlobs;
      /** Phase D at the pinned commit, or null when the commit has no such path. */
      phaseD: string | null;
    }
  | {
      /** No pin (a standalone preflight): the live tree is what a run would stage. */
      pinned: false;
      /** Porcelain status lines for uncommitted/untracked paths under the drill source dir. */
      statusLines: readonly string[];
      /** Phase D at HEAD, or null when HEAD has no such path. */
      phaseD: string | null;
    };

/**
 * What `integration-queue-clear` judges, read on the tower (the integrator) for the
 * drill target's store and worktree.
 */
export type IntegrationBaselineObservation = {
  /** `<pot home>/<repo key>`, for the refusal text. */
  target: string;
  /** refs/hive/staging in the tower's store; null when the integrator never advanced it. */
  canonicalStagingOid: string | null;
  worktreeHeadOid: string | null;
  /** The worktree HEAD is canonical staging or an ancestor of it (so a bridge can fast-forward it). */
  worktreeContained: boolean;
  /** Pending ratify-queue rows whose head a device still publishes and staging does not contain. */
  blockedHeads: ReadonlyArray<{ devicePubkey: string; headSha: string; reason: string }>;
};

export type PhysicalDrillPreflightDeps = {
  observeIntegrationBaseline?: () => Promise<IntegrationBaselineObservation>;
  listTrust?: () => Promise<CommsTrustEntry[]>;
  readCanaryMode?: () => Promise<{ mode: string; source: string }>;
  /** Gathers the drill-source observation (pinned or unpinned; D-086). */
  observeDrillSource?: () => Promise<DrillSourceObservation>;
  /** Receives the VM owner port the run targets. */
  probeVm?: (vmOwnerPort: number) => Promise<VmPayloadProbe>;
  readTowerStamp?: () => Promise<TowerComposedStamp | null>;
  /** Receives the tower owner port the run targets. */
  towerHealthStatus?: (towerPort: number) => Promise<number>;
  nowMs?: () => number;
};

export type PhysicalDrillPreflightOptions = {
  checks?: readonly PhysicalDrillPreflightCheckId[];
  /** The VM device's GitHub user. Unknown ⇒ every trust row is held to the VM rule (conservative). */
  vmGithubUserId?: number | null;
  expectedCanaryMode?: string;
  /**
   * The owner ports hosts-answering (and the VM probe's health read) target. The physical rig
   * runs both owners on DRILL_OWNER_PORT; the same-box rig (plan physical-drill-iteration-speed
   * D-003) runs two throwaway owners on this box, so rig-profile.sh passes their ports — without
   * them the check would read the LIVE operator on :3070 and report a rig that is down as up.
   */
  towerPort?: number;
  vmOwnerPort?: number;
};

// ── pure evaluations (one per check; null = satisfied) ──────────────────────

/** Drill source = the non-test TypeScript the producer imports; test edits never change a run. */
export function isDrillSourcePath(path: string): boolean {
  return path.endsWith('.ts') && !path.endsWith('.test.ts');
}

function phaseDViolation(where: string, phaseD: string | null): string | null {
  if (phaseD === null) return `${where} has no ${DRILL_PHASE_D_SOURCE}`;
  if (!phaseD.includes(DRILL_PHASE_D_LOCK_OWNER_MARKER)) {
    return (
      `${where} ${DRILL_PHASE_D_SOURCE} lacks the Phase D dirt lock (owner '${DRILL_PHASE_D_LOCK_OWNER_MARKER}<runId>', ` +
      `WI-10003741); a VM git-sync would sweep the planted file`
    );
  }
  return null;
}

/**
 * The drill source a run executes must be the source a commit names (D-086).
 * PINNED: the tower snapshot must equal the pinned commit, file for file (the VM
 * stages that same commit, so the two hosts then run identical bytes); the live
 * tree is not consulted, because its edits are not part of the run. UNPINNED: the
 * live tree must have no uncommitted drill source (a run would stage HEAD).
 */
export function drillSourceViolation(observed: DrillSourceObservation): string | null {
  if (!observed.pinned) {
    const dirty = observed.statusLines
      .map((line) => line.slice(3).trim())
      .map((path) => (path.includes(' -> ') ? path.split(' -> ')[1]! : path))
      .filter(isDrillSourcePath);
    if (dirty.length > 0) {
      return (
        `uncommitted drill source (unpinned preflight: a run would stage HEAD via git archive, so it would run ` +
        `different code): ${dirty.join(', ')} — wait for git-sync or fire git-sync:run, then re-run`
      );
    }
    return phaseDViolation('HEAD', observed.phaseD);
  }
  const short = observed.sha.slice(0, 12);
  const missing: string[] = [];
  const differing: string[] = [];
  for (const [path, blob] of observed.commitBlobs) {
    const executed = observed.executedBlobs.get(path);
    if (executed === undefined) missing.push(path);
    else if (executed !== blob) differing.push(path);
  }
  const extra = [...observed.executedBlobs.keys()].filter((path) => !observed.commitBlobs.has(path));
  if (missing.length + differing.length + extra.length > 0) {
    const parts = [
      differing.length ? `differing: ${differing.join(', ')}` : '',
      missing.length ? `missing: ${missing.join(', ')}` : '',
      extra.length ? `extra: ${extra.join(', ')}` : '',
    ].filter(Boolean);
    return (
      `the tower snapshot does not match pinned commit ${short} (${parts.join('; ')}); ` +
      `the run would execute drill source no commit names`
    );
  }
  if (observed.commitBlobs.size === 0) return `pinned commit ${short} has no drill source under ${DRILL_SOURCE_DIR}`;
  return phaseDViolation(`pinned commit ${short}`, observed.phaseD);
}

/** A crashed run leaves the canary in legacy; the next run would record legacy as the "original" and never restore bridged. */
export function canaryModeViolation(read: { mode: string; source: string }, expected: string): string | null {
  if (read.mode === expected) return null;
  return (
    `canary hello-world-3-pot mode is '${read.mode}' (source ${read.source}), expected baseline '${expected}' — ` +
    `a prior Phase E did not restore it; set it back with phase-e-mode-ensure ${expected} <run-id>`
  );
}

/**
 * Phase D can only hold the VM author below steer when (a) no earlier hold is
 * still in place — a leftover would be snapshotted as the "prior" row and the
 * restore would lose steer for good — and (b) the VM user's row is not
 * gate-only, which `holdPhysicalPhaseDBelowSteer` refuses mid-phase because it
 * cannot restore a NULL tier exactly.
 */
export function trustHoldViolation(
  entries: readonly CommsTrustEntry[],
  vmGithubUserId: number | null,
  nowMs: number,
): string | null {
  const leftover = entries.filter(
    (entry) => entry.tier === PHASE_D_TIER_HOLD_TIER && (entry.note ?? '').startsWith(PHASE_D_TIER_HOLD_NOTE_PREFIX),
  );
  if (leftover.length > 0) {
    const described = leftover.map((entry) => {
      const run = (entry.note ?? '').slice(PHASE_D_TIER_HOLD_NOTE_PREFIX.length).trim().split(';')[0] || 'unknown run';
      const expiry =
        entry.expiresAtMs == null
          ? 'no expiry'
          : entry.expiresAtMs > nowMs
            ? `expires ${new Date(entry.expiresAtMs).toISOString()}`
            : `lapsed ${new Date(entry.expiresAtMs).toISOString()}`;
      return `github user ${entry.githubUserId} held at '${entry.tier}' by ${run} (${expiry})`;
    });
    return (
      `a Phase D below-steer hold was never restored: ${described.join('; ')} — run phase-d-tier-restore on that ` +
      `run's phase-d-tier-hold.json, or put the prior comms-trust row back, before another hold snapshots it as "prior"`
    );
  }
  const gateOnly = entries.filter(
    (entry) => entry.tier === null && (vmGithubUserId === null || entry.githubUserId === vmGithubUserId),
  );
  if (gateOnly.length > 0) {
    return (
      `gate-only comms-trust row for github user ${gateOnly.map((entry) => entry.githubUserId).join(', ')}` +
      `${vmGithubUserId === null ? ' (VM user unknown, so every row is checked)' : ''}: Phase D cannot hold ` +
      `a NULL tier and restore it exactly — give the row an explicit tier first`
    );
  }
  return null;
}

/** The VM must run the payload the tower last composed, and that payload must be internally consistent. */
export function vmPayloadViolation(vm: VmPayloadProbe, tower: TowerComposedStamp | null): string | null {
  if (!vm.stampServeSha256 || !vm.stampHarnessSuSha256) {
    return 'VM payload BUILD-STAMP.txt is missing or lacks serveSha256/harnessSuSha256 — recompose with compose-rig-sidecar-current.sh';
  }
  if (vm.serveSha256 !== vm.stampServeSha256) {
    return `VM serve.mjs (${vm.serveSha256 || 'unreadable'}) differs from its BUILD-STAMP (${vm.stampServeSha256})`;
  }
  if (vm.harnessSuSha256 !== vm.stampHarnessSuSha256) {
    return (
      `VM harness su.md (${vm.harnessSuSha256 || 'unreadable'}) differs from its BUILD-STAMP ` +
      `(${vm.stampHarnessSuSha256}) — current code against a stale harness (WI-10003486)`
    );
  }
  if (!tower) {
    return 'no tower-composed BUILD-STAMP to compare against — run compose-rig-sidecar-current.sh so the expected build is known';
  }
  if (vm.stampServeSha256 !== tower.serveSha256 || vm.stampHarnessSuSha256 !== tower.harnessSuSha256) {
    return (
      `VM payload is not the build the tower last composed (${tower.composedAt || 'unknown time'}): ` +
      `serve ${vm.stampServeSha256.slice(0, 12)} vs ${tower.serveSha256.slice(0, 12)}, ` +
      `harness ${vm.stampHarnessSuSha256.slice(0, 12)} vs ${tower.harnessSuSha256.slice(0, 12)} — push the composed payload`
    );
  }
  return null;
}

export function hostsViolation(
  towerStatus: number,
  vmOwnerStatus: string,
  ports: { towerPort?: number; vmOwnerPort?: number } = {},
): string | null {
  const towerPort = ports.towerPort ?? DRILL_OWNER_PORT;
  const vmOwnerPort = ports.vmOwnerPort ?? DRILL_OWNER_PORT;
  const down: string[] = [];
  if (towerStatus !== 200) down.push(`tower :${towerPort}/api/health answered ${towerStatus || 'nothing'}`);
  if (vmOwnerStatus !== '200') down.push(`VM owner :${vmOwnerPort}/api/health answered ${vmOwnerStatus || 'nothing'}`);
  return down.length > 0 ? `${down.join('; ')} — start the owner before a run` : null;
}

/**
 * Phase D waits for the tower worktree to reach the run-bound staging head. It can
 * only get there by fast-forward, so the drill must start with every member head
 * already absorbed into canonical staging. Two states make that impossible, and
 * neither heals on its own: a member head the integrator holds in its ratify queue
 * (an author below the steer tier is never integrated automatically), and a tower
 * worktree carrying a commit staging does not contain.
 * Measured: same-box run 12 (WI-10003976) started with both owners' rig-up heads
 * queued `below-steer-tier`; Phase D ratified only its own head, so the tower
 * worktree stayed on its unabsorbed commit and the phase burned its 20-minute
 * convergence budget on 'lagging worktree'.
 */
export function integrationBaselineViolation(observed: IntegrationBaselineObservation): string | null {
  if (!observed.canonicalStagingOid) {
    return (
      `the tower's ${observed.target} store has no canonical staging (${WORKTREE_STAGING_REF}) — the integrator ` +
      'never advanced it, so no phase has a head to converge on; let git-sync integrate the member heads first'
    );
  }
  const problems: string[] = [];
  if (observed.blockedHeads.length > 0) {
    const heads = observed.blockedHeads
      .map((head) => `${head.devicePubkey.slice(0, 12)}@${head.headSha.slice(0, 12)} (${head.reason})`)
      .join(', ');
    problems.push(
      `the tower integrator holds ${observed.blockedHeads.length} member head(s) in its ratify queue that staging ` +
        `${observed.canonicalStagingOid.slice(0, 12)} does not contain: ${heads}`,
    );
  }
  if (!observed.worktreeContained) {
    problems.push(
      `the tower worktree HEAD ${(observed.worktreeHeadOid ?? 'unreadable').slice(0, 12)} is not contained in ` +
        `canonical staging ${observed.canonicalStagingOid.slice(0, 12)}, so Phase D's tower convergence can never reach the run-bound head`,
    );
  }
  if (problems.length === 0) return null;
  return (
    `${problems.join('; ')} — raise the member to steer (trust:comms set) or ratify the queued heads, ` +
    'then let git-sync integrate them before a run'
  );
}

// ── default gatherers (read-only) ───────────────────────────────────────────

export type IntegrationBaselineDeps = {
  repoPath?: string;
  worktreePath?: string;
  listPending?: () => Promise<IntegrationRequest[]>;
};

/** Read-only: git reads on the tower's store and worktree, one ratify-queue read. */
export async function observeIntegrationBaseline(deps: IntegrationBaselineDeps = {}): Promise<IntegrationBaselineObservation> {
  const target = physicalDrillTarget();
  const repoPath = deps.repoPath ?? hiveGitRepoPath(target.potHome, target.repoKey);
  // Explicit workspace: the default resolves to an empty registry under a bare rig-profile
  // env (measured on same-box rig r13), and the ratify queue below is read in this workspace.
  const worktreePath = deps.worktreePath ?? (await projectDirForSlug(target.gitSyncSlug, PHASE_D_WORKSPACE));
  if (!worktreePath) throw new Error(`cannot resolve the ${target.gitSyncSlug} worktree`);
  const rev = async (cwd: string, ref: string): Promise<string | null> => {
    const result = await defaultRunGit(['rev-parse', '--verify', '-q', `${ref}^{commit}`], cwd);
    return result.code === 0 ? result.stdout.trim() || null : null;
  };
  const staging = await rev(repoPath, WORKTREE_STAGING_REF);
  // A commit the store never received is not contained (merge-base exits non-zero on it).
  const contained = async (sha: string): Promise<boolean> =>
    staging !== null &&
    (sha === staging || (await defaultRunGit(['merge-base', '--is-ancestor', sha, staging], repoPath)).code === 0);
  const worktreeHeadOid = await rev(worktreePath, 'HEAD');
  const published = await defaultRunGit(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/namespaces/'], repoPath);
  const current = new Set(
    published.stdout
      .split('\n')
      .filter((line) => line.includes('/refs/heads/'))
      .map((line) => line.split(' ')[0]),
  );
  const pending = deps.listPending
    ? await deps.listPending()
    : await listIntegrationRequests({
        workspaceId: PHASE_D_WORKSPACE,
        potSlug: target.potHome,
        repoKey: target.repoKey,
        state: 'pending',
        limit: 500,
      });
  const blockedHeads: IntegrationBaselineObservation['blockedHeads'][number][] = [];
  for (const request of pending) {
    // A row whose head no device publishes any more is not gated by the integrator.
    if (request.state !== 'pending' || !current.has(request.headSha) || (await contained(request.headSha))) continue;
    blockedHeads.push({ devicePubkey: request.devicePubkey, headSha: request.headSha, reason: request.reason });
  }
  return {
    target: `${target.potHome}/${target.repoKey}`,
    canonicalStagingOid: staging,
    worktreeHeadOid,
    worktreeContained: worktreeHeadOid !== null && (await contained(worktreeHeadOid)),
    blockedHeads,
  };
}

const execFileAsync = promisify(execFile);
/** Read per call: the probe exports PAPERCUSP_REPO_DIR, and tests point it at a temp repo. */
const repoRoot = () =>
  process.env.PAPERCUSP_REPO_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

async function git(args: readonly string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot(), ...args], { timeout: 20_000, maxBuffer });
  return stdout;
}

async function readCommitFile(ref: string, path: string): Promise<string | null> {
  try {
    return await git(['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/** The git blob id of `bytes` — what `git ls-tree` reports for the same content. */
export function gitBlobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function listCommitBlobs(sha: string, dir: string): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  for (const line of (await git(['ls-tree', '-r', '--full-tree', sha, '--', dir])).split('\n')) {
    const match = line.match(/^\d+ blob ([0-9a-f]{40})\t(.+)$/);
    if (match && isDrillSourcePath(match[2]!)) blobs.set(match[2]!, match[1]!);
  }
  return blobs;
}

async function hashTreeBlobs(root: string, dir: string): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  let entries: string[];
  try {
    entries = await readdir(join(root, dir), { recursive: true });
  } catch {
    return blobs; // an absent snapshot dir reports every commit file as missing
  }
  for (const rel of entries) {
    const path = `${dir}/${rel.split(sep).join('/')}`;
    if (!isDrillSourcePath(path)) continue;
    const abs = join(root, path);
    const stat = await lstat(abs);
    if (stat.isSymbolicLink()) blobs.set(path, gitBlobId(Buffer.from(await readlink(abs))));
    else if (stat.isFile()) blobs.set(path, gitBlobId(await readFile(abs)));
  }
  return blobs;
}

/** Resolves the D-086 pin from the environment the probe exports; see DRILL_SOURCE_SHA_ENV. */
export async function observeDrillSource(env: NodeJS.ProcessEnv = process.env): Promise<DrillSourceObservation> {
  const sha = env[DRILL_SOURCE_SHA_ENV] ?? '';
  const towerSource = env[DRILL_TOWER_SOURCE_ENV] ?? '';
  if (!sha && !towerSource) {
    const [status, phaseD] = await Promise.all([
      git(['status', '--porcelain=v1', '--untracked-files=all', '--', DRILL_SOURCE_DIR], 4 * 1024 * 1024),
      readCommitFile('HEAD', DRILL_PHASE_D_SOURCE),
    ]);
    return { pinned: false, statusLines: status.split('\n').filter((line) => line.length > 3), phaseD };
  }
  if (!sha || !towerSource) {
    throw new Error(`${DRILL_SOURCE_SHA_ENV} and ${DRILL_TOWER_SOURCE_ENV} must be set together (D-086 pin)`);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${DRILL_SOURCE_SHA_ENV} is not a full commit sha: '${sha}'`);
  const [commitBlobs, executedBlobs, phaseD] = await Promise.all([
    listCommitBlobs(sha, DRILL_SOURCE_DIR),
    hashTreeBlobs(towerSource, DRILL_SOURCE_DIR),
    readCommitFile(sha, DRILL_PHASE_D_SOURCE),
  ]);
  return { pinned: true, sha, commitBlobs, executedBlobs, phaseD };
}

/** One ssh, read-only: the VM payload's stamp, its actual hashes, and the owner's health status. */
export function vmPayloadProbeCommand(payloadDir?: string, vmOwnerPort: number = DRILL_OWNER_PORT): string {
  const d = payloadDir ? `'${payloadDir.replace(/'/g, `'\\''`)}'` : DRILL_VM_PAYLOAD_DIR_DEFAULT;
  if (!Number.isInteger(vmOwnerPort) || vmOwnerPort < 1 || vmOwnerPort > 65535) {
    throw new Error(`vmPayloadProbeCommand: VM owner port ${vmOwnerPort} is not a TCP port`);
  }
  return [
    `grep -E '^(serveSha256|harnessSuSha256)=' ${d}/BUILD-STAMP.txt 2>/dev/null | sed 's/^/stamp./'`,
    `printf 'serve=%s\\n' "$(shasum -a 256 ${d}/serve.mjs 2>/dev/null | awk '{print $1}')"`,
    `printf 'harness=%s\\n' "$(shasum -a 256 ${d}/${HARNESS_SU_REL} 2>/dev/null | awk '{print $1}')"`,
    `printf 'health=%s\\n' "$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:${vmOwnerPort}/api/health)"`,
  ].join('; ');
}

export function parseVmPayloadProbe(stdout: string): VmPayloadProbe {
  const fields = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return {
    stampServeSha256: fields.get('stamp.serveSha256') ?? '',
    stampHarnessSuSha256: fields.get('stamp.harnessSuSha256') ?? '',
    serveSha256: fields.get('serve') ?? '',
    harnessSuSha256: fields.get('harness') ?? '',
    ownerHealthStatus: fields.get('health') || '000',
  };
}

async function defaultProbeVm(vmOwnerPort: number): Promise<VmPayloadProbe> {
  const vm = process.env[DRILL_VM_SSH_ENV];
  if (!vm) throw new Error(`${DRILL_VM_SSH_ENV} is unset; the probe passes the VM ssh target`);
  const payloadDir = process.env.PCUSP_RIG_SIDECAR_DIR || undefined;
  const { stdout } = await execFileAsync(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'StrictHostKeyChecking=no',
      vm,
      vmPayloadProbeCommand(payloadDir, vmOwnerPort),
    ],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return parseVmPayloadProbe(stdout);
}

export function parseBuildStamp(text: string): TowerComposedStamp {
  const value = (key: string) => text.match(new RegExp(`^${key}=(\\S+)`, 'm'))?.[1] ?? '';
  return {
    serveSha256: value('serveSha256'),
    harnessSuSha256: value('harnessSuSha256'),
    composedAt: text.match(/composedAt=(\S+)/)?.[1] ?? '',
  };
}

async function defaultReadTowerStamp(): Promise<TowerComposedStamp | null> {
  const out =
    process.env.PCUSP_RIG_COMPOSE_OUT ||
    join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'papercusp', 'rig-sidecar-current');
  try {
    return parseBuildStamp(await readFile(join(out, 'BUILD-STAMP.txt'), 'utf8'));
  } catch {
    return null;
  }
}

async function defaultTowerHealthStatus(towerPort: number): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${towerPort}/api/health`, { signal: AbortSignal.timeout(5_000) });
    return response.status;
  } catch {
    return 0;
  }
}

// ── runner ──────────────────────────────────────────────────────────────────

export async function runPhysicalDrillPreflight(
  options: PhysicalDrillPreflightOptions = {},
  deps: PhysicalDrillPreflightDeps = {},
): Promise<PhysicalDrillPreflightReport> {
  const started = Date.now();
  const now = deps.nowMs ?? Date.now;
  const checks = options.checks && options.checks.length > 0 ? [...options.checks] : [...PHYSICAL_DRILL_PREFLIGHT_CHECKS];
  const vmGithubUserId = options.vmGithubUserId ?? null;
  const expectedMode = options.expectedCanaryMode ?? DRILL_CANARY_BASELINE_MODE;
  const towerPort = options.towerPort ?? DRILL_OWNER_PORT;
  const vmOwnerPort = options.vmOwnerPort ?? DRILL_OWNER_PORT;
  // vm-payload-current and hosts-answering share ONE ssh round-trip.
  let vmProbe: Promise<VmPayloadProbe> | null = null;
  const probeVm = () => (vmProbe ??= (deps.probeVm ?? defaultProbeVm)(vmOwnerPort));

  const evaluate: Record<PhysicalDrillPreflightCheckId, () => Promise<string | null>> = {
    'drill-source-committed': async () =>
      drillSourceViolation(await (deps.observeDrillSource ?? (() => observeDrillSource()))()),
    'canary-mode-baseline': async () =>
      canaryModeViolation(await (deps.readCanaryMode ?? (() => readPhysicalPhaseEMode()))(), expectedMode),
    'vm-trust-hold-ready': async () =>
      trustHoldViolation(await (deps.listTrust ?? (() => listCommsTrust(PHASE_D_WORKSPACE)))(), vmGithubUserId, now()),
    'vm-payload-current': async () =>
      vmPayloadViolation(await probeVm(), await (deps.readTowerStamp ?? defaultReadTowerStamp)()),
    'hosts-answering': async () => {
      const [tower, vm] = await Promise.all([
        (deps.towerHealthStatus ?? defaultTowerHealthStatus)(towerPort),
        probeVm().then((probe) => probe.ownerHealthStatus),
      ]);
      return hostsViolation(tower, vm, { towerPort, vmOwnerPort });
    },
    'integration-queue-clear': async () =>
      integrationBaselineViolation(await (deps.observeIntegrationBaseline ?? (() => observeIntegrationBaseline()))()),
  };

  const results = await Promise.all(
    checks.map(async (check): Promise<PhysicalDrillPreflightResult> => {
      try {
        const violation = await evaluate[check]();
        return { check, ok: violation === null, reason: violation ?? 'ok' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { check, ok: false, reason: `could not be evaluated (an unmeasured guard rail is not a pass): ${message}` };
      }
    }),
  );
  const firstFailure = results.find((result) => !result.ok) ?? null;
  return {
    schemaVersion: PHYSICAL_DRILL_PREFLIGHT_SCHEMA,
    ok: firstFailure === null,
    checks,
    results,
    firstFailure,
    elapsedMs: Date.now() - started,
    observedAt: new Date(now()).toISOString(),
  };
}

export const PHYSICAL_DRILL_PREFLIGHT_USAGE =
  `usage: physical-drill-producer rig-preflight [--check <${PHYSICAL_DRILL_PREFLIGHT_CHECKS.join('|')}>]... ` +
  '[--vm-github-user-id <n>] [--tower-port <port>] [--vm-port <port>]';

function parsePort(value: string | undefined): number | null {
  if (!/^[1-9][0-9]{0,4}$/.test(value ?? '')) return null;
  const port = Number(value);
  return port <= 65535 ? port : null;
}

export function parsePhysicalDrillPreflightArgs(args: readonly string[]): PhysicalDrillPreflightOptions {
  const checks: PhysicalDrillPreflightCheckId[] = [];
  let vmGithubUserId: number | null = null;
  const ports: { towerPort?: number; vmOwnerPort?: number } = {};
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    const port = parsePort(value);
    if (flag === '--check' && (PHYSICAL_DRILL_PREFLIGHT_CHECKS as readonly string[]).includes(value ?? '')) {
      checks.push(value as PhysicalDrillPreflightCheckId);
    } else if (flag === '--vm-github-user-id' && /^[1-9][0-9]{0,11}$/.test(value ?? '')) {
      vmGithubUserId = Number(value);
    } else if (flag === '--tower-port' && port !== null) {
      ports.towerPort = port;
    } else if (flag === '--vm-port' && port !== null) {
      ports.vmOwnerPort = port;
    } else {
      throw new Error(PHYSICAL_DRILL_PREFLIGHT_USAGE);
    }
  }
  return { checks, vmGithubUserId, ...ports };
}

/**
 * The producer's `rig-preflight` mode: the report on success; on refusal an
 * error whose FIRST line is `PHYSICAL_PREFLIGHT_FAILED <check>: <reason>` (the
 * CLI prints it to stderr and exits 1), followed by any further failures.
 */
export async function physicalDrillPreflightMode(
  args: readonly string[],
  deps: PhysicalDrillPreflightDeps = {},
): Promise<PhysicalDrillPreflightReport> {
  const report = await runPhysicalDrillPreflight(parsePhysicalDrillPreflightArgs(args), deps);
  if (!report.ok) {
    throw new Error(
      report.results
        .filter((result) => !result.ok)
        .map((result) => `${PHYSICAL_DRILL_PREFLIGHT_FAILED} ${result.check}: ${result.reason}`)
        .join('\n'),
    );
  }
  return report;
}
