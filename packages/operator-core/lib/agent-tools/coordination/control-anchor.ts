/**
 * Compact durable CTRL anchor (agent-operability improvements P-013).
 *
 * This is a PROJECTION, not a second state authority. It reconciles the tiny
 * control facts an agent must not lose across compaction from their existing
 * canonical stores, then persists the projection on the existing durable
 * session_briefs row. A semantic change increments one monotonic generation;
 * an identical reconciliation does not. Consumers replace from the full
 * post-compaction anchor on any missing base/schema/generation mismatch and
 * never merge a generation-behind payload.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { withBoundedTimeout } from '../../bounded-timeout';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { getModes } from '../../modes/store';
import { getLoopStatus, type LoopStatus } from '../../harness/routines/loop';
import { latestFleetMembership } from '../../fleet-membership-store';
import { getSessionBrief, type SessionBriefLifecycle } from '../../session-brief';
import { notifyAgentOrdersChanged } from '../../agent-orders-notify';
import { fetchSelfWake, type SelfWakeSignals, type SelfWakeSource } from './presence-selfwake';
import { stackRefsForSession } from '../../stack-binding-channel';
import { trackDetached } from '../../detached-imports';
import {
  carryIdentityReceiptForControlActivation,
  parseSuLaunchSpecRecord,
  type SuLaunchSpecRecord,
} from '../../su-persona-render';
import type { SessionActivation } from '@papercusp/orchestrator/blueprint';
import type { SessionPackageFence } from '../../blueprint/session-package-resources';
import {
  desiredActivation,
  normalizeSessionActivation,
  requestActivation,
  restartActivation,
  type ActivationAttribution,
} from '../../session-activation';
import {
  recordCurrentSessionIdentityActivation,
  sessionIdentityStateRevision,
  type SessionIdentityActivationSource,
} from '../../session-identity-attribution';
import {
  readGoalHolderAuthority,
  type GoalHolderAuthority,
} from '../../goals/holder-authority';

export const CONTROL_ANCHOR_SCHEMA = 'ctrl-v1' as const;
export const CONTROL_TRANSITION_SCHEMA = 'ctrl-transition-v1' as const;
/**
 * D-008: duplication is allowed only under a measured, enforced budget.
 *
 * WI-10002024: the ceiling is ENFORCED AT BUILD TIME by the guard tests, not by
 * throwing at render time. An overflow at runtime is MARKED (`budget.overBudget`)
 * and still delivered — see `renderControlTransitionDelivery` for why that is the
 * only safe direction.
 *
 * 512 (was 384): a live session measured 351/384 with ONE mode and TWO stack
 * layers — 33 tokens of headroom — and a maximal state measured 406. P-021 adds
 * mode-axis stack layers, which grows exactly the field that overflows.
 */
export const CONTROL_ANCHOR_MAX_TOKENS = 512;
export const CONTROL_TRANSITION_MAX_TOKENS = 512;
const MAX_SCOPE_ITEMS = 12;
const MAX_ID_CHARS = 120;
const CONTROL_ANCHOR_REFRESH_TIMEOUT_MS = 20_000;
const CONTROL_ANCHOR_REFRESH_STATEMENT_TIMEOUT_MS = 8_000;
const CONTROL_ANCHOR_REFRESH_LOCK_TIMEOUT_MS = 4_000;

export interface ControlAnchorState {
  modes: string[];
  /** D-030/P-040: explicit desired/prepared/applied activation truth. */
  activation?: SessionActivation;
  /**
   * identities-v1 P-012 — the session's STACK BINDING: the identity layers bound beyond
   * the kernel, as `slot:id` refs (`fleet-posture:su.fleet-leader`). DERIVED from the
   * same authorities this anchor already projects (`route.role` → the fleet posture;
   * `modes` → one definition identity per mode axis, P-021) by
   * `stack-binding-channel.ts`, so a posture change bumps the generation exactly like a
   * mode flip; the turn-start hook then delivers the layer TEXT beside the `⟦CTRL⟧`
   * line. Present only when non-empty — costs nothing on the common unbound session.
   */
  stack?: string[];
  loop: { active: boolean; intervalSec: number | null };
  /**
   * WI-7302 part 2 — will ANYTHING wake this session unprompted?
   * `loop` (an armed engine loop) | `event` (a standing policy='wake' await) |
   * `none` (nothing will).
   *
   * Deliberately NOT derivable from `loop.active` above: a session correctly
   * parked on `events:await { work-item:claimable }` has `loop.active:false`
   * and is still perfectly wakeable. The member contract PRESCRIBES that park,
   * so treating !loop.active as "no wake source" would fire hardest at exactly
   * the sanctioned behaviour. See presence-selfwake.ts.
   *
   * OPTIONAL on purpose: absent = the leg was not resolved (UNKNOWN), never
   * `'none'`. Costs ~5 tokens against the anchor's 384 budget when present.
   */
  wakeSource?: SelfWakeSource;
  carry: 'warm' | 'cold';
  /**
   * Durable, re-derived stand-down instruction for an expired GOAL predecessor.
   * Omitted for every non-superseded session to keep the compact anchor small.
   * This is a projection of agent_modes election state, never a second lease.
   */
  goalAuthority?: {
    status: 'superseded';
    goalId: string;
    electedOwnerId: string | null;
    electedEpoch: number | null;
    handoffExpiresAt: string | null;
    standDown: true;
  };
  /** EI-203843: a durable fleet release marker carried by the compact anchor. */
  lifecycle?: SessionBriefLifecycle;
  route:
    | { kind: 'self' }
    | { kind: 'mug' }
    | { kind: 'fleet'; fleet: string; role: string | null };
  scope: {
    workspace: string;
    harness: string | null;
    plan: string | null;
    items: string[];
    itemsMore?: number;
  };
}

export interface ControlAnchor {
  schemaVersion: typeof CONTROL_ANCHOR_SCHEMA;
  generation: number;
  /** Stable fingerprint of the normalized semantic state. Generation is a
   * delivery/version counter and may advance for a byte-identical activation. */
  stateHash?: string;
  state: ControlAnchorState;
  provenance: {
    source: 'harness_shared.session_briefs.control_state';
    ownerId: string;
    updatedAt: string;
  };
  resync: {
    on: readonly ['missing-base', 'schema-mismatch', 'generation-mismatch'];
    verb: 'coord:orient';
    args: { afterCompaction: true };
    rule: 'replace-full-never-merge-behind';
  };
  budget: {
    estimatedTokens: number;
    maxTokens: number;
    /**
     * WI-10002024: set when the render exceeded `maxTokens`. The block is still
     * delivered — an overflow is REPORTED, never enforced by deletion.
     */
    overBudget?: true;
  };
}

export type ControlTransitionOrigin = 'owner' | 'agent' | 'system';

export interface ControlTransitionProvenance {
  origin: ControlTransitionOrigin;
  actorId: string;
  source: 'mode:set' | 'loop:arm' | 'loop:end' | 'loop:transfer' | 'fleet:membership' | 'control-anchor:reconcile' | 'session:activation';
  ownerDirected: boolean;
  recordedAt: string;
}

export interface ControlTransition {
  schemaVersion: typeof CONTROL_TRANSITION_SCHEMA;
  /** The owner/session this transition was produced for, not merely its actor. */
  targetOwnerId: string;
  previousGeneration: number;
  generation: number;
  /** Stable fingerprint of `state`; optional for legacy persisted transitions. */
  stateHash?: string;
  state: ControlAnchorState;
  /**
   * P-012: the `stack` refs of the generation this transition REPLACES (stamped by
   * `persistControlAnchor` from the previous row), so the turn-start hook can diff
   * before → after into attach / detach payloads. ABSENT on a full-resync (unknown
   * predecessor) — the channel then re-delivers every bound layer.
   */
  stackBefore?: string[];
  provenance: ControlTransitionProvenance;
  resync: {
    verb: 'coord:orient';
    args: { afterCompaction: true };
    rule: 'replace-full-never-merge-behind';
  };
}

export interface ControlTransitionDelivery extends ControlTransition {
  kind: 'transition' | 'full-resync';
  reason:
    | 'next-generation'
    | 'missing-transition'
    | 'schema-mismatch'
    | 'generation-mismatch'
    | 'owner-mismatch';
  budget: {
    estimatedTokens: number;
    maxTokens: number;
    /**
     * WI-10002024: set when the render exceeded `maxTokens`. The block is still
     * delivered — an overflow is REPORTED, never enforced by deletion.
     */
    overBudget?: true;
  };
}

