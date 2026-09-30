/**
 * hive-backlog-realqueen.ts — the REAL-QUEEN-vs-no-Queen backlog driver
 * (impartial-benchmark-suite-2026-06-15 / P-033, owner-directed Option B).
 *
 * WHY THIS EXISTS (the structural-null fix, D-015→P-033). The scripted driver
 * ({@link ../external-bench/hive-backlog-live.ts liveHiveBacklogDriver}) drives BOTH its arms with a
 * SCRIPTED placement loop (`getFleetPlanner` → planBatchPlacement vs planFifoPlacement) over
 * one-isolated-hive-PER-task members. queen-ablation.ts states it outright: "EVICTION /
 * RE-PLACEMENT / ADAPTATION — out of scope for BOTH planners". So NEITHER scripted arm runs the real
 * Queen; the only diff is importance-vs-FIFO ordering over isolated single-feature members → affinity
 * always 0, importance degenerate → identical placements (the prior pilot: hive 2/11 vs ablated 3/11,
 * coordEvents 22==22, MAST 0). That A/B cannot measure the Queen.
 *
 * THIS driver measures the ACTUAL Queen. It boots ONE hive holding the WHOLE backlog as N member
 * harnesses (one cloned bench task each, blueprint `external-bench`), then:
 *   - HIVE_REALQUEEN_ARM ('hive-realqueen'): `startHive` → the REAL Queen PERSONA AGENT wakes
 *     (`requestUrgentPotWake` → `fireLaunchBlueprint('hive')`). She surveys the multi-member frontier,
 *     ranks + places a capped bee fleet, the placement-watchdog (hive/placement-watchdog.ts) detects
 *     stuck/dead bees → fires recovery wakes → she RE-PLACES, attaches situational briefs, and declares
 *     her own adaptive wakes. The driver only POLLS surveyPot + countHivePlacementsInFlight until
 *     drained, then `pauseHive` to bound spend. The driver does NOT place — the Queen does.
 *   - FIFO_NOQUEEN_ARM ('fifo-noqueen'): the SAME boot, but the Queen NEVER wakes (no `startHive`).
 *     The driver runs the scripted `planFifoPlacement` loop over the same members + same fleet cap —
 *     FIFO, no eviction/re-placement/briefs/adaptive wake. The honest "no orchestration" pole.
 *
 * FAIRNESS (D-004): the two arms are IDENTICAL except the Queen treatment — same backlog, same fleet
 * cap (the global `maxSimultaneousAgents` ceiling), same per-task `external-bench` bee unit, same
 * iso-budget/task, same clone/diff/grader. The ONLY independent variable is the real Queen vs none.
 *
 * CONTENTION (the D-015 fix): ONE hive over the whole backlog with a fleet cap << backlog (set
 * `maxSimultaneousAgents` ~5 for ~13 tasks → ~3:1 saturation) so the Queen's live management actually
 * bites. The scripted driver's one-hive-per-task topology could never produce contention.
 *
 * COORDINATION CAPTURE (the MAST-non-zero fix): for the real-Queen arm coordEvents are reconstructed
 * from the REAL `pot_placements` ledger (placed/recovering/cursed/stranded + fail_count + the
 * watchdog's last_disposition) — so re-placements show as `rework`, stranded/cursed as breakdown, etc.
 * The FIFO arm writes NO pot_placements rows (the scripted path doesn't), so its coordination trace
 * stays at the synthetic-placement floor — the MAST delta is real, not manufactured.
 *
 * OPUS: the bee role-model floor is haiku and the queen floor is sonnet (orchestrator/role-models.ts),
 * so `AGENT_MODELS='{"bee":"opus:xhigh","queen":"opus:xhigh"}'` (both the placed bees AND the Queen) +
 * the `opus` CLI alias (claude v2.1.177 silently runs opus-4-7 for `--model claude-opus-4-8`) are
 * required. CRITICAL (D-020): a spawn's `--model`/backend is resolved at spawn-BUILD time from the
 * SPAWNING process's `process.env.AGENT_MODELS`/`AGENT_CMD` — and the Queen's `cup:spawn` is serviced by
 * the long-running :3170 host (`fireLaunchBlueprint('hive')` → loopback invoke), NOT this launcher. So for
 * the real-Queen arm the opus pin + `AGENT_CMD=claude -p` MUST be on the :3170 host env (apps/operator/
 * .env.local), not just the launcher. VERIFY `agent_usage_samples.model = claude-opus-4-8 role=bee`
 * (NOT haiku floor, NOT a no-usage omp/self fall-through) on a 1-task probe before any big spend.
 *
 * CONCURRENCY (D-019): the bee cap is the global `maxSimultaneousAgents` (`spawnConcurrencyCeiling()`) —
 * there is NO separate per-hive cap. It is a per-process module cache that does NOT cross processes, so to
 * make a cap < backlog bite for the Queen's spawns the launcher PUTs it to :3170's `operator:rate_limit_
 * config` route (which applies it IN the :3170 process). Setting it only in the launcher cache (the prior
 * bug) left :3170 at the default 16 → all bees ran at once, no contention.
 *
 * GOVERNOR: binding this spends nothing; the real LLM spend is the bees + the Queen running on the
 * gated launch. The drive always `pauseHive`s at drain/timeout to bound it.
 */
import type { CoordEvent } from '@papercusp/bench-metrics';
import type postgres from 'postgres';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { BatchPlacementInput, BatchPlacementPlan } from '../fleet/batch-placement';
import type { ArmAttempt, BenchTask, GenerationBudget, TaskCheckout } from './types';
import {
  getFleetPlanner,
  setHiveBacklogDriver,
  type ConcurrencyTimeline,
  type FleetTaskResult,
  type HiveBacklogDriver,
  type HiveBacklogResult,
  type HiveBacklogRunRequest,
} from './hive-backlog';
import {
  readMemberUsage,
  readMemberBeeSpawns,
  stopReasonForFeatureStatus,
} from './hive-backlog-live';

/** The two NEW arms this driver serves (open `FleetArmId` union). */
export const HIVE_REALQUEEN_ARM = 'hive-realqueen';
export const FIFO_NOQUEEN_ARM = 'fifo-noqueen';

/** Default drain-poll cadence + fleet-drain timeout (the bound on spend). */
const DEFAULT_POLL_MS = 20_000;
const DEFAULT_FLEET_TIMEOUT_MS = 120 * 60 * 1000; // 2h ceiling — a bounded run is far under.

/** Feature statuses that mean a member's task reached a terminal outcome (drain inputs). */
const DONE_FEATURE_STATUSES = new Set(['passed']);
const ESCALATE_FEATURE_STATUSES = new Set(['escalated', 'blocked']);

