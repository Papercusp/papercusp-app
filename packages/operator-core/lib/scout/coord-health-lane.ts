/**
 * coord-health-lane.ts — the COORD-HEALTH digest lane
 * (blender-self-learning-2026-07-12 P-008 / WI-4453).
 *
 * The coordination fabric continuously records how the FLEET is failing to
 * cooperate: escalations that re-mount over and over (a known-benign transient
 * whose "is this the same incident" dedup gate is too narrow — EI-9492), directed
 * messages that pile up unanswered (an agent alive but not draining its reply
 * queue), single inboxes flooded with thousands of near-duplicate wakes (a
 * subscription firehose or a re-firing sender), and claim conflicts (two agents
 * handed the same work-item). Today that pain reaches ideation only after a human
 * FILES an incident — the ideators never SAW the coordination breakdown itself,
 * only its downstream symptom. (Live example this lane was built from — 2026-07-13:
 * the `papercusp-stalled-claims-5agent-pattern` escalation re-mounted across ~4
 * consecutive Kettle reads and climbed advisory→blocker, while several su inboxes
 * carried tens of unanswered directed messages and ~9k coalesced-duplicate wakes.)
 *
 * This lane feeds the coordination fabric's health straight into the corpus digest
 * as grounded, citable patterns (`ref` = `coord:escalation-storm:<sig>` /
 * `coord:unanswered` / `coord:wake-storm:<recipient>` / `coord:claim-conflict` /
 * `coord:premise-resolve-rate`), so
 * ideation can target chronic coordination pain directly — the coordination
 * counterpart of the watchdog-health (P-007) and gate/pipeline-health (P-010) lanes.
 *
 * Deterministic + fail-soft, populated by the cycle seam (cycle-deps readCorpus)
 * exactly like watchdogHealth / gatePipelineHealth: an outage here never disturbs
 * the digest or the cycle. The unanswered-directed signal REUSES the hardened
 * fetchUnansweredDirected reader (WI-4537 exclusions — machine chatter, ack
 * ping-pong, synthetic senders) rather than re-deriving its subtle SQL; the storm
 * aggregates are thin own-SQL over coord_event_log, exactly as the sibling lanes
 * aggregate their own source tables (watchdog_ticks / pipeline_events).
 *
 * The PREMISE-RESOLVE signal (P-011 / D-091) is the one pattern here that is
 * AGGREGATE-ONLY BY CONSTRUCTION: `coord:premise-resolve-rate` carries no sender
 * suffix and must never grow one. `coord:wake-storm:<recipient>` is keyed and
 * `coord:unanswered` is not, so both shapes already exist in this lane — the
 * unkeyed one is an existing precedent, not a special case. See
 * `CoordPremiseResolve` for why keying a metric on an ASSERTED field by its
 * asserter destroys the very thing it measures.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { MetaPattern } from './types';
import type { PremiseRefKind } from '../agent-tools/coordination/message-fields';
import type { PremiseStatus } from '../agent-tools/coordination/premise-resolve';
import {
  buildEnforcementTierCensus,
  loadCoordBehaviourAdoption,
  loadCoordRegistrySnapshot,
  resolveTierDeclarations,
  type EnforcementTierCensus,
} from './enforcement-tier-census';
import {
  DISPATCH_ADOPTION_FLOOR,
  DISPATCH_BASELINE,
  evaluateDispatchAdoption,
  type DispatchAdoptionVerdict,
} from '../agent-tools/coordination/dispatch-adoption-falsifier';
import {
  loadDispatchAdoptionSample,
  type DispatchAdoptionCoverage,
} from '../agent-tools/coordination/dispatch-adoption-sample';
import type { DispatchAdoptionSample } from '../agent-tools/coordination/dispatch-adoption-falsifier';

/** One re-mounting escalation signature over the window (the pure builder input). */
export interface CoordEscalationStorm {
  /** the escalation's dedup signature (subjectSignature / livenessSignature / summary). */
  signature: string;
  /** distinct escalation OPEN events on this signature in the window (the re-mount count). */
  count: number;
  /** most-severe severity seen for this signature. */
  severity: 'blocker' | 'advisory' | 'unknown';
  /** a representative summary for context. */
  sample: string;
}

/** One recipient's inbound coord-message volume over the window. */
export interface CoordWakeStorm {
  recipient: string;
  /** messages + notifies delivered to this recipient in the window. */
  count: number;
}

/** One recipient's standing unanswered-directed backlog (from fetchUnansweredDirected). */
export interface CoordUnansweredTarget {
  recipient: string;
  count: number;
  oldestAgeMs: number;
}

/**
 * One REF KIND's premise-resolution tally (P-011 / D-091).
 *
 * Keyed by ref GRAMMAR, never by sender — see `CoordPremiseResolve` for why that
 * is a correctness constraint rather than a presentation choice.
 */
export interface CoordPremiseKindStat {
  kind: PremiseRefKind;
  /** refs that reached a falsifiable verdict (holds | broken | stale | unresolvable). */
  checked: number;
  holds: number;
  broken: number;
  stale: number;
  unresolvable: number;
}

/**
 * The premise-resolution aggregate over the window — the P-011 measurement that
 * REPLACES fill rate (D-104: forced sectioning made fill rate 100% by
 * construction, so it measures nothing).
 *
 * ⚠ THERE IS NO SENDER FIELD ON THIS TYPE, AND THERE MUST NEVER BE ONE (D-091).
 * `premises` is an ASSERTED field whose values are only PARTLY checkable: a typed
 * ref resolves against a graph, free prose cannot — and D-026 forbids excluding
 * the prose. Attach any per-agent consequence to being caught with an
 * unresolvable ref — a score, a nag, a warning, or merely a lane pattern naming
 * the sender — and the dominant strategy becomes "cite only what a graph can
 * verify, or stop citing". The measurement would then destroy what it measures,
 * and the uncheckable-but-true premises (the ones a sender must state precisely
 * BECAUSE no graph holds them) are the first to go. Same argument shape as the
 * owner's D-090 ruling on `forYouBecause`, and as `youMayNotKnow.provenance`.
 *
 * The breakdown is by REF KIND because that is what makes the reading ACTIONABLE
 * without attribution: it says which ref GRAMMAR is failing, which is fixable in
 * a tool description and in the docs. Attribution says only which agent to lean
 * on, which is the thing forbidden.
 */
export interface CoordPremiseResolve {
  /** distinct agent-authored premise refs seen in the window (context, NOT a rate). */
  refsSeen: number;
  /** refs that reached a falsifiable verdict — the RATE's denominator. */
  checked: number;
  /** refs that resolved and whose claim currently holds — the RATE's numerator. */
  holds: number;
  /** per-REF-KIND breakdown. Never per-agent. */
  byKind: readonly CoordPremiseKindStat[];
  /**
   * `doc` / `opaque` — declarable but never invalidatable (D-026). NOT failures,
   * and deliberately OUTSIDE the rate: counting them would punish the honest
   * citation of something no graph holds.
   */
  notCheckable: number;
  /** the probe itself failed. OUR failure, not the sender's — also outside the rate. */
  unknown: number;
  /** representative FAILING refs (ref + verdict only — never a sender). */
  samples: readonly { ref: string; status: PremiseStatus; note?: string }[];
}

/**
 * coord-derived-fields-2026-08-31 P-008 / D-004 — the `youMayNotKnow.provenance`
 * mechanism check, against the SAME invocation ledger `deriveBasedOn` queries.
 *
 * WHAT IS CHECKED, AND WHAT IS DELIBERATELY NOT. The REF stays authored and
 * ungraded (unified-agent-state-plane D-090: theory-of-mind entries are valuable
 * precisely because they can be wrong). What IS checkable is the MECHANISM claim
 * `provenance:'computed'` — "this ref came out of a diff over tracked state" —
 * which predicts the sender READ something yielding that ref shortly before the
 * send. The probe asks exactly that: does the sender's `tool_invocations` window
 * (READ_REF_MAPPERS grammar, BASED_ON_WINDOW_MS) contain an args-derivable read
 * of the cited ref?
 *
 * ⚠ ONE-SIDED IN BOTH DIRECTIONS — the doc on `YouMayNotKnowEntry.provenance`
 * binds here verbatim:
 *   · `matched` is "not refuted", NEVER "verified" — nothing proves a diff ran.
 *   · `unmatched` is NOT proof of mislabelling: READ_REF_MAPPERS deliberately
 *     omits query-shaped reads (work_items:list, search:*, facts:list) because
 *     no ref is derivable from their args — a genuine computed entry sourced
 *     through one of those has NO ledger row BY DESIGN. `unmatched` means "no
 *     args-derivable source found", a labelling-quality signal, not a catch.
 *
 * ⚠ NO SENDER DIMENSION, EVER (D-004, copying the couplingDivergence consumption
 * contract; D-090 R3 / D-091 reasoning): `computed` is the only value that can be
 * caught wrong, so any per-agent consequence — a warning, nag, score, or refusal —
 * makes "label everything `authored`" the dominant strategy and erases the very
 * distinction the field draws. Aggregate reads only; never a per-message marker.
 */
export interface CoordProvenanceCheck {
  /** `provenance:'computed'` entries seen in the window (agent-authored senders only; capped). */
  computedSeen: number;
  /** claims the probe reached a verdict on — the rate's denominator. */
  checked: number;
  /** an args-derivable read of the cited ref existed in the sender's window — "not refuted". */
  matched: number;
  /** no args-derivable source found — weak evidence (see one-sidedness above). */
  unmatched: number;
  /** the probe itself failed — OUR failure, outside the rate. */
  unknown: number;
  /** representative UNMATCHED refs (ref only — never a sender). */
  samples: readonly { ref: string }[];
}

