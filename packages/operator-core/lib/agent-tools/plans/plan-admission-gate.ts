/**
 * plan-admission-gate — the ONE place a lifecycle door asks "is this EXACT plan
 * revision admitted to run?" (P-004, plan shared-pot-dao-cupboard-v1-2026-09-04).
 *
 * plan-start-gate answers "are this plan's INPUTS ready"; this answers "has this
 * plan's exact revision been RATIFIED, and is that ratification still in force".
 * They are deliberately separate modules with separate refusal shapes: readiness is
 * a property of the plan document, admission is a property of the pot's governance,
 * and collapsing them would make a governance refusal read like a missing input.
 *
 * ACTIVATION IS POLICY-DRIVEN, NOT A FLAG. A pot whose owner-signed policy carries
 * no `governance.planAdmission` section is passed through (`skipped`), so every
 * existing plan in every existing pot keeps working unchanged and no dark flag has
 * to be remembered. Setting the policy is what turns enforcement on, which is the
 * plan's own activation model ("activate enforcement only after evidence", P-013).
 *
 * IT FAILS CLOSED THE MOMENT THE POLICY EXISTS. A pot that HAS opted in but whose
 * production governance log cannot resolve a valid certificate for the exact plan
 * revision is REFUSED (`missing-certificate`), never passed. Storage, scope, or
 * integrity failures therefore cannot silently disable the gate.
 *
 * WHY TWO SEAMS. Policy and certificate resolution are separately replaceable
 * (D-025's ArtifactStore pattern) because they have different owners: the policy is
 * pot configuration, while the production certificate comes from the P-005
 * federated governance-event store. A test or a later on-chain bridge can swap one
 * without touching the other.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import type { PlanGovernanceControls } from './governance-federation';
import { assertPlanAdmission, type AdmissionCertificate, type AdmissionRefusalCode, type PlanAdmissionDoor } from './plan-admission-enforcement';
import type { PlanAdmissionPolicy } from './plan-admission-policy';
import { resolvePlanAdmissionMode, validatePlanAdmissionPolicy } from './plan-admission-policy';
import { productionPlanAdmissionCertificateSource } from './plan-admission-certificate-source';
import { getPlanRow, type PlanRow, type PlanSourceOpts } from './source';

/** What a door needs to identify the plan it is about to act on. */
export interface PlanAdmissionSubject {
  readonly slug: string;
  readonly door: PlanAdmissionDoor;
  readonly opts?: PlanSourceOpts;
  /**
   * A row the door already loaded. Supplied to avoid a second read, never to change
   * the verdict. Keyed on PRESENCE: supplying `null` states that the door looked and
   * found no plan, and no read is attempted — omit the key entirely to have the gate
   * load the row itself.
   */
  readonly row?: PlanRow | null;
  /**
   * The revision hash the door is acting on, for a door that holds the hash but not a
   * `PlanRow` (the scheduled fire reads the plan with its own query). Supplied, no row
   * is read at all — which is the point: a second read could return a NEWER revision
   * than the one the door is about to run, and admitting that revision would be a
   * verdict about a plan nobody is starting.
   */
  readonly planRevisionHash?: string;
  readonly nowMs?: number;
}

/** Resolves the pot's ratification policy, or null when this pot has not opted in. */
export type PlanAdmissionPolicySource = (input: { slug: string; opts: PlanSourceOpts }) => Promise<PlanAdmissionPolicy | null>;

/**
 * Resolves the certificate (and the P-005 governance controls) for one plan revision.
 *
 * Returning `certificate: null` is a REFUSAL, not an absence to be forgiven — see the
 * fail-closed note above. `governance` is the time-evaluated verdict from
 * `resolveRoundControls`, and D-039 requires it to be resolved at the SAME `nowMs`
 * this gate passes in, which is why the instant is an explicit input rather than
 * something the source reads off its own clock.
 */
export interface PlanAdmissionCertificateSource {
  resolve(input: {
    slug: string;
    door: PlanAdmissionDoor;
    planRevisionHash: string;
    policy: PlanAdmissionPolicy;
    nowMs: number;
    opts: PlanSourceOpts;
  }): Promise<{ certificate: AdmissionCertificate | null; governance?: PlanGovernanceControls | null }>;
}

/**
 * One observed-but-not-applied admission verdict (P-013).
 *
 * This is the EVIDENCE the plan's activation model asks for: what the gate would
 * have done to this door, on this revision, had the policy been enforcing. Both
 * outcomes are emitted — a `wouldAdmit: true` observation is not noise, it is the
 * denominator, and without it "how often would this policy refuse?" has no answer.
 */