/**
 * The Queen-brief / bee directive a placed bench bee receives. In the REAL-Queen arm the Queen also
 * attaches her own situational brief; this is the standing task directive both arms' bees get (so a
 * bee placed by the FIFO loop — which has no Queen to brief it — still works its lone feature instead
 * of exiting taskless). Identical to the scripted driver's directive (fairness: same bee unit).
 *
 * D-020 (the CRITICAL fix). In the real-Queen arm the driver does NOT spawn the bee — the Queen persona
 * does, via `cup:spawn`, with HER situational overlay as the brief. Her overlay is NOT a "claim +
 * implement this lone bench feature" instruction, so a Queen-placed bee booted with FEATURE_ID set but no
 * directive to claim its (unassigned, `taken_by` NULL) feature → it found no actionable work and did $0 of
 * model work (no usage sample, no diff; the seeded feature later went `cancelled`). The WORKING scripted
 * arm avoids this precisely because EVERY bee it spawns (`executeBatch`) carries THIS directive (proven:
 * the xbh* haiku run produced 10/11 non-empty diffs, features → `passed`, with the feature left
 * `taken_by` NULL — the bee SELF-claims off the directive). The fix threads this directive to the
 * Queen-placed bee too: the bench launcher exports it as `PAPERCUSP_XBENCH_CUP_DIRECTIVE` on the host that
 * services the Queen's `cup:spawn` (the long-running :3170 operator), and `spawnAgentInHarness`
 * (operator-spawn.ts) APPENDS it to every placed bee's brief + pins the claude-code backend per-spawn. The
 * Queen's placement / eviction / re-placement / adaptive-wake treatment is entirely unchanged — she still
 * decides WHO/WHEN; the directive only guarantees the bee she places can actually DO the coding work.
 */
const BENCH_BEE_DIRECTIVE = [
  'You are placed on a single-task benchmark member harness. This member holds EXACTLY ONE feature work-item —',
  'the benchmark problem to solve. Claim it (`work_items:claim_next` for this harness, or',
  '`fleet:assignments { agent: <your spawn id> }` then `work_items:get` for the detail), read its full',
  'problem_statement, and IMPLEMENT the change directly in this repository as real code edits (a working',
  'unified diff against the checked-out base). Write the actual source fix — do not just plan or describe.',
  'When complete and the repo builds, mark the work-item complete (`work_items:complete`). You are NOT',
  'taskless — the assigned feature IS your task; do not exit FAILED for "no work". There is no',
  'validator/reviewer downstream; you own the fix end to end.',
].join(' ');

/** One enrolled backlog task — its member harness + clone, threaded to collect. */
export interface RealQueenEnrolled {
  task: BenchTask;
  member: string;
  clonePath: string;
  workItemId: string;
  checkout: TaskCheckout;
  /** The bee spawn id that served it (filled at collect from spawned_agents / pot_placements). */
  cupId: string | null;
  placedAtMs: number | null;
  disposition: 'spawn' | 'warm-inject' | null;
}

/**
 * The injected IO seam. ONE shared hive holds ALL members. Every side effect is one method so the
 * boot→enroll→drive→collect→teardown ordering + the drained predicate unit-test with fakes (no
 * git/PG/LLM). The real binding ({@link realQueenBacklogOps}) wires the established seams.
 */
export interface RealQueenBacklogOps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Mint the ONE shared Queen-seat hive home (IDLE — startHive wakes the real Queen for the hive arm). */
  createHive(input: { runId: string; arm: string; workspaceId: string }): Promise<{ hiveHome: string }>;
  /** Clone @ base → register an `external-bench` member of `hiveHome` → seed the problem_statement. */
  enrollTask(input: {
    hiveHome: string;
    task: BenchTask;
    budget: GenerationBudget;
    workspaceId: string;
  }): Promise<RealQueenEnrolled>;
  /** START the REAL Queen over the whole hive (setHiveStarted + requestUrgentPotWake → the queen agent). */
  startRealQueen(input: { hiveHome: string; kickoff: string; workspaceId: string }): Promise<void>;
  /**
   * RE-WAKE the Queen for ANOTHER survey→place cycle (requestUrgentPotWake only — the hive is already
   * started). The initial startRealQueen wakes her ONCE; on the staging host (:3170, DBOS routines off)
   * her first session can exit after a single survey without placing the whole frontier (observed: a
   * Queen ran 156s, placed 0 bees, exited `done`). The driver re-wakes her each poll while there is a
   * READY FRONTIER but NO live bees + nothing in flight — the missing "place the rest of the backlog"
   * nudge the auto-routine would otherwise deliver. Best-effort; a wake error must not abort the drive.
   */
  rewakeQueen(input: { hiveHome: string; reason: string; workspaceId: string }): Promise<void>;
  /**
   * Run ONE placement-watchdog sweep over the bench hive (the real eviction/re-placement backstop).
   * The watchdog normally rides the 30s routinesTick, but the staging operator (:3170) runs with
   * routines DISABLED (PAPERCUSP_DBOS_ROUTINES=0) — so the driver fires the sweep itself each poll,
   * scoped to the bench hive only (reconcileOnePot), to deliver the SAME stuck-bee detection →
   * recovery-wake → Queen re-placement the live hive gets, without enabling global staging routines.
   * Real-Queen arm only (no-op for FIFO). Best-effort — a sweep error must not abort the drive.
   */
  reconcileWatchdog(input: { hiveHome: string; workspaceId: string }): Promise<void>;
  /** surveyPot's ready-frontier + started-plan counts (the drained inputs) across all members. */
  survey(input: { hiveHome: string; workspaceId: string }): Promise<{ frontierLen: number; plansLen: number }>;
  /** Placements still in flight = the drain terminator. For the hive arm: pot_placements non-terminal.
   *  For the FIFO arm: members placed (cupId set) whose feature is non-terminal & bee not terminal. */
  countInFlight(input: { hiveHome: string; members: RealQueenEnrolled[]; arm: string; workspaceId: string }): Promise<number>;
  /** Count live bees (for the peak-concurrency metric — sampled every poll, the fixed counter). */
  countLiveBees(input: { hiveHome: string; workspaceId: string }): Promise<number>;
  /** Count this hive's currently-awake Queen launch rows (running/restarting). The re-wake gate: while a
   *  Queen is awake she is surveying/placing — re-waking would double-drive; only when ZERO are awake and
   *  ready frontier remains unplaced did her prior session exit without placing → a fresh wake is owed. */
  countLiveQueens(input: { hiveHome: string; workspaceId: string }): Promise<number>;
  /** Free spawn headroom + the FIFO arm's gather (live bees) — only used by the FIFO scripted loop. */
  gatherForFifo(input: { hiveHome: string; members: RealQueenEnrolled[]; workspaceId: string }): Promise<{
    tasks: BatchPlacementInput['tasks'];
    bees: NonNullable<BatchPlacementInput['bees']>;
    headroom: number;
  }>;
  /** Execute a FIFO plan (scripted-loop only) — spawn/warm-inject bees running external-bench. */
  placeFifoBatch(input: {
    hiveHome: string;
    plan: BatchPlacementPlan;
    members: RealQueenEnrolled[];
    workspaceId: string;
  }): Promise<{ placements: { instanceId: string; cupId: string; disposition: 'spawn' | 'warm-inject' }[] }>;
  /** Stop the hive — bound spend at drain/timeout (setHiveStarted false). */
  pauseFleet(input: { hiveHome: string; workspaceId: string }): Promise<void>;
  /** Per enrolled task: the diff + cost/timing → FleetTaskResult (cost summed from agent_usage_samples). */
  collectTask(input: { enrolled: RealQueenEnrolled; arm: string; seed: string; workspaceId: string }): Promise<FleetTaskResult>;
  /** The REAL coordination trace for the run (pot_placements ledger for the Queen arm; empty for FIFO). */
  collectCoordEvents(input: { hiveHome: string; members: RealQueenEnrolled[]; arm: string; workspaceId: string }): Promise<CoordEvent[]>;
  /** Drop every member + dissolve the shared hive + rm the clones. */
  teardown(input: { hiveHome: string; members: RealQueenEnrolled[]; workspaceId: string }): Promise<void>;
}

