/**
 * cut-seed-cli — the release-time seed cutter (plan hive-seed-bundle-2026-07-04
 * P-006). Drives {@link cutHiveSeed} over the CANONICAL dogfood inputs (the
 * owner's checkout + the owner's hive corestore) to produce the seed the
 * installer bundles as a Tauri resource, and prints a SIZE REPORT so a release
 * build can see exactly how much the installer grows.
 *
 * Run — the SHIPPING command — on the OWNER box (the live epoch keychain must be
 * present: the git seal key is the hive epoch key, and deriveEpochKey is
 * get-or-CREATE, so a wrong keychain context mints a divergent key no member can
 * unwrap) against a QUIESCENT operator (stop it first so the corestore dir is not
 * being written):
 *
 *   PAPERCUSP_ALLOW_DEV_RESTART=1 \
 *   npx tsx apps/operator/lib/release/cut-seed-cli.ts \
 *     --out papercusp-desktop/src-tauri/seed \
 *     --origin https://github.com/Papercusp/papercup \
 *     --workspace-id papercusp-workspace    # seal git bundles under the hive epoch key (keyRef via=epoch)
 *
 * ⚠ Pass --workspace-id (or --epoch) for a real release: it seals via=epoch, which
 * a freshly-admitted member decrypts with the epoch key admission delivers (Q-4).
 * --encrypt-key-hex is FIXTURE/manual ONLY (keyRef via=seed-key-op) — there is NO
 * joiner delivery path for it, so a member cannot unwrap it and the git half falls
 * back to a cold clone. Do NOT use --encrypt-key-hex for a shippable seed.
 *
 * Flags (all optional except where noted):
 *   --out <dir>            seed output dir (default: papercusp-desktop/src-tauri/seed)
 *   --repo <dir>           source checkout (default: the workspace repo root)
 *   --store-dir <dir>      hive corestore dir (default: the LIVE per-workspace store
 *                          ~/.papercusp-workspaces/<workspace-id>/.papercusp/<hive>/hyperbee when
 *                          --workspace-id is given, else <root>/.papercusp/<hive>/hyperbee).
 *                          MUST already exist — a missing dir is refused, never created.
 *   --hive <slug>          hive home slug (default: papercusp)
 *   --origin <url>         origin the restored clone re-points at (default: the GitHub repo)
 *   --rev <rev>            git bundle rev selector (default: HEAD — current branch only, self-contained &
 *                          offline-cloneable; pass --all to seed every ref).
 *   --depth <n>            currently only `1`: cut an offline-cloneable one-commit snapshot of --rev instead
 *                          of full reachable history. Normal first-boot fetch back-fills history from origin.
 *                          The RELEASE default is DEPTH 1 (owner directive 2026-07-07: trim git history from
 *                          release builds, full history stays on GitHub — supersedes the 2026-07-05 option-A
 *                          full-history default). All build scripts pass --depth 1 unless
 *                          PAPERCUSP_SEED_DEPTH= (empty) forces a full-history cut.
 *   --shallow              alias for --depth 1.
 *   --allow-mint-epoch-key BOOTSTRAP ONLY: skip the load-don't-mint guard and let deriveEpochKey mint a
 *                          fresh epoch key when this box's keychain has no hive identity. Never for the
 *                          canonical hive — a minted key is unwrappable by every admitted member (WI-1981).
 *   --epoch <n>            cutAtEpoch override (default: resolved from PG if --workspace-id, else 0)
 *   --workspace-id <id>    SHIPPING seal: resolve cutAtEpoch from live hive_settings + seal via=epoch
 *   --core-keys <hex,hex>  extra admitted member log keys to seed (owner's own log is always included)
 *   --skip-corestore-refresh
 *   --no-force-backfill      resume a cut whose backfill already ran: trust
 *                            backfillLocalState's per-target markers instead of
 *                            re-enqueueing the whole corpus. Keeps the drain wait and
 *                            the fresh head snapshot, so --sparse stays valid.
 *                          release escape hatch: do NOT force-refresh local PG projection rows into the
 *                          peer log before snapshotting the corestore. The default with --workspace-id
 *                          is to refresh+drain, so installer seeds include all current dogfood work-items
 *                          even when the runtime one-time backfill marker is stale.
 *   --encrypt-key-hex <h>  FIXTURE ONLY (via=seed-key-op, no joiner delivery): 32-byte hex to seal the
 *                          git bundles at rest (env: PAPERCUSP_SEED_KEY_HEX) — never for a real release
 *   --no-git               skip the code half (hive-state-only seed)
 *   --no-corestore         skip the federated-state half (code-only seed)
 *   --sparse               P-004: ship only the head-snapshot span [snapshotIdx,len) of each
 *                          corestore (drops the ~2GB history prefix → ~40MB seed). Appends a fresh
 *                          head snapshot in the pre-cut refresh so the sparse start is in the reader
 *                          scan window. OPT-IN: requires the shipped reader's SUBSTRATE_LOG_SNAPSHOT
 *                          ON (P-005) — until then the default FULL cut folds from block 0.
 *   --head-snapshot-timeout-ms <ms>
 *                          explicit override for the live head-snapshot request deadline
 *                          (env: PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS). Omit it to derive the
 *                          deadline from the holder's own-log length.
 *   --reuse-corestore <dir> WI-3232: graft the ALREADY-CUT corestore from an existing seed dir onto this
 *                          (git-only) cut instead of re-snapshotting the live store. No operator quiesce
 *                          needed (git bundles from the checkout, not the store) — the safe way to re-cut
 *                          FULL-HISTORY git while keeping an earlier corestore snapshot. Same-dir (reuse ==
 *                          --out) is the normal case: the prior seed stays intact until the replacement
 *                          passes every release check. Requires the git half (not --no-git); epoch must match.
 *   --emit-epoch-key       WI-3232 (owner "Full pot, plaintext seed", alpha): also write epoch-keys.json
 *                          into the seed so a FRESH packaged install decrypts the pot OFFLINE (no
 *                          admission). WI-3297: bundles the CURRENT epoch key plus every HISTORICAL
 *                          epoch key still in the keychain (load-only — a missing one is warned, never
 *                          minted), so ops sealed under past epochs decrypt too. Ships the hive READABLE
 *                          — deliberate, flag-gated. Needs an epoch context (--workspace-id or --epoch).
 *   --redact-findings / --redact-finding-digests
 *                          refused: the projection sees sealed content, not plaintext credentials.
 *   --uuid-idempotency-drop-plans FILE --uuid-idempotency-drop-plans-sha256 HASH
 *                          D-166 private source-bound whole-row drops. Requires a fresh filtered
 *                          cut with --skip-corestore-refresh, so source lengths cannot be changed.
 *   --export-uuid-idempotency-census DIR --store-dir FROZEN_STORE
 *   --uuid-source-manifest FILE --uuid-source-manifest-sha256 HASH
 *   --uuid-epoch-keys FILE --uuid-epoch-keys-sha256 HASH
 *                          Read-only export of the exact manifest's canonical source rows;
 *                          the private assembler opens every original envelope independently.
 *                          Use an authorized source correction, then cut a fresh corestore.
 *   --json                 print the manifest + size report as JSON
 */

import { resolve, join, dirname, basename } from 'node:path';
import { moduleRepoRoot } from '@papercusp/operator-core/lib/module-repo-root';
import { constants, existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_NEUTRAL_BUILD_HOSTNAME,
  SEED_UTS_MARKER_ENV,
  buildBwrapArgv,
  findExecutableOnPath,
  planHostnameNeutralization,
  buildNeutralizedChildEnv,
} from './seed-hostname-neutralization.js';
import { assertStagedSeedCarriesNoIdentity, releaseSeedRedactionValues, SEED_REAL_HOSTNAME_ENV } from './seed-identity-guard.js';
export { mergeReleaseSeedRedactionValues } from './seed-identity-guard.js';
import { rm, readFile, writeFile, rename, cp, readdir, mkdir, mkdtemp, lstat, realpath } from 'node:fs/promises';
import Corestore from 'corestore';
import { captureSeedUuidOriginalSpan, exportSeedUuidIdempotencySource, readSeedFrozenExecution } from '@papercusp/operator-core/lib/sync/hyperbee/seed-provider-corestore';
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  cutHiveSeed,
  enumerateOwnStoreCoreKeys,
  formatBytes,
  CORESTORE_SUBDIR,
  SEED_MANIFEST_FILE,
  type GitCutSpec,
  type CorestoreCutSpec,
} from '@papercusp/operator-core/lib/sync/hyperbee/seed-cutter';
import { decodeManifest, encodeManifest, type SeedManifest, type SeedStoreEntry } from '@papercusp/seed-bundle';
import { assertSeedNotDegraded } from './seed-degradation-guard.js';
import { assertSeedPayloadMatchesManifest } from './seed-payload-integrity-guard.js';
import { judgeHolderBootInvariant } from './seed-holder-boot-invariant.js';
import { stampOpHlc } from '@papercusp/operator-core/lib/sync/hyperbee/hlc-stamp';
import { backfillLocalState, type BackfillResult } from '@papercusp/operator-core/lib/sync/hyperbee/backfill-local-state';
import {
  withPgRetry,
  isRetriableIdempotentPgConnectionError,
} from '@papercusp/operator-core/lib/pg-transient-retry';
import { getHiveEpoch } from '@papercusp/operator-core/lib/sync/hyperbee/hive-epoch-state';
import { resolveHiveEpochCrypto } from '@papercusp/operator-core/lib/sync/hyperbee/hive-epoch-serving';
import { drainOutboxOnce, DRAIN_PASS_TIMEOUT_MS } from '@papercusp/operator-core/lib/sync/hyperbee/outbox-drain';
import { openOwnLog, type OwnLog } from '@papercusp/operator-core/lib/sync/hyperbee/peer-log';
import {
  produceLogSnapshot,
  type SnapshotFoldProgress,
} from "@papercusp/operator-core/lib/sync/hyperbee/log-snapshot";
import { SEED_EXCLUDED_TABLES } from '@papercusp/operator-core/lib/sync/hyperbee/seed-excluded-tables';
import {
  findLiveOperatorHoldingHive,
  waitForLiveOperatorHoldingHive,
  requestLiveOperatorHeadSnapshot,
  HEAD_SNAPSHOT_PATH,
  type LiveHeadSnapshotNoHolder,
} from '@papercusp/operator-core/lib/sync/hyperbee/live-head-snapshot-client';
import { detectWedgedListener } from '@papercusp/operator-core/lib/service-health';
import { CURRENT_SCHEMA_VERSION } from '@papercusp/operator-core/lib/sync/hyperbee/schema-version';
import { loadHiveKeyStatus, type HiveKeyStatus } from '@papercusp/operator-core/lib/identity/hive-keypair';
import { papercuspPathForWorkspace } from '@papercusp/operator-core/lib/papercusp-root';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import type { BootedHarnessHandle, LocalWriteOp } from '@papercusp/operator-core/lib/sync/hyperbee/boot';

const DEFAULT_HIVE = 'papercusp';
const DEFAULT_ORIGIN = 'https://github.com/Papercusp/papercup';

/** Keep a long filtered scan visibly alive without writing one line per 256-block window. */
export const CUT_SEED_FILTERED_PROGRESS_INTERVAL_MS = 60_000;
export const CUT_SEED_FILTERED_PROGRESS_PERCENT_STEP = 5;

export function createFilteredSeedProgressReporter(input: {
  readonly warn?: (message: string) => void;
  readonly now?: () => number;
  readonly minIntervalMs?: number;
  readonly minPercentStep?: number;
} = {}): (progress: SnapshotFoldProgress) => void {
  const warn = input.warn ?? ((message: string) => console.warn(message));
  const now = input.now ?? Date.now;
  const minIntervalMs = input.minIntervalMs ?? CUT_SEED_FILTERED_PROGRESS_INTERVAL_MS;
  const minPercentStep = input.minPercentStep ?? CUT_SEED_FILTERED_PROGRESS_PERCENT_STEP;
  let lastReportedAt = Number.NEGATIVE_INFINITY;
  let lastReportedPercent = Number.NEGATIVE_INFINITY;
  let lastProcessed = -1;

  return (progress) => {
    if (progress.processed <= lastProcessed) return;
    const percent = progress.total <= 0
      ? 100
      : Math.min(100, Math.floor((progress.processed / progress.total) * 100));
    const at = now();
    const first = lastProcessed < 0;
    const complete = progress.processed >= progress.total;
    const intervalElapsed = at - lastReportedAt >= minIntervalMs;
    const percentAdvanced = percent - lastReportedPercent >= minPercentStep;
    lastProcessed = progress.processed;
    if (!first && !complete && !intervalElapsed && !percentAdvanced) return;

    warn(
      `[cut-seed] ${progress.phase}: ${progress.processed}/${progress.total} source blocks folded (${percent}%).`,
    );
    lastReportedAt = at;
    lastReportedPercent = percent;
  };
}

/**
 * Cross-process singleton for a release cut's live-hive refresh/open window.
 *
 * A Corestore fd-lock only serializes writable opens. Two live-operator cuts can
 * therefore both force-backfill the same PG projection before either opens its
 * read-only snapshot. Keep the key in PG, where both cut processes already meet,
 * and hold it transaction-scoped until refresh/drain and the final store open are
 * complete. `hashtextextended` gives us one deterministic 64-bit advisory key for
 * the workspace+hive pair without putting user-controlled values into SQL text.
 */
export const CUT_SEED_ADVISORY_LOCK_NAMESPACE = 'papercusp:cut-seed';

