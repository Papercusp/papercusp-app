/**
 * Hyperbee → PG projection for `harness_shared.harness_features_consolidated`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * The shared feature row — the most-consumed Hyperbee table since
 * the feature queue, status badges, claim flow, and PR daemon all
 * read from it. The Hyperbee key inside one harness's Hyperbee is
 * `<feature_id>` (the harness is implicit per-Hyperbee).
 *
 * The PG table is shared (`harness_features_consolidated`), keyed on
 * `(harness_slug, feature_id)`. `harness_slug` is bound at projection
 * registration time (per-harness wiring) so the consumer doesn't
 * need to thread it through every op.
 */

import { getOrgPg } from '@papercusp/db-org';
import { readVerifiedAuthorGithubId } from '../../../work-items-admission';
import { normalizeJsonbInput } from './_jsonb-input';
import type postgres from 'postgres';
import {
  projectionSql,
  projectionStatementFailed,
  type TableProjection,
  type ProvenanceContext,
} from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';

/**
 * Wire-shape of a feature row in Hyperbee. Mirrors the PG columns
 * 1:1 with `number` / `null` for timestamps (epoch ms). Defensive
 * on every field — remote ops with malformed shapes are dropped
 * rather than crashing the projection loop.
 */
export interface HarnessFeatureRow {
  harness_slug: string;
  feature_id: string;
  title: string | null;
  summary: string | null;
  status: string | null;
  attempts: number | null;
  claims: string | null;
  notes: string | null;
  metadata: unknown;                   // JSONB blob — opaque to projection
  kind: string | null;
  project_id: string | null;
  expected_cost_cents: number | null;
  tags: unknown;                       // JSONB
  needs_human_review: boolean | null;
  ts: number | null;                   // epoch ms
  created_ts: number | null;
  updated_ts: number | null;
  parent_id: string | null;
  goal_id: string | null;
  taken_by: string | null;
  taken_at: number | null;             // epoch ms → TIMESTAMPTZ via to_timestamp
  // mig 357 — item-scoped progress signal; epoch ms → TIMESTAMPTZ. OPTIONAL on the wire
  // (pre-357 log history omits it → writeToPg maps absent → NULL).
  last_progress_at?: number | null;
  expires_at: number | null;
  /**
   * Work-item DISPATCH columns (unify-work-items D-013 + dispatch-scaling):
   * kind discriminator, wave order, swarm pinning, redundancy opt-in, and the
   * kind-specific payload. Without these a Queen reorder / redundancy
   * declaration never federates — remote swarms never see steering (found by
   * su-ae509 2026-06-10, blocks shared-hive-loop P-001). OPTIONAL on the wire:
   * ops appended before this change lack them, and replaying that history must
   * keep decoding (the guard accepts undefined; writeToPg maps absent → NULL,
   * item_kind → its PG default).
   */
  item_kind?: string | null;
  feature_order?: number | null;
  swarm_affinity?: string | null;
  redundancy?: number | null;
  payload?: unknown;                   // JSONB blob — opaque to projection
  /**
   * WI-251 (findings-B B-002): content/lineage columns now FEDERATED — were
   * dropped by the mapper so a feature federated A→B landed with them NULL.
   * verifier_*, audit_*, worked_by_history, current_wave stay LOCAL (each peer
   * re-audits / local cursors). OPTIONAL on the wire (back-compat: ops before
   * this change lack them → writeToPg maps absent → the PG default/NULL; the
   * NOT-NULL cols see_also/needs_design/discarded_design_work default []/false).
   */
  design_spec_id?: string | null;
  design_status?: string | null;
  needs_design?: boolean | null;
  discarded_design_work?: boolean | null;
  source_plan_slug?: string | null;
  source_plan_item_ids?: string[] | null;   // text[]
  see_also?: string[] | null;               // text[] NOT NULL DEFAULT '{}'
  wave?: string | null;
  deprecation_reason?: string | null;
  completion_ref?: unknown;            // JSONB blob — opaque to projection
  /**
   * work-item-completion-integrity-2026-07-01 (WI-1403 / EI-5269): the "who did
   * it + what proves it" pair recorded at the terminal-state choke point. OPTIONAL
   * on the wire (pre-432 history lacks them → writeToPg maps absent → NULL).
   */
  terminal_owner?: string | null;
  terminal_completion_ref?: string | null;
  /**
   * work-item-status-full-unify-2026-07-19 (P-009, owner hard-req D-001): the
   * pre-collapse terminal nuance (passed/resolved → done, deprecated/closed →
   * dropped) preserved on the work_items base table (mig 638). MUST federate so a
   * terminal item keeps its resolution kind across the wire — else the passed-vs-
   * plain-done nuance is lost on every peer. OPTIONAL on the wire (pre-638 history
   * lacks it → writeToPg maps absent → NULL).
   */
  terminal_reason?: string | null;
  /**
   * mig 708 / EI-18785839681430807: the AUTHORITY axis (mig 677,
   * agent-protocol-authority-semantics-2026-07-26 P-003; D-035). Same
   * completion-integrity treatment as the terminal_* pair above — federated as
   * a plain column and joined into the EI-16756 digest below. OPTIONAL on the
   * wire (pre-708 history lacks it → writeToPg maps absent → NULL).
   */
  authority?: string | null;
  /**
   * mig 708 PART 2 / EI-18820653360383242: the trigger-maintained close time
   * (mig 698, `stamp_work_item_closed_ts`) — epoch ms of when the item entered
   * its CURRENT terminal status. The trigger's own COALESCE logic requires
   * this to federate (a federated write with no closed_ts stamps the
   * RECEIVING peer's local now() as the close time). A plain carried column,
   * NOT part of the EI-16756 digest below (its correctness is already
   * enforced by the trigger's own terminal->terminal freeze). OPTIONAL on the
   * wire (pre-708 history lacks it → writeToPg maps absent → NULL, and the
   * trigger's INSERT branch honours that as "unknown", matching mig 698's own
   * pre-698 legacy-row semantics).
   */
  closed_ts?: number | null;
  /**
   * WI-41745 — the born-pending admission trio (mig 944), exposed on this view by
   * mig 966. `admission` is the claim gate itself (`admittedWhereSql` =
   * `(admission IS DISTINCT FROM 'pending')`), so a dropped column arrives NULL and
   * reads as ADMITTED on the peer. OPTIONAL on the wire for the usual all-or-nothing
   * decodeValue reason: an op from a peer on older code carries none of them, and
   * rejecting such a row would discard the WHOLE feature op.
   */
  admission?: string | null;
  admitted_at?: string | null;
  admitted_by?: string | null;
}

