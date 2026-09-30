/**
 * First-party context classes (portable-identity-packages-2026-09-26 P-005, D-039).
 *
 * The platform's own identity producers, published as capability classes. A
 * builtin provider contribution names one of these `class@major` refs plus its
 * contract verb instead of an internal function path (D-003). The class owns the
 * output schema. The first-party provider is the in-process producer named by
 * `providerRef`; its consumer computes the value and the identity binder checks it
 * against `outputSchema` before binding.
 *
 * This catalog is the single source for the builtin tier. It is not seeded into
 * the per-workspace `capability_class_registry`: the builtin tier is code. The
 * `papercusp` namespace is reserved, so a Cupboard class-contract import cannot
 * shadow it.
 */

export const FIRST_PARTY_CLASS_NAMESPACE = 'papercusp';

/** `text` binds a prompt-file contribution; `json` binds an operational setting. */
export type FirstPartyOutputKind = 'text' | 'json';

export interface FirstPartyContextClass {
  /** Namespaced class id, always in {@link FIRST_PARTY_CLASS_NAMESPACE}. */
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly verb: string;
  readonly outputKind: FirstPartyOutputKind;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  /** The conformed first-party provider: the in-process producer of this output. */
  readonly providerRef: string;
}

const TEXT_OUTPUT = { type: 'string', minLength: 1 } as const;

export const FIRST_PARTY_CONTEXT_CLASSES: readonly FirstPartyContextClass[] = [
  {
    id: 'papercusp.mode-state', version: '1.0.0', title: 'Current mode state', verb: 'read', outputKind: 'json',
    // The turn-start and orient readers bind the mode rows; goals:start binds the
    // successful set-mode receipt that established GOAL mode.
    outputSchema: {
      anyOf: [
        { type: 'array', items: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', minLength: 1 } } } },
        { type: 'object', required: ['ok'], properties: { ok: { const: true } } },
      ],
    },
    providerRef: 'first-party:modes/store:agent_modes',
  },
  {
    id: 'papercusp.current-assignment', version: '1.0.0', title: 'Current assignment', verb: 'read', outputKind: 'json',
    outputSchema: {
      type: 'object', required: ['ownerId'],
      properties: {
        ownerId: { type: 'string', minLength: 1 },
        intent: { type: ['string', 'null'] },
        currentPlanSlug: { type: ['string', 'null'] },
      },
    },
    providerRef: 'first-party:coord:presence',
  },
  {
    id: 'papercusp.coord-orientation', version: '1.0.0', title: 'Coordination orientation', verb: 'compose',
    outputKind: 'json',
    outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    providerRef: 'first-party:agent-tools/coordination/tools/orient:composeOrient',
  },
  {
    id: 'papercusp.fleet-leader-brief', version: '1.0.0', title: 'Fleet leader brief', verb: 'read', outputKind: 'json',
    outputSchema: { type: 'object', properties: { summary: { type: 'object' } } },
    providerRef: 'first-party:agent-tools/fleet/leader-brief:buildLeaderBrief',
  },
  {
    id: 'papercusp.turn-start-orientation', version: '1.0.0', title: 'Turn-start orientation block', verb: 'render',
    outputKind: 'text', outputSchema: TEXT_OUTPUT,
    providerRef: 'first-party:turn-start-orientation:buildTurnStartOrientationBlock',
  },
  {
    id: 'papercusp.goal-kickoff', version: '1.0.0', title: 'GOAL kickoff brief', verb: 'render', outputKind: 'text',
    outputSchema: TEXT_OUTPUT, providerRef: 'first-party:agent-tools/goals/start:buildGoalKickoffBrief',
  },
  {
    id: 'papercusp.goal-portfolio', version: '1.0.0', title: 'GOAL portfolio brief', verb: 'render', outputKind: 'text',
    outputSchema: TEXT_OUTPUT, providerRef: 'first-party:goal-launch-settings:renderGoalPortfolioBrief',
  },
  {
    id: 'papercusp.agent-obligations', version: '1.0.0', title: 'Turn-start obligations', verb: 'render',
    outputKind: 'text', outputSchema: TEXT_OUTPUT,
    providerRef: 'first-party:agent-obligation-reader:projectAgentTurnStartObligationBrief',
  },
];

/** The contribution input kind each output kind binds. */
export const FIRST_PARTY_INPUT_KIND: Readonly<Record<FirstPartyOutputKind, 'prompt-file' | 'setting'>> = {
  text: 'prompt-file',
  json: 'setting',
};

/** Resolve a `class@major` request to its first-party class, or null. */
export function resolveFirstPartyContextClass(classMajorRef: string): FirstPartyContextClass | null {
  const at = classMajorRef.lastIndexOf('@');
  if (at <= 0) return null;
  const id = classMajorRef.slice(0, at);
  const major = classMajorRef.slice(at + 1);
  return FIRST_PARTY_CONTEXT_CLASSES.find((entry) =>
    entry.id === id && entry.version.split('.')[0] === major) ?? null;
}

export function firstPartyClassRef(entry: FirstPartyContextClass): string {
  return `${entry.id}@${entry.version}`;
}
