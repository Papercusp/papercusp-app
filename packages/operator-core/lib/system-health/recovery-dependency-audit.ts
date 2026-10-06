/**
 * recovery-dependency-audit — does each recovery mechanism SURVIVE the failure it
 * recovers? (plan system-notices-on-its-own-2026-08-16, P-004.)
 *
 * ## The rule, and why it needed a module
 *
 * A watchdog/reaper/alarm is only worth its cadence if it can still FIRE during the
 * failure it exists to fix. When its executor depends on something inside the failure
 * domain, the mechanism goes silent exactly when it is needed — the repo's own term for
 * this is **fate-sharing** (`event-loop-sentinel.ts`, "## The fate-sharing defect this
 * fixes").
 *
 * That rule is not new here. It has been hand-derived correctly in FIVE independent
 * places, every one of them in prose:
 *
 *   1. `@papercusp/scheduled-registry` — `ManagedCategory` documents the `'watchdog'`
 *      category as "out-of-band sentinel — bespoke, MUST SURVIVE WHAT IT WATCHES".
 *      35 timers carry that category. Nothing checked the claim.
 *   2. `dbos/dbos-executor-reaper.ts` — "a DBOS-scheduled reaper would queue on the very
 *      executor that wedges and so couldn't fire when it's most needed".
 *   3. `event-loop-sentinel.ts` — the fate-sharing section above.
 *   4. `system-health/cluster-lag-watchdog.ts` — names a SIBLING as defective:
 *      `lag-self-restart.ts` "reads the event-loop-lag histogram on a `setInterval` and
 *      exits via a `setTimeout` — both are JS callbacks on the SAME wedged loop, so
 *      during a pure synchronous wedge NEITHER fires".
 *   5. `red-queen/engine-death.ts` — "deliberately does NOT ride DBOS, the routines
 *      engine, or background-worker workflows, so it survives exactly the failure it
 *      watches for".
 *
 * Five correct derivations and zero enforcement is the actual defect: the rule is
 * re-discovered per author, at the cost of an incident each time, and a NEW recovery
 * mechanism that violates it is caught by nobody. This module makes the property
 * DECLARED and CHECKED — `recovery-dependency-audit.test.ts` fails when a
 * `category: 'watchdog'` timer exists with no declaration here.
 *
 * ## It invents no new bookkeeping
 *
 * Both inputs are registries this repo already maintains and already guards:
 *
 *   - `category: 'watchdog'` on `managedSetInterval` — the timer's own declaration that
 *     it is an out-of-band sentinel. Enumerated by `scanWatchdogTimers()` below, using
 *     the same textual balanced-paren extraction as `scripts/check-timer-classification.mjs`.
 *   - `TARGET_ROLE_SPEND[...].spend === 'llm'` (`automation/routine-classification.ts`,
 *     cross-checked by `routine-classification.registry.test.ts`) — already the exact
 *     signal for "this fire needs an agent turn", which is what makes a durable-tier
 *     recovery depend on `agent-session` / `agent-spawn`.
 *
 * ## Read the coverage boundary before reading the verdicts
 *
 * `auditRecoveryDependencies()` returns `coverage`, and it is not decoration. The
 * ephemeral tier is enumerated MECHANICALLY and is therefore complete; the durable tier
 * (routines / system actions) is DECLARED BY HAND, because no field distinguishes a
 * recovery routine from an ordinary one. A durable-tier mechanism can therefore be
 * missing from this table without any test going red. Per the repo's bounded-measurement
 * rule, that limit is reported ON the result rather than left for the reader to infer
 * from a confident-looking list.
 */

/**
 * A part of the substrate that can FAIL, and that a recovery mechanism may need alive in
 * order to run. Deliberately coarse: the audit only has to answer "can this fire during
 * that failure", and a finer taxonomy would invite disagreement without changing a
 * verdict.
 */
export type SubstrateComponent =
  /** The Hono host process (`:3070` / `:3170` / bg-host) existing at all. */
  | 'operator-host-process'
  /** That host's MAIN event loop still turning. Distinct from the process existing —
   *  the 2026-08-03 `:3170` wedge held the pid, the port and the accept queue for 30+
   *  minutes with a stopped loop. */
  | 'operator-event-loop'
  /** The host's memory headroom (RSS under its cgroup limit). */
  | 'operator-host-memory'
  | 'postgres'
  /** A live DBOS executor able to claim and run workflows. */
  | 'dbos-executor'
  /** The DBOS queue/dedup path being unwedged. */
  | 'dbos-queue'
  /** `routinesTick` still firing due routines. */
  | 'routines-tick'
  /** An already-live agent session able to take a turn. */
  | 'agent-session'
  /** The ability to LAUNCH a new agent (spawn path + account capacity). */
  | 'agent-spawn'
  /** The frontier dispatcher that gets `work_items` in front of an agent. */
  | 'work-item-dispatch'
  /** A separate, non-operator process (gateway sidecar, spawner sidecar, psu-launcher). */
  | 'external-process'
  /** systemd — the only executor in this table that is outside every other component. */
  | 'systemd';

/**
 * How a recovery mechanism's pass is actually executed. The value of this module is
 * almost entirely in this table: naming the executor forces the dependency set to be
 * explicit instead of assumed.
 */
