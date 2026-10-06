/**
 * release-cut-launch — the agent-facing LOCAL desktop-release cutter's launch +
 * status + hand-off primitives (desktop-update-center-and-release-tooling P-5 Unit B).
 *
 * The `release:cut` MCP tool wraps these. Why a separate module (mirrors
 * release-deploy-launch.ts / release-checkpoint-launch.ts): a cut is a ~35–60 min heavy
 * tri-platform build — it MUST run DETACHED (survive a compaction / TUI relaunch /
 * operator restart, exactly like the deploy lever), so the tool can only fire-and-poll,
 * never await a child. Keeping the pure builders (argv, env, status parse, hand-off
 * collection) here makes them unit-testable WITHOUT firing a real cut (inject the
 * spawn / fs seams) and keeps the tool file thin — the codebase's standing convention
 * for these launch levers.
 *
 * ⛔ LOCAL-only (papercusp-desktop/RELEASE-RUNBOOK.md → "Releases are LOCAL-only";
 * owner directive 2026-07-08). The cut is fired with PAPERCUSP_PUBLISH_GITHUB=0 so
 * release-local.sh never mutates a remote tag or creates a GitHub Release — the signed
 * artifacts on disk are the deliverable. Every launch is bound to one exact superproject
 * SHA, which the cutter verifies before any write. `handoff` collects the local paths +
 * sha256 for the owner to upload.
 */

import { spawn } from 'node:child_process';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS } from './systemd-scope';
import { serviceUnitForTask, TASK_ROOT_SLICE } from './task-manager/types';
import { execFileViaSidecar } from './fleet/git-via-sidecar';

/** Transient systemd unit for the detached cut. Distinct from DEPLOY_UNIT /
 *  the checkpoint unit — a cut, a deploy and a green-checkpoint touch different trees and
 *  may run concurrently, so they must NOT share a mutually-exclusive unit name. */
export const CUT_UNIT = 'papercup-release-cut';
export const CUT_LOG = `/tmp/${CUT_UNIT}.log`;
/** Written "DONE:<exit-code>" by the detached wrapper when release-local.sh finishes —
 *  the authoritative completion signal a cut has no external event (unlike deploy). */
export const CUT_DONE = `/tmp/${CUT_UNIT}.done`;
/** Written when the detached wrapper starts. If the unit later disappears without a
 *  DONE sentinel, this marker distinguishes an interrupted cut from a never-launched one. */
export const CUT_STARTED = `/tmp/${CUT_UNIT}.started`;
/** Shared manual/nightly policy: identity scans authorize reuse for at most one day. */
export const RELEASE_REUSE_MAX_AGE_SEC = 24 * 60 * 60;

export type Channel = 'stable' | 'beta' | 'alpha';
export const CHANNELS: readonly Channel[] = ['stable', 'beta', 'alpha'] as const;
// Semver-ish: X.Y.Z with an optional -prerelease suffix (e.g. 0.0.8, 1.2.3-rc.1).
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/;

// ─── Per-leg (fleet-split) support (WI-4233) ───────────────────────────────────
//
// The 0.0.8 cut ran as a fleet-split: 3 agents, 3 platform legs (linux+core /
// mac / windows), each sequenced on a shared BUILD_SHA. Because op:run only
// ever modeled ONE whole-cut detached unit, every leg had to be fired via raw
// bash around this orchestrator — losing op:status polling, the detached
// systemd unit, and the audit trail (see the cut.ts module doc). The
// functions below let each leg run through its OWN unit/log/done triple
// (`cutUnitFor`/`cutLogFor`/`cutDoneFor`) so N agents can each op:run-leg /
// op:status / op:abort-leg their own platform independently, while a single
// whole-cut (`platform` omitted) keeps behaving exactly as before.

export type Platform = 'linux' | 'mac' | 'windows' | 'arm64';
export const PLATFORMS: readonly Platform[] = ['linux', 'mac', 'windows', 'arm64'] as const;

/** Per-leg unit name; `platform` omitted ⇒ the legacy whole-cut unit (CUT_UNIT), so every
 *  existing whole-cut call site (op:run/status with no platform) is unaffected. */
export function cutUnitFor(platform?: Platform): string {
  return platform ? `${CUT_UNIT}-${platform}` : CUT_UNIT;
}
/** Task-manager service unit for one managed release cut. */
export function cutUnitForTask(taskId: string): string {
  return serviceUnitForTask(taskId);
}
function rootScopedCutPath(extension: 'log' | 'done' | 'started', platform: Platform | undefined, root: string): string {
  const rootKey = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
  const unit = platform ? `${CUT_UNIT}-${platform}` : CUT_UNIT;
  return `/tmp/${unit}-${rootKey}.${extension}`;
}
export function cutLogFor(platform?: Platform, root?: string): string {
  if (root !== undefined) return rootScopedCutPath('log', platform, root);
  return platform ? `/tmp/${CUT_UNIT}-${platform}.log` : CUT_LOG;
}
export function cutDoneFor(platform?: Platform, root?: string): string {
  if (root !== undefined) return rootScopedCutPath('done', platform, root);
  return platform ? `/tmp/${CUT_UNIT}-${platform}.done` : CUT_DONE;
}
export function cutStartedFor(platform?: Platform, root?: string): string {
  if (root !== undefined) return rootScopedCutPath('started', platform, root);
  return platform ? `/tmp/${CUT_UNIT}-${platform}.started` : CUT_STARTED;
}
/** Stable lock for the logical whole-cut/platform slot, independent of task unit id. */
export function cutLockFor(platform?: Platform): string {
  return platform ? `/tmp/${CUT_UNIT}-${platform}.lock` : `/tmp/${CUT_UNIT}.lock`;
}

/** Map a single platform leg to the `CutLegs` flags release-local.sh reads (WITH_MAC=1 /
 *  WITH_WINDOWS=1 / WITH_ARM64=1). 'linux' needs no flag — release-local.sh always builds
 *  the linux leg unconditionally; a linux-only leg is just the no-extra-flags base run. */
export function legsForPlatform(platform: Platform): CutLegs {
  switch (platform) {
    case 'mac':
      return { mac: true };
    case 'windows':
      return { windows: true };
    case 'arm64':
      return { arm64: true };
    case 'linux':
      return {};
  }
}

export function isValidVersion(v: string): boolean {
  return VERSION_RE.test(v);
}
export function isValidChannel(c: string): c is Channel {
  return (CHANNELS as readonly string[]).includes(c);
}
export function isValidSourceSha(sha: string): boolean {
  return SOURCE_SHA_RE.test(sha);
}

/** Integration tree root (mirrors release-deploy-launch.integrationRoot). */
export function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}
/** The papercusp-desktop submodule root — where bin/release-local.sh + src-tauri live.
 *  Overridable (PAPERCUSP_DESKTOP_ROOT) for a non-standard checkout layout. */
export function desktopRoot(): string {
  return process.env.PAPERCUSP_DESKTOP_ROOT ?? path.join(integrationRoot(), 'papercusp-desktop');
}
/** The papercusp-desktop checkout git-sync commits — where a cut's version bump must be
 *  written back (WI-10001570). NOT {@link desktopRoot}: on :3170 the integration root is the
 *  committed `papercusp-staging` mirror, which papercup-staging-sync resets, so every cut
 *  launched there wrote its bump into a tree nothing commits and the canonical manifests sat
 *  at 0.0.22 through 0.0.23–0.0.25 (WI-10003596). `PAPERCUSP_CANONICAL_TREE` is the explicit
 *  edit-tree declaration the staging drop-in sets (same rule as resolveEditTreeRoot); where it
 *  is unset the serving tree IS the edit tree. */
export function canonicalDesktopRoot(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env.PAPERCUSP_CANONICAL_TREE?.trim();
  return declared ? path.join(path.resolve(declared), 'papercusp-desktop') : desktopRoot();
}

export interface CutLegs {
  mac?: boolean;
  windows?: boolean;
  arm64?: boolean;
}

export interface MigrationBootSmokeOverride {
  /** The exact superproject source whose migration corpus passed independently. */
  sourceSha: string;
  /** Durable reference to the successful full replay result. */
  proofRef: string;
  reason: string;
}

export function validateMigrationBootSmokeOverride(
  override: MigrationBootSmokeOverride | undefined,
  expectedSourceSha: string,
): string | null {
  if (!override) return null;
  if (!isValidSourceSha(override.sourceSha) || override.sourceSha !== expectedSourceSha) {
    return 'migration_boot_smoke_override_source_mismatch — proof sourceSha must equal the exact cut sourceSha';
  }
  if (!override.proofRef?.trim() || !override.reason?.trim()) {
    return 'migration_boot_smoke_override_evidence_required — pass a proofRef and reason';
  }
  return null;
}

/** Runtime-only identity and retry controls for a release cut. The owner identity
 * is deliberately never persisted in the tree: the finished-byte identity audit
 * needs it as a search literal, but writing it into release source would create
 * the exact leak that audit is meant to catch. */
