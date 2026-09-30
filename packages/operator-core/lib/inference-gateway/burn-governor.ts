/**
 * Burn-rate governor — the PURE verdict half of WI-41147.
 *
 * PROBLEM: every existing capacity control governs how MANY agents run (headcount, admission,
 * refill clamps). Nothing governs what they SPEND: burn = members × per-member throughput, and
 * only the first factor had any governor. On 2026-08-23 a 2.3× burn spike at FLAT headcount
 * drove 8/12 accounts to utilization7d = 1.00 and walled 4/5 CODEX accounts for 106–162h —
 * discovered only at the wall, because the pool's `available`/`usageWalled` booleans are
 * threshold checks on the CURRENT reading, with no notion of trajectory.
 *
 * DESIGN (reuse-first): the burn rate is DERIVED from the provider's own metered quantity —
 * d(utilization7d)/dt over the retained probe history (`AccountRateState.history7d`,
 * `appendUtilization7dSample` in deployment/account-pool.ts) — never a second hand-rolled
 * meter, and never the cached `available`/`usageWalled` booleans (stale on 11/12 accounts at
 * the incident). This module is deliberately PURE and structurally typed (no imports from
 * deployment/) so:
 *   - it is exhaustively unit-testable, clock edge cases included;
 *   - the selection wiring in deployment/account-pool*.ts can import it without a cycle.
 *
 * VERDICT LADDER (`action`):
 *   - `none`     — no reading / insufficient history / flat-or-decaying burn / projection
 *                  comfortably clears the window reset. NEVER act on missing data.
 *   - `throttle` — projection says the window exhausts before it resets (or exhaustion is
 *                  inside the imminent horizon with no usable reset): PREFER other accounts.
 *   - `shed`     — exhaustion is both before the reset AND imminent (or already at the wall):
 *                  refuse the account, with the reason stated.
 *
 * Enforcement, surfacing (accounts:status), and the never-silent alert are the impure callers'
 * job — this module only computes and EXPLAINS the verdict (`reason` is always populated).
 */

/** One timestamped utilization7d observation — structurally identical to `Utilization7dSample`. */
export interface BurnSample {
  /** Epoch ms observed. */
  at: number;
  /** Unified-7d utilization fraction (1.0 = 100%) at `at`. */
  u: number;
}

export type BurnAction = 'none' | 'throttle' | 'shed';

/**
 * What the verdict's `action` actually RESTS ON — the field that stops a reader inheriting a
 * pacing POLICY as a measured capacity wall (P-001, plan
 * capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01).
 *
 *  - `measured-wall`      — the provider's own meter says the window is exhausted
 *                           (`utilization7d >= BURN_EXHAUSTED_UTIL`). A MEASUREMENT.
 *  - `pacing-projection`  — the action derives from a least-squares PROJECTION of when the
 *                           window would exhaust. A POLICY choice about pacing, not a wall the
 *                           provider has imposed: the account is still serviceable right now.
 *  - `no-verdict`         — no action is being asserted (healthy, no data, or stale-gated).
 *
 * Stamped at the branch that decides the action (never re-derived by a second predicate), because
 * the two are not independently recoverable: the stale gate returns `none` on a reading that may
 * itself be at/over 1.0, so `utilization7d >= 1` is NOT a sound test for "a wall was measured".
 */
export type BurnDisposition = 'measured-wall' | 'pacing-projection' | 'no-verdict';

export interface BurnPolicy {
  /** Only samples within this lookback from `now` feed the rate fit (default 3h). */
  lookbackMs: number;
  /** Minimum span between oldest and newest usable sample — below it the rate is null (default 15m). */
  minSpanMs: number;
  /** Exhaustion projected within this horizon is IMMINENT (default 2h). */
  imminentHorizonMs: number;
}

export const DEFAULT_BURN_POLICY: BurnPolicy = {
  lookbackMs: 3 * 60 * 60_000,
  minSpanMs: 15 * 60_000,
  imminentHorizonMs: 2 * 60 * 60_000,
};

/** Utilization at/above which the window is exhausted (mirrors account-pool's EXHAUSTED_UTIL). */
export const BURN_EXHAUSTED_UTIL = 1.0;

