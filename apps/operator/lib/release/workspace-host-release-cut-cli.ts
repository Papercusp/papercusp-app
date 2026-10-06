/**
 * Cut one workspace-host release as a MANAGED operation: build, sign, evidence and publish on ONE
 * release task, journaled stage by stage (D-394, WI-10002539).
 *
 * WHY THIS EXISTS. Every workspace-host bundle through r37 was assembled by hand — a pinned
 * checkout, a sidecar build with a hand-typed environment, then an untracked
 * `package-sign-evidence.sh` — and handed to the publisher, which journaled only its own upload.
 * Nothing ever recorded a `release.build.*` receipt, and `projectByocReleaseMilestones` advances
 * only across a contiguous verified prefix whose FIRST milestone is the build. So no
 * workspace-host release could ever read as shipped, however much later evidence it collected —
 * and a build receipt cannot be written after the fact, because the build is the one stage whose
 * evidence IS the act of producing the bytes.
 *
 * THE OPERATION, all on one task + operation id:
 *   open      Seed `task_ledger.detail.release` with a LABEL identity (source, gitlinks, version,
 *             channel, platform). The digest does not exist yet; release-stage-receipt.ts binds
 *             every later stage by reading it back off the committed build receipt.
 *   build     `release.build.workspace-host-linux-x86_64`: pinned source checkout -> vm-release
 *             sidecar build -> deterministic pack -> sign + independent minisign verify ->
 *             SBOM/vulnerability verdict over the EXTRACTED bytes -> identity/secret audit.
 *             Committed with `bundle:sha256:<d>` only when every leg passed.
 *   manifest  `runPublicationManifestCli`, exactly once per operation: a regenerated manifest
 *             carries a new timestamp, which the publisher reads as a changed stage input.
 *   publish   The journaled publisher, handed the SAME task + operation.
 *   prune     After a real (not --publish-plan-only) publish, the rebuildable intermediates — the pinned
 *             source worktree, the sidecar tree and the extracted audit copy, ~89% of a ~18 GB work
 *             dir — are removed (WI-10003700). Everything resume, R-4 and audit read stays:
 *             publication/, build-result.json, release-cut.json, logs/, sidecar-trust/, the tauri
 *             sig. `--keep-intermediates` opts out.
 *
 * RESUME is re-running the same command. The operation's ids are persisted in the work directory
 * and every stage reads the journal before acting. A build interrupted mid-way is reconciled from
 * `build-result.json`, which is written only after every leg passed: present and matching the
 * bytes on disk means commit; absent means nothing was produced and the stage may run again.
 *
 * Run it with the operator's database environment, e.g.
 *   cd apps/operator && set -a && . ./.env.local && set +a && \
 *     npx tsx lib/release/workspace-host-release-cut-cli.ts \
 *       --source-sha <40-hex> --version 0.0.21-p318r40 --work-dir ~/.papercusp/wh-release-r40
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleRepoRoot } from '@papercusp/operator-core/lib/module-repo-root';

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import {
  appendTaskReleaseReceipt,
  getTask,
  registerTask,
  taskReleaseJournalFromDetail,
  TASK_RELEASE_JOURNAL_SCHEMA_VERSION,
} from '@papercusp/operator-core/lib/task-manager/store';
import type { TaskSpec } from '@papercusp/operator-core/lib/task-manager/types';
import { newTaskId } from '@papercusp/operator-core/lib/task-manager/types';
import {
  WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME,
  WORKSPACE_HOST_PUBLISHED_MANIFEST_NAME,
  WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME,
} from '@papercusp/operator-core/lib/workspace-host/publication-manifest';
import { WORKSPACE_HOST_RELEASE_CHANNEL } from '@papercusp/operator-core/lib/workspace-host/release-stage-receipt';
import {
  latestGreenShippedReleaseInScope,
  type GreenShippedRelease,
} from '@papercusp/operator-core/lib/workspace-host/release-shipment-green-receipt';

import {
  beginReleaseTaskStage,
  readSourceGitlinks,
  settleReleaseTaskStage,
  type BegunReleaseTaskStage,
  type ReleaseTaskLedger,
  type ReleaseTaskStageContext,
  type ReleaseTaskStageInput,
} from '../../../../scripts/lib/release-task-journal.mjs';
import {
  WORKSPACE_HOST_EVIDENCE_FILES,
  WORKSPACE_HOST_PUBLISHED_SIGNING_KEY_NAME,
  parsePublicationManifestCliInput,
  runPublicationManifestCli,
  type PublicationManifestCliInput,
} from './workspace-host-publication-manifest-cli';

/** The artifact-identity discriminator for a managed workspace-host cut (sibling of the desktop's). */
export const WORKSPACE_HOST_RELEASE_ARTIFACT_KIND = 'papercusp-workspace-host-release';
export const WORKSPACE_HOST_RELEASE_PLATFORM = 'linux-x86_64';
/** `launched_by` on every cut's ledger row — the discovery key, distinct from the desktop cut's. */
export const WORKSPACE_HOST_RELEASE_CUT_LAUNCHED_BY = 'release:workspace-host-cut';
export const WORKSPACE_HOST_BUILD_STAGE = `release.build.workspace-host-${WORKSPACE_HOST_RELEASE_PLATFORM}`;

/**
 * How server.tgz is packed. Part of the build stage's identity, because a different pack is a
 * different set of bytes. The r37 tar was ordered by directory walk and stamped with each file's
 * build-time mtime, so re-packing the same tree never reproduced its digest.
 */
export const WORKSPACE_HOST_PACK_SPEC = {
  format: 'gnu',
  order: 'name',
  owner: '0:0 numeric',
  mtime: 'source-commit-time',
  compression: 'gzip -n',
} as const;

/** Pinned like every other signing call site (papercusp-desktop/bin/lib/inno-spanned-server.sh). */
const DEFAULT_TAURI_CLI_VERSION = '2.11.0';
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BUNDLE_REF = /^bundle:sha256:([0-9a-f]{64})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

// ─── Identity + journal ─────────────────────────────────────────────────────────

export interface WorkspaceHostReleaseIdentity {
  /** Exact superproject commit the cut packages. */
  sourceSha: string;
  /** Submodule pins at that commit — two cuts of one sha with different pins are different builds. */
  gitlinks: Readonly<Record<string, string>>;
  /** The image version the manifest publishes, e.g. `0.0.21-p318r40`. */
  version: string;
}

/**
 * PURE. The `detail.release` seed. A LABEL identity, not a digest: the publisher accepts a journal
 * whose `artifactIdentity.sourceSha`/`version` equal the manifest's, and release-stage-receipt.ts
 * resolves the digest from the committed build receipt.
 */
export function buildWorkspaceHostReleaseJournalSeed(operationId: string, identity: WorkspaceHostReleaseIdentity) {
  return {
    schemaVersion: TASK_RELEASE_JOURNAL_SCHEMA_VERSION,
    operationId,
    source: { sha: identity.sourceSha, gitlinks: sortedRecord(identity.gitlinks) },
    artifactIdentity: {
      kind: WORKSPACE_HOST_RELEASE_ARTIFACT_KIND,
      channel: WORKSPACE_HOST_RELEASE_CHANNEL,
      platform: WORKSPACE_HOST_RELEASE_PLATFORM,
      sourceSha: identity.sourceSha,
      version: identity.version,
    },
    credential: { generation: null, expiresAt: null },
    cursor: 0,
    currentStage: null,
    currentState: null,
    spentOperationIds: [] as string[],
    receipts: [] as never[],
  };
}

/** The journal context every stage of this operation writes through. Same shape the downstream
 *  recorders build for a label-identified journal, so both hash the identical release preimage. */