interface PersistedControlAnchor {
  generation: number;
  state: ControlAnchorState;
  updatedAt: string;
  transition: ControlTransition | null;
}

interface ScopeClaimRow {
  harness_slug: string;
  plan_slug: string;
  item_id: string;
  /**
   * Is the coordination LEASE still in force (`expires_ts > now`)? False means
   * the lease lapsed — peers may take the item — but NOT that this agent stopped
   * working it. See the query in `buildControlAnchorState` for why self-scope
   * deliberately keeps a lapsed row.
   */
  lease_valid: boolean;
}

/** What the claim rows say this agent's own lane is. */
export interface DerivedClaimScope {
  harness: string | null;
  plan: string | null;
  items: string[];
  /** Items whose coordination lease has lapsed — still ours, but re-claim before editing. */
  lapsed: string[];
}

/**
 * Derive an agent's OWN plan lane from its claim rows. Pure so the rule is
 * testable without PG — the guard that matters is the regression below.
 *
 * `briefPlanSlug` (the session brief's durable current plan) wins when set;
 * otherwise the lane is inferred from the claims themselves, which is what lets
 * a respawned agent recover its mission when the brief has not been rewritten
 * yet.
 *
 * ⚠ A LAPSED LEASE IS STILL OUR LANE. Rows arrive here unfiltered by
 * `expires_ts` on purpose (see the query in `buildControlAnchorState`): expiry
 * governs whether a PEER may take the item, not whether WE were working it.
 * Dropping lapsed rows here is what made a live agent's mission vanish
 * mid-flight (2026-08-10).
 */
export function deriveClaimScope(
  claims: readonly ScopeClaimRow[],
  briefPlanSlug: string | null | undefined,
  briefHarnessSlug: string | null | undefined,
): DerivedClaimScope {
  // The brief is a durable hint, but a held claim is the live lane authority.
  // If a stale brief names a control/objective plan that has no matching claim,
  // following it hides the actual plan and items from the successor. Keep the
  // brief plan only when there are no claims to contradict it.
  const briefPlanClaims = briefPlanSlug
    ? claims.filter((c) => c.plan_slug === briefPlanSlug)
    : [];
  const claimPlan = claims[0]?.plan_slug ?? null;
  const selectedPlan = briefPlanClaims.length > 0
    ? briefPlanSlug!
    : claimPlan ?? briefPlanSlug ?? null;
  const planClaims = selectedPlan
    ? claims.filter((c) => c.plan_slug === selectedPlan)
    : [];
  const chosen = planClaims[0] ?? claims[0] ?? null;
  return {
    harness: briefHarnessSlug ?? chosen?.harness_slug ?? null,
    plan: selectedPlan,
    items: planClaims.map((c) => c.item_id),
    lapsed: planClaims.filter((c) => !c.lease_valid).map((c) => c.item_id),
  };
}

function cap(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, MAX_ID_CHARS);
}

/** Stable semantic form: sorted/deduped modes + items, bounded identifiers. */
export function normalizeControlAnchorState(input: ControlAnchorState): ControlAnchorState {
  const allItems = [...new Set(input.scope.items.map(String))].sort();
  const items = allItems.slice(0, MAX_SCOPE_ITEMS).map((v) => v.slice(0, MAX_ID_CHARS));
  const route = input.route.kind === 'fleet'
    ? {
        kind: 'fleet' as const,
        fleet: input.route.fleet.slice(0, MAX_ID_CHARS),
        role: cap(input.route.role),
      }
    : input.route;
  const released = input.lifecycle?.released;
  const goalAuthority = input.goalAuthority?.status === 'superseded' && input.goalAuthority.goalId
    ? {
        status: 'superseded' as const,
        goalId: input.goalAuthority.goalId.slice(0, MAX_ID_CHARS),
        electedOwnerId: cap(input.goalAuthority.electedOwnerId),
        electedEpoch: input.goalAuthority.electedEpoch == null
          ? null
          : Math.max(0, Math.floor(input.goalAuthority.electedEpoch)),
        handoffExpiresAt: cap(input.goalAuthority.handoffExpiresAt),
        standDown: true as const,
      }
    : undefined;
  const stack = [...new Set((input.stack ?? []).map(String))].sort().map((v) => v.slice(0, MAX_ID_CHARS));
  const activation = normalizeSessionActivation(input.activation);
  return {
    modes: [...new Set(input.modes.map(String))].sort().map((v) => v.slice(0, 40)),
    ...(activation ? { activation } : {}),
    // P-012: spread-when-present — an unbound session carries no `stack` key at all.
    ...(stack.length ? { stack } : {}),
    loop: {
      active: Boolean(input.loop.active),
      intervalSec: input.loop.intervalSec == null ? null : Math.max(0, Math.floor(input.loop.intervalSec)),
    },
    // WI-7302: spread-when-present so UNKNOWN stays absent rather than being
    // normalized into a `'none'` that would read as a positive finding.
    ...(input.wakeSource ? { wakeSource: input.wakeSource } : {}),
    carry: input.carry === 'cold' ? 'cold' : 'warm',
    ...(goalAuthority ? { goalAuthority } : {}),
    ...(released?.fleet && released.at && released.by
      ? {
          lifecycle: {
            released: {
              fleet: released.fleet.slice(0, MAX_ID_CHARS),
              at: released.at.slice(0, MAX_ID_CHARS),
              by: released.by.slice(0, MAX_ID_CHARS),
            },
          },
        }
      : {}),
    route,
    scope: {
      workspace: input.scope.workspace.slice(0, MAX_ID_CHARS),
      harness: cap(input.scope.harness),
      plan: cap(input.scope.plan),
      items,
      ...(allItems.length > items.length ? { itemsMore: allItems.length - items.length } : {}),
    },
  };
}

/** Pure projection used by the live reconciler and focused acceptance tests. */
export function projectGoalHolderAuthority(
  authority: GoalHolderAuthority,
): ControlAnchorState['goalAuthority'] {
  if (authority.status !== 'superseded' || !authority.goalId) return undefined;
  return {
    status: 'superseded',
    goalId: authority.goalId,
    electedOwnerId: authority.electedOwnerId,
    electedEpoch: authority.electedEpoch,
    handoffExpiresAt: authority.handoffExpiresAt,
    standDown: true,
  };
}

/** Conservative token estimate used only for the hard compactness budget. */
export function estimateControlAnchorTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);
}

/**
 * Hash the normalized semantic control state, excluding delivery metadata such
 * as generation and timestamps. A carry marker and a later CTRL block can use
 * this to distinguish a real state change from a generation-only activation
 * churn (for example a carry-respawn restart).
 */
export function controlStateHash(state: ControlAnchorState): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeControlAnchorState(state)), 'utf8')
    .digest('hex');
}

const TRANSITION_RESYNC = {
  verb: 'coord:orient' as const,
  args: { afterCompaction: true as const },
  rule: 'replace-full-never-merge-behind' as const,
};

function defaultTransitionProvenance(ownerId: string): ControlTransitionProvenance {
  return {
    origin: 'system',
    actorId: ownerId,
    source: 'control-anchor:reconcile',
    ownerDirected: false,
    recordedAt: new Date().toISOString(),
  };
}