export interface RealQueenBacklogOpts {
  workspaceId: string;
  fleetTimeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * GAIA arm seam (plan benchmark-suite-gaia-2026-06-17). When present, the REAL ops binding
   * ({@link realQueenBacklogOps}) runs the GAIA general-assistant path instead of the SWE-bench coding
   * path — the SAME THREE SWAPS the su-independent driver makes (su-independent-backlog.ts): GAIA
   * scratch-dir clone (no repo), member blueprint `gaia-agent` + the question/answer.txt brief, and
   * `answer.txt` extraction into {@link ArmAttempt.answer} (diff:''). The Queen's
   * placement/eviction/re-placement/adaptive-wake treatment is entirely unchanged — only the bee UNIT
   * (research-assistant vs coding spine) + the work-product readout (answer.txt vs git diff) swap.
   * ADDITIVE: absent → today's unchanged SWE-bench behavior. The driver itself is GAIA-agnostic (the swap
   * is wholly inside the injected ops); the `answer` field flows through {@link collectTask}.
   */
  gaia?: GaiaArmSeamConfig;
  /**
   * DURABILITY hooks (P-033, the rate-limit-kill-resilience fix). The launcher writes per-task diffs +
   * an enrollment manifest INCREMENTALLY through these so a process killed mid-run (the Anthropic API
   * intermittently throttles + kills helpers) does NOT lose the bees' already-produced work — the
   * surviving worktrees are recoverable from the manifest, and any diff collected before the kill is
   * already on disk. Both optional + best-effort: a hook throw must NEVER abort the drive/collection.
   *   - `onEnrolled`  fires right after each member is enrolled (worktree cloned @ base) → persist the
   *     instanceId → clonePath → baseCommit → member mapping so a standalone recovery pass can re-extract.
   *   - `onTaskCollected` fires per member as `collectAll` finishes it → persist that one task's diff +
   *     row immediately, so a kill during the (serial) collect loop keeps every diff already gathered.
   *   - `onHiveCreated` fires the instant the shared hive home is minted (P-033 Fix 4, teardown-on-exit) →
   *     the launcher registers the slug so its SIGTERM/SIGINT/exit handler can pot:dissolve it even when a
   *     rate-limit SIGKILL bypasses the driver's normal/catch teardown — closing the D-022 orphan-respin gap.
   */
  onEnrolled?: (enrolled: RealQueenEnrolled) => void | Promise<void>;
  onTaskCollected?: (result: FleetTaskResult) => void | Promise<void>;
  onHiveCreated?: (hiveHome: string) => void | Promise<void>;
}

/** GAIA arm config — a presence flag is enough today; reserved for future per-arm GAIA tuning. Mirrors the
 *  su-independent driver's {@link import('./su-independent-backlog').GaiaArmSeamConfig}. */
export interface GaiaArmSeamConfig {
  /** Must be true to engage the GAIA path. */
  enabled: true;
}

/**
 * The LIVE {@link HiveBacklogDriver} over the injected {@link RealQueenBacklogOps}. Boots ONE hive
 * over the whole backlog, then drives the arm: real Queen (startHive + poll-until-drained) or scripted
 * FIFO (gather → planFifoPlacement → place → poll). Never throws (the generation-failure contract).
 */