export interface BurnVerdict {
  /**
   * Net d(utilization7d)/dt in utilization-fraction per HOUR (least-squares over the usable
   * samples), or null when the history cannot support an estimate. Negative = the rolling
   * window is decaying faster than new usage lands (headroom growing).
   */
  burnRatePerHr: number | null;
  /** `max(0, 1 - utilization7d)`, or null when there is no reading. */
  headroomFraction: number | null;
  /**
   * Epoch ms the window is projected to hit `BURN_EXHAUSTED_UTIL` at the current rate; `now`
   * when already at/over the wall; null when no reading, no usable rate, or rate ≤ 0.
   */
  projectedExhaustionAt: number | null;
  /**
   * True only when a USABLE reset (`windowResetAt7d` known and in the future) exists and the
   * projected exhaustion lands before it. A reset in the past or never observed is UNKNOWN —
   * this stays false (the imminent horizon still drives a throttle; see `action`).
   */
  exhaustsBeforeReset: boolean;
  action: BurnAction;
  /**
   * The freshest 7d utilization the verdict was computed from, or null when never observed —
   * echoed onto the verdict so every writer can state the BASIS beside the action without
   * re-fetching (and without a second reader guessing which reading it was). Note this is the
   * raw reading, NOT recoverable from `headroomFraction`, which clamps at 0 above the wall.
   */
  utilization7d: number | null;
  /** What `action` rests on — a measured wall vs a pacing projection. Never omitted (P-001). */
  disposition: BurnDisposition;
  /** Always populated — the human-readable WHY behind `action` (never silent throttling). */
  reason: string;
}

/**
 * The ONE rendering of a burn verdict for any human- or agent-facing surface (the standing
 * `account-burn:<id>` fact, the severe-event broadcast, status prose). Every writer calls this
 * instead of composing its own string, so the disposition can never be present on one surface and
 * missing on another.
 *
 * It LEADS with the disposition because that is the part readers were losing: a `throttle`/`shed`
 * derived from a projection is this system pacing itself, and an agent that reads it as "the
 * provider walled us" reaches for the wrong remedy (see the plan's D-001 — never remedy a pacing
 * verdict by throttling the fleet).
 */
export function renderBurnVerdictLabel(v: BurnVerdict): string {
  const util =
    v.utilization7d === null || !Number.isFinite(v.utilization7d) ? 'unknown' : v.utilization7d.toFixed(2);
  if (v.disposition === 'measured-wall') return `USAGE-WALLED (measured; util7d ${util})`;
  if (v.disposition === 'pacing-projection') {
    const basis = v.exhaustsBeforeReset
      ? 'projected exhaustion before reset'
      : 'projected exhaustion inside the imminent horizon, no usable window reset';
    return `${v.action.toUpperCase()} (pacing projection, not a measured wall; util7d ${util}, ${basis})`;
  }
  return `${v.action.toUpperCase()} (no wall asserted; util7d ${util})`;
}

export interface BurnInput {
  /** The freshest observed unified-7d utilization fraction; undefined = never observed. */
  utilization7d?: number;
  /** Epoch ms the 7d window resets; undefined = never observed. */
  windowResetAt7d?: number;
  /** The derived rate (see `estimateBurnRatePerHr`); null = insufficient history. */
  burnRatePerHr: number | null;
  /** Epoch ms "now". */
  now: number;
}

const MS_PER_HR = 60 * 60_000;

/**
 * Estimate the net burn rate d(utilization7d)/dt (fraction per HOUR) by ordinary least-squares
 * over the usable samples. Pure. Returns null (never a guess) when the history cannot support
 * an estimate:
 *   - fewer than 2 usable samples (non-finite / future-dated junk is dropped);
 *   - all usable samples older than `policy.lookbackMs`;
 *   - the usable span is shorter than `policy.minSpanMs` (a fit over minutes extrapolated to
 *     hours amplifies reading noise into a fake trend).
 *
 * The rolling 7d meter already nets usage-in against usage-aging-out, so the fitted slope IS
 * the honest forward projection basis — a negative slope (decay outpacing spend) is returned
 * as-is, not clamped.
 *
 * Callers should append the FRESHEST reading (`{ at: utilizationAt, u: utilization7d }`) to the
 * retained history before calling: retention deliberately skips samples closer than the spacing
 * floor, so the newest point often lives only on the rate fields (see `accountBurnSamples`).
 */
