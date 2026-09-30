/**
 * git-pipeline-hives — the PER-HIVE rows behind the /admin/git per-hive surface
 * (per-hive-git-and-release-gate-2026-06-29 P-014).
 *
 * The operator-home (papercusp) pipeline has its own full view (git-pipeline-stats.ts →
 * `dev.gitPipeline`). THIS enumerates the OTHER repo-backed coding hives that are green-gated
 * (resolveHiveReleaseEnv enabled, not operator-home) and projects one compact row each:
 * the resolved green command (+ whether it's an owner override), the gate status (🟩/🟥/held/
 * stalled), the staging↔main gap, last green sha, and last deploy — all from the SAME
 * substrate the home view reads (harness_shared.routines.metadata.gate_health +
 * harness_shared.pipeline_events, both already scoped per install_slug by gitPipelineSnapshot).
 *
 * READ-ONLY aggregation; every sub-read degrades to a best-effort default so a slow/missing
 * hive never breaks the surface. The list is empty until a coding hive with a repo is gated
 * (the PER_POT_RELEASE_GATE flag is default-OFF during rollout — D-008).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { gitSidecarEnabled, noteSidecarFallback, runGitViaSpawnerSidecar } from './fleet/git-via-sidecar';
import { getOrgPg } from '@papercusp/db-org';
import { loadHarnessRegistry } from './harness-registry';
import { resolveHiveReleaseEnv } from './harness/routines/hive-release-env';
import { getPotGitMode, type PotGitMode } from './harness/git-sync/hive-git-mode';
import { gitPipelineSnapshot, type GitPipelineSnapshot } from './git-pipeline-stats';
import { DEFAULT_WORKSPACE_ID } from './workspace-id-constant';

export type HiveGateStatus = 'green' | 'held' | 'stalled' | 'unknown';

/**
 * The newest GitHub-bridge tick state for a hive (github-bridge-hive-egress-2026-07-02
 * P-009) — projected from the `metadata.github_bridge` blob git-sync-action persists on
 * each member's `system:git-sync` routine row after the bridge pass.
 */
export interface GitPipelineBridgeState {
  /** When the reporting tick ran (ms). */
  atMs: number | null;
  ran: boolean;
  skipped: string | null;
  /** Where egress resolved to: fork | upstream | none | skipped. */
  egressTarget: string | null;
  /** The last ADMITTED github-origin head (the P-005 watermark, full sha). */
  lastAdmitted: string | null;
  /** The P-006 divergence verdict of the newest tick. */
  divergence: 'clear' | 'escalate' | null;
  /** True when resolution needs an owner lever (history rewrite / revoked author). */
  needsOwner: boolean;
  /** Error count reported by the newest tick. */
  errors: number;
  /** Which member routine reported this state (newest `at` wins across members). */
  memberSlug: string;
}

/** Map one routine-metadata `github_bridge` blob into the row state. Junk-safe:
 *  any malformed field degrades to its null/false default, never throws. */
export function bridgeStateFromMetadata(gb: unknown, memberSlug: string): GitPipelineBridgeState | null {
  if (!gb || typeof gb !== 'object') return null;
  const g = gb as Record<string, unknown>;
  return {
    atMs: typeof g.at === 'number' && Number.isFinite(g.at) ? g.at : null,
    ran: g.ran === true,
    skipped: typeof g.skipped === 'string' ? g.skipped : null,
    egressTarget: typeof g.egress_target === 'string' ? g.egress_target : null,
    lastAdmitted: typeof g.last_admitted === 'string' ? g.last_admitted : null,
    divergence: g.divergence === 'clear' || g.divergence === 'escalate' ? g.divergence : null,
    needsOwner: g.needs_owner === true,
    errors: Array.isArray(g.errors) ? g.errors.length : 0,
    memberSlug,
  };
}

/** The newest bridge state across a hive's member git-sync routines. Best-effort:
 *  a PG failure reads as null (the surface renders "no tick yet"), never throws. */
