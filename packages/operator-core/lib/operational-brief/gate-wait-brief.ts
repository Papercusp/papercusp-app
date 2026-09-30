/**
 * Deploy/gate wait operational brief — plan use-existing-router-for-review-requests-2026-09-08
 * P-009, spec OP-BRIEF-P009-GATE.
 *
 * Projects two EXISTING reads into the shared operational-brief shape and stores nothing:
 *  - `DeployStatus` — the same value `release:deploy { op:'status' }` returns: verdict, green
 *    pin, deployed sha, checkpoint execution, release-trigger control, recommendation;
 *  - `CellOwnership` — the `gate.greenCheckpoint.ownership` cell: who holds the gate incident.
 *
 * The three failure modes the spec's falsifier names are closed structurally:
 *  - a stale pin: every sha is read from the DeployStatus passed in, never cached here;
 *  - an omitted owner: the owner is the ownership cell's measured holder, or an explicit
 *    unknown naming why — never inferred from the verdict, never silently null;
 *  - an unavailable deploy lever: the trigger's availability is `deployTriggerRefusalReason`,
 *    the SAME predicate the trigger handler refuses on.
 */
import type { CellOwnership } from '../coord/gate-ownership';
import type { DeployStatus } from '../release-deploy-launch';
import { deployTriggerRefusalReason } from '../release/deploy-trigger-refusal';
import { finalizeOperationalBrief, known, unknown, type BriefField, type OperationalBrief } from './brief';

export const GATE_WAIT_BRIEF_SUBJECT = 'green-checkpoint → :3070 deploy';
export const DEPLOY_TRIGGER_LEVER = "release:deploy { op:'trigger', confirm:true }";
/** Failing tests listed in `blockers`; the rest are counted, never dropped silently. */
export const GATE_WAIT_FAILING_TESTS_SHOWN = 10;

const STATUS_SOURCE = 'release:deploy status';
const OWNERSHIP_SOURCE = 'gate.greenCheckpoint.ownership';

export interface GateWaitDeployLever {
  lever: string;
  available: boolean;
  /** Why it is (un)available — the trigger handler's own refusal text when refused. */
  reason: string;
}

export type GateWaitBriefFacts = {
  verdict: BriefField<'green' | 'red'>;
  judgedCandidate: BriefField<string>;
  greenPin: BriefField<string>;
  deployedSha: BriefField<string>;
  deployedBehindGreenPin: BriefField<number>;
  ownerClaimState: BriefField<string>;
  ownerWorkItem: BriefField<string | null>;
  checkpoint: BriefField<string>;
  deployTrigger: GateWaitDeployLever;
};

export type GateWaitOperationalBrief = OperationalBrief<GateWaitBriefFacts>;