export function renderControlTransitionDelivery(
  input: Omit<ControlTransitionDelivery, 'budget'>,
): ControlTransitionDelivery {
  const state = normalizeControlAnchorState(input.state);
  const base = {
    ...input,
    state,
    stateHash: input.stateHash ?? controlStateHash(state),
  };
  let estimatedTokens = estimateControlAnchorTokens({
    ...base,
    budget: { estimatedTokens: 0, maxTokens: CONTROL_TRANSITION_MAX_TOKENS },
  });
  estimatedTokens = estimateControlAnchorTokens({
    ...base,
    budget: { estimatedTokens, maxTokens: CONTROL_TRANSITION_MAX_TOKENS },
  });
  // WI-10002024: MARK an overflow; never throw it away.
  //
  // A throw here does not surface the overflow to anyone — `turn-start-memory`'s
  // controlPromise swallows it to keep the prompt alive, so the failure is SILENT
  // and total: the entire ⟦CTRL⟧ block disappears, taking the authority state and
  // the generation-mismatch signal with it. That signal is the carry marker's only
  // escape hatch (WI-10002017), and losing it is what bricked a session's whole
  // tool surface in WI-10002005.
  //
  // The costs are asymmetric and one-directional: a few dozen tokens over budget
  // harms nothing, while deleting the block blinds the session. So the guard must
  // never be able to cost more than the thing it is rationing.
  //
  // This does NOT make the block unbounded. Size is capped by construction in
  // `normalizeControlAnchorState` (MAX_SCOPE_ITEMS, MAX_ID_CHARS) — that cap, not
  // this branch, is what actually keeps the render small. The ceiling itself is
  // enforced at BUILD time by the guard tests, where a failure informs a developer
  // who can act on it instead of blinding an agent who cannot.
  const overBudget = estimatedTokens > CONTROL_TRANSITION_MAX_TOKENS;
  return {
    ...base,
    budget: {
      estimatedTokens,
      maxTokens: CONTROL_TRANSITION_MAX_TOKENS,
      ...(overBudget ? { overBudget: true as const } : {}),
    },
  };
}

/** Pure ordering decision. Never returns a generation-behind transition. */
export function decideControlTransitionDelivery(input: {
  ownerId: string;
  deliveredGeneration: number;
  generation: number;
  state: ControlAnchorState;
  transition: ControlTransition | null;
  updatedAt: string;
}): ControlTransitionDelivery {
  const pending = input.transition;
  const targetMatches = pending?.targetOwnerId === input.ownerId;
  const exactNext =
    pending?.schemaVersion === CONTROL_TRANSITION_SCHEMA &&
    targetMatches &&
    pending.previousGeneration === input.deliveredGeneration &&
    pending.generation === input.generation;
  if (exactNext) {
    return renderControlTransitionDelivery({
      ...pending,
      kind: 'transition',
      reason: 'next-generation',
    });
  }
  const reason: ControlTransitionDelivery['reason'] = !pending
    ? 'missing-transition'
    : pending.schemaVersion !== CONTROL_TRANSITION_SCHEMA
      ? 'schema-mismatch'
      : !targetMatches
        ? 'owner-mismatch'
      : 'generation-mismatch';
  // Reject the pending payload wholesale. Full-state replacement is built
  // from the current authoritative anchor row, never the stale transition.
  return renderControlTransitionDelivery({
    schemaVersion: CONTROL_TRANSITION_SCHEMA,
    targetOwnerId: input.ownerId,
    kind: 'full-resync',
    reason,
    previousGeneration: input.deliveredGeneration,
    generation: input.generation,
    state: input.state,
    provenance:
      pending?.generation === input.generation && targetMatches
        ? pending.provenance
        : {
            ...defaultTransitionProvenance(input.ownerId),
            recordedAt: input.updatedAt,
          },
    resync: TRANSITION_RESYNC,
  });
}

export function renderControlAnchor(input: {
  ownerId: string;
  generation: number;
  state: ControlAnchorState;
  updatedAt: string;
}): ControlAnchor {
  const state = normalizeControlAnchorState(input.state);
  const base = {
    schemaVersion: CONTROL_ANCHOR_SCHEMA,
    generation: input.generation,
    stateHash: controlStateHash(state),
    state,
    provenance: {
      source: 'harness_shared.session_briefs.control_state' as const,
      ownerId: input.ownerId,
      updatedAt: input.updatedAt,
    },
    resync: {
      on: ['missing-base', 'schema-mismatch', 'generation-mismatch'] as const,
      verb: 'coord:orient' as const,
      args: { afterCompaction: true as const },
      rule: 'replace-full-never-merge-behind' as const,
    },
  };
  // Include the budget record itself in the measurement. One second pass makes
  // the estimate exact for the final digit width without an unbounded loop.
  let estimatedTokens = estimateControlAnchorTokens({
    ...base,
    budget: { estimatedTokens: 0, maxTokens: CONTROL_ANCHOR_MAX_TOKENS },
  });
  estimatedTokens = estimateControlAnchorTokens({
    ...base,
    budget: { estimatedTokens, maxTokens: CONTROL_ANCHOR_MAX_TOKENS },
  });
  // WI-10002024: mark, never throw — full rationale on the transition renderer
  // above. The anchor is the steady-state block `coord:orient` hands back, so
  // destroying it on overflow blinds the agent to its own authority at exactly the
  // moment that authority is most complex.
  const overBudget = estimatedTokens > CONTROL_ANCHOR_MAX_TOKENS;
  return {
    ...base,
    budget: {
      estimatedTokens,
      maxTokens: CONTROL_ANCHOR_MAX_TOKENS,
      ...(overBudget ? { overBudget: true as const } : {}),
    },
  };
}

/**
 * Atomically persist one semantic projection. The row's generation advances
 * only when jsonb structural equality says the state changed.
 */
export async function persistControlAnchor(
  input: {
    ownerId: string;
    workspaceId: string;
    state: ControlAnchorState;
    transition?: Omit<ControlTransitionProvenance, 'recordedAt'> & { recordedAt?: string };
  },
  sql: Sql = getOrgPg().sql,
): Promise<PersistedControlAnchor> {
  const state = normalizeControlAnchorState(input.state);
  const stateJson = JSON.stringify(state);
  const provenance: ControlTransitionProvenance = {
    ...(input.transition ?? defaultTransitionProvenance(input.ownerId)),
    recordedAt: input.transition?.recordedAt ?? new Date().toISOString(),
  };
  const initialTransition: ControlTransition = {
    schemaVersion: CONTROL_TRANSITION_SCHEMA,
    targetOwnerId: input.ownerId,
    previousGeneration: 0,
    generation: 1,
    state,
    // P-012: a first generation replaces nothing; on conflict the SQL below overwrites
    // this with the PREVIOUS row's `stack` so the hook can diff the binding.
    stackBefore: [],
    provenance,
    resync: TRANSITION_RESYNC,
  };
  const transitionJson = JSON.stringify(initialTransition);
  const rows = await sql<Array<{
    control_generation: number | string;
    control_state: ControlAnchorState;
    control_updated_at: Date | string;
    control_transition: ControlTransition | null;
  }>>`
    INSERT INTO harness_shared.session_briefs
      (owner_id, workspace_id, control_generation, control_state, control_updated_at, control_transition)
    VALUES (${input.ownerId}, ${input.workspaceId}, 1, ${stateJson}::text::jsonb, now(), ${transitionJson}::text::jsonb)
    ON CONFLICT (owner_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      control_transition = CASE
        WHEN harness_shared.session_briefs.control_state IS DISTINCT FROM EXCLUDED.control_state
          THEN jsonb_set(
            jsonb_set(
              jsonb_set(EXCLUDED.control_transition, '{previousGeneration}', to_jsonb(harness_shared.session_briefs.control_generation), true),
              '{generation}', to_jsonb(harness_shared.session_briefs.control_generation + 1), true
            ),
            '{stackBefore}', COALESCE(harness_shared.session_briefs.control_state->'stack', '[]'::jsonb), true
          )
        ELSE harness_shared.session_briefs.control_transition
      END,
      control_generation = CASE
        WHEN harness_shared.session_briefs.control_state IS DISTINCT FROM EXCLUDED.control_state
          THEN harness_shared.session_briefs.control_generation + 1
        ELSE harness_shared.session_briefs.control_generation
      END,
      control_updated_at = CASE
        WHEN harness_shared.session_briefs.control_state IS DISTINCT FROM EXCLUDED.control_state
          THEN now()
        ELSE harness_shared.session_briefs.control_updated_at
      END,
      control_state = EXCLUDED.control_state
    RETURNING control_generation, control_state, control_updated_at, control_transition
  `;
  const row = rows[0];
  if (!row) throw new Error('control_anchor_persist_returned_no_row');
  // WI-6974 — push the Orders panel ONLY when the control state actually moved.
  //
  // This is the whole argument for a producer push over a `session_briefs` row
  // trigger. `persistControlAnchor` runs on essentially every orient, and the
  // upsert above deliberately treats an unchanged state as a no-op (the three
  // `IS DISTINCT FROM` CASEs). A trigger fires on the UPDATE regardless, so it
  // would push every open Orders panel on every agent's every wake — a timer,
  // not an orders change.
  //
  // Detecting "did it move" needs no extra query: on a real change the row keeps
  // OUR transition (EXCLUDED.control_transition, with the generations jsonb_set
  // onto it), so its provenance.recordedAt is the one we just minted; on a no-op
  // it keeps the PREVIOUS transition, recorded at an earlier instant. Comparing
  // generation numbers cannot distinguish them — the stored transition's
  // `generation` equals `control_generation` in BOTH cases.
  const persistedAt = row.control_transition?.provenance?.recordedAt;
  if (persistedAt === provenance.recordedAt) await notifyAgentOrdersChanged(input.ownerId);
  return {
    generation: Number(row.control_generation),
    state: normalizeControlAnchorState(row.control_state),
    updatedAt: new Date(row.control_updated_at).toISOString(),
    transition: row.control_transition ?? null,
  };
}

