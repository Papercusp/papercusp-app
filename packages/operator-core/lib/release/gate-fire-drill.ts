/**
 * Gate fire drill — P-016 of gate-verdict-liveness-and-repair-reliability-2026-08-31.
 *
 * Periodically KILLS a checkpoint run on purpose and asserts the P-003 verdict-liveness
 * detection chain observed it: the fire left its P-001 anchor row (`green_checkpoint_fire`),
 * no verdict-bearing row followed, and the REAL `evaluateVerdictRateAlarm` — fed the REAL
 * ledger window — alarms on that evidence. The 74.2h verdict blackout (plan D-001 loss
 * class 2) was undetected precisely because nothing ever exercised the alarm path; this
 * routine is the standing proof that a killed run is still *visible* to the pager.
 *
 * WHY THE DRILL LAUNCHES ITS OWN RUN: killing the next SCHEDULED run would sabotage a
 * real judging fire (and during a red streak, worsen the exact verdict starvation this
 * plan treats). The drill instead launches a fresh recording run via the normal detached
 * launcher — whose accepted-launch anchor write is exactly the P-001 row the alarm counts
 * — and kills it seconds later, so the suite cost is seconds, not a 55-min slot.
 *
 * WHY `gateRed: true` IS PASSED COUNTERFACTUALLY: both limbs of
 * `evaluateVerdictRateAlarm` deliberately gate on a red gate (P-003's contract — the rate
 * alarm pages *while red*). The drill only runs on a GREEN, idle gate (see skips below),
 * so it asserts the alarm's *detection* — "given a red gate, this window alarms" — by
 * evaluating the real function against the real window with the one counterfactual input.
 * The outcome row records that the input was counterfactual.
 *
 * SKIP, NEVER FIGHT: the drill refuses to run while the gate is red (a drill kill during
 * an incident destroys a legitimate verdict attempt), while a run is in flight (the
 * launcher would refuse anyway — but refusing here keeps the ledger clean of drill noise),
 * while a qualification hold is placed, or under host load. Every skip is recorded.
 *
 * Pure by construction (the P-012 sync-batch-delta-check discipline): every IO is a dep,
 * every decision is in here and unit-tested in both directions.
 */
import type { VerdictRateAlarmInputs, VerdictRateAlarmVerdict, VerdictRateWindow } from './gate-verdict-rate-alarm';

/** How long the drill waits for the launched unit to be observably up before killing. */
export const DRILL_RUN_UP_BUDGET_MS = 30_000;
/** Grace after the kill for the unit to actually exit before the ledger assertions run. */
export const DRILL_POST_KILL_GRACE_MS = 10_000;
/** Slack subtracted from the drill-start stamp when bounding the ledger window read, so a
 *  clock skew between this process and Postgres `now()` cannot exclude the drill's own
 *  anchor row from the asserted window. */
export const DRILL_WINDOW_SLACK_MS = 60_000;

export interface GateFireDrillState {
  /** consecutiveReds > 0 (or last verdict not green). Drill refuses on a red gate. */
  gateRed: boolean;
  consecutiveReds: number;
  /** A checkpoint run (scheduled or manual) is currently in flight. */
  runInFlight: boolean;
  /** A qualification or manual-run hold is placed (or admission read `unknown`). */
  held: boolean;
  /** Host load acceptable for spending a launch+kill cycle. */
  loadOk: boolean;
}

export interface DrillOutcome {
  status: 'pass' | 'fail' | 'skipped';
  /** Machine-stable reason token; the detail sentence carries the specifics. */
  reason:
    | 'drill-pass'
    | 'skip-gate-red'
    | 'skip-run-in-flight'
    | 'skip-held'
    | 'skip-load'
    | 'launch-refused'
    | 'run-never-up'
    | 'kill-failed'
    | 'anchor-missing'
    | 'unexpected-verdict'
    | 'alarm-did-not-fire'
    | 'gate-health-poisoned';
  detail: string;
  /** The evaluator verdict, when the drill got far enough to evaluate. */
  alarm?: VerdictRateAlarmVerdict;
  /** The asserted window, when read. */
  window?: VerdictRateWindow;
  /** True on every recorded outcome: the evaluator's gateRed input was counterfactual. */
  counterfactualGateRed: true;
  unit?: string;
  startedAtMs: number;
  finishedAtMs: number;
}

