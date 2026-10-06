/**
 * P-521 F6 physical Phase I: protected-effect fencing beyond canonical staging
 * (D-022, D-082).
 *
 * Two physical hosts hold DIVERGENT advisory views at the SAME roster epoch:
 * each host's fleet election names itself. That advisory view must grant no
 * exclusive effect. Only the single owning hive key may authorize canonical
 * staging, release promotion, a GitHub canonical push, an independent
 * submodule-origin push, and fork/PR publication.
 *
 * Owner model. The owning hive key is a disposable, run-bound key minted ONCE
 * by a drill owner process on the VM (`startPhaseIOwner`). It never leaves that
 * host: the tower receives only its public key and one captured owner
 * signature (to prove a replayed proof cannot authorize anything). Losing the
 * owner is a SIGKILL of that process; restoring it relaunches the same key
 * file. There is no failover, no second key and no replication.
 *
 * Every effect runs through its production sink against a disposable local
 * stand-in target in the host's own temp directory: never a real shared
 * remote. Each attempt records the complete target snapshot before and after
 * and every `git push` argv the sink issued.
 *
 * Steps:
 *   live      owner up. VM: owner authorizes all five effects; the owner key
 *             under a stale scope is refused. Tower: missing, device-only,
 *             replayed owner proof and foreign hive are all refused.
 *   lost      VM only. Push #1 succeeds under the owner; the owner is killed
 *             after the fork push and before the PR (PR refused); push #2
 *             and the submodule push are refused; local work survives.
 *   outage    owner down. Both hosts are refused (no failover); local
 *             commits and signed device-head exchange still work.
 *   restored  owner relaunched with the same key. VM makes fresh progress on
 *             all five effects; the tower is still refused.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { runGitSync } from '../../harness/git-sync/run-git-sync';
import { generateEd25519KeypairDer, pubkeyBase64FromDer, signWithPrivateKeyDer, verifyEd25519 } from '../../identity/ed25519';
import { electFleetLeader } from '../../p2p/fleet-leader-election';
import type { Pr } from '../../pr-host/types';
import { egressCanonicalRefs } from './github-egress';
import { egressRatifiedRequestAsForkPr } from './github-fork-egress';
import { requireHiveEffectAuthority, type HiveEffectAuthority } from './hive-effect-authority';
import { integrateMemberHeads, STAGING_REF } from './integrator';
import { promoteRelease, readRelease, signGreenAttestation } from './release-promotion';
import { makeSignedProtocolContext, type SignedProtocolContext } from './signed-context';
import { acceptFetchedSigrefs, buildSigrefs, type SignedSigrefs } from './sigrefs';
import { defaultRunGit, deviceNamespaceKey, readNamespaceRef, writeNamespaceRef, type RunGit } from './storage';

export const PHASE_I_OWNER_SCHEMA = 'hive-git-physical-phase-i-owner/v1' as const;
export const PHASE_I_ATTEMPT_SCHEMA = 'hive-git-physical-phase-i-attempt/v1' as const;
export const PHASE_I_INPUT_SCHEMA = 'hive-git-physical-phase-i-input/v1' as const;
export const PHASE_I_RESULT_SCHEMA = 'hive-git-physical-phase-i-result/v1' as const;
export const PHASE_I_PLAN_ITEM = 'P-521' as const;
export const PHASE_I_EFFECTS = [
  'canonical-staging', 'release-promotion', 'github-push', 'submodule-origin-push', 'fork-pr',
] as const;
export const PHASE_I_STEPS = ['live', 'lost', 'outage', 'restored'] as const;
export type PhaseIEffect = (typeof PHASE_I_EFFECTS)[number];
export type PhysicalPhaseIStep = (typeof PHASE_I_STEPS)[number];
export type PhaseIHost = 'tower' | 'vm';
export type PhaseIVariant =
  | 'owner' | 'stale-scope' | 'owner-unreachable'
  | 'missing' | 'device-only' | 'replayed-owner-proof' | 'foreign-hive';

/** Which authority variants each host exercises at each step. The VM is the
 *  single owner host; the tower never holds the owner key. */
export const PHASE_I_PLAN: Record<PhaseIHost, Partial<Record<PhysicalPhaseIStep, readonly PhaseIVariant[]>>> = {
  vm: { live: ['owner', 'stale-scope'], lost: [], outage: ['owner-unreachable'], restored: ['owner'] },
  tower: {
    live: ['missing', 'device-only', 'replayed-owner-proof', 'foreign-hive'],
    outage: ['missing', 'device-only', 'replayed-owner-proof'],
    restored: ['missing', 'device-only', 'replayed-owner-proof'],
  },
};

const RUN_ID = /^[A-Za-z0-9._:-]{8,160}$/;
const DEVICE_KEY = /^[A-Za-z0-9+/]{43}=$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const WORK_REF = 'refs/heads/phase-i-work';
const FORK_OWNER = 'p521-phase-i-contrib';
const UPSTREAM_OWNER = 'p521-phase-i';
const AUTHORITY_REFUSAL = /owning hive key|missing-hive-authority/;
const ALLOW_FILE = ['-c', 'protocol.file.allow=always'];

export type PhaseIOwnerRecord = {
  schemaVersion: typeof PHASE_I_OWNER_SCHEMA;
  hostId: 'vm';
  runId: string;
  hiveId: string;
  pid: number;
  startedAt: string;
  /** True only on the first start: every later start reuses the same key file. */
  mintedKey: boolean;
  /**
   * Where the owning key lives. `drill-minted` = the disposable run-bound key
   * file (ephemeral target). `host-keychain` = the canary hive's REAL key,
   * signed through on its owning host and never copied (canary-owner target,
   * D-119). Absent on pre-WI-10004748 evidence, read as `drill-minted`.
   */
  keySource?: PhaseIKeySource;
};

export type PhaseIKeySource = 'drill-minted' | 'host-keychain';

/**
 * The canary hive's REAL owning key, exposed to Phase I ONLY as a signing
 * capability on its owning host (identity/hive-keypair `signWithHiveKey`).
 * The private key never enters Phase I, a file, or the other host.
 */
export type PhaseIHostKeychainSigner = {
  hiveId: string;
  sign: (bytes: Buffer) => Buffer | Promise<Buffer>;
};

/**
 * The canary's REAL protected refs, read-only. Phase I never writes them: a
 * canary-owner run proves they did not move while the owner was down (G1) and
 * that the restored owner made fresh authorized progress (G3).
 */
export type PhaseIRealTargetSnapshot = {
  observedAt: string;
  stagingRef: string | null;
  releaseRef: string | null;
  githubMain: string | null;
  forkRefs: Array<{ ref: string; sha: string }>;
  pullRequests: Array<{ number: number; headRef: string }>;
};

/**
 * What Phase I's owner IS (WI-10004748). `ephemeral` = a disposable minted
 * key against stand-in targets: valid for the P-521 drill, NOT for P-502.
 * `canary-owner` = the live canary hive's real owning authority. Effect
 * attempts still run against disposable stand-ins, but are scoped by the real
 * hive_id/repo_key, and the real refs are snapshotted around the outage.
 */
