/**
 * Desktop-perf release gate (desktop-performance-suite-2026-07-20 P-011).
 *
 * The DESKTOP-UI sibling of perf-gate.ts. A PURE policy layer that turns the
 * latest persisted desktop-perf run (harness_shared.desktop_perf_runs, P-010)
 * into a green-checkpoint action: `pass`, `warn` (surface it, still advance the
 * green pin), or `block` (hold the deploy).
 *
 * Two load-bearing rules, mirrored from perf-gate.ts:
 *   - THE SAMPLE IS GATED, NOT THE VERDICT. A budgeted breach `block`s only when
 *     the gate can prove the run was measured inside a QUIET WINDOW; a breach
 *     measured under host contention is `unmeasurable` and only `warn`s. See
 *     "quiet-gated blocking" below.
 *   - FLAG-GATED + FAIL-SOFT. This is the P-011 improvement over perf-gate.ts's
 *     env gate: the enable switch is a FLAGS entry (FLAGS.DESKTOP_PERF_GATE, a
 *     server getFlag read), NOT a process.env boolean. Disabled ⇒ a no-op `pass`
 *     that reads nothing; a missing / empty run (verdict `unknown`) never blocks.
 *
 * QUIET-GATED BLOCKING (resource-efficiency-closeout-2026-08-13 D-005; read D-003
 * and D-004 for the history). V1 shipped "warn-not-block until trusted" with
 * `block` hardwired false, and by 2026-08-16 that had produced 13 days of silent
 * fail-soft passes — an inert gate. The obvious repair, flipping block to an
 * unconditional true, was refused twice for a measured reason: desktop LCP spanned
 * 2143–5742ms on IDENTICAL code with the 4000ms budget inside that band, so an
 * unconditional block would have swapped a silent gate for a loud FALSE-RED one
 * that freezes the fleet whenever the box is busy.
 *
 * What broke the deadlock was finding the missing variable rather than retuning the
 * budget. Under a PSI-quiet window the same measurement is tight and reproducible
 * (2527–2803ms, ~10% spread): it was never inherently noisy, contention simply was
 * never controlled. So the gate now reads the `host:psi-cpu-*` stamps every run
 * records and treats a run taken outside that window as UNMEASURABLE — neither
 * pass nor fail — arming `block` only for a breach it can attribute to a quiet
 * host. That is what makes this an EFFECTIVE gate rather than an inert or a
 * false-red one, and it is the same void-sample principle applied twice already in
 * this lane (the egress spec records -1 rather than a meaningless 0;
 * plan-popup-open throws `UNMEASURABLE:` rather than publishing a timing for a
 * plan that never opened). A gate that cannot tell "measured and fine" from "never
 * measured" is the whole defect class here.
 *
 * ONE EXCEPTION, added by no-http-anywhere-2026-07-28 P-003c: a measure flagged
 * `invariant: true` BLOCKS regardless of block-mode. Warn-until-trusted is the
 * right posture for a hand-tuned, load-sensitive timing budget; it is the wrong
 * posture for a binary correctness property that cannot produce a false red. The
 * first such invariant is `invariant:webview-http-egress` — D-005 rules that any
 * HTTP escape from the desktop webview is a loud failure, and it had already
 * broken three times undetected while the rule existed only in prose.
 *
 * Like perf-gate.ts, the green-checkpoint CALL SITE lives in green-checkpoint.ts
 * (CheckpointDeps.desktopPerfGate + realCheckpointDeps), not here — this file is
 * the buildable, framework-agnostic substrate.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { DESKTOP_PERF_BINARY_BUILT_AT_KEY } from '@papercusp/operator-core/lib/admin-test-suites-shared';
import {
  DESKTOP_PERF_BUDGETS,
  type DesktopPerfBudgets,
} from '@papercusp/operator-core/lib/system-health/desktop-perf-budgets';
import {
  readDesktopPerfRuns,
  type DesktopPerfRun,
  type DesktopPerfMeasure,
} from '@papercusp/operator-core/lib/system-health/desktop-perf-runs';

/** What the gate tells the green-checkpoint to do with a candidate. */
export type DesktopPerfGateAction = 'pass' | 'warn' | 'block';
export type DesktopPerfVerdictStatus = 'ok' | 'warn' | 'crit' | 'unknown';

/**
 * How the host was loaded while the run was measured — the D-005 sample gate.
 *
 *   `quiet`      both stamps sit inside the quiet window ⇒ a load-controlled
 *                measurement, and the only kind a breach may block on.
 *   `contended`  at least one stamp is above the window ⇒ UNMEASURABLE. A timing
 *                taken under contention is not comparable to the budget, which
 *                was calibrated on a quiet box.
 *   `unstamped`  the run carries no PSI stamp at all — an old row (every run
 *                before 2026-08-16), a non-Linux producer, or a kernel built
 *                without PSI. Treated exactly like `contended`: the gate cannot
 *                SHOW the window was quiet, and "no evidence of quiet" must not
 *                be read as "quiet". This is the same absence-vs-zero distinction
 *                that made 13 days of fail-soft passes look like green ones.
 */
export type DesktopPerfPressureClass = 'quiet' | 'contended' | 'unstamped';

export interface QuietWindowThresholds {
  /** Max `/proc/pressure/cpu` `some avg10` (percent of the last 10s in which at
   *  least one task was stalled waiting for CPU). */
  someAvg10Max: number;
  /** Max `full avg10` — time when EVERY task was stalled. Separate because a
   *  non-zero `full` is a categorically worse condition than a non-zero `some`. */
  fullAvg10Max: number;
}

/** The PSI stamp keys `recordHostPressure` writes (tools/perf-test/wdio/perf-report.ts).
 *  The unit lives in the KEY deliberately: adding a value to the `unit` enum is a
 *  cross-deploy breaking change, because the ingest route rejects the WHOLE batch on
 *  one unknown unit and the runner posts to the release checkout, not the working tree. */
export const PSI_SOME_KEY_PREFIX = 'host:psi-cpu-some-avg10-pct:';
export const PSI_FULL_KEY_PREFIX = 'host:psi-cpu-full-avg10-pct:';

