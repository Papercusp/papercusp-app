/**
 * Fold legacy per-class tool-failure observations into their signature rows
 * (review-system-rework-reduction-2026-09-23 D-010, P-012/P-023).
 *
 * Before D-010 the automatic invocation-friction path keyed each tracker row on
 * the failure CLASS (tool, family, error code, contract, deployed revision), so
 * one live defect minted a new row on every build — about 27 a day. New filings
 * now land on one row per SIGNATURE (tool, family, error code, field path). This
 * sweep folds the rows filed before that, in bounded batches on the existing
 * watchdog cadence, so it needs no manual step and finishes on its own: nothing
 * mints a legacy-keyed automatic row any more, so the query empties.
 *
 * Scope is deliberately narrow: open, observation-lane rows still in probation
 * that the AUTOMATIC path filed (`payload.toolInvocation`). Promoted rows are
 * accountable issues with their own disposition and are never touched; agent-
 * authored captures carry no `toolInvocation` and are out of scope.
 *
 * The close mirrors reconcileToolFailurePromotionCollision in capture-core: mark
 * the duplicate with its survivor, then resolve it under a dedicated owner. That
 * owner is NOT the watchdog auto-close owner, so no exact-key reopen path fires.
 */
import { getOrgPg } from '@papercusp/db-org';
import { mergeIssuePayload, setIssueState } from '../../issues-engineer';
import {
  addToolFailureClassSnapshot,
  toolFailureSignatureOf,
  type ToolFailureSignaturePayload,
} from './capture-core';
import { toolFailureSignatureKey, type ToolErrorClass } from './tool-error-classifier';

type Sql = ReturnType<typeof getOrgPg>['sql'];

export const SIGNATURE_FOLD_OWNER = 'system:tool-failure-signature-fold';
export const SIGNATURE_FOLD_BATCH = 200;
const TERMINAL = ['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'];

interface FoldRow {
  id: string;
  harness_slug: string;
  origin: string;
  payload: Record<string, unknown>;
}

export interface SignatureFoldDeps {
  sql?: Sql;
  mergeIssuePayload?: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  resolveDuplicate?: (id: string) => Promise<unknown>;
}

export interface SignatureFoldResult {
  scanned: number;
  groups: number;
  folded: number;
  rekeyed: number;
  failedGroups: number;
}

interface Probation {
  class?: string;
  classKey?: string;
  contractFingerprint?: string;
  deployedRevision?: string;
  reporters?: string[];
  firstSeenAt?: string;
  lastSeenAt?: string;
  report?: { toolName?: string; errorCode?: string; fieldPath?: string };
  [key: string]: unknown;
}

function probationOf(payload: Record<string, unknown>): Probation | null {
  const p = payload.toolFailureProbation;
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Probation) : null;
}

/** The signature a legacy row would have been filed under, or null when unreadable. */
export function legacySignatureOf(payload: Record<string, unknown>): string | null {
  const probation = probationOf(payload);
  const report = probation?.report;
  if (!probation?.class || !report?.toolName) return null;
  return toolFailureSignatureKey(
    { toolName: report.toolName, errorCode: report.errorCode, fieldPath: report.fieldPath },
    probation.class as ToolErrorClass,
  );
}

function repeatCountOf(payload: Record<string, unknown>): number {
  return typeof payload.repeatCount === 'number' && payload.repeatCount > 0 ? payload.repeatCount : 1;
}

/** Add one legacy row's whole class history to a signature tally (pure). */
export function foldRowIntoTally(
  tally: ToolFailureSignaturePayload | null,
  signatureKey: string,
  payload: Record<string, unknown>,
  keepClassKey?: string,
): ToolFailureSignaturePayload {
  const probation = probationOf(payload) ?? {};
  const classKey = probation.classKey ?? `unknown-class:${signatureKey}`;
  const seen = typeof payload.lastSeenAt === 'string' ? payload.lastSeenAt : probation.lastSeenAt;
  const first = probation.firstSeenAt ?? seen ?? new Date(0).toISOString();
  return addToolFailureClassSnapshot(tally, signatureKey, classKey, {
    reporters: Array.isArray(probation.reporters) ? probation.reporters : [],
    count: repeatCountOf(payload),
    firstSeenAt: first,
    lastSeenAt: seen ?? first,
    contractFingerprint: probation.contractFingerprint ?? 'schema-unknown~field-unknown',
    deployedRevision: probation.deployedRevision ?? 'runtime-unknown',
  }, keepClassKey);
}

