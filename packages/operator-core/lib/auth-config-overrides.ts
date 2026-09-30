/**
 * Runtime §G auth/sandbox overrides (live-configurability-audit-2026-06-20 P-019).
 *
 * Three baked auth/security literals become runtime-settable, read through a D-010 module SYNC cache
 * GATED by the DARK `papercusp-auth-config-overrides` flag (owner-authority — the owner flips it ON to
 * ratify the dials). OFF (default) ⇒ the cache stays empty ⇒ every surface uses its baked literal ⇒
 * byte-identical.
 *
 *   - `fullAccessRoles` → auth:set_full_access_roles REPLACES the baked TESTING_FULL_ACCESS_ROLES
 *     gate-bypass set (the strongest escalation in the system — adding a role lets it skip ALL
 *     role+capability gates, so this is the reason the whole cluster is dark). Reached by agent-mcp's
 *     gate-bypass via the host resolver installed below.
 *   - `safeToolsRemove` → clamp:set_safe_tools NARROWS the scoped-SU cross-workspace allowlist
 *     (SCOPED_SAFE_CROSSWORKSPACE). TIGHTEN-ONLY: a REMOVE-set (you can only take tools OUT of the
 *     allowlist), never an add — narrowing can only reduce a scoped superuser's reach.
 *   - `sandboxMaskAdditions` / `sandboxDenyAllEgress` → exec_sandbox:set_policy ADDS sandbox mask dirs
 *     (unioned over CAPABILITY_SANDBOX_MASK_DIRS) and/or forces deny-all-egress. TIGHTEN-ONLY:
 *     add-masks / lock-down only — it can never UNMASK a baked dir or RE-OPEN egress.
 *
 * Separately, the `papercusp-testing-full-access` flag is the runtime master kill-switch (the env→flag
 * conversion of PAPERCUSP_TESTING_FULL_ACCESS_ROLES=off): OFF ⇒ testing-full-access is globally
 * disabled (the resolver returns false for every role). Default ON ⇒ current behaviour. This flag is
 * read REGARDLESS of the dark override flag (the kill-switch must work even with no override set).
 *
 * The module import is PURE (no import-time getFlag/PG read, and no flag-binding ACCESS either) —
 * importing it on the dispatch hot path (via gate-bypass's resolver, the clamp, or exec-sandbox)
 * never does IO; the getters are plain cache reads. Refresh on (a) onFlagChange(null | the two
 * flags), armed on first use by every reader — see ./lazy-flag-refresh — plus the explicit host-boot
 * warm `armAuthConfigRefresh()`, (b) local write, (c) a ~60s unref timer.
 */
import { getFlag } from '@papercusp/flags/server';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';
import { setTestingFullAccessResolver } from '@papercusp/agent-mcp';
import { lazyFlagRefresh } from './lazy-flag-refresh';
import { systemDistinctId } from './flag-distinct-id';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

const STATE_TABLE = 'operator_auth_config' as const;