export type ExecutorKind =
  /** `managedSetInterval` on the operator host's main loop. */
  | 'operator-in-process-timer'
  /** A worker thread / child of the operator host — survives a main-loop stall. */
  | 'operator-off-loop'
  /** The cluster PRIMARY observing a request WORKER (independent event loops). */
  | 'cluster-primary-timer'
  /** A DBOS `@scheduled` workflow. */
  | 'dbos-scheduled-workflow'
  /** A `harness_shared.routines` row firing a deterministic `system:<action>` in-process. */
  | 'routine-system-action'
  /** A routine whose fire needs a MODEL TURN — it spawns/wakes an agent, or mints work
   *  items for the dispatcher to hand to one (`TARGET_ROLE_SPEND.spend === 'llm'`). */
  | 'routine-agent-dispatch'
  /** A timer inside a separate sidecar/daemon process. */
  | 'sidecar-process-timer'
  /** systemd `Restart=` / a unit timer. */
  | 'systemd-unit';

/**
 * What each executor REQUIRES to be healthy in order to fire at all.
 *
 * Read these as "if any one of these is the thing that broke, this executor does not
 * run". They compose downward: a routine needs everything DBOS needs, plus the tick; an
 * agent-dispatching routine needs everything a routine needs, plus an agent.
 */
export const EXECUTOR_REQUIRES: Readonly<Record<ExecutorKind, readonly SubstrateComponent[]>> = {
  'operator-in-process-timer': ['operator-host-process', 'operator-event-loop', 'operator-host-memory'],
  // Still dies with the process, but NOT with the main loop — that separation is the
  // entire point of the sentinel worker.
  'operator-off-loop': ['operator-host-process', 'operator-host-memory'],
  // The primary is a different process from the worker it judges; it shares the host's
  // memory cgroup but not the worker's loop.
  'cluster-primary-timer': ['operator-host-process', 'operator-host-memory'],
  'dbos-scheduled-workflow': [
    'operator-host-process',
    'operator-event-loop',
    'operator-host-memory',
    'postgres',
    'dbos-executor',
    'dbos-queue',
  ],
  'routine-system-action': [
    'operator-host-process',
    'operator-event-loop',
    'operator-host-memory',
    'postgres',
    'dbos-executor',
    'dbos-queue',
    'routines-tick',
  ],
  'routine-agent-dispatch': [
    'operator-host-process',
    'operator-event-loop',
    'operator-host-memory',
    'postgres',
    'dbos-executor',
    'dbos-queue',
    'routines-tick',
    'work-item-dispatch',
    'agent-spawn',
    'agent-session',
  ],
  'sidecar-process-timer': ['external-process'],
  'systemd-unit': ['systemd'],
} as const;

/**
 * Why an intersection between "what it needs" and "what it recovers" is nevertheless
 * acceptable. A verdict with no mitigation is a real defect; a verdict with one is a
 * design choice someone made on purpose.
 */
export type MitigationKind =
  /**
   * The mechanism acts on a LEADING indicator and completes its action BEFORE the
   * dependency actually fails (memory-watchdog recycles on an RSS trend, well before the
   * OOM that would stop it).
   */
  | 'leading-indicator'
  /**
   * The mechanism's own SILENCE is the signal an out-of-band observer reads. Fate-sharing
   * here is not a defect — it is the detector. A heartbeat that survived the wedge would
   * report the wedged worker as healthy.
   */
  | 'absence-is-the-signal'
  /**
   * A DIFFERENT, non-fate-shared mechanism covers the hard case; this one covers the
   * degraded case only. The backstop must be NAMED and must itself be in this table.
   */
  | 'out-of-band-backstop';

export interface Mitigation {
  kind: MitigationKind;
  /** Name of the mechanism that covers the hard case. Required for 'out-of-band-backstop'. */
  backstop?: string;
  why: string;
}

export interface RecoveryMechanism {
  /** The registered timer/routine name — the join key to `schedule:inventory`. */
  name: string;
  /** Repo-relative source file, so a verdict is actionable without a grep. */
  file: string;
  executor: ExecutorKind;
  /**
   * Which substrate components are INSIDE the failure this mechanism exists to recover.
   *
   * Empty is the common, correct case and means "the failure it targets is not part of
   * the substrate its executor rides" — a git-sync stall, a dark MCP surface, a
   * degraded retrieval leg. Empty is a real answer, not an unfilled field.
   */
  recovers: readonly SubstrateComponent[];
  mitigation?: Mitigation;
  /** One line: what it actually watches. Kept short — the source file is linked above. */
  note: string;
}

export type RecoveryVerdict =
  /** Executor requires nothing inside the failure domain. */
  | 'sound'
  /** Intersects, with a declared mitigation. */
  | 'fate-shared-mitigated'
  /** Intersects, unmitigated: it cannot fire during the failure it targets. */
  | 'fate-shared';

/**
 * THE TABLE (P-004). Every `category: 'watchdog'` timer in the tree, plus the durable-tier
 * recovery mechanisms named in the plan.
 *
 * ⚠ `recovers` is the field that carries the judgement, and it is about the FAILURE, not
 * the subject. `goal-liveness-watchdog` watches goals held by dead agents — but a dead
 * AGENT is not a dead OPERATOR, and the watchdog rides the operator, so it recovers no
 * component it depends on and is `sound`. Filling in `recovers` with "things this
 * mechanism is about" instead of "components whose failure IS the failure it targets"
 * turns the whole audit into noise.
 */
