/**
 * push-utilization-io — the P-011 utilization ledger LIVE LEG
 * (ambient-semantic-push-2026-07-14 Phase 6): assemble the real
 * harness_shared.push_delivery disposition rows (migration 610) into the pure
 * core's ledger and roll them through {@link scorePushUtilization} into the
 * per-matcher dashboard report. READ-ONLY over the table — this module never
 * enqueues, never selects, never feeds back into delivery: eviction/tuning is a
 * HUMAN reading the report (D-005 / carry D-001), and the report says so on
 * every row (`advisoryOnly: true`).
 *
 * The one live-mapping policy a DB row forces that the pure core didn't:
 * WHEN does a delivered-but-unstamped row count as IGNORED? The pure core
 * excludes outcome-less entries from rates ("a pending push is not counted as
 * 'not pulled'") — but on the live table pulled_at/acted_at arrive LATER (or
 * never), so a row's silence only becomes signal with age. The
 * OBSERVATION-GRACE policy: a delivered row with neither stamp is PENDING
 * (outcome null, excluded) until `observationGraceMs` past its delivered_at,
 * after which it is OBSERVED-IGNORED ({pulled:false, acted:false}) — the D-005
 * "delivered but never pulled" eviction signal the dashboard exists to surface.
 *
 * DEFERRED with reason (unchanged from the pure core's header): AUTOMATIC
 * pulled/acted attribution — deriving "this owner resolved that handle / took
 * that action" from a live session trace — is the OutcomeProbe seam, host-
 * coupled and staged until the owner arms it. The WRITE path it will use ships
 * now (push-delivery-store recordPulled/recordActed, keyed owner + handle_ref);
 * nothing calls it on the turn path yet.
 */
import type { DropReason, PushObject, PushSessionClass } from './ambient-push';
import type { PushDeliveryRow } from './push-delivery-store';
import { recentDeliveries } from './push-delivery-store';
import type { LedgerEntry, PushUtilizationReport, UtilizationScoreParams } from './push-utilization';
import { pushKey, scorePushUtilization } from './push-utilization';

/** Pending → ignored after this long delivered-with-no-stamp (default 60 min:
 *  a push rides a turn-boundary injection, so engagement lands within the
 *  receiver's next turn or two — minutes — and an hour of silence is decided). */
export const DEFAULT_OBSERVATION_GRACE_MS = 60 * 60 * 1000;

/** migration 610 does NOT persist the receiver's session class (P-003 keyed
 *  delivery on owner only), and {@link scorePushUtilization} never reads the
 *  field — rows are stamped with this placeholder to satisfy the LedgerEntry
 *  shape. A real per-class dashboard cut needs a column (deferred until wanted). */
export const UNATTRIBUTED_SESSION_CLASS: PushSessionClass = 'interactive';

/** Tolerant timestamptz-text parse: postgres-js hands back `ts::text` in the
 *  server's text format ('2026-07-14 23:00:00.123-04'); V8 parses that directly,
 *  but don't bet the policy on it — retry with the ISO 'T' separator, and return
 *  null (never NaN) when both fail so the caller stays conservative (pending). */
function parsePgTimestamp(text: string | null): number | null {
  if (!text) return null;
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;
  const iso = Date.parse(text.replace(' ', 'T'));
  return Number.isFinite(iso) ? iso : null;
}

export interface RowLedgerPolicy {
  observationGraceMs?: number;
  now?: () => number;
}

/**
 * Map ONE push_delivery row to a ledger entry. Returns null for a QUEUED row —
 * it has not been through selection yet, so it is neither delivered nor dropped
 * and does not belong on the ledger (the caller counts it separately).
 *
 * Outcome policy for a delivered row, in order:
 *   • pulled_at/acted_at stamped → OBSERVED with the stamps as booleans
 *     (actionKind stays unset — 610 has no action-kind column; the per-kind
 *     tallies populate only once the OutcomeProbe leg lands richer data);
 *   • unstamped + delivered_at older than the grace → OBSERVED-IGNORED;
 *   • unstamped + fresh (or an unparseable delivered_at) → PENDING (null) —
 *     conservative: never fabricate a "not pulled" out of a row we cannot age.
 */
