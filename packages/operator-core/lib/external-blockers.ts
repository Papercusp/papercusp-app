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

/**
 * WI-10005010 — the CLOSED vocabulary of defaults the blocker-default reaper may
 * execute on owner silence. Deliberately tiny: an agent acting on an owner's
 * silence is owner-authority semantics, so each member must be a no-regret move.
 *   - `stay_parked`        — no state change; the deadline is recorded as passed and
 *                            the owner card/digest re-surfaces the ask as 'applied'.
 *   - `release_to_agents`  — clear the human blocker and hand the item back to the
 *                            claimable pool; the blocker's free-text default is the
 *                            brief the next agent reads on history.
 * Anything else (free text, an unknown token) NEVER auto-executes.
 */
export const OWNER_ASK_DEFAULT_ACTIONS = ['stay_parked', 'release_to_agents'] as const;
export type OwnerAskDefaultAction = (typeof OWNER_ASK_DEFAULT_ACTIONS)[number];

export function isOwnerAskDefaultAction(value: unknown): value is OwnerAskDefaultAction {
  return typeof value === 'string' && (OWNER_ASK_DEFAULT_ACTIONS as readonly string[]).includes(value);
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
  /** Owner-attention ledger (EI-23783029010995961): what the system WILL do if the
   *  owner never answers this human ask — the load-bearing disclosure that turns
   *  "waiting forever, silently" into "proceeding as X unless you say otherwise".
   *  Required by `work_items:set_blocker` for owner-capability asks; legacy rows
   *  predate it, so it is optional on the record and readers must say "none
   *  declared" rather than invent one. */
  defaultIfUnanswered?: string;
  /** ISO timestamp when {@link defaultIfUnanswered} is intended to take effect. */
  decideBy?: string;
  /** WI-10005010: the TYPED, machine-executable form of {@link defaultIfUnanswered}.
   *  The free text is a disclosure to a human and is NEVER parsed; only this closed
   *  vocabulary may be executed by the blocker-default reaper once `decideBy` has
   *  passed. Absent => the declared default is disclosure-only and stays parked. */
  defaultAction?: OwnerAskDefaultAction;
  /** ISO timestamp the reaper applied {@link defaultAction}. Set exactly once; its
   *  presence is the idempotence fence (a second sweep never re-applies). */
  defaultAppliedAt?: string;
  defaultAppliedAction?: OwnerAskDefaultAction;
  clearedAt?: string;
  clearedBy?: string;
  /** Advisory, evidence-bearing condition verdict. Absence means not measured. */
  reachability?: ExternalConditionReachability;
}

/**
 * The owner-facing disclosure line for the active human asks on a work-item
 * payload, or null when it carries none. A row with no declared default is
 * reported as such — and told plainly that the item stays parked — so the owner
 * is never left to assume the system will act on its own. Pure.
 */