export interface CutRuntimeEnv {
  ownerName: string;
  ownerEmail?: string;
  /** Caller scope shared by the managed task and its focused test proof. */
  harnessSlug?: string | null;
  /** Explicit shipping policy: re-cut Git with its full reachable history. The
   * cutter distinguishes this from its depth-1 default by a PRESENT-EMPTY env
   * value, so the launcher must render the empty string rather than omit it. */
  fullHistory?: boolean;
  /** Approved speculative build only: leave all release tags and canonical
   * version manifests untouched until a matching containment receipt arrives. */
  deferTag?: boolean;
  /** Explicit retry-only fast path: reuse a seed already cut in this isolated root. */
  reuseSeed?: boolean;
  /** Reviewed private D-140 exact-content seed finding evidence, never a path skip. */
  seedFindingProof?: string;
  /** Private D166 plan bound to a frozen ORIGINAL store. Transport only;
   * independent source/candidate acceptance remains required. */
  seedUuidIdempotency?: { plansPath: string; plansSha256: string; sourceStoreDir: string;
    censusPath: string; censusSha256: string };
  /** Explicit new-build path: package the validated placeholder-only seed directory
   * without cutting or reusing a hive seed. Unlike reuseSeed, this does not restore
   * retry-owned version residue before launch. */
  seedless?: boolean;
  /** The CANONICAL papercusp-desktop checkout, so release-local.sh can write the
   *  version bump back to it (WI-10001570). The cutter derives its own ROOT from
   *  where the script lives, so a cut launched against an isolated worktree bumps
   *  only that throwaway checkout — whose .git is an INDEPENDENT clone, not a
   *  linked worktree. With the publish/push leg deleted under LOCAL-only there is
   *  then no route back at all and the bump dies with the worktree, which is how
   *  0.0.18 shipped while every canonical manifest still read 0.0.17. This is the
   *  one place that knows BOTH roots, so it is where they get connected. */
  canonicalDesktopRoot?: string;
  /** Override for the sparse-seed head-snapshot deadline, in ms.
   *
   *  cut-seed-cli already honours PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS, so a MANUAL
   *  `bin/release-local.sh` run has always had this lever — a plain shell passes the
   *  whole environment down. A cut launched through `release:cut` did not, because the
   *  env below is an explicit allowlist rendered onto a `systemd-run` command: any name
   *  not named here is dropped. That asymmetry left the release path with NO way to widen
   *  the deadline, so the only remedies a scan overrun offered were a FULL seed or
   *  quiescing the operator (a fleet-affecting outage) — neither of which is necessary
   *  (EI-23917342543376581). Carrying it restores parity with the manual path. */
  headSnapshotTimeoutMs?: number;
  /** Managed-release journal identity (P-001). release-local.sh runs its phase journal
   *  — stage receipts, reuse/reconcile decisions, restart resume — only when BOTH of
   *  these are present; absent, the cut runs UNMANAGED exactly as before, which is how
   *  every manual `release:cut` ran until now while the nightly routine
   *  (nightly-release-cut-action.ts) threaded them. Supplying them is what makes a
   *  manual cut resumable and discoverable after an operator restart. */
  releaseTaskId?: string;
  releaseOperationId?: string;
  /** Enqueue instant, so the journal can separate queue wait from build time. */
  enqueuedAtMs?: number;
  /** Explicit, exact-source, audited bypass after a separate full replay passes. */
  migrationBootSmokeOverride?: MigrationBootSmokeOverride;
}

function requiredOwnerName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      'release_owner_name_required — pass the human owner name at run time so the finished-byte identity audit can certify the cut',
    );
  }
  return trimmed;
}

/** Shell-safe single-quoted literal. Owner names may contain apostrophes; interpolating
 * them directly into the systemd wrapper would otherwise corrupt the command. */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

/** Pure: the env the detached cut runs release-local.sh with — LOCAL-only ENFORCED
 *  (PAPERCUSP_PUBLISH_GITHUB=0, never publish to GitHub) plus the requested optional
 *  platform legs. Exported for unit testing. */
export function buildCutEnv(
  legs: CutLegs,
  expectedSourceSha: string,
  runtime: CutRuntimeEnv,
  platform?: Platform,
): Record<string, string> {
  const overrideError = validateMigrationBootSmokeOverride(runtime.migrationBootSmokeOverride, expectedSourceSha);
  if (overrideError) throw new Error(overrideError);
  const env: Record<string, string> = {
    PAPERCUSP_PUBLISH_GITHUB: '0',
    // Reset inherited state for ordinary cuts, including detached retries.
    PAPERCUSP_RELEASE_DEFER_TAG: runtime.deferTag === true ? '1' : '0',
    PAPERCUSP_EXPECTED_SOURCE_SHA: expectedSourceSha,
    PAPERCUSP_RELEASE_OWNER_NAME: requiredOwnerName(runtime.ownerName),
    // A release cut may execute a frozen exact-source dependency-generation
    // script while using current orchestration fixes. Force that older script's
    // already-supported independent-copy path too: otherwise its historical
    // same-filesystem default can hardlink a predecessor generation, and
    // platform packaging then shares mutable inodes across Linux and Darwin.
    DEPENDENCY_GENERATION_FORCE_COPY: '1',
    // D-186: a desktop release never consumes npm-install-safe's immutable
    // dependency generation. Exact-source retries execute the frozen cutter,
    // so the current launcher must carry this invariant across that boundary;
    // relying only on the current release-local.sh would silently restore the
    // multi-GB copy whenever `root` selects an older frozen worktree.
    PAPERCUSP_SKIP_DEP_GENERATION: '1',
    // This is the desktop release cutter. release-local.sh otherwise auto-enables
    // Android whenever a sibling mobile checkout + SDK happen to exist, which makes
    // an explicitly Linux/macOS/Windows cut depend on ambient fourth-product state.
    // Mobile has its own release rail; declare the desktop-only scope explicitly.
    PAPERCUSP_SKIP_MOBILE: '1',
  };
  if (runtime.migrationBootSmokeOverride) env.PAPERCUSP_SKIP_MIGRATION_BOOTSMOKE = '1';
  const ownerEmail = runtime.ownerEmail?.trim();
  if (ownerEmail) env.PAPERCUSP_RELEASE_OWNER_EMAIL = ownerEmail;
  const harnessSlug = runtime.harnessSlug?.trim();
  if (harnessSlug && harnessSlug !== '*' && harnessSlug !== 'all') {
    env.PAPERCUSP_TEST_RUN_HARNESS = harnessSlug;
  }
  // Absent => release-local.sh skips the writeback rather than guessing a path.
  // It is a no-op when the cut already runs in the canonical checkout, so passing
  // it unconditionally is safe.
  const canonicalDesktopRoot = runtime.canonicalDesktopRoot?.trim();
  if (canonicalDesktopRoot) {
    env.PAPERCUSP_RELEASE_CANONICAL_DESKTOP_ROOT = canonicalDesktopRoot;
  }
  if (runtime.reuseSeed && runtime.seedless) {
    throw new Error('seed_mode_conflict — reuseSeed and seedless are mutually exclusive');
  }
  if (runtime.fullHistory && (runtime.reuseSeed || runtime.seedless)) {
    throw new Error(
      'seed_history_mode_conflict — fullHistory requires a fresh Git seed cut and cannot accompany reuseSeed or seedless',
    );
  }
  if (runtime.reuseSeed || runtime.seedless) env.PAPERCUSP_SKIP_SEED_CUT = '1';
  if (runtime.seedUuidIdempotency) {
    const { plansPath, plansSha256, sourceStoreDir, censusPath, censusSha256 } = runtime.seedUuidIdempotency;
    if (runtime.reuseSeed || runtime.seedless || !plansPath?.startsWith('/')
        || !sourceStoreDir?.startsWith('/') || !/^[0-9a-f]{64}$/.test(plansSha256)
        || !censusPath?.startsWith('/') || !/^[0-9a-f]{64}$/.test(censusSha256)) {
      throw new Error('seed_uuid_mode_conflict — UUID plans require exact absolute private inputs and a fresh frozen-source cut');
    }
    env.PAPERCUSP_SEED_UUID_PLAN_PATH = plansPath;
    env.PAPERCUSP_SEED_UUID_PLAN_SHA256 = plansSha256;
    // Keep census context after the seed function clears the one-use row plan:
    // later copy points must discover mirrors without reapplying that plan.
    env.PAPERCUSP_SEED_UUID_CENSUS_PATH = censusPath;
    env.PAPERCUSP_SEED_UUID_CENSUS_SHA256 = censusSha256;
    env.PAPERCUSP_SEED_STORE_DIR = sourceStoreDir;
    env.PAPERCUSP_SEED_FORCE = '1';
    env.PAPERCUSP_SEED_CORESTORE = '1';
    env.PAPERCUSP_SEED_REUSE_CORESTORE = '0';
    env.PAPERCUSP_SEED_SPARSE = '0';
    env.PAPERCUSP_SEED_SNAPSHOT_DIR = '';
  }
  if (runtime.seedFindingProof) env.PAPERCUSP_RELEASE_SEED_FINDING_PROOF = runtime.seedFindingProof;
  if (runtime.fullHistory) env.PAPERCUSP_SEED_DEPTH = '';
  // BOTH-OR-NEITHER, enforced HERE rather than discovered in the cut. release-local.sh's
  // release_task_journal_configure() hard-refuses a half-configured pair (`managed release
  // resume requires BOTH ...`, exit 2) — but that refusal happens inside the detached unit,
  // so a caller that threads only one id gets a green `launched:true` and learns nothing
  // until it reads a failed log. Refusing at build time turns that into an immediate,
  // attributable error at the call site.
  const releaseTaskId = runtime.releaseTaskId?.trim();
  const releaseOperationId = runtime.releaseOperationId?.trim();
  if (Boolean(releaseTaskId) !== Boolean(releaseOperationId)) {
    throw new Error(
      'release_journal_identity_incomplete — a managed cut needs BOTH releaseTaskId and releaseOperationId (release-local.sh refuses the pair otherwise); pass neither to run an unmanaged cut',
    );
  }
  if (releaseTaskId && releaseOperationId) {
    env.PAPERCUSP_RELEASE_TASK_ID = releaseTaskId;
    env.PAPERCUSP_RELEASE_OPERATION_ID = releaseOperationId;
    // Receipt commit requires a bounded expiry even for newly built bytes.
    // Leaving this unset defaults the cutter to 0 and fails after the build.
    env.PAPERCUSP_RELEASE_REUSE_MAX_AGE_SEC = String(RELEASE_REUSE_MAX_AGE_SEC);
    const enqueuedAtMs = runtime.enqueuedAtMs;
    if (Number.isSafeInteger(enqueuedAtMs) && (enqueuedAtMs as number) > 0) {
      env.PAPERCUSP_RELEASE_ENQUEUED_AT_MS = String(enqueuedAtMs);
    }
  }
  // Only a usable positive integer is forwarded: cut-seed-cli REFUSES a malformed value,
  // and failing the whole cut on a stray override would be worse than ignoring it.
  const headSnapshotTimeoutMs = runtime.headSnapshotTimeoutMs;
  if (Number.isSafeInteger(headSnapshotTimeoutMs) && (headSnapshotTimeoutMs as number) > 0) {
    env.PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS = String(headSnapshotTimeoutMs);
  }
  // A platform leg still runs the shared release-local collector. Non-Linux legs
  // must consume the already-successful Linux bytes through its existing,
  // provenance-checked salvage path; otherwise a Windows/macOS/arm64 retry
  // silently rebuilds Linux before reaching its requested leg.
  if (platform && platform !== 'linux') env.PAPERCUSP_REUSE_LINUX = '1';
  if (legs.mac) env.WITH_MAC = '1';
  if (legs.windows) env.WITH_WINDOWS = '1';
  if (legs.arm64) env.WITH_ARM64 = '1';
  return env;
}