export function rowToLedgerEntry(row: PushDeliveryRow, policy: RowLedgerPolicy = {}): LedgerEntry | null {
  if (row.status === 'queued') return null;
  const now = policy.now ?? Date.now;
  const graceMs = policy.observationGraceMs ?? DEFAULT_OBSERVATION_GRACE_MS;

  const push: PushObject = {
    matcherKind: row.matcher_kind,
    severity: row.severity,
    teaser: row.teaser,
    handle: { kind: row.handle_kind, ref: row.handle_ref, query: row.handle_query ?? [] },
    score: row.score,
    provenance: 'data-not-directive',
    sourceSessionId: row.source_session_id,
  };

  if (row.status === 'dropped') {
    return {
      pushKey: pushKey(push),
      push,
      matcherKind: row.matcher_kind,
      sessionClass: UNATTRIBUTED_SESSION_CLASS,
      delivery: {
        kind: 'dropped',
        // recordDropped always writes a reason; the fallback is defensive only.
        reason: (row.drop_reason ?? 'below-floor') as DropReason,
      },
      outcome: null,
      observedAt: parsePgTimestamp(row.enqueued_at),
    };
  }

  // delivered
  const pulled = row.pulled_at != null;
  const acted = row.acted_at != null;
  let outcome: LedgerEntry['outcome'] = null;
  if (pulled || acted) {
    outcome = { pulled, acted };
  } else {
    const deliveredAtMs = parsePgTimestamp(row.delivered_at);
    if (deliveredAtMs != null && now() - deliveredAtMs >= graceMs) {
      outcome = { pulled: false, acted: false }; // observed-ignored: the D-005 signal
    }
  }

  return {
    pushKey: pushKey(push),
    push,
    matcherKind: row.matcher_kind,
    sessionClass: UNATTRIBUTED_SESSION_CLASS,
    delivery: { kind: 'delivered' },
    outcome,
    observedAt: parsePgTimestamp(row.delivered_at),
  };
}

export interface LedgerFromRowsResult {
  entries: LedgerEntry[];
  /** Rows still 'queued' — not yet through selection, skipped from the ledger. */
  queued: number;
  /** Delivered rows within the grace window with no stamp yet — on the ledger
   *  but outcome:null, so excluded from every rate. */
  pendingObservation: number;
}

/** Map a batch of rows; PURE given the rows + policy. */
export function ledgerFromRows(rows: PushDeliveryRow[], policy: RowLedgerPolicy = {}): LedgerFromRowsResult {
  const entries: LedgerEntry[] = [];
  let queued = 0;
  let pendingObservation = 0;
  for (const row of rows) {
    const entry = rowToLedgerEntry(row, policy);
    if (!entry) {
      queued += 1;
      continue;
    }
    if (entry.delivery.kind === 'delivered' && entry.outcome === null) pendingObservation += 1;
    entries.push(entry);
  }
  return { entries, queued, pendingObservation };
}

export interface RunUtilizationReportInput {
  /** Cut to one receiver; omit for the whole-fleet rollup. */
  targetOwnerId?: string;
  /** Enqueue-window start (recentDeliveries' `since` axis). */
  since?: Date | string;
  /** Max rows read (store-capped at 500). Default 500. */
  limit?: number;
  observationGraceMs?: number;
  params?: UtilizationScoreParams;
  now?: () => number;
}

export interface UtilizationReportResult {
  report: PushUtilizationReport;
  counts: {
    rows: number;
    ledgerEntries: number;
    queued: number;
    pendingObservation: number;
  };
  window: {
    targetOwnerId: string | null;
    since: string | null;
    limit: number;
    observationGraceMs: number;
  };
}

/**
 * The live P-011 read: recent push_delivery rows → ledger → per-matcher
 * utilization + advisory recommendations. Read-only; the result is a REPORT for
 * a human (and the tool surface that renders it), never a control input.
 */
export async function runUtilizationReport(input: RunUtilizationReportInput = {}): Promise<UtilizationReportResult> {
  const limit = input.limit ?? 500;
  const graceMs = input.observationGraceMs ?? DEFAULT_OBSERVATION_GRACE_MS;
  const rows = await recentDeliveries({
    targetOwnerId: input.targetOwnerId,
    since: input.since,
    limit,
  });
  const { entries, queued, pendingObservation } = ledgerFromRows(rows, {
    observationGraceMs: graceMs,
    now: input.now,
  });
  const report = scorePushUtilization(entries, input.params);
  const sinceIso =
    input.since == null ? null : typeof input.since === 'string' ? input.since : input.since.toISOString();
  return {
    report,
    counts: { rows: rows.length, ledgerEntries: entries.length, queued, pendingObservation },
    window: {
      targetOwnerId: input.targetOwnerId ?? null,
      since: sinceIso,
      limit,
      observationGraceMs: graceMs,
    },
  };
}
