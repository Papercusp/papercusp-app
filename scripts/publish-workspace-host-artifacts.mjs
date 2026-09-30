#!/usr/bin/env -S npx tsx
/**
 * Publish a workspace-host publication to the Cupboard artifact store.
 *
 * The store caps a DIRECT server.tgz PUT at 64MB (MAX_BYTES in
 * apps/operator-public/src/routes/workspace-host-artifacts.ts), so a real
 * release bundle (GBs) MUST go through the multipart route. This script is the
 * client for that route; there was none before, and hand-rolling curl for a
 * 64-part upload with per-part digests is how a release gets corrupted quietly.
 *
 * Wire contract (mirrors the route + its test):
 *   POST   .../sha256/<sha>/server.tgz/multipart              {parts:[{partNumber,sha256,sizeBytes}]}
 *          headers: x-artifact-sha256, x-artifact-size        -> 201 {uploadId,...} | 200 {deduped:true}
 *   PUT    .../server.tgz/multipart/parts/<n>?uploadId=<id>   headers: x-part-sha256, x-part-size
 *   POST   .../server.tgz/multipart/complete?uploadId=<id>    {parts:[{partNumber,etag}]}
 *   PUT    .../sha256/<sha>/<file>                            headers: x-artifact-sha256, x-artifact-size
 *   POST   .../sha256/<sha>/finalize
 *
 * Every non-final part must be an identical size >= 5MB and <= 32MB, and the
 * sizes must sum to x-artifact-size, so the plan is computed from the file
 * itself rather than declared by the caller.
 *
 * Usage:
 *   npm run release:publish-workspace-host-artifacts -- \
 *     --dir ~/.papercusp/p046-r11-workspace-host-publication \
 *     [--base https://cupboard.papercusp.com] \    # default; see DEFAULT_BASE
 *     [--token <bearer>]        # default: `gh auth token`
 *     [--plan-only]             # hash + plan + preflight, no writes
 *
 * Exit 0 only when the publication is finalized AND the public object is
 * reachable; anything else is a non-zero failure naming the leg that failed.
 */

import { createHash } from 'node:crypto';
import { open, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { tsImport } from 'tsx/esm/api';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { releaseStageInputHash, releaseStageRequestIdentity } from './lib/release-task-journal.mts';

export { releaseStageInputHash, releaseStageRequestIdentity };

const PART_BYTES = 32 * 1024 * 1024;
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 1024;
const DIRECT_MAX = { 'server.tgz.minisig': 64 * 1024, 'manifest.json': 1024 * 1024 };
const SBOM_MAX_BYTES = 16 * 1024 * 1024;
const SENSITIVE_KEY = /(?:access[_-]?token|api[_-]?key|authorization|credential|password|private[_-]?key|secret|signature|token|upload[-_]?id)/i;
const SENSITIVE_QUERY = /(?:access[_-]?token|api[_-]?key|authorization|credential|password|private[_-]?key|secret|signature|token|upload[-_]?id)/i;
const SENSITIVE_ASSIGNMENT = new RegExp(
  `\\b(${SENSITIVE_QUERY.source})\\b\\s*[:=]\\s*(?:Bearer\\s+)?[^\\s,;}]+`,
  'gi',
);
const SENSITIVE_ERROR_FIELDS = [
  'name',
  'message',
  'code',
  'errno',
  'syscall',
  'hostname',
  'address',
  'port',
  'type',
];
/**
 * The BRANDED Cupboard host, matching WORKSPACE_HOST_ARTIFACT_ORIGIN in
 * libs/generic/deployment-driver/src/workspace-host-build-manifest.ts — the origin the artifacts
 * this script publishes are later FETCHED from, so the two must name the same host.
 *
 * ⚠ Deliberately NOT the Worker's own `*.workers.dev` origin. That form embeds the Cloudflare
 * ACCOUNT SUBDOMAIN (the release owner's GitHub handle); scripts/ ships inside the release bundle,
 * so a literal here is a personal identity string in the product (WI-38233 / WI-38321).
 *
 * ⚠ FROM THE PAPERCUSP DEV BOX this host will hang: that box blackholes TLS to every
 * papercusp-family name by SNI (EI-16742, agent-insights/su-box-sni-tls-blackhole-not-outage). It
 * is a LOCAL network filter, not an outage — pass `--base <the worker's own origin>` for a run
 * from that box rather than changing this default back.
 */
const DEFAULT_BASE = 'https://cupboard.papercusp.com';

export const USAGE = `Usage:
  npm run release:publish-workspace-host-artifacts -- \\
    --dir <publication-dir> [--base <url>] [--token <bearer>] [--plan-only] [--evidence-only]
`;

export function parseArgs(argv, env = process.env) {
  const out = { base: DEFAULT_BASE, planOnly: false, concurrency: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--task-id') out.taskId = argv[++i];
    else if (a === '--operation-id') out.operationId = argv[++i];
    else if (a === '--plan-only') out.planOnly = true;
    else if (a === '--evidence-only') out.evidenceOnly = true;
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.help) return out;
  if (!out.dir) throw new Error('--dir <publication dir> is required');
  if (!Number.isSafeInteger(out.concurrency) || out.concurrency < 1 || out.concurrency > 32) {
    throw new Error('--concurrency must be an integer between 1 and 32');
  }
  out.taskId ??= env.PAPERCUSP_RELEASE_TASK_ID?.trim();
  out.operationId ??= env.PAPERCUSP_RELEASE_OPERATION_ID?.trim();
  out.base = out.base.replace(/\/+$/, '');
  return out;
}

function resolveToken(explicit) {
  if (explicit) return explicit;
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  if (!token) throw new Error('gh auth token returned empty; pass --token');
  return token;
}

function redactText(value) {
  return String(value)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:access[_-]?token|api[_-]?key|authorization|credential|password|private[_-]?key|secret|signature|token|upload[-_]?id)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, (match) => match.replace(/([:=]\s*)(?:Bearer\s+)?[^\s,;}]+$/i, '$1[REDACTED]'));
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return redactText(url.toString());
  } catch {
    return redactText(value);
  }
}

