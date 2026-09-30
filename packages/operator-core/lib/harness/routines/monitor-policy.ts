/**
 * Typed admission policy for engine-managed monitor loops.
 *
 * A monitor is not ordinary recurring work: before a loop row may be created it
 * must identify the watched predicate, its stop condition, a finite quiet-wake
 * budget, and one durable authority.  The policy deliberately reuses the
 * existing work-item, fleet, turn-provenance, presence, and routine stores.
 */
import type { Sql } from 'postgres';
import { z } from 'zod';
import { OWNER_CANDIDATE_TURN_VERDICTS, quoteMatchesTurn } from '../../turn-provenance/turn-ref';
import { parseTurnRef } from '../../agent-tools/sessions/_shared';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { STALE_CLAIM_GRACE_MS } from '../../work-items-stale-claims';
// P-004 LOAD-GRAPH RAIL: the four I/O seams below (`agent-fleets-store`, `coordination/presence`,
// `work-items`, `pg-read-query`) are TYPE-ONLY here and are `await import(...)`-ed at their call
// sites instead. They are used ONLY inside async resolvers and inside the default-dependency
// lambdas, so nothing needs them at module-evaluation time.
//
// WHY THIS IS LOAD-BEARING, not style: a static value import of `coordination/presence` drags
// presence -> control-anchor -> presence-selfwake -> inbox-wake -> events/await/engine ->
// progress-lease -> predicate-watch -> projected-tool-deps -> capability-envelope/policy, and
// `capability-envelope/policy.ts` evaluates `AGENT_ROLES.filter(...)` at MODULE SCOPE. Any
// consumer that wants only this module's PURE half (parsePersistedMonitorConfig,
// decideMonitorAdmission) would otherwise pay for that whole chain — and any test that mocks
// `@papercusp/agent-mcp` without `AGENT_ROLES` fails on import alone. That is exactly how
// `continuity-probes.test.ts` broke when `harness/routines/loop.ts` began value-importing this
// module's parser (it had previously been an erased `import type`). Guarded by
// `monitor-policy-load-graph.test.ts` — keep these type-only.
import type { AgentFleetRecord } from '../../agent-fleets-store';
import type { PresenceRecord } from '../../agent-tools/coordination/presence';
import type { WorkItem } from '../../work-items';

export const MONITOR_NO_DELTA_BUDGET_DEFAULT = 1;
/** A monitor may be deliberately long-lived, but never unbounded. */
export const MONITOR_NO_DELTA_BUDGET_MAX = 100;

export const monitorAuthoritySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('work-item'),
      workItem: z
        .string()
        .min(3)
        .max(120)
        .describe('Existing nonterminal WI-/EI-/F- item already held by the loop owner.'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fleet-leader'),
      fleet: z
        .string()
        .min(1)
        .max(120)
        .describe('Durable agent_fleets slug whose registered, live leader is the loop owner.'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('owner-turn'),
      turnRef: z
        .string()
        .min(10)
        .max(300)
        .describe(
          'Canonical session_turn:<source-kind>:<full-session-id>:<turn-index> reference from this owner session.',
        ),
      quote: z
        .string()
        .min(3)
        .max(1000)
        .describe('Exact owner text authorizing this monitor; it must occur in the referenced turn.'),
    })
    .strict(),
]);

export const monitorArmConfigSchema = z
  .object({
    predicateKey: z
      .string()
      .min(1)
      .max(200)
      .describe('Canonical identity of the watched condition. Whitespace/case are normalized at admission.'),
    stopCondition: z.string().min(1).max(1000).describe('Concrete condition that ends this monitor.'),
    noDeltaBudget: z
      .number()
      .int()
      .min(1)
      .max(MONITOR_NO_DELTA_BUDGET_MAX)
      .default(MONITOR_NO_DELTA_BUDGET_DEFAULT)
      .describe(
        `Consecutive quiet wakes allowed before automatic standdown (default ${MONITOR_NO_DELTA_BUDGET_DEFAULT}, max ${MONITOR_NO_DELTA_BUDGET_MAX}).`,
      ),
    authority: monitorAuthoritySchema,
  })
  .strict();

export type MonitorArmConfigInput = z.input<typeof monitorArmConfigSchema>;
export type MonitorAuthority = z.infer<typeof monitorAuthoritySchema>;