/**
 * The quiet window: `some avg10 ≤ 1.0` (percent), `full avg10 = 0`.
 *
 * DERIVED FROM MEASUREMENT, not picked. D-005 required the threshold to come from
 * a larger PSI-stamped sample than the 3 runs that justified the design, so 14
 * further smoke runs were taken back-to-back on this box (2026-08-16T02:08–02:15Z)
 * while ambient fleet load varied on its own. n=15, each stamped at start AND end;
 * the run's pressure is taken as the WORSE of the two. Binning by candidate
 * threshold:
 *
 *   T      quiet n   LCP range (ms)   spread        headroom to the 4000ms budget
 *   0.1        6     2206–2721        515 (20%)     1279ms (47% above worst quiet)
 *   0.5        8     2206–2765        559 (21%)     1235ms (45%)
 *   1.0        9     2206–2817        611 (23%)     1183ms (42%)
 *   1.5       10     2206–2916        710 (27%)     1084ms (37%)
 *   2.0       13     2206–3085        879 (33%)      915ms (30%)
 *
 * 1.0 is the knee: it admits 9 of 15 runs while holding the band at 611ms, and
 * every reading above 2817ms in the whole sample falls OUTSIDE it. Loosening to
 * 1.5 and 2.0 buys one and four more runs for a spread that grows faster than the
 * sample does. D-005's independent 3-run band (2527–2803ms at PSI 0.00–0.08) lands
 * inside this one, which is corroboration from a separate session rather than a
 * restatement.
 *
 * WHY THIS MAKES BLOCKING SAFE, which is the whole point: inside the window the
 * worst observed LCP is 2817ms against a 4000ms budget — 42% of headroom. A breach
 * measured inside the window is therefore a ~40%+ move, far outside the 611ms the
 * measurement itself varies by. That is the gap D-003 correctly refused to arm
 * across when it did not exist (the budget then sat INSIDE a 2143–5742ms band).
 *
 * WHY NOT LOADAVG (D-004): it read 56.92 here while PSI reported `some avg10=0.05`
 * — no stall pressure at all. loadavg is a trailing EWMA of runnable tasks, so it
 * describes a decaying past rather than the interval the run occupied. It is still
 * stamped, for contrast only, under `host:loadavg1-not-authoritative:*`.
 *
 * WHY `full` MUST BE 0: a non-zero `full` means every task on the box was stalled
 * at once, which cannot coexist with a trustworthy interaction timing. It was 0.00
 * on all 15 samples, so this bound is not yet exercised by data — it is a floor
 * against a condition that would obviously invalidate a measurement, not a fitted
 * parameter.
 *
 * ERRING DIRECTION. Too TIGHT a window makes nearly every run `unmeasurable`,
 * which silently re-creates the inert gate P-004 exists to fix; too loose admits a
 * contended sample whose reading is untrustworthy in EITHER direction (see the
 * pass branch of {@link evaluateDesktopPerfGate}). Both errors are real, so the
 * threshold is set where the data separates rather than at whichever end feels
 * safer.
 */
export const DEFAULT_QUIET_WINDOW: QuietWindowThresholds = { someAvg10Max: 1.0, fullAvg10Max: 0 };

/** The PSI stamps a run carries, or null for whichever phase is missing. */
export interface DesktopPerfHostPressure {
  someStart: number | null;
  someEnd: number | null;
  fullStart: number | null;
  fullEnd: number | null;
}

function stampValue(run: DesktopPerfRun, key: string): number | null {
  const hit = run.measures.find((m) => m.key === key);
  return hit && Number.isFinite(hit.value) ? hit.value : null;
}

/** PURE: read the `host:psi-cpu-*` stamps off a run. */
export function readHostPressure(run: DesktopPerfRun): DesktopPerfHostPressure {
  return {
    someStart: stampValue(run, `${PSI_SOME_KEY_PREFIX}start`),
    someEnd: stampValue(run, `${PSI_SOME_KEY_PREFIX}end`),
    fullStart: stampValue(run, `${PSI_FULL_KEY_PREFIX}start`),
    fullEnd: stampValue(run, `${PSI_FULL_KEY_PREFIX}end`),
  };
}

/**
 * PURE: classify the host conditions a run was measured under (D-005 step 2).
 *
 * BOTH phases must be inside the window. A run that STARTED quiet and ended
 * contended (or the reverse) spans a change in conditions, so nothing it measured
 * can be attributed to a quiet box — which is precisely why the stamp is taken
 * twice rather than once. Requiring both is also what makes the check falsifiable
 * by a fleet that gets busy mid-run, the common case on this host.
 *
 * A run missing EITHER `some` phase is `unstamped`, not partially trusted: a
 * half-stamped run is an absence of evidence about the other half.
 */
export function classifyRunPressure(
  run: DesktopPerfRun,
  quiet: QuietWindowThresholds = DEFAULT_QUIET_WINDOW,
): DesktopPerfPressureClass {
  const p = readHostPressure(run);
  if (p.someStart === null || p.someEnd === null) return 'unstamped';
  if (p.someStart > quiet.someAvg10Max || p.someEnd > quiet.someAvg10Max) return 'contended';
  // `full` is absent on some kernels even when `some` is present; only a PRESENT
  // reading above the bound is evidence of contention.
  if ((p.fullStart ?? 0) > quiet.fullAvg10Max || (p.fullEnd ?? 0) > quiet.fullAvg10Max) return 'contended';
  return 'quiet';
}

function fmtPressure(p: DesktopPerfHostPressure): string {
  const n = (v: number | null) => (v === null ? '?' : String(v));
  return `PSI some avg10 ${n(p.someStart)}→${n(p.someEnd)}, full ${n(p.fullStart)}→${n(p.fullEnd)}`;
}