export function estimateBurnRatePerHr(
  samples: readonly BurnSample[] | undefined,
  now: number,
  policy: BurnPolicy = DEFAULT_BURN_POLICY,
): number | null {
  const usable = (samples ?? [])
    .filter((s) => s && Number.isFinite(s.at) && Number.isFinite(s.u) && s.at <= now && now - s.at <= policy.lookbackMs)
    .sort((a, b) => a.at - b.at)
    // Collapse duplicate timestamps (e.g. the freshest reading re-appended over a retained twin).
    .filter((s, i, arr) => i === 0 || s.at !== arr[i - 1]!.at);
  if (usable.length < 2) return null;
  const span = usable[usable.length - 1]!.at - usable[0]!.at;
  if (span < policy.minSpanMs) return null;

  // Ordinary least squares, centered for numeric stability (epoch-ms x-values are ~1.7e12).
  const n = usable.length;
  const meanAt = usable.reduce((acc, s) => acc + s.at, 0) / n;
  const meanU = usable.reduce((acc, s) => acc + s.u, 0) / n;
  let num = 0;
  let den = 0;
  for (const s of usable) {
    const dx = s.at - meanAt;
    num += dx * (s.u - meanU);
    den += dx * dx;
  }
  if (den === 0) return null; // degenerate (all same timestamp) — unreachable after dedupe, kept as a guard
  return (num / den) * MS_PER_HR;
}

/**
 * Assemble the burn-sample series for one account's rate-shaped state: the retained history
 * plus the freshest reading (which retention's spacing floor may have skipped). Pure; tolerant
 * of a partially-hydrated row.
 */
export function accountBurnSamples(rate: {
  history7d?: BurnSample[];
  utilization7d?: number;
  utilizationAt?: number;
}): BurnSample[] {
  const base = (rate.history7d ?? []).filter((s) => s && Number.isFinite(s.at) && Number.isFinite(s.u));
  if (rate.utilization7d !== undefined && Number.isFinite(rate.utilization7d) && Number.isFinite(rate.utilizationAt)) {
    base.push({ at: rate.utilizationAt!, u: rate.utilization7d });
  }
  return base.sort((a, b) => a.at - b.at);
}

/**
 * The pure verdict: given the freshest reading, the (possibly unknown) window reset, the derived
 * burn rate, and the clock, decide whether this account's 7d window is on course to exhaust
 * before it resets — and what to do about it. Never acts on missing data (`action: 'none'` with
 * the gap named), and always states its reason.
 */
