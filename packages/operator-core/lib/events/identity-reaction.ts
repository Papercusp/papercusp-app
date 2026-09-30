/**
 * Identity reactions (portable-identity-packages-2026-09-26 P-018; D-027, D-028, D-029).
 *
 * A worn `delivery:'async'` rule is subscribed to its event key as a muted
 * `coord_entity_subscriptions` row (agent-identities/identity-rule-subscriptions).
 * When the key fires, the emit hands those rows here and each becomes ONE durable
 * reaction, never a turn injection and never an in-process fire:
 *
 *   ENQUEUE (the emit, fail-soft). One DBOS workflow per (fire, wearer, revision,
 *   rule), keyed by the receipt id, so a replayed enqueue collapses to one run and
 *   two wearers get two. With no durable path the reaction is recorded as a
 *   terminal refusal (`durable-unavailable`) — it never falls back in-process.
 *
 *   EXECUTE (the workflow step). The receipt (`event_reactions`) is a small state
 *   machine: the step inserts it `authorizing` and reads it back. A terminal
 *   status means a replay, so it returns without dispatching. `authorizing`
 *   means authorize NOW from live state — so a crash after authorization and
 *   before dispatch is recovered by authorizing again, never by trusting what
 *   was decided before the crash (D-027 §5, D-029 §6).
 *
 *   AUTHORIZE. The wearer is re-read from the control anchor; the attachment's
 *   revision must still be the one the subscription was written for, the rule
 *   pin must still be worn, `when` must hold, the pot must bind the class verb,
 *   and the allowlist (class capability ∩ declared needs ∩ pot/role ceiling ∩
 *   protected floor) must be non-empty. Any miss is a recorded refusal with zero
 *   dispatch. A lookup that fails THROWS, so the step retries and, once retries
 *   are exhausted, the workflow records `failed` — it never grants access.
 *
 *   DISPATCH AS THE WEARER. The ordinary dispatcher, with the wearer as
 *   principal and coordination owner, role `su`, and NO gate bypass: the
 *   capability gate holds the reaction to the allowlist, the role and quota
 *   gates apply and charge the wearer, and the identity grant kernel judges the
 *   wearer's live grants. Never the `system:event-reaction` or
 *   `plugin:event-reaction` authority.
 *
 * The one at-least-once window is a crash after dispatch returns and before the
 * terminal UPDATE: the recovered step sees `authorizing` and dispatches again. An
 * operation provider closes it: it is submitted through `blueprint:submit` under
 * a request key derived from the receipt id, so the second submit replays the
 * first blueprint receipt (D-030). A plain tool is at-least-once there.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  dispatchProjectedTool,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';
import {
  IDENTITY_RULE_SUBSCRIPTION_KIND,
  identityReactionAllowlist,
  identityReactionReceiptId,
  parseIdentityRuleSubscriberId,
  readIdentityWearer,
  wornAsyncRules,
  type IdentityWearer,
} from '../agent-identities/identity-async-rules';
import { buildWearerToolContext } from '../agent-identities/wearer-authority';
import { cancelIdentityRuleSubscription } from '../agent-identities/identity-rule-subscriptions';
import type { CapabilityProviderKind } from '../capability-class-registry-store';
import type { IdentityReactionCeiling } from '../capability-envelope/identity-grants-port';
import { withPgRetry } from '../pg-transient-retry';
import type { LatchedEventSubscriber } from './await/store';
import {
  resolveClassFireTarget,
  validateClassFireTarget,
  type ResolveClassFireResult,
  type ValidateClassFireResult,
} from './class-fire-target';
import type { ReactionCause } from './types';

/** The JSON-serializable workflow input for one identity reaction. */
export interface IdentityReactionPayload {
  readonly receiptId: string;
  /** The subscription row's workspace, which is the wearer's (D-029 §3). */
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly revisionTag: string;
  readonly pinRef: string;
  readonly subscriberId: string;
  readonly eventKey: string;
  readonly fireId: string;
  readonly eventPayload: unknown;
}