/** The flock file papercup-staging-sync (apps/operator/bin/release/sync-staging-checkout.sh)
 *  takes EXCLUSIVELY (non-blocking) before setup-release-checkout.sh re-clones every submodule
 *  IN PLACE inside the staging checkout, and that :3170's ExecStartPre takes SHARED. */
export const STAGING_SYNC_LOCK = '/tmp/papercup-staging-sync.lock';
/** How long a cut waits for an in-flight staging-sync to finish mutating the tree before it
 *  gives up (staging-sync's own TimeoutStartSec is 900). */
export const STAGING_SYNC_LOCK_WAIT_SEC = 1200;
/** Distinct cut exit code (`DONE:75`) when that wait expires, so a lock timeout never reads
 *  like a build failure. */
export const STAGING_SYNC_LOCK_TIMEOUT_EXIT = 75;

/** WI-10003515: does this orchestrator root live in the staging checkout that
 *  papercup-staging-sync rewrites every time staging advances? A cut fired through :3170
 *  sources its orchestration (release-local.sh, build-desktop-sidecar.sh, bin/lib/*) from
 *  `papercusp-staging/papercusp-desktop` for its whole 30–90 min life, and staging-sync deletes
 *  and re-extracts that submodule in place on every advance — measured 2026-09-27, the 0.0.22
 *  mac leg died sourcing bin/lib/source-roots.sh in the second it was being re-extracted. */
export function orchestratorNeedsStagingSyncLock(orchestratorRoot: string): boolean {
  const worktree = path.basename(path.dirname(path.resolve(orchestratorRoot)));
  return worktree === 'papercusp-staging' || worktree === 'papercup-staging';
}

/** Pure: wrap a shell command so it runs holding staging-sync's lock SHARED for its whole
 *  lifetime. staging-sync's exclusive try-lock then skips its ticks, while :3170's shared
 *  ExecStartPre lock stays compatible. `--close` keeps the lock fd OUT of the command's process
 *  tree, so a daemon the build spawns (sccache, a gradle daemon) cannot outlive the cut still
 *  holding staging frozen; the flock process itself holds the lock until the command exits.
 *  `lockPath` / `waitSec` are overridable for the behavioural test only. */
export function wrapWithStagingSyncLock(
  command: string,
  lockPath: string = STAGING_SYNC_LOCK,
  waitSec: number = STAGING_SYNC_LOCK_WAIT_SEC,
): string {
  return (
    `flock --shared --close --verbose --timeout ${waitSec} ` +
    `--conflict-exit-code ${STAGING_SYNC_LOCK_TIMEOUT_EXIT} ${shellSingleQuote(lockPath)} ${command}`
  );
}

/** Pure: the full `systemd-run` argv for the detached LOCAL cut. Mirrors
 *  release-deploy-launch.buildSystemdRunArgv (PATH passthrough so the transient unit
 *  doesn't depend on the systemd-manager env). The inner command clears a stale DONE
 *  sentinel, writes root-scoped status files and updates the host-wide pointers, then
 *  records the real exit code. Exported for unit testing the command construction. */
