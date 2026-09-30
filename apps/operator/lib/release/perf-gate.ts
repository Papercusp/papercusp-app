/**
 * F2 (round-4 Lane F / P-031): the perf-regression DEPLOY-GATE decision.
 *
 * A PURE policy layer that turns F1's per-thread perf verdict (perf-budgets.ts
 * `evaluatePerfSignals`, plan P-030) into a green-checkpoint action: `pass`,
 * `warn` (surface it, still advance the green pin), or `block` (hold the deploy).
 *
 * Two load-bearing rules from the plan (infra-perf-reliability-audit-round4-2026-06-19):
 *   - DEFAULT-WARN until the budgets are trusted. A perf wedge only `block`s the deploy
 *     when the OWNER has explicitly armed block-mode; otherwise the worst it does is
 *     `warn` (broadcast/escalate) and let the green commit advance. This keeps the gate
 *     from ever silently stranding `main` on a perf signal that turns out noisy.
 *   - FLAG-GATED + FAIL-SOFT. Disabled by default (a no-op `pass`); a stale / missing /
 *     unparseable signal capture (verdict `unknown`) never blocks — missing perf data
 *     must not hold a green deploy.
 *
 * Kept as a STANDALONE, framework-agnostic decision (`evaluatePerfGate`) so it composes
 * either as a bespoke green-checkpoint pre-advance hook OR as one check inside a shared
 * fail-fast preflight framework (the deploy-gate ABI preflight, A1/A2 of
 * infra-fail-fast-build-integrity-2026-06-19), whichever the deploy-gate owner lands.
 * The only step that touches the contested `green-checkpoint.ts` gate file — adding an
 * optional `CheckpointDeps.perfGate` and the post-runGreen/pre-advance call site — is
 * intentionally NOT in this module; it is the owner-arming + anti-collision-gated last
 * mile. This file is the buildable substrate, dead-code-until-wired (like perf-budgets.ts
 * before its panel wiring).
 */

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  evaluatePerfSignals,
  readLatestPerfSignals,
  PERF_BUDGETS,
  type PerfVerdict,
  type PerfSignalsV1,
  type PerfBudgets,
} from '@papercusp/operator-core/lib/system-health/perf-budgets';

/** What the gate tells the green-checkpoint to do with a candidate. */
export type PerfGateAction = 'pass' | 'warn' | 'block';

export interface PerfGatePolicy {
  /** Master switch. When false the gate is a no-op (`pass`) and reads no signals.
   *  Default-OFF — perf gating is opt-in until the budgets are trusted. */
  enabled: boolean;
  /** Owner-armed block-mode. When false a definitive wedge (crit) only `warn`s and the
   *  deploy still advances; when true a crit `block`s it. Default-OFF per the plan's
   *  "default = FLAG (warn), not block". A non-crit (warn) verdict NEVER blocks even when
   *  armed — block is reserved for the definitive per-thread-wedge crits. */
  block: boolean;
}

export interface PerfGateDecision {
  action: PerfGateAction;
  /** The verdict's human reasons (the alarm copy) for the worst tier reached. */
  reasons: string[];
  /** One-line, deploy-context summary for the broadcast / escalation. */
  summary: string;
  /** The underlying perf verdict tier (ok | warn | crit | unknown) for logging. */
  verdictStatus: PerfVerdict['status'];
}

/** Read the gate policy from the environment.
 *  - `PAPERCUSP_PERF_GATE=1`        → enable the gate (default off).
 *  - `PAPERCUSP_PERF_GATE_BLOCK=1`  → arm block-mode (default warn-only). Owner-set.
 *
 *  @deprecated WI-6538 — superseded by {@link perfGatePolicyFromFlags}, which is what
 *  green-checkpoint now calls. Kept only so an operator can still force the gate on for
 *  a one-off local run; it is no longer the production path. See the note on
 *  FLAGS.HOST_PERF_GATE for why env could not actually arm this gate. */
export function perfGatePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PerfGatePolicy {
  return {
    enabled: env.PAPERCUSP_PERF_GATE === '1',
    block: env.PAPERCUSP_PERF_GATE_BLOCK === '1',
  };
}

/** Read the gate policy from the FLAGS system (both switches default ON).
 *
 *  Mirrors `desktopPerfGatePolicyFromFlags` deliberately — the two perf gates are
 *  siblings and should be armed, read and reasoned about the same way, down to
 *  block-mode tracking its own separate flag.
 *
 *  WI-38449 / D-007 F3: `block` is no longer hardwired false. It reads
 *  FLAGS.HOST_PERF_GATE_BLOCK, which is safe to arm now that a crit blocks only for
 *  reasons attributed to the operator itself (see evaluatePerfGate). Before that
 *  split, arming held every deploy whenever this shared box was busy. */