export function evaluateBurn(input: BurnInput, policy: BurnPolicy = DEFAULT_BURN_POLICY): BurnVerdict {
  const { utilization7d: u, windowResetAt7d: resetAt, burnRatePerHr: rate, now } = input;

  if (u === undefined || !Number.isFinite(u)) {
    return {
      burnRatePerHr: rate,
      headroomFraction: null,
      projectedExhaustionAt: null,
      exhaustsBeforeReset: false,
      action: 'none',
      utilization7d: null,
      disposition: 'no-verdict',
      reason: 'no 7d utilization reading — no verdict (never act on missing data)',
    };
  }

  const headroomFraction = Math.max(0, 1 - u);
  const resetUsable = resetAt !== undefined && Number.isFinite(resetAt) && resetAt > now;

  if (u >= BURN_EXHAUSTED_UTIL) {
    return {
      burnRatePerHr: rate,
      headroomFraction,
      projectedExhaustionAt: now,
      exhaustsBeforeReset: resetUsable,
      action: 'shed',
      utilization7d: u,
      // The provider's own meter says the window is spent — this one IS a measurement.
      disposition: 'measured-wall',
      reason: `7d window already exhausted (utilization ${u.toFixed(2)})${
        resetUsable ? ` — resets in ${fmtDurationMs(resetAt - now)}` : ' — reset unknown'
      }`,
    };
  }

  if (rate === null || !Number.isFinite(rate)) {
    return {
      burnRatePerHr: null,
      headroomFraction,
      projectedExhaustionAt: null,
      exhaustsBeforeReset: false,
      action: 'none',
      utilization7d: u,
      disposition: 'no-verdict',
      reason: 'insufficient burn history to estimate a rate — no verdict (never act on missing data)',
    };
  }

  if (rate <= 0) {
    return {
      burnRatePerHr: rate,
      headroomFraction,
      projectedExhaustionAt: null,
      exhaustsBeforeReset: false,
      action: 'none',
      utilization7d: u,
      disposition: 'no-verdict',
      reason: `7d window flat or decaying (${fmtRate(rate)}/hr) — headroom is not shrinking`,
    };
  }

  const hoursToExhaustion = (BURN_EXHAUSTED_UTIL - u) / rate;
  const projectedExhaustionAt = now + hoursToExhaustion * MS_PER_HR;
  const timeToExhaustMs = projectedExhaustionAt - now;
  const exhaustsBeforeReset = resetUsable && projectedExhaustionAt < resetAt;
  const imminent = timeToExhaustMs <= policy.imminentHorizonMs;

  const trajectory = `burning ${fmtRate(rate)}/hr at utilization ${u.toFixed(2)} — exhausts in ~${fmtDurationMs(timeToExhaustMs)}`;

  if (exhaustsBeforeReset && imminent) {
    return {
      burnRatePerHr: rate,
      headroomFraction,
      projectedExhaustionAt,
      exhaustsBeforeReset,
      action: 'shed',
      utilization7d: u,
      // Derived from the PROJECTION, not from a wall the provider imposed: the account is still
      // serviceable right now — this is us choosing not to spend into the wall.
      disposition: 'pacing-projection',
      reason: `${trajectory}, BEFORE the window resets (in ${fmtDurationMs(resetAt! - now)}) and inside the ${fmtDurationMs(policy.imminentHorizonMs)} imminent horizon`,
    };
  }
  if (exhaustsBeforeReset) {
    return {
      burnRatePerHr: rate,
      headroomFraction,
      projectedExhaustionAt,
      exhaustsBeforeReset,
      action: 'throttle',
      utilization7d: u,
      disposition: 'pacing-projection',
      reason: `${trajectory}, BEFORE the window resets (in ${fmtDurationMs(resetAt! - now)}) — prefer other accounts`,
    };
  }
  if (imminent && !resetUsable) {
    return {
      burnRatePerHr: rate,
      headroomFraction,
      projectedExhaustionAt,
      exhaustsBeforeReset: false,
      action: 'throttle',
      utilization7d: u,
      disposition: 'pacing-projection',
      reason: `${trajectory} with no usable window reset ${
        resetAt !== undefined ? '(observed reset is in the past — stale)' : '(never observed)'
      } — prefer other accounts`,
    };
  }
  return {
    burnRatePerHr: rate,
    headroomFraction,
    projectedExhaustionAt,
    exhaustsBeforeReset: false,
    action: 'none',
    utilization7d: u,
    disposition: 'no-verdict',
    reason: resetUsable
      ? `${trajectory}, AFTER the window resets (in ${fmtDurationMs(resetAt! - now)}) — the reset relieves first`
      : `${trajectory} — outside the ${fmtDurationMs(policy.imminentHorizonMs)} imminent horizon`,
  };
}

/**
 * Convenience: samples → rate → verdict in one call, for callers holding a rate-shaped account
 * row. Pure; equivalent to `evaluateBurn` over `estimateBurnRatePerHr(accountBurnSamples(...))`.
 */
export function evaluateAccountBurn(
  rate: { history7d?: BurnSample[]; utilization7d?: number; utilizationAt?: number; windowResetAt7d?: number },
  now: number,
  policy: BurnPolicy = DEFAULT_BURN_POLICY,
): BurnVerdict {
  return evaluateBurn(
    {
      utilization7d: rate.utilization7d,
      windowResetAt7d: rate.windowResetAt7d,
      burnRatePerHr: estimateBurnRatePerHr(accountBurnSamples(rate), now, policy),
      now,
    },
    policy,
  );
}

