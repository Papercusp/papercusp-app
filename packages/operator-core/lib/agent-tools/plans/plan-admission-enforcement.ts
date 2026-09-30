/**
 * Reusable exact-plan admission guard for every lifecycle execution door (P-004).
 *
 * Governance CONTROLS (pause / revoke / quarantine, P-005) are evaluated BEFORE the
 * certificate checks, so a control can never be out-voted by a certificate that is
 * otherwise perfectly valid: a paused or revoked plan must refuse even when its
 * ratification certificate matches the revision and epoch exactly.
 *
 * Refusal is a pure return value. No caller may mint a work-item, promote, or
 * execute on `ok: false` — the guard does no work of its own, so there is nothing
 * to undo on the refusal path.
 */
import type { PlanGovernanceControls } from './governance-federation';

export const PLAN_ADMISSION_DOORS = ['status', 'start', 'promotion', 'scheduled', 'run-now', 'autostart', 'fleet-launch'] as const;
export type PlanAdmissionDoor = (typeof PLAN_ADMISSION_DOORS)[number];

export interface AdmissionCertificate {
  readonly planRevisionHash: string;
  readonly policyVersion: number;
  readonly admitted: boolean;
  readonly expiresAtMs: number;
  readonly certificateHash: string;
}

export type AdmissionRefusalCode =
  | 'unknown-door'
  | 'missing-plan-revision'
  | 'missing-certificate'
  | 'certificate-rejected'
  | 'revision-mismatch'
  | 'policy-epoch-mismatch'
  | 'certificate-expired'
  // Governance controls (P-005). Distinct codes because the operator response differs:
  // a pause lapses on its own, a quarantine clears by recomputing the round, and a
  // revoke never clears at all.
  | 'plan-paused'
  | 'plan-revoked'
  | 'round-quarantined';
export type AdmissionResult = { ok: true; door: PlanAdmissionDoor; certificate: AdmissionCertificate } | { ok: false; code: AdmissionRefusalCode; detail: string };

/**
 * Assert that an execution door is operating on the exact ratified plan
 * revision and owner policy epoch. Callers invoke this inside their existing
 * transaction/lock immediately before promotion or execution.
 */
export function assertPlanAdmission(input: {
  door: string;
  planRevisionHash: string;
  policyVersion: number;
  certificate?: AdmissionCertificate | null;
  /** Time-evaluated governance verdict from `resolveRoundControls`, resolved at this same `nowMs`. */
  governance?: PlanGovernanceControls | null;
  nowMs: number;
}): AdmissionResult {
  if (!(PLAN_ADMISSION_DOORS as readonly string[]).includes(input.door)) return { ok: false, code: 'unknown-door', detail: `unsupported plan execution door '${input.door}'` };
  if (!input.planRevisionHash.trim()) return { ok: false, code: 'missing-plan-revision', detail: 'exact plan revision hash is required' };
  const control = input.governance ? refuseOnGovernanceControl(input.governance) : null;
  if (control) return control;
  if (!input.certificate) return { ok: false, code: 'missing-certificate', detail: 'an immutable admission certificate is required' };
  if (!input.certificate.admitted) return { ok: false, code: 'certificate-rejected', detail: 'admission certificate does not authorize execution' };
  if (input.certificate.planRevisionHash !== input.planRevisionHash) return { ok: false, code: 'revision-mismatch', detail: 'certificate is for a different plan revision' };
  if (input.certificate.policyVersion !== input.policyVersion) return { ok: false, code: 'policy-epoch-mismatch', detail: 'certificate is for a different policy epoch' };
  if (!Number.isFinite(input.nowMs) || input.nowMs > input.certificate.expiresAtMs) return { ok: false, code: 'certificate-expired', detail: 'admission certificate has expired' };
  return { ok: true, door: input.door as PlanAdmissionDoor, certificate: input.certificate };
}

/**
 * Map a governance status onto its refusal, or null when the controls do not block.
 *
 * Precedence matches `resolveStatus` in governance-federation: revoked outranks
 * quarantined outranks paused. `open` refuses nothing HERE — an unfinalized round is
 * already refused by the certificate checks that follow, and duplicating that verdict
 * would report the wrong code for it.
 */
function refuseOnGovernanceControl(governance: PlanGovernanceControls): { ok: false; code: AdmissionRefusalCode; detail: string } | null {
  const round = governance.roundId;
  switch (governance.status) {
    case 'revoked':
      return { ok: false, code: 'plan-revoked', detail: `round ${round} is revoked and can never be re-admitted: ${governance.revokedReason ?? 'no reason recorded'}` };
    case 'quarantined':
      return { ok: false, code: 'round-quarantined', detail: governance.quarantineReason ?? `round ${round} is quarantined pending recomputation` };
    case 'paused':
      return { ok: false, code: 'plan-paused', detail: `round ${round} is paused by an owner-signed control` };
    default:
      return null;
  }
}
