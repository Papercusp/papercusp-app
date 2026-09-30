/**
 * ambient-push — the delivery-selection core for ambient-semantic-push-2026-07-14
 * (Phase 1 P-003, the pure part), built to plan D-002/D-004/D-006.
 *
 * The pushed object is a one-line TEASER + a QUERY HANDLE — never full content
 * (D-002). Push and pull are ONE object with two delivery modes: an agent can
 * PULL the handle out of its carry-doc, or the system can PUSH it via the coord
 * rail; either way resolving the handle is what fetches the detail. (The carry
 * plan's P-026 query handle is not a landed artifact yet — it is live-drill-
 * gated — so this module DEFINES the canonical {@link QueryHandle} shape both
 * sides will share.)
 *
 * This file is the PURE selection pipeline — the same pure-core / deferred-
 * live-leg split the rest of the build uses. What lands here (deterministic,
 * no-LLM, no-transport):
 *   • the typed push object + query handle, always stamped data-not-directive
 *     (carry P-014 provenance discipline — a peer's teaser can never read as an
 *     owner directive to the receiver);
 *   • the SEVERITY gate (D-004: a weak-model drone receives only collision +
 *     dead-end severities; interactive sessions get the richer feed — weak
 *     models derail on irrelevant interjections);
 *   • the NOVELTY / dedup filter (a push whose handle the agent already carries,
 *     or that says nothing its recent context does not, is dropped);
 *   • the per-class BUDGET accounting + a high-similarity FLOOR;
 *   • an AUDITABLE drop list (every candidate that did not ship, with why) —
 *     the raw material the P-011 utilization ledger consumes.
 *
 * DEFERRED live legs (DEFAULT-OFF, later phases, behind the host seam): the
 * actual harness INJECTION at hop boundaries + the injection-door tally (carry
 * P-006/D-007), the coord topic TRANSPORT, and handle RESOLUTION into a brief
 * (the carry-doc builder / peer-brief P-012). None live here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Matcher kinds, severity, session classes
// ─────────────────────────────────────────────────────────────────────────────

/** Which matcher produced a push. Ordered by ship order / Clippy risk (D-006):
 *  collision first (the multi-agent-unique value), insights last (most Clippy-
 *  prone). */
export type MatcherKind = 'collision' | 'dead-end' | 'topic-sub' | 'insight';

/** Push severity — the gate that decides whether a weak-model drone ever sees
 *  it (D-004). collision = the strongest signal; insight = the most optional. */
export type PushSeverity = 'critical' | 'warning' | 'info';

/** The fixed matcher→severity map. collision is critical; a documented dead-end
 *  just ahead is a warning; a topic subscription notice and an insight/runbook
 *  suggestion are info (weak models never see info — D-004). */
export const SEVERITY_BY_MATCHER: Record<MatcherKind, PushSeverity> = {
  collision: 'critical',
  'dead-end': 'warning',
  'topic-sub': 'info',
  insight: 'info',
};

/** Higher = more urgent (selection sort key). */
const SEVERITY_RANK: Record<PushSeverity, number> = { critical: 3, warning: 2, info: 1 };

/** The session classes budgets are keyed on. Drones are the weak-model tier
 *  (severity-gated); interactive is the human-facing rich feed; gateway is the
 *  in-between service tier. Extensible — an unknown class falls back to the
 *  drone policy (safe: the tightest). */
export type PushSessionClass = 'drone' | 'interactive' | 'gateway';

// ─────────────────────────────────────────────────────────────────────────────
// The query handle + the push object (D-002)
// ─────────────────────────────────────────────────────────────────────────────

/** The resolvable pointer shared by push and pull (D-002). NEVER carries full
 *  content — resolving it (a live leg) is what fetches the brief. `query` holds
 *  the lexical terms that matched, so a lexical re-pull is exact + legible. */
export interface QueryHandle {
  kind: 'work-item' | 'session' | 'fact' | 'doc' | 'topic';
  /** The id / anchor to resolve: WI-4790, a session id, a fact slot, a doc path, a topic. */
  ref: string;
  /** The matched lexical terms (the "why", and the re-pull query). */
  query: string[];
}