export async function perfGatePolicyFromFlags(
  readFlag: () => Promise<boolean> = () => getFlag(FLAGS.HOST_PERF_GATE, 'system'),
  env: NodeJS.ProcessEnv = process.env,
  readBlockFlag: () => Promise<boolean> = () => getFlag(FLAGS.HOST_PERF_GATE_BLOCK, 'system'),
): Promise<PerfGatePolicy> {
  // Fail-soft: a flag backend that throws must not take the release gate down with it.
  // Falling back to `false` keeps green-checkpoint's behaviour a no-op `pass` rather
  // than an unexplained gate error mid-deploy.
  const enabled = (await readFlag().catch(() => false)) || env.PAPERCUSP_PERF_GATE === '1';
  // An UNREADABLE block flag ⇒ warn-only, never armed. A flag-store hiccup must not
  // invent a deploy-holding verdict — the same rule as the desktop sibling.
  const blockRequested = (await readBlockFlag().catch(() => false)) || env.PAPERCUSP_PERF_GATE_BLOCK === '1';
  return {
    enabled,
    // Block-mode is meaningless without the gate itself — never report armed-but-disabled,
    // which would read as "this gate can hold a deploy" when it evaluates nothing at all.
    block: enabled && blockRequested,
  };
}

function shaLabel(candidateSha?: string): string {
  return candidateSha ? candidateSha.slice(0, 8) : 'candidate';
}

/**
 * PURE: map a perf verdict + policy to a deploy-gate action. No IO.
 *
 * Decision table (action by verdict tier):
 *   disabled                      → pass   (no-op; the gate is opt-in)
 *   ok                            → pass   (measured, and fine)
 *   unknown (stale / no capture)  → warn   (D-007: never blocks, but never SILENT either —
 *                                           a dead producer is a producer failure, not a pass)
 *   warn (hot-but-not-fatal)      → warn   (surface, never block — even when armed)
 *   crit, operator-defect         → block IFF policy.block else warn
 *   crit, ambient-host only       → warn ALWAYS (even armed — see below)
 *   crit, unattributed            → warn ALWAYS (never block on an unclassified reason)
 *
 * WI-38449 / D-007 F3 — WHY CRIT ALONE IS NOT ENOUGH TO BLOCK. Measured 2026-08-16
 * against a live capture, `crit` fired on the SINGLE reason `PSI memory full avg60
 * 11.45 ≥ 5` — ambient RAM pressure from ~100 peer agents on this shared box, with
 * nothing wrong with any candidate; `evaluatePerfGate(verdict, { enabled:true,
 * block:true })` returned `block`. So arming the undifferentiated crit tier would have
 * held EVERY deploy for the whole busy period — the exact false-red D-003/D-005 refused
 * for the desktop sibling.
 *
 * The fix is attribution, not a threshold: `PerfVerdict.critAttribution` splits crit
 * reasons at the point they are RAISED (perf-budgets.ts) into
 *   - operatorDefect — :3070 unreachable · wedge-active · event-loop lag p95 ≥ 1s ·
 *     CLOSE_WAIT ≥ 500. Meltdown-class properties of OUR process. These block.
 *   - ambientHost   — CPU/memory pressure, host-total inotify (per-uid, routinely a
 *     third-party editor). These never block.
 *
 * ⚠ This gate does NOT weaken any alarm: an ambient crit is still `crit`, still carries
 * every reason in `reasons`, and is still surfaced — it is merely not a reason to hold a
 * release. And an armed gate that declines to block SAYS SO in its summary; a silent
 * non-block would be the same invisible suppression that hid 13 days of fail-soft.
 */
