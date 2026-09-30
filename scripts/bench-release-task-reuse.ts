/**
 * Controlled performance evidence for BYOC delivery acceleration P-006.
 *
 * The cold arm packages deterministic bytes, hashes them, signs them and creates
 * a manifest. The hit arm enters through the production prior-receipt journal
 * seam, then re-hashes, verifies the signature, unpacks the offline payload and
 * rechecks the manifest before committing a NEW receipt. Queue wait remains a
 * separate field, so scheduler delay cannot masquerade as preparation work.
 *
 * Usage: npx tsx scripts/bench-release-task-reuse.ts > report.json
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';

import type {
  AppendTaskReleaseReceiptResult,
  PriorCommittedTaskReleaseReceipt,
  TaskReleaseJournal,
  TaskReleaseReceipt,
} from '../packages/operator-core/lib/task-manager/store';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry';
import { redactIdentityLeaks } from './lib/identity-leak-patterns.mjs';
import {
  beginReleaseTaskStage,
  inspectReleaseTaskStage,
  releaseTaskStageInputHash,
  settleReleaseTaskStage,
  type ReleaseTaskIdentity,
  type ReleaseTaskLedger,
  type ReleaseTaskStageContext,
  type ReleaseTaskStageInput,
} from './lib/release-task-journal.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_NOW = new Date('2026-09-09T12:40:00.000Z');
const REUSE_MAX_AGE_MS = 86_400_000;
const FIXTURE_BYTES = 8 * 1024 * 1024;
const PAIRS = 5;

interface TimedSample {
  run: number;
  coldPreparationMs: number;
  hitPreparationMs: number;
  lookupMs: number;
  queueWaitMs: number | null;
  coldAction: string;
  hitAction: string;
  committedAction: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(...args: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
}

function committedGitlinks(): Record<string, string> {
  const links = git('ls-tree', 'HEAD')
    .split('\n')
    .flatMap((line) => {
      const match = /^160000 commit ([0-9a-f]{40,64})\t(.+)$/.exec(line);
      return match ? [[match[2], match[1]] as const] : [];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(links);
}

function deterministicBytes(): Buffer {
  const bytes = Buffer.allocUnsafe(FIXTURE_BYTES);
  let state = 0x6d2b79f5;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function deterministicEd25519KeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  const seed = Buffer.from('7061706572637573702d703030362d62656e63686d61726b2d6b65792d763121', 'hex');
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const privateKey = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

function journal(operationId: string, sourceSha: string, gitlinks: Record<string, string>): TaskReleaseJournal {
  return {
    schemaVersion: 1,
    operationId,
    source: { sha: sourceSha, gitlinks },
    artifactIdentity: {
      kind: 'papercusp-desktop-release',
      sourceSha,
      version: 'p006-controlled-fixture-v1',
      channel: 'benchmark',
    },
    cursor: 0,
    currentStage: null,
    currentState: null,
    spentOperationIds: [],
    receipts: [],
  };
}

function ledger(
  taskId: string,
  operationId: string,
  sourceSha: string,
  gitlinks: Record<string, string>,
  reusable: PriorCommittedTaskReleaseReceipt | null,
): ReleaseTaskLedger & { journal: TaskReleaseJournal } {
  const state = journal(operationId, sourceSha, gitlinks);
  return {
    get journal() {
      return state;
    },
    async getTask(candidate) {
      return candidate === taskId ? { detail: { release: state } } : null;
    },
    taskReleaseJournalFromDetail(detail) {
      return detail?.release === state ? state : null;
    },
    async findPriorCommittedTaskReleaseReceipt() {
      return reusable;
    },
    async appendTaskReleaseReceipt(candidate, expectedCursor, input): Promise<AppendTaskReleaseReceiptResult> {
      if (candidate !== taskId) return { ok: false, reason: 'task_not_found', journal: null };
      if (state.cursor !== expectedCursor) return { ok: false, reason: 'cursor_mismatch', journal: state };
      const matching = state.receipts.filter((receipt) => receipt.requestIdentity === input.requestIdentity);
      const prior = matching.at(-1);
      const valid = input.state === 'intent'
        ? matching.length === 0
        : input.state === 'unknown'
          ? prior?.state === 'intent'
          : prior?.state === 'intent' || prior?.state === 'unknown';
      if (!valid) return { ok: false, reason: 'invalid_transition', journal: state };
      const receipt: TaskReleaseReceipt = {
        sequence: state.cursor,
        operationId: input.operationId,
        requestIdentity: input.requestIdentity,
        stage: input.stage,
        state: input.state,
        inputHash: input.inputHash,
        inputIdentity: input.inputIdentity ?? null,
        evidenceRefs: [...(input.evidenceRefs ?? [])],
        credentialGeneration: input.credentialGeneration ?? null,
        credentialExpiresAt: input.credentialExpiresAt ?? null,
        reuseSource: input.reuseSource ?? null,
        lookupElapsedMs: input.lookupElapsedMs ?? null,
        queueWaitMs: input.queueWaitMs ?? null,
        preparationElapsedMs: input.preparationElapsedMs ?? null,
        reuseExpiresAt: input.reuseExpiresAt ?? null,
        recordedAt: FIXED_NOW.toISOString(),
      };
      state.receipts.push(receipt);
      state.cursor += 1;
      state.currentStage = receipt.stage;
      state.currentState = receipt.state;
      if (receipt.state === 'intent') state.spentOperationIds.push(receipt.requestIdentity);
      return { ok: true, journal: state, receipt };
    },
  };
}

function context(
  taskId: string,
  operationId: string,
  store: ReleaseTaskLedger,
  identity: ReleaseTaskIdentity,
  expiresAt: string,
): ReleaseTaskStageContext {
  return {
    taskId,
    operationId,
    ledger: store,
    identity,
    credentialGeneration: 'benchmark-generation-1',
    credentialExpiresAt: expiresAt,
    reuseMaxAgeMs: REUSE_MAX_AGE_MS,
    reuseExpiresAt: expiresAt,
    queueWaitMs: 0,
    now: () => FIXED_NOW,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Keep captured benchmark evidence safe to commit without changing its measurements. */
