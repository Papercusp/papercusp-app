/**
 * pair-launch-options — the TYPE-CONDITIONAL launch option contract
 * (directed-pair-work-items-2026-08-25 D-008 / D-009 / D-012, P-011).
 *
 * The option schema BRANCHES on the fleet type; it does not merge into one
 * superset with optional per-role fields:
 *
 *   type:'single'  → today's FLAT knob set, completely unchanged. No per-role
 *                    nesting, no new required fields. Every existing caller and
 *                    every existing habit keeps working untouched.
 *   type:'paired'  → the same knobs as two per-role GROUPS, `directors` and
 *                    `implementers`, each independent (D-009), plus a top-level
 *                    `count` that means PAIRS (D-012).
 *
 * A launch whose option shape does not match its declared type is REJECTED with
 * `invalid_args` naming the expected shape — never coerced. That refusal is the
 * point of the module: coercion is exactly how a flat `model` meant for the
 * implementers gets broadcast to both roles and you end up paying top-tier rates
 * for a fleet of directors, with nothing in the result saying so.
 *
 * Pure and side-effect free on purpose — the branch is the part worth pinning
 * with tests, and it should be provable without opening a terminal.
 */
import type { FleetType } from '../../agent-fleets-store';

/** Knobs that are meaningful PER ROLE in a paired fleet (D-009). */
export const PER_ROLE_KNOBS = [
  'agent',
  'model',
  'effort',
  'headless',
  'account',
  'carry',
] as const;

export type PerRoleKnob = (typeof PER_ROLE_KNOBS)[number];

/** One role's slice of the launch configuration. */
export interface RoleLaunchOptions {
  agent?: 'claude' | 'omp' | 'codex';
  model?: string;
  effort?: string;
  headless?: boolean;
  account?: string;
  carry?: 'warm' | 'cold';
}

/**
 * The caller-facing shape, before branching. Every field is optional here
 * because which ones are LEGAL depends on `type` — that is the whole contract,
 * and it is enforced by resolveLaunchOptions rather than by the zod schema
 * (zod cannot express "these fields are mutually exclusive with those, keyed on
 * the value of a third" without collapsing the two arms into a union whose error
 * messages name neither shape).
 */
export interface LaunchOptionInput extends RoleLaunchOptions {
  type?: FleetType;
  count?: number;
  directors?: RoleLaunchOptions & { count?: number };
  implementers?: RoleLaunchOptions & { count?: number };
}

export interface ResolvedSingleLaunch {
  ok: true;
  type: 'single';
  /** Pair count is meaningless for a single fleet. */
  pairs: null;
  /** The flat knobs, passed through untouched. */
  flat: RoleLaunchOptions;
}

export interface ResolvedPairedLaunch {
  ok: true;
  type: 'paired';
  /** Number of PAIRS (D-012). Total members = pairs * 2. */
  pairs: number | null;
  directors: RoleLaunchOptions;
  implementers: RoleLaunchOptions;
}

export interface RejectedLaunch {
  ok: false;
  error: 'invalid_args';
  /** Machine-readable reason, so a caller can branch without regex-ing prose. */
  reason:
    | 'per_role_groups_on_single_fleet'
    | 'flat_knobs_on_paired_fleet'
    | 'count_inside_role_group'
    | 'no_roles_configured';
  message: string;
  /** The offending field paths, so the caller does not have to guess which one. */
  offending: string[];
  /** A one-line sketch of the shape this type actually accepts. */
  expectedShape: string;
}

export type ResolvedLaunchOptions =
  | ResolvedSingleLaunch
  | ResolvedPairedLaunch
  | RejectedLaunch;

const SINGLE_SHAPE =
  "type:'single' → flat knobs: { count, agent, model, effort, headless, account, carry }";
const PAIRED_SHAPE =
  "type:'paired' → { count /* = number of PAIRS */, directors:{ agent, model, effort, headless, account, carry }, implementers:{ …same } }";

function presentKnobs(source: RoleLaunchOptions, prefix = ''): string[] {
  return PER_ROLE_KNOBS.filter((k) => source[k] !== undefined).map((k) => `${prefix}${k}`);
}

function pickRole(source: RoleLaunchOptions | undefined): RoleLaunchOptions {
  if (!source) return {};
  const out: RoleLaunchOptions = {};
  for (const k of PER_ROLE_KNOBS) {
    if (source[k] !== undefined) (out as Record<string, unknown>)[k] = source[k];
  }
  return out;
}

