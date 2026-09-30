/**
 * P2P loud-refusal receipts + M15 counters
 * (p2p-work-distribution-2026-07-02 P-004, Lane A).
 *
 * The D-004 contract: NO SILENT DROPS. Every refused/interrupted cross-peer
 * action produces, on the enforcing (responder) side:
 *   (a) a RECEIPT to the requester — a durable `p2p_receipts` row (mig 468)
 *       naming the EXACT missing capability/budget; it federates over the hive
 *       peer-log, so the requester's machines receive it without a push path
 *       (P-303's wake-nudge is latency-only, later);
 *   (b) a LOCAL AUDIT row (`harness_shared.audit_log`, the established inline
 *       pattern — flag-audit.ts / process-kill.ts);
 *   (c) a COUNTER metric (`p2p_refused_op_counters`).
 * M21: `offerId` threads through the receipt row, the audit `details`, and the
 * log line — both sides — so `p2p:trace` can assemble one offer's
 * cross-machine timeline. X8: `kind: 'excused-breach'` marks preemption-class
 * interruptions (kill-switch wind-down, revocation-lite downgrade), excluded
 * from reliability signals (P-203).
 * M15: an UNAUTHENTICATED failure path (no verified requester) gets ONLY the
 * counter — call `bumpRefusedOpCounter` directly (loud is not unbounded).
 *
 * C3 (WI-1564): all reads/writes resolve the workspace through
 * `resolveP2pGrantWorkspace` — same resolver as the grant store, and a receipt
 * write under the un-federating 'default' partition is REFUSED (a receipt the
 * requester never receives is a silent drop wearing a receipt's clothes).
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { OrgSql } from '../work-items';
import { resolveP2pGrantWorkspace } from './grant-store';
import type { P2pCapability, P2pGranteeKind } from './capabilities';
import type { BuildInfo } from '../build-info';

/**
 * Mixed-version responder identity carried inside the existing signed receipt
 * `detail` field. This deliberately does NOT widen the receipt wire/DB schema:
 * old peers retain the prose, while current peers can parse the bounded tail.
 *
 * `current` means "a current-format marker with a provable loaded SHA", not
 * "the same build as the reader". That comparison belongs at the read surface
 * because a different SHA proves skew, but not ancestry or which side is older.
 */
export type ResponderBuildMarkerEvidence =
  | { state: 'current'; sha: string; version: string | null; marker: string; detail: string }
  | { state: 'legacy'; sha: null; version: null; marker: null; detail: string }
  | { state: 'unknown'; sha: null; version: string | null; marker: string | null; detail: string };

/**
 * Comparison made by the READER between its loaded build and the responder's
 * receipt marker. `skew` means only "different loaded Git identities". It says
 * nothing about ancestry, ordering, or which host is stale.
 */
export interface ResponderBuildComparison {
  comparison: 'same' | 'skew' | 'unknown';
  responderSha: string | null;
  tracingSha: string | null;
  detail: string;
}

/** Keep each token small enough that a marker cannot turn receipt prose into an unbounded payload. */
export const RESPONDER_BUILD_MARKER_VALUE_MAX_CHARS = 80;

const RESPONDER_BUILD_MARKER_RE = /\[responder-build sha=([A-Za-z0-9._+\-]{1,80}) version=([A-Za-z0-9._+\-]{1,80})\]/;
const RESPONDER_BUILD_MARKER_PREFIX_RE = /\[responder-build\b/;

function safeResponderBuildValue(value: string | null | undefined): string {
  const safe = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._+\-]/g, '_')
    .slice(0, RESPONDER_BUILD_MARKER_VALUE_MAX_CHARS);
  return safe || 'unknown';
}

/** Pure formatter: callers pass the build identity sampled at receipt-emission time. */
export function formatResponderBuildMarker(build: Pick<BuildInfo, 'sha' | 'version'>): string {
  return `[responder-build sha=${safeResponderBuildValue(build.sha)} version=${safeResponderBuildValue(build.version)}]`;
}

/** Append one machine-readable marker without changing the receipt schema or the original prose. */
export function appendResponderBuildMarker(detail: string, build: Pick<BuildInfo, 'sha' | 'version'>): string {
  const marker = formatResponderBuildMarker(build);
  return detail ? `${detail.trimEnd()} ${marker}` : marker;
}