export type PhaseITarget =
  | { kind: 'ephemeral' }
  | {
      kind: 'canary-owner';
      workspaceId: string;
      potHomeSlug: string;
      hiveId: string;
      repoKey: string;
      realTargets: {
        beforeOutage: PhaseIRealTargetSnapshot;
        duringOutage: PhaseIRealTargetSnapshot;
        afterRecovery: PhaseIRealTargetSnapshot;
      };
    };

export type PhaseITargetSnapshot = {
  /** Protected targets: a refused attempt must leave every one unchanged. */
  protected: {
    stagingRef: string | null;
    releaseRef: string | null;
    githubMain: string | null;
    submoduleOriginMain: string | null;
    superOriginMain: string | null;
    forkExists: boolean;
    forkRefs: Array<{ ref: string; sha: string }>;
    pullRequests: Array<{ number: number; headRef: string }>;
  };
  /** Local, unprotected state: members may always advance it. */
  local: { workHead: string | null; submoduleLocalHead: string | null };
};

export type PhaseIEffectAttempt = {
  effect: PhaseIEffect;
  variant: PhaseIVariant;
  candidate: string;
  /** The sink reported that the effect happened. */
  ok: boolean;
  reason: string | null;
  /** How many times the sink challenged the presented signer. */
  signerCalls: number;
  before: PhaseITargetSnapshot;
  after: PhaseITargetSnapshot;
  pushArgs: string[][];
};

export type PhaseILostSequence = {
  ownerPid: number;
  killedAt: string;
  ownerGoneVerified: boolean;
  push1: PhaseIEffectAttempt;
  forkPr: PhaseIEffectAttempt;
  push2: PhaseIEffectAttempt;
  submodule: PhaseIEffectAttempt;
};

export type PhysicalPhaseIAttempt = {
  schemaVersion: typeof PHASE_I_ATTEMPT_SCHEMA;
  hostId: PhaseIHost;
  step: PhysicalPhaseIStep;
  runId: string;
  startedAt: string;
  finishedAt: string;
  attemptPid: number;
  hiveId: string;
  repoKey: string;
  advisory: {
    provenance: 'drill-supplied-roster-inputs';
    rosterEpoch: number;
    isSelf: boolean;
    leaderDevicePubkey: string | null;
  };
  /** The host's real physical device key signed a probe (device-only authority is a real admitted device). */
  deviceSigner: { devicePubkey: string; verified: boolean };
  ownerKeyMaterialOnHost: boolean;
  attempts: PhaseIEffectAttempt[];
  localCommit: { oid: string; landed: boolean };
  capturedOwnerProof: { bytesBase64: string; signatureBase64: string } | null;
  deviceHead: SignedSigrefs | null;
  deviceHeadAcceptance: { ok: boolean; reason: string | null } | null;
  lost: PhaseILostSequence | null;
};

export type PhysicalPhaseIInput = {
  schemaVersion: typeof PHASE_I_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  /** Absent = `{ kind: 'ephemeral' }` (the P-521 drill). P-502 requires `canary-owner`. */
  target?: PhaseITarget;
  owner: { first: PhaseIOwnerRecord; restored: PhaseIOwnerRecord; goneAfterLost: boolean };
  steps: {
    live: { vm: PhysicalPhaseIAttempt; tower: PhysicalPhaseIAttempt };
    lost: { vm: PhysicalPhaseIAttempt };
    outage: { vm: PhysicalPhaseIAttempt; tower: PhysicalPhaseIAttempt };
    restored: { vm: PhysicalPhaseIAttempt; tower: PhysicalPhaseIAttempt };
  };
};

export type PhysicalPhaseIVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_I_RESULT_SCHEMA;
    phase: 'I';
    planItem: typeof PHASE_I_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
    counts: { authorized: number; refused: number };
    assertions: {
      divergentAdvisoryViewsAtSameEpoch: true;
      onlyOwningHiveAuthorizedEveryProtectedEffect: true;
      missingDeviceOnlyReplayedForeignAndStaleAuthorityRefusedWithoutEffect: true;
      authorityLostBetweenPushAttemptsFroze: true;
      ownerOutageFrozeBothHostsWithoutFailover: true;
      localCommitsAndDeviceHeadExchangePermitted: true;
      restoredOwnerMadeFreshAuthorizedProgress: true;
      noForcePush: true;
    };
  };
};

/** Both hosts derive the SAME advisory roster epoch from the run id. */
export function phaseIRosterEpoch(runId: string): number {
  return 1 + (parseInt(createHash('sha256').update(`phase-i:${runId}`).digest('hex').slice(0, 8), 16) % 1_000_000);
}

export function phaseIRepoKey(runId: string): string {
  return `p521-phase-i:${runId}`;
}

export function phaseITargetOf(input: { target?: PhaseITarget }): PhaseITarget {
  return input.target ?? { kind: 'ephemeral' };
}

/** The repo_key every attempt must be scoped by: the run-bound key, or the canary's real one. */
export function phaseIExpectedRepoKey(input: { runId: string; target?: PhaseITarget }): string {
  const target = phaseITargetOf(input);
  return target.kind === 'canary-owner' ? target.repoKey : phaseIRepoKey(input.runId);
}

function validDeviceKey(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_KEY.test(value) && Buffer.from(value, 'base64').length === 32;
}

function assertDir(dir: string): void {
  if (!isAbsolute(dir) || !existsSync(dir)) throw new Error(`physical Phase I requires an existing absolute directory: ${dir}`);
}

