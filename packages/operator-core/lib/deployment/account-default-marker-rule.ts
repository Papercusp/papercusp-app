/**
 * EI-19944784972017743 — keep the per-process default-account marker fresh on a
 * SIBLING host, without polling.
 *
 * THE GAP THIS CLOSES. `PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE` is a per-PROCESS env
 * marker (papercusp-shared must not import operator-core, so env is the seam).
 * `setDefaultAccount` publishes it in whichever process served the write — the
 * operator — and `syncDefaultAccountEnv` republishes it at host boot. A sibling
 * long-lived host (papercup-bg-host) that booted EARLIER therefore keeps its
 * stale value until it next restarts, and `chooseStatelessTransport` goes on
 * sending that host's in-process anthropic-direct family (judges, sim-users,
 * summarisers, memory session-extraction, Scout ideators) to this box's
 * `~/.claude` login — which is precisely the traffic nominating a default pool
 * account is meant to move. The stale marker can only be wrong about WHICH LEG,
 * never about which account, so this is a routing-preference bug, not a
 * correctness one; both legs work.
 *
 * WHY A REACTION AND NOT A CADENCE. `syncDefaultAccountEnv`'s own docstring
 * offered "call on a cadence in any long-lived host", but the override table
 * ALREADY emits a change event: `harness_shared.operator_account_override` has
 * the `emit_change_notify_trg` trigger, whose `pg_notify('sync_invalidate', …)`
 * every operator host process picks up on the LISTEN it starts at boot
 * (`ensureInvalidationListener`, called from hono-host — bg-host runs that same
 * entrypoint), and `bridgeTriggerEvent` taps it into the in-process reaction
 * matcher as `<schema>.<table>.changed`. So the push already exists end to end;
 * a timer would re-poll PG from every host to re-discover what the change stream
 * is already delivering, and would still leave the marker wrong for up to one
 * interval. This reacts on the write instead.
 *
 * Registered from `events/rules.ts` beside the other first-party rules.
 */

import { registerReactionRule, TABLE_CHANGED_KEY } from '../events/registry';
import { tableNameFromChangedEvent } from '../events/cache-eca-rule';
import { ACCOUNT_DEFAULT_MARKER_SYNC_ACTION } from '../events/builtin-actions';
import type { ToolInvocationEvent } from '../events/types';

/** The rule id (stable — re-registering replaces; used in tests + the reactive graph). */
export const ACCOUNT_DEFAULT_MARKER_RULE_ID = 'accounts:default-marker-resync';

/**
 * The operator-state table carrying the owner's account override (its
 * `defaultAccountId` is what the marker reflects).
 *
 * A deliberate local copy, NOT an import: pulling `account-session-override` in
 * here would drag the operator-state/PG stack into every `events/rules.ts`
 * import, which is a module-scope cost paid by every process and every test that
 * touches the events file. It is PINNED instead — `account-default-marker-rule.test.ts`
 * asserts this equals the exported `OVERRIDE_STATE_TABLE`, so a rename fails a
 * test rather than silently making this rule match nothing (a dead rule is
 * indistinguishable from "the default never changed").
 */
const OVERRIDE_TABLE = 'operator_account_override';

/**
 * Register the override-change → marker-resync rule. Idempotent (stable id).
 *
 * Deliberately NOT flag-gated, unlike the cache ECA: the marker is a routing
 * preference the owner set explicitly, and there is no state in which honouring
 * it later than necessary is the wanted behaviour.
 */
export function registerAccountDefaultMarkerRule(): void {
  registerReactionRule({
    id: ACCOUNT_DEFAULT_MARKER_RULE_ID,
    on: TABLE_CHANGED_KEY,
    when: (e: ToolInvocationEvent) => tableNameFromChangedEvent(e.tool) === OVERRIDE_TABLE,
    fire: ACCOUNT_DEFAULT_MARKER_SYNC_ACTION,
    // The action re-reads the persisted override for the trigger's workspace; the
    // event's own payload carries no default-account state worth forwarding, and
    // re-reading is what makes a coalesced/replayed notify still land correctly.
    args: () => ({}),
    // A per-process side effect, like the cache bump: fire-and-forget in-process,
    // not durability-worthy. A missed resync self-heals — the next override write
    // re-fires this, and host boot re-syncs unconditionally.
    mode: 'sync',
    onlyOnSuccess: true,
    source: 'events-file',
  });
}