export async function withCutSeedSingleton<T>(input: {
  readonly pg: postgres.Sql;
  readonly workspaceId: string;
  readonly hive: string;
  readonly run: (pg: postgres.Sql) => Promise<T>;
}): Promise<T> {
  const [result] = await input.pg.begin(async (tx) => {
    const [{ acquired }] = await tx<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended(${`${CUT_SEED_ADVISORY_LOCK_NAMESPACE}:${input.workspaceId}:${input.hive}`}, 0)
      ) AS acquired
    `;
    if (!acquired) {
      throw new Error(
        `[cut-seed] another seed cut is already refreshing or opening ` +
          `${input.workspaceId}::${input.hive}; refusing before backfill or corestore open. ` +
          'Wait for that cut to finish. If it was interrupted after refresh completed, resume with ' +
        '--no-force-backfill rather than starting a second force-backfill.',
      );
    }
    return [input.run(tx as unknown as postgres.Sql)];
  });
  return result;
}

/**
 * Resolve the release literal set whenever the finished seed contains a corestore,
 * whether that corestore is cut fresh or grafted from `--reuse-corestore`.
 *
 * The reuse path deliberately sets `wantCorestore=false` because it must not open the
 * live store.  Using `corestore?.redactValues` as the later staged-byte guard's input
 * therefore silently reduced that guard to the five build-box literals and let a stale
 * snapshot carrying an owner organization name reach the Windows packaging gate.  Keep
 * selection in one pure, tested branch and feed its result to BOTH the fresh projection
 * and the post-graft guard.
 */
export function resolveReleaseSeedRedactionValuesForCut(input: {
  readonly wantCorestore: boolean;
  readonly reuseCorestoreDir?: string;
  readonly load: () => readonly string[];
}): readonly string[] {
  return input.wantCorestore || input.reuseCorestoreDir ? input.load() : [];
}

/** WI-10005568: reuse the provider's literal projection without putting a credential
 * in argv, source, or logs. Approval selects exact finding digests; the private scan
 * must still match its report, plaintext source and detector config identities. */
export async function readSeedFindingRedactions(
  reportPath: string,
  digests: readonly string[],
  configPath: string,
): Promise<readonly string[]> {
  const refused = () => new Error('seed credential redaction evidence invalid');
  const wanted = new Set(digests);
  if (!wanted.size || wanted.size !== digests.length || digests.some((d) => !/^[0-9a-f]{64}$/.test(d))) {
    throw refused();
  }
  const hashFile = async (file: string) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  };
  const privateFile = async (file: string) => {
    const [info, parent] = await Promise.all([lstat(file), lstat(dirname(file))]);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) ||
        !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) ||
        await realpath(file) !== resolve(file)) throw refused();
  };
  try {
    if (!reportPath.endsWith('.json')) throw refused();
    const metaPath = reportPath.replace(/\.json$/, '.meta.json');
    await Promise.all([privateFile(reportPath), privateFile(metaPath)]);
    const [reportText, metaText] = await Promise.all([readFile(reportPath, 'utf8'), readFile(metaPath, 'utf8')]);
    const rows: unknown = JSON.parse(reportText);
    const meta = JSON.parse(metaText) as { scannerExit?: number; findings?: number; reportSha256?: string;
      identity?: { blobSha256?: string; configSha256?: string } };
    if (!Array.isArray(rows) || rows.length !== meta.findings || ![0, 1].includes(meta.scannerExit ?? -1) ||
        createHash('sha256').update(reportText).digest('hex') !== meta.reportSha256 ||
        await hashFile(configPath) !== meta.identity?.configSha256) throw refused();
    const found = new Set<string>();
    const literals = new Set<string>();
    const sources = new Set<string>();
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') throw refused();
      const row = raw as Record<string, unknown>;
      const fields = [row.RuleID, row.Match, row.Secret];
      if (fields.some((v) => typeof v !== 'string' || v === 'REDACTED')) throw refused();
      if (typeof row.File !== 'string') throw refused();
      sources.add(row.File);
      const digest = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
      if (wanted.has(digest)) {
        if ((row.Secret as string).length < 12) throw refused();
        found.add(digest);
        literals.add((row.Secret as string).trim());
      }
    }
    if (found.size !== wanted.size || sources.size !== 1) throw refused();
    const source = [...sources][0];
    await privateFile(source);
    if (await hashFile(source) !== meta.identity?.blobSha256) throw refused();
    return [...literals];
  } catch {
    // Parsing and filesystem errors must not echo any private report content.
    throw refused();
  }
}

/** D-166: transport a private assembler result without logging values or private bindings.
 * Hash/shape checks are preflight; the provider checks the actual source rows and lengths.
 * This reader does not establish census completeness, source authentication or candidate GO. */
export async function readSeedUuidIdempotencyDropPlans(
  file: string, sha256: string, redactValues?: readonly string[],
): Promise<NonNullable<CorestoreCutSpec['uuidIdempotencyDropPlans']>> {
  const refused = () => new Error('UUID row-drop plan input invalid (values omitted)');
  try {
    const [info, parent] = await Promise.all([lstat(file), lstat(dirname(file))]);
    if (!/^[0-9a-f]{64}$/.test(sha256) || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)
        || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)
        || await realpath(file) !== resolve(file)) throw refused();
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw refused();
    const value = JSON.parse(bytes.toString('utf8'));
    if (value?.schema !== 'papercusp-uuid-idempotency-row-drop-plan-set-v1'
        || value.reviewRef !== 'p2p-public-release-endgame-2026-09-01#D-166'
        || !Array.isArray(value.plans) || value.sourceAuthentication !== 'original-envelope-aead'
        || value.sourceSignatureAndCoverage !== 'requires-independent-hypercore-export-validation'
        || !value.privateSourceBindings || !value.counts) throw refused();
    if (redactValues) {
      const literalsSha256 = createHash('sha256').update(JSON.stringify(redactValues)).digest('hex');
      const excludedTablesSha256 = createHash('sha256').update(JSON.stringify([...SEED_EXCLUDED_TABLES].sort())).digest('hex');
      const sources = value.privateSourceBindings.sources;
      if (!Array.isArray(sources) || !sources.length || sources.some(source =>
        source.privacyProjectionContext?.schema !== 'papercusp-seed-privacy-projection-v1'
        || source.privacyProjectionContext.literalsSha256 !== literalsSha256
        || source.privacyProjectionContext.excludedTablesSha256 !== excludedTablesSha256)) throw refused();
    }
    const keys = new Set<string>();
    for (const plan of value.plans) {
      if (plan?.schema !== 'papercusp-uuid-idempotency-row-drop-plan-v1'
          || plan.reviewRef !== value.reviewRef || typeof plan.sourceKeyHex !== 'string'
          || !/^[0-9a-f]{64}$/.test(plan.sourceKeyHex) || keys.has(plan.sourceKeyHex)
          || !Number.isSafeInteger(plan.sourceLength) || plan.sourceLength <= 0
          || !Array.isArray(plan.rows) || (!plan.rows.length && !plan.sourceInput)) throw refused();
      keys.add(plan.sourceKeyHex);
    }
    // Keep every D174 census core bound even when it has no UUID drops. Otherwise
    // the ordinary producer could choose a different input for that core silently.
    const sources = value.privateSourceBindings.sources;
    if (Array.isArray(sources) && sources.some(source => source.sourceInput)) {
      if (sources.length !== value.plans.length || sources.some(source => {
        const plan = value.plans.find((plan: { sourceKeyHex?: string }) => plan.sourceKeyHex === source.sourceKeyHex);
        return !source.sourceInput?.executionBinding || !plan || plan.sourceLength !== source.sourceLength
          || JSON.stringify(plan.sourceInput) !== JSON.stringify(source.sourceInput);
      })) throw refused();
    }
    return value.plans;
  } catch { throw refused(); }
}

/** Read-only D166 census from a manifest-bound frozen Corestore. This never opens the
 * live writer, refreshes history, or replaces an existing export. Independent GO must
 * reproduce the export against the actual frozen source and final candidate. */
export async function exportSeedUuidIdempotencyCensus(input: {
  storeDir: string; manifestPath?: string; manifestSha256?: string; potId?: string;
  epochKeysPath: string; epochKeysSha256: string; outputDir: string;
  redactValues?: readonly string[];
  /** D-176 creates an original proof-built replica here; never a storage copy. */
  captureOriginalSpan?: boolean;
}, deps: { readFrozenExecution?: typeof readSeedFrozenExecution } = {}): Promise<string> {
  // Dependency injection is internal to the library; the CLI always uses the
  // real clean-checkout reader. A fixture may supply its own frozen environment.
  const readExecution = deps.readFrozenExecution ?? readSeedFrozenExecution;
  const executionBinding = await readExecution();
  if (!(await lstat(input.storeDir)).isDirectory()) throw new Error('UUID frozen source store missing');
  let manifestPath = input.manifestPath;
  let manifestSha256 = input.manifestSha256;
  let potId = input.potId;
  let coreKeys: string[] | undefined;
  let coreLengths: Record<string, unknown> = {};
  if (manifestPath || manifestSha256) {
    if (!manifestPath || !manifestSha256) throw new Error('UUID source manifest binding incomplete');
    const manifestBytes = await readFile(manifestPath);
    if (!/^[0-9a-f]{64}$/.test(manifestSha256)
        || createHash('sha256').update(manifestBytes).digest('hex') !== manifestSha256) {
      throw new Error('UUID source manifest binding changed');
    }
    const manifest = decodeManifest(manifestBytes.toString('utf8'));
    if (potId && potId !== manifest.potId) throw new Error('UUID source pot binding changed');
    potId = manifest.potId;
    const entries = manifest.stores.filter(entry => entry.kind === 'corestore');
    if (entries.length !== 1) throw new Error('UUID source must contain exactly one Corestore entry');
    const meta = entries[0]!.meta as { coreKeys?: unknown; coreLengths?: Record<string, unknown> };
    const lengths = meta?.coreLengths;
    if (!Array.isArray(meta?.coreKeys) || !meta.coreKeys.length
        || new Set(meta.coreKeys).size !== meta.coreKeys.length || !lengths
        || meta.coreKeys.some(key => typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)
          || !Number.isSafeInteger(lengths[key]) || (lengths[key] as number) <= 0)) {
      throw new Error('UUID source core coverage incomplete');
    }
    coreKeys = meta.coreKeys as string[];
    coreLengths = lengths;
  } else if (!input.captureOriginalSpan || !potId) {
    throw new Error('UUID source requires a bound manifest or original capture with an explicit pot');
  }
  const store = new Corestore(input.storeDir, { readOnly: true, wait: false });
  try {
    await store.ready();
    if (!coreKeys) {
      // Exactly the release producer's default source population, on this ONE
      // held original view. Never substitute an already projected seed's keys.
      coreKeys = await enumerateOwnStoreCoreKeys(store);
      if (coreKeys.length !== 1) throw new Error('UUID original own-log selection incomplete');
      for (const key of coreKeys) {
        const core = store.get({ key: Buffer.from(key, 'hex'), valueEncoding: 'json' }) as { ready(): Promise<void>; length: number };
        await core.ready();
        if (!Number.isSafeInteger(core.length) || core.length <= 0) throw new Error('UUID original own-log head missing');
        coreLengths[key] = core.length;
      }
    }
    const sources = [];
    const foldNow = Date.now();
    let replicaDir: string | undefined;
    if (input.captureOriginalSpan) {
      if (coreKeys.length !== 1) throw new Error('UUID original span capture currently requires one manifest-bound core');
      replicaDir = join(input.outputDir, 'original-signed-span');
    }
    for (const [index, key] of coreKeys.entries()) {
      const exported = await exportSeedUuidIdempotencySource({ sourceStore: store,
        sourceKeyHex: key, sourceLength: coreLengths[key] as number,
        outputDir: input.outputDir, segment: `segment-${String(index + 1).padStart(6, '0')}.blob`,
        redactValues: input.redactValues, now: foldNow, executionBinding });
      if (replicaDir) {
        const capture = await captureSeedUuidOriginalSpan({ sourceStore: store, sourceKeyHex: key,
          sourceInput: exported.sourceInput, replicaDir });
        const replica = new Corestore(replicaDir, { readOnly: true, wait: false });
        try {
          await replica.ready();
          const verified = await exportSeedUuidIdempotencySource({ sourceStore: replica,
            sourceKeyHex: key, sourceLength: exported.sourceLength, outputDir: input.outputDir,
            segment: 'segment-000002.blob', redactValues: input.redactValues, now: foldNow, executionBinding });
          if (JSON.stringify(verified.sourceInput) !== JSON.stringify(exported.sourceInput)
              || capture.proofInventorySha256 !== verified.sourceInput.proofInventorySha256) {
            throw new Error('UUID original replica census binding mismatch');
          }
          sources.push(verified);
        } finally { await replica.close(); }
      } else sources.push(exported);
    }
    const configPath = join(input.outputDir, 'uuid-census.private.json');
    if (JSON.stringify(await readExecution()) !== JSON.stringify(executionBinding)) {
      throw new Error('UUID frozen execution changed during census');
    }
    if (!manifestPath) {
      // Private source-population descriptor, not a shipped SeedManifest or a
      // fabricated physical-store hash. Each head was actually signature-verified.
      manifestPath = join(input.outputDir, 'original-source-manifest.private.json');
      const bytes = JSON.stringify({ schema: 'papercusp-original-signed-source-span-v1', potId,
        sourceSelection: 'enumerateOwnStoreCoreKeys', stores: [{ kind: 'corestore', meta: {
          coreKeys, coreLengths, sourceHeads: Object.fromEntries(sources.map(source =>
            [source.sourceKeyHex, source.sourceInput.sourceHead])) } }] });
      await writeFile(manifestPath, bytes, { mode: 0o600, flag: 'wx' });
      manifestSha256 = createHash('sha256').update(bytes).digest('hex');
    }
    await writeFile(configPath, JSON.stringify({ reviewRef: 'p2p-public-release-endgame-2026-09-01#D-166',
      potId, sourceManifestPath: manifestPath, sourceManifestSha256: manifestSha256,
      epochKeysPath: input.epochKeysPath, epochKeysSha256: input.epochKeysSha256, sources,
      ...(replicaDir ? { originalSpanReplicaDir: replicaDir } : {}) }), { mode: 0o600, flag: 'wx' });
    return configPath;
  } finally { await store.close(); }
}

export interface PickGitEncryptionInput {
  /** --encrypt-key-hex / PAPERCUSP_SEED_KEY_HEX — an EXPLICIT fixture/manual key. */
  readonly keyHex?: string;
  /** --workspace-id — presence signals a live hive whose epoch we read from PG. */
  readonly workspaceId?: string;
  /** Whether --epoch was passed explicitly (a deliberate epoch context). */
  readonly epochProvided: boolean;
  readonly hive: string;
  readonly cutAtEpoch: number;
  /** The owner's epoch-key resolver (crypto.deriveEpochKey) — injected so the branch
   *  logic unit-tests without the keychain/native crypto. */
  readonly deriveEpochKey: (potId: string, epoch: number) => Promise<Uint8Array>;
  readonly warn?: (msg: string) => void;
}

/**
 * Decide how to seal the git bundles (P-010 live-wire 2 completion). Pure branch logic,
 * injected `deriveEpochKey`, so it's headless-testable:
 *
 *   1. `keyHex` given      → FIXTURE/manual mode: seal with that key, keyRef via='seed-key-op'
 *      (a standalone key with NO automatic joiner delivery → a joiner defers + cold-clones
 *      the git half). For manual/test use, not a real release.
 *   2. a DELIBERATE epoch context (`workspaceId` OR explicit `--epoch`) → RELEASE mode: seal
 *      under the hive EPOCH key (keyRef via='epoch'), which a newly-admitted member decrypts
 *      with the epoch key admission delivers (the path the joiner-side deferred-git-restore
 *      trigger resolves). NEVER taken from the bare cutAtEpoch=0 guess, so we can't mint a
 *      divergent key from nothing. ⚠ MUST run on the OWNER box with the live epoch keychain:
 *      deriveEpochKey is get-or-CREATE — a keychain MISS mints a fresh key no member can
 *      unwrap (seed then cold-clones the git half; no data loss).
 *   3. otherwise            → undefined (PLAINTEXT — dev/fixture only, warned).
 */
export async function pickGitEncryption(inp: PickGitEncryptionInput): Promise<GitCutSpec['encryption'] | undefined> {
  const warn = inp.warn ?? (() => {});
  if (inp.keyHex) {
    const key = Buffer.from(inp.keyHex, 'hex');
    if (key.length !== 32) throw new Error(`--encrypt-key-hex must be 32 bytes (64 hex chars); got ${key.length}`);
    warn(
      '[cut-seed] sealed with an EXPLICIT key (keyRef via=seed-key-op) — a joiner has no delivery path for it and ' +
        'will cold-clone the git half. FIXTURE/manual mode; a real release should seal under the epoch key ' +
        '(drop --encrypt-key-hex, pass --workspace-id).',
    );
    return { key: Uint8Array.from(key), keyRef: { via: 'seed-key-op', potId: inp.hive } };
  }
  if (inp.workspaceId || inp.epochProvided) {
    const epochKey = Uint8Array.from(await inp.deriveEpochKey(inp.hive, inp.cutAtEpoch));
    if (epochKey.length !== 32) {
      throw new Error(`owner epoch key for (${inp.hive}, epoch ${inp.cutAtEpoch}) is ${epochKey.length}B, expected 32`);
    }
    warn(
      `[cut-seed] git bundles sealed under hive epoch ${inp.cutAtEpoch} (keyRef via=epoch, hive '${inp.hive}'). ` +
        'MUST have run on the OWNER box with the live epoch keychain — a wrong context mints a divergent key no ' +
        'member can unwrap (seed then cold-clones the git half).',
    );
    return { key: epochKey, keyRef: { via: 'epoch', potId: inp.hive, epoch: inp.cutAtEpoch } };
  }
  warn(
    '[cut-seed] ⚠ NO encryption key + no --workspace-id/--epoch — git bundles will be PLAINTEXT. The dogfood repo ' +
      'is PRIVATE; a real release MUST pass --workspace-id (seal under the hive epoch key) or --encrypt-key-hex. ' +
      'Proceeding UNENCRYPTED (dev/fixture only).',
  );
  return undefined;
}

/**
 * Load-don't-mint guard (WI-2903 / WI-1981). `deriveEpochKey` is get-or-CREATE:
 * on a box whose keychain does NOT already hold the hive identity, an epoch seal
 * silently MINTS a fresh divergent key that no admitted member can unwrap — the
 * seed ships "sealed" but every joiner falls back to a cold clone. This box
 * (2026-06) already grew one such divergent identity that way.
 *
 * So before an epoch seal we REQUIRE the hive private key to already be loadable
 * (tri-state via loadHiveKeyStatus — a keychain read error fails CLOSED, it is
 * not "no key"). `allowMint` (--allow-mint-epoch-key) is the deliberate escape
 * hatch for bootstrapping a brand-new hive's first seed.
 */
export async function assertEpochSealIdentityPresent(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly allowMint: boolean;
  /** Injected for tests; defaults to the real keychain read. */
  readonly loadStatus?: (workspaceId: string, slug: string) => Promise<HiveKeyStatus>;
  readonly warn?: (msg: string) => void;
}): Promise<void> {
  const warn = inp.warn ?? ((m: string) => console.warn(m));
  const status = await (inp.loadStatus ?? loadHiveKeyStatus)(inp.workspaceId, inp.hive);
  if (status.kind === 'ok') {
    warn(`[cut-seed] hive identity present (pubkey ${status.pubkeyBase64.slice(0, 8)}…) — epoch seal will use the live key.`);
    return;
  }
  if (inp.allowMint) {
    warn(
      `[cut-seed] ⚠ --allow-mint-epoch-key: hive identity ${status.kind === 'error' ? `unreadable (${status.reason})` : 'absent'} — ` +
        'deriveEpochKey WILL mint a fresh key. Only correct when bootstrapping a brand-new hive.',
    );
    return;
  }
  const why =
    status.kind === 'error'
      ? `the keychain read FAILED (${status.reason}) — a key may exist but could not be loaded`
      : 'this box holds NO private key for the hive';
  throw new Error(
    `[cut-seed] REFUSING epoch seal for hive '${inp.hive}' (workspace '${inp.workspaceId}'): ${why}. ` +
      'deriveEpochKey is get-or-CREATE, so proceeding would mint a DIVERGENT epoch key no admitted member can unwrap ' +
      '(WI-1981). Run the cut on the owner box with the live keychain, or pass --allow-mint-epoch-key to bootstrap a new hive.',
  );
}

/** The bundled-epoch-key file (WI-3232). Ships INSIDE the seed dir alongside the
 *  manifest so a fresh packaged install can decrypt the pot OFFLINE (no admission).
 *  Shape: { "<hive>": { "<epoch>": "<base64 32-byte key>" } }. */
export const EPOCH_KEYS_FILE = 'epoch-keys.json';

/** WI-3232 (owner "Full pot, plaintext seed", alpha-authorised): serialize hive
 *  epoch keys so the bundled EpochKeyProvider can unwrap the seed's git bundles AND
 *  the corestore content with NO federation join. Ships the hive READABLE — only
 *  emitted behind the explicit --emit-epoch-key flag. WI-3297: takes the FULL
 *  per-epoch map (the provider already resolves any epoch in the doc) — seed logs
 *  carry ops sealed under PAST epochs, and a single-epoch file leaves those
 *  permanently undecryptable on a fresh install (the epoch-decrypt-fail DROP class). */
export function encodeEpochKeysFile(hive: string, keys: ReadonlyMap<number, Uint8Array>): string {
  if (keys.size === 0) throw new Error('encodeEpochKeysFile: no epoch keys to emit');
  const byEpoch: Record<string, string> = {};
  for (const epoch of [...keys.keys()].sort((a, b) => a - b)) {
    const key = keys.get(epoch)!;
    if (key.length !== 32) throw new Error(`epoch ${epoch} key must be 32 bytes, got ${key.length}`);
    byEpoch[String(epoch)] = Buffer.from(key).toString('base64');
  }
  return JSON.stringify({ [hive]: byEpoch }, null, 2) + '\n';
}

/**
 * WI-3297: assemble the full epoch-key map for --emit-epoch-key — the CURRENT
 * epoch's key (already derived by the seal path, get-or-create semantics
 * unchanged) plus every HISTORICAL epoch 0..cutAtEpoch-1 whose key the keychain
 * still holds, via a load-ONLY read (deriveEpochKey would MINT a fresh key for
 * any epoch the keychain misses and ship it as if real). A missing historical
 * key is warned and skipped — its ops stay undecryptable exactly as before,
 * never silently re-keyed.
 */
export async function collectSeedEpochKeys(inp: {
  readonly hive: string;
  readonly cutAtEpoch: number;
  readonly currentKey: Uint8Array;
  /** Injected for tests; defaults to the real load-only keychain read. */
  readonly loadKey?: (hive: string, epoch: number) => Promise<Uint8Array | null>;
  readonly warn?: (msg: string) => void;
}): Promise<Map<number, Uint8Array>> {
  const warn = inp.warn ?? ((m: string) => console.warn(m));
  // Lazy like hive-epoch-serving's crypto resolve: crypto-impl sits next to the
  // native sodium loader, and only the real keychain path needs it.
  const loadKey =
    inp.loadKey ??
    (async (h: string, e: number) =>
      (await import('@papercusp/operator-core/lib/sync/hyperbee/hive-epoch-crypto-impl')).loadEpochKeyIfPresent(h, e));
  const keys = new Map<number, Uint8Array>();
  for (let epoch = 0; epoch < inp.cutAtEpoch; epoch++) {
    const key = await loadKey(inp.hive, epoch);
    if (key) keys.set(epoch, key);
    else {
      warn(
        `[cut-seed] ⚠ historical epoch ${epoch} key NOT in the keychain — ops sealed under it stay ` +
          'undecryptable on seeded installs (bundling every epoch the keychain holds; never minting).',
      );
    }
  }
  keys.set(inp.cutAtEpoch, inp.currentKey);
  return keys;
}

/**
 * WI-3232 --reuse-corestore: read the reusable corestore store-entry from an EXISTING
 * seed dir's manifest. Lets a git-only re-cut (e.g. full-history) graft the already-cut
 * corestore back on WITHOUT re-snapshotting the live store — so no operator quiesce is
 * needed (avoids the outage class). Throws if the dir has no manifest, no corestore
 * entry, or no corestore payload on disk. Injected fs for tests.
 */
export async function readReusableCorestore(
  seedDir: string,
  deps: { readManifest?: (p: string) => Promise<string>; exists?: (p: string) => boolean } = {},
): Promise<{ entry: SeedStoreEntry; cutAtEpoch: number }> {
  const readManifest = deps.readManifest ?? ((p: string) => readFile(p, 'utf8'));
  const exists = deps.exists ?? existsSync;
  const manifestPath = join(seedDir, SEED_MANIFEST_FILE);
  if (!exists(manifestPath)) {
    throw new Error(`--reuse-corestore: no ${SEED_MANIFEST_FILE} in ${seedDir} (not a seed dir?)`);
  }
  const manifest = decodeManifest(await readManifest(manifestPath));
  const entry = manifest.stores.find((s) => s.kind === 'corestore');
  if (!entry) {
    throw new Error(`--reuse-corestore: ${join(seedDir, SEED_MANIFEST_FILE)} has no 'corestore' store entry — nothing to reuse`);
  }
  if (!exists(join(seedDir, CORESTORE_SUBDIR))) {
    throw new Error(`--reuse-corestore: manifest lists a corestore but ${join(seedDir, CORESTORE_SUBDIR)} is missing on disk`);
  }
  return { entry, cutAtEpoch: manifest.cutAtEpoch };
}

/** Graft a reused corestore entry onto a git-only cut's manifest (pure — exported for
 *  tests). Refuses to double-add a corestore. */
export function graftCorestoreEntry(gitManifest: SeedManifest, corestoreEntry: SeedStoreEntry): SeedManifest {
  if (gitManifest.stores.some((s) => s.kind === 'corestore')) {
    throw new Error('graftCorestoreEntry: manifest already has a corestore entry');
  }
  return { ...gitManifest, stores: [...gitManifest.stores, corestoreEntry] };
}

export interface RefreshCorestoreStateForSeedResult {
  readonly backfill: BackfillResult;
  readonly drained: number;
  readonly passes: number;
  readonly ownLogKey: string;
}

/**
 * Release pre-cut refresh: enqueue the current local PG projection rows and drain
 * them into the same own log that the seed snapshots. Runtime boot's one-time
 * `backfill_done` marker can be stale on long-lived dogfood installs; a packaged
 * installer seed must represent the current work-items/plans/settings, not only
 * whatever happened before that marker was written.
 */
export async function refreshCorestoreStateForSeed(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly store: Corestore;
  readonly pg?: postgres.Sql;
  readonly openOwnLogImpl?: (store: Corestore) => Promise<OwnLog>;
  readonly backfillImpl?: typeof backfillLocalState;
  readonly drainImpl?: (handle: BootedHarnessHandle, pg: postgres.Sql) => Promise<number>;
  readonly warn?: (msg: string) => void;
  /**
   * P-004 sparse cut: after the drain, append a FRESH head __snapshot__ so a sparse
   * cut can find a compaction point within the reader's tail scan window (see below).
   * Only meaningful for a sparse cut — a full cut ships every op and needs no snapshot.
   */
  readonly sparse?: boolean;
  readonly produceSnapshotImpl?: typeof produceLogSnapshot;
  /** False ⇒ --no-force-backfill; see the note on the call site below. */
  readonly forceBackfill?: boolean;
}): Promise<RefreshCorestoreStateForSeedResult> {
  const warn = inp.warn ?? ((m: string) => console.warn(m));
  const pg = inp.pg ?? getOrgPg().sql;
  const ownLog = await (inp.openOwnLogImpl ?? openOwnLog)(inp.store);
  const handle = {
    workspaceId: inp.workspaceId,
    harnessSlug: inp.hive,
    ownLog,
    // Mirror the REAL append seam (boot.ts:743-750, implemented at boot.ts:5426).
    // `OwnLog.append` takes a PeerLogOp whose `author_pubkey` is REQUIRED, while
    // LocalWriteOp carries only an optional `writerPubkey`. Passing the op straight
    // through appended it with no `author_pubkey` at all — the field the read-merge /
    // admission stages attribute an op to a peer identity by (peer-log.ts:47+).
    append: (op: LocalWriteOp) =>
      ownLog.append({ ...op, author_pubkey: op.writerPubkey ?? '' }),
    registerCloseHook: () => {},
  } as unknown as BootedHarnessHandle;

  const backfill = await (inp.backfillImpl ?? backfillLocalState)(handle, pg, {
    force: inp.forceBackfill !== false,
    maxOpsPerAuthor: 0,
  });

  let drained = 0;
  let passes = 0;
  const drain =
    inp.drainImpl ??
    ((h: BootedHarnessHandle, sql: postgres.Sql) =>
      // `_gcMaxBatches: 0` (no inline GC during a seed cut) was stranded when the GC
      // bound moved from a batch COUNT to a wall-time budget — the count ceiling was
      // removed for silently leaving rows behind (outbox-drain.ts:102). A 0 budget is
      // the faithful equivalent: the loop tests it at the TOP of each iteration
      // (outbox-drain.ts:513), so it breaks before the first GC batch.
      drainOutboxOnce(h, sql, { batch: 1000, _gcBudgetMs: 0 }));
  for (;;) {
    const n = await drain(handle, pg);
    passes += 1;
    drained += n;
    if (n === 0) break;
    if (passes > 10_000) {
      throw new Error(
        `[cut-seed] corestore refresh did not drain to zero after ${passes} passes ` +
          `(${drained} rows drained); refusing to cut a partial seed.`,
      );
    }
  }

  // P-004 sparse cut: append a FRESH head __snapshot__ compacting the just-drained state.
  // The reader's findLatestCompleteSnapshot scans back only SNAPSHOT_SCAN_LOOKBACK ops from the
  // tail; the drain just re-enqueued the whole pot as raw ops (≫ that window), so WITHOUT a fresh
  // tail snapshot computeSparseFrom finds none → returns 0 → the "sparse" cut silently ships FULL.
  // A full cut ships every block, so it needs no fresh snapshot. (seed-history-trim-2026-07-07 P-004.)
  if (inp.sparse) {
    const produce = inp.produceSnapshotImpl ?? produceLogSnapshot;
    // EI-20108164746219771 — same exclusion the LIVE operator applies in
    // servicePendingHeadSnapshot (boot.ts). This is the QUIESCED path (we hold the store
    // writable and append the snapshot ourselves); the no-outage path goes through the
    // head-snapshot route instead. Both append the snapshot a sparse cut ships, so both
    // must filter or the leak returns on whichever path is taken.
    const snap = await produce(ownLog, {
      now: Date.now(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      excludeTables: SEED_EXCLUDED_TABLES,
    });
    warn(
      `[cut-seed] sparse: appended fresh head snapshot ` +
        `(appended=${snap.appended} coversUpTo=${snap.coversUpTo} chunks=${snap.chunkCount} rows=${snap.rowCount}).`,
    );
  }

  warn(
    `[cut-seed] refreshed corestore source for ${inp.workspaceId}::${inp.hive}: ` +
      `backfill enqueued=${backfill.enqueued} dropped=${backfill.dropped} ` +
      `drained=${drained} ownLog=${ownLog.keyHex.slice(0, 12)}…`,
  );
  return { backfill, drained, passes, ownLogKey: ownLog.keyHex };
}

/**
 * WI-4487: the "the operator holds the store" signature. The failing lock is NOT
 * RocksDB's db/LOCK (the long-standing misdiagnosis) — it is the CORESTORE
 * device-file lock, which hypercore-storage builds in the CorestoreStorage
 * CONSTRUCTOR and only when `!readOnly && !allowBackup`. fd-lock raises this exact
 * string, so it is the one reliable marker that a live writer owns the store.
 */
export function isCorestoreLockedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /could not be locked|descriptor.*lock|resource.*locked/i.test(msg);
}

/**
 * WI-37488: the "the store moved under us mid-open" signature — TRANSIENT, not broken.
 *
 * A `readOnly` open is a RocksDB `OpenForReadOnly`: it reads CURRENT → MANIFEST and then
 * stats the files that manifest references. The live primary retires WAL/SST files
 * continuously, so a file retired between the manifest read and the stat surfaces as
 *   IO error: While stat a file for size: <store>/db/002519.log: No such file or directory
 * — an ENOENT for a file that legitimately no longer exists.
 *
 * This is not a rare edge: the cut CAUSES the churn it then races. `openSourceStoreForCut`
 * opens read-only immediately after forcing a full outbox drain + a head-snapshot append,
 * which is the hardest the primary ever rewrites its WAL. Measured 2026-08-09: a cut died
 * here at 13:20:50Z after a 1,090s drain (nothing cut, whole drain wasted), and five
 * identical read-only opens ~30s later all succeeded in 8-58ms.
 *
 * Deliberately narrow: ENOENT only. A corrupt manifest, a permissions failure or the
 * corestore lock itself must NOT be swallowed as retryable — those never self-clear, and
 * retrying them just delays a real diagnosis.
 */
export function isTransientStoreOpenError(e: unknown): boolean {
  if (isCorestoreLockedError(e)) return false;
  const code = (e as { code?: unknown } | null | undefined)?.code;
  if (code === 'ENOENT') return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /no such file or directory/i.test(msg);
}

/** How hard to retry a read-only open that lost a race with the live primary (WI-37488). */
export const RO_OPEN_RETRY_ATTEMPTS = 10;
export const RO_OPEN_RETRY_DELAY_MS = 1000;

export const HEAD_SNAPSHOT_ACCEPT_QUEUE_RECHECK_MS = 250;

type ListenerQueueSample = NonNullable<Awaited<ReturnType<typeof detectWedgedListener>>>;

interface PersistentAcceptQueueEvidence {
  readonly port: number;
  readonly firstPending: number;
  readonly secondPending: number;
  readonly firstBacklog: number;
  readonly secondBacklog: number;
  readonly pid: number | null;
}

/**
 * Add passive evidence only for ports that failed to answer the head-snapshot probe.
 * A positive first sample is confirmed after a pause; transient backlog spikes and
 * listener-table read failures stay undiagnosed. This never opens a client connection.
 */
async function confirmUnansweredAcceptQueues(inp: {
  readonly outcome: LiveHeadSnapshotNoHolder;
  readonly detect: typeof detectWedgedListener;
  readonly pause: (ms: number) => Promise<void>;
}): Promise<PersistentAcceptQueueEvidence[]> {
  const responsive = new Set([...inp.outcome.answered, ...inp.outcome.staleBuild]);
  const ports = [...new Set(inp.outcome.probed)].filter((port) => !responsive.has(port));
  if (ports.length === 0) return [];

  const listenUrl = (port: number): string => `http://127.0.0.1:${port}${HEAD_SNAPSHOT_PATH}`;
  try {
    const firstSamples = await Promise.all(
      ports.map(async (port) => ({ port, sample: await inp.detect(listenUrl(port)) })),
    );
    const candidates = firstSamples.filter(
      (entry): entry is { port: number; sample: ListenerQueueSample } =>
        entry.sample?.wedged === true && entry.sample.pending > 0,
    );
    if (candidates.length === 0) return [];

    await inp.pause(HEAD_SNAPSHOT_ACCEPT_QUEUE_RECHECK_MS);
    const confirmed = await Promise.all(
      candidates.map(async ({ port, sample: first }) => {
        const second = await inp.detect(listenUrl(port));
        if (!second?.wedged || second.pending <= 0) return null;
        return {
          port,
          firstPending: first.pending,
          secondPending: second.pending,
          firstBacklog: first.backlog,
          secondBacklog: second.backlog,
          // A restart between samples means we cannot identify one PID as the listener.
          pid: first.pid === second.pid ? first.pid : null,
        };
      }),
    );
    return confirmed.filter((entry): entry is PersistentAcceptQueueEvidence => entry !== null);
  } catch {
    // Diagnostics are fail-soft: they must not replace the original cut refusal.
    return [];
  }
}

function describeAcceptQueueEvidence(evidence: readonly PersistentAcceptQueueEvidence[]): string {
  if (evidence.length === 0) return '';
  const ports = evidence.map((entry) =>
    `port ${entry.port}: pending ${entry.firstPending} -> ${entry.secondPending}, ` +
      `backlog ${entry.firstBacklog} -> ${entry.secondBacklog}` +
      (entry.pid === null ? '' : `, pid ${entry.pid}`),
  );
  return (
    ` Passive listen-table samples ${HEAD_SNAPSHOT_ACCEPT_QUEUE_RECHECK_MS}ms apart found ` +
    `persistent unaccepted connections (${ports.join('; ')}). This is queue evidence only; ` +
    `it does not establish the listener's root cause.`
  );
}

function pauseForAcceptQueueSample(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * WI-4487: wait until the LIVE operator has drained this hive's outbox into its own
 * log, so a read-only cut ships CURRENT state rather than a stale snapshot.
 *
 * We must not drain it ourselves here: `drainOutboxOnce` appends to the own log
 * (needs the write lock the operator holds) AND stamps `drained_at` in SHARED PG.
 * Draining into anything other than the live log — a temp copy, say — would mark the
 * rows delivered while the real log never got them, silently losing them for good.
 * The operator owns its log; our job is only to enqueue (a PG-only INSERT) and wait.
 */
/**
 * Open the hive corestore for a cut, refreshing it first, and return a store whose
 * contents are current as of the return.
 *
 * The ORDER of the steps here is the whole point of the function, and it is why this is
 * one unit rather than inline code in main(): a `readOnly` corestore open is a RocksDB
 * `OpenForReadOnly`, i.e. a POINT-IN-TIME SNAPSHOT — it never observes another process's
 * subsequent writes. Measured against the live operator: a held readOnly open sat frozen
 * at own-log length 83311 across 45s while a fresh readOnly open of the same store read
 * 84872. So on the live path the refresh (whose appends are performed by the OPERATOR,
 * not us) MUST fully complete BEFORE we open. Open first and the cut replicates state
 * frozen at open, silently omitting every op the drain appended — while exiting 0 and
 * printing a green "drained to zero". That is the ships-green-does-nothing failure
 * WI-4487 exists to fix, so the ordering is asserted by tests; do not reorder.
 */
export async function openSourceStoreForCut(inp: {
  readonly storeDir: string;
  /** Undefined ⇒ no DB scope, so no refresh is possible. */
  readonly workspaceId: string | undefined;
  readonly hive: string;
  readonly sparse: boolean;
  /** False ⇒ --skip-corestore-refresh. */
  readonly wantRefresh: boolean;
  /**
   * False ⇒ --no-force-backfill: RESUMING a cut whose backfill already ran.
   *
   * The default (`force: true`) makes backfillLocalState skip its per-target marker read
   * and treat EVERY target as unswept — belt-and-braces for a release artifact, but it
   * re-enqueues the whole corpus (~35k rows here) on every attempt. Those rows are
   * already in substrate_outbox and still draining, so a relaunch STACKS onto the live
   * backlog for zero information gain: measured 2026-08-09, 27.9k undrained + 35.5k
   * re-enqueued = ~63k rows at ~4.4 rows/s ≈ 4h of pure waiting.
   *
   * With this false we trust the markers and sweep only genuinely-unswept targets. That
   * is SAFE for the seed's currency because the drain wait below is unchanged: it still
   * blocks until undrained === 0, and the fresh head snapshot is still appended after it.
   * The precondition it assumes is that a PRIOR backfill enqueued the corpus — true when
   * resuming, false on a first-ever cut for a workspace, which is why this is OPT-IN.
   */
  readonly forceBackfill?: boolean;
  readonly openStore?: (dir: string, opts?: { readOnly?: boolean; wait?: boolean }) => Corestore;
  readonly pg?: postgres.Sql;
  readonly refreshImpl?: typeof refreshCorestoreStateForSeed;
  readonly backfillImpl?: typeof backfillLocalState;
  readonly waitImpl?: typeof waitForOperatorDrain;
  /** P-019 seam — ask the live operator for the head snapshot a no-outage sparse cut needs. */
  readonly headSnapshotImpl?: typeof requestLiveOperatorHeadSnapshot;
  /** Optional explicit override; otherwise the client derives from the holder's own-log length. */
  readonly headSnapshotTimeoutMs?: number;
  /** Injectable only for the passive refusal diagnosis; production uses service-health's reader. */
  readonly detectWedgedListenerImpl?: typeof detectWedgedListener;
  /** Injectable only so the second passive listener sample is deterministic in tests. */
  readonly acceptQueueSamplePauseImpl?: (ms: number) => Promise<void>;
  /** P-019 seam — the cheap, side-effect-free "who holds this hive?" discovery. */
  readonly findHolderImpl?: typeof findLiveOperatorHoldingHive;
  /**
   * How long the pre-flight gate waits for a holder to appear before refusing. Defaults
   * to the client's budget, which spans a full bg-host recycle. 0 = one look (tests, and
   * anywhere a fast refusal beats a correct one).
   */
  readonly holderWaitMs?: number;
  /** WI-37488 seam — the backoff between read-only open retries (tests pass a no-op). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly warn?: (msg: string) => void;
}): Promise<{ store: Corestore; sourceWritable: boolean }> {
  const warn = inp.warn ?? ((m: string) => console.warn(m));
  const openStore = inp.openStore ?? ((dir, opts) => new Corestore(dir, opts) as Corestore);
  const wantRefresh = !!inp.workspaceId && inp.wantRefresh;

  // The CUT itself only ever READS this store — cores are copied out by pipeReplicate.
  // Only the optional pre-cut refresh writes. So try writable first (a quiesced box
  // refreshes in-process exactly as before) and fall back to read-only when the operator
  // holds the store.
  let store: Corestore | undefined = openStore(inp.storeDir);
  let sourceWritable = true;
  try {
    await store.ready();
  } catch (e) {
    if (!isCorestoreLockedError(e)) throw e;
    // Hold NOTHING open across the refresh: see the snapshot semantics above.
    await store.close().catch(() => {});
    store = undefined;
    sourceWritable = false;
  }

  // P-014 (D-012) — FAIL FAST, and fail BEFORE any expensive or MUTATING work.
  //
  // --sparse ships only `[coreSparseFrom, len)`, and coreSparseFrom is resolved by
  // computeSparseFrom → findLatestCompleteSnapshot, which scans back only
  // SNAPSHOT_SCAN_LOOKBACK (= SNAPSHOT_COMPACT_EVERY_OPS × 4 = 4,000) ops from the tail. A
  // fresh head snapshot at the tail is therefore a PRECONDITION of a sparse cut, not an
  // optimisation.
  //
  // Unguarded, the cut proceeds, computeSparseFrom returns 0, seed-provider-corestore emits
  // a console.warn, and the "sparse" seed ships the FULL core — how the 2026-07-21 release
  // shipped 461,475 blocks / 1.9 GB labelled sparse, unnoticed for three weeks.
  //
  // P-019 SOFTENED the `!sourceWritable` leg of this guard. It used to refuse outright on
  // the WI-4487 read-only path, which made "no outage" and "sparse" mutually exclusive.
  // That branch now asks the LIVE OPERATOR to append the snapshot on its behalf (below,
  // after the drain) — so holding the store is no longer disqualifying. What IS
  // disqualifying is having nobody to ask, and that is settled HERE, by a side-effect-free
  // `probeOnly` discovery, precisely so the refusal still lands before any mutation.
  //
  // Every condition below is therefore knowable without writing anything, and this still
  // throws BEFORE backfillLocalState — which INSERTs into substrate_outbox and would
  // otherwise leave rows enqueued for a cut that was never going to be usable.
  if (inp.sparse) {
    let blocked = !inp.workspaceId
      ? 'no --workspace-id, so no pre-cut refresh (and no head snapshot) can run'
      : !inp.wantRefresh
        ? '--skip-corestore-refresh suppressed the refresh that appends the head snapshot'
        : undefined;
    if (!blocked && !sourceWritable) {
      // WAIT for a holder rather than taking one instantaneous look (P-014, 2026-08-09).
      // This gate is the cheapest possible thing to get wrong: it runs before any mutation,
      // so a miss costs the whole cut for a condition that clears itself in seconds. Cut
      // attempt 1 died here in 32s because every port answered booted:false during a
      // bg-host recycle; 18 minutes later the same probe answered booted:true.
      const found = await waitForLiveOperatorHoldingHive({
        workspaceId: inp.workspaceId!,
        hive: inp.hive,
        findHolderImpl: inp.findHolderImpl,
        retryBudgetMs: inp.holderWaitMs,
        warn,
      });
      if (found.kind !== 'holder') {
        // P-015 / D-025. `sourceWritable === false` is set ONLY on a corestore-locked error, so
        // the lock is PROVEN held here. Judge the invariant explicitly rather than describing the
        // symptom: "no operator reports having booted it" reads as *nobody holds this hive*, which
        // points at the quiesce remedy — a fleet-affecting outage — for what is usually an
        // inconsistent in-process registry.
        const listenerQueueEvidence = await confirmUnansweredAcceptQueues({
          outcome: found,
          detect: inp.detectWedgedListenerImpl ?? detectWedgedListener,
          pause: inp.acceptQueueSamplePauseImpl ?? pauseForAcceptQueueSample,
        });
        const invariant = judgeHolderBootInvariant({
          storeLocked: true,
          holderFound: false,
          answered: found.answered,
          probed: found.probed,
          staleBuild: found.staleBuild,
        });
        blocked = `${invariant.message}${describeAcceptQueueEvidence(listenerQueueEvidence)} ` +
          `(hive ${inp.workspaceId}::${inp.hive})`;
        // A sibling that is SERVING but 404s this one path is running a build older than the
        // route (the Hono host has no file-watch, so a long-lived holder keeps 404ing until it
        // restarts) — the competing explanation for the same symptom, and the one whose remedy
        // differs. judgeHolderBootInvariant already names staleBuild in both of its
        // lock-held branches; this adds the specific route so the 404 is diagnosable.
        // See LiveHeadSnapshotNoHolder.staleBuild for the measured incident (P-014 / WI-10773).
        if (found.staleBuild.length) {
          blocked += ` (the 404 is on ${HEAD_SNAPSHOT_PATH})`;
        }
      }
    }
    if (blocked) {
      if (store) await store.close().catch(() => {});
      throw new Error(
        `[cut-seed] --sparse requires a fresh head snapshot at the own-log tail, and none can ` +
          `be appended: ${blocked}. Proceeding would silently ship the FULL core ` +
          `(computeSparseFrom → 0). Remedies: (a) re-run without the suppressing flag, or make ` +
          `sure the operator holding this hive is healthy and serving ` +
          `/api/internal/substrate/head-snapshot, then retry; (b) quiesce the operator on this box ` +
          `and re-run, so the cut opens the store WRITABLE and appends the snapshot itself (an ` +
          `OUTAGE); or (c) drop --sparse (PAPERCUSP_SEED_SPARSE=0) to ship a full seed ` +
          `deliberately.`,
      );
    }
  }

  if (wantRefresh && sourceWritable) {
    // Quiesced box: we own the store, so refresh in-process exactly as before.
    const pg = inp.pg ?? getOrgPg().sql;
    await (inp.refreshImpl ?? refreshCorestoreStateForSeed)({
      workspaceId: inp.workspaceId!,
      hive: inp.hive,
      store: store!,
      pg,
      sparse: inp.sparse,
      forceBackfill: inp.forceBackfill,
    });
  } else if (wantRefresh) {
    // Live-operator box: split the refresh along the write boundary. backfill is a
    // PG-only INSERT into substrate_outbox (it never appends to the log — the drain owns
    // that), so it needs no store handle at all; the drain itself is done by the OPERATOR,
    // into the real live log, and we simply wait for it. Draining it ourselves is not an
    // option: it needs the write lock, and stamping `drained_at` for rows the live log
    // never received would lose them permanently.
    const handle = { workspaceId: inp.workspaceId, harnessSlug: inp.hive } as unknown as BootedHarnessHandle;
    const forceBackfill = inp.forceBackfill !== false;
    if (!forceBackfill) {
      warn(
        '[cut-seed] --no-force-backfill: trusting backfillLocalState markers, so already-swept ' +
          'targets are NOT re-enqueued. The drain wait below is unchanged (still to zero), and the ' +
          'fresh head snapshot is still appended after it — currency is preserved. Only valid when a ' +
          'PRIOR backfill enqueued this corpus.',
      );
    }

    // WI-10001781 — ABSORB a transient connection loss instead of discarding the build.
    //
    // Measured 2026-09-17: the 0.0.21-alpha cut died here on
    // `write CONNECTION_DESTROYED 127.0.0.1:6432`, raised from postgres-js's pre-execution
    // `execute()` guard — i.e. the pool this phase was handed had been torn down between two
    // of its reads.
    //
    // ⚠ Size this honestly, because the obvious framing is wrong: the seed runs at phase ~16
    // of the pipeline, ~2.5 min in and BEFORE any platform build starts, so a death here
    // costs the preflight work (toolchain checks, lint:migrations, the migration boot-smoke
    // suite, the manifest bump) — 3 min and 12 min on the two 2026-09-17 attempts — not the
    // 2.5h cut. The reason to fix it anyway is the SECOND-order cost: an abort this cheap and
    // this arbitrary trains everyone to re-fire blind instead of diagnosing, which is how two
    // attempts died the same night for two unrelated reasons.
    //
    // Retrying is safe here because BOTH operations are idempotent, which is the standing
    // precondition on `isRetriableIdempotentPgConnectionError` (see its doc — the error alone
    // does NOT prove the statement never ran, so the caller owes this argument):
    //   • backfillLocalState only ever INSERTs into `substrate_outbox`, which carries no
    //     uniqueness constraint (PK on `id` alone) — so a repeat cannot raise a duplicate-key
    //     error — and the drain applies a duplicate `put` of the same key+row idempotently
    //     under LWW. A retry costs drain time, never correctness.
    //   • waitForOperatorDrain is a poll to zero: a pure read loop.
    //
    // They get SEPARATE retry scopes on purpose. Sharing one would re-run the backfill after
    // a blip during the drain wait — and that wait has been measured at ~17 min for 35k rows
    // (P-014), so a shared scope would re-enqueue the whole corpus to recover from a dropped
    // socket. Each scope RE-RESOLVES the pool: the failure being absorbed is a dead pool, so
    // retrying through a captured handle would go straight back into it.
    const retryOpts = (label: string) => ({
      retries: 3,
      backoffMs: 2_000,
      classifier: isRetriableIdempotentPgConnectionError,
      label,
      onRetry: (attempt: number, e: unknown) =>
        warn(
          `[cut-seed] ${label}: transient PG connection loss on attempt ${attempt} ` +
            `(${(e as Error)?.message ?? String(e)}). Re-resolving the pool and retrying rather than ` +
            `discarding the cut.`,
        ),
    });

    const backfill = await withPgRetry(
      () =>
        (inp.backfillImpl ?? backfillLocalState)(handle, inp.pg ?? getOrgPg().sql, {
          force: forceBackfill,
          maxOpsPerAuthor: 0,
        }),
      retryOpts('backfill'),
    );
    const { waitedMs } = await withPgRetry(
      () =>
        (inp.waitImpl ?? waitForOperatorDrain)({
          pg: inp.pg ?? getOrgPg().sql,
          workspaceId: inp.workspaceId!,
          hive: inp.hive,
        }),
      retryOpts('drain-wait'),
    );
    warn(
      `[cut-seed] refreshed via the live operator for ${inp.workspaceId}::${inp.hive}: ` +
        `backfill enqueued=${backfill.enqueued} dropped=${backfill.dropped}; operator drained to zero in ${waitedMs}ms.`,
    );
  } else if (!inp.workspaceId) {
    warn('[cut-seed] no --workspace-id: skipping pre-cut corestore refresh (no DB scope to backfill/drain).');
  } else {
    warn('[cut-seed] --skip-corestore-refresh: snapshotting corestore without refreshing local PG state first.');
  }

  // ── P-019 (D-012): the NO-OUTAGE sparse cut ──────────────────────────────────────
  // We are on the read-only path and the caller asked for --sparse, so the head
  // snapshot that sparse REQUIRES cannot be appended by us: the operator holds the
  // write lock. Ask the operator to append it on our behalf.
  //
  // The position of this block is load-bearing in BOTH directions, and neither is
  // obvious from the code alone:
  //   • AFTER the refresh/drain above — so the snapshot summarises the state the
  //     operator just drained. A snapshot taken before the drain covers less than the
  //     seed ships, which defeats the point of refreshing at all.
  //   • BEFORE the read-only open below — a `readOnly` Corestore handle is a
  //     point-in-time view (see the note on that open: a HELD read-only handle sat
  //     frozen at own-log length 83311 for 45s while a FRESH read-only open of the same
  //     store read the current length). Requesting the snapshot after opening would
  //     produce it into a log this cut can no longer see.
  if (!sourceWritable && inp.sparse) {
    const outcome = await (inp.headSnapshotImpl ?? requestLiveOperatorHeadSnapshot)({
      workspaceId: inp.workspaceId!,
      hive: inp.hive,
      ...(inp.headSnapshotTimeoutMs === undefined ? {} : { timeoutMs: inp.headSnapshotTimeoutMs }),
      warn,
    });
    if (outcome.kind !== 'produced') {
      // Refuse rather than degrade. P-014 established this direction and D-012 explains
      // why: a silently-full "sparse" cut is indistinguishable from a working one until
      // someone measures the shipped installer, which took three weeks last time.
      // P-015 / D-025 again — same invariant, second site. We are inside `!sourceWritable`, so
      // the lock is proven held here too, and a bare "nobody reports having booted it" would
      // steer to the outage remedy for what is usually a registry inconsistency.
      const listenerQueueEvidence =
        outcome.kind === 'no-holder'
          ? await confirmUnansweredAcceptQueues({
            outcome,
            detect: inp.detectWedgedListenerImpl ?? detectWedgedListener,
            pause: inp.acceptQueueSamplePauseImpl ?? pauseForAcceptQueueSample,
          })
          : [];
      const why =
        outcome.kind === 'no-holder'
          ? judgeHolderBootInvariant({
              storeLocked: true,
              holderFound: false,
              answered: outcome.answered,
              probed: outcome.probed,
              staleBuild: outcome.staleBuild,
            }).message + describeAcceptQueueEvidence(listenerQueueEvidence)
          : `the operator on port ${outcome.port} could not produce it: ${outcome.error}`;
      // Say how hard we tried. Without this the refusal reads as a first-try failure, and
      // the natural next move is "just retry the cut" — which re-runs the ~17-min drain to
      // arrive at the same place. If we already waited out the retry budget, the holder is
      // not merely recycling and remedy (a) is NOT the answer.
      // WI-37467: report ELAPSED wall-clock as the headline, not waitedMs (the sum of the
      // deliberate sleeps BETWEEN attempts) — waitedMs excludes time spent inside each
      // attempt itself (discovery + the real POST, which can run for minutes), so a run
      // that spent most of its time IN an attempt rather than sleeping between them
      // rendered as e.g. "~15s of waiting" for a 616s run. Keep waitedMs as a labelled
      // secondary term: the gap between the two numbers is itself diagnostic (a holder
      // that never came back vs. one whose attempts each ran long and failed).
      const tried = outcome.retry
        ? ` (after ${outcome.retry.attempts} attempts over ~${Math.round(outcome.retry.elapsedMs / 1000)}s ` +
          `[~${Math.round(outcome.retry.waitedMs / 1000)}s of that waiting between attempts] — ` +
          `so this is NOT a transient recycle; retrying the cut unchanged will re-run the drain and fail again)`
        : '';
      throw new Error(
        `[cut-seed] --sparse needs a fresh head snapshot at the own-log tail. This box's operator ` +
          `holds the corestore, so only IT can append one — and ${why}${tried}. Proceeding would silently ` +
          `ship the FULL core (computeSparseFrom → 0). Remedies: (a) confirm the operator holding ` +
          `${inp.workspaceId}::${inp.hive} is healthy and serving /api/internal/substrate/head-snapshot, ` +
          `then retry; (b) quiesce the operator and re-run, so this cut opens the store WRITABLE and ` +
          `appends the snapshot itself (an OUTAGE); or (c) drop --sparse (PAPERCUSP_SEED_SPARSE=0) to ` +
          `ship a full seed deliberately.`,
      );
    }
    warn(
      `[cut-seed] sparse (no outage): the live operator on port ${outcome.port} (pid ${outcome.pid}` +
        `${outcome.process ? `, ${outcome.process}` : ''}) appended a fresh head snapshot — ` +
        `appended=${outcome.appended} coversUpTo=${outcome.coversUpTo} chunks=${outcome.chunkCount} ` +
        `rows=${outcome.rowCount} in ${outcome.elapsedMs}ms. See WI-4487 + P-019.`,
    );
  }

  if (!sourceWritable) {
    // NOW open read-only — strictly after any refresh above, so this snapshot CONTAINS
    // the ops the operator just drained. `readOnly` skips the CORESTORE device-file lock
    // outright (hypercore-storage builds it only when `!readOnly && !allowBackup`) and
    // opens RocksDB read-only. That is what lets a box running the operator cut a
    // properly-seeded release with no quiesce and no outage — previously every such cut
    // either took an outage or fell back to PAPERCUSP_SEED_CORESTORE=0 and shipped an
    // installer that cold-clones on first boot.
    //
    // `wait: false` is load-bearing, not decoration. hypercore-storage:496 reads
    //   if ((this.bootstrap && !this.readOnly && !this.allowBackup) || this.wait)
    // — the `|| this.wait` binds AFTER the whole readOnly clause, so a truthy `wait`
    // re-arms the very DeviceFile lock readOnly is here to avoid, and it fails with an
    // error identical to the one we just caught. Pin it explicitly so this cannot regress
    // silently if a default changes upstream.
    // WI-37488: RETRY the read-only open on a transient ENOENT.
    //
    // We arrive here having just forced the heaviest write burst this store ever sees (a
    // full outbox drain + a head-snapshot append, both above), and a readOnly open stats
    // every file the MANIFEST references. Racing a WAL the primary retires in that window
    // is therefore the EXPECTED failure, not an exotic one — and it lands at the most
    // expensive possible moment, after the entire drain, with nothing cut.
    //
    // Each attempt gets a FRESH Corestore: a failed ready() leaves the instance unusable,
    // so retrying on the same object just re-throws. See isTransientStoreOpenError.
    const sleep = inp.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let roErr: unknown;
    let roAttempts = 0;
    for (let attempt = 1; attempt <= RO_OPEN_RETRY_ATTEMPTS; attempt++) {
      roAttempts = attempt;
      const candidate = openStore(inp.storeDir, { readOnly: true, wait: false });
      try {
        await candidate.ready();
        store = candidate;
        roErr = undefined;
        break;
      } catch (e) {
        roErr = e;
        await candidate.close?.().catch(() => {});
        // Only an ENOENT-shaped failure self-clears. Anything else (corrupt manifest,
        // permissions) is reported immediately rather than after a pointless budget.
        if (!isTransientStoreOpenError(e)) break;
        if (attempt < RO_OPEN_RETRY_ATTEMPTS) {
          warn(
            `[cut-seed] read-only open lost a race with the live operator's WAL churn ` +
              `(attempt ${attempt}/${RO_OPEN_RETRY_ATTEMPTS}) — retrying in ${RO_OPEN_RETRY_DELAY_MS}ms. See WI-37488.`,
          );
          await sleep(RO_OPEN_RETRY_DELAY_MS);
        }
      }
    }

    if (roErr !== undefined) {
      // The read-only fallback is the no-outage path; if even it cannot open, the store is
      // not merely operator-locked. Surface the real diagnosis + remedies rather than a
      // raw hyperbee error minutes into a cut.
      //
      // The two cases need DIFFERENT advice, and conflating them is its own defect: the
      // remedies below all degrade the seed (or take an outage), so recommending them for a
      // transient race makes a reader ship a worse seed to dodge a condition that clears on
      // its own. Only a NON-transient failure earns that list.
      const msg = roErr instanceof Error ? roErr.message : String(roErr);
      if (isTransientStoreOpenError(roErr)) {
        throw new Error(
          `[cut-seed] cannot open the hive corestore at ${inp.storeDir} read-only: it kept moving under us for ` +
            `all ${roAttempts} attempts over ~${Math.round((roAttempts * RO_OPEN_RETRY_DELAY_MS) / 1000)}s. ` +
            'This is a TRANSIENT race with the live operator retiring WAL/SST files, NOT a lock conflict and NOT a ' +
            'broken store — so do NOT reach for --no-corestore / --reuse-corestore / an outage, which all ship a ' +
            'worse seed to dodge a condition that clears by itself. The drain and head snapshot this run already ' +
            'completed are PERSISTED, so re-running the cut now is cheap (it will not re-pay the full drain). If it ' +
            'persists, something is writing to this hive far harder than a normal operator would.\n' +
            `See WI-37488. (underlying error: ${msg})`,
        );
      }
      throw new Error(
        `[cut-seed] cannot open the hive corestore at ${inp.storeDir} — it is locked by the running operator AND ` +
          'the read-only fallback failed, so this is not a plain lock conflict. Use a no-outage path instead:\n' +
          '  • PAPERCUSP_SEED_CORESTORE=0 / --no-corestore  → git-only seed (fresh installs cold-clone the hive on first boot)\n' +
          '  • --reuse-corestore <prior seed dir>           → graft an already-cut corestore, no quiesce (WI-3232)\n' +
          '  • PAPERCUSP_SKIP_SEED_CUT=1 (release-local.sh)  → reuse the existing src-tauri/seed as-is\n' +
          '  • or stop the operator, then re-run (an OUTAGE — not for the shared dev box).\n' +
          `See WI-4487. (underlying error: ${msg})`,
      );
    }
    warn(
      '[cut-seed] the operator holds the hive corestore — opened it READ-ONLY (after the refresh above) and ' +
        'cutting live (no quiesce, no outage). The cut only reads the store; see WI-4487.',
    );
  }

  return { store: store!, sourceWritable };
}

// EI-18155637095067676: outbox-drain.ts LEGITIMATELY lets a single drain pass hang up to
// DRAIN_PASS_TIMEOUT_MS (120s) before its own watchdog abandons the zombie pass and a fresh
// pass retries (WI-2009) — a documented, healthy self-heal, not a wedge. cut-seed's stall
// tolerance used to be an independent, coincidentally-EQUAL 120_000 constant, so a single
// hung pass produced exactly 120s of no-progress and the cut declared the operator wedged at
// the EXACT moment the drain's own watchdog would have recovered it — a guaranteed race under
// any transient append stall (confirmed live 2026-07-20: an 8779-row backlog the operator was
// healthily draining the whole time got refused because ONE pass took its documented up-to-120s
// self-heal window). Derive the default from the drain's own constant instead of a coincidence:
// give it at least two full pass-timeout cycles plus margin before concluding it's genuinely
// wedged. This does not mask a real wedge — outbox-drain's own DRAIN_BACKLOG_STALL_MS (10min)
// and age/size detectors (WI-5147) still escalate a genuinely-dead drain; a truly-stuck backlog
// still never drains and this still eventually fails, just not on one transient pass stall.
// WI-37500 — THE SAME MISTAKE ONE LEVEL UP. The derivation above accounts for the drain's
// INTERNAL self-heal (a hung PASS, recovered by outbox-drain's own watchdog in ≤120s). It does
// not account for the drain's OTHER, larger, equally-legitimate self-heal: a bg-host PROCESS
// recycle issued by bghost-watchdog.mjs. During one, NOTHING drains — the drain's owner is
// simply not running — and that blackout is structurally LONGER than 300s:
//   • bghost-watchdog only judges a freeze after FREEZE staleness > 240s, and
//   • it skips judgment entirely while the unit is within BOOT_GRACE_MS (8min), polling every
//     POLL_MS (30s) — so a boot that cannot get the ticker healthy is re-killed at exactly
//     BOOT_GRACE_MS + POLL_MS = 510s. Measured on this box 2026-08-09: five consecutive
//     inter-restart gaps of 510-511s (10:35:59→10:44:29→10:52:59, 11:44:31→11:53:01,
//     12:35:03→12:43:33, 13:34:05→13:42:36).
// So the OLD 300s budget could not survive even ONE recycle, while a real cut needs ~20-25min
// of continuous draining — i.e. the two clocks were on a collision course and the cut lost by
// construction. Measured failure 2026-08-09T14:35Z: freeze onset ~14:30:14Z, drain resumed
// 14:35:52Z (338s blackout), cut refused at 300s having done ~19k rows of real work.
// WIDENING IS SAFE, and not a mask: this bounds only how long we WAIT, never what we SHIP —
// the cut proceeds only at `undrained === 0`, so no extra wait can ever admit an omitted row.
// A genuinely dead drain still never reaches 0 and still fails, just after one recycle's worth
// of patience instead of before it. outbox-drain's own DRAIN_BACKLOG_STALL_MS (10min) and the
// WI-5147 age/size detectors remain the escalation path for a truly-wedged drain.
const BGHOST_RECYCLE_ENVELOPE_MS = 510_000; // BOOT_GRACE_MS (8min) + POLL_MS (30s), measured above
export const CUT_SEED_DRAIN_STALL_MS = BGHOST_RECYCLE_ENVELOPE_MS + DRAIN_PASS_TIMEOUT_MS * 2 + 60_000; // 510s + 300s = 810s

export async function waitForOperatorDrain(inp: {
  readonly pg: postgres.Sql;
  readonly workspaceId: string;
  readonly hive: string;
  /** Fail after this long with NO progress (default CUT_SEED_DRAIN_STALL_MS — derived from
   *  outbox-drain's own DRAIN_PASS_TIMEOUT_MS so this can never be tighter than a single
   *  legitimate self-heal cycle; see EI-18155637095067676). Not a total budget — see below. */
  readonly stallMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly warn?: (msg: string) => void;
}): Promise<{ undrained: number; waitedMs: number }> {
  const stallMs = inp.stallMs ?? CUT_SEED_DRAIN_STALL_MS;
  const pollMs = inp.pollMs ?? 500;
  const now = inp.now ?? (() => Date.now());
  const sleep = inp.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warn = inp.warn ?? ((m: string) => console.warn(m));
  const started = now();

  // Deadline on STALL, not on total elapsed time. A force-backfill legitimately enqueues
  // the whole projection — measured ~8k rows draining at ~55 rows/s ≈ 145s on this box —
  // so any fixed total budget either fails a perfectly healthy cut or is so large it stops
  // catching a genuinely wedged operator. Progress is the real health signal: as long as
  // the backlog keeps shrinking we wait, however long it takes.
  let lastUndrained = Number.POSITIVE_INFINITY;
  let lastProgressAt = now();
  let lastWarnAt = 0;

  for (;;) {
    const [{ undrained }] = await inp.pg<{ undrained: number }[]>`
      SELECT count(*)::int AS undrained
        FROM harness_shared.substrate_outbox
       WHERE workspace_id = ${inp.workspaceId}
         AND harness_slug = ${inp.hive}
         AND drained_at IS NULL
    `;
    if (undrained === 0) return { undrained: 0, waitedMs: now() - started };

    // A refill from another writer is just as meaningful as a decrease: the prior
    // low-water mark no longer describes the work still draining, so it must reset
    // the stall clock instead of letting an external refill look permanently stuck.
    if (undrained !== lastUndrained) {
      lastProgressAt = now();
      lastUndrained = undrained;
    }
    const stalledFor = now() - lastProgressAt;
    if (stalledFor >= stallMs) {
      throw new Error(
        `[cut-seed] the running operator has made NO progress draining ${undrained} outbox row(s) for ` +
          `${inp.workspaceId}::${inp.hive} in ${Math.round(stalledFor / 1000)}s — refusing to cut a seed that ` +
          'would silently omit them. Check the operator is healthy and draining (it owns the own-log ' +
          'append; this cut cannot drain on its behalf without corrupting delivery state), then retry.',
      );
    }
    if (now() - lastWarnAt >= 5_000) {
      lastWarnAt = now();
      warn(`[cut-seed] waiting for the operator to drain ${undrained} outbox row(s)…`);
    }
    await sleep(pollMs);
  }
}

/** Build and verify off to the side; a failed cut must preserve the entire prior
 * seed, including its manifest and epoch keys. The sibling transaction directory
 * keeps publication on one filesystem and retains the backup if rollback fails. */
export async function withSeedOutput<T>(
  outDir: string,
  build: (stagingDir: string) => Promise<T>,
  renameDir: typeof rename = rename,
): Promise<T> {
  await mkdir(dirname(outDir), { recursive: true });
  const transactionDir = await mkdtemp(join(dirname(outDir), `.${basename(outDir)}-cut-`));
  const stagingDir = join(transactionDir, 'next');
  const backupDir = join(transactionDir, 'previous');
  let displaced = false;
  let published = false;
  try {
    const result = await build(stagingDir);
    try {
      await renameDir(outDir, backupDir);
      displaced = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await renameDir(stagingDir, outDir);
      published = true;
    } catch (error) {
      if (displaced) {
        try {
          await renameDir(backupDir, outDir);
          displaced = false;
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `Seed publication and rollback failed; prior seed preserved at ${backupDir}`);
        }
      }
      throw error;
    }
    return result;
  } finally {
    if (!displaced || published) await rm(transactionDir, { recursive: true, force: true });
  }
}

function resolveWorkspaceRoot(): string {
  return process.env.PAPERCUSP_WORKSPACE_ROOT || moduleRepoRoot(import.meta.url);
}

/**
 * Find sibling harness stores that may host admitted remote logs. The
 * remote-core-host registry is process-local, while this release cutter runs
 * separately from the harness operators, so the `.papercusp/<harness>/hyperbee`
 * siblings are the explicit cross-process discovery surface.
 */
export async function deriveSourceStoreDirs(storeDir: string): Promise<string[]> {
  const resolvedStoreDir = resolve(storeDir);
  if (basename(resolvedStoreDir) !== 'hyperbee') return [];

  const harnessDir = dirname(resolvedStoreDir);
  const papercuspDir = dirname(harnessDir);
  if (basename(papercuspDir) !== '.papercusp') return [];

  let entries;
  try {
    entries = await readdir(papercuspDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(papercuspDir, entry.name, 'hyperbee'))
    .filter((candidate) => resolve(candidate) !== resolvedStoreDir && existsSync(candidate))
    .sort();
}

interface Args {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

export function parseGitDepth(args: Args): number | undefined {
  const raw = str(args, 'depth');
  if (args.shallow === true && raw !== undefined && raw !== '1') {
    throw new Error('--shallow is an alias for --depth 1; do not pass both with different values');
  }
  const value = raw ?? (args.shallow === true ? '1' : undefined);
  if (value === undefined) return undefined;
  const depth = Number(value);
  if (!Number.isInteger(depth) || depth < 1) {
    throw new Error(`--depth must be a positive integer; got ${value}`);
  }
  if (depth !== 1) {
    throw new Error(`--depth currently supports only 1; got ${depth}`);
  }
  return depth;
}

export const HEAD_SNAPSHOT_TIMEOUT_ENV = 'PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS';

/** Resolve the optional CLI/env override; omission preserves corpus-derived sizing. */
export function parseHeadSnapshotTimeoutMs(args: Args, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = str(args, 'head-snapshot-timeout-ms') ?? env[HEAD_SNAPSHOT_TIMEOUT_ENV];
  if (raw === undefined) return undefined;
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`--head-snapshot-timeout-ms must be a positive integer; got ${raw}`);
  }
  return timeoutMs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ('export-uuid-idempotency-census' in args) {
    const fields = ['store-dir', 'uuid-epoch-keys', 'uuid-epoch-keys-sha256', 'export-uuid-idempotency-census'] as const;
    if (fields.some(name => !str(args, name))) throw new Error('UUID source export requires exact frozen store, manifest/hash, epoch-keys/hash and a private output directory');
    const config = await exportSeedUuidIdempotencyCensus({ storeDir: str(args, 'store-dir')!,
      manifestPath: str(args, 'uuid-source-manifest'), manifestSha256: str(args, 'uuid-source-manifest-sha256'),
      potId: str(args, 'hive') ?? DEFAULT_HIVE,
      epochKeysPath: str(args, 'uuid-epoch-keys')!, epochKeysSha256: str(args, 'uuid-epoch-keys-sha256')!,
      outputDir: str(args, 'export-uuid-idempotency-census')!,
      redactValues: releaseSeedRedactionValues(resolveWorkspaceRoot()),
      captureOriginalSpan: args['capture-original-span'] === true });
    console.log(JSON.stringify({ schema: 'papercusp-uuid-idempotency-source-export-v1', configPath: config }));
    return;
  }
  // WI-10005568: a validated plaintext finding does not make the projection able
  // to inspect its source envelope. Refuse before opening/refreshing any store;
  // otherwise the cut can appear successful while carrying the same credential.
  if ('redact-findings' in args || 'redact-finding-digests' in args) {
    throw new Error('seed finding export redaction is unsupported for sealed content; correct the authorized source and cut a fresh corestore');
  }
  let uuidIdempotencyDropPlans: CorestoreCutSpec['uuidIdempotencyDropPlans'];
  let uuidPlanInput: { file: string; hash: string } | undefined;
  if ('uuid-idempotency-drop-plans' in args || 'uuid-idempotency-drop-plans-sha256' in args) {
    const file = str(args, 'uuid-idempotency-drop-plans');
    const hash = str(args, 'uuid-idempotency-drop-plans-sha256');
    if (!file || !hash || args['skip-corestore-refresh'] !== true
        || 'reuse-corestore' in args || args['no-corestore'] === true) {
      throw new Error('UUID row-drop plans require an exact private file/hash and a fresh cut with --skip-corestore-refresh');
    }
    uuidPlanInput = { file, hash };
  }
  const root = resolveWorkspaceRoot();
  const hive = str(args, 'hive') ?? DEFAULT_HIVE;
  const repo = str(args, 'repo') ?? root;
  const outDir = resolve(str(args, 'out') ?? join(root, 'papercusp-desktop', 'src-tauri', 'seed'));
  const origin = str(args, 'origin') ?? DEFAULT_ORIGIN;
  // Default to HEAD (current branch). Build scripts add --depth 1 so the release
  // seed is a small offline-cloneable tree snapshot; omit depth for full history.
  const rev = str(args, 'rev') ?? 'HEAD';
  const depth = parseGitDepth(args);
  const headSnapshotTimeoutMs = parseHeadSnapshotTimeoutMs(args);
  const wantGit = args['no-git'] !== true;
  // WI-3232 --reuse-corestore: graft an existing corestore instead of cutting a fresh
  // one from the live store (no quiesce). Mutually exclusive with cutting a corestore.
  const reuseCorestoreRaw = str(args, 'reuse-corestore');
  const reuseCorestoreDir = reuseCorestoreRaw ? resolve(reuseCorestoreRaw) : undefined;
  const emitEpochKey = args['emit-epoch-key'] === true;
  const wantCorestore = args['no-corestore'] !== true && !reuseCorestoreDir;
  const releaseRedactionValues = [...resolveReleaseSeedRedactionValuesForCut({
    wantCorestore,
    ...(reuseCorestoreDir ? { reuseCorestoreDir } : {}),
    load: () => releaseSeedRedactionValues(root),
  })];
  if (uuidPlanInput) uuidIdempotencyDropPlans = await readSeedUuidIdempotencyDropPlans(
    uuidPlanInput.file, uuidPlanInput.hash, releaseRedactionValues);
  const asJson = args['json'] === true;

  // P-004 sparse cut: ship only [snapshotIndex,len) of each core (drops the ~2GB history
  // prefix → ~40MB seed). OPT-IN: a sparse seed REQUIRES the shipped reader to have
  // SUBSTRATE_LOG_SNAPSHOT ON (P-005) — with it OFF the restore folds from an absent block 0
  // and fails. Release builds add --sparse once P-005 lands + is verified; until then the
  // default full cut is the safe shippable. (seed-history-trim-public-builds-2026-07-07.)
  const sparse = args.sparse === true;
  if (sparse && !wantCorestore) {
    throw new Error(
      '--sparse applies to the corestore cut; incompatible with --no-corestore / --reuse-corestore ' +
        '(a reused corestore is grafted as-cut).',
    );
  }
  if (sparse && args['skip-corestore-refresh'] === true) {
    console.warn(
      '[cut-seed] --sparse with --skip-corestore-refresh: no FRESH head snapshot is appended, so the ' +
        'sparse start may fall outside the reader scan window and the cut can silently ship FULL. ' +
        'Drop --skip-corestore-refresh for a real sparse cut.',
    );
  }

  // EI-20040763522089574 — the ONE chokepoint that keeps the build box's hostname out of
  // the seed. Every leg cuts through here (release-local.sh, ensure-release-seed.sh,
  // build-windows-cross.sh, mac-vm-build.sh, mac-vm-verify-build.sh), which is exactly
  // why it lives here and not in those five scripts: a sixth caller added later would
  // silently reintroduce the leak, and two of those five are mac-vm-* scripts already
  // known to be unable to emit a failing verdict (D-009).
  //
  // Placed AFTER arg parsing (we need `wantCorestore`) but BEFORE any work, so the
  // re-exec never duplicates a backfill/drain. See ./seed-hostname-neutralization.ts for
  // the mechanism and the measurements.
  {
    const neutralHostname = process.env.PAPERCUSP_SEED_BUILD_HOSTNAME || DEFAULT_NEUTRAL_BUILD_HOSTNAME;
    const plan = planHostnameNeutralization({
      wantCorestore,
      platform: process.platform,
      markerSet: process.env[SEED_UTS_MARKER_ENV] === '1',
      currentHostname: hostname(),
      neutralHostname,
      bwrapPath: findExecutableOnPath('bwrap'),
    });
    if (plan.kind === 'refuse') throw new Error(plan.message);
    if (plan.kind === 're-exec') {
      console.warn(
        `[cut-seed] re-exec under bwrap with a neutral UTS hostname ('${plan.neutralHostname}') so RocksDB ` +
          'does not stamp this box into every SST it writes (EI-20040763522089574).',
      );
      const res = spawnSync(
        plan.bwrapPath,
        buildBwrapArgv({
          bwrapPath: plan.bwrapPath,
          neutralHostname: plan.neutralHostname,
          execPath: process.execPath,
          // process.execArgv carries the tsx loader flags — see buildBwrapArgv's note.
          execArgv: process.execArgv,
          argv: process.argv.slice(1),
        }),
        {
          stdio: 'inherit',
          // Composed by a pure, tested function — the child's env is as load-bearing as its
          // argv (see buildNeutralizedChildEnv): the marker stops the re-exec recursing, and
          // the real hostname is the only way the child can still know what it must NOT ship.
          env: buildNeutralizedChildEnv({
            env: process.env,
            realHostname: hostname(),
            realHostnameEnvKey: SEED_REAL_HOSTNAME_ENV,
          }),
        },
      );
      // Fail CLOSED on a broken re-exec: a seed cut that "succeeded" because the sandbox
      // never ran is the silent-degrade this whole guard exists to prevent.
      if (res.error) throw new Error(`[cut-seed] bwrap re-exec failed to start: ${res.error.message}`);
      if (res.signal) throw new Error(`[cut-seed] bwrap re-exec died on signal ${res.signal}`);
      process.exit(res.status ?? 1);
    }
  }

  if (reuseCorestoreDir && args['no-corestore'] === true) {
    throw new Error('--reuse-corestore and --no-corestore are mutually exclusive (reuse IS the corestore source)');
  }
  if (reuseCorestoreDir && !wantGit) {
    throw new Error('--reuse-corestore grafts the corestore onto a FRESH git cut; with --no-git there is nothing new to cut');
  }
  if (!wantGit && !wantCorestore && !reuseCorestoreDir) {
    throw new Error('nothing to cut: both --no-git and --no-corestore given');
  }

  // Epoch: resolve from live hive_settings when a workspace id is given, else
  // default to 0 (the canonical dogfood hive has no boundary bumps — all content
  // is under epoch 0, decryptable by a new member's single epoch-0 key).
  let cutAtEpoch = 0;
  const workspaceId = str(args, 'workspace-id');
  if (str(args, 'epoch') !== undefined) {
    cutAtEpoch = Number(str(args, 'epoch'));
  } else if (workspaceId) {
    cutAtEpoch = await getHiveEpoch(workspaceId, hive);
  } else {
    console.warn('[cut-seed] no --workspace-id/--epoch — defaulting cutAtEpoch=0 (canonical dogfood hive).');
  }

  // WI-3232: read the reusable corestore entry before staging the replacement. Refuse an epoch
  // mismatch — a corestore cut at a different epoch would ship inconsistent hive state.
  let reused: { entry: SeedStoreEntry; cutAtEpoch: number } | undefined;
  if (reuseCorestoreDir) {
    reused = await readReusableCorestore(reuseCorestoreDir);
    if (reused.cutAtEpoch !== cutAtEpoch) {
      throw new Error(
        `--reuse-corestore: the reused corestore was cut at epoch ${reused.cutAtEpoch} but this cut resolves epoch ` +
          `${cutAtEpoch} — refusing to mix epochs (pass --epoch ${reused.cutAtEpoch} to match, or re-cut the corestore).`,
      );
    }
  }

  const cutTs = Date.now();
  const cutHlc = stampOpHlc({ ts: cutTs }).hlc;

  // WI-3232 --emit-epoch-key: captured from the git epoch seal when available (no
  // re-derive), else derived on demand in the emit step below.
  let epochKeyForEmit: Uint8Array | undefined;

  // --- git half ---
  let git: GitCutSpec | null = null;
  if (wantGit) {
    const keyHex = str(args, 'encrypt-key-hex') ?? process.env.PAPERCUSP_SEED_KEY_HEX;
    // Load-don't-mint guard BEFORE touching deriveEpochKey (get-or-CREATE).
    if (!keyHex && workspaceId) {
      await assertEpochSealIdentityPresent({
        workspaceId,
        hive,
        allowMint: args['allow-mint-epoch-key'] === true,
      });
    }
    const encryption = await pickGitEncryption({
      keyHex,
      workspaceId,
      epochProvided: str(args, 'epoch') !== undefined,
      hive,
      cutAtEpoch,
      // Lazily resolve the crypto ONLY on the epoch path (keyHex/plaintext never touch it).
      deriveEpochKey: async (h, e) => (await resolveHiveEpochCrypto(true)).deriveEpochKey(h, e),
      warn: (m) => console.warn(m),
    });
    git = { sourceRepoDir: repo, originUrl: origin, rev, ...(depth !== undefined ? { depth } : {}), ...(encryption ? { encryption } : {}) };
    // WI-3232: the epoch seal already derived the hive epoch key — reuse it for
    // --emit-epoch-key rather than deriving twice.
    if (encryption && encryption.keyRef.via === 'epoch') epochKeyForEmit = encryption.key;
  }

  // --- corestore (federated hive state) half ---
  // Store-dir default: the LIVE per-workspace store (~/.papercusp-workspaces/<id>/
  // .papercusp/<hive>/hyperbee) when --workspace-id names one, else the repo-local
  // layout. The repo-relative guess was the WI-2903 trap: on a multi-workspace box
  // it points at empty dev scratch, and `new Corestore()` HAPPILY CREATES an empty
  // store there — a silently-empty seed. Hence the existsSync refusal below.
  const storeDir =
    str(args, 'store-dir') ??
    (workspaceId ? papercuspPathForWorkspace(workspaceId, hive, 'hyperbee') : join(root, '.papercusp', hive, 'hyperbee'));
  let corestore: CorestoreCutSpec | null = null;
  let store: Corestore | undefined;
  if (wantCorestore) {
    if (!existsSync(storeDir)) {
      throw new Error(
        `[cut-seed] corestore dir not found: ${storeDir} — refusing to cut (opening it would CREATE an empty store ` +
          'and ship a silently-empty seed). Pass --store-dir <live hive store> or --no-corestore.',
      );
    }
    // WI-4487: the CUT itself only ever READS this store — cores are copied out by
    // pipeReplicate. Only the optional pre-cut refresh writes. So try writable first
    // (a quiesced box refreshes in-process exactly as before), and fall back to a
    // READ-ONLY open when the operator holds the store: `readOnly` skips the CORESTORE
    // device-file lock outright (hypercore-storage builds it only when
    // `!readOnly && !allowBackup`) and opens RocksDB read-only. That is what lets a box
    // running the operator cut a properly-seeded release with no quiesce and no outage
    // — previously every such cut either took an outage or fell back to
    // PAPERCUSP_SEED_CORESTORE=0 and shipped an installer that cold-clones on first boot.
    const openForCut = (pg?: postgres.Sql) =>
      openSourceStoreForCut({
        storeDir,
        workspaceId,
        hive,
        sparse,
        wantRefresh: args['skip-corestore-refresh'] !== true,
        forceBackfill: args['no-force-backfill'] !== true,
        ...(headSnapshotTimeoutMs === undefined ? {} : { headSnapshotTimeoutMs }),
        ...(pg ? { pg } : {}),
      });
    // The advisory lock must be acquired before the first Corestore open: a writable
    // open can succeed on a quiesced box while a second process is already force-
    // backfilling the same hive through PG. Keep the transaction alive through the
    // refresh/drain and final read-only or writable open, then release it before the
    // immutable seed snapshot is copied.
    const opened = workspaceId
      ? await withCutSeedSingleton({
          pg: getOrgPg().sql,
          workspaceId,
          hive,
          run: (pg) => openForCut(pg),
        })
      : await openForCut();
    store = opened.store;

    const own = await enumerateOwnStoreCoreKeys(store);
    const extra = (str(args, 'core-keys') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const coreKeys = [...new Set([...own, ...extra])];
    const sourceStoreDirs = await deriveSourceStoreDirs(storeDir);
    if (extra.length === 0) {
      console.warn(
        '[cut-seed] seeding the OWNER own-log only (' +
          `${coreKeys.length} core). Additional admitted MEMBER logs require the live admitted set ` +
          '(pass --core-keys or run inside a swarm session — see plan P-007). New members still cold-catch the rest.',
      );
    }
    corestore = {
      sourceStore: store!,
      ...(sourceStoreDirs.length > 0 ? { sourceStoreDirs } : {}),
      coreKeys,
      ...(sparse ? { sparse: true as const } : {}),
      // A public desktop seed is a release projection, not a byte-for-byte copy of the
      // owner's private author log. The provider mints a fresh read-only snapshot core,
      // redacts email-shaped values, and leaves the live source log untouched.
      filtered: true,
      redactValues: releaseRedactionValues,
      ...(uuidIdempotencyDropPlans ? { uuidIdempotencyDropPlans } : {}),
      onProgress: createFilteredSeedProgressReporter(),
    };
  }

  try {
    const publishedDir = outDir;
    const { res, finalManifest } = await withSeedOutput(publishedDir, async (outDir) => {
      const res = await cutHiveSeed({ potId: hive, cutAtEpoch, cutHlc, cutTs, outDir, git, corestore });

      // Copy on write where supported; never move or modify the reusable source.
      let finalManifest = res.manifest;
      if (reuseCorestoreDir && reused) {
        const dst = join(outDir, CORESTORE_SUBDIR);
        await cp(join(reuseCorestoreDir, CORESTORE_SUBDIR), dst, { recursive: true, mode: constants.COPYFILE_FICLONE });
        finalManifest = graftCorestoreEntry(res.manifest, reused.entry);
        await writeFile(res.manifestPath, encodeManifest(finalManifest));
        console.warn(
          `[cut-seed] reused corestore from ${reuseCorestoreDir} (${formatBytes(reused.entry.sizeBytes)}, no live-store snapshot).`,
        );
      }

      // P-015 (D-009 recurrence guard). Judge the FINAL manifest — the bytes on disk, after any
      // graft — never `res.manifest`, which on the reuse path carries no corestore at all and so
      // can never see the degradation (D-023: the reuse branch is the one that actually ships).
      // This single call therefore covers both branches by construction.
      assertSeedNotDegraded(finalManifest, { origin: reuseCorestoreDir ? 'reuse' : 'fresh' });

      // RocksDB's info log (exactly `LOG`, rotated `LOG.old.<ts>`) records the build
      // box's hostname and absolute paths on EVERY store open — it redded the 0.0.11
      // release identity gate (WI-4736 AppDir scan). Purely diagnostic and regenerated
      // on next open; the numbered `<NNN>.log` WALs are data and must stay.
      const seedDbDir = join(outDir, CORESTORE_SUBDIR, 'db');
      if (existsSync(seedDbDir)) {
        for (const f of await readdir(seedDbDir)) {
          if (f === 'LOG' || f.startsWith('LOG.old')) await rm(join(seedDbDir, f), { force: true });
        }
      }

      // WI-39447. Judge the manifest AGAINST THE BYTES — after the graft and after the LOG
      // sweep, i.e. exactly what the installer will hash. The two guards above judge the
      // manifest's claims about ITSELF (an honest sparse label, a sane size); neither can see a
      // manifest whose hash describes a payload that is not on disk. That is what the default
      // --reuse-corestore path produces: the grafted entry's hash/sizeBytes are inherited from
      // the PRIOR manifest and re-measured by nothing. The installer runs precisely this check
      // (restoreSeed → provider.verify) and, on a mismatch, SKIPS the store and restores an
      // empty hive without failing the install — so it has to be caught here or not at all.
      await assertSeedPayloadMatchesManifest({
        manifest: finalManifest,
        dir: outDir,
        origin: reuseCorestoreDir ? 'reuse' : 'fresh',
      });

      // EI-20108164746219771 step 4. Judge the STAGED BYTES for the build box's identity —
      // after the graft and after the LOG sweep, i.e. exactly what the installer will carry.
      // Mechanism-agnostic on purpose: the two known leaks (presence ROWS, RocksDB's
      // host.identity SST property) arrived by unrelated routes and each fix is blind to the
      // other, so this asks the bytes rather than trusting any one filter. See
      // ./seed-identity-guard.ts for why it does NOT shell out to audit-release-bundle.py.
      // EI-22086776666843792: ALSO hunt the release literal set the projection scrubbed with —
      // the same list audit-release-bundle.py will hunt at the build gate — so an owner handle /
      // name / email that survived the projection reds HERE, not 3h40m later at the build.
      await assertStagedSeedCarriesNoIdentity({
        dir: outDir,
        neutralHostname: process.env.PAPERCUSP_SEED_BUILD_HOSTNAME || DEFAULT_NEUTRAL_BUILD_HOSTNAME,
        extraLiterals: releaseRedactionValues,
      });

      // WI-3232 --emit-epoch-key: write the bundled key so the pot decrypts OFFLINE.
      if (emitEpochKey) {
        let key = epochKeyForEmit;
        if (!key) {
          if (!workspaceId && str(args, 'epoch') === undefined) {
            throw new Error('--emit-epoch-key needs an epoch context — pass --workspace-id (or --epoch).');
          }
          if (workspaceId) {
            await assertEpochSealIdentityPresent({ workspaceId, hive, allowMint: args['allow-mint-epoch-key'] === true });
          }
          key = Uint8Array.from(await (await resolveHiveEpochCrypto(true)).deriveEpochKey(hive, cutAtEpoch));
        }
        // WI-3297: bundle every keychain-present historical epoch key too — seed logs
        // carry ops sealed under past epochs, and a current-epoch-only file leaves them
        // permanently DROPped (epoch_decrypt_fail) on every fresh install.
        const epochKeys = await collectSeedEpochKeys({ hive, cutAtEpoch, currentKey: key });
        await writeFile(join(outDir, EPOCH_KEYS_FILE), encodeEpochKeysFile(hive, epochKeys));
        console.warn(
          `[cut-seed] ⚠ WI-3232: wrote ${EPOCH_KEYS_FILE} (hive '${hive}', epochs ${[...epochKeys.keys()]
            .sort((a, b) => a - b)
            .join(',')}) — the seed is now OFFLINE-DECRYPTABLE (owner-authorised for alpha; the pot ships READABLE).`,
        );
      }

      return { res, finalManifest };
    });
    const manifestPath = join(publishedDir, SEED_MANIFEST_FILE);

    if (asJson) {
      // `finalManifest`, not `res.manifest`: on the reuse path the latter has no corestore
      // entry, so `--json` used to report a manifest with no coreSparseFrom while the manifest
      // ON DISK carried the degraded one — a measurement of the reuse path read as "no sparse
      // data at all" rather than as the defect it is.
      console.log(JSON.stringify({ manifest: finalManifest, sizeReport: res.sizeReport, manifestPath }, null, 2));
    } else {
      console.log(`\n=== Hive seed cut → ${outDir} ===`);
      console.log(`hive=${hive} epoch=${cutAtEpoch} hlc=${cutHlc} ts=${cutTs}`);
      for (const s of res.sizeReport.stores) {
        console.log(`  • ${s.kind.padEnd(10)} ${formatBytes(s.sizeBytes).padStart(12)}  (${s.subdir}${s.encrypted ? ', encrypted' : ''})`);
      }
      console.log(`  • ${'manifest'.padEnd(10)} ${formatBytes(res.sizeReport.manifestBytes).padStart(12)}`);
      console.log(`  = ${'TOTAL'.padEnd(10)} ${formatBytes(res.sizeReport.totalBytes).padStart(12)}  ← installer growth`);
      console.log(`\nmanifest: ${manifestPath}\n`);
    }
  } finally {
    if (store) await store.close();
  }
}

if (isCliEntry(import.meta.url)) {
  main().catch((e) => {
    console.error('[cut-seed] FAILED:', e instanceof Error ? e.stack ?? e.message : e);
    process.exitCode = 1;
  });
}
