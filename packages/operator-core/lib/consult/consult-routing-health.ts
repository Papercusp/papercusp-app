/**
 * consult-routing-health.ts — "is review routing working?" as ONE read (plan
 * review-routing-through-relevance-router-2026-09-26, P-004 / R-5, clause
 * RR-P-004-routing-health-counts).
 *
 * Before this, answering that question meant hand-written SQL over
 * consult_state and the task ledger (the P-001 audit). This module derives, per
 * selection policy, what happened to the answering sessions the router
 * launched in a caller-chosen window:
 *
 *   launched  — a dispatch walk that started an answering session
 *   answered  — that session posted an answer (or the consult closed answered
 *               while it was the consult's current launch)
 *   declined  — that session posted a decline, or closed the consult can't-help
 *   failed    — a launch attempt that did not survive, or a launched session the
 *               expiry sweep stopped for not posting (P-003); bucketed by reason
 *   hung      — a launched session with no post and no recorded failure whose
 *               answer window has already elapsed. After P-003 the sweep records
 *               every such slot as a failure, so a non-zero `hung` means the sweep
 *               is not keeping up (or the window predates P-003).
 *   pending   — launched, no outcome yet, window still open
 *   skipped   — ranks the walk passed over without launching (walls, pressure)
 *
 * THE WINDOW IS A LAUNCH COHORT: an attempt belongs to the window its dispatch
 * walk's `at` falls in, and its outcome is judged as of `nowMs` whenever it
 * happened. So "answered 7 of 10 launched" is a rate over one population, never
 * a numerator from one window over a denominator from another.
 *
 * Ground truth is `consult_state.dispatch_attempts` (migration 1225, written by
 * consult-dispatch.ts) plus the consult's own cascade digest and close. Nothing
 * is kept in a second table, so the read cannot drift from what dispatch did.
 *
 * Honesty markers, on the RESULT rather than per row: every known policy is
 * always reported (a zero is a measured zero, not an omission);
 * `consultsWithoutDispatchRecords` says how many consults in scope carry no
 * dispatch record at all (a consult routed before the recorder shipped reads as
 * unrecorded, not as "launched nothing"); and `bounded` says when the scan hit
 * its census limit or a consult's 24-record log cap, so a count is a floor.
 */
import type { Sql } from 'postgres';
import { HARD_BLOCKED_EXPIRY_MS, PROCEED_EXPIRY_MS } from './get-feedback-core';
import { DISPATCH_RECORDS_MAX } from './consult-dispatch';
import { reviewConsultKind } from './consult-expiry-core';
import { CONSULT_RECONCILIATION_DISPOSITIONS, type ConsultReconciliationDisposition } from './consult-verbs-core';
import {
  ACCEPTANCE_GRADING_POLICY,
  CONSULT_DEFAULT_POLICY,
  GRADING_INTEGRITY_AUDIT_POLICY,
  SELECTION_POLICIES,
} from './selection-policies';

/** Consults scanned per read. Independent of any caller limit (a census, not a page). */
export const ROUTING_HEALTH_CONSULT_LIMIT = 5000;
/** Longest window a caller may ask for. */
export const ROUTING_HEALTH_MAX_WINDOW_MS = 14 * 24 * 3_600_000;
/** How long before the window a consult may have been opened and still launch
 *  inside it (measured 2026-09-26: consults stay open p99 8 h, max 32 h). */
const CONSULT_OPEN_MARGIN = '2 days';

/** One consult_state row, as the reader selects it. */
export interface RoutingHealthConsultRow {
  conversation_id: string;
  requester_id?: string | null;
  created_at?: string | Date | null;
  expires_at?: string | Date | null;
  outcome?: unknown;
  /** Typed responder posts, measured independently of bounded cascade history. */
  has_feedback?: boolean;
  has_decline?: boolean;
  routing: unknown;
  state: string;
  latency_contract: string | null;
  closed_at: string | Date | null;
  cascade_digest: unknown;
  dispatch_attempts: unknown;
}