export function realQueenBacklogDriver(ops: RealQueenBacklogOps, opts: RealQueenBacklogOpts): HiveBacklogDriver {
  const ws = opts.workspaceId;
  const fleetTimeoutMs = opts.fleetTimeoutMs ?? DEFAULT_FLEET_TIMEOUT_MS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;

  return {
    async run(req: HiveBacklogRunRequest): Promise<HiveBacklogResult> {
      const isRealQueen = req.arm === HIVE_REALQUEEN_ARM;
      const startedAtMs = ops.now();
      let coordEvents: CoordEvent[] = [];
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

      // FIFO arm needs a registered scripted planner (planFifoPlacement registered under FIFO_NOQUEEN_ARM
      // or QUEEN_ABLATED_ARM); the real-Queen arm needs none (the Queen agent places).
      const fifoPlanner = isRealQueen ? null : getFleetPlanner(req.arm);
      if (!isRealQueen && !fifoPlanner) return empty(`no FIFO placement planner registered for arm '${req.arm}'`);

      let hiveHome: string | undefined;
      const members: RealQueenEnrolled[] = [];
      let peakConcurrentBees = 0;
      // su-vs-queen-expansion P-003: record the live-concurrency timeline (not just the peak) so the
      // parallelism comparison shows actual-vs-cap for the hive arms too (the su-independent arm already
      // fills this). Each poll already computes liveBees; we just also append a {tMs, live} sample.
      const concurrencySamples: { tMs: number; live: number }[] = [];
      const buildTimeline = (): ConcurrencyTimeline => ({
        samples: concurrencySamples,
        avgConcurrent: concurrencySamples.length
          ? concurrencySamples.reduce((s, x) => s + x.live, 0) / concurrencySamples.length
          : 0,
        peakConcurrent: concurrencySamples.reduce((m, x) => Math.max(m, x.live), 0),
      });
      try {
        ({ hiveHome } = await ops.createHive({ runId: req.runId, arm: req.arm, workspaceId: ws }));
        // Register the hive slug with the launcher the instant it exists (P-033 Fix 4) so a
        // SIGKILL-bypassed teardown still dissolves it. Best-effort: a hook throw must not abort the drive.
        if (opts.onHiveCreated && hiveHome) {
          try {
            await opts.onHiveCreated(hiveHome);
          } catch {
            /* best-effort teardown-registration hook — ignore */
          }
        }

        // ── enroll the WHOLE backlog as members of the ONE shared hive ──
        for (const task of req.backlog) {
          const enrolled = await ops.enrollTask({ hiveHome, task, budget: req.budget, workspaceId: ws });
          members.push(enrolled);
          // Persist the enrollment manifest entry immediately (durability — a mid-run kill keeps the
          // worktree→task mapping the recovery pass needs). Best-effort: a hook throw (sync OR async)
          // must NEVER abort enrollment, so the whole invocation is guarded (a sync throw escapes a
          // bare `.catch`, since it fires before Promise.resolve wraps it).
          if (opts.onEnrolled) {
            try {
              await opts.onEnrolled(enrolled);
            } catch {
              /* best-effort durability hook — ignore */
            }
          }
        }

        const deadline = startedAtMs + fleetTimeoutMs;
        const home = hiveHome;

        if (isRealQueen) {
          // ── REAL-QUEEN DRIVE: wake the Queen agent, then ONLY poll until drained ──
          await ops.startRealQueen({
            hiveHome: home,
            workspaceId: ws,
            kickoff:
              `Impartial benchmark backlog (${req.suite}, ${members.length} tasks) is enrolled across THIS hive's ` +
              `member harnesses (slug prefix "${home}m…"), each holding EXACTLY ONE benchmark feature that ` +
              `is a REAL, solvable SWE-bench-Pro task — NOT a phantom, duplicate, or "cursed"/breaker-tripped ` +
              `item. These ${members.length} features ARE your work and they run THROUGH YOU: place a bee on every ` +
              `one. Your ONLY job this run is placement — for each member feature in your frontier, place a bee ` +
              `(free slot / graceful-evict+fresh / warm-inject), attach a brief, evict + re-place stuck/dead bees, ` +
              `and keep placing until every member's lone feature has a live or terminal bee. Do NOT skip a feature ` +
              `as "already solved elsewhere" (sibling rows are OTHER hives' tasks, not yours), do NOT declare a ` +
              `future wake and go idle while any of your ${members.length} features is still unplaced, and do NOT ` +
              `treat your own enrolled members as contamination. Ignore non-"${home}m" frontier items — they ` +
              `belong to other hives. If an item looks blocked, place a bee anyway and let it report; you own ` +
              `placement end-to-end.`,
          });
          while (ops.now() < deadline) {
            // Fire the placement-watchdog sweep ourselves (staging routines are off) so the Queen gets
            // the real stuck-bee eviction → recovery-wake → re-placement backstop, scoped to this hive.
            await ops.reconcileWatchdog({ hiveHome: home, workspaceId: ws }).catch(() => {});
            const [liveBees, liveQueens, inFlight, survey] = await Promise.all([
              ops.countLiveBees({ hiveHome: home, workspaceId: ws }),
              ops.countLiveQueens({ hiveHome: home, workspaceId: ws }),
              ops.countInFlight({ hiveHome: home, members, arm: req.arm, workspaceId: ws }),
              ops.survey({ hiveHome: home, workspaceId: ws }),
            ]);
            peakConcurrentBees = Math.max(peakConcurrentBees, liveBees);
            concurrencySamples.push({ tMs: ops.now() - startedAtMs, live: liveBees });
            // Drained when the Queen has nothing left: no ready frontier, no started plan, nothing in flight.
            if (survey.frontierLen === 0 && survey.plansLen === 0 && inFlight === 0) break;
            // RE-WAKE the Queen when there is READY work that NOBODY is driving: a ready frontier remains,
            // NO bee is live, and NO Queen is currently awake → her prior session exited without placing it
            // (observed on :3170 with auto-routines off; her survey-then-exit leaves the member unplaced, and
            // since no bee ever spawned for it the in-flight heuristic alone would wrongly read it as "in
            // flight" forever and never re-wake — D-023 reclaim-under-load's sibling gap). The liveQueens===0
            // gate is the correct "nobody is working" signal: while a Queen IS awake (mid-survey/placement)
            // OR a bee is live we do NOT re-wake (the watchdog owns stuck/dead recovery). Best-effort.
            if (survey.frontierLen > 0 && liveBees === 0 && liveQueens === 0) {
              await ops
                .rewakeQueen({
                  hiveHome: home,
                  workspaceId: ws,
                  reason:
                    `${survey.frontierLen} of YOUR "${home}m…" benchmark feature(s) are still READY and ` +
                    `unplaced with NO live bee — your prior session exited without placing them. These are REAL ` +
                    `solvable tasks, not phantoms. PLACE A BEE on each one NOW (fleet cap is the contention bound). ` +
                    `Do NOT skip them as "already solved"/"cursed"/"contamination" and do NOT declare a wake and ` +
                    `idle — place every unplaced member feature this wake.`,
                })
                .catch(() => {});
            }
            await ops.sleep(pollMs);
          }
        } else {
          // ── FIFO DRIVE (no Queen): gather → planFifoPlacement → place → poll until drained ──
          while (ops.now() < deadline) {
            const [liveBees, inFlight, gathered] = await Promise.all([
              ops.countLiveBees({ hiveHome: home, workspaceId: ws }),
              ops.countInFlight({ hiveHome: home, members, arm: req.arm, workspaceId: ws }),
              ops.gatherForFifo({ hiveHome: home, members, workspaceId: ws }),
            ]);
            peakConcurrentBees = Math.max(peakConcurrentBees, liveBees);
            concurrencySamples.push({ tMs: ops.now() - startedAtMs, live: liveBees });
            if (inFlight === 0 && gathered.tasks.length === 0) break; // drained

            if (gathered.tasks.length > 0 && (gathered.headroom > 0 || gathered.bees.length > 0)) {
              const plan = fifoPlanner!({ tasks: gathered.tasks, bees: gathered.bees, headroom: gathered.headroom });
              const { placements } = await ops.placeFifoBatch({ hiveHome: home, plan, members, workspaceId: ws });
              for (const p of placements) {
                coordEvents.push({ ts: ops.now(), kind: 'placement', taskId: p.instanceId, agent: p.cupId, detail: p.disposition });
                const st = members.find((m) => m.task.instanceId === p.instanceId);
                if (st) {
                  st.cupId = p.cupId;
                  st.placedAtMs = ops.now();
                  st.disposition = p.disposition;
                }
              }
            }
            await ops.sleep(pollMs);
          }
        }
      } catch (e) {
        if (hiveHome) await ops.pauseFleet({ hiveHome, workspaceId: ws }).catch(() => {});
        const runError = e instanceof Error ? e.message : String(e);
        const partial = await collectAll(ops, members, req, ws, opts.onTaskCollected).catch(() => [] as FleetTaskResult[]);
        const finishedAtMs = ops.now();
        if (hiveHome) await ops.teardown({ hiveHome, members, workspaceId: ws }).catch(() => {});
        return { ...empty(runError), finishedAtMs, peakConcurrentBees, taskResults: partial, concurrencyTimeline: buildTimeline() };
      }

      // ── always pause (bound spend), collect diffs/cost + the REAL coord trace, then teardown ──
      await ops.pauseFleet({ hiveHome, workspaceId: ws }).catch(() => {});
      const taskResults = await collectAll(ops, members, req, ws, opts.onTaskCollected);
      const realCoord = await ops.collectCoordEvents({ hiveHome, members, arm: req.arm, workspaceId: ws }).catch(() => [] as CoordEvent[]);
      // Real-Queen arm: the pot_placements-derived trace IS the coordination signal. FIFO arm: keep the
      // synthetic per-placement events the loop pushed (no Queen ledger to read).
      coordEvents = isRealQueen ? realCoord : coordEvents;
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
        concurrencyTimeline: buildTimeline(),
      };
    },
  };
}

