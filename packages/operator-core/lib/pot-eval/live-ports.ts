/**
 * live-ports.ts — the LIVE `HiveRunPorts` assembly (HE-07 follow-on, P-063 / D-011): boot a real
 * throwaway Hive over a seeded scenario, drive it to completion, collect the run, tear it down.
 * This is the owner-gated leaf (P-051): wiring it makes the benchmark RUNNABLE, but the cadence
 * still spends nothing until the owner sets a budget + activates.
 *
 * Topology (owner decision 2026-06-13): the substrate is a MEMBER harness. `bootHive` mints the
 * Queen seat (`createHiveHarness`, repo-less hive home) AND registers the hermetic seed-app clone
 * as a MEMBER harness (`hive_slug` → the home) that `surveyHive` scans; the scenario's work-item
 * DAG seeds into the member. This mirrors the real Hive topology (Queen + member projects).
 *
 * The seam that keeps this honest: the live IO (git, PG, hive boot/survey, LLM-spending drive) is
 * injected via {@link LiveHivePortsDeps}, so this module's PURE core — the seed-app→pinned-SHA
 * materialization plan, the scenario→seed-DAG plan, and the drained predicate — is unit-tested
 * with no git/PG/LLM, and the full whole-Hive run is exercised only by an owner-armed run (NOT CI).
 *
 * The score EXTRACTOR's ground-truth leg is su-b459e's `ground-truth-live.ts` (P-062) — composed
 * here, not duplicated (the agreed file split).
 */
import { buildSubstrateCloneCommands, type GitCommand } from '../gym/clone';
import type { HiveScenario } from './scenario';
import { SEED_APP_DIR } from './scenarios';
import type { PotSurvey } from '../pot/survey';
import type { HiveRunPorts, HiveBootResult, DriveResult } from './run-harness';

// ───────────────────────── seed-app → a pinned-SHA git repo (pure) ─────────────────────────
//
// The seed-app fixture (SEED_APP_DIR) is a plain directory: the scenario sandbox carries
// `commit: 'seed'`, a placeholder — but `gym/clone` REQUIRES a hex SHA (a hermetic clone pins an
// immutable commit so the trace collector can `git diff <pin> HEAD`). So before cloning, bootHive
// materializes a one-commit git repo from a COPY of the fixture (never mutating the fixture itself)
// and clones from THAT at the resulting SHA. These are the materialization commands; the caller
// runs them then `git rev-parse HEAD` to read the pin (the SHA isn't known until the commit lands).

/** A fixed identity so `git commit` never fails on missing user config (the SHA itself is opaque —
 *  run identity comes from instance×scenario×repeat×seed, not the substrate commit). */
const SEED_GIT_IDENTITY = ['-c', 'user.name=hive-eval', '-c', 'user.email=hive-eval@papercusp.local'];

/** The git commands that turn a COPY of the seed-app fixture into a one-commit repo (the clone
 *  source). The caller execs these in order, then `git -C <baseDir> rev-parse HEAD` for the pin. */
export function seedRepoMaterializeCommands(baseDir: string): GitCommand[] {
  return [
    { argv: ['git', 'init', '--quiet', baseDir] },
    { argv: ['git', '-C', baseDir, 'add', '-A'] },
    { argv: ['git', '-C', baseDir, ...SEED_GIT_IDENTITY, 'commit', '--quiet', '-m', 'hive-eval seed-app base'] },
  ];
}

/** The hermetic clone of the materialized base @ the pinned SHA into the run's scratch dir. */
export function seedRepoCloneCommands(input: { baseDir: string; commit: string; destDir: string }): GitCommand[] {
  return buildSubstrateCloneCommands({ source: input.baseDir, commit: input.commit, destDir: input.destDir }).commands;
}

// ───────────────────────── scenario → the seed-DAG plan (pure) ─────────────────────────
//
// Each scenario work-item becomes a `todo` feature-family work-item in the member harness; its
// `dependsOn` becomes a feature→feature `blocks` edge so `surveyHive`'s readiness filter holds a
// lane back until its prerequisites complete (the same readiness the orchestrator dispatches by).
// The planted defect is already in the cloned repo, so seeding is pure metadata.