export function ownerAskDefaultDisclosure(payload: unknown): string | null {
  const human = activeExternalBlockers(payload).filter((blocker) => blocker.kind === 'human');
  if (human.length === 0) return null;
  const lines = human.map((blocker) => {
    const fallback = blocker.defaultIfUnanswered?.trim();
    const by = blocker.decideBy?.trim();
    if (blocker.defaultAppliedAt)
      return `Default APPLIED ${blocker.defaultAppliedAt} (${blocker.defaultAppliedAction ?? 'stay_parked'}): ${fallback || 'no free-text default'}; still parked until you answer.`;
    if (!fallback) return 'No default declared — the item stays parked until you answer.';
    return (
      `Default if unanswered: ${fallback}${by ? ` (decide by ${by})` : ''}` +
      (blocker.defaultAction ? ` [auto-applied as '${blocker.defaultAction}' after the deadline]` : '')
    );
  });
  return [...new Set(lines)].join('\n');
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
    defaultIfUnanswered?: string;
    decideBy?: string;
    /** WI-10005010: typed executable default; see {@link OWNER_ASK_DEFAULT_ACTIONS}. */
    defaultAction?: OwnerAskDefaultAction;
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
    // A re-declared deadline or typed action is a NEW contract: drop the applied
    // fence so the reaper may honour it once (never re-apply the OLD one).
    const rearmed = Boolean(input.decideBy?.trim() || input.defaultAction);
    const { defaultAppliedAt: _fenceAt, defaultAppliedAction: _fenceAction, ...unfenced } = current;
    void _fenceAt;
    void _fenceAction;
    blockers[index] = {
      ...(rearmed ? unfenced : current),
      ...(input.capability ? { capability: input.capability, capabilitySource: 'explicit' as const } : {}),
      ...(input.defaultAction ? { defaultAction: input.defaultAction } : {}),
      summary: input.summary?.trim() || current.summary,
      updatedAt: now,
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.nextVerb ? { nextVerb: input.nextVerb } : {}),
      ...(input.defaultIfUnanswered?.trim() ? { defaultIfUnanswered: input.defaultIfUnanswered.trim() } : {}),
      ...(input.decideBy?.trim() ? { decideBy: input.decideBy.trim() } : {}),
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
    ...(input.defaultIfUnanswered?.trim() ? { defaultIfUnanswered: input.defaultIfUnanswered.trim() } : {}),
    ...(input.decideBy?.trim() ? { decideBy: input.decideBy.trim() } : {}),
    ...(input.defaultAction ? { defaultAction: input.defaultAction } : {}),
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

export type BlockerDefaultSkipReason =
  | 'not-human'
  | 'not-active'
  | 'no-decide-by'
  | 'decide-by-unparseable'
  | 'deadline-not-reached'
  | 'no-typed-action'
  | 'already-applied';

export type BlockerDefaultDecision =
  | { apply: true; action: OwnerAskDefaultAction }
  | { apply: false; why: BlockerDefaultSkipReason };

/**
 * WI-10005010 — may the blocker-default reaper execute this human ask's default NOW?
 * Pure; mirrors `decideGateReap`'s shape. Rule order is load-bearing:
 *  1. only an ACTIVE `human` blocker is ever a candidate (never event/gate/runtime —
 *     those clear on their own condition, not on owner silence);
 *  2. an already-applied default is never re-applied (the exactly-once fence);
 *  3. no `decideBy` (or an unparseable one) => nothing to enforce;
 *  4. before the deadline => nothing to enforce;
 *  5. NO TYPED ACTION => skip. The free-text `defaultIfUnanswered` is a human
 *     disclosure and is never interpreted, so an agent can never act on an owner's
 *     silence by reading prose it did not author a closed meaning for.
 */
export function decideBlockerDefault(blocker: ExternalBlockerRecord, now: Date): BlockerDefaultDecision {
  if (blocker.kind !== 'human') return { apply: false, why: 'not-human' };
  if (blocker.status !== 'active') return { apply: false, why: 'not-active' };
  if (blocker.defaultAppliedAt) return { apply: false, why: 'already-applied' };
  const raw = blocker.decideBy?.trim();
  if (!raw) return { apply: false, why: 'no-decide-by' };
  const due = Date.parse(raw);
  if (!Number.isFinite(due)) return { apply: false, why: 'decide-by-unparseable' };
  if (now.getTime() < due) return { apply: false, why: 'deadline-not-reached' };
  if (!isOwnerAskDefaultAction(blocker.defaultAction)) return { apply: false, why: 'no-typed-action' };
  return { apply: true, action: blocker.defaultAction };
}

/**
 * Pure: record that `action` was applied to the one ACTIVE human blocker `ref`,
 * preserving history. `release_to_agents` also clears it (so the caller restores the
 * item's lifecycle); `stay_parked` leaves it active but fenced so it applies once.
 * Returns `changed:false` when no active, unapplied human blocker matches — which is
 * how a concurrent applier losing the race becomes a no-op.
 */
export function applyBlockerDefaultToHistory(
  payload: unknown,
  ref: string,
  action: OwnerAskDefaultAction,
  actor: string,
  now = new Date().toISOString(),
): { blockers: ExternalBlockerRecord[]; changed: boolean } {
  const blockers = readExternalBlockers(payload);
  const index = [...blockers]
    .map((row, i) => ({ row, i }))
    .reverse()
    .find(
      ({ row }) => row.kind === 'human' && row.ref === ref && row.status === 'active' && !row.defaultAppliedAt,
    )?.i;
  if (index === undefined) return { blockers, changed: false };
  const current = blockers[index]!;
  const note = `decideBy ${current.decideBy ?? '?'} passed with no owner answer; applied typed default '${action}'.`;
  blockers[index] = {
    ...current,
    updatedAt: now,
    defaultAppliedAt: now,
    defaultAppliedAction: action,
    evidence: current.evidence ? `${current.evidence}\n${note}` : note,
    ...(action === 'release_to_agents'
      ? { status: 'cleared' as const, clearedAt: now, clearedBy: actor }
      : {}),
  };
  return { blockers, changed: true };
}