export interface DesktopPerfGatePolicy {
  /** Master switch. When false the gate is a no-op (`pass`) and reads no run.
   *  Sourced from FLAGS.DESKTOP_PERF_GATE (default ON — warn-only is safe). */
  enabled: boolean;
  /**
   * Block-mode: hold the deploy on a budgeted breach that was measured inside a
   * QUIET WINDOW (see {@link classifyRunPressure}). Sourced from
   * FLAGS.DESKTOP_PERF_GATE_BLOCK (default ON).
   *
   * It is ONLY ever consulted for a quiet-window breach. A breach measured under
   * host contention is `unmeasurable` and warns whether or not this is armed —
   * so arming this can never produce the false red D-003/D-004 refused.
   */
  block: boolean;
  /**
   * The quiet-window admission thresholds, in /proc/pressure/cpu `avgN` percent.
   * A run is only a load-controlled measurement if BOTH its start and end stamps
   * sit at or below these. See {@link DEFAULT_QUIET_WINDOW} for the derivation.
   */
  quiet: QuietWindowThresholds;
  /**
   * How old the latest run may be and still be treated as a verdict on the
   * candidate, in ms.
   *
   * WHY THIS EXISTS (perf-testing-sweep-2026-07-27, WI-6538): this gate's own
   * fail-soft summary has always said "no FRESH desktop-perf run", but nothing
   * implemented freshness — `readLatestRun` is `readDesktopPerfRuns(ws, 1)[0]`,
   * the most recent row at ANY age, with no time bound. While the table was empty
   * that was invisible (the null branch handled every call). The moment a producer
   * started writing rows, the unbounded read became live: one run would be
   * re-applied as the verdict for every future candidate, indefinitely, long after
   * the code it measured had changed. A perf gate whose data can be arbitrarily
   * stale is not a working gate — it just fails in the other direction from the
   * starvation it replaced.
   */
  maxAgeMs: number;
}

/**
 * Default freshness window: 24h. Long enough that a nightly/periodic producer
 * always has a valid run in place, short enough that a run can never speak for a
 * materially different tree.
 */
export const DEFAULT_DESKTOP_PERF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface DesktopPerfGateDecision {
  action: DesktopPerfGateAction;
  /** Human reasons (the failing measures) for the broadcast / escalation. */
  reasons: string[];
  /** One-line, deploy-context summary. */
  summary: string;
  verdictStatus: DesktopPerfVerdictStatus;
  /**
   * The host conditions the run was measured under (D-005). `null` only when no
   * run was read at all (disabled / no data) — never when a run exists, so a
   * reader can always tell "measured on a quiet box" from "we cannot say".
   */
  pressure: DesktopPerfPressureClass | null;
}

function shaLabel(candidateSha?: string): string {
  return candidateSha ? candidateSha.slice(0, 8) : 'candidate';
}

/**
 * The green pin the candidate would be promoted OVER, and the newest commit time it
 * contains. `newestCommitAtMs` is null when it could not be read; the gate then
 * makes no attribution call, exactly as if no baseline had been supplied.
 */
export interface DesktopPerfBaseline {
  ref: string;
  newestCommitAtMs: number | null;
}

/**
 * Slack for git-sync's sweep lag: a binary built from the working tree holds edits
 * whose commit lands minutes AFTER the build, so "built before the baseline's newest
 * commit" only proves "cannot contain it" once the gap exceeds the sweep cadence.
 */
export const BUILD_SWEEP_LAG_TOLERANCE_MS = 30 * 60 * 1000;

/** When the measured packaged binary was built (its `build:` stamp), or null when the run carries none. */
export function readBinaryBuiltAt(run: DesktopPerfRun): number | null {
  const m = run.measures.find((x) => x.key === DESKTOP_PERF_BINARY_BUILT_AT_KEY);
  return m && Number.isFinite(m.value) && m.value > 0 ? m.value : null;
}

/**
 * True when the run measured a build that PREDATES the baseline (green pin) by more
 * than the sweep-lag tolerance (WI-10003815). Anything such a build shows is already
 * on the baseline, so no verdict on it can be the candidate's: holding the candidate
 * cannot keep it off `main`, and a clean reading says nothing about the candidate either.
 *
 * Only a POSITIVE proof demotes. An unstamped run or an unreadable baseline keeps
 * the pre-existing behaviour rather than inventing a verdict in either direction.
 */
export function binaryPredatesBaseline(
  run: DesktopPerfRun,
  baseline: DesktopPerfBaseline | null | undefined,
): { builtAt: number; baselineAt: number } | null {
  const builtAt = readBinaryBuiltAt(run);
  const baselineAt = baseline?.newestCommitAtMs ?? null;
  if (builtAt === null || baselineAt === null) return null;
  return builtAt + BUILD_SWEEP_LAG_TOLERANCE_MS < baselineAt ? { builtAt, baselineAt } : null;
}

/**
 * How the measured build relates to the judged candidate and the green pin, read from
 * the build's OWN recorded source sha (`DesktopPerfRun.buildSha`) — plan
 * desktop-perf-measure-candidate-build-2026-09-29 P-002 / D-001.
 *
 *   candidate          — the build IS the judged candidate: attributable.
 *   candidate-ancestor — strictly inside the candidate's promotion delta (an ancestor of
 *                        the candidate that is not on the pin): attributable, because
 *                        everything it adds would reach `main` with the candidate.
 *   on-baseline        — contained in the green pin: anything it shows is already there.
 *   unrelated          — a real commit that is neither (a newer tip, a side branch): it is
 *                        not what would be promoted, so it cannot be charged to it.
 *   unknown            — no clean identity recorded, or git could not answer. Only this
 *                        falls back to the build-time (mtime) rule.
 */
export type DesktopPerfBuildRelation = 'candidate' | 'candidate-ancestor' | 'on-baseline' | 'unrelated' | 'unknown';

export interface DesktopPerfBuildAttribution {
  /** Full sha when git resolved it, else the recorded value, else null. */
  buildSha: string | null;
  relation: DesktopPerfBuildRelation;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : 'unknown';
}

function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

function fmtMeasure(m: DesktopPerfMeasure): string {
  const v = m.unit === 'kb' ? `${Math.round(m.value / 1024)}MB` : m.unit === 'count' ? `${m.value}` : `${Math.round(m.value)}ms`;
  const b = m.budget === null ? '' : m.unit === 'kb' ? `${Math.round(m.budget / 1024)}MB` : m.unit === 'count' ? `${m.budget}` : `${Math.round(m.budget)}ms`;
  return `${m.key} ${v} > budget ${b}`;
}