function serializeError(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? redactText(value) : value;
  }
  if (depth >= 4) return '[cause depth limit]';
  if (seen.has(value)) return '[circular cause]';
  seen.add(value);

  const result = {};
  for (const key of SENSITIVE_ERROR_FIELDS) {
    if (!(key in value)) continue;
    const field = value[key];
    if (SENSITIVE_KEY.test(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof field === 'string') {
      result[key] = redactText(field);
    } else if (
      field === null ||
      typeof field === 'number' ||
      typeof field === 'boolean'
    ) {
      result[key] = field;
    }
  }
  if ('cause' in value && value.cause !== undefined) {
    result.cause = serializeError(value.cause, seen, depth + 1);
  }
  if ('errors' in value && Array.isArray(value.errors)) {
    result.errors = value.errors.map((entry) => serializeError(entry, seen, depth + 1));
  }
  seen.delete(value);
  return Object.keys(result).length > 0 ? result : redactText(Object.prototype.toString.call(value));
}

export function formatRequestError(stage, url, error) {
  return `${stage} request failed URL=${redactUrl(url)} error=${JSON.stringify(serializeError(error))}`;
}

/**
 * ONE streaming pass computes the whole-file digest AND every part digest,
 * and checks the bootstrap executables in those same archive bytes.
 * Reading the file twice would let a concurrent writer produce a plan that
 * disagrees with the bytes actually uploaded.
 */
export async function hashAndPlan(path) {
  // Keep CLI --help side-effect-free. The bootstrap contract, not a second
  // hand-written list or the manifest's claimed profile, owns this inventory.
  const [{ default: tar }, { DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS }] = await Promise.all([
    import('tar-stream'),
    tsImport('@papercusp/deployment-driver', import.meta.url),
  ]);
  const required = new Set(Object.values(DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS));
  const seen = new Set();
  const failures = new Set();
  const archive = tar.extract();
  archive.on('entry', (header, stream, next) => {
    const name = header.name.replace(/^(\.\/)+/, '');
    if (required.has(name)) {
      if (seen.has(name)) failures.add(`${name}: duplicate archive entry`);
      seen.add(name);
      // These are the actual executable release programs. A link or directory
      // with the right name does not prove an executable will exist on the VM.
      if (header.type !== 'file' || header.size <= 0 || (header.mode & 0o111) === 0) {
        failures.add(`${name}: expected a non-empty executable regular file`);
      }
    }
    stream.on('end', next);
    stream.resume();
  });
  const { size } = await stat(path);
  if (size === 0) throw new Error(`${path} is empty`);
  const partCount = Math.ceil(size / PART_BYTES);
  if (partCount > MAX_PARTS) {
    throw new Error(`bundle needs ${partCount} parts, store allows ${MAX_PARTS}`);
  }
  if (partCount > 1 && PART_BYTES < MIN_PART_BYTES) {
    throw new Error('part size below the store minimum');
  }

  const whole = createHash('sha256');
  const parts = [];
  const fh = await open(path, 'r');
  try {
    async function* compressedParts() {
      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        const offset = (partNumber - 1) * PART_BYTES;
        const want = Math.min(PART_BYTES, size - offset);
        // Each yielded buffer belongs to the pipeline until consumed; reusing
        // one scratch buffer would let gunzip observe the next part's bytes.
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fh.read(buf, 0, want, offset);
        if (bytesRead !== want) {
          throw new Error(`short read at part ${partNumber}: ${bytesRead} != ${want}`);
        }
        whole.update(buf);
        parts.push({
          partNumber,
          sha256: createHash('sha256').update(buf).digest('hex'),
          sizeBytes: want,
        });
        yield buf;
      }
    }
    await pipeline(
      Readable.from(compressedParts(), { objectMode: false, highWaterMark: 64 * 1024 }),
      createGunzip(),
      archive,
    );
  } finally {
    await fh.close();
  }
  for (const name of required) {
    if (!seen.has(name)) failures.add(`${name}: missing executable release entrypoint`);
  }
  if (failures.size > 0) {
    throw new Error(`workspace-host bundle cannot bootstrap: ${[...failures].join('; ')}`);
  }
  return { size, sha256: whole.digest('hex'), parts };
}

async function readPart(path, partNumber) {
  const offset = (partNumber - 1) * PART_BYTES;
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const want = Math.min(PART_BYTES, size - offset);
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await fh.read(buf, 0, want, offset);
    if (bytesRead !== want) throw new Error(`short read at part ${partNumber}`);
    return buf;
  } finally {
    await fh.close();
  }
}

const SAFE_RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function request(
  url,
  init,
  attempts = 4,
  stage = 'request',
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const method = String(init?.method ?? 'GET').toUpperCase();
  if (attempts > 1 && !SAFE_RETRY_METHODS.has(method)) {
    throw new Error(
      `${stage} refused a blind ${method} retry; journal the intent and reconcile its outcome instead`,
    );
  }
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchImpl(url, init);
      // 4xx is a contract answer, not a transport blip: never retry it, or a
      // digest mismatch is re-sent until it looks like a network problem.
      if (res.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(1000 * attempt);
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(1000 * attempt);
    }
  }
  throw new Error(
    formatRequestError(stage, url, lastError ?? new Error('request failed')),
    { cause: lastError },
  );
}