function sh(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...env } });
  if (r.status !== 0) throw new Error(`physical Phase I git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function tryRev(gitDir: string, ref: string): string | null {
  if (!existsSync(gitDir)) return null;
  const r = spawnSync('git', ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' });
  return r.status === 0 && OID.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'Papercusp P-521 Phase I', GIT_AUTHOR_EMAIL: 'p521-phase-i@papercusp.invalid',
  GIT_COMMITTER_NAME: 'Papercusp P-521 Phase I', GIT_COMMITTER_EMAIL: 'p521-phase-i@papercusp.invalid',
};

// ─── owner process ──────────────────────────────────────────────────────────

function ownerPaths(dir: string) {
  const ownerDir = join(dir, 'owner');
  return { ownerDir, key: join(ownerDir, 'hive-key.der'), record: join(ownerDir, 'owner.json'), socket: join(ownerDir, 'owner.sock') };
}

/**
 * Start the single owner: mint the key on first start, reuse it afterwards,
 * and serve signatures to local processes over a 0700-directory unix socket.
 * The returned `close` stops serving; a SIGKILL of the process is the physical
 * owner loss the scenario uses.
 */
export async function startPhaseIOwner(input: {
  dir: string;
  runId: string;
  now?: () => string;
  /** Tests only: an in-process owner shares the test's pid. The producer never sets this. */
  pid?: number;
  /**
   * canary-owner target: sign through the canary host's real hive key instead
   * of minting one. No key file is written or read; `mintedKey` stays false.
   */
  signer?: PhaseIHostKeychainSigner;
}): Promise<{
  record: PhaseIOwnerRecord;
  close: () => Promise<void>;
}> {
  assertDir(input.dir);
  if (!RUN_ID.test(input.runId)) throw new Error(`physical Phase I runId is invalid: ${input.runId}`);
  const paths = ownerPaths(input.dir);
  await mkdir(paths.ownerDir, { recursive: true, mode: 0o700 });
  await chmod(paths.ownerDir, 0o700);
  let mintedKey = false;
  let hiveId: string;
  let sign: (bytes: Buffer) => Buffer | Promise<Buffer>;
  if (input.signer) {
    if (!validDeviceKey(input.signer.hiveId)) throw new Error('physical Phase I host-keychain signer must name a raw Ed25519 hive key');
    hiveId = input.signer.hiveId;
    sign = input.signer.sign;
  } else {
    if (!existsSync(paths.key)) {
      await writeFile(paths.key, generateEd25519KeypairDer().privateKeyDer, { flag: 'wx', mode: 0o600 });
      mintedKey = true;
    }
    const privateKeyDer = await readFile(paths.key);
    hiveId = pubkeyBase64FromDer(privateKeyDer);
    sign = (bytes) => signWithPrivateKeyDer(privateKeyDer, bytes);
  }
  if (existsSync(paths.socket)) {
    const live = await ownerSocketSigner(paths.socket, 1_000)(Buffer.from('probe')).then(() => true, () => false);
    if (live) throw new Error('physical Phase I owner is already serving');
    await rm(paths.socket, { force: true });
  }
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const end = buf.indexOf('\n');
      if (end < 0) return;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(JSON.parse(buf.slice(0, end)).bytes, 'base64');
      } catch (error) {
        sock.end(`${JSON.stringify({ error: String(error) })}\n`);
        return;
      }
      Promise.resolve().then(() => sign(bytes)).then(
        (signature) => sock.end(`${JSON.stringify({ signature: Buffer.from(signature).toString('base64') })}\n`),
        (error) => sock.end(`${JSON.stringify({ error: String(error) })}\n`),
      );
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, () => resolve());
  });
  await chmod(paths.socket, 0o600);
  const record: PhaseIOwnerRecord = {
    schemaVersion: PHASE_I_OWNER_SCHEMA,
    hostId: 'vm',
    runId: input.runId,
    hiveId,
    pid: input.pid ?? process.pid,
    startedAt: (input.now ?? (() => new Date().toISOString()))(),
    mintedKey,
    keySource: input.signer ? 'host-keychain' : 'drill-minted',
  };
  const tmp = `${paths.record}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(tmp, paths.record);
  return {
    record,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function readPhaseIOwnerRecord(dir: string): Promise<PhaseIOwnerRecord> {
  return JSON.parse(await readFile(ownerPaths(dir).record, 'utf8')) as PhaseIOwnerRecord;
}

/** A live signer backed by the owner process; it fails once the owner is gone. */
export function ownerSocketSigner(socketPath: string, timeoutMs = 5_000): (bytes: Buffer) => Promise<Buffer> {
  return (bytes) => new Promise<Buffer>((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('physical Phase I owner signer timed out')); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ bytes: bytes.toString('base64') })}\n`));
    sock.on('data', (chunk) => {
      buf += chunk;
      const end = buf.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      sock.destroy();
      try {
        const reply = JSON.parse(buf.slice(0, end)) as { signature?: string; error?: string };
        if (reply.signature) resolve(Buffer.from(reply.signature, 'base64'));
        else reject(new Error(reply.error ?? 'physical Phase I owner refused'));
      } catch (error) {
        reject(error);
      }
    });
    sock.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

// ─── disposable targets ─────────────────────────────────────────────────────

type Targets = {
  root: string;
  canonical: string;
  github: string;
  subOrigin: string;
  superOrigin: string;
  superWork: string;
  subWork: string;
  fork: string;
  prLedger: string;
};

function targetsOf(dir: string): Targets {
  const root = join(dir, 'targets');
  const superWork = join(root, 'super-work');
  return {
    root,
    canonical: join(root, 'canonical.git'),
    github: join(root, 'github.git'),
    subOrigin: join(root, 'sub-origin.git'),
    superOrigin: join(root, 'super-origin.git'),
    superWork,
    subWork: join(superWork, 'libs', 'sub'),
    fork: join(root, 'fork.git'),
    prLedger: join(root, 'pull-requests.jsonl'),
  };
}

function configUser(path: string): void {
  sh(path, ['config', 'user.name', COMMIT_ENV.GIT_AUTHOR_NAME]);
  sh(path, ['config', 'user.email', COMMIT_ENV.GIT_AUTHOR_EMAIL]);
  sh(path, ['config', 'commit.gpgsign', 'false']);
}

async function ensureTargets(dir: string, runId: string, deviceKey: string, runGit: RunGit): Promise<Targets> {
  const t = targetsOf(dir);
  if (existsSync(t.canonical)) return t;
  await mkdir(t.root, { recursive: true, mode: 0o700 });
  for (const bare of [t.canonical, t.github, t.subOrigin, t.superOrigin]) sh(t.root, ['init', '--bare', '-b', 'main', bare]);
  const base = commitPayload(t.canonical, null, { runId, label: 'base' });
  await writeNamespaceRef(t.canonical, deviceKey, WORK_REF, base, runGit);
  const subSeed = join(t.root, 'sub-seed');
  sh(t.root, ['clone', t.subOrigin, subSeed]);
  configUser(subSeed);
  await writeFile(join(subSeed, 'sub.txt'), `${runId}:sub-base\n`);
  sh(subSeed, ['add', '-A']);
  sh(subSeed, ['commit', '--no-verify', '-m', 'phase I sub base']);
  sh(subSeed, ['push', 'origin', 'HEAD:main']);
  const superSeed = join(t.root, 'super-seed');
  sh(t.root, ['clone', t.superOrigin, superSeed]);
  configUser(superSeed);
  sh(superSeed, [...ALLOW_FILE, 'submodule', 'add', t.subOrigin, 'libs/sub']);
  sh(superSeed, ['commit', '--no-verify', '-m', 'phase I super base']);
  sh(superSeed, ['push', 'origin', 'HEAD:main']);
  sh(t.root, ['clone', t.superOrigin, t.superWork]);
  configUser(t.superWork);
  sh(t.superWork, [...ALLOW_FILE, 'submodule', 'update', '--init', '--recursive']);
  configUser(t.subWork);
  sh(t.subWork, ['checkout', '-B', 'main', 'origin/main']);
  await rm(subSeed, { recursive: true, force: true });
  await rm(superSeed, { recursive: true, force: true });
  return t;
}

function commitPayload(gitDir: string, parent: string | null, payload: Record<string, unknown>): string {
  const body = `${JSON.stringify({ schemaVersion: 'hive-git-physical-phase-i-payload/v1', nonce: randomBytes(8).toString('hex'), ...payload })}\n`;
  const blob = sh(gitDir, ['hash-object', '-w', '--stdin'], body);
  const tree = sh(gitDir, ['mktree'], `100644 blob ${blob}\tp521-phase-i.json\n`);
  return sh(gitDir, ['commit-tree', tree, ...(parent ? ['-p', parent] : [])], `P-521 Phase I ${String(payload.label)}\n`, COMMIT_ENV);
}

/** A local commit in this device's OWN namespace. It needs no authority. */
async function localCommit(t: Targets, deviceKey: string, runId: string, label: string, runGit: RunGit): Promise<string> {
  const parent = await readNamespaceRef(t.canonical, deviceKey, WORK_REF, runGit);
  const oid = commitPayload(t.canonical, parent, { runId, label });
  await writeNamespaceRef(t.canonical, deviceKey, WORK_REF, oid, runGit, parent ?? '0'.repeat(40));
  return oid;
}

async function readLedger(path: string): Promise<Array<{ number: number; headRef: string }>> {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => {
    const row = JSON.parse(line) as { number: number; head_ref: string };
    return { number: row.number, headRef: row.head_ref };
  });
}

async function snapshot(t: Targets, deviceKey: string, runGit: RunGit): Promise<PhaseITargetSnapshot> {
  const forkExists = existsSync(t.fork);
  const forkRefs = forkExists
    ? sh(t.root, ['--git-dir', t.fork, 'for-each-ref', '--format=%(refname) %(objectname)']).split('\n').filter(Boolean)
        .map((line) => { const [ref, sha] = line.split(' '); return { ref: ref!, sha: sha! }; })
    : [];
  return {
    protected: {
      stagingRef: await readNamespaceRef(t.canonical, deviceKey, STAGING_REF, runGit),
      releaseRef: await readRelease(t.canonical, deviceKey, runGit),
      githubMain: tryRev(t.github, 'refs/heads/main'),
      submoduleOriginMain: tryRev(t.subOrigin, 'refs/heads/main'),
      superOriginMain: tryRev(t.superOrigin, 'refs/heads/main'),
      forkExists,
      forkRefs,
      pullRequests: await readLedger(t.prLedger),
    },
    local: {
      workHead: await readNamespaceRef(t.canonical, deviceKey, WORK_REF, runGit),
      submoduleLocalHead: sh(t.subWork, ['rev-parse', 'HEAD']),
    },
  };
}

// ─── authority variants ─────────────────────────────────────────────────────

type Counted = { authority: HiveEffectAuthority | null; calls: () => number };

function counted(authority: HiveEffectAuthority | null): Counted {
  if (!authority) return { authority: null, calls: () => 0 };
  let calls = 0;
  return {
    authority: { ...authority, sign: async (bytes) => { calls += 1; return authority.sign(bytes); } },
    calls: () => calls,
  };
}

type HostContext = {
  host: PhaseIHost;
  runId: string;
  deviceKey: string;
  hiveId: string;
  repoKey: string;
  targets: Targets;
  runGit: RunGit;
  signDevice: (bytes: Buffer) => Promise<Buffer>;
  ownerSigner: ((bytes: Buffer) => Promise<Buffer>) | null;
  capturedOwnerSignature: Buffer | null;
  onOwnerSignature?: (bytes: Buffer, signature: Buffer) => void;
};

function authorityFor(ctx: HostContext, variant: PhaseIVariant): HiveEffectAuthority | null {
  const scope = { hive_id: ctx.hiveId, repo_key: ctx.repoKey };
  switch (variant) {
    case 'missing':
      return null;
    case 'device-only':
      return { ...scope, sign: ctx.signDevice };
    case 'replayed-owner-proof': {
      const captured = ctx.capturedOwnerSignature;
      if (!captured) throw new Error('physical Phase I replay requires a captured owner proof');
      return { ...scope, sign: async () => Buffer.from(captured) };
    }
    case 'foreign-hive': {
      const foreign = generateEd25519KeypairDer();
      return { hive_id: foreign.pubkeyBase64, repo_key: ctx.repoKey, sign: async (bytes) => signWithPrivateKeyDer(foreign.privateKeyDer, bytes) };
    }
    case 'stale-scope':
    case 'owner':
    case 'owner-unreachable': {
      const signer = ctx.ownerSigner;
      if (!signer) throw new Error(`physical Phase I ${variant} requires the owner signer on the owner host`);
      const sign = async (bytes: Buffer) => {
        const signature = await signer(bytes);
        ctx.onOwnerSignature?.(bytes, signature);
        return signature;
      };
      return { hive_id: ctx.hiveId, repo_key: variant === 'stale-scope' ? `${ctx.repoKey}:stale-prior-scope` : ctx.repoKey, sign };
    }
  }
}

// ─── effects ────────────────────────────────────────────────────────────────

type SinkOutcome = { ok: boolean; reason: string | null };

async function exerciseEffect(
  ctx: HostContext,
  effect: PhaseIEffect,
  variant: PhaseIVariant,
  hooks: { afterForkPush?: () => Promise<void> } = {},
): Promise<PhaseIEffectAttempt> {
  const t = ctx.targets;
  const pushArgs: string[][] = [];
  let forkPushed = false;
  const runGit: RunGit = async (args, cwd) => {
    const result = await ctx.runGit(args, cwd);
    if (args.includes('push') && !args.includes('--dry-run')) {
      pushArgs.push([...args]);
      if (effect === 'fork-pr' && result.code === 0 && !forkPushed && hooks.afterForkPush) {
        forkPushed = true;
        await hooks.afterForkPush();
      }
    }
    return result;
  };
  const scope = { hive_id: ctx.hiveId, repo_key: ctx.repoKey };
  const { authority, calls } = counted(authorityFor(ctx, variant));
  // Every attempt publishes a FRESH candidate that the sink would really
  // publish, so a refusal can only come from the authority fence.
  const candidate = effect === 'submodule-origin-push'
    ? await (async () => {
      await writeFile(join(t.subWork, `phase-i-${randomBytes(6).toString('hex')}.txt`), `${ctx.runId}:${variant}\n`);
      return 'pending';
    })()
    : await localCommit(t, ctx.deviceKey, ctx.runId, `${effect}:${variant}`, ctx.runGit);
  const before = await snapshot(t, ctx.deviceKey, ctx.runGit);
  let outcome: SinkOutcome;
  try {
    outcome = await runSink(ctx, effect, candidate, scope, authority, runGit);
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const after = await snapshot(t, ctx.deviceKey, ctx.runGit);
  return {
    effect,
    variant,
    candidate: effect === 'submodule-origin-push' ? after.local.submoduleLocalHead ?? '' : candidate,
    ok: outcome.ok,
    reason: outcome.reason,
    signerCalls: calls(),
    before,
    after,
    pushArgs,
  };
}

async function runSink(
  ctx: HostContext,
  effect: PhaseIEffect,
  candidate: string,
  scope: { hive_id: string; repo_key: string },
  authority: HiveEffectAuthority | null,
  runGit: RunGit,
): Promise<SinkOutcome> {
  const t = ctx.targets;
  switch (effect) {
    case 'canonical-staging': {
      const r = await integrateMemberHeads(t.canonical, ctx.deviceKey,
        [{ deviceHex: deviceNamespaceKey(ctx.deviceKey), sha: candidate }], { runGit, scope, authority });
      return { ok: r.advanced, reason: r.advanced ? null : 'not-advanced' };
    }
    case 'release-promotion': {
      const gate = generateEd25519KeypairDer();
      const proof = await signGreenAttestation(
        { repoKey: ctx.repoKey, stagingSha: candidate, signerPubkeyBase64: gate.pubkeyBase64, nowMs: Date.now() },
        async (bytes) => signWithPrivateKeyDer(gate.privateKeyDer, bytes),
      );
      const r = await promoteRelease(t.canonical, ctx.deviceKey, ctx.repoKey, candidate, [proof],
        { allow: [gate.pubkeyBase64], threshold: 1 }, { runGit, hiveId: ctx.hiveId, authority });
      return { ok: r.promoted, reason: r.promoted ? null : r.reason };
    }
    case 'github-push': {
      const r = await egressCanonicalRefs({
        scope, authority, repoPath: t.canonical, remoteUrl: t.github,
        refs: [{ sha: candidate, remoteRef: 'refs/heads/main' }], runGit, scanSecrets: false,
      });
      const ok = r.ok && r.pushed.length === 1;
      return { ok, reason: ok ? null : [...r.errors, ...r.rejectedNonFF.map((x) => x.reason)].join('; ') || 'not-pushed' };
    }
    case 'submodule-origin-push': {
      const r = await runGitSync('physical-phase-i', {
        repoPath: t.superWork,
        runGit,
        contentDetectors: [],
        deletionGuard: false,
        diffSubjects: false,
        config: { push: false, pushSubmoduleOrigins: true },
        // The production git-sync gate (git-sync-action.ts): a fresh live
        // owner challenge bound to the exact push argv, for EACH attempt.
        beforePush: (args, cwd) => requireHiveEffectAuthority(authority, scope, ['git-sync-push', cwd, ...args]),
      });
      const synced = r.status === 'synced';
      const reason = r.status === 'error' ? r.errors.map((e) => e.message).join('; ') : synced ? null : r.status;
      return { ok: synced && tryRev(t.subOrigin, 'refs/heads/main') === sh(t.subWork, ['rev-parse', 'HEAD']), reason };
    }
    case 'fork-pr': {
      const r = await egressRatifiedRequestAsForkPr({
        scope, authority, repoPath: t.canonical, potSlug: 'p521-phase-i',
        request: { devicePubkey: ctx.deviceKey, headSha: candidate, state: 'ratified' },
        upstreamRemote: `github.com/${UPSTREAM_OWNER}/upstream`, upstreamOwner: UPSTREAM_OWNER,
        upstreamRepo: 'upstream', baseBranch: 'main', token: 'p521-phase-i-disposable', runGit,
        forkPushUrl: () => t.fork,
        ensureForkFn: async () => {
          const created = !existsSync(t.fork);
          if (created) sh(t.root, ['init', '--bare', '-b', 'main', t.fork]);
          return { forkOwner: FORK_OWNER, forkFullName: `${FORK_OWNER}/upstream`, created };
        },
        openPrFn: async (args) => {
          const number = (await readLedger(t.prLedger)).length + 1;
          await appendFile(t.prLedger, `${JSON.stringify({ number, head_ref: args.head_ref, head_owner: args.head_owner ?? null, base_ref: args.base_ref })}\n`, { mode: 0o600 });
          return { ok: true, data: { ref: { number }, url: `file://${t.prLedger}#${number}` } as unknown as Pr };
        },
      });
      return { ok: r.ok, reason: r.ok ? null : r.error };
    }
  }
}

