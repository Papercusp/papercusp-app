/**
 * D-424 (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, P-326): the env a psu launch
 * carries so its PTY host runs the agent CLI as the customer workspace account.
 *
 * Deliberately tiny: launch-su imports it on every launch, so it must not pull in the hosted
 * runtime graph. The hosted runtime SETS the spec once at start
 * (`installHostedCustomerAgentIdentity`); desktop and dev never set it, so their psu launches
 * carry nothing extra and stay byte-identical.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import { AGENT_IDENTITY_SPEC_ENV, type AgentIdentitySpec } from '@papercusp/papercusp-shared/agent';

const state = pinModuleState('@papercusp/operator-core.hosted-agent-identity-psu-env', () => ({
  spec: undefined as string | undefined,
}));

/** Install (or clear, with undefined) the process-wide psu agent identity spec. */
export function setHostedAgentIdentityPsuSpec(spec: AgentIdentitySpec | undefined): void {
  state.spec = spec === undefined ? undefined : JSON.stringify(spec);
}

/** Env to merge into a psu launch: the spec when this operator is a hosted host, else nothing. */
export function hostedAgentIdentityPsuEnv(): Record<string, string> {
  return state.spec === undefined ? {} : { [AGENT_IDENTITY_SPEC_ENV]: state.spec };
}