/**
 * P-012 / D-106 — did moving clarification onto the LIVE path actually raise
 * P(answer)? The adoption reading for the `clarify` message field.
 *
 * WHAT THIS MEASURES, AND WHY IT IS THIS AND NOT FILL RATE. `clarify` carries a
 * question PAIRED with the assumption the sender proceeds on. `assuming` is
 * MANDATORY IN THE SCHEMA — so "share of entries carrying an assumption" is
 * 100% by construction and measures exactly nothing. That is D-104's vacuous
 * metric in a new costume, and it is deliberately absent from this type.
 *
 * The falsifiable question is the one D-106's whole argument rests on: asking
 * only pays when an answer actually arrives, so the signal is the ANSWER RATE.
 * The baselines to beat were measured on the incumbent surface before the field
 * existed (2026-08-02, 60d): the conversation path answered 10 of 42 questions
 * (~24%) and orphaned 32 (76%), while `coord:ask` drew 6 calls against
 * `coord:send`'s 3512 (~1:84). If clarification-on-the-live-path is the right
 * call, this rate beats 24%.
 *
 * ⚠ EXPECT ZERO FOR A WHILE, AND THAT IS NOT A DEFECT. The field ships in the
 * same change as this reading, so there is no traffic yet by construction. The
 * builder is SILENT below `minClarifyAsks` rather than reporting a 0/0 rate,
 * for the same reason `coord:premise-resolve-rate` is: a rate over a handful of
 * events is noise wearing a number's clothes, and an emitted 0% would read as a
 * finding about the field rather than an absence of data.
 *
 * ⚠ NO SENDER DIMENSION — same constraint as `CoordPremiseResolve`, and it
 * binds harder here. Keying an ASK metric by the asking agent makes asking a
 * thing to avoid being seen doing, which kills the field outright (D-091,
 * generalising the owner's D-090 R3).
 */
export interface CoordClarifyAdoption {
  /** agent-authored messages in the window carrying ≥1 `clarify` entry. */
  asks: number;
  /** of those, how many drew a reply. The RATE's numerator. */
  answered: number;
  /** total `clarify` entries (one message may carry several). Context, not a rate. */
  entries: number;
}

/**
 * THE THREE LEVELS OF "ADOPTION" (plan coordination-spec-adoption-2026-08-03,
 * D-091 there — not to be confused with agent-protocol D-091 cited above).
 *
 * WHY THIS SHAPE. "Adoption" was doing three different jobs, and conflating them
 * produced a headline that was wrong by two orders of magnitude
 * (EI-19300252001829260: "0.58% adopted", measured on a denominator that mixed
 * system writers and machine lifecycle emissions in with agent prose — its
 * NUMERATOR was exactly right). So this type refuses to collapse them:
 *
 *   L1 PRESENCE    the field is there. A PRECONDITION, never a headline — a
 *                  schema that refuses the old shape can compel presence, so
 *                  L1 alone cannot tell real use from wrapper compliance.
 *   L2 SUBSTANCE   the content is non-degenerate (several sections, authored
 *                  fields actually filled).
 *   L3 CONSEQUENCE a reader received it and its next action differed. The only
 *                  level that means the spec is working, and the one nothing in
 *                  this system measured before this type existed.
 *
 * EVERY COUNT CARRIES ITS OWN DENOMINATOR as a sibling field, because the one
 * failure this is built to prevent is a ratio quoted without one (D-003).
 *
 * ⚠ NO SENDER DIMENSION — the same constraint as {@link CoordPremiseResolve} and
 * {@link CoordClarifyAdoption}, and it binds here too: a per-agent adoption
 * breakdown turns a coordination field into a compliance scoreboard, and writing
 * `forYouBecause` to avoid looking bad is not a theory of mind (D-090/D-091 R3).
 */
export interface CoordAuthoredAdoption {
  /**
   * L1 denominator: hand-authored agent prose in the window. Machine senders and
   * `auto:true` lifecycle emissions are excluded (they CANNOT carry sections, so
   * including them is the EI-19300252001829260 bug), AND — D-095 — so is anything
   * lacking `expects`, which `coord:send` requires and therefore proves the
   * message came through the agent-callable tool at all.
   */
  handAuthored: number;
  /**
   * L1 numerator: of those, how many carry a `sections` array.
   *
   * ⚠ THIS IS NOT A COMPLIANCE RATE, and reading it as one is the D-095 error.
   * `stampMessageFields` writes `sections` only when they CARRY something
   * (`authored || sections.length > 1`), so the compliant minimum `body:[{text}]`
   * — the exact shape the refusal message teaches — persists NO `sections` key.
   * A fully compliant message therefore counts AGAINST this number. Measured:
   * 200 of 236 "sectionless" messages had passed the schema. What this actually
   * measures is (authored ∨ multi-section), which is `withAuthoredField` ∪
   * `multiSection` — an L2 reading, not an independent precondition.
   *
   * True L1 compliance is now 100% BY CONSTRUCTION on this denominator (the
   * schema refuses everything else), and per D-016 a field that is 100% by
   * construction measures nothing. The informative number in this slot is
   * {@link bypassedChokepoint}.
   */
  withSections: number;
  /**
   * THE REAL L1 (D-095): agent-identity messages in the window that never reached
   * the schema — no `expects`, so they were emitted by code calling the
   * `sendMessage` seam directly rather than by an agent through `coord:send`.
   *
   * Reported as a COUNT, not a rate, and deliberately NOT folded into
   * `handAuthored`: it is a different population, not a failing slice of the same
   * one. Its floor is the honest reading of "is the enforcement actually
   * enforcing" — a number that can only be moved by closing a send path, never by
   * an agent writing better messages.
   */
  bypassedChokepoint: number;
  /** L2: of the sectioned ones, how many carry MORE than one section (a 1-element array is what a wrapper looks like). */
  multiSection: number;
  /** L2: of the sectioned ones, how many fill ≥1 authored field (forYouBecause / premises / youMayNotKnow / couldNotDetermine). */
  withAuthoredField: number;
  /** L3 TREATMENT denominator: messages carrying an ACTIONABLE authored field (`couldNotDetermine` or `youMayNotKnow`) — the ones that ask a reader to do something. */
  openQuestions: number;
  /** L3 TREATMENT numerator: of those, how many drew a reply from a recipient. */
  openQuestionsAnswered: number;
  /** L3 CONTROL denominator: hand-authored messages in the same window carrying NO authored field at all. */
  plainMessages: number;
  /** L3 CONTROL numerator: of those, how many drew a reply. Without this arm the treatment rate is uninterpretable — a 40% reply rate is a success or a failure depending entirely on what plain messages get. */
  plainMessagesAnswered: number;
  /** L3 context: `coord:read` calls in the window — the only surface that shows authored structure IN FULL. The in-band marker carries the forYouBecause RELATION and mere COUNTS; the note, the youMayNotKnow items and premises past the first live behind this call. */
  structureReads: number;
}

/** The pure builder's input — the coordination-breakdown aggregate over the window. */
export interface CoordHealthInput {
  /** re-mounting escalation signatures (open events grouped by signature). */
  escalationStorms: readonly CoordEscalationStorm[];
  /** per-recipient inbound-message volume (inbox/wake flooding). */
  wakeStorms: readonly CoordWakeStorm[];
  /** fleet-wide standing unanswered-directed backlog per recipient. */
  unansweredTargets: readonly CoordUnansweredTarget[];
  /** claim-conflict events in the window. */
  claimConflicts: number;
  /** premise-citation quality (P-011 / D-091). Absent ⇒ the signal is simply not emitted. */
  premiseResolve?: CoordPremiseResolve;
  /** `clarify` adoption (P-012 / D-106). Absent ⇒ the signal is simply not emitted. */
  clarifyAdoption?: CoordClarifyAdoption;
  /** `youMayNotKnow.provenance` mechanism check (coord-derived-fields P-008 / D-004). Absent ⇒ the signal is simply not emitted. */
  provenanceCheck?: CoordProvenanceCheck;
  /** L1/L2/L3 authored-structure adoption (coordination-spec-adoption-2026-08-03 P-001). Absent ⇒ the signal is simply not emitted. */
  authoredAdoption?: CoordAuthoredAdoption;
  /** Enforcement-tier census (coordination-spec-adoption-2026-08-03 P-002 / the D-016/D-047 debt). Absent ⇒ the signal is simply not emitted. */
  enforcementCensus?: EnforcementTierCensus;
  /** `coord:dispatch` retirement falsifier (P-013 / D-100–D-102). Absent ⇒ the signal is simply not emitted. */
  dispatchAdoption?: CoordDispatchAdoption;
}

/**
 * A live reading of the `coord:dispatch` retirement falsifier: the sample, what
 * window the retained telemetry could actually substantiate, and the verdict the
 * PRE-COMMITTED bar returns for it.
 *
 * Carried as an already-judged triple so `buildCoordHealthPatterns` stays pure —
 * the evaluator is pure too, but the SAMPLE is IO, and the pure builder must not
 * reach for a database.
 */
export interface CoordDispatchAdoption {
  sample: DispatchAdoptionSample;
  coverage: DispatchAdoptionCoverage;
  verdict: DispatchAdoptionVerdict;
}

/**
 * The incumbent-surface baselines this reading is judged against, measured
 * 2026-08-02 over 60d BEFORE `clarify` existed (D-106). Named constants rather
 * than numbers inline in a template string, so a future re-measurement updates
 * one place and the emitted text cannot drift from the comment explaining it.
 */
export const CLARIFY_BASELINE_CONVERSATION_ANSWER_RATE = 0.24;

export interface CoordHealthOpts {
  /** min re-mounts to surface an escalation storm (advisory); a blocker surfaces at 1. */
  minEscalationReMounts?: number;
  /** min per-recipient unanswered-directed count for a recipient to count as "backlogged". */
  minUnanswered?: number;
  /** min inbound-message count for a recipient to surface as an inbox/wake flood. */
  minWakeStorm?: number;
  /** min claim-conflict events to surface the pattern. */
  minClaimConflicts?: number;
  /** min CHECKED premise refs before the resolve-rate is worth reporting at all. */
  minPremiseChecked?: number;
  /** min `clarify` asks before the answer-rate is worth reporting at all. */
  minClarifyAsks?: number;
  /** min CHECKED `provenance:'computed'` claims before the mechanism-check is worth reporting — below it the rate is noise wearing a number's clothes. */
  minComputedClaims?: number;
  /** min hand-authored messages in the window before the L1/L2/L3 adoption reading is worth reporting — below it the ratios are noise, and a 0/0 "adoption %" is exactly the kind of number this signal exists to stop publishing. */
  minAuthoredAdoptionMessages?: number;
  /** min UNDECLARED coordination behaviours before the tier-census signal is worth emitting — at zero the debt is closed and there is nothing to report. */
  minTierDebt?: number;
  /** cap on emitted patterns. */
  limit?: number;
}