// ─── one host, one step ─────────────────────────────────────────────────────

export type PhaseIAttemptDeps = {
  runGit?: RunGit;
  now?: () => string;
  /** Signs with this host's REAL physical device key (production: signWithDeviceKey). */
  signDevice: (bytes: Buffer) => Promise<Buffer>;
  /** Kills the owner process (production: SIGKILL of its pid) and resolves once it is gone. */
  killOwner?: (pid: number) => Promise<boolean>;
};

export async function attemptPhysicalPhaseI(input: {
  host: PhaseIHost;
  step: PhysicalPhaseIStep;
  dir: string;
  runId: string;
  deviceKey: string;
  hiveId: string;
  /** VM steps: the owner's socket. Tower: none. */
  ownerSocket?: string | null;
  /** Tower steps: the VM's live-step record (captured owner proof). */
  vmLive?: PhysicalPhaseIAttempt | null;
  /** Tower outage: the VM's outage-step record (its signed device head). */
  vmOutage?: PhysicalPhaseIAttempt | null;
  /**
   * canary-owner target: scope every attempt by the canary's REAL repo_key
   * (with `hiveId` = its real hive key). Absent = the run-bound drill key.
   */
  repoKey?: string;
}, deps: PhaseIAttemptDeps): Promise<PhysicalPhaseIAttempt> {
  if (!(PHASE_I_STEPS as readonly string[]).includes(input.step)) throw new Error(`physical Phase I step is invalid: ${input.step}`);
  if (input.host !== 'tower' && input.host !== 'vm') throw new Error(`physical Phase I host is invalid: ${input.host}`);
  if (!RUN_ID.test(input.runId)) throw new Error(`physical Phase I runId is invalid: ${input.runId}`);
  if (!validDeviceKey(input.deviceKey) || !validDeviceKey(input.hiveId)) throw new Error('physical Phase I requires raw Ed25519 device and hive keys');
  const variants = PHASE_I_PLAN[input.host][input.step];
  if (!variants) throw new Error(`physical Phase I: host ${input.host} does not run step ${input.step}`);
  assertDir(input.dir);
  const now = deps.now ?? (() => new Date().toISOString());
  const runGit = deps.runGit ?? defaultRunGit;
  const startedAt = now();
  if (input.repoKey !== undefined && (!input.repoKey.trim() || input.repoKey === phaseIRepoKey(input.runId))) {
    throw new Error('physical Phase I canary repoKey must be the canary hive\'s real repo_key, not the run-bound drill key');
  }
  const repoKey = input.repoKey ?? phaseIRepoKey(input.runId);
  const targets = await ensureTargets(input.dir, input.runId, input.deviceKey, runGit);
  const captured = input.vmLive?.capturedOwnerProof ?? null;
  let capturedOwnerProof: PhysicalPhaseIAttempt['capturedOwnerProof'] = null;
  const ctx: HostContext = {
    host: input.host,
    runId: input.runId,
    deviceKey: input.deviceKey,
    hiveId: input.hiveId,
    repoKey,
    targets,
    runGit,
    signDevice: deps.signDevice,
    ownerSigner: input.host === 'vm' && input.ownerSocket ? ownerSocketSigner(input.ownerSocket) : null,
    capturedOwnerSignature: captured ? Buffer.from(captured.signatureBase64, 'base64') : null,
    onOwnerSignature: (bytes, signature) => {
      capturedOwnerProof ??= { bytesBase64: bytes.toString('base64'), signatureBase64: signature.toString('base64') };
    },
  };

  const probe = Buffer.from(`phase-i:${input.runId}:${input.host}:${input.step}:device-probe`);
  const deviceSignature = await deps.signDevice(probe);
  const election = electFleetLeader({
    scope: { kind: 'fleet', ownerGithubUserId: 1, slug: 'p521-phase-i' },
    rosterMemberUids: new Set([1]),
    rosterEpoch: phaseIRosterEpoch(input.runId),
    presence: [],
    self: { devicePubkey: input.deviceKey, githubUserId: 1 },
    incumbent: null,
    nowMs: Date.parse(startedAt),
    staleMs: 90_000,
    leaseMs: 30_000,
  });

  const attempts: PhaseIEffectAttempt[] = [];
  let lost: PhaseILostSequence | null = null;
  if (input.step === 'lost') {
    lost = await runLostSequence(ctx, input.dir, deps);
  } else {
    for (const variant of variants) {
      for (const effect of PHASE_I_EFFECTS) attempts.push(await exerciseEffect(ctx, effect, variant));
    }
  }

  const committed = await localCommit(targets, input.deviceKey, input.runId, `${input.step}:local`, runGit);
  const landed = (await readNamespaceRef(targets.canonical, input.deviceKey, WORK_REF, runGit)) === committed;

  let deviceHead: SignedSigrefs | null = null;
  let deviceHeadAcceptance: PhysicalPhaseIAttempt['deviceHeadAcceptance'] = null;
  const context: SignedProtocolContext = makeSignedProtocolContext(input.hiveId, repoKey,
    `sg2-1-${createHash('sha256').update(repoKey).digest('hex')}`);
  if (input.host === 'vm' && input.step === 'outage') {
    deviceHead = await buildSigrefs(targets.canonical, input.deviceKey, deps.signDevice, { nowMs: Date.parse(now()), runGit, context });
  }
  if (input.host === 'tower' && input.step === 'outage') {
    const head = input.vmOutage?.deviceHead;
    if (!head) throw new Error('physical Phase I tower outage requires the VM outage device head');
    const accepted = acceptFetchedSigrefs(head, head.device_pubkey, null, { expectedContext: { hive_id: input.hiveId, repo_key: repoKey } });
    deviceHeadAcceptance = { ok: accepted.ok, reason: accepted.ok ? null : accepted.reason };
  }

  return {
    schemaVersion: PHASE_I_ATTEMPT_SCHEMA,
    hostId: input.host,
    step: input.step,
    runId: input.runId,
    startedAt,
    finishedAt: now(),
    attemptPid: process.pid,
    hiveId: input.hiveId,
    repoKey,
    advisory: {
      provenance: 'drill-supplied-roster-inputs',
      rosterEpoch: election.rosterEpoch,
      isSelf: election.isSelf,
      leaderDevicePubkey: election.leaderDevicePubkey,
    },
    deviceSigner: { devicePubkey: input.deviceKey, verified: verifyEd25519(probe, input.deviceKey, deviceSignature) },
    ownerKeyMaterialOnHost: existsSync(ownerPaths(input.dir).key),
    attempts,
    localCommit: { oid: committed, landed },
    capturedOwnerProof: input.host === 'vm' && input.step === 'live' ? capturedOwnerProof : null,
    deviceHead,
    deviceHeadAcceptance,
    lost,
  };
}