/**
 * Parse current, legacy, and explicit/malformed unknown evidence while
 * preserving the original detail verbatim for human diagnosis.
 */
export function parseResponderBuildMarker(detail: string): ResponderBuildMarkerEvidence {
  const match = RESPONDER_BUILD_MARKER_RE.exec(detail);
  if (!match) {
    return RESPONDER_BUILD_MARKER_PREFIX_RE.test(detail)
      ? { state: 'unknown', sha: null, version: null, marker: null, detail }
      : { state: 'legacy', sha: null, version: null, marker: null, detail };
  }
  const marker = match[0];
  const sha = match[1]!;
  const versionToken = match[2]!;
  const version = versionToken.toLowerCase() === 'unknown' ? null : versionToken;
  if (sha.toLowerCase() === 'unknown') {
    return { state: 'unknown', sha: null, version, marker, detail };
  }
  return { state: 'current', sha, version, marker, detail };
}

function sameGitObjectIdentity(left: string, right: string): boolean {
  if (left === right) return true;
  // Deployed envs may carry a full SHA while a dev checkout reports the short
  // form. A valid Git prefix is the same object identity, not build skew.
  const gitHex = /^[0-9a-f]{7,64}$/i;
  return gitHex.test(left) && gitHex.test(right) && (left.startsWith(right) || right.startsWith(left));
}

/**
 * Compare responder evidence with the tracing operator's loaded build.
 * Versions are deliberately diagnostic-only: equal package versions can still
 * contain different commits, and different SHAs do not establish chronology.
 */
export function compareResponderBuild(
  responder: ResponderBuildMarkerEvidence,
  tracingBuild: Pick<BuildInfo, 'sha' | 'version'>,
): ResponderBuildComparison {
  const tracingSha = tracingBuild.sha?.trim() || null;
  if (responder.state === 'legacy') {
    return {
      comparison: 'unknown',
      responderSha: null,
      tracingSha,
      detail: 'legacy responder receipt has no build marker, so build equality is unknown.',
    };
  }
  if (responder.state === 'unknown') {
    return {
      comparison: 'unknown',
      responderSha: null,
      tracingSha,
      detail: 'responder receipt has a missing, malformed, or identity-less build marker.',
    };
  }
  if (!tracingSha) {
    return {
      comparison: 'unknown',
      responderSha: responder.sha,
      tracingSha: null,
      detail: 'the tracing operator cannot prove its loaded Git SHA, so build equality is unknown.',
    };
  }
  if (sameGitObjectIdentity(responder.sha, tracingSha)) {
    return {
      comparison: 'same',
      responderSha: responder.sha,
      tracingSha,
      detail: 'responder and tracing operator identify the same loaded Git object.',
    };
  }
  return {
    comparison: 'skew',
    responderSha: responder.sha,
    tracingSha,
    detail:
      'responder and tracing operator report different loaded Git SHAs; this proves build skew only. ' +
      'Commit ancestry and chronology were not measured.',
  };
}

/**
 * X8 receipt taxonomy.
 *
 * ⚠ WIRE CONTRACT — this is not a local enum. `isP2pReceiptWireRow`
 * (sync/hyperbee/projections/p2p-receipts.ts) validates inbound rows against
 * this exact set and DROPS anything outside it, and mig 468/723 pins the same
 * list as a DB CHECK. So a peer that predates a new kind silently discards
 * those receipts. Widening it means: migration first, then this list, and
 * accept that older peers drop the new kind until they update.
 *
 * - `refusal`        — a refused/interrupted cross-peer action; REQUIRES the
 *                      structured refusal {code, detail} and bumps the M15
 *                      refused-op counters.
 * - `excused-breach` — preemption-class interruption (X8: host kill-switch
 *                      wind-down, revocation-lite downgrade); excluded from
 *                      reliability signals (P-203).
 * - `honored`        — the SUCCESS fact for a completed cross-peer action
 *                      (EI-19333624101736074). Carries NO refusal and must
 *                      NOT touch the refused-op counters.
 */
export const P2P_RECEIPT_KINDS = ['refusal', 'excused-breach', 'honored'] as const;
export type P2pReceiptKind = (typeof P2P_RECEIPT_KINDS)[number];

/**
 * Kinds that denote a FAILED/interrupted op, i.e. the ones the M15 refused-op
 * counters are evidence for. `honored` is deliberately absent: those counters
 * are the trust boundary's evidence that foreign work was refused (P-413), and
 * counting successes into them corrupts the one artifact D-001 relies on.
 */
