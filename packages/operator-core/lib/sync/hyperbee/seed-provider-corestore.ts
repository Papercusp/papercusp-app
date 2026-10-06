/**
 * seed-provider-corestore — the corestore SeedProvider (plan
 * hive-seed-bundle-2026-07-04 P-003; design memo agent-insights/hive-seed-bundle-design).
 *
 * Carries the FEDERATED hive state (plans, work-items, features, issues,
 * coordination, settings, members — everything a peer replicates as admitted
 * author logs) as a CHECKPOINT so a fresh install pre-positions the blocks and
 * the unmodified swarm replication then transfers only the delta (blocks past
 * the seeded length).
 *
 * TWO correctness properties this module is built around — a naive
 * "copy the store directory" gets BOTH wrong:
 *
 *  1. NO SECRET-KEY LEAK. The owner's store holds its OWN writable log, whose
 *     storage includes the owner's signing secret. Shipping that in a public
 *     installer would leak the owner's identity. So `cut` never copies the
 *     source store — it opens each admitted log by KEY (read-only, no secret)
 *     into a fresh REPLICA store and downloads the blocks. The replica has
 *     ciphertext blocks + merkle trees + public keys, and NO secrets.
 *
 *  2. NO PRIMARY-KEY COLLISION. A corestore's NAME-derived cores (a peer's own
 *     writable log = `store.get({ name:'peer-log' })`) hash off the store's
 *     primary key. If the seed carried a primary key, EVERY install restoring
 *     the same seed would derive the SAME own-log key and collide as writers.
 *     So `restore` does NOT copy the seed's store dir into B — it opens B's OWN
 *     fresh store (B mints its own primary), and INJECTS the seeded read-only
 *     cores into it by replicating from a throwaway store opened on the seed.
 *     B's own log stays unique; the seeded cores (addressed by their own public
 *     keys, independent of any primary) land in B's store ready to serve the
 *     boot read-merge and to delta-replicate forward.
 *
 * The seed is UNTRUSTED CACHE: every seeded block is author-signed and
 * merkle-verified by hypercore on read, and the hive content is epoch-ciphertext
 * (hive-epoch-content-ops) — useless until admission delivers the key. `verify`
 * additionally gates on a content hash of the payload before restore.
 */

import Corestore from 'corestore';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  SeedProvider,
  SeedStoreEntry,
  SeedCutContext,
  SeedCutOutput,
  SeedRestoreContext,
  SeedPayload,
  VerifyResult,
} from '@papercusp/seed-bundle';
import { hostname, tmpdir, userInfo } from 'node:os';
import { openNamedLog, type PeerLogOp } from './peer-log';
import {
  decodeEncodedJson,
  isExternalTriggerEnvelope,
  valueCarriesExternalIngest,
} from './external-ingest-envelope';

// The external-ingest predicates moved to ./external-ingest-envelope so the outbox
// row mapper (the POST-ADMISSION replication boundary) can share this ONE definition
// without importing corestore/child_process/fs through this module. Re-exported here
// because this module was their original home and is where callers still import them.
export { isExternalTriggerEnvelope, valueCarriesExternalIngest };
import {
  DROP_SNAPSHOT_ROW,
  SnapshotRowFolder,
  foldFilteredSnapshotRows,
  formatSnapshotFoldStall,
  isSnapshotOp,
  produceFilteredSnapshotIntoLog,
  type SnapshotFoldProgressCallback,
  type SnapshotFoldStall,
  type SnapshotValueTransform,
} from './log-snapshot';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import {
  findLatestCompleteSnapshot,
  findLatestCompleteSnapshotDetailed,
  SNAPSHOT_SCAN_LOOKBACK,
  type AdmittedLog,
  type SnapshotScanOutcome,
} from './read-merge';

export const CORESTORE_SEED_KIND = 'corestore';

/**
 * The seed's table-exclusion policy. DEFINED in `./seed-excluded-tables` (a
 * dependency-free module) and re-exported here, because `boot.ts` — the live operator
 * that appends the head snapshot a no-outage cut actually ships — needs the same list
 * and must not take a runtime dependency on this module to get it. Read that file for
 * the policy and its ⛔ caveats before changing what is excluded.
 */
export { SEED_EXCLUDED_TABLES, SEED_REDACT_IN_PLACE_TABLES } from './seed-excluded-tables';
import { SEED_EXCLUDED_TABLES, SEED_REDACT_IN_PLACE_TABLES } from './seed-excluded-tables';

/**
 * The projection-fact contract the degradation guard reads. DEFINED in
 * `./seed-projection-meta` (a dependency-free module) for the same reason as the
 * exclusion policy above: the guard is a pure judge in apps/operator and must not have
 * to import this file — and its whole hypercore graph — to learn one meta key.
 */
export { SEED_PROJECTED_FROM_META_KEY, readCoreProjectedFrom } from './seed-projection-meta';
import { SEED_PROJECTED_FROM_META_KEY } from './seed-projection-meta';

/** What {@link mintFilteredSeedContentCore} produced, for the manifest. */
export interface MintedSeedCore {
  /** Public key of the synthetic content core, as it must appear in `meta.coreKeys`. */
  readonly keyHex: string;
  /** Blocks landed in the staging store — `meta.coreLengths[keyHex]`. */
  readonly length: number;
  /** Rows carried by the filtered snapshot (diagnostic). */
  readonly rowCount: number;
  /** What the projection left out and why (diagnostic; logged by the cut). */
  readonly projection: SeedProjectionStats;
}

/** D-166: PRIVATE, authenticated-census input. Never copy binding hashes to the public manifest. */
export interface SeedUuidIdempotencyDropPlan {
  readonly schema: 'papercusp-uuid-idempotency-row-drop-plan-v1';
  readonly reviewRef: 'p2p-public-release-endgame-2026-09-01#D-166';
  readonly sourceKeyHex: string;
  readonly sourceLength: number;
  readonly sourceInput?: SeedSourceInput;
  readonly rows: readonly {
    readonly table: string;
    readonly hbKey: string;
    /** SHA256 of JSON.stringify(original stored value), NOT of the refused token. */
    readonly valueSha256: string;
    readonly occurrences: readonly { segment: string; line: number; fieldPath: readonly (string | number)[] }[];
  }[];
}

/** D-174 private input and winner binding; never publish these original locators. */
export interface SeedSourceInput {
  executionBinding?: SeedFrozenExecution;
  coverage: 'complete-snapshot-set + tail' | 'full-log';
  sourceHead: { sourceKeyHex: string; sourceLength: number; fork: number; byteLength: number;
    treeHash: string; signatureHex: string };
  seedIndex: number;
  coversUpTo: number;
  chunkCount: number;
  snapshotSetSha256: string | null;
  omittedPrefixBlocks: number;
  sourceBlocksRead: number;
  sourceBlocksJsonSha256: string;
  proofInventorySha256: string;
  sealedRowOccurrences: number;
  foldNow: number;
  winners: readonly { table: string; hbKey: string; disposition: 'carry' | 'redact' | 'drop' }[];
}

export interface SeedFrozenExecution {
  sourceCommit: string;
  gitDirty: false;
  nodeVersion: string;
  packageLockSha256: string;
  installedLockSha256: string;
  dependencyGeneration: string;
  directBlobs: { path: string; sha256: string }[];
}

const SEED_EXECUTION_PATHS = ['packages/operator-core/lib/sync/hyperbee/read-merge.ts',
  'packages/operator-core/lib/sync/hyperbee/log-snapshot.ts',
  'packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts',
  'apps/operator/lib/release/cut-seed-cli.ts'];