export interface AuthConfigOverrides {
  /** REPLACES the baked TESTING_FULL_ACCESS_ROLES bypass set (escalation; dark-gated). */
  fullAccessRoles?: string[];
  /** Tools to REMOVE from the scoped-SU cross-workspace allowlist (narrow-only). */
  safeToolsRemove?: string[];
  /** Extra home-relative dirs to ADD to the sandbox mask set (add-only). */
  sandboxMaskAdditions?: string[];
  /** Force deny-all-egress in the capability sandbox (lock-down only; undefined ⇒ defer to the env). */
  sandboxDenyAllEgress?: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const strList = (xs: unknown): string[] =>
  Array.isArray(xs) ? [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];

// ── D-010 sync cache ──────────────────────────────────────────────────────────
let overridesEnabled = false; // papercusp-auth-config-overrides (DARK)
let testingFullAccessEnabled = true; // papercusp-testing-full-access (kill-switch; default ON)
let cached: AuthConfigOverrides = {};
// Derived structures recomputed on refresh so the hot-path getters never allocate.
let fullAccessSet: ReadonlySet<string> | null = null;
let safeToolsRemoveSet: ReadonlySet<string> = EMPTY_SET;
let maskAdditions: readonly string[] = [];
// Set by the first completed refresh. `refreshAuthConfigOverrides` is EXPORTED (and called by the
// write path), so an arm that happens AFTER an explicit refresh must not re-seed a resolved value
// back to the flag default.
let resolved = false;

// Armed on FIRST USE, not at import (EI-19416650993725684 / WI-6650) — the import touches no flag
// binding, so a test that partially mocks `@papercusp/flags/server` can still collect. EVERY reader
// arms, including the HIDDEN one: `resolveTestingFullAccess` below is installed into agent-mcp's
// gate-bypass and reads the module vars directly, so arming only the exported getters would leave the
// actual auth gate unarmed. Hosts additionally warm it at boot via `armAuthConfigRefresh()`
// (host-bootstrap.ts), which restores the boot-time subscription the module-scope form used to give
// them. Declared ABOVE the readers so no reader can hit it in its temporal dead zone.
const armFlagRefresh = lazyFlagRefresh(refreshAuthConfigOverrides, {
  keys: [FLAGS.AUTH_CONFIG_OVERRIDES, FLAGS.TESTING_FULL_ACCESS],
  unpopulated: {
    kind: 'seeded-from-flag-default',
    serves:
      'FLAG_DEFAULTS[AUTH_CONFIG_OVERRIDES] (false, DARK owner-authority ⇒ empty override set ⇒ every ' +
      'surface uses its baked literal) and FLAG_DEFAULTS[TESTING_FULL_ACCESS] (true ⇒ current ' +
      'behaviour). That is exactly what the module-scope form served before its boot reload landed. ' +
      'The only divergence is a kill-switch flipped OFF not yet honoured on the first read in a fresh ' +
      'process; hosts close that by arming at boot, and the ~60s timer below bounds it everywhere else.',
  },
  seed: () => {
    if (resolved) return;
    overridesEnabled = FLAG_DEFAULTS[FLAGS.AUTH_CONFIG_OVERRIDES] === true;
    testingFullAccessEnabled = FLAG_DEFAULTS[FLAGS.TESTING_FULL_ACCESS] !== false;
    recomputeDerived();
  },
});

/**
 * Explicit boot warm (host-bootstrap.ts). Idempotent — the same arm every reader calls. Exists because
 * this cache's unpopulated state is the PERMISSIVE one for the testing-full-access kill-switch, so a
 * long-running host should subscribe at boot rather than on its first gate-bypass check.
 */
export function armAuthConfigRefresh(): void {
  armFlagRefresh();
}

function recomputeDerived(): void {
  if (!overridesEnabled) {
    fullAccessSet = null;
    safeToolsRemoveSet = EMPTY_SET;
    maskAdditions = [];
    return;
  }
  const roles = strList(cached.fullAccessRoles);
  fullAccessSet = roles.length ? new Set(roles) : null;
  const removes = strList(cached.safeToolsRemove);
  safeToolsRemoveSet = removes.length ? new Set(removes) : EMPTY_SET;
  maskAdditions = strList(cached.sandboxMaskAdditions);
}

// ── hot-path getters (SYNC, zero-await) ───────────────────────────────────────
/** Tools to subtract from SCOPED_SAFE_CROSSWORKSPACE (narrow-only). Empty when off/unset. */
export function authSafeToolsRemoveSet(): ReadonlySet<string> {
  armFlagRefresh();
  return safeToolsRemoveSet;
}
/** Extra sandbox mask dirs to union over CAPABILITY_SANDBOX_MASK_DIRS (add-only). Empty when off/unset. */
export function authSandboxMaskAdditions(): readonly string[] {
  armFlagRefresh();
  return maskAdditions;
}
/** Deny-all-egress override (undefined ⇒ defer to the env). Only honoured when the dark flag is ON. */
export function authSandboxDenyAllEgressOverride(): boolean | undefined {
  armFlagRefresh();
  return overridesEnabled ? cached.sandboxDenyAllEgress : undefined;
}

// The gate-bypass resolver (installed once below). Reads the live module vars each call — the HIDDEN
// reader, so it arms too.
function resolveTestingFullAccess(role: string | null | undefined): boolean | null {
  armFlagRefresh();
  if (!testingFullAccessEnabled) return false; // kill-switch flag OFF ⇒ globally disabled
  if (fullAccessSet) return role != null && fullAccessSet.has(role); // dark override REPLACES the baked set
  return null; // fall through to the baked TESTING_FULL_ACCESS_ROLES
}
setTestingFullAccessResolver(resolveTestingFullAccess);

export async function refreshAuthConfigOverrides(): Promise<void> {
  try {
    const [ovr, tfa] = await Promise.all([
      getFlag(FLAGS.AUTH_CONFIG_OVERRIDES, systemDistinctId()),
      getFlag(FLAGS.TESTING_FULL_ACCESS, systemDistinctId()),
    ]);
    overridesEnabled = ovr;
    testingFullAccessEnabled = tfa;
    cached = overridesEnabled ? (await readOperatorState<AuthConfigOverrides>(STATE_TABLE)) ?? {} : {};
  } catch {
    overridesEnabled = false;
    testingFullAccessEnabled = true; // fail SAFE to current behaviour (testing-full-access on)
    cached = {};
  }
  resolved = true;
  recomputeDerived();
}
// P-008: visible in schedule:inventory as a 'cache' timer (per-process config memo refresh).
managedSetInterval('config-refresh:auth-config', 60_000, () => refreshAuthConfigOverrides(), {
  category: 'cache',
});

// ── async read/write (the tools) ──────────────────────────────────────────────
export async function readAuthConfigOverrides(): Promise<AuthConfigOverrides> {
  return (await readOperatorState<AuthConfigOverrides>(STATE_TABLE)) ?? {};
}

async function persist(next: AuthConfigOverrides): Promise<AuthConfigOverrides> {
  await writeOperatorState<AuthConfigOverrides>(STATE_TABLE, next);
  await refreshAuthConfigOverrides(); // same-process immediacy
  return next;
}

/** Set (or clear, when roles=null) the full-access bypass-role REPLACEMENT set (escalation; dark-gated). */
export async function setFullAccessRoles(roles: string[] | null): Promise<AuthConfigOverrides> {
  const cur = await readAuthConfigOverrides();
  const next = { ...cur };
  if (roles === null) delete next.fullAccessRoles;
  else next.fullAccessRoles = strList(roles);
  return persist(next);
}

/** Set (or clear, when tools=null) the scoped-SU safe-tool REMOVE set (narrow-only). */
export async function setSafeToolsRemove(tools: string[] | null): Promise<AuthConfigOverrides> {
  const cur = await readAuthConfigOverrides();
  const next = { ...cur };
  if (tools === null) delete next.safeToolsRemove;
  else next.safeToolsRemove = strList(tools);
  return persist(next);
}

/** Set the sandbox policy override: ADD mask dirs (add-only) and/or force deny-all-egress. null clears. */
export async function setSandboxPolicy(
  policy: { maskAdditions?: string[] | null; denyAllEgress?: boolean | null } | null,
): Promise<AuthConfigOverrides> {
  const cur = await readAuthConfigOverrides();
  const next = { ...cur };
  if (policy === null) {
    delete next.sandboxMaskAdditions;
    delete next.sandboxDenyAllEgress;
  } else {
    if (policy.maskAdditions !== undefined) {
      if (policy.maskAdditions === null) delete next.sandboxMaskAdditions;
      else next.sandboxMaskAdditions = strList(policy.maskAdditions);
    }
    if (policy.denyAllEgress !== undefined) {
      if (policy.denyAllEgress === null) delete next.sandboxDenyAllEgress;
      else next.sandboxDenyAllEgress = policy.denyAllEgress;
    }
  }
  return persist(next);
}

export async function setAuthConfigOverrides(o: AuthConfigOverrides): Promise<void> {
  await persist(o ?? {});
}
export async function resetAuthConfigOverrides(): Promise<void> {
  await persist({});
}

// ── config:list-overrides / config:reset-overrides registration (D-005) ───────
registerOverrideConcern({
  name: 'auth-config-overrides',
  description:
    'runtime §G auth/sandbox overrides — full-access bypass roles (replace), scoped-SU safe-tools (narrow), sandbox mask dirs/egress (tighten). DARK: papercusp-auth-config-overrides',
  auditAction: 'auth:set_full_access_roles',
  diff: async () => {
    const o = await readAuthConfigOverrides();
    const entries: OverrideEntry[] = [];
    if (o.fullAccessRoles?.length) {
      entries.push({ key: 'fullAccessRoles', effective: o.fullAccessRoles, default: 'TESTING_FULL_ACCESS_ROLES baked', layer: 'pg-settings' });
    }
    if (o.safeToolsRemove?.length) {
      entries.push({ key: 'safeToolsRemove', effective: o.safeToolsRemove, default: [], layer: 'pg-settings' });
    }
    if (o.sandboxMaskAdditions?.length) {
      entries.push({ key: 'sandboxMaskAdditions', effective: o.sandboxMaskAdditions, default: [], layer: 'pg-settings' });
    }
    if (o.sandboxDenyAllEgress !== undefined) {
      entries.push({ key: 'sandboxDenyAllEgress', effective: o.sandboxDenyAllEgress, default: 'env PAPERCUSP_CAPABILITY_SANDBOX_DENY_ALL_EGRESS', layer: 'pg-settings' });
    }
    return entries;
  },
  capture: () => readAuthConfigOverrides(),
  reset: () => resetAuthConfigOverrides(),
  restore: (snap) => setAuthConfigOverrides((snap as AuthConfigOverrides) ?? {}),
});