/** The budgeted measures that missed their budget — the definitive regressions. */
/**
 * An invariant whose probe DID NOT RUN — "could not measure", never "measured a breach"
 * (WI-39665 D-008).
 *
 * WHY A NEGATIVE VALUE IS AN UNAMBIGUOUS SENTINEL. Every invariant this gate reads is a
 * `count` unit asserted against budget 0, and a count is non-negative by construction, so
 * no real reading can ever be < 0. `-1` is the DETECTOR-ABSENT sentinel written by
 * `libs/generic/desktop-ipc/src/desktop-bootstrap.ts`, whose own header warns in these
 * words: "A detector that goes quiet exactly when the fault is present is worse than no
 * detector, because `-1/unknown` and `0/clean` are one careless `>= 0` apart."
 *
 * This gate was making precisely that conflation, pointed at CONVICTION rather than
 * clearance: `!m.ok` is true for a sentinel, so an invariant nobody measured was reported
 * as an invariant that FAILED — and the invariant branch blocks independently of
 * block-mode arming AND of the PSI-quiet window, i.e. it bypasses every safety valve that
 * exists to absorb false reds. One such row (workspace-global, no harness scoping on
 * `desktop_perf_runs`) froze `main` for EVERY harness in the workspace on 2026-08-17.
 *
 * The correct reading is the one this file already applies to STALE data one branch up:
 * "the honest reading is *nothing is measuring this*, not *the invariant is broken now*".
 *
 * NOT fail-open: a real breach is value > 0 and still blocks, and value 0 still passes.
 * Only the never-taken reading stops being treated as evidence — and it is surfaced as a
 * loud `unknown` warn rather than swallowed, because a detector that has gone silent is
 * itself a defect worth paging on.
 */
export function isUnmeasuredInvariant(m: DesktopPerfMeasure): boolean {
  return m.invariant === true && !(m.value >= 0);
}

/** The invariants whose probe did not run — see {@link isUnmeasuredInvariant}. */
export function unmeasuredInvariants(run: DesktopPerfRun): DesktopPerfMeasure[] {
  return run.measures.filter(isUnmeasuredInvariant);
}

export function failingMeasures(run: DesktopPerfRun): DesktopPerfMeasure[] {
  // Unmeasured invariants are excluded here TOO, not just from breachedInvariants. They
  // carry budget 0 (non-null) with ok:false, so leaving them in would simply relocate the
  // false block from the invariant branch to the budget branch — which, with block-mode
  // armed by default since D-005, still blocks on a quiet host. Same defect, new address.
  return run.measures.filter((m) => m.budget !== null && !m.ok && !isUnmeasuredInvariant(m));
}

/**
 * The breached INVARIANTS — measures flagged `invariant: true` that did not hold
 * (no-http-anywhere-2026-07-28 P-003c).
 *
 * Separate from {@link failingMeasures} because the two are governed differently:
 * a budget breach is warn-until-armed, an invariant breach always blocks. See
 * `DesktopPerfMeasure.invariant` for why that asymmetry is principled rather than
 * just a louder severity.
 *
 * NOTE the deliberate lack of a `budget !== null` filter. An invariant asserts a
 * property, and its author may or may not express that property as a numeric
 * budget — reusing the budget-shaped check here would silently ignore any
 * invariant recorded without one, which is exactly the class of quiet
 * non-enforcement this gate already fell into once.
 */
export function breachedInvariants(run: DesktopPerfRun): DesktopPerfMeasure[] {
  // WI-39665 D-008: a BREACH is a reading that was taken and did not hold. An invariant
  // whose probe never ran is `unknown`, not `false` — see isUnmeasuredInvariant for why a
  // negative count is an unambiguous sentinel and why this is not a fail-open.
  return run.measures.filter(
    (m) => m.invariant === true && !m.ok && !isUnmeasuredInvariant(m),
  );
}

/**
 * Return the canonical interaction budgets that a run failed to measure.
 *
 * A run containing only the measures it happened to collect is not a complete
 * desktop-performance verdict: a producer can silently omit a newly-declared
 * interaction and still look green if the gate grades presence only. Keep this
 * check separate from {@link failingMeasures}; a missing measure is unknown data,
 * not a measured budget breach, and must warn without blocking.
 */
export function missingBudgetedInteractions(
  run: DesktopPerfRun,
  budgets: Pick<DesktopPerfBudgets, 'interactions'> = DESKTOP_PERF_BUDGETS,
): string[] {
  const measured = new Set(
    run.measures
      .filter((m) => m.key.startsWith('interaction:'))
      .map((m) => m.key.slice('interaction:'.length)),
  );
  return Object.keys(budgets.interactions).filter((name) => !measured.has(name));
}

function fmtInvariant(m: DesktopPerfMeasure): string {
  return `${m.key} = ${m.value} (invariant: must be ${m.budget ?? 0})`;
}

function fmtUnmeasuredInvariant(m: DesktopPerfMeasure): string {
  return `${m.key} = ${m.value} (DETECTOR ABSENT — the probe did not run; any real reading is ≥ 0)`;
}

/**
 * PURE: map the latest desktop-perf run + policy to a deploy-gate action. No IO.
 *
 * Decision table (action by verdict tier):
 *   disabled                         → pass  (no-op; the gate is opt-in via the flag)
 *   no run / no measures (unknown)   → pass  (fail-soft: never block on missing data)
 *   run older than policy.maxAgeMs   → pass  (fail-soft: stale data is not a verdict)
 *   build identity on the pin / unrelated → warn (unknown: not the candidate's build — P-002;
 *                                            findings reported as pre-existing / on that build)
 *   binary built before `baseline`   → warn  (unknown: a stale BUILD is not the candidate —
 *                                            WI-10003815; ONLY when no identity names the build)
 *   an INVARIANT measure breached    → block ALWAYS (independent of policy.block)
 *   an INVARIANT never MEASURED      → warn  (unknown: a probe that did not run is not a
 *                                            breach — WI-39665 D-008)
 *   a declared interaction is missing → warn (unknown: the run is incomplete, so it
 *                                            cannot report a clean interaction verdict)
 *   ok (all budgeted measures met)   → pass
 *   warn (suite warned, no breach)   → warn  (surface, never block — even when armed)
 *   crit (a budgeted measure breach) → block IFF policy.block else warn
 *
 * `now` is injected rather than read from the clock so the staleness branch is
 * deterministically testable. `baseline` (the green pin) enables the stale-build
 * branch; without it that branch never fires — see {@link binaryPredatesBaseline}.
 */
