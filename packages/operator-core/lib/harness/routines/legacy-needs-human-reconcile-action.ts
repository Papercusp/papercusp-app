/**
 * `system:legacy-needs-human-reconcile` — P-004 of
 * autonomous-inbox-resolution-2026-08-31.
 *
 * `payload.needsHuman` is a retired, ambiguous attention dialect. Migration 1020
 * removed the measured cross-harness residue, but a migration is a one-time event:
 * a replayed old row or a federated writer can reintroduce the key later. This
 * bounded sweep compares that legacy marker with the row's CURRENT lifecycle and
 * typed blocker state, then removes only markers that no live human gate supports.
 *
 * The mutation is deliberately payload-only. It never changes status, ownership,
 * progress, or any sibling payload key. Typed gates fail closed: status
 * `needs-human`, `needsOwnerAction`, `humanCapability`, and active or malformed
 * external-blocker structures are all preserved for their owning lifecycle path.
 */
import { getOrgPg } from '@papercusp/db-org';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import type { OrgSql } from '../../work-items';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const LEGACY_NEEDS_HUMAN_RECONCILE = 'legacy-needs-human-reconcile';
export const DEFAULT_LEGACY_NEEDS_HUMAN_RECONCILE_CAP = 100;
export const MAX_LEGACY_NEEDS_HUMAN_RECONCILE_CAP = 500;

const ISSUE_FAMILY_KINDS = new Set(['bug', 'change', 'task']);
const TERMINAL_STATES = new Set(ANY_FAMILY_TERMINAL_STATES);

export interface LegacyNeedsHumanCandidate {
  workspaceId: string;
  harnessSlug: string | null;
  id: string;
  status: string | null;
  itemKind: string | null;
  takenBy: string | null;
  payload: unknown;
}

export type LegacyNeedsHumanKeepReason =
  | 'not-legacy-needs-human'
  | 'not-issue-family'
  | 'terminal-history'
  | 'observation-lane'
  | 'needs-human-status'
  | 'typed-owner-action'
  | 'human-capability'
  | 'active-external-blocker'
  | 'malformed-external-blockers';

export type LegacyNeedsHumanDecision =
  | { action: 'clear'; reason: 'no-live-human-gate' }
  | { action: 'keep'; reason: LegacyNeedsHumanKeepReason };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isLegacyTrue(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true');
}

function blockerDisposition(payload: Record<string, unknown>): 'none' | 'active' | 'malformed' {
  if (!Object.hasOwn(payload, 'externalBlockers') || payload.externalBlockers === null) return 'none';
  if (!Array.isArray(payload.externalBlockers)) return 'malformed';
  for (const value of payload.externalBlockers) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'malformed';
    const blocker = value as Record<string, unknown>;
    if (typeof blocker.status !== 'string') return 'malformed';
    if (blocker.status.trim().toLowerCase() === 'active') return 'active';
  }
  return 'none';
}

/**
 * Pure, total decision over one live row. Every keep branch is intentionally
 * conservative: this sweep removes a stale presentation marker; it is never the
 * authority that resolves a real blocker.
 */
export function decideLegacyNeedsHumanReconcile(candidate: LegacyNeedsHumanCandidate): LegacyNeedsHumanDecision {
  const payload = record(candidate.payload);
  if (!isLegacyTrue(payload.needsHuman)) return { action: 'keep', reason: 'not-legacy-needs-human' };
  if (!candidate.itemKind || !ISSUE_FAMILY_KINDS.has(candidate.itemKind)) {
    return { action: 'keep', reason: 'not-issue-family' };
  }
  if (candidate.status && TERMINAL_STATES.has(candidate.status)) {
    return { action: 'keep', reason: 'terminal-history' };
  }
  if (payload.lane === 'observation' || payload._lane === 'observation') {
    return { action: 'keep', reason: 'observation-lane' };
  }
  if (candidate.status === 'needs-human') return { action: 'keep', reason: 'needs-human-status' };
  if (payload.needsOwnerAction === true) return { action: 'keep', reason: 'typed-owner-action' };
  if (Object.hasOwn(payload, 'humanCapability')) return { action: 'keep', reason: 'human-capability' };
  const blocker = blockerDisposition(payload);
  if (blocker === 'active') return { action: 'keep', reason: 'active-external-blocker' };
  if (blocker === 'malformed') return { action: 'keep', reason: 'malformed-external-blockers' };
  return { action: 'clear', reason: 'no-live-human-gate' };
}

export interface LegacyNeedsHumanReconcileResult {
  scanned: number;
  cleared: number;
  clearedIds: string[];
  deferredToNextTick: boolean;
}

export function legacyNeedsHumanReconcileCap(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LEGACY_NEEDS_HUMAN_RECONCILE_CAP;
  return Math.min(parsed, MAX_LEGACY_NEEDS_HUMAN_RECONCILE_CAP);
}

interface CandidateRow {
  workspace_id: string;
  harness_slug: string | null;
  feature_id: string;
  status: string | null;
  item_kind: string | null;
  taken_by: string | null;
  payload: unknown;
}

/**
 * Atomic read-decide-write pass. Candidate rows are locked with SKIP LOCKED, so
 * the JS decision and payload rewrite observe one lifecycle snapshot without
 * waiting behind an agent actively updating another row.
 */