/**
 * Branch the launch options on the declared fleet type, or refuse.
 *
 * `type` omitted is treated as 'single' — the default must stay invisible, so
 * that no existing caller has to learn the field exists.
 */
export function resolveLaunchOptions(input: LaunchOptionInput): ResolvedLaunchOptions {
  const type: FleetType = input.type === 'paired' ? 'paired' : 'single';

  if (type === 'single') {
    // The single arm rejects exactly one thing: per-role groups, which are
    // meaningless without pairs. Accepting them silently would let a caller
    // believe they had configured two roles on a fleet that has only one.
    const offending = (['directors', 'implementers'] as const).filter(
      (g) => input[g] !== undefined,
    );
    if (offending.length > 0) {
      return {
        ok: false,
        error: 'invalid_args',
        reason: 'per_role_groups_on_single_fleet',
        message:
          `Per-role launch groups (${offending.join(', ')}) are only valid on a paired fleet. ` +
          `This launch is type:'single'${input.type === undefined ? " (the default — you did not pass `type`)" : ''}, ` +
          `whose members are configured by the FLAT knobs. ` +
          `Pass type:'paired' to launch director↔implementer pairs, or move these settings to the flat knobs. ` +
          SINGLE_SHAPE,
        offending,
        expectedShape: SINGLE_SHAPE,
      };
    }
    return { ok: true, type: 'single', pairs: null, flat: pickRole(input) };
  }

  // --- paired ---------------------------------------------------------------

  // A per-role `count` cannot be honoured (D-012: pairs are 1:1, so N lives at
  // the top level) and must not be ignored either — a caller who wrote
  // implementers:{count:3} believes something specific about the fleet they are
  // about to open.
  const countOffenders = (['directors', 'implementers'] as const)
    .filter((g) => input[g]?.count !== undefined)
    .map((g) => `${g}.count`);
  if (countOffenders.length > 0) {
    return {
      ok: false,
      error: 'invalid_args',
      reason: 'count_inside_role_group',
      message:
        `${countOffenders.join(' and ')} is not accepted: a paired fleet is 1:1, so the pair count lives at the TOP level (D-012). ` +
        `Pass count:<pairs> instead — count:3 opens 3 directors, 3 implementers, 6 members and 3 couplings. ` +
        PAIRED_SHAPE,
      offending: countOffenders,
      expectedShape: PAIRED_SHAPE,
    };
  }

  // Flat per-role knobs alongside type:'paired' are the dangerous case: coerced,
  // they would broadcast one value to BOTH roles, silently defeating the whole
  // point of per-role configuration (D-006: the director wants the top tier, the
  // implementer can be cheaper).
  const flatOffenders = presentKnobs(input);
  if (flatOffenders.length > 0) {
    return {
      ok: false,
      error: 'invalid_args',
      reason: 'flat_knobs_on_paired_fleet',
      message:
        `Flat per-member knobs (${flatOffenders.join(', ')}) are not accepted on a paired fleet: ` +
        `they would have to be broadcast to BOTH roles, which is exactly the coercion the type-conditional ` +
        `schema exists to prevent (a flat model meant for the implementers turns into a fleet of directors ` +
        `running it). Put each value in directors:{…} and/or implementers:{…} — repeat it in both if you ` +
        `genuinely want the roles configured identically. ` +
        PAIRED_SHAPE,
      offending: flatOffenders,
      expectedShape: PAIRED_SHAPE,
    };
  }

  const directors = pickRole(input.directors);
  const implementers = pickRole(input.implementers);
  // PRESENCE, not emptiness. `directors:{}` is a deliberate "this role runs on
  // the defaults" — refusing it would contradict the very repair this refusal
  // recommends. Only a launch that mentions neither group is the half-finished
  // call worth stopping.
  if (input.directors === undefined && input.implementers === undefined) {
    return {
      ok: false,
      error: 'invalid_args',
      reason: 'no_roles_configured',
      message:
        `type:'paired' was declared but neither directors:{…} nor implementers:{…} was configured. ` +
        `A paired launch that configures no role is almost always a half-finished call — if you really want ` +
        `both roles on the defaults, say so explicitly with directors:{} and implementers:{}. ` +
        PAIRED_SHAPE,
      offending: ['directors', 'implementers'],
      expectedShape: PAIRED_SHAPE,
    };
  }

  return {
    ok: true,
    type: 'paired',
    pairs: input.count ?? null,
    directors,
    implementers,
  };
}

