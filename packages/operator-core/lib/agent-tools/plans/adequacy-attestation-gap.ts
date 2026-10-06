/**
 * EI-24903278232142036 — report adequacy ATTESTATIONS a re-bind lacks or a retraction removes.
 *
 * A `{ fromTestRun }` binding derives only the RUN facts (collected / skipped / executed /
 * outcome, testLayer). The DESIGN attestations a binder supplies by judgment — targeted,
 * falsifiable, pathReachable, oracleIndependent, fixtureCalibrated, coverageRungs — cannot be
 * derived from a run, so a fresh re-bind of the very same test file carries none of them.
 * Nothing visibly breaks at bind time, because the older row still carries them. The loss
 * lands LATER, when the older row is retracted (by hand, or by `supersedeAtRevision`): the
 * clause's correct-layer / oracle-independence / fixture-calibration ratings flip from pass to
 * unknown, and a freshness repair reads as having made the clause worse. Observed 2026-10-02
 * on blueprint-backed-work-item-execution-2026-09-23, e.g. GBE-P-008-contract: bindings
 * 12398 → 17686 → 22753, all of work-items-lifecycle.integration.test.ts, lost five
 * attestations on the first hop and its ratings went unknown once 12398 was retracted.
 *
 * The attestations are NOT carried forward automatically: they are judgments about the TEST,
 * and the test may have changed between the two runs. Both moments instead REPORT the gap as
 * an advisory, so the caller re-attests deliberately via `details.adequacy`.
 */
import { withWorkspace } from '@papercusp/db-org';
import { resolvePlanScope } from './source';

/** Adequacy keys a binder asserts by judgment; never derived from a recorded run. */
export const DESIGN_ATTESTATION_KEYS = [
  'targeted',
  'falsifiable',
  'pathReachable',
  'oracleIndependent',
  'fixtureCalibrated',
  'coverageRungs',
] as const;
export type DesignAttestationKey = (typeof DESIGN_ATTESTATION_KEYS)[number];

export interface ClauseAdequacyRow {
  id: number;
  evidenceKind: string;
  evidenceRef: string;
  adequacy: Record<string, unknown> | null | undefined;
}

/** True when the row POSITIVELY attests `key`; an explicit false is not an attestation. */
export function carriesAttestation(adequacy: Record<string, unknown> | null | undefined, key: DesignAttestationKey) {
  const value = adequacy?.[key];
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some((v) => v === true);
  return false;
}

/**
 * Attestations that live siblings of a NEW row carry but the new row does not. A sibling is a
 * live row of the same clause revision and evidence kind; for `test` rows it must also bind the
 * same test file, because another file's attestations say nothing about this one.
 */
export function attestationGap(
  bound: ClauseAdequacyRow,
  liveClauseRows: readonly ClauseAdequacyRow[],
): Array<{ key: DesignAttestationKey; carriedBy: number[] }> {
  const siblings = liveClauseRows.filter(
    (row) =>
      row.id !== bound.id &&
      row.evidenceKind === bound.evidenceKind &&
      (bound.evidenceKind !== 'test' || row.evidenceRef === bound.evidenceRef),
  );
  return DESIGN_ATTESTATION_KEYS.flatMap((key) => {
    if (carriesAttestation(bound.adequacy, key)) return [];
    const carriedBy = siblings.filter((row) => carriesAttestation(row.adequacy, key)).map((row) => row.id);
    return carriedBy.length > 0 ? [{ key, carriedBy }] : [];
  });
}

/**
 * Attestations the retracted rows carried that NO remaining live row of the same clause
 * revision carries — any kind, since the evaluator reads the clause's rows together.
 */
export function attestationLoss(
  retracted: readonly ClauseAdequacyRow[],
  remainingLive: readonly ClauseAdequacyRow[],
): Array<{ key: DesignAttestationKey; lostFrom: number[] }> {
  return DESIGN_ATTESTATION_KEYS.flatMap((key) => {
    if (remainingLive.some((row) => carriesAttestation(row.adequacy, key))) return [];
    const lostFrom = retracted.filter((row) => carriesAttestation(row.adequacy, key)).map((row) => row.id);
    return lostFrom.length > 0 ? [{ key, lostFrom }] : [];
  });
}

export interface ClauseRef {
  planSlug: string;
  specId: string;
  specRevision: number;
}

interface AdequacyRowSql {
  id: string | number;
  plan_slug: string;
  spec_id: string;
  spec_revision: number;
  evidence_kind: string;
  evidence_ref: string;
  adequacy: Record<string, unknown> | null;
  retracted: boolean;
}

