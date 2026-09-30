/**
 * account-session-override — the owner's "session-now" steer over WHICH pool accounts
 * the fleet may spawn/deploy on (accounts-pool-tab-2026-06-15 P-004; owner greenlit
 * "allow-list + exclude", whole-fleet, no TTL). The account sibling of owner-steering.ts
 * (the Queen-focus lever).
 *
 * Two axes, both empty by default (⇒ EXACTLY today's selection — purely additive):
 *   forcedAccounts   — the Queen may use ONLY these (allow-list). Empty ⇒ no restriction.
 *   excludeAccounts  — skip these (e.g. a flaky / rate-limited account). Empty ⇒ skip none.
 *
 * Applied as a precedence layer BEFORE the existing headroom/drain selectors
 * (account-pool-store.ts): restrict to `forced`, drop `exclude`, then select among
 * what survives. FAIL-SOFT and NO-OP-WHEN-UNSET — a read error or an empty override is
 * exactly the pre-override behaviour, so it can never wedge the live spawn chokepoint.
 *
 * WORKSPACE-LEVEL, not per-hive (D-015): persisted as a single-row-per-workspace JSONB
 * in `harness_shared.operator_account_override` (migration 297) — the operator-state
 * idiom, the same store the account POOL uses. The original P-004 design keyed it to the
 * home hive's hive_settings, which broke when no home hive was configured
 * ("no_home_harness") and split the write key from the read key. Living in its own
 * operator-state row (apart from operator_account_pool) keeps the owner's intent from
 * being clobbered by the pool's high-churn rate-projection writes.
 */
import { readOperatorState, writeOperatorState } from '../operator-state-pg';
import { activeWorkspaceId } from '../workspace-registry';
import { registerOverrideConcern, type OverrideEntry } from '../config-overrides/registry';
import { AccountPoolError } from './account-pool';

/** The decoded override. Both lists empty + no default ⇒ no steer at all (today's behaviour). */
export interface AccountSessionOverride {
  /** Allow-list — the fleet may use ONLY these account ids. Empty ⇒ no restriction. */
  forcedAccounts: string[];
  /** Skip these account ids (e.g. a flaky / rate-limited account). Empty ⇒ skip none. */
  excludeAccounts: string[];
  /**
   * The pool account that stands in for this box's own `~/.claude` login
   * (default-deploy-account-2026-08-08 D-001). Unset ⇒ the local login, exactly as before.
   *
   * This is a DIFFERENT AXIS from the two lists above: they RESTRICT what may be selected,
   * this one only replaces the implicit fallback when nothing else pinned a choice. A
   * default therefore never narrows the pool and never defeats failover — see D-003, and
   * note `isOverrideEmpty` below deliberately ignores it.
   */
  defaultAccountId?: string;
}

export const DEFAULT_ACCOUNT_OVERRIDE: AccountSessionOverride = { forcedAccounts: [], excludeAccounts: [] };

/** EXPORTED so `account-default-marker-rule.ts` can PIN its own copy of this table
 *  name against the real one in a test, instead of silently duplicating it (the
 *  rule must not import this module at module scope — that would pull the operator
 *  -state/PG stack into every `events/rules.ts` import). */
export const OVERRIDE_STATE_TABLE = 'operator_account_override' as const;

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

/**
 * True when the override imposes no RESTRICTION at all (the common, no-op case).
 *
 * ⚠ Deliberately ignores `defaultAccountId`. This gates the candidate-narrowing path in
 * account-pool-store (`isOverrideEmpty(override) ? wholePool : applyAccountOverride(...)`),
 * and a default is a FALLBACK preference, not a restriction — folding it in here would make
 * the selectors treat "I picked a default" as "narrow the pool", silently killing failover.
 * If you need "has the owner steered accounts at all", ask for that explicitly rather than
 * widening this predicate.
 */
export function isOverrideEmpty(o: AccountSessionOverride): boolean {
  return o.forcedAccounts.length === 0 && o.excludeAccounts.length === 0;
}

/**
 * Apply the override to a candidate account-id list: restrict to `forced` (when set),
 * then drop `exclude`. Pure + order-preserving. An empty override returns the input
 * unchanged (no-op); an over-restrictive one may return [] (the caller fails soft to the
 * frame-default credential, exactly as an empty pool does today).
 */