function isString(v: unknown): v is string { return typeof v === 'string'; }
function isStringOrNull(v: unknown): v is string | null { return v === null || typeof v === 'string'; }
function isNumberOrNull(v: unknown): v is number | null { return v === null || (typeof v === 'number' && Number.isFinite(v)); }
function isBoolOrNull(v: unknown): v is boolean | null { return v === null || typeof v === 'boolean'; }

/**
 * Restore the fleet-wide "unassigned ⟺ `taken_by IS NULL OR taken_by = ''`"
 * invariant at the federation ingest boundary (EI-7939). Every claim/survey/
 * frontier floor treats an item as unassigned ONLY when `taken_by IS NULL OR
 * taken_by = ''` (work-items.ts `claimFloorsWhereSql`, survey.ts,
 * wake-frontier-guard.ts). A projected/federated op that carries a non-null,
 * non-empty placeholder — whitespace-only, or the literal string `'unassigned'`
 * (a legacy/foreign "not taken" marker) — VIOLATES that invariant: the item is
 * neither claimable (the claim floor treats it as taken → STARVED) nor a real
 * dead-holder orphan, yet the P-013 orphan sweep (fleet-monitors.ts
 * `sweepOrphanedTakenBy`) then returns it to the backlog and files an
 * `orphaned-taken-by` incident (the false "dead holder, no live lease" signal
 * that surfaced as EI-7939 for WI-3130). Collapse those placeholders to NULL on
 * ingest so the invariant holds and neither the starvation nor the noise recurs.
 * A REAL holder id (an agent owner/sid) is returned unchanged.
 */