export interface PolicyRoutingHealth {
  policy: string;
  /** Consults of this policy open at some point in the window. */
  consults: number;
  /** Of those, how many carry no dispatch record at all. */
  consultsWithoutDispatchRecords: number;
  launched: number;
  answered: number;
  declined: number;
  failed: number;
  failedReasons: Record<string, number>;
  hung: number;
  pending: number;
  skipped: number;
  skippedReasons: Record<string, number>;
}

export interface RoutingHealthBounds {
  /** True when the consult scan hit its census limit: every count is a floor. */
  truncatedByLimit: boolean;
  consultsScanned: number;
  consultLimit: number;
  /** Consults whose dispatch log is at its keep-newest cap, so older walks may be gone. */
  dispatchLogCapped: number;
}

export interface RoutingHealth {
  window: { since: string; until: string; cohort: 'launch-time' };
  asOf: string;
  policies: PolicyRoutingHealth[];
  totals: Omit<PolicyRoutingHealth, 'policy'>;
  bounded: RoutingHealthBounds;
  requestCohort: {
    window: { since: string; until: string; cohort: 'request-time' };
    policies: Array<RequestDeliveryHealth & { policy: string }>;
    totals: RequestDeliveryHealth;
  };
}

/** Intent partitions requests; outcomes partition requested dispatch only. */
export interface RequestDeliveryHealth {
  requests: number;
  dispatchRequested: number;
  retrievalOnly: number;
  legacyIntentUnknown: number;
  outcomes: { received: number; declined: number; pending: number; unavailable: number; failed: number; unmeasured: number };
  followThrough: {
    applicable: number; notApplicable: number; applicabilityUnknown: number;
    recorded: Record<ConsultReconciliationDisposition, number>;
    unknown: number; invalid: number;
    recordedWithFeedback: number; recordedWithoutFeedback: number;
  };
}

