/**
 * seed-cutter — compose the git + corestore SeedProviders into ONE canonical
 * hive seed (plan hive-seed-bundle-2026-07-04 P-006; design memo
 * agent-insights/hive-seed-bundle-design).
 *
 * `cutHiveSeed` drives {@link createGitSeedProvider} (the CODE — the dogfood
 * superproject + submodules, as `git bundle`s) and
 * {@link createCorestoreSeedProvider} (the FEDERATED hive state — admitted
 * author logs) over a source repo + a source corestore, writes each store's
 * payload under a subdir of the seed dir, and emits a single combined
 * {@link SeedManifest} + a SIZE REPORT. The manifest travels WITH the seed dir,
 * so each store entry's `source.path` is rewritten to a subdir name RELATIVE to
 * the seed root — the restore side (P-007) resolves payloads against wherever the
 * installer unpacks the seed, never an absolute build-machine path.
 *
 * This is the build/release-time half; the CLI wrapper that resolves the real
 * dogfood inputs lives at apps/operator/lib/release/cut-seed-cli.ts.
 */

import Corestore from 'corestore';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  SEED_FORMAT_VERSION,
  encodeManifest,
  type SeedManifest,
  type SeedStoreEntry,
  type SeedKeyRef,
} from '@papercusp/seed-bundle';
import { createGitSeedProvider } from './seed-provider-git';
import { createCorestoreSeedProvider, isRocksInfoLog, type CorestoreCutContext } from './seed-provider-corestore';
import { openOwnLog } from './peer-log';

/** The seed root subdir each store's payload is written under (and recorded as
 *  the store entry's relative `source.path`). */
export const GIT_SUBDIR = 'git';
export const CORESTORE_SUBDIR = 'corestore';
export const SEED_MANIFEST_FILE = 'manifest.json';

/** The git half of a cut (omit to seed hive state only). */
export interface GitCutSpec {
  /** The source working tree to bundle (the owner's checkout). */
  readonly sourceRepoDir: string;
  /** The canonical origin a restored clone re-points at (the GitHub repo). */
  readonly originUrl: string;
  /** `git bundle create` rev selector; default `--all` (every ref). Pass `HEAD`
   *  to bundle only the current branch's history. Pair `rev: 'HEAD'` with
   *  `depth: 1` for the shippable tiny seed: an offline-cloneable synthetic
   *  one-commit snapshot of the current tree, then normal fetch back-fills
   *  history from origin after first boot. */
  readonly rev?: string;
  /** `1` cuts a synthetic one-commit snapshot. Other depths are refused by the
   *  git provider because native shallow/prerequisite bundles cannot be cloned
   *  offline. */
  readonly depth?: number;
  /** Encrypt the bundles at rest (REQUIRED for the private dogfood repo). The
   *  key is delivered to the joiner post-admission via `keyRef` — never shipped. */
  readonly encryption?: { readonly key: Uint8Array; readonly keyRef: SeedKeyRef };
}

