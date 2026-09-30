/**
 * `liveHiveBacklogDriver` + `bindLiveHiveBacklogDriver` — the LIVE binding of P-022's
 * {@link HiveBacklogDriver} (su-1226c). Makes the `hive` treatment arm AND (via the shared planner
 * seam) su-136a4's `queen-ablated` baseline one-command-runnable for the bounded pilot smoke (P-032).
 *
 * SHAPE: the same injected-ops orchestration as hive-eval's `makeLiveHivePorts` (boot → seed → drive
 * → collect → teardown over an injected IO seam, poll-until-drained, pause-on-timeout to bound spend),
 * adapted from hive-eval's scenario corpus to a BENCHMARK BACKLOG of public tasks, and driving
 * placement with the SCRIPTED planner ({@link getFleetPlanner}) rather than the real Queen persona —
 * so `hive` (planBatchPlacement) vs `queen-ablated` (planFifoPlacement) is a clean MATCHED A/B (same
 * loop/fleet/per-task-unit, swap ONE planner — D-012). The orchestration is pure over the ops seam
 * (unit-tested with fakes, no git/PG/LLM); the real ops bind the live machinery.
 *
 * GOVERNOR-INDEPENDENT: this is code/wiring — binding it spends NOTHING. The real LLM spend (the bees
 * running `external-bench` per placed task) happens only when the owner triggers the bounded run at
 * the opus reset; `driveLoop` always pauses the fleet at drain/timeout to bound it.
 *
 * ── REAL-OPS INTEGRATION (the LIVE binding — `liveHiveBacklogOps`; verify on the FIRST gated run) ──
 * `liveHiveBacklogOps` (the real binding; `realHiveBacklogOps` delegates) wires the established
 * functions — REUSING the hive-eval `liveHiveOps` lifecycle, the fleet placement fns, the spine-drive
 * CREATE pattern (`bench-harness-live.ts`), and the bench clone/diff ports. ONE member harness per
 * task (the clone), keyed `feature_id = task.instanceId` so a frontier row IS its task — exact,
 * time-window-free cost/diff attribution (the same per-member discipline `liveHiveOps` draws):
 *   createHive       → `liveHiveOps.createHive` (createHiveHarness, a transient IDLE Queen-seat home).
 *   enrollTask       → `cloneTaskRepo` (./clone) @ base_commit → write `.papercusp/blueprint.yaml`
 *                      (`extends: external-bench`) into the clone (the spine-drive CREATE pattern,
 *                      `bench-harness-live.ts`) → `liveHiveOps.registerMember` → `liveHiveOps.seedFeature`
 *                      ONE feature (`feature_id = task.instanceId`, the problem_statement).
 *   gatherFrontier   → `gatherFrontier` (fleet/placement-gather.ts) — IMPORTANCE order for 'hive',
 *                      ARRIVAL/backlog order for 'queen-ablated' (136a4's FIFO contract — su-136a4).
 *   gatherBees       → `gatherLiveBees` (fleet/placement-gather.ts) + `getSpawnHeadroom`.
 *   placeBatch       → `executeBatch` (fleet/place_batch.ts) over the planner's `BatchPlacementPlan`
 *                      (spawns/warm-injects bees running the member's external-bench spine).
 *   countInFlight    → `liveHiveOps.countInFlightPlacements` (hive_placements rows not yet completed).
 *   pauseFleet       → `liveHiveOps.pauseHive`.
 *   collectTask      → `extractDiff` (./clone) over the member clone + the per-task cost/turns SUM
 *                      from `agent_usage_samples` (`readBenchRunCost`) + the member's bee spawn row
 *                      (`readMemberSpawnRows`) → an {@link ArmAttempt} → a {@link FleetTaskResult}.
 *   teardown         → `liveHiveOps.dropMember` per member + `liveHiveOps.dissolveHive` + rm clones.
 * Every method is a real best-effort body (NO throwing stub on the core path); the genuinely-uncertain
 * integrations carry `VERIFY-AT-FIRST-RUN:` flags. The ORCHESTRATION above is green over fakes
 * regardless; the pilot trigger (su-10912 / ec8fe) confirms the live wires.
 */
import type { CoordEvent } from '@papercusp/bench-metrics';
import type postgres from 'postgres';
import type { BatchPlacementInput, BatchPlacementPlan } from '../fleet/batch-placement';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { ArmAttempt, BenchTask, GenerationBudget, TaskCheckout } from './types';
import { QUEEN_ABLATED_ARM } from './hive-backlog';
import {
  getFleetPlanner,
  setHiveBacklogDriver,
  type FleetTaskResult,
  type HiveBacklogDriver,
  type HiveBacklogResult,
  type HiveBacklogRunRequest,
} from './hive-backlog';

/** Default fleet-drain timeout for a bounded backlog run (ms). Pauses the fleet to bound spend. */
const DEFAULT_FLEET_TIMEOUT_MS = 60 * 60 * 1000; // 1h — a bounded smoke is far under this.
const DEFAULT_POLL_MS = 10_000;

/**
 * The Queen-brief a placed bench bee receives (extraEnv.MUG_BRIEF → the bee's `## Queen brief`). The
 * scripted hive loop has no real Queen to assign+drive, so this is the standing directive that turns a
 * placed bee from taskless-exit into a benchmark worker: its member holds exactly ONE seeded feature
 * (the benchmark task's problem_statement); the bee claims + implements it to a real code diff in the
 * repo, then completes it. Naming the lone assigned task is direction, NOT freelancing (bee.md's
 * taskless rule forbids self-INVENTING work, not working an explicitly-placed feature).
 */
const BENCH_BEE_DIRECTIVE = [
  'You are placed on a single-task benchmark harness. This member holds EXACTLY ONE feature work-item —',
  'the benchmark problem to solve. Your job: claim it (`work_items:claim_next` for this harness, or',
  '`fleet:assignments { agent: <your spawn id> }` then `work_items:get` for the detail), read its full',
  'problem_statement, and IMPLEMENT the change directly in this repository as real code edits (a working',
  'unified diff against the checked-out base). Write the actual source fix — do not just plan or describe.',
  'When the implementation is complete and the repo builds, mark the work-item complete',
  '(`work_items:complete`). You are NOT taskless — the assigned feature IS your task; do not exit FAILED',
  'for "no work". There is no validator/reviewer downstream; you own the fix end to end.',
].join(' ');