export interface SeedFeature {
  /** The member-harness feature id — the scenario work-item id (unique within the member). */
  featureId: string;
  title: string;
  /** What the bee must do (the work-item spec/summary). */
  spec: string;
}

/** A `blocks` edge: `blockedBy` (a prerequisite) must complete before `feature` is ready. */
export interface SeedEdge {
  feature: string;
  blockedBy: string;
}

export interface ScenarioSeedPlan {
  features: SeedFeature[];
  edges: SeedEdge[];
}

/** Turn a scenario's work-item DAG into the member-harness seed plan (features + block edges). */
export function scenarioSeedPlan(scenario: HiveScenario): ScenarioSeedPlan {
  const features: SeedFeature[] = scenario.workItems.map((w) => ({ featureId: w.id, title: w.title, spec: w.spec }));
  const edges: SeedEdge[] = [];
  for (const w of scenario.workItems) {
    for (const dep of w.dependsOn) edges.push({ feature: w.id, blockedBy: dep });
  }
  return { features, edges };
}

// ───────────────────────── completion: the drained predicate (pure) ─────────────────────────
//
// The whole-Hive run is DRAINED when the Queen has nothing left to do: the survey's frontier is
// empty (no unplaced ready work), no started plan remains, and no placement is in flight (a bee
// still working). `driveToCompletion` polls `surveyHive` + the in-flight-placement count and tests
// this each tick until true or the timeout — `drained` vs `timeout` is the terminal disposition.

/** True when the Hive has drained the scenario: nothing ready, nothing started, nothing in flight. */
export function isHiveDrained(
  survey: Pick<PotSurvey, 'plans' | 'frontier'>,
  inFlightPlacements: number,
): boolean {
  return survey.frontier.length === 0 && survey.plans.length === 0 && inFlightPlacements <= 0;
}

// ───────────────────────── the injectable live IO seam ─────────────────────────
//
// The IO `makeLiveHivePorts` wires the PURE helpers above over these injected operations. Real
// defaults bind git/fs (clone), `createHiveHarness` + the member-register + schema scaffold (boot),
// the HFC insert + block-edge sync (seed), `pot:start` + `surveyHive` + the placement-in-flight
// query (drive), the spawn/work-item/cost reads (collect), and the schema-drop + clone-rm
// (teardown). Injected so the orchestration is unit-testable; bound for the owner-armed live run.
// (makeLiveHivePorts lands next — Phase 1 IO assembly + Phase 2 drive/collect — over this seam.)

/** The run's measured counts + cost, read from the throwaway hive's rows (the speed/cost inputs). */
export interface LiveRunStats {
  costUsd: number;
  workItemsTotal: number;
  workItemsCompleted: number;
}

/**
 * The live IO operations `makeLiveHivePorts` orchestrates. Every side effect is one method, so the
 * boot→seed→drive→collect→teardown ORDERING + the drained-polling loop are unit-testable with fakes
 * (no git/PG/LLM); the real binding (`liveHiveOps`, next) wires git/fs + createHiveHarness + the
 * member-register + the HFC/edge writes + pot:start + surveyHive + the placement/spawn reads +
 * teardown. The full live run is reached only by an owner-armed run (P-051).
 */
