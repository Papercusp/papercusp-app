/**
 * Fixed production-spine adapter for P-505 physical Phase E / P-306.
 *
 * Phase E is deliberately not a second bridge implementation. The checked-in
 * scenario flips the fixed canary through `setPotGitMode`, fires the canonical
 * `git-sync:run` action on both physical hosts, and observes the routine row
 * written by `runGithubBridgeLeg`. This adapter only supplies fixed, run-bound
 * remote mutations plus exact observations and a strict causal validator.
 * Caller-selected commands, repositories, refs, and remote URLs are absent.
 */
import { getOrgPg } from '@papercusp/db-org';
import { waitForConvergence } from '@papercusp/verification-harness';
import { loadHarnessRegistry } from '../../harness-registry';
import { parseGithubUrl } from '../../harness/clone-github';
import { fetchRepoPushPermission } from '../../harness/github-repo-permissions';
import { checkGitSyncStall } from '../../release/git-sync-stall-watchdog';
import { getPotGitMode, readPotGitMode, setPotGitMode, type PotGitMode } from '../../harness/git-sync/hive-git-mode';
import { BRIDGE_CANONICAL_REF, BRIDGE_REMOTE_STAGING_REF } from './github-bridge-tick';
import { GITHUB_BRIDGE_ESCALATION_PHASE } from './github-divergence';
import { defaultRunGit, hiveGitRepoPath, type RunGit } from './storage';
import {
  PHASE_A_POT_HOME,
  PHASE_A_REPO_KEY,
  physicalDrillGitSyncSlug,
  type PhysicalDrillGitSyncSlug,
} from './physical-drill-phase-a';
import { PHASE_D_WORKSPACE, type PhysicalPhaseDHost } from './physical-drill-phase-d';

export const PHASE_E_INPUT_SCHEMA = 'hive-git-physical-phase-e-input/v1' as const;
export const PHASE_E_RESULT_SCHEMA = 'hive-git-physical-phase-e-result/v1' as const;
export const PHASE_E_OBSERVATION_SCHEMA = 'hive-git-physical-phase-e-observation/v1' as const;
export const PHASE_E_MUTATION_SCHEMA = 'hive-git-physical-phase-e-mutation/v1' as const;
export const PHASE_E_MODE_CHANGE_SCHEMA = 'hive-git-physical-phase-e-mode-change/v1' as const;
export const PHASE_E_WATCHDOG_SCHEMA = 'hive-git-physical-phase-e-watchdog/v1' as const;
export const PHASE_E_RECOVERY_SCHEMA = 'hive-git-physical-phase-e-recovery/v1' as const;
export const PHASE_E_PREFLIGHT_SCHEMA = 'hive-git-physical-phase-e-preflight/v1' as const;
export const PHASE_E_PLAN_ITEM = 'P-306' as const;

const RUN_ID = /^[A-Za-z0-9._-]{8,120}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DEVICE_KEY = /^[A-Za-z0-9+/]{43}=$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const GIT_SYNC_WATCHDOG_PHASE = 'git-sync-watchdog';

export type PhysicalPhaseEHost = PhysicalPhaseDHost;
export type PhysicalPhaseEObservationStage =
  | 'legacy-before'
  | 'bridged-member'
  | 'healthy-egress'
  | 'divergence-before'
  | 'divergence-after'
  | 'legacy-after';

/**
 * The mode each observation stage must show. The VM learns the tower's mode
 * write by federation, so a one-shot read races propagation; an observation
 * waits (bounded) for its stage's mode, then captures whatever it sees and the
 * validator judges it (WI-10003791).
 */
export const PHASE_E_STAGE_MODE: Readonly<Record<PhysicalPhaseEObservationStage, 'legacy' | 'bridged'>> = {
  'legacy-before': 'legacy',
  'bridged-member': 'bridged',
  'healthy-egress': 'bridged',
  'divergence-before': 'bridged',
  'divergence-after': 'bridged',
  'legacy-after': 'legacy',
};
export const PHASE_E_MODE_WAIT_MAX_MS = 20 * 60_000;
export const PHASE_E_MODE_POLL_MS = 5_000;
export const PHASE_E_MODE_READ_SCHEMA = 'hive-git-physical-phase-e-mode-read/v1' as const;
export const PHASE_E_MODE_ENSURE_SCHEMA = 'hive-git-physical-phase-e-mode-ensure/v1' as const;
export const PHASE_E_MODE_AWAIT_SCHEMA = 'hive-git-physical-phase-e-mode-await/v1' as const;

export type PhysicalPhaseETrigger = {
  tool: 'git-sync:run';
  installSlug: PhysicalDrillGitSyncSlug;
  host: PhysicalPhaseEHost;
  role: 'tower-member' | 'vm-member' | 'healthy-ingress' | 'healthy-integrate' | 'healthy-egress' | 'divergence-egress' | 'rollback-observe';
  fired: true;
  startedAt: string;
  finishedAt: string;
};

export type PhysicalPhaseEModeChange = {
  schemaVersion: typeof PHASE_E_MODE_CHANGE_SCHEMA;
  runId: string;
  hostId: 'tower';
  tool: 'setPotGitMode';
  from: 'legacy' | 'bridged';
  to: 'legacy' | 'bridged';
  workspaceId: typeof PHASE_D_WORKSPACE;
  potHomeSlug: typeof PHASE_A_POT_HOME;
  observedAt: string;
};

/**
 * The writer-backed whole-fire marker (`routines.metadata.git_sync_activity`).
 * git-sync writes `active:false` + a terminal phase only after the GitHub
 * bridge and P2P post-legs, so it is the one field that says a fire's effects,
 * including `github_bridge`, are all persisted. Epoch ms on the writer's clock.
 */
export type PhysicalPhaseEFire = {
  active: boolean;
  phase: string | null;
  startedAt: number | null;
  completedAt: number | null;
  outcomeStatus: string | null;
};

export type PhysicalPhaseERoutine = {
  active: boolean;
  lastFiredAt: string | null;
  pushMode: string | null;
  lastStatus: string | null;
  lastPushed: string[];
  headSha: string | null;
  watchdogAlerted: boolean;
  watchdogErrorSweeps: number;
  watchdogStallSweeps: number;
  githubBridge: null | {
    at: number | null;
    ran: boolean;
    skipped: string | null;
    egressTarget: string | null;
    lastAdmitted: string | null;
    egressHead: string | null;
    divergence: string | null;
    needsOwner: boolean;
    errors: string[];
  };
  fire: PhysicalPhaseEFire | null;
};