export interface PlanAdmissionShadowObservation {
  readonly slug: string;
  readonly door: PlanAdmissionDoor;
  readonly planRevisionHash: string;
  readonly policyVersion: number;
  readonly nowMs: number;
  /** What the door WOULD have received under `enforce`. */
  readonly wouldAdmit: boolean;
  /** Present only when `wouldAdmit` is false. */
  readonly code?: AdmissionRefusalCode;
  readonly detail: string;
}

/** Where shadow observations go. Unset means the verdict is computed and discarded. */
export interface PlanAdmissionShadowSink {
  record(observation: PlanAdmissionShadowObservation): void | Promise<void>;
}

interface AdmissionGateState {
  policySource: PlanAdmissionPolicySource | null;
  certificateSource: PlanAdmissionCertificateSource | null;
  shadowSink: PlanAdmissionShadowSink | null;
}

// Pinned: operator-core is reached both as a bare specifier and by relative path, and
// a split module record would give one caller a configured source and another the
// default while neither errored (see @papercusp/module-singleton).
const state = pinModuleState<AdmissionGateState>('@papercusp/operator-core.plan-admission-gate', () => ({
  policySource: null,
  certificateSource: null,
  shadowSink: null,
}));

/** Install a certificate-provider override. Pass null to restore the production governance-event source. */
export function configurePlanAdmissionCertificateSource(source: PlanAdmissionCertificateSource | null): void {
  state.certificateSource = source;
}

/** Override policy resolution. Pass null to restore the default hive-policy reader. */
export function configurePlanAdmissionPolicySource(source: PlanAdmissionPolicySource | null): void {
  state.policySource = source;
}

/**
 * Install the shadow-observation sink. Pass null to compute-and-discard.
 *
 * Absent a sink, `mode: 'shadow'` still admits everything — the mode governs
 * ENFORCEMENT, and recording is a separate concern with a separate owner, which is
 * the same argument the module header makes for keeping policy and certificate
 * resolution apart.
 */
export function configurePlanAdmissionShadowSink(sink: PlanAdmissionShadowSink | null): void {
  state.shadowSink = sink;
}

/**
 * Hand one observation to the sink. NEVER throws.
 *
 * Deliberately fail-OPEN, which is the opposite of everything else in this file and
 * is correct here: recording is not authorization. A sink that is misconfigured,
 * slow, or throwing must not turn into a refusal — that would make the
 * evidence-gathering mode more dangerous to switch on than enforcement itself, and
 * nobody would ever gather the evidence.
 */
async function emitShadowObservation(observation: PlanAdmissionShadowObservation): Promise<void> {
  const sink = state.shadowSink;
  if (!sink) return;
  try {
    await sink.record(observation);
  } catch {
    // Swallowed on purpose. See above.
  }
}

/**
 * Where each admission door is WIRED. The counterpart of PLAN_START_DOORS, and it is
 * a separate registry for a reason: the start gate has six doors that all funnel
 * through one chokepoint, while admission has seven spread over four files, because
 * three of them (the scheduled fire, the status flips, the scout autostart sweep)
 * reach no chokepoint at all — they hold their own row and run their own SQL.
 *
 * That spread IS the failure mode this registry exists to catch. P-004's original
 * delivery shipped `assertPlanAdmission` with ZERO callers and read as complete,
 * which is precisely what a registry-plus-guard makes impossible to repeat: adding a
 * door here without wiring it fails the build, and wiring one without registering it
 * leaves the door unaudited.
 *
 * A door may name SEVERAL files ('scheduled' is armed in one place and fired in
 * another); the guard requires every listed file to reach an entrypoint, so a
 * half-wired pair cannot pass on the strength of its wired half.
 */
export const PLAN_ADMISSION_DOOR_SITES = [
  { door: 'status', files: ['lib/agent-tools/plans/set-plan-status.ts'] },
  { door: 'promotion', files: ['lib/agent-tools/plans/set-plan-status.ts'] },
  { door: 'start', files: ['lib/agent-tools/plans/start.ts', 'lib/agent-tools/plans/launch.ts'] },
  { door: 'run-now', files: ['lib/agent-tools/plans/run-now.ts'] },
  {
    door: 'scheduled',
    files: ['lib/agent-tools/plans/arm-schedule.ts', 'lib/harness/routines/plan-run-action.ts'],
  },
  { door: 'autostart', files: ['lib/scout/ready-plan-autostart.ts'] },
  { door: 'fleet-launch', files: ['lib/agent-tools/fleet_registry/launch-on-plan.ts'] },
] as const;

