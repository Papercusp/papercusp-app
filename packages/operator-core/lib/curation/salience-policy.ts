/**
 * Salience policy — the one genuinely-new design piece of the curator-operator
 * (plan `curator-operator-2026-06-04`, D-004 → settled in D-007).
 *
 * The operator is the user's single voice; the fleet reports up STRUCTURED
 * status (escalations, blockers, decisions-needed, completions, routine
 * progress). This module decides — purely, deterministically, with ZERO LLM
 * tokens — what the operator should **surface now**, **batch into a calm
 * digest**, or **stay quiet about**. The LLM `operator:scan` stays for richer
 * proactive *suggestions*; this is the cheap, auditable, always-on filter.
 *
 * Faithful to D-004:
 *  - ALWAYS surface: escalations, blockers, decisions-needed, completions of
 *    user-requested work.
 *  - BATCH-summarize: routine progress + fleet-internal completions.
 *  - STAY SILENT: healthy in-progress work emits no signal at all (no row →
 *    nothing to classify).
 *  - Escalations / blockers can NEVER be suppressed by the filter on their
 *    merits — see the `baseDisposition` invariant + its test.
 *
 * Pure + side-effect-free so it is unit-testable without a database. The loop
 * (`curation-loop.ts`) owns I/O; this file owns the *decision*.
 */

/** Version stamped on every surfaced row so "why did this surface?" is always
 *  answerable (the reactive-graph / audit trail). Bump on a policy change. */
export const SALIENCE_POLICY_VERSION = 'curator-v4';

/**
 * The normalized, structured unit the curator reasons over. Produced by
 * `gatherFleetSignals` (`fleet-signals.ts`) from the canonical coord /
 * work_items sources — never from raw agent transcripts (D-002 / the
 * "operator token cost" risk mitigation).
 */
export type FleetSignalKind =
  /** An agent → human escalation (coord `escalations`). */
  | 'escalation'
  /** Work is blocked: a blocked plan-item / open blocking issue / feature
   *  status=blocked / an escalation with severity 'blocker'. */
  | 'blocker'
  /** A decision is needed: needs_human_review / needs_design / an escalation
   *  with severity 'question'. Always surfaced, but not a fire-alarm. */
  | 'decision'
  /** A work_item reached a terminal done/resolved state. */
  | 'completion'
  /** Routine progress (a subscribed work_item update / plan-event). */
  | 'progress'
  /** P-002 system-health source: a `warn`-tier `computeSystemHealth` panel
   *  (D-007 — batch-tier, NOT `progress`: folding a health warning into the
   *  "N items progressed" digest count would misrepresent it). A `crit`-tier
   *  panel surfaces as kind 'blocker' instead (always-surface, urgent — a
   *  crit system-health condition genuinely blocks the fleet's operation). */
  | 'health'
  /** P-003 recovery close-the-loop: a previously-surfaced escalation/blocker
   *  (incl. a P-002 crit health panel, which surfaces as kind 'blocker') is
   *  no longer present in the current gather — computed by the loop as a
   *  diff over `curation-log`, never emitted by a `FleetReaders` source. */
  | 'cleared';

export interface FleetSignal {
  /** Stable dedup key, e.g. `escalation:<msgId>`, `wi-done:<harness>#<id>`.
   *  Two ticks observing the same underlying fact MUST produce the same id. */
  id: string;
  kind: FleetSignalKind;
  /** One calm line for the user. */
  title: string;
  /** Optional second line (e.g. the blocking reason). */
  detail?: string;
  /** Owning harness slug, when applicable. */
  harness?: string;
  /** The work_item id (WI-/F-/EI-NNN) this signal is about, when applicable. */
  workItemId?: string;
  /** Escalation severity, when kind derives from an escalation. */
  severity?: 'blocker' | 'question' | 'advisory';
  /** Provenance: was this work requested by the human (vs fleet-internal)?
   *  Gates whether a `completion` is surfaced or batched. */
  userRequested?: boolean;
  /** Drill-in pointer for the D-005 overlay fallback — curation never hides;
   *  the raw item is always reachable (e.g. `escalation:<msgId>`,
   *  `wi:<harness>#<id>`, `coord:inbox`). */
  ref?: string;
  /** ISO timestamp of the underlying event. */
  ts: string;
}

/**
 * P-006 aging re-surface (curation-signal-gaps-2026-07-17): a still-open
 * escalation/blocker that re-surfaces after the idempotency window rolls over
 * (`classifySignal`'s overlay) would otherwise read as brand-new information.
 * `agingAnnotation` computes a "still open — day N" tag purely from the
 * signal's own `ts` — the ORIGINAL open time (coord escalations / blocked
 * work_items never rewrite `ts` on a later gather) — so it applies uniformly
 * regardless of *why* this tick re-surfaced it, with no extra state to track.
 */
export const AGING_ANNOTATION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 1 day

/** The only kinds that are genuinely a "still open" standing condition worth
 *  aging — a completion/progress/health/decision/cleared signal is a
 *  point-in-time fact, not something that stays open over days. */