export interface GateFireDrillDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  readGateState(): Promise<GateFireDrillState>;
  /** Launch a fresh RECORDING checkpoint run (default verdict target — a `target: null`
   *  run writes no P-001 anchor, which would blind the very assertion this drill makes). */
  launchDrillRun(): Promise<{ launched: boolean; unit: string; reason?: string }>;
  /** Poll until the launched unit is observably up (process alive / unit active). */
  waitForRunUp(unit: string, budgetMs: number): Promise<boolean>;
  /** Stop the unit (systemctl --user stop <unit>); resolve true when it is gone. */
  killRun(unit: string): Promise<boolean>;
  /** The REAL readVerdictRateWindow, bounded to the supplied window. */
  readWindow(windowMs: number): Promise<VerdictRateWindow>;
  /** The REAL evaluateVerdictRateAlarm. */
  evaluate(i: VerdictRateAlarmInputs): VerdictRateAlarmVerdict;
  suiteBudgetMs(): number;
  /** Durable outcome row (pipeline_events kind='gate_fire_drill') — the drill's own trace,
   *  so an out-of-band `systemctl stop` in the journal is attributable to the drill. */
  recordOutcome(o: DrillOutcome): Promise<void>;
  /** Page loudly: the drill FAILED, i.e. a killed run is invisible to the alarm path.
   *  This is a detector regression — the exact blindness P-003 exists to remove. */
  alarmDetectorFailure(o: DrillOutcome): Promise<void>;
}

function outcome(
  startedAtMs: number,
  now: number,
  status: DrillOutcome['status'],
  reason: DrillOutcome['reason'],
  detail: string,
  extra: Partial<Pick<DrillOutcome, 'alarm' | 'window' | 'unit'>> = {},
): DrillOutcome {
  return { status, reason, detail, counterfactualGateRed: true, startedAtMs, finishedAtMs: now, ...extra };
}