async function runLostSequence(ctx: HostContext, dir: string, deps: PhaseIAttemptDeps): Promise<PhaseILostSequence> {
  const owner = await readPhaseIOwnerRecord(dir);
  const kill = deps.killOwner ?? killOwnerProcess;
  const push1 = await exerciseEffect(ctx, 'github-push', 'owner');
  let killedAt = '';
  let ownerGoneVerified = false;
  // The owner dies AFTER the authorized fork push and BEFORE the PR opens.
  const forkPr = await exerciseEffect(ctx, 'fork-pr', 'owner', {
    afterForkPush: async () => {
      killedAt = new Date().toISOString();
      ownerGoneVerified = await kill(owner.pid);
    },
  });
  const push2 = await exerciseEffect(ctx, 'github-push', 'owner-unreachable');
  const submodule = await exerciseEffect(ctx, 'submodule-origin-push', 'owner-unreachable');
  return { ownerPid: owner.pid, killedAt, ownerGoneVerified, push1, forkPr, push2, submodule };
}

async function killOwnerProcess(pid: number): Promise<boolean> {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (!alive()) return false;
  process.kill(pid, 'SIGKILL');
  // converge-exempt: waits up to 5 s for a local child pid to exit after SIGKILL, not a remote observation
  for (let i = 0; i < 100 && alive(); i += 1) await new Promise((r) => setTimeout(r, 50));
  return !alive();
}

