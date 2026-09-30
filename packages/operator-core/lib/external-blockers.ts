import {
  readEventConditionReachability,
  type ExternalConditionReachability,
} from './external-condition-reachability';

export type ExternalBlockerKind = 'event' | 'gate' | 'runtime' | 'human';

/** What capability is actually missing. The trigger shape (`kind`) and the
 * capability needed to clear it are deliberately separate: a `human` blocker
 * may be a standing approval AUTO already satisfies, or a physical device no
 * amount of authority can conjure. */
export type ExternalBlockerCapability =
  | 'approval-auto-clearable'
  | 'credential'
  | 'physical-device'
  | 'external-service-action'
  | 'live-dependency'
  | 'product-decision';

export type ExternalBlockerCapabilitySource = 'explicit' | 'inferred' | 'legacy-inferred';

export interface ExternalBlockerCapabilityPolicy {
  capability: ExternalBlockerCapability;
  autoClearable: boolean;
  requiresOwnerCapability: boolean;
  resolutionOwner:
    | 'agent-authority'
    | 'credential-provider'
    | 'device-holder'
    | 'external-operator'
    | 'dependency-owner'
    | 'product-owner';
  recommendedAction: string;
}

export const EXTERNAL_BLOCKER_CAPABILITIES = [
  'approval-auto-clearable',
  'credential',
  'physical-device',
  'external-service-action',
  'live-dependency',
  'product-decision',
] as const satisfies readonly ExternalBlockerCapability[];

const CAPABILITY_POLICIES: Record<ExternalBlockerCapability, Omit<ExternalBlockerCapabilityPolicy, 'capability'>> = {
  'approval-auto-clearable': {
    autoClearable: true,
    requiresOwnerCapability: false,
    resolutionOwner: 'agent-authority',
    recommendedAction: 'Under AUTO/DRAIN authority, record the approval and continue; otherwise request approval.',
  },
  credential: {
    autoClearable: false,
    requiresOwnerCapability: true,
    resolutionOwner: 'credential-provider',
    recommendedAction: 'Acquire the missing credential through the approved secret/configuration surface.',
  },
  'physical-device': {
    autoClearable: false,
    requiresOwnerCapability: true,
    resolutionOwner: 'device-holder',
    recommendedAction: 'A person with the physical device must perform or attest the interaction.',
  },
  'external-service-action': {
    autoClearable: false,
    requiresOwnerCapability: true,
    resolutionOwner: 'external-operator',
    recommendedAction: 'Use an authenticated integration or have the external service operator perform the action.',
  },
  'live-dependency': {
    autoClearable: false,
    requiresOwnerCapability: false,
    resolutionOwner: 'dependency-owner',
    recommendedAction: 'Await the declared event/gate or repair the stalled dependency; do not poll blindly.',
  },
  'product-decision': {
    autoClearable: false,
    requiresOwnerCapability: true,
    resolutionOwner: 'product-owner',
    recommendedAction:
      'Obtain or infer the product-direction decision according to the active operating-mode contract.',
  },
};

export function externalBlockerCapabilityPolicy(
  capability: ExternalBlockerCapability,
): ExternalBlockerCapabilityPolicy {
  return { capability, ...CAPABILITY_POLICIES[capability] };
}

export function inferExternalBlockerCapability(kind: ExternalBlockerKind): ExternalBlockerCapability {
  return kind === 'human' ? 'product-decision' : 'live-dependency';
}

export interface ExternalBlockerRecord {
  kind: ExternalBlockerKind;
  capability: ExternalBlockerCapability;
  capabilitySource: ExternalBlockerCapabilitySource;
  ref: string;
  summary: string;
  status: 'active' | 'cleared';
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  evidence?: string;
  nextVerb?: string;
  clearedAt?: string;
  clearedBy?: string;
  /** Advisory, evidence-bearing condition verdict. Absence means not measured. */
  reachability?: ExternalConditionReachability;
}

/** Preserve blocker history while attaching a separately resolved condition verdict. */
export function attachExternalBlockerReachability(
  blocker: ExternalBlockerRecord,
  reachability: ExternalConditionReachability,
): ExternalBlockerRecord {
  return { ...blocker, reachability };
}

/**
 * Resolve event/gate blockers through the existing event authority. Runtime and
 * human blockers keep an honest unmeasured shape until their own typed resolver
 * is supplied; they are never guessed from age or prose.
 */
export async function readExternalBlockersWithReachability(
  payload: unknown,
  opts: { resolveEvent?: typeof readEventConditionReachability } = {},
): Promise<ExternalBlockerRecord[]> {
  const resolveEvent = opts.resolveEvent ?? readEventConditionReachability;
  return Promise.all(
    readExternalBlockers(payload).map(async (blocker) => {
      if (blocker.kind !== 'event' && blocker.kind !== 'gate') return blocker;
      return attachExternalBlockerReachability(blocker, await resolveEvent(blocker.ref));
    }),
  );
}