/** The corestore (federated hive state) half of a cut (omit to seed code only). */
export interface CorestoreCutSpec {
  /** The live/quiescent source store to cut from (the owner's store). */
  readonly sourceStore: Corestore;
  /**
   * Optional sibling Corestore directories for cross-process host resolution.
   * The release CLI derives these from the source store's `.papercusp` root.
   */
  readonly sourceStoreDirs?: readonly string[];
  /** Hex keys of the admitted author logs to seed (read-only, no secrets). */
  readonly coreKeys: readonly string[];
  /**
   * seed-history-trim-public-builds-2026-07-07 P-004 — ship each core's
   * current-state SUFFIX only (`[latest-snapshot-index, length)`), dropping the
   * summarized-and-superseded history prefix (the ~2GB of churn) from the public
   * build. Projection-equivalent (P-002); REQUIRES the snapshot reader ON in the
   * shipped build (SUBSTRATE_LOG_SNAPSHOT — P-005). The caller SHOULD append a
   * fresh head snapshot (produceLogSnapshot, P-003) after any large pre-cut drain
   * so the last snapshot stays inside the reader's scan window. Omit ⇒ full ship
   * (byte-identical to pre-P-004). See {@link CorestoreCutContext.sparse}.
   */
  readonly sparse?: boolean;
  /**
   * Release-only privacy projection. When true, cut a fresh filtered snapshot core
   * instead of copying the private author-log bytes into the public seed.
   */
  readonly filtered?: boolean;
  /** Identity literals emitted by the desktop release audit for the projection scrub. */
  readonly redactValues?: readonly string[];
  /** Optional bounded source-scan progress sink for filtered release cuts. */
  readonly onProgress?: CorestoreCutContext['onProgress'];
  /** Optional cursor-stall sink for filtered release cuts. */
  readonly onStall?: CorestoreCutContext['onStall'];
  /** Optional test/release override for the filtered-scan stall diagnostic. */
  readonly filteredScanStallMs?: CorestoreCutContext['filteredScanStallMs'];
  /**
   * Optional sink for the per-cut projection report. Omitted ⇒ the provider's
   * default `console.warn` line. The seam exists on the provider but was not
   * reachable from here, so every caller going through `cutHiveSeed` — the real
   * entrypoint — was pinned to that default with no way to redirect the report.
   */
  readonly onProjection?: CorestoreCutContext['onProjection'];
}

export interface HiveSeedCutInputs {
  /** Which hive this seed reconstitutes (manifest.potId). */
  readonly potId: string;
  /** Hive epoch at cut time (a member decrypts seeded content iff it holds this
   *  epoch's key — guaranteed for new members by grantEpochKeysToMembers). */
  readonly cutAtEpoch: number;
  /** HLC stamp of the cut — the ordering anchor. */
  readonly cutHlc: string;
  /** Wall-clock ms of the cut — provenance only. */
  readonly cutTs: number;
  /** Directory the seed is written into (created if absent). */
  readonly outDir: string;
  /** The code half (null ⇒ skip — hive-state-only seed). */
  readonly git: GitCutSpec | null;
  /** The federated-state half (null ⇒ skip — code-only seed). */
  readonly corestore: CorestoreCutSpec | null;
}

export interface SeedStoreSize {
  readonly kind: string;
  readonly subdir: string;
  readonly sizeBytes: number;
  readonly encrypted: boolean;
}

export interface SeedSizeReport {
  readonly stores: readonly SeedStoreSize[];
  readonly manifestBytes: number;
  /** Sum of every store payload + the manifest — the on-disk seed footprint,
   *  i.e. how much the installer grows. */
  readonly totalBytes: number;
}

export interface HiveSeedCutResult {
  readonly manifest: SeedManifest;
  readonly manifestPath: string;
  readonly outDir: string;
  readonly sizeReport: SeedSizeReport;
}

async function walkFiles(root: string, dir: string = root, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, full, acc);
    // Skip the corestore RocksDB info LOG for the SAME reason the corestore
    // provider's own walk does (isRocksInfoLog): it is rewritten on every store
    // open (non-deterministic), hash-excluded (EI-12881), AND scrubbed from the
    // shipped seed (WI-4736). The per-store `sizeBytes` already excludes it, so
    // measureSeedDir must too — otherwise the recount over-counts the seed's
    // shipped footprint by the LOG's bytes and diverges from sizeReport.totalBytes.
    else if (e.isFile() && !isRocksInfoLog(e.name)) acc.push(relative(root, full));
  }
  return acc;
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  for (const rel of await walkFiles(root)) total += (await stat(join(root, rel))).size;
  return total;
}

/**
 * The minimal-correct corestore seed source: the owner's OWN author log key.
 * Always present, always admitted, and carries the bulk of the dogfood hive
 * state authored locally (plans, work-items, features, issues, coordination).
 * Additional admitted MEMBER log keys are supplied on top by the caller (the
 * live admitted set is only fully known to a running swarm session — see P-007).
 */