/**
 * A site satisfies the guard by calling one of these: `checkPlanAdmission` directly,
 * or `checkPlanStartable`, which calls it on the site's behalf and is where the five
 * start-shaped doors are gated.
 */
export const PLAN_ADMISSION_GATE_ENTRYPOINTS = ['checkPlanAdmission', 'checkPlanStartable'] as const;

/**
 * Emergency OFF switch for enforcement application. Default-on: absent or any
 * value other than an explicit off token leaves the owner policy in force. Turning
 * it off runs the identical verdict path in shadow mode; it never mutates or
 * reinterprets the signed policy bytes.
 */
export const PLAN_ADMISSION_ENFORCEMENT_ENV = 'PAPERCUSP_PLAN_ADMISSION_ENFORCEMENT';

export function planAdmissionEnforcementEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[PLAN_ADMISSION_ENFORCEMENT_ENV]?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'disabled';
}

/** Why a door did not evaluate admission at all. Both are PASSES, and both say so out loud. */
/**
 * Why a door was admitted without an applied verdict.
 *
 * `shadow-mode` is NOT the same as `no-admission-policy`, and the distinction is
 * the whole point of P-013: the first means a policy exists and was fully
 * evaluated but is only watching, the second means nothing was evaluated at all.
 * Collapsing them would make "we gathered evidence" indistinguishable from "we
 * never looked" — which is precisely the state this mode was added to escape.
 */
export type PlanAdmissionSkipReason = 'no-admission-policy' | 'plan-not-found' | 'shadow-mode';

export interface PlanAdmissionRefusal {
  error: 'plan_admission_refused';
  code: AdmissionRefusalCode;
  door: PlanAdmissionDoor;
  slug: string;
  /** The revision the door was about to act on — not the certificate's. */
  planRevisionHash: string;
  policyVersion: number;
  detail: string;
  /** One line, actionable; surface verbatim. */
  hint: string;
}

export type PlanAdmissionVerdict =
  | { admitted: true; skipped: PlanAdmissionSkipReason; shadow?: PlanAdmissionShadowObservation }
  | { admitted: true; skipped?: undefined; certificate: AdmissionCertificate; planRevisionHash: string; policyVersion: number }
  | { admitted: false; refusal: PlanAdmissionRefusal };

const HINTS: Record<AdmissionRefusalCode, string> = {
  'unknown-door': 'this door is not a recognised plan admission door — add it to PLAN_ADMISSION_DOORS and wire it',
  'missing-plan-revision': 'the plan row carries no content hash, so its exact revision cannot be identified',
  'missing-certificate': 'this pot requires ratification but no admission certificate was resolved for the current plan revision — ratify and persist the revision, or repair the governance-event source',
  'certificate-rejected': 'the ratification round did not approve this plan revision',
  'revision-mismatch': 'the plan has been edited since it was ratified — ratify the current revision',
  'policy-epoch-mismatch': 'the certificate was issued under an older governance policy epoch — re-ratify under the current policy',
  'certificate-expired': 'the ratification window has closed — re-ratify this plan revision',
  'plan-paused': 'governance has paused this round; the pause must expire or be resumed before this plan can run',
  'plan-revoked': 'governance revoked this round; a revoke is terminal and a new round is required',
  'round-quarantined': 'conflicting finalizations quarantined this round; recompute it in a fresh round before running',
};

/** Read the pot's owner-signed `governance.planAdmission` section, or null if unset. */
const defaultPolicySource: PlanAdmissionPolicySource = async ({ opts }) => {
  const harnessSlug = opts.harnessSlug;
  const workspaceId = opts.workspaceId;
  if (!harnessSlug || !workspaceId) return null;
  const [{ potHomeSlugForHarness }, { getHivePolicyCached }] = await Promise.all([import('../../hive-federation'), import('../../hive-policy-store')]);
  const potHomeSlug = await potHomeSlugForHarness(workspaceId, harnessSlug);
  if (!potHomeSlug) return null;
  const resolved = await getHivePolicyCached(workspaceId, potHomeSlug);
  const raw = resolved?.policy?.governance?.planAdmission;
  if (raw === undefined || raw === null) return null;
  const validated = validatePlanAdmissionPolicy(raw);
  // An INVALID policy is not the same as an absent one. Passing through on a
  // malformed section would let a corrupted policy silently disable the gate, which
  // is precisely the failure a governance control exists to prevent — so treat it as
  // present-and-unsatisfiable and let the certificate checks refuse.
  return validated.ok ? validated.policy : { ...FAILING_POLICY };
};