async function body(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 400) };
  }
}

class ReleaseHttpError extends Error {
  constructor(leg, res, payload) {
    super(`${leg} failed: HTTP ${res.status} ${JSON.stringify(payload)}`);
    this.name = 'ReleaseHttpError';
    this.status = res.status;
    this.payload = payload;
    this.outcomeUnknown =
      res.status >= 500 ||
      (res.status === 409 && /outcome_unknown/.test(String(payload?.error ?? '')));
  }
}

function fail(leg, res, payload) {
  throw new ReleaseHttpError(leg, res, payload);
}

async function loadDefaultReleaseLedger() {
  const store = await import('@papercusp/operator-core/lib/task-manager/store');
  return {
    getTask: store.getTask,
    appendTaskReleaseReceipt: store.appendTaskReleaseReceipt,
    taskReleaseJournalFromDetail: store.taskReleaseJournalFromDetail,
  };
}

function latestReceipt(receipts, requestIdentity) {
  return [...receipts]
    .reverse()
    .find((receipt) => receipt.requestIdentity === requestIdentity) ?? null;
}

function matchingStageReceipts(journal, stage, inputHash) {
  const forStage = journal.receipts.filter((receipt) => receipt.stage === stage);
  const conflicting = forStage.find((receipt) => receipt.inputHash !== inputHash);
  if (conflicting) {
    throw new Error(
      `release stage ${stage} input changed within operation ${journal.operationId}; ` +
        `receipt ${conflicting.sequence} pins ${conflicting.inputHash}, current input is ${inputHash}`,
    );
  }
  return forStage;
}

async function readReleaseJournal(ledger, taskId, operationId) {
  const task = await ledger.getTask(taskId);
  if (!task) throw new Error(`release task ${taskId} is absent from the task ledger`);
  const journal = ledger.taskReleaseJournalFromDetail(task.detail);
  if (!journal) {
    throw new Error(`release task ${taskId} has no complete task_ledger.detail.release journal`);
  }
  if (journal.operationId !== operationId) {
    throw new Error(
      `release task ${taskId} belongs to operation ${journal.operationId}, not ${operationId}`,
    );
  }
  return { task, journal };
}

async function appendReleaseReceipt(ctx, receipt) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { journal } = await readReleaseJournal(ctx.ledger, ctx.taskId, ctx.operationId);
    const prior = latestReceipt(journal.receipts, receipt.requestIdentity);
    if (prior?.state === receipt.state) return journal;
    const result = await ctx.ledger.appendTaskReleaseReceipt(
      ctx.taskId,
      journal.cursor,
      {
        operationId: ctx.operationId,
        ...receipt,
        credentialGeneration: ctx.credentialGeneration,
        credentialExpiresAt: ctx.credentialExpiresAt,
      },
    );
    if (result.ok) return result.journal;
    if (result.reason === 'cursor_mismatch' || result.reason === 'cas_conflict') continue;
    throw new Error(
      `release journal refused ${receipt.stage}/${receipt.requestIdentity}/${receipt.state}: ${result.reason}`,
    );
  }
  throw new Error(`release journal stayed contended while recording ${receipt.stage}/${receipt.state}`);
}

function assertCredentialFresh(ctx) {
  if (!ctx.credentialExpiresAt) return;
  const expiresAt = Date.parse(ctx.credentialExpiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new Error('PAPERCUSP_RELEASE_CREDENTIAL_EXPIRES_AT must be an ISO timestamp');
  }
  if (expiresAt <= ctx.now().getTime()) {
    throw new Error(
      `release credential ${ctx.credentialGeneration ?? '(unreported)'} expired at ${ctx.credentialExpiresAt}`,
    );
  }
}

async function reconcilePending(ctx, args, requestIdentity, priorState) {
  let reconciled;
  try {
    reconciled = await args.reconcile(requestIdentity);
  } catch (error) {
    if (priorState === 'intent') {
      await appendReleaseReceipt(ctx, {
        requestIdentity,
        stage: args.stage,
        state: 'unknown',
        inputHash: args.inputHash,
        evidenceRefs: ['reconcile:unavailable'],
      });
    }
    throw new Error(
      `release stage ${args.stage} outcome remains unknown because reconciliation failed: ${error.message}`,
      { cause: error },
    );
  }
  if (reconciled.state === 'committed') {
    await appendReleaseReceipt(ctx, {
      requestIdentity,
      stage: args.stage,
      state: 'committed',
      inputHash: args.inputHash,
      evidenceRefs: reconciled.evidenceRefs ?? [],
    });
    return reconciled;
  }
  if (reconciled.state === 'absent') {
    await appendReleaseReceipt(ctx, {
      requestIdentity,
      stage: args.stage,
      state: 'refused',
      inputHash: args.inputHash,
      evidenceRefs: ['reconcile:confirmed-absent', ...(reconciled.evidenceRefs ?? [])],
    });
    return reconciled;
  }
  if (priorState === 'intent') {
    await appendReleaseReceipt(ctx, {
      requestIdentity,
      stage: args.stage,
      state: 'unknown',
      inputHash: args.inputHash,
      evidenceRefs: reconciled.evidenceRefs ?? ['reconcile:outcome-unknown'],
    });
  }
  throw new Error(`release stage ${args.stage} provider outcome is still unknown; refusing another mutation`);
}