export function evaluateDesktopPerfGate(
  run: DesktopPerfRun | null,
  policy: DesktopPerfGatePolicy,
  candidateSha?: string,
  now: number = Date.now(),
  baseline?: DesktopPerfBaseline | null,
  attribution?: DesktopPerfBuildAttribution | null,
): DesktopPerfGateDecision {
  const sha = shaLabel(candidateSha);

  if (!policy.enabled) {
    return { action: 'pass', reasons: [], summary: `desktop-perf-gate disabled — ${sha} not perf-checked`, verdictStatus: 'unknown', pressure: null };
  }

  // A DEAD PRODUCER WARNS — it does not silently pass (D-007). The action still advances
  // the deploy (fail-soft is right: missing data must never block), but `warn` is what
  // green-checkpoint LOGS AND BROADCASTS, and `pass` is what it says nothing about. That
  // asymmetry is the root cause of this gate's 13 days of unnoticed fail-soft passes: the
  // summary below has always named the problem, and nobody could ever have read it.
  if (!run || run.measures.length === 0) {
    return {
      action: 'warn',
      reasons: ['no desktop-perf run recorded — nothing is producing runs for this gate to read'],
      summary:
        `🟧 desktop-perf-gate: NO desktop-perf run recorded — ${sha} advances UNMEASURED. ` +
        `This is not a clean result: the gate has no data, which is a producer failure, not a pass.`,
      verdictStatus: 'unknown',
      pressure: null,
    };
  }

  const pressure = classifyRunPressure(run, policy.quiet);

  // Stale data is NOT a verdict — see DesktopPerfGatePolicy.maxAgeMs. Reported as
  // `unknown` (never a breach) so a lapsed producer degrades to the same fail-soft
  // pass as no data at all, and names the age so the real problem — nothing is
  // running the suite — is visible instead of silently re-asserting an old result.
  const ageMs = now - run.createdTs;
  if (Number.isFinite(policy.maxAgeMs) && policy.maxAgeMs > 0 && ageMs > policy.maxAgeMs) {
    const ageHrs = Math.floor(ageMs / 3_600_000);
    const maxHrs = Math.round(policy.maxAgeMs / 3_600_000);
    // `warn`, not `pass` — same reason as the no-run branch above (D-007). Stale data is
    // still NOT a verdict (this never blocks, and never reports a breach), but a producer
    // that has lapsed must be audible.
    return {
      action: 'warn',
      reasons: [`latest desktop-perf run is ${ageHrs}h old (> ${maxHrs}h window) — nothing is producing fresh runs`],
      summary:
        `🟧 desktop-perf-gate: latest desktop-perf run is STALE (${ageHrs}h old > ${maxHrs}h window) — ` +
        `${sha} advances UNMEASURED; nothing is producing fresh runs`,
      verdictStatus: 'unknown',
      pressure,
    };
  }

  // A STALE BUILD IS NOT THE CANDIDATE (WI-10003815). The run is fresh, but the binary it
  // timed may not be: the producer measures whatever packaged build is newest on disk and
  // nothing rebuilds it. Observed 2026-09-29: a quiet-host plan-popup-open breach measured
  // on a 12-day-old binary held a suite-green candidate. A build that predates the green
  // pin can only show what is ALREADY on it, so holding the candidate cannot keep that
  // off `main`, and a clean reading says nothing about the candidate either. Same shape as
  // the staleness branch above, and placed ahead of the invariant branch for the same
  // reason: a breach recorded against a tree the candidate has moved past must not hold it
  // hostage. `warn` rather than `pass` (D-007), with every finding still named — a
  // pre-existing regression is real and must stay audible, just not charged to the candidate.
  //
  // BUILD IDENTITY OUTRANKS BUILD TIME (plan desktop-perf-measure-candidate-build-2026-09-29
  // P-002 / D-001). When the build recorded its own source sha, the gate reads it and the
  // mtime rule below is only the fallback for builds that recorded none: time attribution
  // misreads any rebuild that is not the candidate as the candidate.
  const relation = attribution?.relation ?? 'unknown';
  if (relation === 'on-baseline' || relation === 'unrelated') {
    const found = [...breachedInvariants(run).map(fmtInvariant), ...failingMeasures(run).map(fmtMeasure)];
    const pin = baseline?.ref ?? 'the green pin';
    const build = shortSha(attribution?.buildSha ?? null);
    const why =
      relation === 'on-baseline'
        ? `the measured packaged binary was built from ${build}, which is already on ${pin}, so it cannot contain ${sha} and anything it shows is already on ${pin}`
        : `the measured packaged binary was built from ${build}, which is neither ${sha} nor on ${pin}, so it is not what would be promoted`;
    const label = relation === 'on-baseline' ? `pre-existing on ${pin}` : `on build ${build}`;
    return {
      action: 'warn',
      reasons: [`UNATTRIBUTABLE (build identity): ${why}`, ...found.map((r) => `${label}: ${r}`)],
      summary:
        found.length > 0
          ? `🟧 desktop-perf-gate: desktop-perf miss on build ${build}, NOT reported as ${sha}'s regression — ${why}. ` +
            `Deploy advances; ${label}: ${found.join('; ')}. Build and measure the candidate to judge it.`
          : `🟧 desktop-perf-gate: ${sha} advances UNMEASURED — ${why}. Build and measure the candidate to judge it.`,
      verdictStatus: 'unknown',
      pressure,
    };
  }
  const identityProvesCandidate = relation === 'candidate' || relation === 'candidate-ancestor';
  const predates = identityProvesCandidate ? null : binaryPredatesBaseline(run, baseline);
  if (predates && baseline) {
    const gapDays = ((predates.baselineAt - predates.builtAt) / 86_400_000).toFixed(1);
    const why =
      `the measured packaged binary was built ${isoMinute(predates.builtAt)}, ${gapDays}d before the newest ` +
      `commit on ${baseline.ref} (${isoMinute(predates.baselineAt)}), so it cannot contain ${sha} and anything it shows is already on ${baseline.ref}`;
    const found = [...breachedInvariants(run).map(fmtInvariant), ...failingMeasures(run).map(fmtMeasure)];
    return {
      action: 'warn',
      reasons: [`UNATTRIBUTABLE (stale build): ${why}`, ...found.map((r) => `pre-existing on ${baseline.ref}: ${r}`)],
      summary:
        found.length > 0
          ? `🟧 desktop-perf-gate: desktop-perf miss on a STALE BUILD, NOT reported as ${sha}'s regression — ${why}. ` +
            `Deploy advances; pre-existing: ${found.join('; ')}. Rebuild the packaged binary to measure the candidate.`
          : `🟧 desktop-perf-gate: ${sha} advances UNMEASURED — ${why}. Rebuild the packaged binary to measure the candidate.`,
      verdictStatus: 'unknown',
      pressure,
    };
  }

  // INVARIANTS FIRST, and they block whether or not block-mode is armed
  // (no-http-anywhere-2026-07-28 P-003c). Ordered ahead of the budget branch so a
  // run that breaches both reports the invariant — the correctness failure is the
  // headline, and a timing regression is often just its symptom (the 9 escaping
  // requests this shipped for were also 3.6s of the boot they were slowing).
  //
  // Deliberately AFTER the staleness branch above: stale data is not a verdict for
  // an invariant either. A breach recorded against a tree that no longer exists
  // must not hold today's candidate hostage — the honest reading of an old run is
  // "nothing is measuring this", which is the fail-soft `unknown` the gate already
  // reports, not "the invariant is broken now".
  // NOTE the deliberate absence of any quiet-window condition on this branch. An
  // invariant is a BINARY CORRECTNESS property, and host contention cannot make one
  // false: no amount of CPU pressure causes the webview to issue an HTTP request it
  // would not otherwise have issued. Gating invariants on the quiet window would
  // hand every busy hour a way to suppress a real correctness failure — the exact
  // fail-open shape D-005 exists to remove, pointed the other way.
  const breached = breachedInvariants(run);
  if (breached.length > 0) {
    const reasons = breached.map(fmtInvariant);
    return {
      action: 'block',
      reasons,
      summary:
        `🟥 desktop-perf-gate: INVARIANT BREACHED — deploy of ${sha} BLOCKED: ${reasons.join('; ')}. ` +
        `An invariant is not a tunable budget: it blocks regardless of block-mode arming or host load.`,
      verdictStatus: 'crit',
      pressure,
    };
  }

  const failing = failingMeasures(run);
  if (failing.length > 0) {
    const reasons = failing.map(fmtMeasure);
    const p = readHostPressure(run);

    // D-005 STEP 2: a breach the gate cannot prove was measured on a quiet box is
    // UNMEASURABLE — neither pass nor fail. It warns (loudly, every time) and the
    // deploy advances, and the verdict is `unknown` rather than `crit` because we do
    // not know whether this candidate regressed. Reporting it as a regression is the
    // specific error D-003 was written to stop: LCP spanned 2143–5742ms on identical
    // code, so one contended sample can convict any candidate at all.
    //
    // Suppression is a WARN and not a `pass` on purpose. Persistent unmeasurability
    // would otherwise be indistinguishable from a healthy green gate — the same
    // silence that let this gate fail soft for 13 days — so every suppression is
    // surfaced and broadcast, and a gate that can never measure anything says so out
    // loud without needing any N-run bookkeeping to notice.
    if (pressure !== 'quiet') {
      const why =
        pressure === 'unstamped'
          ? `the run carries no /proc/pressure/cpu stamp, so the gate cannot show it was measured on a quiet box`
          : `it was measured under host contention (${fmtPressure(p)}; quiet window is some avg10 ≤ ${policy.quiet.someAvg10Max}, full ≤ ${policy.quiet.fullAvg10Max})`;
      return {
        action: 'warn',
        reasons: [`UNMEASURABLE (${pressure}): ${why}`, ...reasons],
        summary:
          `🟧 desktop-perf-gate: desktop-perf budget missed but the sample is UNMEASURABLE — ${why}. ` +
          `Deploy of ${sha} advances; this is NOT reported as a regression: ${reasons.join('; ')}`,
        verdictStatus: 'unknown',
        pressure,
      };
    }

    // Measured inside a quiet window ⇒ a real verdict, and the only case block-mode
    // is ever consulted for.
    const action: DesktopPerfGateAction = policy.block ? 'block' : 'warn';
    const verb = action === 'block' ? 'BLOCKED (block-mode armed)' : 'flagged (warn — block-mode not armed)';
    return {
      action,
      reasons,
      summary:
        `🟥 desktop-perf-gate: desktop interaction REGRESSED on a QUIET host (${fmtPressure(p)}) — ` +
        `deploy of ${sha} ${verb}: ${reasons.join('; ')}`,
      verdictStatus: 'crit',
      pressure,
    };
  }

  // WI-39665 D-008: an invariant whose PROBE DID NOT RUN. Deliberately positioned AFTER
  // the breach and budget branches, so it can never mask a verdict that was actually
  // measured: a real invariant breach (value > 0) still blocks above, and a real budget
  // breach still reaches its own branch. By the time control arrives here, nothing that
  // was measured has anything to say, and the only outstanding fact is that something
  // went unmeasured.
  //
  // `warn`/`unknown` and never `block`, for the reason the staleness branch gives: a
  // missing measurement is not a verdict. But never `pass` either — a silent detector is
  // itself a defect, and reporting it as a clean gate is the 13-day fail-soft silence
  // D-007 exists to end. This is the branch that keeps "nothing measured it" audible
  // without letting it freeze the fleet.
  const unmeasured = unmeasuredInvariants(run);
  if (unmeasured.length > 0) {
    const reasons = unmeasured.map(fmtUnmeasuredInvariant);
    return {
      action: 'warn',
      reasons,
      summary:
        `🟧 desktop-perf-gate: INVARIANT UNMEASURED — ${sha} advances UNVERIFIED: ${reasons.join('; ')}. ` +
        `This is NOT a clear and NOT a breach: the probe did not run, so the gate has no evidence either way. ` +
        `Fix the producer — a correctness invariant nobody is measuring is the failure this reports.`,
      verdictStatus: 'unknown',
      pressure,
    };
  }

  // A declared interaction that never appears in the run is not an implicit pass.
  // This branch is deliberately after measured invariant/budget verdicts and the
  // detector-absent branch above, so missing coverage cannot mask a real failure.
  // It is still before the ordinary run-status/pass branches: a partial run must
  // remain audible and unknown rather than silently clearing the release gate.
  const missingInteractions = missingBudgetedInteractions(run);
  if (missingInteractions.length > 0) {
    const measureKeys = missingInteractions.map((name) => `interaction:${name}`);
    const reasons = measureKeys.map((key) => `MISSING declared interaction measure: ${key}`);
    return {
      action: 'warn',
      reasons,
      summary:
        `🟧 desktop-perf-gate: INCOMPLETE desktop-perf run — ${sha} advances UNVERIFIED: ` +
        `${measureKeys.join(', ')} were declared but not measured. ` +
        `A partial run is not a clean interaction verdict; fix the producer before trusting it.`,
      verdictStatus: 'unknown',
      pressure,
    };
  }

  if (run.status === 'warn') {
    return {
      action: 'warn',
      reasons: ['desktop-perf suite reported a warning (no budgeted breach)'],
      summary: `🟧 desktop-perf-gate: desktop-perf run warned — deploy of ${sha} flagged`,
      verdictStatus: 'warn',
      pressure,
    };
  }

  // A PASS is honoured whatever the host pressure was, and the asymmetry with the
  // breach branch above is deliberate — but NOT for the tempting reason. "Contention
  // can only slow an interaction down, so an under-budget reading on a busy box is a
  // pass a fortiori" is FALSE here, and the sample behind DEFAULT_QUIET_WINDOW
  // falsifies it: across n=15, PSI correlates strongly with FCP (Spearman +0.78,
  // quiet mean 716ms → contended 850ms) but only weakly with LCP (+0.32), and the
  // single most contended run reported LCP=1311ms — 895ms FASTER than any quiet
  // reading in the sample, with its FCP simultaneously the second-worst at 996ms.
  // LCP is a largest-element-SO-FAR metric, so contention that stops the big element
  // painting inside the observation window leaves a smaller earlier element holding
  // the title. Contention does not shift LCP's centre (contended mean 2581ms vs quiet
  // 2629ms); it destroys its precision (range 1311–3246ms vs 2206–2817ms). A contended
  // sample is therefore untrustworthy in BOTH directions.
  //
  // The real reason this branch passes: an unmeasurable sample never blocks either way,
  // so a contended pass and a contended breach produce the SAME action (advance) — the
  // only difference is what gets reported, and reporting is where honesty is available.
  // Hence the summary names the pressure class instead of calling this a clear.
  //
  // NOT CLAIMED: that this is a load-controlled clear. It is an advance on a sample the
  // gate cannot vouch for, which is the correct fail-soft posture and not evidence.
  return {
    action: 'pass',
    reasons: [],
    summary:
      pressure === 'quiet'
        ? `desktop-perf-gate: desktop-perf ok on a quiet host — ${sha} clears`
        : `desktop-perf-gate: desktop-perf ok (${pressure} sample — under budget despite it) — ${sha} clears`,
    verdictStatus: 'ok',
    pressure,
  };
}