export function workspaceHostCutStageContext(
  taskId: string,
  operationId: string,
  identity: WorkspaceHostReleaseIdentity,
  ledger: ReleaseTaskLedger,
): ReleaseTaskStageContext {
  return {
    taskId,
    operationId,
    ledger,
    identity: {
      sourceSha: identity.sourceSha,
      gitlinks: sortedRecord(identity.gitlinks),
      version: identity.version,
      channel: WORKSPACE_HOST_RELEASE_CHANNEL,
    },
  };
}

/** The build stage's own inputs. The source, gitlinks and version are already in the preimage. */
export function workspaceHostBuildStageInput(desktopVersion: string): ReleaseTaskStageInput {
  return {
    stage: WORKSPACE_HOST_BUILD_STAGE,
    sourceScope: 'complete',
    identity: {
      builder: 'papercusp-desktop/bin/build-desktop-sidecar.sh',
      distributionProfile: 'vm-release',
      targetOs: 'linux',
      targetArch: 'x64',
      desktopVersion,
      pack: WORKSPACE_HOST_PACK_SPEC,
    },
  };
}

// ─── Build result ───────────────────────────────────────────────────────────────

/** Written only after every build leg passed; the reconcile path's proof that a build finished. */
export interface WorkspaceHostBuildResult {
  schemaVersion: 1;
  operationId: string;
  requestIdentity: string;
  sourceSha: string;
  version: string;
  desktopVersion: string;
  sourceEpochSeconds: number;
  bundle: { sha256: string; bytes: number };
  signature: { sha256: string; bytes: number };
  signingKeySha256: string;
  evidence: { sbomSha256: string; vulnerabilitiesSha256: string; summarySha256: string; secretScanSha256: string };
}

/** PURE. The committed build receipt's evidence. `bundle:sha256:<d>` is the ref every later stage
 *  binds to; the rest let an auditor match the receipt to the files beside the bundle. */
export function workspaceHostBuildEvidenceRefs(result: WorkspaceHostBuildResult): string[] {
  return [
    `bundle:sha256:${result.bundle.sha256}`,
    `artifact:sha256:${result.signature.sha256}:${result.signature.bytes}`,
    `signing-key:sha256:${result.signingKeySha256}`,
    `evidence:sbom:sha256:${result.evidence.sbomSha256}`,
    `evidence:vulnerabilities:sha256:${result.evidence.vulnerabilitiesSha256}`,
    `evidence:vulnerability-summary:sha256:${result.evidence.summarySha256}`,
    `evidence:secret-scan:sha256:${result.evidence.secretScanSha256}`,
    `build-request:${result.requestIdentity}`,
  ];
}

export function parseWorkspaceHostBuildResult(value: unknown): WorkspaceHostBuildResult {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('build-result.json is not a schemaVersion 1 build result');
  const digests = [
    (value.bundle as Record<string, unknown> | undefined)?.sha256,
    (value.signature as Record<string, unknown> | undefined)?.sha256,
    value.signingKeySha256,
    ...Object.values(isRecord(value.evidence) ? value.evidence : {}),
  ];
  if (digests.length !== 7 || !digests.every((digest) => typeof digest === 'string' && SHA256.test(digest))) {
    throw new Error('build-result.json records a missing or malformed digest');
  }
  for (const key of ['operationId', 'requestIdentity', 'sourceSha', 'version', 'desktopVersion'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) throw new Error(`build-result.json has no ${key}`);
  }
  return value as unknown as WorkspaceHostBuildResult;
}

// ─── Publication input ──────────────────────────────────────────────────────────

export interface WorkspaceHostPublicationFacts {
  version: string;
  sourceSha: string;
  desktopVersion: string;
  /** The papercusp-desktop gitlink — recorded as the `desktop_revision` build parameter. */
  desktopRevision: string;
  sourceRoot: string;
  bundleRoot: string;
  /**
   * Version of the last GREEN-SHIPPED release in this cut's scope, or null when nothing has shipped
   * green yet (D-437). Required, not optional: omitting the rollback edge is what left every r5x/r60
   * manifest unshippable, so each caller must decide it explicitly.
   */
  rollbackVersion: string | null;
}

/**
 * PURE. Turn the tracked template into the manifest CLI's input. The template carries only what is
 * the same for every cut; the per-cut values are filled from measured facts, and each material's
 * `from` becomes the absolute path its bytes are read from. The result is validated by the manifest
 * CLI's own parser, so the template cannot drift into a shape the manifest CLI would refuse later.
 */
export function buildWorkspaceHostPublicationInput(
  template: unknown,
  facts: WorkspaceHostPublicationFacts,
): PublicationManifestCliInput {
  if (!isRecord(template) || template.schemaVersion !== 1) {
    throw new Error('publication input template must be a schemaVersion 1 object');
  }
  const { schemaVersion: _schema, image, source, builder, materials, parameters, ...rest } = template;
  if (!isRecord(image) || !isRecord(source) || !isRecord(builder)) {
    throw new Error('publication input template needs image, source and builder objects');
  }
  if (!Array.isArray(materials) || !Array.isArray(parameters)) {
    throw new Error('publication input template needs materials and parameters arrays');
  }
  const resolvedMaterials = materials.map((material, index) => {
    if (!isRecord(material) || typeof material.path !== 'string') {
      throw new Error(`template materials[${index}] must name a path`);
    }
    const { from, ...spec } = material;
    const root = from === 'source' ? facts.sourceRoot : from === 'bundle' ? facts.bundleRoot : null;
    if (!root) throw new Error(`template materials[${index}] ('${material.path}') must be from 'source' or 'bundle'`);
    return { ...spec, sourcePath: join(root, material.path) };
  });
  if (parameters.some((parameter) => isRecord(parameter) && parameter.name === 'desktop_revision')) {
    throw new Error('template must not pin desktop_revision: it is measured from the source gitlinks');
  }
  if (isRecord(rest.lifecycle) && rest.lifecycle.rollbackTarget !== undefined) {
    throw new Error('template must not pin lifecycle.rollbackTarget: it is the last green-shipped release, resolved at cut time');
  }
  let lifecycle: Record<string, unknown> | undefined = isRecord(rest.lifecycle) ? { ...rest.lifecycle } : undefined;
  if (facts.rollbackVersion !== null) {
    if (typeof image.id !== 'string' || !image.id) throw new Error('publication input template image needs an id');
    if (facts.rollbackVersion === facts.version) {
      throw new Error(`rollback target ${facts.rollbackVersion} is the release being cut; a release cannot roll back to itself`);
    }
    // Every cut shares this template, so the green-shipped release published under the same image id.
    lifecycle = { ...lifecycle, rollbackTarget: { id: image.id, version: facts.rollbackVersion } };
  }
  return parsePublicationManifestCliInput({
    ...rest,
    ...(lifecycle ? { lifecycle } : {}),
    image: { ...image, version: facts.version },
    source: { ...source, revision: facts.sourceSha },
    builder: { ...builder, version: facts.desktopVersion },
    materials: resolvedMaterials,
    parameters: [...parameters, { name: 'desktop_revision', value: facts.desktopRevision }],
  });
}

// ─── Processes ──────────────────────────────────────────────────────────────────

/**
 * A build leg that did not pass. `gating` separates a VERDICT (the bytes were measured and refused:
 * audit findings, a High/Critical match) from a leg that could not run. Only the latter may be
 * retried with the same input — re-running a refusal just re-measures the same bytes.
 */