/** Slugify a free-text signature/recipient into a compact, stable ref suffix. */
/**
 * The ref prefixes of this lane's KEYED families — one pattern per escalation
 * signature and per flooded recipient, so both are unbounded in fleet size.
 * Everything else this lane emits is a single corpus-wide reading.
 *
 * Used by the cap policy at the end of `buildCoordHealthPatterns`: the limit is
 * spent on these, never on the measurements. Adding a new KEYED family means
 * adding it here — a new SINGLETON needs no change, which is the safe default.
 */
export const KEYED_PATTERN_FAMILIES = [
  'coord:escalation-storm:',
  'coord:wake-storm:',
] as const;

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'unknown'
  );
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function humanAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${rem}m` : `${h}h`;
}

/**
 * PURE: the coordination-breakdown aggregate → digest patterns.
 *
 * Emits (most-acute first): re-mounting ESCALATION STORMS (the leaking dedup gate —
 * a blocker surfaces even at one re-mount; an advisory needs a chronic count), the
 * fleet-wide UNANSWERED-DIRECTED backlog (comms stalling), CLAIM CONFLICTS (two
 * agents on one item), then the chronic WAKE/INBOX FLOODS (noise burning turns).
 * Sorted acute→chronic, capped.
 */
export function buildCoordHealthPatterns(
  input: CoordHealthInput,
  opts: CoordHealthOpts = {},
): MetaPattern[] {
  const minReMounts = opts.minEscalationReMounts ?? 3;
  const minUnans = opts.minUnanswered ?? 5;
  const minWake = opts.minWakeStorm ?? 200;
  const minClaim = opts.minClaimConflicts ?? 3;
  const minPremiseChecked = opts.minPremiseChecked ?? 5;
  const minClarifyAsks = opts.minClarifyAsks ?? 5;
  const minComputedClaims = opts.minComputedClaims ?? 5;
  const minAuthoredAdoptionMessages = opts.minAuthoredAdoptionMessages ?? 20;
  const minTierDebt = opts.minTierDebt ?? 1;
  const limit = opts.limit ?? 10;

  const out: MetaPattern[] = [];

  // 1. Escalation storms — a signature that re-mounts a full escalation cascade.
  //    A blocker demands attention even at one re-mount; an advisory must be chronic.
  const storms = [...input.escalationStorms]
    .filter((s) => (s.severity === 'blocker' && s.count >= 1) || s.count >= minReMounts)
    .sort(
      (a, b) =>
        (b.severity === 'blocker' ? 1 : 0) - (a.severity === 'blocker' ? 1 : 0) ||
        b.count - a.count,
    );
  for (const s of storms) {
    out.push({
      category: 'coord-health',
      ref: `coord:escalation-storm:${slug(s.signature)}`,
      summary: `escalation re-mounted ${s.count}× in 24h (${s.severity}): ${trunc(s.signature, 80)} — a repeating cascade, not a one-off`,
      detail: `${s.count} escalation event(s)/24h on the same signature${
        s.sample ? `; e.g. "${trunc(s.sample, 120)}"` : ''
      }. A known-benign transient re-mounting a full escalation cascade (fresh work-item + probe + owner alert) means the "is this the same incident" dedup gate is too narrow (EI-9492): widen the dedup key or add a recently-resolved suppression so the same condition can't re-page every wake.`,
      weight: s.severity === 'blocker' ? 1 : 0.8,
    });
  }

  // 2. Unanswered directed — a directed message is meant to PREEMPT the recipient's
  //    work, so a growing per-agent backlog means agents are alive but not draining
  //    their reply queue (the "live but not converting" stall).
  const worst = [...input.unansweredTargets]
    .filter((t) => t.count >= minUnans)
    .sort((a, b) => b.count - a.count);
  if (worst.length > 0) {
    const total = worst.reduce((n, t) => n + t.count, 0);
    const top = worst
      .slice(0, 5)
      .map((t) => `${t.recipient} ${t.count} (${humanAge(t.oldestAgeMs)})`)
      .join(', ');
    out.push({
      category: 'coord-health',
      ref: 'coord:unanswered',
      summary: `${worst.length} agent(s) hold ≥${minUnans} unanswered directed message(s) (${total} total) — directed comms are stalling`,
      detail: `worst: ${top}. A directed message OUTRANKS the recipient's own work; a per-agent backlog that grows across wakes despite landed nudges is a coordination-comms stall (agents alive, producing turns, but not converting into reply-drain or claim progress) — the reply-obligation surfacing or the wake→reply path may be failing.`,
      weight: 0.7,
    });
  }

  // 3. Claim conflicts — two agents handed the same work-item (scheduler/claim-spec
  //    dedup leak, or a stale claim not releasing).
  if (input.claimConflicts >= minClaim) {
    out.push({
      category: 'coord-health',
      ref: 'coord:claim-conflict',
      summary: `${input.claimConflicts} claim conflict(s) in 24h — agents contending for the same work-item`,
      detail:
        'repeated claim conflicts mean the scheduler/claim-spec is surfacing the same item to multiple agents, or a stale claim is not releasing on session death; check claim TTLs, the hold-open sweep cadence, and scheduler dedup.',
      weight: 0.6,
    });
  }

  // 4. Premise-citation quality (P-011 / D-091) — the replacement for fill rate.
  //
  //    ⚠ CORRECTED 2026-08-09 (WI-37443). This used to read "emitted BEFORE the
  //    wake-storm floods … ordering is the cap policy here", and that protection
  //    was FALSE: escalation storms are keyed too AND are emitted first, so on a
  //    noisy fleet they consumed the entire limit and this reading was cut
  //    anyway — measured, all 10 slots taken by `coord:escalation-storm:*`.
  //    The cap is now spent on the KEYED families only (see the tail of this
  //    function), so every corpus-wide measurement survives regardless of order.
  const pr = input.premiseResolve;
  if (pr && pr.checked >= minPremiseChecked) {
    const failed = pr.checked - pr.holds;
    const rate = pr.holds / pr.checked;
    const failRate = 1 - rate;
    const pct = (n: number) => `${Math.round(n * 100)}%`;

    // Per-KIND, worst grammar first — that ordering is the actionable part.
    const kinds = [...pr.byKind]
      .filter((k) => k.checked > 0)
      .sort(
        (a, b) => b.checked - b.holds - (a.checked - a.holds) || b.checked - a.checked,
      );
    const kindLine = kinds
      .map((k) => `${k.kind} ${k.holds}/${k.checked}`)
      .join(', ');
    const sampleLine = pr.samples
      .slice(0, 4)
      .map((s) => `${s.ref} → ${s.status}${s.note ? ` (${trunc(s.note, 60)})` : ''}`)
      .join('; ');

    out.push({
      category: 'coord-health',
      ref: 'coord:premise-resolve-rate',
      summary: `premise refs resolve ${pct(rate)} (${pr.holds}/${pr.checked} checked; ${failed} failing) — cited ground that does not hold`,
      detail:
        `by ref kind: ${kindLine || 'n/a'}. ` +
        `${pr.refsSeen} distinct agent-authored premise ref(s) in 24h; ${pr.notCheckable} not-checkable (doc/opaque — declarable but never invalidatable, D-026, deliberately outside the rate) and ${pr.unknown} unknown (the probe failed — our gap, not the sender's).` +
        (sampleLine ? ` Failing: ${sampleLine}.` : '') +
        ` A premise is what a sender's reasoning RESTED ON, so a ref that does not resolve means a message was built on ground that was never there (broken) or has since moved (stale). ` +
        `Read this by REF GRAMMAR, never by sender: the fix for a failing kind is a clearer ref form in the tool description and the docs. ` +
        `NOT a gate — a low rate never blocks, warns, or refuses a send (D-091; D-088's standing condition that verification is never authorisation).`,
      // Weight tracks the FAILURE rate, not the volume: an all-holds reading is
      // still emitted (a reader that only ever sees failures cannot tell "no
      // premises were checkable" from "all of them held" — the same argument
      // premise-resolve.ts makes for carrying both stamp halves), but it ranks
      // low enough that the cap deprioritises it naturally.
      weight: Math.min(0.75, 0.25 + 0.5 * failRate),
    });
  }

  // 4b. `clarify` adoption (P-012 / D-106) — did moving clarification onto the
  //     live path raise P(answer)? Emitted next to the premise reading, and for
  //     the same cap reason: it is ONE corpus-wide reading competing with
  //     per-recipient floods.
  const ca = input.clarifyAdoption;
  if (ca && ca.asks >= minClarifyAsks) {
    const rate = ca.answered / ca.asks;
    const base = CLARIFY_BASELINE_CONVERSATION_ANSWER_RATE;
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const verdict =
      rate > base
        ? `ABOVE the ${pct(base)} conversation-path baseline — moving clarification onto the live path is paying`
        : `at or BELOW the ${pct(base)} conversation-path baseline — the live path is not (yet) buying a better answer rate`;

    out.push({
      category: 'coord-health',
      ref: 'coord:clarify-answer-rate',
      summary: `clarify asks answered ${pct(rate)} (${ca.answered}/${ca.asks}) — ${verdict}`,
      detail:
        `${ca.asks} agent-authored message(s) carried a \`clarify\` section in 24h (${ca.entries} entr(y|ies) total); ${ca.answered} drew a reply. ` +
        `\`clarify\` pairs a question with the assumption the sender proceeds on ANYWAY, so an unanswered ask is not a stalled sender — it is a peer acting on an assumption nobody corrected. ` +
        `Baseline to beat (measured before the field existed): the conversation path answered ~${pct(base)} of questions and orphaned 76%, and coord:ask drew 6 calls against coord:send's 3512. ` +
        `Read this as a reading on the MECHANISM, never on the askers: no per-agent breakdown exists or may be added, because attaching a consequence to being seen asking is what kills the field (D-091/D-090 R3). ` +
        `Never a gate, and never a fill rate — \`assuming\` is schema-mandatory, so its fill rate is 100% by construction and measures nothing (D-104).`,
      // Ranks by SHORTFALL against the baseline: a rate that beats the incumbent
      // is good news and should not crowd out live coordination breakdowns.
      weight: Math.min(0.7, 0.25 + Math.max(0, base - rate)),
    });
  }

  // 4c. `youMayNotKnow.provenance` mechanism check (coord-derived-fields P-008 /
  //     D-004) — the couplingDivergence consumption contract: ONE corpus-wide
  //     aggregate, no sender dimension, never a per-message marker.
  const pv = input.provenanceCheck;
  if (pv && pv.checked >= minComputedClaims) {
    const rate = pv.matched / pv.checked;
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const sampleLine = pv.samples
      .slice(0, 3)
      .map((s) => trunc(s.ref, 60))
      .join('; ');
    out.push({
      category: 'coord-health',
      ref: 'coord:computed-provenance-check',
      summary: `youMayNotKnow provenance:'computed' claims: ${pv.matched}/${pv.checked} (${pct(rate)}) had an args-derivable read of the cited ref in the sender's window`,
      detail:
        `${pv.computedSeen} computed-labelled entr(y|ies) from agent-authored messages in 24h; ${pv.unknown} unknown (the probe failed — our gap, outside the rate). ` +
        `ONE-SIDED both ways: matched = "not refuted", never verified (nothing proves a diff ran); unmatched = "no args-derivable source" — query-shaped reads (list/search) have no ledger ref BY DESIGN, so this is a labelling-quality signal, not a catch.` +
        (sampleLine ? ` Unmatched: ${sampleLine}.` : '') +
        ` The authored ref itself stays ungraded (D-090: being wrong is the payload); only the MECHANISM claim is checked. ` +
        `AGGREGATE-ONLY, no sender dimension ever (D-004/D-091): attach a per-agent consequence and "label everything authored" becomes dominant, erasing the distinction. Never a gate, warning, nag, score, or refusal.`,
      // Ranks by the unmatched share, capped below the live-breakdown floods —
      // this is a data-quality reading, not an incident.
      weight: Math.min(0.65, 0.2 + 0.45 * (1 - rate)),
    });
  }

  // 4b. AUTHORED-STRUCTURE ADOPTION, reported as THREE levels and never as one
  //     number (coordination-spec-adoption-2026-08-03 D-091). The summary leads
  //     with L3 because L3 is the only level that says the spec is working: L1
  //     was ~80% and L2 healthy at a moment when the full structure was opened
  //     15 times in a week, and a single blended "adoption %" would have hidden
  //     exactly that.
  const aa = input.authoredAdoption;
  if (aa && aa.handAuthored >= minAuthoredAdoptionMessages) {
    const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : 'n/a');
    // D-095: L1 is the BYPASS count, not a presence rate. `withSections` cannot
    // express compliance — the compliant minimum stamps nothing — so a rate built
    // on it reports compliant traffic as failure. What an operator can act on is
    // how many messages never reached the schema at all.
    const l1 = `${aa.bypassedChokepoint} bypassed`;
    const l2 = pct(aa.withAuthoredField, Math.max(aa.withSections, 1));
    // The same numerator against the UNCONDITIONAL denominator. The conditional
    // rate above answers "of the messages that already carried structure…",
    // which stays high even if structure is rare; this one cannot.
    const l2All = pct(aa.withAuthoredField, aa.handAuthored);
    // L3 is reported as a LIFT against the control arm, never as a floating
    // rate. D-085 requires the control arm for exactly this reason: "40% of
    // messages carrying an open question drew a reply" is a success or a failure
    // depending entirely on what a PLAIN message gets, and without the
    // comparison the number cannot be read either way.
    const treatRate = aa.openQuestions > 0 ? aa.openQuestionsAnswered / aa.openQuestions : null;
    const ctrlRate = aa.plainMessages > 0 ? aa.plainMessagesAnswered / aa.plainMessages : null;
    const l3 =
      treatRate === null
        ? 'no actionable messages'
        : ctrlRate === null
          ? `${pct(aa.openQuestionsAnswered, aa.openQuestions)} (no control arm this window — uninterpretable)`
          : `${pct(aa.openQuestionsAnswered, aa.openQuestions)} vs ${pct(aa.plainMessagesAnswered, aa.plainMessages)} plain ` +
            `(${treatRate >= ctrlRate ? '+' : ''}${Math.round((treatRate - ctrlRate) * 100)}pp)`;

    // The gap that matters: structure written vs structure ever opened in full.
    const writtenWithStructure = aa.withAuthoredField;
    const readStarved = writtenWithStructure > 0 && aa.structureReads * 10 < writtenWithStructure;

    out.push({
      category: 'coord-health',
      ref: 'coord:authored-adoption',
      summary:
        `authored structure — L1 enforcement ${l1} (never reached the schema; ${aa.handAuthored} hand-authored did), ` +
        `L2 substantive ${l2All} of all hand-authored (${aa.withAuthoredField}/${aa.handAuthored}; ${l2} = ${aa.withAuthoredField}/${aa.withSections} of those carrying structure), ` +
        `L3 open-questions answered ${l3}` +
        (readStarved ? ` — READ-STARVED: ${writtenWithStructure} written vs ${aa.structureReads} coord:read` : ''),
      detail:
        `Three levels, deliberately NOT collapsed into one number. ` +
        `L1 ENFORCEMENT ${aa.bypassedChokepoint} message(s) reached the log WITHOUT passing coord:send's schema — emitted by code calling the sendMessage seam directly under an agent's ownerId. That is the only actionable L1 number: true schema compliance is now 100% BY CONSTRUCTION (the string body is refused), and per D-016 a field that is 100% by construction measures nothing. ` +
        `⚠ D-095: this slot used to report "${aa.withSections}/${aa.handAuthored} carry sections" as a COMPLIANCE rate. It never was one — stampMessageFields writes \`sections\` only when they carry something (authored || >1), so the compliant minimum body:[{text}] persists no sections key and counted as a FAILURE. Measured: 200 of 236 such messages had passed the schema. \`withSections\` is an L2 reading (authored ∪ multi-section), and is reported as one below. ` +
        `L2 SUBSTANCE ${aa.withAuthoredField}/${aa.handAuthored} hand-authored messages fill an authored field (${l2All}) — the unconditional rate, and the one to read. Conditionally, ${aa.withAuthoredField}/${aa.withSections} of those already carrying structure do, and ${aa.multiSection} carry more than one section; that conditional rate stays high even when structure is rare, which is why both denominators are stated. ` +
        `L3 CONSEQUENCE ${aa.openQuestionsAnswered}/${aa.openQuestions} messages carrying an ACTIONABLE authored field (couldNotDetermine / youMayNotKnow) drew a reply, against a CONTROL arm of ${aa.plainMessagesAnswered}/${aa.plainMessages} hand-authored messages with no authored field at all — same senders, same window. ` +
        `The control is what makes the treatment rate mean anything (D-085): a bare reply rate is a success or a failure depending on what a plain message gets, and reporting it alone is how a correct numerator becomes a wrong conclusion. ` +
        `coord:read — the only surface showing authored structure IN FULL — was called ${aa.structureReads} time(s) in 24h. ` +
        `The in-band [coord+N] marker carries the forYouBecause RELATION and mere COUNTS; the note, the youMayNotKnow items and premises past the first are only visible through coord:read. ` +
        `A LOW L3 against a HIGH L2 is the diagnostic this signal exists to make visible: it means the write half of "agents write their intent and other agents read it" shipped and the read half did not. (Stated against L2 since D-095 — L1 is now an enforcement count, and a count of bypasses says nothing about whether written structure is being read.) ` +
        `Denominators are stated inline on purpose — a ratio quoted without one is how "0.58% adopted" was published from a numerator that was exactly right (EI-19300252001829260). ` +
        `Aggregate-only, and no per-sender breakdown exists or may be added: attaching a consequence to being seen authoring these fields is what kills them (D-090/D-091 R3).`,
      // Ranks by the READ gap first: structure written but never opened is the
      // alarming state and must outrank a low substance rate that is merely early.
      //
      // D-095: the fallback used to rank by `1 - withSections/handAuthored`, which
      // read every compliant plain send as a miss — it ranked hardest on the
      // artifact, so the signal rose fastest when nothing was wrong. It now ranks
      // on the SUBSTANCE gap (a real behaviour an agent can change), with a floor
      // under any live bypass, since a send path that skips enforcement outranks a
      // merely-thin authoring rate.
      weight: readStarved
        ? 0.65
        : Math.max(
            aa.bypassedChokepoint > 0 ? 0.4 : 0,
            Math.min(0.5, 0.2 + (1 - aa.withAuthoredField / Math.max(aa.handAuthored, 1)) * 0.3),
          ),
    });
  }

  // 4c. ENFORCEMENT-TIER CENSUS (P-002 / the D-016/D-047 debt). The sibling of 4b
  //     and its structural counterpart: 4b measures whether a shipped behaviour is
  //     USED, this measures whether it is ENFORCED at all. The pair is the point —
  //     without a tier column you cannot tell a verb that is UNUSED from one that
  //     is merely UNENFORCED, so the reflex for every low number is "add more
  //     prompt text", which D-001 measured as the weakest lever there is.
  const cen = input.enforcementCensus;
  if (cen && cen.totals.undeclared >= minTierDebt) {
    const t = cen.totals;
    // Every count names its denominator inline (D-003). There is deliberately no
    // single "enforcement %" — averaging a tier ladder is exactly the summary
    // that would hide which rung a behaviour sits on.
    const worstOffenders = cen.rows
      .filter((r) => r.retirementCandidate)
      .slice(0, 6)
      .map((r) => r.id);

    out.push({
      category: 'coord-health',
      ref: 'coord:enforcement-tier-census',
      summary:
        `enforcement tiers — ${t.undeclared}/${t.behaviours} coordination verbs carry NO declared tier, ` +
        `${t.enforced}/${t.behaviours} carry a real one (D-001 tier 1–3); ` +
        `${t.zeroCall}/${t.behaviours} took zero calls in ${cen.windowDays}d, of which ${t.retirementCandidates} are both unused AND unenforced`,
      detail:
        `Generated from the live tool registry, never a hand-kept list: a coordination verb added tomorrow surfaces here as debt with nobody remembering to list it. ` +
        `TIER DEBT ${t.undeclared}/${t.behaviours} have no declaration at all — the D-016/D-047 gap. ENFORCED ${t.enforced}/${t.behaviours} carry one of D-001's tiers 1–3 (auto-stamp / schema-refusal / see-also). PROMPT-ONLY ${t.promptOnly} are declared but enforced only by prose, which D-016 says is not a tier — that is the finding, not a passing grade. ` +
        `ZERO-CALL ${t.zeroCall}/${t.behaviours} took no call in the ${cen.windowDays}d window. ` +
        `RETIREMENT CANDIDATES ${t.retirementCandidates} are zero-call AND unenforced` +
        (worstOffenders.length ? ` (e.g. ${worstOffenders.join(', ')})` : '') +
        `. A zero-call verb that DOES carry a real tier is deliberately NOT flagged — that is a different finding (built but unreached), and conflating the two would propose retiring working machinery. ` +
        `⚠ CANDIDATE, never a verdict: D-092 ruled that the zero-call verbs are NOT to be retired — make them discoverable first, re-measure at +7d, and retire only what stays at zero. This reading is the input to that re-measurement, which is why the window is ${cen.windowDays}d and not 24h: over 24h a merely weekly verb reads as dead. ` +
        `Denominators are stated inline on purpose (D-003), and there is no single blended "enforcement %" — a mean over "how enforced is this" is precisely the summary that hides which rung a behaviour sits on. ` +
        `The fix for an undeclared row is to find the MECHANISM that enforces it and declare that; if none exists, the honest tier is prompt-only, and D-001's ruling then applies: a behaviour that cannot be given tier 1–3 is a candidate for retirement, not for more prompt text.`,
      // Ranks by the share of behaviours carrying NO enforcement at all. Tier debt
      // is structural and slow-moving, so it must never outrank a live
      // coordination breakdown (escalation storms, unanswered backlogs).
      weight: Math.min(0.55, 0.2 + (t.undeclared / Math.max(t.behaviours, 1)) * 0.35),
    });
  }

  // 4b. The `coord:dispatch` retirement falsifier (P-013 / D-100–D-102). This is
  //     the surface that makes the pre-commitment REAL: a falsifier that is never
  //     evaluated is indistinguishable from never having committed to one, which
  //     is the failure P-013 existed to prevent (WI-37443 — the evaluator shipped
  //     with zero callers). Emitting it here rather than from a new routine is
  //     deliberate: this lane already runs on the live scout cycle, so the check
  //     fires by construction instead of waiting for someone to activate a row.
  const da = input.dispatchAdoption;
  if (da) {
    const den = `${da.sample.sendCalls} coord:send calls / ${da.sample.windowDays}d`;
    const rate =
      da.verdict.verdict === 'undetermined'
        ? null
        : `${da.verdict.ratePerThousand.toFixed(2)}/1k`;
    const shortfall = da.coverage.shortfall
      ? ` ⚠ telemetry retention could only substantiate ${da.coverage.coveredWindowDays}d of the ${da.coverage.requestedWindowDays}d asked for (oldest retained row ${da.coverage.oldestRetainedAt}), so the window published here is the one the data supports, not the one requested.`
      : '';

    out.push({
      category: 'coord-health',
      ref: 'coord:dispatch-adoption-verdict',
      summary:
        `coord:dispatch retirement falsifier — ${da.verdict.verdict.toUpperCase()}` +
        (rate ? ` at ${rate} sends across ${da.sample.dispatchAgents} agent(s)` : '') +
        ` (denominator ${den}; bar ${DISPATCH_ADOPTION_FLOOR.ratePerThousand}/1k + ${DISPATCH_ADOPTION_FLOOR.distinctAgents} agents, not judgeable before ${DISPATCH_ADOPTION_FLOOR.reEvaluateAfter})`,
      detail:
        `${da.verdict.why} ` +
        `DENOMINATOR STATED INLINE per D-003: ${den}, sampled ${da.sample.asOf} across ALL tenants — the same population the baseline was measured over (${DISPATCH_BASELINE.dispatchCalls} dispatch / ${DISPATCH_BASELINE.sendCalls} sends over ${DISPATCH_BASELINE.windowDays}d = ${DISPATCH_BASELINE.ratePerThousand}/1k). ` +
        `A sample scoped differently from its baseline would report a lift between two different populations. ` +
        shortfall +
        ` ⚠ UNDETERMINED IS NEVER UPGRADED TO RETIRE (the asymmetry is deliberate): an absent measurement must not read as absent demand. ` +
        `A \`retire\` verdict retires coord:dispatch AND coord:handoff together (D-102 folded handoff in, because deleting the handoff store before the measurement would have destroyed the evidence). ` +
        `This reading is emitted every cycle so the verdict is a standing, dated record rather than a one-shot nobody witnessed.`,
      // Deliberately modest until the bar is judgeable: before the re-evaluate
      // date this is a dated no-op, and it must never outrank a live coordination
      // breakdown. A real `retire`/`keep` verdict is a decision input, so it
      // outranks tier debt but still sits under an active storm.
      weight: da.verdict.verdict === 'undetermined' ? 0.15 : 0.5,
    });
  }

  // 5. Wake / inbox floods — one recipient buried under thousands of (often near-
  //    duplicate) deliveries: a subscription firehose or a re-firing sender whose
  //    coalescing/dedup is leaking; heavy wake traffic burns turns and buries real
  //    directed mail.
  const floods = [...input.wakeStorms]
    .filter((w) => w.count >= minWake)
    .sort((a, b) => b.count - a.count);
  for (const w of floods) {
    out.push({
      category: 'coord-health',
      ref: `coord:wake-storm:${slug(w.recipient)}`,
      summary: `${w.recipient} received ${w.count} coord message(s) in 24h — an inbox/wake flood`,
      detail: `${w.count} deliveries/24h to one recipient. A subscription firehose or a re-firing sender is flooding this inbox — if most are near-duplicates the coalescing/dedup is leaking; heavy wake traffic burns turns and buries real directed mail under noise.`,
      weight: Math.min(0.6, 0.2 + w.count / 5000),
    });
  }

  // THE CAP POLICY. Two of this lane's families are KEYED and unbounded — one
  // pattern per escalation signature, one per flooded recipient — while every
  // other reading is a single corpus-wide measurement. A plain `slice` therefore
  // lets a noisy fleet silently DELETE the measurements, and "emit them earlier"
  // is not a fix: escalation storms are emitted first and are themselves keyed.
  //
  // MEASURED 2026-08-09 (WI-37443), which is how this was found: the live lane
  // returned 10 patterns and ALL TEN were `coord:escalation-storm:*` — 7 of them
  // per-agent `compaction-watchdog-context-death-su-<id>` rows. Every singleton
  // was cut, including `coord:premise-resolve-rate`, whose own comment claimed
  // ordering protected it. It did not.
  //
  // So the cap is applied to the KEYED families only. The singletons are few and
  // structurally bounded (one per measurement, seven in total), so keeping them
  // all cannot itself blow the budget. Ordering here is cap policy, NOT salience
  // — `weight` carries salience, and a live blocker storm still outranks a dated
  // no-op by weight regardless of position.
  // ⚠ The cap decides WHAT SURVIVES, never what order it comes back in: emission
  // order is salience here (the acute blocker leads), so the survivors are
  // re-emitted in their original positions.
  const cap = Math.max(1, limit);
  const isKeyed = (p: MetaPattern) => KEYED_PATTERN_FAMILIES.some((f) => p.ref.startsWith(f));
  const singletonCount = out.reduce((n, p) => (isKeyed(p) ? n : n + 1), 0);
  let keyedRoom = Math.max(0, cap - singletonCount);
  const survivors = new Set<MetaPattern>();
  for (const p of out) {
    if (!isKeyed(p)) survivors.add(p);
    else if (keyedRoom > 0) {
      survivors.add(p);
      keyedRoom -= 1;
    }
  }
  return out.filter((p) => survivors.has(p)).slice(0, cap);
}