export const RECOVERY_MECHANISMS: readonly RecoveryMechanism[] = [
  // ── The event-loop family — where every real finding lives ────────────────────────
  {
    name: 'event-loop-lag-monitor',
    file: 'packages/operator-core/lib/event-loop-lag-monitor.ts',
    executor: 'operator-in-process-timer',
    recovers: ['operator-event-loop'],
    mitigation: {
      kind: 'out-of-band-backstop',
      backstop: 'event-loop-sentinel-heartbeat',
      why: 'Reads a libuv histogram from a timer ON the loop it measures, so it reports a DEGRADED loop and structurally cannot report a STOPPED one. event-loop-sentinel-host.ts documents exactly this split and exists to cover the stopped case.',
    },
    note: 'p95 event-loop delay gauge + CPU-profile capture.',
  },
  {
    name: 'event-loop-sentinel-heartbeat',
    file: 'packages/operator-core/lib/event-loop-sentinel-host.ts',
    executor: 'operator-in-process-timer',
    recovers: ['operator-event-loop'],
    mitigation: {
      kind: 'absence-is-the-signal',
      why: 'The beat is deliberately ON the judged loop; the WATCHER is a worker thread reading a SharedArrayBuffer. A stopped loop stops the beat, and the off-loop watcher reads that silence. Fate-sharing is the detector here, not the defect.',
    },
    note: 'Main-thread beat into a SAB; off-loop worker declares the host wedged.',
  },
  {
    name: 'lag-self-restart',
    file: 'packages/operator-core/lib/system-health/lag-self-restart.ts',
    executor: 'operator-in-process-timer',
    recovers: ['operator-event-loop'],
    mitigation: {
      kind: 'out-of-band-backstop',
      backstop: 'cluster-lag-scan',
      why: 'cluster-lag-watchdog.ts states the limit outright: this reads the histogram on a setInterval and exits via a setTimeout, "both JS callbacks on the SAME wedged loop, so during a pure synchronous wedge NEITHER fires". It covers sustained-critical-but-turning; the primary-side scan covers the hard wedge.',
    },
    note: 'Exits a worker non-zero after a sustained-critical loop so systemd/cluster respawns it.',
  },
  {
    name: 'cluster-lag-beat',
    file: 'packages/operator-core/lib/system-health/cluster-lag-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: ['operator-event-loop'],
    mitigation: {
      kind: 'absence-is-the-signal',
      why: 'The worker-side beat. "A synchronous wedge stops the worker\'s interval from firing, so the heartbeats STOP — and silence is the one signal that survives a non-yielding loop."',
    },
    note: 'Per-worker heartbeat to the cluster primary.',
  },
  {
    name: 'cluster-lag-scan',
    file: 'packages/operator-core/lib/system-health/cluster-lag-watchdog.ts',
    executor: 'cluster-primary-timer',
    recovers: ['operator-event-loop'],
    note: "The primary SIGKILLs a worker silent past the threshold; cluster-fork respawns it. The primary's loop is independent of the wedged worker's — the reference design for this whole table.",
  },
  {
    name: 'primary-managed-timers-broadcast',
    file: 'packages/operator-core/lib/cluster-managed-timers-sync.ts',
    executor: 'cluster-primary-timer',
    // Empty, and deliberately so: this mechanism targets NO failure, so there is no
    // component whose failure IS the failure it addresses. Filling `recovers` with
    // "things this is about" (cluster IPC, the managed-timer registry) is exactly the
    // misuse the module header warns turns the audit into noise — it would invent a
    // fate-sharing verdict for a mechanism that recovers nothing.
    recovers: [],
    note:
      "NOT a sentinel — a VISIBILITY broadcast, declared here only because it registers category:'watchdog'. " +
      "The cluster primary periodically pushes its OWN managed-timer + DBOS-schedule registries to workers over " +
      'node:cluster IPC (EI-19454206016477347), because SO_REUSEPORT means /api/internal/managed-timers is always ' +
      "answered by a worker, so the primary's own timers are otherwise invisible to the route that reports them. " +
      'It watches nothing and recovers nothing, so it has no fate-sharing to analyse. ' +
      "⚠ Its category is a poor fit for the registry's stated watchdog contract (\"out-of-band sentinel, MUST " +
      'SURVIVE WHAT IT WATCHES\") — it runs on, and reports, the same process, so it structurally cannot. The ' +
      'category was most plausibly chosen for shed-exemption rather than sentinel semantics. Re-categorising is a ' +
      'live behaviour change to that subsystem and is tracked on EI-20842109125283348 rather than done here.',
  },
  {
    name: 'memory-watchdog',
    file: 'packages/operator-core/lib/memory-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: ['operator-host-memory', 'operator-host-process'],
    mitigation: {
      kind: 'leading-indicator',
      why: 'Recycles on an RSS high-water TREND while the process is still healthy, so it completes its action before the OOM that would prevent it. A hard OOM-kill is systemd Restart= territory, which nothing in-process could cover.',
    },
    note: 'Bounded-RSS self-recycle for the long-running Hono host.',
  },
  {
    name: 'loop-pressure-governor',
    file: 'packages/operator-core/lib/loop-pressure-governor.ts',
    executor: 'operator-in-process-timer',
    recovers: ['operator-event-loop'],
    mitigation: {
      kind: 'leading-indicator',
      why: 'Sheds agent concurrency as loop pressure RISES, to keep the loop from reaching the wedge. It is a preventer, not a recoverer — under an actual stop it is as dead as anything else on the loop, and does not claim otherwise.',
    },
    note: 'Closed-loop feedback throttling fleet concurrency against loop pressure.',
  },
  {
    name: 'loop-pressure-governor-burn',
    file: 'packages/operator-core/lib/loop-pressure-governor.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Reads remote provider-pool burn and sheds agent concurrency before quota exhaustion; that failure domain is outside the listed operator substrate.',
  },
  {
    name: 'claude-update-canary',
    file: 'packages/operator-core/lib/system-health/claude-update-canary.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Probes a changed Claude Code build and its saved model route, then escalates CLI regressions. The external CLI failure domain is outside the listed operator substrate; this timer does not claim to recover a stopped operator.',
  },

  // ── DBOS / routines engine ───────────────────────────────────────────────────────
  {
    name: 'in-process-sweep-arm-reconcile',
    file: 'packages/operator-core/lib/dbos/in-process-sweep-arm.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Converges code-declared in-process sweep timers onto durable arm-state rows. The watchdog observes control-plane drift, not a listed substrate failure, so no substrate component is in its recovery domain.',
  },
  {
    name: 'dbos-executor-reaper',
    file: 'packages/operator-core/lib/dbos/dbos-executor-reaper.ts',
    executor: 'operator-in-process-timer',
    recovers: ['dbos-executor', 'dbos-queue'],
    note: 'Frees dedup ids pinned by dead executors. Deliberately a process-level interval, NOT a DBOS workflow — "a DBOS-scheduled reaper would queue on the very executor that wedges". Correct by construction.',
  },
  {
    name: 'dbos-hang-watchdog',
    file: 'packages/operator-core/lib/dbos/dbos-hang-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: ['dbos-executor'],
    note: 'Detects a workflow recovered without progress (recovery_attempts advances, max function_id does not). In-process, so a wedged DBOS queue does not silence it.',
  },
  {
    name: 'routine-fire-cancellation-alarm',
    file: 'packages/operator-core/lib/dbos/routine-fire-cancellation-alarm.ts',
    executor: 'operator-in-process-timer',
    recovers: ['routines-tick', 'dbos-queue'],
    note: 'Surfaces CANCELLED routineFires. In-process rather than a routine — the pattern this audit wants.',
  },
  {
    name: 'red-queen-engine-death',
    file: 'packages/operator-core/lib/red-queen/engine-death.ts',
    executor: 'operator-in-process-timer',
    recovers: ['routines-tick', 'dbos-executor'],
    note: "Every active routine's next_fire_at in the past at once = the engine is dead. Armed as a plain interval right after the boot catch, explicitly off DBOS and off the routines engine.",
  },

  // ── Release / git pipeline ───────────────────────────────────────────────────────
  {
    name: 'green-stall-watchdog',
    file: 'packages/operator-core/lib/release/green-stall-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Alarms on a silently-stalled green-checkpoint run.',
  },
  {
    name: 'git-sync-stall-watchdog',
    file: 'packages/operator-core/lib/release/git-sync-stall-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Alarms on commit staleness across the shared tree.',
  },
  {
    name: 'origin-freshness-watchdog',
    file: 'packages/operator-core/lib/release/origin-freshness-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'The class the other two miss: local commits fine, origin not advancing.',
  },
  {
    name: 'worktree-coverage-watchdog',
    file: 'packages/operator-core/lib/release/worktree-coverage-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Alarms when a worktree falls out of git-sync coverage.',
  },
  {
    name: 'git-export-drainer',
    file: 'packages/operator-core/lib/harness-state/git-export/drainer.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Drains undrained git_export_outbox rows.',
  },

  // ── Host / service supervision ───────────────────────────────────────────────────
  {
    name: 'liveness-alarm',
    file: 'packages/operator-core/lib/system-health/liveness-alarm.ts',
    executor: 'operator-in-process-timer',
    recovers: ['operator-host-process'],
    mitigation: {
      kind: 'out-of-band-backstop',
      backstop: 'service-restart-rate-watchdog',
      why: "Request-path supervision alarm running in the host it reports on: it cannot alarm about its OWN host being down. It covers peer/unit liveness; a host that is itself gone is systemd's case and shows up as a restart-rate signal.",
    },
    note: 'R4-3 request-path supervision alarm.',
  },
  {
    name: 'single-primary-check',
    file: 'packages/operator-core/lib/system-health/single-primary-check.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'R4-2 "exactly one background primary" guard — a split-brain check, not a liveness one.',
  },
  {
    name: 'service-restart-rate-watchdog',
    file: 'packages/operator-core/lib/system-health/service-restart-rate-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Alarms on the RATE a long-lived unit restarts — reads systemd state, so a crash-loop in ANOTHER unit is fully visible.',
  },
  {
    name: 'condition-staleness-alarm',
    file: 'packages/operator-core/lib/system-health/condition-staleness-alarm.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Periodic actor for coord:conditions staleness.',
  },
  {
    name: 'escalation-aging-alarm',
    file: 'packages/operator-core/lib/overwatch/escalation-aging-alarm.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Deterministic actor for the escalation-aging anomaly.',
  },
  {
    name: 'claude-credential-sync',
    file: 'packages/operator-core/lib/claude-credential-sync.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Newest-wins reconciliation of the OAuth credential bundle across session dirs.',
  },

  // ── Sidecars and separate processes ──────────────────────────────────────────────
  {
    name: 'resource-governor-live-health-publisher',
    file: 'packages/operator-core/lib/resource-governor/live-health-publisher.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note:
      'Publishes THIS process\'s live-health fragment (loop lag, GC, RSS) to the shared ' +
      'fragment dir for the sampler to merge. Publication only — it repairs nothing and ' +
      'decides nothing, so no substrate component sits inside a failure domain it targets. ' +
      'Armed once per publishing process under one literal name with instanced: true, so ' +
      'schedule:inventory shows a single aggregated row carrying the live instance count.',
  },
  {
    name: 'resource-governor-live-health-monitor',
    file: 'packages/operator-core/lib/resource-governor/live-health-monitor.ts',
    executor: 'sidecar-process-timer',
    recovers: [],
    note:
      'The out-of-process live-health sampler its own header calls "cross-platform, ' +
      'out-of-process": it OBSERVES host health and owns "only observation and freshness". ' +
      'It recovers nothing — it never decides whether a reading should contract admission, ' +
      'which belongs to the P-005/P-006 controller — so no substrate component is inside a ' +
      'failure domain it targets. Being a separate process spawned by live-health-supervisor ' +
      'is also what keeps its sampling honest when the operator loop is the thing degrading.',
  },
  {
    name: 'spawner-sidecar-orphan-watchdog',
    file: 'packages/operator-core/lib/fleet/spawner-sidecar-server.ts',
    executor: 'sidecar-process-timer',
    recovers: ['operator-host-process'],
    note: 'Runs INSIDE the spawner sidecar, polling whether its owner pid is gone. The observer is outside the failure domain — correct by construction.',
  },
  {
    name: 'gateway-sidecar-reprobe',
    file: 'packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts',
    executor: 'operator-in-process-timer',
    recovers: ['external-process'],
    note: 'The operator re-probes the gateway sidecar; watcher and watched are different processes.',
  },

  // ── Federation / substrate sync ──────────────────────────────────────────────────
  {
    name: 'federation-join-stall-watchdog',
    file: 'packages/operator-core/lib/sync/hyperbee/federation-join-stall-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'A federation VM that loses gh auth mid-join stalls silently.',
  },
  {
    name: 'booted-handles-broadcast',
    file: 'packages/operator-core/lib/sync/hyperbee/cluster-booted-handles-sync.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Push-sync of booted handles across true-cluster workers.',
  },
  {
    name: 'booted-handles-pg-publish',
    file: 'packages/operator-core/lib/sync/hyperbee/substrate-booted-handles-pg.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Cross-SERVICE leg of the booted-handles status broadcast.',
  },

  // ── Agent / session layer (the operator watches; the agents are the subject) ──────
  {
    name: 'agent-productivity-watchdog',
    file: 'packages/operator-core/lib/system-health/agent-productivity-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note:
      'REPORT-ONLY, and its header says so as a decision: "It never respawns anything." It ' +
      'opens a deduped escalation for wedged / never-booted agent sessions and stops there, ' +
      'because N respawns fired into the wall that caused the wedge spend the little capacity ' +
      'left. Recovery belongs to a caller that can also see whether capacity exists (the ' +
      'goal-holder respawn leg, behind its own owner-authority flag). Declaring recovers: [] ' +
      'is therefore the accurate statement, not a waiver: it repairs no substrate component, ' +
      'so its in-process executor cannot fate-share with one.',
  },
  {
    name: 'mcp-dark-watchdog',
    file: 'packages/operator-core/lib/system-health/mcp-dark-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Layer-4 net for tool-less sessions after a deploy. The watchdog rides the NEW host, so the restart that caused the darkness cannot silence it.',
  },
  {
    name: 'goal-liveness-watchdog',
    file: 'packages/operator-core/lib/system-health/goal-liveness-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'P-001 of this plan — goals with a stale agent_modes row and no live holder. A dead agent is not a dead operator.',
  },
  {
    name: 'goal-holder-respawner',
    file: 'packages/operator-core/lib/system-health/goal-liveness-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'P-009 — opt-in lost-holder recovery. It rides the operator rather than the agent-session layer it restores, and shares the bounded flap-damping/give-up policy.',
  },
  {
    name: 'standing-goal-boot-arm',
    file: 'packages/operator-core/lib/system-health/goal-liveness-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'P-011 — bounded boot window that re-arms STANDING goals after an operator restart (self-stops after maxPasses). It rides the fresh operator, so the restart that dropped the arm cannot silence it; a dark standing goal is not a substrate failure.',
  },
  {
    name: 'goal-drain-fleet-watchdog',
    file: 'packages/operator-core/lib/system-health/goal-drain-fleet-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Sibling of the above — a goal draining without the fleet its contract requires.',
  },
  {
    name: 'goal-edit-claim-watchdog',
    file: 'packages/operator-core/lib/system-health/goal-edit-claim-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'P-008 — first edit-claim by a goal-mode owner, surfaced to graders in real time. A stale grading signal is not a substrate failure.',
  },
  {
    name: 'goal-owner-report-watchdog',
    file: 'packages/operator-core/lib/system-health/goal-owner-report-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'P-009 — a goal-mode owner report-silent past the cadence floor gets one nudge with the report skeleton. A quiet owner is not a substrate failure.',
  },
  {
    name: 'retrieval-degradation-watchdog',
    file: 'packages/operator-core/lib/system-health/retrieval-degradation-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'P-002 of this plan — semantic leg blocked by the embed budget.',
  },
  {
    name: 'embed-latency-watchdog',
    file: 'packages/operator-core/lib/system-health/embed-latency-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: ['external-process'],
    note: 'Grades per-caller embed latency and unavailability from operator-owned samples. The embed sidecar is an external process, so this in-process observer remains outside the failure domain it reports.',
  },
  {
    name: 'compaction-compliance-watchdog',
    file: 'packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Sessions crossing the compaction band without flushing.',
  },
  {
    name: 'installed-hook-drift-watchdog',
    file: 'packages/operator-core/lib/system-health/installed-hook-drift-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'WI-10002031. Compares ~/.papercusp/hooks/cc (the copy that executes on every agent turn) against the canonical hooks under the integration root. The subject is plain files on disk written by an installer, not a component this timer depends on, so the executor sits outside the failure it targets.',
  },
  {
    name: 'wedged-identity-activation-watchdog',
    file: 'packages/operator-core/lib/system-health/wedged-identity-activation-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'WI-10002060. Finds sessions whose identity activation cannot be reconciled with their launch record, which makes the kernel refuse every tool for the life of that session. `recovers` is EMPTY deliberately: the failure is scoped to an individual AGENT session\'s authority, not to the operator this timer rides — the operator keeps serving every other session normally, which is precisely why nothing else notices. The wedged session cannot self-report (filing is itself a tool call), so being out-of-band is the whole point of the mechanism.',
  },
  {
    name: 'mid-turn-memory-admission-heartbeat',
    file: 'packages/operator-core/lib/memory/mid-turn-admission.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Renews the mid-turn memory-admission lease while drained work is still active, so a slow drain is not mistaken for a dead holder. The renewable lease expiry is the correctness backstop it services; nothing in the substrate is inside the failure it targets.',
  },
  {
    name: 'carry-drill-drop-watchdog',
    file: 'packages/operator-core/lib/system-health/carry-drill-drop-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Carry-drill state dropped across a respawn.',
  },
  {
    name: 'codex-rollout-persistence-watchdog',
    file: 'packages/operator-core/lib/system-health/codex-rollout-persistence-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Codex rollout files not persisting.',
  },
  {
    name: 'cold-boot-drill-autorunner',
    file: 'packages/operator-core/lib/system-health/cold-boot-drill-autorunner.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Runs the cold-boot drill on cadence.',
  },

  // ── Remote access (external-app-access) ──────────────────────────────────────────
  {
    name: 'own-tunnel-reconciler',
    file: 'packages/operator-core/lib/own-tunnel/service.ts',
    executor: 'operator-in-process-timer',
    recovers: ['external-process'],
    note: 'Makes this process match the remote_access_own_tunnel row: opens the external-ingress listener and (re)starts the cloudflared connector. cloudflared is a separate process, so its death is the failure this recovers, and the in-process timer does not depend on it.',
  },
  {
    name: 'portal-relay-reconciler',
    file: 'packages/operator-core/lib/remote-access/relay-opt-in.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'Makes this process match the remote_access_portal_relay row: (re)links the outbound relay connector. The connector is an in-process outbound link to the portal, so a dropped link is not a substrate component this timer rides.',
  },

  // ── Work-item queue / claim layer ────────────────────────────────────────────────
  {
    name: 'unservable-critical-watchdog',
    file: 'packages/operator-core/lib/system-health/unservable-critical-watchdog.ts',
    executor: 'operator-in-process-timer',
    recovers: [],
    note: 'EI-19919820196426791 — a `critical` item aged past 7d in a lane no claim path serves (lane=observation / state=needs-human). The dispatcher is working correctly and excluding by design, so nothing in work-item-dispatch is inside the failure; the failure is the mis-file itself, and only an outside sweep can see an item nobody writes to.',
  },

  // ── DURABLE TIER — hand-declared; see `coverage.durableTierDiscovery` ─────────────
  {
    name: 'plan-schedule-blender-steward-heartbeat-2026-08-11',
    file: 'packages/operator-core/lib/harness/routines/plan-run-action.ts',
    executor: 'routine-agent-dispatch',
    recovers: ['agent-session', 'work-item-dispatch'],
    mitigation: {
      kind: 'out-of-band-backstop',
      backstop: 'goal-liveness-watchdog',
      why: 'The heartbeat cannot recover a steward when the agent layer is empty: its plan-run fire only mints work for the same dispatcher. The in-process goal-liveness watchdog survives that absence and escalates the dark goal, so the heartbeat is an optimization rather than the only detection path.',
    },
    note: "The plan's motivating case, verified from source. The routine fires system:plan-run, which mints an instance plan and \"the instance's items as frontier work_items — the harness's existing dispatcher executes those work_items, no second execution engine\" (plan-run-action.ts). routine-classification.ts already types it { spend: 'llm' }. So a steward that is dead because nothing is alive to claim its work is \"recovered\" by minting more work nobody claims.",
  },
  {
    name: 'system:unguarded-halt-rescue',
    file: 'packages/operator-core/lib/harness/routines/unguarded-halt-rescue-action.ts',
    executor: 'routine-agent-dispatch',
    recovers: ['agent-session'],
    mitigation: {
      kind: 'leading-indicator',
      why: 'It WAKES an existing halted session rather than depending on one to volunteer. The session process is still up (the module is explicit that these agents heartbeat for 6-9 days while making no tool call) — so the agent-session dependency is satisfied by the very session being rescued.',
    },
    note: 'Wakes sessions that halted without a guaranteed re-wake.',
  },
  {
    name: 'system:sweep-stalled-loops',
    file: 'packages/operator-core/lib/harness/routines/stalled-loops-guard.ts',
    executor: 'routine-system-action',
    recovers: [],
    note: 'Deterministic SQL pass over stalled loop rows — classified spend:none, so no agent is in its path.',
  },
  {
    name: 'system:gc-dead-loops',
    file: 'packages/operator-core/lib/harness/routines/gc-dead-loops-action.ts',
    executor: 'routine-system-action',
    recovers: [],
    note: 'Reaps loop rows whose owning session is long gone. spend:none.',
  },
] as const;

