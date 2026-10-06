/**
 * Routine classification — the four axes the owner-facing automation panes sort
 * on (agents-system-pane-split-2026-07-26 P-001).
 *
 * WHY THIS EXISTS (owner, 2026-07-26): "Is everything in the agents tab an LLM?"
 * No. Of the 140 non-loop schedules in this workspace, 55 spawn a model and 85 are
 * deterministic sweeps — git commits, GC, canary probes, outbox drains — sitting in
 * a tab called "Agents" with equal visual weight to the things spending the owner's
 * weekly limit. The panes now split on that line, so this module has to answer it
 * correctly.
 *
 * ⚠ CLASSIFY BY `target_role`, NEVER BY THE ROUTINE NAME (D-001). The predecessor
 * of this module was `AGENT_SPAWNING_PATTERNS` in catalog.ts — a list of regexes
 * matched against the routine's NAME. A name is a label; `target_role` is the
 * handler the routines engine actually dispatches to, so it is the only thing that
 * knows whether a model runs. The regex was wrong in both directions, and its
 * output was load-bearing (it drove the "tokens" flag the owner used to decide what
 * to pause). Two demonstrated failures, both fixed by this table:
 *
 *   • `wake-brain` was flagged as a token spender by `/(^|-)wake($|-)/` — and its
 *     handler is `async (ctx) => { void ctx; }`, a retired tombstone kept registered
 *     so old rows don't fail with "unknown action" (wake-brain-action.ts). It cannot
 *     spend anything. It is `none` here.
 *   • `/^improvement-(implement|triage|watchdog|human-digest|invalid-args-miner)$/`
 *     flagged FIVE routines. Exactly one — `improvement-implement` — returns
 *     `durableSpawns`. `-triage` explicitly "never dispatches — it only records
 *     routing metadata"; `-watchdog` and `-invalid-args-miner` are SQL passes;
 *     `-human-digest` ranks and sends. Four false positives.
 *
 * ⚠ KEEP THIS FILE RUNTIME-IMPORT-FREE. The left-rail tabs import these as VALUES,
 * and their bundle is a browser bundle — the same constraint that forced
 * pane-categories.ts out of catalog.ts (which top-level-imports a Postgres client).
 * Types are erased; values are not.
 *
 * ⚠ AND KEEP IT A STATIC TABLE, not a field read off the live system-action
 * registry (D-002). Reading `listSystemActions()` at request time would couple a
 * request-serving projection to whether the BACKGROUND registry happens to be
 * loaded in this process — exactly the class of bug where a request-only staging
 * host silently reports an empty projection. The table cannot drift instead because
 * `routine-classification.registry.test.ts` enumerates the live registry and fails
 * if the two disagree in either direction.
 */

/** Does a fire of this routine cause model turns to be billed? */
export type RoutineSpend = 'llm' | 'none';

/**
 * What FIRES the row — the mechanism, not the subject.
 *
 * `triggered` is the one that did not exist before and is why the panes used to
 * show a padlock with no explanation: `doc-freshness-sweep` and
 * `doc-steward-dispatch` are neither schedules nor timers. They are function calls
 * at the end of every git-sync (SYNC_TRIGGERED_SWEEPS in schedule-inventory.ts), so
 * "runs as an in-process schedule" — the tooltip they used to get — was simply
 * false. A triggered row names its trigger instead of faking a cadence.
 */
export type RoutineKind = 'scheduled' | 'triggered' | 'loop';

/**
 * Is it actually going to run again?
 *
 * `stalled` is the state `active` alone cannot express, and its absence is the
 * defect the owner spotted: 15 loop rows are `active = true` with
 * `next_fire_at = 'infinity'` — armed, never firing again because the owning
 * session is long gone. `loop-su-d93ac1bf-…` read as healthy in the pane while
 * having last fired five days earlier.
 */
export type RoutineLiveness = 'running' | 'stalled' | 'dormant';

/**
 * Is the schedule ARMED — and do we know?
 *
 * WI-6447. `schedule-inventory` reports `armed: true | false | null`, and the
 * catalog used to funnel all three through `const active = row.armed !== false`,
 * which maps the UNKNOWN case onto the optimistic one. The 7 external-process
 * rows (gateway-self-heal, gateway-token-refresh, psu-supervisor-heartbeat, …)
 * all report `null` with the note "static manifest — live fire-state requires
 * P-014 federation" — nothing has checked them, yet the pane rendered them as
 * running.
 *
 * `unknown` is therefore a FIRST-CLASS state, exactly as it is for `spend`: a
 * row we cannot verify must not be able to look healthy. This is the same defect
 * class as the two this module already exists to fix (`controllable:false`
 * meaning five different things; `active:true` on 15 loops that would never fire
 * again) — a display collapsing distinct situations into one reassuring value.
 */
export type RoutineArmedState = 'armed' | 'disarmed' | 'unknown';

/** The row's short status word, and whether it is a state we actually verified. */
const ARMED_STATE_COPY: Record<RoutineArmedState, string> = {
  armed: 'armed',
  disarmed: 'not armed',
  unknown: 'arm state unknown',
};

/**
 * Derive the tri-state from schedule-inventory's raw `armed` field WITHOUT
 * collapsing it. Pure and total: anything that is not a literal boolean is
 * `unknown`, so a future source emitting `undefined` degrades to the honest
 * state rather than the flattering one.
 */
export function routineArmedState(armed: boolean | null | undefined): RoutineArmedState {
  if (armed === true) return 'armed';
  if (armed === false) return 'disarmed';
  return 'unknown';
}

/** Display copy for an armed state — kept beside the type so the two cannot drift. */
export function armedStateLabel(state: RoutineArmedState): string {
  return ARMED_STATE_COPY[state];
}

/**
 * Where this row's on/off switch actually lives.
 *
 * Replaces the old `controllable: boolean`, whose false case rendered a padlock
 * that meant four different things at once ("it's a DBOS workflow" / "it's a
 * managed timer" / "it's a git-sync hook" / "its switch is a feature flag"). The
 * `flag` case is the one that was costing a real control: `doc-steward-dispatch`'s
 * armed state IS the `papercusp-doc-steward` flag, which the inventory already
 * resolves — the pane just had no way to say so.
 */