export interface LiveHiveOps {
  /** Per-run scratch root (the base + clone dirs live under it). */
  scratchRoot(slug: string): string;
  /** Recursively copy the seed-app fixture into a writable base dir (never mutate the fixture). */
  copyDir(src: string, dest: string): Promise<void>;
  /** Run a git/shell command (execFile, no shell). Returns stdout (for `rev-parse`). */
  exec(cmd: string, args: string[]): Promise<{ stdout: string }>;
  /** Remove a path (the clone / base dir) on teardown. */
  rm(path: string): Promise<void>;
  /** Mint the Queen seat — createHiveHarness, IDLE (no initial wake; drive starts it). */
  createHive(input: { slug: string; workspaceId: string }): Promise<void>;
  /** Register the substrate clone as a MEMBER harness (scaffold schema + hive_slug → home). */
  registerMember(input: { member: string; clonePath: string; hiveHome: string; workspaceId: string }): Promise<void>;
  /** Seed one scenario work-item as a `todo` feature-family work-item in the member harness. */
  seedFeature(input: { member: string; featureId: string; title: string; spec: string; workspaceId: string }): Promise<void>;
  /** Write a work-item's dependsOn as feature→feature `blocks` edges (syncFeatureBlockEdges). */
  syncBlockEdges(input: { member: string; featureId: string; blockedBy: readonly string[] }): Promise<void>;
  /** Start the Hive (setHiveStarted + the urgent Queen wake) — the real autonomous run begins. */
  startHive(input: { hiveHome: string; workspaceId: string; kickoff: string }): Promise<void>;
  /** Stop the Hive (setHiveStarted false) — bound spend at drain/timeout. */
  pauseHive(input: { hiveHome: string; workspaceId: string }): Promise<void>;
  /** surveyHive's two views (which plans/frontier remain) — the drained inputs. */
  survey(input: { hiveHome: string; workspaceId: string }): Promise<Pick<PotSurvey, 'plans' | 'frontier'>>;
  /** Count placements still in flight (hive_placements rows not yet `completed`). */
  countInFlightPlacements(input: { hiveHome: string; workspaceId: string }): Promise<number>;
  /** The run's measured cost + completion counts (spawned_agents + the member's work-items). */
  readRunStats(input: { member: string; workspaceId: string }): Promise<LiveRunStats>;
  /**
   * The run's distilled trace + ref for the judge (HE-06) AND the full {@link LiveRunCapture} (in
   * `extra.capture`) — the live binding runs the acceptance command in `repoPath`, collects the
   * ground truth, and extracts the spawn behavior/timings HERE, before teardown removes the clone +
   * member schema (run-harness.ts tears down right after collectRunData). `scenario` + `repoPath` are
   * threaded so this single pre-teardown read captures everything the (post-teardown) extractor replays.
   */
  readRunTrace(input: {
    member: string;
    /** The Mug-seat hive home slug — the per-wake Mug usage samples (role='mug') are tagged
     *  with it, and it is unique per run, so it scopes mugWakeEfficiency to THIS run's wakes (B-06). */
    hiveHome: string;
    repoPath: string;
    scenario: HiveScenario;
    workspaceId: string;
    maxChars: number;
  }): Promise<{ distilledTrace: string; traceRef: string; extra?: Record<string, unknown> }>;
  /** Drop the member harness schema + its rows. */
  dropMember(input: { member: string; workspaceId: string }): Promise<void>;
  /** Dissolve the Queen-seat hive home. */
  dissolveHive(input: { hiveHome: string; workspaceId: string }): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface LiveHivePortsOpts {
  workspaceId: string;
  /** Poll cadence for the drained check during driveToCompletion. Default 10s. */
  pollIntervalMs?: number;
}

/** The boot context threaded (opaquely) to seed/drive/collect/teardown. */
interface LiveBootHandle {
  home: string;
  member: string;
  base: string;
  clone: string;
}

/**
 * Assemble the LIVE {@link HiveRunPorts} from the injected ops. boot → materialize+clone the
 * seed-app, mint the Queen seat + register the substrate member; seed → the work-item DAG + block
 * edges; drive → start the Hive then poll until {@link isHiveDrained} or the timeout (then pause to
 * bound spend); collect → the distilled trace; teardown → drop the member + dissolve the hive +
 * remove the clones. The whole-Hive run is real LLM spend — reached only by an owner-armed run.
 */
export function makeLiveHivePorts(ops: LiveHiveOps, opts: LiveHivePortsOpts): HiveRunPorts {
  const ws = opts.workspaceId;
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;

  return {
    now: () => ops.now(),

    async bootHive({ identity }): Promise<HiveBootResult> {
      const root = ops.scratchRoot(identity.potSlug);
      const base = `${root}/base`;
      const clone = `${root}/clone`;
      const home = identity.potSlug;
      const member = `${identity.potSlug}m`; // hyphen-free (run-identity) ⇒ safe schema id

      // 1. Materialize the seed-app fixture as a one-commit repo (the clone source + pin).
      await ops.copyDir(SEED_APP_DIR, base);
      for (const c of seedRepoMaterializeCommands(base)) await ops.exec(c.argv[0], c.argv.slice(1));
      const sha = (await ops.exec('git', ['-C', base, 'rev-parse', 'HEAD'])).stdout.trim();
      // 2. Hermetic-clone @ the pinned SHA.
      for (const c of seedRepoCloneCommands({ baseDir: base, commit: sha, destDir: clone })) {
        await ops.exec(c.argv[0], c.argv.slice(1));
      }
      // 3. Queen seat (idle) + the substrate as a member harness it surveys.
      await ops.createHive({ slug: home, workspaceId: ws });
      await ops.registerMember({ member, clonePath: clone, hiveHome: home, workspaceId: ws });

      const handle: LiveBootHandle = { home, member, base, clone };
      return { potSlug: home, repoPath: clone, workspaceId: ws, handle };
    },

    async seedScenario({ scenario, boot }): Promise<void> {
      const { member } = boot.handle as LiveBootHandle;
      const plan = scenarioSeedPlan(scenario);
      for (const f of plan.features) {
        await ops.seedFeature({ member, featureId: f.featureId, title: f.title, spec: f.spec, workspaceId: ws });
      }
      // Block edges per work-item (the planted defect is already in the cloned repo).
      for (const w of scenario.workItems) {
        if (w.dependsOn.length > 0) await ops.syncBlockEdges({ member, featureId: w.id, blockedBy: w.dependsOn });
      }
    },

    async driveToCompletion({ scenario, boot, timeoutMs }): Promise<DriveResult> {
      const { home, member } = boot.handle as LiveBootHandle;
      const startedAt = ops.now();
      await ops.startHive({
        hiveHome: home,
        workspaceId: ws,
        kickoff: `Hive-eval scenario "${scenario.id}" — drain the seeded work-items to the known-good end state.`,
      });

      let drained = false;
      try {
        while (ops.now() - startedAt < timeoutMs) {
          const [survey, inFlight] = await Promise.all([
            ops.survey({ hiveHome: home, workspaceId: ws }),
            ops.countInFlightPlacements({ hiveHome: home, workspaceId: ws }),
          ]);
          if (isHiveDrained(survey, inFlight)) {
            drained = true;
            break;
          }
          await ops.sleep(pollIntervalMs);
        }
      } finally {
        // Always stop the Hive — a timed-out run must not keep spending.
        await ops.pauseHive({ hiveHome: home, workspaceId: ws }).catch(() => {});
      }

      const stats = await ops.readRunStats({ member, workspaceId: ws });
      return {
        terminalState: drained ? 'drained' : 'timeout',
        frontierDrained: drained,
        workItemsTotal: stats.workItemsTotal || scenario.workItems.length,
        workItemsCompleted: stats.workItemsCompleted,
        costUsd: stats.costUsd,
      };
    },

    async collectRunData({ scenario, boot, maxChars }) {
      const { member, home } = boot.handle as LiveBootHandle;
      // Capture EVERYTHING live here (acceptance over the clone + ground-truth rows + spawn
      // behavior/timing + the Queen per-wake efficiency scoped to the home) — teardown runs
      // immediately after, so the extractor replays from `extra`.
      return ops.readRunTrace({ member, hiveHome: home, repoPath: boot.repoPath, scenario, workspaceId: ws, maxChars });
    },

    async teardown({ boot }): Promise<void> {
      const { home, member, base, clone } = boot.handle as LiveBootHandle;
      await ops.dropMember({ member, workspaceId: ws }).catch(() => {});
      await ops.dissolveHive({ hiveHome: home, workspaceId: ws }).catch(() => {});
      await ops.rm(base).catch(() => {});
      await ops.rm(clone).catch(() => {});
    },
  };
}