const REFUSAL_CLASS_KINDS: ReadonlySet<string> = new Set<P2pReceiptKind>(['refusal', 'excused-breach']);

/** True when the kind denotes a failed/interrupted op rather than a success. */
export function isRefusalClassReceiptKind(kind: string): boolean {
  return REFUSAL_CLASS_KINDS.has(kind);
}

export interface P2pReceipt {
  workspaceId: string;
  potSlug: string;
  receiptId: string;
  kind: P2pReceiptKind;
  /** M21 thread key; null for pre-offer refusals (bare grant checks). */
  offerId: string | null;
  action: string;
  refusalCode: string | null;
  missingCapability: string | null;
  budgetAxis: string | null;
  detail: string;
  requesterKind: string | null;
  requesterRef: string | null;
  requesterGithubUserId: number | null;
  responderGithubUserId: number;
  responderDevicePubkey: string | null;
  receiptTs: number;
  origin: string;
}

interface ReceiptRow {
  workspace_id: string;
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
  requester_github_user_id: string | number | null;
  responder_github_user_id: string | number;
  responder_device_pubkey: string | null;
  receipt_ts: string | number;
  origin: string;
}

function rowToReceipt(r: ReceiptRow): P2pReceipt {
  return {
    workspaceId: r.workspace_id,
    potSlug: r.harness_slug,
    receiptId: r.receipt_id,
    kind: r.kind as P2pReceiptKind,
    offerId: r.offer_id,
    action: r.action,
    refusalCode: r.refusal_code,
    missingCapability: r.missing_capability,
    budgetAxis: r.budget_axis,
    detail: r.detail,
    requesterKind: r.requester_kind,
    requesterRef: r.requester_ref,
    requesterGithubUserId: r.requester_github_user_id == null ? null : Number(r.requester_github_user_id),
    responderGithubUserId: Number(r.responder_github_user_id),
    responderDevicePubkey: r.responder_device_pubkey,
    receiptTs: Number(r.receipt_ts),
    origin: r.origin,
  };
}

export interface EmitP2pReceiptArgs {
  /** The caller's RESOLVED identity workspace (C3). */
  workspaceId: string | null | undefined;
  potSlug: string;
  kind: P2pReceiptKind;
  /** M21: REQUIRED whenever the action belongs to an offer lifecycle. */
  offerId?: string | null;
  /** The refused/interrupted cross-peer action ('work-offer:claim', 'wake', 'spawn', 'wind-down', …). */
  action: string;
  /** The structured refusal (checkP2pCapability's shape) when kind='refusal'. */
  refusal?: { code: string; missing?: P2pCapability | string; detail: string } | null;
  /** Budget-axis refusals (P-107/P-201): 'remote' | 'local'. */
  budgetAxis?: string | null;
  /** Extra human detail; defaults to refusal.detail. */
  detail?: string;
  requester?: {
    kind?: P2pGranteeKind | string | null;
    ref?: string | null;
    githubUserId?: number | null;
  } | null;
  /** The enforcing side — the receipt author. */
  responderGithubUserId: number;
  responderDevicePubkey?: string | null;
  /** Audit actor label (session/owner id); defaults to 'p2p'. */
  actor?: string;
  /** Event time override (tests); defaults to Date.now(). */
  receiptTs?: number;
}

export type EmitP2pReceiptResult =
  | { ok: true; receipt: P2pReceipt }
  | { ok: false; refusal: { code: string; detail: string } };

/**
 * Emit one loud-refusal receipt: the federated receipt row + the local audit
 * row + the counter, in that order (the receipt row is the load-bearing one;
 * audit/counter are best-effort and never fail the emit). One log line, M21
 * offer-id threaded.
 */