/**
 * Execute one provider mutation behind the task-ledger receipt chain.
 * A mutation is attempted once. A second attempt is possible only after the
 * adapter proves the prior identity absent; a committed receipt is revalidated
 * against the provider before it is trusted.
 */
export async function runJournaledMutation(ctx, args) {
  assertCredentialFresh(ctx);
  const inputHash = releaseStageInputHash(args.input);
  const stageArgs = { ...args, inputHash };
  let { journal } = await readReleaseJournal(ctx.ledger, ctx.taskId, ctx.operationId);
  let receipts = matchingStageReceipts(journal, args.stage, inputHash);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const identities = [...new Set(receipts.map((receipt) => receipt.requestIdentity))];
    const activeIdentity = identities.at(-1) ?? null;
    const prior = activeIdentity ? latestReceipt(receipts, activeIdentity) : null;

    if (prior?.state === 'committed') {
      if (args.restore) {
        await ctx.afterStage?.(args.stage, { resumed: true, requestIdentity: activeIdentity });
        return args.restore(prior);
      }
      const verified = await args.reconcile(activeIdentity);
      if (verified.state !== 'committed') {
        throw new Error(
          `release stage ${args.stage} has a committed receipt but provider verification returned ${verified.state}`,
        );
      }
      await ctx.afterStage?.(args.stage, { resumed: true, requestIdentity: activeIdentity });
      return verified.value;
    }

    if (prior?.state === 'intent' || prior?.state === 'unknown') {
      const reconciled = await reconcilePending(ctx, stageArgs, activeIdentity, prior.state);
      if (reconciled.state === 'committed') {
        await ctx.afterStage?.(args.stage, { resumed: true, requestIdentity: activeIdentity });
        return reconciled.value;
      }
      ({ journal } = await readReleaseJournal(ctx.ledger, ctx.taskId, ctx.operationId));
      receipts = matchingStageReceipts(journal, args.stage, inputHash);
      continue;
    }

    if (prior?.state === 'refused' && !prior.evidenceRefs.includes('reconcile:confirmed-absent')) {
      throw new Error(`release stage ${args.stage} was refused for request ${activeIdentity}; input must change before retry`);
    }

    const requestIdentity = releaseStageRequestIdentity(
      ctx.operationId,
      args.stage,
      inputHash,
      identities.length,
    );
    await appendReleaseReceipt(ctx, {
      requestIdentity,
      stage: args.stage,
      state: 'intent',
      inputHash,
      evidenceRefs: args.intentEvidenceRefs ?? [],
    });

    let outcome;
    try {
      assertCredentialFresh(ctx);
      outcome = await args.mutate(requestIdentity);
    } catch (error) {
      if (error instanceof ReleaseHttpError && !error.outcomeUnknown) {
        await appendReleaseReceipt(ctx, {
          requestIdentity,
          stage: args.stage,
          state: 'refused',
          inputHash,
          evidenceRefs: [`http:${error.status}`],
        });
        throw error;
      }
      await appendReleaseReceipt(ctx, {
        requestIdentity,
        stage: args.stage,
        state: 'unknown',
        inputHash,
        evidenceRefs: ['response:outcome-unknown'],
      });
      const reconciled = await reconcilePending(ctx, stageArgs, requestIdentity, 'unknown');
      if (reconciled.state === 'committed') {
        await ctx.afterStage?.(args.stage, { resumed: true, requestIdentity });
        return reconciled.value;
      }
      ({ journal } = await readReleaseJournal(ctx.ledger, ctx.taskId, ctx.operationId));
      receipts = matchingStageReceipts(journal, args.stage, inputHash);
      continue;
    }
    await appendReleaseReceipt(ctx, {
      requestIdentity,
      stage: args.stage,
      state: 'committed',
      inputHash,
      evidenceRefs: outcome.evidenceRefs ?? [],
    });
    await ctx.afterStage?.(args.stage, { resumed: false, requestIdentity });
    return outcome.value;
  }
  throw new Error(`release stage ${args.stage} exhausted reconciled attempts`);
}

async function parseResponse(res, leg) {
  const payload = await body(res);
  if (!res.ok) fail(leg, res, payload);
  return payload;
}

function descriptorFromHead(res) {
  if (res.status === 404) return null;
  if (!res.ok) throw new ReleaseHttpError('artifact HEAD', res, { error: `HTTP ${res.status}` });
  const sha256 = res.headers.get('x-artifact-sha256');
  const sizeBytes = Number(res.headers.get('content-length'));
  return typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256) && Number.isSafeInteger(sizeBytes)
    ? { sha256, sizeBytes }
    : null;
}

function releaseContext(args, deps) {
  if (!args.taskId || !args.operationId) {
    throw new Error(
      'publishing requires --task-id/--operation-id or ' +
        'PAPERCUSP_RELEASE_TASK_ID/PAPERCUSP_RELEASE_OPERATION_ID; ' +
        'an unjournaled mutation is not resumable',
    );
  }
  return {
    taskId: args.taskId,
    operationId: args.operationId,
    credentialGeneration: deps.env.PAPERCUSP_RELEASE_CREDENTIAL_GENERATION?.trim() || null,
    credentialExpiresAt: deps.env.PAPERCUSP_RELEASE_CREDENTIAL_EXPIRES_AT?.trim() || null,
    ledger: deps.ledger,
    now: deps.now,
    afterStage: deps.afterStage,
  };
}

