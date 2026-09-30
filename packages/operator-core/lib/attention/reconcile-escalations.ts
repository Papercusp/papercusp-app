/**
 * reconcile-escalations — the attention-queue reconciliation sweep
 * (queue-pending-accuracy-and-drift P-003/P-005, D-002/D-003).
 *
 * The drift it kills: OPERATIONAL escalations (placement-watchdog cursed
 * placements, aging sweeps — `from: system[:…]`, no options) are emitted en
 * masse and almost never resolved (live: ~7000 opened, ~135 resolved), so they
 * accumulate forever. The reader already DEMOTES them out of "waiting on you"
 * (isOperationalEscalation → alert tier), but they still pile up in the alert
 * list. This sweep auto-resolves the stale ones so the queue stays a projection
 * of live reality WITHOUT relying on any agent remembering to resolve them.
 *
 * Why a TTL and not a per-unit liveness check: an operational escalation is a
 * redundant duplicate of a DERIVED health metric (`placements.cursed`) — that
 * metric, not the escalation, is the source of truth for current state (D-003).
 * So an operational escalation idle past the TTL is, by construction, stale: the
 * live state is still shown by the metric; the escalation is just un-GC'd noise.
 *
 * WI-36154 bounds that premise: it holds only where the row is a DUPLICATE of
 * the live signal. Where the open row is itself the SUPPRESSOR that stops an
 * alarm re-firing, resolving it re-arms the alarm instead of tidying a duplicate
 * — so a row whose EMITTER owns its lifecycle is exempt (see isEmitterOwnedRow).
 *
 * GENUINE human decisions (non-system sender, or carrying options) are NEVER
 * selected — a human must clear those (that is what `coord:resolve` is for).
 */

import { isOperationalEscalation } from './adapters';
import { listEscalations, resolveEscalationsBatch } from '../agent-tools/coordination/escalations';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import { getPresence, listPresence } from '../agent-tools/coordination/presence';
import { fetchPresenceFleet } from '../agent-tools/coordination/presence-fleet';
import { sendMessage } from '../agent-tools/coordination/messages';
import {
  ESCALATION_SLA_REROUTE_WAKE_SOURCE,
  wakeRecipients,
} from '../agent-tools/coordination/inbox-wake';
import { coordLog, coordSql, coordWorkspaceId, coordHasPgFastPath } from '../agent-tools/coordination/log';
import { AGENT_SESSION_SENDER_PATTERN } from '../agent-tools/coordination/machine-authored';
import { readEvidence } from '../agent-tools/coordination/relay-provenance';
import {
  parseEscalationPredicate,
  revalidateEscalationPredicate,
  validateEscalationArtifactRef,
  type EscalationArtifactValidation,
  type EscalationPredicate,
  type EscalationPredicateValidation,
} from '../agent-tools/coordination/tools/escalate';
import { getFleet } from '../agent-fleets-store';
import { listLoopStanddownOwners } from '../harness/routines/release-pause-ttl';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { classifyItemActivity, isActivelyWorked } from '../item-activity';
import { getWorkItem, TERMINAL_WORK_ITEM_STATES } from '../work-items';

/** Resolver identity stamped on auto-reconciled escalations (audit trail). */
export const RECONCILE_OWNER = 'system:attention-reconcile';

/**
 * Default TTL for OPERATIONAL escalations: 48h. Override via env. Lowered from 3d
 * (infra-perf-robustness-audit-2026-06-18 D-005): operational escalations are
 * redundant duplicates of the derived `placements.cursed` health metric (D-003),
 * so a shorter idle window is safe — and a 3d window let a placement-watchdog burst
 * pile ~12k stale escalations into the alert tier (drowning ~89 real decisions in
 * the human attention feed) before they aged out. 48h still leaves ~2 days for any
 * genuinely-current operational state to surface.
 */