export type PhysicalPhaseEObservation = {
  schemaVersion: typeof PHASE_E_OBSERVATION_SCHEMA;
  runId: string;
  hostId: PhysicalPhaseEHost;
  deviceKey: string;
  stage: PhysicalPhaseEObservationStage;
  observedAt: string;
  mode: { value: PotGitMode; source: 'set' | 'absent' | 'malformed' | 'error' };
  routine: PhysicalPhaseERoutine;
  refs: {
    canonicalStaging: string | null;
    upstreamDefault: string | null;
    remoteStaging: string | null;
  };
  bridgeEscalation: Record<string, unknown> | null;
  watchdogEscalation: Record<string, unknown> | null;
  /** Present when the observation waited for a fire started at/after `since` to finish. Diagnostic only. */
  waitedForFire?: { since: string; reached: boolean; waitedMs: number };
};

export type PhysicalPhaseERemoteMutation = {
  schemaVersion: typeof PHASE_E_MUTATION_SCHEMA;
  runId: string;
  kind: 'ingress' | 'fork-ahead';
  hostId: 'tower';
  method: 'fixed-empty-commit-ff-push';
  remoteRole: 'upstream' | 'fork';
  remoteRef: string;
  baseOid: string;
  canonicalOid: string;
  headOid: string;
  createdAt: string;
};

export type PhysicalPhaseERemoteRecovery = {
  schemaVersion: typeof PHASE_E_RECOVERY_SCHEMA;
  runId: string;
  hostId: 'tower';
  method: 'fixed-force-with-lease-restore';
  remoteRef: typeof BRIDGE_REMOTE_STAGING_REF;
  expectedDivergenceOid: string;
  restoredOid: string;
  observedRemoteOid: string;
  observedAt: string;
};

export type PhysicalPhaseEWatchdogSweep = {
  schemaVersion: typeof PHASE_E_WATCHDOG_SCHEMA;
  runId: string;
  hostId: 'tower';
  ordinal: 1 | 2;
  tool: 'checkGitSyncStall';
  startedAt: string;
  finishedAt: string;
  fixedRoutineActive: boolean;
  fixedPushMode: string | null;
  fixedWatchdogAlerted: boolean;
  fixedWatchdogErrorSweeps: number;
  fixedWatchdogStallSweeps: number;
  alarmed: string[];
  recovered: string[];
};

export type PhysicalPhaseERemotePreflight = {
  schemaVersion: typeof PHASE_E_PREFLIGHT_SCHEMA;
  ready: true;
  potHomeSlug: typeof PHASE_A_POT_HOME;
  defaultBranch: string;
  refs: {
    canonicalStaging: string;
    upstreamDefault: string;
    forkStaging: string;
  };
  permissions: {
    upstreamPush: true;
    forkPush: true;
  };
};

export type PhysicalPhaseEInput = {
  schemaVersion: typeof PHASE_E_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  before: { tower: PhysicalPhaseEObservation; vm: PhysicalPhaseEObservation };
  activation: {
    modeChange: PhysicalPhaseEModeChange;
    towerTrigger: PhysicalPhaseETrigger;
    vmTrigger: PhysicalPhaseETrigger;
    tower: PhysicalPhaseEObservation;
    vm: PhysicalPhaseEObservation;
  };
  healthy: {
    ingressMutation: PhysicalPhaseERemoteMutation;
    ingressTrigger: PhysicalPhaseETrigger;
    integrateTrigger: PhysicalPhaseETrigger;
    egressTrigger: PhysicalPhaseETrigger;
    observation: PhysicalPhaseEObservation;
  };
  watchdogSweeps: [PhysicalPhaseEWatchdogSweep, PhysicalPhaseEWatchdogSweep];
  divergence: {
    before: PhysicalPhaseEObservation;
    mutation: PhysicalPhaseERemoteMutation;
    trigger: PhysicalPhaseETrigger;
    after: PhysicalPhaseEObservation;
    recovery: PhysicalPhaseERemoteRecovery;
  };
  rollback: {
    modeChange: PhysicalPhaseEModeChange;
    towerTrigger: PhysicalPhaseETrigger;
    vmTrigger: PhysicalPhaseETrigger;
    tower: PhysicalPhaseEObservation;
    vm: PhysicalPhaseEObservation;
  };
};

export type PhysicalPhaseEVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_E_RESULT_SCHEMA;
    phase: 'E';
    planItem: typeof PHASE_E_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
    assertions: {
      bothHostsConsumedFederatedBridgedMode: true;
      bothMembersWereCommitOnlyAndDirectPushedNothing: true;
      ingressAdvancedAdmissionWatermark: true;
      canonicalDescendedFromAdmittedIngress: true;
      bridgeAloneFastForwardedRemoteStaging: true;
      twoProductionWatchdogSweepsStayedQuiet: true;
      forkAheadWasRefusedWithoutCanonicalMutation: true;
      controlledRemoteRecoveryAndLegacyRollbackObserved: true;
    };
    oids: { ingress: string; admitted: string; canonical: string; divergence: string; restored: string };
  };
};

type OrgSql = ReturnType<typeof getOrgPg>['sql'];
type RemoteContext = { repoPath: string; upstream: string; fork: string; defaultBranch: string };
type PhaseEDeps = {
  sql?: OrgSql;
  runGit?: RunGit;
  remoteContext?: RemoteContext;
  loadRegistry?: () => Promise<{
    projects: Array<{
      slug: string;
      github_remote?: string;
      fork_remote?: string;
      github_default_branch?: string;
    }>;
  }>;
  fetchPushPermission?: (owner: string, repo: string) => Promise<boolean | null>;
  getMode?: typeof getPotGitMode;
  setMode?: typeof setPotGitMode;
  readMode?: typeof readPotGitMode;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type PhysicalPhaseEModeRead = {
  schemaVersion: typeof PHASE_E_MODE_READ_SCHEMA;
  workspaceId: typeof PHASE_D_WORKSPACE;
  potHomeSlug: typeof PHASE_A_POT_HOME;
  mode: PotGitMode;
  source: 'set' | 'absent' | 'malformed' | 'error';
  observedAt: string;
};

/**
 * The drill's own baseline/restore write. It is deliberately NOT evidence: the
 * validated legacy→bridged→legacy cycle still goes through setPhysicalPhaseEMode.
 */
export type PhysicalPhaseEModeEnsure = {
  schemaVersion: typeof PHASE_E_MODE_ENSURE_SCHEMA;
  runId: string;
  hostId: 'tower';
  tool: 'setPotGitMode';
  workspaceId: typeof PHASE_D_WORKSPACE;
  potHomeSlug: typeof PHASE_A_POT_HOME;
  from: PotGitMode;
  to: 'legacy' | 'bridged';
  changed: boolean;
  observedAt: string;
};

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`physical Phase E runId is invalid: ${runId}`);
}

function assertDeviceKey(deviceKey: string): void {
  if (!DEVICE_KEY.test(deviceKey) || Buffer.from(deviceKey, 'base64').length !== 32) {
    throw new Error('physical Phase E requires a raw 32-byte Ed25519 device key in base64');
  }
}