// ─── validation ─────────────────────────────────────────────────────────────

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function refused(label: string, a: PhaseIEffectAttempt | undefined, errors: string[]): void {
  if (!a) { errors.push(`${label}: attempt is missing`); return; }
  if (a.ok) errors.push(`${label}: sink reported the effect happened`);
  if (!AUTHORITY_REFUSAL.test(a.reason ?? '')) errors.push(`${label}: refusal was not the owning-hive fence (${a.reason})`);
  if (!same(a.before.protected, a.after.protected)) errors.push(`${label}: a protected target moved`);
  if (a.effect !== 'submodule-origin-push' && a.pushArgs.length > 0) errors.push(`${label}: the sink pushed despite refusal`);
}

function authorized(label: string, a: PhaseIEffectAttempt | undefined, errors: string[]): void {
  if (!a) { errors.push(`${label}: attempt is missing`); return; }
  if (!a.ok || a.reason !== null) { errors.push(`${label}: owner-authorized effect did not happen (${a.reason})`); return; }
  if (a.signerCalls < 1) errors.push(`${label}: the sink never challenged the owner`);
  const b = a.before.protected;
  const p = a.after.protected;
  const moved: Record<PhaseIEffect, boolean> = {
    'canonical-staging': p.stagingRef === a.candidate && b.stagingRef !== a.candidate,
    'release-promotion': p.releaseRef === a.candidate && b.releaseRef !== a.candidate,
    'github-push': p.githubMain === a.candidate && b.githubMain !== a.candidate,
    'submodule-origin-push': p.submoduleOriginMain === a.candidate && b.submoduleOriginMain !== a.candidate,
    'fork-pr': p.forkExists && p.forkRefs.some((r) => r.sha === a.candidate) && p.pullRequests.length === b.pullRequests.length + 1,
  };
  if (!moved[a.effect]) errors.push(`${label}: the protected target did not advance to the candidate`);
}

function noForce(records: PhaseIEffectAttempt[]): boolean {
  return records.every((a) => a.pushArgs.every((args) => !args.some((arg) => /^--force|^-f$|^\+/.test(arg))));
}