/**
 * Read the gate policy from the FLAGS system: enabled (default ON) + quiet-gated
 * block-mode (default ON, D-005).
 *
 * Both reads fail CLOSED-TO-SAFE rather than closed: an unreadable enable flag
 * disables the gate, and an unreadable block flag leaves it warn-only. A flag
 * store hiccup must never invent a deploy-holding verdict.
 */
export async function desktopPerfGatePolicyFromFlags(
  readFlag: () => Promise<boolean> = () => getFlag(FLAGS.DESKTOP_PERF_GATE, 'system'),
  readBlockFlag: () => Promise<boolean> = () => getFlag(FLAGS.DESKTOP_PERF_GATE_BLOCK, 'system'),
): Promise<DesktopPerfGatePolicy> {
  return {
    enabled: await readFlag().catch(() => false),
    // D-005: block-mode is armed, but it only ever applies to a breach measured
    // INSIDE the quiet window below — see DesktopPerfGatePolicy.block.
    block: await readBlockFlag().catch(() => false),
    maxAgeMs: DEFAULT_DESKTOP_PERF_MAX_AGE_MS,
    quiet: DEFAULT_QUIET_WINDOW,
  };
}

/** IO seam for {@link runDesktopPerfGate} (injected as fakes in tests). */
export interface DesktopPerfGateIO {
  readLatestRun: (workspaceId: string) => Promise<DesktopPerfRun | null>;
  /** Newest commit time (epoch ms) reachable within the last few commits of `ref`, or null. */
  readNewestCommitAtMs?: (ref: string, repoRoot: string) => Promise<number | null>;
  /** Relate the measured build's recorded sha to the candidate and the pin (P-002). */
  classifyBuild?: (
    buildSha: string | null,
    opts: { candidateSha?: string; baselineRef?: string; repoRoot: string },
  ) => Promise<DesktopPerfBuildAttribution>;
}

