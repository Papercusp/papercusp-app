/**
 * The ONE predicate that decides whether `release:deploy { op:'trigger' }` refuses, and why.
 *
 * Extracted from the trigger handler (plan use-existing-router-for-review-requests-2026-09-08
 * P-009) so the deploy/gate wait operational brief can report the deploy lever's availability
 * from the SAME code the handler refuses on. Two copies of this decision would let the brief
 * advertise a trigger the handler then refuses — the exact falsifier of spec
 * OP-BRIEF-P009-GATE ("names a deploy action unavailable for the current verdict").
 *
 * Pure and type-only on its inputs: the authority is `canTriggerGreen`, computed once by
 * `computeDeployStatus`; the reason order is the handler's historical order (a running deploy
 * first, because a caller retrying after a transport error needs "your deploy IS running", not
 * a gate lecture — EI-18724155280048738).
 */
import type { DeployStatus } from '../release-deploy-launch';

export type DeployTriggerRefusalInput = Pick<
  DeployStatus,
  'canTriggerGreen' | 'deployInFlight' | 'state' | 'nothingToDeploy' | 'recommendation'
>;

/** `null` when op:'trigger' would launch; otherwise the refusal reason the handler returns. */
export function deployTriggerRefusalReason(status: DeployTriggerRefusalInput): string | null {
  if (status.canTriggerGreen) return null;
  const inFlight = status.deployInFlight;
  if (inFlight?.active) {
    const started = inFlight.startedAtMs ? `, started ${new Date(inFlight.startedAtMs).toISOString()}` : '';
    return `deploy_in_flight — a deploy is ALREADY RUNNING (unit ${inFlight.unit} is ${inFlight.activeState}${started}). This is NOT a failed trigger: if your last trigger returned a transport error, it very likely still launched THIS deploy. Do not re-trigger — watch ${inFlight.logPath} or await release:deployed / deploy-failed.`;
  }
  if (status.state === 'gate-red') {
    return 'gate_red — there is no green pin ahead of the live deploy to ship. Fix the reds first (release:deploy{op:status} for detail); trigger can only expedite GREEN code.';
  }
  if (status.nothingToDeploy) return 'nothing_to_deploy — the live :3070 is already at the green pin.';
  return `not_green_deployable (${status.state}) — ${status.recommendation}`;
}
