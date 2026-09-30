/**
 * Hyperbee → PG projection for `harness_shared.p2p_receipts` — loud-refusal
 * receipt FACTS federated as hive state
 * (p2p-work-distribution-2026-07-02 P-004, mig 468).
 *
 * gate_verdicts pattern: IMMUTABLE INSERT-only facts, apply = INSERT … ON
 * CONFLICT DO NOTHING (dedup by receipt_id). Receiver-enforced (M6/L9): a
 * REMOTE op applies only when the op's VERIFIED source-log device attests to
 * the SAME numeric GitHub user the row names as `responder_github_user_id` —
 * you author receipts solely AS YOURSELF (a forged receipt would poison
 * reliability signals + the M21 trace). Refused applies bump the M15 counter.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { resolveAuthorCommsTier } from '../comms-tier-gate';
import { bumpRefusedOpCounter } from '../../../p2p/receipts';
import { P2P_RECEIPT_KINDS } from '../../../p2p/receipts';

/** Wire-shape of a federated p2p_receipts row. Defensive on every field. */
export interface P2pReceiptWireRow {
  harness_slug: string;
  receipt_id: string;
  kind: string;
  offer_id: string | null;
  action: string;
  refusal_code: string | null;
  missing_capability: string | null;
  budget_axis: string | null;
  detail: string;
  requester_kind: string | null;
  requester_ref: string | null;
  requester_github_user_id: number | null;
  responder_github_user_id: number;
  responder_device_pubkey: string | null;
  receipt_ts: number;
}

const KIND_SET: ReadonlySet<string> = new Set(P2P_RECEIPT_KINDS);

export function isP2pReceiptWireRow(input: unknown): input is P2pReceiptWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (typeof r.receipt_id !== 'string' || r.receipt_id.length === 0) return false;
  if (typeof r.kind !== 'string' || !KIND_SET.has(r.kind)) return false;
  if (r.offer_id !== null && typeof r.offer_id !== 'string') return false;
  if (typeof r.action !== 'string' || r.action.length === 0) return false;
  for (const k of ['refusal_code', 'missing_capability', 'budget_axis', 'requester_kind', 'requester_ref', 'responder_device_pubkey'] as const) {
    if (r[k] !== null && typeof r[k] !== 'string') return false;
  }
  if (typeof r.detail !== 'string') return false;
  if (r.requester_github_user_id !== null && typeof r.requester_github_user_id !== 'number') return false;
  if (typeof r.responder_github_user_id !== 'number' || !Number.isInteger(r.responder_github_user_id) || r.responder_github_user_id <= 0) return false;
  if (typeof r.receipt_ts !== 'number' || !Number.isFinite(r.receipt_ts)) return false;
  return true;
}

export interface P2pReceiptsProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  sql?: postgres.Sql;
  /** Identity-gate remote ops only when hive-bound (mirrors p2p-peer-grants). */
  potHomeSlug?: string;
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  resolveAuthorIdentity?: (devicePubkey: string | null) => Promise<{ githubUserId: number | null }>;
  onRefusedApply?: (reason: 'no_author_device' | 'identity_unresolved' | 'responder_mismatch', row: P2pReceiptWireRow) => void;
}

function composeKey(row: P2pReceiptWireRow): string {
  return row.receipt_id;
}

/**
 * Unknown kinds already warned about, so a peer steadily emitting a newer kind
 * logs once per process rather than once per row. Log-dedupe only — carries no
 * state anything reads back.
 */
const warnedUnknownKinds = new Set<string>();

function decodeValue(raw: unknown): P2pReceiptWireRow | null {
  if (isP2pReceiptWireRow(raw)) return raw;

  // EI-19333624101736074: P2P_RECEIPT_KINDS is a WIRE CONTRACT, so a peer
  // running a NEWER build emits kinds this one has never heard of — and the
  // guard above drops them indistinguishably from malformed junk. That silent
  // drop is the same defect class the 'honored' kind was added to fix (a fact
  // that never crosses looks exactly like a fact that never happened), so make
  // taxonomy skew SAY SO. Still dropped — accepting an unvalidated kind would
  // defeat the guard — but no longer invisible.
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const kind = r && typeof r.kind === 'string' ? r.kind : null;
  if (kind && !KIND_SET.has(kind) && !warnedUnknownKinds.has(kind)) {
    warnedUnknownKinds.add(kind);
    console.warn(
      `[p2p-receipts] DROPPED inbound receipt(s) of unknown kind '${kind}' — this peer's ` +
        `P2P_RECEIPT_KINDS (${[...KIND_SET].join(', ')}) predates the emitting peer's. ` +
        `Update this host to stop discarding them; further '${kind}' rows are dropped silently.`,
    );
  }
  return null;
}