function stepHeader(label: string, a: PhysicalPhaseIAttempt | undefined, host: PhaseIHost, step: PhysicalPhaseIStep,
  input: PhysicalPhaseIInput, deviceKey: string, errors: string[]): a is PhysicalPhaseIAttempt {
  if (!a) { errors.push(`${label}: missing step evidence`); return false; }
  if (a.schemaVersion !== PHASE_I_ATTEMPT_SCHEMA) errors.push(`${label}: schemaVersion must be ${PHASE_I_ATTEMPT_SCHEMA}`);
  if (a.hostId !== host || a.step !== step) errors.push(`${label}: host/step label mismatch`);
  if (a.runId !== input.runId || a.repoKey !== phaseIExpectedRepoKey(input)) errors.push(`${label}: not bound to this run`);
  if (a.hiveId !== input.owner.first.hiveId) errors.push(`${label}: attempted against a different hive`);
  if (!a.deviceSigner.verified || a.deviceSigner.devicePubkey !== deviceKey) errors.push(`${label}: device signer is not the host's physical device key`);
  if (a.advisory.rosterEpoch !== phaseIRosterEpoch(input.runId) || !a.advisory.isSelf || a.advisory.leaderDevicePubkey !== deviceKey) {
    errors.push(`${label}: advisory view must elect this host at the shared roster epoch`);
  }
  if (!a.localCommit.landed || !OID.test(a.localCommit.oid)) errors.push(`${label}: a local commit was refused`);
  if ([input.owner.first.pid, input.owner.restored.pid].includes(a.attemptPid)) errors.push(`${label}: attempt ran inside the owner process`);
  const planned = PHASE_I_PLAN[host][step] ?? [];
  const expected = planned.flatMap((variant) => PHASE_I_EFFECTS.map((effect) => `${variant}/${effect}`));
  if (!same(a.attempts.map((x) => `${x.variant}/${x.effect}`), expected)) errors.push(`${label}: attempt matrix is incomplete or reordered`);
  if (host === 'tower' && a.ownerKeyMaterialOnHost) errors.push(`${label}: the owner key is present on the tower`);
  return true;
}

/** The protected identity of a real-target snapshot (observation time excluded). */
function realProtectedRefs(s: PhaseIRealTargetSnapshot): string {
  return JSON.stringify({
    stagingRef: s.stagingRef,
    releaseRef: s.releaseRef,
    githubMain: s.githubMain,
    forkRefs: [...(s.forkRefs ?? [])].sort((a, b) => a.ref.localeCompare(b.ref)),
    pullRequests: [...(s.pullRequests ?? [])].sort((a, b) => a.number - b.number),
  });
}

/**
 * canary-owner target checks (WI-10004748, D-119): the run is bound to the
 * canary's real owning authority, and its real refs are G1-frozen across the
 * outage and G3-advanced after recovery. Ref movement is observed, never
 * pushed by Phase I: the advance is production git-sync's own.
 */
function validatePhaseICanaryTarget(input: PhysicalPhaseIInput, target: Extract<PhaseITarget, { kind: 'canary-owner' }>): string[] {
  const errors: string[] = [];
  if (!target.workspaceId?.trim() || !target.potHomeSlug?.trim()) errors.push('canary target: workspaceId and potHomeSlug are required');
  if (!validDeviceKey(target.hiveId)) errors.push('canary target: hiveId must be the canary hive\'s raw Ed25519 key');
  if (!target.repoKey?.trim() || target.repoKey === phaseIRepoKey(input.runId)) errors.push('canary target: repoKey must be the canary\'s real repo_key, not the run-bound drill key');
  const rt = target.realTargets;
  if (!rt?.beforeOutage || !rt.duringOutage || !rt.afterRecovery) {
    errors.push('canary target: real-target snapshots before, during and after the owner outage are required');
    return errors;
  }
  const at = [rt.beforeOutage, rt.duringOutage, rt.afterRecovery].map((s) => Date.parse(s.observedAt));
  const lo = Date.parse(input.window?.startedAt);
  const hi = Date.parse(input.window?.finishedAt);
  if (!at.every(Number.isFinite) || !(at[0] < at[1] && at[1] < at[2])) errors.push('canary target: real-target snapshots must be ordered before < during < after');
  else if (!(at[0] >= lo && at[2] <= hi)) errors.push('canary target: real-target snapshots must fall inside the Phase I window');
  if (!rt.beforeOutage.stagingRef || !OID.test(rt.beforeOutage.stagingRef)) errors.push('canary target: the canary\'s real staging ref must be observed');
  if (realProtectedRefs(rt.beforeOutage) !== realProtectedRefs(rt.duringOutage)) errors.push('G1: the canary\'s real protected refs moved while its owner was down');
  if (!rt.afterRecovery.stagingRef || !OID.test(rt.afterRecovery.stagingRef) || rt.afterRecovery.stagingRef === rt.duringOutage.stagingRef) {
    errors.push('G3: the restored owner made no fresh progress on the canary\'s real staging ref');
  }
  return errors;
}