/**
 * Read the newest undelivered generation for the turn-start hook.
 *
 * This is intentionally the first phase of delivery, not the acknowledgement:
 * stack rendering happens after this query and can fail softly. The caller must
 * acknowledge the returned generation only after it has assembled the complete
 * prompt block; otherwise a render failure would advance the watermark while
 * the stack layer was never delivered.
 */
export async function preparePendingControlTransition(
  ownerId: string,
  workspaceId: string,
  sql: Sql = getOrgPg().sql,
): Promise<ControlTransitionDelivery | null> {
  const rows = await sql<Array<{
    control_generation: number | string;
    control_state: ControlAnchorState;
    control_updated_at: Date | string | null;
    control_transition: ControlTransition | null;
    delivered_generation: number | string;
  }>>`
    SELECT owner_id, control_generation, control_state, control_updated_at,
           control_transition, control_delivered_generation AS delivered_generation
      FROM harness_shared.session_briefs
     WHERE owner_id = ${ownerId} AND workspace_id = ${workspaceId}
       AND control_state IS NOT NULL
       AND control_generation > control_delivered_generation
     FOR UPDATE
  `;
  const row = rows[0];
  if (!row) return null;
  return decideControlTransitionDelivery({
    ownerId,
    deliveredGeneration: Number(row.delivered_generation),
    generation: Number(row.control_generation),
    state: row.control_state,
    transition: row.control_transition,
    updatedAt: row.control_updated_at
      ? new Date(row.control_updated_at).toISOString()
      : new Date().toISOString(),
  });
}

/** Persist the prepared phase after the complete stack/render validation succeeds. */
export async function markControlTransitionPrepared(
  ownerId: string,
  workspaceId: string,
  generation: number,
  revision: SessionActivation['desired'],
  sql: Sql = getOrgPg().sql,
): Promise<boolean> {
  const rev = JSON.stringify({ specificationRevision: revision.specificationRevision, stateRevision: revision.stateRevision });
  return await sql.begin(async (tx) => {
    // WI-10003464: a generation that does not change the identity (a loop, scope
    // or reconcile bump) re-delivers an activation that is ALREADY applied. Like
    // the pure prepareActivation, that is a no-op: re-marking it 'prepared' made
    // status read 'prepared' with desired == prepared == applied between turns.
    // Only status 'applied' qualifies — a carry-respawn restart sets 'desired'
    // with the same revision and MUST still prepare + acknowledge, so the
    // successor native session records its own applied receipt.
    const rows = await tx<Array<{ control_generation: number | string; already_applied: boolean }>>`
      UPDATE harness_shared.session_briefs
         SET control_state = CASE
           WHEN control_state->'activation'->>'status' = 'applied'
            AND control_state->'activation'->'applied'->>'specificationRevision' = ${revision.specificationRevision}
            AND control_state->'activation'->'applied'->>'stateRevision' = ${revision.stateRevision}
           THEN control_state
           ELSE jsonb_set(
             jsonb_set(
               jsonb_set(control_state, '{activation,prepared}', ${rev}::text::jsonb, true),
               '{activation,status}', '"prepared"'::jsonb, true
             ),
             '{activation,failure}', 'null'::jsonb, true
           )
         END
       WHERE owner_id = ${ownerId}
         AND workspace_id = ${workspaceId}
         AND control_generation = ${generation}
         AND control_delivered_generation < ${generation}
         AND control_state->'activation'->'desired' = ${rev}::text::jsonb
      RETURNING control_generation,
                (control_state->'activation'->>'status' = 'applied') AS already_applied
    `;
    if (rows.length === 0) return false;
    // Nothing transitioned, so there is no prepared receipt to record; the
    // acknowledgement below still advances the delivery watermark.
    if (rows[0]!.already_applied) return true;
    const recorded = await recordCurrentSessionIdentityActivation({
      ownerId, workspaceId, generation, phase: 'prepared', source: 'control', revision,
      sql: tx as unknown as Sql,
    });
    if (recorded === 'missing') {
      throw new Error('session_identity_activation_prepared_not_recorded');
    }
    return true;
  });
}

/** Persist a render/delivery failure while retaining the previous applied revision. */
export async function failControlTransitionActivation(
  ownerId: string,
  workspaceId: string,
  generation: number,
  revision: SessionActivation['desired'],
  failure: string,
  sql: Sql = getOrgPg().sql,
): Promise<boolean> {
  if (!failure.trim()) return false;
  const rev = JSON.stringify({ specificationRevision: revision.specificationRevision, stateRevision: revision.stateRevision });
  const reason = JSON.stringify(failure.trim());
  return await sql.begin(async (tx) => {
    const rows = await tx<Array<{ control_generation: number | string }>>`
      UPDATE harness_shared.session_briefs
         SET control_state = jsonb_set(
           jsonb_set(
             jsonb_set(control_state, '{activation,prepared}', 'null'::jsonb, true),
             '{activation,status}', '"failed"'::jsonb, true
           ),
           '{activation,failure}', ${reason}::text::jsonb, true
         )
       WHERE owner_id = ${ownerId}
         AND workspace_id = ${workspaceId}
         AND control_generation = ${generation}
         AND control_delivered_generation < ${generation}
         AND control_state->'activation'->'desired' = ${rev}::text::jsonb
      RETURNING control_generation
    `;
    if (rows.length === 0) return false;
    const recorded = await recordCurrentSessionIdentityActivation({
      ownerId, workspaceId, generation, phase: 'failed', source: 'control', revision,
      failure: failure.trim(), sql: tx as unknown as Sql,
    });
    if (recorded === 'missing') {
      throw new Error('session_identity_activation_failed_not_recorded');
    }
    return true;
  });
}

/**
 * Backwards-compatible name for callers that still use the original
 * one-shot-delivery vocabulary. The operation is now deliberately a
 * prepare/read; pair it with {@link acknowledgeControlTransition} after the
 * prompt has been assembled.
 */
export const consumePendingControlTransition = preparePendingControlTransition;

/**
 * The launch record the kernel gate judges for this owner: its selection verbatim
 * (projected-tool-deps.ts), pinned by wedged-identity-activation-selection.pin.test.ts.
 * Every writer of `activation.applied` vets against THIS row — vetting against any
 * other is how an acknowledgement wedged a session (EI-23703586803892464).
 */
/** Exported for the turn-start guide target (portable-identity P-003) — the SAME record selection the activation gate uses. */
export async function readGateSelectedLaunchSpec(tx: Sql, ownerId: string, workspaceId: string): Promise<unknown> {
  const rows = await tx<Array<{ launch_spec: unknown }>>`
    SELECT to_jsonb(s)->'launch_spec' AS launch_spec
      FROM harness_shared.adv_sessions s
     WHERE s.coord_owner_id = ${ownerId}
       AND s.workspace_id = ${workspaceId}
     ORDER BY (s.ended_at IS NULL AND s.ended_by IS NULL) DESC, s.started_at DESC, s.id DESC
     LIMIT 1
  `;
  return rows[0]?.launch_spec;
}

/**
 * Phase two of CTRL delivery: acknowledge one generation after the complete
 * prompt has been assembled successfully.
 *
 * The update is conditional and monotonic. If a newer generation appeared
 * while the caller was rendering, only the generation that this caller
 * actually prepared is acknowledged; the newer one remains pending for the
 * next turn. If the process dies before this call, the same generation is
 * returned again, preserving at-least-once delivery instead of losing a stack
 * mutation.
 *
 * With an `activationRevision` this is the ONLY writer of `activation.applied`,
 * so it refuses (returns false, nothing written) unless the launch record the
 * kernel gate selects admits that revision (EI-23703586803892464). Writing a
 * revision that record cannot resolve does not grant anything — it makes the
 * gate deny EVERY tool as `stale-artifact`, coord:orient included. A refusal
 * leaves the generation pending, so it is re-delivered and retried each turn
 * until the record carries it — the same wait a `relaunch-with-carry` takes.
 */