export function buildCutArgv(
  root: string,
  version: string,
  channel: Channel,
  legs: CutLegs,
  expectedSourceSha: string,
  pathEnv: string,
  runtime: CutRuntimeEnv,
  platform?: Platform,
  orchestratorRoot?: string,
): string[] {
  const env = buildCutEnv(legs, expectedSourceSha, runtime, platform);
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shellSingleQuote(v)}`)
    .join(' ');
  const taskId = runtime.releaseTaskId?.trim();
  const unit = taskId ? cutUnitForTask(taskId) : cutUnitFor(platform);
  const log = cutLogFor(platform, root);
  const done = cutDoneFor(platform, root);
  const started = cutStartedFor(platform, root);
  // Rootless status and preflight keep their host-wide view of the latest cut;
  // an explicit root reads its own independent markers/log/done files.
  const currentStatusPointers = [
    [log, cutLogFor(platform)],
    [done, cutDoneFor(platform)],
    [started, cutStartedFor(platform)],
  ]
    .map(([target, pointer]) => `ln -sfn ${shellSingleQuote(target!)} ${shellSingleQuote(pointer!)}`)
    .join('; ') + '; ';
  const lock = cutLockFor(platform);
  // A first pass writes these version fields before cutting the seed. A retry
  // validates that exact residue in release:cut, then restores only those files
  // so release-local.sh starts from a clean provenance baseline and reapplies the
  // same idempotent bump while preserving the ignored completed seed.
  const resumeReset = runtime.reuseSeed
    ? 'git restore -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock && '
    : '';
  // The selected root owns the exact target bytes and artifact paths, while the
  // current tooling root owns retry orchestration. Invoking the selected root's
  // frozen cutter would make every release repair in the current cutter inert.
  // `bash -c` sets $0 to the frozen target entrypoint; the sourced script sees
  // its current path through BASH_SOURCE[0] and deliberately keeps both roots.
  const targetEntrypoint = path.join(root, 'bin', 'release-local.sh');
  const orchestratorEntrypoint = path.join(orchestratorRoot ?? root, 'bin', 'release-local.sh');
  const sourceCutter =
    `bash -c 'source "$1" "$2" "$3"' ` +
    `${shellSingleQuote(targetEntrypoint)} ${shellSingleQuote(orchestratorEntrypoint)} ` +
    `${shellSingleQuote(version)} ${shellSingleQuote(channel)}`;
  // WI-10003515: an orchestrator in the staging checkout must not be re-cloned under the cut.
  const cutterInvocation = orchestratorNeedsStagingSyncLock(orchestratorRoot ?? root)
    ? wrapWithStagingSyncLock(sourceCutter)
    : sourceCutter;
  // The started marker carries the OPERATION IDENTITY, not just a timestamp (P-001).
  // The sentinels are per-PLATFORM and therefore SHARED across successive cuts of the
  // same leg, so an anonymous marker cannot distinguish "my cut is still running" from
  // "a later cut took this unit and my operation is long gone" — and the DONE sentinel a
  // stale reader then picks up belongs to that other cut, which reads as a success the
  // operation never had. Stamping the ids here is what lets restart discovery correlate
  // a live unit back to its journal row instead of guessing from the log.
  // `STARTED:<epoch>` stays the FIRST line so a marker written by an older launcher, or
  // read by an older parser, still resolves.
  const operationId = env.PAPERCUSP_RELEASE_OPERATION_ID;
  const markerTaskId = env.PAPERCUSP_RELEASE_TASK_ID;
  const startedMarker =
    operationId && markerTaskId
      ? `printf 'STARTED:%s\\nOPERATION:%s\\nTASK:%s\\n' "$(date +%s)" ${shellSingleQuote(operationId)} ${shellSingleQuote(markerTaskId)} > ${started}; `
      : `printf 'STARTED:%s\\n' "$(date +%s)" > ${started}; `;
  const inner =
    `exec 9>${shellSingleQuote(lock)}; flock -n 9 || { echo 'release_cut_slot_busy' >&2; exit 73; }; ` +
    `rm -f ${done}; ${currentStatusPointers}${startedMarker}systemd-notify --ready || exit $?; ` +
    `${resumeReset}${envPrefix} ${cutterInvocation} > ${log} 2>&1; echo "DONE:$?" > ${done}`;
  return [
    '--user',
    ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
    `--unit=${unit}`,
    `--slice=${TASK_ROOT_SLICE}`,
    '--property=Type=notify',
    // READY comes from the shell's systemd-notify child, not the main bash PID.
    // Without this, systemd discards it and kills a running cut at its startup deadline.
    '--property=NotifyAccess=all',
    `--working-directory=${root}`,
    `--setenv=PATH=${pathEnv}`,
    'bash',
    '-c',
    inner,
  ];
}

export type SpawnLike = typeof spawn;

export interface LaunchCutOpts {
  version: string;
  channel: Channel;
  /** Exact 40-char superproject commit this cut is authorized to package. */
  expectedSourceSha: string;
  runtime: CutRuntimeEnv;
  legs?: CutLegs;
  /** papercusp-desktop root (default desktopRoot()). */
  root?: string;
  /** Current papercusp-desktop tooling root. The selected `root` still owns all
   * target bytes and artifact paths; only orchestration is sourced from here. */
  orchestratorRoot?: string;
  /** Fire ONE platform leg on its own unit/log/done (WI-4233 fleet-split support) instead
   *  of the legacy whole-cut unit. Omitted ⇒ unchanged whole-cut behavior. */
  platform?: Platform;
}

export interface LaunchCutResult {
  launched: boolean;
  unit: string;
  version: string;
  channel: Channel;
  legs: CutLegs;
  /** systemd-run argv actually run (or that would be run). */
  argv: string[];
  logPath: string;
  donePath: string;
  /** Managed-release journal identity this cut runs under, or null for an unmanaged cut.
   *  Returned so the caller records WHICH operation it fired in its audit entry — a cut
   *  whose id lives only in the detached unit's env is unrecoverable once it dies. */
  operationId: string | null;
  taskId: string | null;
  /** Present on a launch failure (e.g. the unit already exists ⇒ a cut is in flight). */
  reason?: string;
}

/**
 * Fire the LOCAL cut as a DETACHED transient systemd unit (survives a compaction /
 * relaunch of THIS operator — a 35–60 min build cannot be an awaited child). Returns
 * once systemd-run has accepted/refused the unit; the cut's OUTCOME is read later via
 * readCutStatus (the DONE sentinel + log), not by this caller.
 *
 * `spawnFn` is injectable so the tool handler is unit-testable without launching anything.
 */
export function launchDetachedCut(opts: LaunchCutOpts, spawnFn: SpawnLike = spawn): Promise<LaunchCutResult> {
  const root = opts.root ?? desktopRoot();
  const orchestratorRoot = opts.orchestratorRoot ?? desktopRoot();
  const legs = opts.legs ?? {};
  const argv = buildCutArgv(
    root,
    opts.version,
    opts.channel,
    legs,
    opts.expectedSourceSha,
    process.env.PATH ?? '',
    opts.runtime,
    opts.platform,
    orchestratorRoot,
  );
  return new Promise<LaunchCutResult>((resolve) => {
    const base: LaunchCutResult = {
      launched: false,
      unit: opts.runtime.releaseTaskId?.trim()
        ? cutUnitForTask(opts.runtime.releaseTaskId.trim())
        : cutUnitFor(opts.platform),
      version: opts.version,
      channel: opts.channel,
      legs,
      argv,
      logPath: cutLogFor(opts.platform),
      donePath: cutDoneFor(opts.platform),
      operationId: opts.runtime.releaseOperationId?.trim() || null,
      taskId: opts.runtime.releaseTaskId?.trim() || null,
    };
    let stderr = '';
    const child = spawnFn('systemd-run', argv);
    child.stderr?.on('data', (d: unknown) => (stderr += String(d)));
    child.on('error', (e: unknown) => {
      resolve({ ...base, launched: false, reason: e instanceof Error ? e.message : String(e) });
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ ...base, launched: true });
      } else {
        resolve({
          ...base,
          launched: false,
          reason: `systemd-run exited ${code} (a cut may already be in flight): ${stderr.trim().slice(0, 200)}`,
        });
      }
    });
  });
}

// ─── Status (poll a detached cut) ──────────────────────────────────────────────

export type CutStateKind = 'idle' | 'running' | 'done' | 'failed' | 'interrupted';

/** Who the on-host sentinels belong to, read back off the started marker (P-001).
 *  `null` on every field for an UNMANAGED cut (no journal ids were threaded) — which is
 *  distinct from "no marker at all", reported as a `null` operation on CutStatus. */
export interface CutOperationMarker {
  operationId: string | null;
  taskId: string | null;
  /** Epoch SECONDS as written by the wrapper's `date +%s` (null if unparseable). */
  startedAtSec: number | null;
}

export interface CutStatus {
  state: CutStateKind;
  running: boolean;
  /** The cut's exit code once the DONE sentinel exists (null while running / idle). */
  exitCode: number | null;
  /** Last lines of the cut log (null if no log yet). */
  logTail: string | null;
  logPath: string;
  donePath: string;
  /** Identity stamped by the launch wrapper; null when no started marker exists.
   *  Restart discovery correlates THIS against the journal — the sentinels are shared
   *  per platform, so without it a stale operation reads a newer cut's DONE sentinel
   *  as its own outcome. */
  operation: CutOperationMarker | null;
}

/** Pure: parse the started-marker body. Tolerates the pre-P-001 `STARTED:<epoch>` form
 *  (an in-flight cut launched by the older wrapper) by reporting null ids rather than
 *  failing — an unidentified marker is a real, representable state, not an error. */
export function parseCutStartedMarker(text: string): CutOperationMarker {
  const startedAt = text.match(/^STARTED:(\d+)/m);
  const operation = text.match(/^OPERATION:(.+)$/m);
  const task = text.match(/^TASK:(.+)$/m);
  return {
    operationId: operation?.[1]?.trim() || null,
    taskId: task?.[1]?.trim() || null,
    startedAtSec: startedAt ? Number(startedAt[1]) : null,
  };
}

function cutTaskIdFromStartedMarker(
  startedPath: string,
  exists: (path: string) => boolean,
  read: (path: string) => string,
): string | null {
  if (!exists(startedPath)) return null;
  try {
    return parseCutStartedMarker(read(startedPath)).taskId;
  } catch {
    return null;
  }
}

function cutUnitFromStartedMarker(
  platform: Platform | undefined,
  exists: (path: string) => boolean,
  read: (path: string) => string,
): string {
  const taskId = cutTaskIdFromStartedMarker(cutStartedFor(platform), exists, read);
  return taskId ? cutUnitForTask(taskId) : cutUnitFor(platform);
}

export interface ReadCutStatusDeps {
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
  /** Whether the transient unit is currently active (systemctl --user is-active). */
  isUnitActive?: (unit: string) => boolean;
  /** Read ONE platform leg's status (WI-4233) instead of the legacy whole-cut unit. */
  platform?: Platform;
  /** Select one registered cut root's status files instead of the latest host-wide cut. */
  root?: string;
}

/** Default: `systemctl --user is-active <unit>` → true only on exit 0 ("active"). */
export function defaultIsUnitActive(unit: string): boolean {
  try {
    const out = execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).trim();
    return out === 'active' || out === 'activating';
  } catch {
    // Non-zero exit = inactive/failed/unknown unit → not running.
    return false;
  }
}

/**
 * `systemctl --user is-active <unit>` without blocking the event loop: the raw
 * ActiveState, or '' when systemctl could not answer. `is-active` exits non-zero
 * for every state except active, and still prints the state, so stdout is read
 * on both paths.
 */
export async function readUnitActiveStateAsync(unit: string): Promise<string> {
  try {
    const { stdout } = await execFileViaSidecar(
      'systemctl',
      ['--user', 'is-active', unit],
      { timeoutMs: 5000, subsystem: 'release-cut-launch' },
    );
    return stdout.trim();
  } catch (err) {
    // `is-active` exits non-zero for inactive/failed states but prints ActiveState
    // to stdout. execFileViaSidecar preserves that stdout on its rejection shape.
    const stdout = (err as { stdout?: unknown } | null)?.stdout;
    return typeof stdout === 'string' ? stdout.trim() : '';
  }
}

/** Async {@link defaultIsUnitActive}: true only for active/activating. */
export async function defaultIsUnitActiveAsync(unit: string): Promise<boolean> {
  const state = await readUnitActiveStateAsync(unit);
  return state === 'active' || state === 'activating';
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/**
 * Read the current cut status. READ-ONLY. The DONE sentinel is authoritative for
 * completion (the launch `rm -f`s it at start, so a stale sentinel from a prior cut is
 * cleared the moment a new cut begins). The started marker is written by the detached
 * wrapper before the builder runs, so an inactive unit with that marker but no DONE
 * sentinel is an interrupted cut, not an idle host. Precedence: unit-active ⇒ running;
 * else sentinel ⇒ done/failed by exit code; else started marker ⇒ interrupted; else idle.
 */
export function readCutStatus(deps: ReadCutStatusDeps = {}): CutStatus {
  const probe = cutStatusProbe(deps);
  return cutStatusFrom(probe, (deps.isUnitActive ?? defaultIsUnitActive)(probe.unit));
}

export interface ReadCutStatusAsyncDeps extends Omit<ReadCutStatusDeps, 'isUnitActive'> {
  /** Async unit probe; defaults to {@link defaultIsUnitActiveAsync}. */
  isUnitActiveAsync?: (unit: string) => Promise<boolean>;
}

/**
 * {@link readCutStatus} with the systemd probe off the event loop
 * (jev-memory-timeouts-to-zero-2026-10-01). The sync probe is an execFileSync
 * that froze the calling worker for 50-240 ms per read on this host; the
 * liveness alarm runs it on every tick. Same marker reads, same precedence.
 */
export async function readCutStatusAsync(deps: ReadCutStatusAsyncDeps = {}): Promise<CutStatus> {
  const probe = cutStatusProbe(deps);
  return cutStatusFrom(probe, await (deps.isUnitActiveAsync ?? defaultIsUnitActiveAsync)(probe.unit));
}

interface CutStatusProbe {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  logPath: string;
  donePath: string;
  startedSeen: boolean;
  operation: CutOperationMarker | null;
  unit: string;
}

/** The marker reads that decide WHICH unit to ask systemd about. */
function cutStatusProbe(deps: Omit<ReadCutStatusDeps, 'isUnitActive'>): CutStatusProbe {
  const exists = deps.existsSync ?? ((p: string) => fs.existsSync(p));
  const read = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const startedPath = cutStartedFor(deps.platform, deps.root);

  const startedSeen = exists(startedPath);
  let operation: CutOperationMarker | null = null;
  if (startedSeen) {
    try {
      operation = parseCutStartedMarker(read(startedPath));
    } catch {
      operation = { operationId: null, taskId: null, startedAtSec: null };
    }
  }
  const unit = operation?.taskId ? cutUnitForTask(operation.taskId) : cutUnitFor(deps.platform);
  return {
    exists,
    read,
    logPath: cutLogFor(deps.platform, deps.root),
    donePath: cutDoneFor(deps.platform, deps.root),
    startedSeen,
    operation,
    unit,
  };
}

/**
 * The rest of the status, read AFTER the unit probe answered, so a cut that ends
 * between the two reads lands as running-or-done, never as interrupted.
 */
function cutStatusFrom(probe: CutStatusProbe, running: boolean): CutStatus {
  const { exists, read, logPath, donePath, startedSeen, operation } = probe;
  let exitCode: number | null = null;
  let doneSeen = false;
  if (exists(donePath)) {
    const m = read(donePath).trim().match(/^DONE:(-?\d+)/);
    if (m) {
      exitCode = Number(m[1]);
      doneSeen = true;
    }
  }
  // A marker that exists but cannot be read is still evidence a cut STARTED, so the
  // state machine above keeps the interrupted/running decision and only identity degrades.
  const logTail = exists(logPath) ? tailLines(read(logPath), 40) : null;

  let state: CutStateKind;
  if (running) state = 'running';
  else if (doneSeen) state = exitCode === 0 ? 'done' : 'failed';
  else if (startedSeen) state = 'interrupted';
  else state = 'idle';

  return { state, running, exitCode, logTail, logPath, donePath, operation };
}

// ─── Hand-off (collect the LOCAL deliverable) ──────────────────────────────────

export interface HandoffArtifact {
  path: string;
  name: string;
  bytes: number;
  sha256: string;
  /** True iff a sibling `<artifact>.sig` (minisign) exists — the updater signature. */
  signed: boolean;
}

export interface HandoffResult {
  version: string;
  targetRoot: string;
  /** Every root actually scanned: targetRoot + the cargo target_directory when relocated
   *  (the linux leg's bundles land there, not under src-tauri/target — WI-4243). */
  scannedRoots: string[];
  found: boolean;
  artifacts: HandoffArtifact[];
  /** latest.json manifest path(s). */
  manifests: string[];
  /** build-provenance.json path(s). */
  provenance: string[];
  /** UPDATER artifacts (isUpdaterArtifact) missing their `.sig` — a hand-off blocker
   *  (the updater can't verify them). */
  unsignedNames: string[];
  /** NON-updater artifacts (dmg / exe / msi / .bin slices / deb) without a `.sig` —
   *  informational only, NOT a blocker: these aren't updater-feed artifacts, so a missing
   *  minisign sig is expected (WI-4243: the old blanket blocker false-alarmed on dmgs). */
  unsignedInfoNames: string[];
}

/** Installer/updater artifact extensions the cut produces across the three platforms. */
const ARTIFACT_EXTS = ['.AppImage', '.deb', '.dmg', '.app.tar.gz', '.exe', '.msi', '.nsis.zip'] as const;
/** Inno Setup disk-spanning payload slices (`X-setup-1.bin`): the Windows Server installer
 *  exceeds Inno's single-file limit, so its setup.exe reads sibling .bin slices — they are
 *  shippable artifacts the owner MUST upload next to the setup.exe (WI-4243). */
const INNO_SLICE_RE = /-setup-\d+\.bin$/;

export function isReleaseArtifact(name: string): boolean {
  return ARTIFACT_EXTS.some((e) => name.endsWith(e)) || INNO_SLICE_RE.test(name);
}

/** The tauri-UPDATER feed artifact types — the ones whose minisign `.sig` the updater
 *  actually verifies. Everything else (dmg, deb, setup.exe, msi, .bin slices) installs
 *  through OS-native paths, so a missing .sig there is informational, never a blocker. */
const UPDATER_EXTS = ['.app.tar.gz', '.AppImage', '.nsis.zip'] as const;

export function isUpdaterArtifact(name: string): boolean {
  return UPDATER_EXTS.some((e) => name.endsWith(e));
}

// Cargo/target build-intermediate dirs to prune from the walk (target/ is huge; the
// bundles live only under `**/bundle/**`, latest.json + build-provenance.json near them).
const PRUNE_DIRS = new Set(['deps', 'build', '.fingerprint', 'incremental', 'examples', 'node_modules']);

/** Default recursive file list under `dir`, pruning cargo build-intermediate subtrees. */
export function defaultListFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (PRUNE_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

export function defaultSha256(p: string): string {
  // Shell out to sha256sum (matches release-local.sh) — streams large (multi-GB) artifacts
  // without reading them wholesale into memory.
  return execFileSync('sha256sum', [p], { encoding: 'utf8', maxBuffer: 1 << 20 }).trim().split(/\s+/)[0];
}

/** The cargo `target_directory` for this checkout — mirrors release-local.sh's own
 *  CARGO_TARGET_ROOT derivation (its line ~713) exactly: `cargo metadata` at src-tauri,
 *  null when unresolvable. On a stock checkout this IS src-tauri/target; on a relocated
 *  one (CARGO_TARGET_DIR, e.g. ~/.cargo-target on the dev box) the linux leg's bundles
 *  live ONLY here — the root the old single-root walk missed (WI-4243). */
export function defaultCargoTargetRoot(root: string): string | null {
  try {
    const out = execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
      cwd: path.join(root, 'src-tauri'),
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
    const td = (JSON.parse(out) as { target_directory?: string }).target_directory;
    return td && td.length > 0 ? td : null;
  } catch {
    return null;
  }
}

export interface CollectHandoffDeps {
  exists?: (p: string) => boolean;
  listFiles?: (dir: string) => string[];
  fileSize?: (p: string) => number;
  sha256?: (p: string) => string;
  /** Read a build-provenance.json (utf8). */
  readFile?: (p: string) => string;
  /** Resolve the cargo target_directory for the desktop root (null ⇒ skip that root). */
  cargoTargetRoot?: (root: string) => string | null;
  /** Canonicalize a path for root de-duplication (src-tauri/target is often a symlink
   *  to the relocated cargo target dir — same tree, two spellings). */
  realpath?: (p: string) => string;
}

/**
 * Collect the LOCAL hand-off set for `version` from the cut output (RELEASE-RUNBOOK §5):
 * every installer/updater artifact + whether its `.sig` is present, plus the latest.json
 * manifests and build-provenance.json files, with each artifact's sha256. Scans BOTH
 * `src-tauri/target` AND the cargo target_directory when relocated (the linux leg).
 * Artifacts are found two ways (WI-4243):
 *   1. walk: version-named installers inside a bundle/ dir (P-009 `*_<version>_*` parity);
 *   2. provenance: every artifact a version-matching build-provenance.json records —
 *      this is what catches the mac updater tarballs (`Papercusp GUI.app.tar.gz` carries
 *      NO version in its filename, so the walk's name filter can never see it).
 * Pure over injectable fs deps (unit-testable against a fake tree). Does NOT touch
 * GitHub — the caller hands these paths to the owner.
 */
export function collectHandoff(
  version: string,
  opts: { root?: string } = {},
  deps: CollectHandoffDeps = {},
): HandoffResult {
  const root = opts.root ?? desktopRoot();
  const targetRoot = path.join(root, 'src-tauri', 'target');
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const list = deps.listFiles ?? defaultListFiles;
  const size = deps.fileSize ?? ((p: string) => fs.statSync(p).size);
  const sha = deps.sha256 ?? defaultSha256;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const cargoRoot = deps.cargoTargetRoot ?? defaultCargoTargetRoot;
  const real =
    deps.realpath ??
    ((p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    });

  // Roots to scan: src-tauri/target + the cargo target_directory when it's a DIFFERENT
  // tree (realpath-compared — on the dev box src-tauri/target symlinks elsewhere while
  // the linux leg writes to ~/.cargo-target; on a stock checkout they're one tree).
  const scannedRoots: string[] = [];
  const seenReal = new Set<string>();
  for (const r of [targetRoot, cargoRoot(root)]) {
    if (!r || !exists(r)) continue;
    const rp = real(r);
    if (seenReal.has(rp)) continue;
    seenReal.add(rp);
    scannedRoots.push(r);
  }

  const empty: HandoffResult = {
    version,
    targetRoot,
    scannedRoots,
    found: false,
    artifacts: [],
    manifests: [],
    provenance: [],
    unsignedNames: [],
    unsignedInfoNames: [],
  };
  if (scannedRoots.length === 0) return empty;

  const files = scannedRoots.flatMap((r) => list(r));
  const sigs = new Set(files.filter((f) => f.endsWith('.sig')));
  const artifacts: HandoffArtifact[] = [];
  const manifests: string[] = [];
  const provenance: string[] = [];
  const collected = new Set<string>();

  for (const f of files) {
    const name = path.basename(f);
    if (name === 'latest.json') {
      manifests.push(f);
      continue;
    }
    if (name === 'build-provenance.json') {
      provenance.push(f);
      continue;
    }
    // Only actual installers, inside a bundle/ dir, scoped to this version (P-009 parity).
    if (!f.includes(`${path.sep}bundle${path.sep}`)) continue;
    if (!isReleaseArtifact(name)) continue;
    if (!name.includes(version)) continue;
    if (collected.has(f)) continue;
    collected.add(f);
    artifacts.push({ path: f, name, bytes: size(f), sha256: sha(f), signed: sigs.has(`${f}.sig`) });
  }

  // Pass 2 (WI-4243): trust each version-matching build-provenance.json for artifacts the
  // name filter can't see (the versionless mac `<App>.app.tar.gz` updater tarballs).
  // Provenance `name`s are OUT_DIR-relative subpaths (post-WI-4243 emitter) — resolve
  // against the provenance's own dir; for pre-fix basename-only provenance, fall back to
  // a unique-basename match among the walked files under that root.
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    const b = path.basename(f);
    const arr = byBase.get(b);
    if (arr) arr.push(f);
    else byBase.set(b, [f]);
  }
  for (const provPath of provenance) {
    let prov: { version?: string; artifacts?: { name?: unknown }[] };
    try {
      prov = JSON.parse(readFile(provPath)) as typeof prov;
    } catch {
      continue;
    }
    if (prov?.version !== version || !Array.isArray(prov.artifacts)) continue;
    const provDir = path.dirname(provPath);
    for (const a of prov.artifacts) {
      if (typeof a?.name !== 'string' || a.name.length === 0) continue;
      let f: string | null = path.join(provDir, a.name);
      if (!exists(f)) {
        const candidates = (byBase.get(path.basename(a.name)) ?? []).filter(
          (c) => c.startsWith(`${provDir}${path.sep}`) && !c.endsWith('.sig'),
        );
        f = candidates.length === 1 ? candidates[0]! : null;
      }
      if (!f || collected.has(f)) continue;
      collected.add(f);
      artifacts.push({
        path: f,
        name: a.name,
        bytes: size(f),
        sha256: sha(f),
        signed: sigs.has(`${f}.sig`) || exists(`${f}.sig`),
      });
    }
  }

  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  manifests.sort();
  provenance.sort();
  const unsigned = artifacts.filter((a) => !a.signed);
  const unsignedNames = unsigned.filter((a) => isUpdaterArtifact(a.name)).map((a) => a.name);
  const unsignedInfoNames = unsigned.filter((a) => !isUpdaterArtifact(a.name)).map((a) => a.name);

  return {
    version,
    targetRoot,
    scannedRoots,
    found: artifacts.length > 0,
    artifacts,
    manifests,
    provenance,
    unsignedNames,
    unsignedInfoNames,
  };
}