/** One line of injection: teaser + handle + the provenance stamp. */
export interface PushObject {
  matcherKind: MatcherKind;
  severity: PushSeverity;
  /** One line, bounded — a teaser, never the content. */
  teaser: string;
  handle: QueryHandle;
  /** The match score that produced it (cursor overlap, drift, etc.) ∈ [0,1]. */
  score: number;
  /** ALWAYS 'data-not-directive' (carry P-014). A field, not a free choice —
   *  {@link makePush} stamps it; a hand-built object should mirror it. */
  provenance: 'data-not-directive';
  /** For a peer collision: whose surface this points at (never the querying self). */
  sourceSessionId?: string | null;
}

/** The teaser is a hard one-liner — a runaway "teaser" must never become a
 *  content payload (the whole point of teaser-not-content). */
export const TEASER_MAX_CHARS = 200;

/** Build a push object: clamps the teaser to one bounded line and ALWAYS stamps
 *  data-not-directive. The severity follows the matcher kind unless overridden
 *  (an override never RAISES a drone-invisible kind into visibility by accident
 *  — callers pass it deliberately). PURE. */
export function makePush(input: {
  matcherKind: MatcherKind;
  handle: QueryHandle;
  teaser: string;
  score: number;
  severity?: PushSeverity;
  sourceSessionId?: string | null;
}): PushObject {
  const teaser = input.teaser.replace(/\s+/g, ' ').trim().slice(0, TEASER_MAX_CHARS);
  return {
    matcherKind: input.matcherKind,
    severity: input.severity ?? SEVERITY_BY_MATCHER[input.matcherKind],
    teaser,
    handle: input.handle,
    score: input.score,
    provenance: 'data-not-directive',
    sourceSessionId: input.sourceSessionId ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Novelty / dedup (vs the agent's carry + recent context)
// ─────────────────────────────────────────────────────────────────────────────

/** What the receiving agent already knows — the dedup baseline. */
export interface KnownContext {
  /** Handle refs already in the carry-doc or already pushed this window. */
  refs: Set<string>;
  /** Terms already salient in recent context (a push that adds no new term is
   *  noise). Optional — omit to dedup on refs alone. */
  terms?: Set<string>;
}

/**
 * Is this push NOVEL to the agent? Not novel when the handle ref is already
 * known (already carried or already pushed). When `terms` is supplied, a push
 * whose every query term is already salient adds nothing and is also dropped
 * (it would only re-say what the agent is already thinking about — an echo).
 * PURE.
 */
export function isNovelPush(push: PushObject, known: KnownContext): boolean {
  if (known.refs.has(push.handle.ref)) return false;
  if (known.terms && push.handle.query.length > 0) {
    const addsATerm = push.handle.query.some((t) => !known.terms!.has(t));
    if (!addsATerm) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-class budget policy + the selection pipeline
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassPushPolicy {
  /** Max pushes delivered to a session of this class per window. */
  budget: number;
  /** Severities this class may receive. Drones: critical + warning only
   *  (collision + dead-end) — never info (D-004). */
  allowedSeverities: ReadonlySet<PushSeverity>;
  /** The high-similarity floor: a match below this score never pushes. */
  minScore: number;
}

/** Deliberate defaults (no runtime self-adaptation — carry D-001). All of these
 *  belong on the carry P-023 config surface when the live matcher wires up
 *  (D-004); baked here for the pure core. */
export const DEFAULT_PUSH_POLICIES: Record<PushSessionClass, ClassPushPolicy> = {
  // Weak models derail on interjections: tiny budget, severity-gated to the two
  // strongest signals, high floor.
  drone: { budget: 2, allowedSeverities: new Set(['critical', 'warning']), minScore: 0.4 },
  interactive: { budget: 6, allowedSeverities: new Set(['critical', 'warning', 'info']), minScore: 0.25 },
  gateway: { budget: 4, allowedSeverities: new Set(['critical', 'warning', 'info']), minScore: 0.3 },
};

export function policyFor(sessionClass: PushSessionClass): ClassPushPolicy {
  return DEFAULT_PUSH_POLICIES[sessionClass] ?? DEFAULT_PUSH_POLICIES.drone;
}

export type DropReason = 'below-floor' | 'severity-gated' | 'not-novel' | 'budget-exhausted';

export interface DroppedPush {
  push: PushObject;
  reason: DropReason;
}

export interface SelectPushesInput {
  candidates: PushObject[];
  sessionClass: PushSessionClass;
  known: KnownContext;
  /** Override the class policy (else {@link DEFAULT_PUSH_POLICIES}). */
  policy?: ClassPushPolicy;
  /** Pushes already delivered to this session this window (counts against budget). */
  alreadyDelivered?: number;
}

export interface SelectPushesResult {
  /** The pushes to deliver, most-urgent first (severity desc, then score desc). */
  selected: PushObject[];
  /** Everything that did NOT ship, with why — the P-011 utilization-ledger feed. */
  dropped: DroppedPush[];
  policy: ClassPushPolicy;
}

/**
 * Select which candidate pushes actually reach a session, in order:
 *   1. FLOOR   — drop matches below the class similarity floor;
 *   2. SEVERITY — drop severities this class may not receive (drones: info out);
 *   3. NOVELTY — drop pushes the agent already carries / that add no new term;
 *   4. RANK + BUDGET — sort by severity then score, take up to the remaining
 *      budget, drop the overflow as budget-exhausted.
 * Every drop is recorded with its reason (auditable, feeds P-011). The control
 * path is deterministic; nothing here self-tunes (telemetry is dashboard-only,
 * a human retires/tunes a matcher — carry D-001 / D-005). PURE.
 */
export function selectPushes(input: SelectPushesInput): SelectPushesResult {
  const policy = input.policy ?? policyFor(input.sessionClass);
  const dropped: DroppedPush[] = [];
  const survivors: PushObject[] = [];

  for (const push of input.candidates) {
    if (push.score < policy.minScore) { dropped.push({ push, reason: 'below-floor' }); continue; }
    if (!policy.allowedSeverities.has(push.severity)) { dropped.push({ push, reason: 'severity-gated' }); continue; }
    if (!isNovelPush(push, input.known)) { dropped.push({ push, reason: 'not-novel' }); continue; }
    survivors.push(push);
  }

  // Most urgent first: severity rank, then score, then a deterministic ref tie-break.
  survivors.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.score - a.score ||
      a.handle.ref.localeCompare(b.handle.ref),
  );

  const remaining = Math.max(0, policy.budget - Math.max(0, input.alreadyDelivered ?? 0));
  const selected = survivors.slice(0, remaining);
  for (const overflow of survivors.slice(remaining)) dropped.push({ push: overflow, reason: 'budget-exhausted' });

  return { selected, dropped, policy };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge: a peer-collision candidate → a push object
// ─────────────────────────────────────────────────────────────────────────────

/** The minimal collision-candidate shape this bridge needs (structural — mirrors
 *  lexical-cursor's CollisionCandidate without importing its whole surface). */
export interface CollisionLike {
  sessionId: string;
  overlap: { score: number; sharedTerms: Array<{ term: string }> };
}

/**
 * Turn a peer-cursor collision (from lexical-cursor.collisionCandidates) into a
 * push object: a collision-severity teaser naming the shared terms, handle
 * pointing at the peer session with the shared terms as the re-pull query. The
 * teaser is legible ("peer <sid> converging — shared: …") and stamped
 * data-not-directive. PURE. `maxTerms` bounds the teaser/handle term list. */
export function collisionToPush(candidate: CollisionLike, maxTerms = 5): PushObject {
  const terms = candidate.overlap.sharedTerms.slice(0, maxTerms).map((s) => s.term);
  const sid = candidate.sessionId;
  return makePush({
    matcherKind: 'collision',
    handle: { kind: 'session', ref: sid, query: terms },
    teaser: `peer ${sid} converging — shared: ${terms.join(', ') || '(cursor overlap)'}`,
    score: candidate.overlap.score,
    sourceSessionId: sid,
  });
}