async function collectAll(
  ops: RealQueenBacklogOps,
  members: RealQueenEnrolled[],
  req: HiveBacklogRunRequest,
  ws: string,
  onTaskCollected?: (result: FleetTaskResult) => void | Promise<void>,
): Promise<FleetTaskResult[]> {
  const out: FleetTaskResult[] = [];
  for (const enrolled of members) {
    const result = await ops.collectTask({ enrolled, arm: req.arm, seed: String(req.seed), workspaceId: ws });
    out.push(result);
    // Persist this one task's diff/row immediately (durability — a kill mid-collect keeps every diff
    // already gathered). Best-effort: a hook throw (sync OR async) must not abort the rest of the loop.
    if (onTaskCollected) {
      try {
        await onTaskCollected(result);
      } catch {
        /* best-effort durability hook — ignore */
      }
    }
  }
  return out;
}

/** Bind the live real-Queen driver so `runHiveBacklog` is instant-go. `ops` defaults to the real binding. */
export function bindRealQueenBacklogDriver(opts: RealQueenBacklogOpts, ops?: RealQueenBacklogOps): void {
  setHiveBacklogDriver(realQueenBacklogDriver(ops ?? realQueenBacklogOps(opts), opts));
}

/**
 * FULL dissolve of a bench hive by slug (P-033 Fix 4, teardown-on-exit). Stops the Queen wake, cancels every
 * live bee subtree (+ SIGTERMs the local processes), tears down the per-hive learning loops (the D-022
 * orphan-respin source), deregisters the home harness and drops its schema — the exact closure
 * `live-ops.dissolveHive` (now full) delivers. The LAUNCHER's SIGTERM/SIGINT/exit handler calls this for
 * every hive it registered (`onHiveCreated`) so a rate-limit SIGKILL that bypasses the driver's normal/catch
 * teardown still leaves NO orphan re-spinning opus. Idempotent + best-effort (a teardown error must not mask
 * the exit). Lazy import keeps the fake-driven test from loading PG/registry.
 */
export async function dissolveBenchHive(hiveHome: string, workspaceId: string): Promise<void> {
  const { liveHiveOps } = await import('../pot-eval/live-ops');
  await liveHiveOps({ workspaceId }).dissolveHive({ hiveHome, workspaceId });
}

/* -------------------------------------------------------------------------- */
/* The REAL binding — ONE shared hive, real-Queen wake + the pot_placements trace. */
/* -------------------------------------------------------------------------- */

