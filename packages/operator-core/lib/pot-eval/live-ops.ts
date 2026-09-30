/**
 * live-ops.ts — the CONCRETE {@link LiveHiveOps} binding (P-063 / D-011): the ~15 injected IO ops
 * `makeLiveHivePorts` orchestrates, wired to the real seams. This is the "wire-to-reality" layer the
 * orchestration's fakes stand in for — git/fs, the Queen-seat create, the member register + schema
 * scaffold, the HFC seed insert + block edges, hive start/pause, surveyPot, the placement /
 * spawn-row reads, the live capture (`captureRunData`), and the throwaway-hive teardown.
 *
 * Verifiability boundary (the same b459e drew for ground-truth-live.ts):
 *   - The fs/exec ops + every lifecycle op call ALREADY-TESTED seams (createPotHarness,
 *     scaffoldHarnessSchema, setPotStarted, surveyPot, syncFeatureBlockEdges, dropHarnessSchema).
 *   - The DB-read ops (placements in-flight, run stats, spawn rows) + the capture read synthetic
 *     rows in integration tests — NO LLM spend.
 *   - The ONE genuinely owner-gated, real-LLM seam is `driveToCompletion`'s real Queen (P-051): the
 *     budget-capped first run. The cost/coord/collision behavior fields have no confirmed column on
 *     `spawned_agents` and are first-live-run EKG wiring (flagged 0, never inflating a score —
 *     they're denominators / failure pairs, so 0 is the conservative floor + the outcome gate +
 *     un-gameable floor are fully sourced from ground-truth + baseline + timings).
 */
import { cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { createPotHarness } from '../agent-tools/pot/_create';
import { loadHarnessRegistry, saveHarnessRegistry } from '../harness-registry';
import { scaffoldHarnessSchema, dropHarnessSchema } from '../scaffold-harness-schema';
import { removeHarnessFromWorkspace } from '../harness-membership';
import { setPotStarted } from '../pot/started';
import { requestUrgentPotWake } from '../pot/urgent-wake';
import { clearPotTimeWake } from '../pot/wake';
import { cancelSubtree } from '../fleet/nursery';
import { listFleetAssignments } from '../fleet/assignments';
import { teardownPotLearningLoop } from '../pot/provision-learning-loop';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { surveyPot } from '../pot/survey';
import { syncFeatureBlockEdges } from '../dbos/feature-blockers-edges';
import { liveAcceptancePorts } from './outcome-metrics';
import { collectGroundTruth, runBaselineSuite, type GroundTruthCtx } from './ground-truth';
import { liveGroundTruthPortsFromSql } from './ground-truth-live';
import { SEED_APP_DIR } from './scenarios';
import { mugWakeEfficiency, mugWakeSampleRows, type MugWakeEfficiency } from '../pot/mug-wake-efficiency';
import { cupWakeEfficiency, cupWakeSampleRows, type CupWakeEfficiency } from '../pot/cup-wake-efficiency';
import type { HiveScenario } from './scenario';
import type { LiveHiveOps, LiveRunStats } from './live-ports';
import { packLiveRunCapture, type BehaviorEkgFields, type LiveRunCapture, type SpawnRunRow } from './live-capture';

const execFileP = promisify(execFile);

/** Spawn statuses that count as a TERMINAL placement (the in-flight predicate is the complement). */
const IN_FLIGHT_PLACEMENT_STATUSES = ['working', 'recovering'] as const;

interface SpawnRow {
  spawn_id: string;
  feature_id: string | null;
  status: string;
  started_at: string | Date;
  finished_at: string | Date | null;
  duration_ms: string | number | null;
}

/** The run's confirmed `spawned_agents` rows for the member, mapped to {@link SpawnRunRow}. Exported
 *  for the integration test (verifies the SQL + the bigint/timestamp coercions against the real schema). */
export async function readMemberSpawnRows(sql: postgres.Sql, member: string, workspaceId: string): Promise<SpawnRunRow[]> {
  const rows = await sql<SpawnRow[]>`
    SELECT spawn_id, feature_id, status, started_at, finished_at, duration_ms
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${member}`;
  return rows.map((r) => ({
    spawnId: r.spawn_id,
    featureId: r.feature_id,
    status: r.status,
    startedAtMs: new Date(r.started_at).getTime(),
    finishedAtMs: r.finished_at != null ? new Date(r.finished_at).getTime() : null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
  }));
}

/** The run's stats from the member's HFC rows (cost is first-live-run EKG wiring — see file header). */
export async function readMemberRunStats(sql: postgres.Sql, member: string, workspaceId: string): Promise<LiveRunStats> {
  const rows = await sql<{ total: number; completed: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'passed')::int AS completed
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${member}`;
  return { costUsd: 0, workItemsTotal: rows[0]?.total ?? 0, workItemsCompleted: rows[0]?.completed ?? 0 };
}

/** Placements still in flight for a hive home: `pot_placements` rows in a non-terminal status (the
 *  drained predicate's "a bee is still working" input). Exported for the integration test. */
export async function countHivePlacementsInFlight(sql: postgres.Sql, hiveHome: string, workspaceId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.pot_placements
     WHERE workspace_id = ${workspaceId} AND install_slug = ${hiveHome}
       AND status = ANY(${[...IN_FLIGHT_PLACEMENT_STATUSES]})`;
  return rows[0]?.n ?? 0;
}

/** The queen subset of {@link BehaviorEkgFields} — the eval RunBehavior's per-wake Queen fields. */
type QueenEkg = Pick<
  BehaviorEkgFields,
  'queenCacheReadTokens' | 'queenCacheCreationTokens' | 'queenInputTokens' | 'queenWakes' | 'queenTurns' | 'queenWakesWithTurns'
>;

/** Map a {@link MugWakeEfficiency} aggregate onto the eval's queen EKG fields. Pure. */
export function queenEkgFromEfficiency(eff: MugWakeEfficiency): QueenEkg {
  return {
    queenCacheReadTokens: eff.totalCacheReadTokens,
    queenCacheCreationTokens: eff.totalCacheCreationTokens,
    queenInputTokens: eff.totalInputTokens,
    queenWakes: eff.wakes,
    queenTurns: eff.totalTurns,
    queenWakesWithTurns: eff.turnsReportedWakes,
  };
}

/**
 * Read the Queen per-wake efficiency for a throwaway hive home (B-06 / P-010-P-011): the
 * `role='mug'` agent_usage_samples scoped to `hiveHome` — unique per run, so this is exact
 * attribution, no time window — aggregated by {@link mugWakeEfficiency} (over the passed `sql`)
 * and mapped to the eval's queen EKG fields. Exported so the integration test exercises the real SQL.
 */
export async function readQueenEkg(sql: postgres.Sql, input: { workspaceId: string; hiveHome: string }): Promise<QueenEkg> {
  const eff = await mugWakeEfficiency(input.workspaceId, {
    harnessSlug: input.hiveHome,
    limit: 500, // a whole run's Queen wakes — well above the default 50 so attribution isn't truncated
    deps: { fetchSamples: (q) => mugWakeSampleRows(sql, q) },
  });
  return queenEkgFromEfficiency(eff);
}

/** The bee subset of {@link BehaviorEkgFields} — the eval RunBehavior's per-bee warm-inject carry fields. */
type BeeEkg = Pick<
  BehaviorEkgFields,
  'beeCarriedReadTokens' | 'beeCacheReadTokens' | 'beeCacheCreationTokens' | 'beeInputTokens' | 'beeWarmInjects'
>;

/** Map a {@link CupWakeEfficiency} aggregate onto the eval's bee EKG fields. Pure. */
export function beeEkgFromEfficiency(eff: CupWakeEfficiency): BeeEkg {
  return {
    beeCarriedReadTokens: eff.totalCarriedReadTokens,
    beeCacheReadTokens: eff.totalCacheReadTokens,
    beeCacheCreationTokens: eff.totalCacheCreationTokens,
    beeInputTokens: eff.totalInputTokens,
    // Warm-injects = non-first wakes across all bee sessions = totalWakes − sessions (each session's
    // FIRST wake is the spawn, not a warm-inject). This is the gate (>0) that decides whether the
    // bee carry sub-score is scored at all (scoring.ts), so a run with no warm-inject carry isn't
    // scored on a 0 it never earned.
    beeWarmInjects: eff.totalWakes - eff.sessions,
  };
}

/**
 * Read the per-bee warm-inject carry efficiency for a throwaway run (P-015): the `role='bee'`
 * agent_usage_samples grouped by session_id, scoped to the MEMBER clone slug (where the bees work —
 * a bee's sample carries `harness_slug = harnessSlugFromProjectDir(projectDir)` = the member), so
 * attribution is exact (the slug is unique per run). Aggregated by {@link cupWakeEfficiency} over the
 * passed `sql` and mapped to the eval's bee EKG fields. Exported so the integration test exercises
 * the real SQL.
 */
export async function readBeeEkg(sql: postgres.Sql, input: { workspaceId: string; member: string }): Promise<BeeEkg> {
  const eff = await cupWakeEfficiency(input.workspaceId, {
    harnessSlug: input.member,
    limit: 500, // a whole run's bee wakes across the member-clone sessions (above the default 200)
    deps: { fetchSamples: (q) => cupWakeSampleRows(sql, q) },
  });
  return beeEkgFromEfficiency(eff);
}

export interface CaptureRunDataInput {
  member: string;
  /** The Queen-seat hive home slug — scopes the per-wake Queen efficiency read (unique per run). */
  hiveHome: string;
  repoPath: string;
  scenario: HiveScenario;
  workspaceId: string;
  maxChars: number;
}

/**
 * The LIVE `readRunTrace` — gather the full {@link LiveRunCapture} BEFORE teardown removes the clone
 * + member schema: run the scenario's acceptance command in the clone, collect the ground truth
 * (b459e's `liveGroundTruthPortsFromSql` over the member's HFC/spawn rows) with the regression floor
 * (pre = the pristine seed-app fixture, post = the run's mutated clone), and read the confirmed spawn
 * rows. The capture rides `extra.capture` to the (post-teardown) replay extractor. NO LLM spend —
 * the only live cost is the drive that produced these rows.
 */
export async function captureRunData(
  sql: postgres.Sql,
  input: CaptureRunDataInput,
): Promise<{ distilledTrace: string; traceRef: string; extra: Record<string, unknown> }> {
  const { member, hiveHome, repoPath, scenario, workspaceId, maxChars } = input;
  const ctx: GroundTruthCtx = { scenario, repoPath, potSlug: member, workspaceId };

  const acceptance = await liveAcceptancePorts().runAcceptance({ repoPath, acceptance: scenario.acceptance });

  const baseline = async () => {
    const [pre, post] = await Promise.all([runBaselineSuite(SEED_APP_DIR), runBaselineSuite(repoPath)]);
    return { pre, post };
  };
  const groundTruth = await collectGroundTruth(liveGroundTruthPortsFromSql({ sql, baseline }), ctx);

  const spawnRows = await readMemberSpawnRows(sql, member, workspaceId);

  // Per-wake Mug efficiency (B-06, scoped to the unique home slug, role='mug') + per-bee
  // warm-inject carry (P-015, scoped to the member clone, role='bee' grouped by session_id) for THIS
  // run. Both are non-LLM reads of already-persisted rows; each fail-soft (a read error leaves its
  // half absent → those fields default to 0, the same conservative floor as the other EKG fields).
  const [queenEkg, beeEkg] = await Promise.all([
    readQueenEkg(sql, { workspaceId, hiveHome }).catch(() => undefined),
    readBeeEkg(sql, { workspaceId, member }).catch(() => undefined),
  ]);
  const ekg: BehaviorEkgFields | undefined = queenEkg || beeEkg ? { ...queenEkg, ...beeEkg } : undefined;

  const capture: LiveRunCapture = { acceptance, groundTruth, spawnRows, ...(ekg ? { ekg } : {}) };

  // A compact human-readable trace for the (optional, advisory) HE-06 judge — capped at maxChars.
  const claimed = groundTruth.workItems.filter((w) => w.claimedDone).length;
  const real = groundTruth.workItems.filter((w) => w.actuallyDone && w.hasCommit).length;
  const trace =
    `Scenario ${scenario.id} (${scenario.shape}) — acceptance ${acceptance.passed ? 'PASS' : 'FAIL'}; ` +
    `${claimed} claimed done / ${real} genuinely done (commit+work); ${spawnRows.length} bee spawns. ` +
    `Review:\n${groundTruth.reviewOutput}`;
  const distilledTrace = trace.slice(0, maxChars);

  return { distilledTrace, traceRef: `hive-eval://${member}`, extra: packLiveRunCapture(capture) };
}

export interface LiveHiveOpsDeps {
  workspaceId: string;
  /** Per-run scratch parent dir (the base + clone live under it). Default `os.tmpdir()/hive-eval`. */
  scratchParent?: string;
}

/**
 * Bind the concrete {@link LiveHiveOps} for a workspace. Every IO op the orchestration calls is a
 * real seam here; `makeLiveHivePorts(liveHiveOps({ workspaceId }), { workspaceId })` is the live
 * `HiveRunPorts` the cadence runs once the owner sets a budget (P-051).
 */
export function liveHiveOps(deps: LiveHiveOpsDeps): LiveHiveOps {
  const ws = deps.workspaceId;
  const scratchParent = deps.scratchParent ?? join(tmpdir(), 'pot-eval');
  const sqlClient = (): postgres.Sql => getOrgPg().sql;

  return {
    scratchRoot: (slug) => join(scratchParent, slug),
    copyDir: (src, dest) => cp(src, dest, { recursive: true }),
    exec: async (cmd, args) => {
      const { stdout } = await execFileP(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
      return { stdout };
    },
    rm: (path) => rm(path, { recursive: true, force: true }),

    async createHive({ slug, workspaceId }) {
      // Idle (no wakeInSeconds — driveToCompletion starts it), repo-less, no knowledge-pack seed.
      const res = await createPotHarness({ slug, workspaceId, knowledgePack: null });
      if (!res.ok) {
        throw new Error(`hive-eval createHive('${slug}') failed: ${res.error ?? 'unknown'} ${res.message ?? ''}`.trim());
      }
    },

    async registerMember({ member, clonePath, hiveHome, workspaceId }) {
      // Register the hermetic clone as a (non-hive) MEMBER harness with `hive_slug` → the home so
      // surveyPot scans it; then scaffold its schema. We set hive_slug DIRECTLY (not addHarnessToHive)
      // so the throwaway clone never gets a git-sync routine seeded — it must not federate/push.
      const reg = await loadHarnessRegistry(workspaceId);
      if (!reg.projects.some((p) => p.slug === member)) {
        reg.projects.push({ slug: member, path: clonePath, hive_slug: hiveHome });
        await saveHarnessRegistry(reg, workspaceId);
      }
      await scaffoldHarnessSchema(member);
    },

    async seedFeature({ member, featureId, title, spec }) {
      // Direct HFC insert keyed on the SCENARIO item id (the throwaway convention ground-truth-live
      // defaults its idMap to: feature_id === scenario id), todo/feature — mirrors createWorkItem's
      // write (workspace_id filled by the fill_ws_features trigger from the member's project row).
      const sql = sqlClient();
      const now = Date.now();
      await sql.unsafe(
        `INSERT INTO harness_shared.work_items (
           harness_slug, feature_id, title, summary, status, attempts,
           item_kind, needs_design, needs_human_review, ts, created_ts, updated_ts
         ) VALUES ($1, $2, $3, $4, 'open', 0, 'feature', FALSE, FALSE, $5, $6, $7)
         ON CONFLICT (harness_slug, feature_id) DO NOTHING`,
        [member, featureId, title, spec, now, now, now],
      );
    },

    syncBlockEdges: ({ member, featureId, blockedBy }) => syncFeatureBlockEdges(member, featureId, [...blockedBy]),

    async startHive({ hiveHome, workspaceId, kickoff }) {
      // The core of pot:start: persist started=true (the watchdog's liveness bit) + wake the Queen.
      await setPotStarted(workspaceId, hiveHome, true);
      await requestUrgentPotWake({ reason: kickoff, harness: hiveHome, workspaceId });
    },

    pauseHive: ({ hiveHome, workspaceId }) => setPotStarted(workspaceId, hiveHome, false),

    async survey({ hiveHome, workspaceId }) {
      const s = await surveyPot(workspaceId, hiveHome);
      return { plans: s.plans, frontier: s.frontier };
    },

    countInFlightPlacements: ({ hiveHome, workspaceId }) => countHivePlacementsInFlight(sqlClient(), hiveHome, workspaceId),

    readRunStats: ({ member, workspaceId }) => readMemberRunStats(sqlClient(), member, workspaceId),

    readRunTrace: (input) => captureRunData(sqlClient(), input),

    async dropMember({ member, workspaceId }) {
      await removeHarnessFromWorkspace(workspaceId, member).catch(() => {});
      await dropHarnessSchema(member).catch(() => {});
    },

    async dissolveHive({ hiveHome, workspaceId }) {
      // The FULL durable inverse of createHive — now mirrors pot:dissolve's core IN FULL (D-022 /
      // P-033 spend-safety fix). The old teardown skipped the bee-cancel + learning-loop teardown on
      // the assumption "the drive already paused the hive, so its bees are terminal" — but a
      // rate-limit-killed launcher (or a stuck bee that outlived the pause) left LIVE bees AND the
      // per-hive gymAutoloop/scoutRoutine learning loops behind, which re-spin opus AFTER teardown
      // (the orphan re-spin this benchmark must never produce). We now cancel every live bee subtree,
      // SIGTERM the local processes, and tear down the learning loops — the same closure pot:dissolve
      // delivers. Best-effort throughout (teardown must not mask the run's outcome).
      await setPotStarted(workspaceId, hiveHome, false).catch(() => {});
      const sql = sqlClient();
      await clearPotTimeWake(sql, hiveHome).catch(() => {});

      // Cancel every live bee in the hive (+ its subtree): mark cancelled, release claims/locks NOW,
      // notify, and SIGTERM the running process so it stops making edits. Mirrors pot:dissolve step 2.
      const actor: AgentIdentity = {
        ownerId: `hive-eval-dissolve:${hiveHome}`,
        ownerLabel: `hive-eval:dissolve:${hiveHome}`,
        source: 'principal',
        workspaceId,
        userId: null,
      };
      try {
        const rows = await listFleetAssignments({ workspaceId, harness: hiveHome });
        const beeIds = [...new Set(rows.filter((r) => r.holderAlive && r.agentId).map((r) => r.agentId as string))];
        const { abortLocalSpawn } = await import('../fleet/operator-spawn');
        for (const cupId of beeIds) {
          try {
            const res = await cancelSubtree(sql, { workspaceId, rootSpawnId: cupId, reason: 'hive-eval:dissolveHive', actor });
            for (const c of res.cancelled) abortLocalSpawn(c.spawnId);
          } catch (e) {
            console.warn(`[hive-eval] dissolve cancel bee ${cupId} failed: ${e instanceof Error ? e.message : e}`);
          }
        }
      } catch (e) {
        console.warn(`[hive-eval] dissolve bee-cancel sweep failed (${hiveHome}): ${e instanceof Error ? e.message : e}`);
      }

      // Tear down the per-hive learning loops (dark gym autoloop row + inactive scout routine + the
      // gym:<hive>/scout:<hive> governor registrants) — the D-022 re-spin source. Best-effort.
      await teardownPotLearningLoop({ sql, workspaceId, potSlug: hiveHome }).catch((e) => {
        console.warn(`[hive-eval] dissolve learning-loop teardown failed (${hiveHome}): ${e instanceof Error ? e.message : e}`);
      });

      await removeHarnessFromWorkspace(workspaceId, hiveHome).catch(() => {});
      await dropHarnessSchema(hiveHome).catch(() => {});
    },

    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