/** Bound on how many distinct refs one lane pass will probe. */
const PREMISE_REFS_MAX = 200;

/**
 * The premise-resolution read (P-011 / D-091).
 *
 * ⚠ REUSES THE LIVE RESOLVER — `resolvePremiseStamps` + the production
 * `premiseProbes()` — deliberately, and this is the load-bearing design choice
 * rather than convenience. A second, lane-local "does this ref resolve" checker
 * would be free to drift from the one the SEND path stamps with, and the two
 * would then disagree about what "resolves" means: the corpus digest would
 * report a rate that no message stamp corroborates. One resolver, two callers.
 *
 * Every dependency is imported DYNAMICALLY inside the function, matching this
 * lane's existing treatment of `fetchUnansweredDirected` and premise-probes.ts's
 * own rule — the stores stay out of the module graph at load time.
 *
 * Fail-soft to `undefined`: an outage here removes the signal, never the lane.
 */
export async function loadCoordPremiseResolve(
  ws: string,
): Promise<CoordPremiseResolve | undefined> {
  try {
    const { sql } = getOrgPg();
    const [{ MACHINE_SENDER_PATTERN }, { resolvePremiseStamps, PREMISE_STAMPS_MAX }, { premiseProbes }] =
      await Promise.all([
        import('../agent-tools/coordination/machine-authored'),
        import('../agent-tools/coordination/premise-resolve'),
        import('../agent-tools/coordination/premise-probes'),
      ]);

    // AGENT-AUTHORED ONLY (D-091's denominator). The exclusion reuses the ONE
    // canonical machine-sender pattern shared by sendMessage and
    // unanswered-directed rather than a third hand-maintained list — a private
    // copy here is exactly how the three call sites would drift apart.
    // `premises` live on SECTIONS, never on the envelope (verified against the
    // live corpus: 78 sectioned rows, 0 envelope-level).
    const rows = await sql<Array<{ ref: string }>>`
      SELECT DISTINCT p AS ref
        FROM harness_shared.coord_event_log e
        CROSS JOIN LATERAL jsonb_array_elements(e.body->'sections') s
        CROSS JOIN LATERAL jsonb_array_elements_text(s->'premises') p
       WHERE e.workspace_id = ${ws}
         AND e.surface = 'messages'
         AND e.ts > now() - interval '24 hours'
         AND jsonb_typeof(e.body->'sections') = 'array'
         AND jsonb_typeof(s->'premises') = 'array'
         AND NOT (coalesce(e.body->>'from', '') ~ ${MACHINE_SENDER_PATTERN})
       LIMIT ${PREMISE_REFS_MAX}`;

    const refs = rows.map((r) => r.ref).filter(Boolean);
    if (refs.length === 0) return undefined;

    // `resolvePremiseStamps` caps at PREMISE_STAMPS_MAX (its per-MESSAGE
    // contract), so a window-wide read is chunked to that cap rather than
    // bypassing it — the cap keeps its meaning and the resolver stays untouched.
    const probes = premiseProbes({});
    const stamps: Awaited<ReturnType<typeof resolvePremiseStamps>> = [];
    for (let i = 0; i < refs.length; i += PREMISE_STAMPS_MAX) {
      stamps.push(...(await resolvePremiseStamps(refs.slice(i, i + PREMISE_STAMPS_MAX), probes)));
    }

    return aggregatePremiseStamps(stamps);
  } catch {
    return undefined;
  }
}