export type IdentityRefusalCode =
  | 'durable-unavailable'
  | 'detached'
  | 'attachment-changed'
  | 'rule-changed'
  | 'when-false'
  | 'unbound'
  | 'class-invalid'
  | 'capability-empty';

export type IdentityReactionOutcome =
  | { readonly status: 'replayed'; readonly prior: string }
  | { readonly status: 'refused'; readonly code: IdentityRefusalCode; readonly reason: string }
  | { readonly status: 'fired'; readonly tool: string }
  | { readonly status: 'failed'; readonly tool: string; readonly error: string };

/** The receipt's statuses. `authorizing` is the only non-terminal one. */
export const IDENTITY_RECEIPT_TERMINAL = ['fired', 'refused', 'failed'] as const;

/** `event_reactions.fire` before the rule has been read (a refusal can precede it). */
export const UNRESOLVED_IDENTITY_FIRE = '(unresolved)';

/** The spawn id a wearer-principal dispatch is recorded under in tool_invocations. */
export const IDENTITY_REACTION_SPAWN_ID = 'identity-reaction';

/** The provider kinds an identity reaction resolves: sync tools and async blueprint operations (D-030 §3). */
export const IDENTITY_REACTION_PROVIDER_KINDS: readonly CapabilityProviderKind[] = ['tool', 'operation'];

/**
 * The blueprint request key of one identity reaction's operation submit. The
 * receipt id can exceed the 200-char key limit, so it is hashed; the same
 * receipt always yields the same key, which is what makes a recovered
 * re-dispatch replay the first submit (D-030 §4).
 */
export function identityOperationRequestKey(receiptId: string): string {
  return `identity-reaction:${createHash('sha256').update(receiptId).digest('hex')}`;
}

/* ------------------------------------------------------------------ */
/* Planning (pure).                                                     */
/* ------------------------------------------------------------------ */

/**
 * PURE: one reaction per identity subscription row this fire reached. Rows are
 * recognised by `derived_from_kind`, never by subscriber-id shape (D-029 §2); a
 * row whose subscriber id does not parse against its own owner is reported.
 */
export function planIdentityReactions(input: {
  workspaceId: string;
  eventKey: string;
  fireId: string;
  payload: unknown;
  rows: readonly LatchedEventSubscriber[];
}): { payloads: IdentityReactionPayload[]; unparseable: string[] } {
  const payloads: IdentityReactionPayload[] = [];
  const unparseable: string[] = [];
  for (const row of input.rows) {
    if (row.derived_from_kind !== IDENTITY_RULE_SUBSCRIPTION_KIND) continue;
    const ownerId = row.derived_from_ref ?? '';
    const parsed = ownerId ? parseIdentityRuleSubscriberId(row.subscriber_id, ownerId) : null;
    if (!parsed) {
      unparseable.push(row.subscriber_id);
      continue;
    }
    payloads.push({
      receiptId: identityReactionReceiptId({ fireId: input.fireId, ownerId, ...parsed }),
      workspaceId: input.workspaceId,
      ownerId,
      revisionTag: parsed.revisionTag,
      pinRef: parsed.pinRef,
      subscriberId: row.subscriber_id,
      eventKey: input.eventKey,
      fireId: input.fireId,
      eventPayload: input.payload ?? null,
    });
  }
  return { payloads, unparseable };
}

/* ------------------------------------------------------------------ */
/* The receipt.                                                         */
/* ------------------------------------------------------------------ */

type Sql = postgres.Sql | postgres.TransactionSql;

/**
 * Insert the receipt `authorizing` unless it exists; return its status either
 * way. One statement: when the insert conflicts, the pre-existing row is what
 * the snapshot shows.
 */
