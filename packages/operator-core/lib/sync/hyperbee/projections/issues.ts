/**
 * Hyperbee → PG projection for `harness_shared.harness_issues_consolidated`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * One row per (harness, issue_id). Hyperbee key per-harness:
 * `<issue_id>`. PG primary key: `(harness_slug, issue_id)`.
 *
 * `notes` is a JSONB array (issue history); pass-through opaque.
 * `linked_feature_id` is the F-FIX-* feature linking a fix back to
 * the originating issue (per project memory).
 */

import { getOrgPg } from '@papercusp/db-org';
import { normalizeJsonbInput } from './_jsonb-input';
import type postgres from 'postgres';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';
import type { TableProjection, ProvenanceContext } from '../projection';

export interface HarnessIssueRow {
  harness_slug: string;
  issue_id: string;
  title: string;
  severity: string;
  source: string;
  status: string;
  found_at: number;                     // epoch ms
  found_during: string | null;
  repro: string | null;
  evidence: string | null;
  suggested_fix: string | null;
  code_pointer: string | null;
  linked_feature_id: string | null;
  attempts: number;
  notes: unknown;                       // JSONB array
  created_ts: number;
  updated_ts: number;
}

export interface IssuesProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /**
   * Test/multi-peer seam — write to THIS postgres-js client instead of the
   * process-global `getOrgPg().sql`. See `HarnessFeaturesProjectionOpts.sql`:
   * the Stage-6 federation acceptance test injects a per-peer client so two
   * peers in one process project into two separate databases. Defaults to
   * `getOrgPg().sql`.
   */
  sql?: postgres.Sql;
  /** WI-259 P-002: hive-home slug when this harness is a hive MEMBER (cross-member content is
   *  membership-gated only when set); undefined for a non-hive / owned-home harness. */
  potHomeSlug?: string;
  /** WI-259 P-002: resolve an op's VERIFIED source-log device pubkey from its receiver-stamped
   *  sourceLogKeyHex (boot's admittedIdentities); threaded via RegisterAllOpts. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004: the content-before-membership defer buffer. When the membership guard would
   *  DROP a cross-member op ONLY because the author's hive_members row hasn't federated yet, the
   *  op is buffered here (keyed on the author device) + re-applied when that member joins — not
   *  lost. Undefined ⇒ today's drop (no buffer wired). Threaded via RegisterAllOpts. */
  pendingMemberContent?: PendingMembershipContent;
}

function composeKey(row: HarnessIssueRow): string {
  return row.issue_id;
}

function isString(v: unknown): v is string { return typeof v === 'string'; }
function isStringOrNull(v: unknown): v is string | null { return v === null || typeof v === 'string'; }
function isFiniteNumber(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }

export function isHarnessIssueRow(input: unknown): input is HarnessIssueRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    isString(r.harness_slug) && r.harness_slug.length > 0 &&
    isString(r.issue_id) && r.issue_id.length > 0 &&
    isString(r.title) && r.title.length > 0 &&
    isString(r.severity) &&
    isString(r.source) &&
    isString(r.status) &&
    isFiniteNumber(r.found_at) &&
    isStringOrNull(r.found_during) &&
    isStringOrNull(r.repro) &&
    isStringOrNull(r.evidence) &&
    isStringOrNull(r.suggested_fix) &&
    isStringOrNull(r.code_pointer) &&
    isStringOrNull(r.linked_feature_id) &&
    isFiniteNumber(r.attempts) &&
    isFiniteNumber(r.created_ts) &&
    isFiniteNumber(r.updated_ts)
    // notes is JSONB opaque — accept anything
  );
}

function decodeValue(raw: unknown): HarnessIssueRow | null {
  return isHarnessIssueRow(raw) ? raw : null;
}

