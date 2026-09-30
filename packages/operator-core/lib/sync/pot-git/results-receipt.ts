/**
 * pot-git/results-receipt.ts — the RC-1 results-channel receipt shape
 * (p2p-work-distribution-2026-07-02 P-108, ratified D-018; design
 * docs/plans/DESIGN-P-108-results-channel-2026-07-02.md §4).
 *
 * THE CONTRACT (RC-1): the receipt is the POINTER to a foreign deliverable —
 * `{scope_id, foreign_ref, commit_oid, execution_epoch, offer_id}` — and coord
 * NEVER carries artifacts. A refusal receipt names the EXACT cap/finding that
 * refused admission (P-004 loud-refusal discipline: authenticated failures get
 * receipts naming the missing capability/budget — M15), and the offer id
 * threads through every receipt so `p2p:trace` can assemble the cross-machine
 * timeline (M21). Results carry the offer's execution epoch so a stale
 * (resurrected) executor's receipt is rejectable by fencing, never by
 * wall-clock (H9/X6).
 *
 * This module is the SHAPE + builders + validation only. Delivery rides the
 * P-004 receipt rail (lane A) and persistence rides the results-channel wiring
 * — deliberately NOT here, so the shape stays pure and testable. The natural
 * producer is `foreign-mirror-quarantine.ts` (the RC-2 admission): its
 * `QuarantineFetchResult` is "receipt-ready" and `receiptFromQuarantine` is the
 * one sanctioned mapping. X8's EXCUSED-BREACH receipts are LEASE-lifecycle
 * receipts (P-203), not results receipts — out of scope here by design.
 */

import type { QuarantineFetchResult } from './foreign-mirror-quarantine';
import { type ScopeId, formatScopeId, parseScopeId } from './scope-repo';

export const RESULTS_RECEIPT_SCHEMA_VERSION = 1;

/** Why an admission refused — mirrors QuarantineRefusalCode plus the
 *  receipt-only 'stale-epoch' (H9 fencing happens at receipt consumption). */
export type ResultsRefusalCode =
  | 'fetch-failed'
  | 'blob-over-cap'
  | 'total-over-cap'
  | 'object-flood'
  | 'secrets'
  | 'identity'
  | 'stale-epoch'
  | 'error';

/** The RC-1 receipt — one record covers both outcomes; `kind` discriminates. */
export interface ResultsReceipt {
  v: number;
  kind: 'completion' | 'refusal';
  /** Canonical FederationScope id (`fleet:<uid>/<slug>`, FS-D2). */
  scope_id: string;
  /** The offer this deliverable answers (M21 — threads through both sides). */
  offer_id: string;
  /** The foreign-marked ref the result publishes as (P-110 contract). */
  foreign_ref: string;
  /** Admitted head sha (completion) / null (refusal). */
  commit_oid: string | null;
  /** The offer's execution epoch the executor ran under (H9 fencing). */
  execution_epoch: number;
  /** Refusal only: the machine-readable reason class. */
  refusal_code?: ResultsRefusalCode;
  /** Refusal only: the exact cap/finding, human-readable (P-004 loudness). */
  refusal_detail?: string;
  /** Admission accounting (both kinds; zero on pre-fetch failures). */
  new_object_count: number;
  new_total_bytes: number;
  /** Producer wall-clock, epoch-ms. INFORMATIONAL ONLY — never a gate (X6). */
  created_ts: number;
}

/** Render the one canonical loud refusal line (what the requester reads). */
function refusalDetail(q: QuarantineFetchResult): string {
  switch (q.refusalCode) {
    case 'blob-over-cap': {
      const worst = [...q.oversizeBlobs].sort((a, b) => b.bytes - a.bytes)[0];
      return worst
        ? `blob over per-blob cap: ${worst.path} (${worst.oid.slice(0, 12)}) is ${worst.bytes} bytes`
        : 'blob over per-blob cap';
    }
    case 'total-over-cap':
      return `total new bytes over cap: ${q.newTotalBytes} new bytes`;
    case 'object-flood':
      return `new object count over cap: ${q.newObjectCount} new objects`;
    case 'secrets': {
      const n = q.secretFindings.length;
      const first = q.secretFindings[0];
      const where = first ? ` (first: ${first.rule ?? 'finding'} in ${first.path ?? 'unknown path'})` : '';
      return `secret scan refused admission: ${n} finding(s)${where}`;
    }
    case 'identity': {
      const reasons = q.identity?.refusals ?? [];
      const first = reasons[0] as { sha?: string } | undefined;
      return `identity outside the offer's attested origin chain${
        first?.sha ? ` (first: commit ${String(first.sha).slice(0, 12)})` : ''
      } — ${reasons.length || 'unresolved'} inadmissible identit${reasons.length === 1 ? 'y' : 'ies'}`;
    }
    case 'fetch-failed':
      return `quarantine fetch failed: ${q.errors[0] ?? 'unknown git failure'}`;
    case 'error':
    default:
      return q.errors[0] ?? 'admission errored (fail-closed)';
  }
}