export type RoutineControl = 'routine' | 'flag' | 'none';

/**
 * WHY a `control: 'none'` row has no switch here.
 *
 * The owner asked this question out loud on 2026-07-26, looking at the shipped
 * System pane: *"why are there some things that say 'Runs as a managed schedule,
 * not a routine — paused from its own subsystem'. should we not have all runs as
 * routines?"* That the question had to be asked IS the defect — "its own
 * subsystem" names a limitation and points nowhere, and a single sentence was
 * covering five architecturally different situations.
 *
 * Splitting them matters because the answers are genuinely different, and one of
 * them is a real invariant rather than an implementation gap:
 *
 *   - `watchdog`   — a watchdog driven BY the routines tick cannot detect a WEDGED
 *                    routines tick. Being outside the control plane is the whole
 *                    point of the thing; this is the one that must never be "fixed".
 *   - `per-process`— a cache refresh runs in every process. There is no singleton
 *                    to pause, so a single switch would be a lie about scope.
 *   - `per-connection` — one timer per stream, created and destroyed with it. Not
 *                    a schedule at all; it has no steady-state identity to toggle.
 *   - `other-process` — a different OS process. Reachable only once the P-014
 *                    per-process federation lands; a genuine gap, not a principle.
 *   - `ephemeral-tier` — already centrally driven, just declared as a blueprint
 *                    `triggers.schedule` rather than a routines row. The one set
 *                    where "make it a routine" is a coherent proposal.
 */
export type NoControlReason =
  | 'watchdog'
  | 'per-process'
  | 'per-connection'
  | 'other-process'
  | 'ephemeral-tier'
  | 'durable-workflow'
  | 'event-triggered'
  | 'unknown';

export interface ControlEntry {
  control: RoutineControl;
  /** One line, shown as the row's tooltip — where the switch is, or why there isn't one. */
  why: string;
  /** Set only when `control === 'none'`; null otherwise. */
  reason: NoControlReason | null;
}

/** The tooltip copy per no-control reason. Kept beside the type so the two cannot drift. */
const NO_CONTROL_COPY: Record<NoControlReason, string> = {
  watchdog:
    'A watchdog — deliberately outside the routine system, because one driven by the scheduler could not detect the scheduler wedging. Stopping it is a code change, by design.',
  'per-process':
    'A per-process cache refresh — one runs in every operator process, so there is no single switch to offer. It stops when the process does.',
  'per-connection':
    'A per-connection timer — one exists per live stream and dies with it. There is no steady-state schedule here to pause.',
  'other-process':
    'Runs inside a separate process (not the operator), which the routine system cannot yet reach. Stop it by stopping that process.',
  'ephemeral-tier':
    'A central sweep on the in-process tier — declared in code rather than as a routine row, so it has no per-row switch yet.',
  'durable-workflow':
    'A DBOS scheduled workflow — its cadence is declared in code, so there is no row to toggle. Stopping it is a code change.',
  'event-triggered': 'Fires on an event rather than a clock — there is no schedule to pause.',
  unknown: 'Not a routine row, so it has no switch in this pane.',
};

/**
 * Derive where a non-routines row's switch lives (or why it has none), from the
 * two fields the inventory already carries. Pure and total — an unrecognised
 * source/category degrades to `unknown` rather than throwing, because a new
 * timer category appearing should show a vague tooltip, never break the pane.
 */
export function routineControl(input: {
  source: string;
  category?: string | null;
  flagKey?: string | null;
}): ControlEntry {
  if (input.source === 'routines') {
    return { control: 'routine', why: 'Pause or resume it right here.', reason: null };
  }
  if (input.flagKey) {
    return {
      control: 'flag',
      why: `Its on/off switch is the feature flag \`${input.flagKey}\` — toggling here sets that flag.`,
      reason: null,
    };
  }
  // Source binds before category: a process boundary and a DBOS workflow are
  // constraints no category can override. Category then discriminates the
  // in-operator timers, which is where the five real populations live.
  const reason: NoControlReason =
    input.source === 'external-process'
      ? 'other-process'
      : input.source === 'dbos'
        ? 'durable-workflow'
        : input.category === 'sync-triggered'
          ? 'event-triggered'
          : input.category === 'watchdog'
            ? 'watchdog'
            : input.category === 'cache'
              ? 'per-process'
              : input.category === 'lifecycle'
                ? 'per-connection'
                : input.category === 'global-sweep' || input.category === 'ephemeral-harness'
                  ? 'ephemeral-tier'
                  : 'unknown';
  return { control: 'none', why: NO_CONTROL_COPY[reason], reason };
}

/** The subject grouping for the secondary browse-by-family view. */
export type RoutineFamily =
  | 'loops'
  | 'wake'
  | 'learning'
  | 'docs'
  | 'git-release'
  | 'cleanup'
  | 'health'
  | 'federation';

export interface SpendEntry {
  spend: RoutineSpend;
  /** One line, shown as the row's tooltip — why this is or isn't a spender. */
  why: string;
}

/**
 * Spend metadata for blueprint payloads handled by `system:blueprint-run`.
 *
 * That target role is a dispatcher, not an executable unit: a payload can select
 * a pure deterministic program or a program whose step calls an LLM/spawns agents.
 * Keep the exceptions explicit and runtime-import-free so the browser-safe
 * classification module does not load the blueprint resolver. Unknown blueprint
 * ids conservatively retain the dispatcher's `llm` classification.
 */