export const persistedMonitorConfigSchema = z
  .object({
    predicateKey: z.string().min(1).max(200),
    stopCondition: z.string().min(1).max(1000),
    noDeltaBudget: z.number().int().min(1).max(MONITOR_NO_DELTA_BUDGET_MAX),
    remainingNoDeltaBudget: z.number().int().min(0).max(MONITOR_NO_DELTA_BUDGET_MAX),
    authority: monitorAuthoritySchema,
  })
  .strict();

export type PersistedMonitorConfig = z.infer<typeof persistedMonitorConfigSchema>;

export type MonitorAdmissionCode =
  | 'monitor_config_invalid'
  | 'monitor_work_item_not_found'
  | 'monitor_work_item_terminal'
  | 'monitor_authority_not_held'
  | 'monitor_peer_owned_progress'
  | 'monitor_fleet_not_found'
  | 'monitor_fleet_not_led'
  | 'monitor_fleet_leader_not_live'
  | 'monitor_owner_turn_invalid'
  | 'monitor_owner_turn_unverified'
  | 'monitor_owner_turn_not_owner'
  | 'monitor_owner_quote_mismatch'
  | 'monitor_duplicate_live_owner'
  | 'monitor_admission_unavailable';

export type MonitorAdmissionResult =
  | { allowed: true; config: PersistedMonitorConfig }
  | {
      allowed: false;
      code: MonitorAdmissionCode;
      message: string;
      details?: Record<string, unknown>;
    };

export interface MonitorAdmissionEvidence {
  workItem?: WorkItem | null;
  workItemHolderPresence?: PresenceRecord | null;
  fleet?: AgentFleetRecord | null;
  ownerPresence?: PresenceRecord | null;
  ownerTurn?: MonitorOwnerTurnEvidence | null;
  duplicateLiveOwnerId?: string | null;
}

export interface MonitorAdmissionDependencies {
  loadWorkItem(id: string, harness?: string): Promise<WorkItem | null>;
  loadPresence(ownerId: string): Promise<PresenceRecord | null>;
  loadFleet(workspaceId: string, fleetSlug: string): Promise<AgentFleetRecord | null>;
  verifyOwnerTurn(
    ownerId: string,
    workspaceId: string,
    turnRef: string,
    quote: string,
  ): Promise<MonitorOwnerTurnEvidence | null>;
  listActiveMonitorOwners(input: {
    workspaceId: string;
    predicateKey: string;
    excludeOwnerId: string;
  }): Promise<string[]>;
  nowMs(): number;
}

export interface MonitorOwnerTurnEvidence {
  ref: string;
  found: boolean;
  checked: boolean;
  ownerId: string | null;
  speaker: string | null;
  verdict: string | null;
  origin: string | null;
  quoteMatch: boolean | null;
}

