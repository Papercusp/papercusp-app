/**
 * escalations.ts — operator host adapter for the agent → human channel.
 *
 * Record shapes + the append-only resolve fold live in
 * @papercusp/coordination/core; the per-event-file I/O lives behind the
 * CoordEventLog seam (coordLog). Original function surface preserved.
 *
 * agent-coordination-architecture-v2 §6.4 (#9). Append-only (P-012): the
 * open escalation record is immutable; a resolution is a SIBLING
 * 'escalation_resolved' event, and open/resolved state is derived by
 * folding the resolve events at read time.
 */

import {
  newMsgId,
  foldEscalations,
  foldResolved,
  indexResolves,
  resolvedEventId,
  reopenedEventId,
  escalationGeneration,
  type EscalationSeverity,
  type EscalationOption,
  type OpenEscalationInput,
  type ResolveInput,
  type EscalationRecord,
  type EscalationResolvedEvent,
  type EscalationReopenedEvent,
} from '@papercusp/coordination/core';
import type { Sql, TransactionSql } from 'postgres';
import { EVIDENCE_FIELD, type EvidenceStamp } from './relay-provenance';
import { coordLog, coordSql, coordWorkspaceId, coordHasPgFastPath } from './log';
import type { AgentIdentity } from './identity';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { systemDistinctId } from '../../flag-distinct-id';

export type {
  EscalationSeverity,
  EscalationOption,
  OpenEscalationInput,
  ResolveInput,
  EscalationRecord,
  EscalationResolvedEvent,
  EscalationReopenedEvent,
};

export async function armEscalationRequesterInterest(
  ownerId: string,
  msgId: string,
): Promise<import('../../interest-auto-arm').InterestAutoArmHandle | undefined> {
  try {
    const { reconcileInterestEventAwaits } = await import('../../interest-auto-arm');
    return await reconcileInterestEventAwaits({
      ownerId,
      eventKeys: [`escalation:resolved:${msgId}`],
      boundTo: { kind: 'escalation-request', ref: msgId },
      note: `escalation-requester auto-arm for ${msgId}`,
    });
  } catch {
    return undefined;
  }
}

async function settleEscalationRequesterInterest(
  open: EscalationRecord,
  input: { msg_id: string; choice: string; note?: string; resolver?: string },
): Promise<void> {
  try {
    const { emitAwaitedEvent } = await import('../../events/await/engine');
    await emitAwaitedEvent({
      key: `escalation:resolved:${input.msg_id}`,
      summary: `escalation resolved → ${input.choice}${input.note ? ` — ${input.note}` : ''}`,
      payload: { msg_id: input.msg_id, choice: input.choice, resolver: input.resolver ?? open.from },
      to: [open.from],
      source: input.resolver ?? open.from,
    });
  } catch {
    /* the append-only resolution is authoritative; wake delivery is fail-soft */
  }
  try {
    const { retireInterestEventAwaits } = await import('../../interest-auto-arm');
    await retireInterestEventAwaits({ kind: 'escalation-request', ref: input.msg_id });
  } catch {
    /* lifecycle cleanup is fail-soft */
  }
}

const OPEN_ESCALATION_REPEAT_COUNT_KEY = 'repeatCount';
const OPEN_ESCALATION_LAST_SEEN_KEY = 'lastSeenTs';
const OPEN_ESCALATION_SUBJECT_SIGNATURE_KEY = 'subjectSignature';
const OPEN_ESCALATION_DEDUP_KIND_KEY = 'dedupKind';
const DEFAULT_ADVISORY_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ADVISORY_EXPIRY_LIMIT = 200;

/**
 * WI-6943: every escalation is addressed to the human, so second-person prose
 * such as "your change" attributes a shared-tree edit to the owner. That claim
 * is not established by the escalation transport (and git history is especially
 * unsuitable evidence in this workspace). Keep delivery fail-open, but make the
 * unverified attribution impossible to miss on the owner-facing summary.
 */
export const UNVERIFIED_OWNER_AUTHORSHIP_CLAIM_TAG = '[UNVERIFIED owner-authorship claim]';

const OWNER_POSSESSIVE_AUTHORSHIP_RE =
  /\byour\s+(?:change(?:s)?|code|commit(?:s)?|edit(?:s)?|patch(?:es)?|implementation|work)\b/i;