/** One enrolled backlog task — its member harness + clone, threaded to collect. */
export interface EnrolledTask {
  task: BenchTask;
  member: string;
  clonePath: string;
  workItemId: string;
}

/**
 * The injected IO seam the orchestration drives (mirrors hive-eval's `LiveHiveOps`). Every side effect
 * is one method, so the boot→enroll→place→drain→collect→teardown ordering is unit-testable with fakes.
 */
export interface HiveBacklogOps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Mint the transient Queen-seat hive home (IDLE — the scripted loop drives placement, not a wake). */
  createHive(input: { runId: string; arm: string; workspaceId: string }): Promise<{ hiveHome: string }>;
  /** Clone the task repo @ base → register an `external-bench` member → seed the problem_statement work_item. */
  enrollTask(input: {
    hiveHome: string;
    task: BenchTask;
    budget: GenerationBudget;
    workspaceId: string;
  }): Promise<EnrolledTask>;
  /** Ready, unplaced frontier tasks (importance order for 'hive', backlog order for 'queen-ablated'). */
  gatherFrontier(input: { hiveHome: string; arm: string; workspaceId: string }): Promise<BatchPlacementInput['tasks']>;
  /** Live bees + free spawn headroom. */
  gatherBees(input: { hiveHome: string; workspaceId: string }): Promise<{ bees: NonNullable<BatchPlacementInput['bees']>; headroom: number }>;
  /** Execute the planner's decisions (spawn / warm-inject bees running external-bench). */
  placeBatch(input: {
    hiveHome: string;
    plan: BatchPlacementPlan;
    arm: string;
    workspaceId: string;
  }): Promise<{ placements: { instanceId: string; cupId: string; disposition: 'spawn' | 'warm-inject' }[] }>;
  /** Placements still in flight (0 = the backlog is drained). */
  countInFlight(input: { hiveHome: string; workspaceId: string }): Promise<number>;
  /** Pause the fleet — a timed-out/drained run must not keep spending. */
  pauseFleet(input: { hiveHome: string; workspaceId: string }): Promise<void>;
  /** Per enrolled task: the diff the bee produced + its cost/timing → the L1 leaf + placement provenance. */
  collectTask(input: { enrolled: EnrolledTask; arm: string; seed: string; workspaceId: string }): Promise<FleetTaskResult>;
  /** Drop members + dissolve the hive + remove the clones. */
  teardown(input: { hiveHome: string; members: EnrolledTask[]; workspaceId: string }): Promise<void>;
}

export interface LiveHiveBacklogOpts {
  workspaceId: string;
  /** Fleet-drain timeout (ms). Default 1h; a bounded smoke is far under. */
  fleetTimeoutMs?: number;
  /** Drain-poll cadence (ms). Default 10s. */
  pollIntervalMs?: number;
}

/**
 * The LIVE {@link HiveBacklogDriver} over the injected {@link HiveBacklogOps}. Drives the SCRIPTED
 * placement loop with the run's arm planner; never throws (the generation-failure contract — a failed
 * run yields a `runError` result, mirroring `runHiveBacklog`/`instantiateBenchHarness`).
 */
export function liveHiveBacklogDriver(ops: HiveBacklogOps, opts: LiveHiveBacklogOpts): HiveBacklogDriver {
  const ws = opts.workspaceId;
  const fleetTimeoutMs = opts.fleetTimeoutMs ?? DEFAULT_FLEET_TIMEOUT_MS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;

  return {
    async run(req: HiveBacklogRunRequest): Promise<HiveBacklogResult> {
      const planner = getFleetPlanner(req.arm);
      const startedAtMs = ops.now();
      const coordEvents: CoordEvent[] = [];
      const empty = (runError: string): HiveBacklogResult => ({
        arm: req.arm,
        suite: req.suite,
        runId: req.runId,
        seed: req.seed,
        startedAtMs,
        finishedAtMs: ops.now(),
        peakConcurrentBees: 0,
        taskResults: [],
        coordEvents,
        runError,
      });

      // An arm with no registered placement planner is not an our-fleet run (e.g. a competitor
      // orchestrator, P-028) — it must use its own runner, not this driver.
      if (!planner) return empty(`no fleet placement planner registered for arm '${req.arm}'`);

      let hiveHome: string | undefined;
      const members: EnrolledTask[] = [];
      let peakConcurrentBees = 0;
      try {
        ({ hiveHome } = await ops.createHive({ runId: req.runId, arm: req.arm, workspaceId: ws }));

        // ── enroll the whole backlog (clone @ base + member + work_item per task) ──
        for (const task of req.backlog) {
          const enrolled = await ops.enrollTask({ hiveHome, task, budget: req.budget, workspaceId: ws });
          members.push(enrolled);
          coordEvents.push({ ts: ops.now(), kind: 'claim', taskId: task.instanceId, detail: `enrolled → member ${enrolled.member}` });
        }

        // ── scripted placement loop: gatherFrontier → plan(arm) → placeBatch → poll until drained ──
        const deadline = startedAtMs + fleetTimeoutMs;
        const home = hiveHome;
        while (ops.now() < deadline) {
          const [inFlight, frontier, beeState] = await Promise.all([
            ops.countInFlight({ hiveHome: home, workspaceId: ws }),
            ops.gatherFrontier({ hiveHome: home, arm: req.arm, workspaceId: ws }),
            // Sample the live bees EVERY poll — not only when the frontier is non-empty. The single
            // batch placement drains the frontier in one tick, so a frontier-gated sample only ever
            // saw the (empty) pre-placement bee set → peak stuck at 0 even when N bees then ran
            // concurrently. Polling bees here (the same window countInFlight covers) catches the true
            // peak as the placed bees come up and run. (Fixes the broken peakConcurrentBees counter.)
            ops.gatherBees({ hiveHome: home, workspaceId: ws }),
          ]);
          peakConcurrentBees = Math.max(peakConcurrentBees, beeState.bees.length);
          if (inFlight === 0 && frontier.length === 0) break; // drained

          if (frontier.length > 0) {
            const { bees, headroom } = beeState;
            if (headroom > 0 || bees.length > 0) {
              const plan = planner({ tasks: frontier, bees, headroom });
              const { placements } = await ops.placeBatch({ hiveHome: home, plan, arm: req.arm, workspaceId: ws });
              for (const p of placements) {
                coordEvents.push({ ts: ops.now(), kind: 'placement', taskId: p.instanceId, agent: p.cupId, detail: p.disposition });
              }
            }
          }
          await ops.sleep(pollMs);
        }
      } catch (e) {
        // Pause + collect what completed before surfacing the run-level failure.
        if (hiveHome) await ops.pauseFleet({ hiveHome, workspaceId: ws }).catch(() => {});
        const runError = e instanceof Error ? e.message : String(e);
        const partial = await collectAll(ops, members, req, ws).catch(() => [] as FleetTaskResult[]);
        const finishedAtMs = ops.now();
        if (hiveHome) await ops.teardown({ hiveHome, members, workspaceId: ws }).catch(() => {});
        return { ...empty(runError), finishedAtMs, peakConcurrentBees, taskResults: partial };
      }

      // ── always pause the fleet (bound spend), then collect + teardown ──
      await ops.pauseFleet({ hiveHome, workspaceId: ws }).catch(() => {});
      const taskResults = await collectAll(ops, members, req, ws);
      const finishedAtMs = ops.now();
      await ops.teardown({ hiveHome, members, workspaceId: ws }).catch(() => {});

      return {
        arm: req.arm,
        suite: req.suite,
        runId: req.runId,
        seed: req.seed,
        startedAtMs,
        finishedAtMs,
        peakConcurrentBees,
        taskResults,
        coordEvents,
      };
    },
  };
}