/**
 * Build the RC-1 receipt from an RC-2 admission outcome. `nowMs` is injected
 * (no ambient Date.now) so producers stamp once and tests are deterministic.
 */
export function receiptFromQuarantine(
  q: QuarantineFetchResult,
  ctx: { scope: ScopeId; executionEpoch: number; offerId?: string; nowMs: number },
): ResultsReceipt {
  const offerId = ctx.offerId ?? q.offerId ?? '';
  const base = {
    v: RESULTS_RECEIPT_SCHEMA_VERSION,
    scope_id: formatScopeId(ctx.scope),
    offer_id: offerId,
    foreign_ref: q.foreignRef,
    execution_epoch: ctx.executionEpoch,
    new_object_count: q.newObjectCount,
    new_total_bytes: q.newTotalBytes,
    created_ts: ctx.nowMs,
  };
  if (q.admit && q.head) {
    return { ...base, kind: 'completion', commit_oid: q.head };
  }
  return {
    ...base,
    kind: 'refusal',
    commit_oid: null,
    refusal_code: (q.refusalCode ?? 'error') as ResultsRefusalCode,
    refusal_detail: refusalDetail(q),
  };
}

/** Build the receipt-side H9 fence: a receipt whose epoch trails the offer's
 *  CURRENT execution epoch is refused as stale (epoch-gated, never wall-clock). */
export function staleEpochRefusal(
  receipt: ResultsReceipt,
  currentExecutionEpoch: number,
  nowMs: number,
): ResultsReceipt | null {
  if (receipt.execution_epoch >= currentExecutionEpoch) return null;
  return {
    ...receipt,
    kind: 'refusal',
    commit_oid: null,
    refusal_code: 'stale-epoch',
    refusal_detail: `execution epoch ${receipt.execution_epoch} trails current ${currentExecutionEpoch} — stale executor result refused (H9)`,
    created_ts: nowMs,
  };
}

const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/; // sha1 or sha256

/**
 * Validate an untrusted wire receipt (fail-closed: null = invalid, and the
 * CALLER owes a loud counter/receipt for it — never a silent drop, D-004).
 */
export function validateResultsReceipt(value: unknown): ResultsReceipt | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (r.v !== RESULTS_RECEIPT_SCHEMA_VERSION) return null;
  if (r.kind !== 'completion' && r.kind !== 'refusal') return null;
  if (typeof r.scope_id !== 'string' || parseScopeId(r.scope_id) === null) return null;
  if (typeof r.offer_id !== 'string' || r.offer_id.length === 0 || r.offer_id.length > 200) return null;
  if (typeof r.foreign_ref !== 'string' || !r.foreign_ref.startsWith('refs/foreign/')) return null;
  if (typeof r.execution_epoch !== 'number' || !Number.isSafeInteger(r.execution_epoch) || r.execution_epoch < 0)
    return null;
  if (typeof r.new_object_count !== 'number' || r.new_object_count < 0) return null;
  if (typeof r.new_total_bytes !== 'number' || r.new_total_bytes < 0) return null;
  if (typeof r.created_ts !== 'number' || r.created_ts <= 0) return null;
  if (r.kind === 'completion') {
    if (typeof r.commit_oid !== 'string' || !OID_RE.test(r.commit_oid)) return null;
  } else {
    if (r.commit_oid !== null) return null;
    if (typeof r.refusal_code !== 'string') return null;
    if (typeof r.refusal_detail !== 'string' || r.refusal_detail.length === 0) return null;
  }
  return value as unknown as ResultsReceipt;
}

/** The canonical loud one-line rendering (logs / coord summaries / p2p:trace). */
export function formatResultsReceipt(r: ResultsReceipt): string {
  return r.kind === 'completion'
    ? `p2p-results COMPLETION offer=${r.offer_id} scope=${r.scope_id} ref=${r.foreign_ref} oid=${r.commit_oid?.slice(0, 12)} epoch=${r.execution_epoch} (+${r.new_object_count} obj / ${r.new_total_bytes} B)`
    : `p2p-results REFUSAL offer=${r.offer_id} scope=${r.scope_id} ref=${r.foreign_ref} code=${r.refusal_code} epoch=${r.execution_epoch}: ${r.refusal_detail}`;
}