// ─── Preflight (READ-ONLY go/no-go before a cut) ───────────────────────────────

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** true ⇒ ok:false is only a WARNING (cut can still proceed), not a hard blocker. */
  warnOnly?: boolean;
}

export interface PreflightResult {
  go: boolean;
  desktopRoot: string;
  checks: PreflightCheck[];
  /** Hard blockers (ok:false && !warnOnly) — go is false iff this is non-empty. */
  blockers: string[];
}

/**
 * The subtree holding release MACHINERY — the scripts that PERFORM a cut.
 *
 * A cut tree mixes two things that are governed differently. WHAT is being shipped
 * (product source) is deliberately pinned to an exact sha by an isolated cut root —
 * resolveCutRoot refuses auto-managed checkouts precisely so the tree cannot move
 * mid-build — so drift there is CORRECT and must never be reported as a fault. The
 * machinery performing the ship is the opposite: a bug in it corrupts the release
 * process no matter which version is being shipped, so a frozen root silently
 * re-executes whatever release bugs its pin carried.
 *
 * Only the second kind is a hazard, which is why this check is scoped to a subtree
 * rather than to the tree as a whole.
 */
export const RELEASE_TOOLING_SUBTREE = 'bin';

/** These changed scripts are either the current sourced cutter/producer or
 * optional diagnostics outside the local artifact cut. A future target-tree
 * invocation of one of them revokes the exception at preflight time. Unknown
 * changed scripts remain hard blockers. */