export function validatePhysicalPhaseI(input: PhysicalPhaseIInput): PhysicalPhaseIVerdict {
  const errors: string[] = [];
  const fail = (): PhysicalPhaseIVerdict => ({ ok: false, errors, result: null });
  if (input?.schemaVersion !== PHASE_I_INPUT_SCHEMA) errors.push(`schemaVersion must be ${PHASE_I_INPUT_SCHEMA}`);
  if (!RUN_ID.test(input?.runId ?? '')) errors.push('runId is invalid');
  const { towerDeviceKey, vmDeviceKey } = input?.identities ?? ({} as PhysicalPhaseIInput['identities']);
  if (!validDeviceKey(towerDeviceKey) || !validDeviceKey(vmDeviceKey) || towerDeviceKey === vmDeviceKey) {
    errors.push('tower and VM device keys must be distinct raw Ed25519 keys');
  }
  const { first, restored: back, goneAfterLost } = input?.owner ?? ({} as PhysicalPhaseIInput['owner']);
  if (!first || !back || first.schemaVersion !== PHASE_I_OWNER_SCHEMA || back.schemaVersion !== PHASE_I_OWNER_SCHEMA) {
    errors.push('both owner start records are required');
  }
  if (errors.length || !input.steps) return fail();

  // Owner: one key, minted once, on the VM; restored by relaunch, not replaced.
  if (!validDeviceKey(first.hiveId) || first.hiveId !== back.hiveId) errors.push('owner: the restored owner must hold the SAME hive key');
  const target = phaseITargetOf(input);
  if (target.kind === 'canary-owner') {
    if (first.mintedKey || back.mintedKey) errors.push('owner: a canary-owner run must never mint a key');
    if (first.keySource !== 'host-keychain' || back.keySource !== 'host-keychain') errors.push('owner: a canary-owner run must sign through the canary host\'s real hive key');
    if (first.hiveId !== target.hiveId) errors.push('owner: the owning key is not the canary hive key the target names');
    errors.push(...validatePhaseICanaryTarget(input, target));
  } else {
    if (first.keySource === 'host-keychain' || back.keySource === 'host-keychain') errors.push('owner: an ephemeral run must use the drill-minted key');
    if (!first.mintedKey || back.mintedKey) errors.push('owner: the key must be minted exactly once (first start only)');
  }
  if (first.pid === back.pid) errors.push('owner: restoration must be a new owner process');
  if ([towerDeviceKey, vmDeviceKey].includes(first.hiveId)) errors.push('owner: the hive key must not be a physical device key');
  if (first.runId !== input.runId || back.runId !== input.runId) errors.push('owner: records are not bound to this run');
  if (!goneAfterLost) errors.push('owner: the scenario did not confirm the owner process was gone after the lost step');

  const s = input.steps;
  const ok = [
    stepHeader('live/vm', s.live?.vm, 'vm', 'live', input, vmDeviceKey, errors),
    stepHeader('live/tower', s.live?.tower, 'tower', 'live', input, towerDeviceKey, errors),
    stepHeader('lost/vm', s.lost?.vm, 'vm', 'lost', input, vmDeviceKey, errors),
    stepHeader('outage/vm', s.outage?.vm, 'vm', 'outage', input, vmDeviceKey, errors),
    stepHeader('outage/tower', s.outage?.tower, 'tower', 'outage', input, towerDeviceKey, errors),
    stepHeader('restored/vm', s.restored?.vm, 'vm', 'restored', input, vmDeviceKey, errors),
    stepHeader('restored/tower', s.restored?.tower, 'tower', 'restored', input, towerDeviceKey, errors),
  ].every(Boolean);
  if (!ok) return fail();

  // Causal order across hosts and steps.
  const ordered = [s.live.vm, s.live.tower, s.lost.vm, s.outage.vm, s.outage.tower, s.restored.vm, s.restored.tower];
  let cursor = Date.parse(input.window.startedAt);
  for (const a of ordered) {
    for (const t of [a.startedAt, a.finishedAt].map(Date.parse)) {
      if (!Number.isFinite(t) || t < cursor) errors.push(`${a.hostId}/${a.step}: evidence is out of causal order`);
      cursor = Math.max(cursor, t);
    }
  }
  if (Date.parse(back.startedAt) < Date.parse(s.lost.vm.finishedAt) || Date.parse(back.startedAt) > Date.parse(s.restored.vm.startedAt)) {
    errors.push('owner: restoration must happen between the outage and the restored step');
  }
  if (Date.parse(input.window.finishedAt) < cursor) errors.push('window closes before its evidence');

  // Divergent advisory views at the SAME epoch.
  if (s.live.vm.advisory.leaderDevicePubkey === s.live.tower.advisory.leaderDevicePubkey) {
    errors.push('live: advisory views did not diverge');
  }

  const byVariant = (a: PhysicalPhaseIAttempt, variant: PhaseIVariant) => a.attempts.filter((x) => x.variant === variant);
  let authorizedCount = 0;
  let refusedCount = 0;
  const allow = (label: string, x: PhaseIEffectAttempt) => { authorized(label, x, errors); authorizedCount += 1; };
  const deny = (label: string, x: PhaseIEffectAttempt) => { refused(label, x, errors); refusedCount += 1; };

  for (const x of byVariant(s.live.vm, 'owner')) allow(`live/vm/owner/${x.effect}`, x);
  for (const x of byVariant(s.live.vm, 'stale-scope')) deny(`live/vm/stale-scope/${x.effect}`, x);
  for (const x of s.live.tower.attempts) deny(`live/tower/${x.variant}/${x.effect}`, x);
  for (const x of s.outage.vm.attempts) deny(`outage/vm/${x.variant}/${x.effect}`, x);
  for (const x of s.outage.tower.attempts) deny(`outage/tower/${x.variant}/${x.effect}`, x);
  for (const x of byVariant(s.restored.vm, 'owner')) allow(`restored/vm/owner/${x.effect}`, x);
  for (const x of s.restored.tower.attempts) deny(`restored/tower/${x.variant}/${x.effect}`, x);

  // The replayed proof was a GENUINE owner signature, still refused.
  const proof = s.live.vm.capturedOwnerProof;
  if (!proof || !verifyEd25519(Buffer.from(proof.bytesBase64, 'base64'), first.hiveId, Buffer.from(proof.signatureBase64, 'base64'))) {
    errors.push('live: the captured owner proof is not a valid owner signature');
  }

  // Authority lost between push attempts.
  const lost = s.lost.vm.lost;
  if (!lost) {
    errors.push('lost: the lost-authority sequence is missing');
  } else {
    if (lost.ownerPid !== first.pid) errors.push('lost: killed a process other than the first owner');
    if (!lost.ownerGoneVerified || !lost.killedAt) errors.push('lost: owner death was not verified between pushes');
    allow('lost/push1', lost.push1);
    const f = lost.forkPr;
    if (f.ok || !/open PR authorization failed/.test(f.reason ?? '')) errors.push('lost: the PR was not refused after the owner died');
    if (!f.after.protected.forkRefs.some((r) => r.sha === f.candidate)) errors.push('lost: the authorized fork push did not land before the owner died');
    if (f.after.protected.pullRequests.length !== f.before.protected.pullRequests.length) errors.push('lost: a PR opened after the owner died');
    deny('lost/push2', lost.push2);
    if (lost.push2.after.protected.githubMain !== lost.push1.candidate) errors.push('lost: GitHub main is not the last authorized push');
    deny('lost/submodule', lost.submodule);
    if (lost.submodule.after.local.submoduleLocalHead === lost.submodule.before.local.submoduleLocalHead) {
      errors.push('lost: the refused submodule publication dropped the local commit');
    }
  }

  // Local work and device-head exchange survive the outage.
  const head = s.outage.vm.deviceHead;
  if (!head || head.device_pubkey !== vmDeviceKey) errors.push('outage: the VM signed no device head');
  if (!s.outage.tower.deviceHeadAcceptance?.ok) errors.push('outage: the tower refused the VM signed device head');
  for (const x of [...s.outage.vm.attempts, ...s.outage.tower.attempts].filter((a) => a.effect === 'submodule-origin-push')) {
    if (x.after.local.submoduleLocalHead === x.before.local.submoduleLocalHead) errors.push(`outage/${x.variant}: a local submodule commit was dropped`);
  }

  // Fresh progress after restoration.
  const liveVm = new Map(byVariant(s.live.vm, 'owner').map((x) => [x.effect, x]));
  for (const x of byVariant(s.restored.vm, 'owner')) {
    const prior = liveVm.get(x.effect);
    if (!prior || x.candidate === prior.candidate) errors.push(`restored/${x.effect}: no fresh progress beyond the pre-outage state`);
  }

  const all = [...ordered.flatMap((a) => a.attempts), ...(lost ? [lost.push1, lost.forkPr, lost.push2, lost.submodule] : [])];
  if (!noForce(all)) errors.push('a push used force');
  if (errors.length) return fail();
  return {
    ok: true,
    errors: [],
    result: {
      schemaVersion: PHASE_I_RESULT_SCHEMA,
      phase: 'I',
      planItem: PHASE_I_PLAN_ITEM,
      status: 'complete',
      complete: true,
      missingAssertions: [],
      observedAt: new Date(cursor).toISOString(),
      counts: { authorized: authorizedCount, refused: refusedCount },
      assertions: {
        divergentAdvisoryViewsAtSameEpoch: true,
        onlyOwningHiveAuthorizedEveryProtectedEffect: true,
        missingDeviceOnlyReplayedForeignAndStaleAuthorityRefusedWithoutEffect: true,
        authorityLostBetweenPushAttemptsFroze: true,
        ownerOutageFrozeBothHostsWithoutFailover: true,
        localCommitsAndDeviceHeadExchangePermitted: true,
        restoredOwnerMadeFreshAuthorizedProgress: true,
        noForcePush: true,
      },
    },
  };
}

/** Stable digest of the verify input, for the evidence manifest. */
export function physicalPhaseIInputDigest(input: PhysicalPhaseIInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