export function evaluatePerfGate(
  verdict: PerfVerdict,
  policy: PerfGatePolicy,
  candidateSha?: string,
): PerfGateDecision {
  const sha = shaLabel(candidateSha);

  if (!policy.enabled) {
    return {
      action: 'pass',
      reasons: [],
      summary: `perf-gate disabled — ${sha} not perf-checked`,
      verdictStatus: verdict.status,
    };
  }

  // `unknown` stays a quiet fail-soft pass HERE, and that is deliberate — do not "fix" it
  // to warn (I tried; it is wrong for this gate). Unlike its desktop sibling, this gate
  // already distinguishes a BRIEF gap from a DEAD producer upstream, in
  // perf-budgets.ts's `blindMs` branch (WI-324): a capture 10–30min old is `unknown`
  // (a skipped timer tick — quiet on purpose), while one past 30min is promoted to
  // `warn` carrying the reason "host SLO monitor blind; check
  // papercup-perf-signals-capture.timer". So a genuinely dead producer is ALREADY audible
  // through the warn branch below, and warning on plain `unknown` would only add noise on
  // every skipped tick. (The desktop gate had no such tier, which is why D-007's
  // dead-producer ruling changes THAT file and not this one.)
  if (verdict.status === 'ok' || verdict.status === 'unknown') {
    const why = verdict.status === 'unknown' ? 'no fresh perf signal (fail-soft)' : 'operator perf ok';
    return {
      action: 'pass',
      reasons: [],
      summary: `perf-gate: ${why} — ${sha} clears`,
      verdictStatus: verdict.status,
    };
  }

  if (verdict.status === 'crit') {
    // WI-38449 / D-007 F3: a crit BLOCKS only for reasons attributable to the operator
    // itself. Ambient host state (CPU/memory pressure, host-total inotify) is still a
    // crit, still reported here in full, but must never hold a release: no candidate
    // caused it and no release can fix it, so blocking on it would freeze every deploy
    // for as long as this shared box is busy.
    // Read DEFENSIVELY, not because the field is optional (it is required), but because
    // `lint:tsc` only typechecks packages/operator-core — this file lives in
    // apps/operator and vitest does not typecheck, so a caller passing a verdict built
    // before this field existed would fault at runtime on the destructure. Absent ⇒
    // unattributed ⇒ never blocks, which is the same fail-soft direction as below.
    const { operatorDefect = [], ambientHost = [] } = verdict.critAttribution ?? {};
    // An UNATTRIBUTED crit (both lists empty — e.g. a verdict built by an older code
    // path) must not silently become a block. Fail toward not-blocking, and say so,
    // exactly as the desktop sibling refuses to invent a deploy-holding verdict from
    // an unreadable signal.
    const unattributed = operatorDefect.length === 0 && ambientHost.length === 0;
    const blockworthy = operatorDefect.length > 0;
    const action: PerfGateAction = policy.block && blockworthy ? 'block' : 'warn';

    let verb: string;
    if (action === 'block') {
      verb = `BLOCKED (block-mode armed; ${operatorDefect.length} operator-defect crit)`;
    } else if (!policy.block) {
      verb = 'flagged (warn — block-mode not armed)';
    } else if (unattributed) {
      verb = 'flagged (warn — block-mode armed but this crit carries NO attribution; not blocking on an unclassified reason)';
    } else {
      // The case this whole change exists for. Name it explicitly: an armed gate that
      // declines to block is otherwise indistinguishable from a gate that is not armed,
      // and that ambiguity is what makes a suppression channel invisible.
      verb = `flagged (warn — block-mode armed, but all ${ambientHost.length} crit reason(s) are AMBIENT HOST state, not this candidate)`;
    }

    // Attribute in the summary, so a reader can tell "the operator is wedged" from
    // "the box is busy" without opening the capture.
    const detail = blockworthy
      ? `operator-defect: ${operatorDefect.join('; ')}${ambientHost.length ? ` | ambient (not blocking): ${ambientHost.join('; ')}` : ''}`
      : verdict.reasons.join('; ');

    return {
      action,
      reasons: verdict.reasons,
      summary: `🟥 perf-gate: operator DEGRADED — deploy of ${sha} ${verb}: ${detail}`,
      verdictStatus: 'crit',
    };
  }

  // 'warn' — hot but not a definitive wedge: surface only, never block.
  return {
    action: 'warn',
    reasons: verdict.reasons,
    summary: `🟧 perf-gate: operator hot — deploy of ${sha} flagged: ${verdict.reasons.join('; ')}`,
    verdictStatus: 'warn',
  };
}

/** IO seam for `runPerfGate` (injected as fakes in tests). */
export interface PerfGateIO {
  readSignals: () => Promise<PerfSignalsV1 | null>;
  now: () => number;
}

const defaultPerfGateIO: PerfGateIO = {
  readSignals: () => readLatestPerfSignals(),
  now: () => Date.now(),
};

/**
 * Read the latest perf-signals-v1 capture, evaluate it against the budgets, and apply the
 * gate policy → a {@link PerfGateDecision}. Fail-soft end-to-end: when disabled it reads
 * NOTHING and passes; a read error / missing capture degrades to `unknown` → `pass`. The
 * green-checkpoint wiring calls this post-`runGreen`/pre-`advance` and, on `block`, holds
 * the advance; on `warn`/`block` it broadcasts/escalates `decision.summary`.
 */
export async function runPerfGate(
  policy: PerfGatePolicy,
  candidateSha?: string,
  io: PerfGateIO = defaultPerfGateIO,
  budgets: PerfBudgets = PERF_BUDGETS,
): Promise<PerfGateDecision> {
  if (!policy.enabled) {
    // Skip IO entirely when off — the decision is `pass` regardless of any signal.
    return evaluatePerfGate(evaluatePerfSignals(null, io.now(), budgets), policy, candidateSha);
  }
  const signals = await io.readSignals().catch(() => null);
  const verdict = evaluatePerfSignals(signals, io.now(), budgets);
  return evaluatePerfGate(verdict, policy, candidateSha);
}