function assertPublicationJournalIdentity(journal, manifest, plan) {
  const source = journal.source;
  const manifestRevision = manifest?.artifact?.buildManifest?.source?.revision;
  if (
    !source ||
    typeof source !== 'object' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(source.sha ?? '')) ||
    !source.gitlinks ||
    typeof source.gitlinks !== 'object' ||
    Array.isArray(source.gitlinks) ||
    Object.keys(source.gitlinks).length === 0 ||
    !Object.values(source.gitlinks).every((sha) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(sha)))
  ) {
    throw new Error('release journal must pin the exact source SHA and a non-empty gitlink map');
  }
  if (typeof manifestRevision !== 'string' || manifestRevision !== source.sha) {
    throw new Error(
      `release journal source ${source.sha} does not match manifest source ${manifestRevision ?? '(missing)'}`,
    );
  }
  const identity = journal.artifactIdentity;
  const manifestVersion = manifest?.artifact?.release?.version ?? manifest?.artifact?.image?.version;
  const exactDigest = identity && typeof identity === 'object'
    ? identity.bundleSha256
    : undefined;
  const logicalIdentityMatches =
    identity &&
    typeof identity === 'object' &&
    identity.sourceSha === source.sha &&
    typeof identity.version === 'string' &&
    identity.version === manifestVersion;
  if (
    !identity ||
    typeof identity !== 'object' ||
    !(exactDigest === plan.sha256 || (exactDigest === undefined && logicalIdentityMatches))
  ) {
    throw new Error(
      `release journal artifact identity must pin bundleSha256 ${plan.sha256} ` +
        'or the manifest\'s exact source/version identity',
    );
  }
}

async function headArtifact(ctx, deps, url, expected, requestIdentity) {
  const res = await request(
    url,
    { method: 'HEAD' },
    4,
    `reconcile ${requestIdentity}`,
    deps.fetch,
    deps.sleep,
  );
  if (res.status === 404) return { state: 'absent', evidenceRefs: [`provider:absent:${requestIdentity}`] };
  const descriptor = descriptorFromHead(res);
  if (!descriptor) return { state: 'unknown', evidenceRefs: [`provider:unreadable:${requestIdentity}`] };
  if (descriptor.sha256 !== expected.sha256 || descriptor.sizeBytes !== expected.sizeBytes) {
    throw new Error(
      `provider artifact conflicts at ${url}: ${descriptor.sha256}/${descriptor.sizeBytes} ` +
        `!= ${expected.sha256}/${expected.sizeBytes}`,
    );
  }
  return {
    state: 'committed',
    value: descriptor,
    evidenceRefs: [`provider:head:${expected.sha256}:${expected.sizeBytes}`],
  };
}