export const BLUEPRINT_SPEND: Readonly<Record<string, SpendEntry>> = {
  calibration: { spend: 'none', why: 'Runs the deterministic calibration SQL sweep; no agent or LLM turn' },
  'change-ledger': { spend: 'none', why: 'Runs the deterministic git/SQL change-ledger scan; no agent or LLM turn' },
  'deferral-interest': { spend: 'none', why: 'Runs the deterministic SQL/math pricing refit; no agent or LLM turn' },
  'fleet-ekg': { spend: 'none', why: 'Runs the deterministic Fleet EKG SQL scan; no agent or LLM turn' },
  graduation: { spend: 'none', why: 'Runs the deterministic graduation SQL scan; no agent or LLM turn' },
  'memory-live-recall-canary': {
    spend: 'none',
    why: 'Runs the deterministic live-memory canary; no agent or LLM turn',
  },
  'memory-precision': { spend: 'none', why: 'Runs the deterministic memory-precision bench; no agent or LLM turn' },
  'negative-space': {
    spend: 'none',
    why: 'Runs the deterministic negative-space SQL/filesystem miner; no agent or LLM turn',
  },
  neologism: { spend: 'none', why: 'Runs the deterministic SQL/filesystem neologism miner; no agent or LLM turn' },
  'red-queen': { spend: 'none', why: 'Runs the deterministic red-queen drill; no agent or LLM turn' },
};

/**
 * The `target_role` carried by an ARM-STATE row — a `tier='in-process'` routines row standing for
 * a sweep DECLARED IN CODE, whose `active` column is that sweep's on/off switch
 * (EI-19294826146331487, migration 1046).
 *
 * Deliberately NOT a `system:` role: nothing dispatches these rows, and a `system:` role with no
 * registered action is the exact shape the missing-system-action auditor exists to flag
 * (EI-18741229858124453). It lives HERE, in the leaf classification module, rather than beside the
 * reconciler, so the UI-facing catalog can classify the row without importing the background-host
 * machinery that maintains it.
 */
export const IN_PROCESS_SWEEP_TARGET_ROLE = 'in-process:sweep';

/**
 * `system:loop-wake` is a SENTINEL target_role, not a registered handler: the DBOS
 * fire recognises a loop by `reschedule_interval_sec IS NOT NULL` + `target_owner_id`
 * and delivers a `coord:send {wake}` to the owner rather than running an action
 * inline (loop.ts LOOP_WAKE_ACTION). It therefore never appears in
 * `listSystemActions()`, and the registry cross-check must exempt it.
 *
 * `IN_PROCESS_SWEEP_TARGET_ROLE` is the second sentinel, for a stronger reason: an ARM-STATE row
 * is dispatched by NO executor at all, which is why it is deliberately not a `system:` role.
 * Referenced rather than repeated so the exemption cannot drift from the value actually written.
 */
export const SENTINEL_TARGET_ROLES: readonly string[] = ['system:loop-wake', IN_PROCESS_SWEEP_TARGET_ROLE];

/**
 * `system:<action>` → does firing it bill a model?
 *
 * The rule for `llm`: a fire can DIRECTLY cause billed model turns — it spawns an
 * agent, launches a session, wakes one (a wake costs a turn), or queues work that
 * is immediately dispatched to the autonomous pipeline. Filing a work-item a human
 * or an already-running loop may later pick up is NOT `llm`; the question the pane
 * answers is "if I pause this, does spending stop?".
 */
