/**
 * EI-23766133296678780: a fail-closed authority refusal must say what would LIFT it.
 *
 * Until this module the identity gate emitted `Identity capability (unresolved):
 * stale-artifact (<tool>)` — the STATE, with the lift condition and the observed
 * values both discarded at the denial site. That is how a session whose entire tool
 * surface was refused (`coord:orient` included) came up mute: nothing in the string
 * told the victim that the recovery door was still open, or that the fault was a
 * revision pair the HOST could prove equal. Recovery then needed an out-of-band
 * `sudo psql` write plus knowing which work-item described the bug.
 *
 * A refusal contract is three fields, carried on `obligations.capabilityUnsatisfied
 * .refusal` and rendered after the unchanged `Identity capability …: <cause> (<tool>)`
 * prefix (the tool-error classifier keys on that prefix, so it is never reworded):
 *   - `observed`          the values actually compared, so the reader can see WHY
 *   - `liftsWhen`         the concrete observable condition under which this lifts
 *   - `whoCanMakeItTrue`  who can satisfy it — act (self) or escalate (host/owner/…)
 *
 * This module is deliberately import-free apart from a type: the denial is emitted
 * from the gate that sits on the self-sealing path, and a contract table that could
 * itself fail to load would reproduce the exact fault it documents.
 *
 * Authority is untouched. A contract is DESCRIPTION; no field here widens anything
 * or alters a decision. The non-widening auto-converge half of the item already
 * lives at `healStaleArtifactFromLaunchRecord` (projected-tool-deps.ts,
 * EI-23703586803892464), where the predicate is host-written and unforgeable.
 */
import type { IdentityGrantFailureCause } from './blueprint-envelopes';
import type { RefusalActor, RefusalContract, RefusalObservation } from './refusal-contract-types';

// The shape lives in a dependency-free leaf so light prebundled modules can use it without
// this file's `blueprint-envelopes` import chain (see refusal-contract-types.ts). Re-exported
// so every existing importer of these names is unchanged.
export type { RefusalActor, RefusalContract, RefusalObservation };

/**
 * One entry per refusal cause. The `Record` key type is the exhaustiveness guard: a
 * new `IdentityGrantFailureCause` that omits its lift condition fails to compile, so
 * "a refusal with no lift condition" cannot be added by accident.
 */
export const IDENTITY_REFUSAL_LIFT: Readonly<Record<
  IdentityGrantFailureCause,
  { liftsWhen: string; whoCanMakeItTrue: readonly RefusalActor[] }
>> = {
  'stale-artifact': {
    liftsWhen:
      'the session\'s applied activation revision matches a receipt in its launch record. ' +
      'The recovery door stays open for this cause: call coord:orient { afterCompaction: true } ' +
      '(via tools:invoke { name: \'coord:orient\' } on a trimmed surface) to acknowledge it, ' +
      'and the gate converges applied to desired by itself when the launch record already admits desired',
    whoCanMakeItTrue: ['self', 'host'],
  },
  'no-launch-record': {
    liftsWhen:
      'an identity launch record is registered for this session. The host writes it at launch, ' +
      'not the session; coord:orient stays admitted meanwhile so the session can report the fault',
    whoCanMakeItTrue: ['host'],
  },
  'policy-unavailable': {
    liftsWhen:
      'the identity policy for this pot and role can be read again, or a ceiling policy is ' +
      'published for it. Usually transient infrastructure: retry shortly; if it persists, escalate',
    whoCanMakeItTrue: ['host', 'owner'],
  },
  'provider-unbound': {
    liftsWhen:
      'an active, conformance-passed provider is bound for the required capability class. ' +
      'Retrying cannot lift this: it needs a binding decision',
    whoCanMakeItTrue: ['owner'],
  },
  'provider-changed': {
    liftsWhen:
      'the provider this session was launched on matches the pot\'s current binding. ' +
      'Relaunch the session to pick up the new binding, or restore the previous binding',
    whoCanMakeItTrue: ['host', 'owner'],
  },
  'tool-unavailable': {
    liftsWhen:
      'the tool exists in the catalog this identity resolves against. A retired or misspelled ' +
      'name will not lift by retrying: find the current name with tools:find',
    whoCanMakeItTrue: ['self', 'host'],
  },
  'outside-ceiling': {
    liftsWhen:
      'the role\'s capability ceiling admits this tool. This is a statement about AUTHORITY, ' +
      'not state: it does not lift by retrying or converging, so escalate instead of working around it',
    whoCanMakeItTrue: ['owner'],
  },
};

/** The contract for a refusal cause, carrying whatever values the denial site compared. */
export function identityRefusalContract(
  cause: IdentityGrantFailureCause,
  observed: RefusalObservation = {},
): RefusalContract {
  const lift = IDENTITY_REFUSAL_LIFT[cause];
  return { observed, liftsWhen: lift.liftsWhen, whoCanMakeItTrue: lift.whoCanMakeItTrue };
}

/** `0c748b5c/9a3af46a` — enough of a `spec/state` revision pair to compare by eye. */
export function shortRevision(
  revision: { specificationRevision: string; stateRevision: string } | null | undefined,
): string | null {
  return revision ? `${revision.specificationRevision.slice(0, 8)}/${revision.stateRevision.slice(0, 8)}` : null;
}

/** Render the contract as a single line to append to the unchanged denial prefix. */
export function renderRefusalContract(contract: RefusalContract): string {
  const observed = Object.entries(contract.observed)
    .map(([key, value]) => `${key}=${value ?? 'none'}`)
    .join(' ');
  return (
    ` — lifts when: ${contract.liftsWhen}; who: ${contract.whoCanMakeItTrue.join('/')}` +
    (observed ? `; observed: ${observed}` : '')
  );
}