// Capture at module load, before a long-lived TS runtime could outlive a source
// edit. A stale runtime must not bind the new on-disk blobs as its loaded code.
const LOADED_SEED_EXECUTION_BLOBS = (() => {
  if (typeof import.meta.url !== 'string' || !import.meta.url.endsWith('/seed-provider-corestore.ts')) return null;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  return SEED_EXECUTION_PATHS.map(path => ({ path,
    sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') }));
})();

/** D-175: execution must be the clean source TS blobs, not a stale bundle whose
 * files on disk merely resemble its code. Reuse the maintained release setup's
 * verified dependency generation markers and npm integrity entries. GO still
 * re-derives their installation and runtime provenance independently. */
export async function readSeedFrozenExecution(): Promise<SeedFrozenExecution> {
  if (!LOADED_SEED_EXECUTION_BLOBS) {
    throw new Error('[seed:corestore] frozen census refuses compiled-only execution');
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const sourceCommit = git('rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(sourceCommit) || git('status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none')) {
    throw new Error('[seed:corestore] frozen census requires a clean source commit');
  }
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const lockBytes = await readFile(join(root, 'package-lock.json'));
  const sourceLock = await readFile(join(root, 'node_modules/.papercusp-source-package-lock.json'));
  const installedBytes = await readFile(join(root, 'node_modules/.package-lock.json'));
  const marker = await readFile(join(root, 'node_modules/.papercusp-dependency-generation'), 'utf8');
  const isolated = await readFile(join(root, 'node_modules/.papercusp-isolated-snapshot'), 'utf8');
  const dependencyGeneration = /^identity=(v1-[0-9a-f]{64})$/m.exec(marker)?.[1];
  if (!dependencyGeneration || !isolated.split('\n').includes(`generation=${dependencyGeneration}`)
      || hash(lockBytes) !== hash(sourceLock)) throw new Error('[seed:corestore] frozen dependency generation/lock mismatch');
  const lock = JSON.parse(lockBytes.toString()).packages;
  const installed = JSON.parse(installedBytes.toString()).packages;
  for (const [path, expected] of Object.entries(lock) as [string, { integrity?: string; version?: string; link?: boolean }][]) {
    if (!path.includes('node_modules/') || expected.link || !expected.integrity) continue;
    if (installed[path]?.integrity !== expected.integrity || installed[path]?.version !== expected.version) {
      throw new Error('[seed:corestore] installed dependency integrity does not match frozen lock');
    }
  }
  const directBlobs = await Promise.all(SEED_EXECUTION_PATHS.map(async path => ({ path, sha256: hash(await readFile(join(root, path))) })));
  if (JSON.stringify(directBlobs) !== JSON.stringify(LOADED_SEED_EXECUTION_BLOBS)) {
    throw new Error('[seed:corestore] loaded source modules do not match frozen blobs');
  }
  if (git('rev-parse', 'HEAD') !== sourceCommit || git('status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none')) {
    throw new Error('[seed:corestore] frozen execution changed while binding');
  }
  return { sourceCommit, gitDirty: false, nodeVersion: process.version,
    packageLockSha256: hash(lockBytes), installedLockSha256: hash(installedBytes), dependencyGeneration, directBlobs };
}

const ORIGINAL_BLOCK_HASH = Symbol('proof-verified-original-block-sha256');

/** A local get() alone cannot prove persisted bytes still match the signed head. */
async function signedSeedSource(core: ReadableCore, sourceKeyHex: string, sourceLength: number) {
  const signed = core as ReadableCore & {
    state: { length: number; fork: number; byteLength: number; signature: Buffer;
      hash(): Buffer; createTreeBatch(): unknown };
    core: { verifier: { verify(batch: unknown, signature: Buffer): boolean } };
    proof(opts: unknown): Promise<{ block?: { value: Buffer } }>;
    verifyFullyRemote(proof: unknown): Promise<{ length: number; fork: number; hash(): Buffer }>;
  };
  const head = () => {
    const state = signed.state;
    if (core.length !== sourceLength || state.length !== sourceLength || !state.signature
        || !signed.core.verifier.verify(state.createTreeBatch(), state.signature)) {
      throw new Error('[seed:corestore] original source signed head invalid or changed');
    }
    return { sourceKeyHex, sourceLength, fork: state.fork, byteLength: state.byteLength,
      treeHash: state.hash().toString('hex'), signatureHex: state.signature.toString('hex') };
  };
  const sourceHead = head();
  const assertHead = () => {
    if (JSON.stringify(head()) !== JSON.stringify(sourceHead)) throw new Error('[seed:corestore] original source signed head changed');
  };
  const log: AdmittedLog = { keyHex: sourceKeyHex, length: sourceLength, get: async index => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= sourceLength || !await core.has?.(index)) {
      throw new Error('[seed:corestore] original source span requires every block locally');
    }
    const proof = await signed.proof({ block: { index, nodes: 0 }, upgrade: { start: 0, length: sourceLength } });
    const verified = await signed.verifyFullyRemote(proof);
    if (!proof.block?.value || verified.length !== sourceLength || verified.fork !== sourceHead.fork
        || verified.hash().toString('hex') !== sourceHead.treeHash) throw new Error('[seed:corestore] original source block proof mismatch');
    assertHead();
    const op = JSON.parse(proof.block.value.toString('utf8')) as PeerLogOp;
    Object.defineProperty(op, ORIGINAL_BLOCK_HASH, { value: createHash('sha256').update(proof.block.value).digest('hex') });
    return op;
  } };
  const selected = await findLatestCompleteSnapshotDetailed(log);
  if (selected.kind === 'unreadable') throw new Error('[seed:corestore] original snapshot selection unreadable');
  return { log, sourceHead, assertHead, hint: selected.kind === 'found' ? selected.seed : null };
}

function sourceSpanRecorder(sourceLength: number) {
  const blocks = createHash('sha256');
  const snapshot = createHash('sha256');
  const inventory = createHash('sha256');
  let first = -1;
  let next = -1;
  let count = 0;
  let snapshotEnd = -1;
  let sealedRowOccurrences = 0;
  return {
    read(index: number, op: PeerLogOp) {
      if (first === -1) {
        first = next = index;
        if (isSnapshotOp(op)) {
          const value = op.value as { coversUpTo: number; chunkCount?: number };
          if (value.coversUpTo === index) snapshotEnd = index + (value.chunkCount ?? 1);
        }
      }
      if (index !== next++) throw new Error('[seed:corestore] original span read order/count mismatch');
      const text = JSON.stringify([index, op]) + '\n';
      blocks.update(text);
      const rawHash = (op as PeerLogOp & { [ORIGINAL_BLOCK_HASH]?: string })[ORIGINAL_BLOCK_HASH];
      if (!rawHash) throw new Error('[seed:corestore] original span block lacks proof verification');
      inventory.update(JSON.stringify([index, rawHash]) + '\n');
      const rows = isSnapshotOp(op) ? (op.value as { rows: { epoch?: number; value: unknown }[] }).rows : [op];
      sealedRowOccurrences += rows.filter(row => row.epoch != null && row.value != null).length;
      if (index < snapshotEnd) snapshot.update(text);
      count++;
    },
    finish(fold: { seedIndex: number; coversUpTo: number; chunkCount: number }) {
      if (first !== fold.seedIndex || count !== sourceLength - fold.seedIndex || next !== sourceLength) {
        throw new Error('[seed:corestore] original span block coverage mismatch');
      }
      return { coverage: fold.chunkCount ? 'complete-snapshot-set + tail' as const : 'full-log' as const,
        seedIndex: fold.seedIndex, coversUpTo: fold.coversUpTo, chunkCount: fold.chunkCount,
        snapshotSetSha256: fold.chunkCount ? snapshot.digest('hex') : null,
        omittedPrefixBlocks: fold.seedIndex, sourceBlocksRead: count,
        sourceBlocksJsonSha256: blocks.digest('hex'), proofInventorySha256: inventory.digest('hex'), sealedRowOccurrences };
    },
  };
}

/** D-176: complete ORIGINAL span replica, built only by maintained proof admission.
 * This private source never ships. The caller retains its point-in-time source
 * handle throughout; head drift or any inventory mismatch aborts and removes output. */
export async function captureSeedUuidOriginalSpan(inp: {
  sourceStore: Corestore; sourceKeyHex: string; sourceInput: SeedSourceInput; replicaDir: string;
}): Promise<{ sourceHead: SeedSourceInput['sourceHead']; proofInventorySha256: string; sourceBlocksRead: number }> {
  const sourceCore = inp.sourceStore.get({ key: Buffer.from(inp.sourceKeyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore;
  await sourceCore.ready();
  const source = await signedSeedSource(sourceCore, inp.sourceKeyHex, inp.sourceInput.sourceHead.sourceLength);
  if (JSON.stringify(source.sourceHead) !== JSON.stringify(inp.sourceInput.sourceHead)) {
    throw new Error('[seed:corestore] original span capture head mismatch');
  }
  // An exclusive directory creation distinguishes this from resuming an arbitrary
  // partial storage copy. Never reuse or overwrite a previous replica.
  const parent = await lstat(dirname(inp.replicaDir));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)
      || await realpath(dirname(inp.replicaDir)) !== resolve(dirname(inp.replicaDir))) {
    throw new Error('[seed:corestore] original replica parent must be private');
  }
  await mkdir(inp.replicaDir, { mode: 0o700 });
  const store = new Corestore(inp.replicaDir);
  const inventory = createHash('sha256');
  let count = 0;
  try {
    await store.ready();
    const replica = store.get({ key: Buffer.from(inp.sourceKeyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore & {
      writable: boolean; keyPair?: { secretKey?: Buffer };
      core: { bitfield: { firstSet(index: number): number } };
      applyProof(proof: unknown): Promise<boolean>;
    };
    await replica.ready();
    const original = sourceCore as ReadableCore & { manifest: unknown; proof(opts: unknown): Promise<{ block: { value: Buffer }; manifest?: unknown }> };
    for (let index = inp.sourceInput.seedIndex; index < source.log.length; index++) {
      source.assertHead();
      const proof = await original.proof({ block: { index, nodes: 0 }, upgrade: { start: 0, length: source.log.length } });
      proof.manifest = original.manifest;
      if (!proof.block?.value || !await replica.applyProof(proof)) throw new Error('[seed:corestore] original span proof admission failed');
      inventory.update(JSON.stringify([index, createHash('sha256').update(proof.block.value).digest('hex')]) + '\n');
      count++;
      if (count % 256 === 0) await new Promise<void>(done => setImmediate(done));
    }
    source.assertHead();
    const digest = inventory.digest('hex');
    if (count !== source.log.length - inp.sourceInput.seedIndex || count !== inp.sourceInput.sourceBlocksRead
        || digest !== inp.sourceInput.proofInventorySha256
        || replica.writable || replica.keyPair?.secretKey) throw new Error('[seed:corestore] original replica inventory/custody mismatch');
    // Read-time re-verification, not trust in the capture-time admission receipt.
    const audit = await signedSeedSource(replica, inp.sourceKeyHex, source.log.length);
    if (JSON.stringify(audit.sourceHead) !== JSON.stringify(source.sourceHead)) throw new Error('[seed:corestore] original replica signed head mismatch');
    const hashes = createHash('sha256');
    for (let index = inp.sourceInput.seedIndex; index < source.log.length; index++) {
      const op = await audit.log.get(index) as PeerLogOp & { [ORIGINAL_BLOCK_HASH]: string };
      hashes.update(JSON.stringify([index, op[ORIGINAL_BLOCK_HASH]]) + '\n');
    }
    if (replica.core.bitfield.firstSet(0) !== inp.sourceInput.seedIndex) {
      throw new Error('[seed:corestore] original replica contains an omitted prefix block or no declared span');
    }
    if (hashes.digest('hex') !== digest) throw new Error('[seed:corestore] original replica read-time inventory mismatch');
    await store.close();
    return { sourceHead: audit.sourceHead, proofInventorySha256: digest, sourceBlocksRead: count };
  } catch (error) {
    await store.close().catch(() => {});
    await rm(inp.replicaDir, { recursive: true, force: true });
    throw error;
  }
}

/** Export the locally present canonical source population before UUID drops.
 * Hypercore supplies the signed source blocks; no author/header/ciphertext is rewritten.
 * Each segment is this immutable private JSONL export, NOT a guessed RocksDB byte locator.
 * The external assembler still authenticates every envelope; final GO re-exports independently.
 * Excluded tables are omitted by the same policy used by the seed provider. */
export async function exportSeedUuidIdempotencySource(inp: {
  sourceStore: Corestore; sourceKeyHex: string; sourceLength: number;
  outputDir: string; segment: string;
  redactValues?: readonly string[];
  now?: number;
  executionBinding?: SeedFrozenExecution;
}): Promise<{
  sourceKeyHex: string; sourceLength: number; rowCount: number; rowsPath: string; rowsSha256: string;
  sourceBlocksRead: number; sourceBlocksJsonSha256: string;
  sourceInput: SeedSourceInput;
  privacyProjectionContext: { schema: 'papercusp-seed-privacy-projection-v1'; literalsSha256: string; excludedTablesSha256: string };
}> {
  if (!/^[0-9a-f]{64}$/.test(inp.sourceKeyHex) || !Number.isSafeInteger(inp.sourceLength)
      || inp.sourceLength <= 0 || !/^segment-[0-9]{6}\.(?:blob|log)$/.test(inp.segment)) {
    throw new Error('[seed:corestore] invalid UUID source export binding');
  }
  const directory = await lstat(inp.outputDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
      || await realpath(inp.outputDir) !== resolve(inp.outputDir)) {
    throw new Error('[seed:corestore] UUID source export directory must be private');
  }
  const core = inp.sourceStore.get({ key: Buffer.from(inp.sourceKeyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore;
  await core.ready();
  if (core.length !== inp.sourceLength) throw new Error('[seed:corestore] UUID source export head changed');
  const source = await signedSeedSource(core, inp.sourceKeyHex, inp.sourceLength);
  const recorder = sourceSpanRecorder(inp.sourceLength);
  const foldNow = inp.now ?? Date.now();
  // Reuse the producer's normal privacy fold. This private expectation is distinct
  // from D166 drops; the independent validator must still authenticate originals
  // and refuse any output change beyond this exact, source-bound projection.
  const privacy = seedSnapshotValueTransform(inp.redactValues);
  const options = { now: foldNow, excludeTables: SEED_EXCLUDED_TABLES,
    priorSnapshotHint: source.hint, requireComplete: true };
  const original = await foldFilteredSnapshotRows(source.log, { ...options, onSourceBlock: recorder.read });
  const projected = await foldFilteredSnapshotRows(source.log, { ...options, transformValue: privacy.transform });
  if (original.seedIndex !== projected.seedIndex || original.chunkCount !== projected.chunkCount) {
    throw new Error('[seed:corestore] privacy census snapshot span mismatch');
  }
  source.assertHead();
  if (core.length !== inp.sourceLength) throw new Error('[seed:corestore] UUID source export head changed');
  const rows = original.rows;
  const span = recorder.finish(original);
  const projectedRows = new Map(projected.rows.map(row => [JSON.stringify([row.table, row.hbKey]), row]));
  const winners: SeedSourceInput['winners'][number][] = [];
  const path = join(inp.outputDir, inp.segment);
  const file = await open(path, 'wx', 0o600);
  const digest = createHash('sha256');
  try {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      const projected = projectedRows.get(JSON.stringify([row.table, row.hbKey]));
      const privacyProjection = !projected ? { disposition: 'drop' } :
        JSON.stringify(projected.value) === JSON.stringify(row.value) ? { disposition: 'carry' } :
          { disposition: 'redact', value: projected.value };
      winners.push({ table: row.table, hbKey: row.hbKey,
        disposition: privacyProjection.disposition as 'carry' | 'redact' | 'drop' });
      const text = JSON.stringify({ ...row, segment: inp.segment, line: index + 1,
        storedValueJson: JSON.stringify(row.value), privacyProjection }) + '\n';
      digest.update(text);
      await file.writeFile(text);
    }
    await file.sync();
    source.assertHead();
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
  return { sourceKeyHex: inp.sourceKeyHex, sourceLength: inp.sourceLength,
    rowCount: rows.length, rowsPath: path, rowsSha256: digest.digest('hex'),
    sourceBlocksRead: span.sourceBlocksRead, sourceBlocksJsonSha256: span.sourceBlocksJsonSha256,
    sourceInput: { ...span, sourceHead: source.sourceHead, foldNow, winners,
      ...(inp.executionBinding ? { executionBinding: inp.executionBinding } : {}) },
    privacyProjectionContext: { schema: 'papercusp-seed-privacy-projection-v1',
      literalsSha256: createHash('sha256').update(JSON.stringify(inp.redactValues ?? SEED_BUILD_IDENTITY_LITERALS)).digest('hex'),
      excludedTablesSha256: createHash('sha256').update(JSON.stringify([...SEED_EXCLUDED_TABLES].sort())).digest('hex') } };
}

/** Producer evidence only. The final validator must independently check class coverage and source auth. */
export interface SeedUuidIdempotencyRedactionReport {
  readonly schema: 'papercusp-uuid-idempotency-redaction-manifest-v1';
  readonly reviewRef: SeedUuidIdempotencyDropPlan['reviewRef'];
  readonly replacement: '<redacted:idempotency-key>';
  readonly authenticationDisposition: 'dropped';
  readonly ciphertextAuthentication: 'requires-independent-candidate-validation';
  readonly droppedRows: number;
  readonly occurrenceCount: number;
  readonly occurrences: readonly { segment: string; line: number; fieldPath: readonly (string | number)[] }[];
}

function uuidIdempotencyRowDropper(
  plan: SeedUuidIdempotencyDropPlan,
  source: { ownerKeyHex: string; sourceLength: number },
): { drop: (value: unknown, table: string, hbKey: string) => boolean; finish: () => SeedUuidIdempotencyRedactionReport } {
  if (plan.schema !== 'papercusp-uuid-idempotency-row-drop-plan-v1'
      || plan.reviewRef !== 'p2p-public-release-endgame-2026-09-01#D-166'
      || !/^[0-9a-f]{64}$/.test(plan.sourceKeyHex) || plan.sourceKeyHex !== source.ownerKeyHex
      || !Number.isSafeInteger(plan.sourceLength) || plan.sourceLength <= 0
      || plan.sourceLength !== source.sourceLength || !Array.isArray(plan.rows)
      || (plan.rows.length === 0 && !plan.sourceInput)) {
    throw new Error('[seed:corestore] UUID row-drop plan source/schema binding mismatch');
  }
  const rows = new Map<string, { hash: string; occurrences: SeedUuidIdempotencyRedactionReport['occurrences'] }>();
  const locatorIds = new Set<string>();
  for (const row of plan.rows) {
    const key = JSON.stringify([row.table, row.hbKey]);
    if (typeof row.table !== 'string' || !row.table || typeof row.hbKey !== 'string' || !row.hbKey
        || !/^[0-9a-f]{64}$/.test(row.valueSha256) || rows.has(key)
        || !Array.isArray(row.occurrences) || row.occurrences.length === 0) {
      throw new Error('[seed:corestore] invalid/duplicate UUID row-drop binding');
    }
    // Explicit parameter types: `Array.isArray` on a `readonly` array narrows it to
    // `readonly T[] & any[]`, which would leave these callback parameters implicitly `any`.
    const occurrences = row.occurrences.map((occurrence: SeedUuidIdempotencyDropPlan['rows'][number]['occurrences'][number]) => {
      if (!/^segment-[0-9]{6}\.(?:blob|log)$/.test(occurrence.segment)
          || !Number.isSafeInteger(occurrence.line) || occurrence.line <= 0
          || !Array.isArray(occurrence.fieldPath) || occurrence.fieldPath.length === 0
          || occurrence.fieldPath.some((part: string | number) => typeof part === 'number'
            ? !Number.isSafeInteger(part) || part < 0
            : typeof part !== 'string' || !part
              || /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i.test(part))) {
        throw new Error('[seed:corestore] unsafe UUID redaction occurrence locator');
      }
      const copied = { segment: occurrence.segment, line: occurrence.line, fieldPath: [...occurrence.fieldPath] };
      const locatorId = JSON.stringify(copied);
      if (locatorIds.has(locatorId)) throw new Error('[seed:corestore] duplicate UUID redaction occurrence');
      locatorIds.add(locatorId);
      return copied;
    });
    rows.set(key, { hash: row.valueSha256, occurrences });
  }
  const dropped = new Set<string>();
  return {
    drop(value, table, hbKey) {
      const key = JSON.stringify([table, hbKey]);
      const row = rows.get(key);
      if (!row) return false;
      const encoded = JSON.stringify(value);
      if (encoded === undefined || createHash('sha256').update(encoded).digest('hex') !== row.hash) {
        throw new Error('[seed:corestore] UUID row-drop original value binding mismatch');
      }
      dropped.add(key);
      return true;
    },
    finish() {
      if (dropped.size !== rows.size) throw new Error('[seed:corestore] UUID row-drop plan has missing targets');
      const occurrences = [...rows.values()].flatMap((row) => row.occurrences);
      return {
        schema: 'papercusp-uuid-idempotency-redaction-manifest-v1',
        reviewRef: 'p2p-public-release-endgame-2026-09-01#D-166',
        replacement: '<redacted:idempotency-key>',
        authenticationDisposition: 'dropped',
        ciphertextAuthentication: 'requires-independent-candidate-validation',
        droppedRows: dropped.size,
        occurrenceCount: occurrences.length,
        occurrences,
      };
    },
  };
}

/**
 * Public seed content must not carry identity values from private plan metadata or prose.
 * The release cutter supplies the same literal set as the desktop release audit (including
 * known-sensitive cross-box aliases); direct callers fall back to this box's runtime values.
 * Opaque binary / encrypted values are left untouched; valid UTF-8 JSON values are projected
 * too, because the corestore JSON boundary can surface encoded JSON as bytes.
 */
const SEED_EMAIL_PATTERN = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;

const SEED_REAL_HOSTNAME_ENV = 'PAPERCUSP_SEED_REAL_HOSTNAME';
const IMPERSONAL_USERS = new Set(['root', 'runner', 'build', 'ubuntu']);
const IMPERSONAL_HOMES = new Set(['/root', '/', '/home']);
const IMPERSONAL_HOST_PREFIXES = ['runner', 'ci-', 'localhost'];

function gitConfig(key: string): string | undefined {
  try {
    const value = execFileSync('git', ['config', '--get', key], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Build-box identity values are not content and must not survive a public projection. */
function seedBuildIdentityLiterals(): readonly string[] {
  const realHostname = process.env[SEED_REAL_HOSTNAME_ENV] || hostname();
  let username: string | undefined;
  try {
    username = userInfo().username;
  } catch {
    username = undefined;
  }
  let home: string | undefined;
  try {
    home = process.env.HOME || undefined;
  } catch {
    home = undefined;
  }
  const values = [
    realHostname && !IMPERSONAL_HOST_PREFIXES.some((prefix) => realHostname.startsWith(prefix))
      ? realHostname
      : undefined,
    username && !IMPERSONAL_USERS.has(username) ? username : undefined,
    home && !IMPERSONAL_HOMES.has(home) ? home : undefined,
    gitConfig('user.name'),
    gitConfig('user.email'),
  ];
  return [...new Set(values.filter((value): value is string => !!value && value.length >= 3))];
}

const SEED_BUILD_IDENTITY_LITERALS = seedBuildIdentityLiterals();

function needsWordBoundary(literal: string): boolean {
  return literal.length < 6 && /^[a-zA-Z0-9]+$/.test(literal);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The pattern ONE identity literal is hunted with — byte-for-byte the release gate's rule
 * (`audit-release-bundle.py` `lit_ere()` + `needs_word_boundary()` + `case_fold_ere()`):
 * a short alphanumeric literal matches on a word boundary, everything matches
 * CASE-INSENSITIVELY. The projection and the gate must not disagree about what counts as a
 * hit: build #5 (EI-22086776666843792) shipped `maclogin` ×25 and `ownerhandle` ×8 in prose that
 * this scrub had already "cleaned" — it matched with `split(literal)`, case-sensitively,
 * while the gate case-folds every literal.
 */
export function seedLiteralPattern(literal: string, flags: 'g' | '' = ''): RegExp {
  const body = escapeRegExp(literal);
  return new RegExp(needsWordBoundary(literal) ? `\\b${body}\\b` : body, `${flags}i`);
}

/** True iff `value` carries any hunted identity literal under the gate's own matching rule. */
export function stringCarriesSeedIdentity(value: string, literals: readonly string[]): boolean {
  return literals.some((literal) => seedLiteralPattern(literal).test(value));
}

function redactString(value: string, literals: readonly string[]): string {
  let redacted = value.replace(SEED_EMAIL_PATTERN, '[email]');
  for (const literal of literals) {
    redacted = redacted.replace(seedLiteralPattern(literal, 'g'), '[build-identity]');
  }
  return redacted;
}

/**
 * Deep scan of a row VALUE for any hunted identity literal — strings, object KEYS, arrays,
 * and encoded-JSON bytes. Keys are scanned on purpose: build #5's five raw `ownerhandle` survivors
 * were account-pool ids used as JSON object keys (`{"accounts":{"ownerhandle":…,"ownerhandle3":…}}`),
 * which the value-only redaction below walked straight past.
 */
export function valueCarriesSeedIdentity(value: unknown, literals: readonly string[]): boolean {
  if (literals.length === 0) return false;
  if (typeof value === 'string') return stringCarriesSeedIdentity(value, literals);
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const decoded = decodeEncodedJson(value);
    // Opaque binary (ciphertext, non-UTF-8) is untouched by the redaction too; a UTF-8 text
    // that is not JSON is still text and is judged as such.
    return decoded ? stringCarriesSeedIdentity(decoded.text, literals) : false;
  }
  if (Array.isArray(value)) return value.some((item) => valueCarriesSeedIdentity(item, literals));
  for (const [key, child] of Object.entries(value)) {
    if (stringCarriesSeedIdentity(key, literals) || valueCarriesSeedIdentity(child, literals)) return true;
  }
  return false;
}

/**
 * Redact encoded bytes, covering EXACTLY the ground {@link valueCarriesSeedIdentity} judges.
 *
 * That coverage comes from the SHARED decoder on purpose, never a second `JSON.parse` here:
 * {@link decodeEncodedJson} returns `json` as OPTIONAL precisely so valid UTF-8 that is not
 * JSON is still judged AS TEXT. This function used to re-implement the decode and bail to
 * `return value` when its own `JSON.parse` threw, so the two halves of ONE safety property
 * disagreed about what "carries identity" means — the detector said yes, the redactor
 * declined, and the row was then counted `carried`, i.e. clean. A STRUCTURAL row skips the
 * identity DROP by design, which makes this redaction its ONLY compensating control, so it
 * may not cover less. The gap shipped a `build-git-name@<id>` git author token into the
 * 0.0.20 seed and the staging gate refused it ~2.5h into the cut (EI-23523718191785410).
 */
function redactEncodedJson(value: Uint8Array | ArrayBuffer, literals: readonly string[]): unknown {
  const decoded = decodeEncodedJson(value);
  // Opaque binary (ciphertext, non-UTF-8): the detector cannot read it either, so the
  // bytes stay byte-for-byte unchanged.
  if (!decoded) return value;

  if (!('json' in decoded)) {
    // Valid UTF-8 that is not JSON — text, and judged as text. Redact it as text and
    // re-encode, so the value keeps the BYTE shape it arrived in.
    const redactedText = redactString(decoded.text, literals);
    return redactedText === decoded.text ? value : new TextEncoder().encode(redactedText);
  }

  const redacted = redactSeedValue(decoded.json, literals);
  // Preserve the original bytes when no sensitive value was found. This keeps opaque
  // and already-sanitized encoded values byte-for-byte unchanged.
  return redacted === decoded.json ? value : redacted;
}

export function redactSeedValue(value: unknown, literals: readonly string[] = SEED_BUILD_IDENTITY_LITERALS): unknown {
  if (typeof value === 'string') {
    return redactString(value, literals);
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return redactEncodedJson(value, literals);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const redacted = redactSeedValue(item, literals);
      changed ||= redacted !== item;
      return redacted;
    });
    return changed ? out : value;
  }

  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    // Keys too: an identity literal used as a map key (an account-pool id, a handle-keyed
    // roster) ships exactly like a value. Two keys folding onto one marker collide — the
    // later wins — which is acceptable for a public projection and far better than the leak.
    const redactedKey = redactString(key, literals);
    const redacted = redactSeedValue(child, literals);
    changed ||= redacted !== child || redactedKey !== key;
    out[redactedKey] = redacted;
  }
  return changed ? out : value;
}

/**
 * Keys are row addresses, not display text. Rewriting an identity-bearing key would
 * orphan the row (or collide with another redacted key), so the public seed must omit
 * that row and let normal replication recover it from the private author log later.
 */
function seedKeyCarriesBuildIdentity(
  hbKey: string,
  literals: readonly string[] = SEED_BUILD_IDENTITY_LITERALS,
): boolean {
  return redactString(hbKey, literals) !== hbKey;
}

/** Why a row was left out of the public seed — counted per cut so the number is reported. */
export interface SeedProjectionStats {
  /** Rows whose hbKey (address) carried an identity literal — cannot be rewritten, dropped. */
  droppedIdentityKey: number;
  /** Rows carrying an external-integration ingest envelope (the owner's inbox) — any table. */
  droppedPrivateIngest: number;
  /** Content-table rows whose VALUE carried an identity literal (D-002 row-drop). */
  droppedIdentityContent: number;
  /** Structural-table rows (roster/policy/keys) whose value was redacted in place and kept. */
  redactedInPlace: number;
  /** Rows carried unchanged. */
  carried: number;
  /** D-166 output-only drop accounting; absent unless an exact private plan was applied. */
  uuidIdempotencyRedaction?: SeedUuidIdempotencyRedactionReport;
}

/** The per-cut projection report — the numbers the cut log prints so a drop count is never invisible. */
export interface SeedProjectionReport extends SeedProjectionStats {
  /** Rows the filtered snapshot carries (after every drop). */
  readonly rows: number;
  /** Size of the literal set the projection hunted with. */
  readonly literals: number;
  readonly ownerKeyHex: string;
}

function logProjectionReport(r: SeedProjectionReport): void {
  console.warn(
    `[seed:corestore] projection for owner=${r.ownerKeyHex.slice(0, 12)}…: rows=${r.rows} carried=${r.carried} ` +
      `redactedInPlace=${r.redactedInPlace} dropped(identityKey=${r.droppedIdentityKey} ` +
      `privateIngest=${r.droppedPrivateIngest} identityContent=${r.droppedIdentityContent}) literals=${r.literals}`,
  );
}

/**
 * The seed's per-row projection (EI-22086776666843792, endgame D-002). In precedence:
 *   1. an identity literal in the row ADDRESS (hbKey)          → DROP (cannot be rewritten);
 *   2. an external-integration ingest envelope anywhere inside → DROP, in EVERY table;
 *   3. an identity literal anywhere inside a CONTENT row       → DROP (replicates post-admission);
 *   4. a STRUCTURAL row ({@link SEED_REDACT_IN_PLACE_TABLES})  → redact in place, keep;
 *   5. otherwise carry the value as is (email shapes still fold to `[email]`).
 * Returns the transform plus a live stats object the cut logs once the fold finishes.
 */
export function seedSnapshotValueTransform(
  literals: readonly string[] = SEED_BUILD_IDENTITY_LITERALS,
  uuidDrops?: { plan: SeedUuidIdempotencyDropPlan; ownerKeyHex: string; sourceLength: number },
): { transform: SnapshotValueTransform; stats: SeedProjectionStats; finishUuidRedaction?: () => void } {
  const dropper = uuidDrops ? uuidIdempotencyRowDropper(uuidDrops.plan, uuidDrops) : undefined;
  const stats: SeedProjectionStats = {
    droppedIdentityKey: 0,
    droppedPrivateIngest: 0,
    droppedIdentityContent: 0,
    redactedInPlace: 0,
    carried: 0,
  };
  const transform: SnapshotValueTransform = (value, { table, hbKey }) => {
    // DROP the complete stored row. Never rewrite ciphertext, hbKey, author or original authentication.
    if (dropper?.drop(value, table, hbKey)) return DROP_SNAPSHOT_ROW;
    if (seedKeyCarriesBuildIdentity(hbKey, literals)) {
      stats.droppedIdentityKey += 1;
      return DROP_SNAPSHOT_ROW;
    }
    if (valueCarriesExternalIngest(value)) {
      stats.droppedPrivateIngest += 1;
      return DROP_SNAPSHOT_ROW;
    }
    const structural = SEED_REDACT_IN_PLACE_TABLES.has(table);
    if (!structural && valueCarriesSeedIdentity(value, literals)) {
      stats.droppedIdentityContent += 1;
      return DROP_SNAPSHOT_ROW;
    }
    const redacted = redactSeedValue(value, literals);
    // POST-CONDITION, not a belt-and-braces extra. Skipping the DROP above for a structural
    // row is sound ONLY because redaction covers the same ground the detector does. When it
    // does not, the row ships build identity, and the failure surfaces as a whole-seed
    // refusal at the staging gate hours later with no indication of WHICH row caused it —
    // the 0.0.20 cut burned ~2.5h that way (EI-23523718191785410). Fail here, naming the row.
    // Never DROP instead: a structural row is load-bearing, and silently omitting one would
    // ship a seed that passes the gate and breaks a joiner.
    if (structural && valueCarriesSeedIdentity(redacted, literals)) {
      throw new Error(
        `[seed:corestore] redaction declined on structural row ${table}/${hbKey}: the value STILL ` +
          `carries a build-identity literal after redactSeedValue. The redactor covers less than ` +
          `valueCarriesSeedIdentity judges — close that asymmetry (see redactEncodedJson).`,
      );
    }
    if (redacted !== value) stats.redactedInPlace += 1;
    else stats.carried += 1;
    return redacted;
  };
  return { transform, stats, ...(dropper ? { finishUuidRedaction: () => {
    stats.uuidIdempotencyRedaction = dropper.finish();
  } } : {}) };
}

/**
 * Mint the seed's CONTENT core: one filtered snapshot of the owner's log, in a core
 * the owner never wrote (EI-20108164746219771).
 *
 * ── WHY MINT-THEN-REPLICATE INSTEAD OF WRITING STRAIGHT INTO `stagingDir` ──
 * Writing a core directly into the staging store would make it WRITABLE there, and a
 * writable hypercore's storage contains its SIGNING SECRET — which then ships inside
 * the installer. That is precisely the failure this module's header calls its first
 * correctness property ("NO SECRET-KEY LEAK ... `cut` never copies the source store").
 * A privacy fix that shipped a signing secret would be a worse leak than the one it
 * removes, so the core is minted in a THROWAWAY store and only its BLOCKS are
 * replicated into staging — the same read-only path the owner's admitted logs already
 * take. The staging copy is a replica: blocks, merkle trees and a public key, no secret.
 *
 * The throwaway store also supplies a fresh primary key, so the minted core's
 * name-derived key differs per cut. That is fine and intended: the manifest names the
 * key explicitly and restore addresses cores by public key (property 2 in the header) —
 * nothing derives it, so nothing collides.
 */
export async function mintFilteredSeedContentCore(inp: {
  readonly sourceStore: Corestore;
  /** The owner's own-log key — READ ONLY; this function never writes the source. */
  readonly ownerKeyHex: string;
  /** The seed's staging corestore (already created by the caller). */
  readonly stagingStore: Corestore;
  readonly excludeTables?: readonly string[];
  readonly now?: number;
  /** Release audit literals; omitted direct callers use the current box's runtime set. */
  readonly redactValues?: readonly string[];
  /** D-166 private source-bound plan; final class census/auth proof is a separate required gate. */
  readonly uuidIdempotencyDropPlan?: SeedUuidIdempotencyDropPlan;
  /** Forward bounded source-scan progress to the release runner, when supplied. */
  readonly onProgress?: SnapshotFoldProgressCallback;
  /** Forward a cursor-stall diagnostic to the release runner, when supplied. */
  readonly onStall?: (stall: SnapshotFoldStall) => void;
  /** Override the cursor-stall diagnostic threshold. The scan is never timed out. */
  readonly filteredScanStallMs?: number;
  /**
   * Override how long ONE prior-snapshot seek read may hang before the seek is
   * abandoned and the full fold is used instead. Unlike the stall threshold above
   * this one DOES end a wait, so the production default is deliberately generous;
   * a test that gates reads indefinitely must shrink it or it waits that long.
   */
  readonly seekReadBudgetMs?: number;
  /** Receives the per-cut projection report; omitted ⇒ one `console.warn` line. */
  readonly onProjection?: (report: SeedProjectionReport) => void;
}): Promise<MintedSeedCore> {
  const sourceCore = inp.sourceStore.get({
    key: Buffer.from(inp.ownerKeyHex, 'hex'),
    valueEncoding: 'json',
  }) as unknown as ReadableCore;
  await sourceCore.ready();
  await sourceCore.update({ wait: true });
  const sourceLog = coreAsAdmittedLog(sourceCore, inp.ownerKeyHex);

  const mintDir = await mkdtemp(join(tmpdir(), 'papercusp-seed-mint-'));
  try {
    const mintStore = new Corestore(mintDir);
    await mintStore.ready();
    try {
      const synthetic = await openNamedLog(mintStore, 'seed-content');
      const reportStall = (stall: SnapshotFoldStall): void => {
        if (inp.onStall) {
          inp.onStall(stall);
          return;
        }
        console.error(
          `[seed:corestore] filtered source scan stalled for owner=${inp.ownerKeyHex.slice(0, 12)}…: ` +
            `${formatSnapshotFoldStall(stall)}; ` +
            `the scan remains live and is not being aborted`,
        );
      };
      const boundSourceLength = sourceCore.length;
      const censusInput = inp.uuidIdempotencyDropPlan?.sourceInput;
      if (censusInput?.executionBinding && JSON.stringify(await readSeedFrozenExecution()) !== JSON.stringify(censusInput.executionBinding)) {
        throw new Error('[seed:corestore] census/producer frozen execution mismatch');
      }
      const boundSource = censusInput ? await signedSeedSource(sourceCore, inp.ownerKeyHex, boundSourceLength) : undefined;
      const recorder = censusInput ? sourceSpanRecorder(boundSourceLength) : undefined;
      const censusOriginal = censusInput ? new SnapshotRowFolder({ excludeTables: inp.excludeTables ?? SEED_EXCLUDED_TABLES }) : undefined;
      const censusPrivacy = censusInput ? new SnapshotRowFolder({ excludeTables: inp.excludeTables ?? SEED_EXCLUDED_TABLES,
        transformValue: seedSnapshotValueTransform(inp.redactValues).transform }) : undefined;
      if (censusInput && JSON.stringify(boundSource!.sourceHead) !== JSON.stringify(censusInput.sourceHead)) {
        throw new Error('[seed:corestore] census/producer signed source head mismatch');
      }
      const projection = seedSnapshotValueTransform(inp.redactValues, inp.uuidIdempotencyDropPlan ? {
        plan: inp.uuidIdempotencyDropPlan, ownerKeyHex: inp.ownerKeyHex, sourceLength: boundSourceLength,
      } : undefined);
      // P-003: the producer's own seek only scans a short tail window, and the
      // proportional cadence leaves the newest set far behind it. Locate it with the
      // reader's unbounded scan and hand it over; a miss still folds from 0 correctly.
      const priorSet = boundSource ? boundSource.hint : await findLatestCompleteSnapshot(sourceLog).catch(() => null);
      const produced = await produceFilteredSnapshotIntoLog(boundSource?.log ?? sourceLog, synthetic, {
        ...(boundSource ? { priorSnapshotHint: priorSet } : priorSet ? { priorSnapshotHint: priorSet } : {}),
        now: censusInput?.foldNow ?? inp.now ?? Date.now(),
        schemaVersion: CURRENT_SCHEMA_VERSION,
        excludeTables: inp.excludeTables ?? SEED_EXCLUDED_TABLES,
        onProgress: inp.onProgress,
        onStall: reportStall,
        stallMs: inp.filteredScanStallMs,
        seekReadBudgetMs: inp.seekReadBudgetMs,
        transformValue: projection.transform,
        ...(censusInput ? { requireComplete: true, onSourceBlock: (index: number, op: PeerLogOp) => {
          recorder!.read(index, op);
          censusOriginal!.add(op, op.value, index);
          censusPrivacy!.add(op, op.value, index);
        },
          onFoldedRows: (fold: Awaited<ReturnType<typeof foldFilteredSnapshotRows>>) => {
            const actual = recorder!.finish(fold);
            for (const field of Object.keys(actual) as (keyof typeof actual)[]) {
              if (actual[field] !== censusInput[field]) throw new Error('[seed:corestore] census/producer original span mismatch');
            }
            const privacyRows = new Map(censusPrivacy!.finish({ now: censusInput.foldNow })
              .map(row => [JSON.stringify([row.table, row.hbKey]), row]));
            const winners = censusOriginal!.finish({ now: censusInput.foldNow }).map(row => {
              const projected = privacyRows.get(JSON.stringify([row.table, row.hbKey]));
              return { table: row.table, hbKey: row.hbKey, disposition: !projected ? 'drop'
                : JSON.stringify(projected.value) === JSON.stringify(row.value) ? 'carry' : 'redact' };
            });
            if (JSON.stringify(winners) !== JSON.stringify(censusInput.winners)) {
              throw new Error('[seed:corestore] census/producer original winner dispositions mismatch');
            }
            const dropped = new Set(inp.uuidIdempotencyDropPlan!.rows.map(row => JSON.stringify([row.table, row.hbKey])));
            const expected = censusInput.winners.filter(row => row.disposition !== 'drop'
              && !dropped.has(JSON.stringify([row.table, row.hbKey]))).map(row => JSON.stringify([row.table, row.hbKey])).sort();
            const emitted = fold.rows.map(row => JSON.stringify([row.table, row.hbKey])).sort();
            if (new Set(expected).size !== expected.length || JSON.stringify(expected) !== JSON.stringify(emitted)) {
              throw new Error('[seed:corestore] census/producer winner set mismatch');
            }
            boundSource!.assertHead();
          } } : {}),
      });
      if (inp.uuidIdempotencyDropPlan && sourceCore.length !== boundSourceLength) {
        throw new Error('[seed:corestore] UUID row-drop source head changed during projection');
      }
      projection.finishUuidRedaction?.();
      (inp.onProjection ?? logProjectionReport)({
        ...projection.stats,
        rows: produced.rowCount,
        literals: (inp.redactValues ?? SEED_BUILD_IDENTITY_LITERALS).length,
        ownerKeyHex: inp.ownerKeyHex,
      });
      if (!produced.appended) {
        throw new Error(
          `[seed:corestore] refusing to cut: the source log ${inp.ownerKeyHex.slice(0, 12)}… folded ` +
            `to no snapshot at all (length=${sourceLog.length}). A seed with no content core would ` +
            `restore as an empty hive while still looking like a successful cut.`,
        );
      }

      // Blocks only — see the secret-key note above.
      const { teardown } = pipeReplicate(mintStore, inp.stagingStore);
      let length: number;
      try {
        length = await downloadCoreRange(inp.stagingStore, synthetic.keyHex, 0);
      } finally {
        teardown();
      }
      return { keyHex: synthetic.keyHex, length, rowCount: produced.rowCount, projection: projection.stats };
    } finally {
      await mintStore.close().catch(() => {});
    }
  } finally {
    // The throwaway store holds the synthetic core's SECRET. Remove it — never let it
    // outlive the cut, and never let it sit next to the artifacts being packaged.
    await rm(mintDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** WI-37553 — escalating read budgets for the CUTTER's snapshot scan.
 *
 *  read-merge's 5s default is tuned for a reader on a settled core. The cutter reads a
 *  LIVE corestore the operator is actively appending to, and there a single slow get used
 *  to collapse the entire sparse cut into shipping FULL history — measured: a 5.62 GB seed
 *  from a core whose snapshot sat 48 blocks from the tail, which the seed-degradation guard
 *  then (correctly) refused, failing a release cut 52 minutes in. Spend more patience before
 *  concluding the snapshot is not there; the retry is cheap next to a re-cut. */
const CUTTER_SNAPSHOT_SCAN_TIMEOUTS_MS: readonly number[] = [5_000, 20_000, 60_000];

/** `.replicate()` is typed loosely upstream; it returns a duplex stream. */
type Pipeable = { pipe<T extends Pipeable>(dest: T): T; destroy(): void };

/** `store.get()` is typed loosely upstream (`unknown`); narrow at the boundary. */
interface ReadableCore {
  readonly length: number;
  /** Blocks [0, contiguousLength) are local. Absent on older cores — treat as unknown, not 0. */
  readonly contiguousLength?: number;
  ready(): Promise<void>;
  update(opts?: { wait?: boolean }): Promise<void>;
  get(i: number, opts?: { wait?: boolean }): Promise<unknown>;
  /** Bitfield membership test — O(1) per block where available. */
  has?(i: number): Promise<boolean> | boolean;
}

/** Context for {@link createCorestoreSeedProvider}.cut (build/release time). */
export interface CorestoreCutContext {
  /** The live/quiescent source store to cut from (the owner's store). */
  readonly sourceStore: Corestore;
  /**
   * Optional sibling Corestore directories to inspect when the cut runs in a
   * separate process from the host harness. `remote-core-host` is process-local,
   * so the release cut must supply this explicit discovery seam for admitted
   * logs whose blocks were opened by another harness on the same machine.
   */
  readonly sourceStoreDirs?: readonly string[];
  /** Hex keys of the admitted author logs to seed (read-only). */
  readonly coreKeys: readonly string[];
  /** Directory the read-only replica is materialized into — becomes the payload. */
  readonly stagingDir: string;
  /**
   * seed-history-trim-public-builds-2026-07-07 P-004 — SPARSE cut. When true,
   * each core ships only `[seedIndex, length)` where `seedIndex` is the chunk-0
   * index of its latest COMPLETE snapshot set (per read-merge's
   * `findLatestCompleteSnapshot`, the SAME locator the joiner's cursor seeds to,
   * so cut + reader agree by construction). The summarized-and-superseded prefix
   * `[0, seedIndex)` (the ~2GB of churn/history) is DROPPED. Projection-equivalent
   * (P-002): the snapshot rows reconstitute current state, so a snapshot-aware
   * reader (SUBSTRATE_LOG_SNAPSHOT ON — P-005, REQUIRED for a sparse seed) folds
   * from `seedIndex` forward to the identical PG read model.
   *
   * A core with NO complete snapshot set ships FULL (`seedIndex = 0`) and warns.
   * The reader could not seed past a prefix it cannot locate either, so a full
   * ship is the safe fallback. Since p2p-join-catchup-speed P-004 the scan has no
   * window (`SNAPSHOT_SCAN_LOOKBACK` is 0), so an old set far behind the tail is
   * still found. A fresh head snapshot after a large pre-cut drain is still worth
   * appending, because it trims the ops the old set does not summarize.
   *
   * Omitted / false ⇒ full ship (`downloadCoreRange` from 0), byte-identical to
   * the pre-P-004 behavior.
   */
  readonly sparse?: boolean;
  /**
   * Release-only privacy projection. The filtered snapshot is minted into a fresh
   * read-only core so the live source log is never rewritten or made unreachable.
   */
  readonly filtered?: boolean;
  /** D-166 private plans, one per exact source core; never accepted on an unfiltered copy. */
  readonly uuidIdempotencyDropPlans?: readonly SeedUuidIdempotencyDropPlan[];
  /** Identity literals supplied by the release audit for the projection scrub. */
  readonly redactValues?: readonly string[];
  /** Optional bounded source-scan progress sink for filtered release cuts. */
  readonly onProgress?: SnapshotFoldProgressCallback;
  /** Optional cursor-stall sink for filtered release cuts. */
  readonly onStall?: (stall: SnapshotFoldStall) => void;
  /** Optional test/release override for the filtered-scan stall diagnostic. */
  readonly filteredScanStallMs?: number;
  /** Optional sink for the per-cut projection report (default: one `console.warn` line). */
  readonly onProjection?: (report: SeedProjectionReport) => void;
}

/** Context for {@link createCorestoreSeedProvider}.restore (first-boot time). */
export interface CorestoreRestoreContext {
  /** The fresh install's hyperbee store dir (`.papercusp/<harness>/hyperbee`). */
  readonly targetStoreDir: string;
}

interface CorestoreSeedMeta {
  readonly coreKeys: string[];
  readonly coreLengths: Record<string, number>;
  /**
   * P-004 — per-core sparse-suffix start: the index of the first block the seed
   * SHIPS (`0` for a full ship). RESTORE MUST download only `[coreSparseFrom, len)`
   * — a sparse seed only SERVES that suffix, so a full-range download (or any
   * `get(i, {wait:true})` for `i < coreSparseFrom`) HANGS on the absent prefix in
   * an offline restore (no other peer holds those blocks). Absent ⇒ a legacy
   * full-ship seed ⇒ restore reads from 0 (unchanged).
   */
  readonly coreSparseFrom?: Record<string, number>;
}

/**
 * RocksDB's info log (exactly `LOG`, rotated `LOG.old.<ts>`) is DIAGNOSTIC and is
 * rewritten on EVERY store open — it can never be part of the seed's content
 * identity. It is also scrubbed from the shipped seed because it embeds the build
 * box's hostname + absolute paths (WI-4736). Those two facts collide: hashing it
 * meant the cut hashed a LOG that the scrub then deleted, so `verify` re-hashed a
 * different directory and refused the restore — every install silently cold-pathed
 * to an EMPTY hive (EI-12881). Excluded here so the hash is stable whether or not a
 * LOG exists, on both the pack and verify sides. The numbered `<NNN>.log` WALs are
 * DATA and must keep participating.
 */
export const isRocksInfoLog = (rel: string): boolean => {
  const base = rel.split(/[\\/]/).pop() ?? '';
  return base === 'LOG' || base.startsWith('LOG.old');
};

async function walkFiles(root: string, dir: string = root, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, full, acc);
    else if (e.isFile() && !isRocksInfoLog(e.name)) acc.push(relative(root, full));
  }
  return acc;
}

/** Deterministic sha256 over a directory's file paths + bytes (sorted). */
async function hashDir(root: string): Promise<string> {
  const h = createHash('sha256');
  const rels = (await walkFiles(root)).sort();
  for (const rel of rels) {
    h.update(rel + '\0');
    h.update(await readFile(join(root, rel)));
  }
  return h.digest('hex');
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  for (const rel of await walkFiles(root)) total += (await stat(join(root, rel))).size;
  return total;
}

/**
 * Open a core by key in `store` and pull blocks `[from, length)` into local
 * storage. `from = 0` (the default) materializes the whole core (the pre-P-004
 * behavior). A sparse `from > 0` pulls only the suffix — the seed then SERVES only
 * that suffix, so the RESTORE side must call with the SAME `from` (from
 * `meta.coreSparseFrom`) or `get(i, {wait:true})` for `i < from` hangs on a block
 * no offline peer holds. Returns the core's full `length` (the authenticated head
 * length, independent of how many blocks were downloaded).
 */
async function downloadCoreRange(store: Corestore, keyHex: string, from = 0): Promise<number> {
  const core = store.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore;
  await core.ready();
  await core.update({ wait: true });
  const len: number = core.length;
  for (let i = Math.max(0, from); i < len; i++) await core.get(i, { wait: true });
  return len;
}

/**
 * Refuse to DECLARE a range the staging replica does not actually hold
 * (EI-20592896313306826; recurrence of EI-20199738329864737).
 *
 * ── WHY `downloadCoreRange` RETURNING IS NOT PROOF THE BLOCKS SHIPPED ──
 * `downloadCoreRange` awaits `core.get(i, { wait: true })` for every index and then
 * returns `core.length`, and that length is what lands in `meta.coreLengths`. But a
 * `get()` resolves as soon as the block is available to THAT SESSION — it is not a
 * statement that the block was durably written into the staging store. So a cut whose
 * replication finishes short still returns a full `length`, still hashes, and still
 * emits a manifest promising blocks the payload does not contain. Nothing throws.
 *
 * Measured on the shipped 2026-08-15 seed: `meta.coreLengths` declared 76 while the
 * payload held 64 readable blocks (contiguousLength 63) — 50,165,685 bytes short of the
 * manifest's own `sizeBytes`, and a `hashDir` mismatch that the provider's `verify()`
 * would have rejected at boot. The earlier occurrence (65 KB short) was closed by
 * refreshing the artifact, which left this hole open and let it recur two orders of
 * magnitude larger.
 *
 * So: assert the property on the REPLICA, before the entry is built, exactly like
 * {@link assertShippedRangeCarriesNoExcludedTables} — the artifact that ships is the
 * thing worth measuring, not the intent that produced it.
 *
 * THROWS rather than warns, for the same reason as its sibling: a refused cut costs
 * minutes, a published installer that silently restores an incomplete hive does not
 * announce itself at all.
 */
async function assertStagedRangeIsLocal(inp: {
  store: Corestore;
  keyHex: string;
  from: number;
  len: number;
}): Promise<void> {
  const { store, keyHex, from, len } = inp;
  const core = store.get({
    key: Buffer.from(keyHex, 'hex'),
    valueEncoding: 'json',
  }) as unknown as ReadableCore;
  await core.ready();

  const missing: number[] = [];
  for (let i = Math.max(0, from); i < len; i++) {
    // Prefer the O(1) bitfield test; fall back to a local-only read (`wait:false`),
    // which is precisely what a consumer of the shipped seed experiences offline.
    const present =
      typeof core.has === 'function'
        ? await core.has(i)
        : (await core.get(i, { wait: false })) != null;
    if (!present) {
      missing.push(i);
      // Enough to identify the failure without walking a 100k-block core to build a list.
      if (missing.length >= 8) break;
    }
  }

  if (missing.length > 0) {
    const shown = missing.join(', ');
    throw new Error(
      `seed cut REFUSED: staging replica is missing block(s) it would declare as shipped — ` +
        `core ${keyHex.slice(0, 16)}… range [${from}, ${len}), missing index(es) ${shown}` +
        `${missing.length >= 8 ? ' (truncated — more follow)' : ''}. ` +
        `contiguousLength=${String(core.contiguousLength ?? 'unknown')}. ` +
        `Declaring this range would ship a manifest promising blocks the payload does not hold ` +
        `(EI-20592896313306826).`,
    );
  }
}

/**
 * Refuse to ship a suffix that still carries an excluded table (EI-20108164746219771).
 *
 * ── WHY FILTERING THE SNAPSHOT IS NOT SUFFICIENT ON ITS OWN ──
 * The head snapshot is filtered (boot.ts / cut-seed-cli.ts), but what SHIPS is
 * `[coreSparseFrom, len)` where `len` is the core length at the cutter's read-only OPEN —
 * which happens strictly AFTER the operator appends that snapshot. The live operator
 * re-announces `presence` on a 30s keep-alive (presence-announce.ts DEFAULT_REFRESH_MS),
 * so a heartbeat landing in that gap appends a RAW op inside the shipped span and the
 * leak returns. The shipped seed measured rawOps=0, but that is a race won, not a race
 * removed: filtering alone makes the fix PROBABILISTIC.
 *
 * So this asserts the property directly, on the blocks that actually landed in staging
 * rather than on the intent that produced them. Reading the replica (not the source) is
 * the point — it is the artifact that ships.
 *
 * THROWS rather than warns. A refused cut is recoverable in minutes; a published
 * installer carrying the build box's identity is not, and the last one took three weeks
 * to notice. The artifact-level identity gate (`audit-release-bundle.py`) remains the
 * backstop; this is the earlier, cheaper failure that names the exact block.
 */
async function assertShippedRangeCarriesNoExcludedTables(inp: {
  readonly store: Corestore;
  readonly keyHex: string;
  readonly from: number;
  readonly len: number;
  readonly excludeTables: readonly string[];
}): Promise<void> {
  const excluded = new Set(inp.excludeTables);
  if (excluded.size === 0) return;
  const core = inp.store.get({
    key: Buffer.from(inp.keyHex, 'hex'),
    valueEncoding: 'json',
  }) as unknown as ReadableCore;
  await core.ready();
  const offenders: string[] = [];
  for (let i = Math.max(0, inp.from); i < inp.len; i++) {
    const op = (await core.get(i, { wait: true })) as PeerLogOp | null;
    if (!op) continue;
    if (isSnapshotOp(op)) {
      // A snapshot block carries the rows themselves — the case that matters, since the
      // shipped suffix is normally ENTIRELY snapshot chunks.
      const payload = op.value as { rows?: Array<{ table?: string; hbKey?: string }> } | undefined;
      for (const r of payload?.rows ?? []) {
        if (r?.table && excluded.has(r.table)) offenders.push(`block ${i} snapshot row ${r.table}`);
      }
      continue;
    }
    if (op.table && excluded.has(op.table)) offenders.push(`block ${i} raw op ${op.table}`);
  }
  if (offenders.length) {
    const shown = offenders.slice(0, 5).join('; ');
    throw new Error(
      `[seed:corestore] REFUSING TO CUT: the shipped suffix [${inp.from}, ${inp.len}) of ` +
        `${inp.keyHex.slice(0, 12)}… still carries ${offenders.length} row(s) from an excluded ` +
        `table (${shown}${offenders.length > 5 ? '; …' : ''}). Excluded: ${[...excluded].join(', ')}. ` +
        'This is the EI-20108164746219771 identity leak. A RAW-op offender means an op was ' +
        "appended between the filtered head snapshot and this cut's read-only open (presence " +
        're-announces every 30s) — re-cut to pick up a fresher snapshot. A SNAPSHOT-ROW offender ' +
        'means the head snapshot was produced WITHOUT the exclusion: check that the operator ' +
        'servicing /api/internal/substrate/head-snapshot is running a build that filters it.',
    );
  }
}

/** Adapt a corestore core (read via replication from the FULL source) to the
 *  {@link AdmittedLog} shape `findLatestCompleteSnapshot` scans. */
function coreAsAdmittedLog(core: ReadableCore, keyHex: string): AdmittedLog {
  return {
    keyHex,
    get length() {
      return core.length;
    },
    get: async (i: number) => (await core.get(i, { wait: true })) as PeerLogOp | null,
  };
}

/**
 * P-004 — the sparse-suffix start for a core: the chunk-0 index of its latest
 * COMPLETE snapshot set, via read-merge's `findLatestCompleteSnapshot` (the SAME
 * locator the joiner's cursor seeds to, so a `[seedIndex, len)` ship lines up with
 * where the reader folds from). `0` ⇒ no complete snapshot set in the core ⇒ ship
 * FULL (the reader can't seed past a prefix it can't find, so trimming it would break
 * restore). When a set exists the scan reads only `[seedIndex, len)` plus its chunks,
 * and no prefix block.
 */
async function computeSparseFrom(store: Corestore, keyHex: string): Promise<number> {
  const core = store.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore;
  await core.ready();
  await core.update({ wait: true });
  const log = coreAsAdmittedLog(core, keyHex);
  const short = `${keyHex.slice(0, 12)}…`;
  const budgets = CUTTER_SNAPSHOT_SCAN_TIMEOUTS_MS;

  let last: SnapshotScanOutcome | undefined;
  for (let attempt = 0; attempt < budgets.length; attempt++) {
    const timeoutMs = budgets[attempt]!;
    const r = await findLatestCompleteSnapshotDetailed(log, SNAPSHOT_SCAN_LOOKBACK, timeoutMs);
    last = r;
    if (r.kind === 'found') {
      if (attempt > 0) {
        console.warn(
          `[seed:corestore] snapshot scan for ${short} succeeded on attempt ${attempt + 1} at a ` +
            `${timeoutMs}ms read budget — the earlier miss was SLOWNESS, not a missing snapshot.`,
        );
      }
      return r.seed.seedIndex > 0 ? r.seed.seedIndex : 0;
    }
    // `none-in-window` is a real answer: every block was read and none held a snapshot.
    // More patience cannot change it, so don't burn the remaining budgets.
    if (r.kind === 'none-in-window') break;
    console.warn(
      `[seed:corestore] snapshot scan for ${short} could not READ block ${r.atIndex} (${r.cause}) at a ` +
        `${timeoutMs}ms budget (attempt ${attempt + 1}/${budgets.length})` +
        (attempt + 1 < budgets.length ? ' — retrying with a longer budget.' : '.'),
    );
  }

  // Only now is FULL history the honest answer — and name WHICH cause it is. The old
  // single message always blamed the scan WINDOW, which sent readers off to "append a
  // fresh snapshot" that already existed (WI-37553). The two causes have opposite fixes.
  if (last?.kind === 'unreadable') {
    console.warn(
      `[seed:corestore] sparse cut: could NOT READ the tail of ${short} (${last.cause} at block ` +
        `${last.atIndex}) after ${budgets.length} attempts → shipping FULL history for this core. ` +
        'This is a READ/liveness problem, NOT a missing snapshot — appending another snapshot will ' +
        'not help. Re-cut when the source corestore is quieter.',
    );
  } else {
    console.warn(
      `[seed:corestore] sparse cut: no complete snapshot set anywhere ` +
        `in ${short} → shipping FULL history for this core (append a fresh ` +
        `head snapshot via produceLogSnapshot after the pre-cut drain to trim it).`,
    );
  }
  return 0;
}

function pipeReplicate(a: Corestore, b: Corestore): { streams: Pipeable[]; teardown: () => void } {
  const sa = a.replicate(true) as unknown as Pipeable;
  const sb = b.replicate(false) as unknown as Pipeable;
  // Swallow post-teardown errors so a destroy() can't reject the run.
  for (const s of [sa, sb]) (s as unknown as { on(ev: string, cb: () => void): void }).on('error', () => {});
  sa.pipe(sb).pipe(sa);
  return {
    streams: [sa, sb],
    teardown: () => {
      for (const s of [sa, sb]) s.destroy();
    },
  };
}

/**
 * Open the explicitly discovered sibling stores read-only for the duration of
 * one cut. A candidate open failure is fatal: silently dropping an unreadable
 * candidate would recreate the original short/empty-seed failure under a new
 * path. The source store itself remains owned by the caller.
 */
async function openSourceStoreCandidates(sourceStoreDirs: readonly string[] | undefined): Promise<Corestore[]> {
  const dirs = [...new Set((sourceStoreDirs ?? []).map((dir) => dir.trim()).filter(Boolean))];
  const opened: Corestore[] = [];
  try {
    for (const dir of dirs) {
      const store = new Corestore(dir, { readOnly: true });
      try {
        await store.ready();
        opened.push(store);
      } catch (error) {
        await store.close().catch(() => {});
        throw new Error(`[seed:corestore] could not open source-store candidate ${dir}`, { cause: error });
      }
    }
    return opened;
  } catch (error) {
    for (const store of opened.reverse()) await store.close().catch(() => {});
    throw error;
  }
}

/** True when a store has the requested core's first block locally. */
async function hasLocalCoreBlocks(store: Corestore, keyHex: string): Promise<boolean> {
  const core = store.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore;
  await core.ready();
  if (core.length <= 0) return false;
  if (typeof core.has === 'function') return Boolean(await core.has(0));
  return (await core.get(0, { wait: false })) != null;
}

/**
 * Resolve a requested key to the store that physically holds its blocks.
 * Without candidates this intentionally returns `sourceStore` without probing,
 * preserving the pre-WI-37822 source-store-only behavior for direct callers.
 */
async function resolveSourceStoreForKey(
  sourceStore: Corestore,
  candidates: readonly Corestore[],
  keyHex: string,
): Promise<Corestore> {
  if (candidates.length === 0) return sourceStore;
  if (await hasLocalCoreBlocks(sourceStore, keyHex)) return sourceStore;
  for (const candidate of candidates) {
    if (await hasLocalCoreBlocks(candidate, keyHex)) return candidate;
  }
  // Keep the source as the fallback so the existing downstream diagnostics and
  // staged-range guard remain authoritative when no discovered store has it.
  return sourceStore;
}

/**
 * The corestore SeedProvider. Register it in a
 * {@link import('@papercusp/seed-bundle').SeedProviderRegistry}.
 */
export function createCorestoreSeedProvider(): SeedProvider {
  return {
    kind: CORESTORE_SEED_KIND,

    async cut(ctx: SeedCutContext): Promise<SeedCutOutput> {
      const {
        sourceStore,
        sourceStoreDirs,
        coreKeys,
        stagingDir,
        sparse,
        filtered,
        redactValues,
        onProgress,
        onStall,
        filteredScanStallMs,
        onProjection,
        uuidIdempotencyDropPlans,
      } =
        ctx as unknown as CorestoreCutContext;
      const uuidPlans = new Map<string, SeedUuidIdempotencyDropPlan>();
      for (const plan of uuidIdempotencyDropPlans ?? []) {
        if (!filtered || !coreKeys.includes(plan.sourceKeyHex) || uuidPlans.has(plan.sourceKeyHex)) {
          throw new Error('[seed:corestore] UUID row-drop plan requires a unique requested filtered source core');
        }
        uuidPlans.set(plan.sourceKeyHex, plan);
      }
      await mkdir(stagingDir, { recursive: true });

      const candidateStores = await openSourceStoreCandidates(sourceStoreDirs);
      const sourceStoresByKey = new Map<string, Corestore>();
      try {
        for (const keyHex of coreKeys) {
          sourceStoresByKey.set(keyHex, await resolveSourceStoreForKey(sourceStore, candidateStores, keyHex));
        }

        if (filtered) {
          const replica = new Corestore(stagingDir);
          await replica.ready();
          const filteredCoreKeys: string[] = [];
          const coreLengths: Record<string, number> = {};
          // WI-10001612 — record the PROJECTION FACT, don't leave it to be inferred.
          // Minted key → the owner own-log key it was projected from. See
          // `seed-projection-meta.ts` for why the mapping, and not a bare boolean.
          const coreProjectedFrom: Record<string, string> = {};
          const uuidRedactions: SeedUuidIdempotencyRedactionReport[] = [];
          const uuidOccurrenceIds = new Set<string>();
          try {
            for (const ownerKeyHex of coreKeys) {
              const minted = await mintFilteredSeedContentCore({
                sourceStore: sourceStoresByKey.get(ownerKeyHex) ?? sourceStore,
                ownerKeyHex,
                stagingStore: replica,
                redactValues,
                onProgress,
                onStall,
                filteredScanStallMs,
                onProjection,
                uuidIdempotencyDropPlan: uuidPlans.get(ownerKeyHex),
              });
              if (minted.projection.uuidIdempotencyRedaction) {
                const report = minted.projection.uuidIdempotencyRedaction;
                for (const occurrence of report.occurrences) {
                  const id = JSON.stringify(occurrence);
                  if (uuidOccurrenceIds.has(id)) {
                    throw new Error('[seed:corestore] duplicate UUID redaction occurrence across source cores');
                  }
                  uuidOccurrenceIds.add(id);
                }
                uuidRedactions.push(report);
              }
              filteredCoreKeys.push(minted.keyHex);
              coreLengths[minted.keyHex] = minted.length;
              coreProjectedFrom[minted.keyHex] = ownerKeyHex;
              // EI-20592896313306826 — same guard as the sparse branch: never declare a
              // length the staging replica cannot actually serve. This is the branch that
              // produced the truncated 2026-08-15 seed (76 declared, 64 present).
              await assertStagedRangeIsLocal({
                store: replica,
                keyHex: minted.keyHex,
                from: 0,
                len: minted.length,
              });
              await assertShippedRangeCarriesNoExcludedTables({
                store: replica,
                keyHex: minted.keyHex,
                from: 0,
                len: minted.length,
                excludeTables: SEED_EXCLUDED_TABLES,
              });
            }
          } finally {
            await replica.close();
          }

          const hash = await hashDir(stagingDir);
          const sizeBytes = await dirSize(stagingDir);
          const entry: SeedStoreEntry = {
            kind: CORESTORE_SEED_KIND,
            hash,
            sizeBytes,
            source: { type: 'resource', path: stagingDir },
            // This is a complete current-state projection, not a source-log suffix. Do not
            // label it sparse: a start index of 0 is honest here and must not trip the
            // history-degradation guard as though a private prefix had been dropped.
            //
            // WI-10001612 — `coreProjectedFrom` is how the guard KNOWS that, instead of
            // inferring it from a block count that silently expired once the workspace
            // outgrew the 1,000-block floor. This branch is the only place the fact is
            // available at all, so omitting it here is what forces the guess downstream.
            meta: {
              coreKeys: filteredCoreKeys,
              coreLengths,
              [SEED_PROJECTED_FROM_META_KEY]: coreProjectedFrom,
              ...(uuidRedactions.length ? { uuidIdempotencyRedactions: uuidRedactions } : {}),
            },
          };
          return { entry, payload: { path: stagingDir } };
        }

        // P-004 — sparse: resolve each core's suffix start from the FULL host store
        // (all blocks local, no replication for the scan) BEFORE downloading. The
        // reader seeds its cursor to the SAME index (findLatestCompleteSnapshot), so
        // `[from, len)` is exactly the span a snapshot-aware joiner folds.
        const coreSparseFrom: Record<string, number> = {};
        if (sparse) {
          for (const keyHex of coreKeys) {
            // computeSparseFrom does its own reporting now — it is the only place that can
            // tell an UNREADABLE tail from a genuinely absent snapshot (WI-37553), and those
            // two have opposite remedies.
            const from = await computeSparseFrom(sourceStoresByKey.get(keyHex) ?? sourceStore, keyHex);
            coreSparseFrom[keyHex] = from;
          }
        }
        const replica = new Corestore(stagingDir);
        await replica.ready();
        const replications = [...new Set(sourceStoresByKey.values())].map((host) => pipeReplicate(host, replica));
        const coreLengths: Record<string, number> = {};
        try {
          for (const keyHex of coreKeys) {
            const from = coreSparseFrom[keyHex] ?? 0;
            const len = await downloadCoreRange(replica, keyHex, from);
            coreLengths[keyHex] = len;
            // EI-20592896313306826 — the range about to be DECLARED must actually be present
            // in the replica. `downloadCoreRange` returning `len` does not establish that.
            await assertStagedRangeIsLocal({ store: replica, keyHex, from, len });
            // EI-20108164746219771 — verify the bytes that actually landed, before they are
            // hashed into a seed entry. Filtering the head snapshot is necessary but not
            // sufficient (see this function's note: a presence keep-alive can land a raw op
            // inside the shipped span after the snapshot was taken).
            await assertShippedRangeCarriesNoExcludedTables({
              store: replica,
              keyHex,
              from,
              len,
              excludeTables: SEED_EXCLUDED_TABLES,
            });
          }
        } finally {
          for (const replication of replications.reverse()) replication.teardown();
          await replica.close();
        }

        const hash = await hashDir(stagingDir);
        const sizeBytes = await dirSize(stagingDir);
        const entry: SeedStoreEntry = {
          kind: CORESTORE_SEED_KIND,
          hash,
          sizeBytes,
          source: { type: 'resource', path: stagingDir },
          meta: { coreKeys: [...coreKeys], coreLengths, ...(sparse ? { coreSparseFrom } : {}) },
        };
        return { entry, payload: { path: stagingDir } };
      } finally {
        for (const store of candidateStores.reverse()) await store.close().catch(() => {});
      }
    },

    async verify(entry: SeedStoreEntry, payload: SeedPayload): Promise<VerifyResult> {
      const path = (payload as { path?: string })?.path;
      if (!path || !existsSync(path)) return { ok: false, reason: `payload path missing: ${String(path)}` };
      const hash = await hashDir(path);
      if (hash !== entry.hash) {
        return { ok: false, reason: `hash mismatch (expected ${entry.hash.slice(0, 12)}…, got ${hash.slice(0, 12)}…)` };
      }
      return { ok: true };
    },

    /**
     * Inject the seeded read-only cores into B's OWN fresh store (idempotent —
     * re-downloading already-present blocks is a no-op). Never copies the seed's
     * primary key, so B's own log stays unique.
     */
    async restore(entry: SeedStoreEntry, payload: SeedPayload, ctx: SeedRestoreContext): Promise<void> {
      const { targetStoreDir } = ctx as unknown as CorestoreRestoreContext;
      const seedPath = (payload as { path: string }).path;
      const meta = entry.meta as CorestoreSeedMeta | undefined;
      const coreKeys = meta?.coreKeys ?? [];
      // P-004 — a sparse seed only SERVES `[coreSparseFrom, len)`. Restore MUST
      // range-limit to the SAME start, or `downloadCoreRange`'s `get(i,{wait:true})`
      // for a block in the dropped prefix hangs forever (offline restore → no peer
      // holds it). Absent meta ⇒ 0 ⇒ full read (legacy full-ship seed, unchanged).
      const coreSparseFrom = meta?.coreSparseFrom ?? {};
      await mkdir(targetStoreDir, { recursive: true });
      const target = new Corestore(targetStoreDir);
      // WI-2902: the SEED store MUST open `readOnly` — a bundled seed is a COPIED
      // payload (built into the .deb, dpkg-extracted to a root-owned read-only
      // `/usr/lib/<Product>/seed`), and corestore 7.x's storage layer guards every
      // writable open with a `device-file` (the `CORESTORE` header + a
      // `user.device-file` xattr). A copy loses the xattr and changes the inode, so
      // a default (writable) open throws "Invalid device file, was moved unsafely"
      // BEFORE it even hits the EACCES from the read-only dir — which is exactly why
      // every packaged install logged `restored=[]`. `readOnly:true` skips both the
      // device-file guard and the RocksDB LOCK/LOG writes (hypercore-storage gates
      // them on `!readOnly`), so the seed opens read-only and still serves its blocks
      // over replication. Proven: a moved+read-only seed replicates all 108633 blocks
      // into a fresh target. (Do NOT use `writable:false` — corestore forwards only
      // `readOnly` to Hypercore.defaultStorage, not `writable`.)
      const seedStore = new Corestore(seedPath, { readOnly: true });
      await target.ready();
      await seedStore.ready();
      // Pre-open each core in the seed store so it is served over replication.
      for (const keyHex of coreKeys) {
        const c = seedStore.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore;
        await c.ready();
      }
      const { teardown } = pipeReplicate(seedStore, target);
      try {
        for (const keyHex of coreKeys) {
          await downloadCoreRange(target, keyHex, coreSparseFrom[keyHex] ?? 0);
        }
      } finally {
        teardown();
        await seedStore.close();
        await target.close();
      }
    },
  };
}