export async function acknowledgeControlTransition(
  ownerId: string,
  workspaceId: string,
  generation: number,
  sql: Sql = getOrgPg().sql,
  activationRevision?: SessionActivation['desired'],
): Promise<boolean> {
  if (!Number.isSafeInteger(generation) || generation < 0) return false;
  if (activationRevision) {
    const { launchRecordAdmitsApplied, appliedIdentityArtifact } = await import('../../capability-envelope/identity-grants-port');
    // D-018: package installations fenced by this activation are released only
    // after it commits, so a rollback never deletes rows the wearer still sees.
    let superseded: SessionPackageFence[] = [];
    const acknowledged = await sql.begin(async (tx) => {
      const launchSpec = await readGateSelectedLaunchSpec(tx as unknown as Sql, ownerId, workspaceId);
      if (!launchRecordAdmitsApplied(launchSpec, activationRevision)) return false;
      const rows = await tx<Array<{ control_delivered_generation: number | string }>>`
        UPDATE harness_shared.session_briefs
           SET control_delivered_generation = GREATEST(control_delivered_generation, ${generation}),
               control_state = jsonb_set(
                 jsonb_set(
                  jsonb_set(control_state, '{activation,applied}', ${JSON.stringify(activationRevision)}::text::jsonb, true),
                   '{activation,prepared}', 'null'::jsonb, true
                 ),
                 '{activation,status}', '"applied"'::jsonb, true
               )
         WHERE owner_id = ${ownerId}
           AND workspace_id = ${workspaceId}
           AND control_generation >= ${generation}
           AND control_delivered_generation < ${generation}
           AND control_state->'activation'->'desired' = ${JSON.stringify(activationRevision)}::text::jsonb
           AND (
             control_state->'activation'->'prepared' = ${JSON.stringify(activationRevision)}::text::jsonb
             -- WI-10003464: markControlTransitionPrepared leaves an already-applied
             -- revision untouched (prepared stays null), so accept that state too or
             -- a non-identity generation bump could never advance the watermark.
             OR (
               control_state->'activation'->>'status' = 'applied'
               AND control_state->'activation'->'applied'->>'specificationRevision' = ${activationRevision.specificationRevision}
               AND control_state->'activation'->'applied'->>'stateRevision' = ${activationRevision.stateRevision}
             )
           )
        RETURNING control_delivered_generation
      `;
      if (rows.length === 0) return false;
      const recorded = await recordCurrentSessionIdentityActivation({
        ownerId, workspaceId, generation, phase: 'applied', source: 'control',
        revision: activationRevision, sql: tx as unknown as Sql,
      });
      if (recorded === 'missing') {
        throw new Error('session_identity_activation_applied_not_recorded');
      }
      const { applySessionPackageResources } = await import('../../blueprint/session-package-resources');
      ({ superseded } = await applySessionPackageResources(tx, { ownerId, workspaceId, revision: activationRevision,
        artifact: appliedIdentityArtifact(launchSpec, activationRevision) }));
      return true;
    });
    await releaseAfterCommit(sql, superseded);
    return acknowledged;
  }
  // WI-10002717: a revision-less acknowledgement may advance the delivery
  // watermark only when no identity activation is still pending (desired ==
  // applied, or no activation at all). Advancing it past a pending activation
  // makes preparePendingControlTransition see nothing pending, so the activation
  // is never prepared or applied and the session is stranded at 'desired'.
  // coord:orient {afterCompaction} is the caller this guards against: it
  // acknowledges without rendering the stack block, so it must leave such a
  // generation pending for turn-start, which acknowledges WITH the revision.
  const rows = await sql<Array<{ control_delivered_generation: number | string }>>`
    UPDATE harness_shared.session_briefs
       SET control_delivered_generation = GREATEST(control_delivered_generation, ${generation})
     WHERE owner_id = ${ownerId}
       AND workspace_id = ${workspaceId}
       AND control_generation >= ${generation}
       AND control_delivered_generation < ${generation}
       AND (
         control_state->'activation'->'desired' IS NULL
         OR jsonb_typeof(control_state->'activation'->'desired') = 'null'
         OR control_state->'activation'->'desired' = control_state->'activation'->'applied'
       )
    RETURNING control_delivered_generation
  `;
  return rows.length > 0;
}

/**
 * EI-23886889674609842 (defect #1): a FAILED stack render must not strand the
 * authority receipt behind a launch the session has already made.
 *
 * On a render failure turn-start skips prepare and ack, so `applied` keeps the
 * previous revision. If the session was meanwhile relaunched on `desired` — its
 * gate-selected launch record carries it — the gate can no longer resolve the old
 * `applied` and denies every tool as `stale-artifact`, coord:orient included,
 * until someone hand-writes SQL. The WI-10002021 rescue cannot help: it sits on
 * the render-SUCCEEDED path.
 *
 * Two concerns share acknowledgement, and only one may move here:
 *   - `activation.applied` (authority) converges to `desired`, because the record
 *     the gate judges demonstrably runs it;
 *   - `control_delivered_generation` (prompt text) is NOT touched, because the
 *     stack block was not delivered and must be retried next turn.
 *
 * It writes only when that record admits `desired` AND no longer admits the
 * current non-null `applied` — i.e. only when it replaces a certain total denial
 * with the authority the launch already carries, never otherwise.
 */
export async function convergeActivationToLaunchRecord(
  ownerId: string,
  workspaceId: string,
  generation: number,
  revision: SessionActivation['desired'],
  sql: Sql = getOrgPg().sql,
): Promise<boolean> {
  if (!Number.isSafeInteger(generation) || generation < 0) return false;
  const { launchRecordAdmitsApplied } = await import('../../capability-envelope/identity-grants-port');
  const rev = JSON.stringify({ specificationRevision: revision.specificationRevision, stateRevision: revision.stateRevision });
  const superseded: SessionPackageFence[] = [];
  const converged = await sql.begin(async (tx) => {
    const launchSpec = await readGateSelectedLaunchSpec(tx as unknown as Sql, ownerId, workspaceId);
    if (!launchRecordAdmitsApplied(launchSpec, revision)) return false;
    const current = await tx<Array<{ applied: unknown }>>`
      SELECT control_state->'activation'->'applied' AS applied
        FROM harness_shared.session_briefs
       WHERE owner_id = ${ownerId}
         AND workspace_id = ${workspaceId}
       FOR UPDATE
    `;
    const applied = current[0]?.applied as { specificationRevision?: unknown; stateRevision?: unknown } | null | undefined;
    if (typeof applied?.specificationRevision !== 'string' || typeof applied.stateRevision !== 'string') return false;
    const appliedRevision = { specificationRevision: applied.specificationRevision, stateRevision: applied.stateRevision };
    if (launchRecordAdmitsApplied(launchSpec, appliedRevision)) return false;
    return await writeLaunchProvenApplied(tx, ownerId, workspaceId, generation, revision, launchSpec, superseded);
  });
  await releaseAfterCommit(sql, superseded);
  return converged;
}

/**
 * WI-10003459 (residual): make `applied` follow a carry-respawn at the relaunch,
 * not one turn later.
 *
 * A carry-respawn relaunches the CLI on `desired`, so the new process consumes
 * that revision from its first token. `applied` nevertheless moved only when the
 * NEXT turn's hook proved the CTRL emission (WI-10003297), so the whole first
 * turn after every respawn joined its tool and inference usage to the PREVIOUS
 * applied revision. Measured 2026-09-27 on su-fcbb3fed: 95 tool rows under
 * b4a393278a74 while adv_sessions.launch_spec already carried e5995edd00f9 — the
 * R-3 falsifier "usage joined to a revision the process is not running".
 *
 * Delivery proof is the right gate for an IN-PLACE change: a mode flip is
 * consumed only once its text reaches the context. A restart is different: the
 * launch artifact IS the consumption. So this converges `applied` (authority and
 * attribution) when, and only when:
 *   1. the latest `desired` event for this owner was written by a RESTART onto
 *      exactly this revision — an in-place flip, even one back to the launched
 *      specification, is `control`-sourced and keeps waiting for delivery proof;
 *   2. the gate-selected launch record carries exactly this specification and
 *      state revision — a relaunch that never landed keeps the old record; and
 *   3. that record admits the revision (the same gate the kernel preflight uses).
 * Provenance is read first, so an in-place transition never consults the launch
 * record. The delivery watermark is untouched: the CTRL text still awaits the
 * hook's proof, and that acknowledgement replays this transition id idempotently.
 */