/**
 * PURE: resolved stamps → the per-REF-KIND aggregate. Split out from the IO so
 * the counting rules (what lands in the rate, what is held outside it) are
 * unit-testable without a database.
 */
export function aggregatePremiseStamps(
  stamps: readonly { ref: string; kind: PremiseRefKind; status: PremiseStatus; note?: string }[],
): CoordPremiseResolve {
  const byKind = new Map<PremiseRefKind, CoordPremiseKindStat>();
  let checked = 0;
  let holds = 0;
  let notCheckable = 0;
  let unknown = 0;
  const samples: { ref: string; status: PremiseStatus; note?: string }[] = [];

  for (const s of stamps) {
    // `not-checkable` and `unknown` are held OUTSIDE the rate on purpose: the
    // first would punish honestly citing something no graph holds (D-026), the
    // second would charge the sender for OUR probe failing.
    if (s.status === 'not-checkable') {
      notCheckable += 1;
      continue;
    }
    if (s.status === 'unknown') {
      unknown += 1;
      continue;
    }

    let k = byKind.get(s.kind);
    if (!k) {
      k = { kind: s.kind, checked: 0, holds: 0, broken: 0, stale: 0, unresolvable: 0 };
      byKind.set(s.kind, k);
    }
    k.checked += 1;
    checked += 1;
    if (s.status === 'holds') {
      k.holds += 1;
      holds += 1;
    } else {
      if (s.status === 'broken') k.broken += 1;
      else if (s.status === 'stale') k.stale += 1;
      else k.unresolvable += 1;
      if (samples.length < 8) samples.push({ ref: s.ref, status: s.status, note: s.note });
    }
  }

  return {
    refsSeen: stamps.length,
    checked,
    holds,
    byKind: [...byKind.values()],
    notCheckable,
    unknown,
    samples,
  };
}