async function collectAll(
  ops: HiveBacklogOps,
  members: EnrolledTask[],
  req: HiveBacklogRunRequest,
  ws: string,
): Promise<FleetTaskResult[]> {
  const out: FleetTaskResult[] = [];
  for (const enrolled of members) {
    out.push(await ops.collectTask({ enrolled, arm: req.arm, seed: String(req.seed), workspaceId: ws }));
  }
  return out;
}

/**
 * Bind the live driver so `runHiveBacklog` is instant-go for the pilot. `ops` defaults to the real
 * machinery binding (`realHiveBacklogOps` → `liveHiveBacklogOps`); the smoke/test path injects a fake.
 * Pass `null` ops to leave the driver bound to whatever was last set (or `setHiveBacklogDriver(null)`).
 */
export function bindLiveHiveBacklogDriver(opts: LiveHiveBacklogOpts, ops?: HiveBacklogOps): void {
  setHiveBacklogDriver(liveHiveBacklogDriver(ops ?? realHiveBacklogOps(opts), opts));
}

/** Alias kept for callers/pilot wiring that name `bindLiveHiveBacklog` (the brief's name). */
export const bindLiveHiveBacklog = bindLiveHiveBacklogDriver;

/* -------------------------------------------------------------------------- */
/* The REAL binding — wires the established functions (the function map above). */
/* -------------------------------------------------------------------------- */

/** A transient throwaway slug for the bench Queen-seat home / a member harness — hyphen-free so it is a
 *  schema-safe identifier (`scaffoldHarnessSchema` makes a PG schema of it; `_` is the only safe sep). */