export async function beginIdentityReceipt(sql: Sql, payload: IdentityReactionPayload): Promise<string> {
  const rows = await sql<{ status: string | null }[]>`
    WITH ins AS (
      INSERT INTO harness_shared.event_reactions
        (dedup_id, workspace_id, rule_id, fire, trigger_tool, cause_root_run_id, depth, status, contributor)
      VALUES (${payload.receiptId}, ${payload.workspaceId}, ${payload.pinRef}, ${UNRESOLVED_IDENTITY_FIRE},
              ${`event:${payload.eventKey}`}, ${payload.fireId}, 1, 'authorizing', NULL)
      ON CONFLICT (dedup_id) DO NOTHING
      RETURNING status
    )
    SELECT COALESCE(
      (SELECT status FROM ins),
      (SELECT status FROM harness_shared.event_reactions WHERE dedup_id = ${payload.receiptId})
    ) AS status`;
  const status = rows[0]?.status;
  if (!status) throw new Error(`identity reaction receipt ${payload.receiptId} could not be read back`);
  return status;
}

/**
 * Move an `authorizing` receipt to a terminal status. Guarded on `authorizing`,
 * so a terminal status is never overwritten. Returns whether this call moved it.
 */
export async function settleIdentityReceipt(sql: Sql, receiptId: string, outcome: {
  status: (typeof IDENTITY_RECEIPT_TERMINAL)[number];
  error?: string | null;
  fire?: string | null;
  contributor?: string | null;
}): Promise<boolean> {
  const rows = await sql`
    UPDATE harness_shared.event_reactions
       SET status = ${outcome.status},
           error_message = ${outcome.error ?? null},
           fire = COALESCE(${outcome.fire ?? null}, fire),
           contributor = COALESCE(${outcome.contributor ?? null}, contributor)
     WHERE dedup_id = ${receiptId} AND status = 'authorizing'
    RETURNING dedup_id`;
  return rows.length > 0;
}

/** A terminal refusal recorded where no workflow will ever run (enqueue time). */
export async function recordIdentityRefusal(
  sql: Sql, payload: IdentityReactionPayload, code: IdentityRefusalCode, reason: string,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.event_reactions
      (dedup_id, workspace_id, rule_id, fire, trigger_tool, cause_root_run_id, depth, status, error_message, contributor)
    VALUES (${payload.receiptId}, ${payload.workspaceId}, ${payload.pinRef}, ${UNRESOLVED_IDENTITY_FIRE},
            ${`event:${payload.eventKey}`}, ${payload.fireId}, 1, 'refused', ${`${code}: ${reason}`}, NULL)
    ON CONFLICT (dedup_id) DO NOTHING`;
}

/* ------------------------------------------------------------------ */
/* Enqueue (the emit side).                                             */
/* ------------------------------------------------------------------ */

/**
 * `enqueued`: a durable workflow row exists (or already existed) for the
 * receipt. `unavailable`: no enqueue was attempted. An attempted enqueue whose
 * outcome is unknown THROWS — recording a refusal then could suppress a
 * workflow that did commit.
 */
export type IdentityReactionEnqueuer = (payload: IdentityReactionPayload) => Promise<'enqueued' | 'unavailable'>;

async function enqueueDurably(payload: IdentityReactionPayload): Promise<'enqueued' | 'unavailable'> {
  let mod: typeof import('../dbos/identity-reaction-workflow');
  try {
    mod = await import('../dbos/identity-reaction-workflow');
  } catch (err) {
    console.warn(`[identity-reaction] durable module unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return 'unavailable';
  }
  return mod.enqueueIdentityReaction(payload);
}

export interface EnqueueIdentityReactionsResult {
  enqueued: number;
  refused: number;
  uncertain: number;
  unparseable: number;
}

/**
 * Enqueue one durable reaction per identity row this fire reached. Never
 * throws: the emit that calls it must not break, and every per-row outcome is
 * either a workflow, a recorded refusal, or a logged uncertain enqueue.
 */