const CURRENT_CUT_TOOLING = new Set([
  'bin/release-local.sh',
  'bin/build-desktop-sidecar.sh',
  'bin/install-and-relaunch-verify.sh',
  'bin/lib/federation-asserts.selftest.sh',
  'bin/live-federation-gate.sh',
  'bin/vm-rig/boot-headless-current.sh',
]);

function targetExecutedStaleTooling(staleFiles: string[], currentCutter: string | null): string[] {
  if (currentCutter === null) return staleFiles; // unreadable current cutter is unmeasured
  const targetReferences = new Set<string>();
  for (const line of currentCutter.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    for (const match of line.matchAll(/\$(?:ROOT|\{ROOT\})\/(bin\/[A-Za-z0-9_./-]+)/g)) {
      targetReferences.add(match[1]!);
    }
  }
  return staleFiles.filter((file) => !CURRENT_CUT_TOOLING.has(file) || targetReferences.has(file));
}

/** Runs git in `repo`. `ok` reflects the EXIT STATUS, which is the answer itself for
 * predicates like `merge-base --is-ancestor` that communicate through exit code and
 * write nothing to stdout. */
export type GitRunner = (repo: string, args: string[]) => { ok: boolean; stdout: string };

export interface ReleaseToolingDrift {
  /** `behind` ⇒ subject is an ancestor of reference, so a differing file is genuinely
   * superseded. `diverged` ⇒ the pins are unrelated or the subject is ahead, which a
   * deliberate pin can legitimately produce. `unknown` ⇒ NOT MEASURED — never clean. */
  state: 'current' | 'behind' | 'diverged' | 'unknown';
  staleFiles: string[];
  subjectPin?: string;
  referencePin?: string;
  detail?: string;
}