export async function publishWorkspaceHostArtifacts(args, injected = {}) {
  const deps = {
    fetch: injected.fetch ?? globalThis.fetch,
    sleep: injected.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    ledger: injected.ledger ?? null,
    env: injected.env ?? process.env,
    now: injected.now ?? (() => new Date()),
    log: injected.log ?? console.log,
    afterStage: injected.afterStage,
  };
  if (!args.planOnly && !deps.ledger) deps.ledger = await loadDefaultReleaseLedger();
  const log = deps.log;
  const ctx = args.planOnly ? null : releaseContext(args, deps);
  if (args.evidenceOnly) {
    const manifestRaw = await readFile(join(args.dir, 'manifest.json'));
    const manifest = JSON.parse(manifestRaw.toString('utf8'));
    const sbom = await readPublicationSbom(args.dir, manifest);
    if (args.planOnly) return { planOnly: true, evidenceOnly: true, sha256: sbom.sha256 };
    return publishSbomEvidence(args, deps, ctx, manifestRaw, manifest, sbom);
  }
  const bundlePath = join(args.dir, 'server.tgz');

  log('=== [1/6] verify bootstrap executables + hash bundle + build part plan ===');
  const plan = await hashAndPlan(bundlePath);
  log(`  bundle sha256 ${plan.sha256}`);
  log(`  bytes ${plan.size}  parts ${plan.parts.length} x ${PART_BYTES}B`);

  // The manifest is the release's own claim about which bytes it describes.
  // Uploading a bundle whose digest disagrees with it would publish a manifest
  // that points at something else, so refuse before any write.
  // Shape per validatePublicationManifest: { schemaVersion, kind, artifact,
  // files:{bundle,signature}, trustReport }. Read the digest from the path the
  // route validates, and treat an ABSENT claim as a hard failure — a check that
  // silently does not run is indistinguishable from one that passed.
  const manifestRaw = await readFile(join(args.dir, 'manifest.json'));
  const manifest = JSON.parse(manifestRaw.toString('utf8'));
  const sbom = await readPublicationSbom(args.dir, manifest);
  const claimed = manifest?.files?.bundle?.sha256;
  const claimedRelease = manifest?.artifact?.release?.bundleSha256;
  if (typeof claimed !== 'string' || typeof claimedRelease !== 'string') {
    throw new Error(
      'manifest.json has no files.bundle.sha256 / artifact.release.bundleSha256 — ' +
        'cannot verify it describes this bundle; regenerate the publication',
    );
  }
  for (const [label, value] of [['files.bundle', claimed], ['artifact.release', claimedRelease]]) {
    if (value !== plan.sha256) {
      throw new Error(
        `manifest ${label} declares ${value} but server.tgz hashes to ${plan.sha256} — refusing`,
      );
    }
  }
  log(`  manifest bundle claim MATCHES (files.bundle + artifact.release)`);

  const root = `${args.base}/admin/artifacts/workspace-host/sha256/${plan.sha256}`;
  const mp = `${root}/server.tgz/multipart`;

  // Resolve the bearer at the latest possible boundary. Hash/manifest validation
  // is credential-free, and an expired/invalid credential should not be held in
  // memory during that potentially long preflight.
  const token = resolveToken(args.token);
  const auth = { Authorization: `Bearer ${token}` };
  if (ctx && !ctx.credentialGeneration) {
    ctx.credentialGeneration =
      `github-token-sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
  }

  if (args.planOnly) {
    const probe = await request(
      `${args.base}/admin/reports`,
      { headers: auth },
      4,
      'credential preflight',
      deps.fetch,
      deps.sleep,
    );
    log(`  credential preflight: HTTP ${probe.status} (200 expected)`);
    log('PLAN_ONLY=1 — no writes performed');
    return { planOnly: true, plan };
  }

  // A plan-only invocation deliberately works without a task row; every write
  // below is journaled and therefore requires the context.
  const release = ctx;
  const { journal: openingJournal } = await readReleaseJournal(
    release.ledger,
    release.taskId,
    release.operationId,
  );
  assertPublicationJournalIdentity(openingJournal, manifest, plan);

  log('=== [2/6] initiate multipart ===');
  const init = await runJournaledMutation(release, {
    stage: 'publish.multipart.initiate',
    input: { bundleSha256: plan.sha256, sizeBytes: plan.size, parts: plan.parts },
    intentEvidenceRefs: [`bundle:sha256:${plan.sha256}`],
    mutate: async (requestIdentity) => {
      const res = await request(
        mp,
        {
          method: 'POST',
          headers: {
            ...auth,
            'content-type': 'application/json',
            'x-artifact-sha256': plan.sha256,
            'x-artifact-size': String(plan.size),
            'x-operation-id': requestIdentity,
          },
          body: JSON.stringify({ parts: plan.parts }),
        },
        1,
        'initiate multipart',
        deps.fetch,
        deps.sleep,
      );
      const payload = await parseResponse(res, 'initiate');
      return {
        value: payload,
        evidenceRefs: [
          payload.deduped ? `provider:bundle:${plan.sha256}` : `provider:multipart:${requestIdentity}`,
        ],
      };
    },
    reconcile: async (requestIdentity) => {
      const statusUrl =
        `${mp}?uploadId=${encodeURIComponent(requestIdentity)}` +
        '&partNumber=1';
      const res = await request(
        statusUrl,
        { method: 'GET', headers: auth },
        4,
        'reconcile multipart initiation',
        deps.fetch,
        deps.sleep,
      );
      if (res.status === 404) return { state: 'absent' };
      const payload = await parseResponse(res, 'reconcile initiate');
      return {
        state: 'committed',
        value: payload.completed === true
          ? { ...payload, deduped: true }
          : {
              ok: true,
              uploadId: requestIdentity,
              operationId: requestIdentity,
              partCount: plan.parts.length,
              deduped: false,
              resumed: true,
            },
        evidenceRefs: [
          payload.completed === true
            ? `provider:bundle:${plan.sha256}`
            : `provider:multipart:${requestIdentity}`,
        ],
      };
    },
  });

  let uploaded = [];
  if (init.deduped) {
    log('  bundle already stored (deduped) — skipping part upload');
  } else {
    const uploadId = init.uploadId;
    log(`  uploadId ${uploadId}  partCount ${init.partCount}`);

    log('=== [3/6] upload parts ===');
    const results = new Array(plan.parts.length);
    let cursor = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= plan.parts.length) return;
        const part = plan.parts[index];
        const buf = await readPart(bundlePath, part.partNumber);
        const payload = await runJournaledMutation(release, {
          stage: `publish.multipart.part.${part.partNumber}`,
          input: { bundleSha256: plan.sha256, uploadId, ...part },
          intentEvidenceRefs: [`part:sha256:${part.sha256}:${part.sizeBytes}`],
          mutate: async () => {
            const res = await request(
              `${mp}/parts/${part.partNumber}?uploadId=${encodeURIComponent(uploadId)}`,
              {
                method: 'PUT',
                headers: {
                  ...auth,
                  'content-type': 'application/octet-stream',
                  'content-length': String(part.sizeBytes),
                  'x-part-sha256': part.sha256,
                  'x-part-size': String(part.sizeBytes),
                },
                body: buf,
              },
              1,
              `part ${part.partNumber}`,
              deps.fetch,
              deps.sleep,
            );
            const value = await parseResponse(res, `part ${part.partNumber}`);
            return {
              value,
              evidenceRefs: [`provider:multipart:${uploadId}:part:${part.partNumber}:${value.etag}`],
            };
          },
          reconcile: async () => {
            const statusUrl =
              `${mp}?uploadId=${encodeURIComponent(uploadId)}` +
              `&partNumber=${part.partNumber}`;
            const res = await request(
              statusUrl,
              { method: 'GET', headers: auth },
              4,
              `reconcile part ${part.partNumber}`,
              deps.fetch,
              deps.sleep,
            );
            if (res.status === 404) return { state: 'absent' };
            const value = await parseResponse(res, `reconcile part ${part.partNumber}`);
            if (value.completed === true) {
              return {
                state: 'committed',
                value: { completed: true },
                evidenceRefs: [`provider:bundle:${plan.sha256}`],
              };
            }
            if (value.state === 'committed') {
              return {
                state: 'committed',
                value,
                evidenceRefs: [`provider:multipart:${uploadId}:part:${part.partNumber}:${value.etag}`],
              };
            }
            if (value.state === 'absent') return { state: 'absent' };
            return { state: 'unknown', evidenceRefs: [`provider:multipart:${uploadId}:part:${part.partNumber}:intent`] };
          },
        });
        if (payload.completed === true) {
          throw new Error(
            `bundle ${plan.sha256} completed concurrently; restart to reconcile from initiation`,
          );
        }
        results[index] = { partNumber: part.partNumber, etag: payload.etag };
        done += 1;
        if (done % 8 === 0 || done === plan.parts.length) {
          log(`  ${done}/${plan.parts.length} parts uploaded`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(args.concurrency, plan.parts.length) }, worker),
    );
    uploaded = results;

    log('=== [4/6] complete multipart ===');
    const comp = await runJournaledMutation(release, {
      stage: 'publish.multipart.complete',
      input: { bundleSha256: plan.sha256, uploadId, parts: uploaded },
      intentEvidenceRefs: uploaded.map((part) => `part:${part.partNumber}:${part.etag}`),
      mutate: async () => {
        const res = await request(
          `${mp}/complete?uploadId=${encodeURIComponent(uploadId)}`,
          {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ parts: uploaded }),
          },
          1,
          'complete multipart',
          deps.fetch,
          deps.sleep,
        );
        const value = await parseResponse(res, 'complete');
        return { value, evidenceRefs: [`provider:bundle:${plan.sha256}`] };
      },
      restore: () => ({ sha256: plan.sha256, bytes: plan.size, deduped: true }),
      reconcile: async () => {
        const statusUrl =
          `${mp}?uploadId=${encodeURIComponent(uploadId)}` +
          '&partNumber=1';
        const res = await request(
          statusUrl,
          { method: 'GET', headers: auth },
          4,
          'reconcile multipart completion',
          deps.fetch,
          deps.sleep,
        );
        if (res.status === 404) return { state: 'absent' };
        const value = await parseResponse(res, 'reconcile multipart completion');
        return value.completed === true
          ? {
              state: 'committed',
              value: { sha256: plan.sha256, bytes: plan.size, deduped: true },
              evidenceRefs: [`provider:bundle:${plan.sha256}`],
            }
          : { state: 'absent', evidenceRefs: [`provider:multipart:${uploadId}:incomplete`] };
      },
    });
    log(`  stored sha256 ${comp.sha256 ?? plan.sha256} bytes ${comp.bytes ?? plan.size}`);
  }

  log('=== [5/6] upload minisig + manifest, then finalize ===');
  for (const name of ['server.tgz.minisig', 'manifest.json']) {
    const bytes = name === 'manifest.json' ? manifestRaw : await readFile(join(args.dir, name));
    if (bytes.byteLength > DIRECT_MAX[name]) {
      throw new Error(`${name} is ${bytes.byteLength}B, over the ${DIRECT_MAX[name]}B cap`);
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    const put = async () => {
      const res = await request(
        `${root}/${name}`,
        {
          method: 'PUT',
          headers: {
            ...auth,
            'content-length': String(bytes.byteLength),
            'x-artifact-sha256': sha,
            'x-artifact-size': String(bytes.byteLength),
          },
          body: bytes,
        },
        1,
        `upload ${name}`,
        deps.fetch,
        deps.sleep,
      );
      const value = await parseResponse(res, name);
      return { value, evidenceRefs: [`provider:artifact:${name}:${sha}:${bytes.byteLength}`] };
    };
    const payload = await runJournaledMutation(release, {
      stage: `publish.direct.${name}`,
      input: { bundleSha256: plan.sha256, name, sha256: sha, sizeBytes: bytes.byteLength },
      intentEvidenceRefs: [`artifact:sha256:${sha}:${bytes.byteLength}`],
      mutate: put,
      restore: () => ({ ok: true, deduped: true }),
      // The route's PUT is create-only and checks the exact content descriptor
      // before touching R2. Replaying it is the route's reconciliation read: a
      // prior acceptance returns deduped:true with zero provider writes.
      reconcile: async () => {
        const outcome = await put();
        return { state: 'committed', ...outcome };
      },
    });
    log(`  ${name}: ${payload.deduped ? 'deduped' : 'stored'} ${sha} (${bytes.byteLength}B)`);
  }

  const expectedManifestSha = createHash('sha256').update(manifestRaw).digest('hex');
  const pub = `${args.base}/artifacts/workspace-host/sha256/${plan.sha256}/server.tgz`;
  const fin = await runJournaledMutation(release, {
    stage: 'publish.finalize',
    input: { bundleSha256: plan.sha256, manifestSha256: expectedManifestSha },
    intentEvidenceRefs: [`manifest:sha256:${expectedManifestSha}`],
    restore: () => ({ manifestSha256: expectedManifestSha, deduped: true }),
    mutate: async () => {
      const res = await request(
        `${root}/finalize`,
        { method: 'POST', headers: auth },
        1,
        'finalize',
        deps.fetch,
        deps.sleep,
      );
      const value = await parseResponse(res, 'finalize');
      if (value.manifestSha256 !== expectedManifestSha) {
        throw new Error(
          `finalize returned manifest ${value.manifestSha256}, expected ${expectedManifestSha}`,
        );
      }
      return { value, evidenceRefs: [`provider:finalization:${expectedManifestSha}`] };
    },
    reconcile: async (requestIdentity) => {
      const verified = await headArtifact(
        release,
        deps,
        pub,
        { sha256: plan.sha256, sizeBytes: plan.size },
        requestIdentity,
      );
      return verified.state === 'committed'
        ? {
            ...verified,
            value: { manifestSha256: expectedManifestSha, deduped: true },
            evidenceRefs: [...verified.evidenceRefs, `provider:finalization:${expectedManifestSha}`],
          }
        : verified;
    },
  });
  log(`  finalized manifestSha256 ${fin.manifestSha256}${fin.deduped ? ' (deduped)' : ''}`);

  // Finalize returning ok is the store's claim; a public HEAD is the
  // independent check that the object a consumer would fetch actually exists.
  log('=== [6/6] verify the PUBLIC object is reachable ===');
  const headRes = await request(
    pub,
    { method: 'HEAD' },
    4,
    'public HEAD',
    deps.fetch,
    deps.sleep,
  );
  const len = headRes.headers.get('content-length');
  if (!headRes.ok) throw new Error(`public HEAD failed: HTTP ${headRes.status}`);
  if (len !== null && Number(len) !== plan.size) {
    throw new Error(`public object is ${len}B, expected ${plan.size}B`);
  }
  log(`  public HEAD ${headRes.status}, content-length ${len ?? '(absent)'}`);
  await publishSbomEvidence(args, deps, release, manifestRaw, manifest, sbom);

  log('');
  log(`PUBLISH_VERDICT=PASS`);
  log(`BUNDLE_SHA256=${plan.sha256}`);
  log(`BUNDLE_BYTES=${plan.size}`);
  log(`PUBLIC_URL=${pub}`);
  return { plan, publicUrl: pub, manifestSha256: expectedManifestSha };
}

async function readPublicationSbom(dir, manifest) {
  const evidence = manifest?.trustReport?.evidence;
  const matches = Array.isArray(evidence) ? evidence.filter((entry) => entry.kind === 'sbom') : [];
  const bound = matches[0];
  if (matches.length !== 1 || bound.format !== 'cyclonedx-json' ||
      bound.subjectSha256 !== manifest?.files?.bundle?.sha256 ||
      !/^[a-f0-9]{64}$/.test(bound.documentSha256)) {
    throw new Error('manifest must bind exactly one CycloneDX SBOM to this bundle');
  }
  const bytes = await readFile(join(dir, 'evidence', 'sbom.cdx.json'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!bytes.byteLength || bytes.byteLength > SBOM_MAX_BYTES || sha256 !== bound.documentSha256) {
    throw new Error('SBOM bytes do not match the manifest binding or size limit');
  }
  return { bytes, sha256, sizeBytes: bytes.byteLength };
}

async function publishSbomEvidence(args, deps, ctx, manifestRaw, manifest, sbom) {
  const bundleSha256 = manifest.files.bundle.sha256;
  const manifestSha256 = createHash('sha256').update(manifestRaw).digest('hex');
  const { journal } = await readReleaseJournal(ctx.ledger, ctx.taskId, ctx.operationId);
  assertPublicationJournalIdentity(journal, manifest, { sha256: bundleSha256 });
  const finalizationHash = releaseStageInputHash({ bundleSha256, manifestSha256 });
  if (!journal.receipts.some((r) => r.stage === 'publish.finalize' && r.state === 'committed' &&
      r.inputHash === finalizationHash)) throw new Error('SBOM publication requires this exact committed finalization');
  const publicRoot = `${args.base}/artifacts/workspace-host/sha256/${bundleSha256}`;
  const publicManifest = await request(`${publicRoot}/manifest.json`, {}, 4, 'public manifest', deps.fetch, deps.sleep);
  if (!publicManifest.ok || createHash('sha256').update(Buffer.from(await publicManifest.arrayBuffer())).digest('hex') !== manifestSha256) {
    throw new Error('public manifest bytes do not match the finalized release');
  }
  const token = resolveToken(args.token);
  ctx.credentialGeneration ??= `github-token-sha256:${createHash('sha256').update(token).digest('hex')}`;
  const name = 'sbom.cdx.json';
  const url = `${publicRoot}/${name}`;
  await runJournaledMutation(ctx, {
    stage: `publish.evidence.${name}`,
    input: { bundleSha256, manifestSha256, name, sha256: sbom.sha256, sizeBytes: sbom.sizeBytes },
    intentEvidenceRefs: [`artifact:sha256:${sbom.sha256}:${sbom.sizeBytes}`],
    mutate: async () => {
      const response = await request(`${args.base}/admin/artifacts/workspace-host/sha256/${bundleSha256}/${name}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'x-artifact-sha256': sbom.sha256,
          'x-artifact-size': String(sbom.sizeBytes), 'content-length': String(sbom.sizeBytes) },
        body: sbom.bytes,
      }, 1, 'publish SBOM', deps.fetch, deps.sleep);
      return { value: await parseResponse(response, name),
        evidenceRefs: [`provider:artifact:${name}:${sbom.sha256}:${sbom.sizeBytes}`] };
    },
    reconcile: (requestIdentity) => headArtifact(ctx, deps, url, sbom, requestIdentity),
  });
  const response = await request(url, {}, 4, 'public SBOM', deps.fetch, deps.sleep);
  if (!response.ok || createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') !== sbom.sha256) {
    throw new Error('public SBOM bytes do not match the manifest binding');
  }
  deps.log(`SBOM_PUBLIC_BYTES=PASS sha256=${sbom.sha256} url=${url}`);
  return { evidenceOnly: true, publicUrl: url, manifestSha256, sbomSha256: sbom.sha256 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return undefined;
  }
  return publishWorkspaceHostArtifacts(args);
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    console.error('');
    console.error(`PUBLISH_VERDICT=FAIL`);
    console.error(String(error?.stack ?? error));
    process.exit(1);
  });
}