export const TARGET_ROLE_SPEND: Readonly<Record<string, SpendEntry>> = {
  // ── spends ───────────────────────────────────────────────────────────────
  'system:blueprint-run': { spend: 'llm', why: 'Launches a blueprint agent (the Mug/Cup hive launch path)' },
  'system:plan-run': { spend: 'llm', why: 'Mints a plan run and dispatches its items to agents' },
  'system:blueprint-operation': {
    spend: 'llm',
    why: 'Admits a registered operation whose declared target can mint agent work or a plan run',
  },
  'system:external-trigger-dispatch': {
    spend: 'llm',
    why: 'Launches event-triggered plan runs and wakes their claimable work',
  },
  'system:overwatch-launch': { spend: 'llm', why: 'Launches the overwatch (Kettle) session' },
  'system:gym-cycle': { spend: 'llm', why: 'Runs one bounded gym cycle' },
  'system:improvement-implement': { spend: 'llm', why: 'Returns durableSpawns — dispatches an implementer agent' },
  'system:hive-canary': { spend: 'llm', why: 'Queues a canary feature the autonomous pipeline carries end to end' },
  'system:unguarded-halt-rescue': { spend: 'llm', why: 'Wakes halted sessions, and a wake bills a turn' },
  'system:loop-wake': { spend: 'llm', why: "Delivers a wake to the loop's owning session" },
  'system:scout-cycle': { spend: 'llm', why: 'Runs a budgeted Scout ideation cycle (in-process LLM ideators/critics)' },
  'system:dream-cycle': {
    spend: 'llm',
    why: 'Runs a governor-bounded REM dreamer plus independent reviewer calls',
  },
  'system:goal-holder-launch': { spend: 'llm', why: 'Launches a replacement agent for an existing goal' },
  'system:goal-start': { spend: 'llm', why: 'Activates an existing goal by launching its holder session' },
  'system:work-item-admission-promoter': {
    spend: 'llm',
    why: 'Runs at most one batched strong-model duplicate judgement over the pending work-item batch',
  },
  'system:work-item-admission-bulk-dedup': {
    spend: 'llm',
    why: 'Runs the reviewed staged corpus dedup pass through bounded strong-model shard judgements',
  },
  'system:work-item-admission-bulk-dedup-driver': {
    spend: 'llm',
    why: 'Arms one stage-bounded system:work-item-admission-bulk-dedup run (strong-model shard judgements) daily unless one is already in flight',
  },
  'system:work-item-admission-delta-sweep': {
    spend: 'llm',
    why: 'Runs one strong-model call over the hourly admitted-item delta to detect shared-root-cause bursts',
  },
  'system:work-item-admission-daily-digest': {
    spend: 'llm',
    why: 'Runs one guarded full-corpus strong-model cluster digest after a completed bulk stage',
  },
  'system:resolver-whole-corpus': {
    spend: 'llm',
    why: 'Runs the whole-corpus strong-model resolver pass over one or more embedding-component shards',
  },
  'system:acceptance-grading-sweep': {
    spend: 'llm',
    why: 'Recruits or re-dispatches an independent grader, which can launch a model session',
  },
  'system:plan-drain-sweep': { spend: 'none', why: 'Applies deterministic plan status transitions; no model or agent launch' },
  'system:acceptance-drain-sweep': { spend: 'none', why: 'Files claimable work items for plans the ship gate is holding; bounded reads plus work-item writes, no model or agent launch' },

  // ── free system work ─────────────────────────────────────────────────────
  'system:git-sync': { spend: 'none', why: 'Commits and pushes the tree' },
  'system:facebook-personal-vault-poll': {
    spend: 'none',
    why: 'Polls the owner-authorized Facebook Graph surface and emits replay-safe trigger/vault deliveries',
  },
  'system:slack-org-sync': {
    spend: 'none',
    why: 'Syncs Slack channel membership into permission lists and writes paced backfill pages as chat messages; no agent or model call',
  },
  'system:connector-sync': {
    spend: 'none',
    why: 'Drives every registered provider source through leased backfill/incremental sync pages and admits records into the local delivery ledger; no agent or model call',
  },
  'system:personal-vault-import': {
    spend: 'none',
    why: 'Advances one bounded, checkpointed local archive-import batch; no agent or model call',
  },
  'system:psu-pty-host-events-ingest': {
    spend: 'none',
    why: 'Drains per-owner psu-pty host JSONL files into Postgres and applies row/file retention; filesystem plus SQL only, no agent or model call',
  },
  'system:work-item-durable-park-audit': {
    spend: 'none',
    why: 'Runs a report-only durable-park audit and publishes evidence; no model call or dispatch',
  },
  'system:work-item-admission-fail-open': {
    spend: 'none',
    why: 'Deterministically admits over-age pending rows and checks the promoter success watermark; no model call',
  },
  'system:unshipped-plans-audit': {
    spend: 'none',
    why: 'Reads plan/work/blocker/acceptance/presence state and publishes evidence artifacts — no model call',
  },
  'system:foreign-git-sync': { spend: 'none', why: 'Syncs a foreign (member) clone' },
  'system:green-checkpoint': { spend: 'none', why: 'Runs the gate suite and fast-forwards main' },
  'system:template-gym': { spend: 'none', why: 'Runs deterministic template and reference-consumer checks' },
  'system:release-trigger': { spend: 'none', why: 'Deploys the green commit' },
  'system:pr-poll': { spend: 'none', why: 'Polls GitHub for PR state' },
  'system:cargo-test': { spend: 'none', why: 'Runs the Rust test suite' },
  'system:nightly-release-cut': {
    spend: 'none',
    why: 'Launches a managed Linux nightly desktop build; no model call',
  },
  'system:bulk-run-watchdog': {
    spend: 'none',
    // Found unclassified by the registry cross-check while landing sync-batch-delta-check
    // (the autonomous-inbox-resolution-2026-08-31 P-002 lane landed the import + seed but
    // not this entry — the half-landed pair the check exists to catch). Verified against
    // bulk-run-watchdog-action.ts before classifying: it fails stale executing bulk runs
    // and reconciles run counters — deterministic row mutations, no spawn/wake/dispatch.
    why: 'Fails stale bulk runs and reconciles run counters — deterministic row updates, no agent spawn or wake',
  },
  'system:sync-batch-delta-check': {
    spend: 'none',
    // Verified against sync-batch-delta-check-action.ts before classifying: it runs
    // bounded test/typecheck subprocesses and files condition-keyed work-items via
    // createOneWorkItem — no agent spawn, no session wake, no pipeline dispatch, so
    // pausing it stops only the checks themselves.
    why: 'Runs bounded per-sync-batch affected-tests/typecheck legs and files deduped work-items — no agent spawn or wake',
  },
  'system:reconcile-silent-halts': {
    spend: 'none',
    // Found unclassified by the registry cross-check while landing gate-fire-drill (the
    // same half-landed-pair class the check exists to catch). Verified against
    // silent-halt-action.ts + its registration contract before classifying: it detects
    // heartbeat-fresh sessions holding claimed work-items while taking no turns and PAGES
    // THE OWNER (a notification — deliberately never the halted agent's inbox, which does
    // not wake a session); no spawn, no session wake, no dispatch.
    why: 'Detects halted sessions holding claimed work-items and pages the owner — a notification only, no agent spawn or wake',
  },
  'system:gate-fire-drill': {
    spend: 'none',
    // Verified against gate-fire-drill-action.ts before classifying: it launches ONE
    // detached checkpoint run (a subprocess suite, killed seconds later by design),
    // reads the pipeline_events ledger, and writes one outcome row + at most one
    // severe-event broadcast — no agent spawn, no session wake, no model call.
    why: 'Weekly kill-a-run fire drill asserting the verdict-liveness alarm chain — subprocess launch/kill + ledger reads, no agent spawn or wake',
  },
  'system:gate-watcher-tick': { spend: 'none', why: 'Reads gate state' },
  'system:scout-signal-accumulator-sweep': {
    spend: 'none',
    // Verified against scout/signal-accumulator.ts before classifying (WI-10000846
    // extracted it out of routinesTick): scoutSignalAccumulatorSweep reads per-lane
    // counts, scores them, and INSERTs into harness_shared.scout_signal_accumulator.
    // Its only outcomes are error|skipped|swept — there is no fire/dispatch path. It
    // is the volume ACCOUNTING substrate; cadence.ts READS these counts to decide
    // whether Scout should fire, and the resulting `system:scout-cycle` is what is
    // classified 'llm'. No spawn, wake or dispatch, so a fire cannot bill turns.
    why: 'Accumulates per-lane Scout signal counts into a counter table — cadence.ts reads them; system:scout-cycle is what spends',
  },
  'system:dead-target-reaper-sweep': {
    spend: 'none',
    // Verified against harness/routines/dead-target-sweep.ts before classifying
    // (also extracted from routinesTick by WI-10000846): it groups ACTIVE routines
    // by install, probes each install once, and — only on a permanent verdict
    // confirmed across two spaced sweeps — PARKS that install's routines and files
    // one debounced observation. Parking removes future fires rather than creating
    // them; no spawn, wake or dispatch, so a fire cannot bill turns.
    why: 'Probes installs and parks a dead install’s routines (plus one debounced observation) — strictly reduces future fires, no wake/spawn/dispatch',
  },
  'system:fleet-transition-sweep': {
    spend: 'none',
    // Verified against fleet-transition-sweep-action.ts before classifying: it
    // gathers observations through the same path fleet:assignments uses
    // (groupByAgent → the wakeability oracle → context-pressure buckets) and
    // diffs them against the previous snapshot. No spawn, no session wake, no
    // dispatch, and no DB writes — a pure observer, so a fire cannot bill turns.
    why: 'Reads fleet assignments + wakeability to detect member transitions — observer only, no wake/spawn/dispatch',
  },
  'system:presence-transition-sweep': {
    spend: 'none',
    // Verified against presence-transition-sweep-action.ts before classifying: it
    // reads the same assignments + wakeability pipeline fleet:assignments uses,
    // diffs it against the previous snapshot, and on a crossing writes coord
    // messages to the agents already blocked on the crosser. No spawn and no
    // dispatch, so a fire cannot bill turns. It DOES write (unlike its
    // fleet-transition sibling, which only emits awaitable events), and a written
    // coord line can satisfy a recipient's always-armed inbox-wake — but only for
    // an agent whose OWN commitment just became void, which is precisely the
    // moment waking them is correct rather than costly.
    why: 'Reads presence + resolves blocked-peer commitments, then writes one coord line per blocked agent — no spawn/dispatch',
  },
  'system:gate-canary-sweep': { spend: 'none', why: 'Sweeps stale gate canaries' },
  'system:autoloop-release-readiness-monitor': { spend: 'none', why: 'Reads release-readiness state' },
  'system:doc-anchor-reconcile': { spend: 'none', why: 'Reconciles doc anchors against HEAD (sha compare)' },
  'system:gitnexus-reindex': {
    spend: 'none',
    why: 'Shells out to `gitnexus analyze` to refresh the code graph — subprocess CPU/FS only',
  },
  'system:project-history-refresh': {
    spend: 'none',
    why: "Shells out to `papercusp project-history generate` to refresh a hive's committed History artifact — subprocess CPU/FS plus PG reads, no model call",
  },
  'system:knowledge-pack-delivery': { spend: 'none', why: 'Copies pack items into pools — no authoring' },
  'system:knowledge-pack-hygiene': {
    spend: 'llm',
    why: 'Runs up to 10 bounded transferability-judge LLM calls while reviewing pack rows',
  },
  'system:pot-git-gc': { spend: 'none', why: 'Garbage-collects pot git objects' },
  'system:coverage-census': {
    spend: 'none',
    // Verified against coverage-census-action.ts before classifying (plan
    // deterministic-coverage-census-2026-08-17 P-002): the handler resolves the
    // registered census providers, runs them, and upserts/retires rows through the
    // PG census store. No spawn, no session wake, no dispatch — so a fire cannot
    // bill model turns. The mass-retirement breaker and provider failures only
    // console.warn; they never launch anything.
    why: 'Runs the deterministic testable-surface census and upserts/retires census rows — provider + PG work only, no spawn/wake/dispatch',
  },
  'system:corpus-term-df': {
    spend: 'none',
    why: 'Recomputes corpus term document-frequency by tokenizing sampled turns locally — no model call',
  },
  'system:gc-plan-runs': { spend: 'none', why: 'Prunes finished plan-run rows' },
  'system:gc-dead-loops': { spend: 'none', why: 'Reaps loop rows whose owning session is long gone' },
  'system:sweep-stalled-loops': {
    spend: 'none',
    // Disarms (a plain UPDATE ... active=false) an ARMED loop whose computeTurnsStalled
    // verdict is true, then — like presence-transition-sweep above — writes ONE
    // inject-only ('*' broadcast, no wake) coord message per sweep summarizing every
    // owner it disarmed. No spawn, no dispatch, no wake: a fire cannot bill turns.
    why: 'Disarms turns-stalled loop routines and broadcasts an inject-only fleet notice — no spawn/dispatch/wake',
  },
  'system:sweep-wedged-pty-hosts': {
    spend: 'none',
    // Reads local discovery files + bounded ledger tails and, at most, writes ONE
    // inject-only ('*' broadcast, no wake) coord message plus one attention page per
    // sweep. No spawn, no dispatch, no wake, and deliberately no actuator — it cannot
    // bill a turn, and it cannot touch the hosts it observes.
    why: 'Detects wake-deaf psu-pty hosts from their on-disk ledgers and broadcasts an inject-only notice — no spawn/dispatch/wake',
  },
  'system:gc-verify-instances': {
    spend: 'none',
    why: 'Reaps abandoned verify-tauri-headless work dirs, displays and sidecars — filesystem only',
  },
  'system:gc-desktop-sessions': {
    spend: 'none',
    // The desktop lifecycle governor, built at parity with gc-verify-instances above. It walks
    // leased DesktopSession rows and applies the freeze-first ladder — freeze/thaw a cgroup,
    // reap an expired lease, update the row. Every effect is a process signal or a DB write; it
    // never spawns an agent, wakes a session, or dispatches queued work, so a fire cannot bill
    // a model turn.
    why: 'Freezes idle desktop sessions and reaps expired leases — process + DB only',
  },
  // EI-19294826146331487: the ARM-STATE row class (`tier='in-process'`). These rows are dispatched
  // by nobody — they carry the on/off state of a sweep declared in code — so the honest spend is
  // 'none'. Declaring it here also keeps them out of the 'unknown' bucket, which is what a row with
  // no entry falls into and what the pane surfaces as needing attention.
  [IN_PROCESS_SWEEP_TARGET_ROLE]: {
    spend: 'none',
    why: 'An on/off record for a sweep declared in code — it is fired by nothing, so it cannot spend',
  },
  'system:session-dir-gc': { spend: 'none', why: 'Deletes isolation dirs of ended sessions' },
  'system:telemetry-retention': { spend: 'none', why: 'Applies telemetry retention windows' },
  'system:idle-session-reaper': { spend: 'none', why: 'Reaps idle session rows' },
  'system:idle-backend-reaper': {
    spend: 'none',
    why: 'Polls /slots and stops idle on-demand local inference backends — no LLM calls',
  },
  'system:hetzner-orphan-frame-reaper': { spend: 'none', why: 'Reaps orphaned remote frames' },
  'system:test-webview-reaper': { spend: 'none', why: 'Reaps leaked test webviews' },
  'system:orphaned-mcp-reaper': { spend: 'none', why: 'Reaps leaked agent-spawned playwright-mcp server processes' },
  'system:precompute-derived-reads': { spend: 'none', why: 'Refreshes derived read tables' },
  'system:sql-read-census': {
    spend: 'none',
    why: 'Measures raw SQL reads and records threshold crossings — deterministic SQL/FS work, no model call',
  },
  'system:interactive-usage-ingest': { spend: 'none', why: 'Tails local transcripts into usage samples (SQL/FS only)' },
  'system:task-reconcile': {
    spend: 'none',
    why: 'REPORT-ONLY kernel-vs-ledger reconcile — no kill/freeze path exists',
  },
  'system:token-weekly-report': { spend: 'none', why: 'Aggregates usage into a report (SQL/FS only)' },
  'system:unclaimed-work-digest': { spend: 'none', why: 'Read-only: lists unclaimed items and posts a digest' },
  'system:improvement-human-digest': { spend: 'none', why: 'Ranks the human queue and sends it — no model' },
  'system:improvement-triage': { spend: 'none', why: 'Records routing metadata; explicitly never dispatches' },
  'system:improvement-watchdog': { spend: 'none', why: 'SQL pass that files work items' },
  'system:improvement-invalid-args-miner': { spend: 'none', why: 'Mines tool_invocations for invalid args (SQL)' },
  'system:improvement-tool-rejection-scorecard': {
    spend: 'none',
    why: 'Per-verb schema-rejection rate over tool_invocations (SQL); files work items',
  },
  'system:improvement-correction-decay': {
    spend: 'none',
    why: 'Per-rule auto-correction decay read from tool_invocations.args_json (SQL) plus a jsonb snapshot write to its own routine metadata; files work items via captureImprovement — no spawn/dispatch/wake',
  },
  'system:claim-integrity-sweep': { spend: 'none', why: 'Checks claim invariants in SQL' },
  'system:claim-discipline-watch': { spend: 'none', why: 'Injects a nudge into an existing turn — never wakes' },
  'system:coord-invariant-monitor': { spend: 'none', why: 'Checks coord substrate invariants in SQL' },
  'system:coord-probe-canary': { spend: 'none', why: 'Runs a verb-cycle probe pair' },
  'system:plan-item-orphan-reconcile': { spend: 'none', why: 'Reconciles orphaned plan items' },
  'system:plan-item-reflect-orphan-reconcile': {
    spend: 'none',
    why: 'SQL sweep + plans:set-status flips — the reflect-direction mirror of plan-item-orphan-reconcile; no spawn/dispatch/wake',
  },
  'system:supervision-reconcile': { spend: 'none', why: 'Reconciles supervision rows' },
  'system:frozen-candidate-drift-sweep': {
    spend: 'none',
    why: 'One bounded `git log` over the frozen candidate..staging range plus a report-only captureImprovement — no spawn/dispatch/wake. Filing a finding can lead a HUMAN or a later triage routine to act, but nothing this fire does bills a turn directly, matching worker-breaker-watch (which even broadcasts on coord) being none',
  },
  'system:completion-claim-recheck': {
    spend: 'none',
    why: 'Re-evaluates already-declared completion claims against the working tree (fs read + TypeScript AST parse, no type resolution and no build), stamps each row and files findings via captureImprovement — no spawn/dispatch/wake. Matches dead-citation-sweep: a filed finding can lead a HUMAN or a later triage lane to act, but nothing this fire does bills a turn directly',
  },
  'system:dead-citation-sweep': {
    spend: 'none',
    why: 'Doc/metadata citation-drift scan filing findings via captureImprovement — no spawn/dispatch/wake',
  },
  'system:launch-cost-ceiling': {
    spend: 'none',
    why: 'Bounded transcript scan measuring agent launch cost against a ceiling/regression threshold; on a crossing it records a fires-ledger row with wakeAt:null and opens an ADVISORY escalation — no spawn/dispatch/wake. Same shape as frozen-candidate-drift-sweep: the alert can lead a HUMAN or a later lane to act, but nothing this fire does bills a turn directly',
  },
  'system:durable-escalation-orphan-sweep': {
    spend: 'none',
    why: 'One bounded read of harness_shared.engineer_issues plus arithmetic over each emitter\'s own close-time distribution, filing findings via captureImprovement — no spawn/dispatch/wake. Matches dead-citation-sweep: a filed finding can lead a HUMAN or a later triage lane to act, but nothing this fire does bills a turn directly',
  },
  'system:legacy-needs-human-reconcile': {
    spend: 'none',
    why: 'One bounded payload-only reconciliation of retired needsHuman markers against live work-item lifecycle and typed blocker state — no spawn/dispatch/wake',
  },
  'system:episode-scoped-operational-reconcile': {
    spend: 'none',
    why: 'One bounded read of episode-scoped operational rows plus a single gate-verdict read (gitPipelineSnapshot), closing matches via setIssueState — no spawn/dispatch/wake',
  },
  'system:inbox-bulk-resolve': {
    spend: 'llm',
    why: 'Starts the supervised Inbox resolver agent, which can bill model turns',
  },
  'system:intake-triage-drain': {
    spend: 'llm',
    why: 'Starts the supervised intake-triage resolver agent over awaiting observations/candidates, which can bill model turns',
  },
  'system:plan-cleanup-sweep': {
    spend: 'llm',
    why: 'Runs the deterministic plan clean-up pass, then starts the supervised cleanup resolver agent when judgment residue remains, which can bill model turns',
  },
  'system:consult-expiry-sweep': {
    spend: 'llm',
    why: 'Expiry emit wakes a hard-blocked parked requester (latched consult:reply key), and a wake bills a turn',
  },
  'system:connected-app-alert-sweep': {
    spend: 'none',
    why: 'One bounded read of connected-app keys, their activity counts and auth-failure counters, then owner-attention notifications (push/desktop/audit row) — no spawn/dispatch/wake',
  },
  'system:worker-breaker-watch': {
    spend: 'none',
    why: 'HTTP GET of the embed sidecar /healthz + a coord broadcast on a tripped breaker — no spawn/dispatch/wake',
  },
  'system:account-capacity-reprobe': {
    spend: 'none',
    why: 'One minimal upstream request per already-walled account (a header read) plus a DB projection write and gateway readmit — no spawn/dispatch/wake',
  },
  'system:hosted-lifecycle-reconcile': {
    spend: 'none',
    why: 'One bounded SELECT of the workspace’s queued/running workspace_host_operations plus recovery_state UPDATEs and a deduped intervention notice — no spawn/dispatch/wake. A notice can lead a HUMAN to act, but nothing this fire does bills a turn directly (same reading as worker-breaker-watch, which even broadcasts on coord, being none)',
  },
  'system:hosted-public-ingress-probe': {
    spend: 'none',
    why: 'A read of the tunnel config plus ~36 unauthenticated GETs against the public hosted origin; a finding throws into the routine’s own last_error — no spawn/dispatch/wake',
  },
  'system:readiness-drift-monitor': {
    spend: 'none',
    why: 'Reconciles the work_item_blocked readiness sidecar against its SQL oracle and repairs drift',
  },
  'system:fleet-headcount-governor': {
    spend: 'llm',
    why: 'Spawns replacement fleet members through the headless or visible launch seam',
  },
  'system:autonomy-trust-scan': { spend: 'none', why: 'Scores autonomy trust from recorded dispositions' },
  'system:hive-canary-sla': { spend: 'none', why: 'Checks yesterday’s canaries against their deadline' },
  'system:cross-hive-outbox-drain': { spend: 'none', why: 'Drains durable cross-hive outboxes' },
  'system:p2p-foreign-supervision': { spend: 'none', why: 'Supervises foreign harness rows' },
  'system:sweep-orphaned-foreign-harnesses': { spend: 'none', why: 'Sweeps orphaned foreign harnesses' },
  'system:p2p-perf-tier1': { spend: 'none', why: 'Nightly p2p bench' },
  'system:p2p-perf-tier2': { spend: 'none', why: 'Weekly p2p bench' },
  'system:wake-brain': { spend: 'none', why: 'Retired tombstone — the handler is a no-op' },
  'system:oddsmith-paper-cycle': {
    spend: 'none',
    why: 'Runs a bounded PAPER-mode market-making cycle script (npm run paper-cycle); no agent or model call',
  },
  'system:oddsmith-error-triage-ingest': {
    spend: 'none',
    why: 'Runs the deterministic error-triage ingest CLI; no agent or model call',
  },
  'system:oddsmith-error-triage-autofix': {
    spend: 'llm',
    why: 'Launches a hardened headless Claude agent to fix open error classes when any exist',
  },
};