export interface RecoveryAuditRow {
  name: string;
  file: string;
  executor: ExecutorKind;
  verdict: RecoveryVerdict;
  /** The components that are BOTH required by the executor and inside the failure domain. */
  fateSharedOn: readonly SubstrateComponent[];
  mitigation?: Mitigation;
  note: string;
}

export interface RecoveryAuditCoverage {
  /**
   * The ephemeral tier is enumerated mechanically from `category: 'watchdog'`, so it is
   * complete and a missing declaration fails the test.
   */
  ephemeralTierDiscovery: 'mechanical';
  /**
   * The durable tier is declared BY HAND: no field on a routine distinguishes a recovery
   * routine from an ordinary one, so a durable-tier mechanism can be absent from this
   * table without any test going red. Stated here so the row list is never read as a
   * total.
   */
  durableTierDiscovery: 'manual';
  declared: number;
  /** Declared rows whose executor rides the durable tier. */
  durableTierDeclared: number;
}

export interface RecoveryAuditResult {
  rows: readonly RecoveryAuditRow[];
  counts: Record<RecoveryVerdict, number>;
  coverage: RecoveryAuditCoverage;
}

/** PURE: which required components fall inside the failure domain. */
export function fateSharedComponents(m: RecoveryMechanism): SubstrateComponent[] {
  const required = new Set(EXECUTOR_REQUIRES[m.executor]);
  return m.recovers.filter((c) => required.has(c));
}