export function normalizeTakenBy(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'unassigned') return null;
  return value;
}

export function isHarnessFeatureRow(input: unknown): input is HarnessFeatureRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.feature_id) || r.feature_id.length === 0) return false;
  if (!isStringOrNull(r.title)) return false;
  if (!isStringOrNull(r.summary)) return false;
  if (!isStringOrNull(r.status)) return false;
  if (!isNumberOrNull(r.attempts)) return false;
  if (!isStringOrNull(r.claims)) return false;
  if (!isStringOrNull(r.notes)) return false;
  if (!isStringOrNull(r.kind)) return false;
  if (!isStringOrNull(r.project_id)) return false;
  if (!isNumberOrNull(r.expected_cost_cents)) return false;
  if (!isBoolOrNull(r.needs_human_review)) return false;
  if (!isNumberOrNull(r.ts)) return false;
  if (!isNumberOrNull(r.created_ts)) return false;
  if (!isNumberOrNull(r.updated_ts)) return false;
  if (!isStringOrNull(r.parent_id)) return false;
  if (!isStringOrNull(r.goal_id)) return false;
  if (!isStringOrNull(r.taken_by)) return false;
  if (!isNumberOrNull(r.taken_at)) return false;
  if (r.last_progress_at !== undefined && !isNumberOrNull(r.last_progress_at)) return false; // mig 357 — optional on the wire
  if (!isNumberOrNull(r.expires_at)) return false;
  // Dispatch columns are OPTIONAL on the wire (absent in pre-2026-06-10 log
  // history) — tolerate undefined, validate when present.
  if (r.item_kind !== undefined && !isStringOrNull(r.item_kind)) return false;
  if (r.feature_order !== undefined && !isNumberOrNull(r.feature_order)) return false;
  if (r.swarm_affinity !== undefined && !isStringOrNull(r.swarm_affinity)) return false;
  if (r.redundancy !== undefined && !isNumberOrNull(r.redundancy)) return false;
  if (r.terminal_owner !== undefined && !isStringOrNull(r.terminal_owner)) return false;
  if (r.terminal_completion_ref !== undefined && !isStringOrNull(r.terminal_completion_ref)) return false;
  if (r.terminal_reason !== undefined && !isStringOrNull(r.terminal_reason)) return false; // P-009/D-001 — optional on the wire
  if (r.authority !== undefined && !isStringOrNull(r.authority)) return false; // mig 708/D-035 — optional on the wire
  if (r.closed_ts !== undefined && !isNumberOrNull(r.closed_ts)) return false; // mig 708 PART 2 — optional on the wire
  // WI-41745 (mig 944/966) — all three optional on the wire; see the interface note.
  if (r.admission !== undefined && !isStringOrNull(r.admission)) return false;
  if (r.admitted_at !== undefined && !isStringOrNull(r.admitted_at)) return false;
  if (r.admitted_by !== undefined && !isStringOrNull(r.admitted_by)) return false;
  // metadata + tags + payload are JSONB blobs; accept anything (incl. null/missing).
  return true;
}