function emptyRequestCounts(): RequestDeliveryHealth {
  return {
    requests: 0, dispatchRequested: 0, retrievalOnly: 0, legacyIntentUnknown: 0,
    outcomes: { received: 0, declined: 0, pending: 0, unavailable: 0, failed: 0, unmeasured: 0 },
    followThrough: {
      applicable: 0, notApplicable: 0, applicabilityUnknown: 0,
      recorded: { confirmed: 0, rescoped: 0, reversed: 0, moot: 0 },
      unknown: 0, invalid: 0, recordedWithFeedback: 0, recordedWithoutFeedback: 0,
    },
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function requestOutcome(row: RoutingHealthConsultRow, nowMs: number): keyof RequestDeliveryHealth['outcomes'] {
  const outcome = jsonObject(row.outcome);
  const answer = outcome.source === 'archive' ? jsonObject(outcome.answer).answer : outcome.answer;
  // A typed receipt outranks expiry, decline and recovered launch failures.
  if (row.has_feedback === true || (typeof answer === 'string' && answer.trim())) return 'received';
  if (row.has_decline === true || row.state === 'closed_cant_help' || row.state === 'declined') return 'declined';
  const walks = parseWalks(row.dispatch_attempts);
  const expiresMs = toMs(row.expires_at);
  const open = ['awaiting_responder', 'active', 'budget_exhausted'].includes(row.state);
  if (open && Number.isFinite(expiresMs) && nowMs < expiresMs) return 'pending';
  if (row.state === 'no_qualified_responder') return 'unavailable';
  const attempts = walks.flatMap((walk) => walk.attempts);
  if (attempts.length > 0 && attempts.every((attempt) =>
    attempt.outcome === 'skipped' && attempt.reason === 'account-walled')) return 'unavailable';
  if (walks.some((walk) => walk.answerFailure != null) ||
      attempts.some((attempt) => attempt.outcome === 'failed') ||
      (walks.some((walk) => walk.dispatched) &&
        (row.state === 'expired' || (Number.isFinite(expiresMs) && nowMs >= expiresMs)))) return 'failed';
  // Missing recorder/expiry evidence is not proof of a delivery failure.
  return 'unmeasured';
}

function recordFollowThrough(row: RoutingHealthConsultRow, counts: RequestDeliveryHealth, nowMs: number) {
  const follow = counts.followThrough;
  if (row.latency_contract === 'hard-blocked') { follow.notApplicable += 1; return; }
  if (row.latency_contract !== 'proceed') { follow.applicabilityUnknown += 1; return; }
  follow.applicable += 1;
  const raw = jsonObject(row.outcome).reconciliation;
  if (raw == null) { follow.unknown += 1; return; }
  const reconciliation = jsonObject(raw);
  const disposition = reconciliation.disposition as ConsultReconciliationDisposition;
  const atMs = toMs(reconciliation.at);
  if (!row.requester_id || reconciliation.by !== row.requester_id ||
      !CONSULT_RECONCILIATION_DISPOSITIONS.includes(disposition) ||
      typeof reconciliation.note !== 'string' || !reconciliation.note.trim() ||
      !Number.isFinite(atMs) || atMs > nowMs) {
    follow.invalid += 1;
    return;
  }
  follow.recorded[disposition] += 1;
  if (requestOutcome(row, nowMs) === 'received') follow.recordedWithFeedback += 1;
  else follow.recordedWithoutFeedback += 1;
}

/** The selection policy a consult ran under. Null `routing.policy` is the default. */
export function consultPolicyKey(routing: unknown): string {
  let snap = routing;
  if (typeof snap === 'string') {
    try {
      snap = JSON.parse(snap);
    } catch {
      snap = null;
    }
  }
  const kind = reviewConsultKind(snap);
  if (kind === 'acceptance-grading') return ACCEPTANCE_GRADING_POLICY;
  if (kind === 'grading-integrity') return GRADING_INTEGRITY_AUDIT_POLICY;
  const policy = snap && typeof snap === 'object' ? (snap as { policy?: unknown }).policy : undefined;
  return typeof policy === 'string' && policy.trim() ? policy : CONSULT_DEFAULT_POLICY;
}

interface WalkRecord {
  atMs: number;
  dispatched: boolean;
  answeringOwnerId: string | null;
  attempts: Array<{ outcome?: unknown; reason?: unknown }>;
  answerFailure: { reason: string } | null;
}

interface DigestEvent {
  ownerId: string;
  kind: string;
  atMs: number;
}

const POST_ANSWER_KINDS = new Set(['answer', 'new_fact']);
const POST_DECLINE_KINDS = new Set(['decline']);

function jsonArray(value: unknown): unknown[] {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v : [];
}

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return Number.NaN;
}

function parseWalks(value: unknown): WalkRecord[] {
  const out: WalkRecord[] = [];
  for (const raw of jsonArray(value)) {
    const e = (typeof raw === 'string' ? safeParse(raw) : raw) as Record<string, unknown> | null;
    if (!e || typeof e !== 'object') continue;
    const atMs = toMs(e.at);
    if (!Number.isFinite(atMs)) continue;
    const af = e.answerFailure as { reason?: unknown } | undefined;
    out.push({
      atMs,
      dispatched: e.dispatched === true,
      answeringOwnerId: typeof e.answeringOwnerId === 'string' ? e.answeringOwnerId : null,
      attempts: Array.isArray(e.attempts) ? (e.attempts as WalkRecord['attempts']) : [],
      answerFailure:
        af && typeof af === 'object' ? { reason: typeof af.reason === 'string' ? af.reason : 'unknown' } : null,
    });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseDigest(value: unknown): DigestEvent[] {
  const out: DigestEvent[] = [];
  for (const raw of jsonArray(value)) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as { ownerId?: unknown; kind?: unknown; at?: unknown };
    const atMs = toMs(e.at);
    if (typeof e.ownerId !== 'string' || typeof e.kind !== 'string' || !Number.isFinite(atMs)) continue;
    out.push({ ownerId: e.ownerId, kind: e.kind, atMs });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

function emptyCounts(): Omit<PolicyRoutingHealth, 'policy'> {
  return {
    consults: 0,
    consultsWithoutDispatchRecords: 0,
    launched: 0,
    answered: 0,
    declined: 0,
    failed: 0,
    failedReasons: {},
    hung: 0,
    pending: 0,
    skipped: 0,
    skippedReasons: {},
  };
}

const bump = (bucket: Record<string, number>, key: unknown) => {
  const k = typeof key === 'string' && key ? key : 'unknown';
  bucket[k] = (bucket[k] ?? 0) + 1;
};

/** The answer window a launched session gets, from the consult's latency contract. */
export function answerWindowMs(latencyContract: string | null): number {
  return latencyContract === 'hard-blocked' ? HARD_BLOCKED_EXPIRY_MS : PROCEED_EXPIRY_MS;
}

/**
 * Per-policy routing health over the launch cohort [sinceMs, untilMs), judged
 * as of `nowMs`. Pure.
 */
export function routingHealthFromRows(
  rows: readonly RoutingHealthConsultRow[],
  opts: { sinceMs: number; untilMs: number; nowMs: number; truncatedByLimit?: boolean; consultLimit?: number },
): RoutingHealth {
  const { sinceMs, untilMs, nowMs } = opts;
  const inWindow = (ms: number) => ms >= sinceMs && ms < untilMs;
  const byPolicy = new Map<string, Omit<PolicyRoutingHealth, 'policy'>>();
  const requestPolicies = new Map<string, RequestDeliveryHealth>();
  // Every known policy is reported, so a zero is a measured zero, not an omission.
  for (const key of Object.keys(SELECTION_POLICIES)) {
    byPolicy.set(key, emptyCounts());
    requestPolicies.set(key, emptyRequestCounts());
  }
  let dispatchLogCapped = 0;

  for (const row of rows) {
    const policy = consultPolicyKey(row.routing);
    let c = byPolicy.get(policy);
    if (!c) {
      c = emptyCounts();
      byPolicy.set(policy, c);
    }
    if (inWindow(toMs(row.created_at))) {
      const requests = requestPolicies.get(policy) ?? emptyRequestCounts();
      requestPolicies.set(policy, requests);
      requests.requests += 1;
      recordFollowThrough(row, requests, nowMs);
      const intent = jsonObject(row.routing).deliveryIntent;
      if (intent === 'retrieval-only') requests.retrievalOnly += 1;
      else if (intent !== 'dispatch') requests.legacyIntentUnknown += 1;
      else {
        requests.dispatchRequested += 1;
        requests.outcomes[requestOutcome(row, nowMs)] += 1;
      }
    }
    const records = parseWalks(row.dispatch_attempts);
    c.consults += 1;
    if (records.length === 0) c.consultsWithoutDispatchRecords += 1;
    if (jsonArray(row.dispatch_attempts).length >= DISPATCH_RECORDS_MAX) dispatchLogCapped += 1;

    const walks = records.filter((r) => r.answerFailure == null);
    const failures = records.filter((r) => r.answerFailure != null);
    const launches = walks.filter((w) => w.dispatched);
    const digest = parseDigest(row.cascade_digest);
    const closedMs = toMs(row.closed_at);
    const windowMs = answerWindowMs(row.latency_contract);

    for (const walk of walks) {
      if (!inWindow(walk.atMs)) continue;
      for (const attempt of walk.attempts) {
        if (attempt?.outcome === 'failed') {
          c.failed += 1;
          bump(c.failedReasons, attempt.reason);
        } else if (attempt?.outcome === 'skipped') {
          c.skipped += 1;
          bump(c.skippedReasons, attempt.reason);
        }
      }
      if (!walk.dispatched) continue;
      c.launched += 1;

      const owner = walk.answeringOwnerId;
      const post = owner ? digest.find((d) => d.ownerId === owner && d.atMs >= walk.atMs) : undefined;
      if (post && POST_ANSWER_KINDS.has(post.kind)) {
        c.answered += 1;
        continue;
      }
      if (post && POST_DECLINE_KINDS.has(post.kind)) {
        c.declined += 1;
        continue;
      }
      const failure = owner
        ? failures.find((f) => f.answeringOwnerId === owner && f.atMs >= walk.atMs)
        : undefined;
      if (failure) {
        c.failed += 1;
        bump(c.failedReasons, failure.answerFailure?.reason);
        continue;
      }
      // A consult close is attributed to the launch that was current when it closed.
      const nextLaunch = launches.find((l) => l.atMs > walk.atMs);
      const closedOnThisLaunch =
        Number.isFinite(closedMs) && closedMs >= walk.atMs && (!nextLaunch || closedMs < nextLaunch.atMs);
      if (closedOnThisLaunch && (row.state === 'closed_answered' || row.state === 'graduated')) {
        c.answered += 1;
        continue;
      }
      if (closedOnThisLaunch && row.state === 'closed_cant_help') {
        c.declined += 1;
        continue;
      }
      if (nowMs >= walk.atMs + windowMs) c.hung += 1;
      else c.pending += 1;
    }

    // A failure record with no launch walk to resolve (dispatch never stamped an
    // answering owner, or its walk was not recorded) still counts, by its own time.
    for (const f of failures) {
      if (!inWindow(f.atMs)) continue;
      const matched = f.answeringOwnerId
        ? launches.some((l) => l.answeringOwnerId === f.answeringOwnerId && l.atMs <= f.atMs)
        : false;
      if (matched) continue;
      c.failed += 1;
      bump(c.failedReasons, f.answerFailure?.reason);
    }
  }

  const policies = [...byPolicy.entries()]
    .map(([policy, counts]) => ({ policy, ...counts }))
    .sort((a, b) => a.policy.localeCompare(b.policy));
  const totals = emptyCounts();
  const requestTotals = emptyRequestCounts();
  for (const counts of requestPolicies.values()) {
    for (const key of ['requests', 'dispatchRequested', 'retrievalOnly', 'legacyIntentUnknown'] as const) {
      requestTotals[key] += counts[key];
    }
    for (const key of Object.keys(counts.outcomes) as Array<keyof RequestDeliveryHealth['outcomes']>) {
      requestTotals.outcomes[key] += counts.outcomes[key];
    }
    for (const key of ['applicable', 'notApplicable', 'applicabilityUnknown', 'unknown', 'invalid', 'recordedWithFeedback', 'recordedWithoutFeedback'] as const) {
      requestTotals.followThrough[key] += counts.followThrough[key];
    }
    for (const disposition of CONSULT_RECONCILIATION_DISPOSITIONS) {
      requestTotals.followThrough.recorded[disposition] += counts.followThrough.recorded[disposition];
    }
  }
  for (const p of policies) {
    for (const key of [
      'consults',
      'consultsWithoutDispatchRecords',
      'launched',
      'answered',
      'declined',
      'failed',
      'hung',
      'pending',
      'skipped',
    ] as const) {
      totals[key] += p[key];
    }
    for (const [k, n] of Object.entries(p.failedReasons)) totals.failedReasons[k] = (totals.failedReasons[k] ?? 0) + n;
    for (const [k, n] of Object.entries(p.skippedReasons)) totals.skippedReasons[k] = (totals.skippedReasons[k] ?? 0) + n;
  }
  return {
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), cohort: 'launch-time' },
    asOf: new Date(nowMs).toISOString(),
    policies,
    totals,
    bounded: {
      truncatedByLimit: opts.truncatedByLimit ?? false,
      consultsScanned: rows.length,
      consultLimit: opts.consultLimit ?? ROUTING_HEALTH_CONSULT_LIMIT,
      dispatchLogCapped,
    },
    requestCohort: {
      window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), cohort: 'request-time' },
      policies: [...requestPolicies.entries()].map(([policy, counts]) => ({ policy, ...counts })).sort((a, b) => a.policy.localeCompare(b.policy)),
      totals: requestTotals,
    },
  };
}