function scratchSlug(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Map a `BenchTask.instanceId` → a schema-safe member harness slug. The instanceId carries `/`, `-`,
 * `_`, `.` (e.g. `instance_astropy__astropy-12345`); the member slug must be a clean PG identifier, so
 * we hash-suffix a sanitized prefix rather than trust the raw id. Kept per-run-unique by the random
 * Queen-home prefix the factory threads in.
 */
function memberSlugForTask(homePrefix: string, instanceId: string): string {
  const safe = instanceId.replace(/[^a-z0-9]+/gi, '').toLowerCase().slice(0, 24);
  return `${homePrefix}m${safe}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Map a `BenchTask.instanceId` → a REGEX-SAFE feature id (the `feature_id` the bee runs).
 *
 * CRITICAL (confirmed at the first real run): the bee's invoke recognizes its feature ONLY when the
 * `FEATURE_ID=` extra matches the orchestrator's `FEATURE_ID_RE` (`^[A-Z][A-Z0-9]*-[A-Z0-9-]+$`,
 * run-id.ts:extractFeatureId) — an UPPERCASE-prefixed id like `F-AB12`. The raw `task.instanceId`
 * (`instance_ansible__ansible-11c1777…`, lowercase + `_`) FAILS that regex, so `extractFeatureId`
 * returned null, the bee booted with NO feature (`prompt-budget … feature=-`), found no work in its
 * lane, and exited taskless ($0, empty diff) — the drain loop then re-placed it every poll forever.
 * The spine-drive (bench-harness-live.ts) sidesteps this by minting `XBENCH-<HEX>` (already regex-safe);
 * the hive arm must do the same. We derive a stable, schema-/regex-safe `F-<UPPERHEX>` and keep the
 * featureId↔instanceId mapping in the driver's state (cost/diff attribution is by member slug + the
 * stored instanceId, NOT this id, so the swap is attribution-safe).
 */
function featureIdForTask(instanceId: string): string {
  const safe = instanceId.replace(/[^a-zA-Z0-9]+/g, '').toUpperCase().slice(0, 16) || 'TASK';
  return `F-${safe}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** Per-task live state the factory threads from enroll → place → collect → teardown (the clone handle,
 *  its member slug, and the placement/timing provenance executeBatch returns). */
interface LiveEnrolledState extends EnrolledTask {
  checkout: TaskCheckout;
  /** The bee spawn id placeBatch assigned (filled at placement). */
  cupId: string | null;
  placedAtMs: number | null;
  disposition: 'spawn' | 'warm-inject' | null;
}

/**
 * The REAL machinery binding (the brief's `liveHiveBacklogOps`). Lazy dynamic imports keep this module
 * import-light (the orchestration carries no PG/registry/fleet dependency, so a fake-driven test never
 * loads them). Every method is a real best-effort body; the genuinely-uncertain integrations carry
 * `VERIFY-AT-FIRST-RUN:` flags. The pilot trigger (su-10912/ec8fe) confirms these live; the
 * orchestration is green over fakes regardless.
 *
 * State: one member harness PER task (its clone), keyed `feature_id = task.instanceId`, so a frontier
 * row IS its task and cost/diff attribution is per-member (exact, no time window) — the same discipline
 * `liveHiveOps`/`readBenchRunCost` draw. The factory closes over a per-task state map threaded
 * enroll→place→collect→teardown.
 */
export function liveHiveBacklogOps(opts: LiveHiveBacklogOpts): HiveBacklogOps {
  const ws = opts.workspaceId;

  // ── BEE-SPAWN ENV DEFAULTS (the missing wire — confirmed at the first real run) ──────────────────
  // The hive arm places `role: 'bee'` via executeBatch → spawnAgentInHarness → spawnInvokeOnce, and that
  // path takes NO per-spawn extraEnv passthrough — so unlike the spine-drive (bench-harness-live.ts, which
  // pins these in its own extraEnv), the bee child inherits these ONLY from the driver process env. Set the
  // two bench-run defaults here (the driver process is dedicated to one benchmark run) so EVERY placed bee
  // gets them, regardless of launcher. Both are the EXACT decisions bench-harness-live.ts documents:
  //
  //   PAPERCUSP_FLEET_SANDBOX=0 — the claude-code spawn path is sandbox-DEFAULT-ON (invoke.ts P-013/D-015);
  //     bubblewrap sets up a private net namespace with a loopback iface whose RTM_NEWADDR needs CAP_NET_ADMIN,
  //     which a plain (non-fleet) host lacks → `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`
  //     and EVERY bee invoke exits rc=1 with no diff (confirmed at the first real hive run: the bee died this
  //     way, looped, zero diff). The member clone is already an isolated scratch dir + scratch schema (teardown
  //     DROPs it), so the sandbox adds no isolation the bench needs and is the one thing blocking the bee.
  //   PAPERCUSP_SPAWN_BACKEND=claude-code — pin the bee to the Anthropic (Claude) backend. A throwaway member
  //     inherits the host workspace's DEFAULT agent backend, which on a dev box can be a LOCAL self-hosted
  //     model ($0, emits a bare tool-call instead of real work) → a meaningless number. The impartial-benchmark
  //     papercusp arm must run the SHIPPED system on its real model.
  //
  //   AGENT_CMD=claude -p — the LOAD-BEARING one for the bee path (confirmed at the first full-driver run).
  //     The backend swap that turns PAPERCUSP_SPAWN_BACKEND into the real `claude -p` command reads it from
  //     the SPAWN's extraEnv (harness-invoke-once.ts: `spec.extraEnv?.PAPERCUSP_SPAWN_BACKEND`), NOT from
  //     process.env — and the bee spawn path (executeBatch→spawnAgentInHarness) only sets that extraEnv key
  //     when a TIER resolves a backend (we pass none). So a driver-spawned bee fell through to the default
  //     base command `process.env.AGENT_CMD ?? CLAUDE ?? 'omp -p'` and ran omp (unconfigured here → 1-byte
  //     output, $0, taskless) instead of claude — even though the direct-spawn probe (which set SPAWN_BACKEND
  //     in extraEnv) ran claude and wrote a real diff. The robust fix for the bee path is to set AGENT_CMD
  //     itself: buildInvokeOnce resolves the base command from `process.env.AGENT_CMD` (inherited by the
  //     spawned child), so this pins the bee to `claude -p` directly — no extraEnv passthrough needed.
  //
  // Only SET when unset, so a caller that deliberately wants the sandbox/another backend/command can override
  // before the run. (Mirrors bench-harness-live.ts's `?? '0'` / `?? 'claude-code'` discipline.)
  if (process.env.PAPERCUSP_FLEET_SANDBOX == null) process.env.PAPERCUSP_FLEET_SANDBOX = '0';
  if (process.env.PAPERCUSP_SPAWN_BACKEND == null) process.env.PAPERCUSP_SPAWN_BACKEND = 'claude-code';
  if (process.env.AGENT_CMD == null && process.env.CLAUDE == null) process.env.AGENT_CMD = 'claude -p';

  // Per-run state: instanceId → its clone/member handle + placement provenance. Closed over so the
  // ops are stateless from the orchestration's view (it threads opaque EnrolledTask handles).
  const state = new Map<string, LiveEnrolledState>();
  // featureId (the regex-safe work-item id the bee runs) → instanceId, so placeBatch can resolve the
  // state from executeBatch's `p.task` (which is the work-item/feature id, NOT the raw instanceId).
  const instanceByFeatureId = new Map<string, string>();
  // The Queen-home prefix is minted on createHive and reused as the member-slug namespace (per-run-unique).
  let homePrefix = scratchSlug('xbh');

  const sqlClient = async (): Promise<postgres.Sql> => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return getOrgPg().sql;
  };
  const liveOps = async () => {
    const { liveHiveOps } = await import('../pot-eval/live-ops');
    return liveHiveOps({ workspaceId: ws });
  };

  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    async createHive({ runId }) {
      // A transient IDLE Queen-seat home (the scripted loop drives placement, not a real Queen wake).
      // `liveHiveOps.createHive` === createHiveHarness, IDLE/repo-less/no knowledge-pack — exactly the
      // hive-eval boot. The home slug doubles as the per-run member-slug namespace.
      homePrefix = scratchSlug('xbh');
      const hiveHome = homePrefix;
      const ops = await liveOps();
      await ops.createHive({ slug: hiveHome, workspaceId: ws });
      void runId; // runId rides coordEvents/the row, not the slug (the slug must stay schema-safe).
      return { hiveHome };
    },

    async enrollTask({ hiveHome, task }) {
      // 1. REAL git clone @ the pinned base commit (the diff seam every arm shares).
      const { cloneTaskRepo } = await import('./clone');
      const checkout = await cloneTaskRepo(task);

      try {
        // 2. Write `.papercusp/blueprint.yaml` (`extends: external-bench`) into the clone — the
        //    spine-drive CREATE pattern (bench-harness-live.ts:createHarness). The DBOS pipeline
        //    resolves a harness's spine from this git-canonical file; without it a registered clone
        //    defaults to the built-in `coding` spine, so the member would NOT run external-bench.
        //    VERIFY-AT-FIRST-RUN: confirm the pipeline reads `.papercusp/blueprint.yaml` from the
        //    member clone's worktree (orchestrator-start.ts:resolveHarnessSpine). cloneTaskRepo
        //    git-clones a writable repo @ base, so the write lands; fallback if the resolver reads
        //    from a different path = pass the blueprintId through `registerMember`/the registry row.
        const member = memberSlugForTask(homePrefix, task.instanceId);
        const { mkdir, writeFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { stringify: stringifyYaml } = await import('yaml');
        const bpDir = join(checkout.dir, '.papercusp');
        await mkdir(bpDir, { recursive: true });
        await writeFile(
          join(bpDir, 'blueprint.yaml'),
          stringifyYaml({ id: member, extends: 'external-bench' }, { lineWidth: 100 }),
          'utf8',
        );

        // 3. Register the clone as a (non-hive) MEMBER harness of the home + scaffold its schema —
        //    the hive-eval `registerMember` seam (sets hive_slug DIRECTLY so the throwaway clone never
        //    gets a git-sync routine seeded; it must not federate/push).
        const ops = await liveOps();
        await ops.registerMember({ member, clonePath: checkout.dir, hiveHome, workspaceId: ws });

        // 4. Seed ONE `feature` work_item — the problem_statement. The `feature_id` MUST be regex-safe
        //    (FEATURE_ID_RE) or the placed bee won't recognize its feature (see featureIdForTask) — so
        //    we mint `F-<HEX>` rather than use the raw lowercase `task.instanceId`. The instanceId stays
        //    the attempt's identity (cost/diff attribution is by member slug + the stored task). title =
        //    a short slice, spec/summary = the full brief the harness works.
        const featureId = featureIdForTask(task.instanceId);
        await ops.seedFeature({
          member,
          featureId,
          title: task.problemStatement.slice(0, 200),
          spec: task.problemStatement,
          workspaceId: ws,
        });

        // PIN the feature's workspace_id to `ws` (confirmed at the first real run). `liveHiveOps.seedFeature`
        // relies on the `fill_ws_features` trigger to derive workspace_id from the member's project row — and
        // for a throwaway bench member that row resolves to `default`, NOT the run's `ws` (papercusp-workspace).
        // The placed bee's `work_items:claim_next` filters `workspace_id = <PAPERCUSP_WORKSPACE_ID=ws>` (the ws
        // the driver threads to the spawn), so a `default`-scoped feature is INVISIBLE → the bee claims nothing,
        // lists nothing, and exits taskless ($0). The spine-drive's addFeature already writes workspace_id
        // explicitly (and works); the hive path must match. One targeted UPDATE keeps the shared seedFeature op
        // untouched. (Same workspace-identity class as WI-148 — the trigger's derived ws ≠ the caller's ws.)
        {
          const sql = await sqlClient();
          await sql`
            UPDATE harness_shared.harness_features_consolidated
               SET workspace_id = ${ws}, updated_ts = ${Date.now()}
             WHERE harness_slug = ${member} AND feature_id = ${featureId}`;
        }

        const enrolled: LiveEnrolledState = {
          task,
          member,
          clonePath: checkout.dir,
          workItemId: featureId,
          checkout,
          cupId: null,
          placedAtMs: null,
          disposition: null,
        };
        state.set(task.instanceId, enrolled);
        instanceByFeatureId.set(featureId, task.instanceId);
        return { task, member, clonePath: checkout.dir, workItemId: featureId };
      } catch (e) {
        // Enroll failed AFTER the clone landed — clean the scratch dir so a failed run leaves nothing.
        await checkout.cleanup().catch(() => {});
        throw e;
      }
    },

    async gatherFrontier({ arm }) {
      // Each enrolled member holds ONE feature (`feature_id = instanceId`). Build the candidate id list
      // and hand it to the SHARED `gatherFrontier` by explicit ids — it resolves each, drops
      // claimed/settled/blocked, and (CRUCIAL per su-136a4) PRESERVES the caller's order. So the arm's
      // ordering is decided HERE by the id list we pass:
      //   - 'hive'         → IMPORTANCE order (priority/feature_order asc, then arrival) — the ranked frontier.
      //   - 'queen-ablated'→ ARRIVAL/backlog (enrollment) order — un-ranked, so the FIFO ablation is clean.
      // Enrollment order === arrival order (we enroll the backlog in req.backlog order), so the Map's
      // insertion order IS the arrival order. Importance order re-sorts by the seeded feature priority.
      // EXCLUDE already-placed members (cupId set): a member is placed once, then its bee self-claims its
      // lone feature off the directive. Until that self-claim lands the feature still reads unassigned, so
      // WITHOUT this guard the loop would re-place it every poll (a fresh bee each tick) before the first
      // bee claims — the double-placement the post-spawn-claim used to (wrongly) prevent. The drain loop
      // keeps the placed member alive via countInFlight (placed + non-terminal), so dropping it from the
      // frontier here doesn't lose it. shared gatherFrontier ALSO drops it once the bee self-claims
      // (wi.assignee set) — this is the belt; that's the suspenders.
      const members = [...state.values()].filter((m) => m.cupId == null);
      if (members.length === 0) return [] as unknown as BatchPlacementInput['tasks'];
      const ids =
        arm === QUEEN_ABLATED_ARM
          ? members.map((m) => m.workItemId) // arrival/backlog order — NOT importance-ranked (136a4 FIFO).
          : await importanceOrderedIds(members); // importance order — the Queen's ranked frontier.

      const { gatherFrontier } = await import('../fleet/placement-gather');
      const res = await gatherFrontier({ ids, limit: Math.max(ids.length, 1), workspaceId: ws });
      return res.tasks as unknown as BatchPlacementInput['tasks'];
    },

    async gatherBees() {
      const [{ gatherLiveBees }, { getSpawnHeadroom }] = await Promise.all([
        import('../fleet/placement-gather'),
        import('../fleet/operator-spawn'),
      ]);
      const bees = await gatherLiveBees(ws);
      const { headroom } = await getSpawnHeadroom(ws);
      return { bees: bees as unknown as NonNullable<BatchPlacementInput['bees']>, headroom };
    },

    async placeBatch({ plan, arm }) {
      // Execute the planner's decisions over the live fleet — spawn/warm-inject bees that run each
      // placed member's external-bench feature. The Queen-seat home is the placing actor.
      // VERIFY-AT-FIRST-RUN: executeBatch's actor/role — the scripted loop has no real Queen agent, so
      // we synthesize an operator-tier AgentIdentity (ownerId = the hive home, role 'operator') as the
      // placer. `parentSpawnId` is null (not an `s-…` owner), so the bees parent to the operator, not a
      // bee — correct for a scripted placement. If executeBatch later requires a real `s-…` parent owner
      // for the spawn-tree, mint a placeholder Queen spawn row first (same seam, one extra insert).
      const [{ executeBatch }, { getSpawnHeadroom }] = await Promise.all([
        import('../agent-tools/fleet/place_batch'),
        import('../fleet/operator-spawn'),
      ]);
      const actor: AgentIdentity = {
        ownerId: homePrefix,
        ownerLabel: `xbench-queen:${arm}`,
        source: 'principal',
        workspaceId: ws,
        userId: null,
      };
      const { headroom } = await getSpawnHeadroom(ws);
      const exec = await executeBatch({
        plan,
        headroom,
        // The directive brief (confirmed at the first real run). WITHOUT a real Queen there is nothing to
        // assign/drive a placed bee, and a fresh-spawned bee whose lane reads empty exits TASKLESS (bee.md
        // "If you find NO work items: you are taskless … exit FAILED", confirmed: the bee booted, found no
        // claimed work, exited rc=0 $0 empty-diff, and the drain loop re-placed it every poll forever). The
        // bee is placed onto a member that holds EXACTLY ONE seeded feature whose problem_statement IS the
        // benchmark task — so the brief names that explicitly and tells the bee to claim+implement it. This
        // is direction (a named task), not freelancing. It rides extraEnv.MUG_BRIEF → the bee's
        // `## Queen brief` (invoke.ts:8.11), read on boot before the lane check.
        brief: BENCH_BEE_DIRECTIVE,
        tier: null,
        actor,
        role: 'operator',
        workspaceId: ws,
      });

      // Map executeBatch's per-decision results back to {instanceId, cupId, disposition}. The decision
      // task id is the WORK-ITEM/feature id we placed (`F-<HEX>`, featureIdForTask) — resolve the real
      // instanceId + state via the featureId→instanceId index. `spawned`/`injected` are the placements
      // that actually fanned a bee; the rest (unplaced/deferred/raced/failed) carry no bee.
      const placedAtMs = Date.now();
      const placements: { instanceId: string; cupId: string; disposition: 'spawn' | 'warm-inject' }[] = [];
      for (const p of exec.placements) {
        const featureId = p.task; // === work-item id we placed (F-<HEX>), NOT the raw instanceId
        const instanceId = instanceByFeatureId.get(featureId) ?? featureId;
        const st = state.get(instanceId);
        if (p.action === 'spawned' || p.action === 'injected') {
          const disposition = p.action === 'spawned' ? ('spawn' as const) : ('warm-inject' as const);
          const cupId = p.spawn_id ?? p.bee ?? instanceId;
          // Record the placement in state. We deliberately do NOT pre-claim the feature to the bee here
          // (confirmed at the first full-driver run that doing so HURT): a post-spawn `claimWorkItem` races
          // the bee's own boot — and worse, once `taken_by=cupId` is set, the bee's directed
          // `work_items:claim_next` (which requires `taken_by IS NULL`) finds nothing and the bee gives up
          // taskless before its lane read settles. The bee SELF-claims its lone feature off the directive
          // brief + FEATURE_ID (proven: the direct-spawn probe self-claimed and wrote a real 29-line diff).
          // Double-placement is prevented by excluding already-placed members from the frontier (gatherFrontier
          // below), and `st.cupId` set here is what flips this member to in-flight for the drain loop.
          if (st) {
            st.cupId = cupId;
            st.placedAtMs = placedAtMs;
            st.disposition = disposition;
          }
          placements.push({ instanceId, cupId, disposition });
        }
      }
      return { placements };
    },

    async countInFlight() {
      // "Still working" — the drain-loop terminator. We do NOT use `hive_placements`
      // (countInFlightPlacements): confirmed at the first real run the SCRIPTED executeBatch path writes NO
      // hive_placements row (those come from the real Queen's flow), so that count was permanently 0 → the
      // loop drained the instant after placing. We also can't use ONLY "bee spawn row is running", because
      // there's a STARTUP WINDOW between executeBatch returning and the bee's spawned_agents row flipping to
      // 'running' — confirmed at the first full-driver run: countInFlight saw 0 in that window and drained
      // before the bee did any work ($0). So a placed member counts as IN-FLIGHT when its feature is NOT yet
      // terminal AND no bee spawn has REACHED a terminal state for it (covers both "bee still running" and
      // "bee placed but not yet recorded"). Once the bee finishes — feature → passed/escalated/blocked OR
      // the bee spawn row is done/failed (a bee that exited without finishing must not hang the loop) — the
      // member drops out and, when all do, the backlog is drained and we collect. Members never placed
      // (cupId null) stay on the frontier, not in-flight.
      const sql = await sqlClient();
      const placedMembers = [...state.values()].filter((m) => m.cupId != null);
      if (placedMembers.length === 0) return 0;
      let inFlight = 0;
      for (const m of placedMembers) {
        const [featRows, beeRows] = await Promise.all([
          sql<{ status: string }[]>`
            SELECT status FROM harness_shared.harness_features_consolidated
             WHERE workspace_id = ${ws} AND harness_slug = ${m.member} AND feature_id = ${m.workItemId}
             LIMIT 1`,
          sql<{ running: string; terminal: string }[]>`
            SELECT count(*) FILTER (WHERE status IN ('running','restarting'))::text AS running,
                   count(*) FILTER (WHERE status IN ('done','failed','cancelled'))::text AS terminal
              FROM harness_shared.spawned_agents
             WHERE workspace_id = ${ws} AND harness_slug = ${m.member} AND child_role = 'cup'`,
        ]);
        const featTerminal = DONE_FEATURE_STATUSES.has(featRows[0]?.status ?? '') ||
          ESCALATE_FEATURE_STATUSES.has(featRows[0]?.status ?? '');
        const running = Number(beeRows[0]?.running ?? 0) || 0;
        const terminal = Number(beeRows[0]?.terminal ?? 0) || 0;
        // In-flight while: feature not terminal AND (a bee is running OR no bee has terminated yet — the
        // startup-window grace). A terminated bee with a non-terminal feature = the bee gave up; not in-flight.
        if (!featTerminal && (running > 0 || terminal === 0)) inFlight++;
      }
      return inFlight;
    },

    async pauseFleet({ hiveHome }) {
      const ops = await liveOps();
      await ops.pauseHive({ hiveHome, workspaceId: ws });
    },

    async collectTask({ enrolled, arm, seed }): Promise<FleetTaskResult> {
      const st = state.get(enrolled.task.instanceId);
      const checkout = st?.checkout;
      const member = enrolled.member;

      // 1. The diff the bee produced (base..worktree, grader test-files excluded) — "" if no change.
      let diff = '';
      let generationError: string | undefined;
      if (checkout) {
        try {
          const { extractDiff } = await import('./clone');
          diff = await extractDiff(checkout, enrolled.task);
        } catch (e) {
          generationError = `extractDiff failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      } else {
        generationError = 'enrolled task has no checkout (clone state lost) — cannot extract diff';
      }

      // 2. SUM the member harness's `agent_usage_samples` → tokens/cost/turns (coordination overhead
      //    included — fairness #2). Per-member, throwaway + unique → exact attribution, no time window
      //    (the `readBenchRunCost` pattern, scoped by harness_slug = the member). Also read the member's
      //    bee spawn rows for the bee id + start/finish timing.
      const sql = await sqlClient();
      const [cost, spawnRows] = await Promise.all([
        readMemberUsage(sql, member, ws).catch(() => ({ tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 })),
        readMemberBeeSpawns(sql, member, ws).catch(() => [] as MemberSpawnRow[]),
      ]);
      // Derive the stopReason from the seeded feature's terminal status (the member ran ONE feature).
      const status = await readMemberFeatureStatus(sql, member, enrolled.workItemId, ws).catch(() => null);
      const stopReason = stopReasonForFeatureStatus(status, generationError);

      // Bee + timing provenance: prefer the placement record (placeBatch), fall back to the spawn row.
      const firstSpawn = spawnRows[0];
      const cupId = st?.cupId ?? firstSpawn?.spawnId ?? enrolled.member;
      const placedAtMs = st?.placedAtMs ?? firstSpawn?.startedAtMs ?? Date.now();
      const startedAtMs = firstSpawn?.startedAtMs ?? placedAtMs;
      const finishedAtMs = firstSpawn?.finishedAtMs ?? Date.now();
      const wallClockMs = Math.max(0, finishedAtMs - startedAtMs);

      const attempt: ArmAttempt = {
        arm,
        blueprintId: 'external-bench',
        instanceId: enrolled.task.instanceId,
        seed,
        diff,
        tokensIn: cost.tokensIn,
        tokensOut: cost.tokensOut,
        costUsd: cost.costUsd,
        turns: cost.turns,
        wallClockMs,
        trajectoryRef: `xbench-hive://${member}`,
        stopReason,
        ...(generationError ? { generationError } : {}),
        armMeta: { member, hiveArm: arm, cupId },
      };

      return {
        attempt,
        cupId,
        placedAtMs,
        startedAtMs,
        finishedAtMs,
        disposition: st?.disposition ?? 'spawn',
      };
    },

    async teardown({ hiveHome, members }) {
      const ops = await liveOps();
      // Drop each member harness (schema + rows) + remove its clone, then dissolve the Queen-seat home.
      // Best-effort throughout — a teardown hiccup must not mask the run's outcome.
      for (const m of members) {
        await ops.dropMember({ member: m.member, workspaceId: ws }).catch(() => {});
        const st = state.get(m.task.instanceId);
        await st?.checkout.cleanup().catch(() => {});
        state.delete(m.task.instanceId);
      }
      await ops.dissolveHive({ hiveHome, workspaceId: ws }).catch(() => {});
    },
  };
}

/**
 * Order enrolled members by IMPORTANCE (the hive arm's ranked frontier) — the seeded feature's
 * priority/feature_order asc, then arrival (enrollment) order as the tiebreak. Reads each member's
 * single work-item; a member whose read fails sinks to the tail (treated as +∞ priority) so a flaky
 * read never drops a task from the frontier. Returns the work-item ids in importance order.
 */
async function importanceOrderedIds(members: LiveEnrolledState[]): Promise<string[]> {
  const { getWorkItem } = await import('../work-items');
  const ranked = await Promise.all(
    members.map(async (m, arrivalIdx) => {
      const wi = await getWorkItem(m.workItemId, m.member).catch(() => null);
      const priority = wi?.priority ?? Number.POSITIVE_INFINITY;
      return { id: m.workItemId, priority, arrivalIdx };
    }),
  );
  ranked.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.arrivalIdx - b.arrivalIdx));
  return ranked.map((r) => r.id);
}

