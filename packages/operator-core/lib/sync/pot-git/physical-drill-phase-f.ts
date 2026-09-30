/**
 * Fixed production-code adapter for P-505 physical Phase F / P-307.
 *
 * Phase F is host-local lifecycle safety, so the physical scenario executes
 * this adapter independently on both registered machines. Each execution
 * creates private throwaway bare repositories, drives the real G-9 collector
 * and G-10 publish guard, records exact before/after refs and refusal codes,
 * then removes the repositories before returning. No caller-selected path,
 * command, ref, namespace, cap, or evidence document crosses this seam.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcHiveGitRepo, type PotGitGcResult } from './gc';
import { checkPublishGuard, type PublishGuardResult } from './publish-guard';
import {
  defaultRunGit,
  defaultRunGitStdin,
  deviceNamespaceKey,
  type RunGit,
  type RunGitStdin,
} from './storage';

export const PHASE_F_INPUT_SCHEMA = 'hive-git-physical-phase-f-input/v1' as const;
export const PHASE_F_HOST_SCHEMA = 'hive-git-physical-phase-f-host/v1' as const;
export const PHASE_F_RESULT_SCHEMA = 'hive-git-physical-phase-f-result/v1' as const;
export const PHASE_F_PLAN_ITEM = 'P-307' as const;

const RUN_ID = /^[A-Za-z0-9._:-]{8,160}$/;
const DEVICE_KEY = /^[A-Za-z0-9+/]{43}=$/;

export type PhysicalPhaseFHost = 'tower' | 'vm';

type GuardSummary = Pick<
  PublishGuardResult,
  'ok' | 'refusalCode' | 'newObjectCount' | 'newTotalBytes' | 'errors'
> & {
  oversizeCount: number;
  secretFindingCount: number;
};

export type PhysicalPhaseFHostResult = {
  schemaVersion: typeof PHASE_F_HOST_SCHEMA;
  runId: string;
  planItem: typeof PHASE_F_PLAN_ITEM;
  hostId: PhysicalPhaseFHost;
  deviceKey: string;
  peerDeviceKey: string;
  observedAt: string;
  productionSurfaces: ['gcHiveGitRepo', 'checkPublishGuard'];
  namespaces: { live: string; departed: string };
  gc: {
    beforeRefs: string[];
    afterRefs: string[];
    result: PotGitGcResult;
  };
  guards: {
    clean: GuardSummary;
    secret: GuardSummary;
    oversized: GuardSummary;
  };
  temporaryReposRemoved: true;
};

export type PhysicalPhaseFInput = {
  schemaVersion: typeof PHASE_F_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  hostResults: [PhysicalPhaseFHostResult, PhysicalPhaseFHostResult];
};

export type PhysicalPhaseFVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_F_RESULT_SCHEMA;
    phase: 'F';
    planItem: typeof PHASE_F_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
    assertions: {
      bothPhysicalHostsExecutedProductionLifecycle: true;
      workRefAndNewestTwoPublishedRefsKept: true;
      oldestPublishedRefPruned: true;
      departedNamespaceArchived: true;
      cleanPublishAdmitted: true;
      plantedCredentialRefused: true;
      oversizedBlobRefused: true;
      temporaryRepositoriesRemoved: true;
    };
  };
};

type PhaseFDeps = {
  runGit?: RunGit;
  runGitStdin?: RunGitStdin;
  makeTempDir?: () => Promise<string>;
  removeTempDir?: (path: string) => Promise<void>;
  now?: () => string;
};

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`physical Phase F runId is invalid: ${runId}`);
}

function assertDeviceKey(deviceKey: string): void {
  if (!DEVICE_KEY.test(deviceKey) || Buffer.from(deviceKey, 'base64').length !== 32) {
    throw new Error('physical Phase F requires raw 32-byte Ed25519 device keys in base64');
  }
}

async function git(runGit: RunGit, cwd: string, args: string[]): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) throw new Error(`physical Phase F git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function gitStdin(
  runGitStdin: RunGitStdin,
  cwd: string,
  args: string[],
  stdin: string,
): Promise<string> {
  const result = await runGitStdin(args, cwd, stdin);
  if (result.code !== 0) throw new Error(`physical Phase F git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.toString('utf8').trim();
}

async function createCommit(input: {
  repoPath: string;
  path: string;
  content: string;
  parent?: string;
  runGit: RunGit;
  runGitStdin: RunGitStdin;
}): Promise<string> {
  const blob = await gitStdin(input.runGitStdin, input.repoPath, ['hash-object', '-w', '--stdin'], input.content);
  const tree = await gitStdin(
    input.runGitStdin,
    input.repoPath,
    ['mktree'],
    `100644 blob ${blob}\t${input.path}\n`,
  );
  return gitStdin(
    input.runGitStdin,
    input.repoPath,
    [
      '-c', 'user.name=Papercusp Physical Drill',
      '-c', 'user.email=physical-drill@papercusp.invalid',
      'commit-tree', tree,
      ...(input.parent ? ['-p', input.parent] : []),
    ],
    `physical Phase F ${input.path}\n`,
  );
}

async function listRefs(runGit: RunGit, repoPath: string): Promise<string[]> {
  const output = await git(runGit, repoPath, ['for-each-ref', '--format=%(refname)']);
  return output.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

function guardSummary(result: PublishGuardResult): GuardSummary {
  return {
    ok: result.ok,
    refusalCode: result.refusalCode,
    newObjectCount: result.newObjectCount,
    newTotalBytes: result.newTotalBytes,
    oversizeCount: result.oversizeBlobs.length,
    secretFindingCount: result.secretFindings.length,
    errors: [...result.errors],
  };
}

export async function executePhysicalPhaseFHost(
  input: {
    hostId: PhysicalPhaseFHost;
    deviceKey: string;
    peerDeviceKey: string;
    runId: string;
  },
  deps: PhaseFDeps = {},
): Promise<PhysicalPhaseFHostResult> {
  assertRunId(input.runId);
  assertDeviceKey(input.deviceKey);
  assertDeviceKey(input.peerDeviceKey);
  if (input.deviceKey === input.peerDeviceKey) {
    throw new Error('physical Phase F requires distinct local and peer device keys');
  }
  const runGit = deps.runGit ?? defaultRunGit;
  const runGitStdin = deps.runGitStdin ?? defaultRunGitStdin;
  const makeTempDir = deps.makeTempDir ?? (() => mkdtemp(join(tmpdir(), `papercusp-phase-f-${input.hostId}-`)));
  const removeTempDir = deps.removeTempDir ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const root = await makeTempDir();
  const gcRepo = join(root, 'gc.git');
  const guardRepo = join(root, 'guard.git');
  const live = deviceNamespaceKey(input.deviceKey);
  const departed = deviceNamespaceKey(input.peerDeviceKey);
  let result: Omit<PhysicalPhaseFHostResult, 'temporaryReposRemoved'>;
  try {
    await git(runGit, root, ['init', '--bare', gcRepo]);
    const refs = [
      [`refs/namespaces/${live}/refs/heads/work`, 'work-v1'],
      [`refs/namespaces/${live}/published/v1`, 'published-v1'],
      [`refs/namespaces/${live}/published/v2`, 'published-v2'],
      [`refs/namespaces/${live}/published/v3`, 'published-v3'],
      [`refs/namespaces/${departed}/published/v1`, 'departed-v1'],
    ] as const;
    for (const [ref, content] of refs) {
      const oid = await createCommit({ repoPath: gcRepo, path: 'phase-f.txt', content, runGit, runGitStdin });
      await git(runGit, gcRepo, ['update-ref', ref, oid]);
    }
    const beforeRefs = await listRefs(runGit, gcRepo);
    const gcResult = await gcHiveGitRepo(gcRepo, {
      archiveNamespaces: [departed],
      keepPublishedRefsPerNamespace: 2,
      runGit,
    });
    const afterRefs = await listRefs(runGit, gcRepo);

    await git(runGit, root, ['init', '--bare', guardRepo]);
    const base = await createCommit({ repoPath: guardRepo, path: 'base.txt', content: 'base\n', runGit, runGitStdin });
    const secret = await createCommit({
      repoPath: guardRepo,
      path: 'credential.txt',
      content: `aws_key = ${['AKIA', 'ABCDEFGHIJKLMNOP'].join('')}\n`,
      parent: base,
      runGit,
      runGitStdin,
    });
    const oversized = await createCommit({
      repoPath: guardRepo,
      path: 'oversized.bin',
      content: 'x'.repeat(6_144),
      parent: base,
      runGit,
      runGitStdin,
    });
    const cleanGuard = await checkPublishGuard({ repoPath: guardRepo, fromOid: null, toOid: base, runGit });
    const secretGuard = await checkPublishGuard({ repoPath: guardRepo, fromOid: base, toOid: secret, runGit });
    const oversizedGuard = await checkPublishGuard({
      repoPath: guardRepo,
      fromOid: base,
      toOid: oversized,
      caps: { maxBlobBytes: 4_096 },
      runGit,
    });
    result = {
      schemaVersion: PHASE_F_HOST_SCHEMA,
      runId: input.runId,
      planItem: PHASE_F_PLAN_ITEM,
      hostId: input.hostId,
      deviceKey: input.deviceKey,
      peerDeviceKey: input.peerDeviceKey,
      observedAt: (deps.now ?? (() => new Date().toISOString()))(),
      productionSurfaces: ['gcHiveGitRepo', 'checkPublishGuard'],
      namespaces: { live, departed },
      gc: { beforeRefs, afterRefs, result: gcResult },
      guards: {
        clean: guardSummary(cleanGuard),
        secret: guardSummary(secretGuard),
        oversized: guardSummary(oversizedGuard),
      },
    };
  } finally {
    await removeTempDir(root);
  }
  return { ...result, temporaryReposRemoved: true };
}

function sameStrings(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((value, index) => actual[index] === value);
}

export function validatePhysicalPhaseF(input: PhysicalPhaseFInput): PhysicalPhaseFVerdict {
  const errors: string[] = [];
  if (input?.schemaVersion !== PHASE_F_INPUT_SCHEMA) errors.push(`schemaVersion must be ${PHASE_F_INPUT_SCHEMA}`);
  if (!RUN_ID.test(input?.runId ?? '')) errors.push('Phase F runId is invalid or missing');
  const startedAt = Date.parse(input?.window?.startedAt ?? '');
  const finishedAt = Date.parse(input?.window?.finishedAt ?? '');
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt <= startedAt) {
    errors.push('Phase F window must contain ordered ISO-8601 timestamps');
  }
  const expectedKeys: Record<PhysicalPhaseFHost, string> = {
    tower: input?.identities?.towerDeviceKey,
    vm: input?.identities?.vmDeviceKey,
  };
  for (const key of Object.values(expectedKeys)) {
    if (!DEVICE_KEY.test(key ?? '') || Buffer.from(key ?? '', 'base64').length !== 32) {
      errors.push('Phase F identities must contain two raw Ed25519 device keys');
      break;
    }
  }
  if (expectedKeys.tower === expectedKeys.vm) errors.push('Phase F physical device identities must be distinct');
  if (!Array.isArray(input?.hostResults) || input.hostResults.length !== 2) {
    errors.push('Phase F must contain exactly one lifecycle result from each physical host');
  }
  const seen = new Set<string>();
  for (const host of input?.hostResults ?? []) {
    if (host.schemaVersion !== PHASE_F_HOST_SCHEMA) errors.push(`Phase F ${host.hostId} host schema is invalid`);
    if (host.runId !== input.runId) errors.push(`Phase F ${host.hostId} runId must match the enclosing phase`);
    if (host.planItem !== PHASE_F_PLAN_ITEM) errors.push(`Phase F ${host.hostId} planItem must be ${PHASE_F_PLAN_ITEM}`);
    if ((host.hostId !== 'tower' && host.hostId !== 'vm') || seen.has(host.hostId)) {
      errors.push('Phase F host results contain an unknown or duplicate host');
      continue;
    }
    seen.add(host.hostId);
    const peerHost: PhysicalPhaseFHost = host.hostId === 'tower' ? 'vm' : 'tower';
    if (host.deviceKey !== expectedKeys[host.hostId] || host.peerDeviceKey !== expectedKeys[peerHost]) {
      errors.push(`Phase F ${host.hostId} result is not bound to the two physical identities`);
    }
    const observedAt = Date.parse(host.observedAt);
    if (!Number.isFinite(observedAt) || observedAt < startedAt || observedAt > finishedAt) {
      errors.push(`Phase F ${host.hostId} observation must fall inside the same-run window`);
    }
    if (!sameStrings(host.productionSurfaces, ['gcHiveGitRepo', 'checkPublishGuard'])) {
      errors.push(`Phase F ${host.hostId} must execute the production G-9/G-10 surfaces`);
    }
    const live = deviceNamespaceKey(host.deviceKey);
    const departed = deviceNamespaceKey(host.peerDeviceKey);
    if (host.namespaces.live !== live || host.namespaces.departed !== departed) {
      errors.push(`Phase F ${host.hostId} namespaces must derive from the attested devices`);
    }
    const before = [
      `refs/namespaces/${departed}/published/v1`,
      `refs/namespaces/${live}/published/v1`,
      `refs/namespaces/${live}/published/v2`,
      `refs/namespaces/${live}/published/v3`,
      `refs/namespaces/${live}/refs/heads/work`,
    ].sort();
    const after = [
      `refs/archive/namespaces/${departed}/published/v1`,
      `refs/namespaces/${live}/published/v2`,
      `refs/namespaces/${live}/published/v3`,
      `refs/namespaces/${live}/refs/heads/work`,
    ].sort();
    if (!sameStrings(host.gc.beforeRefs, before)) errors.push(`Phase F ${host.hostId} pre-GC refs are incomplete`);
    if (!sameStrings(host.gc.afterRefs, after)) errors.push(`Phase F ${host.hostId} post-GC refs violate retention`);
    if (host.gc.result.errors.length !== 0 || !host.gc.result.archivedNamespaces.includes(departed)) {
      errors.push(`Phase F ${host.hostId} G-9 collector did not archive cleanly`);
    }
    if (!host.guards.clean.ok || host.guards.clean.refusalCode !== null) {
      errors.push(`Phase F ${host.hostId} clean publish must be admitted`);
    }
    if (host.guards.secret.ok || host.guards.secret.refusalCode !== 'secrets' || host.guards.secret.secretFindingCount < 1) {
      errors.push(`Phase F ${host.hostId} planted credential must be refused as secrets`);
    }
    if (
      host.guards.oversized.ok ||
      host.guards.oversized.refusalCode !== 'blob-over-cap' ||
      host.guards.oversized.oversizeCount < 1
    ) {
      errors.push(`Phase F ${host.hostId} oversized blob must be refused at the fixed boundary`);
    }
    if (host.temporaryReposRemoved !== true) errors.push(`Phase F ${host.hostId} temporary repositories were not removed`);
  }
  for (const host of ['tower', 'vm']) {
    if (!seen.has(host)) errors.push(`Phase F is missing the ${host} physical-host result`);
  }
  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    result: uniqueErrors.length === 0
      ? {
          schemaVersion: PHASE_F_RESULT_SCHEMA,
          phase: 'F',
          planItem: PHASE_F_PLAN_ITEM,
          status: 'complete',
          complete: true,
          missingAssertions: [],
          observedAt: input.window.finishedAt,
          assertions: {
            bothPhysicalHostsExecutedProductionLifecycle: true,
            workRefAndNewestTwoPublishedRefsKept: true,
            oldestPublishedRefPruned: true,
            departedNamespaceArchived: true,
            cleanPublishAdmitted: true,
            plantedCredentialRefused: true,
            oversizedBlobRefused: true,
            temporaryRepositoriesRemoved: true,
          },
        }
      : null,
  };
}