/**
 * The `clarify` adoption read (P-012 / D-106).
 *
 * REPLY DETECTION, AND ITS KNOWN BIAS — STATED, NOT HIDDEN. An ask counts as
 * answered when a RECIPIENT sent a message threaded to it
 * (`related_msg_id` = the ask's `msg_id`). That is branch (1) of
 * `unanswered-directed`'s hardened predicate, reused verbatim in shape rather
 * than re-derived.
 *
 * Its LOOSE branch — an un-threaded reply back to the sender, narrowed and
 * PAIRED so one reply clears at most one ask (WI-6729, EI-13819, WI-5345) — is
 * deliberately NOT reproduced here. That logic is subtle, order-dependent, and
 * exists to protect a counter that PREEMPTS an agent's work; a second, simpler
 * copy of it in a digest lane would drift from the original and quietly
 * disagree with it. So this reading UNDER-COUNTS answers, because this fleet's
 * agents overwhelmingly reply in fresh standalone messages rather than
 * re-threading.
 *
 * The direction of that error is the safe one for THIS metric: it can only make
 * clarification look WORSE than it is, so a rate that still beats the 24%
 * conversation baseline is a conservative win rather than an artefact. It is
 * also apples-to-apples with that baseline, which was itself measured on an
 * explicit linkage (`accepted_post_id`). If the rate ever sits just under the
 * baseline, this bias is the FIRST thing to re-examine — not evidence against
 * the field.
 *
 * Fail-soft to `undefined`: an outage removes the signal, never the lane.
 */