/**
 * Spend for a `target_role`, or `unknown` when the role is not in the table.
 *
 * `unknown` is deliberately a THIRD value rather than a default to `none`. A new
 * system action nobody classified must not be able to present itself as free — the
 * pane surfaces `unknown` as its own state, and the registry cross-check test turns
 * it into a build failure.
 */
export function spendForTargetRole(
  targetRole: string | null | undefined,
  payloadTemplate?: Readonly<Record<string, unknown>> | null,
): RoutineSpend | 'unknown' {
  if (!targetRole) return 'unknown';
  if (targetRole === 'system:blueprint-run') {
    const blueprintId = payloadTemplate?.blueprintId;
    if (typeof blueprintId === 'string' && blueprintId.trim()) {
      const declared = BLUEPRINT_SPEND[blueprintId.trim()];
      if (declared) return declared.spend;
    }
  }
  return TARGET_ROLE_SPEND[targetRole]?.spend ?? 'unknown';
}

/** The one-line reason behind a row's spend classification (the row tooltip). */
export function spendReasonForTargetRole(
  targetRole: string | null | undefined,
  payloadTemplate?: Readonly<Record<string, unknown>> | null,
): string | null {
  if (!targetRole) return null;
  if (targetRole === 'system:blueprint-run') {
    const blueprintId = payloadTemplate?.blueprintId;
    if (typeof blueprintId === 'string' && blueprintId.trim()) {
      const declared = BLUEPRINT_SPEND[blueprintId.trim()];
      if (declared) return `${declared.why} (blueprint '${blueprintId.trim()}')`;
    }
  }
  return TARGET_ROLE_SPEND[targetRole]?.why ?? null;
}