export const OPERATIONAL_ESCALATION_TTL_MS = (() => {
  const env = Number(process.env.PAPERCUSP_OPERATIONAL_ESCALATION_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : 2 * 24 * 60 * 60 * 1000;
})();

/** Max escalations resolved per sweep tick. Raised 500→2500 (infra audit D-005):
 *  EI-1490 made a tick batch-resolve from a SINGLE coord-log load (no longer O(n²)),
 *  so a larger batch is cheap, and it lets the hourly sweep actually drain a large
 *  backlog (e.g. a watchdog burst) within a few ticks instead of accumulating. */
export const RECONCILE_BATCH_LIMIT = 2500;

export interface StaleEscalationInput {
  msg_id: string;
  from?: string | null;
  options?: readonly unknown[];
  /** ISO timestamp the escalation was opened. */
  ts: string;
  /** Flat metadata stamped by coord:escalate for later validation. */
  escalationPredicate?: unknown;
  predicateValidation?: unknown;
  evidence?: unknown;
  evidenceValidation?: unknown;
  /**
   * WI-36154: the infra-liveness alarm's stable signal key, stamped into `meta`
   * by liveness-alarm.ts and FLATTENED onto the record (escalations.ts:190
   * `Object.assign(env, input.meta)`), so it arrives as a top-level field on
   * every read path — the projection returns the stored `body` whole, and the
   * event-fold spreads it (`{ ...open, resolved }`). Typed `unknown` because it
   * reaches us from jsonb: only a non-empty string counts (see isLivenessSuppressor).
   */
  livenessSignature?: unknown;
  /**
   * WI-36214: the emitter's explicit declaration that it OWNS this row's
   * lifecycle — it skips re-firing while the row is open, and resolves the row
   * itself when the condition clears. See SELF_RECONCILING_META_KEY.
   */
  selfReconciling?: unknown;
}

/**
 * WI-36214: the meta key an emitter stamps to opt a row OUT of the TTL sweep.
 *
 * Stamp it ONLY when BOTH legs hold, because each defeats a different half of
 * the sweep's premise:
 *   1. the emitter SKIPS firing while one of its rows is open (so GC'ing the
 *      row does not tidy a duplicate — it RE-ARMS the alarm), and
 *   2. the emitter RESOLVES the row itself once the condition clears (so the
 *      TTL is not needed as a backstop against an immortal row).
 *
 * Deliberately OPT-IN rather than inferred. The tempting inference — "this
 * emitter also calls resolveEscalation, so it reconciles its own rows" — is
 * WRONG and expensive: `pot/placement-watchdog.ts` both opens and resolves, but
 * opens one row PER CURSED PLACEMENT with no such gate. It is the mass-emitter
 * this whole sweep was built for (~7000 opened / ~135 resolved; a 3d window once
 * let ~12k pile into the alert tier), so inferring the exemption would resurrect
 * exactly the flood the sweep exists to kill.
 */
export const SELF_RECONCILING_META_KEY = 'selfReconciling';

/**
 * WI-36154/WI-36214: is this row its own emitter's SUPPRESSOR — i.e. would
 * resolving it re-arm an alarm whose condition is still true?
 *
 * Two legs, both anchored to an EXPLICIT stamp:
 *   - `selfReconciling === true` — the general marker (WI-36214);
 *   - a non-empty `livenessSignature` — the infra-liveness alarm's pre-existing
 *     stamp, retained so rows ALREADY OPEN (and any written by a not-yet-updated
 *     worker) stay protected without waiting to be re-emitted.
 *
 * Deliberately NOT `livenessSignatureOf()`, whose summary-derivation fallback
 * ends in a catch-all `"<panel label>: <...>"` match: that heuristic would
 * silently extend the exemption across unrelated operational rows. The exclusion
 * is anchored to the property that DEFINES membership (this row is an alarm's
 * own suppressor), never to how a summary happens to read.
 */
export function isEmitterOwnedRow(
  e: Pick<StaleEscalationInput, 'livenessSignature' | 'selfReconciling'>,
): boolean {
  if (e.selfReconciling === true) return true;
  return typeof e.livenessSignature === 'string' && e.livenessSignature.length > 0;
}

export interface StaleEscalation {
  msg_id: string;
  ageDays: number;
  /** WI-2140594: set by the unanswerable selector — the row carried options (a real choice) that went unmade. */
  hasOptions?: boolean;
}

/**
 * PURE: which OPEN escalations are stale (auto-resolvable) — operational
 * (system sender, no options), NOT an emitter-owned suppressor row
 * (WI-36154/WI-36214), AND opened older than `ttlMs`. Sorted oldest first so a
 * batch-limited sweep
 * drains the longest-stale first.
 */
export function selectStaleEscalations(
  opens: readonly StaleEscalationInput[],
  ctx: { nowMs: number; ttlMs?: number },
): StaleEscalation[] {
  const ttl = ctx.ttlMs ?? OPERATIONAL_ESCALATION_TTL_MS;
  const out: StaleEscalation[] = [];
  for (const e of opens) {
    if (!isOperationalEscalation(e.from, (e.options?.length ?? 0) > 0)) continue;
    // WI-36154: the TTL premise (a row is a redundant duplicate of a derived
    // metric) is FALSE where the ROW IS THE SUPPRESSOR. liveness-alarm.ts:1552
    // buckets open escalations by signature and SKIPS firing a signal that
    // already has one open, so resolving that row does not clean up a duplicate
    // — it RE-ARMS the alarm while its condition is still true.
    //
    // MEASURED 14d: 5 of 5 idle-2d auto-resolves carrying a livenessSignature
    // re-fired within 120s (stale-paused-routines 3/3, rubric-emission-dark
    // 2/2) — the sweep was running the alarm as a ~2-day notification
    // scheduler. WI-36214: re-running that probe against the 366 rows the
    // exemption LEFT BEHIND found 6 more, all `system:escalation-aging-alarm`
    // (escalation-aging-alarm.ts:167 — same gate, no livenessSignature), so the
    // exclusion is now keyed on an explicit opt-in marker any such emitter can
    // stamp. Still narrow BY MEASUREMENT: 11 of 371 idle-2d resolves in 14d.
    if (isEmitterOwnedRow(e)) continue;
    const openedMs = Date.parse(e.ts);
    if (!Number.isFinite(openedMs)) continue;
    const ageMs = ctx.nowMs - openedMs;
    if (ageMs >= ttl) out.push({ msg_id: e.msg_id, ageDays: ageMs / 86_400_000 });
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

export interface ReconcileResult {
  scanned: number;
  stale: number;
  resolved: number;
  /** True when the backlog exceeded the batch limit (more remain for next tick). */
  truncated: boolean;
  /**
   * WHICH BRANCH produced this result (WI-7397). Required, not optional, on
   * purpose: a caller must not be able to ignore the difference.
   *
   * The dead-author pass has a fail-safe that resolves NOTHING when a liveness
   * read throws. That is correct — a degraded read must never read as "everyone
   * is gone" — but before WI-7397 it returned a value IDENTICAL to the healthy
   * "nothing was eligible" case, so a permanently-degraded reaper was
   * indistinguishable from one with no work to do, forever and silently.
   *
   *  - 'swept'         — the pass ran to completion (`resolved` may still be 0)
   *  - 'no-candidates' — nothing was eligible this tick; healthy
   *  - 'aborted'       — a liveness/presence read THREW; nothing was resolved
   */
  outcome: 'swept' | 'no-candidates' | 'aborted';
}

/**
 * One reconciliation pass: load open escalations, resolve the stale operational
 * ones (up to the batch limit). Idempotent — an already-resolved escalation is a
 * no-op, so re-running is safe.
 */
export async function reconcileStaleEscalationsOnce(
  opts: { nowMs?: number; ttlMs?: number; limit?: number } = {},
): Promise<ReconcileResult> {
  const opens = (await listEscalations({ status: 'open' })) as unknown as StaleEscalationInput[];
  const nowMs = opts.nowMs ?? Date.now();
  const stale = selectStaleEscalations(opens, { nowMs, ttlMs: opts.ttlMs });
  const limit = opts.limit ?? RECONCILE_BATCH_LIMIT;
  const batch = stale.slice(0, limit);

  // EI-1490: resolve the whole batch from a SINGLE load of the escalation log.
  // The per-item `resolveEscalation` re-read the entire surface every call
  // (O(n²) over the ~13k operational backlog), so a tick drained only a fraction
  // of its batch before the step budget — the lane never actually emptied.
  const resolved =
    batch.length === 0
      ? 0
      : (
          await resolveEscalationsBatch(
            batch.map((s) => ({
              msg_id: s.msg_id,
              choice: 'auto-reconciled',
              resolver: RECONCILE_OWNER,
              note: `auto-resolved: operational escalation idle ${Math.round(s.ageDays)}d — live state is the derived health metric (queue-pending-accuracy P-003/P-005)`,
            })),
          )
        ).resolved;

  return {
    scanned: opens.length,
    stale: stale.length,
    resolved,
    truncated: stale.length > batch.length,
    outcome: 'swept',
  };
}

// ─── EI-19411323991062966: unanswerable escalations from DEAD authors ─────────
//
// The sweep above deliberately never touches NON-operational escalations — an
// agent- or session-authored escalation reads as a genuine human decision, and
// auto-closing a live agent's ask would be wrong. That default is right for a
// LIVE author and wrong for a DEAD one: an escalation whose author no longer
// exists can never be answered by that author, and no code path closes it. They
// are immortal by construction.
//
// MEASURED 2026-08-03: 365 of 550 open rows were non-operational, 304 of them
// past 48h, oldest 2026-06-15 — 66% of the open set and the OLDEST rows, so they
// sit at the FRONT of every oldest-first bounded page. That is the standing
// reason the 500-row read cap gets approached at all (the cap that silently
// starved condition-staleness's own auto-resolve leg in EI-19403159016550818).
//
// The discriminator is AUTHOR LIVENESS, not author identity. Deliberately NOT
// done by widening isOperationalEscalation: that set's comment rightly forbids
// adding an agent alias, because a live bee's escalation can be a genuine ask.

/**
 * TTL for NON-operational escalations before the dead-author reaper considers
 * them. Deliberately much longer than OPERATIONAL_ESCALATION_TTL_MS: these are
 * human-shaped asks, so age alone is never sufficient — it is only the window
 * after which a *provably absent* author makes the row unanswerable.
 */
export const UNANSWERABLE_ESCALATION_TTL_MS = (() => {
  const env = Number(process.env.PAPERCUSP_UNANSWERABLE_ESCALATION_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : 7 * 24 * 60 * 60 * 1000;
})();

/**
 * TTL for OPTION-CARRYING escalations from a requester with an EXPLICIT
 * ended/recorded verdict (WI-2140594). Longer than the option-less window on
 * purpose: a row with options is a real choice, so it is reaped only when BOTH
 * legs are beyond doubt — the requester is PROVEN gone (never merely absent from
 * presence) and the choice has sat unmade for twice the option-less window.
 * Measured 2026-09-01: 114 such rows from 104 ended agent sessions, 9–79 days
 * old, were the only permanently-stuck class in the 783-row backlog — every
 * reaper excluded them by design, so nothing could ever close them, while the
 * requester that would have consumed the choice no longer existed.
 */
export const UNANSWERABLE_CHOICE_ESCALATION_TTL_MS = (() => {
  const env = Number(process.env.PAPERCUSP_UNANSWERABLE_CHOICE_ESCALATION_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : 14 * 24 * 60 * 60 * 1000;
})();

interface UnanswerableWindow {
  nowMs: number;
  /** Window for option-less rows. */
  ttlMs: number;
  /** Window for option-carrying rows — longer, and only ever paired with an explicit verdict. */
  choiceTtlMs: number;
}

function hasChoice(e: Pick<StaleEscalationInput, 'options'>): boolean {
  return (e.options?.length ?? 0) > 0;
}

/**
 * Structural pre-filter: could this row EVER be reaped as unanswerable? Excludes
 * operational rows (the TTL sweep above owns those), a blank sender, and anything
 * inside its window — `ttlMs` for an option-less row, the longer `choiceTtlMs`
 * for one carrying options. Author liveness is NOT consulted here — this is the
 * cheap filter that decides whom we bother probing.
 */
function isUnanswerableCandidate(e: StaleEscalationInput, w: UnanswerableWindow): boolean {
  const choice = hasChoice(e);
  if (isOperationalEscalation(e.from, choice)) return false;
  const from = typeof e.from === 'string' ? e.from.trim() : '';
  if (!from) return false;
  const openedMs = Date.parse(e.ts);
  if (!Number.isFinite(openedMs)) return false;
  return w.nowMs - openedMs >= (choice ? w.choiceTtlMs : w.ttlMs);
}

function unanswerableWindow(ctx: { nowMs: number; ttlMs?: number; choiceTtlMs?: number }): UnanswerableWindow {
  return {
    nowMs: ctx.nowMs,
    ttlMs: ctx.ttlMs ?? UNANSWERABLE_ESCALATION_TTL_MS,
    choiceTtlMs: ctx.choiceTtlMs ?? UNANSWERABLE_CHOICE_ESCALATION_TTL_MS,
  };
}

/** The distinct senders worth probing for liveness this tick. */
export function unanswerableCandidateAuthors(
  opens: readonly StaleEscalationInput[],
  ctx: { nowMs: number; ttlMs?: number; choiceTtlMs?: number },
): string[] {
  const w = unanswerableWindow(ctx);
  const out = new Set<string>();
  for (const e of opens) {
    if (isUnanswerableCandidate(e, w)) out.add((e.from as string).trim());
  }
  return [...out];
}

/**
 * PURE: which OPEN escalations are UNANSWERABLE — non-operational, past their
 * window, AND authored by someone proven gone:
 *
 *   - an OPTION-LESS row is gone when `isAuthorGone` says so (an explicit verdict
 *     OR presence-absence — see reconcileUnanswerableEscalationsOnce);
 *   - an OPTION-CARRYING row (a real choice) is gone ONLY when
 *     `isAuthorGoneByVerdict` says so — an explicit ended/recorded verdict.
 *     Presence-absence never suffices for a choice, and a caller that supplies no
 *     verdict leg can never reap one (WI-2140594).
 *
 * Both predicates must return true ONLY for a PROVEN-absent author. Unknown must
 * map to false: this selector resolves rows that look like human decisions, so
 * every ambiguous signal has to fail closed.
 */
export function selectUnanswerableEscalations(
  opens: readonly StaleEscalationInput[],
  ctx: {
    nowMs: number;
    ttlMs?: number;
    choiceTtlMs?: number;
    isAuthorGone: (from: string) => boolean;
    isAuthorGoneByVerdict?: (from: string) => boolean;
  },
): StaleEscalation[] {
  const w = unanswerableWindow(ctx);
  const out: StaleEscalation[] = [];
  for (const e of opens) {
    if (!isUnanswerableCandidate(e, w)) continue;
    const from = (e.from as string).trim();
    const choice = hasChoice(e);
    const gone = choice ? ctx.isAuthorGoneByVerdict?.(from) === true : ctx.isAuthorGone(from);
    if (!gone) continue;
    out.push({ msg_id: e.msg_id, ageDays: (ctx.nowMs - Date.parse(e.ts)) / 86_400_000, hasOptions: choice });
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

export interface UnanswerableReconcileDeps {
  resolveSessionStatesFn?: typeof resolveSessionStates;
  getPresenceFn?: (ownerId: string) => Promise<unknown | null>;
}

/**
 * One dead-author reconciliation pass.
 *
 * Liveness is read in TWO legs because the oracle's UNKNOWN is ambiguous by
 * design. `resolveSessionStates` is TOTAL (EI-18771777750306094): every subject
 * gets an entry, and one it has no signal for gets an IN-BAND unknown —
 * `sessionState: null` + `signalMissing` — which means "never heard of" OR
 * "signal degraded", and its doc is explicit that the caller keeps its own
 * "state unknown" behavior. Treating unknown as dead would mass-resolve real
 * asks on one degraded fetch. So:
 *
 *   - an EXPLICIT verdict is authoritative in both directions — gone iff the
 *     session state is 'ended' or 'recorded' ('suspect'/'parked'/'draining' are
 *     ambiguous and deliberately count as NOT gone);
 *   - with an UNKNOWN verdict (`sessionState: null`, or no entry from an injected
 *     partial map), presence-row absence disambiguates: we treat the author as
 *     gone only when the presence store ANSWERED and held no row for them.
 *
 * WI-2140594: before the oracle became total, "no entry" was the unknown and the
 * presence leg drained most of the backlog (measured 226 of 229 authors had no
 * presence row). Once every subject carried an entry, `goneByVerdict.has(from)`
 * was true for all of them and the presence leg went dead — a null verdict read
 * as "not gone". It still drained, only because the ended-session log leg of the
 * oracle proved most dead authors `ended`; the doc above was simply no longer
 * describing the code. A null verdict now falls through to the presence leg
 * again, which is the documented contract.
 *
 * Option-carrying rows (a real choice) are held to the explicit-verdict leg
 * ONLY, past the longer UNANSWERABLE_CHOICE_ESCALATION_TTL_MS window.
 *
 * Any throw from either leg aborts the whole pass and resolves NOTHING; a
 * degraded read must never read as "everyone is gone".
 */
export async function reconcileUnanswerableEscalationsOnce(
  opts: { nowMs?: number; ttlMs?: number; choiceTtlMs?: number; limit?: number } & UnanswerableReconcileDeps = {},
): Promise<ReconcileResult> {
  const opens = (await listEscalations({ status: 'open' })) as unknown as StaleEscalationInput[];
  const nowMs = opts.nowMs ?? Date.now();
  const ttl = opts.ttlMs ?? UNANSWERABLE_ESCALATION_TTL_MS;
  const choiceTtl = opts.choiceTtlMs ?? UNANSWERABLE_CHOICE_ESCALATION_TTL_MS;
  // WI-7397: the two zero-result branches below are semantically OPPOSITE (one
  // healthy, one a degraded-read abort) and must never again be the same value.
  const zero = (outcome: ReconcileResult['outcome']): ReconcileResult => ({
    scanned: opens.length,
    stale: 0,
    resolved: 0,
    truncated: false,
    outcome,
  });

  const candidates = unanswerableCandidateAuthors(opens, { nowMs, ttlMs: ttl, choiceTtlMs: choiceTtl });
  if (candidates.length === 0) return zero('no-candidates');

  const resolveFn = opts.resolveSessionStatesFn ?? resolveSessionStates;
  const getPresenceFn = opts.getPresenceFn ?? getPresence;

  // EXPLICIT verdicts only. A null `sessionState` is the oracle's in-band
  // unknown and is deliberately NOT entered here, so it falls through to the
  // presence leg below instead of reading as "not gone" (WI-2140594).
  let goneByVerdict: Map<string, boolean>;
  let presenceKnown: Set<string>;
  try {
    const [verdicts, presenceRows] = await Promise.all([
      resolveFn(candidates.map((ownerId) => ({ ownerId }))),
      Promise.all(candidates.map(async (id) => [id, await getPresenceFn(id)] as const)),
    ]);
    goneByVerdict = new Map(
      [...verdicts.entries()]
        .filter(([, v]) => v.sessionState != null)
        .map(([id, v]) => [id, v.sessionState === 'ended' || v.sessionState === 'recorded']),
    );
    presenceKnown = new Set(presenceRows.filter(([, row]) => row != null).map(([id]) => id));
  } catch {
    // FAIL-SAFE. A degraded liveness/presence read is indistinguishable from
    // "nobody exists" if you squint — so we refuse to squint.
    // The 'aborted' outcome is what makes this refusal VISIBLE: resolving
    // nothing is the right call, but doing so silently is not (WI-7397).
    return zero('aborted');
  }

  const isAuthorGone = (from: string): boolean =>
    goneByVerdict.has(from) ? goneByVerdict.get(from)! : !presenceKnown.has(from);
  const isAuthorGoneByVerdict = (from: string): boolean => goneByVerdict.get(from) === true;

  const stale = selectUnanswerableEscalations(opens, {
    nowMs,
    ttlMs: ttl,
    choiceTtlMs: choiceTtl,
    isAuthorGone,
    isAuthorGoneByVerdict,
  });
  const limit = opts.limit ?? RECONCILE_BATCH_LIMIT;
  const batch = stale.slice(0, limit);

  const resolved =
    batch.length === 0
      ? 0
      : (
          await resolveEscalationsBatch(
            batch.map((s) => ({
              msg_id: s.msg_id,
              choice: 'unanswerable',
              resolver: RECONCILE_OWNER,
              // Distinct from the operational note on purpose: an auto-closed row
              // must never read as an ask that was actually answered — and a
              // choice row must say its options were never chosen (WI-2140594).
              note: s.hasOptions
                ? `auto-resolved: requester session ended (explicit verdict) — its options were never chosen; escalation open ${Math.round(s.ageDays)}d and unanswerable (WI-2140594)`
                : `auto-resolved: author no longer exists — escalation open ${Math.round(s.ageDays)}d and unanswerable (EI-19411323991062966)`,
            })),
          )
        ).resolved;

  return {
    scanned: opens.length,
    stale: stale.length,
    resolved,
    truncated: stale.length > batch.length,
    outcome: 'swept',
  };
}

// ─── EI-7024: escalation SLA reroute to a live driver ────────────────────────

/** A genuine escalation may need a live operator even while the original row
 * remains a human decision. After this SLA, route a one-shot action message to
 * the closest live su. Environment override exists for operators/tests. */
export const ESCALATION_REROUTE_SLA_MS = (() => {
  const env = Number(process.env.PAPERCUSP_ESCALATION_REROUTE_SLA_MS);
  return Number.isFinite(env) && env > 0 ? env : 30 * 60 * 1000;
})();

/** Safety bound per five-minute tick. */
export const ESCALATION_REROUTE_BATCH_LIMIT = 200;

const AGENT_ESCALATION_AUTHOR_RE = new RegExp(AGENT_SESSION_SENDER_PATTERN, 'i');
/** Harness/self-test sender namespace. These rows exercise the escalation
 * transport itself; they are not operators asking another live operator to
 * take action, so aging must never promote them into the SLA reroute lane. */
const LOOPBACK_ESCALATION_AUTHOR_RE = /^su-loopback(?:$|[-:_])/i;
export const ESCALATION_REROUTE_OWNER = ESCALATION_SLA_REROUTE_WAKE_SOURCE;
const ESCALATION_REROUTE_MSG_PREFIX = 'escalation-sla-reroute:';
const ESCALATION_REROUTE_MARKER_FIELD = 'escalationRerouteOf';
const ESCALATION_REVALIDATION_MSG_PREFIX = 'escalation-revalidation:';
const ESCALATION_REVALIDATION_MARKER_FIELD = 'escalationRevalidationOf';

const ESCALATION_REROUTE_IDENTITY: AgentIdentity = {
  ownerId: ESCALATION_REROUTE_OWNER,
  ownerLabel: 'system · escalation-sla-reroute',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface EscalationRerouteInput extends StaleEscalationInput {
  summary?: string;
  body?: string;
  plan_slug?: string;
  harness_slug?: string;
  /** Legacy/meta-flattened harness context. */
  harnessSlug?: string;
  /** Original sender role captured by coord:escalate for revalidation. */
  escalationPredicateRole?: unknown;
}

export interface EscalationRerouteDriver {
  ownerId: string;
  sessionState: string | null;
  agentRole: string | null;
  currentPlanSlug: string | null;
  potSlug: string | null;
  fleetSlug: string | null;
  /**
   * Is this driver's engine loop held under an active `loop:standdown-all`?
   * REQUIRED rather than optional on purpose (EI-21451978219397190): an omitted
   * flag reads as falsy, i.e. "safe to wake", which is the exact wrong default
   * for a guard whose whole job is to NOT wake someone. Every construction site
   * must state it.
   */
  standdownHeld: boolean;
}

export type EscalationRerouteReason = 'author-fleet-leader' | 'author-fleet-member' | 'same-plan' | 'same-harness';

export interface EscalationRerouteSelection {
  escalation: EscalationRerouteInput;
  targetOwnerId: string;
  reason: EscalationRerouteReason;
  overdueMinutes: number;
}

function concrete(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRerouteEligible(
  e: EscalationRerouteInput,
  nowMs: number,
  slaMs: number,
  responseMarkers: ReadonlySet<string>,
): boolean {
  const from = concrete(e.from);
  if (!from || !AGENT_ESCALATION_AUTHOR_RE.test(from)) return false;
  if (LOOPBACK_ESCALATION_AUTHOR_RE.test(from)) return false;
  if (isOperationalEscalation(from, (e.options?.length ?? 0) > 0)) return false;
  if (responseMarkers.has(e.msg_id)) return false;
  const openedMs = Date.parse(e.ts);
  return Number.isFinite(openedMs) && nowMs - openedMs >= slaMs;
}

/**
 * PURE: choose one DIFFERENT live su for each past-SLA, still-open escalation.
 * Contextless agents are never selected. Ties are owner-id sorted so retries and
 * tests make the same choice from the same snapshot.
 */
export function selectEscalationSlaReroutes(
  opens: readonly EscalationRerouteInput[],
  roster: readonly EscalationRerouteDriver[],
  ctx: {
    nowMs: number;
    slaMs?: number;
    responseMarkers?: ReadonlySet<string>;
    leaderByFleet?: ReadonlyMap<string, string | null>;
  },
): EscalationRerouteSelection[] {
  const slaMs = ctx.slaMs ?? ESCALATION_REROUTE_SLA_MS;
  const responseMarkers = ctx.responseMarkers ?? new Set<string>();
  const leaderByFleet = ctx.leaderByFleet ?? new Map<string, string | null>();
  const byOwner = new Map(roster.map((r) => [r.ownerId, r]));
  const out: EscalationRerouteSelection[] = [];

  for (const escalation of opens) {
    if (!isRerouteEligible(escalation, ctx.nowMs, slaMs, responseMarkers)) continue;
    const from = concrete(escalation.from)!;
    const author = byOwner.get(from);
    const authorFleet = author?.fleetSlug ?? null;
    const authorLive = author?.sessionState === 'live';
    const planSlug = concrete(escalation.plan_slug) ?? author?.currentPlanSlug ?? null;
    const harnessSlug =
      concrete(escalation.harness_slug) ?? concrete(escalation.harnessSlug) ?? author?.potSlug ?? null;

    const ranked = roster
      .filter(
        (candidate) =>
          candidate.ownerId !== from &&
          candidate.sessionState === 'live' &&
          candidate.agentRole === 'su' &&
          // EI-21451978219397190: never hand an unacked escalation to an agent
          // held under a global stand-down. During a stand-down "unacknowledged
          // by the human" is the EXPECTED state — the owner is deliberately
          // away — so treating it as a fault and hunting for a driver walks the
          // roster waking exactly the agents the pause told to stay idle. With
          // this filter the reroute lands only on whoever the owner
          // deliberately left running (the de-facto stand-down driver), and
          // when nobody is left running it does not fire at all: the escalation
          // stays open and reroutes normally once the hold lapses.
          !candidate.standdownHeld,
      )
      .map(
        (candidate): { candidate: EscalationRerouteDriver; rank: number; reason: EscalationRerouteReason } | null => {
          if (authorFleet && leaderByFleet.get(authorFleet) === candidate.ownerId) {
            return { candidate, rank: 0, reason: 'author-fleet-leader' };
          }
          // WI-10003519: a LIVE author is already the live driver this SLA
          // looks for. Only an UPWARD hop (to the author's fleet leader, above)
          // adds anything; a lateral peer or the author's own subordinate can
          // neither drive the escalation harder than its author nor supply the
          // human decision it waits on (measured: a leader's owner-spend ask
          // rerouted to its own fleet member, twice in one afternoon). A
          // non-live or absent author keeps the full fall-through below.
          if (authorLive) return null;
          if (authorFleet && candidate.fleetSlug === authorFleet) {
            return { candidate, rank: 1, reason: 'author-fleet-member' };
          }
          if (planSlug && candidate.currentPlanSlug === planSlug) {
            return { candidate, rank: 2, reason: 'same-plan' };
          }
          if (harnessSlug && candidate.potSlug === harnessSlug) {
            return { candidate, rank: 3, reason: 'same-harness' };
          }
          return null;
        },
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.rank - b.rank || a.candidate.ownerId.localeCompare(b.candidate.ownerId));

    const selected = ranked[0];
    if (!selected) continue;
    const openedMs = Date.parse(escalation.ts);
    out.push({
      escalation,
      targetOwnerId: selected.candidate.ownerId,
      reason: selected.reason,
      overdueMinutes: (ctx.nowMs - openedMs) / 60_000,
    });
  }

  return out.sort(
    (a, b) =>
      Date.parse(a.escalation.ts) - Date.parse(b.escalation.ts) ||
      a.escalation.msg_id.localeCompare(b.escalation.msg_id),
  );
}

/** Any messages-surface sibling carrying related_msg_id retires rerouting for
 * the escalation. A reroute notice cannot use related_msg_id when the original
 * escalation has been pruned, so its explicit lifecycle marker does the same
 * job.
 *
 * Two UNIONed legs, each an index scan on its own partial index (691 for
 * related_msg_id, 1235 for the reroute marker). The key-presence predicates are
 * required by those partial indexes; keep them even though the equality looks
 * sufficient. The marker key is a SQL LITERAL on purpose: a postgres.js
 * interpolation inside quotes becomes a quoted '$n', which is how this query
 * used to fail every prepare and fall back to the whole messages surface
 * (host-memory-reduction-2026-09-27 D-012). It must equal
 * ESCALATION_REROUTE_MARKER_FIELD — pinned behaviourally by
 * reconcile-escalations.reroute.integration.test.ts, which seeds a real marker
 * row against real PG (no fallback left to mask a mismatch).
 * On PG a query error PROPAGATES (D-011); only a non-PG seam scans readLines. */
async function readEscalationResponseMarkers(msgIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(msgIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  if (coordHasPgFastPath()) {
    const sql = coordSql();
    const ws = coordWorkspaceId();
    const rows = await sql<{ msg_id: string | null }[]>`
      SELECT body->>'related_msg_id' AS msg_id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${ws}
         AND surface = 'messages'
         AND body ? 'related_msg_id'
         AND body->>'related_msg_id' = ANY(${ids})
      UNION
      SELECT body->>'escalationRerouteOf' AS msg_id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${ws}
         AND surface = 'messages'
         AND body ? 'escalationRerouteOf'
         AND body->>'escalationRerouteOf' = ANY(${ids})
    `;
    return new Set(rows.map((row) => row.msg_id).filter((id): id is string => typeof id === 'string'));
  }
  const idSet = new Set(ids);
  const lines = await coordLog.readLines('messages');
  return new Set(lines.flatMap((line) => {
    const marker = (line as unknown as Record<string, unknown>)[ESCALATION_REROUTE_MARKER_FIELD];
    return [
      line.related_msg_id,
      typeof marker === 'string' ? marker : null,
    ].filter((id): id is string => typeof id === 'string' && idSet.has(id));
  }));
}

export interface EscalationRerouteResult {
  scanned: number;
  selected: number;
  rerouted: number;
  failed: number;
  truncated: boolean;
  /** Rows withheld because their stored predicate was false or unreadable. */
  predicateSkipped: number;
  /** Rows withheld because the current artifact read could not be established. */
  artifactUnknownSkipped: number;
  /** Rows rerouted with an explicit warning that their cited path is absent. */
  artifactMissingWarnings: number;
  /**
   * Rows withheld because the escalation's SUBJECT work-item (the WI-/EI-/F- id
   * named in its summary or evidence ref, if any) already has a live,
   * actively-progressing assignee — waking a second member would be pure noise
   * (EI-21834041480805949). See {@link subjectAlreadyActivelyWorked}.
   */
  subjectActivelyWorkedSkipped: number;
  /**
   * Reroutes that WOULD have fired but were suppressed because every otherwise-
   * eligible driver is held under an active `loop:standdown-all`
   * (EI-21451978219397190). Non-zero means the stand-down is doing its job; the
   * escalations stay open and reroute normally once the hold lapses.
   */
  standdownSuppressed: number;
}

export interface EscalationRerouteDeps {
  listLoopStanddownOwnersFn?: (nowMs: number) => Promise<Set<string>>;
  listEscalationsFn?: typeof listEscalations;
  listPresenceFn?: typeof listPresence;
  resolveSessionStatesFn?: typeof resolveSessionStates;
  fetchPresenceFleetFn?: typeof fetchPresenceFleet;
  getFleetFn?: typeof getFleet;
  readResponseMarkersFn?: (msgIds: readonly string[]) => Promise<Set<string>>;
  revalidatePredicateFn?: typeof revalidateEscalationPredicate;
  validateArtifactRefFn?: typeof validateEscalationArtifactRef;
  sendMessageFn?: typeof sendMessage;
  wakeRecipientsFn?: typeof wakeRecipients;
}

function hasOwnField(value: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function evidenceRefOf(e: EscalationRerouteInput): string | null {
  const raw = readEvidence(e as unknown as Record<string, unknown>);
  return raw?.ref ?? null;
}

/**
 * Word-bounded WI-/EI-/F- id extraction from free prose — the same convention
 * used for exact-string validation elsewhere (e.g. attention/adapters.ts's
 * `/^(?:WI|EI|F)-\d+$/i`), unanchored so it matches inside a sentence. Only the
 * FIRST match is used: an escalation naming its subject typically names it once,
 * and the eligibility check below is deliberately narrow (see
 * {@link subjectAlreadyActivelyWorked}).
 */
const SUBJECT_WORK_ITEM_ID_RE = /\b((?:WI|EI|F)-\d+)\b/i;

/**
 * The escalation's SUBJECT work-item id, if any: the first WI-/EI-/F- id named
 * in its summary prose, falling back to its cited evidence ref (some
 * escalations cite the item they are about there rather than in prose). `null`
 * when neither resolves — the caller's fail-closed default applies.
 */
function extractSubjectWorkItemId(escalation: EscalationRerouteInput): string | null {
  const fromSummary = SUBJECT_WORK_ITEM_ID_RE.exec(escalation.summary ?? '');
  if (fromSummary) return fromSummary[1].toUpperCase();
  const evidenceRef = evidenceRefOf(escalation);
  const fromEvidence = evidenceRef ? SUBJECT_WORK_ITEM_ID_RE.exec(evidenceRef) : null;
  return fromEvidence ? fromEvidence[1].toUpperCase() : null;
}

/**
 * EI-21834041480805949: does the escalation's SUBJECT work-item ALREADY have a
 * live, actively-progressing assignee by the time the SLA reroute would fire?
 * If so, waking a second member is pure noise — the escalation itself stays
 * open (only the human resolution path is authoritative); this only suppresses
 * the automatic reroute NOTICE.
 *
 * Deliberately MINIMAL and FAIL-CLOSED (returns false — proceed with the
 * reroute) on every path except the one well-evidenced case: no subject id
 * found, the item can't be resolved, it is already terminal, it has no
 * assignee, or the assignee's liveness is unknown to the roster this pass
 * already fetched. Reuses {@link classifyItemActivity}/{@link isActivelyWorked}
 * (item-activity.ts) rather than re-deriving a staleness threshold, and the
 * `rosterByOwner` map {@link rerouteUnackedEscalationsOnce} already built from
 * `resolveSessionStates` — no second presence fetch.
 */
async function subjectAlreadyActivelyWorked(
  escalation: EscalationRerouteInput,
  rosterByOwner: ReadonlyMap<string, EscalationRerouteDriver>,
  nowMs: number,
): Promise<boolean> {
  const subjectId = extractSubjectWorkItemId(escalation);
  if (!subjectId) return false;
  const harness = concrete(escalation.harness_slug) ?? concrete(escalation.harnessSlug) ?? undefined;
  let item: Awaited<ReturnType<typeof getWorkItem>>;
  try {
    item = await getWorkItem(subjectId, harness);
  } catch {
    // A lookup failure must never manufacture a suppression — fail closed.
    return false;
  }
  if (!item) return false;
  if (TERMINAL_WORK_ITEM_STATES.includes(item.state)) return false;
  if (!item.assignee) return false;
  const driver = rosterByOwner.get(item.assignee);
  // Deliberately narrower than the fleet-wide "alive" set (parked/recorded count
  // there): this guard's own title is "live, actively-progressing assignee", so
  // only `sessionState === 'live'` counts as alive here. Absent from the roster
  // entirely is UNKNOWN (undefined), never assumed dead.
  const holderAlive = driver ? driver.sessionState === 'live' : undefined;
  const activity = classifyItemActivity(
    { takenBy: item.assignee, takenAt: item.takenAt, lastProgressAt: item.lastProgressAt, holderAlive },
    { now: nowMs },
  );
  return isActivelyWorked(activity);
}

function unknownPredicateValidation(reason: string): EscalationPredicateValidation {
  return {
    status: 'unknown',
    checkedAt: new Date().toISOString(),
    reason,
  };
}

function validationStatusKey(
  predicateValidation: EscalationPredicateValidation | undefined,
  artifactValidation: EscalationArtifactValidation | undefined,
): string {
  return [
    predicateValidation?.status ?? 'no-predicate',
    artifactValidation?.status ?? 'no-artifact',
  ].join('+');
}

async function annotateEscalationRevalidation(
  escalation: EscalationRerouteInput,
  validation: {
    predicate?: EscalationPredicateValidation;
    artifact?: EscalationArtifactValidation;
  },
  sendFn: typeof sendMessage,
): Promise<void> {
  const statusKey = validationStatusKey(validation.predicate, validation.artifact);
  const details: string[] = [];
  if (validation.predicate) {
    details.push(
      `Predicate revalidation is ${validation.predicate.status} at ${validation.predicate.checkedAt}` +
        (validation.predicate.reason ? ` (${validation.predicate.reason})` : '') +
        '.',
    );
  }
  if (validation.artifact) {
    details.push(
      `Cited evidence ref "${validation.artifact.ref}" is ${validation.artifact.status} at ${validation.artifact.checkedAt}` +
        (validation.artifact.path ? ` (${validation.artifact.path})` : '') +
        (validation.artifact.reason ? ` (${validation.artifact.reason})` : '') +
        '.',
    );
  }
  const msgId = `${ESCALATION_REVALIDATION_MSG_PREFIX}${escalation.msg_id}:${statusKey}`;
  try {
    await sendFn(ESCALATION_REROUTE_IDENTITY, {
      to: ['human'],
      msgId,
      summary: `Escalation ${escalation.msg_id} machine revalidation: ${statusKey}`,
      body:
        `The original escalation ${escalation.msg_id} remains OPEN and was not auto-resolved. ` +
        'Its machine-checkable evidence changed or could not be re-read before SLA reroute:\n' +
        details.join('\n'),
      plan_slug: concrete(escalation.plan_slug) ?? undefined,
      harnessSlug: concrete(escalation.harness_slug) ?? concrete(escalation.harnessSlug) ?? undefined,
      extra: {
        auto: true,
        lifecycle: 'escalation-revalidation',
        expects: 'none',
        [ESCALATION_REVALIDATION_MARKER_FIELD]: escalation.msg_id,
        ...(validation.predicate ? { predicateValidation: validation.predicate } : {}),
        ...(validation.artifact ? { evidenceValidation: validation.artifact } : {}),
      },
    });
  } catch (error) {
    // The original escalation is still open and the reroute pass remains
    // fail-closed. A notice failure is visible in logs but must not turn a
    // safe suppression into an automatic reroute.
    console.warn(
      `[escalation-sla-reroute] revalidation annotation for ${escalation.msg_id} failed: ` +
        `${error instanceof Error ? error.message : error}`,
    );
  }
}

/** One injectable, fail-closed pass. The original escalation is NEVER resolved:
 * this only appends one action message + attempts one targeted wake. */
export async function rerouteUnackedEscalationsOnce(
  opts: {
    nowMs?: number;
    slaMs?: number;
    limit?: number;
    workspaceId?: string;
  } & EscalationRerouteDeps = {},
): Promise<EscalationRerouteResult> {
  const listEscalationsFn = opts.listEscalationsFn ?? listEscalations;
  const listPresenceFn = opts.listPresenceFn ?? listPresence;
  const resolveFn = opts.resolveSessionStatesFn ?? resolveSessionStates;
  const fetchFleetFn = opts.fetchPresenceFleetFn ?? fetchPresenceFleet;
  const getFleetFn = opts.getFleetFn ?? getFleet;
  const readMarkersFn = opts.readResponseMarkersFn ?? readEscalationResponseMarkers;
  const revalidatePredicateFn = opts.revalidatePredicateFn ?? revalidateEscalationPredicate;
  const validateArtifactRefFn = opts.validateArtifactRefFn ?? validateEscalationArtifactRef;
  const sendFn = opts.sendMessageFn ?? sendMessage;
  const wakeFn = opts.wakeRecipientsFn ?? wakeRecipients;
  // Fails OPEN, at the CALL boundary as well as inside the reader: acquiring the
  // handle can throw before the reader's own try/catch is reached. This guard
  // only ever SUPPRESSES a delivery, so an unreadable stand-down must degrade to
  // "nobody is held" (reroute as before) rather than silently stranding every
  // escalation the moment the routines read is unavailable.
  const standdownFn =
    opts.listLoopStanddownOwnersFn ??
    (async (at: number) => {
      try {
        return await listLoopStanddownOwners(coordSql(), {
          workspaceId: opts.workspaceId ?? coordWorkspaceId(),
          nowMs: at,
        });
      } catch (e) {
        console.warn(
          `[escalation-sla-reroute] stand-down read failed (non-fatal, failing open): ${e instanceof Error ? e.message : String(e)}`,
        );
        return new Set<string>();
      }
    });
  const nowMs = opts.nowMs ?? Date.now();
  const slaMs = opts.slaMs ?? ESCALATION_REROUTE_SLA_MS;
  const limit = opts.limit ?? ESCALATION_REROUTE_BATCH_LIMIT;
  const workspaceId = opts.workspaceId ?? coordWorkspaceId();

  const opens = (await listEscalationsFn({ status: 'open' })) as unknown as EscalationRerouteInput[];
  const pastSlaAgentRows = opens.filter((e) => isRerouteEligible(e, nowMs, slaMs, new Set()));
  const markers = await readMarkersFn(pastSlaAgentRows.map((e) => e.msg_id));
  const unmarked = pastSlaAgentRows.filter((e) => !markers.has(e.msg_id));
  if (unmarked.length === 0) {
    return {
      scanned: opens.length,
      selected: 0,
      rerouted: 0,
      failed: 0,
      truncated: false,
      predicateSkipped: 0,
      artifactUnknownSkipped: 0,
      artifactMissingWarnings: 0,
      subjectActivelyWorkedSkipped: 0,
      standdownSuppressed: 0,
    };
  }

  const presence = await listPresenceFn({ workspaceId });
  const ownerIds = presence.map((p) => p.ownerId);
  const [verdicts, membership, standdownOwners] = await Promise.all([
    resolveFn(
      presence.map((p) => ({
        ownerId: p.ownerId,
        heartbeatAt: p.heartbeatAt,
        stale: p.stale,
        host: p.host,
        pid: p.pid,
        source: p.source,
      })),
    ),
    fetchFleetFn(ownerIds),
    standdownFn(nowMs),
  ]);
  const roster: EscalationRerouteDriver[] = presence.map((p) => ({
    ownerId: p.ownerId,
    sessionState: verdicts.get(p.ownerId)?.sessionState ?? null,
    agentRole: p.agentRole,
    currentPlanSlug: p.currentPlanSlug,
    potSlug: p.potSlug,
    fleetSlug: membership.get(p.ownerId)?.fleetSlug ?? null,
    standdownHeld: standdownOwners.has(p.ownerId),
  }));
  const authorIds = new Set(unmarked.map((e) => concrete(e.from)).filter((id): id is string => id !== null));
  const authorFleets = [
    ...new Set(
      roster
        .filter((r) => authorIds.has(r.ownerId))
        .map((r) => r.fleetSlug)
        .filter((slug): slug is string => slug !== null),
    ),
  ];
  const fleetRows = await Promise.all(
    authorFleets.map(async (slug) => [slug, await getFleetFn(workspaceId, slug).catch(() => null)] as const),
  );
  const leaderByFleet = new Map(fleetRows.map(([slug, fleet]) => [slug, fleet?.leaderOwnerId ?? null]));

  const rosterByOwner = new Map(roster.map((r) => [r.ownerId, r]));
  const predicateValidations = new Map<string, EscalationPredicateValidation>();
  const artifactValidations = new Map<string, EscalationArtifactValidation>();
  let predicateSkipped = 0;
  let artifactUnknownSkipped = 0;
  let subjectActivelyWorkedSkipped = 0;
  const validatedRows: EscalationRerouteInput[] = [];

  // Revalidation is deliberately BEFORE selection. A stale predicate must not
  // merely decorate a route that the selector has already decided to send; the
  // current result is the gate for the automatic handoff, while the original
  // human escalation remains open in every branch.
  await Promise.all(
    unmarked.map(async (escalation) => {
      const predicatePresent = hasOwnField(escalation, 'escalationPredicate');
      let predicate: EscalationPredicate | null = null;
      if (predicatePresent) {
        predicate = parseEscalationPredicate(escalation.escalationPredicate);
        if (!predicate) {
          predicateSkipped += 1;
          await annotateEscalationRevalidation(
            escalation,
            {
              predicate: unknownPredicateValidation('stored escalation predicate is malformed'),
            },
            sendFn,
          );
          return;
        }
        const from = concrete(escalation.from);
        const author = from ? rosterByOwner.get(from) : undefined;
        const predicateValidation = author
          ? await revalidatePredicateFn(predicate, {
              workspaceId,
              harnessSlug:
                concrete(escalation.harness_slug) ??
                concrete(escalation.harnessSlug) ??
                author.potSlug ??
                null,
              role: author.agentRole,
              onBehalfOf: from ?? '',
              spawnId: 'escalation-sla-revalidation',
            })
          : unknownPredicateValidation('original sender is absent from the live roster');
        predicateValidations.set(escalation.msg_id, predicateValidation);
        if (predicateValidation.status !== 'satisfied') {
          predicateSkipped += 1;
          await annotateEscalationRevalidation(
            escalation,
            { predicate: predicateValidation },
            sendFn,
          );
          return;
        }
      }

      const evidenceRef = evidenceRefOf(escalation);
      if (evidenceRef) {
        const artifactValidation = await validateArtifactRefFn(evidenceRef);
        artifactValidations.set(escalation.msg_id, artifactValidation);
        if (artifactValidation.status === 'unknown') {
          artifactUnknownSkipped += 1;
          await annotateEscalationRevalidation(
            escalation,
            {
              ...(predicateValidations.has(escalation.msg_id)
                ? { predicate: predicateValidations.get(escalation.msg_id) }
                : {}),
              artifact: artifactValidation,
            },
            sendFn,
          );
          return;
        }
      }
      // EI-21834041480805949: never wake a second member when the escalation's
      // own subject work-item already has a live, actively-progressing
      // assignee. No notice is sent — this is a good outcome, not an anomaly,
      // unlike the predicate/artifact skips above (which flag something the
      // original escalation should know changed).
      if (await subjectAlreadyActivelyWorked(escalation, rosterByOwner, nowMs)) {
        subjectActivelyWorkedSkipped += 1;
        return;
      }
      validatedRows.push(escalation);
    }),
  );

  const selectorCtx = { nowMs, slaMs, responseMarkers: markers, leaderByFleet };
  const selected = selectEscalationSlaReroutes(validatedRows, roster, selectorCtx);
  // How many reroutes the stand-down actually suppressed. Counted by re-running
  // the PURE selector against the same roster with the hold lifted, rather than
  // inferring it from "selected fewer than validated" — plenty of rows select
  // nothing for unrelated reasons (no same-fleet/plan/harness candidate at all),
  // and attributing those to the stand-down would report a guard that did
  // nothing as if it were working. Skipped entirely when nothing is held.
  let standdownSuppressed = 0;
  if (standdownOwners.size > 0) {
    const selectedIds = new Set(selected.map((s) => s.escalation.msg_id));
    standdownSuppressed = selectEscalationSlaReroutes(
      validatedRows,
      roster.map((r) => ({ ...r, standdownHeld: false })),
      selectorCtx,
    ).filter((s) => !selectedIds.has(s.escalation.msg_id)).length;
  }
  const batch = selected.slice(0, limit);
  let rerouted = 0;
  let failed = 0;
  let artifactMissingWarnings = 0;
  for (const route of batch) {
    const { escalation } = route;
    const noticeMsgId = `${ESCALATION_REROUTE_MSG_PREFIX}${escalation.msg_id}`;
    const predicateValidation = predicateValidations.get(escalation.msg_id);
    const artifactValidation = artifactValidations.get(escalation.msg_id);
    const validationLines: string[] = [];
    if (predicateValidation) {
      validationLines.push(
        `Predicate revalidation: ${predicateValidation.status} at ${predicateValidation.checkedAt}.`,
      );
    }
    if (artifactValidation?.status === 'absent') {
      artifactMissingWarnings += 1;
      validationLines.push(
        `Cited evidence ref "${artifactValidation.ref}" is ABSENT as of ${artifactValidation.checkedAt}; ` +
          'do not treat it as current evidence.',
      );
    } else if (artifactValidation?.status === 'present') {
      validationLines.push(
        `Cited evidence ref "${artifactValidation.ref}" was verified present at ${artifactValidation.checkedAt}.`,
      );
    } else if (artifactValidation?.status === 'not-path') {
      validationLines.push(
        `Cited evidence ref "${artifactValidation.ref}" is not a local path; no filesystem check applies.`,
      );
    }
    const validationNote = validationLines.length > 0 ? `\n\nMachine validation:\n${validationLines.join('\n')}` : '';
    try {
      const notice = await sendFn(ESCALATION_REROUTE_IDENTITY, {
        to: [route.targetOwnerId],
        msgId: noticeMsgId,
        summary:
          `⏰ escalation needs a live driver (${route.reason}, ~${Math.round(route.overdueMinutes)}m): ` +
          `${escalation.summary ?? escalation.msg_id}`,
        body:
          `Escalation ${escalation.msg_id} from ${escalation.from ?? 'an agent'} has remained open without ` +
          `any related coord acknowledgement for ~${Math.round(route.overdueMinutes)} minutes. You were selected ` +
          `as the closest live su (${route.reason}). Inspect it and drive the next action. Keep the original ` +
          'escalation open: only the human resolution path is authoritative. After taking ownership, acknowledge ' +
          `this reroute notice with coord:ack { msg_id: '${noticeMsgId}' }; that stable target remains valid even ` +
          'when the original escalation message has been pruned.' +
          validationNote,
        plan_slug: concrete(escalation.plan_slug) ?? undefined,
        harnessSlug: concrete(escalation.harness_slug) ?? concrete(escalation.harnessSlug) ?? undefined,
        extra: {
          auto: true,
          lifecycle: 'escalation-sla-reroute',
          expects: 'action',
          escalationRerouteReason: route.reason,
          [ESCALATION_REROUTE_MARKER_FIELD]: escalation.msg_id,
          ...(predicateValidation ? { predicateValidation } : {}),
          ...(artifactValidation ? { evidenceValidation: artifactValidation } : {}),
        },
      });
      rerouted += 1;
      try {
        await wakeFn([route.targetOwnerId], {
          summary: `take over unacknowledged escalation ${escalation.msg_id}`,
          payload: { escalationMsgId: escalation.msg_id, noticeMsgId: notice.msg_id },
          source: ESCALATION_REROUTE_OWNER,
          workspaceId,
        });
      } catch (error) {
        console.warn(
          `[escalation-sla-reroute] wake ${route.targetOwnerId} for ${escalation.msg_id} failed: ` +
            `${error instanceof Error ? error.message : error}`,
        );
      }
    } catch (error) {
      failed += 1;
      console.warn(
        `[escalation-sla-reroute] send for ${escalation.msg_id} failed: ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
  }

  return {
    scanned: opens.length,
    selected: selected.length,
    rerouted,
    failed,
    truncated: selected.length > batch.length,
    predicateSkipped,
    artifactUnknownSkipped,
    artifactMissingWarnings,
    subjectActivelyWorkedSkipped,
    standdownSuppressed,
  };
}