const AGING_ELIGIBLE_KINDS: ReadonlySet<FleetSignalKind> = new Set<FleetSignalKind>(['escalation', 'blocker']);

/**
 * "still open — day N" for an escalation/blocker at least
 * `AGING_ANNOTATION_THRESHOLD_MS` old, else `null`. Day 1 = still within its
 * first day (never annotated — day 1 short-circuits via the threshold check);
 * day N (N ≥ 2) = N-1 full days have elapsed since `signal.ts`. Pure — no
 * database, directly unit-testable.
 */
export function agingAnnotation(signal: Pick<FleetSignal, 'kind' | 'ts'>, now: number): string | null {
  if (!AGING_ELIGIBLE_KINDS.has(signal.kind)) return null;
  const openedAt = Date.parse(signal.ts);
  if (!Number.isFinite(openedAt)) return null;
  const ageMs = now - openedAt;
  if (ageMs < AGING_ANNOTATION_THRESHOLD_MS) return null;
  const day = Math.floor(ageMs / AGING_ANNOTATION_THRESHOLD_MS) + 1;
  return `still open — day ${day}`;
}

export type Disposition = 'surface' | 'batch' | 'suppress';

export interface SalienceVerdict {
  disposition: Disposition;
  /** `urgent` ⇒ the P2 event-driven immediate wake; else it rides the cadence.
   *  Only escalations + blockers are urgent. */
  urgent: boolean;
  /** Human-readable why — recorded for the "why did this surface?" audit. */
  reason: string;
}

export interface SalienceState {
  /** Dedup keys already surfaced within the recent window
   *  (`operator_curation_log`). Prevents re-nagging the SAME signal. */
  alreadySurfaced: ReadonlySet<string>;
}

/**
 * The kind → (disposition, urgent) map BEFORE the idempotency overlay. Pure on
 * `kind` (+ provenance for completions). Exported so the never-suppress
 * invariant is directly testable:
 *
 *   baseDisposition('escalation').disposition === 'surface'  // always
 *   baseDisposition('blocker').disposition    === 'surface'  // always
 *
 * This encodes D-004: the salience policy NEVER suppresses an escalation /
 * blocker on its merits. (The only suppression is the exact-repeat idempotency
 * overlay below — that is de-dup, not hiding: the raw item always remains in
 * the coord inbox + the overlay drill-in, D-005.)
 */
export function baseDisposition(
  kind: FleetSignalKind,
  userRequested?: boolean,
): { disposition: Disposition; urgent: boolean; reason: string } {
  switch (kind) {
    case 'escalation':
      return { disposition: 'surface', urgent: true, reason: 'escalation — always surface, urgent' };
    case 'blocker':
      return { disposition: 'surface', urgent: true, reason: 'blocker — always surface, urgent' };
    case 'decision':
      // Always surface, but can wait one cadence tick — not a fire-alarm.
      return { disposition: 'surface', urgent: false, reason: 'decision-needed — always surface' };
    case 'completion':
      return userRequested
        ? { disposition: 'surface', urgent: false, reason: 'completion of user-requested work — surface' }
        : { disposition: 'batch', urgent: false, reason: 'fleet-internal completion — batch' };
    case 'progress':
      return { disposition: 'batch', urgent: false, reason: 'routine progress — batch' };
    case 'health':
      // A warn-tier system-health panel — a heads-up, not a fire-alarm; crit
      // panels never reach here (they're emitted as kind 'blocker').
      return { disposition: 'batch', urgent: false, reason: 'system-health warn — batch' };
    case 'cleared':
      // A calm recovery notice, not a fire-alarm — always surface (the owner
      // should learn a blocker/escalation resolved), never urgent.
      return { disposition: 'surface', urgent: false, reason: 'recovery — previously-surfaced signal cleared' };
    default:
      // Defensive: unknown kinds are batched, never surfaced or dropped.
      return { disposition: 'batch', urgent: false, reason: 'unknown kind — batch (defensive)' };
  }
}

/**
 * Classify ONE signal: the kind-based disposition, then the idempotency
 * overlay (already-surfaced → suppress, so we don't re-surface the same fact
 * every tick). A NEW escalation/blocker is always surfaced.
 */
export function classifySignal(signal: FleetSignal, state: SalienceState): SalienceVerdict {
  const base = baseDisposition(signal.kind, signal.userRequested);
  if (base.disposition !== 'suppress' && state.alreadySurfaced.has(signal.id)) {
    // Idempotency, NOT salience-suppression — prevents re-nagging the same
    // signal. The raw item stays reachable via the coord inbox + drill-in ref.
    return { disposition: 'suppress', urgent: false, reason: 'already-surfaced (idempotency)' };
  }
  return base;
}

/** Classify a batch of signals; returns a map keyed by `signal.id`. */
export function classifyAll(
  signals: readonly FleetSignal[],
  state: SalienceState,
): Map<string, SalienceVerdict> {
  const out = new Map<string, SalienceVerdict>();
  for (const s of signals) out.set(s.id, classifySignal(s, state));
  return out;
}