/** Loop routines are named `loop-<ownerId>` (loop.ts loopRoutineName). */
export function isLoopRoutine(name: string): boolean {
  return /^loop-/i.test(name);
}

export interface RoutineKindInput {
  name: string;
  /** True when the row came from SYNC_TRIGGERED_SWEEPS (fires on an event, not a clock). */
  syncTriggered?: boolean;
}

export function routineKind({ name, syncTriggered }: RoutineKindInput): RoutineKind {
  if (isLoopRoutine(name)) return 'loop';
  if (syncTriggered) return 'triggered';
  return 'scheduled';
}

export interface RoutineLivenessInput {
  active: boolean;
  /** ISO next fire, or null. Postgres `infinity` arrives here as null (the catalog's iso() drops non-finite dates) — which is precisely the armed-but-never-firing case. */
  nextFireAt: string | null;
  /**
   * Does a clock drive this row? A `triggered` row has no next fire BY DESIGN and
   * must never read as stalled; a cron row or a loop with no next fire is broken.
   */
  clockDriven: boolean;
  /** Injected for tests. */
  now?: number;
}

/**
 * How overdue a clock-driven row may be before it reads as stalled. One hour is
 * long enough that a slow tick or a coalesced restart never trips it, and short
 * enough that a genuinely wedged sweep surfaces the same day.
 */