/**
 * One account's contribution to the pool verdict. Deliberately the action AND what it RESTS ON,
 * never the bare action (P-005): a rollup that takes `BurnAction[]` drops the disposition at its
 * INPUT boundary, so no amount of care downstream can restate it — the pool verdict then reads
 * `SHED` with no way to tell a provider wall from this system pacing itself.
 */
export type PoolBurnRow = Pick<BurnVerdict, 'action' | 'disposition'>;

/** Pool-level rollup of per-account burn verdicts (WI-41147 leg b — the concurrency lever's input). */
export interface PoolBurnAggregate {
  action: BurnAction;
  /** Accounts aggregated (the input length). */
  total: number;
  /** Per-action tally over the input. */
  counts: Record<BurnAction, number>;
  /**
   * What the POOL `action` rests on — the STRONGEST disposition among the accounts contributing
   * to it (`measured-wall` > `pacing-projection` > `no-verdict`), never a majority vote. Strongest
   * because the remedies do not average: one measured wall means part of the pool genuinely cannot
   * serve until its window resets, and softening that to `pacing-projection` because siblings are
   * projections would tell a reader to keep sending traffic at an exhausted account. `no-verdict`
   * whenever `action` is `none` — nothing is being asserted, so nothing rests on anything.
   *
   * This is the CONFIDENCE half of the answer and `action` is the REMEDY half — the two questions
   * P-004 learned not to gate on each other. The mix that produced it is never destroyed: read
   * `dispositionCounts` for how many of each.
   */
  disposition: BurnDisposition;
  /**
   * Per-disposition tally over the CONTRIBUTING accounts (those whose own action is not `none`),
   * so a mixed pool — 2 measured walls beside 4 pacing projections — stays legible after the
   * strongest-wins collapse above. All zero when `action` is `none` (no contributors).
   */
  dispositionCounts: Record<BurnDisposition, number>;
  /** Always populated — the WHY behind the pool verdict (never silent shedding). */
  reason: string;
  /**
   * The ONE canonical rendering of this pool verdict for any human- or agent-facing surface —
   * {@link renderPoolBurnLabel}. The pool-level sibling of `BurnVerdict`'s
   * `renderBurnVerdictLabel`: every writer interpolates this instead of composing its own
   * `pool burn 'shed'` string, so the disposition cannot be present on one surface and missing
   * on another (P-005).
   */
  label: string;
}

/** Strongest-first, so the collapse in {@link aggregatePoolBurn} is stated once and reused. */
const DISPOSITION_STRENGTH: readonly BurnDisposition[] = [
  'measured-wall',
  'pacing-projection',
  'no-verdict',
];

/**
 * The ONE rendering of a POOL burn verdict, leading with the disposition for the same reason
 * {@link renderBurnVerdictLabel} does: a `shed` derived entirely from projections is this system
 * pacing itself, and a reader who takes it for a provider wall reports the fleet as "at capacity"
 * when every account is still serving.
 */
export function renderPoolBurnLabel(agg: Pick<PoolBurnAggregate, 'action' | 'disposition' | 'dispositionCounts'>): string {
  const head = agg.action.toUpperCase();
  const c = agg.dispositionCounts;
  if (agg.disposition === 'measured-wall') {
    const rest = c['pacing-projection'] > 0 ? `, ${c['pacing-projection']} pacing projection(s)` : '';
    return `${head} (measured wall; ${c['measured-wall']} account(s) measured-walled${rest})`;
  }
  if (agg.disposition === 'pacing-projection') {
    return `${head} (pacing projection, not a measured wall; ${c['pacing-projection']} account(s) projected, 0 measured)`;
  }
  // `no-verdict` beside a NON-none action is not reachable from `evaluateBurn` (the two are
  // stamped together at one branch), but a hand-built aggregate can express it. Rendering that as
  // "no wall asserted" would state the opposite of the action it leads with, so say what is
  // actually true — the basis is missing. Mirrors burn-alert's own fallback wording.
  if (agg.action !== 'none') return `${head} (disposition unavailable)`;
  return `${head} (no wall asserted)`;
}