/** PURE: the verdict for one mechanism. */
export function verdictFor(m: RecoveryMechanism): RecoveryVerdict {
  if (fateSharedComponents(m).length === 0) return 'sound';
  return m.mitigation ? 'fate-shared-mitigated' : 'fate-shared';
}

const DURABLE_EXECUTORS: ReadonlySet<ExecutorKind> = new Set<ExecutorKind>([
  'dbos-scheduled-workflow',
  'routine-system-action',
  'routine-agent-dispatch',
]);

/**
 * PURE: the audit. Takes the table (injectable so tests can drive synthetic rows) and
 * returns one row per mechanism plus the coverage boundary.
 */
export function auditRecoveryDependencies(
  mechanisms: readonly RecoveryMechanism[] = RECOVERY_MECHANISMS,
): RecoveryAuditResult {
  const rows: RecoveryAuditRow[] = mechanisms.map((m) => ({
    name: m.name,
    file: m.file,
    executor: m.executor,
    verdict: verdictFor(m),
    fateSharedOn: fateSharedComponents(m),
    ...(m.mitigation ? { mitigation: m.mitigation } : {}),
    note: m.note,
  }));
  const counts: Record<RecoveryVerdict, number> = {
    sound: 0,
    'fate-shared-mitigated': 0,
    'fate-shared': 0,
  };
  for (const r of rows) counts[r.verdict] += 1;
  return {
    rows,
    counts,
    coverage: {
      ephemeralTierDiscovery: 'mechanical',
      durableTierDiscovery: 'manual',
      declared: rows.length,
      durableTierDeclared: rows.filter((r) => DURABLE_EXECUTORS.has(r.executor)).length,
    },
  };
}