async function fixedRemoteContext(deps: PhaseEDeps = {}): Promise<RemoteContext> {
  if (deps.remoteContext) return deps.remoteContext;
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const entry = (await loadRegistry()).projects.find((project) => project.slug === PHASE_A_POT_HOME);
  if (!entry?.github_remote || !entry.fork_remote) {
    throw new Error(`physical Phase E fixed canary ${PHASE_A_POT_HOME} requires both upstream and fork remotes`);
  }
  return {
    repoPath: hiveGitRepoPath(PHASE_A_POT_HOME, PHASE_A_REPO_KEY),
    upstream: entry.github_remote,
    fork: entry.fork_remote,
    defaultBranch: entry.github_default_branch ?? 'main',
  };
}

/** The fixed canary's local bare store; needs no remote config (a member has none for the fork). */
function fixedRepoPath(deps: PhaseEDeps = {}): string {
  return deps.remoteContext?.repoPath ?? hiveGitRepoPath(PHASE_A_POT_HOME, PHASE_A_REPO_KEY);
}

async function git(runGit: RunGit, cwd: string, args: string[]): Promise<string> {
  const result = await runGit(args, cwd, { timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(`physical Phase E git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function rev(runGit: RunGit, cwd: string, ref: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  const oid = result.stdout.trim();
  return result.code === 0 && OID.test(oid) ? oid : null;
}

async function remoteRef(runGit: RunGit, cwd: string, remote: string, ref: string): Promise<string | null> {
  const result = await runGit(['ls-remote', '--refs', remote, ref], cwd, { timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(`physical Phase E cannot read fixed remote ${ref}: ${result.stderr.trim()}`);
  const oid = result.stdout.trim().split(/\s+/)[0] ?? '';
  return OID.test(oid) ? oid : null;
}

/**
 * Fail closed on every fixed Phase E remote prerequisite before the outer
 * physical wrapper makes its first SSH call. This is intentionally read-only:
 * registry + authenticated permission reads, local rev-parse, and ls-remote.
 */
export async function preflightPhysicalPhaseERemotes(
  deps: Pick<PhaseEDeps, 'runGit' | 'remoteContext' | 'loadRegistry' | 'fetchPushPermission'> = {},
): Promise<PhysicalPhaseERemotePreflight> {
  const runGit = deps.runGit ?? defaultRunGit;
  const context = await fixedRemoteContext(deps);
  const upstreamRepo = parseGithubUrl(context.upstream);
  const forkRepo = parseGithubUrl(context.fork);
  if (!upstreamRepo || !forkRepo) {
    throw new Error(`physical Phase E fixed canary ${PHASE_A_POT_HOME} requires parseable GitHub upstream and fork remotes`);
  }

  const fetchPushPermission = deps.fetchPushPermission ?? fetchRepoPushPermission;
  const [upstreamPush, forkPush] = await Promise.all([
    fetchPushPermission(upstreamRepo.owner, upstreamRepo.repo),
    fetchPushPermission(forkRepo.owner, forkRepo.repo),
  ]);
  if (upstreamPush !== true) {
    throw new Error(`physical Phase E upstream push permission is ${upstreamPush === false ? 'denied' : 'unverified'}`);
  }
  if (forkPush !== true) {
    throw new Error(`physical Phase E fork push permission is ${forkPush === false ? 'denied' : 'unverified'}`);
  }

  const upstreamDefaultRef = `refs/heads/${context.defaultBranch}`;
  const [canonicalStaging, upstreamDefault, forkStaging] = await Promise.all([
    rev(runGit, context.repoPath, BRIDGE_CANONICAL_REF),
    remoteRef(runGit, context.repoPath, context.upstream, upstreamDefaultRef),
    remoteRef(runGit, context.repoPath, context.fork, BRIDGE_REMOTE_STAGING_REF),
  ]);
  if (!canonicalStaging) throw new Error('physical Phase E fixed canonical staging ref is absent');
  if (!upstreamDefault) throw new Error(`physical Phase E fixed upstream ${upstreamDefaultRef} is absent`);
  if (!forkStaging) throw new Error(`physical Phase E fixed fork ${BRIDGE_REMOTE_STAGING_REF} is absent`);
  if (forkStaging !== canonicalStaging) {
    throw new Error('physical Phase E fixed fork staging must equal canonical staging before the drill');
  }

  return {
    schemaVersion: PHASE_E_PREFLIGHT_SCHEMA,
    ready: true,
    potHomeSlug: PHASE_A_POT_HOME,
    defaultBranch: context.defaultBranch,
    refs: { canonicalStaging, upstreamDefault, forkStaging },
    permissions: { upstreamPush: true, forkPush: true },
  };
}

async function routine(sql: OrgSql): Promise<PhysicalPhaseERoutine> {
  const rows = await sql<Array<{ active: boolean; last_fired_at: Date | string | null; metadata: Record<string, unknown> | null }>>`
    SELECT active, last_fired_at, metadata
      FROM harness_shared.routines
     WHERE workspace_id = ${PHASE_D_WORKSPACE}
       AND install_slug = ${PHASE_A_POT_HOME}
       AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  const row = rows[0];
  const metadata = row?.metadata ?? {};
  const bridge = metadata.github_bridge && typeof metadata.github_bridge === 'object'
    ? metadata.github_bridge as Record<string, unknown>
    : null;
  const activity = metadata.git_sync_activity && typeof metadata.git_sync_activity === 'object'
    ? metadata.git_sync_activity as Record<string, unknown>
    : null;
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const integer = (value: unknown): number => Number.isSafeInteger(Number(value)) ? Number(value) : 0;
  const epoch = (value: unknown): number | null =>
    value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    active: row?.active === true,
    lastFiredAt: row?.last_fired_at ? new Date(row.last_fired_at).toISOString() : null,
    pushMode: typeof metadata.push_mode === 'string' ? metadata.push_mode : null,
    lastStatus: typeof metadata.last_status === 'string' ? metadata.last_status : null,
    lastPushed: strings(metadata.last_pushed),
    headSha: typeof metadata.head_sha === 'string' ? metadata.head_sha : null,
    watchdogAlerted: metadata.watchdog_alerted === true,
    watchdogErrorSweeps: integer(metadata.wd_error_sweeps),
    watchdogStallSweeps: integer(metadata.wd_stall_sweeps),
    githubBridge: bridge ? {
      at: Number.isFinite(Number(bridge.at)) ? Number(bridge.at) : null,
      ran: bridge.ran === true,
      skipped: typeof bridge.skipped === 'string' ? bridge.skipped : null,
      egressTarget: typeof bridge.egress_target === 'string' ? bridge.egress_target : null,
      lastAdmitted: typeof bridge.last_admitted === 'string' ? bridge.last_admitted : null,
      egressHead: typeof bridge.egress_head === 'string' ? bridge.egress_head : null,
      divergence: typeof bridge.divergence === 'string' ? bridge.divergence : null,
      needsOwner: bridge.needs_owner === true,
      errors: strings(bridge.errors),
    } : null,
    fire: activity ? {
      active: activity.active !== false,
      phase: typeof activity.phase === 'string' ? activity.phase : null,
      startedAt: epoch(activity.started_at),
      completedAt: epoch(activity.completed_at),
      outcomeStatus: typeof activity.outcome_status === 'string' ? activity.outcome_status : null,
    } : null,
  };
}

/**
 * True when the routine row shows a FINISHED git-sync fire that started at or
 * after `sinceMs`. `git-sync:run` answers `in_progress` after 45s while the fire
 * keeps running, and the bridge leg persists `github_bridge` near the end of it,
 * so a single read right after the call can capture the previous fire's verdict.
 * The 0.0.25 shakedown did exactly that: divergence-after read `divergence:clear`
 * about 20ms before the triggered fire wrote `escalate` (WI-10004055).
 */
export function finishedFireStartedSince(routineRow: PhysicalPhaseERoutine, sinceMs: number): boolean {
  const fire = routineRow.fire;
  return !!fire && !fire.active && fire.startedAt !== null && fire.startedAt >= sinceMs;
}

async function escalation(sql: OrgSql, phase: string): Promise<Record<string, unknown> | null> {
  const rows = await sql<Array<{ escalation: string | Record<string, unknown> | null }>>`
    SELECT escalation
      FROM harness_shared.harness_escalations
     WHERE workspace_id = ${PHASE_D_WORKSPACE}
       AND harness_slug = ${PHASE_A_POT_HOME}
       AND phase = ${phase}
     LIMIT 1
  `;
  const raw = rows[0]?.escalation;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return { malformed: raw }; }
  }
  return raw;
}