// Lazy + memoized, NOT promisified at module scope (EI-10161): under a narrow
// `vi.mock('node:child_process')` `execFile` is undefined, and an eager `promisify` throws at
// IMPORT time — crashing every test file that reaches this module, even one that never calls it.
let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;
const execFileAsync = ((...args: unknown[]) =>
  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;

/**
 * How far back {@link readNewestCommitAtMs} looks. It takes the MAX over a window, not
 * the tip's date, because repair-queue admission commits ("admit N path(s) onto frozen
 * lineage …") carry a deterministic 2000-01-01 committer date; `main` routinely sits on
 * one, so its tip date would say the green pin is 26 years old.
 */
const BASELINE_COMMIT_WINDOW = 64;

export async function readNewestCommitAtMs(ref: string, repoRoot: string): Promise<number | null> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repoRoot, 'log', '-n', String(BASELINE_COMMIT_WINDOW), '--format=%ct', ref, '--'],
    { encoding: 'utf8', timeout: 15_000 },
  );
  let newest = 0;
  for (const line of stdout.split('\n')) {
    const s = Number(line.trim());
    if (Number.isFinite(s) && s > newest) newest = s;
  }
  return newest > 0 ? newest * 1000 : null;
}

/** Full commit sha `rev` names in `repoRoot`, or null when git cannot resolve it. */
async function resolveCommit(rev: string, repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`],
      { encoding: 'utf8', timeout: 15_000 },
    );
    const sha = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * `git merge-base --is-ancestor`: true / false from its documented exit codes 0 / 1;
 * null for anything else (a bad ref, a timeout) — "could not tell", never "no".
 */
async function isAncestor(ancestor: string, descendant: string, repoRoot: string): Promise<boolean | null> {
  try {
    await execFileAsync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', ancestor, descendant], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === 1 ? false : null;
  }
}

/**
 * Relate a measured build's recorded source sha to the judged candidate and the green
 * pin — see {@link DesktopPerfBuildRelation}. Pure git reads in `repoRoot` (the
 * integration tree the build came from). Every doubt resolves to `unknown`, which the
 * gate answers with its pre-existing build-time rule rather than a guess. Order
 * matters: a build that is on the pin is pre-existing even though the pin is itself an
 * ancestor of the candidate.
 */
export async function classifyBuildSha(
  buildSha: string | null,
  opts: { candidateSha?: string; baselineRef?: string; repoRoot: string },
): Promise<DesktopPerfBuildAttribution> {
  if (!buildSha) return { buildSha: null, relation: 'unknown' };
  const build = await resolveCommit(buildSha, opts.repoRoot);
  if (!build) return { buildSha, relation: 'unknown' };
  const candidate = opts.candidateSha ? await resolveCommit(opts.candidateSha, opts.repoRoot) : null;
  if (candidate && candidate === build) return { buildSha: build, relation: 'candidate' };
  if (opts.baselineRef) {
    const onPin = await isAncestor(build, opts.baselineRef, opts.repoRoot);
    if (onPin === null) return { buildSha: build, relation: 'unknown' };
    if (onPin) return { buildSha: build, relation: 'on-baseline' };
  }
  if (!candidate) return { buildSha: build, relation: 'unknown' };
  const inDelta = await isAncestor(build, candidate, opts.repoRoot);
  if (inDelta === null) return { buildSha: build, relation: 'unknown' };
  return { buildSha: build, relation: inDelta ? 'candidate-ancestor' : 'unrelated' };
}

const defaultDesktopPerfGateIO: DesktopPerfGateIO = {
  readLatestRun: async (workspaceId) => (await readDesktopPerfRuns(workspaceId, 1))[0] ?? null,
  readNewestCommitAtMs,
  classifyBuild: classifyBuildSha,
};

/**
 * Read the latest persisted desktop-perf run for the workspace, evaluate it, and
 * apply the gate policy → a {@link DesktopPerfGateDecision}. Fail-soft end-to-end:
 * disabled ⇒ reads NOTHING and passes; a read error / missing run degrades to
 * `unknown` → `pass`. The green-checkpoint wiring calls this post-`runGreen` /
 * pre-`advance` and, on `block`, holds the advance; on `warn`/`block` it
 * broadcasts/escalates `decision.summary`.
 */
export async function runDesktopPerfGate(
  policy: DesktopPerfGatePolicy,
  opts: {
    workspaceId?: string;
    candidateSha?: string;
    /** The green pin the candidate would promote over (e.g. `main`). Enables the stale-build branch. */
    baselineRef?: string;
    /** Repository holding `baselineRef`; defaults to the process cwd. */
    repoRoot?: string;
    io?: DesktopPerfGateIO;
  } = {},
): Promise<DesktopPerfGateDecision> {
  const candidateSha = opts.candidateSha;
  if (!policy.enabled) {
    return evaluateDesktopPerfGate(null, policy, candidateSha);
  }
  const workspaceId = opts.workspaceId ?? process.env.PAPERCUSP_WORKSPACE_ID ?? 'default';
  const io = opts.io ?? defaultDesktopPerfGateIO;
  const run = await io.readLatestRun(workspaceId).catch(() => null);
  let baseline: DesktopPerfBaseline | null = null;
  if (opts.baselineRef) {
    const read = io.readNewestCommitAtMs ?? readNewestCommitAtMs;
    // Fail-soft: an unreadable baseline makes no attribution call (see binaryPredatesBaseline).
    const newestCommitAtMs = await read(opts.baselineRef, opts.repoRoot ?? process.cwd()).catch(() => null);
    baseline = { ref: opts.baselineRef, newestCommitAtMs };
  }
  // P-002: attribute by the build's own recorded identity. Fail-soft like the baseline
  // read — an unanswerable classification is `unknown`, i.e. the build-time fallback.
  let attribution: DesktopPerfBuildAttribution | null = null;
  if (run?.buildSha && (candidateSha || opts.baselineRef)) {
    const classify = io.classifyBuild ?? classifyBuildSha;
    attribution = await classify(run.buildSha, {
      candidateSha,
      baselineRef: opts.baselineRef,
      repoRoot: opts.repoRoot ?? process.cwd(),
    }).catch(() => ({ buildSha: run.buildSha, relation: 'unknown' as const }));
  }
  return evaluateDesktopPerfGate(run, policy, candidateSha, Date.now(), baseline, attribution);
}