async function loadBridgeState(memberSlugs: string[]): Promise<GitPipelineBridgeState | null> {
  if (memberSlugs.length === 0) return null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ install_slug: string; gb: unknown }[]>`
      SELECT install_slug, metadata->'github_bridge' AS gb
        FROM harness_shared.routines
       WHERE target_role = 'system:git-sync'
         AND install_slug = ANY(${memberSlugs})
         AND metadata ? 'github_bridge'
    `;
    let newest: GitPipelineBridgeState | null = null;
    for (const r of rows) {
      const s = bridgeStateFromMetadata(r.gb, r.install_slug);
      if (s && (newest === null || (s.atMs ?? 0) > (newest.atMs ?? 0))) newest = s;
    }
    return newest;
  } catch {
    return null;
  }
}

export interface GitPipelineHiveRow {
  slug: string;
  /** The integration tree root (the hive's gated checkout). */
  root: string;
  /** Resolved green command the gate runs (override > knob > testCommand > build). */
  greenCmd: string;
  /** True when greenCmd is a per-hive owner override (editable on this surface). */
  greenCmdOverridden: boolean;
  integrationBranch: string;
  releaseRef: string;
  /** A deploy target is configured (release-trigger seeded). */
  hasDeploy: boolean;
  /** Whether the green-checkpoint routine is active for this hive. */
  greenCheckpointActive: boolean;
  // ── gate health ──
  gateStatus: HiveGateStatus;
  consecutiveReds: number;
  lastGreenAtMs: number | null;
  lastGreenSha: string | null;
  // ── pipeline position ──
  /** Commits on integrationBranch not yet on releaseRef (the untested buffer); null if unknown. */
  stagingMainGap: number | null;
  lastDeployAtMs: number | null;
  lastDeployStatus: string | null;
  // ── github bridge (github-bridge-hive-egress-2026-07-02 P-009) ──
  /** The hive's federated `hiveGit.mode` (legacy = no bridge, today's behavior). */
  hiveGitMode: PotGitMode;
  /** Newest bridge tick state; null on legacy hives / before the first tick. */
  bridge: GitPipelineBridgeState | null;
}