export async function reconcileLegacyNeedsHumanRows(input: {
  workspaceId: string;
  cap?: number;
  sql?: OrgSql;
}): Promise<LegacyNeedsHumanReconcileResult> {
  const cap = legacyNeedsHumanReconcileCap(input.cap);
  const workspaceIds = [...new Set([input.workspaceId, 'default'])];
  return boundedOrgTxn(
    async (tx) => {
      // The SQL prefilter mirrors every fail-closed decision branch so a typed
      // gate cannot sit at the front of the ordered scan and consume the cap on
      // every tick. The pure decision runs again under the row lock as the final
      // authority; the duplicated WHERE is a performance filter, never permission.
      const rows = await tx<CandidateRow[]>`
        SELECT workspace_id, harness_slug, feature_id, status, item_kind, taken_by, payload
          FROM harness_shared.work_items
         WHERE workspace_id = ANY(${workspaceIds}::text[])
           AND item_kind = ANY(ARRAY['bug','change','task'])
           AND status <> ALL(${[...ANY_FAMILY_TERMINAL_STATES]}::text[])
           AND status IS DISTINCT FROM 'needs-human'
           AND COALESCE(payload, '{}'::jsonb) ->> 'needsHuman' = 'true'
           AND COALESCE(payload, '{}'::jsonb) ->> 'lane'  IS DISTINCT FROM 'observation'
           AND COALESCE(payload, '{}'::jsonb) ->> '_lane' IS DISTINCT FROM 'observation'
           AND COALESCE(payload, '{}'::jsonb) ->> 'needsOwnerAction' IS DISTINCT FROM 'true'
           AND NOT (COALESCE(payload, '{}'::jsonb) ? 'humanCapability')
           AND (
             NOT (COALESCE(payload, '{}'::jsonb) ? 'externalBlockers')
             OR COALESCE(payload, '{}'::jsonb) -> 'externalBlockers' = 'null'::jsonb
             OR (
               jsonb_typeof(COALESCE(payload, '{}'::jsonb) -> 'externalBlockers') = 'array'
               AND NOT EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(COALESCE(payload, '{}'::jsonb) -> 'externalBlockers') b
                  WHERE jsonb_typeof(b) IS DISTINCT FROM 'object'
                     OR b ->> 'status' IS NULL
                     OR lower(b ->> 'status') = 'active'
               )
             )
           )
         ORDER BY updated_ts ASC NULLS FIRST, harness_slug ASC NULLS FIRST, feature_id ASC
         LIMIT ${cap + 1}
         FOR UPDATE SKIP LOCKED`;

      const deferredToNextTick = rows.length > cap;
      const candidates = rows.slice(0, cap).map(
        (row): LegacyNeedsHumanCandidate => ({
          workspaceId: row.workspace_id,
          harnessSlug: row.harness_slug,
          id: row.feature_id,
          status: row.status,
          itemKind: row.item_kind,
          takenBy: row.taken_by,
          payload: row.payload,
        }),
      );
      const clearable = candidates.filter((candidate) => decideLegacyNeedsHumanReconcile(candidate).action === 'clear');
      if (clearable.length === 0) {
        return { scanned: candidates.length, cleared: 0, clearedIds: [], deferredToNextTick };
      }

      const identities = clearable.map((candidate) => ({
        workspace_id: candidate.workspaceId,
        harness_slug: candidate.harnessSlug,
        feature_id: candidate.id,
      }));
      const updated = await tx<Array<{ feature_id: string }>>`
        UPDATE harness_shared.work_items wi
           SET payload = COALESCE(wi.payload, '{}'::jsonb) - 'needsHuman',
               updated_ts = GREATEST(
                 COALESCE(wi.updated_ts, 0),
                 floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
               )
          FROM jsonb_to_recordset(${JSON.stringify(identities)}::text::jsonb)
               AS picked(workspace_id text, harness_slug text, feature_id text)
         WHERE wi.workspace_id = picked.workspace_id
           AND wi.harness_slug IS NOT DISTINCT FROM picked.harness_slug
           AND wi.feature_id = picked.feature_id
           -- Defensive replay guard: a recovery can re-enter from the top, and
           -- a future refactor may change the candidate query. Never create the
           -- key or touch a row that was already normalized.
           AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman' = 'true'
        RETURNING wi.feature_id`;
      const clearedIds = updated.map((row) => row.feature_id).sort();
      return {
        scanned: candidates.length,
        cleared: clearedIds.length,
        clearedIds,
        deferredToNextTick,
      };
    },
    input.sql ? { client: input.sql } : {},
  );
}

export interface LegacyNeedsHumanReconcileActionDeps {
  reconcile: (input: { workspaceId: string; cap: number }) => Promise<LegacyNeedsHumanReconcileResult>;
  log: (message: string) => void;
}

export function makeLegacyNeedsHumanReconcileAction(overrides: Partial<LegacyNeedsHumanReconcileActionDeps> = {}) {
  const deps: LegacyNeedsHumanReconcileActionDeps = {
    reconcile: ({ workspaceId, cap }) => reconcileLegacyNeedsHumanRows({ workspaceId, cap, sql: getOrgPg().sql }),
    log: (message) => console.log(`[${LEGACY_NEEDS_HUMAN_RECONCILE}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const cap = legacyNeedsHumanReconcileCap(ctx.triggerConfig?.cap);
    const result = await deps.reconcile({ workspaceId: ctx.workspaceId, cap });
    if (result.cleared === 0 && !result.deferredToNextTick) return;
    deps.log(
      `${ctx.installSlug}: scanned=${result.scanned} cleared=${result.cleared}` +
        (result.deferredToNextTick ? ` cap=${cap} reached; more deferred` : '') +
        (result.clearedIds.length > 0 ? ` ids=${result.clearedIds.join(',')}` : ''),
    );
  };
}

registerSystemAction(LEGACY_NEEDS_HUMAN_RECONCILE, makeLegacyNeedsHumanReconcileAction());