/** Fixed mode flip. The returned record is the evidence of the production write surface used. */
export async function setPhysicalPhaseEMode(input: { runId: string; mode: 'legacy' | 'bridged' }, deps: PhaseEDeps = {}): Promise<PhysicalPhaseEModeChange> {
  assertRunId(input.runId);
  const getMode = deps.getMode ?? getPotGitMode;
  const setMode = deps.setMode ?? setPotGitMode;
  const sql = deps.sql ?? (deps.getMode && deps.setMode ? undefined : getOrgPg().sql);
  const from = await getMode(PHASE_D_WORKSPACE, PHASE_A_POT_HOME, sql);
  const expectedFrom: PhysicalPhaseEModeChange['from'] = input.mode === 'bridged' ? 'legacy' : 'bridged';
  if (from !== expectedFrom) {
    throw new Error(`physical Phase E mode flip requires ${expectedFrom} before ${input.mode}; observed ${from}`);
  }
  await setMode(PHASE_D_WORKSPACE, PHASE_A_POT_HOME, input.mode, sql);
  const after = await getMode(PHASE_D_WORKSPACE, PHASE_A_POT_HOME, sql);
  if (after !== input.mode) throw new Error(`physical Phase E mode flip did not persist ${input.mode}`);
  return {
    schemaVersion: PHASE_E_MODE_CHANGE_SCHEMA,
    runId: input.runId,
    hostId: 'tower',
    tool: 'setPotGitMode',
    from,
    to: after,
    workspaceId: PHASE_D_WORKSPACE,
    potHomeSlug: PHASE_A_POT_HOME,
    observedAt: new Date().toISOString(),
  };
}

function stageModeReached(
  mode: { mode: PotGitMode; source: PhysicalPhaseEModeRead['source'] },
  stage: PhysicalPhaseEObservationStage,
): boolean {
  const expected = PHASE_E_STAGE_MODE[stage];
  return mode.mode === expected && (expected !== 'bridged' || mode.source === 'set');
}

/**
 * Poll the local mode row until it shows the stage's mode or `waitMs` runs out,
 * then return the last read. A timeout is not an error here: the observation
 * records what the host saw and validatePhysicalPhaseE judges it.
 */