/** A signal paired with its verdict — the loop's working unit. */
export interface ClassifiedSignal {
  signal: FleetSignal;
  verdict: SalienceVerdict;
}

/**
 * Partition classified signals into the three buckets the loop acts on:
 *  - `surfaceNow` — disposition 'surface' (urgent first, then the rest)
 *  - `batch`      — disposition 'batch' (collapsed into one digest)
 *  - everything else (suppressed) is dropped.
 * `surfaceNow` is ordered urgent-first so the most important line leads.
 */
export function partition(
  signals: readonly FleetSignal[],
  verdicts: ReadonlyMap<string, SalienceVerdict>,
): { surfaceNow: ClassifiedSignal[]; batch: ClassifiedSignal[]; hasUrgent: boolean } {
  const surfaceNow: ClassifiedSignal[] = [];
  const batch: ClassifiedSignal[] = [];
  let hasUrgent = false;
  for (const signal of signals) {
    const verdict = verdicts.get(signal.id);
    if (!verdict) continue;
    if (verdict.disposition === 'surface') {
      surfaceNow.push({ signal, verdict });
      if (verdict.urgent) hasUrgent = true;
    } else if (verdict.disposition === 'batch') {
      batch.push({ signal, verdict });
    }
  }
  // Urgent first within surfaceNow (escalations/blockers lead the message).
  surfaceNow.sort((a, b) => Number(b.verdict.urgent) - Number(a.verdict.urgent));
  return { surfaceNow, batch, hasUrgent };
}

/**
 * EI-1687 — map a fleet signal to the AttentionItem id the operator triages it by
 * (`inbox:triage`), so a downgrade/resolve can suppress it from the salient
 * surfaces. Escalation-source signals (any severity/kind — `escalationKind`
 * derives the kind, but the id is always `escalation:<msgId>`) surface on the
 * inbox as the coord-escalation AttentionItem `coord-escalation:<msgId>`. Other
 * signal kinds are not inbox-triageable through this mapping → `null` (untouched).
 */
export function attentionIdForSignal(
  signal: Pick<FleetSignal, 'id' | 'workItemId'>,
): string | null {
  const ESC = 'escalation:';
  if (signal.id.startsWith(ESC)) return `coord-escalation:${signal.id.slice(ESC.length)}`;

  // curated-signal-cards-2026-07-17 P-003 — blocker signals now have cards too.
  //
  // The discriminator is STRUCTURAL, not a ref-string guess: the work-item leg
  // of the `blocked` reader (`deps.ts readBlockedWorkItems`) stamps
  // `workItemId`, while the plan-item leg (`getAllBlockedPlanItems`) does not.
  // Both legs' refs look like `<x>#<y>`, so sniffing the ref would be guesswork;
  // the presence of `workItemId` is exact.
  const BLOCKED = 'blocked:';
  if (signal.id.startsWith(BLOCKED)) {
    // Work-item leg → the source #15 card (`work-item-blocked:<id>`), which by
    // construction reads exactly the `status='blocked'` rows this signal came
    // from, so the card is guaranteed to exist.
    if (signal.workItemId) return `work-item-blocked:${signal.workItemId}`;
    // Plan-item leg → the EXISTING source #1 card. Note the id separator
    // differs from the ref's: ref is `<plan>#<P-id>`, the attention id is
    // `plan-item:<plan>:<P-id>` (see `planItemToAttention`).
    const ref = signal.id.slice(BLOCKED.length);
    const hash = ref.indexOf('#');
    if (hash > 0 && hash < ref.length - 1) {
      return `plan-item:${ref.slice(0, hash)}:${ref.slice(hash + 1)}`;
    }
    return null;
  }

  // `deadclaim:` deliberately maps to NOTHING. A claim held by an ended session
  // is an independent fact from a blocked STATUS (fleet-signals keeps the id
  // prefixes distinct for exactly this reason), so the item it names is NOT
  // necessarily a `status='blocked'` row — meaning source #15 may have no card
  // for it. Returning a `work-item-blocked:` id here would be a link to a card
  // that does not exist. It keeps its plain drill-in ref instead.
  return null;
}

/**
 * EI-1687 — drop signals the operator triaged to the "handled" tier (downgrade /
 * resolve), so a handled escalation does not re-surface as "open" on curation:feed
 * or the Queen wake brief every wake (the re-downgrade-thrash bug). PURE: the
 * caller supplies `handled` (the triaged-handled AttentionItem ids, from
 * `readTriagedHandledItemIds`). An empty set is a no-op. Only signals whose
 * {@link attentionIdForSignal} is in `handled` are dropped — escalate/confirm
 * (Decision-tier) triage rows are NOT in the set, so they still surface.
 */
export function dropTriagedHandledSignals(
  signals: readonly FleetSignal[],
  handled: ReadonlySet<string>,
): FleetSignal[] {
  if (handled.size === 0) return [...signals];
  return signals.filter((s) => {
    const attentionId = attentionIdForSignal(s);
    return !(attentionId !== null && handled.has(attentionId));
  });
}