export function serializeBenchmarkReport(report: unknown, identityEntries?: [string, string][]): string {
  return `${redactIdentityLeaks(JSON.stringify(report, null, 2), identityEntries)}\n`;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const sourceSha = git('rev-parse', 'HEAD');
  const gitlinks = committedGitlinks();
  const expiresAt = new Date(FIXED_NOW.getTime() + REUSE_MAX_AGE_MS).toISOString();
  const identity: ReleaseTaskIdentity = {
    sourceSha,
    gitlinks,
    version: 'p006-controlled-fixture-v1',
    channel: 'benchmark',
  };
  const sourceBytes = deterministicBytes();
  const sourceDigest = sha256(sourceBytes);
  const { privateKey, publicKey } = deterministicEd25519KeyPair();
  const signingIdentity = sha256(publicKey.export({ type: 'spki', format: 'der' }));
  const stageInput: ReleaseTaskStageInput = {
    stage: 'release.build.linux',
    requiredReuseEvidenceRefs: ['artifact-set:hash-signature-verified'],
    identity: {
      tenant: { workspaceId: 'papercusp-workspace', harness: 'papercusp' },
      dependencies: {
        generation: 'controlled-v1',
        packageLock: 'fixture-lock-v1',
        cargoLock: 'fixture-cargo-v1',
      },
      toolchain: { node: process.version, compressor: 'node:zlib:gzip:level-9' },
      profile: { host: `${process.platform}-${process.arch}`, roles: ['gui'], channel: 'benchmark' },
      policy: {
        localPostgres: true,
        localSpa: true,
        selectedEmbedderDefault: 'local',
        vendorContentUpload: false,
      },
      signing: { updaterPublicKeySha256: signingIdentity },
      audit: { reuseMaxAgeMs: REUSE_MAX_AGE_MS, verifier: 'sha256+ed25519+gunzip' },
      offlineAssets: { embedded: true, networkRequired: false, sourceDigest },
    },
  };
  const stageIdentity = stageInput.identity as Record<string, Record<string, unknown>>;

  const samples: TimedSample[] = [];
  let artifactDigest: string | null = null;
  let manifestDigest: string | null = null;
  let finalHitReceipt: TaskReleaseReceipt | null = null;
  for (let run = 0; run < PAIRS; run += 1) {
    const coldTaskId = `p006-cold-task-${run}`;
    const coldOperationId = `p006-cold-${run}`;
    const coldLedger = ledger(coldTaskId, coldOperationId, sourceSha, gitlinks, null);
    const coldContext = context(coldTaskId, coldOperationId, coldLedger, identity, expiresAt);
    const coldBegin = await beginReleaseTaskStage(coldContext, stageInput);
    if (coldBegin.action !== 'run' || !coldBegin.requestIdentity) throw new Error('cold arm did not run');

    const coldStarted = performance.now();
    const artifact = gzipSync(sourceBytes, { level: 9 });
    const thisArtifactDigest = sha256(artifact);
    const signature = sign(null, artifact, privateKey);
    const manifest = {
      schemaVersion: 1,
      stage: stageInput.stage,
      inputHash: releaseTaskStageInputHash(coldContext, stageInput),
      artifactSha256: thisArtifactDigest,
      artifactBytes: artifact.length,
      signatureSha256: sha256(signature),
      sourceSha256: sourceDigest,
      tenant: stageIdentity.tenant,
      offlineAssets: stageIdentity.offlineAssets,
    };
    const thisManifestDigest = sha256(JSON.stringify(manifest));
    const coldPreparationMs = performance.now() - coldStarted;
    const coldSettled = await settleReleaseTaskStage(coldContext, {
      ...stageInput,
      requestIdentity: coldBegin.requestIdentity,
      state: 'committed',
      evidenceRefs: [
        'artifact-set:hash-signature-verified',
        `artifact:sha256:${thisArtifactDigest}`,
        `manifest:sha256:${thisManifestDigest}`,
        'offline-assets:verified',
        'tenant:papercusp-workspace/papercusp',
      ],
      preparationElapsedMs: coldPreparationMs,
    });
    const coldReceipt = coldLedger.journal.receipts.at(-1);
    if (coldSettled.action !== 'reuse' || coldReceipt?.state !== 'committed') {
      throw new Error('cold arm did not commit');
    }

    const hitTaskId = `p006-hit-task-${run}`;
    const hitOperationId = `p006-hit-${run}`;
    const hitLedger = ledger(hitTaskId, hitOperationId, sourceSha, gitlinks, {
      taskId: coldTaskId,
      operationId: coldOperationId,
      receipt: coldReceipt,
    });
    const hitContext = context(hitTaskId, hitOperationId, hitLedger, identity, expiresAt);
    const hitBegin = await beginReleaseTaskStage(hitContext, stageInput);
    if (hitBegin.action !== 'reconcile' || hitBegin.reuseSource?.taskId !== coldTaskId || !hitBegin.requestIdentity) {
      throw new Error('hit arm did not seed a reconcile intent from the prior receipt');
    }

    const hitStarted = performance.now();
    if (sha256(artifact) !== thisArtifactDigest) throw new Error('artifact digest mismatch');
    if (!verify(null, artifact, publicKey, signature)) throw new Error('signature verification failed');
    if (sha256(gunzipSync(artifact)) !== sourceDigest) throw new Error('offline artifact payload mismatch');
    if (sha256(JSON.stringify(manifest)) !== thisManifestDigest) throw new Error('manifest digest mismatch');
    if (JSON.stringify(manifest.tenant) !== JSON.stringify(stageIdentity.tenant)) {
      throw new Error('tenant identity mismatch');
    }
    const hitPreparationMs = performance.now() - hitStarted;
    const hitSettled = await settleReleaseTaskStage(hitContext, {
      ...stageInput,
      requestIdentity: hitBegin.requestIdentity,
      state: 'committed',
      evidenceRefs: coldReceipt.evidenceRefs,
      preparationElapsedMs: hitPreparationMs,
    });
    const hitReceipt = hitLedger.journal.receipts.at(-1);
    if (hitSettled.action !== 'reuse' || hitReceipt?.state !== 'committed') {
      throw new Error('hit arm did not commit after verification');
    }

    artifactDigest ??= thisArtifactDigest;
    manifestDigest ??= thisManifestDigest;
    if (thisArtifactDigest !== artifactDigest || thisManifestDigest !== manifestDigest) {
      throw new Error('paired artifact or manifest bytes drifted');
    }
    finalHitReceipt = hitReceipt;
    samples.push({
      run,
      coldPreparationMs: Number(coldPreparationMs.toFixed(3)),
      hitPreparationMs: Number(hitPreparationMs.toFixed(3)),
      lookupMs: Number((hitBegin.lookupElapsedMs ?? 0).toFixed(3)),
      queueWaitMs: hitReceipt.queueWaitMs ?? null,
      coldAction: coldBegin.action,
      hitAction: hitBegin.action,
      committedAction: hitSettled.action,
    });
  }

  if (!finalHitReceipt || !artifactDigest || !manifestDigest) throw new Error('benchmark produced no samples');
  const coldMedianMs = median(samples.map((sample) => sample.coldPreparationMs));
  const hitMedianMs = median(samples.map((sample) => sample.hitPreparationMs));
  const reductionPct = 100 * (coldMedianMs - hitMedianMs) / coldMedianMs;
  const baselineHash = releaseTaskStageInputHash({ identity, reuseMaxAgeMs: REUSE_MAX_AGE_MS }, stageInput);
  const mutate = (
    changedIdentity: ReleaseTaskIdentity,
    changedStage: ReleaseTaskStageInput,
  ): boolean => releaseTaskStageInputHash(
    { identity: changedIdentity, reuseMaxAgeMs: REUSE_MAX_AGE_MS },
    changedStage,
  ) !== baselineHash;
  const replaceStageIdentity = (key: string, value: unknown): ReleaseTaskStageInput => ({
    ...stageInput,
    identity: { ...stageIdentity, [key]: value },
  });
  const invalidationMatrix = {
    source: mutate({ ...identity, sourceSha: 'f'.repeat(40) }, stageInput),
    gitlink: mutate(
      { ...identity, gitlinks: { ...gitlinks, 'papercusp-desktop': 'e'.repeat(40) } },
      stageInput,
    ),
    dependency: mutate(identity, replaceStageIdentity('dependencies', {
      ...stageIdentity.dependencies,
      generation: 'controlled-v2',
    })),
    toolchain: mutate(identity, replaceStageIdentity('toolchain', {
      ...stageIdentity.toolchain,
      node: 'changed-node',
    })),
    profile: mutate(identity, replaceStageIdentity('profile', {
      ...stageIdentity.profile,
      roles: ['server'],
    })),
    policy: mutate(identity, replaceStageIdentity('policy', {
      ...stageIdentity.policy,
      vendorContentUpload: true,
    })),
    signing: mutate(identity, replaceStageIdentity('signing', {
      updaterPublicKeySha256: 'd'.repeat(64),
    })),
    audit: mutate(identity, replaceStageIdentity('audit', {
      ...stageIdentity.audit,
      verifier: 'changed-verifier',
    })),
  };
  if (Object.values(invalidationMatrix).some((changed) => !changed)) {
    throw new Error('one or more identity mutations did not invalidate');
  }

  const expiryTaskId = 'p006-expiry-task';
  const expiryOperationId = 'p006-expiry-operation';
  const expiryLedger = ledger(expiryTaskId, expiryOperationId, sourceSha, gitlinks, null);
  expiryLedger.journal.receipts.push({
    ...finalHitReceipt,
    sequence: 0,
    operationId: expiryOperationId,
  });
  expiryLedger.journal.cursor = 1;
  expiryLedger.journal.currentStage = stageInput.stage;
  expiryLedger.journal.currentState = 'committed';
  const expiryContext = {
    ...context(expiryTaskId, expiryOperationId, expiryLedger, identity, expiresAt),
    now: () => new Date(expiresAt),
  };
  const expired = await inspectReleaseTaskStage(expiryContext, stageInput);
  if (expired.action !== 'refused' || expired.freshness !== 'expired') {
    throw new Error('exact expiry boundary did not refuse');
  }
  if (reductionPct < 30) throw new Error(`controlled preparation reduction ${reductionPct}% is below 30%`);

  const implementationFiles = [
    'packages/operator-core/lib/task-manager/store.ts',
    'scripts/lib/release-task-journal.mts',
    'packages/operator-core/lib/harness/routines/nightly-release-cut-action.ts',
    'papercusp-desktop/bin/release-local.sh',
    'scripts/bench-release-task-reuse.ts',
  ];
  const sourceFingerprints = Object.fromEntries(implementationFiles.map((file) => [
    file,
    sha256(readFileSync(join(REPO_ROOT, file))),
  ]));
  const finishedAt = new Date();
  const roundedReductionPct = Number(reductionPct.toFixed(3));
  const summary =
    `Five same-host paired release-preparation runs reduced median preparation from ${coldMedianMs} ms ` +
    `to ${hitMedianMs} ms (${roundedReductionPct}%), above the 30% bar. Every hit re-verified ` +
    'artifact bytes, Ed25519 signature, manifest, offline payload and tenant identity; all eight identity ' +
    'mutations and the exact audit-expiry boundary invalidated reuse.';
  const report = {
    schemaVersion: 1,
    kind: 'operational-test-evidence',
    name: 'BYOC P-006 controlled trusted artifact reuse benchmark',
    framework: 'operational',
    command: [
      'npx tsx scripts/bench-release-task-reuse.ts >/tmp/p006-reuse-benchmark-current.json',
    ],
    exitCode: 0,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    summary,
    assertions: [
      {
        id: 'preparation-reduction',
        passed: reductionPct >= 30,
        evidence: `cold median ${coldMedianMs} ms; verified-hit median ${hitMedianMs} ms; reduction ${roundedReductionPct}% >= 30% across ${samples.length} paired runs`,
      },
      {
        id: 'receipt-transition',
        passed: samples.every((sample) => sample.coldAction === 'run' && sample.hitAction === 'reconcile' && sample.committedAction === 'reuse'),
        evidence: 'Every cold arm ran; every prior-receipt hit seeded only a reconcile intent; every verified hit committed a new receipt.',
      },
      {
        id: 'artifact-trust',
        passed: true,
        evidence: `All hit arms reproduced artifact ${artifactDigest} and manifest ${manifestDigest}, verified Ed25519 signatures, and gunzipped to source ${sourceDigest}.`,
      },
      {
        id: 'identity-invalidation',
        passed: Object.values(invalidationMatrix).every(Boolean),
        evidence: `One-at-a-time mutations all changed the input hash: ${Object.keys(invalidationMatrix).join(', ')}.`,
      },
      {
        id: 'freshness-boundary',
        passed: expired.action === 'refused' && expired.freshness === 'expired',
        evidence: `A committed receipt inspected exactly at ${expiresAt} returned action=refused and freshness=expired.`,
      },
      {
        id: 'isolation-offline-queue',
        passed: finalHitReceipt.queueWaitMs === 0,
        evidence: 'Tenant stayed papercusp-workspace/papercusp, offline payload verification required no network, and queueWaitMs=0 remained separate from preparationElapsedMs.',
      },
    ],
    benchmark: 'BYOC-ACCEL-P006-CACHE@2 controlled release preparation',
    observedAtUtc: new Date().toISOString(),
    // os.hostname() reads the same value in-process; spawning `hostname` was a
    // resource start outside admission (lint:resource-governor-enforcement).
    host: hostname(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    pinnedSource: { sourceSha, gitlinks, sourceFingerprints },
    fixture: {
      bytes: sourceBytes.length,
      sourceSha256: sourceDigest,
      artifactSha256: artifactDigest,
      manifestSha256: manifestDigest,
      signingIdentitySha256: signingIdentity,
      tenant: stageIdentity.tenant,
      offlineAssets: stageIdentity.offlineAssets,
    },
    method: {
      pairs: samples.length,
      cold: 'gzip level 9 + SHA-256 + Ed25519 sign + manifest digest, then committed receipt',
      hit: 'prior committed receipt -> reconcile hint; SHA-256 + Ed25519 verify + offline gunzip/source digest + manifest digest, then new committed receipt',
      queueTreatment: 'queueWaitMs fixed at 0 and recorded separately from preparation',
      statistic: 'median of five paired runs on the same host and deterministic bytes',
    },
    samples,
    result: {
      coldMedianMs,
      hitMedianMs,
      reductionPct: roundedReductionPct,
      requiredReductionPct: 30,
      passed: reductionPct >= 30,
      artifactBytesIdentical: true,
      manifestDigestIdentical: true,
      signatureVerifiedEveryHit: true,
      offlineReadinessVerifiedEveryHit: true,
      tenantIdentityPreserved: true,
      exactExpiryBoundaryRefused: true,
      invalidationMatrix,
    },
    receiptEvidence: {
      queueWaitMs: finalHitReceipt.queueWaitMs,
      preparationElapsedMs: finalHitReceipt.preparationElapsedMs,
      reuseExpiresAt: finalHitReceipt.reuseExpiresAt,
      reuseSource: finalHitReceipt.reuseSource,
      evidenceRefs: finalHitReceipt.evidenceRefs,
    },
  };
  process.stdout.write(serializeBenchmarkReport(report));
}

if (isCliEntry(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