export async function awaitPhysicalPhaseEStageMode(
  input: { stage: PhysicalPhaseEObservationStage; waitMs: number },
  deps: Pick<PhaseEDeps, 'sql' | 'readMode' | 'sleep' | 'now'> = {},
): Promise<{ mode: PotGitMode; source: PhysicalPhaseEModeRead['source'] }> {
  if (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > PHASE_E_MODE_WAIT_MAX_MS) {
    throw new Error(`physical Phase E mode wait must be an integer 0..${PHASE_E_MODE_WAIT_MAX_MS}ms`);
  }
  const read = deps.readMode ?? readPotGitMode;
  // The shared convergence helper (PDS P-004): read now, re-read until the stage's mode shows.
  const result = await waitForConvergence({
    what: `physical Phase E ${input.stage} mode`,
    observe: () => read(PHASE_D_WORKSPACE, PHASE_A_POT_HOME, deps.sql),
    lagging: (mode) => (stageModeReached(mode, input.stage) ? [] : [`mode=${mode.mode} (${mode.source})`]),
    budgetMs: input.waitMs,
    pollMs: PHASE_E_MODE_POLL_MS,
    maxBudgetMs: PHASE_E_MODE_WAIT_MAX_MS,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  return result.value;
}

export type PhysicalPhaseEModeAwait = {
  schemaVersion: typeof PHASE_E_MODE_AWAIT_SCHEMA;
  workspaceId: string;
  potHomeSlug: string;
  stage: PhysicalPhaseEObservationStage;
  expected: 'legacy' | 'bridged';
  mode: PotGitMode;
  source: PhysicalPhaseEModeRead['source'];
  waitedMs: number;
  observedAt: string;
};

/**
 * Gate a member's git-sync tick on the stage's mode having reached this host.
 * The tower writes the mode row and the VM learns it by federation, so the VM
 * tick that follows a flip can run in the previous mode. Unlike the observation
 * wait, a timeout here throws: the tick would measure the wrong mode, and the
 * scenario must stop before firing it (WI-10003791 second race).
 */
export async function requirePhysicalPhaseEStageMode(
  input: { stage: PhysicalPhaseEObservationStage; waitMs: number },
  deps: Pick<PhaseEDeps, 'sql' | 'readMode' | 'sleep' | 'now'> = {},
): Promise<PhysicalPhaseEModeAwait> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const mode = await awaitPhysicalPhaseEStageMode(input, deps);
  const waitedMs = now() - startedAt;
  const expected = PHASE_E_STAGE_MODE[input.stage];
  if (!stageModeReached(mode, input.stage)) {
    throw new Error(
      `physical Phase E ${input.stage}: this host still reads hiveGit.mode=${mode.mode} (${mode.source}) after ${waitedMs}ms; ` +
        `expected ${expected}${expected === 'bridged' ? ' (set)' : ''}. The mode flip has not federated here, so a git-sync tick now would run in the wrong mode.`,
    );
  }
  return {
    schemaVersion: PHASE_E_MODE_AWAIT_SCHEMA,
    workspaceId: PHASE_D_WORKSPACE,
    potHomeSlug: PHASE_A_POT_HOME,
    stage: input.stage,
    expected,
    mode: mode.mode,
    source: mode.source,
    waitedMs,
    observedAt: new Date().toISOString(),
  };
}

/** Read the fixed canary's mode row as-is (the scenario records it before any baseline write). */
export async function readPhysicalPhaseEMode(deps: Pick<PhaseEDeps, 'sql' | 'readMode'> = {}): Promise<PhysicalPhaseEModeRead> {
  const read = deps.readMode ?? readPotGitMode;
  const sql = deps.sql ?? (deps.readMode ? undefined : getOrgPg().sql);
  const mode = await read(PHASE_D_WORKSPACE, PHASE_A_POT_HOME, sql);
  return {
    schemaVersion: PHASE_E_MODE_READ_SCHEMA,
    workspaceId: PHASE_D_WORKSPACE,
    potHomeSlug: PHASE_A_POT_HOME,
    mode: mode.mode,
    source: mode.source,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Idempotent mode write for the drill's own baseline and restore. The fixed
 * canary keeps whatever mode the hive chose (hello-world-3-pot has been
 * bridged since 2026-07-17), so the drill establishes the legacy start its
 * contract needs and puts the original mode back afterwards (WI-10003791).
 * Only legacy/bridged are touched; any other mode is the hive's and is refused.
 */
export async function ensurePhysicalPhaseEMode(
  input: { runId: string; mode: 'legacy' | 'bridged' },
  deps: PhaseEDeps = {},
): Promise<PhysicalPhaseEModeEnsure> {
  assertRunId(input.runId);
  const getMode = deps.getMode ?? getPotGitMode;
  const setMode = deps.setMode ?? setPotGitMode;
  const sql = deps.sql ?? (deps.getMode && deps.setMode ? undefined : getOrgPg().sql);
  const from = await getMode(PHASE_D_WORKSPACE, PHASE_A_POT_HOME, sql);
  if (from !== 'legacy' && from !== 'bridged') {
    throw new Error(`physical Phase E refuses to change the canary out of mode ${from}`);
  }
  if (from !== input.mode) {
    await setMode(PHASE_D_WORKSPACE, PHASE_A_POT_HOME, input.mode, sql);
    const after = await getMode(PHASE_D_WORKSPACE, PHASE_A_POT_HOME, sql);
    if (after !== input.mode) throw new Error(`physical Phase E mode ensure did not persist ${input.mode}`);
  }
  return {
    schemaVersion: PHASE_E_MODE_ENSURE_SCHEMA,
    runId: input.runId,
    hostId: 'tower',
    tool: 'setPotGitMode',
    workspaceId: PHASE_D_WORKSPACE,
    potHomeSlug: PHASE_A_POT_HOME,
    from,
    to: input.mode,
    changed: from !== input.mode,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Poll the fixed routine row until a git-sync fire that started at or after
 * `sinceMs` has finished, or the deadline passes. A timeout is not an error:
 * the observation records what the host saw and validatePhysicalPhaseE judges it.
 */
async function awaitFinishedFireSince(
  sql: OrgSql,
  sinceMs: number,
  deadline: number,
  deps: Pick<PhaseEDeps, 'sleep' | 'now'>,
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  // The shared convergence helper (PDS P-004); the budget is what is left of the caller's.
  const result = await waitForConvergence({
    what: 'physical Phase E git-sync fire finished since the judged start',
    observe: async () => finishedFireStartedSince(await routine(sql), sinceMs),
    lagging: (reached) => (reached ? [] : ['no finished git-sync fire started at/after the judged start']),
    budgetMs: Math.min(Math.max(0, deadline - now()), PHASE_E_MODE_WAIT_MAX_MS),
    pollMs: PHASE_E_MODE_POLL_MS,
    maxBudgetMs: PHASE_E_MODE_WAIT_MAX_MS,
    now,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  return result.value;
}

/**
 * Capture fixed production routine/ref/escalation state on one physical host.
 * `afterFireStartedAt` (the ISO start of the git-sync:run call this stage
 * judges) makes the capture wait, within the same `waitMs` budget as the mode
 * wait, until a fire started at or after it has finished, so the observation
 * shows that fire's verdict and not the previous one (WI-10004055).
 */
export async function capturePhysicalPhaseEObservation(
  input: {
    runId: string;
    hostId: PhysicalPhaseEHost;
    deviceKey: string;
    stage: PhysicalPhaseEObservationStage;
    waitMs?: number;
    afterFireStartedAt?: string;
  },
  deps: PhaseEDeps = {},
): Promise<PhysicalPhaseEObservation> {
  assertRunId(input.runId);
  assertDeviceKey(input.deviceKey);
  const fireSinceMs = input.afterFireStartedAt === undefined ? null : Date.parse(input.afterFireStartedAt);
  if (fireSinceMs !== null && (!ISO_INSTANT.test(input.afterFireStartedAt ?? '') || !Number.isFinite(fireSinceMs))) {
    throw new Error('physical Phase E afterFireStartedAt must be an ISO-8601 UTC instant (the git-sync:run trigger start)');
  }
  const sql = deps.sql ?? getOrgPg().sql;
  const runGit = deps.runGit ?? defaultRunGit;
  const now = deps.now ?? Date.now;
  const waitStartedAt = now();
  const waitMs = input.waitMs ?? 0;
  // Only the tower is the bridge writer. A member joined by invite carries no
  // fork remote, and validatePhysicalPhaseE never reads a member's remote refs,
  // so the VM records them as null instead of requiring bridge config.
  const context = input.hostId === 'tower' ? await fixedRemoteContext(deps) : null;
  const repoPath = context?.repoPath ?? fixedRepoPath(deps);
  const mode = await awaitPhysicalPhaseEStageMode({ stage: input.stage, waitMs }, { ...deps, sql });
  const waitedForFire = fireSinceMs === null
    ? undefined
    : {
        since: new Date(fireSinceMs).toISOString(),
        reached: await awaitFinishedFireSince(sql, fireSinceMs, waitStartedAt + waitMs, deps),
        waitedMs: now() - waitStartedAt,
      };
  return {
    schemaVersion: PHASE_E_OBSERVATION_SCHEMA,
    runId: input.runId,
    hostId: input.hostId,
    deviceKey: input.deviceKey,
    stage: input.stage,
    observedAt: new Date().toISOString(),
    mode: { value: mode.mode, source: mode.source },
    routine: await routine(sql),
    refs: {
      canonicalStaging: await rev(runGit, repoPath, BRIDGE_CANONICAL_REF),
      upstreamDefault: context
        ? await remoteRef(runGit, repoPath, context.upstream, `refs/heads/${context.defaultBranch}`)
        : null,
      remoteStaging: context ? await remoteRef(runGit, repoPath, context.fork, BRIDGE_REMOTE_STAGING_REF) : null,
    },
    bridgeEscalation: await escalation(sql, GITHUB_BRIDGE_ESCALATION_PHASE),
    watchdogEscalation: await escalation(sql, GIT_SYNC_WATCHDOG_PHASE),
    ...(waitedForFire ? { waitedForFire } : {}),
  };
}

async function createRemoteMutation(
  input: { runId: string; kind: 'ingress' | 'fork-ahead' },
  deps: PhaseEDeps = {},
): Promise<PhysicalPhaseERemoteMutation> {
  assertRunId(input.runId);
  const runGit = deps.runGit ?? defaultRunGit;
  const context = await fixedRemoteContext(deps);
  const canonical = await rev(runGit, context.repoPath, BRIDGE_CANONICAL_REF);
  if (!canonical) throw new Error('physical Phase E fixed canonical staging ref is absent');
  const remoteRole = input.kind === 'ingress' ? 'upstream' : 'fork';
  const remote = remoteRole === 'upstream' ? context.upstream : context.fork;
  const remoteRefName = input.kind === 'ingress' ? `refs/heads/${context.defaultBranch}` : BRIDGE_REMOTE_STAGING_REF;
  const base = input.kind === 'ingress'
    ? await remoteRef(runGit, context.repoPath, remote, remoteRefName)
    : await remoteRef(runGit, context.repoPath, remote, remoteRefName);
  if (!base) throw new Error(`physical Phase E fixed ${remoteRole} ${remoteRefName} is absent`);
  if (input.kind === 'fork-ahead' && base !== canonical) {
    throw new Error('physical Phase E divergence control requires fork staging to equal canonical before arming');
  }
  if (!(await rev(runGit, context.repoPath, base))) {
    await git(runGit, context.repoPath, ['fetch', '--no-tags', remote, base]);
  }
  const tree = await git(runGit, context.repoPath, ['rev-parse', `${base}^{tree}`]);
  const head = await git(runGit, context.repoPath, [
    '-c', 'user.name=Papercusp Physical Drill',
    '-c', 'user.email=physical-drill@papercusp.local',
    'commit-tree', tree, '-p', base, '-m', `physical-phase-e ${input.kind} ${input.runId}`,
  ]);
  if (!OID.test(head)) throw new Error('physical Phase E commit-tree returned an invalid oid');
  await git(runGit, context.repoPath, ['push', remote, `${head}:${remoteRefName}`]);
  const observed = await remoteRef(runGit, context.repoPath, remote, remoteRefName);
  if (observed !== head) throw new Error(`physical Phase E ${remoteRole} mutation did not land`);
  return {
    schemaVersion: PHASE_E_MUTATION_SCHEMA,
    runId: input.runId,
    kind: input.kind,
    hostId: 'tower',
    method: 'fixed-empty-commit-ff-push',
    remoteRole,
    remoteRef: remoteRefName,
    baseOid: base,
    canonicalOid: canonical,
    headOid: head,
    createdAt: new Date().toISOString(),
  };
}

export const createPhysicalPhaseEIngress = (input: { runId: string }, deps: PhaseEDeps = {}): Promise<PhysicalPhaseERemoteMutation> =>
  createRemoteMutation({ runId: input.runId, kind: 'ingress' }, deps);

export const createPhysicalPhaseEDivergence = (input: { runId: string }, deps: PhaseEDeps = {}): Promise<PhysicalPhaseERemoteMutation> =>
  createRemoteMutation({ runId: input.runId, kind: 'fork-ahead' }, deps);

/** Restore only the exact fork-ahead mutation this run created, guarded by force-with-lease. */
export async function restorePhysicalPhaseEDivergence(
  mutation: PhysicalPhaseERemoteMutation,
  deps: PhaseEDeps = {},
): Promise<PhysicalPhaseERemoteRecovery> {
  if (
    mutation.schemaVersion !== PHASE_E_MUTATION_SCHEMA || mutation.kind !== 'fork-ahead' ||
    mutation.remoteRole !== 'fork' || mutation.remoteRef !== BRIDGE_REMOTE_STAGING_REF
  ) throw new Error('physical Phase E recovery requires the fixed fork-ahead mutation record');
  assertRunId(mutation.runId);
  const runGit = deps.runGit ?? defaultRunGit;
  const context = await fixedRemoteContext(deps);
  await git(runGit, context.repoPath, [
    'push', `--force-with-lease=${BRIDGE_REMOTE_STAGING_REF}:${mutation.headOid}`,
    context.fork, `${mutation.canonicalOid}:${BRIDGE_REMOTE_STAGING_REF}`,
  ]);
  const observed = await remoteRef(runGit, context.repoPath, context.fork, BRIDGE_REMOTE_STAGING_REF);
  if (observed !== mutation.canonicalOid) throw new Error('physical Phase E controlled fork recovery did not restore canonical');
  return {
    schemaVersion: PHASE_E_RECOVERY_SCHEMA,
    runId: mutation.runId,
    hostId: 'tower',
    method: 'fixed-force-with-lease-restore',
    remoteRef: BRIDGE_REMOTE_STAGING_REF,
    expectedDivergenceOid: mutation.headOid,
    restoredOid: mutation.canonicalOid,
    observedRemoteOid: observed,
    observedAt: new Date().toISOString(),
  };
}

/** Execute the production watchdog and bind its outcome to the fixed canary routine. */
export async function runPhysicalPhaseEWatchdogSweep(
  input: { runId: string; ordinal: 1 | 2 },
  deps: PhaseEDeps = {},
): Promise<PhysicalPhaseEWatchdogSweep> {
  assertRunId(input.runId);
  const sql = deps.sql ?? getOrgPg().sql;
  const startedAt = new Date().toISOString();
  const outcome = await checkGitSyncStall(sql);
  const fixed = await routine(sql);
  return {
    schemaVersion: PHASE_E_WATCHDOG_SCHEMA,
    runId: input.runId,
    hostId: 'tower',
    ordinal: input.ordinal,
    tool: 'checkGitSyncStall',
    startedAt,
    finishedAt: new Date().toISOString(),
    fixedRoutineActive: fixed.active,
    fixedPushMode: fixed.pushMode,
    fixedWatchdogAlerted: fixed.watchdogAlerted,
    fixedWatchdogErrorSweeps: fixed.watchdogErrorSweeps,
    fixedWatchdogStallSweeps: fixed.watchdogStallSweeps,
    alarmed: outcome.alarmed,
    recovered: outcome.recovered,
  };
}

function ms(value: string, label: string, errors: string[]): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) errors.push(`${label} must be ISO-8601`);
  return parsed;
}

function validateTrigger(trigger: PhysicalPhaseETrigger, role: PhysicalPhaseETrigger['role'], host: PhysicalPhaseEHost, window: { start: number; finish: number }, errors: string[]): void {
  if (trigger.tool !== 'git-sync:run' || trigger.installSlug !== physicalDrillGitSyncSlug(host) || trigger.fired !== true || trigger.role !== role || trigger.host !== host) {
    errors.push(`Phase E ${role} must be the fixed ${host} git-sync:run trigger`);
  }
  const start = ms(trigger.startedAt, `Phase E ${role}.startedAt`, errors);
  const finish = ms(trigger.finishedAt, `Phase E ${role}.finishedAt`, errors);
  if (finish < start || start < window.start || finish > window.finish) errors.push(`Phase E ${role} trigger must be ordered inside the run window`);
}

function validateObservation(
  observation: PhysicalPhaseEObservation,
  expected: { runId: string; host: PhysicalPhaseEHost; key: string; stage: PhysicalPhaseEObservationStage; mode: PotGitMode },
  window: { start: number; finish: number },
  errors: string[],
): void {
  if (observation.schemaVersion !== PHASE_E_OBSERVATION_SCHEMA || observation.runId !== expected.runId || observation.hostId !== expected.host || observation.deviceKey !== expected.key || observation.stage !== expected.stage) {
    errors.push(`Phase E ${expected.stage} must be the exact ${expected.host} run-bound observation`);
  }
  const at = ms(observation.observedAt, `Phase E ${expected.stage}.observedAt`, errors);
  if (at < window.start || at > window.finish) errors.push(`Phase E ${expected.stage} observation must fall inside the run window`);
  if (observation.mode.value !== expected.mode || (expected.mode === 'bridged' && observation.mode.source !== 'set')) {
    errors.push(`Phase E ${expected.stage} must observe mode ${expected.mode}${expected.mode === 'bridged' ? ' from the federated set row' : ''}`);
  }
}

/**
 * A stage judged on a tower fire's verdict must show THAT fire: a finished
 * git-sync fire started at/after the trigger, and a github_bridge row written
 * at/after it. Otherwise the observation raced the in-flight fire, and the
 * product assertions below would judge the previous fire's row (WI-10004055).
 */
function validateObservedTriggeredFire(
  observation: PhysicalPhaseEObservation,
  trigger: PhysicalPhaseETrigger,
  errors: string[],
): void {
  const since = Date.parse(trigger.startedAt);
  const bridgeAt = observation.routine.githubBridge?.at;
  if (
    !Number.isFinite(since) || !finishedFireStartedSince(observation.routine, since) ||
    typeof bridgeAt !== 'number' || bridgeAt < since
  ) {
    errors.push(
      `Phase E ${observation.stage} must be read after the ${trigger.role} git-sync fire finished ` +
        '(git_sync_activity inactive, started at/after the trigger, github_bridge written at/after it); ' +
        'this read raced the in-flight fire and shows an earlier verdict',
    );
  }
}

function hasSignal(escalation: Record<string, unknown> | null, kind: string): boolean {
  const signals = Array.isArray(escalation?.signals) ? escalation.signals : [];
  return signals.some((value) => value && typeof value === 'object' && (value as Record<string, unknown>).kind === kind);
}

function validateModeChange(change: PhysicalPhaseEModeChange, runId: string, from: 'legacy' | 'bridged', to: 'legacy' | 'bridged', errors: string[]): void {
  if (
    change.schemaVersion !== PHASE_E_MODE_CHANGE_SCHEMA || change.runId !== runId || change.hostId !== 'tower' ||
    change.tool !== 'setPotGitMode' || change.workspaceId !== PHASE_D_WORKSPACE || change.potHomeSlug !== PHASE_A_POT_HOME ||
    change.from !== from || change.to !== to
  ) errors.push(`Phase E mode change must use setPotGitMode ${from}→${to} on the fixed canary`);
}

/** Strict, pure causal validator for the assembled two-host Phase E evidence. */
export function validatePhysicalPhaseE(input: PhysicalPhaseEInput): PhysicalPhaseEVerdict {
  const errors: string[] = [];
  if (input.schemaVersion !== PHASE_E_INPUT_SCHEMA) errors.push(`schemaVersion must be ${PHASE_E_INPUT_SCHEMA}`);
  if (!RUN_ID.test(input.runId)) errors.push('Phase E runId is invalid');
  for (const [label, key] of [['tower', input.identities.towerDeviceKey], ['vm', input.identities.vmDeviceKey]] as const) {
    try { assertDeviceKey(key); } catch { errors.push(`Phase E ${label} device key is invalid`); }
  }
  if (input.identities.towerDeviceKey === input.identities.vmDeviceKey) errors.push('Phase E physical device identities must be distinct');
  const start = ms(input.window.startedAt, 'Phase E window.startedAt', errors);
  const finish = ms(input.window.finishedAt, 'Phase E window.finishedAt', errors);
  if (finish <= start) errors.push('Phase E window must be ordered');
  const window = { start, finish };
  const tower = input.identities.towerDeviceKey;
  const vm = input.identities.vmDeviceKey;

  validateObservation(input.before.tower, { runId: input.runId, host: 'tower', key: tower, stage: 'legacy-before', mode: 'legacy' }, window, errors);
  validateObservation(input.before.vm, { runId: input.runId, host: 'vm', key: vm, stage: 'legacy-before', mode: 'legacy' }, window, errors);
  validateModeChange(input.activation.modeChange, input.runId, 'legacy', 'bridged', errors);
  validateTrigger(input.activation.towerTrigger, 'tower-member', 'tower', window, errors);
  validateTrigger(input.activation.vmTrigger, 'vm-member', 'vm', window, errors);
  validateObservation(input.activation.tower, { runId: input.runId, host: 'tower', key: tower, stage: 'bridged-member', mode: 'bridged' }, window, errors);
  validateObservation(input.activation.vm, { runId: input.runId, host: 'vm', key: vm, stage: 'bridged-member', mode: 'bridged' }, window, errors);
  validateObservedTriggeredFire(input.activation.tower, input.activation.towerTrigger, errors);
  for (const [label, observation] of [['tower', input.activation.tower], ['vm', input.activation.vm]] as const) {
    if (observation.routine.pushMode !== 'commit-only:bridged' || observation.routine.lastPushed.length !== 0 || !observation.routine.active) {
      errors.push(`Phase E ${label} member must be active, commit-only:bridged, and record no direct pushes`);
    }
  }

  const ingress = input.healthy.ingressMutation;
  if (
    ingress.schemaVersion !== PHASE_E_MUTATION_SCHEMA || ingress.runId !== input.runId || ingress.kind !== 'ingress' ||
    ingress.remoteRole !== 'upstream' || ingress.hostId !== 'tower' || ingress.method !== 'fixed-empty-commit-ff-push' ||
    !OID.test(ingress.baseOid) || !OID.test(ingress.headOid) || ingress.baseOid === ingress.headOid
  ) errors.push('Phase E healthy ingress must be a fresh fixed FF upstream commit');
  validateTrigger(input.healthy.ingressTrigger, 'healthy-ingress', 'tower', window, errors);
  validateTrigger(input.healthy.integrateTrigger, 'healthy-integrate', 'tower', window, errors);
  validateTrigger(input.healthy.egressTrigger, 'healthy-egress', 'tower', window, errors);
  validateObservation(input.healthy.observation, { runId: input.runId, host: 'tower', key: tower, stage: 'healthy-egress', mode: 'bridged' }, window, errors);
  validateObservedTriggeredFire(input.healthy.observation, input.healthy.egressTrigger, errors);
  const healthy = input.healthy.observation;
  const admitted = healthy.routine.githubBridge?.lastAdmitted;
  const canonical = healthy.refs.canonicalStaging;
  if (admitted !== ingress.headOid || healthy.refs.upstreamDefault !== ingress.headOid) {
    errors.push('Phase E healthy bridge must ingress and persist the exact fresh upstream head as last_admitted');
  }
  if (
    !canonical || healthy.routine.githubBridge?.ran !== true || healthy.routine.githubBridge.egressTarget !== 'fork' ||
    healthy.routine.githubBridge.egressHead !== canonical || healthy.refs.remoteStaging !== canonical ||
    healthy.routine.githubBridge.divergence !== 'clear' || healthy.bridgeEscalation !== null
  ) errors.push('Phase E healthy bridge must clear divergence and FF exact canonical staging to the fork');
  if (canonical === ingress.baseOid || canonical === ingress.canonicalOid) {
    errors.push('Phase E healthy canonical must advance beyond the pre-ingress staging head');
  }

  if (input.watchdogSweeps.length !== 2) errors.push('Phase E requires exactly two production watchdog sweeps');
  input.watchdogSweeps.forEach((sweep, index) => {
    if (
      sweep.schemaVersion !== PHASE_E_WATCHDOG_SCHEMA || sweep.runId !== input.runId || sweep.hostId !== 'tower' ||
      sweep.ordinal !== index + 1 || sweep.tool !== 'checkGitSyncStall' || !sweep.fixedRoutineActive ||
      sweep.fixedPushMode !== 'commit-only:bridged' || sweep.fixedWatchdogAlerted || sweep.fixedWatchdogErrorSweeps !== 0 ||
      sweep.fixedWatchdogStallSweeps !== 0 || sweep.alarmed.includes(PHASE_A_POT_HOME)
    ) errors.push(`Phase E watchdog sweep ${index + 1} must inspect the active commit-only canary without alarming`);
    const sweepStart = ms(sweep.startedAt, `Phase E watchdog ${index + 1}.startedAt`, errors);
    const sweepFinish = ms(sweep.finishedAt, `Phase E watchdog ${index + 1}.finishedAt`, errors);
    if (sweepFinish < sweepStart || sweepStart < window.start || sweepFinish > window.finish) errors.push(`Phase E watchdog sweep ${index + 1} must fall inside the run window`);
  });
  if (Date.parse(input.watchdogSweeps[1].startedAt) <= Date.parse(input.watchdogSweeps[0].finishedAt)) {
    errors.push('Phase E production watchdog sweeps must be distinct and ordered');
  }

  validateObservation(input.divergence.before, { runId: input.runId, host: 'tower', key: tower, stage: 'divergence-before', mode: 'bridged' }, window, errors);
  const mutation = input.divergence.mutation;
  if (
    mutation.schemaVersion !== PHASE_E_MUTATION_SCHEMA || mutation.runId !== input.runId || mutation.kind !== 'fork-ahead' ||
    mutation.remoteRole !== 'fork' || mutation.remoteRef !== BRIDGE_REMOTE_STAGING_REF || mutation.baseOid !== mutation.canonicalOid ||
    mutation.canonicalOid !== input.divergence.before.refs.canonicalStaging || mutation.headOid === mutation.baseOid
  ) errors.push('Phase E divergence must arm one fresh fork-ahead commit from the observed canonical head');
  validateTrigger(input.divergence.trigger, 'divergence-egress', 'tower', window, errors);
  validateObservation(input.divergence.after, { runId: input.runId, host: 'tower', key: tower, stage: 'divergence-after', mode: 'bridged' }, window, errors);
  validateObservedTriggeredFire(input.divergence.after, input.divergence.trigger, errors);
  const after = input.divergence.after;
  if (
    after.refs.canonicalStaging !== mutation.canonicalOid || after.refs.remoteStaging !== mutation.headOid ||
    after.routine.githubBridge?.divergence !== 'escalate' || after.routine.githubBridge.egressHead !== mutation.canonicalOid ||
    !hasSignal(after.bridgeEscalation, 'egress-non-ff')
  ) errors.push('Phase E fork-ahead control must yield egress-non-ff while canonical and remote remain unchanged');
  const recovery = input.divergence.recovery;
  if (
    recovery.schemaVersion !== PHASE_E_RECOVERY_SCHEMA || recovery.runId !== input.runId || recovery.hostId !== 'tower' ||
    recovery.method !== 'fixed-force-with-lease-restore' || recovery.expectedDivergenceOid !== mutation.headOid ||
    recovery.restoredOid !== mutation.canonicalOid || recovery.observedRemoteOid !== mutation.canonicalOid
  ) errors.push('Phase E divergence recovery must lease-guard restore the exact canonical head');

  validateModeChange(input.rollback.modeChange, input.runId, 'bridged', 'legacy', errors);
  validateTrigger(input.rollback.towerTrigger, 'rollback-observe', 'tower', window, errors);
  validateTrigger(input.rollback.vmTrigger, 'rollback-observe', 'vm', window, errors);
  validateObservation(input.rollback.tower, { runId: input.runId, host: 'tower', key: tower, stage: 'legacy-after', mode: 'legacy' }, window, errors);
  validateObservation(input.rollback.vm, { runId: input.runId, host: 'vm', key: vm, stage: 'legacy-after', mode: 'legacy' }, window, errors);

  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    result: uniqueErrors.length ? null : {
      schemaVersion: PHASE_E_RESULT_SCHEMA,
      phase: 'E',
      planItem: PHASE_E_PLAN_ITEM,
      status: 'complete',
      complete: true,
      missingAssertions: [],
      observedAt: input.window.finishedAt,
      assertions: {
        bothHostsConsumedFederatedBridgedMode: true,
        bothMembersWereCommitOnlyAndDirectPushedNothing: true,
        ingressAdvancedAdmissionWatermark: true,
        canonicalDescendedFromAdmittedIngress: true,
        bridgeAloneFastForwardedRemoteStaging: true,
        twoProductionWatchdogSweepsStayedQuiet: true,
        forkAheadWasRefusedWithoutCanonicalMutation: true,
        controlledRemoteRecoveryAndLegacyRollbackObserved: true,
      },
      oids: {
        ingress: ingress.headOid,
        admitted: admitted!,
        canonical: canonical!,
        divergence: mutation.headOid,
        restored: recovery.observedRemoteOid,
      },
    },
  };
}