async function writeToPg(
  opts: IssuesProjectionOpts,
  row: HarnessIssueRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // WI-259 P-002: membership-aware guard — apply own-slug, or a cross-member op iff its VERIFIED
  // source-log device pubkey ∈ the hive's CURRENT members. resolveAuthorDevice maps the immutable
  // sourceLogKeyHex (carried as provenance.authorPubkey for a remote op) → the admit-verified
  // device; re-checked at apply so a removed member immediately loses write access.
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    // WI-259 P-004: a cross-member op the guard drops ONLY because the author's hive_members row
    // hasn't federated to this peer yet (decision 'defer', author device known) is BUFFERED + re-
    // applied when that member joins (the onMemberApplied drain), instead of lost to the advancing
    // merge cursor. A genuine non-member's op also defers, but the buffer's TTL evicts it (D-007).
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'issues',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    if (memberDecision === 'drop' && !sourceLogDevice && provenance?.authorPubkey && opts.pendingMemberContent) {
      opts.pendingMemberContent.deferUnresolvedSourceLog(
        {
          sourceLogKey: provenance.authorPubkey,
          tableTag: 'issues',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    return;
  }
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  // WI-1612 (same class as WI-1572): ALWAYS write workspace_id explicitly from
  // opts.workspaceId (bound at projection-registration time — already the correct
  // owning workspace for this harness) — never leave it NULL for the
  // fill_ws_issues_trg BEFORE-INSERT trigger to fill. That trigger's fallback
  // (fill_workspace_id_from_projects) consults ONLY the sparse harness_shared.projects
  // table and then defaults to the literal 'default', with NO fallback to the
  // authoritative harness_shared.harness_registry — so a harness registered only in
  // the registry (e.g. papercusp itself) had federated issue ops silently stranded at
  // workspace_id='default'. Mirrors the already-correct pattern in
  // sync/hyperbee/projections/engineer-issues.ts and harness-features.ts.
  await sql`
    INSERT INTO harness_shared.harness_issues_consolidated
      (workspace_id, harness_slug, issue_id, title, severity, source, status,
       found_at, found_during, repro, evidence, suggested_fix,
       code_pointer, linked_feature_id, attempts, notes,
       created_ts, updated_ts, author_pubkey, origin, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.issue_id}, ${row.title}, ${row.severity}, ${row.source}, ${row.status},
       to_timestamp(${row.found_at} / 1000.0),
       ${row.found_during}, ${row.repro}, ${row.evidence}, ${row.suggested_fix},
       ${row.code_pointer}, ${row.linked_feature_id}, ${row.attempts},
       -- jsonb: bind via JSON.stringify(x)::jsonb — sql.json THROWS under the getOrgPg runtime
       -- client (agent-insights/postgres-js-jsonb-binding).
       ${JSON.stringify(normalizeJsonbInput(row.notes) ?? [])}::text::jsonb,
       ${row.created_ts}, ${row.updated_ts}, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc})
    ON CONFLICT (harness_slug, issue_id) DO UPDATE SET
      title = EXCLUDED.title,
      severity = EXCLUDED.severity,
      source = EXCLUDED.source,
      status = EXCLUDED.status,
      found_at = EXCLUDED.found_at,
      found_during = EXCLUDED.found_during,
      repro = EXCLUDED.repro,
      evidence = EXCLUDED.evidence,
      suggested_fix = EXCLUDED.suggested_fix,
      code_pointer = EXCLUDED.code_pointer,
      linked_feature_id = EXCLUDED.linked_feature_id,
      attempts = EXCLUDED.attempts,
      notes = EXCLUDED.notes,
      updated_ts = EXCLUDED.updated_ts,
      author_pubkey = EXCLUDED.author_pubkey,
      origin = EXCLUDED.origin,
      fed_ts = EXCLUDED.fed_ts,
      fed_hlc = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(harness_issues_consolidated.fed_hlc, harness_issues_consolidated.fed_ts)
  `;
}

async function deleteFromPg(
  opts: IssuesProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.harness_issues_consolidated
    WHERE harness_slug = ${opts.harnessSlug}
      AND issue_id = ${key}
      -- guard the delete by the SAME fed_order_key() order as the put guard (EI-1698).
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildIssuesProjection(opts: IssuesProjectionOpts): TableProjection<HarnessIssueRow> {
  return {
    tableTag: 'issues',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHarnessIssueRow,
};