export const STALLED_OVERDUE_MS = 60 * 60 * 1000;

/**
 * Can this row's staleness be judged at all?
 *
 * Only a row whose SOURCE can report a next fire may ever read `stalled`. The two
 * sources differ, and conflating them is a real, shipped bug (P-008):
 *
 *   • `routines` rows are backed by a scheduler that writes `next_fire_at`, so a
 *     cron (or a loop's reschedule interval) with no next fire is genuinely broken.
 *   • Every OTHER source — DBOS workflows, managed timers, in-process sweeps,
 *     external-process timers — reports a human CADENCE ("every 30s") while usually
 *     having no next fire to report, because there is no scheduler row to read one
 *     from. Judging those by cadence marked 17 perfectly healthy System sweeps as
 *     needing the owner's attention the first time the pane was opened for real.
 *
 * So: cadence is NOT evidence of a readable clock. Only a next fire is.
 */
export function isClockDriven(input: {
  source: 'routines' | 'other';
  kind: RoutineKind;
  cron?: string | null;
  rescheduleIntervalSec?: number | null;
  nextFireAt?: string | null;
  /** The routines row's execution tier, when the caller has it. */
  tier?: string | null;
}): boolean {
  if (input.kind === 'triggered') return false;
  // An ARM-STATE row (`tier='in-process'`, EI-19294826146331487) is not a schedule: no executor
  // reads it, so it has no next_fire_at and never will. Its `reschedule_interval_sec` is the
  // SWEEP's cadence carried for display, not a promise that this ROW fires — and reading it as a
  // clock would make all 17 sweeps report `stalled` / needs-attention forever, which is the exact
  // false alarm P-008 was fixed to stop. The sweep's real liveness comes from the inventory row it
  // collapses with.
  if (input.tier === 'in-process') return false;
  if (input.source === 'routines') {
    return Boolean(input.cron) || input.rescheduleIntervalSec != null;
  }
  return Boolean(input.nextFireAt);
}