const OWNER_ACTION_AUTHORSHIP_RE =
  /\byou(?:'ve|\s+have)?\s+(?:wrote|written|authored|updated|changed|implemented|committed|edited|introduced|added|removed|modified)\b/i;

export type OwnerAuthorshipClaimLocation = 'summary' | 'body' | 'summary-and-body';

/** Narrow, pure detector for second-person authorship claims on the human-only surface. */
export function detectOwnerAuthorshipClaim(
  summary: string,
  body?: string,
): OwnerAuthorshipClaimLocation | null {
  const hasClaim = (text: string | undefined) =>
    Boolean(text && (OWNER_POSSESSIVE_AUTHORSHIP_RE.test(text) || OWNER_ACTION_AUTHORSHIP_RE.test(text)));
  const inSummary = hasClaim(summary);
  const inBody = hasClaim(body);
  if (inSummary && inBody) return 'summary-and-body';
  if (inSummary) return 'summary';
  if (inBody) return 'body';
  return null;
}

function ownerAuthorshipGuardedSummary(summary: string, body?: string): string {
  if (!detectOwnerAuthorshipClaim(summary, body)) return summary;
  if (summary.startsWith(UNVERIFIED_OWNER_AUTHORSHIP_CLAIM_TAG)) return summary;
  return `${UNVERIFIED_OWNER_AUTHORSHIP_CLAIM_TAG} ${summary}`;
}

type EscalationMeta = Record<string, unknown> & {
  dedupKind?: string;
  lastSeenTs?: string;
  repeatCount?: number;
  subjectSignature?: string;
};

interface EscalationDedupIdentity {
  dedupKind: string;
  subjectSignature: string;
}

/**
 * A coalesced open is returned with a transient notice for the caller. These
 * fields are deliberately added only to the returned view, never to the
 * append-only event or materialized open projection: a duplicate fire remains
 * one row while the caller learns that its body (unlike its refreshed summary)
 * was not persisted.
 */
export type EscalationOpenResult = EscalationRecord & {
  coalesced?: boolean;
  existingMsgId?: string;
  bodyDiscarded?: boolean;
};

interface EscalationDedupResult {
  record: EscalationRecord;
  coalesced: boolean;
}

function markCoalesced(record: EscalationRecord): EscalationOpenResult {
  return {
    ...record,
    coalesced: true,
    existingMsgId: record.msg_id,
    bodyDiscarded: true,
  };
}

/**
 * WI-7353: a duration embedded in a summary is a MONOTONICALLY-CHANGING value, and a
 * dedup key that contains one can never dedup — every tick derives a fresh key, so one
 * continuous condition mints an unbounded flood of un-coalesced rows.
 *
 * This has now recurred FOUR times, each time fixed only at the call site, leaving the
 * class armed for the next author who forgets `meta.subjectSignature`:
 *   - EI-10662  kettle/overwatch watchdog (prose summary as the key)
 *   - EI-14854  known-open-aging (`~Nh` duration + a re-minting issueId)
 *   - WI-7254   condition-staleness (`has been OPEN for {N}m`)
 *   - EI-19403159016550818 the same alarm, still flooding from a host on pre-fix code
 *
 * So neutralize it HERE, in the derived fallback itself, making the key stable by
 * construction rather than by every caller remembering. Deliberately NARROW: the digit
 * run must be preceded by start-of-string or whitespace AND followed by a time unit at a
 * word boundary. That is what keeps genuinely-distinct subjects distinct — `pot alpha-1`
 * (digits not unit-suffixed), `disk 80% full` (`%` is not a time unit) and `harness-3d`
 * (preceded by `-`, not whitespace) are all left untouched; only `for 50m` / `for 81m`
 * style tokens collapse, which is exactly the coalescing we want.
 *
 * Note this governs ONLY the fuzzy no-explicit-signature path. A caller supplying an
 * explicit conditionKey is unaffected, and supplying one remains strictly better than
 * relying on this backstop.
 */
const VOLATILE_DURATION_RE = /(^|\s)\d+(?:\.\d+)?\s?(?:ms|s|m|h|d)\b/g;

/**
 * EI-19474857043229377: a FIFTH instance of the class the duration rule above
 * exists for — a dedup key carrying a rotating token can never dedup — but with
 * a COMMIT SHA as the volatile value instead of a duration.
 *
 * MEASURED (papercusp-workspace, coord_event_log surface='escalations', 7d to
 * 2026-09-05): one continuous condition minted FIVE keys and 179 un-coalesced
 * opens, every one at severity `blocker`, every one auto-resolved by its own
 * emitter with choice "gate green" and ZERO agent involvement:
 *   green-checkpoint held: 6653fb41 push failed  96
 *   green-checkpoint held: 0092c7ab push failed  29
 *   green-checkpoint held: 5384ef26 push failed  23
 *   green-checkpoint held: 0ac0c3b1 push failed  16
 *   green-checkpoint held: e5e6747d push failed  15
 *
 * Neutralized HERE for the reason the duration rule gives: the class has
 * recurred repeatedly when fixed only at the call site, so make the key stable
 * by construction rather than by every caller remembering `meta.subjectSignature`.
 *
 * Deliberately NARROW — three independent guards, each killing a distinct
 * false-positive family, so genuinely-distinct subjects stay distinct:
 *   1. `(^|\s)` + `\b` — the run must be a WHOLE whitespace-delimited token, so
 *      suffixed identifiers (`EI-19474857043229377`, `harness-3d`) are untouched.
 *   2. must contain a DIGIT — spares all-letter hex-alphabet English words
 *      (`effaced`, `defaced`, `deadbeef`), which is why length alone is not enough.
 *   3. must contain a HEX LETTER — spares bare decimal runs (`count 12345678`),
 *      so a large number is never mistaken for a hash.
 * A run longer than 64 chars is left alone rather than guessed at.
 *
 * Ordered AFTER the duration replace so that rule's tested behaviour is unchanged.
 */
const VOLATILE_HEX_TOKEN_RE =
  /(^|\s)(?=[0-9a-f]{7,64}\b)(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/g;

/**
 * PURE: the summary-derived dedup key, with volatile tokens neutralized.
 * Exported for direct unit coverage — this function is the whole defence for a
 * failure class that has now recurred five times, and it previously had none.
 */
export function normalizeSubjectSignature(summary: string): string {
  return summary
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(VOLATILE_DURATION_RE, '$1<dur>')
    .replace(VOLATILE_HEX_TOKEN_RE, '$1<sha>');
}

/**
 * EI-12546: a stable, severity-INDEPENDENT dedupKind for a caller-supplied
 * conditionKey (which arrives here as meta.subjectSignature). A recurring
 * condition that legitimately escalates (advisory → blocker) must coalesce onto
 * its ONE open row — escalating severity is a normal drift-worsening signal, so
 * it's exactly when staying coalesced matters most. Before this, dedupKind
 * defaulted to `severity` even for an explicit conditionKey, so the coalesce
 * query (which matches on dedupKind AND subjectSignature) missed the existing
 * row the moment severity changed and forked a parallel one.
 *
 * The summary-DERIVED fallback (no explicit conditionKey) still keys dedupKind
 * on severity, so two unrelated same-summary escalations at different
 * severities stay separate — preserving the existing dedupKind-boundary
 * contract for that fuzzy path.
 */
const CONDITION_KEY_DEDUP_KIND = 'conditionKey';

function escalationDedupIdentity(input: OpenEscalationInput & { meta?: EscalationMeta }): EscalationDedupIdentity {
  const explicitSignature =
    typeof input.meta?.subjectSignature === 'string' && input.meta.subjectSignature.trim()
      ? input.meta.subjectSignature.trim()
      : null;
  const subjectSignature = explicitSignature ?? normalizeSubjectSignature(input.summary);
  const dedupKind =
    typeof input.meta?.dedupKind === 'string' && input.meta.dedupKind.trim()
      ? input.meta.dedupKind.trim()
      : explicitSignature !== null
        ? CONDITION_KEY_DEDUP_KIND
        : input.severity;
  return { dedupKind, subjectSignature };
}

function repeatCountOf(rec: Record<string, unknown>): number {
  const raw = rec[OPEN_ESCALATION_REPEAT_COUNT_KEY];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

function withRepeatMetadata(
  record: EscalationRecord,
  dedup: EscalationDedupIdentity,
  nowIso: string,
  repeatCount: number,
  // EI-12546: refresh the coalesced row's severity to the latest call's. On the
  // severity-independent conditionKey path this is what lets an advisory→blocker
  // escalation upgrade the ONE open row instead of leaving it stuck at the
  // original (lower) severity. On the summary-derived path the bucket is keyed by
  // severity, so a coalesce there is always same-severity and this is a no-op.
  severity: EscalationSeverity,
  // EI-20068390701347529: recurring liveness alarms render their current
  // magnitude into the summary. Coalescing must keep the one open row readable
  // at the latest observed magnitude instead of leaving its first-fire text
  // frozen forever.
  summary: string,
): EscalationRecord {
  return {
    ...record,
    severity,
    summary,
    [OPEN_ESCALATION_DEDUP_KIND_KEY]: dedup.dedupKind,
    [OPEN_ESCALATION_LAST_SEEN_KEY]: nowIso,
    [OPEN_ESCALATION_REPEAT_COUNT_KEY]: repeatCount,
    [OPEN_ESCALATION_SUBJECT_SIGNATURE_KEY]: dedup.subjectSignature,
  };
}

function buildOpenEscalationRecord(
  identity: AgentIdentity,
  input: OpenEscalationInput & {
    meta?: EscalationMeta;
    harness_slug?: string;
    /** P-010: the evidence band grounding this escalation. Adapter-level, exactly
     *  like `meta`/`harness_slug` — the generic coordination lib stays untouched.
     *  DESCRIPTIVE only (D-015): it changes how much weight a reader gives the
     *  escalation, never what the runtime executes. */
    evidence?: EvidenceStamp;
  },
  dedup: EscalationDedupIdentity,
  nowIso: string,
): EscalationRecord {
  const env: EscalationRecord = {
    ts: nowIso,
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: ['human'],
    kind: 'escalation',
    severity: input.severity,
    summary: input.summary,
    resolved: null,
  };
  Object.assign(env, {
    [OPEN_ESCALATION_DEDUP_KIND_KEY]: dedup.dedupKind,
    [OPEN_ESCALATION_LAST_SEEN_KEY]: nowIso,
    [OPEN_ESCALATION_REPEAT_COUNT_KEY]: 1,
    [OPEN_ESCALATION_SUBJECT_SIGNATURE_KEY]: dedup.subjectSignature,
  });
  if (input.body !== undefined) env.body = input.body;
  if (input.plan_slug !== undefined) env.plan_slug = input.plan_slug;
  if (input.options !== undefined) env.options = input.options;
  if (input.harness_slug !== undefined) env.harness_slug = input.harness_slug;
  if (input.meta) Object.assign(env, input.meta);
  // P-010: stamp the evidence band so the renderer can show `⊢ <band>
  // (confidence: <derived>)`. Set LAST-but-one deliberately: `meta` is a
  // caller-supplied extras bag, and the band must not be silently overwritable
  // by a key collision in it.
  if (input.evidence) env[EVIDENCE_FIELD] = input.evidence;
  return env;
}

async function bumpProjectionDuplicateWithSql(
  sql: Sql | TransactionSql,
  workspaceId: string,
  dedup: EscalationDedupIdentity,
  nowIso: string,
  // EI-12546: refresh the coalesced row's severity to the latest call's, so a
  // conditionKey re-escalation that graduated advisory→blocker upgrades the ONE
  // open row instead of leaving it displayed at the old lower severity.
  severity: EscalationSeverity,
  // EI-20068390701347529: keep the materialized open row's rendered summary
  // current when a recurring signal's magnitude changes.
  summary: string,
): Promise<EscalationRecord | null> {
  // WI-10002540: one flat top-level merge, not nested jsonb_set calls. The nested
  // form needs one `jsonb_set(` opener per path clause. When '{summary}' was
  // added, its opener was not, so every call failed with 42601 and the swallowing
  // catches below hid it for a month. For top-level keys, `||` is exactly
  // jsonb_set(..., create_missing => true), and it has no per-key opener to miss.
  const rows = await sql<{ body: EscalationRecord }[]>`
    UPDATE harness_shared.coord_open_escalations
       SET body = body || jsonb_build_object(
             'repeatCount', COALESCE(NULLIF(body->>'repeatCount', '')::int, 1) + 1,
             'lastSeenTs', ${nowIso}::text,
             'severity', ${severity}::text,
             'summary', ${summary}::text
           )
     WHERE workspace_id = ${workspaceId}
       AND body->>'dedupKind' = ${dedup.dedupKind}
       AND body->>'subjectSignature' = ${dedup.subjectSignature}
    RETURNING body
  `;
  return rows[0]?.body ?? null;
}

async function insertEscalationEventWithSql(
  sql: Sql | TransactionSql,
  workspaceId: string,
  env: EscalationRecord,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug)
    VALUES (${workspaceId}, ${'escalations'}, NULL, ${env.msg_id}, ${JSON.stringify(env)}::text::jsonb, ${env.harness_slug ?? null})
    ON CONFLICT (workspace_id, surface, msg_id) WHERE surface IN ('handoffs', 'escalations')
    DO UPDATE SET body = EXCLUDED.body, ts = now(), harness_slug = EXCLUDED.harness_slug
  `;
}

async function openEscalationWithPgDedupLock(
  identity: AgentIdentity,
  input: OpenEscalationInput & {
    meta?: EscalationMeta;
    harness_slug?: string;
    /** P-010: the evidence band grounding this escalation. Adapter-level, exactly
     *  like `meta`/`harness_slug` — the generic coordination lib stays untouched.
     *  DESCRIPTIVE only (D-015): it changes how much weight a reader gives the
     *  escalation, never what the runtime executes. */
    evidence?: EvidenceStamp;
  },
  dedup: EscalationDedupIdentity,
  nowIso: string,
): Promise<EscalationDedupResult | null> {
  if (!coordHasPgFastPath()) return null;
  try {
    const sql = coordSql();
    const ws = coordWorkspaceId();
    return await sql.begin(async (tx) => {
      // EI-6840: serialize the first-writer check+insert. Without this, N
      // request workers can all miss the open projection before any trigger has
      // inserted a row, then append N identical escalation events.
      await tx`
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`coord-escalation-dedup:${ws}:${dedup.dedupKind}:${dedup.subjectSignature}`},
          0
        ))
      `;
      const bumped = await bumpProjectionDuplicateWithSql(tx, ws, dedup, nowIso, input.severity, input.summary);
      if (bumped) return { record: bumped, coalesced: true };
      const env = buildOpenEscalationRecord(identity, input, dedup, nowIso);
      await insertEscalationEventWithSql(tx, ws, env);
      return { record: env, coalesced: false };
    });
  } catch (err) {
    rethrowIfSqlSyntaxError(err);
    return null;
  }
}

/**
 * WI-10002540: the PG fast-path catches exist so an unreachable store, or one
 * that has not applied the projection migration yet, falls back to the
 * event-log fold. A 42601 syntax error is never that condition. It is a defect
 * in the statement itself, and swallowing it hid a malformed UPDATE for a month
 * while every escalation silently took the slow, unlocked path.
 */
function rethrowIfSqlSyntaxError(err: unknown): void {
  if ((err as { code?: unknown } | null)?.code === '42601') throw err;
}

async function tryBumpProjectionDuplicate(
  dedup: EscalationDedupIdentity,
  nowIso: string,
  severity: EscalationSeverity,
  summary: string,
): Promise<EscalationRecord | null> {
  if (!coordHasPgFastPath()) return null;
  try {
    const sql = coordSql();
    const ws = coordWorkspaceId();
    return await bumpProjectionDuplicateWithSql(sql, ws, dedup, nowIso, severity, summary);
  } catch (err) {
    rethrowIfSqlSyntaxError(err);
    return null;
  }
}

async function findOpenDuplicate(
  dedup: EscalationDedupIdentity,
): Promise<EscalationRecord | null> {
  const { opens, resolves, reopens } = await loadEscalations();
  const open = foldEscalations(opens, resolves, { status: 'open', reopens }).find((rec) => {
    const meta = rec as Record<string, unknown>;
    return (
      meta[OPEN_ESCALATION_DEDUP_KIND_KEY] === dedup.dedupKind &&
      meta[OPEN_ESCALATION_SUBJECT_SIGNATURE_KEY] === dedup.subjectSignature
    );
  });
  return open ?? null;
}

/** Open a new escalation — writes the immutable per-event record. */
export async function openEscalation(
  identity: AgentIdentity,
  // `meta` is an optional domain-free extras bag persisted on the record via
  // CoordEnvelope's `[key:string]:unknown` index signature — inbox-cards-
  // unification Phase D (P-033) stashes `{ cardCorrelationId, cardWorkspaceId }`
  // here to link a durable escalation to a live ctx.askUser card. The generic
  // coordination lib is untouched (the field lives only in this adapter input).
  // WI-1375: `harness_slug` FEDERATES the escalation. A harness-scoped agent on a
  // PEER machine escalating "to human" needs its record to reach the hub where the
  // human's inbox lives — PgCoordLog projects env.harness_slug to the
  // coord_event_log.harness_slug column the capture trigger federates on
  // (distributed-coordination-shared-harness Track A). The coord:escalate tool sets it
  // ONLY for a concrete harness (never the operator/SU '*' wildcard), so an
  // operator-scope escalation correctly stays workspace-local. Distinct from
  // `meta.harnessSlug` (camelCase, body-only — the human-inbox chat-scoping key).
  input: OpenEscalationInput & {
    meta?: EscalationMeta;
    harness_slug?: string;
    /** P-010: the evidence band grounding this escalation. Adapter-level, exactly
     *  like `meta`/`harness_slug` — the generic coordination lib stays untouched.
     *  DESCRIPTIVE only (D-015): it changes how much weight a reader gives the
     *  escalation, never what the runtime executes. */
    evidence?: EvidenceStamp;
  },
): Promise<EscalationOpenResult> {
  const nowIso = new Date().toISOString();
  const guardedSummary = ownerAuthorshipGuardedSummary(input.summary, input.body);
  const guardedInput = guardedSummary === input.summary ? input : { ...input, summary: guardedSummary };
  // Dedup on the caller's stable subject, not on our presentation-only tag. This
  // lets a pre-guard open row coalesce and refresh into the guarded rendering
  // instead of forking a second owner escalation for the same condition.
  const dedup = escalationDedupIdentity(input);
  const locked = await openEscalationWithPgDedupLock(identity, guardedInput, dedup, nowIso);
  if (locked) return locked.coalesced ? markCoalesced(locked.record) : locked.record;
  const bumped = await tryBumpProjectionDuplicate(dedup, nowIso, guardedInput.severity, guardedInput.summary);
  if (bumped) return markCoalesced(bumped);
  const existing = await findOpenDuplicate(dedup);
  if (existing) {
    const refreshed = withRepeatMetadata(
      existing,
      dedup,
      nowIso,
      repeatCountOf(existing as Record<string, unknown>) + 1,
      guardedInput.severity,
      guardedInput.summary,
    );
    // The non-PG fallback has no materialized projection to update. Upsert the
    // coalesced record under its original msg_id so list/readers observe the
    // refreshed summary instead of only the transient return value.
    await coordLog.putEvent('escalations', refreshed.msg_id, refreshed);
    return markCoalesced(refreshed);
  }

  const env = buildOpenEscalationRecord(identity, guardedInput, dedup, nowIso);
  await coordLog.putEvent('escalations', env.msg_id, env);
  return env;
}

/** Read every escalation event and split it into opens + resolves. */
async function loadEscalations(): Promise<{
  opens: EscalationRecord[];
  resolves: EscalationResolvedEvent[];
  reopens: EscalationReopenedEvent[];
}> {
  const all = await coordLog.readEvents('escalations');
  const opens: EscalationRecord[] = [];
  const resolves: EscalationResolvedEvent[] = [];
  const reopens: EscalationReopenedEvent[] = [];
  for (const rec of all) {
    if (rec.kind === 'escalation') opens.push(rec as EscalationRecord);
    else if (rec.kind === 'escalation_resolved') {
      const ev = rec as EscalationResolvedEvent;
      if (typeof ev.related_msg_id === 'string') resolves.push(ev);
    } else if (rec.kind === 'escalation_reopened') {
      const ev = rec as EscalationReopenedEvent;
      if (typeof ev.related_msg_id === 'string') reopens.push(ev);
    }
  }
  return { opens, resolves, reopens };
}

/**
 * Read the OPEN escalation set from the materialized projection (mig 355) — a
 * small table holding exactly the currently-open escalation records, maintained
 * incrementally by the coord_open_escalations_trg trigger. This is the P-005
 * fast path: it replaces the unbounded ~35k-event full-surface replay
 * (loadEscalations -> readEvents) that pg_stat_statements pinned as ~88% of DB
 * exec time. The stored `body` IS the open EscalationRecord (resolved:null by
 * construction — resolved rows are deleted by the trigger). Sorted in JS with
 * the SAME comparator as foldEscalations({status:'open'}) so the output is
 * byte-identical to the fold path (collation-independent).
 */
async function readOpenEscalationsProjection(
  from?: string,
  filter?: EscalationLookupFilter,
): Promise<EscalationRecord[]> {
  const sql = coordSql();
  const ws = coordWorkspaceId();
  // EI-19403159016550818: `from` filters SERVER-SIDE. A caller that wants only its
  // OWN open escalations (an alarm auto-resolving its own reminders) must never
  // get them via "read a bounded page, then filter in JS" — the page is ordered
  // oldest-first and capped at 500, so a single author's rows fall outside it the
  // moment the workspace-wide open set exceeds the cap, and the filter then yields
  // an empty list that is indistinguishable from "I have nothing open".
  const rows = from
    ? await sql<{ body: EscalationRecord }[]>`
        SELECT body FROM harness_shared.coord_open_escalations
         WHERE workspace_id = ${ws} AND body->>'from' = ${from}
      `
    : await sql<{ body: EscalationRecord }[]>`
        SELECT body FROM harness_shared.coord_open_escalations
         WHERE workspace_id = ${ws}
      `;
  const all = rows
    .map((r) => r.body)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
  // EI-15377: this projection table already holds exactly the (small) open set,
  // not the ~35k-event full surface — so a conditionKey/q filter applied here is
  // cheap and, unlike the legacy windowed fold path below, sees the WHOLE open
  // backlog rather than only a recency window.
  return filter ? all.filter((rec) => escalationMatchesFilter(rec, filter)) : all;
}

/**
 * Read one exact open-escalation subject without materializing the complete
 * open set. The critical work-item creation alert is keyed by a stable
 * conditionKey/subjectSignature, so settle-time cleanup must remain cheap even
 * when the item was re-rated away from `critical` before it settled.
 *
 * The projection is an optimization, not the source of truth: when the fast
 * path is unavailable (or its feature flag/read fails), retain the existing
 * full-fold fallback used by the general list operation.
 */
export async function listOpenEscalationsBySubjectSignature(subjectSignature: string): Promise<EscalationRecord[]> {
  const subject = subjectSignature.trim();
  if (!subject) return [];

  if (coordHasPgFastPath()) {
    let useProjection = false;
    try {
      useProjection = await getFlag(FLAGS.COORD_OPEN_ESCALATIONS_PROJECTION, systemDistinctId());
    } catch {
      useProjection = false;
    }
    if (useProjection) {
      try {
        const sql = coordSql();
        const ws = coordWorkspaceId();
        const rows = await sql<{ body: EscalationRecord }[]>`
          SELECT body
            FROM harness_shared.coord_open_escalations
           WHERE workspace_id = ${ws}
             AND body->>'dedupKind' = 'conditionKey'
             AND body->>'subjectSignature' = ${subject}
        `;
        return rows.map((row) => row.body);
      } catch {
        // Fall through to the authoritative event fold below.
      }
    }
  }

  return (await listEscalations({ status: 'open' })).filter(
    (record) => (record as Record<string, unknown>)[OPEN_ESCALATION_SUBJECT_SIGNATURE_KEY] === subject,
  );
}

/** List escalation records. Optionally filter by open/resolved. */
export async function listEscalations(
  opts: { status?: 'open' | 'resolved' } = {},
): Promise<EscalationRecord[]> {
  // P-005 fast path: serve the open set from the materialized projection instead
  // of the unbounded full-surface event replay, when the flag is ON. Fail-safe:
  // any flag-read or projection-read error falls through to the authoritative
  // fold below (e.g. before mig 355 applies, the projection table won't exist).
  //
  // Gate on coordHasPgFastPath(): the projection read goes through coordSql(),
  // which — when the seam is the in-memory/fs double (tests) — falls back to a
  // DIFFERENT (real org) PG store than the seam reads/writes. Taking it there
  // would silently return another store's rows instead of the seam's seeded data
  // (the listEscalations({status:'open'}) failures the green gate caught). Same
  // contract readInbox/readAckedMsgIds gate on (see coordHasPgFastPath doc).
  if (opts.status === 'open' && coordHasPgFastPath()) {
    let useProjection = false;
    try {
      useProjection = await getFlag(
        FLAGS.COORD_OPEN_ESCALATIONS_PROJECTION,
        systemDistinctId(),
      );
    } catch {
      useProjection = false;
    }
    if (useProjection) {
      try {
        return await readOpenEscalationsProjection();
      } catch {
        // fall through to the authoritative event-fold
      }
    }
  }
  const { opens, resolves, reopens } = await loadEscalations();
  return foldEscalations(opens, resolves, { ...opts, reopens });
}

/** WI-4181: slack subtracted from the oldest open's ts when deciding whether the
 *  resolves window covers the opens window — absorbs writer clock skew (ts is
 *  client-side `new Date().toISOString()`) between the open and its resolution. */
const RESOLVE_COVERAGE_SLACK_MS = 60_000;
/** WI-4181: hard cap on EXTRA resolves pages fetched for coverage (beyond the
 *  first window) — bounds the read to (1 + cap) × maxRecords rows even on a
 *  pathologically resolve-heavy surface. */
const MAX_RESOLVE_COVERAGE_PAGES = 8;

/**
 * EI-1548 (#3): a caller-supplied `body` (openEscalation's free-text detail
 * field, e.g. a diagnostic dump) can be arbitrarily large — unlike `summary`,
 * which is always short. Bounding `maxRecords` alone still lets N records of
 * fat bodies reproduce the original ~9MB-response repro. LIST mode truncates
 * `body` per-record and flags it (`bodyTruncated` + the original `bodyLength`)
 * so a caller who needs the full text knows more exists; `getEscalation`
 * (single-record read by msg_id) is untouched and always returns the full body.
 */
const MAX_LIST_BODY_CHARS = 500;

function boundBodyForList(rec: EscalationRecord): EscalationRecord {
  if (typeof rec.body !== 'string' || rec.body.length <= MAX_LIST_BODY_CHARS) return rec;
  return {
    ...rec,
    body: rec.body.slice(0, MAX_LIST_BODY_CHARS),
    bodyTruncated: true,
    bodyLength: rec.body.length,
  };
}

/**
 * EI-15377: server-side lookup filters, so re-verifying ONE known escalation
 * against a 300+ backlog no longer requires dumping the whole page and
 * grepping a door-truncated scratch file.
 *
 * `conditionKey` is an EXACT match against the record's `subjectSignature` —
 * the same field a caller supplies (as `meta.subjectSignature`) when opening
 * an escalation with an explicit dedup key (see `escalationDedupIdentity`
 * above); it is what the write-side dedup/coalesce logic already keys on, so
 * the read side now supports the mirror lookup the write side has always had.
 * `q` is a case-insensitive substring match over `summary` + `body`.
 */
export interface EscalationLookupFilter {
  conditionKey?: string;
  q?: string;
}

function escalationMatchesFilter(rec: EscalationRecord, filter?: EscalationLookupFilter): boolean {
  if (!filter) return true;
  if (filter.conditionKey !== undefined) {
    const sig = (rec as Record<string, unknown>)[OPEN_ESCALATION_SUBJECT_SIGNATURE_KEY];
    if (sig !== filter.conditionKey) return false;
  }
  if (filter.q !== undefined) {
    const needle = filter.q.toLowerCase();
    const summaryMatch = typeof rec.summary === 'string' && rec.summary.toLowerCase().includes(needle);
    const bodyMatch = typeof rec.body === 'string' && rec.body.toLowerCase().includes(needle);
    if (!summaryMatch && !bodyMatch) return false;
  }
  return true;
}

/**
 * List escalation records with pagination to prevent unbounded response sizes.
 * Loads up to maxRecords events, folds them, and returns with a truncated flag.
 * WI-239: bounds coord:escalations so one call never returns ~9M chars.
 */
export async function listEscalationsPaginated(
  opts: {
    status?: 'open' | 'resolved';
    maxRecords?: number;
    offset?: number;
    from?: string;
    conditionKey?: string;
    q?: string;
  } = {},
): Promise<{
  escalations: EscalationRecord[];
  truncated: boolean;
  total: number;
  trueOpenTotal?: number;
  offset?: number;
  /** EI-15377: set when conditionKey/q was applied via the legacy windowed fold
   *  path (i.e. NOT the unbounded open-set projection) — a miss there does not
   *  prove absence, only that the match (if any) fell outside the recency
   *  window this page scanned. Never set on the projection fast path, which
   *  filters the complete open set and needs no such caveat. */
  filterWindowCaveat?: boolean;
}> {
  const maxRecords = Math.max(1, Math.min(opts.maxRecords ?? 50, 500));
  const offset = Math.max(0, opts.offset ?? 0);
  const conditionKey = typeof opts.conditionKey === 'string' && opts.conditionKey.trim() ? opts.conditionKey.trim() : undefined;
  const q = typeof opts.q === 'string' && opts.q.trim() ? opts.q.trim() : undefined;
  const filter: EscalationLookupFilter | undefined = conditionKey !== undefined || q !== undefined ? { conditionKey, q } : undefined;

  // EI-18712273081050373 (WI-6038's sibling) — for status:'open', when the P-005
  // materialized projection is available, serve the PAGE directly from it instead
  // of the recency-windowed raw-event-log fold below. That fold only ever scans
  // the NEWEST `maxRecords` "escalation" open events (+ a bounded, extended
  // resolves window) — so in a high-churn workspace where most RECENT escalation
  // traffic resolves quickly, an OLD escalation that never resolved is buried
  // under that noise and is NEVER reached, no matter how large `maxRecords` is
  // raised: raising it only widens the SAME recency window, it never introduces a
  // way to page further BACK. Live-observed: trueOpenTotal:359, a maxRecords:50
  // page returning exactly 0-1 rows. The projection already holds the exact,
  // complete, ordered open set (it's the very source `trueOpenTotal` reads below)
  // — slicing it directly by `offset` makes the WHOLE backlog pageable (sum of
  // pages == trueOpenTotal) instead of silently returning a near-empty page while
  // claiming a true count of hundreds.
  if (opts.status === 'open' && coordHasPgFastPath()) {
    let useProjection = false;
    try {
      useProjection = await getFlag(FLAGS.COORD_OPEN_ESCALATIONS_PROJECTION, systemDistinctId());
    } catch {
      useProjection = false;
    }
    if (useProjection) {
      try {
        // EI-19403159016550818: push `from` into the projection query, so an
        // author-scoped read is COMPLETE for that author rather than "whatever
        // survived the workspace-wide window". EI-15377: conditionKey/q are
        // pushed the same way — this leg reads the WHOLE open set, so the
        // filter is complete, not windowed.
        const all = await readOpenEscalationsProjection(opts.from, filter);
        // EI-19938772014458100: `all` is sorted ASCENDING (oldest-first — see
        // readOpenEscalationsProjection's comparator). Slicing from the FRONT
        // with offset=0 therefore returned the OLDEST `maxRecords` rows, while
        // this tool's own contract (and every caller) expects "newest-first" —
        // the default page silently hid every recent escalation behind however
        // many old, never-resolved ones happened to sort first. Take the newest
        // window instead (`offset` walks further BACK in time from the newest
        // end), keeping ascending order WITHIN the page so within-page byte
        // identity with the legacy fold path is preserved.
        const end = Math.max(0, all.length - offset);
        const start = Math.max(0, end - maxRecords);
        const page = all.slice(start, end).map(boundBodyForList);
        return {
          escalations: page,
          truncated: offset + maxRecords < all.length,
          total: page.length,
          trueOpenTotal: all.length,
          offset,
        };
      } catch {
        // fall through to the legacy windowed fold below — best-effort, never a
        // hard dependency of the projection being reachable.
      }
    }
  }

  // EI-1548: bound the READ at the storage layer instead of loading the ENTIRE
  // escalations surface into memory and truncating after.
  //
  // EI-6624: read `escalation` (opens) and `escalation_resolved` (resolves)
  // events on SEPARATE bounded windows (kinds-filtered), rather than one
  // shared `limit`-sized window mixing both kinds. The old combined window let
  // a burst of resolve events (an active fleet resolving a backlog — exactly
  // this session's own traffic) crowd OPEN escalations out of the window
  // entirely: `escalations:[]` with a nonzero `total`/`truncated:true`, which
  // read as broken rather than "no matches in a resolve-heavy window."
  // EI-16170: a bounded/windowed page's `total` (== `escalations.length`, see
  // below) is NOT the backlog size — it's just how many fit in this window,
  // and a small `maxRecords` window silently reads like ground truth (a
  // maxRecords:10 open-scan reporting "total:2" was mistaken for "only 2
  // escalations open" when the real open backlog was 279+; the OverwatchBrief
  // aging-escalations panel, which reads the UNBOUNDED set, was correct all
  // along). For status:'open' only, also fetch the true unbounded open count
  // via `listEscalations` (already the panel's own source of truth) so a
  // caller has an honest total to compare its bounded page against instead of
  // conflating the two.
  const [opensRaw, firstResolvePage, trueOpenTotal] = await Promise.all([
    coordLog.readEventsBounded('escalations', { limit: maxRecords, kinds: ['escalation'] }),
    coordLog.readEventsBoundedCursor('escalations', {
      limit: maxRecords,
      kinds: ['escalation_resolved', 'escalation_reopened'],
    }),
    opts.status === 'open' ? listEscalations({ status: 'open' }).then((rows) => rows.length) : Promise.resolve(undefined),
  ]);
  const opens = opensRaw as EscalationRecord[];

  // WI-4181: the resolves window must reach at least as far BACK as the opens
  // window. A resolution row is always NEWER than the open it closes, so every
  // resolve that can pair with `opens` has ts >= the oldest open's ts — but the
  // two windows are bounded by COUNT, and under resolve-heavy traffic the
  // newest-N resolves window goes time-SHALLOWER than the newest-N opens window.
  // An old open whose resolution was evicted then re-materializes as a ZOMBIE
  // "open" (live incident 2026-07-11: a Jul-9 health-tick-stale escalation,
  // resolved 4min after opening, re-listed as open once 500+ newer resolves
  // accumulated — the infra-liveness alarm re-attempted the resolve and
  // re-broadcast its recovery from 17 workers every ~2min for ~12h). Page the
  // resolves cursor deeper until it covers the oldest open (with clock-skew
  // slack), the surface is exhausted, or the hard page cap trips.
  let resolveRows = firstResolvePage.rows;
  let resolvesExhausted = firstResolvePage.exhausted;
  const oldestOpenMs = opens.length
    ? Date.parse(opens.reduce((min, o) => (o.ts < min ? o.ts : min), opens[0].ts))
    : null;
  const coverageTs =
    oldestOpenMs !== null && Number.isFinite(oldestOpenMs)
      ? new Date(oldestOpenMs - RESOLVE_COVERAGE_SLACK_MS).toISOString()
      : null;
  let extraPages = 0;
  while (
    coverageTs !== null &&
    !resolvesExhausted &&
    extraPages < MAX_RESOLVE_COVERAGE_PAGES &&
    resolveRows.length > 0 &&
    resolveRows[resolveRows.length - 1].envelope.ts > coverageTs
  ) {
    const page = await coordLog.readEventsBoundedCursor('escalations', {
      limit: maxRecords,
      kinds: ['escalation_resolved', 'escalation_reopened'],
      beforeId: resolveRows[resolveRows.length - 1].id,
    });
    resolveRows = resolveRows.concat(page.rows);
    resolvesExhausted = page.exhausted;
    extraPages += 1;
    if (page.rows.length === 0) break;
  }
  const resolves = resolveRows
    .map((r) => r.envelope)
    .filter(
      (rec): rec is EscalationResolvedEvent =>
        rec.kind === 'escalation_resolved' && typeof (rec as EscalationResolvedEvent).related_msg_id === 'string',
    );
  const reopens = resolveRows
    .map((r) => r.envelope)
    .filter(
      (rec): rec is EscalationReopenedEvent =>
        rec.kind === 'escalation_reopened' && typeof (rec as EscalationReopenedEvent).related_msg_id === 'string',
    );

  const foldedAll = foldEscalations(opens, resolves, { ...opts, reopens });
  // EI-19403159016550818: same `from` scoping as the projection path above. NOTE
  // this leg filters AFTER a recency-bounded fold, so it is bounded-by-window in
  // the way that path always was — it is consistent, not complete. The projection
  // path is the one that gives an author a complete read.
  const fromFiltered = opts.from ? foldedAll.filter((r) => r.from === opts.from) : foldedAll;
  // EI-15377: conditionKey/q applied HERE, on this leg only, are bounded by the
  // SAME recency window as everything else on this path (see the EI-19403159016550818
  // note above `foldedAll`) — a miss does not prove absence, it may just be older
  // than what this window scanned. `filterWindowCaveat` says so explicitly, so a
  // caller re-checking one known escalation does not mistake a windowed miss for
  // confirmed resolution.
  const escalations = (filter ? fromFiltered.filter((r) => escalationMatchesFilter(r, filter)) : fromFiltered).map(
    boundBodyForList,
  );
  // `total` = escalations actually returned (matches the tool's own human-facing
  // "Bounded to the N most-recent escalation events" note — never inconsistent
  // with `escalations`, unlike the old raw-event-scan count). `truncated` flags
  // that either bounded kind-window maxed out, so older matches may exist
  // beyond it (NOT the full backlog size — that would need an unbounded count).
  const truncated = opens.length >= maxRecords || resolveRows.length >= maxRecords;
  return {
    escalations,
    truncated,
    total: escalations.length,
    ...(trueOpenTotal !== undefined ? { trueOpenTotal } : {}),
    ...(filter ? { filterWindowCaveat: true } : {}),
  };
}

/**
 * Close/archive escalations older than TTL that have been resolved.
 * GC for both operational (system) and user escalations to prevent unbounded growth.
 * WI-239: implement escalation lifecycle GC.
 */
export interface ArchiveEscalationOpts {
  resolvedOlderThanMs?: number; // Default 14 days (14 * 24 * 60 * 60 * 1000)
  limit?: number; // Max escalations to archive per call (batch limit, default 200)
}

export interface ArchiveResult {
  scanned: number;
  archived: number;
  truncated: boolean; // True if more remain beyond the batch limit
}

export async function archiveResolvedEscalations(
  opts: ArchiveEscalationOpts = {},
): Promise<ArchiveResult> {
  const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  const ttlMs = opts.resolvedOlderThanMs ?? DEFAULT_TTL_MS;
  const limit = opts.limit ?? 200;
  const nowMs = Date.now();
  
  const { opens, resolves, reopens } = await loadEscalations();
  const resolveMap = indexResolves(resolves, reopens);
  
  // Find resolved escalations older than TTL
  const toArchive: string[] = [];
  for (const open of opens) {
    const resolved = resolveMap.get(open.msg_id);
    if (!resolved) continue; // Not resolved yet
    
    const resolvedMs = Date.parse(resolved.ts);
    if (!Number.isFinite(resolvedMs)) continue;
    
    const ageMs = nowMs - resolvedMs;
    if (ageMs >= ttlMs) {
      toArchive.push(open.msg_id);
      if (toArchive.length >= limit) break;
    }
  }
  
  // Archive by creating a special "archived" resolution event.
  // WI-346: collect + write in one batched putEvents (was one putEvent per row).
  //
  // ⚠ UNCALLED as of 2026-08-08 — nothing in the tree invokes this function; the
  // physical reclaim that superseded it is `gcResolvedEscalationFamilies`
  // (escalation-log-gc.ts), which DELETES families instead of adding rows.
  //
  // ⚠ DO NOT WIRE THIS UP AS-IS. The comment here used to claim it was
  // "idempotent: a no-op from the fold perspective". That is true of the FOLD and
  // false of STORAGE, which is the reading that matters for a GC: `indexResolves`
  // keeps the EARLIEST resolve per target, so the resolve this loop ages against
  // never advances — once a family crosses the TTL it is re-selected on EVERY
  // subsequent pass, and each pass appends another row under a fresh `newMsgId()`.
  // That is unbounded growth in the surface a GC exists to shrink.
  //
  // Fixing it needs a DERIVED key, as WI-10769 did for the two live resolve paths
  // above — but NOT `resolvedEventId`, which would collide with the genuine
  // resolve and overwrite its from/summary/choice with 'auto-archived'. It needs
  // its own namespace (e.g. `arc-<msgId>`) so repeat passes collapse onto one row.
  const archiveWrites = toArchive.map((msgId) => {
    const archiveEv: EscalationResolvedEvent = {
      ts: new Date().toISOString(),
      msg_id: newMsgId(),
      from: 'system:escalation-gc',
      to: ['human'],
      kind: 'escalation_resolved',
      related_msg_id: msgId,
      summary: 'auto-archived: resolved escalation aged beyond retention',
      choice: 'auto-archived',
    };
    return { msgId: archiveEv.msg_id, record: archiveEv };
  });
  await coordLog.putEvents('escalations', archiveWrites);
  const archived = archiveWrites.length;

  return { scanned: opens.length, archived, truncated: toArchive.length >= limit };
}

export interface ExpireAdvisoryEscalationOpts {
  olderThanMs?: number;
  limit?: number;
}

export interface ExpireAdvisoryEscalationResult {
  scanned: number;
  eligible: number;
  expired: number;
  truncated: boolean;
}

/**
 * Auto-expire OPEN advisory escalations older than the TTL. This is separate
 * from resolved-family GC: these rows are still open noise, but they are the
 * lowest-severity band and safe to clear once stale. Blocker/question rows are
 * never touched here.
 */
export async function expireStaleAdvisoryEscalations(
  opts: ExpireAdvisoryEscalationOpts = {},
): Promise<ExpireAdvisoryEscalationResult> {
  const ttlMs = opts.olderThanMs ?? DEFAULT_ADVISORY_EXPIRY_MS;
  const limit = opts.limit ?? DEFAULT_ADVISORY_EXPIRY_LIMIT;
  const nowMs = Date.now();
  const open = await listEscalations({ status: 'open' });
  const eligible = open
    .filter((rec) => rec.severity === 'advisory')
    .map((rec) => ({ rec, tsMs: Date.parse(rec.ts) }))
    .filter((row) => Number.isFinite(row.tsMs) && nowMs - row.tsMs >= ttlMs)
    .sort((a, b) => a.tsMs - b.tsMs || a.rec.msg_id.localeCompare(b.rec.msg_id));
  const batch = eligible.slice(0, limit);
  const expired =
    batch.length === 0
      ? 0
      : (
          await resolveEscalationsBatch(
            batch.map(({ rec }) => ({
              msg_id: rec.msg_id,
              choice: 'auto-expired',
              resolver: 'system:escalation-expiry',
              note: `auto-expired: advisory escalation aged beyond ${Math.round(ttlMs / 86_400_000)}d retention`,
            })),
          )
        ).resolved;
  return {
    scanned: open.length,
    eligible: eligible.length,
    expired,
    truncated: eligible.length > batch.length,
  };
}

/** One escalation to resolve in a batch sweep. Mirrors the per-call ResolveInput
 *  fields the batch path needs (no `allowSpawnRequest` — spawn-approval requests
 *  are never auto-reconciled, so a batch never resolves them). */
export interface BatchResolveItem {
  msg_id: string;
  choice: string;
  resolver?: string;
  note?: string;
}

export interface BatchResolveResult {
  resolved: number;
  notFound: number;
  alreadyResolved: number;
  requiresSpawnApprove: number;
}

/**
 * Resolve MANY escalations from a SINGLE load of the escalation log.
 *
 * EI-1490: the attention-reconcile sweep used to call `resolveEscalation` once
 * per stale escalation, and EACH call re-reads the ENTIRE escalations surface
 * (`loadEscalations` → `readEvents`) to find the open + check the resolve index.
 * Over the live ~13k operational backlog that is O(n²) per tick (500 resolves ×
 * a full ~14k-event scan each), so a sweep tick is slow enough to drain only a
 * fraction of its batch before the step budget — the lane never actually
 * drained. This batch loads + indexes ONCE, then writes the sibling
 * `escalation_resolved` events in a single O(n) pass.
 *
 * Idempotent + safe exactly like `resolveEscalation`: an unknown id → notFound,
 * an already-resolved (or duplicate-in-batch) id → alreadyResolved (no write),
 * a spawn-approval request → requiresSpawnApprove (never auto-resolved).
 */
export async function resolveEscalationsBatch(
  inputs: readonly BatchResolveItem[],
): Promise<BatchResolveResult> {
  const result: BatchResolveResult = {
    resolved: 0,
    notFound: 0,
    alreadyResolved: 0,
    requiresSpawnApprove: 0,
  };
  if (inputs.length === 0) return result;

  // ONE load for the whole batch (the O(n²) → O(n) fix).
  const { opens, resolves, reopens } = await loadEscalations();
  const openById = new Map(opens.map((e) => [e.msg_id, e]));
  const alreadyResolved = indexResolves(resolves, reopens);
  // Also guard against the same msg_id appearing twice in `inputs`.
  const resolvedThisBatch = new Set<string>();

  // WI-346 / round3 P-001: collect the sibling resolved-events and write them in
  // a SINGLE multi-row INSERT (coordLog.putEvents) instead of one putEvent per
  // resolve. The per-row write made the reconcile cost N round-trips AND N DBOS
  // steps, capping a drain tick at ~150 even with a 2500-item batch — the lane
  // never actually drained the ~11k operational backlog. One putEvents = one
  // round-trip + one DBOS step, so a tick drains its whole batch.
  const toWrite: {
    msgId: string;
    record: EscalationResolvedEvent;
    open: EscalationRecord;
    input: BatchResolveItem;
  }[] = [];

  for (const input of inputs) {
    const open = openById.get(input.msg_id);
    if (!open) {
      result.notFound += 1;
      continue;
    }
    if (alreadyResolved.has(input.msg_id) || resolvedThisBatch.has(input.msg_id)) {
      result.alreadyResolved += 1;
      continue;
    }
    if ((open as Record<string, unknown>).spawnRequest === true) {
      result.requiresSpawnApprove += 1;
      continue;
    }
    // WI-10769: derived, exactly as in the single-resolve path above. This loop has
    // the SAME read-then-write shape (load at the top, check at `alreadyResolved`,
    // write at the batched `putEvents` below), so two sweeps racing the same backlog
    // previously wrote two rows per escalation. `putEvents` upserts on
    // (workspace_id, surface, msg_id), so a derived key makes the concurrent write
    // collapse onto ONE row instead of duplicating — no new primitive needed here,
    // because a drain sweep reports COUNTS and pages nobody, so it needs the row to
    // be unique but does not need to elect a single announcer.
    const generation = escalationGeneration(input.msg_id, reopens);
    const ev: EscalationResolvedEvent = {
      ts: new Date().toISOString(),
      msg_id: resolvedEventId(input.msg_id, generation),
      from: input.resolver ?? open.from,
      to: [open.from],
      kind: 'escalation_resolved',
      related_msg_id: input.msg_id,
      summary: `resolved: ${input.choice}`,
      choice: input.choice,
      generation,
    };
    if (input.resolver !== undefined) ev.by = input.resolver;
    if (input.note !== undefined) ev.note = input.note;
    toWrite.push({ msgId: ev.msg_id, record: ev, open, input });
    resolvedThisBatch.add(input.msg_id);
    result.resolved += 1;
  }

  // Single batched write for every resolve in this sweep (no-op on empty).
  await coordLog.putEvents(
    'escalations',
    toWrite.map(({ msgId, record }) => ({ msgId, record })),
  );
  await Promise.all(
    toWrite.map(({ open, input }) => settleEscalationRequesterInterest(open, input)),
  );

  return result;
}

/** Read one escalation by msg_id (with folded resolution), or null. */
export async function getEscalation(
  msg_id: string,
): Promise<EscalationRecord | null> {
  const open = await coordLog.getEvent('escalations', msg_id);
  if (!open || open.kind !== 'escalation') return null;
  const { resolves, reopens } = await loadEscalations();
  return foldResolved(open as EscalationRecord, indexResolves(resolves, reopens).get(msg_id));
}

/**
 * Append an owner compensation that reopens a resolved escalation. The original
 * resolution remains in history; the next resolve writes a new deterministic
 * generation, so repeat resolve/reopen cycles stay race-safe and auditable.
 */
export async function reopenEscalation(input: {
  msg_id: string;
  by?: string;
  note?: string;
}): Promise<EscalationRecord | 'not_found' | 'already_open'> {
  const { opens, resolves, reopens } = await loadEscalations();
  const open = opens.find((event) => event.msg_id === input.msg_id);
  if (!open) return 'not_found';
  if (!indexResolves(resolves, reopens).has(input.msg_id)) return 'already_open';
  const generation = escalationGeneration(input.msg_id, reopens) + 1;
  const event: EscalationReopenedEvent = {
    ts: new Date().toISOString(),
    msg_id: reopenedEventId(input.msg_id, generation),
    from: input.by ?? 'owner',
    to: [open.from],
    kind: 'escalation_reopened',
    related_msg_id: input.msg_id,
    generation,
    summary: `reopened escalation ${input.msg_id}`,
    ...(input.by ? { by: input.by } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
  const won = await coordLog.putEventIfAbsent('escalations', event.msg_id, event);
  if (!won) return 'already_open';
  return foldResolved(open, undefined);
}

/**
 * Resolve an escalation by msg_id. Append-only: writes a sibling
 * `escalation_resolved` event (never mutates the open record). Returns
 * the folded record, `'not_found'`, or `'already_resolved'` (no write).
 */
export async function resolveEscalation(
  input: ResolveInput,
  opts: { allowSpawnRequest?: boolean } = {},
): Promise<EscalationRecord | 'not_found' | 'already_resolved' | 'requires_spawn_approve'> {
  const { opens, resolves, reopens } = await loadEscalations();
  const open = opens.find((e) => e.msg_id === input.msg_id);
  if (!open) return 'not_found';
  if (indexResolves(resolves, reopens).has(input.msg_id)) return 'already_resolved';
  // unify-agent-spawn-chokepoint P-005/P-006: a `new_subagent` spawn-approval request
  // (it carries meta.spawnRequest) is resolvable ONLY via the brain-gated
  // `new_subagent:approve` tool (which passes allowSpawnRequest), NOT the general
  // `coord:resolve` (open to all coord roles). This is what makes "only the brain
  // decides spawns" enforced at the tool layer, not prompt convention.
  if ((open as Record<string, unknown>).spawnRequest === true && !opts.allowSpawnRequest) {
    return 'requires_spawn_approve';
  }

  // WI-10769 — the resolve event's id is DERIVED from the escalation it resolves,
  // not freshly minted. A resolve is terminal and one-per-escalation, so a fresh id
  // was never expressing anything true: it made N concurrent resolves of the SAME
  // row land as N distinct rows that no unique constraint could catch. Deriving it
  // makes "at most one resolve per escalation" a property of the key.
  const generation = escalationGeneration(input.msg_id, reopens);
  const ev: EscalationResolvedEvent = {
    ts: new Date().toISOString(),
    msg_id: resolvedEventId(input.msg_id, generation),
    from: input.resolver ?? open.from,
    to: [open.from],
    kind: 'escalation_resolved',
    related_msg_id: input.msg_id,
    summary: `resolved: ${input.choice}`,
    choice: input.choice,
    generation,
  };
  if (input.resolver !== undefined) ev.by = input.resolver;
  if (input.note !== undefined) ev.note = input.note;
  // The check at the top of this function is a READ; between it and here, a peer
  // worker may have resolved the same row. `putEventIfAbsent` is the atomic claim
  // that closes that window: exactly one concurrent caller gets `true`, and every
  // other one now learns it lost and reports the same `'already_resolved'` sentinel
  // it would have got had it read a moment later. That is what makes
  // liveness-alarm.ts's "only the worker whose resolve actually landed announces
  // it" TRUE — before this, all N workers got a record back and all N announced.
  const won = await coordLog.putEventIfAbsent('escalations', ev.msg_id, ev);
  if (!won) return 'already_resolved';
  await settleEscalationRequesterInterest(open, input);
  return foldResolved(open, ev);
}