/** Parse defensively because payload is federated/untrusted JSON. */
export function readExternalBlockers(payload: unknown): ExternalBlockerRecord[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const rows = (payload as Record<string, unknown>).externalBlockers;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): ExternalBlockerRecord[] => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const r = row as Record<string, unknown>;
    if (
      !['event', 'gate', 'runtime', 'human'].includes(String(r.kind)) ||
      typeof r.ref !== 'string' ||
      typeof r.summary !== 'string' ||
      (r.status !== 'active' && r.status !== 'cleared') ||
      typeof r.createdAt !== 'string' ||
      typeof r.createdBy !== 'string' ||
      typeof r.updatedAt !== 'string'
    )
      return [];
    const kind = r.kind as ExternalBlockerKind;
    const explicitCapability = EXTERNAL_BLOCKER_CAPABILITIES.includes(r.capability as ExternalBlockerCapability)
      ? (r.capability as ExternalBlockerCapability)
      : null;
    const source = explicitCapability
      ? ['explicit', 'inferred', 'legacy-inferred'].includes(String(r.capabilitySource))
        ? (r.capabilitySource as ExternalBlockerCapabilitySource)
        : 'explicit'
      : 'legacy-inferred';
    return [
      {
        ...(r as unknown as ExternalBlockerRecord),
        kind,
        capability: explicitCapability ?? inferExternalBlockerCapability(kind),
        capabilitySource: source,
      },
    ];
  });
}

export function activeExternalBlockers(payload: unknown): ExternalBlockerRecord[] {
  return readExternalBlockers(payload).filter((blocker) => blocker.status === 'active');
}

/** Pure history-preserving upsert. Clearing marks the record; it never deletes it,
 * and it never touches internal work-item dependency edges. */
export function updateExternalBlockerHistory(
  payload: unknown,
  input: {
    kind: ExternalBlockerKind;
    capability?: ExternalBlockerCapability;
    ref: string;
    summary?: string;
    evidence?: string;
    nextVerb?: string;
    clear?: boolean;
  },
  actor: string,
  now = new Date().toISOString(),
): { blockers: ExternalBlockerRecord[]; changed: boolean } {
  const blockers = readExternalBlockers(payload);
  const index = [...blockers]
    .map((row, i) => ({ row, i }))
    .reverse()
    .find(({ row }) => row.kind === input.kind && row.ref === input.ref && row.status === 'active')?.i;

  if (input.clear) {
    if (index === undefined) return { blockers, changed: false };
    const current = blockers[index]!;
    blockers[index] = {
      ...current,
      status: 'cleared',
      updatedAt: now,
      clearedAt: now,
      clearedBy: actor,
      ...(input.evidence ? { evidence: input.evidence } : {}),
    };
    return { blockers, changed: true };
  }

  if (index !== undefined) {
    const current = blockers[index]!;
    blockers[index] = {
      ...current,
      ...(input.capability ? { capability: input.capability, capabilitySource: 'explicit' as const } : {}),
      summary: input.summary?.trim() || current.summary,
      updatedAt: now,
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.nextVerb ? { nextVerb: input.nextVerb } : {}),
    };
    return { blockers, changed: true };
  }

  blockers.push({
    kind: input.kind,
    capability: input.capability ?? inferExternalBlockerCapability(input.kind),
    capabilitySource: input.capability ? 'explicit' : 'inferred',
    ref: input.ref,
    summary: input.summary?.trim() || `${input.kind} dependency: ${input.ref}`,
    status: 'active',
    createdAt: now,
    createdBy: actor,
    updatedAt: now,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.nextVerb ? { nextVerb: input.nextVerb } : {}),
  });
  const active = blockers.filter((row) => row.status === 'active');
  const cleared = blockers.filter((row) => row.status === 'cleared').slice(-40);
  return { blockers: [...cleared, ...active], changed: true };
}

/** Apply an update and mechanically consume standing approval under AUTO/DRAIN.
 * The just-cleared row remains in history, proving that authority — rather than
 * a missing credential/device — resolved the blocker. */
export function applyExternalBlockerUpdate(
  payload: unknown,
  input: Parameters<typeof updateExternalBlockerHistory>[1],
  actor: string,
  opts: { autoAuthority: boolean },
  now = new Date().toISOString(),
): { blockers: ExternalBlockerRecord[]; changed: boolean; autoCleared: boolean } {
  const first = updateExternalBlockerHistory(payload, input, actor, now);
  if (input.clear || input.capability !== 'approval-auto-clearable' || !opts.autoAuthority || !first.changed)
    return { ...first, autoCleared: false };

  const base =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const cleared = updateExternalBlockerHistory(
    { ...base, externalBlockers: first.blockers },
    {
      kind: input.kind,
      ref: input.ref,
      clear: true,
      evidence: input.evidence ?? 'Cleared by active AUTO/DRAIN standing authority.',
    },
    actor,
    now,
  );
  return { ...cleared, autoCleared: true };
}