/** psu --role for each half of a pair. P-001 / P-002 author these personas. */
export const PAIR_ROLE_DIRECTOR = 'pair-director';
export const PAIR_ROLE_IMPLEMENTER = 'directed-implementer';

/**
 * Seat ordering inside a paired launch is INTERLEAVED (D-014): seat 2k is the
 * DIRECTOR of pair k, seat 2k+1 is its IMPLEMENTER.
 *
 * The alternative — blocked (`d,d,…,i,i,…`) — is what you reach for first, and
 * it is wrong here for one decisive reason: **launch waves get clamped.** Both
 * the capacity clamp and MAX_MEMBERS routinely open fewer seats than asked.
 * Under interleaving a truncated wave degrades to FEWER WHOLE PAIRS, which is a
 * smaller version of the thing the caller asked for. Under blocking it degrades
 * to all-directors-and-no-implementers: every seat opens, nothing can be
 * coupled, and the fleet is silently useless in a way `openCount` still reports
 * as success.
 *
 * Interleaving also makes pair identity derivable from the index ALONE, which is
 * what the auto-coupling (P-012) consumes — no side table, and nothing to keep
 * in sync when a member is respawned into an existing seat.
 */
export function pairSeatRole(seat: number): 'director' | 'implementer' {
  return seat % 2 === 0 ? 'director' : 'implementer';
}

/** Which pair seat `seat` belongs to. Seats 0,1 → pair 0; seats 2,3 → pair 1. */
export function pairIndexOfSeat(seat: number): number {
  return Math.floor(seat / 2);
}

/**
 * Round a requested seat count DOWN to whole pairs.
 *
 * A lone director with no implementer is not a degraded pair, it is a broken
 * one: it has nobody to direct, and the implementer-side tool denials mean it
 * cannot fall back to doing the work itself. So an odd seat allowance opens one
 * fewer seat rather than one half-pair — and callers are told, because silently
 * opening `count-1` seats is how a clamp becomes a mystery.
 */
export function wholePairSeats(requestedSeats: number): number {
  if (!Number.isFinite(requestedSeats) || requestedSeats < 2) return 0;
  return Math.floor(requestedSeats / 2) * 2;
}

/**
 * The per-member override list for a paired launch, in seat order.
 *
 * This is deliberately expressed as the SAME `members: MemberSpec[]` per-member
 * override mechanism a single fleet already uses (per-member-declarative-launch-
 * specs P-002), not as a second member-command path. The paired arm therefore
 * inherits every downstream behaviour for free — the member>fleet>system
 * precedence fold, launch-context composition, the attestation records, the
 * saved-launch-spec round trip — and there is exactly one place where a member
 * command is built, so the two arms cannot drift.
 *
 * Returns a structurally MemberSpec-compatible list; the caller folds it over
 * the fleet defaults.
 */
export function expandPairedMembers(
  resolved: ResolvedPairedLaunch,
  seats: number,
): Array<RoleLaunchOptions & { role: string }> {
  const usable = wholePairSeats(seats);
  return Array.from({ length: usable }, (_v, seat) => {
    const isDirector = pairSeatRole(seat) === 'director';
    const role = isDirector ? PAIR_ROLE_DIRECTOR : PAIR_ROLE_IMPLEMENTER;
    const slice = isDirector ? resolved.directors : resolved.implementers;
    // Only DEFINED knobs are emitted: an unset per-role field must fall through
    // to the fleet default, never zero it (the D-001 precedence rule the fold
    // implements). Spreading the slice wholesale would be enough today, but
    // pickRole already guarantees no undefined keys — keep it explicit so a
    // later field addition cannot smuggle an `undefined` into the override.
    return { ...pickRole(slice), role };
  });
}

/** One director↔implementer edge the launch should declare (P-012). */
export interface PairToCouple {
  pairIndex: number;
  director: string;
  implementer: string;
}