/** `git -C root rev-list --count <from>..<to>` via a LOCAL fork — best-effort, null on any error. */
function revListCountLocal(root: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: 5_000, cwd: root }, (err, stdout) => {
      if (err) return resolve(null);
      const n = Number.parseInt(stdout.trim(), 10);
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

/**
 * `git -C root rev-list --count <from>..<to>` — best-effort, null on any
 * error/missing branch.
 *
 * Routes through the SPAWNER SIDECAR when enabled, falling back to a local fork
 * on any sidecar problem. `fork()` copies the caller's page tables, so spawning
 * from the ~4 GB bg-host cost ~165 ms of BLOCKED EVENT LOOP per call for a
 * command git finishes in ~4 ms (EI-18808838427010743, ~40 ms/GB measured).
 * This runs per hive row inside the pipeline snapshot, and a CPU profile of the
 * live bg-host attributed 0.62% of the whole main thread to it — the largest
 * remaining git spawner after dev-deploy-state.ts.
 */
async function revListCount(root: string, from: string, to: string): Promise<number | null> {
  if (!root || !existsSync(root)) return null;
  const args = ['-C', root, 'rev-list', '--count', `${from}..${to}`];
  if (gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR')) {
    try {
      const r = await runGitViaSpawnerSidecar(args, root, 5_000, process.env);
      if (r.code !== 0) return null;
      const n = Number.parseInt(r.stdout.trim(), 10);
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      // Sidecar unreachable — fall through to the local fork. This helper
      // swallows every error into `null`, so it used to leave NO trace at all:
      // the fallback (and the fork stall it reintroduces) was completely
      // invisible here. Counting it costs nothing and is the only signal.
      noteSidecarFallback('git-pipeline', e);
    }
  }
  return revListCountLocal(root, args);
}

function gateStatusOf(gate: GitPipelineSnapshot['gate']): HiveGateStatus {
  if (gate.stalled === true) return 'stalled';
  if (gate.consecutiveReds > 0) return 'held';
  if (gate.stalled === null || gate.stalled === undefined) return 'unknown';
  if (gate.lastGreenAtMs != null) return 'green';
  return 'unknown';
}

/** The sha `main` was last fast-forwarded to: the newest green_checkpoint event's advancedTo
 *  (partial advance) or candidate (full advance). null when no green event yet.
 *
 *  WI-38367: `'advanced-prefix'` MUST be in this filter. `detail.advancedTo` is written on
 *  the partial-advance path and NOWHERE else (green-checkpoint.ts's prefix promotion →
 *  buildCheckpointDetail), so excluding that status made the `advancedTo` branch below
 *  unreachable and left this row naming an OLDER pin whenever the most recent thing that
 *  moved `main` was a prefix promotion — reporting main further back than it actually is,
 *  for as long as the tip stays red. Same root as WI-38340: a consumer written against the
 *  status taxonomy that existed before WI-38218 added a new kind of advance. */
function lastGreenShaOf(recent: GitPipelineSnapshot['recent']): string | null {
  const ev = recent.find(
    (e) =>
      e.kind === 'green_checkpoint' &&
      (e.status === 'advanced' || e.status === 'up-to-date' || e.status === 'advanced-prefix'),
  );
  if (!ev) return null;
  const d = ev.detail || {};
  const sha = typeof d.advancedTo === 'string' ? d.advancedTo : typeof d.candidate === 'string' ? d.candidate : null;
  return sha ? sha.slice(0, 12) : null;
}

/** Build one compact per-hive row. Reuses gitPipelineSnapshot(slug) (routines/gate/events
 *  are install_slug-scoped) and overlays the per-hive command/branches/gap. */
async function buildRow(
  slug: string,
  env: Awaited<ReturnType<typeof resolveHiveReleaseEnv>>,
  hiveGitMode: PotGitMode,
  bridge: GitPipelineBridgeState | null,
): Promise<GitPipelineHiveRow> {
  const root = env.env.PAPERCUSP_INTEGRATION_ROOT ?? '';
  const integrationBranch = env.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging';
  const releaseRef = env.env.PAPERCUSP_RELEASE_REF ?? 'main';

  let snap: GitPipelineSnapshot | null = null;
  try {
    snap = await gitPipelineSnapshot(slug);
  } catch {
    snap = null;
  }
  const gap = await revListCount(root, releaseRef, integrationBranch);
  const lastDeploy = snap?.recent.find((e) => e.kind === 'deploy') ?? null;

  return {
    slug,
    root,
    greenCmd: env.greenCmd ?? '',
    greenCmdOverridden: env.greenCmdOverridden === true,
    integrationBranch,
    releaseRef,
    hasDeploy: env.hasDeploy,
    greenCheckpointActive: snap?.routines.greenCheckpoint?.active ?? false,
    gateStatus: snap ? gateStatusOf(snap.gate) : 'unknown',
    consecutiveReds: snap?.gate.consecutiveReds ?? 0,
    lastGreenAtMs: snap?.gate.lastGreenAtMs ?? null,
    lastGreenSha: snap ? lastGreenShaOf(snap.recent) : null,
    stagingMainGap: gap,
    lastDeployAtMs: lastDeploy?.createdAtMs ?? null,
    lastDeployStatus: lastDeploy?.status ?? null,
    hiveGitMode,
    bridge,
  };
}

/**
 * The per-hive pipeline rows for the /admin/git surface: every repo-backed coding hive that
 * is green-gated, EXCLUDING the operator-home (it has its own full view). Sorted by slug.
 */
export async function gitPipelineHiveRows(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<GitPipelineHiveRow[]> {
  let projects: Array<{ slug: string; hive_slug?: string }>;
  try {
    const reg = await loadHarnessRegistry(workspaceId);
    projects = reg.projects;
  } catch {
    return [];
  }

  const rows: GitPipelineHiveRow[] = [];
  for (const p of projects) {
    let env: Awaited<ReturnType<typeof resolveHiveReleaseEnv>>;
    try {
      env = await resolveHiveReleaseEnv(p.slug, workspaceId);
    } catch {
      continue;
    }
    // Only GATED, repo-backed, NON-home hives appear here (the home is the main view).
    if (!env.enabled || env.isOperatorHome) continue;
    // P-009: the bridge cell — mode read is fail-open-to-legacy (never throws);
    // the bridge-state PG read runs only on non-legacy hives (legacy = zero cost).
    const hiveGitMode = await getPotGitMode(workspaceId, p.slug);
    const bridge =
      hiveGitMode === 'legacy'
        ? null
        : await loadBridgeState([p.slug, ...projects.filter((m) => m.hive_slug === p.slug).map((m) => m.slug)]);
    rows.push(await buildRow(p.slug, env, hiveGitMode, bridge));
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug));
  return rows;
}