export function applyAccountOverride(accountIds: readonly string[], o: AccountSessionOverride): string[] {
  let ids = [...accountIds];
  if (o.forcedAccounts.length > 0) {
    const allow = new Set(o.forcedAccounts);
    ids = ids.filter((id) => allow.has(id));
  }
  if (o.excludeAccounts.length > 0) {
    const deny = new Set(o.excludeAccounts);
    ids = ids.filter((id) => !deny.has(id));
  }
  return ids;
}

export interface AccountSessionOverridePatch {
  forcedAccounts?: string[];
  excludeAccounts?: string[];
  /**
   * Set (non-empty string) or CLEAR (`null`) the default account. Omitted ⇒ untouched.
   * `null` is meaningful and distinct from omission, which is why this is `?: string | null`
   * rather than `?: string` — there must be a way to say "go back to the ~/.claude login".
   */
  defaultAccountId?: string | null;
  /** Wipe every axis — both lists AND the default — back to no steer. */
  clear?: boolean;
  /** Explicitly acknowledge narrowing a non-empty pool to zero routable accounts. */
  confirmCollapse?: boolean;
}

/** Trim to a usable account id, or undefined. Empty/whitespace ⇒ undefined (= unset). */
function asAccountId(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export interface AccountSessionOverrideValidation {
  poolAccountIds: string[];
  unknownAccountIds: string[];
  conflictingAccountIds: string[];
  effectiveAccountIds: string[];
  errors: string[];
  warning?: string;
}

/**
 * Validate the restriction axes against a concrete pool snapshot. This stays pure so the
 * write-time guard and its recurrence tests share exactly the same set semantics as the
 * live admission filter.
 */
export function validateAccountOverrideAgainstPool(
  override: AccountSessionOverride,
  poolAccountIds: readonly string[],
  confirmCollapse = false,
): AccountSessionOverrideValidation {
  const pool = [...new Set(poolAccountIds)];
  const poolSet = new Set(pool);
  const forced = [...new Set(override.forcedAccounts)];
  const excluded = [...new Set(override.excludeAccounts)];
  const configured = [...new Set([...forced, ...excluded])];
  const unknownAccountIds = configured.filter((id) => !poolSet.has(id));
  const excludedSet = new Set(excluded);
  const conflictingAccountIds = forced.filter((id) => excludedSet.has(id));
  const effectiveAccountIds = applyAccountOverride(pool, { forcedAccounts: forced, excludeAccounts: excluded });
  const errors: string[] = [];

  if (unknownAccountIds.length > 0) {
    errors.push(
      `session override names account id(s) not present in the account pool: ${unknownAccountIds.join(', ')}. ` +
        'Refresh accounts:list and use the pool ids rather than a domain or display name.',
    );
  }
  if (conflictingAccountIds.length > 0) {
    errors.push(
      `session override places account id(s) in both forcedAccounts and excludeAccounts: ${conflictingAccountIds.join(', ')}. ` +
        'Remove each id from one axis before saving the override.',
    );
  }
  if (pool.length > 0 && effectiveAccountIds.length === 0) {
    const collapseMessage =
      `session override would collapse the non-empty account pool (${pool.length} account(s)) to zero routable accounts. ` +
      'If this narrowing is intentional, re-send with confirmCollapse:true; otherwise revise the override.';
    if (confirmCollapse) {
      return {
        poolAccountIds: pool,
        unknownAccountIds,
        conflictingAccountIds,
        effectiveAccountIds,
        errors,
        warning: `pool-collapse confirmed by caller (confirmCollapse:true): ${collapseMessage}`,
      };
    }
    errors.push(collapseMessage);
  }

  return { poolAccountIds: pool, unknownAccountIds, conflictingAccountIds, effectiveAccountIds, errors };
}

/** Read the persisted pool ids without importing the IO-owning account-pool-store (cycle guard). */
async function readAccountPoolIds(workspaceId: string): Promise<string[] | null> {
  try {
    const raw = await readOperatorState<{ accounts?: unknown }>('operator_account_pool', workspaceId);
    if (!raw || !Array.isArray(raw.accounts)) return null;
    return raw.accounts.filter((account): account is { id: string } => {
      return !!account && typeof account === 'object' && typeof (account as { id?: unknown }).id === 'string';
    }).map((account) => account.id);
  } catch {
    // The override is a fail-soft routing layer. If the pool itself cannot be read, preserve
    // the existing write behaviour and let the next capacity/admission read expose the issue.
    return null;
  }
}

/** Read the workspace's account override (no hive needed; missing row ⇒ no steer). */
export async function getAccountOverride(workspaceId: string): Promise<AccountSessionOverride> {
  const raw = await readOperatorState<Partial<AccountSessionOverride>>(OVERRIDE_STATE_TABLE, workspaceId);
  const defaultAccountId = asAccountId(raw?.defaultAccountId);
  return {
    forcedAccounts: asStringArray(raw?.forcedAccounts),
    excludeAccounts: asStringArray(raw?.excludeAccounts),
    // Omit the key entirely when unset so the shape matches DEFAULT_ACCOUNT_OVERRIDE and
    // `toEqual` comparisons in existing callers/tests keep passing.
    ...(defaultAccountId ? { defaultAccountId } : {}),
  };
}

/**
 * Write an override patch (read-modify-write the single row). `clear:true` wipes both;
 * otherwise only the provided axes change ([] clears that axis; omitted is untouched).
 * Returns the resulting override.
 */
export async function setAccountOverride(
  workspaceId: string,
  patch: AccountSessionOverridePatch,
): Promise<AccountSessionOverride> {
  if (patch.clear) {
    await writeOperatorState(OVERRIDE_STATE_TABLE, DEFAULT_ACCOUNT_OVERRIDE, workspaceId);
    return DEFAULT_ACCOUNT_OVERRIDE;
  }
  const cur = await getAccountOverride(workspaceId);
  // null ⇒ clear; a string ⇒ set; omitted ⇒ keep. `?? undefined` collapses null to unset.
  const nextDefault =
    patch.defaultAccountId !== undefined ? asAccountId(patch.defaultAccountId) : cur.defaultAccountId;
  const next: AccountSessionOverride = {
    forcedAccounts: patch.forcedAccounts !== undefined ? asStringArray(patch.forcedAccounts) : cur.forcedAccounts,
    excludeAccounts: patch.excludeAccounts !== undefined ? asStringArray(patch.excludeAccounts) : cur.excludeAccounts,
    ...(nextDefault ? { defaultAccountId: nextDefault } : {}),
  };
  // Validate at the write boundary, before a bad id or an unsatisfiable override can become
  // durable state. A missing/empty pool is intentionally not a collapse: setup may write the
  // steer before the first account is registered, and a transient pool read must not wedge the
  // account-control surface.
  const poolAccountIds = await readAccountPoolIds(workspaceId);
  if (poolAccountIds !== null) {
    const validation = validateAccountOverrideAgainstPool(next, poolAccountIds, patch.confirmCollapse === true);
    if (validation.errors.length > 0) throw new AccountPoolError(validation.errors.join(' '));
  }
  await writeOperatorState(OVERRIDE_STATE_TABLE, next, workspaceId);
  return next;
}

// Self-register as a runtime-config override concern (P-024 registry / sentinel-herald P-037):
// the owner's session-now account allow/exclude steer shows up in config:list-overrides, and
// config:reset-overrides wipes it back to no-restriction (the "drop my account steer" lever).
// The two axes are intrinsically paired but reported per-axis (each empty by default), so the
// readback shows exactly which steer is active.
registerOverrideConcern({
  name: 'account-session-override',
  description:
    "owner's account steer (forcedAccounts allow-list / excludeAccounts / defaultAccountId)",
  auditAction: 'accounts:set-session-override',
  diff: async () => {
    const o = await getAccountOverride(activeWorkspaceId());
    const entries: OverrideEntry[] = [];
    if (o.forcedAccounts.length > 0) entries.push({ key: 'forcedAccounts', effective: o.forcedAccounts, default: [], layer: 'pg-settings' });
    if (o.excludeAccounts.length > 0) entries.push({ key: 'excludeAccounts', effective: o.excludeAccounts, default: [], layer: 'pg-settings' });
    // The default's DEFAULT is the box's own ~/.claude login, which has no account id —
    // hence null, not '' (an empty string would read as "an account named ''").
    if (o.defaultAccountId) entries.push({ key: 'defaultAccountId', effective: o.defaultAccountId, default: null, layer: 'pg-settings' });
    return entries;
  },
  capture: () => getAccountOverride(activeWorkspaceId()),
  reset: () => setAccountOverride(activeWorkspaceId(), { clear: true }),
  restore: async (snap) => {
    const o = snap as AccountSessionOverride;
    await setAccountOverride(activeWorkspaceId(), {
      forcedAccounts: o.forcedAccounts,
      excludeAccounts: o.excludeAccounts,
      // Explicit null (not undefined) so restoring a snapshot taken with NO default
      // actually CLEARS a default set since — otherwise restore silently keeps it.
      defaultAccountId: o.defaultAccountId ?? null,
    });
  },
});