/**
 * Which pairs are ready to be COUPLED, given the members that actually opened
 * (P-012). `seatOwners` maps an ABSOLUTE seat index to the owner id that opened
 * in it — absolute, because a top-up wave opens seats `liveMembers + i` and pair
 * identity is a property of the fleet, not of the wave.
 *
 * A pair is emitted only when BOTH of its seats are present. That is the whole
 * job: a launch wave can be clamped, a terminal can fail to open, and a member
 * can fail verification, so half a pair really does occur. Coupling a director
 * to a member that never opened would create a dangling edge that reads, on
 * every later coupling-expanded roster, exactly like a healthy pair — and the
 * missing half is the failure you most need to see. Skipping is what makes the
 * absence visible instead.
 *
 * Seats belonging to an EARLIER wave are naturally skipped by the same rule:
 * their partner is not in this wave's map, and they were coupled when they
 * opened.
 */
export function pairsToCouple(seatOwners: ReadonlyMap<number, string>): PairToCouple[] {
  const out: PairToCouple[] = [];
  const seen = new Set<number>();
  for (const seat of [...seatOwners.keys()].sort((a, b) => a - b)) {
    const pairIndex = pairIndexOfSeat(seat);
    if (seen.has(pairIndex)) continue;
    seen.add(pairIndex);
    const director = seatOwners.get(pairIndex * 2);
    const implementer = seatOwners.get(pairIndex * 2 + 1);
    if (!director || !implementer) continue;
    out.push({ pairIndex, director, implementer });
  }
  return out;
}

/** One implementer seat that must be confined before it is spawned (P-004). */
export interface ImplementerToConfine {
  pairIndex: number;
  seat: number;
  implementer: string;
  /**
   * The coupled director, when its seat is in this wave — named verbatim in the
   * implementer's refusals. `null` when the director opened in an earlier wave, which
   * costs the refusal a name but never the confinement itself.
   */
  director: string | null;
}

/**
 * Which seats in this wave are IMPLEMENTERS, so the launch can declare their confinement
 * before spawning them (P-004 / D-017 §4). Same absolute-seat convention as
 * `pairsToCouple`.
 *
 * ⚠ THE INCOMPLETE-PAIR POLICY IS THE OPPOSITE OF `pairsToCouple`'s, ON PURPOSE. Coupling
 * SKIPS a half-open pair, because a dangling edge renders on every later roster as a
 * healthy pair and hides the missing half. Confinement must NOT skip: the failure mode
 * here is an implementer running UNCONFINED — free to complete its own work items and arm
 * its own loops, which is precisely the theatre D-015 was written to end — and that failure
 * is invisible, because an unconfined session looks exactly like a session with nothing to
 * deny. So an implementer whose director is absent is still confined; only the director's
 * NAME in the refusal text is lost.
 */
export function implementersToConfine(
  seatOwners: ReadonlyMap<number, string>,
): ImplementerToConfine[] {
  const out: ImplementerToConfine[] = [];
  for (const seat of [...seatOwners.keys()].sort((a, b) => a - b)) {
    if (pairSeatRole(seat) !== 'implementer') continue;
    const implementer = seatOwners.get(seat);
    if (!implementer) continue;
    const pairIndex = pairIndexOfSeat(seat);
    out.push({
      pairIndex,
      seat,
      implementer,
      director: seatOwners.get(pairIndex * 2) ?? null,
    });
  }
  return out;
}

/**
 * The spawn-announcement line(s) the persona rule requires. A paired launch owes
 * the owner ONE LINE PER ROLE (account + model + carry), not a merged summary —
 * a merged one is unreadable exactly when the roles differ, which is the case
 * the announcement exists for.
 */
export function describeLaunchRoles(
  resolved: ResolvedSingleLaunch | ResolvedPairedLaunch,
): string[] {
  const line = (label: string, o: RoleLaunchOptions): string =>
    `${label}: model ${o.model ?? '(default)'}` +
    (o.effort ? `:${o.effort}` : '') +
    ` · account ${o.account ?? 'default (system)'}` +
    ` · carry ${o.carry ?? 'warm'}` +
    ` · ${o.headless ? 'headless' : 'visible'}`;

  if (resolved.type === 'single') return [line('members', resolved.flat)];
  const n = resolved.pairs;
  return [
    `${n ?? '?'} pair(s) — ${n == null ? '' : `${n * 2} members total, `}each pair coupled at launch`,
    line('directors', resolved.directors),
    line('implementers', resolved.implementers),
  ];
}