/**
 * Aggregate per-account burn actions into ONE pool verdict for the fleet-concurrency lever
 * (loop-pressure-governor). Selection (leg a) can only SPREAD load between accounts; when every
 * account is burning, spreading cannot reduce total spend — only cutting concurrency can. So the
 * pool verdict escalates only when routing has nowhere left to go:
 *   - `shed`     — EVERY account is shed: nowhere to route at all; cut concurrency now.
 *   - `throttle` — every account is throttle-or-shed (≥1 throttle): every route is burning;
 *                  spreading cannot relieve the pool — slow the fleet.
 *   - `none`     — any account still has headroom OR no usable verdict (per-account `none`
 *                  covers both healthy and no-data, and the stale gate maps stale readings to
 *                  `none`) — selection can route around the burn; the concurrency lever stands
 *                  down. Empty pool ⇒ `none` (never act on missing data).
 * Pure; deliberately conservative — a single unknown/healthy account stands the lever down.
 *
 * Takes VERDICT ROWS, not bare actions (P-005). The bare-action signature it replaced could not
 * state what the pool verdict rested on, so `pool burn 'shed'` reached the fleet-concurrency lever
 * and the operator log with the measured-vs-projected distinction already destroyed.
 */
export function aggregatePoolBurn(rows: readonly PoolBurnRow[]): PoolBurnAggregate {
  const counts: Record<BurnAction, number> = { none: 0, throttle: 0, shed: 0 };
  for (const r of rows) counts[r.action] += 1;
  const total = rows.length;

  // Only the accounts actually asserting a burn get a vote on what the pool verdict rests on: a
  // healthy account's 'no-verdict' is the ABSENCE of an assertion, and counting it would dilute a
  // real measured wall toward "nothing is measured".
  const dispositionCounts: Record<BurnDisposition, number> = {
    'measured-wall': 0,
    'pacing-projection': 0,
    'no-verdict': 0,
  };
  for (const r of rows) if (r.action !== 'none') dispositionCounts[r.disposition] += 1;

  /** The strongest disposition any CONTRIBUTING account asserted — see the field's docs. */
  const restsOn = (): BurnDisposition =>
    DISPOSITION_STRENGTH.find((d) => dispositionCounts[d] > 0) ?? 'no-verdict';

  const finish = (
    decided: Pick<PoolBurnAggregate, 'action' | 'disposition' | 'reason'>,
  ): PoolBurnAggregate => {
    const base = {
      ...decided,
      total,
      counts,
      // Nothing is being asserted, so nothing contributed to it — never report a stale tally
      // beside a `none` verdict.
      dispositionCounts:
        decided.action === 'none'
          ? { 'measured-wall': 0, 'pacing-projection': 0, 'no-verdict': 0 }
          : dispositionCounts,
    };
    return { ...base, label: renderPoolBurnLabel(base) };
  };

  // Each branch states its own disposition beside its own action, for the reason P-001 gives at
  // the per-account level: stamp it where the action is DECIDED, never re-derive it afterwards
  // from a second predicate that can disagree with the branch that ran.
  if (total === 0) {
    return finish({
      action: 'none',
      disposition: 'no-verdict',
      reason: 'no accounts in pool — governor stands down (never act on missing data)',
    });
  }
  if (counts.shed === total) {
    return finish({
      action: 'shed',
      disposition: restsOn(),
      reason: `all ${total} account(s) shed — nowhere to route; cut fleet concurrency`,
    });
  }
  if (counts.none === 0) {
    return finish({
      action: 'throttle',
      disposition: restsOn(),
      reason: `every account is burning (${counts.throttle} throttle, ${counts.shed} shed of ${total}) — spreading cannot relieve the pool; slow the fleet`,
    });
  }
  return finish({
    action: 'none',
    disposition: 'no-verdict',
    reason: `${counts.none} of ${total} account(s) have headroom or no verdict — selection can route around the burn`,
  });
}

function fmtRate(rate: number): string {
  return `${rate >= 0 ? '+' : ''}${(rate * 100).toFixed(1)}pp`;
}

function fmtDurationMs(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 48) return `${Math.round(h / 24)}d`;
  return h > 0 ? `${h}h${m > 0 ? `${m}m` : ''}` : `${m}m`;
}