export async function enumerateOwnStoreCoreKeys(store: Corestore): Promise<string[]> {
  const own = await openOwnLog(store);
  return [own.keyHex];
}

/** Human-readable one-liner for a size in bytes → MiB (build-log friendly). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${mib.toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * Cut a combined hive seed (code + federated state) into `outDir` and return the
 * manifest + a size report. Idempotent-ish: writes into fresh subdirs; call with
 * a clean `outDir`.
 */
export async function cutHiveSeed(inputs: HiveSeedCutInputs): Promise<HiveSeedCutResult> {
  const { potId, cutAtEpoch, cutHlc, cutTs, outDir, git, corestore } = inputs;
  if (!git && !corestore) throw new Error('cutHiveSeed: at least one of { git, corestore } must be provided');
  await mkdir(outDir, { recursive: true });

  const stores: SeedStoreEntry[] = [];
  const sizes: SeedStoreSize[] = [];

  if (git) {
    const provider = createGitSeedProvider();
    const stagingDir = join(outDir, GIT_SUBDIR);
    const { entry } = await provider.cut({
      sourceRepoDir: git.sourceRepoDir,
      stagingDir,
      originUrl: git.originUrl,
      ...(git.rev ? { rev: git.rev } : {}),
      ...(git.depth !== undefined ? { depth: git.depth } : {}),
      ...(git.encryption ? { encryption: git.encryption } : {}),
    });
    // Portable manifest: record the RELATIVE subdir, not the build-machine path.
    stores.push({ ...entry, source: { type: 'resource', path: GIT_SUBDIR } });
    sizes.push({ kind: entry.kind, subdir: GIT_SUBDIR, sizeBytes: entry.sizeBytes, encrypted: Boolean(entry.encryption) });
  }

  if (corestore) {
    const provider = createCorestoreSeedProvider();
    const stagingDir = join(outDir, CORESTORE_SUBDIR);
    const { entry } = await provider.cut({
      sourceStore: corestore.sourceStore,
      ...(corestore.sourceStoreDirs ? { sourceStoreDirs: corestore.sourceStoreDirs } : {}),
      coreKeys: corestore.coreKeys,
      stagingDir,
      ...(corestore.sparse ? { sparse: true } : {}),
      ...(corestore.filtered ? { filtered: true } : {}),
      ...(corestore.redactValues ? { redactValues: corestore.redactValues } : {}),
      ...(corestore.onProgress ? { onProgress: corestore.onProgress } : {}),
      ...(corestore.onStall ? { onStall: corestore.onStall } : {}),
      ...(corestore.filteredScanStallMs !== undefined ? { filteredScanStallMs: corestore.filteredScanStallMs } : {}),
      ...(corestore.onProjection ? { onProjection: corestore.onProjection } : {}),
    });
    stores.push({ ...entry, source: { type: 'resource', path: CORESTORE_SUBDIR } });
    sizes.push({ kind: entry.kind, subdir: CORESTORE_SUBDIR, sizeBytes: entry.sizeBytes, encrypted: false });
  }

  const manifest: SeedManifest = {
    seedFormatVersion: SEED_FORMAT_VERSION,
    potId,
    cutAtEpoch,
    cutHlc,
    cutTs,
    stores,
  };
  const manifestJson = encodeManifest(manifest); // validates; throws on a bad shape
  const manifestPath = join(outDir, SEED_MANIFEST_FILE);
  await writeFile(manifestPath, manifestJson);
  const manifestBytes = (await stat(manifestPath)).size;

  const totalBytes = sizes.reduce((n, s) => n + s.sizeBytes, 0) + manifestBytes;
  return { manifest, manifestPath, outDir, sizeReport: { stores: sizes, manifestBytes, totalBytes } };
}

/**
 * A one-shot deterministic recount of a seed dir's on-disk size (independent of
 * the per-store `sizeBytes` in the manifest) — used by the CLI's build-log
 * report and the E2E installer-growth measurement (P-010).
 */
export async function measureSeedDir(outDir: string): Promise<number> {
  return dirSize(outDir);
}