/**
 * The consults that could hold a launch inside [sinceIso, untilIso): opened
 * before the window ends (and at most {@link CONSULT_OPEN_MARGIN} before it
 * starts) and not closed before it starts. Returns `limit` rows at most, with
 * `truncated` when more exist.
 */
export async function readRoutingHealthRows(
  sql: Sql,
  workspaceId: string,
  sinceIso: string,
  untilIso: string,
  limit = ROUTING_HEALTH_CONSULT_LIMIT,
  asOfIso = new Date().toISOString(),
): Promise<{ rows: RoutingHealthConsultRow[]; truncated: boolean }> {
  // Keep precise snapshot strings as text on the wire: an inferred timestamp
  // parameter is serialized through JS Date by postgres.js and loses micros.
  const rows = await sql<RoutingHealthConsultRow[]>`
    SELECT cs.conversation_id, cs.requester_id, cs.created_at, cs.expires_at, cs.outcome, cs.routing, cs.state,
           cs.latency_contract, cs.closed_at, cs.cascade_digest, cs.dispatch_attempts,
           EXISTS (SELECT 1 FROM harness_shared.consult_post_meta pm
                    WHERE pm.workspace_id = cs.workspace_id AND pm.conversation_id = cs.conversation_id
                      AND pm.author_id <> cs.requester_id AND pm.kind IN ('answer', 'new_fact')
                      AND pm.created_at <= ${asOfIso}::text::timestamptz) AS has_feedback,
           EXISTS (SELECT 1 FROM harness_shared.consult_post_meta pm
                    WHERE pm.workspace_id = cs.workspace_id AND pm.conversation_id = cs.conversation_id
                      AND pm.author_id <> cs.requester_id AND pm.kind = 'decline'
                      AND pm.created_at <= ${asOfIso}::text::timestamptz) AS has_decline
      FROM harness_shared.consult_state cs
     WHERE cs.workspace_id = ${workspaceId}
       AND cs.created_at < ${untilIso}::timestamptz
       AND cs.created_at >= ${sinceIso}::timestamptz - ${CONSULT_OPEN_MARGIN}::interval
       AND (cs.closed_at IS NULL OR cs.closed_at >= ${sinceIso}::timestamptz OR cs.created_at >= ${sinceIso}::timestamptz)
     ORDER BY cs.created_at DESC
     LIMIT ${limit + 1}
  `;
  const truncated = rows.length > limit;
  return { rows: truncated ? rows.slice(0, limit) : [...rows], truncated };
}

/** Resolve a caller window to [since, until) ms, or a refusal message. */
export function resolveRoutingHealthWindow(
  args: { since?: string; until?: string; hours?: number },
  nowMs: number,
): { sinceMs: number; untilMs: number } | { error: string } {
  const untilMs = args.until ? Date.parse(args.until) : nowMs;
  if (!Number.isFinite(untilMs)) return { error: `until is not a timestamp: ${args.until}` };
  const sinceMs = args.since ? Date.parse(args.since) : untilMs - (args.hours ?? 24) * 3_600_000;
  if (!Number.isFinite(sinceMs)) return { error: `since is not a timestamp: ${args.since}` };
  if (sinceMs >= untilMs) return { error: 'the window is empty: since must be before until' };
  if (untilMs - sinceMs > ROUTING_HEALTH_MAX_WINDOW_MS) {
    return { error: `the window is longer than ${ROUTING_HEALTH_MAX_WINDOW_MS / 86_400_000} days` };
  }
  return { sinceMs, untilMs };
}
