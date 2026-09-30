/**
 * Worn async-rule SUBSCRIPTIONS (portable-identity-packages-2026-09-26 P-018;
 * D-027 §2, D-029 §1/§3/§4).
 *
 * Applying a wearer's package resources (D-018) replaces that wearer's identity
 * subscriptions: one `coord_entity_subscriptions` row per worn async rule,
 * `target_kind='event'`, `target_ref` = the rule's `on` key, `delivery_mode=
 * 'muted'` (the emit's notify fan-out never live-delivers it). The emit reads
 * these rows off the same latch statement it already runs and enqueues one
 * durable identity reaction per row.
 *
 * A row is an index of INTEREST, never a permit: the reaction re-reads the
 * wearer, the applied revision and the rule pin before it dispatches, so a
 * stale row can only produce a recorded refusal.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { CompiledAgentSpecification } from '@papercusp/orchestrator/blueprint';
import {
  IDENTITY_RULE_SUBSCRIPTION_KIND,
  identityRevisionTag,
  identityRuleSubscriberId,
  wornAsyncRules,
} from './identity-async-rules';
import { wornRulePins } from './sync-hook-rules';

export const IDENTITY_RULE_DELIVERY_MODE = 'muted';

export interface IdentityRuleSubscription {
  readonly subscriberId: string;
  /** The catalogued event key the rule is `on`. */
  readonly eventKey: string;
}

/** PURE: the rows a wearer of `artifact` holds, one per worn async rule. */
export function planIdentityRuleSubscriptions(
  ownerId: string,
  artifact: Pick<CompiledAgentSpecification, 'inputs' | 'specificationRevision'>,
): IdentityRuleSubscription[] {
  const tag = identityRevisionTag(artifact.specificationRevision);
  return wornAsyncRules(wornRulePins(artifact)).rules.map((entry) => ({
    subscriberId: identityRuleSubscriberId(ownerId, tag, entry.pinRef),
    eventKey: entry.rule.on,
  }));
}

/**
 * Replace the wearer's identity subscriptions with those `artifact` implies.
 * Runs inside the activation transaction, so the rows change exactly when the
 * applied revision does. An artifact with no async rules cancels every row
 * (detach); callers pass no artifact when the activation says nothing about
 * the identity (a legacy record, or a control-only activation), and then the
 * rows are left as they are (D-029 §4).
 */
export async function replaceIdentityRuleSubscriptions(tx: TransactionSql, input: {
  ownerId: string;
  workspaceId: string;
  artifact: Pick<CompiledAgentSpecification, 'inputs' | 'specificationRevision'>;
}): Promise<{ subscribed: number; cancelled: number }> {
  const planned = planIdentityRuleSubscriptions(input.ownerId, input.artifact);
  const cancelled = await tx`
    UPDATE harness_shared.coord_entity_subscriptions AS s
       SET cancelled_at = now()
     WHERE s.workspace_id = ${input.workspaceId}
       AND s.derived_from_kind = ${IDENTITY_RULE_SUBSCRIPTION_KIND}
       AND s.derived_from_ref = ${input.ownerId}
       AND s.cancelled_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM unnest(${planned.map((row) => row.subscriberId)}::text[],
                              ${planned.map((row) => row.eventKey)}::text[]) AS keep(subscriber_id, event_key)
          WHERE keep.subscriber_id = s.subscriber_id AND keep.event_key = s.target_ref)`;
  let subscribed = 0;
  for (const row of planned) {
    const inserted = await tx`
      INSERT INTO harness_shared.coord_entity_subscriptions
        (workspace_id, subscriber_id, target_kind, target_ref, delivery_mode, derived_from_kind, derived_from_ref)
      VALUES (${input.workspaceId}, ${row.subscriberId}, 'event', ${row.eventKey},
              ${IDENTITY_RULE_DELIVERY_MODE}, ${IDENTITY_RULE_SUBSCRIPTION_KIND}, ${input.ownerId})
      ON CONFLICT (workspace_id, subscriber_id, target_kind, target_ref) WHERE cancelled_at IS NULL DO NOTHING
      RETURNING id`;
    subscribed += inserted.length;
  }
  return { subscribed, cancelled: cancelled.count };
}

/**
 * Cancel one stale row a reaction found no longer worn (D-029 §4). Exact on
 * the subscriber id, which carries the revision tag, so a row the current
 * revision re-created under a different tag is untouched.
 */
export async function cancelIdentityRuleSubscription(
  sql: Sql | TransactionSql,
  input: { workspaceId: string; ownerId: string; subscriberId: string; eventKey: string },
): Promise<void> {
  await sql`
    UPDATE harness_shared.coord_entity_subscriptions
       SET cancelled_at = now()
     WHERE workspace_id = ${input.workspaceId}
       AND derived_from_kind = ${IDENTITY_RULE_SUBSCRIPTION_KIND}
       AND derived_from_ref = ${input.ownerId}
       AND subscriber_id = ${input.subscriberId}
       AND target_kind = 'event' AND target_ref = ${input.eventKey}
       AND cancelled_at IS NULL`;
}