export async function emitP2pReceipt(args: EmitP2pReceiptArgs, sqlOverride?: OrgSql): Promise<EmitP2pReceiptResult> {
  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) {
    return {
      ok: false,
      refusal: {
        code: 'workspace_unresolved',
        detail:
          "P2P receipt emit refused: unresolvable workspace partition (WI-1564) — a receipt captured under 'default' never federates, i.e. the requester never receives it.",
      },
    };
  }
  const hive = args.potSlug?.trim();
  if (!hive)
    return {
      ok: false,
      refusal: { code: 'hive_required', detail: 'receipts are hive-scoped; pass the hive HOME slug.' },
    };
  if (!Number.isInteger(args.responderGithubUserId) || args.responderGithubUserId <= 0) {
    return {
      ok: false,
      refusal: {
        code: 'invalid_responder',
        detail: 'responderGithubUserId must be a positive numeric GitHub user-id (X9).',
      },
    };
  }
  if (args.kind === 'refusal' && !args.refusal) {
    return {
      ok: false,
      refusal: {
        code: 'refusal_required',
        detail: "kind='refusal' requires the structured refusal {code, missing?, detail}.",
      },
    };
  }
  // The mirror of the check above: a SUCCESS receipt carrying a refusal code is
  // incoherent, and would surface in p2p:trace as a refusal on the very path
  // this kind exists to distinguish from one (EI-19333624101736074).
  if (!isRefusalClassReceiptKind(args.kind) && args.refusal) {
    return {
      ok: false,
      refusal: {
        code: 'refusal_on_success_receipt',
        detail: `kind='${args.kind}' is a success fact and must not carry a structured refusal — put the outcome in \`detail\`.`,
      },
    };
  }
  if (!isRefusalClassReceiptKind(args.kind) && !args.detail?.trim()) {
    return {
      ok: false,
      refusal: {
        code: 'detail_required',
        detail: `kind='${args.kind}' carries no refusal code, so \`detail\` is its ONLY payload — emitting it empty federates a content-free success.`,
      },
    };
  }

  const sql = sqlOverride ?? getOrgPg().sql;
  const receiptId = randomUUID();
  const ts = args.receiptTs ?? Date.now();
  const detail = args.detail ?? args.refusal?.detail ?? '';
  const offerId = args.offerId ?? null;

  const rows = (await sql`
    INSERT INTO harness_shared.p2p_receipts
      (workspace_id, harness_slug, receipt_id, kind, offer_id, action,
       refusal_code, missing_capability, budget_axis, detail,
       requester_kind, requester_ref, requester_github_user_id,
       responder_github_user_id, responder_device_pubkey, receipt_ts)
    VALUES
      (${ws}, ${hive}, ${receiptId}, ${args.kind}, ${offerId}, ${args.action},
       ${args.refusal?.code ?? null}, ${args.refusal?.missing ?? null},
       ${args.budgetAxis ?? null}, ${detail},
       ${args.requester?.kind ?? null}, ${args.requester?.ref ?? null},
       ${args.requester?.githubUserId ?? null},
       ${args.responderGithubUserId}, ${args.responderDevicePubkey ?? null}, ${ts})
    RETURNING *`) as unknown as ReceiptRow[];
  const receipt = rowToReceipt(rows[0]!);

  // (b) local audit row — best-effort, never fails the emit (M21: offer_id in details).
  try {
    await sql`
      INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
      VALUES (${randomUUID()}, ${ts}, ${args.actor ?? 'p2p'}, ${'p2p:receipt:' + args.kind},
              ${args.action + (offerId ? ` offer=${offerId}` : '')},
              ${JSON.stringify({
                receipt_id: receiptId,
                offer_id: offerId,
                hive,
                refusal_code: args.refusal?.code ?? null,
                missing: args.refusal?.missing ?? null,
                requester: args.requester ?? null,
              })}::text::jsonb, ${ws})`;
  } catch {
    /* audit is advisory; the receipt row is the durable record */
  }

  // (c) counter — best-effort.
  // ONLY refusal-class kinds bump it. These counters are the trust boundary's
  // evidence that foreign work was REFUSED (P-413/D-001); counting a success
  // into them would corrupt the one artifact that evidence rests on
  // (EI-19333624101736074).
  if (isRefusalClassReceiptKind(args.kind)) {
    try {
      await bumpRefusedOpCounter(
        { workspaceId: ws, potSlug: hive, reason: `${args.kind}:${args.refusal?.code ?? args.action}` },
        sql,
      );
    } catch {
      /* counter is advisory */
    }
  }

  // M21: ONE log line, offer-id threaded — both sides grep the same shape.
  // A success is logged at info: warn-level successes train the reader to
  // ignore the warn stream that the refusal receipts depend on.
  const line =
    `[p2p:receipt] ${args.kind} action=${args.action}${offerId ? ` offer=${offerId}` : ''} ` +
    `code=${args.refusal?.code ?? '-'} missing=${args.refusal?.missing ?? '-'} ` +
    `requester=${args.requester?.kind ?? '-'}:${args.requester?.ref ?? '-'} receipt=${receiptId}`;
  if (isRefusalClassReceiptKind(args.kind)) console.warn(line);
  else console.log(line);

  return { ok: true, receipt };
}