/**
 * A mitigation is only worth the word if the thing it points at exists. An
 * 'out-of-band-backstop' naming a mechanism that is not in the table (or that is itself
 * unmitigated fate-shared on the SAME component) is a fate-shared row wearing a
 * reassuring label — which is worse than an honest one, because it stops the reader
 * looking.
 */
export interface BrokenBackstop {
  name: string;
  backstop: string | undefined;
  reason: 'missing-backstop-name' | 'unknown-backstop' | 'backstop-also-fate-shared';
}

export function findBrokenBackstops(mechanisms: readonly RecoveryMechanism[] = RECOVERY_MECHANISMS): BrokenBackstop[] {
  const byName = new Map(mechanisms.map((m) => [m.name, m]));
  const broken: BrokenBackstop[] = [];
  for (const m of mechanisms) {
    if (m.mitigation?.kind !== 'out-of-band-backstop') continue;
    const backstop = m.mitigation.backstop;
    if (!backstop) {
      broken.push({ name: m.name, backstop, reason: 'missing-backstop-name' });
      continue;
    }
    const target = byName.get(backstop);
    if (!target) {
      broken.push({ name: m.name, backstop, reason: 'unknown-backstop' });
      continue;
    }
    // The backstop must not be fate-shared, unmitigated, on a component this mechanism
    // is relying on it to cover.
    const targetShared = new Set(fateSharedComponents(target));
    const relying = fateSharedComponents(m);
    if (!target.mitigation && relying.some((c) => targetShared.has(c))) {
      broken.push({ name: m.name, backstop, reason: 'backstop-also-fate-shared' });
    }
  }
  return broken;
}