export class WorkspaceHostCutStepError extends Error {
  constructor(
    readonly step: string,
    readonly gating: boolean,
    detail: string,
  ) {
    super(`${step}: ${detail}`);
    this.name = 'WorkspaceHostCutStepError';
  }
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Receives stdout and stderr. Absent inherits both. */
  logFile?: string;
  /** Receives stdout only (stderr goes to `logFile` or is inherited). */
  stdoutFile?: string;
  /** Exit codes that are a refusal of the bytes rather than a failure to measure them. */
  gatingExitCodes?: readonly number[];
}

/**
 * Exit status papercusp-desktop/bin/lib/disk-preflight.sh returns when it refuses a build for lack of
 * free space (ENOSPC's errno). build-desktop-sidecar.sh preserves it with `|| exit $?`.
 */
export const DISK_PREFLIGHT_REFUSAL_EXIT_CODE = 28;

/**
 * The failure line for a step that exited non-zero. A bare "bash exited 28" was read on 2026-09-26
 * (EI-24283123732250788) as an opaque failure, and 28 is also curl's timeout code; name the disk
 * shortage so the operator frees space and resumes instead of hunting a network fault.
 */
export function describeStepExit(command: string, code: number | null, logFile?: string): string {
  const where = logFile ? ` (log: ${logFile})` : '';
  const base = `${command} exited ${code ?? 'by signal'}${where}`;
  if (code !== DISK_PREFLIGHT_REFUSAL_EXIT_CODE) return base;
  return (
    `${base}: the build's disk preflight refused for lack of free space on the work directory's filesystem ` +
    '(the log names the GB needed and any space reserved by other builds). ' +
    'Free space there, then rerun the same command with the same --work-dir to resume this operation'
  );
}

async function runStep(step: string, command: string, args: readonly string[], options: RunOptions = {}): Promise<void> {
  const log = options.logFile ? await open(options.logFile, 'a') : null;
  const out = options.stdoutFile ? await open(options.stdoutFile, 'w') : null;
  try {
    const code = await new Promise<number | null>((resolvePromise, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', out?.fd ?? log?.fd ?? 'inherit', log?.fd ?? 'inherit'],
      });
      child.once('error', reject);
      child.once('close', (exitCode) => resolvePromise(exitCode));
    });
    if (code !== 0) {
      const gating = code !== null && (options.gatingExitCodes ?? []).includes(code);
      throw new WorkspaceHostCutStepError(step, gating, describeStepExit(command, code, options.logFile));
    }
  } finally {
    await out?.close();
    await log?.close();
  }
}

/**
 * The deterministic pack. Every property that differs between two packs of the same tree is pinned:
 * member order (directory walk -> name), timestamps (build time -> the source commit's), ownership
 * (the building user -> 0:0, which also keeps the build box's identity out of every tar header), and
 * the gzip header's own name and mtime (`-n`). Mode bits are the tree's own and are kept.
 */
export function deterministicPackTarArgs(sidecarDir: string, sourceEpochSeconds: number): string[] {
  if (!Number.isSafeInteger(sourceEpochSeconds) || sourceEpochSeconds <= 0) {
    throw new Error(`source commit time must be a positive epoch, got ${sourceEpochSeconds}`);
  }
  return [
    '--create',
    '--format=gnu',
    '--sort=name',
    `--mtime=@${sourceEpochSeconds}`,
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--directory',
    sidecarDir,
    '.',
  ];
}

export async function packDeterministically(sidecarDir: string, sourceEpochSeconds: number, outPath: string): Promise<void> {
  const partial = `${outPath}.partial`;
  await rm(partial, { force: true });
  await runStep(
    'pack',
    'bash',
    ['-c', 'set -o pipefail; tar "$@" | gzip -n', 'pack', ...deterministicPackTarArgs(sidecarDir, sourceEpochSeconds)],
    { stdoutFile: partial },
  );
  await rename(partial, outPath);
}

export async function sha256OfFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { sha256: hash.digest('hex'), bytes: (await stat(path)).size };
}

// ─── The build ──────────────────────────────────────────────────────────────────

export interface WorkspaceHostBuildPlan {
  repoRoot: string;
  workDir: string;
  identity: WorkspaceHostReleaseIdentity;
  desktopVersion: string;
  sourceEpochSeconds: number;
  operationId: string;
  requestIdentity: string;
  /** Sourced (`set -a`) around every leg that audits identity, exactly as the hand recipe did. */
  releaseIdentityEnvFile: string;
  signingKeyPath: string;
  signingKeyPassword: string;
  tauriCliVersion: string;
}

export function workspaceHostCutPaths(workDir: string) {
  return {
    state: join(workDir, 'release-cut.json'),
    lock: join(workDir, 'release-cut.lock'),
    source: join(workDir, 'source'),
    sourceReady: join(workDir, 'source.ready.json'),
    sidecar: join(workDir, 'sidecar'),
    sidecarReady: join(workDir, 'sidecar.ready.json'),
    sidecarTrust: join(workDir, 'sidecar-trust'),
    publication: join(workDir, 'publication'),
    extracted: join(workDir, 'extracted'),
    logs: join(workDir, 'logs'),
    tauriSignature: join(workDir, 'server.tgz.tauri.sig'),
    buildResult: join(workDir, 'build-result.json'),
    publicationInput: join(workDir, 'publication-input.json'),
  };
}

/** Run a command with the release identity literals exported, the way the audits expect them. */
function withReleaseIdentity(envFile: string, command: string, args: readonly string[]): [string, string[]] {
  return ['bash', ['-c', 'set -a; . "$0"; set +a; exec "$@"', envFile, command, ...args]];
}