export interface ProjectGateWaitBriefInput {
  status: DeployStatus;
  /** The ownership cell read beside the status; null/undefined when it was not read. */
  ownership: CellOwnership | null | undefined;
  /** Why the ownership read produced nothing, when it was attempted and failed. */
  ownershipReadError?: string;
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function shaField(sha: string | null, what: string): BriefField<string> {
  return sha ? known(sha, STATUS_SOURCE) : unknown(`${what} was not resolved by this read`);
}

function verdictField(gate: DeployStatus['gate']): BriefField<'green' | 'red'> {
  if (gate.verdictStale) {
    return unknown(`the last verdict is superseded or unverified: ${gate.verdictStaleReason ?? 'no reason recorded'}`);
  }
  if (gate.fireStale) {
    return unknown(`the green-checkpoint is not firing (${gate.fireStaleReason ?? 'stale'}); its counters describe the past`);
  }
  return known(gate.green ? 'green' : 'red', STATUS_SOURCE);
}

interface OwnerFields {
  owner: BriefField<string | null>;
  claimState: BriefField<string>;
  workItem: BriefField<string | null>;
}

function ownerFields(ownership: CellOwnership | null | undefined, readError?: string): OwnerFields {
  if (!ownership) {
    const reason = readError ?? 'gate ownership was not read on this call';
    return { owner: unknown(reason), claimState: unknown(reason), workItem: unknown(reason) };
  }
  if (ownership.unknown) {
    const detail = ownership.unknown.detail ? ` (${ownership.unknown.detail})` : '';
    const reason = `gate ownership unmeasured: ${ownership.unknown.code}${detail}`;
    return { owner: unknown(reason), claimState: unknown(reason), workItem: unknown(reason) };
  }
  const workItem = known(ownership.workItem, OWNERSHIP_SOURCE);
  const state = ownership.claimState;
  if (!state) {
    const reason = 'gate ownership returned no claim state';
    return { owner: unknown(reason), claimState: unknown(reason), workItem };
  }
  const claimState = known<string>(state, OWNERSHIP_SOURCE);
  if (state === 'held' || state === 'hold-blocked') {
    return {
      owner: ownership.takenBy
        ? known<string | null>(ownership.takenBy, OWNERSHIP_SOURCE)
        : unknown(`the gate item is ${state} but its holder is unreadable`),
      claimState,
      workItem,
    };
  }
  // no-object | claimable | lease-expired: measured, and nobody's claim protects the incident.
  return { owner: known<string | null>(null, OWNERSHIP_SOURCE), claimState, workItem };
}

function deployTriggerLever(status: DeployStatus): GateWaitDeployLever {
  const refusal = deployTriggerRefusalReason(status);
  if (refusal === null) {
    const behind = status.deploy.deployedBehindGreenPin;
    return {
      lever: DEPLOY_TRIGGER_LEVER,
      available: true,
      reason: `the green pin is ${behind ?? 'some'} commit(s) ahead of the live :3070 build`,
    };
  }
  return { lever: DEPLOY_TRIGGER_LEVER, available: false, reason: refusal };
}

function nextActionField(
  status: DeployStatus,
  trigger: GateWaitDeployLever,
  owner: OwnerFields,
  verdict: BriefField<'green' | 'red'>,
): BriefField<string> {
  if (trigger.available) return known(`${trigger.lever} — ${trigger.reason}`, STATUS_SOURCE);
  const inFlight = status.deployInFlight;
  if (inFlight?.active) {
    return known(
      `Wait for the running deploy (unit ${inFlight.unit}); do not trigger another — watch ${inFlight.logPath} or await release:deployed / deploy-failed.`,
      STATUS_SOURCE,
    );
  }
  // Owner-directed red advice only for a CURRENT red. A red counter from a checkpoint that is
  // not firing (or whose verdict is superseded) describes the past; the status read's own
  // recommendation already routes that case to recovering the producer.
  if (status.state === 'gate-red' && verdict.status === 'known' && verdict.value === 'red') {
    if (owner.owner.status === 'unknown') {
      return unknown(`the gate is red but its owner is unknown (${owner.owner.reason}); read ${OWNERSHIP_SOURCE} before acting`);
    }
    const item = owner.workItem.status === 'known' && owner.workItem.value ? owner.workItem.value : null;
    if (owner.owner.value) {
      return known(
        `The gate is red and ${owner.owner.value} owns it${item ? ` (${item})` : ''}. Send new evidence to the holder once with coord:send; do not claim the gate item, re-run the checkpoint, or deploy.`,
        OWNERSHIP_SOURCE,
      );
    }
    return known(
      `The gate is red and unowned. Claim ${item ?? 'the gate incident'}, fix the failing tests on staging, land the fixes with release:repair-queue { op:'admit', paths }, then run release:checkpoint-run.`,
      OWNERSHIP_SOURCE,
    );
  }
  return known(status.recommendation, STATUS_SOURCE);
}

function blockersField(status: DeployStatus): BriefField<string[]> {
  const gate = status.gate;
  const out: string[] = [];
  if (status.deployInFlight?.active) out.push(`deploy in flight (unit ${status.deployInFlight.unit})`);
  if (gate.fireStale) out.push(`green-checkpoint not firing: ${gate.fireStaleReason ?? 'stale'}`);
  if (gate.verdictStale) out.push(`gate verdict superseded or unverified: ${gate.verdictStaleReason ?? 'no reason recorded'}`);
  if (status.releaseTrigger.blocked) {
    out.push(`release-trigger blocked: ${status.releaseTrigger.blockReason ?? 'no reason recorded'}`);
  }
  if (status.checkpoint.blocker) out.push(`checkpoint: ${status.checkpoint.blocker}`);
  if (!gate.green && !gate.verdictStale && !gate.fireStale) {
    if (gate.failingTestsMeasured === false) {
      return unknown('the gate is red but its failing tests were not measured on this read');
    }
    if (gate.failingTests.length === 0) {
      out.push(`gate red (${gate.consecutiveReds} consecutive); no failing-test list on this read`);
    } else {
      const shown = gate.failingTests.slice(0, GATE_WAIT_FAILING_TESTS_SHOWN);
      out.push(...shown.map((test) => `failing: ${test}`));
      const rest = gate.failingTests.length - shown.length;
      if (rest > 0) out.push(`…and ${rest} more failing test file(s)`);
    }
  }
  return known(out, STATUS_SOURCE);
}

function deadlineField(status: DeployStatus, ownership: CellOwnership | null | undefined, owner: OwnerFields) {
  if (status.state === 'up-to-date') return known<string | null>(null, STATUS_SOURCE);
  if (owner.owner.status === 'known' && owner.owner.value && ownership?.expiresAt) {
    return known<string | null>(ownership.expiresAt, `${OWNERSHIP_SOURCE} lease expiry`);
  }
  return unknown<string | null>(
    "release status carries no wake deadline; the next verdict time is routines:list { name:'green-checkpoint' } nextFireAt",
  );
}

export function projectGateWaitOperationalBrief(input: ProjectGateWaitBriefInput): GateWaitOperationalBrief {
  const { status, ownership } = input;
  const gate = status.gate;
  const owner = ownerFields(ownership, input.ownershipReadError);
  const trigger = deployTriggerLever(status);
  const verdict = verdictField(gate);
  const last = gate.lastVerdict;
  return finalizeOperationalBrief<GateWaitBriefFacts>({
    surface: 'gate-wait',
    subject: GATE_WAIT_BRIEF_SUBJECT,
    state:
      status.state === 'unknown'
        ? unknown(`release status could not classify the deploy state${status.errors.length ? `: ${status.errors.join('; ')}` : ''}`)
        : known(status.state, STATUS_SOURCE),
    owner: owner.owner,
    nextAction: nextActionField(status, trigger, owner, verdict),
    blockers: blockersField(status),
    lastVerified: last
      ? known(
          {
            ref: `green-checkpoint verdict${last.candidate ? ` @ ${last.candidate}` : ''}`,
            at: iso(last.tickAtMs),
            summary: `gate verdict ${last.status}${gate.verdictStale ? ' (superseded or unverified)' : ''}`,
          },
          STATUS_SOURCE,
        )
      : unknown('no gate verdict is recorded on this read'),
    deadline: deadlineField(status, ownership, owner),
    facts: {
      verdict,
      judgedCandidate: last?.candidate
        ? known(last.candidate, STATUS_SOURCE)
        : unknown('the last verdict records no candidate sha'),
      greenPin: shaField(status.deploy.greenPinSha, 'the green pin (main)'),
      deployedSha: shaField(status.deploy.deployedSha, 'the live :3070 build sha'),
      deployedBehindGreenPin:
        typeof status.deploy.deployedBehindGreenPin === 'number'
          ? known(status.deploy.deployedBehindGreenPin, STATUS_SOURCE)
          : unknown('the distance from the live build to the green pin was not measured'),
      ownerClaimState: owner.claimState,
      ownerWorkItem: owner.workItem,
      checkpoint:
        status.checkpoint.state === 'unknown'
          ? unknown(`checkpoint execution unmeasured${status.checkpoint.probe.detail ? `: ${status.checkpoint.probe.detail}` : ''}`)
          : known(
              `${status.checkpoint.state}${status.checkpoint.phase ? ` (${status.checkpoint.phase})` : ''}`,
              STATUS_SOURCE,
            ),
      deployTrigger: trigger,
    },
  });
}

function fieldText<T>(field: BriefField<T>, format: (value: T) => string): string {
  return field.status === 'known' ? format(field.value) : `unknown (${field.reason})`;
}

/** Gate-specific lines appended to the shared rendering. */
export function renderGateWaitFactLines(brief: GateWaitOperationalBrief): string[] {
  const f = brief.facts;
  return [
    `verdict: ${fieldText(f.verdict, (v) => v)} · judged: ${fieldText(f.judgedCandidate, (v) => v.slice(0, 10))}`,
    `pin: main ${fieldText(f.greenPin, (v) => v.slice(0, 10))} · :3070 ${fieldText(f.deployedSha, (v) => v.slice(0, 10))} · behind ${fieldText(f.deployedBehindGreenPin, (v) => String(v))}`,
    `gate claim: ${fieldText(f.ownerClaimState, (v) => v)}${f.ownerWorkItem.status === 'known' && f.ownerWorkItem.value ? ` (${f.ownerWorkItem.value})` : ''}`,
    `deploy trigger: ${f.deployTrigger.available ? 'AVAILABLE' : 'unavailable'} — ${f.deployTrigger.reason}`,
  ];
}