export async function applyRelaunchedActivation(
  ownerId: string,
  workspaceId: string,
  generation: number,
  revision: SessionActivation['desired'],
  sql: Sql = getOrgPg().sql,
): Promise<boolean> {
  if (!Number.isSafeInteger(generation) || generation < 0) return false;
  const superseded: SessionPackageFence[] = [];
  const applied = await sql.begin(async (tx) => {
    const [latest] = await tx<Array<{ source: string; specification_revision: string; state_revision: string }>>`
      SELECT source, specification_revision, state_revision
        FROM harness_shared.session_identity_activation_events
       WHERE workspace_id = ${workspaceId}
         AND owner_id = ${ownerId}
         AND phase = 'desired'
       ORDER BY id DESC
       LIMIT 1
    `;
    if (
      latest?.source !== 'restart' ||
      latest.specification_revision !== revision.specificationRevision ||
      latest.state_revision !== revision.stateRevision
    ) return false;
    const launchSpec = await readGateSelectedLaunchSpec(tx as unknown as Sql, ownerId, workspaceId);
    const launched = launchSpec && typeof launchSpec === 'object'
      ? launchSpec as { specificationRevision?: unknown; stateRevision?: unknown }
      : null;
    if (
      launched?.specificationRevision !== revision.specificationRevision ||
      launched.stateRevision !== revision.stateRevision
    ) return false;
    const { launchRecordAdmitsApplied } = await import('../../capability-envelope/identity-grants-port');
    if (!launchRecordAdmitsApplied(launchSpec, revision)) return false;
    return await writeLaunchProvenApplied(tx, ownerId, workspaceId, generation, revision, launchSpec, superseded);
  });
  await releaseAfterCommit(sql, superseded);
  return applied;
}

/** Release the package installations an activation fenced, once it has
 * committed. Fire-and-forget; a failure stays durable on the installation
 * row and resumes at the wearer's next provisioning. */
async function releaseAfterCommit(sql: Sql, superseded: readonly SessionPackageFence[]): Promise<void> {
  if (superseded.length === 0) return;
  const { scheduleSupersededSessionPackageRelease } = await import('../../blueprint/session-package-resources');
  scheduleSupersededSessionPackageRelease(sql, superseded);
}

/**
 * The shared write for a launch-proven `applied`: authority + attribution move to
 * `revision`; `control_delivered_generation` does NOT (the prompt text still awaits
 * the hook's delivery proof). A no-op when `revision` is already applied, so a
 * retry never appends a second receipt. Installations it fences are appended to
 * `superseded` for the caller to release after its transaction commits.
 */
async function writeLaunchProvenApplied(
  tx: TransactionSql,
  ownerId: string,
  workspaceId: string,
  generation: number,
  revision: SessionActivation['desired'],
  launchSpec: unknown,
  superseded: SessionPackageFence[],
): Promise<boolean> {
  const rev = JSON.stringify({ specificationRevision: revision.specificationRevision, stateRevision: revision.stateRevision });
  const rows = await tx<Array<{ control_generation: number | string }>>`
    UPDATE harness_shared.session_briefs
       SET control_state = jsonb_set(
         jsonb_set(
           jsonb_set(control_state, '{activation,applied}', ${rev}::text::jsonb, true),
           '{activation,prepared}', 'null'::jsonb, true
         ),
         '{activation,status}', '"applied"'::jsonb, true
       )
     WHERE owner_id = ${ownerId}
       AND workspace_id = ${workspaceId}
       AND control_generation >= ${generation}
       AND control_state->'activation'->'desired' = ${rev}::text::jsonb
       AND NOT (
         control_state->'activation'->>'status' IS NOT DISTINCT FROM 'applied'
         AND control_state->'activation'->'applied' = ${rev}::text::jsonb
       )
    RETURNING control_generation
  `;
  if (rows.length === 0) return false;
  const recorded = await recordCurrentSessionIdentityActivation({
    ownerId, workspaceId, generation, phase: 'applied', source: 'control', revision, sql: tx as unknown as Sql,
  });
  if (recorded === 'missing') {
    throw new Error('session_identity_activation_applied_not_recorded');
  }
  const { applySessionPackageResources } = await import('../../blueprint/session-package-resources');
  const { appliedIdentityArtifact } = await import('../../capability-envelope/identity-grants-port');
  const fenced = await applySessionPackageResources(tx, { ownerId, workspaceId, revision,
    artifact: appliedIdentityArtifact(launchSpec, revision) });
  superseded.push(...fenced.superseded);
  return true;
}

/**
 * WI-10002058: re-arm the ⟦CTRL:…⟧ escape hatch across a CONTEXT WIPE.
 *
 * `control_delivered_generation` is a watermark over an OWNER, but the thing
 * that actually holds delivered state is a CONTEXT. Every other writer advances
 * it with `GREATEST(...)`, so it is monotonically non-decreasing — and nothing
 * lowered it when a carry-respawn destroyed the context that had been told.
 * {@link preparePendingControlTransition} then finds
 * `control_generation > control_delivered_generation` false and emits NO block,
 * while the carry document the successor actually reads carries a BUILD-TIME
 * stamp that may already be generations behind.
 *
 * That is how the carry marker's only escape hatch (WI-10002017) comes to be
 * disarmed at precisely the boundary it exists to serve: the successor is handed
 * `complete:true` for a stale generation, and no live channel can contradict it.
 * The two mechanisms answer different questions — the block says "changed since
 * you were last told", the marker says "true when this document was built" — so
 * SILENCE FROM THE BLOCK IS NOT AGREEMENT WITH THE MARKER unless the baselines
 * are the same. This makes them the same.
 *
 * Lowering the watermark to the generation the outgoing document is STAMPED with
 * restores the equivalence:
 *   - state unchanged since the stamp → still not greater → no block, correctly.
 *   - state moved past the stamp      → greater           → full-resync, armed.
 *
 * `LEAST(...)` is the deliberate mirror of the `GREATEST(...)` advance: it can
 * only ever lower, is idempotent, and cannot skip a delivery. If a respawn is
 * requested but never happens, the whole cost is one redundant — and
 * authoritative — full-resync block. That is the same asymmetry
 * {@link renderControlTransitionDelivery} already documents: a few dozen extra
 * tokens harm nothing, while blinding the session is total.
 */
export async function rearmControlWitnessForContextWipe(
  ownerId: string,
  workspaceId: string,
  stampedGeneration: number,
  sql: Sql = getOrgPg().sql,
): Promise<{ rearmed: boolean; deliveredGeneration: number | null }> {
  if (!Number.isInteger(stampedGeneration) || stampedGeneration < 0) {
    return { rearmed: false, deliveredGeneration: null };
  }
  const rows = await sql<Array<{ control_delivered_generation: number | string }>>`
    UPDATE harness_shared.session_briefs
       SET control_delivered_generation = LEAST(control_delivered_generation, ${stampedGeneration})
     WHERE owner_id = ${ownerId}
       AND workspace_id = ${workspaceId}
       AND control_delivered_generation > ${stampedGeneration}
    RETURNING control_delivered_generation
  `;
  const row = rows[0];
  return {
    rearmed: Boolean(row),
    deliveredGeneration: row ? Number(row.control_delivered_generation) : null,
  };
}

export function renderControlTransitionContext(delivery: ControlTransitionDelivery): string {
  // Recompute for legacy callers/tests that still pass a persisted transition
  // without the additive hash field. The live renderer always emits it.
  const withStateHash = {
    ...delivery,
    stateHash: delivery.stateHash ?? controlStateHash(delivery.state),
  };
  return `⟦CTRL:${delivery.kind}⟧ ${JSON.stringify(withStateHash)}`;
}