export interface HarnessFeaturesProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /**
   * Test/multi-peer seam — write to THIS postgres-js client instead of the
   * process-global `getOrgPg().sql`. Production leaves this undefined (the
   * single embedded-pg / native-pg connection). The Stage-6 federation
   * acceptance test injects a per-peer client so two peers in ONE process
   * project into two SEPARATE databases — without it, both peers would write
   * to the same global connection and the "did the row land in B?" assertion
   * would be vacuous. Defaults to `getOrgPg().sql`.
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

function composeKey(row: HarnessFeatureRow): string {
  // Per-harness Hyperbee → key is just feature_id.
  return row.feature_id;
}

function decodeValue(raw: unknown): HarnessFeatureRow | null {
  return isHarnessFeatureRow(raw) ? raw : null;
}

async function writeToPg(
  opts: HarnessFeaturesProjectionOpts,
  row: HarnessFeatureRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // WI-259 P-002 membership guard (see member-content-guard.ts): own-slug applies; a cross-member
  // op applies iff its VERIFIED source-log device ∈ the hive's CURRENT members. resolveAuthorDevice
  // maps the immutable sourceLogKeyHex (provenance.authorPubkey for a remote op) → the admit-verified device.
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
          tableTag: 'features-by-id',
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
          tableTag: 'features-by-id',
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
  // P-537: both statements below run on the merge's batch transaction when there is one.
  const sql = await projectionSql(opts.sql ?? getOrgPg().sql);
  // EI-7939: collapse an empty-ish / `'unassigned'` placeholder taken_by to NULL
  // at ingest so the "unassigned ⟺ NULL/''" invariant every claim floor relies on
  // holds (EXCLUDED.taken_by below — and thus the ON CONFLICT UPDATE + the LWW
  // content digest — inherit the normalized value).
  const takenBy = normalizeTakenBy(row.taken_by);
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  // D-001: the op's HLC ordering key — the SAME causal key the merge fold orders
  // by. Stored as `fed_hlc` and compared by the LWW guard below via fed_order_key()
  // (EI-1698: a single derived-HLC order space, so a no-HLC op — pre-P-010 / pre-314
  // history — still compares transitively against HLC-bearing ops).
  const fedHlc = provenance?.fedHlc ?? null;
  // P-008 (shared-hive-trust-admission): stamp the VERIFIED author identity on
  // REMOTE rows only — resolve author_pubkey → github_user_id via a verified,
  // non-revoked hive_members device attestation (NEVER a self-claimed id). NULL
  // when unverified/revoked/local, so the trust gate (autoPickableWhereSql /
  // isAutoPickable) conservatively refuses the fast-path. This is the PRODUCER
  // for the column the gate consumes (the consumer was landed in P-010).
  let verifiedAuthorGithubUserId: number | null = null;
  if (origin === 'remote' && authorPubkey) {
    try {
      verifiedAuthorGithubUserId = await readVerifiedAuthorGithubId(sql, { workspaceId: opts.workspaceId, authorPubkey });
    } catch {
      // Fail-safe as before (an unreadable pot_members stamps NULL, so the trust gate
      // refuses). Inside the batch the error aborted the transaction; the read was this
      // write's only statement, so rolling back to the op's savepoint loses nothing.
      await projectionStatementFailed();
    }
  }
  // WI-1612 (same class as WI-1572): ALWAYS write workspace_id explicitly from
  // opts.workspaceId (bound at projection-registration time, so it is already the
  // correct owning workspace for this harness) — never leave it NULL for the
  // fill_ws_features_trg BEFORE-INSERT trigger to fill. That trigger's fallback
  // function (fill_workspace_id_from_projects) consults ONLY the sparse
  // harness_shared.projects table and then defaults to the literal 'default',
  // with NO fallback to the authoritative harness_shared.harness_registry — so a
  // harness registered only in the registry (e.g. papercusp itself) had every
  // FEDERATED (remote-origin) feature op silently stranded at workspace_id='default'
  // (confirmed live: 179 work_items feature-family rows). engineer-issues.ts already
  // does this correctly for issue-family ops; this mirrors that pattern.
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, attempts, claims, notes,
       metadata, kind, project_id, expected_cost_cents, tags, needs_human_review,
       ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, last_progress_at, expires_at,
       item_kind, feature_order, swarm_affinity, redundancy, payload,
       design_spec_id, design_status, needs_design, discarded_design_work,
       source_plan_slug, source_plan_item_ids, see_also, wave, deprecation_reason, completion_ref,
       terminal_owner, terminal_completion_ref, terminal_reason, authority, closed_ts,
       admission, admitted_at, admitted_by,
       author_pubkey, origin, fed_ts, fed_hlc, verified_author_github_user_id)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.feature_id}, ${row.title}, ${row.summary}, ${row.status}, ${row.attempts}, ${row.claims}, ${row.notes},
       -- jsonb: bind via JSON.stringify(x)::jsonb — sql.json THROWS under getOrgPg (agent-insights/postgres-js-jsonb-binding)
       ${row.metadata == null ? null : JSON.stringify(normalizeJsonbInput(row.metadata))}::text::jsonb,
       ${row.kind}, ${row.project_id}, ${row.expected_cost_cents},
       ${row.tags == null ? null : JSON.stringify(normalizeJsonbInput(row.tags))}::text::jsonb,
       ${row.needs_human_review},
       ${row.ts}, ${row.created_ts}, ${row.updated_ts}, ${row.parent_id}, ${row.goal_id}, ${takenBy},
       ${row.taken_at == null ? null : sql`to_timestamp(${row.taken_at} / 1000.0)`},
       ${row.last_progress_at == null ? null : sql`to_timestamp(${row.last_progress_at} / 1000.0)`},
       ${row.expires_at == null ? null : sql`to_timestamp(${row.expires_at} / 1000.0)`},
       -- Dispatch columns: item_kind is NOT NULL DEFAULT 'feature' in PG, so an
       -- op that doesn't carry it (pre-2026-06-10 history) inserts the default.
       ${row.item_kind ?? 'feature'}, ${row.feature_order ?? null}, ${row.swarm_affinity ?? null}, ${row.redundancy ?? null},
       ${row.payload == null ? null : JSON.stringify(normalizeJsonbInput(row.payload))}::text::jsonb,
       -- WI-251 (findings-B B-002): federated content/lineage columns. text[] +
       -- jsonb bound explicitly; the NOT-NULL PG cols default ([]/false) when an
       -- older op (no these fields) is replayed.
       ${row.design_spec_id ?? null}, ${row.design_status ?? null},
       ${row.needs_design ?? false}, ${row.discarded_design_work ?? false},
       ${row.source_plan_slug ?? null}, ${row.source_plan_item_ids ?? null}::text[],
       ${row.see_also ?? []}::text[], ${row.wave ?? null}, ${row.deprecation_reason ?? null},
       ${row.completion_ref == null ? null : JSON.stringify(normalizeJsonbInput(row.completion_ref))}::text::jsonb,
       ${row.terminal_owner ?? null}, ${row.terminal_completion_ref ?? null}, ${row.terminal_reason ?? null},
       ${row.authority ?? null}, ${row.closed_ts ?? null},
       -- WI-41745: the born-pending admission trio (mig 944, exposed here by mig 966).
       ${row.admission ?? null}, ${row.admitted_at ?? null}, ${row.admitted_by ?? null},
       ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc}, ${verifiedAuthorGithubUserId})
    ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      status = EXCLUDED.status,
      attempts = EXCLUDED.attempts,
      claims = EXCLUDED.claims,
      notes = EXCLUDED.notes,
      metadata = EXCLUDED.metadata,
      kind = EXCLUDED.kind,
      project_id = EXCLUDED.project_id,
      expected_cost_cents = EXCLUDED.expected_cost_cents,
      tags = EXCLUDED.tags,
      needs_human_review = EXCLUDED.needs_human_review,
      ts = EXCLUDED.ts,
      created_ts = EXCLUDED.created_ts,
      updated_ts = EXCLUDED.updated_ts,
      parent_id = EXCLUDED.parent_id,
      goal_id = EXCLUDED.goal_id,
      taken_by = EXCLUDED.taken_by,
      taken_at = EXCLUDED.taken_at,
      last_progress_at = EXCLUDED.last_progress_at,
      expires_at = EXCLUDED.expires_at,
      -- item_kind is the immutable discriminator: never let an op that doesn't
      -- carry it (defaulted to 'feature' above) flip a research-task/chunk back.
      item_kind = CASE WHEN work_items.item_kind <> 'feature'
                       THEN work_items.item_kind
                       ELSE EXCLUDED.item_kind END,
      feature_order = EXCLUDED.feature_order,
      swarm_affinity = EXCLUDED.swarm_affinity,
      redundancy = EXCLUDED.redundancy,
      payload = EXCLUDED.payload,
      -- WI-251 (findings-B B-002): federated content/lineage columns. Safe to
      -- overwrite from EXCLUDED — the fed_hlc/fed_ts WHERE guard below gates the
      -- whole UPDATE on the op being newer, so an older op (which lacks these
      -- fields → maps to defaults) can never win the guard and clobber them.
      design_spec_id = EXCLUDED.design_spec_id,
      design_status = EXCLUDED.design_status,
      needs_design = EXCLUDED.needs_design,
      discarded_design_work = EXCLUDED.discarded_design_work,
      source_plan_slug = EXCLUDED.source_plan_slug,
      source_plan_item_ids = EXCLUDED.source_plan_item_ids,
      see_also = EXCLUDED.see_also,
      wave = EXCLUDED.wave,
      deprecation_reason = EXCLUDED.deprecation_reason,
      completion_ref = EXCLUDED.completion_ref,
      terminal_owner = EXCLUDED.terminal_owner,
      terminal_completion_ref = EXCLUDED.terminal_completion_ref,
      -- P-009/D-001: the terminal nuance must converge like status itself.
      terminal_reason = EXCLUDED.terminal_reason,
      -- mig 708/D-035: same rationale as terminal_reason — the authority axis
      -- must converge like status itself.
      authority = EXCLUDED.authority,
      -- mig 708 PART 2: honour a federated close time; the BEFORE trigger's own
      -- COALESCE/freeze logic (mig 698) then decides whether it actually wins.
      closed_ts = EXCLUDED.closed_ts,
      -- WI-41745: identical monotonic floor to the one the issue family got in
      -- EI-21467654382027859, and for the same two reasons. (1) EXCLUDED NULL means the
      -- op predates the change, and taking NULL would read as ADMITTED at the claim gate
      -- and un-hide a born-pending item. (2) An explicit 'pending' arriving over a
      -- locally PROMOTED row is a peer that has not seen the promotion — and the LWW
      -- guard below does not cover it, because a LOCAL promotion does not restamp
      -- fed_ts/fed_hlc, so the remote op legitimately outranks it in fed_order_key space.
      -- Promotion is one-way (pending -> admitted/auto/unreviewed); nothing demotes.
      -- admitted_at/admitted_by follow the SAME branch so the trio cannot disagree.
      admission = CASE
        WHEN EXCLUDED.admission IS NULL THEN work_items.admission
        WHEN EXCLUDED.admission = 'pending'
             AND work_items.admission IS NOT NULL
             AND work_items.admission IS DISTINCT FROM 'pending' THEN work_items.admission
        ELSE EXCLUDED.admission
      END,
      admitted_at = CASE
        WHEN EXCLUDED.admission IS NULL THEN work_items.admitted_at
        WHEN EXCLUDED.admission = 'pending'
             AND work_items.admission IS NOT NULL
             AND work_items.admission IS DISTINCT FROM 'pending' THEN work_items.admitted_at
        ELSE EXCLUDED.admitted_at
      END,
      admitted_by = CASE
        WHEN EXCLUDED.admission IS NULL THEN work_items.admitted_by
        WHEN EXCLUDED.admission = 'pending'
             AND work_items.admission IS NOT NULL
             AND work_items.admission IS DISTINCT FROM 'pending' THEN work_items.admitted_by
        ELSE EXCLUDED.admitted_by
      END,
      author_pubkey = EXCLUDED.author_pubkey,
      origin = EXCLUDED.origin,
      fed_ts = EXCLUDED.fed_ts,
      fed_hlc = EXCLUDED.fed_hlc,
      verified_author_github_user_id = EXCLUDED.verified_author_github_user_id
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    -- WI-2923 (mig 504): at an EQUAL order key the WRITER tie-break decides —
    -- the bare ">=" applied unconditionally on ties, so two cells that each
    -- completed the same item in the same clock tick SWAPPED values on heal
    -- (each applied the other's write, echo suppression froze the swap, and
    -- convergence reported a fixed point over divergent replicas —
    -- composition-chaos P-002). fed_apply_wins breaks the tie by writer-pair
    -- when both are known, else by the SYMMETRIC content digest (local rows are
    -- author_pubkey-NULL by design, mig 214), so every replica settles on the
    -- same value in one exchange. The digest covers CONTENT columns only.
    --
    -- EI-16756: terminal_owner/terminal_completion_ref MUST be in this digest —
    -- see the identical fix + rationale in projections/engineer-issues.ts's
    -- sibling writeToPg (both feature- and issue-family rows carry this
    -- completion-integrity pair and share the same fed_apply_wins tie-break).
    -- P-009/D-001 (work-item-status-full-unify): terminal_reason joins the digest
    -- for the SAME reason — two different completions of one item can converge to
    -- an IDENTICAL status/taken_by (e.g. both 'done') while carrying DIFFERENT
    -- terminal_reason (passed vs plain-done, resolved vs plain-done). Omitting it
    -- would make the tie branch's "equal digest ⇒ identical content ⇒ no-op"
    -- invariant FALSE for those ops, so a racing peer could silently overwrite the
    -- correct terminal nuance while every other field looked converged.
    --
    -- mig 708 / EI-18785839681430807 (D-035): authority joins the digest for the
    -- SAME reason — two racing completions can converge to an identical
    -- status/taken_by/terminal_owner while carrying a DIFFERENT authority (an
    -- evidence-backed 'committed' vs a racing under-evidenced 'proposed').
    WHERE harness_shared.fed_apply_wins(
            EXCLUDED.fed_hlc, EXCLUDED.fed_ts, EXCLUDED.author_pubkey,
            md5(concat_ws('|', EXCLUDED.item_kind, EXCLUDED.title, EXCLUDED.summary,
                          EXCLUDED.status, EXCLUDED.taken_by, EXCLUDED.payload::text,
                          EXCLUDED.terminal_owner, EXCLUDED.terminal_completion_ref,
                          EXCLUDED.terminal_reason, EXCLUDED.authority)),
            work_items.fed_hlc, work_items.fed_ts, work_items.author_pubkey,
            md5(concat_ws('|', work_items.item_kind, work_items.title, work_items.summary,
                          work_items.status, work_items.taken_by, work_items.payload::text,
                          work_items.terminal_owner, work_items.terminal_completion_ref,
                          work_items.terminal_reason, work_items.authority)))
  `;
}

async function deleteFromPg(
  opts: HarnessFeaturesProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = await projectionSql(opts.sql ?? getOrgPg().sql);
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.harness_features_consolidated
    WHERE harness_slug = ${opts.harnessSlug}
      AND feature_id = ${key}
      -- EI-79 step 2 + D-001: guard the delete by the SAME fed_order_key() order as
      -- the put guard (EI-1698). A stale del (lower key) must not erase a row a newer
      -- put recreated; on a key tie del beats put (>=).
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
  // workspaceId is captured for future per-workspace partitioning of the
  // consolidated view; the table is currently shared across the workspace.
  void opts.workspaceId;
}

export function buildHarnessFeaturesProjection(
  opts: HarnessFeaturesProjectionOpts,
): TableProjection<HarnessFeatureRow> {
  return {
    tableTag: 'features-by-id',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    // P-537 (D-034 #2): every statement goes through projectionSql, the one caught read
    // calls projectionStatementFailed, and no transaction-local state is set, so ops fold
    // inside the batch transaction.
    batchable: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
    // P-528: the capture routes a feature row to the log of its own (canonical) harness and
    // ships the whole row, so within one log every put under a feature_id writes that
    // harness's row, and the only refusal (the member guard) depends on the source log.
    supersedableKey: () => true,
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHarnessFeatureRow,
};