function scratchSlug(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}
function memberSlugForTask(homePrefix: string, instanceId: string): string {
  const safe = instanceId.replace(/[^a-z0-9]+/gi, '').toLowerCase().slice(0, 24);
  return `${homePrefix}m${safe}${Math.random().toString(36).slice(2, 6)}`;
}
/** Mint a regex-safe (`FEATURE_ID_RE`) feature id — the bee recognizes its feature ONLY for `F-<UPPERHEX>`. */
function featureIdForTask(instanceId: string): string {
  const safe = instanceId.replace(/[^a-zA-Z0-9]+/g, '').toUpperCase().slice(0, 16) || 'TASK';
  return `F-${safe}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/**
 * The REAL machinery binding. ONE shared hive home; N member harnesses (one per task). The real-Queen
 * arm wakes the queen agent (startRealQueen); the FIFO arm never does. Lazy dynamic imports keep the
 * module import-light so the fake-driven test never loads PG/registry/fleet.
 *
 * The bee-spawn env defaults (PAPERCUSP_FLEET_SANDBOX=0 / SPAWN_BACKEND=claude-code / AGENT_CMD=claude -p)
 * are the SAME load-bearing ones the scripted driver documents (hive-backlog-live.ts) — set on the
 * driver process so EVERY placed bee inherits them. The opus pin (AGENT_MODELS bee+queen=opus:xhigh)
 * is the CALLER's responsibility (the launcher), since it must also reach the Queen agent.
 */
export function realQueenBacklogOps(opts: RealQueenBacklogOpts): RealQueenBacklogOps {
  const ws = opts.workspaceId;

  // GAIA seam (plan benchmark-suite-gaia-2026-06-17): when engaged, swap clone → GAIA scratch dir, member
  // blueprint → `gaia-agent`, the feature spec → the question + answer.txt instruction, and the work-product
  // readout → `answer.txt` (the THREE SWAPS, mirroring suIndependentBacklogOps). Everything else — the Queen
  // wake/place/evict/re-place/adaptive-wake drive, the pot_placements coord trace, the readMemberUsage cost
  // read, the never-throw contract — is unchanged. Per-task briefs are stored by instanceId so the Queen's
  // situational placement still rides the right per-task directive (she ALSO attaches her own overlay).
  const gaiaMode = opts.gaia?.enabled === true;
  const gaiaBriefByInstance = new Map<string, string>();

  if (process.env.PAPERCUSP_FLEET_SANDBOX == null) process.env.PAPERCUSP_FLEET_SANDBOX = '0';
  if (process.env.PAPERCUSP_SPAWN_BACKEND == null) process.env.PAPERCUSP_SPAWN_BACKEND = 'claude-code';
  if (process.env.AGENT_CMD == null && process.env.CLAUDE == null) process.env.AGENT_CMD = 'claude -p';
  // D-020 fix: the bee self-sufficiency directive. The real Queen places a bench bee via `cup:spawn`, but
  // her brief is a situational overlay — not the "claim + implement this lone feature" directive — so a
  // placed bee did $0 of work (the feature stayed unassigned → `cancelled`). When set, spawnAgentInHarness
  // APPENDS this to every placed bee's brief + pins the claude backend per-spawn (operator-spawn.ts), the
  // exact mechanism the WORKING scripted arm uses. CRITICAL: the Queen's `cup:spawn` is serviced by the
  // long-running :3170 host (fireLaunchBlueprint → loopback invoke), NOT this launcher process — so for the
  // real-Queen arm this var MUST also be on :3170's env (set in apps/operator/.env.local). We set it here so
  // the FIFO arm's IN-PROCESS executeBatch spawns (which run in this launcher) also carry it, and as the
  // single source of the directive text.
  // The STANDING directive every placed bee inherits (spawnAgentInHarness appends PAPERCUSP_XBENCH_CUP_DIRECTIVE
  // to each bee's brief). The default is the coding directive ("produce a working unified diff"); for the GAIA
  // arm that is WRONG — the GAIA bee researches + writes answer.txt, NOT code. So in gaiaMode set the standing
  // directive to the GAIA self-sufficiency instruction (claim your lone feature → research → write answer.txt →
  // DONE), keeping the same "you own it end-to-end, don't exit taskless" contract that makes a Queen-placed bee
  // actually DO the work (the D-020 fix). The per-task QUESTION still rides the seeded feature spec (gaiaBrief).
  const GAIA_BENCH_BEE_DIRECTIVE = [
    'You are placed on a single-task GAIA benchmark member harness. This member holds EXACTLY ONE feature',
    'work-item — a GAIA general-assistant question to answer. Claim it (`work_items:claim_next` for this',
    'harness, or `fleet:assignments { agent: <your spawn id> }` then `work_items:get` for the detail), read its',
    'full problem_statement (the question + any attached file staged in your cwd), and RESEARCH the answer with',
    'your native web_search / fetch / bash(python) / file tools — chase every hop, verify facts from the actual',
    'sources. When done, write ONLY your final answer to a file named "answer.txt" in your current working',
    'directory (use the Write tool), in the GAIA normalized format (a number OR as few words as possible OR a',
    'comma-separated list; no thousands-commas, no units/articles/abbreviations unless asked). You may end the',
    'file with a line "FINAL ANSWER: <answer>". That file is your ENTIRE submission — nothing else is graded.',
    'When answer.txt is written, mark the work-item complete (`work_items:complete`) and emit DONE. You are NOT',
    'taskless — the assigned question IS your task; do not exit FAILED for "no work", and do not exit without',
    'writing answer.txt (if genuinely uncertain, still write your single best exact answer). You own it end to end.',
  ].join(' ');
  if (gaiaMode) {
    // Override unconditionally for GAIA — the default coding directive would mis-instruct the bee. (Set on this
    // launcher process AND, load-bearing, on the :3170 host env that services the Queen's cup:spawn.)
    process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE = GAIA_BENCH_BEE_DIRECTIVE;
  } else if (process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE == null) {
    process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE = BENCH_BEE_DIRECTIVE;
  }

  let homePrefix = scratchSlug('xbq');
  const instanceByFeatureId = new Map<string, string>();

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

    async createHive() {
      homePrefix = scratchSlug('xbq');
      const hiveHome = homePrefix;
      const ops = await liveOps();
      await ops.createHive({ slug: hiveHome, workspaceId: ws });
      return { hiveHome };
    },

    async enrollTask({ hiveHome, task }) {
      // GAIA SWAP 1: no repo to clone — a scratch git dir with the optional attachment staged in (gaiaCloneTask).
      // SWE-bench path is unchanged (cloneTaskRepo @ base).
      let checkout;
      if (gaiaMode) {
        const { gaiaCloneTask } = await import('./gaia-backlog-support');
        checkout = await gaiaCloneTask(task);
      } else {
        const { cloneTaskRepo } = await import('./clone');
        checkout = await cloneTaskRepo(task);
      }
      try {
        const member = memberSlugForTask(homePrefix, task.instanceId);
        const { mkdir, writeFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { stringify: stringifyYaml } = await import('yaml');

        // GAIA SWAP 2 (blueprint + spec): the member runs the general-assistant `gaia-agent` blueprint, NOT the
        // coding spine `external-bench`, and its seeded feature spec is the question + answer.txt instruction.
        let memberBlueprint = 'external-bench';
        let featureSpec = task.problemStatement;
        if (gaiaMode) {
          const { GAIA_MEMBER_BLUEPRINT, gaiaBrief } = await import('./gaia-backlog-support');
          memberBlueprint = GAIA_MEMBER_BLUEPRINT;
          featureSpec = gaiaBrief(task); // the question + the answer.txt instruction (the work-item brief)
          gaiaBriefByInstance.set(task.instanceId, featureSpec);
        }
        const bpDir = join(checkout.dir, '.papercusp');
        await mkdir(bpDir, { recursive: true });
        await writeFile(
          join(bpDir, 'blueprint.yaml'),
          stringifyYaml({ id: member, extends: memberBlueprint }, { lineWidth: 100 }),
          'utf8',
        );

        const ops = await liveOps();
        await ops.registerMember({ member, clonePath: checkout.dir, hiveHome, workspaceId: ws });

        const featureId = featureIdForTask(task.instanceId);
        await ops.seedFeature({
          member,
          featureId,
          title: task.problemStatement.slice(0, 200),
          spec: featureSpec,
          workspaceId: ws,
        });
        // Pin the feature's workspace_id (the fill_ws_features trigger derives `default` for a throwaway
        // member; the placed bee's claim filters workspace_id = ws → a default-scoped feature is invisible).
        {
          const sql = await sqlClient();
          await sql`
            UPDATE harness_shared.harness_features_consolidated
               SET workspace_id = ${ws}, updated_ts = ${Date.now()}
             WHERE harness_slug = ${member} AND feature_id = ${featureId}`;
        }

        const enrolled: RealQueenEnrolled = {
          task,
          member,
          clonePath: checkout.dir,
          workItemId: featureId,
          checkout,
          cupId: null,
          placedAtMs: null,
          disposition: null,
        };
        instanceByFeatureId.set(featureId, task.instanceId);
        return enrolled;
      } catch (e) {
        await checkout.cleanup().catch(() => {});
        throw e;
      }
    },

    async startRealQueen({ hiveHome, kickoff }) {
      // The core of pot:start: persist started=true (the watchdog's liveness bit) + wake the Queen agent.
      // `liveHiveOps.startHive` === setHiveStarted(true) + requestUrgentPotWake → fireLaunchBlueprint('hive').
      const ops = await liveOps();
      await ops.startHive({ hiveHome, workspaceId: ws, kickoff });
    },

    async rewakeQueen({ hiveHome, reason }) {
      // Another urgent wake → another fireLaunchBlueprint('hive') → a fresh Queen session that surveys +
      // places the still-ready frontier. The hive is already started (startRealQueen did setHiveStarted);
      // this is the re-wake the disabled auto-routine would have delivered. Same call pot:start uses.
      const { requestUrgentPotWake } = await import('../pot/urgent-wake');
      await requestUrgentPotWake({ reason, harness: hiveHome, workspaceId: ws });
    },

    async reconcileWatchdog({ hiveHome }) {
      // Drive ONE placement-watchdog sweep for THIS hive (staging routines are off → no auto sweep).
      // reconcileOnePot resolves the Queen owner, derives each placed bee's liveness, and fires the
      // recovery wakes / breaker escalations / stranded-blocker escalations — the real eviction +
      // re-placement loop, scoped to the bench hive (NOT the global listStartedHives sweep).
      const sql = await sqlClient();
      const { reconcileOnePot, placementConfig } = await import('../pot/placement-watchdog');
      await reconcileOnePot(sql, ws, hiveHome, placementConfig(), Date.now());
    },

    async survey({ hiveHome }) {
      const { surveyPot } = await import('../pot/survey');
      const s = await surveyPot(ws, hiveHome);
      return { frontierLen: s.frontier.length, plansLen: s.plans.length };
    },

    async countInFlight({ members, arm }) {
      const sql = await sqlClient();
      if (arm === HIVE_REALQUEEN_ARM) {
        // The Queen places via the real flow → pot_placements rows. In-flight = non-terminal placements
        // PLUS any member whose feature is still non-terminal with no terminal-bee yet (startup window).
        const placed = await sql<{ status: string }[]>`
          SELECT status FROM harness_shared.pot_placements
           WHERE workspace_id = ${ws} AND install_slug = ${homePrefix}
             AND status IN ('working','recovering')`;
        if (placed.length > 0) return placed.length;
        // No live placement rows: fall through to the feature/bee check (covers the pre-first-placement
        // window AND the post-drain settle). A member counts as in-flight while its feature is non-terminal
        // and no bee has terminated for it yet.
      }
      // FIFO arm (and the real-Queen fallthrough): feature/bee-derived in-flight over placed members.
      const placedMembers = members.filter((m) => m.cupId != null);
      // For the real-Queen arm, no bee was recorded by the driver (the Queen placed), so check ALL members.
      const toCheck = arm === HIVE_REALQUEEN_ARM ? members : placedMembers;
      if (toCheck.length === 0) return arm === HIVE_REALQUEEN_ARM ? members.length : 0;
      let inFlight = 0;
      for (const m of toCheck) {
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
        const status = featRows[0]?.status ?? '';
        const featTerminal = DONE_FEATURE_STATUSES.has(status) || ESCALATE_FEATURE_STATUSES.has(status);
        const running = Number(beeRows[0]?.running ?? 0) || 0;
        const terminal = Number(beeRows[0]?.terminal ?? 0) || 0;
        if (!featTerminal && (running > 0 || terminal === 0)) inFlight++;
      }
      return inFlight;
    },

    async countLiveBees() {
      const { gatherLiveBees } = await import('../fleet/placement-gather');
      const bees = await gatherLiveBees(ws);
      return bees.length;
    },

    async countLiveQueens() {
      // This hive's awake Queen launch rows. A Queen wake records a `launch-%` spawned_agents row
      // (child_role='queen') on the home harness; it flips terminal when her invoke turn returns. So
      // running/restarting === "a Queen is mid-survey/placement right now" — the gate that distinguishes
      // "she's still working, don't re-wake" from "her session ended unplaced, a fresh wake is owed".
      const sql = await sqlClient();
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${ws} AND harness_slug = ${homePrefix}
           AND child_role = 'mug' AND status IN ('running','restarting')`;
      return Number(rows[0]?.n ?? 0) || 0;
    },

    async gatherForFifo({ members }) {
      // FIFO consumes members in ARRIVAL/backlog (enrollment) order — un-ranked (the no-Queen contract).
      // EXCLUDE already-placed members (cupId set) so the loop doesn't re-place every poll.
      const unplaced = members.filter((m) => m.cupId == null);
      const [{ gatherFrontier, gatherLiveBees }, { getSpawnHeadroom }] = await Promise.all([
        import('../fleet/placement-gather'),
        import('../fleet/operator-spawn'),
      ]);
      const ids = unplaced.map((m) => m.workItemId);
      const res = ids.length > 0 ? await gatherFrontier({ ids, limit: Math.max(ids.length, 1), workspaceId: ws }) : { tasks: [] };
      const bees = await gatherLiveBees(ws);
      const { headroom } = await getSpawnHeadroom(ws);
      return {
        tasks: (res.tasks ?? []) as unknown as BatchPlacementInput['tasks'],
        bees: bees as unknown as NonNullable<BatchPlacementInput['bees']>,
        headroom,
      };
    },

    async placeFifoBatch({ plan, members }) {
      // Route FIFO bee spawns through :3170 host (same path as Queen's fleet:place_batch)
      // instead of in-process executeBatch. This ensures bees get the env + work-item
      // claim that hive bees get via the operator host (D-020 fix).
      // NOTE: The staging operator (:3170) is the Queen's host on the integration tree.
      // Using :3170 ensures FIFO control bees get the full invoke environment + work-item
      // claim layer that hive-realqueen bees get from the same host.
      const { loopbackFetch, readJsonBody } = await import('../loopback-fetch');

      // Extract task IDs from the plan decisions (tasks that will be placed in FIFO order)
      const taskIds = plan.decisions
        .filter((d) => d.disposition !== 'unplaced')
        .map((d) => d.task.id);

      if (taskIds.length === 0) {
        return { placements: [] };
      }

      // Infer the target harness from the first unplaced member (they all have external-bench blueprint)
      const targetHarness = members.find((m) => m.cupId == null)?.member ?? homePrefix;

      // Invoke fleet:place_batch on :3170 (staging operator host) with the FIFO-ordered tasks
      const stagingOperatorBase = 'http://localhost:3170';
      const toolUrl = `${stagingOperatorBase}/api/agent-mcp/run-tool`;
      const res = await loopbackFetch(toolUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'fleet:place_batch',
          args: {
            tasks: taskIds,
            harness: targetHarness,
            // In gaiaMode the standing env directive was overridden to the GAIA self-sufficiency instruction
            // (research → write answer.txt); the per-task question rides the seeded feature spec. For the
            // SWE-bench path this is the coding BENCH_BEE_DIRECTIVE (env == constant). FIFO arm only.
            brief: gaiaMode
              ? (process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE ?? process.env.PAPERCUSP_XBENCH_BEE_DIRECTIVE /* legacy env name — dual-accept until callers migrate */ ?? '')
              : BENCH_BEE_DIRECTIVE,
            tier: 'max', // Enforce opus-strict per brief (max tier = opus:xhigh)
            workspace: ws,
            dry_run: false,
          },
        }),
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        throw new Error(`fleet:place_batch failed: HTTP ${res.status} ${errorBody}`);
      }

      const toolResult = await readJsonBody<{
        ok: boolean;
        result?: {
          placements: Array<{
            task: string;
            action: string;
            spawn_id?: string | null;
            bee?: string;
          }>;
        };
        error?: string;
      }>(res, toolUrl);

      if (!toolResult.ok) {
        throw new Error(`fleet:place_batch error: ${toolResult.error}`);
      }

      // Convert tool result to the expected placement format
      const placements: { instanceId: string; cupId: string; disposition: 'spawn' | 'warm-inject' }[] = [];
      const exec = toolResult.result ?? { placements: [] };
      for (const p of exec.placements) {
        const featureId = p.task;
        const instanceId = instanceByFeatureId.get(featureId) ?? featureId;
        if (p.action === 'spawned' || p.action === 'injected') {
          const disposition = p.action === 'spawned' ? ('spawn' as const) : ('warm-inject' as const);
          const cupId = p.spawn_id ?? p.bee ?? instanceId;
          placements.push({ instanceId, cupId, disposition });
        }
      }
      return { placements };
    },

    async pauseFleet({ hiveHome }) {
      const ops = await liveOps();
      await ops.pauseHive({ hiveHome, workspaceId: ws });
    },

    async collectTask({ enrolled, arm, seed }): Promise<FleetTaskResult> {
      const member = enrolled.member;
      // GAIA SWAP 3: read `answer.txt` (the qa answer the bee wrote) instead of the git diff. The cost read
      // (readMemberUsage) + feature-status → stopReason are unchanged.
      let diff = '';
      let answer: string | undefined;
      let generationError: string | undefined;
      if (gaiaMode) {
        const { extractGaiaAnswer } = await import('./gaia-backlog-support');
        answer = await extractGaiaAnswer(enrolled.checkout); // never throws; '' when no answer.txt
      } else {
        try {
          const { extractDiff } = await import('./clone');
          diff = await extractDiff(enrolled.checkout, enrolled.task);
        } catch (e) {
          generationError = `extractDiff failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      const sql = await sqlClient();
      const [cost, spawnRows] = await Promise.all([
        readMemberUsage(sql, member, ws).catch(() => ({ tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 })),
        readMemberBeeSpawns(sql, member, ws).catch(() => []),
      ]);
      const status = await readMemberFeatureStatus(sql, member, enrolled.workItemId, ws).catch(() => null);
      const stopReason = stopReasonForFeatureStatus(status, generationError);

      const firstSpawn = spawnRows[0];
      const cupId = enrolled.cupId ?? firstSpawn?.spawnId ?? member;
      const placedAtMs = enrolled.placedAtMs ?? firstSpawn?.startedAtMs ?? Date.now();
      const startedAtMs = firstSpawn?.startedAtMs ?? placedAtMs;
      const finishedAtMs = firstSpawn?.finishedAtMs ?? Date.now();
      const wallClockMs = Math.max(0, finishedAtMs - startedAtMs);

      const attempt: ArmAttempt = {
        arm,
        blueprintId: gaiaMode ? 'gaia-agent' : 'external-bench',
        instanceId: enrolled.task.instanceId,
        seed,
        diff,
        ...(answer != null ? { answer } : {}),
        tokensIn: cost.tokensIn,
        tokensOut: cost.tokensOut,
        costUsd: cost.costUsd,
        turns: cost.turns,
        wallClockMs,
        trajectoryRef: `xbench-realqueen://${member}`,
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
        disposition: enrolled.disposition ?? 'spawn',
      };
    },

    async collectCoordEvents({ members, arm }) {
      if (arm !== HIVE_REALQUEEN_ARM) return []; // FIFO has no Queen ledger — caller keeps the synthetic trace.
      const sql = await sqlClient();
      const featureToInstance = new Map(members.map((m) => [m.workItemId, m.task.instanceId]));
      const rows = await sql<{
        work_item_id: string;
        harness_slug: string | null;
        cup_spawn_id: string | null;
        status: string;
        fail_count: number;
        last_disposition: string | null;
        placed_at: string | Date;
      }[]>`
        SELECT work_item_id, harness_slug, cup_spawn_id, status, fail_count, last_disposition, placed_at
          FROM harness_shared.pot_placements
         WHERE workspace_id = ${ws} AND install_slug = ${homePrefix}
         ORDER BY placed_at ASC`;
      return buildRealQueenCoordEvents(rows, featureToInstance);
    },

    async teardown({ hiveHome, members }) {
      const ops = await liveOps();
      for (const m of members) {
        await ops.dropMember({ member: m.member, workspaceId: ws }).catch(() => {});
        await m.checkout.cleanup().catch(() => {});
      }
      await ops.dissolveHive({ hiveHome, workspaceId: ws }).catch(() => {});
    },
  };
}

