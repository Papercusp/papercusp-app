/**
 * A caller-side refusal: the request carries no attributable coordination identity.
 *
 * Thrown by `resolveAgentIdentity` (agent-tools/coordination/identity.ts) when the context has
 * no power-user / superuser / principal / verified-spawn identity. That is a property of the
 * REQUEST, not a server fault, so the route stack maps it to a typed 401 `identity_required`
 * instead of the generic 500 `handler_error` every other handler throw becomes
 * (EI-24708210960582152: an owner's unattributed HTTP call to
 * /api/agent-tools/triggers/create-webhook read as a server crash).
 *
 * Leaf module on purpose: route-stack.ts imports it, and it must not drag the coordination
 * module graph into every route.
 */
export class AgentIdentityRequiredError extends Error {
  readonly status = 401 as const;
  readonly code = 'identity_required' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AgentIdentityRequiredError';
  }
}