/**
 * PURE: the coverage gate's decision, split out from the tree scan so it can be driven
 * with synthetic input.
 *
 * A gate whose whole logic lives inside the assertion that consumes a real scan is
 * untestable in the direction that matters — you cannot show it would FAIL — and a scan
 * that silently returned nothing would make it pass vacuously. Both halves are checked
 * separately in the test: this function against controls, and the scan against a floor.
 *
 * A scanned timer whose NAME is not a literal is reported as unreadable rather than
 * skipped: it is a watchdog nobody can prove is declared, which is a finding, not a pass.
 */
export interface CoverageGap {
  undeclared: { name: string; file: string }[];
  unreadable: { file: string }[];
  /** Declared in-process rows with no matching timer in the tree — stale bookkeeping. */
  stale: string[];
}

export function findCoverageGaps(
  scanned: readonly { name: string | null; file: string }[],
  mechanisms: readonly RecoveryMechanism[] = RECOVERY_MECHANISMS,
): CoverageGap {
  const declared = new Set(mechanisms.map((m) => m.name));
  const scannedNames = new Set(scanned.map((t) => t.name).filter((n): n is string => n !== null));
  return {
    undeclared: scanned
      .filter((t) => t.name !== null && !declared.has(t.name))
      .map((t) => ({ name: t.name as string, file: t.file })),
    unreadable: scanned.filter((t) => t.name === null).map((t) => ({ file: t.file })),
    stale: mechanisms
      .filter((m) => m.executor === 'operator-in-process-timer' && !scannedNames.has(m.name))
      .map((m) => m.name),
  };
}