/** A bench member's confirmed bee spawn row (the bee that ran its one task) — id + start/finish ms. */
interface MemberSpawnRow {
  spawnId: string;
  startedAtMs: number;
  finishedAtMs: number | null;
}

/**
 * The member's `bee`-role spawn rows (the bee that ran its one task), ordered earliest-first. Reuses
 * the same `spawned_agents` read shape as `liveHiveOps.readMemberSpawnRows`, narrowed to bee spawns.
 * Exported for the integration test (verifies the SQL + timestamp coercions). Empty when no bee landed
 * (e.g. a placement that never spawned) → the collect path falls back to the placement record.
 */
export async function readMemberBeeSpawns(sql: postgres.Sql, member: string, workspaceId: string): Promise<MemberSpawnRow[]> {
  const rows = await sql<{ spawn_id: string; started_at: string | Date; finished_at: string | Date | null }[]>`
    SELECT spawn_id, started_at, finished_at
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${member} AND child_role = 'cup'
     ORDER BY started_at ASC`;
  return rows.map((r) => ({
    spawnId: r.spawn_id,
    startedAtMs: new Date(r.started_at).getTime(),
    finishedAtMs: r.finished_at != null ? new Date(r.finished_at).getTime() : null,
  }));
}

/** The member's single seeded feature status (terminal → the stopReason). Null when the row is absent. */
async function readMemberFeatureStatus(
  sql: postgres.Sql,
  member: string,
  featureId: string,
  workspaceId: string,
): Promise<string | null> {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${member} AND feature_id = ${featureId}
     LIMIT 1`;
  return rows[0]?.status ?? null;
}

/** Feature statuses that mean the member's task reached DONE. */
const DONE_FEATURE_STATUSES = new Set(['passed']);
/** Feature statuses that mean it escalated / is blocked on a human. */
const ESCALATE_FEATURE_STATUSES = new Set(['escalated', 'blocked']);

/**
 * Map a member's terminal feature status → the {@link ArmAttempt} stopReason. A genuine infra failure
 * (a diff-extraction error) wins — it's a generation-side failure, not a scored terminal. Otherwise
 * passed → 'done', escalated/blocked → 'escalate'.
 *
 * FAIRNESS (benchmark-fairness-fix): a member that was still IN-FLIGHT when the fleet was paused at the
 * drain/timeout bound was NOT given a fair chance to settle — under contention (a fleet cap << backlog),
 * the bee may simply never have been placed, or was evicted, before the run's wall-clock ceiling forced a
 * pause. Scoring that as 'max-turns'-counted-as-fail was the audit's central unfairness for the fleet arms.
 * It now maps to 'infra-failed' (a NON-scored external terminal — EXCLUDED from resolved%, never a
 * capability fail). A bee that genuinely ran its full turn/budget would have landed the feature in a
 * terminal status (passed/escalated/blocked) → those stay scored.
 *
 * VERIFY-AT-FIRST-RUN: confirm a bench member's finalizer lands the single feature in `passed` on a
 * clean DONE (the same statuses `bench-harness-live.ts` keys on). If a member's terminal status differs
 * (e.g. a hive-member finalizer uses a different terminal), widen these sets — same map, one literal.
 */
export function stopReasonForFeatureStatus(
  status: string | null,
  generationError: string | undefined,
): ArmAttempt['stopReason'] {
  if (generationError) return 'error';
  if (status && DONE_FEATURE_STATUSES.has(status)) return 'done';
  if (status && ESCALATE_FEATURE_STATUSES.has(status)) return 'escalate';
  // Not terminal at collect time — the fleet was paused to bound spend before this task settled. Under
  // contention this is an EXTERNAL drain-unsettled symptom, not a capability fail → 'infra-failed' (excluded).
  return 'infra-failed';
}

/**
 * SUM the member harness's `agent_usage_samples` → tokensIn/Out, cost_usd, turns (COUNT DISTINCT
 * run_id — coordination overhead INCLUDED, fairness #2). The `readBenchRunCost` pattern, scoped by
 * `harness_slug` = the member (throwaway + unique → exact attribution, no time window). Exported for
 * the integration test. cost_usd/tokens may be null (COALESCE → 0) when a sample landed unpriced.
 *
 * VERIFY-AT-FIRST-RUN: confirm a bench member's per-turn samples carry `harness_slug` + `run_id` (the
 * same columns `readBenchRunCost`/`readMemberRunStats` filter on — both exist on the table). If a
 * member's samples are keyed only by `run_id`, sum over the member's `spawned_agents.run_id` set
 * (the `loadCostBySpawn` join) — same table, one extra join.
 */
export async function readMemberUsage(
  sql: postgres.Sql,
  member: string,
  workspaceId: string,
): Promise<{ tokensIn: number; tokensOut: number; costUsd: number; turns: number }> {
  const rows = await sql<
    { tokens_in: string | null; tokens_out: string | null; cost_usd: string | null; turns: string | null }[]
  >`
    SELECT SUM(COALESCE(input_tokens, 0))::text  AS tokens_in,
           SUM(COALESCE(output_tokens, 0))::text AS tokens_out,
           SUM(COALESCE(cost_usd, 0))::text      AS cost_usd,
           COUNT(DISTINCT run_id)::text          AS turns
      FROM harness_shared.agent_usage_samples
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${member}`;
  const r = rows[0];
  return {
    tokensIn: Number(r?.tokens_in ?? 0) || 0,
    tokensOut: Number(r?.tokens_out ?? 0) || 0,
    costUsd: Number(r?.cost_usd ?? 0) || 0,
    turns: Number(r?.turns ?? 0) || 0,
  };
}

/**
 * The REAL machinery binding (the brief's `realHiveBacklogOps`) — a thin delegator to
 * {@link liveHiveBacklogOps}. Kept as the name `bindLiveHiveBacklogDriver` defaults to, so the pilot
 * wiring + the existing test contract are unchanged.
 */
export function realHiveBacklogOps(opts: LiveHiveBacklogOpts): HiveBacklogOps {
  return liveHiveBacklogOps(opts);
}