function normalizeHumanText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Canonical identity shared by admission and the later event/loop dedup seam. */
export function normalizeMonitorPredicateKey(value: string): string | null {
  const normalized = normalizeHumanText(value).toLowerCase();
  if (!normalized || normalized.length > 200) return null;
  // Whitespace is normalized above; every other ASCII control byte is invalid
  // in an identity that will be compared and persisted.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

export function monitorPredicateDedupRefusal(
  normalizedPredicateKey: string | null,
  conflictingKind: 'monitor' | 'exact-await',
): { code: 'monitor_exact_await_duplicate'; message: string; details: { predicateKey: string; conflictingKind: string } } | null {
  if (!normalizedPredicateKey) return null;
  return {
    code: 'monitor_exact_await_duplicate',
    message:
      `Refusing duplicate monitoring for predicate ${normalizedPredicateKey}: this owner already has a live ${conflictingKind}. ` +
      'Keep the exact event await for an owner/leader when the event exists; otherwise cancel/end the existing registration first.',
    details: { predicateKey: normalizedPredicateKey, conflictingKind },
  };
}

export function prepareMonitorConfig(value: unknown): MonitorAdmissionResult {
  const parsed = monitorArmConfigSchema.safeParse(value);
  if (!parsed.success) {
    return {
      allowed: false,
      code: 'monitor_config_invalid',
      message: 'Monitor admission requires a typed predicate, stop condition, bounded no-delta budget, and authority.',
      details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    };
  }
  const predicateKey = normalizeMonitorPredicateKey(parsed.data.predicateKey);
  const stopCondition = normalizeHumanText(parsed.data.stopCondition);
  if (!predicateKey || !stopCondition) {
    return {
      allowed: false,
      code: 'monitor_config_invalid',
      message: 'Monitor predicateKey and stopCondition must remain non-empty after normalization.',
    };
  }

  const authority: MonitorAuthority =
    parsed.data.authority.kind === 'work-item'
      ? { kind: 'work-item', workItem: parsed.data.authority.workItem.trim().toUpperCase() }
      : parsed.data.authority.kind === 'fleet-leader'
        ? { kind: 'fleet-leader', fleet: parsed.data.authority.fleet.trim().toLowerCase() }
        : {
            kind: 'owner-turn',
            turnRef: parsed.data.authority.turnRef.trim(),
            quote: normalizeHumanText(parsed.data.authority.quote),
          };

  return {
    allowed: true,
    config: {
      predicateKey,
      stopCondition,
      noDeltaBudget: parsed.data.noDeltaBudget,
      remainingNoDeltaBudget: parsed.data.noDeltaBudget,
      authority,
    },
  };
}

export function parsePersistedMonitorConfig(value: unknown): PersistedMonitorConfig | null {
  const parsed = persistedMonitorConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The existing claim writer's newest claim/progress anchor within its 10m window. */
export function isLiveProgressingWorkItem(
  item: Pick<WorkItem, 'takenAt' | 'lastProgressAt'>,
  presence: Pick<PresenceRecord, 'stale'> | null | undefined,
  nowMs: number,
): boolean {
  if (!presence || presence.stale) return false;
  const anchors = [timestampMs(item.lastProgressAt), timestampMs(item.takenAt)].filter(
    (value): value is number => value != null,
  );
  return anchors.length > 0 && nowMs - Math.max(...anchors) <= STALE_CLAIM_GRACE_MS;
}

/** Pure authority + duplicate-owner verdict over already-resolved evidence. */
export function decideMonitorAdmission(input: {
  ownerId: string;
  config: PersistedMonitorConfig;
  evidence: MonitorAdmissionEvidence;
  nowMs: number;
}): MonitorAdmissionResult {
  const { ownerId, config, evidence, nowMs } = input;
  const authority = config.authority;

  if (authority.kind === 'work-item') {
    const item = evidence.workItem;
    if (!item) {
      return {
        allowed: false,
        code: 'monitor_work_item_not_found',
        message: `Monitor authority work-item ${authority.workItem} does not exist in the resolved harness.`,
      };
    }
    if (ANY_FAMILY_TERMINAL_STATES.includes(String(item.state))) {
      return {
        allowed: false,
        code: 'monitor_work_item_terminal',
        message: `Monitor authority work-item ${authority.workItem} is terminal (${item.state}).`,
      };
    }
    if (item.assignee !== ownerId) {
      if (item.assignee && isLiveProgressingWorkItem(item, evidence.workItemHolderPresence, nowMs)) {
        return {
          allowed: false,
          code: 'monitor_peer_owned_progress',
          message: `${authority.workItem} is already owned and progressing under live peer ${item.assignee}; do not create a parallel monitor.`,
          details: { holder: item.assignee, workItem: authority.workItem },
        };
      }
      return {
        allowed: false,
        code: 'monitor_authority_not_held',
        message: `Monitor authority work-item ${authority.workItem} is not already held by ${ownerId}.`,
        details: { holder: item.assignee },
      };
    }
  } else if (authority.kind === 'fleet-leader') {
    if (!evidence.fleet) {
      return {
        allowed: false,
        code: 'monitor_fleet_not_found',
        message: `Fleet ${authority.fleet} is not registered in this workspace.`,
      };
    }
    if (evidence.fleet.leaderOwnerId !== ownerId) {
      return {
        allowed: false,
        code: 'monitor_fleet_not_led',
        message: `${ownerId} is not the durable registered leader of fleet ${authority.fleet}.`,
        details: { registeredLeader: evidence.fleet.leaderOwnerId },
      };
    }
    if (!evidence.ownerPresence || evidence.ownerPresence.stale) {
      return {
        allowed: false,
        code: 'monitor_fleet_leader_not_live',
        message: `Fleet ${authority.fleet} names ${ownerId} as leader, but that leader has no live presence.`,
      };
    }
  } else {
    const verdict = evidence.ownerTurn;
    if (!verdict || !verdict.checked || !verdict.found) {
      return {
        allowed: false,
        code: 'monitor_owner_turn_unverified',
        message: `Owner-turn authority ${authority.turnRef} could not be resolved inside ${ownerId}'s session chain.`,
      };
    }
    if (verdict.ownerId !== ownerId) {
      return {
        allowed: false,
        code: 'monitor_owner_turn_not_owner',
        message: `Referenced turn ${authority.turnRef} belongs to ${verdict.ownerId ?? 'no resolved owner'}, not loop owner ${ownerId}.`,
        details: { recordedOwner: verdict.ownerId, loopOwner: ownerId },
      };
    }
    if (verdict.speaker !== 'user') {
      return {
        allowed: false,
        code: 'monitor_owner_turn_not_owner',
        message: `Referenced turn ${authority.turnRef} is a ${verdict.speaker ?? 'missing'} turn, not owner user speech.`,
      };
    }
    if (!verdict.verdict || !OWNER_CANDIDATE_TURN_VERDICTS.includes(verdict.verdict)) {
      return {
        allowed: false,
        code: 'monitor_owner_turn_not_owner',
        message: `Referenced turn ${authority.turnRef} is ${verdict.verdict ?? 'unclassified'}, not verified owner speech.`,
        details: { verdict: verdict.verdict, origin: verdict.origin },
      };
    }
    if (verdict.quoteMatch !== true) {
      return {
        allowed: false,
        code: 'monitor_owner_quote_mismatch',
        message: `The supplied monitor authorization quote does not occur in ${authority.turnRef}.`,
      };
    }
  }

  if (evidence.duplicateLiveOwnerId) {
    return {
      allowed: false,
      code: 'monitor_duplicate_live_owner',
      message: `Live owner ${evidence.duplicateLiveOwnerId} already has an active monitor for predicate ${config.predicateKey}.`,
      details: { ownerId: evidence.duplicateLiveOwnerId, predicateKey: config.predicateKey },
    };
  }

  return { allowed: true, config };
}

export async function listActiveMonitorOwnersForPredicate(
  input: { workspaceId: string; predicateKey: string; excludeOwnerId: string },
  opts: { sql?: Sql } = {},
): Promise<string[]> {
  const { boundedPgReadTxn } = await import('../../pg-read-query');
  const rows = await boundedPgReadTxn<Array<{ owner_id: string }>>(
    (tx) => tx`
      SELECT DISTINCT r.target_owner_id AS owner_id
        FROM harness_shared.routines r
       WHERE r.workspace_id = ${input.workspaceId}
         AND r.active = TRUE
         AND r.reschedule_interval_sec IS NOT NULL
         AND r.target_owner_id IS NOT NULL
         AND r.target_owner_id <> ${input.excludeOwnerId}
         AND r.payload_template->>'mode' = 'monitor'
         AND r.payload_template->'monitor'->>'predicateKey' = ${input.predicateKey}
       ORDER BY owner_id
       LIMIT 20
    `,
    { client: opts.sql },
  );
  return rows.map((row) => row.owner_id);
}

export async function hasActiveMonitorForOwnerPredicate(
  input: { workspaceId: string; ownerId: string; predicateKey: string },
  opts: { sql?: Sql } = {},
): Promise<boolean> {
  const normalized = normalizeMonitorPredicateKey(input.predicateKey);
  if (!normalized) return false;
  const { boundedPgReadTxn } = await import('../../pg-read-query');
  const rows = await boundedPgReadTxn<Array<{ found: number }>>(
    (tx) => tx`
      SELECT 1 AS found
        FROM harness_shared.routines r
       WHERE r.workspace_id = ${input.workspaceId}
         AND r.active = TRUE
         AND r.reschedule_interval_sec IS NOT NULL
         AND r.target_owner_id = ${input.ownerId}
         AND r.payload_template->>'mode' = 'monitor'
         AND r.payload_template->'monitor'->>'predicateKey' = ${normalized}
       LIMIT 1
    `,
    { client: opts.sql },
  );
  return rows.length > 0;
}

export async function readMonitorOwnerTurnEvidence(
  _ownerId: string,
  workspaceId: string,
  turnRef: string,
  quote: string,
  opts: { sql?: Sql } = {},
): Promise<MonitorOwnerTurnEvidence | null> {
  const parsed = parseTurnRef(turnRef);
  if (!parsed || !turnRef.startsWith('session_turn:')) return null;
  const { boundedPgReadTxn } = await import('../../pg-read-query');
  const rows = await boundedPgReadTxn<
    Array<{
      owner: string | null;
      speaker: string;
      text: string;
      turn_origin: string | null;
      turn_origin_verdict: string | null;
    }>
  >(
    (tx) => tx`
      SELECT owner, speaker, text, turn_origin, turn_origin_verdict
        FROM harness_shared.session_turns
       WHERE workspace_id IN (${workspaceId}, 'default')
         AND source_kind = ${parsed.sourceKind}
         AND session_id = ${parsed.sessionId}
         AND turn_idx = ${parsed.turnIdx}
       ORDER BY (workspace_id = ${workspaceId}) DESC
       LIMIT 1
    `,
    { client: opts.sql },
  );
  const row = rows[0];
  if (!row) {
    return {
      ref: turnRef,
      found: false,
      checked: true,
      ownerId: null,
      speaker: null,
      verdict: null,
      origin: null,
      quoteMatch: null,
    };
  }
  return {
    ref: turnRef,
    found: true,
    checked: true,
    ownerId: row.owner,
    speaker: row.speaker,
    verdict: row.turn_origin_verdict,
    origin: row.turn_origin,
    quoteMatch: quoteMatchesTurn(quote, row.text),
  };
}

const defaultMonitorAdmissionDependencies: MonitorAdmissionDependencies = {
  // Deferred imports (see the LOAD-GRAPH RAIL note at the top): these lambdas only ever run
  // on the resolved `admitMonitorArm` path, so the I/O modules load then, not at import time.
  loadWorkItem: async (id, harness) => (await import('../../work-items')).getWorkItem(id, harness),
  loadPresence: async (ownerId) =>
    (await import('../../agent-tools/coordination/presence')).getPresence(ownerId),
  loadFleet: async (workspaceId, fleetSlug) =>
    (await import('../../agent-fleets-store')).getFleet(workspaceId, fleetSlug),
  verifyOwnerTurn: readMonitorOwnerTurnEvidence,
  listActiveMonitorOwners: (input) => listActiveMonitorOwnersForPredicate(input),
  nowMs: () => Date.now(),
};

/** Resolve live evidence, fail closed on unreadable authority, then apply the pure policy. */
export async function admitMonitorArm(
  input: {
    ownerId: string;
    workspaceId: string;
    harness: string;
    monitor: unknown;
  },
  deps: MonitorAdmissionDependencies = defaultMonitorAdmissionDependencies,
): Promise<MonitorAdmissionResult> {
  const prepared = prepareMonitorConfig(input.monitor);
  if (!prepared.allowed) return prepared;
  const config = prepared.config;

  try {
    const evidence: MonitorAdmissionEvidence = {};
    if (config.authority.kind === 'work-item') {
      evidence.workItem = await deps.loadWorkItem(config.authority.workItem, input.harness);
      const holder = evidence.workItem?.assignee;
      if (holder && holder !== input.ownerId) {
        evidence.workItemHolderPresence = await deps.loadPresence(holder);
      }
    } else if (config.authority.kind === 'fleet-leader') {
      evidence.fleet = await deps.loadFleet(input.workspaceId, config.authority.fleet);
      evidence.ownerPresence = await deps.loadPresence(input.ownerId);
    } else {
      const parsed = parseTurnRef(config.authority.turnRef);
      if (!parsed || !config.authority.turnRef.startsWith('session_turn:')) {
        return {
          allowed: false,
          code: 'monitor_owner_turn_invalid',
          message:
            'owner-turn authority requires one canonical session_turn:<source-kind>:<full-session-id>:<turn-index> ref.',
        };
      }
      evidence.ownerTurn = await deps.verifyOwnerTurn(
        input.ownerId,
        input.workspaceId,
        config.authority.turnRef,
        config.authority.quote,
      );
    }

    const possibleDuplicates = await deps.listActiveMonitorOwners({
      workspaceId: input.workspaceId,
      predicateKey: config.predicateKey,
      excludeOwnerId: input.ownerId,
    });
    for (const peerOwnerId of possibleDuplicates) {
      const presence = await deps.loadPresence(peerOwnerId);
      if (presence && !presence.stale) {
        evidence.duplicateLiveOwnerId = peerOwnerId;
        break;
      }
    }

    return decideMonitorAdmission({
      ownerId: input.ownerId,
      config,
      evidence,
      nowMs: deps.nowMs(),
    });
  } catch (error) {
    return {
      allowed: false,
      code: 'monitor_admission_unavailable',
      message: `Monitor authority could not be verified; refusing before claim/routine mutation: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