/**
 * ── HOLDER-REQUIRED GOALS (goal-live-holder-guarantee-2026-08-18 P-002) ───────────
 *
 * A holder-required goal declares, in `launch_settings.holder.onLoss`, what happens
 * when its holder stops being live. That is a RECOVERY DISPOSITION in exactly this
 * module's sense — it names what is supposed to put the system right — so it belongs
 * under the same rule as every other one: DECLARED and CHECKED, never assumed.
 *
 * The gap this closes is specific. `onLoss` is a closed set in the schema, and adding
 * a value to it is a one-line edit that reads as harmless. But each value is a promise
 * about a recovery, and a value whose recovery does not exist is a goal quietly
 * declaring a guarantee nobody honours — the same shape as the stale `agent_modes` row
 * the whole plan exists to kill, one level up. So every admitted value must say here
 * WHICH of three things it is, and the test fails when one does not:
 *
 *   derived-at-read     — no runtime actor at all. Nothing polls, nothing sweeps.
 *                         Correct BECAUSE it is fate-shared with nothing.
 *   recovery-mechanism  — a real actor, which must therefore appear in
 *                         RECOVERY_MECHANISMS and be judged like every other one.
 *   planned             — no actor exists yet, said out loud, with the plan item that
 *                         owes it. Anything else here would let "we'll build it later"
 *                         masquerade as coverage.
 */
export interface HolderLossDisposition {
  kind: 'derived-at-read' | 'recovery-mechanism' | 'planned';
  /** Required for 'recovery-mechanism': the RECOVERY_MECHANISMS row that performs it. */
  mechanism?: string;
  /** Required for 'planned': who owes the actor. */
  planItem?: string;
  why: string;
}

export const HOLDER_LOSS_DISPOSITIONS: Readonly<Record<string, HolderLossDisposition>> = {
  deactivate: {
    kind: 'derived-at-read',
    why:
      'P-004 derives `active` from the holder resolver on every read, so a lost holder ' +
      'stops the goal reading active with nothing running. There is no executor to be ' +
      'fate-shared WITH — the absence of an actor is the property, not a gap in this table.',
  },
  respawn: {
    kind: 'recovery-mechanism',
    mechanism: 'goal-holder-respawner',
    why:
      "P-009's goal-holder-respawner runs on the operator host, independently of the " +
      'agent-session layer it restores. D-001 still makes a goal earn respawn by naming ' +
      'it, D-002 keeps the actor behind its own default-OFF owner-authority flag, and the ' +
      'shared damping policy bounds retries before a deduped give-up escalation.',
  },
};

export interface HolderLossGap {
  /** Values the schema admits with no declared disposition — the anti-rot case. */
  undeclared: string[];
  /** Dispositions declared for a value the schema no longer admits — stale bookkeeping. */
  stale: string[];
  /** 'recovery-mechanism' rows whose named mechanism is not in RECOVERY_MECHANISMS. */
  unresolvedMechanism: { onLoss: string; mechanism: string | null }[];
  /** 'planned' rows with no plan item, i.e. an IOU nobody owes. */
  unownedPlan: string[];
}

/**
 * PURE: the holder-disposition gate's decision, split from the real tables for the
 * same reason `findCoverageGaps` is — a gate that can only be run against the live
 * declarations cannot be shown to FAIL, and one that cannot fail proves nothing.
 */
export function findHolderLossGaps(
  onLossValues: readonly string[],
  dispositions: Readonly<Record<string, HolderLossDisposition>> = HOLDER_LOSS_DISPOSITIONS,
  mechanisms: readonly RecoveryMechanism[] = RECOVERY_MECHANISMS,
): HolderLossGap {
  const declaredNames = new Set(mechanisms.map((m) => m.name));
  const admitted = new Set(onLossValues);
  const unresolvedMechanism: { onLoss: string; mechanism: string | null }[] = [];
  const unownedPlan: string[] = [];

  for (const [onLoss, d] of Object.entries(dispositions)) {
    if (!admitted.has(onLoss)) continue; // reported as `stale` below
    if (d.kind === 'recovery-mechanism' && (!d.mechanism || !declaredNames.has(d.mechanism))) {
      unresolvedMechanism.push({ onLoss, mechanism: d.mechanism ?? null });
    }
    if (d.kind === 'planned' && !d.planItem) unownedPlan.push(onLoss);
  }

  return {
    undeclared: onLossValues.filter((v) => !(v in dispositions)),
    stale: Object.keys(dispositions).filter((k) => !admitted.has(k)),
    unresolvedMechanism,
    unownedPlan,
  };
}

/** Render the audit as a markdown table — what P-004 asks to be produced and filed. */
export function renderRecoveryAuditTable(result: RecoveryAuditResult = auditRecoveryDependencies()): string {
  const order: Record<RecoveryVerdict, number> = { 'fate-shared': 0, 'fate-shared-mitigated': 1, sound: 2 };
  const rows = [...result.rows].sort((a, b) => order[a.verdict] - order[b.verdict] || a.name.localeCompare(b.name));
  const lines = [
    '| mechanism | executor | recovers (shared) | verdict | mitigation |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push(
      `| \`${r.name}\` | ${r.executor} | ${r.fateSharedOn.join(', ') || '—'} | ${r.verdict} | ${
        r.mitigation ? `${r.mitigation.kind}${r.mitigation.backstop ? ` → \`${r.mitigation.backstop}\`` : ''}` : '—'
      } |`,
    );
  }
  lines.push(
    '',
    `sound ${result.counts.sound} · fate-shared-mitigated ${result.counts['fate-shared-mitigated']} · fate-shared ${result.counts['fate-shared']}`,
    '',
    `Coverage: ephemeral tier ${result.coverage.ephemeralTierDiscovery}, durable tier ${result.coverage.durableTierDiscovery} ` +
      `(${result.coverage.durableTierDeclared} of ${result.coverage.declared} rows) — the durable-tier list is NOT exhaustive.`,
  );
  return lines.join('\n');
}