/** Reconcile the existing authoritative stores into the compact projection. */
export async function buildControlAnchorState(
  ownerId: string,
  workspaceId: string,
  opts: {
    sql?: Sql;
    loop?: LoopStatus | null;
    /** Test/transaction seam; undefined reads the newest persisted launch receipt. */
    explicitStack?: readonly string[] | null;
    /** WI-7302: DI seam so the wake-source leg unit-tests without PG. */
    fetchSelfWakeFn?: (ids: string[], sql?: Sql) => Promise<Map<string, SelfWakeSignals>>;
  } = {},
): Promise<ControlAnchorState> {
  const sql = opts.sql ?? getOrgPg().sql;
  // ⚠ Each leg is guarded AT CREATION, not after the whole set is built.
  //
  // These legs are started eagerly and settled together, so two different
  // failures can orphan a rejection with no handler — and on Node's default
  // --unhandled-rejections=throw an orphan takes the process down. That breaks
  // the fail-soft guarantee refreshControlAnchorAfterMutation advertises at
  // exactly the moment it matters most, because a DB fault fails SEVERAL legs
  // at once rather than one:
  //   1. Promise.all rejects with the FIRST failure and abandons the rest; the
  //      losers keep running and reject into nothing.
  //   2. Worse, a leg whose construction throws SYNCHRONOUSLY (`claimsP` is a
  //      tagged template — an `sql` that is not callable throws right here)
  //      aborts the remaining legs, orphaning every promise already created.
  //      A guard placed after the set is assembled never even runs.
  //
  // `guard` is identity — it only marks a rejection handled, so Promise.all
  // still rejects with the first failure and callers see identical behaviour.
  // Measured 2026-08-29 in canonical run 4: standing-goal-boot-arm.test.ts
  // (whose `sql` is `{}`) passed all 11 tests and still exited 1 on exactly
  // three orphans — the three legs built before the tagged template threw —
  // which failed the whole @papercusp/operator-core test:lane-pure task.
  const guard = <T>(leg: T): T => {
    void Promise.resolve(leg).catch(() => {});
    return leg;
  };
  const modesP = guard(getModes(workspaceId, ownerId, sql));
  // The import leg is orphaned the same way when a sibling rejects first, and it is
  // still loading agent-identities/source → agent-tools/blueprint/_resolve →
  // harness-ops/proxy → … when the test file's environment is torn down. In the pure
  // lane (isolate:false) that leaves `_resolve` half-evaluated for every co-resident
  // file: domain-default-packs.test.ts then failed `resolveAndValidate` with
  // "Cannot access '__vite_ssr_import_4__' before initialization" (WI-10004029).
  // trackDetached lets the unit-layer drain wait for the module graph only; the
  // catalog read itself stays untracked so a slow read never stalls teardown.
  const modeCatalogP = guard(
    trackDetached(import('../../agent-identities/source')).then((module) => module.getSelectedModeCatalog()),
  );
  const loopP = guard(
    opts.loop === undefined ? getLoopStatus(ownerId, { sql }) : Promise.resolve(opts.loop),
  );
  const membershipP = guard(latestFleetMembership(workspaceId, ownerId, sql));
  const briefP = guard(getSessionBrief({ ownerId }, sql));
  // Fail closed: an unreadable authority leg must not emit a fresh anchor that
  // silently omits a predecessor's stand-down order. The enclosing orient or
  // mutation refresh can retry; it may never manufacture authority from absence.
  const goalAuthorityP = guard(readGoalHolderAuthority(sql, workspaceId, ownerId));
  const explicitStackP = guard(
    opts.explicitStack !== undefined
      ? Promise.resolve([...(opts.explicitStack ?? [])])
      : sql<Array<{ stack_refs: unknown }>>`
          SELECT launch_spec->'stack' AS stack_refs
            FROM harness_shared.adv_sessions
           WHERE workspace_id = ${workspaceId}
             AND coord_owner_id = ${ownerId}
             AND launch_spec->>'v' = '1'
           ORDER BY (ended_at IS NULL AND ended_by IS NULL) DESC, started_at DESC, id DESC
           LIMIT 1
        `.then((rows) => {
          const raw = rows[0]?.stack_refs;
          return Array.isArray(raw)
            ? raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : [];
        }),
  );
    // ⚠ NO `expires_ts > clock_timestamp()` FILTER HERE — deliberately.
    //
    // `plan_item_claims` is a TTL'd coordination LEASE (default ttl_sec 1200 =
    // 20 min). Expiry answers "may a PEER take this item?" — it does NOT answer
    // "what is this agent working on". Filtering self-scope by it made an
    // agent's own mission evaporate 20 minutes into working a single item.
    //
    // Measured 2026-08-10: a session driving plan
    // retire-mug-kettle-su-only-2026-08-09 respawned and reported
    // `scope: { plan: null, items: [] }`. Its P-034 claim row was still there,
    // unreleased — the lease had simply lapsed 13h earlier. Both symptoms came
    // from this one predicate: `items` emptied, and `plan` then fell through
    // `chosen?.plan_slug` to null. The agent lost its mission and asked the
    // owner which plan it was on.
    //
    // Reading a lapsed row here CANNOT steal a peer's work: the primary key is
    // (workspace_id, harness_slug, plan_slug, item_id), one row per item, and a
    // peer's claim overwrites `owner`. So a surviving row still owned by US
    // means nobody else took it. Rows are DELETED on release, so presence means
    // claimed-and-never-released.
    //
    // `lease_valid` is carried so callers can tell "mine, lease live" from
    // "mine, lease lapsed — re-claim before editing".
  const claimsP = guard(sql<ScopeClaimRow[]>`
      SELECT harness_slug, plan_slug, item_id,
             expires_ts > clock_timestamp() AS lease_valid
        FROM harness_shared.plan_item_claims
       WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
         AND owner = ${ownerId}
       ORDER BY (expires_ts > clock_timestamp()) DESC, plan_slug, item_id
    `);
    // WI-7302 part 2: the forward-looking wake-source leg. Best-effort — on any
    // failure this resolves to an empty map and `wakeSource` is simply absent
    // (UNKNOWN), because a degraded query must never be able to tell a healthy
    // session that nothing will ever wake it.
  const selfWakeP = guard(
    (opts.fetchSelfWakeFn ?? fetchSelfWake)([ownerId], sql).catch(
      () => new Map<string, SelfWakeSignals>(),
    ),
  );
  const [modes, modeCatalog, loop, membership, brief, goalAuthority, explicitStack, claims, selfWake] = await Promise.all([
    modesP,
    modeCatalogP,
    loopP,
    membershipP,
    briefP,
    goalAuthorityP,
    explicitStackP,
    claimsP,
    selfWakeP,
  ]);
  const derived = deriveClaimScope(claims, brief?.currentPlanSlug, brief?.harnessSlug);
  const fleet = membership?.fleetSlug;
  const source = brief?.source?.toLowerCase() ?? '';
  const route: ControlAnchorState['route'] = fleet
    ? { kind: 'fleet', fleet, role: membership?.fleetRole ?? null }
    : source.includes('mug')
      ? { kind: 'mug' }
      : { kind: 'self' };
  return normalizeControlAnchorState({
    modes: modes.map((m) => m.mode),
    // P-009: preserve the current desired/prepared/applied truth while the
    // other canonical control legs are reconciled. The brief is only a carrier;
    // normalizeSessionActivation remains the validator/owner of this field.
    activation: normalizeSessionActivation(
      (brief?.controlState as Record<string, unknown> | null | undefined)?.activation,
    ),
    // P-012 / P-021: the stack binding is a projection of the route (fleet posture) and of
    // the active modes (one definition identity per mode axis) — no new leg.
    stack: stackRefsForSession({ route, modes: modes.map((m) => m.mode), explicit: explicitStack, modeCatalog }),
    loop: { active: Boolean(loop?.active), intervalSec: loop?.intervalSec ?? null },
    wakeSource: selfWake.get(ownerId)?.selfWake,
    carry: loop?.carry ?? 'warm',
    goalAuthority: projectGoalHolderAuthority(goalAuthority),
    lifecycle: brief?.lifecycle ?? undefined,
    route,
    scope: {
      workspace: workspaceId,
      harness: derived.harness,
      plan: derived.plan,
      items: derived.items,
    },
  });
}