export function routineLiveness({
  active,
  nextFireAt,
  clockDriven,
  now = Date.now(),
}: RoutineLivenessInput): RoutineLiveness {
  if (!active) return 'dormant';
  if (!clockDriven) return 'running';
  if (!nextFireAt) return 'stalled';
  const next = Date.parse(nextFireAt);
  if (!Number.isFinite(next)) return 'stalled';
  return next < now - STALLED_OVERDUE_MS ? 'stalled' : 'running';
}

/**
 * Does this row want the owner's attention?
 *
 * Deliberately NARROW. A stalled row is objectively broken, and a flag-gated row
 * that is off is a switch the owner alone can throw. Mass-paused families
 * (`hive-wake`, paused across 16 pots since June) are NOT included: nothing in the
 * row distinguishes "deliberately retired" from "accidentally off", and a false
 * "needs you" costs more trust than a missed one. They stay in Dormant with their
 * count visible.
 */
export function routineNeedsAttention(input: {
  liveness: RoutineLiveness;
  armedState: RoutineArmedState;
  control: RoutineControl;
  active: boolean;
  spend: RoutineSpend | 'unknown';
}): boolean {
  if (input.liveness === 'stalled') return true;
  // An unverifiable armed state must not present as a healthy schedule. External
  // rows use `active = armed !== false`, so without this check `armed: null`
  // becomes a running, attention-free row despite never having been verified.
  if (input.armedState === 'unknown') return true;
  if (input.control === 'flag' && !input.active) return true;
  // An unclassified handler only matters if it can actually fire — an ACTIVE row
  // dispatching to an action nobody registered is a silent no-op the owner should
  // see (EI-18741229858124453). An inactive one is just dormant.
  if (input.spend === 'unknown' && input.active) return true;
  return false;
}

const DOCS_FAMILY = /doc|^knowledge-pack-/i;
const WAKE_FAMILY = /(^|-)wake($|-)/i;
const LEARNING_FAMILY =
  /^improvement-|^bp-singleton-|^gym|^template-gym$|^pot-eval-battery$|^scout|^dream|prospector|^oddsmith-|^scan$/i;
const GIT_RELEASE_FAMILY = /git-sync|checkpoint|release|deploy|^pr-poll$|^cargo-test$|^gate-|^sync-batch-delta-check$/i;
const CLEANUP_FAMILY = /gc$|^gc-|reaper|retention|precompute|^knowledge-pack-/i;
const FEDERATION_FAMILY = /^p2p-|hive|foreign|outbox|federation/i;

/**
 * Subject grouping for the browse-by-family view. Order matters: docs and wake are
 * checked before learning so `doc-steward` and `hive-wake` land where the owner
 * looks for them rather than where their group_slug files them — the same
 * name-before-group rule the old classifyRoutine() used, and for the same reason.
 */
export function routineFamily(name: string, kind: RoutineKind): RoutineFamily {
  if (kind === 'loop') return 'loops';
  if (WAKE_FAMILY.test(name)) return 'wake';
  if (DOCS_FAMILY.test(name)) return 'docs';
  if (LEARNING_FAMILY.test(name)) return 'learning';
  if (GIT_RELEASE_FAMILY.test(name)) return 'git-release';
  if (CLEANUP_FAMILY.test(name)) return 'cleanup';
  if (FEDERATION_FAMILY.test(name)) return 'federation';
  return 'health';
}

/** Display label for a family header. */
export const FAMILY_LABEL: Readonly<Record<RoutineFamily, string>> = {
  loops: 'Loops',
  wake: 'Wake',
  learning: 'Learning',
  docs: 'Docs',
  'git-release': 'Git & release',
  cleanup: 'Cleanup',
  health: 'Health',
  federation: 'Federation',
};

/** Families that belong to the LLM (Agents) pane, in display order. */
export const AGENT_FAMILY_ORDER: readonly RoutineFamily[] = ['loops', 'wake', 'learning', 'docs'];

/** Families that belong to the deterministic (System) pane, in display order. */
export const SYSTEM_FAMILY_ORDER: readonly RoutineFamily[] = ['git-release', 'cleanup', 'health', 'federation'];