/** Every row (live and retracted) of the given clauses plus the given ids, in one read. */
async function loadClauseRows(harnessSlug: string | undefined, clauses: readonly ClauseRef[], ids: readonly number[]) {
  const scope = await resolvePlanScope({ harnessSlug });
  const keys = clauses.map((c) => `${c.planSlug}\u001f${c.specId}\u001f${c.specRevision}`);
  return withWorkspace(scope.workspaceId, async (tx) => {
    const rows = await tx<AdequacyRowSql[]>`
      SELECT id, plan_slug, spec_id, spec_revision, evidence_kind, evidence_ref,
             details->'adequacy' AS adequacy, retracted_at IS NOT NULL AS retracted
        FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND (plan_slug || chr(31) || spec_id || chr(31) || spec_revision::text = ANY(${keys}::text[])
              OR id = ANY(${ids.map(Number)}::bigint[]))`;
    return rows.map((row) => ({
      id: Number(row.id),
      clause: `${row.plan_slug}\u001f${row.spec_id}\u001f${row.spec_revision}`,
      specId: row.spec_id,
      retracted: row.retracted,
      evidenceKind: row.evidence_kind,
      evidenceRef: row.evidence_ref,
      adequacy: row.adequacy,
    }));
  });
}

export interface AttestationAdvisory {
  code: 'adequacy_attestation_gap' | 'adequacy_attestation_lost';
  message: string;
  clauses: Array<Record<string, unknown>>;
}

const REATTEST_HINT =
  'Design attestations are never derived from a run. If they still hold for this test, re-bind with ' +
  'details.adequacy carrying them; otherwise the clause rates correct-layer / oracle-independence / ' +
  'fixture-calibration unknown once the carrying row is gone (EI-24903278232142036).';

/** Advisory for freshly bound rows that lack attestations their live siblings carry. */
export async function rebindAttestationAdvisory(
  harnessSlug: string | undefined,
  bound: ReadonlyArray<ClauseRef & { id: number; evidenceKind: string; evidenceRef: string; adequacy: unknown }>,
): Promise<AttestationAdvisory | null> {
  if (bound.length === 0) return null;
  const rows = await loadClauseRows(harnessSlug, bound, []);
  const clauses = bound.flatMap((b) => {
    const clause = `${b.planSlug}\u001f${b.specId}\u001f${b.specRevision}`;
    const live = rows.filter((row) => row.clause === clause && !row.retracted);
    const gap = attestationGap(
      { id: b.id, evidenceKind: b.evidenceKind, evidenceRef: b.evidenceRef, adequacy: b.adequacy as Record<string, unknown> | null },
      live,
    );
    return gap.length > 0 ? [{ bindingId: b.id, specId: b.specId, specRevision: b.specRevision, missing: gap }] : [];
  });
  if (clauses.length === 0) return null;
  return {
    code: 'adequacy_attestation_gap',
    message: `${clauses.length} new binding(s) lack design attestations a live sibling row still carries; retracting that row (by hand or via supersedeAtRevision) drops them from the clause. ${REATTEST_HINT}`,
    clauses,
  };
}

/** Advisory for retractions that removed the clause's last row carrying an attestation. */
export async function retractionAttestationAdvisory(
  harnessSlug: string | undefined,
  retracted: ReadonlyArray<ClauseRef & { id: number }>,
): Promise<AttestationAdvisory | null> {
  if (retracted.length === 0) return null;
  const rows = await loadClauseRows(harnessSlug, retracted, retracted.map((r) => r.id));
  const retractedIds = new Set(retracted.map((r) => r.id));
  const byClause = new Map<string, ClauseRef>();
  for (const r of retracted) byClause.set(`${r.planSlug}\u001f${r.specId}\u001f${r.specRevision}`, r);
  const clauses = [...byClause].flatMap(([clause, ref]) => {
    const gone = rows.filter((row) => row.clause === clause && retractedIds.has(row.id));
    const live = rows.filter((row) => row.clause === clause && !row.retracted);
    const loss = attestationLoss(gone, live);
    return loss.length > 0 ? [{ specId: ref.specId, specRevision: ref.specRevision, lost: loss }] : [];
  });
  if (clauses.length === 0) return null;
  return {
    code: 'adequacy_attestation_lost',
    message: `${clauses.length} clause(s) no longer have ANY live row carrying some design attestations the retracted rows carried. ${REATTEST_HINT}`,
    clauses,
  };
}