export async function buildAndPersistControlAnchor(
  ownerId: string,
  workspaceId: string,
  opts: {
    sql?: Sql;
    loop?: LoopStatus | null;
    transition?: Omit<ControlTransitionProvenance, 'recordedAt'> & { recordedAt?: string };
  } = {},
): Promise<ControlAnchor> {
  const state = await buildControlAnchorState(ownerId, workspaceId, opts);
  const persisted = await persistControlAnchor(
    { ownerId, workspaceId, state, transition: opts.transition },
    opts.sql ?? getOrgPg().sql,
  );
  return renderControlAnchor({ ownerId, ...persisted });
}

/**
 * Start one acknowledged identity delivery on the existing control anchor.
 * Launch and carry-restart both use this door; `restart` deliberately creates a
 * new generation even when its revisions are unchanged.
 */
export async function requestSessionIdentityActivation(input: {
  ownerId: string;
  workspaceId: string;
  revision: SessionActivation['desired'];
  attribution?: ActivationAttribution;
  source: Exclude<SessionIdentityActivationSource, 'control'>;
  restart?: boolean;
  sql?: Sql;
}): Promise<ControlAnchor> {
  const sql = input.sql ?? getOrgPg().sql;
  return await sql.begin(async (tx) => {
    return requestSessionIdentityActivationInTransaction({ ...input, sql: tx as unknown as Sql });
  });
}

/** Transactional core for launch-receipt + activation mutations. */
export async function requestSessionIdentityActivationInTransaction(input: {
  ownerId: string;
  workspaceId: string;
  revision: SessionActivation['desired'];
  attribution?: ActivationAttribution;
  source: Exclude<SessionIdentityActivationSource, 'control'>;
  restart?: boolean;
  sql: Sql;
}): Promise<ControlAnchor> {
  const state = await buildControlAnchorState(input.ownerId, input.workspaceId, { sql: input.sql });
  const activation = state.activation
    ? input.restart
      ? restartActivation(state.activation, input.revision)
      : requestActivation(state.activation, input.revision)
    : desiredActivation(
        input.attribution ?? {
          actorId: input.ownerId,
          principalId: input.ownerId,
          sessionId: input.ownerId,
        },
        input.revision,
      );
  const persisted = await persistControlAnchor({
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    state: { ...state, activation },
    transition: {
      origin: 'system',
      actorId: input.ownerId,
      source: 'session:activation',
      ownerDirected: false,
    },
  }, input.sql);
  const recorded = await recordCurrentSessionIdentityActivation({
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    generation: persisted.generation,
    phase: 'desired',
    source: input.source,
    revision: input.revision,
    sql: input.sql,
  });
  if (recorded === 'missing') throw new Error('session_identity_activation_desired_not_recorded');
  return renderControlAnchor({ ownerId: input.ownerId, ...persisted });
}

/**
 * P-009 (EI-23431478594488191): give a CONTROL-source activation its own launch
 * receipt. `refreshControlAnchorAfterMutation` advances the applied STATE
 * revision without re-rendering the launch artifact, so without this write no
 * receipt carries the new `stateRevision`, `appliedIdentityArtifact` finds no
 * exact match, and the kernel preflight denies every tool as `stale-artifact`.
 *
 * Runs in the caller's transaction, beside the activation it receipts, so a
 * recorded activation and its receipt cannot land separately. Whether to write
 * at all — and the fail-closed rules that govern it — is decided entirely by
 * `carryIdentityReceiptForControlActivation`; this function only does the I/O.
 *
 * Returns what it did rather than throwing: a session with no launch record is
 * the ordinary legacy path, and a losing CAS means a concurrent writer already
 * rewrote the record (the next transition re-carries). Neither is a reason to
 * fail the mode/loop/route write this receipt is merely accompanying.
 */
async function carryControlActivationIdentityReceipt(input: {
  ownerId: string;
  workspaceId: string;
  revision: SessionActivation['desired'];
  sql: Sql;
}): Promise<'carried' | 'unchanged' | 'no-record' | 'lost-race'> {
  const rows = await input.sql<Array<{ id: number | string; launch_spec: unknown }>>`
    SELECT a.id, to_jsonb(a)->'launch_spec' AS launch_spec
      FROM harness_shared.adv_sessions a
     WHERE a.workspace_id = ${input.workspaceId} AND a.coord_owner_id = ${input.ownerId}
     ORDER BY (a.ended_at IS NULL AND a.ended_by IS NULL) DESC, a.started_at DESC, a.id DESC
     LIMIT 1
  `;
  const row = rows[0];
  const record = parseSuLaunchSpecRecord(row?.launch_spec);
  if (!row || !record) return 'no-record';
  const identityHistory = carryIdentityReceiptForControlActivation(record, input.revision);
  if (!identityHistory) return 'unchanged';
  const next: SuLaunchSpecRecord = { ...record, identityHistory };
  const updated = await input.sql<Array<{ id: number | string }>>`
    UPDATE harness_shared.adv_sessions
       SET launch_spec = ${JSON.stringify(next)}::jsonb
     WHERE id = ${row.id}
       AND workspace_id = ${input.workspaceId}
       AND coord_owner_id = ${input.ownerId}
       AND launch_spec = ${JSON.stringify(row.launch_spec)}::jsonb
    RETURNING id
  `;
  return updated.length > 0 ? 'carried' : 'lost-race';
}

/** Refresh after a canonical mutation. The projection is safety context, but
 * never a reason to roll back the already-committed mode/loop/route write. */
export async function refreshControlAnchorAfterMutation(input: {
  ownerId: string;
  workspaceId: string;
  origin: ControlTransitionOrigin;
  actorId: string;
  source: ControlTransitionProvenance['source'];
  ownerDirected?: boolean;
  sql?: Sql;
}): Promise<ControlAnchor | null> {
  const persist = async (transaction: Sql): Promise<ControlAnchor> => {
    const state = await buildControlAnchorState(input.ownerId, input.workspaceId, { sql: transaction });
    const identityMoved = input.source === 'mode:set' || input.source === 'fleet:membership';
    const nextState = identityMoved && state.activation
      ? {
          ...state,
          activation: requestActivation(state.activation, {
            specificationRevision: state.activation.desired.specificationRevision,
            stateRevision: sessionIdentityStateRevision(state),
          }),
        }
      : state;
    const persisted = await persistControlAnchor({
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      state: nextState,
      transition: {
        origin: input.origin,
        actorId: input.actorId,
        source: input.source,
        ownerDirected: Boolean(input.ownerDirected),
      },
    }, transaction);
    if (identityMoved && persisted.state.activation?.status === 'desired') {
      const recorded = await recordCurrentSessionIdentityActivation({
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        generation: persisted.generation,
        phase: 'desired',
        source: 'control',
        revision: persisted.state.activation.desired,
        sql: transaction,
      });
      if (recorded === 'missing') throw new Error('session_identity_activation_desired_not_recorded');
      // Receipt the activation we just recorded, so the kernel preflight can
      // match it exactly instead of relying on the reader-side fallback.
      await carryControlActivationIdentityReceipt({
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        revision: persisted.state.activation.desired,
        sql: transaction,
      });
    }
    return renderControlAnchor({ ownerId: input.ownerId, ...persisted });
  };

  try {
    const suppliedSql = input.sql;
    // A caller may already be inside its own bounded transaction (notably fleet
    // membership/leadership writes). TransactionSql exposes no `begin`; reuse it
    // so the projection remains atomic with the canonical mutation. The outer
    // transaction owns the timeout in that case.
    if (suppliedSql && typeof (suppliedSql as unknown as { begin?: unknown }).begin !== 'function') {
      return await persist(suppliedSql);
    }

    const bounded = await withBoundedTimeout(
      (signal) => boundedOrgTxn(
        (transaction) => persist(transaction as unknown as Sql),
        {
          ...(suppliedSql ? { client: suppliedSql } : {}),
          statementTimeoutMs: CONTROL_ANCHOR_REFRESH_STATEMENT_TIMEOUT_MS,
          lockTimeoutMs: CONTROL_ANCHOR_REFRESH_LOCK_TIMEOUT_MS,
          signal,
        },
      ),
      {
        timeoutMs: CONTROL_ANCHOR_REFRESH_TIMEOUT_MS,
        fallback: null,
        label: 'control-anchor:refresh',
      },
    );
    return bounded.value;
  } catch {
    return null;
  }
}