/**
 * One bounded fold batch for a workspace. Each group (signature + harness +
 * origin) folds onto its open signature row, or onto its newest legacy row,
 * which is then re-keyed to the signature. A group that fails is left for the
 * next tick and counted in `failedGroups`; it never aborts the others.
 */
export async function foldLegacyToolFailureRows(
  workspaceId: string,
  deps: SignatureFoldDeps = {},
  limit = SIGNATURE_FOLD_BATCH,
): Promise<SignatureFoldResult> {
  const sql = deps.sql ?? getOrgPg().sql;
  const merge = deps.mergeIssuePayload ?? ((id, patch) => mergeIssuePayload(id, patch));
  const resolve = deps.resolveDuplicate ??
    ((id) => setIssueState(id, 'resolved', SIGNATURE_FOLD_OWNER, undefined, { skipCompletionGate: true }));
  const rows = await sql.unsafe<FoldRow[]>(`
    SELECT feature_id AS id, harness_slug,
           COALESCE(payload->'_ei'->>'signal_origin', 'organic') AS origin, payload
      FROM harness_shared.work_items
     WHERE workspace_id = $1
       AND item_kind IN ('bug', 'change')
       AND (status IS NULL OR status <> ALL ($2::text[]))
       AND payload->>'lane' = 'observation'
       AND payload ? 'toolInvocation'
       AND payload->'toolFailureProbation'->>'state' = 'probation'
       AND payload->>'watchdogKey' IS NOT NULL
       AND payload->>'watchdogKey' NOT LIKE 'tool-failure-signature:%'
     ORDER BY updated_ts DESC NULLS LAST, feature_id
     LIMIT $3`, [workspaceId, TERMINAL, limit]);
  const result: SignatureFoldResult = { scanned: rows.length, groups: 0, folded: 0, rekeyed: 0, failedGroups: 0 };
  const groups = new Map<string, { signature: string; harness: string; origin: string; members: FoldRow[] }>();
  for (const row of rows) {
    const signature = legacySignatureOf(row.payload);
    if (!signature) continue;
    const key = `${signature}\u0000${row.harness_slug}\u0000${row.origin}`;
    const group = groups.get(key) ?? { signature, harness: row.harness_slug, origin: row.origin, members: [] };
    group.members.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    result.groups++;
    try {
      const [existing] = await sql.unsafe<FoldRow[]>(`
        SELECT feature_id AS id, harness_slug,
               COALESCE(payload->'_ei'->>'signal_origin', 'organic') AS origin, payload
          FROM harness_shared.work_items
         WHERE workspace_id = $1 AND harness_slug = $2
           AND item_kind IN ('bug', 'change')
           AND (status IS NULL OR status <> ALL ($3::text[]))
           AND payload->>'watchdogKey' = $4
           AND COALESCE(payload->'_ei'->>'signal_origin', 'organic') = $5
           AND payload->>'lane' = 'observation'
         LIMIT 1`, [workspaceId, group.harness, TERMINAL, group.signature, group.origin]);
      // Rows already marked by an interrupted earlier fold are only re-resolved.
      const pending = group.members.filter((m) => typeof m.payload.signatureFoldedInto !== 'string');
      const retry = group.members.filter((m) => typeof m.payload.signatureFoldedInto === 'string');
      const survivor = existing ?? pending[0];
      if (!survivor) {
        for (const m of retry) { await resolve(m.id); result.folded++; }
        continue;
      }
      const losers = pending.filter((m) => m.id !== survivor.id);
      const survivorProbation = probationOf(survivor.payload) ?? {};
      let tally = toolFailureSignatureOf(survivor.payload);
      if (!existing) tally = foldRowIntoTally(tally, group.signature, survivor.payload, survivorProbation.classKey);
      let repeatCount = repeatCountOf(survivor.payload);
      for (const loser of losers) {
        tally = foldRowIntoTally(tally, group.signature, loser.payload, survivorProbation.classKey);
        repeatCount += repeatCountOf(loser.payload);
      }
      await merge(survivor.id, {
        watchdogKey: group.signature,
        repeatCount,
        toolFailureSignature: tally,
        toolFailureProbation: { ...survivorProbation, watchdogKey: group.signature, signatureKey: group.signature },
      });
      if (!existing) result.rekeyed++;
      for (const loser of [...losers, ...retry]) {
        if (typeof loser.payload.signatureFoldedInto !== 'string') {
          await merge(loser.id, {
            decidedReason: `duplicate of ${survivor.id} — tool-failure signature fold (review-system-rework-reduction-2026-09-23 D-010)`,
            signatureFoldedInto: survivor.id,
          });
        }
        await resolve(loser.id);
        result.folded++;
      }
    } catch {
      result.failedGroups++;
    }
  }
  return result;
}