async function readJsonIfPresent(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Directory inside the sidecar (the bundle root) that carries the doc vector seed. The hosted
 *  unit points PAPERCUSP_DOC_VECTOR_SEED_DIR at `$RUNTIME_ROOT/current/<this>`. */
export const WORKSPACE_HOST_DOC_VECTOR_SEED_DIR = 'doc-vector-seed';

export type DocVectorSeedCutOutcome = 'skipped' | 'exported' | 'kept-previous' | 'none';

export interface DocVectorSeedCutOptions {
  sidecarDir: string;
  /** Integration checkout: it has node_modules and resolves the build database. */
  repoRoot: string;
  logFile: string;
  skip?: boolean;
  /** Runs the exporter; defaults to `npx <args>` in `cwd`. Injected by tests. */
  exporter?: (args: readonly string[], options: { cwd: string; logFile: string }) => Promise<void>;
  warn?: (message: string) => void;
}

/**
 * Write precomputed doc_sections vectors into the sidecar before it is packed (WI-10004899).
 * Mirrors the desktop cut's `cut_doc_vector_seed` (papercusp-desktop/bin/release-local.sh): the
 * previous seed, if one is already in the sidecar, is applied first so only changed sections are
 * re-embedded; a failed export never fails the cut, because a bundle without the seed still works
 * (the host embeds the uncovered sections itself, as before). The new seed replaces the old one only
 * once the exporter has written a manifest, so a failed export leaves the previous seed in place.
 */
export async function cutDocVectorSeed(options: DocVectorSeedCutOptions): Promise<DocVectorSeedCutOutcome> {
  if (options.skip) return 'skipped';
  const out = join(options.sidecarDir, WORKSPACE_HOST_DOC_VECTOR_SEED_DIR);
  const tmp = `${out}.new`;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const exporter =
    options.exporter ??
    ((args: readonly string[], runOptions: { cwd: string; logFile: string }) =>
      runStep('doc-vector-seed', 'npx', args, runOptions));
  const hasPrevious = existsSync(join(out, 'manifest.json'));
  await rm(tmp, { recursive: true, force: true });
  try {
    await exporter(
      [
        'tsx', 'scripts/export-doc-vector-seed.mts',
        '--out', tmp,
        '--allow-uncovered',
        ...(hasPrevious ? ['--previous', out] : []),
      ],
      { cwd: options.repoRoot, logFile: options.logFile },
    );
    if (!existsSync(join(tmp, 'manifest.json'))) {
      throw new Error(`the exporter exited 0 but wrote no manifest.json into ${tmp}`);
    }
    await rm(out, { recursive: true, force: true });
    await rename(tmp, out);
    return 'exported';
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    const ships = hasPrevious ? "the previous cut's doc-vector seed" : 'no precomputed doc vectors';
    warn(
      `WARNING: doc-vector-seed export failed (${err instanceof Error ? err.message : String(err)}) — ` +
        `the bundle ships ${ships}; fresh hosts embed the rest on first boot.`,
    );
    return hasPrevious ? 'kept-previous' : 'none';
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.partial`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(`${path}.partial`, path);
}

/**
 * Materialize, build, pack, sign, verify and audit one bundle. Each leg either passes or throws a
 * `WorkspaceHostCutStepError`; `build-result.json` is written last, so its presence means all passed.
 */
export async function buildWorkspaceHostBundle(plan: WorkspaceHostBuildPlan): Promise<WorkspaceHostBuildResult> {
  const paths = workspaceHostCutPaths(plan.workDir);
  const { sourceSha } = plan.identity;
  await mkdir(paths.logs, { recursive: true });
  const logFor = (step: string) => join(paths.logs, `${step}.log`);

  // 1. Pinned source. setup-release's source-only mode stops before any dependency work and
  //    guarantees exact HEAD + submodule pins; the ready marker is what makes a re-run skip it.
  const sourceReady = await readJsonIfPresent(paths.sourceReady);
  if (!(isRecord(sourceReady) && sourceReady.sourceSha === sourceSha)) {
    if (existsSync(paths.source)) {
      throw new WorkspaceHostCutStepError(
        'materialize',
        false,
        `${paths.source} exists without a ready marker for ${sourceSha}; remove it with ` +
          `'git -C ${plan.repoRoot} worktree remove --force ${paths.source}' and re-run`,
      );
    }
    await runStep(
      'materialize',
      'bash',
      [
        join(plan.repoRoot, 'apps/operator/bin/release/setup-release-checkout.sh'),
        '--ref', sourceSha,
        '--integration', plan.repoRoot,
        '--release', paths.source,
        '--source-only',
        '--source-integrity', 'object-sourced',
      ],
      { cwd: plan.repoRoot, logFile: logFor('materialize') },
    );
    const head = execFileSync('git', ['-C', paths.source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== sourceSha) throw new WorkspaceHostCutStepError('materialize', false, `checkout HEAD ${head} is not ${sourceSha}`);
    await writeJsonAtomic(paths.sourceReady, { sourceSha, readyAt: new Date().toISOString() });
  }

  // 2. The vm-release sidecar, built from the pinned tree. The environment is the one the r37 cut
  //    ran with (recorded in tool_invocations 2026-09-20 02:04Z); it is now code instead of a paste.
  const sidecarReady = await readJsonIfPresent(paths.sidecarReady);
  if (!(isRecord(sidecarReady) && sidecarReady.sourceSha === sourceSha && sidecarReady.desktopVersion === plan.desktopVersion)) {
    await rm(paths.sidecarTrust, { recursive: true, force: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REPO_ROOT: paths.source,
      PAPERCUSP_ROOT: join(paths.source, 'libs/papercusp'),
      PAPERCUSP_SIDECAR_OUT: paths.sidecar,
      PAPERCUSP_BUILD_SHA: sourceSha,
      PAPERCUSP_DESKTOP_VERSION: plan.desktopVersion,
      PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release',
      PAPERCUSP_RELEASE_AUDIT: '1',
      PAPERCUSP_SKIP_DEP_GENERATION: '1',
      PAPERCUSP_VM_RELEASE_TRUST_OUTPUT_DIR: paths.sidecarTrust,
      VITE_BUILD_LOCK: join(plan.workDir, 'vite-build.lock'),
      PAPERCUSP_TRANSFORMERS_MODEL_CACHE: join(plan.repoRoot, 'node_modules/@huggingface/transformers/.cache'),
    };
    // Provenance must describe the pinned tree, never a value inherited from the calling shell.
    delete env.PROVENANCE_SOURCE_GIT_HEAD;
    delete env.PROVENANCE_SOURCE_GIT_DIRTY;
    delete env.PROVENANCE_SOURCE_DIRTY_MANIFEST;
    const [command, args] = withReleaseIdentity(plan.releaseIdentityEnvFile, 'bash', [
      join(paths.source, 'papercusp-desktop/bin/build-desktop-sidecar.sh'),
    ]);
    await runStep('sidecar-build', command, args, { cwd: plan.repoRoot, env, logFile: logFor('sidecar-build') });
    await writeJsonAtomic(paths.sidecarReady, {
      sourceSha,
      desktopVersion: plan.desktopVersion,
      readyAt: new Date().toISOString(),
    });
  }

  // 3. Gate: only a sidecar whose own release identity audit passed, for THIS source, is packaged.
  //    A failed build's directory looks identical to a passing one's; the stamp is the difference.
  const stamp = await readJsonIfPresent(join(paths.sidecar, '.sidecar-build-stamp'));
  const identityAudit = isRecord(stamp) ? stamp.releaseIdentityAudit : null;
  if (!isRecord(stamp) || stamp.gitHead !== sourceSha || !isRecord(identityAudit) || identityAudit.passed !== true) {
    throw new WorkspaceHostCutStepError(
      'sidecar-gate',
      false,
      `sidecar stamp does not record a passing release identity audit for ${sourceSha}`,
    );
  }

  // 3b. Precomputed doc_sections vectors (WI-10004899), so a fresh hosted host applies them
  //     instead of embedding every doc section on its own CPU. Never fails the cut.
  await cutDocVectorSeed({
    sidecarDir: paths.sidecar,
    repoRoot: plan.repoRoot,
    logFile: logFor('doc-vector-seed'),
    skip: process.env.PAPERCUSP_SKIP_DOC_VECTOR_SEED === '1',
  });

  // 4. Pack into a fresh publication directory: a leftover file from an earlier attempt must not be
  //    published beside bytes it does not describe.
  await rm(paths.publication, { recursive: true, force: true });
  await rm(paths.extracted, { recursive: true, force: true });
  await mkdir(paths.publication, { recursive: true });
  await mkdir(paths.extracted, { recursive: true });
  const bundlePath = join(paths.publication, WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME);
  await packDeterministically(paths.sidecar, plan.sourceEpochSeconds, bundlePath);

  // 5. Sign, then verify with an independent tool: a signature nobody verified is not evidence.
  const signaturePath = join(paths.publication, WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME);
  const publicKeyPath = join(paths.publication, WORKSPACE_HOST_PUBLISHED_SIGNING_KEY_NAME);
  await runStep(
    'sign',
    'npx',
    [
      '--yes', '-p', `@tauri-apps/cli@${plan.tauriCliVersion}`, 'tauri', 'signer', 'sign',
      '--private-key-path', plan.signingKeyPath,
      '--password', plan.signingKeyPassword,
      bundlePath,
    ],
    { logFile: logFor('sign') },
  );
  // The Tauri signer writes base64-wrapped minisign; the published form is the minisign text.
  await rename(`${bundlePath}.sig`, paths.tauriSignature);
  await writeFile(signaturePath, Buffer.from((await readFile(paths.tauriSignature, 'utf8')).trim(), 'base64'));
  await writeFile(publicKeyPath, Buffer.from((await readFile(`${plan.signingKeyPath}.pub`, 'utf8')).trim(), 'base64'));
  await runStep('verify-signature', 'minisign', ['-V', '-m', bundlePath, '-x', signaturePath, '-p', publicKeyPath], {
    logFile: logFor('verify-signature'),
  });

  // 6. Evidence over the EXTRACTED bytes, so the SBOM describes exactly what was signed. The
  //    vulnerability leg refuses a non-empty evidence directory, so it runs before the audit log.
  const evidenceDir = join(paths.publication, 'evidence');
  await runStep('extract', 'tar', ['-xzf', bundlePath, '-C', paths.extracted, '--no-same-owner'], { logFile: logFor('extract') });
  const auditor = join(paths.source, 'papercusp-desktop/bin/audit-release-bundle.py');
  const auditEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PAPERCUSP_BUILD_SHA: sourceSha,
    PAPERCUSP_DESKTOP_VERSION: plan.desktopVersion,
    SYFT_CHECK_FOR_APP_UPDATE: 'false',
    GRYPE_CHECK_FOR_APP_UPDATE: 'false',
  };
  {
    const [command, args] = withReleaseIdentity(plan.releaseIdentityEnvFile, 'python3', [
      auditor, '--audit-vulnerabilities', paths.extracted, evidenceDir,
    ]);
    await runStep('vulnerability-audit', command, args, { env: auditEnv, logFile: logFor('vulnerability-audit'), gatingExitCodes: [1] });
  }
  const secretScanPath = join(paths.publication, WORKSPACE_HOST_EVIDENCE_FILES.secretScan);
  {
    const [command, args] = withReleaseIdentity(plan.releaseIdentityEnvFile, 'python3', [auditor, bundlePath]);
    await runStep('identity-audit', command, args, { env: auditEnv, logFile: secretScanPath, gatingExitCodes: [1] });
  }
  const summary = await readJsonIfPresent(join(evidenceDir, 'summary.json'));
  const verdict = isRecord(summary) && isRecord(summary.result) ? summary.result : null;
  if (!verdict || verdict.status !== 'green' || verdict.gatedMatches !== 0) {
    throw new WorkspaceHostCutStepError('vulnerability-audit', true, `summary.json verdict is not green: ${JSON.stringify(verdict)}`);
  }

  // 7. Measure everything that was just produced, and only then declare the build finished.
  const [bundle, signature, signingKey, sbom, vulnerabilities, summaryFile, secretScan] = await Promise.all([
    sha256OfFile(bundlePath),
    sha256OfFile(signaturePath),
    sha256OfFile(publicKeyPath),
    sha256OfFile(join(paths.publication, WORKSPACE_HOST_EVIDENCE_FILES.sbom)),
    sha256OfFile(join(paths.publication, WORKSPACE_HOST_EVIDENCE_FILES.vulnerabilities)),
    sha256OfFile(join(evidenceDir, 'summary.json')),
    sha256OfFile(secretScanPath),
  ]);
  const result: WorkspaceHostBuildResult = {
    schemaVersion: 1,
    operationId: plan.operationId,
    requestIdentity: plan.requestIdentity,
    sourceSha,
    version: plan.identity.version,
    desktopVersion: plan.desktopVersion,
    sourceEpochSeconds: plan.sourceEpochSeconds,
    bundle,
    signature,
    signingKeySha256: signingKey.sha256,
    evidence: {
      sbomSha256: sbom.sha256,
      vulnerabilitiesSha256: vulnerabilities.sha256,
      summarySha256: summaryFile.sha256,
      secretScanSha256: secretScan.sha256,
    },
  };
  await writeJsonAtomic(paths.buildResult, result);
  return result;
}

/** Re-measure a recorded build against the files on disk; throws naming every mismatch. */
export async function verifyWorkspaceHostBuild(result: WorkspaceHostBuildResult, workDir: string): Promise<void> {
  const publication = workspaceHostCutPaths(workDir).publication;
  const expected: Array<[string, string, number | null]> = [
    [WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME, result.bundle.sha256, result.bundle.bytes],
    [WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME, result.signature.sha256, result.signature.bytes],
    [WORKSPACE_HOST_PUBLISHED_SIGNING_KEY_NAME, result.signingKeySha256, null],
    [WORKSPACE_HOST_EVIDENCE_FILES.sbom, result.evidence.sbomSha256, null],
    [WORKSPACE_HOST_EVIDENCE_FILES.vulnerabilities, result.evidence.vulnerabilitiesSha256, null],
    ['evidence/summary.json', result.evidence.summarySha256, null],
    [WORKSPACE_HOST_EVIDENCE_FILES.secretScan, result.evidence.secretScanSha256, null],
  ];
  const mismatches: string[] = [];
  for (const [name, sha256, bytes] of expected) {
    const measured = await sha256OfFile(join(publication, name)).catch(() => null);
    if (!measured) mismatches.push(`${name}: missing`);
    else if (measured.sha256 !== sha256 || (bytes !== null && measured.bytes !== bytes)) {
      mismatches.push(`${name}: recorded ${sha256}, measured ${measured.sha256}`);
    }
  }
  if (mismatches.length > 0) throw new Error(`recorded build does not match the publication directory: ${mismatches.join('; ')}`);
}

/**
 * Remove the cut's pinned source checkout, a registered worktree of `repoRoot` (setup-release-checkout
 * uses `git worktree add`). Deleting only the directory would leave a dangling `.git/worktrees/<n>`
 * registration behind, the way r40-r49 did. `--force --force` also takes a worktree that holds
 * initialized submodules, which every cut source does.
 *
 * Fallback, for a source git no longer recognises at this path (an offloaded dir reached through a
 * symlink): delete the files, then drop THIS worktree's registration only, after checking it points
 * back at this checkout. `git worktree prune` is avoided on purpose: it sweeps every stale
 * registration in the repository, including ones other operations still account for.
 */
export function removeReleaseSourceWorktree(repoRoot: string, source: string): void {
  const dotGit = join(source, '.git');
  let adminDir: string | null = null;
  let dotGitReal: string | null = null;
  try {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (match) adminDir = resolve(source, match[1]!);
    dotGitReal = realpathSync(dotGit);
  } catch {
    // No `.git` file: not a worktree checkout, so there is no registration to drop.
  }
  try {
    execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', '--force', source], { stdio: 'pipe' });
    return;
  } catch {
    // Fall through: remove the files and this worktree's own registration by hand.
  }
  rmSync(source, { recursive: true, force: true });
  if (!adminDir || basename(dirname(adminDir)) !== 'worktrees' || !existsSync(adminDir)) return;
  let registered: string;
  try {
    registered = readFileSync(join(adminDir, 'gitdir'), 'utf8').trim();
  } catch {
    return;
  }
  const pointsHere = registered === dotGit || (dotGitReal !== null && registered === dotGitReal);
  if (pointsHere) rmSync(adminDir, { recursive: true, force: true });
}

/**
 * Remove a published cut's rebuildable intermediates and return what was removed (WI-10003700).
 * Every one of them is re-derivable from `--source-sha`; together they are ~89% of a work dir.
 * Ready markers go FIRST: a marker that outlived its directory would let a later build skip a leg
 * whose bytes are gone, whereas a directory without its marker is refused with a clear message.
 */
export async function pruneWorkspaceHostCutIntermediates(
  input: { repoRoot: string; workDir: string },
  removeSource: (repoRoot: string, source: string) => void = removeReleaseSourceWorktree,
): Promise<string[]> {
  const paths = workspaceHostCutPaths(input.workDir);
  const removed: string[] = [];
  for (const marker of [paths.sourceReady, paths.sidecarReady]) {
    if (!existsSync(marker)) continue;
    await rm(marker, { force: true });
    removed.push(marker);
  }
  if (existsSync(paths.source)) {
    removeSource(input.repoRoot, paths.source);
    removed.push(paths.source);
  }
  for (const target of [paths.sidecar, paths.extracted, join(input.workDir, 'vite-build.lock')]) {
    if (!existsSync(target)) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

// ─── Orchestration ──────────────────────────────────────────────────────────────

export interface WorkspaceHostReleaseCutOptions {
  repoRoot: string;
  workDir: string;
  sourceSha: string;
  version: string;
  taskId?: string;
  operationId?: string;
  publish: boolean;
  /** Passed through to the publisher (`--base`, `--token`, and publisher `--plan-only`). */
  publisherArgs: readonly string[];
  /** Keep source/, sidecar/ and extracted/ after a real publish (default: prune them). */
  keepIntermediates?: boolean;
}

export interface WorkspaceHostCutState {
  schemaVersion: 1;
  taskId: string;
  operationId: string;
  sourceSha: string;
  version: string;
}

export interface WorkspaceHostReleaseCutDeps {
  ledger: ReleaseTaskLedger;
  registerTask(spec: TaskSpec, opts: { taskId: string }): Promise<unknown>;
  newTaskId(): string;
  newOperationId(): string;
  readGitlinks(repoRoot: string, sourceSha: string): Record<string, string>;
  readDesktopVersion(repoRoot: string, gitlinks: Readonly<Record<string, string>>): string;
  build(plan: Omit<WorkspaceHostBuildPlan, 'releaseIdentityEnvFile' | 'signingKeyPath' | 'signingKeyPassword' | 'tauriCliVersion'>): Promise<WorkspaceHostBuildResult>;
  verifyBuild(result: WorkspaceHostBuildResult, workDir: string): Promise<void>;
  readBuildResult(workDir: string): Promise<WorkspaceHostBuildResult | null>;
  /**
   * The last release in this cut task's scope whose release.shipment.green committed, or null for
   * the first shipment (D-437). Its version becomes the manifest's lifecycle.rollbackTarget.
   */
  resolveRollbackRelease(taskId: string): Promise<GreenShippedRelease | null>;
  emitManifest(input: {
    workDir: string;
    identity: WorkspaceHostReleaseIdentity;
    desktopVersion: string;
    rollbackVersion: string | null;
  }): Promise<{ trusted: boolean }>;
  publish(input: { repoRoot: string; workDir: string; taskId: string; operationId: string; args: readonly string[] }): Promise<void>;
  /** Remove the rebuildable intermediates of a published cut; returns the removed paths. */
  pruneIntermediates(input: { repoRoot: string; workDir: string }): Promise<string[]>;
  sourceEpochSeconds(repoRoot: string, sourceSha: string): number;
  log(line: string): void;
}

export interface WorkspaceHostReleaseCutResult {
  taskId: string;
  operationId: string;
  bundleSha256: string;
  build: 'built' | 'reconciled' | 'reused';
  published: boolean;
  /** Intermediates removed after a real publish; empty when kept, plan-only or unpublished. */
  pruned: string[];
}

/** Open the operation, or resume the one this work directory already belongs to. */
async function openOperation(
  options: WorkspaceHostReleaseCutOptions,
  identity: WorkspaceHostReleaseIdentity,
  deps: WorkspaceHostReleaseCutDeps,
): Promise<WorkspaceHostCutState> {
  const statePath = workspaceHostCutPaths(options.workDir).state;
  const recorded = await readJsonIfPresent(statePath);
  if (recorded !== null) {
    if (!isRecord(recorded) || recorded.schemaVersion !== 1) throw new Error(`${statePath} is not a cut state file`);
    const state = recorded as unknown as WorkspaceHostCutState;
    if (state.sourceSha !== identity.sourceSha || state.version !== identity.version) {
      throw new Error(
        `${options.workDir} belongs to ${state.sourceSha}/${state.version}, not ${identity.sourceSha}/${identity.version}; ` +
          'use a new --work-dir for a new cut',
      );
    }
    if ((options.taskId && options.taskId !== state.taskId) || (options.operationId && options.operationId !== state.operationId)) {
      throw new Error(`${options.workDir} belongs to task ${state.taskId} / operation ${state.operationId}`);
    }
    deps.log(`resuming task ${state.taskId} operation ${state.operationId}`);
    return state;
  }
  if (options.taskId || options.operationId) {
    if (!options.taskId || !options.operationId) throw new Error('--task-id and --operation-id resume together');
    const state: WorkspaceHostCutState = { schemaVersion: 1, taskId: options.taskId, operationId: options.operationId, sourceSha: identity.sourceSha, version: identity.version };
    await writeJsonAtomic(statePath, state);
    deps.log(`adopting task ${state.taskId} operation ${state.operationId}`);
    return state;
  }
  const state: WorkspaceHostCutState = {
    schemaVersion: 1,
    taskId: deps.newTaskId(),
    operationId: deps.newOperationId(),
    sourceSha: identity.sourceSha,
    version: identity.version,
  };
  // The row first: a row with no cut is discoverable and harmless; a cut with no row cannot journal.
  await deps.registerTask(
    {
      class: 'deploy',
      title: `workspace-host release cut ${identity.version}`,
      argv: [],
      cwd: options.workDir,
      launchedBy: WORKSPACE_HOST_RELEASE_CUT_LAUNCHED_BY,
      harnessSlug: 'papercusp',
      detail: {
        version: identity.version,
        sourceSha: identity.sourceSha,
        platform: WORKSPACE_HOST_RELEASE_PLATFORM,
        workDir: options.workDir,
        release: buildWorkspaceHostReleaseJournalSeed(state.operationId, identity),
      },
    },
    { taskId: state.taskId },
  );
  await writeJsonAtomic(statePath, state);
  deps.log(`opened task ${state.taskId} operation ${state.operationId}`);
  return state;
}

function committedBundleDigest(begun: BegunReleaseTaskStage): string | null {
  for (const ref of begun.receipt?.evidenceRefs ?? []) {
    const match = BUNDLE_REF.exec(ref);
    if (match) return match[1]!;
  }
  return null;
}

async function runBuildStage(
  ctx: ReleaseTaskStageContext,
  input: ReleaseTaskStageInput,
  plan: Parameters<WorkspaceHostReleaseCutDeps['build']>[0],
  deps: WorkspaceHostReleaseCutDeps,
): Promise<{ result: WorkspaceHostBuildResult; outcome: WorkspaceHostReleaseCutResult['build'] }> {
  const settle = (requestIdentity: string, state: 'committed' | 'refused', evidenceRefs: string[]) =>
    settleReleaseTaskStage(ctx, { ...input, requestIdentity, state, evidenceRefs });

  // A confirmed-absent attempt frees the stage for exactly one more; bound the loop anyway.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const begun = await beginReleaseTaskStage(ctx, input);
    const requestIdentity = begun.requestIdentity;
    if (!requestIdentity) throw new Error(`build stage began without a request identity (${begun.action})`);

    if (begun.action === 'reuse') {
      const digest = committedBundleDigest(begun);
      const result = await deps.readBuildResult(plan.workDir);
      if (!digest || !result || result.bundle.sha256 !== digest) {
        throw new Error(
          `build ${requestIdentity} is committed as bundle ${digest ?? '(no digest)'} but its bytes are not in ${plan.workDir}; ` +
            'a committed build cannot be re-produced into the same operation — cut a new one',
        );
      }
      await deps.verifyBuild(result, plan.workDir);
      deps.log(`build already committed: bundle ${digest}`);
      return { result, outcome: 'reused' };
    }

    if (begun.action === 'refused') {
      throw new Error(
        `build stage was refused for this input (${(begun.receipt?.evidenceRefs ?? []).join(', ')}); ` +
          'a refused build needs a new source or version, which is a new cut',
      );
    }

    if (begun.action === 'reconcile') {
      // An intent with no settlement: the process that began it died. Its build-result.json is
      // written only after every leg passed, so it is the whole answer to "did it finish?".
      const recorded = await deps.readBuildResult(plan.workDir);
      if (recorded && recorded.requestIdentity === requestIdentity) {
        const intact = await deps.verifyBuild(recorded, plan.workDir).then(() => true, () => false);
        if (intact) {
          await settle(requestIdentity, 'committed', workspaceHostBuildEvidenceRefs(recorded));
          deps.log(`reconciled interrupted build: bundle ${recorded.bundle.sha256}`);
          return { result: recorded, outcome: 'reconciled' };
        }
      }
      await settle(requestIdentity, 'refused', ['reconcile:confirmed-absent', 'build-result:absent-or-mismatched']);
      deps.log(`interrupted build ${requestIdentity} left no finished result; building again`);
      continue;
    }

    deps.log(`building (request ${requestIdentity})`);
    let result: WorkspaceHostBuildResult;
    try {
      result = await deps.build({ ...plan, requestIdentity });
    } catch (error) {
      if (error instanceof WorkspaceHostCutStepError) {
        await settle(
          requestIdentity,
          'refused',
          error.gating ? [`build:gated:${error.step}`] : ['reconcile:confirmed-absent', `build:failed:${error.step}`],
        );
      }
      // Anything else leaves the intent open: the next run reconciles it from build-result.json.
      throw error;
    }
    await settle(requestIdentity, 'committed', workspaceHostBuildEvidenceRefs(result));
    deps.log(`build committed: bundle ${result.bundle.sha256}`);
    return { result, outcome: 'built' };
  }
  throw new Error('build stage kept being reconciled as absent; refusing to loop');
}

export async function runWorkspaceHostReleaseCut(
  options: WorkspaceHostReleaseCutOptions,
  deps: WorkspaceHostReleaseCutDeps,
): Promise<WorkspaceHostReleaseCutResult> {
  validateWorkspaceHostReleaseCutIdentity(options.sourceSha, options.version);

  const identity: WorkspaceHostReleaseIdentity = {
    sourceSha: options.sourceSha,
    gitlinks: deps.readGitlinks(options.repoRoot, options.sourceSha),
    version: options.version,
  };
  const desktopVersion = deps.readDesktopVersion(options.repoRoot, identity.gitlinks);
  const state = await openOperation(options, identity, deps);
  const ctx = workspaceHostCutStageContext(state.taskId, state.operationId, identity, deps.ledger);

  const { result, outcome } = await runBuildStage(
    ctx,
    workspaceHostBuildStageInput(desktopVersion),
    {
      repoRoot: options.repoRoot,
      workDir: options.workDir,
      identity,
      desktopVersion,
      sourceEpochSeconds: deps.sourceEpochSeconds(options.repoRoot, options.sourceSha),
      operationId: state.operationId,
      requestIdentity: '',
    },
    deps,
  );

  const manifestPath = join(workspaceHostCutPaths(options.workDir).publication, WORKSPACE_HOST_PUBLISHED_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    const rollback = await deps.resolveRollbackRelease(state.taskId);
    deps.log(
      rollback
        ? `rollback target: ${rollback.version} (last green-shipped release task ${rollback.taskId})`
        : 'rollback target: none (no green-shipped release in scope; first shipment, D-437)',
    );
    const manifest = await deps.emitManifest({
      workDir: options.workDir,
      identity,
      desktopVersion,
      rollbackVersion: rollback?.version ?? null,
    });
    if (!manifest.trusted) throw new Error(`the manifest's trust report is not trusted; see ${manifestPath}`);
    deps.log(`manifest written: ${manifestPath}`);
  } else {
    deps.log(`manifest already written: ${manifestPath}`);
  }

  let pruned: string[] = [];
  if (options.publish) {
    await deps.publish({
      repoRoot: options.repoRoot,
      workDir: options.workDir,
      taskId: state.taskId,
      operationId: state.operationId,
      args: options.publisherArgs,
    });
    // Only a REAL publish frees the intermediates: a --plan-only run uploaded nothing, so the cut
    // may still need them. Re-measure the kept bytes first, so nothing is deleted beside a
    // publication directory that no longer matches the committed build.
    if (!options.keepIntermediates && !options.publisherArgs.includes('--plan-only')) {
      await deps.verifyBuild(result, options.workDir);
      pruned = await deps.pruneIntermediates({ repoRoot: options.repoRoot, workDir: options.workDir });
      deps.log(pruned.length > 0 ? `pruned intermediates: ${pruned.join(', ')}` : 'no intermediates left to prune');
    }
  }
  return {
    taskId: state.taskId,
    operationId: state.operationId,
    bundleSha256: result.bundle.sha256,
    build: outcome,
    published: options.publish,
    pruned,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE = join(HERE, 'workspace-host-vm-release-publication-input.json');

export interface WorkspaceHostReleaseCutCliArgs {
  sourceSha: string;
  version: string;
  workDir: string;
  taskId?: string;
  operationId?: string;
  publish: boolean;
  /** Print a whole-cut preview and exit before creating files or opening a release task. */
  planOnly: boolean;
  publisherArgs: string[];
  keepIntermediates: boolean;
}

/**
 * The Cupboard base to hand the publisher when `--base` is absent: the local
 * `PAPERCUSP_CUPBOARD_URL` override, normalized exactly as operator-core's
 * `resolveCupboardBaseUrl()` does, or `undefined` so the publisher keeps its branded
 * default. The override lives in gitignored `.env.local` (which the cut sources) because
 * a box that SNI-blackholes the branded host (EI-16742) can only reach the worker's own
 * origin; without this the cut dies at publish.multipart.initiate (WI-10003172). Reading
 * env keeps the account-bearing worker origin out of shipped code (WI-38321).
 */
export function cupboardBaseOverride(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.PAPERCUSP_CUPBOARD_URL?.trim().replace(/\/+$/, '');
  return raw ? raw : undefined;
}

/**
 * Parse strictly; an unknown flag is an error rather than silently ignored. An explicit
 * `--base` wins; otherwise the `PAPERCUSP_CUPBOARD_URL` override is forwarded.
 */
export function parseWorkspaceHostReleaseCutArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceHostReleaseCutCliArgs {
  const values: Record<string, string> = {};
  const valueFlags = new Set(['source-sha', 'version', 'work-dir', 'task-id', 'operation-id', 'base', 'token']);
  let publish = true;
  let planOnly = false;
  let publishPlanOnly = false;
  let keepIntermediates = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (flag === '--no-publish') { publish = false; continue; }
    if (flag === '--keep-intermediates') { keepIntermediates = true; continue; }
    if (flag === '--plan-only') { planOnly = true; continue; }
    if (flag === '--publish-plan-only') { publishPlanOnly = true; continue; }
    if (!flag.startsWith('--')) throw new Error(`unexpected argument '${flag}'`);
    const key = flag.slice(2);
    if (!valueFlags.has(key)) throw new Error(`unknown flag '--${key}'`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) throw new Error(`flag '--${key}' requires a value`);
    values[key] = value;
    index += 1;
  }
  for (const required of ['source-sha', 'version', 'work-dir']) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  if (Boolean(values['task-id']) !== Boolean(values['operation-id'])) {
    throw new Error('--task-id and --operation-id must be provided together');
  }
  if (planOnly && publishPlanOnly) throw new Error('--plan-only and --publish-plan-only cannot be combined');
  if (publishPlanOnly && !publish) throw new Error('--publish-plan-only requires publishing');
  validateWorkspaceHostReleaseCutIdentity(values['source-sha']!, values.version!);
  const base = values.base ?? cupboardBaseOverride(env);
  const publisherArgs = [
    ...(base ? ['--base', base] : []),
    ...(values.token ? ['--token', values.token] : []),
    ...(publishPlanOnly ? ['--plan-only'] : []),
  ];
  return {
    sourceSha: values['source-sha']!,
    version: values.version!,
    workDir: resolve(values['work-dir']!),
    ...(values['task-id'] ? { taskId: values['task-id'] } : {}),
    ...(values['operation-id'] ? { operationId: values['operation-id'] } : {}),
    publish,
    planOnly,
    publisherArgs,
    keepIntermediates,
  };
}

function validateWorkspaceHostReleaseCutIdentity(sourceSha: string, version: string): void {
  if (!SOURCE_SHA.test(sourceSha)) throw new Error(`--source-sha must be a full commit sha, got '${sourceSha}'`);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) throw new Error(`--version '${version}' is not a release version`);
}

export interface WorkspaceHostReleaseCutCliRunner {
  env?: NodeJS.ProcessEnv;
  signingKeyPath: string;
  newTaskId(): string;
  newOperationId(): string;
  log(line: string): void;
  run(args: WorkspaceHostReleaseCutCliArgs): Promise<void>;
}

/**
 * Handle the read-only whole-cut preview before the execution callback. This keeps the preview
 * ahead of work-directory creation, locking, task registration, builds, manifests and publishing.
 */
export async function runWorkspaceHostReleaseCutCli(
  argv: readonly string[],
  runner: WorkspaceHostReleaseCutCliRunner,
): Promise<'planned' | 'executed'> {
  const args = parseWorkspaceHostReleaseCutArgs(argv, runner.env);
  if (!args.planOnly) {
    await runner.run(args);
    return 'executed';
  }

  const taskId = args.taskId ?? runner.newTaskId();
  const operationId = args.operationId ?? runner.newOperationId();
  runner.log('plan-only: no task will be registered and no work-directory files will be written');
  runner.log(`source sha: ${args.sourceSha}`);
  runner.log(`version: ${args.version}`);
  runner.log(`work directory: ${args.workDir}`);
  runner.log(`task id: ${taskId} (planned)`);
  runner.log(`operation id: ${operationId} (planned)`);
  runner.log(`publish: ${args.publish ? 'enabled' : 'disabled'}`);
  runner.log(`signing key present: ${existsSync(runner.signingKeyPath) ? 'yes' : 'no'}`);
  return 'planned';
}

/** One cut per work directory at a time: two would race each other's journal and files. */
async function acquireWorkDirLock(lockPath: string): Promise<() => Promise<void>> {
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const holder = Number.parseInt(await readFile(lockPath, 'utf8'), 10);
    let alive = false;
    try {
      if (Number.isSafeInteger(holder) && holder > 0) {
        process.kill(holder, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`another cut (pid ${holder}) holds ${lockPath}`);
    await writeFile(lockPath, `${process.pid}\n`);
  }
  return () => rm(lockPath, { force: true });
}

function readDesktopVersionFromGit(repoRoot: string, gitlinks: Readonly<Record<string, string>>): string {
  const pin = gitlinks['papercusp-desktop'];
  if (!pin) throw new Error('source pins no papercusp-desktop gitlink');
  const conf = JSON.parse(
    execFileSync('git', ['-C', join(repoRoot, 'papercusp-desktop'), 'show', `${pin}:src-tauri/tauri.conf.json`], { encoding: 'utf8' }),
  ) as { version?: unknown };
  if (typeof conf.version !== 'string' || !conf.version) throw new Error(`papercusp-desktop ${pin} tauri.conf.json has no version`);
  return conf.version;
}

async function main(): Promise<void> {
  const repoRoot = moduleRepoRoot(import.meta.url);
  const signingKeyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? join(homedir(), '.papercusp/signing/papercusp.key');
  const log = (line: string) => process.stdout.write(`[workspace-host-cut] ${line}\n`);
  await runWorkspaceHostReleaseCutCli(process.argv.slice(2), {
    env: process.env,
    signingKeyPath,
    newTaskId: () => newTaskId(),
    newOperationId: () => randomUUID(),
    log,
    run: async (args) => {
      const { planOnly: _planOnly, ...cutArgs } = args;
      const paths = workspaceHostCutPaths(args.workDir);
      await mkdir(args.workDir, { recursive: true });
      const release = await acquireWorkDirLock(paths.lock);
      try {
        const result = await runWorkspaceHostReleaseCut(
          { repoRoot, ...cutArgs },
          {
            ledger: { getTask: (taskId) => getTask(taskId), taskReleaseJournalFromDetail, appendTaskReleaseReceipt },
            registerTask: (spec, opts) => registerTask(spec, opts),
            newTaskId: () => newTaskId(),
            newOperationId: () => randomUUID(),
            readGitlinks: readSourceGitlinks,
            readDesktopVersion: readDesktopVersionFromGit,
            sourceEpochSeconds: (root, sha) =>
              Number.parseInt(execFileSync('git', ['-C', root, 'show', '-s', '--format=%ct', sha], { encoding: 'utf8' }).trim(), 10),
            build: (plan) =>
              buildWorkspaceHostBundle({
                ...plan,
                releaseIdentityEnvFile: process.env.PAPERCUSP_RELEASE_IDENTITY_ENV ?? join(homedir(), '.papercusp/release-identity.env'),
                signingKeyPath,
                signingKeyPassword: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
                tauriCliVersion: process.env.PAPERCUSP_TAURI_CLI_VERSION ?? DEFAULT_TAURI_CLI_VERSION,
              }),
            verifyBuild: verifyWorkspaceHostBuild,
            readBuildResult: async (workDir) => {
              const raw = await readJsonIfPresent(workspaceHostCutPaths(workDir).buildResult);
              return raw === null ? null : parseWorkspaceHostBuildResult(raw);
            },
            resolveRollbackRelease: (taskId) => latestGreenShippedReleaseInScope(taskId),
            emitManifest: async ({ workDir, identity, desktopVersion, rollbackVersion }) => {
              const cut = workspaceHostCutPaths(workDir);
              const input = buildWorkspaceHostPublicationInput(
                JSON.parse(await readFile(WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE, 'utf8')),
                {
                  version: identity.version,
                  sourceSha: identity.sourceSha,
                  desktopVersion,
                  desktopRevision: identity.gitlinks['papercusp-desktop'] ?? '',
                  sourceRoot: cut.source,
                  bundleRoot: cut.extracted,
                  rollbackVersion,
                },
              );
              await writeJsonAtomic(cut.publicationInput, input);
              return runPublicationManifestCli({ publicationDir: cut.publication, inputFile: cut.publicationInput, sourceRoot: cut.source });
            },
            publish: ({ repoRoot: root, workDir, taskId, operationId, args: extra }) =>
              runStep(
                'publish',
                process.execPath,
                [
                  '--import', 'tsx',
                  join(root, 'scripts/publish-workspace-host-artifacts.mjs'),
                  '--dir', workspaceHostCutPaths(workDir).publication,
                  '--task-id', taskId,
                  '--operation-id', operationId,
                  ...extra,
                ],
                { cwd: root },
              ),
            pruneIntermediates: (input) => pruneWorkspaceHostCutIntermediates(input),
            log,
          },
        );
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.stdout.write(`WORKSPACE_HOST_CUT_TASK_ID=${result.taskId}\nWORKSPACE_HOST_CUT_BUNDLE_SHA256=${result.bundleSha256}\n`);
      } finally {
        await release();
      }
    },
  });
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