/** A `pot_placements` ledger row (the real-Queen coordination source). Exported for the test. */
export interface HivePlacementRow {
  work_item_id: string;
  harness_slug: string | null;
  cup_spawn_id: string | null;
  status: string;
  fail_count: number;
  last_disposition: string | null;
  placed_at: string | Date;
}

/**
 * Reconstruct the REAL-Queen coordination trace from the `pot_placements` ledger — pure, so the test
 * exercises the mapping with no PG. Each row → a `placement` event; a row whose Queen RE-PLACED it
 * (fail_count>0 / last_disposition='recover') → an additional `rework` event (the watchdog evicted a
 * stuck bee and the Queen re-placed — coordination WORK that FIFO never does); 'stranded'/'cursed' →
 * a coordination-breakdown signal; 'completed' → a `complete`. These are the kinds
 * `substrateSignalRates` (bench-metrics/mast.ts) counts → the Queen arm's MAST is finally non-zero,
 * sourced from the real ledger, not manufactured.
 */
export function buildRealQueenCoordEvents(
  rows: readonly HivePlacementRow[],
  featureToInstance: Map<string, string>,
): CoordEvent[] {
  const events: CoordEvent[] = [];
  for (const r of rows) {
    const ts = new Date(r.placed_at).getTime();
    const taskId = featureToInstance.get(r.work_item_id) ?? r.work_item_id;
    const agent = r.cup_spawn_id ?? 'mug';
    events.push({ ts, kind: 'placement', agent, taskId, detail: `placed (${r.status})` });
    if ((r.fail_count ?? 0) > 0 || r.last_disposition === 'recover') {
      // The watchdog surfaced a stuck/dead bee and the Queen re-placed — re-work the FIFO arm can't do.
      events.push({ ts, kind: 'rework', agent: 'mug', taskId, detail: `re-placed after ${r.fail_count} fail(s)` });
    }
    if (r.status === 'stranded' || r.status === 'cursed') {
      events.push({ ts, kind: 'stranded_item', agent: 'mug', taskId, detail: `placement ${r.status}` });
    }
    if (r.status === 'completed') {
      events.push({ ts, kind: 'complete', agent, taskId });
    }
  }
  return events;
}

/** The member's single seeded feature status (terminal → the stopReason). Null when absent. */
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