/**
 * The stand-in for a policy section that exists but does not parse. Its epoch is
 * unmatchable by construction, so every certificate refuses `policy-epoch-mismatch`
 * rather than being admitted under a policy nobody could read.
 */
const FAILING_POLICY: PlanAdmissionPolicy = Object.freeze({
  policyVersion: Number.MAX_SAFE_INTEGER,
  quorumBps: 10_000,
  approvalBps: 10_000,
  ratificationWindowSec: 1,
  materiality: Object.freeze({ maxChangedLines: 0, maxChangedItems: 0 }),
  // Stated explicitly rather than left to the default. This policy stands in for a
  // section nobody could parse, so it must REFUSE; were it ever to resolve to
  // `shadow`, a corrupted policy document would silently switch the gate off
  // instead of failing closed — the exact inversion this stand-in exists to block.
  mode: 'enforce' as const,
});

/**
 * Decide whether `door` may act on `slug`'s current revision.
 *
 * Every door calls this; none re-implements any part of it. The verdict is derived
 * from the row the door is actually about to act on, so a plan edited between
 * ratification and the door call refuses `revision-mismatch` instead of running the
 * revision nobody approved.
 */
export async function checkPlanAdmission(subject: PlanAdmissionSubject): Promise<PlanAdmissionVerdict> {
  const opts = subject.opts ?? {};
  const nowMs = subject.nowMs ?? Date.now();
  const policy = await (state.policySource ?? defaultPolicySource)({ slug: subject.slug, opts });
  if (!policy) return { admitted: true, skipped: 'no-admission-policy' };

  let planRevisionHash = subject.planRevisionHash;
  if (planRevisionHash === undefined) {
    // `row` is keyed on PRESENCE, not truthiness: its type is `PlanRow | null`, so an
    // explicit null is the door saying "I looked, there is no plan" — a fact, not an
    // omission. Falling through to a read there would re-ask a question the door has
    // already answered, and answer it from a different transaction.
    const row = 'row' in subject ? (subject.row ?? null) : await getPlanRow(subject.slug, opts);
    // Absent plan: the door has its own not_found shape (same argument as
    // plan-start-gate's module header). Refusing here would invent a second one.
    if (!row) return { admitted: true, skipped: 'plan-not-found' };
    planRevisionHash = row.contentHash ?? '';
  }
  const certificateSource =
    state.certificateSource ?? productionPlanAdmissionCertificateSource;
  const resolved = await certificateSource.resolve({
    slug: subject.slug,
    door: subject.door,
    planRevisionHash,
    policy,
    nowMs,
    opts,
  });

  const result = assertPlanAdmission({
    door: subject.door,
    planRevisionHash,
    policyVersion: policy.policyVersion,
    certificate: resolved.certificate,
    governance: resolved.governance ?? null,
    nowMs,
  });
  // SHADOW (P-013): the verdict above was computed exactly as it would be under
  // `enforce` — same policy, same certificate, same governance controls, same
  // instant. Only its APPLICATION changes. Diverting here rather than earlier is
  // what makes the evidence trustworthy: an observation produced by a cheaper or
  // short-circuited path would measure something other than the enforcement it is
  // supposed to predict.
  if (
    !planAdmissionEnforcementEnabled() ||
    resolvePlanAdmissionMode(policy) === 'shadow'
  ) {
    const observation: PlanAdmissionShadowObservation = {
      slug: subject.slug,
      door: subject.door,
      planRevisionHash,
      policyVersion: policy.policyVersion,
      nowMs,
      wouldAdmit: result.ok,
      ...(result.ok ? {} : { code: result.code }),
      detail: result.ok ? 'would admit' : result.detail,
    };
    await emitShadowObservation(observation);
    return { admitted: true, skipped: 'shadow-mode', shadow: observation };
  }

  if (result.ok) return { admitted: true, certificate: result.certificate, planRevisionHash, policyVersion: policy.policyVersion };
  return {
    admitted: false,
    refusal: {
      error: 'plan_admission_refused',
      code: result.code,
      door: subject.door,
      slug: subject.slug,
      planRevisionHash,
      policyVersion: policy.policyVersion,
      detail: result.detail,
      hint: HINTS[result.code],
    },
  };
}

/** The refusal as an MCP tool error result — the shape the plans:* verbs return. */
export function planAdmissionRefusalContent(refusal: PlanAdmissionRefusal) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(refusal) }],
    isError: true as const,
  };
}