function defaultGitRunner(repo: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 20,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/**
 * The branch whose submodule pin is the freshness REFERENCE for release machinery: the
 * GREEN branch, i.e. machinery that has passed the gate.
 *
 * It used to be the integration branch (`staging`). That made the check unpassable by
 * construction: staging's desktop pin moves on every git-sync sweep, while a cut root is
 * pinned to a green-main sha that is always behind it, so ANY staging edit to ANY bin/
 * file — a federation test-rig script the cut never runs — re-blocked every exact-source
 * cut. The 0.0.22-alpha cut was refused three times this way (EI-24294628776810491), the
 * last time by a peer's nightly-channel commit landing one minute before preflight.
 * Release machinery that has not passed the gate is not a "fix the cut must carry"; a cut
 * from the latest green main reads 'current', and an older pin still reads 'behind'.
 */
export const RELEASE_TOOLING_REFERENCE_BRANCH = 'main';

/**
 * Compare the release machinery in an isolated cut root against the GREEN BRANCH's pin
 * of the same submodule (see RELEASE_TOOLING_REFERENCE_BRANCH).
 *
 * The reference is deliberately a BRANCH REF, NOT a checkout path. It used to be
 * `desktopRoot()`, which resolves from `cwd` — and release:cut runs inside the :3070
 * operator, whose cwd is the release checkout at whatever green sha was last DEPLOYED.
 * That is routinely the very sha a stale cut root is pinned to, so the comparison read
 * stale-vs-stale as 'current' and the check was vacuous in exactly the case it exists
 * for (WI-10002449, caught by a live probe against the real paused root after every unit
 * test was green). The `main` ref advances on every green promotion regardless of
 * whether a deploy followed, so a root frozen at an older green sha reads 'behind'. A cut
 * root is a linked worktree sharing the canonical .git, so the branch ref is readable
 * from the root itself and needs no path guess.
 *
 * The stale-file list is DERIVED from git rather than compared against a hand-kept
 * roster of "release-critical scripts" — such a roster rots silently, and a file
 * missing from it reads exactly like a file that did not change.
 */
export function releaseToolingDrift(args: {
  subjectDesktopRoot: string;
  /** Default RELEASE_TOOLING_REFERENCE_BRANCH (the green branch). */
  referenceBranch?: string;
  git?: GitRunner;
}): ReleaseToolingDrift {
  const { subjectDesktopRoot } = args;
  const git = args.git ?? defaultGitRunner;
  const branch = args.referenceBranch ?? RELEASE_TOOLING_REFERENCE_BRANCH;
  const superproject = path.dirname(subjectDesktopRoot);
  const submodule = path.basename(subjectDesktopRoot);

  const subject = git(subjectDesktopRoot, ['rev-parse', 'HEAD']);
  const subjectPin = subject.ok ? subject.stdout.trim() : '';
  if (!subjectPin) {
    return { state: 'unknown', staleFiles: [], detail: `could not resolve HEAD in ${subjectDesktopRoot}` };
  }
  const reference = git(superproject, ['rev-parse', `${branch}:${submodule}`]);
  const referencePin = reference.ok ? reference.stdout.trim() : '';
  if (!referencePin) {
    return {
      state: 'unknown',
      staleFiles: [],
      subjectPin,
      detail: `could not resolve the ${branch} branch's pin of ${submodule} from ${superproject}`,
    };
  }
  if (subjectPin === referencePin) {
    return { state: 'current', staleFiles: [], subjectPin, referencePin };
  }

  // A cut root's submodule is typically a STANDALONE clone that has never fetched the
  // newer pin, while the shared superproject store (<common-dir>/modules/<submodule>)
  // holds both. Every later question needs BOTH commits readable in ONE store: an
  // unreadable object makes `diff` answer with an empty file list, byte-identical to
  // "nothing drifted" — the reading that would wave a stale root straight through.
  const common = git(superproject, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const candidates = [
    ...(common.ok && common.stdout.trim() ? [path.join(common.stdout.trim(), 'modules', submodule)] : []),
    subjectDesktopRoot,
  ];
  const store = candidates.find((repo) =>
    [subjectPin, referencePin].every((pin) => git(repo, ['cat-file', '-e', `${pin}^{commit}`]).ok),
  );
  if (!store) {
    return {
      state: 'unknown',
      staleFiles: [],
      subjectPin,
      referencePin,
      detail: `no object store holds both ${subjectPin.slice(0, 12)} and ${referencePin.slice(0, 12)} (tried ${candidates.join(', ')})`,
    };
  }

  const diff = git(store, [
    'diff',
    '--name-only',
    subjectPin,
    referencePin,
    '--',
    RELEASE_TOOLING_SUBTREE,
  ]);
  if (!diff.ok) {
    return { state: 'unknown', staleFiles: [], subjectPin, referencePin, detail: 'git diff failed' };
  }
  const staleFiles = diff.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();

  const behind = git(store, ['merge-base', '--is-ancestor', subjectPin, referencePin]).ok;
  return { state: behind ? 'behind' : 'diverged', staleFiles, subjectPin, referencePin };
}

export interface PreflightDeps {
  exists?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
  isUnitActive?: (unit: string) => boolean;
  /** HOME for resolving the signing key (default process.env.HOME). */
  home?: string;
  /** Override the release-tooling staleness probe (tests inject; default compares the
   * cut root against its integration branch's pin of the same submodule). */
  releaseToolingDrift?: (subjectDesktopRoot: string) => ReleaseToolingDrift;
  /** Exact current release-local.sh source; injected by pure tests. */
  readOrchestratorScript?: (scriptPath: string) => string;
  /** Validate the cut workspace marker with the canonical release identity reader. */
  readDependencyGeneration?: (workspace: string, identityScript: string) => string;
  /** The sha an exact release tag points at on `remote` (null = the tag is absent); throws
   *  when the remote cannot be read. Default: `git ls-remote`. Tests inject. */
  remoteTagSha?: (monorepo: string, tag: string, remote: string) => string | null;
  /** Run bin/smoke-target-preflight.sh for one native smoke target (WI-10004346).
   *  Default: a bounded read-only `bash <script> --platform <p>`. Tests inject. */
  runSmokeTargetPreflight?: (scriptPath: string, platform: 'mac' | 'windows') => SmokeTargetProbe;
}

/** Raw result of bin/smoke-target-preflight.sh. exitCode null = it did not finish
 *  (timeout / spawn failure), which is unmeasured, never READY. */
export interface SmokeTargetProbe {
  exitCode: number | null;
  output: string;
}

function defaultRunSmokeTargetPreflight(scriptPath: string, platform: 'mac' | 'windows'): SmokeTargetProbe {
  const res = spawnSync('bash', [scriptPath, '--platform', platform], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return { exitCode: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error.message}` : ''}` };
}

/**
 * The native installed-upgrade smoke TARGET check (WI-10004346). Preflight used to
 * confirm only that the verify SCRIPTS exist; 0.0.26 then burned a full cut before
 * both native smokes refused on their TARGETS (Mac rig not ready, Windows VM stopped).
 * This runs the shared read-only detector so that is visible BEFORE the build.
 * Always warnOnly: the cut can run; the smoke is a downstream ship-gate.
 */
export function smokeTargetCheck(
  platform: 'mac' | 'windows',
  scriptPath: string,
  exists: (p: string) => boolean,
  run: (scriptPath: string, platform: 'mac' | 'windows') => SmokeTargetProbe,
): PreflightCheck {
  const name = `smoke-target:${platform}`;
  if (!exists(scriptPath)) {
    return { name, ok: false, warnOnly: true, detail: `missing ${scriptPath} — native smoke target readiness is UNMEASURED` };
  }
  const probe = run(scriptPath, platform);
  const blockers = probe.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('SMOKE_TARGET_BLOCKER'));
  const tail = blockers.length ? ` — ${blockers.join('; ')}` : '';
  switch (probe.exitCode) {
    case 0:
      return { name, ok: true, warnOnly: true, detail: `${platform} smoke target READY` };
    case 2:
      return { name, ok: false, warnOnly: true, detail: `${platform} smoke target NOT-READY${tail}` };
    case 3: {
      const hint = probe.output.trim().split('\n').slice(-1)[0] ?? '';
      return { name, ok: false, warnOnly: true, detail: `${platform} smoke target STOPPED — boot it before the smoke step${hint ? `: ${hint}` : ''}` };
    }
    default:
      return {
        name,
        ok: false,
        warnOnly: true,
        detail: `${platform} smoke target UNMEASURED (detector exit ${probe.exitCode ?? 'none — timed out or failed to spawn'})${tail}`,
      };
  }
}

/** The public remote the shipped app clones its dogfood hive from. release-local.sh
 *  certifies the dogfood pin against this exact URL (`PAPERCUP_DOGFOOD_CANONICAL_REMOTE`);
 *  release-cut-launch.test.ts pins the two to the same value. */
export const DOGFOOD_CANONICAL_REMOTE = 'https://github.com/Papercusp/papercup';

/** Same naming rule as release-local.sh's `desktop_release_tag` (bin/lib/gen-latest-manifest.sh). */
export function desktopReleaseTag(version: string, channel: Channel): string {
  return channel === 'stable' ? `desktop-v${version}` : `desktop-v${version}-${channel}`;
}

function defaultRemoteTagSha(monorepo: string, tag: string, remote: string): string | null {
  const out = execFileSync('git', ['-C', monorepo, 'ls-remote', '--refs', '--tags', remote, `refs/tags/${tag}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
  const first = out.split('\n').find((line) => line.trim().length > 0);
  return first ? first.trim().split(/\s+/)[0] : null;
}

function readDependencyGeneration(workspace: string, identityScript: string): string {
  // Run the existing CommonJS reader from the orchestrator tree, not a second
  // parser or the frozen target's potentially stale release machinery.
  return execFileSync(process.execPath, [
    '-e',
    'try { process.stdout.write(require(process.argv[1]).dependencyMarkerFields(process.argv[2]).identity); } ' +
      'catch (error) { console.error(error.message); process.exitCode = 1; }',
    identityScript,
    workspace,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
}

/**
 * Pure-ish preflight: verify the cut CAN run cleanly before firing the ~35-min build —
 * the signing key, the runtime dependency used by release-local.sh's pre-build
 * migration lint, release-local.sh + the three verify scripts (RELEASE-RUNBOOK §2–4)
 * that compose under this cut, and that no cut is already in flight. Requested optional
 * legs (mac/windows) add an informational line naming their native Linux cross-build
 * producer (no VM). No heavy work, no mutation. The only network read is the exact
 * release-tag probe (`git ls-remote`), made only when `opts.release` names the release.
 */
export function preflightCut(
  legs: CutLegs = {},
  opts: {
    root?: string;
    platform?: Platform;
    orchestratorRoot?: string;
    /** The release this cut would produce. When given, preflight also checks the exact
     *  dogfood-pin tag on the canonical remote (EI-24611322499942803). */
    release?: { version: string; channel: Channel; sourceSha: string };
    /** Build-only opt-in; defers the tag probe, never signing/source gates. */
    deferTag?: boolean;
  } = {},
  deps: PreflightDeps = {},
): PreflightResult {
  const root = opts.root ?? desktopRoot();
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const read = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const active = deps.isUnitActive ?? defaultIsUnitActive;
  const home = deps.home ?? process.env.HOME ?? '';
  const unit = cutUnitFromStartedMarker(opts.platform, exists, read);

  const checks: PreflightCheck[] = [];

  const cutter = path.join(root, 'bin', 'release-local.sh');
  checks.push({
    name: 'cutter',
    ok: exists(cutter),
    detail: exists(cutter) ? cutter : `missing ${cutter} — is PAPERCUSP_DESKTOP_ROOT correct?`,
  });

  const keyFile = path.join(home, '.papercusp', 'signing', 'papercusp.key');
  checks.push({
    name: 'signing-key',
    ok: exists(keyFile),
    detail: exists(keyFile)
      ? keyFile
      : `missing ${keyFile} — updater artifacts can't be minisign-signed (bin/setup-signing-key.sh)`,
  });

  // release-local.sh invokes scripts/lint-migrations.mjs before it installs or
  // repairs dependencies. A source-only checkout therefore passes the old
  // existence checks, launches the detached cut, and fails immediately when
  // Node resolves @papercusp/operator-core. Refuse that predictable failure
  // before spending a cut unit. The entrypoint is the exact package export
  // imported by the migration lint, so this also catches a partially materialized
  // node_modules tree rather than only checking that the directory exists.
  const migrationLintEntrypoint = path.join(
    root,
    '..',
    'node_modules',
    '@papercusp',
    'operator-core',
    'lib',
    'util',
    'cli-entry.ts',
  );
  const migrationLintReady = exists(migrationLintEntrypoint);
  checks.push({
    name: 'migration-lint-dependencies',
    ok: migrationLintReady,
    detail: migrationLintReady
      ? migrationLintEntrypoint
      : 'missing ' +
        migrationLintEntrypoint +
        ' — release-local.sh runs migration lint before dependency preparation; materialize node_modules for the release checkout',
  });

  // A hardlinked node_modules tree can satisfy migration lint but lacks the
  // immutable generation marker required by every journalled platform leg.
  // Validate its contents before launching the detached build.
  const workspace = path.resolve(root, '..');
  const marker = path.join(workspace, 'node_modules', '.papercusp-dependency-generation');
  try {
    const generation = (deps.readDependencyGeneration ?? readDependencyGeneration)(
      workspace,
      path.join(opts.orchestratorRoot ?? desktopRoot(), 'bin', 'lib', 'release-content-identity.js'),
    );
    checks.push({ name: 'dependency-generation', ok: true, detail: `${marker}: ${generation}` });
  } catch (error) {
    checks.push({
      name: 'dependency-generation',
      ok: false,
      detail: `invalid or unreadable ${marker}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Re-materialize this cut workspace with setup-release-checkout.sh ' +
        '--prepare-existing --node-modules force --node-modules-copy copy --node-modules-generation required, ' +
        'keeping its --ref and --release target unchanged, then re-run preflight',
    });
  }

  for (const script of ['verify-provenance.sh', 'vm-preflight.sh', 'install-and-relaunch-verify.sh']) {
    const p = path.join(root, 'bin', script);
    checks.push({
      name: `verify:${script}`,
      ok: exists(p),
      detail: exists(p) ? p : `missing ${p} — the RELEASE-RUNBOOK verify step can't compose`,
      warnOnly: true, // the cut itself can run; verify is a downstream ship-gate
    });
  }

  const inFlight = active(unit);
  checks.push({
    name: 'no-cut-in-flight',
    ok: !inFlight,
    detail: inFlight
      ? `a cut is already running (unit ${unit}) — poll release:cut{op:status${opts.platform ? `,platform:'${opts.platform}'` : ''}} instead of starting a second`
      : 'no cut in flight',
  });

  // File availability alone cannot establish release-tooling freshness: a
  // root frozen weeks ago with superseded release scripts satisfied all of them and
  // returned go:true (WI-10002449). An isolated cut root is frozen on purpose, so the
  // fix cannot be "refuse anything behind canonical" — it has to separate the product
  // source being pinned from the machinery doing the pinning.
  // Only ask git about a tree that IS a checkout. A linked worktree carries `.git` as a
  // file rather than a directory, so existsSync covers both shapes. Without this the
  // probe would shell out against any path at all and report the resulting failure as
  // drift state 'unknown' — true, but paid for with two spawned processes per preflight.
  const defaultDrift = (subjectDesktopRoot: string): ReleaseToolingDrift =>
    exists(path.join(subjectDesktopRoot, '.git'))
      ? releaseToolingDrift({ subjectDesktopRoot })
      : {
          state: 'unknown',
          staleFiles: [],
          detail: `${path.join(subjectDesktopRoot, '.git')} not found — cut root is not a git checkout, so its release machinery cannot be dated`,
        };
  const drift = (deps.releaseToolingDrift ?? defaultDrift)(root);
  let currentCutter: string | null = null;
  if (drift.staleFiles.length > 0) {
    try {
      currentCutter = (deps.readOrchestratorScript ?? ((scriptPath) => fs.readFileSync(scriptPath, 'utf8')))(
        path.join(opts.orchestratorRoot ?? desktopRoot(), 'bin', 'release-local.sh'),
      );
    } catch {
      // A missing/unreadable current script cannot prove which frozen scripts execute.
    }
  }
  const targetStaleFiles = targetExecutedStaleTooling(drift.staleFiles, currentCutter);
  const shortPin = (pin: string | undefined) => (pin ? pin.slice(0, 12) : '?');
  const namedFiles = drift.staleFiles.slice(0, 6).join(', ') + (drift.staleFiles.length > 6 ? ', …' : '');
  let toolingOk = true;
  let toolingWarnOnly: boolean | undefined;
  let toolingDetail: string;
  switch (drift.state) {
    case 'current':
      toolingDetail =
        drift.detail ?? `release machinery matches the canonical checkout (${shortPin(drift.subjectPin)})`;
      break;
    case 'behind':
      if (targetStaleFiles.length > 0) {
        toolingOk = false;
        toolingDetail =
          `cut root's release machinery is STALE — ${targetStaleFiles.length} target-executed file(s) under papercusp-desktop/${RELEASE_TOOLING_SUBTREE} ` +
          `are superseded by green ${RELEASE_TOOLING_REFERENCE_BRANCH} (root ${shortPin(drift.subjectPin)} is an ancestor of ${RELEASE_TOOLING_REFERENCE_BRANCH}'s pin ${shortPin(drift.referencePin)}): ${targetStaleFiles.join(', ')}. ` +
          'This cut would re-execute those superseded scripts and rebuild any release bug they carried. ' +
          `re-pin the cut root with setup-release-checkout.sh at the latest green ${RELEASE_TOOLING_REFERENCE_BRANCH} commit, then re-run preflight`;
      } else if (drift.staleFiles.length > 0) {
        toolingDetail = `frozen root differs in ${drift.staleFiles.length} bin file(s) (${namedFiles}); the current release-local.sh is sourced and has no direct target-tree invocation of these files`;
      } else {
        toolingDetail = `root is behind canonical but no file under papercusp-desktop/${RELEASE_TOOLING_SUBTREE} differs — product-source drift only, which an isolated pin is supposed to have`;
      }
      break;
    case 'diverged':
      if (drift.staleFiles.length > 0) {
        toolingOk = false;
        toolingWarnOnly = true;
        toolingDetail =
          `cut root's release machinery DIVERGES from canonical (${drift.staleFiles.length} file(s): ${namedFiles}), but root ` +
          `${shortPin(drift.subjectPin)} is not an ancestor of canonical ${shortPin(drift.referencePin)} — confirm this pin is deliberate`;
      } else {
        toolingDetail = 'root diverges from canonical but its release machinery is identical';
      }
      break;
    case 'unknown':
    default:
      toolingOk = false;
      toolingWarnOnly = true;
      toolingDetail = `could NOT verify release-machinery freshness (${drift.detail ?? 'no detail'}) — treat as UNMEASURED, not as clean`;
      break;
  }
  checks.push({
    name: 'release-tooling-current',
    ok: toolingOk,
    detail: toolingDetail,
    ...(toolingWarnOnly ? { warnOnly: true } : {}),
  });

  // EI-24611322499942803: the exact dogfood-pin tag. release-local.sh refuses a cut whose
  // tag is not already on the canonical remote at the exact source sha, and only op:prepare-tag
  // creates it. Preflight used to skip this, so go:true could precede a run that was certain
  // to fail at the pin check (after bumping the manifests, which left the cut root dirty).
  if (opts.release && opts.deferTag === true) {
    checks.push({
      name: 'release-tag',
      ok: true,
      warnOnly: true,
      detail: `${desktopReleaseTag(opts.release.version, opts.release.channel)} deferred for a build-only run; ` +
        'bind the exact tag only after a containment receipt matches the built sourceSha. Candidate/GO/publication remain blocked.',
    });
  } else if (opts.release) {
    const { version, channel, sourceSha } = opts.release;
    const tag = desktopReleaseTag(version, channel);
    const where = `${DOGFOOD_CANONICAL_REMOTE} refs/tags/${tag}`;
    const prepare = `release:cut{op:'prepare-tag',version:'${version}',channel:'${channel}',sourceSha,root,confirm:true}`;
    let remoteSha: string | null = null;
    let probeError: string | null = null;
    try {
      remoteSha = (deps.remoteTagSha ?? defaultRemoteTagSha)(path.resolve(root, '..'), tag, DOGFOOD_CANONICAL_REMOTE);
    } catch (error) {
      probeError = error instanceof Error ? error.message.split('\n')[0] : String(error);
    }
    if (probeError !== null) {
      checks.push({
        name: 'release-tag',
        ok: false,
        warnOnly: true,
        detail: `could NOT read ${where} (${probeError}) — UNMEASURED, not clean. The cut still refuses before any write if the tag is missing.`,
      });
    } else if (!remoteSha) {
      checks.push({
        name: 'release-tag',
        ok: false,
        detail: `${where} is missing — run ${prepare} first. The cut verifies this exact tag and refuses without it.`,
      });
    } else if (remoteSha !== sourceSha) {
      checks.push({
        name: 'release-tag',
        ok: false,
        detail:
          `${where} points at ${remoteSha.slice(0, 12)}, not sourceSha ${sourceSha.slice(0, 12)} — the cut would refuse. ` +
          'prepare-tag never moves an existing tag: cut from the tagged sha or choose a new version.',
      });
    } else {
      checks.push({ name: 'release-tag', ok: true, detail: `${where} is at sourceSha ${sourceSha.slice(0, 12)}` });
    }
  }

  if (legs.mac) {
    checks.push({
      name: 'leg:mac',
      ok: true,
      detail: 'WITH_MAC requested — built by bin/build-mac-cross.sh, cross-compiled on Linux on this host (no VM or SSH)',
      warnOnly: true,
    });
  }
  if (legs.windows) {
    checks.push({
      name: 'leg:windows',
      ok: true,
      detail: 'WITH_WINDOWS requested — built by bin/build-windows-cross.sh, cross-compiled on Linux on this host (no VM or SSH)',
      warnOnly: true,
    });
  }
  // The legs cross-build without a VM, but their installed-upgrade SMOKE needs one.
  // The detector is release machinery, so read it from the current orchestrator tree.
  const smokeScript = path.join(opts.orchestratorRoot ?? desktopRoot(), 'bin', 'smoke-target-preflight.sh');
  const runSmoke = deps.runSmokeTargetPreflight ?? defaultRunSmokeTargetPreflight;
  for (const platform of ['mac', 'windows'] as const) {
    if (legs[platform]) checks.push(smokeTargetCheck(platform, smokeScript, exists, runSmoke));
  }

  const blockers = checks.filter((c) => !c.ok && !c.warnOnly).map((c) => `${c.name}: ${c.detail}`);
  return { go: blockers.length === 0, desktopRoot: root, checks, blockers };
}

// ─── Abort a leg (WI-4233) ──────────────────────────────────────────────────────

export interface AbortLegResult {
  stopped: boolean;
  unit: string;
  reason?: string;
}

export interface AbortLegDeps {
  /** `systemctl --user stop <unit>` by default; throws on failure. Injectable for tests. */
  stopUnit?: (unit: string) => void;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
}

/** Stop ONE platform leg's detached unit (best-effort — a leg that already finished or
 *  was never started simply reports stopped:false with the systemctl error, not a throw).
 *  Its log/done files are left in place for post-mortem; the next op:run-leg for the same
 *  platform clears the done sentinel itself (buildCutArgv's `rm -f`). */
export function abortLeg(platform: Platform, deps: AbortLegDeps = {}): AbortLegResult {
  const exists = deps.existsSync ?? ((p: string) => fs.existsSync(p));
  const read = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const unit = cutUnitFromStartedMarker(platform, exists, read);
  const stop =
    deps.stopUnit ??
    ((u: string) => {
      execFileSync('systemctl', ['--user', 'stop', u], { stdio: 'ignore' });
    });
  try {
    stop(unit);
    return { stopped: true, unit };
  } catch (err) {
    return { stopped: false, unit, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ─── BUILD_SHA gate (WI-4233) — one honest sha, readable by every leg ──────────
//
// release-local.sh derives BUILD_SHA ONCE, centrally, per P-003/EI-8914 — the single
// source of truth threaded into every leg of a WHOLE cut. A fleet-split cut breaks that:
// 3 agents on 3 machines each firing their own `release-local.sh` invocation (or, before
// op:run-leg existed, raw bash around it) can each land on a DIFFERENT short sha if the
// shared tree moves between invocations (git-sync commits on a schedule) — precisely the
// confusion the 0.0.8 drive hit (BUILD_SHA history: c1d5520 → 7302dd9-dirty → b0124…,
// tracked ad hoc over coord messages because there was no shared, readable gate). The
// functions below give every leg ONE place to read (or, for the first caller, establish)
// the sha this release is cutting against, instead of re-deriving it independently and
// hoping the tree didn't move.

export interface BuildShaInfo {
  sha: string;
  dirty: boolean;
}

export interface DeriveBuildShaDeps {
  gitShortHead?: (root: string) => string;
  gitDirty?: (root: string) => boolean;
}

/** Mirrors release-local.sh's own BUILD_SHA derivation exactly (short head sha of `root`,
 *  marked dirty if EITHER `root` or its parent — the monorepo superproject, since the
 *  sidecar is built from apps/operator — has uncommitted changes; over-reporting dirty is
 *  the safe direction, same comment as release-local.sh). Lets op:gate-status report the
 *  same honest value release-local.sh would derive, without having to run it. */
export function deriveBuildSha(root: string = desktopRoot(), deps: DeriveBuildShaDeps = {}): BuildShaInfo {
  const head =
    deps.gitShortHead ??
    ((r: string) => {
      try {
        return execFileSync('git', ['-C', r, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    });
  const dirty =
    deps.gitDirty ??
    ((r: string) => {
      try {
        return execFileSync('git', ['-C', r, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
      } catch {
        return false;
      }
    });
  const sha = head(root);
  const isDirty = dirty(root) || dirty(path.join(root, '..'));
  return { sha, dirty: isDirty };
}

/** Shared gate file path for (version, channel) — one per release attempt. `/tmp` is
 *  shared only within a single box; a genuinely cross-MACHINE fleet-split (a VM leg) still
 *  needs the sha relayed in (mirrors how release-local.sh already passes BUILD_SHA into
 *  the VM legs, since their rsynced trees have no .git to self-derive from) — this gate is
 *  the LOCAL-box coordination point for legs/agents sharing this host. */
export function gatePath(version: string, channel: Channel): string {
  return `/tmp/papercup-release-gate-${version}-${channel}.json`;
}

export interface ReleaseGate {
  version: string;
  channel: Channel;
  buildSha: string;
  dirty: boolean;
  derivedAt: string;
  derivedBy: string;
}

export interface GateStatusDeps {
  /** Desktop root whose BUILD_SHA should establish a new gate. */
  root?: string;
  exists?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
  /** Exclusive create (like `fs.writeFileSync(p, data, { flag: 'wx' })`) — MUST throw if
   *  `p` already exists, so a race between two first-callers still converges on one
   *  writer. */
  writeFileSyncExclusive?: (p: string, data: string) => void;
  derive?: (root?: string) => BuildShaInfo;
}

/**
 * Read the shared release gate for (version, channel), establishing it (deriving +
 * writing) if this is the first caller. Every subsequent call — from any leg, any agent,
 * on this box — reads back the SAME buildSha instead of each independently re-deriving one
 * that may have drifted if the tree moved (git-sync) between calls. `created:true` tells
 * the caller they were the one who established it (so a leg script can log "I set the
 * gate" vs "I'm matching an existing gate").
 */
export function readOrCreateGate(
  version: string,
  channel: Channel,
  actor: string,
  deps: GateStatusDeps = {},
): { gate: ReleaseGate; created: boolean } {
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const read = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const derive = deps.derive ?? ((root?: string) => deriveBuildSha(root));
  const p = gatePath(version, channel);

  if (exists(p)) {
    return { gate: JSON.parse(read(p)) as ReleaseGate, created: false };
  }

  const { sha, dirty } = derive(deps.root);
  const gate: ReleaseGate = { version, channel, buildSha: sha, dirty, derivedAt: new Date().toISOString(), derivedBy: actor };
  const write = deps.writeFileSyncExclusive ?? ((path_: string, data: string) => fs.writeFileSync(path_, data, { flag: 'wx' }));
  try {
    write(p, JSON.stringify(gate, null, 2));
    return { gate, created: true };
  } catch {
    // Lost the create race to a peer's near-simultaneous first call — their write is
    // authoritative; read it back rather than returning our own (potentially different)
    // derivation.
    return { gate: JSON.parse(read(p)) as ReleaseGate, created: false };
  }
}