/**
 * M15: bump the LOCAL refused-op counter (the ONLY artifact for
 * UNAUTHENTICATED failure paths; also fed by emitP2pReceipt for receipted
 * ones). NEVER throws to the caller — every one of the ~5 call sites across
 * the codebase (federation identity-gate refusals, boot-time scoped-announce
 * refusals, the foreign-op guard, emitP2pReceipt) treats this as best-effort
 * and wraps the call in its own swallowing try/catch or `.catch(() => {})`,
 * on the correct theory that a bookkeeping failure must never block or
 * mask the actual refusal.
 *
 * P-413 (attestation + trust-closure re-verify): that swallow-everywhere
 * pattern previously meant a PG failure INSIDE this function (a bad
 * workspace/pot partition, a lock timeout, a schema drift) was a fully
 * SILENT no-op — the op was correctly refused, but the ONE artifact D-001
 * relies on as evidence the trust layer refused it (v1 ships foreign-work
 * spawn LIVE with no sandbox/containment — these counters ARE the safety
 * boundary's evidence) would quietly fail to increment with zero trace
 * anywhere. That is exactly the failure mode this counter exists to make
 * impossible for the OP itself (M15: "loud is not unbounded") — it must not
 * reappear one level down, in the counter's own write path. So: catch HERE,
 * log loudly (never throw), so a persistent counter-write failure is at
 * least diagnosable via logs even though it still never blocks a refusal.
 */
export async function bumpRefusedOpCounter(
  args: { workspaceId: string; potSlug: string; reason: string },
  sqlOverride?: OrgSql,
): Promise<void> {
  const sql = sqlOverride ?? getOrgPg().sql;
  try {
    await sql`
      INSERT INTO harness_shared.p2p_refused_op_counters (workspace_id, harness_slug, reason, count, updated_at)
      VALUES (${args.workspaceId}, ${args.potSlug}, ${args.reason}, 1, now())
      ON CONFLICT (workspace_id, harness_slug, reason)
      DO UPDATE SET count = harness_shared.p2p_refused_op_counters.count + 1, updated_at = now()`;
  } catch (err) {
    console.error(
      `[p2p:refused-op-counter] FAILED to bump counter (trust-layer evidence gap) ` +
        `workspace=${args.workspaceId} pot=${args.potSlug} reason=${args.reason}:`,
      err,
    );
  }
}

/** Read receipts for p2p:trace / the P-002 audit surface. */
export async function listP2pReceipts(
  args: {
    workspaceId: string | null | undefined;
    potSlug: string;
    /** M21: filter to one offer's timeline. */
    offerId?: string | null;
    limit?: number;
  },
  sqlOverride?: OrgSql,
): Promise<P2pReceipt[]> {
  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) return [];
  const sql = sqlOverride ?? getOrgPg().sql;
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const rows = (args.offerId
    ? await sql`
        SELECT * FROM harness_shared.p2p_receipts
         WHERE workspace_id = ${ws} AND harness_slug = ${args.potSlug} AND offer_id = ${args.offerId}
         ORDER BY receipt_ts ASC LIMIT ${limit}`
    : await sql`
        SELECT * FROM harness_shared.p2p_receipts
         WHERE workspace_id = ${ws} AND harness_slug = ${args.potSlug}
         ORDER BY receipt_ts DESC LIMIT ${limit}`) as unknown as ReceiptRow[];
  return rows.map(rowToReceipt);
}

/** Counter snapshot for p2p:trace / health surfaces. */
export async function listRefusedOpCounters(
  args: { workspaceId: string | null | undefined; potSlug: string },
  sqlOverride?: OrgSql,
): Promise<Array<{ reason: string; count: number }>> {
  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) return [];
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT reason, count FROM harness_shared.p2p_refused_op_counters
     WHERE workspace_id = ${ws} AND harness_slug = ${args.potSlug}
     ORDER BY count DESC`) as unknown as Array<{ reason: string; count: string | number }>;
  return rows.map((r) => ({ reason: r.reason, count: Number(r.count) }));
}