export async function loadCoordClarifyAdoption(
  ws: string,
): Promise<CoordClarifyAdoption | undefined> {
  try {
    const { sql } = getOrgPg();
    const { MACHINE_SENDER_PATTERN } = await import(
      '../agent-tools/coordination/machine-authored'
    );

    const rows = await sql<Array<{ asks: number; answered: number; entries: number }>>`
      WITH asks AS (
        SELECT e.body->>'msg_id' AS msg_id,
               e.body->'to'      AS recipients,
               (
                 SELECT count(*)
                   FROM jsonb_array_elements(e.body->'sections') s2
                   CROSS JOIN LATERAL jsonb_array_elements(s2->'clarify') c
                  WHERE jsonb_typeof(s2->'clarify') = 'array'
               )::int AS entries
          FROM harness_shared.coord_event_log e
         WHERE e.workspace_id = ${ws}
           AND e.surface = 'messages'
           AND e.ts > now() - interval '24 hours'
           AND jsonb_typeof(e.body->'sections') = 'array'
           AND e.body->>'msg_id' IS NOT NULL
           AND NOT (coalesce(e.body->>'from', '') ~ ${MACHINE_SENDER_PATTERN})
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(e.body->'sections') s
              WHERE jsonb_typeof(s->'clarify') = 'array'
                AND jsonb_array_length(s->'clarify') > 0
           )
      ),
      -- MATERIALISE THE REPLIES ONCE. The obvious shape -- a correlated EXISTS
      -- over coord_event_log per ask -- is a full scan PER ASK (related_msg_id
      -- lives in jsonb and is unindexed), so it costs nothing while clarify has
      -- no traffic and TIMES OUT the moment it does. Not hypothetical: the
      -- correlated form was measured against a populated field of the same
      -- shape (premises) and hit the statement timeout, while this one returns
      -- in ~35ms over the same rows. A lane query that only works while its
      -- field is unused is a latent outage, and a zero-traffic read can never
      -- reveal it.
      replies AS (
        SELECT DISTINCT r.body->>'related_msg_id' AS to_msg_id,
                        r.body->>'from'           AS responder
          FROM harness_shared.coord_event_log r
         WHERE r.workspace_id = ${ws}
           AND r.surface = 'messages'
           AND r.ts > now() - interval '24 hours'
           AND r.body ? 'related_msg_id'
      )
      SELECT count(*)::int AS asks,
             coalesce(sum(a.entries), 0)::int AS entries,
             count(*) FILTER (
               WHERE EXISTS (
                 SELECT 1 FROM replies rp
                  WHERE rp.to_msg_id = a.msg_id
                    AND a.recipients @> to_jsonb(ARRAY[rp.responder])
               )
             )::int AS answered
        FROM asks a`;

    const r = rows[0];
    if (!r || Number(r.asks) === 0) return undefined;
    return {
      asks: Number(r.asks) || 0,
      answered: Number(r.answered) || 0,
      entries: Number(r.entries) || 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * L1/L2/L3 authored-structure adoption over the 24h window
 * (coordination-spec-adoption-2026-08-03 P-001). See {@link CoordAuthoredAdoption}
 * for why the three levels may not be collapsed into one number.
 *
 * THE DENOMINATOR IS THE WHOLE POINT. `handAuthored` excludes machine senders
 * (MACHINE_SENDER_PATTERN — the SAME shared constant sendMessage stamps with) AND
 * `auto:true` lifecycle emissions. Both look agent-authored (`from` is an su-… id
 * on the lifecycle ones) and NEITHER can carry sections, so counting them is how
 * a correct numerator produced a headline off by two orders of magnitude.
 *
 * REPLIES ARE MATERIALISED ONCE, for the reason recorded verbatim in
 * loadCoordClarifyAdoption above: the correlated-EXISTS form was measured against
 * a POPULATED field of this exact shape and hit the statement timeout. This query
 * reads a populated field from day one, so the cheap-while-empty trap is not
 * hypothetical here — it would fire immediately.
 */
/**
 * The zero-call window for the enforcement-tier census (P-002).
 *
 * SEVEN DAYS, not the 24h every other signal in this lane uses, and the
 * difference is load-bearing rather than a tuning preference. This census's
 * headline output is a ZERO — "these verbs took no calls" — and over 24h a merely
 * weekly verb is indistinguishable from a dead one, so a 24h window would
 * manufacture retirement candidates out of healthy low-frequency behaviours.
 * D-092 also fixes the re-measurement cadence at +7d; matching it means the lane's
 * reading and that re-measurement are the same number rather than two that have to
 * be reconciled.
 */
export const ENFORCEMENT_CENSUS_WINDOW_DAYS = 7;

/**
 * The enforcement-tier census read (P-002 / the D-016/D-047 debt).
 *
 * Composes the census's two IO seams — the live behaviour list and the measured
 * adoption — and hands them to the PURE builder. Both seams live in
 * enforcement-tier-census.ts; this function only wires them to this lane's `sql`,
 * matching how `loadCoordPremiseResolve` wires the live premise resolver rather
 * than reimplementing it.
 *
 * Fail-soft to `undefined`, like its three siblings: an outage here removes ONE
 * signal, never the lane. The behaviour-list seam is fail-soft in the stricter
 * direction too — it returns `undefined` rather than a shrunken list when the
 * registry looks partial, because a census that counts zeros must never publish a
 * denominator it is not sure of.
 */
export async function loadCoordEnforcementCensus(
  ws: string,
): Promise<EnforcementTierCensus | undefined> {
  try {
    const snapshot = await loadCoordRegistrySnapshot();
    if (!snapshot) return undefined; // partial registry — remove the signal, never shrink the denominator

    const adoption = await loadCoordBehaviourAdoption({
      workspaceId: ws,
      windowDays: ENFORCEMENT_CENSUS_WINDOW_DAYS,
      getSql: () => getOrgPg().sql as never,
    });

    return buildEnforcementTierCensus({
      behaviourIds: snapshot.behaviourIds,
      adoption,
      windowDays: ENFORCEMENT_CENSUS_WINDOW_DAYS,
      // Tier 3 DERIVED from the registry; tiers 1–2 declared (they are properties
      // of a chokepoint, not of a field a scan can read). Explicit wins on overlap.
      declared: resolveTierDeclarations(snapshot.derivedTiers),
    });
  } catch {
    return undefined;
  }
}

/** Cap on computed-provenance claims examined per window — a sampled labelling-quality reading, not a census. */
export const PROVENANCE_CLAIMS_MAX = 50;

/**
 * PURE: does any ledger ref cover the cited claim ref? Ledger refs are in the
 * READ_REF_MAPPERS `kind:id` grammar; authored citations are free-form, so a
 * bare-id citation (`WI-9`) matches its kinded ledger row (`work-item:WI-9`).
 * Conservative by design — a miss is WEAK evidence (see CoordProvenanceCheck).
 */
export function computedClaimMatchesLedger(
  claimRef: string,
  ledgerRefs: readonly string[],
): boolean {
  const c = claimRef.trim();
  if (!c) return false;
  for (const lr of ledgerRefs) {
    if (lr === c) return true;
    const sep = lr.indexOf(':');
    if (sep > 0 && lr.slice(sep + 1) === c) return true; // bare-id citation of a kind:id read
  }
  return false;
}

/**
 * The `provenance:'computed'` mechanism check (coord-derived-fields P-008 /
 * D-004): for each computed-labelled `youMayNotKnow` entry from an agent-authored
 * message, was there an args-derivable read of the cited ref in the sender's
 * invocation-ledger window — the SAME ledger, grammar (READ_REF_MAPPERS) and
 * window (BASED_ON_WINDOW_MS) `deriveBasedOn` uses, so this probe and the stamp
 * it audits cannot drift apart.
 *
 * Fail-soft to `undefined` like its siblings; a per-sender ledger failure lands
 * those claims in `unknown` (OUR failure, outside the rate), never a verdict.
 */
export async function loadCoordProvenanceCheck(
  ws: string,
): Promise<CoordProvenanceCheck | undefined> {
  try {
    const { sql } = getOrgPg();
    const [{ MACHINE_SENDER_PATTERN }, basedOn] = await Promise.all([
      import('../agent-tools/coordination/machine-authored'),
      import('../agent-tools/coordination/based-on'),
    ]);
    const { READ_TOOL_NAMES, refsFromInvocations, BASED_ON_WINDOW_MS } = basedOn;

    const claims = await sql<Array<{ sender: string; ts: Date; ref: string }>>`
      SELECT e.body->>'from' AS sender, e.ts, y->>'ref' AS ref
        FROM harness_shared.coord_event_log e
        CROSS JOIN LATERAL jsonb_array_elements(e.body->'sections') s
        CROSS JOIN LATERAL jsonb_array_elements(s->'youMayNotKnow') y
       WHERE e.workspace_id = ${ws}
         AND e.surface = 'messages'
         AND e.ts > now() - interval '24 hours'
         AND jsonb_typeof(e.body->'sections') = 'array'
         AND jsonb_typeof(s->'youMayNotKnow') = 'array'
         AND y->>'provenance' = 'computed'
         AND coalesce(y->>'ref', '') <> ''
         AND NOT (coalesce(e.body->>'from', '') ~ ${MACHINE_SENDER_PATTERN})
       LIMIT ${PROVENANCE_CLAIMS_MAX}`;
    if (claims.length === 0) return undefined;

    // Group by sender: ONE ledger query per sender over the union of that
    // sender's claim windows, then judge each claim against its OWN
    // [ts - WINDOW, ts] slice — a read after the send is not a source.
    const bySender = new Map<string, { ts: number; ref: string }[]>();
    for (const c of claims) {
      const sender = (c.sender ?? '').trim();
      const tsMs = (c.ts instanceof Date ? c.ts : new Date(c.ts)).getTime();
      if (!sender || !Number.isFinite(tsMs)) continue;
      const list = bySender.get(sender) ?? [];
      list.push({ ts: tsMs, ref: c.ref });
      bySender.set(sender, list);
    }

    let checked = 0;
    let matched = 0;
    let unmatched = 0;
    let unknown = 0;
    const samples: { ref: string }[] = [];

    for (const [sender, entries] of bySender) {
      try {
        const minTs = Math.min(...entries.map((e) => e.ts));
        const maxTs = Math.max(...entries.map((e) => e.ts));
        const rows = await sql<Array<{ tool_name: string; args_json: unknown; invoked_at: Date }>>`
          SELECT tool_name, args_json, invoked_at
            FROM harness_shared.tool_invocations
           WHERE workspace_id = ${ws}
             AND coord_owner_id = ${sender}
             AND invoked_at >= ${new Date(minTs - BASED_ON_WINDOW_MS)}
             AND invoked_at <= ${new Date(maxTs)}
             AND status = 'ok'
             AND tool_name = ANY(${[...READ_TOOL_NAMES]})
           ORDER BY invoked_at DESC
           LIMIT 200`;
        const invocations = rows.map((r) => ({
          tool: r.tool_name,
          args: r.args_json,
          readAt: (r.invoked_at instanceof Date ? r.invoked_at : new Date(r.invoked_at)).toISOString(),
        }));
        for (const entry of entries) {
          const windowRefs = refsFromInvocations(
            invocations.filter((iv) => {
              const at = Date.parse(iv.readAt);
              return at >= entry.ts - BASED_ON_WINDOW_MS && at <= entry.ts;
            }),
            PROVENANCE_CLAIMS_MAX * 4,
          ).map((r) => r.ref);
          checked += 1;
          if (computedClaimMatchesLedger(entry.ref, windowRefs)) {
            matched += 1;
          } else {
            unmatched += 1;
            if (samples.length < 5) samples.push({ ref: entry.ref });
          }
        }
      } catch {
        unknown += entries.length; // OUR probe failed for this sender — outside the rate
      }
    }

    if (checked + unknown === 0) return undefined;
    return { computedSeen: claims.length, checked, matched, unmatched, unknown, samples };
  } catch {
    return undefined;
  }
}

export async function loadCoordAuthoredAdoption(
  ws: string,
): Promise<CoordAuthoredAdoption | undefined> {
  try {
    const { sql } = getOrgPg();
    const { MACHINE_SENDER_PATTERN, AGENT_SESSION_SENDER_PATTERN } = await import(
      '../agent-tools/coordination/machine-authored'
    );

    // `sections` is absent on most rows and jsonb_array_elements THROWS on a
    // non-array, so every lateral coalesces to '[]' rather than relying on a
    // WHERE guard — the L1 DENOMINATOR must include section-less messages, so
    // filtering them out (as the clarify query legitimately does) is not open
    // to us here.
    const rows = await sql<
      Array<{
        hand_authored: number;
        bypassed_chokepoint: number;
        with_sections: number;
        multi_section: number;
        with_authored_field: number;
        open_questions: number;
        open_questions_answered: number;
        plain_messages: number;
        plain_messages_answered: number;
      }>
    >`
      WITH hand AS (
        SELECT e.body->>'msg_id' AS msg_id,
               e.body->'to'      AS recipients,
               (jsonb_typeof(e.body->'sections') = 'array')                    AS has_sections,
               coalesce(jsonb_array_length(
                 CASE WHEN jsonb_typeof(e.body->'sections') = 'array'
                      THEN e.body->'sections' ELSE '[]'::jsonb END), 0)        AS n_sections,
               EXISTS (
                 SELECT 1 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(e.body->'sections') = 'array'
                        THEN e.body->'sections' ELSE '[]'::jsonb END) s
                  WHERE s ?| array['forYouBecause','premises','youMayNotKnow','couldNotDetermine']
               ) AS has_authored,
               EXISTS (
                 SELECT 1 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(e.body->'sections') = 'array'
                        THEN e.body->'sections' ELSE '[]'::jsonb END) s
                  WHERE (jsonb_typeof(s->'couldNotDetermine') = 'array'
                         AND jsonb_array_length(s->'couldNotDetermine') > 0)
                     OR (jsonb_typeof(s->'youMayNotKnow') = 'array'
                         AND jsonb_array_length(s->'youMayNotKnow') > 0)
               ) AS has_actionable
          FROM harness_shared.coord_event_log e
         WHERE e.workspace_id = ${ws}
           AND e.surface = 'messages'
           AND e.ts > now() - interval '24 hours'
           AND e.body->>'kind' = 'message'
           AND e.body->>'msg_id' IS NOT NULL
           AND NOT (coalesce(e.body->>'from', '') ~ ${MACHINE_SENDER_PATTERN})
           -- BOTH filters, and the positive one is load-bearing. The negative
           -- pattern is conservative by design and admits ~1,738 emitters/24h
           -- (git-sync-*, green-checkpoint, intent-divergence-detector, …) that
           -- have ZERO sectioned messages because they never reach coord:send's
           -- schema. Measured: including them deflates L1 from 77.2% to 23.2%.
           AND coalesce(e.body->>'from', '') ~ ${AGENT_SESSION_SENDER_PATTERN}
           AND coalesce(e.body->>'auto', 'false') <> 'true'
           -- D-095, THE THIRD FILTER, and it is positive for the same reason the
           -- sender pattern above is. coord:send REQUIRES expects (no default,
           -- refused at the arg schema), and sendMessage derives it
           -- only for machine/auto senders — both already excluded. So on THIS
           -- population a present expects proves the message came through the
           -- agent-callable tool, and a missing one proves it did not.
           -- (No backticks in this comment on purpose: it lives inside a JS
           -- template literal, where one would terminate the SQL string.)
           --
           -- Without it, 36 lifecycle notices emitted by library code under a
           -- BORROWED agent ownerId (fleet-scope admission blocks,
           -- take-leadership demotions, a fed-event probe, a control cue) count
           -- as hand-authored prose. No name-based pattern can reach them —
           -- the sender IS a real agent — which is why the write-side stamp
           -- (isSystemEmissionUnderAgentIdentity) cannot fix history and this
           -- must be filtered at read time as well as stamped at write time.
           AND e.body ? 'expects'
      ),
      -- The complement, and the honest L1: agent-identity messages that never
      -- reached the schema. Counted separately rather than as a failing slice of
      -- the hand CTE, because it is a different population — a send PATH that bypasses
      -- enforcement, not an agent authoring poorly.
      bypassed AS (
        SELECT count(*)::int AS n
          FROM harness_shared.coord_event_log e
         WHERE e.workspace_id = ${ws}
           AND e.surface = 'messages'
           AND e.ts > now() - interval '24 hours'
           AND e.body->>'kind' = 'message'
           AND e.body->>'msg_id' IS NOT NULL
           AND NOT (coalesce(e.body->>'from', '') ~ ${MACHINE_SENDER_PATTERN})
           AND coalesce(e.body->>'from', '') ~ ${AGENT_SESSION_SENDER_PATTERN}
           AND coalesce(e.body->>'auto', 'false') <> 'true'
           AND NOT (e.body ? 'expects')
      ),
      replies AS (
        SELECT DISTINCT r.body->>'related_msg_id' AS to_msg_id,
                        r.body->>'from'           AS responder
          FROM harness_shared.coord_event_log r
         WHERE r.workspace_id = ${ws}
           AND r.surface = 'messages'
           AND r.ts > now() - interval '24 hours'
           AND r.body ? 'related_msg_id'
      )
      -- The reply lookup is evaluated ONCE PER MESSAGE here rather than once per
      -- arm below; both arms then read the same boolean. Two FILTERed EXISTS
      -- clauses over the same rows would double the correlated work for an
      -- identical answer.
      answered AS (
        SELECT h.*,
               EXISTS (
                 SELECT 1 FROM replies rp
                  WHERE rp.to_msg_id = h.msg_id
                    AND h.recipients @> to_jsonb(ARRAY[rp.responder])
               ) AS was_answered
          FROM hand h
      )
      SELECT count(*)::int                                              AS hand_authored,
             (SELECT n FROM bypassed)                                   AS bypassed_chokepoint,
             count(*) FILTER (WHERE h.has_sections)::int                AS with_sections,
             count(*) FILTER (WHERE h.n_sections > 1)::int              AS multi_section,
             count(*) FILTER (WHERE h.has_authored)::int                AS with_authored_field,
             -- TREATMENT arm: carries something a reader is asked to act on.
             count(*) FILTER (WHERE h.has_actionable)::int              AS open_questions,
             count(*) FILTER (WHERE h.has_actionable AND h.was_answered)::int
                                                                        AS open_questions_answered,
             -- CONTROL arm: hand-authored, same senders, same window, no
             -- authored field at all.
             count(*) FILTER (WHERE NOT h.has_authored)::int            AS plain_messages,
             count(*) FILTER (WHERE NOT h.has_authored AND h.was_answered)::int
                                                                        AS plain_messages_answered
        FROM answered h`;

    const r = rows[0];
    if (!r || Number(r.hand_authored) === 0) return undefined;

    // L3's depth-read signal. Its own query and its own failure domain: a
    // tool_invocations outage must degrade this ONE number to 0, never take the
    // whole reading down with it.
    let structureReads = 0;
    try {
      const reads = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${ws}
           AND invoked_at > now() - interval '24 hours'
           AND tool_name = 'coord:read'`;
      structureReads = Number(reads[0]?.n) || 0;
    } catch {
      structureReads = 0;
    }

    return {
      handAuthored: Number(r.hand_authored) || 0,
      bypassedChokepoint: Number(r.bypassed_chokepoint) || 0,
      withSections: Number(r.with_sections) || 0,
      multiSection: Number(r.multi_section) || 0,
      withAuthoredField: Number(r.with_authored_field) || 0,
      openQuestions: Number(r.open_questions) || 0,
      openQuestionsAnswered: Number(r.open_questions_answered) || 0,
      plainMessages: Number(r.plain_messages) || 0,
      plainMessagesAnswered: Number(r.plain_messages_answered) || 0,
      structureReads,
    };
  } catch {
    return undefined;
  }
}

/**
 * The PG edge: the 24h coordination-breakdown aggregate over coord_event_log for
 * the active workspace + the fleet-wide unanswered-directed read (REUSING the
 * hardened fetchUnansweredDirected). Returns [] on any failure (fail-soft lane).
 */
export async function buildCoordHealthLane(
  opts: { workspaceId?: string } = {},
): Promise<MetaPattern[]> {
  try {
    const ws = opts.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();

    // Re-mounting escalations: OPEN events (kind='escalation', not the resolved
    // markers) grouped by dedup signature over 24h. The count is the storm.
    const escRows = await sql<
      Array<{ sig: string; n: number; sev_rank: number; sample: string | null }>
    >`
      SELECT
        coalesce(
          body->>'subjectSignature',
          body->>'livenessSignature',
          left(body->>'summary', 80)
        ) AS sig,
        count(*)::int AS n,
        max(
          CASE body->>'severity'
            WHEN 'blocker' THEN 2
            WHEN 'advisory' THEN 1
            ELSE 0
          END
        )::int AS sev_rank,
        (array_agg(body->>'summary' ORDER BY ts DESC))[1] AS sample
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${ws}
         AND surface = 'escalations'
         AND body->>'kind' = 'escalation'
         AND ts > now() - interval '24 hours'
       GROUP BY 1`;

    // Per-recipient inbound volume (inbox/wake flooding): real agent recipients
    // only — never a broadcast ('*'), an audience selector ('@…'), or 'human'.
    const wakeRows = await sql<Array<{ recipient: string; n: number }>>`
      SELECT r AS recipient, count(*)::int AS n
        FROM harness_shared.coord_event_log
        CROSS JOIN LATERAL jsonb_array_elements_text(body->'to') AS r
       WHERE workspace_id = ${ws}
         AND surface = 'messages'
         AND ts > now() - interval '24 hours'
         AND jsonb_typeof(body->'to') = 'array'
         AND r NOT IN ('human', '*')
         AND r NOT LIKE '@%'
       GROUP BY 1
      HAVING count(*) >= 100`;

    // Claim conflicts in the window (best-effort text match — the coord log does
    // not carry a dedicated conflict kind).
    const claimRows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${ws}
         AND surface = 'messages'
         AND ts > now() - interval '24 hours'
         AND (
           body->>'summary' ILIKE '%claim%conflict%'
           OR body::text ILIKE '%claim_conflict%'
         )`;

    // Unanswered directed — REUSE the hardened reader over the active recipient
    // set (best-effort: an unavailable coord fast-path yields no targets).
    let unansweredTargets: CoordUnansweredTarget[] = [];
    try {
      const recipRows = await sql<Array<{ r: string }>>`
        SELECT DISTINCT r
          FROM harness_shared.coord_event_log
          CROSS JOIN LATERAL jsonb_array_elements_text(body->'to') AS r
         WHERE workspace_id = ${ws}
           AND surface = 'messages'
           AND ts > now() - interval '3 days'
           AND r ~ '^(su-|s-|cup-)'
         LIMIT 300`;
      const recipients = recipRows.map((x) => x.r).filter(Boolean);
      if (recipients.length > 0) {
        const { fetchUnansweredDirected } = await import(
          '../agent-tools/coordination/unanswered-directed'
        );
        const map = await fetchUnansweredDirected(recipients);
        unansweredTargets = [...map.entries()].map(([recipient, s]) => ({
          recipient,
          count: s.count,
          oldestAgeMs: s.oldestAgeMs,
        }));
      }
    } catch {
      /* best-effort — the unanswered signal is optional decoration */
    }

    // Premise-citation quality (P-011 / D-091) — independent + fail-soft, so a
    // premise-read outage costs this one signal and never the whole lane.
    let premiseResolve: CoordPremiseResolve | undefined;
    try {
      premiseResolve = await loadCoordPremiseResolve(ws);
    } catch {
      /* best-effort — the premise signal is optional decoration */
    }

    // `clarify` adoption (P-012 / D-106) — independently fail-soft, so a zero-
    // traffic or failing read costs this one signal and never the lane.
    let clarifyAdoption: CoordClarifyAdoption | undefined;
    try {
      clarifyAdoption = await loadCoordClarifyAdoption(ws);
    } catch {
      /* best-effort — the clarify signal is optional decoration */
    }

    // `youMayNotKnow.provenance` mechanism check (coord-derived-fields P-008 /
    // D-004) — independently fail-soft like its siblings.
    let provenanceCheck: CoordProvenanceCheck | undefined;
    try {
      provenanceCheck = await loadCoordProvenanceCheck(ws);
    } catch {
      /* best-effort — the provenance signal is optional decoration */
    }

    // L1/L2/L3 authored-structure adoption (coordination-spec-adoption P-001) —
    // independently fail-soft for the same reason as its two siblings above.
    let authoredAdoption: CoordAuthoredAdoption | undefined;
    try {
      authoredAdoption = await loadCoordAuthoredAdoption(ws);
    } catch {
      /* best-effort — the adoption signal is optional decoration */
    }

    // Enforcement-tier census (P-002) — independently fail-soft for the same
    // reason as its three siblings above.
    let enforcementCensus: EnforcementTierCensus | undefined;
    try {
      enforcementCensus = await loadCoordEnforcementCensus(ws);
    } catch {
      /* best-effort — the census signal is optional decoration */
    }

    // The coord:dispatch retirement falsifier (P-013) — independently fail-soft.
    // Sampling is IO; the judgement is the pure pre-committed evaluator, so this
    // seam only wires one to the other and never re-derives the bar.
    let dispatchAdoption: CoordDispatchAdoption | undefined;
    try {
      const reading = await loadDispatchAdoptionSample({
        getSql: () => getOrgPg().sql as never,
      });
      if (reading) {
        dispatchAdoption = {
          sample: reading.sample,
          coverage: reading.coverage,
          verdict: evaluateDispatchAdoption(reading.sample),
        };
      }
    } catch {
      /* best-effort — an outage removes the falsifier signal, never the lane */
    }

    return buildCoordHealthPatterns({
      premiseResolve,
      clarifyAdoption,
      provenanceCheck,
      authoredAdoption,
      enforcementCensus,
      dispatchAdoption,
      escalationStorms: escRows.map((r) => ({
        signature: r.sig || 'unknown',
        count: Number(r.n) || 0,
        severity: r.sev_rank >= 2 ? 'blocker' : r.sev_rank >= 1 ? 'advisory' : 'unknown',
        sample: r.sample ?? '',
      })),
      wakeStorms: wakeRows.map((r) => ({
        recipient: r.recipient,
        count: Number(r.n) || 0,
      })),
      unansweredTargets,
      claimConflicts: Number(claimRows[0]?.n) || 0,
    });
  } catch {
    return [];
  }
}