function refuse(
  opts: P2pReceiptsProjectionOpts,
  reason: 'no_author_device' | 'identity_unresolved' | 'responder_mismatch',
  row: P2pReceiptWireRow,
): void {
  if (opts.onRefusedApply) {
    opts.onRefusedApply(reason, row);
    return;
  }
  console.warn(
    `[p2p-receipts] REFUSED inbound receipt op (${reason}): responder=${row.responder_github_user_id} ` +
      `action=${row.action}${row.offer_id ? ` offer=${row.offer_id}` : ''} hive=${row.harness_slug}`,
  );
  void bumpRefusedOpCounter(
    { workspaceId: opts.workspaceId, potSlug: row.harness_slug, reason: `receipt-apply:${reason}` },
    opts.sql as Parameters<typeof bumpRefusedOpCounter>[1],
  ).catch(() => {});
}

async function writeToPg(
  opts: P2pReceiptsProjectionOpts,
  row: P2pReceiptWireRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;

  if (provenance.origin === 'remote' && opts.potHomeSlug) {
    const sourceLogDevice = provenance.authorPubkey
      ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
      : null;
    if (!sourceLogDevice) {
      refuse(opts, 'no_author_device', row);
      return;
    }
    const resolveIdentity =
      opts.resolveAuthorIdentity ??
      (async (device: string | null) => {
        if (!device) return { githubUserId: null };
        const r = await resolveAuthorCommsTier({
          workspaceId: opts.workspaceId,
          potHomeSlug: opts.potHomeSlug!,
          devicePubkey: device,
        });
        return { githubUserId: r.githubUserId };
      });
    let authorUserId: number | null = null;
    try {
      authorUserId = (await resolveIdentity(sourceLogDevice)).githubUserId;
    } catch {
      authorUserId = null;
    }
    if (authorUserId == null) {
      refuse(opts, 'identity_unresolved', row);
      return;
    }
    if (authorUserId !== row.responder_github_user_id) {
      refuse(opts, 'responder_mismatch', row);
      return;
    }
  }

  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  // Immutable facts: dedup by (workspace, hive, receipt_id) — no LWW needed.
  await sql`
    INSERT INTO harness_shared.p2p_receipts
      (workspace_id, harness_slug, receipt_id, kind, offer_id, action,
       refusal_code, missing_capability, budget_axis, detail,
       requester_kind, requester_ref, requester_github_user_id,
       responder_github_user_id, responder_device_pubkey, receipt_ts,
       origin, author_pubkey, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.receipt_id}, ${row.kind},
       ${row.offer_id}, ${row.action}, ${row.refusal_code}, ${row.missing_capability},
       ${row.budget_axis}, ${row.detail}, ${row.requester_kind}, ${row.requester_ref},
       ${row.requester_github_user_id}, ${row.responder_github_user_id},
       ${row.responder_device_pubkey}, ${row.receipt_ts},
       ${origin}, ${authorPubkey}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, harness_slug, receipt_id) DO NOTHING
  `;
}

async function deleteFromPg(opts: P2pReceiptsProjectionOpts, key: string): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  // Admin-cleanup only (receipts are facts; there is no revocation semantics).
  await sql`
    DELETE FROM harness_shared.p2p_receipts
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND receipt_id = ${key}
  `;
}

export function buildP2pReceiptsProjection(
  opts: P2pReceiptsProjectionOpts,
): TableProjection<P2pReceiptWireRow> {
  return {
    tableTag: 'p2p-receipts',
    // EI-117: CDC-captured table — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key) => deleteFromPg(opts, key),
  };
}

export const _testing = { composeKey, decodeValue, isP2pReceiptWireRow, writeToPg };