export async function enqueueIdentityReactions(
  input: Parameters<typeof planIdentityReactions>[0],
  deps: { enqueue?: IdentityReactionEnqueuer; sql?: Sql; log?: (msg: string) => void } = {},
): Promise<EnqueueIdentityReactionsResult> {
  const log = deps.log ?? ((msg: string) => console.warn(`[identity-reaction] ${msg}`));
  const { payloads, unparseable } = planIdentityReactions(input);
  for (const id of unparseable) log(`subscription ${id} on ${input.eventKey} does not parse against its owner; skipped`);
  const result: EnqueueIdentityReactionsResult = { enqueued: 0, refused: 0, uncertain: 0, unparseable: unparseable.length };
  const enqueue = deps.enqueue ?? enqueueDurably;
  for (const payload of payloads) {
    let verdict: 'enqueued' | 'unavailable';
    try {
      verdict = await enqueue(payload);
    } catch (err) {
      result.uncertain += 1;
      log(`enqueue outcome unknown for ${payload.receiptId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (verdict === 'enqueued') {
      result.enqueued += 1;
      continue;
    }
    try {
      await recordIdentityRefusal(deps.sql ?? getOrgPg().sql, payload, 'durable-unavailable',
        'no durable execution path is available on this host; identity reactions never run in-process');
      result.refused += 1;
    } catch (err) {
      log(`refusal record failed for ${payload.receiptId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Execute (the durable step).                                          */
/* ------------------------------------------------------------------ */

/**
 * PURE: the dispatcher context a wearer-principal reaction runs under — the
 * shared wearer context (`buildWearerToolContext`: no `gateBypass`; capability,
 * role and quota all apply) plus the reaction's cause.
 */
export function buildWearerReactionCtx(input: {
  workspaceId: string;
  ownerId: string;
  role: string;
  harnessSlug: string;
  capabilities: readonly string[];
  cause: ReactionCause;
}): Omit<UnifiedToolContext, 'tx'> {
  return {
    ...buildWearerToolContext({ ...input, spawnId: IDENTITY_REACTION_SPAWN_ID }),
    reactionCause: input.cause,
  };
}

export interface IdentityDispatchInput {
  workspaceId: string;
  ownerId: string;
  role: string;
  harnessSlug: string;
  tool: string;
  args: Record<string, unknown>;
  capabilities: readonly string[];
  cause: ReactionCause;
}

async function dispatchAsWearer(input: IdentityDispatchInput): Promise<{ ok: boolean; error?: string }> {
  const projected = lookupByMcpName(input.tool);
  if (!projected) return { ok: false, error: `tool "${input.tool}" is not registered` };
  const { PROJECTED_DEPS } = await import('../projected-tool-deps');
  try {
    const result = await withWorkspace(input.workspaceId, (tx) =>
      dispatchProjectedTool(projected, input.tool, input.args, { ...buildWearerReactionCtx(input), tx }, PROJECTED_DEPS));
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error ? `${result.error.code}: ${result.error.message}` : 'reaction failed' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface IdentityReactionDeps {
  sql: Sql;
  readWearer: (ownerId: string, workspaceId: string) => Promise<IdentityWearer | null>;
  resolvePot: (workspaceId: string, harnessSlug: string) => Promise<string | null>;
  validateFire: (workspaceId: string, fire: string) => Promise<ValidateClassFireResult>;
  resolveFire: (workspaceId: string, potSlug: string, fire: string) => Promise<ResolveClassFireResult>;
  readCeiling: (input: { workspaceId: string; harnessSlug: string; role: string }) => Promise<IdentityReactionCeiling>;
  isRegisteredTool: (tool: string) => boolean;
  /** The operation submit tool and the capabilities it declares; null when it is not registered here. */
  readOperationSubmit: () => Promise<{ tool: string; capabilities: readonly string[] } | null>;
  dispatch: (input: IdentityDispatchInput) => Promise<{ ok: boolean; error?: string }>;
}

function defaultDeps(): IdentityReactionDeps {
  return {
    sql: getOrgPg().sql,
    readWearer: (ownerId, workspaceId) => readIdentityWearer(ownerId, workspaceId),
    resolvePot: async (workspaceId, harnessSlug) => {
      const { resolvePotSlugsForHarnesses } = await import('../memory/hive-scope');
      return (await resolvePotSlugsForHarnesses(workspaceId, [harnessSlug]))[0] ?? null;
    },
    validateFire: (workspaceId, fire) =>
      withWorkspace(workspaceId, (tx) => validateClassFireTarget(tx, workspaceId, fire)),
    resolveFire: (workspaceId, potSlug, fire) =>
      withWorkspace(workspaceId, (tx) =>
        resolveClassFireTarget(tx, { workspaceId, potSlug, fire, providerKinds: IDENTITY_REACTION_PROVIDER_KINDS })),
    readCeiling: async (input) => {
      const { readIdentityReactionCeiling } = await import('../capability-envelope/identity-grants-port');
      return readIdentityReactionCeiling(input);
    },
    isRegisteredTool: (tool) => lookupByMcpName(tool) != null,
    readOperationSubmit: async () => {
      const { BLUEPRINT_OPERATION_TOOLS } = await import('../blueprint/operation-contract');
      const projected = lookupByMcpName(BLUEPRINT_OPERATION_TOOLS.submit);
      return projected ? { tool: BLUEPRINT_OPERATION_TOOLS.submit, capabilities: [...projected.capabilities] } : null;
    },
    dispatch: dispatchAsWearer,
  };
}

/**
 * The durable step body. Returns the outcome it recorded; THROWS only when a
 * live lookup fails (the step retries, and the workflow records `failed` once
 * retries are exhausted).
 */
export async function executeIdentityReaction(
  payload: IdentityReactionPayload,
  overrides: Partial<IdentityReactionDeps> = {},
): Promise<IdentityReactionOutcome> {
  const deps = { ...defaultDeps(), ...overrides };
  const prior = await beginIdentityReceipt(deps.sql, payload);
  if (prior !== 'authorizing') return { status: 'replayed', prior };

  const settle = (outcome: Parameters<typeof settleIdentityReceipt>[2]) =>
    withPgRetry(() => settleIdentityReceipt(deps.sql, payload.receiptId, outcome));
  const refuse = async (
    code: IdentityRefusalCode, reason: string, attribution: { fire?: string; contributor?: string } = {},
  ): Promise<IdentityReactionOutcome> => {
    await settle({ status: 'refused', error: `${code}: ${reason}`, ...attribution });
    return { status: 'refused', code, reason };
  };
  const cancelStaleRow = () => cancelIdentityRuleSubscription(deps.sql, {
    workspaceId: payload.workspaceId, ownerId: payload.ownerId,
    subscriberId: payload.subscriberId, eventKey: payload.eventKey,
  });

  // 1. The wearer, as it is now.
  const wearer = await deps.readWearer(payload.ownerId, payload.workspaceId);
  if (!wearer) {
    await cancelStaleRow();
    return refuse('detached', `${payload.ownerId} wears no applied identity in ${payload.workspaceId}`);
  }
  if (wearer.revisionTag !== payload.revisionTag) {
    await cancelStaleRow();
    return refuse('attachment-changed',
      `the subscription was written for revision ${payload.revisionTag}; ${payload.ownerId} now wears ${wearer.revisionTag}`);
  }

  // 2. The rule, as the applied revision pins it.
  const entry = wornAsyncRules(wearer.rules.pins).rules.find((candidate) => candidate.pinRef === payload.pinRef);
  if (!entry || entry.rule.on !== payload.eventKey) {
    const unreadable = wearer.rules.pins.unreadable.find((candidate) => candidate.pinRef === payload.pinRef);
    return refuse('rule-changed', unreadable
      ? `rule pin ${payload.pinRef} no longer parses: ${unreadable.error}`
      : `revision ${payload.revisionTag} does not wear async rule ${payload.pinRef} on ${payload.eventKey}`);
  }
  const attribution = { fire: entry.rule.fire, contributor: `identity:${entry.identityId}` };

  // 3. The rule's condition, over this fire.
  if (entry.rule.when &&
      !evaluateDataCondition(entry.rule.when as DataCondition, { key: payload.eventKey, payload: payload.eventPayload })) {
    return refuse('when-false', `rule ${payload.pinRef} does not match this fire`, attribution);
  }

  // 4. The pot the wearer is in, and its binding for the class verb.
  if (!wearer.harnessSlug) {
    return refuse('unbound', `${payload.ownerId} is scoped to no harness, so no pot binding can be resolved`, attribution);
  }
  const potSlug = await deps.resolvePot(payload.workspaceId, wearer.harnessSlug);
  if (!potSlug) {
    return refuse('unbound', `harness "${wearer.harnessSlug}" resolves to no pot`, attribution);
  }
  const validated = await deps.validateFire(payload.workspaceId, entry.rule.fire);
  if (!validated.ok) return refuse('class-invalid', validated.error, attribution);
  const resolved = await deps.resolveFire(payload.workspaceId, potSlug, entry.rule.fire);
  if (resolved.status !== 'resolved') {
    return refuse(resolved.status === 'unbound' ? 'unbound' : 'class-invalid', resolved.error, attribution);
  }
  const bound = `class ${resolved.target.classRef} verb ${resolved.target.verb}`;

  // What the dispatch is: the bound tool itself, or — for an operation provider
  // — the blueprint submit of the bound operation under a receipt-derived key
  // (D-030 §4). Either way it goes through the one wearer dispatch below.
  const ruleArgs = (entry.rule.args ?? {}) as Record<string, unknown>;
  let dispatch: { tool: string; args: Record<string, unknown>; capabilities: readonly string[] };
  if (resolved.providerKind === 'operation') {
    if (!resolved.operationHarnessSlug) {
      return refuse('unbound', `${bound} resolves to operation provider ${resolved.providerPackage}@${resolved.providerVersion}, which pins no harness`, attribution);
    }
    const submit = await deps.readOperationSubmit();
    if (!submit) return refuse('unbound', `${bound} resolves to a blueprint operation, but no operation submit tool is registered`, attribution);
    dispatch = {
      tool: submit.tool,
      args: {
        harness: resolved.operationHarnessSlug,
        operationId: resolved.tool,
        requestKey: identityOperationRequestKey(payload.receiptId),
        input: ruleArgs,
      },
      capabilities: submit.capabilities,
    };
  } else if (resolved.providerKind === 'tool') {
    if (!deps.isRegisteredTool(resolved.tool)) {
      return refuse('unbound', `${bound} resolves to "${resolved.tool}", which is not a registered tool`, attribution);
    }
    dispatch = { tool: resolved.tool, args: ruleArgs, capabilities: [] };
  } else {
    return refuse('unbound', `${bound} resolves to a ${resolved.providerKind} provider, which an identity reaction does not dispatch`, attribution);
  }

  // 5. The allowlist the dispatch is held to.
  const ceiling = await deps.readCeiling({
    workspaceId: payload.workspaceId, harnessSlug: wearer.harnessSlug, role: wearer.role,
  });
  const allowlist = identityReactionAllowlist({
    capability: validated.capability,
    target: validated.target,
    declaredClassNeeds: wearer.rules.declaredClassNeeds,
    ceiling,
    dispatchCapabilities: dispatch.capabilities,
  });
  if (!allowlist.ok) return refuse('capability-empty', allowlist.reason, attribution);

  // 6. Dispatch as the wearer.
  const dispatched = await deps.dispatch({
    workspaceId: payload.workspaceId,
    ownerId: payload.ownerId,
    role: wearer.role,
    harnessSlug: wearer.harnessSlug,
    tool: dispatch.tool,
    args: dispatch.args,
    capabilities: allowlist.capabilities,
    cause: { depth: 1, chain: [payload.pinRef], ruleId: payload.pinRef, rootRunId: payload.fireId },
  });
  if (!dispatched.ok) {
    const error = dispatched.error ?? 'reaction failed';
    await settle({ status: 'failed', error, ...attribution });
    return { status: 'failed', tool: dispatch.tool, error };
  }
  await settle({ status: 'fired', error: null, ...attribution });
  return { status: 'fired', tool: dispatch.tool };
}