/** Run one drill tick. Always records exactly one outcome row; pages only on 'fail'. */
export async function runGateFireDrill(deps: GateFireDrillDeps): Promise<DrillOutcome> {
  const startedAtMs = deps.now();
  const finish = async (o: DrillOutcome): Promise<DrillOutcome> => {
    await deps.recordOutcome(o);
    if (o.status === 'fail') await deps.alarmDetectorFailure(o);
    return o;
  };

  const state = await deps.readGateState();
  if (state.gateRed) {
    return finish(
      outcome(
        startedAtMs,
        deps.now(),
        'skipped',
        'skip-gate-red',
        `gate is red (consecutiveReds=${state.consecutiveReds}) — a drill kill during an incident destroys a legitimate verdict attempt; drilling only on a green gate`,
      ),
    );
  }
  if (state.runInFlight) {
    return finish(
      outcome(startedAtMs, deps.now(), 'skipped', 'skip-run-in-flight', 'a checkpoint run is in flight — never fight the gate'),
    );
  }
  if (state.held) {
    return finish(
      outcome(startedAtMs, deps.now(), 'skipped', 'skip-held', 'a qualification/manual-run hold is placed (or admission unknown) — the gate is deliberately quiesced'),
    );
  }
  if (!state.loadOk) {
    return finish(outcome(startedAtMs, deps.now(), 'skipped', 'skip-load', 'host load too high to spend a launch+kill cycle'));
  }

  const preReds = state.consecutiveReds;

  const launch = await deps.launchDrillRun();
  if (!launch.launched) {
    // A refused launch (collision, memory admission, …) is a skip, not a failure: the
    // refusal reasons are the launcher's own guards working, and nothing was spent.
    return finish(
      outcome(startedAtMs, deps.now(), 'skipped', 'launch-refused', `launcher refused: ${launch.reason ?? 'unknown'}`, {
        unit: launch.unit,
      }),
    );
  }

  const up = await deps.waitForRunUp(launch.unit, DRILL_RUN_UP_BUDGET_MS);
  if (!up) {
    // The launch was ACCEPTED (its P-001 anchor is written per accepted launch), but the
    // unit never became observable. That is itself a liveness defect worth failing on:
    // an accepted fire that never runs is exactly the unaccounted class P-001 counts.
    return finish(
      outcome(
        startedAtMs,
        deps.now(),
        'fail',
        'run-never-up',
        `accepted launch never became an observable unit within ${DRILL_RUN_UP_BUDGET_MS}ms — accepted-but-never-ran is the unaccounted fire class`,
        { unit: launch.unit },
      ),
    );
  }

  const killed = await deps.killRun(launch.unit);
  if (!killed) {
    // The run survives as an ordinary recording run (harmless — one bonus verdict), but
    // the drill's kill lever is broken and future drills are no-ops: page it.
    return finish(
      outcome(startedAtMs, deps.now(), 'fail', 'kill-failed', 'unit did not stop on systemctl stop — drill kill lever broken; the run continues as a normal recording run', {
        unit: launch.unit,
      }),
    );
  }

  await deps.sleep(DRILL_POST_KILL_GRACE_MS);

  // Bound the asserted window to the drill itself (plus skew slack): on a quiet gate it
  // contains exactly this drill's fire, so the assertions are about OUR killed run, not
  // ambient history. The run-lock the drill run held prevents a concurrent verdict row.
  const windowMs = deps.now() - startedAtMs + DRILL_WINDOW_SLACK_MS;
  const window = await deps.readWindow(windowMs);

  if (window.fires < 1) {
    return finish(
      outcome(
        startedAtMs,
        deps.now(),
        'fail',
        'anchor-missing',
        `no green_checkpoint_fire anchor row inside the ${Math.round(windowMs / 1000)}s drill window — the accepted launch's P-001 anchor write is broken, so killed runs are invisible to the rate alarm`,
        { unit: launch.unit, window },
      ),
    );
  }
  if (window.verdicts > 0) {
    return finish(
      outcome(
        startedAtMs,
        deps.now(),
        'fail',
        'unexpected-verdict',
        `a verdict-bearing row landed inside the drill window (verdicts=${window.verdicts}) — either the kill did not take effect or a concurrent run slipped past the in-flight guard; assertions are not about the killed run`,
        { unit: launch.unit, window },
      ),
    );
  }

  const alarm = deps.evaluate({
    nowMs: deps.now(),
    gateRed: true, // counterfactual on purpose — see module header
    window,
    suiteBudgetMs: deps.suiteBudgetMs(),
    minFires: 1, // one deliberate kill IS the rate for this drill-scoped window
    windowMs,
  });
  if (!alarm.alarmed) {
    return finish(
      outcome(
        startedAtMs,
        deps.now(),
        'fail',
        'alarm-did-not-fire',
        'evaluateVerdictRateAlarm did NOT alarm on a window containing a killed fire and zero verdicts — the P-003 detection chain is blind to killed runs',
        { unit: launch.unit, window, alarm },
      ),
    );
  }

  const post = await deps.readGateState();
  if (post.consecutiveReds !== preReds) {
    return finish(
      outcome(
        startedAtMs,
        deps.now(),
        'fail',
        'gate-health-poisoned',
        `consecutiveReds moved ${preReds} -> ${post.consecutiveReds} across the drill — a killed (no-verdict) run must never count as a red (P-002 taxonomy)`,
        { unit: launch.unit, window, alarm },
      ),
    );
  }

  return finish(
    outcome(
      startedAtMs,
      deps.now(),
      'pass',
      'drill-pass',
      `killed run ${launch.unit} was fully visible: anchor counted (fires=${window.fires}), no verdict leaked, rate alarm fired (${alarm.reason}), gate health untouched`,
      { unit: launch.unit, window, alarm },
    ),
  );
}
