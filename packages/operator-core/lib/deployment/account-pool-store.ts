/**
 * Account-pool IO + wiring (`cloud-deployment-layer-2026-06-06` Phase 7).
 *
 * The pure decisions live in `account-pool.ts`; this file is the operator-side
 * host that connects them to the real world:
 *   - **persistence** — the pool is single-row-per-workspace JSONB in
 *     `harness_shared.operator_account_pool` (migration 190), the operator-state idiom.
 *   - **P-020 deploy-time selection** — `selectAccountForDeploy` binds the
 *     most-available account to a member's `DeploymentConfig.credentialRef/accountId`.
 *   - **P-019/P-021 rate bridge** — `initAccountScaleObserver` subscribes the
 *     existing governor `onGovernorPause` signal, records each account's pause into
 *     the pool projection, and (when sustained) emits a `rate-limit:exhausted:<id>`
 *     event + drives the scale-out reaction.
 *   - **P-021 scale-out** — `handleAccountExhausted` provisions a fresh Swarm (a new
 *     cloud frame on a fresh account) for the exhausted account's bound members,
 *     instead of only pausing. Deps are injected so the whole reaction is
 *     unit-testable with a mock driver (real provisioning is owner-gated).
 */
import type { DeploymentConfig, Frame, LogLevel } from '@papercusp/deployment-driver';
import {
  onGovernorPause,
  parseGovernorKey,
  snapshotGovernors,
  DEFAULT_ACCOUNT_ACTIVE_ENV,
} from '@papercusp/papercusp-shared/agent';
import { readOperatorState, updateOperatorState } from '../operator-state-pg';
import { activeWorkspaceId } from '../workspace-registry';
import { readOpusBudgetPolicy } from '../opus-budget-policy';
import { readScalePolicy } from '../scale-policy';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { BurnVerdict } from '../inference-gateway/burn-governor';
import {
  type AccountEgress,
  type AccountPool,
  type AccountRateState,
  type AccountProvider,
  type ScalePolicy,
  type SpawnSelection,
  AccountPoolError,
  accountBurnVerdict,
  accountFull,
  accountProvider,
  accountsForProvider,
  accountReadingStatus,
  bindAccount,
  clearSoftPin,
  DRAIN_FULL_UTIL,
  decideScaleOut,
  effectiveDrainUtil,
  getAccount,
  isAvailable,
  isClassExhausted,
  isSustainedlyLimited,
  manuallyBoundAccount,
  normalizeAccount,
  recordAccountPenalty,
  selectAccountByHeadroom,
  selectAccountForSpawn,
  setSoftPin,
  softPinnedAccount,
  unbindAccount,
  usageWalledUntil,
} from './account-pool';
import {
  getAccountOverride,
  setAccountOverride,
  applyAccountOverride,
  isOverrideEmpty,
  DEFAULT_ACCOUNT_OVERRIDE,
  type AccountSessionOverride,
} from './account-session-override';
import {
  evaluateOpusBudget,
  type OpusBudgetDecision,
  type WorkCriticality,
} from '../opus-budget-governor';
import { fetchGatewayStatsRaw } from '../inference-gateway/observability';
import type { RawGatewayStats } from '../inference-gateway/gateway-wedge';
import { trackDetached } from '../detached-imports';

// ── P-004: the owner's session-now account override (fail-soft, no-op-when-unset) ──

/**
 * Read the owner's session-now account override (P-004) — FAIL-SOFT: any error returns the
 * empty (no-restriction) override, so the live spawn/deploy selectors can never wedge on a
 * bad read. Workspace-level (D-015): the override lives on a per-workspace pseudo-slug in
 * hive_settings and applies regardless of the spawning harness (no home hive required).
 */
async function readAccountOverride(ws: string | undefined): Promise<AccountSessionOverride> {
  try {
    return await getAccountOverride(ws ?? activeWorkspaceId());
  } catch {
    return DEFAULT_ACCOUNT_OVERRIDE;
  }
}

// ── Persistence (operator-state idiom) ───────────────────────────────────────

export async function loadAccountPool(ws?: string): Promise<AccountPool> {
  const raw = await readOperatorState<AccountPool>('operator_account_pool', ws);
  // Normalize every persisted row on read: a partially-written row (e.g. `rate: {}` from a
  // hand-edited pool) used to read as permanently paused via `undefined <= now` → the codex
  // CLI-bridge account reported available:false while serving fine (WI-3068).
  return { accounts: (raw?.accounts ?? []).map(normalizeAccount) };
}

export async function loadAccountPoolForProvider(provider: AccountProvider, ws?: string): Promise<AccountPool> {
  return { accounts: accountsForProvider(await loadAccountPool(ws), provider) };
}

// ── The DEFAULT account (default-deploy-account-2026-08-08 P-002) ─────────────

/**
 * Set (or, with `null`, clear) the pool account that stands in for this box's own
 * `~/.claude` login. VALIDATED against the live pool — this is the one write that must not
 * be able to name a nonexistent or wrong-provider account, because the resolvers treat the
 * default as the answer when nothing else pinned a choice, and a bad id there degrades
 * silently to the local login (D-003) rather than erroring where the mistake was made.
 *
 * Lives HERE rather than in account-session-override.ts on purpose: validation needs the
 * pool, and account-pool-store already imports the override module — the reverse import
 * would be a cycle.
 *
 * PROVIDER-AGNOSTIC since inference-rename-and-provider-agnostic-default-2026-08-09 P-003
 * [owner 2026-08-09]: a Codex/OpenAI account may be the default too. It was Claude-only
 * before, on the reasoning that the default "substitutes for the Claude local login" and a
 * Codex credential cannot serve an Anthropic-format request. The second half is still true,
 * which is why lifting the rule is safe rather than dangerous: per D-002 the default is a
 * PER-PROVIDER primary, resolved inside each provider's already-filtered candidate list, so
 * a Codex default is simply never found while resolving Claude traffic and falls through to
 * the local login exactly as "no default" would. Nothing has to check the provider here —
 * the filtering downstream is what keeps the two from crossing.
 */
export async function setDefaultAccount(
  id: string | null | undefined,
  ws?: string,
): Promise<AccountSessionOverride> {
  const workspace = ws ?? activeWorkspaceId();
  const wanted = typeof id === 'string' ? id.trim() : '';
  if (!wanted) {
    const cleared = await setAccountOverride(workspace, { defaultAccountId: null });
    publishDefaultAccountEnv(false);
    return cleared;
  }

  const pool = await loadAccountPool(workspace);
  const acct = getAccount(pool, wanted);
  if (!acct) {
    const known = pool.accounts.map((a) => a.id).join(', ') || '(pool is empty)';
    throw new AccountPoolError(`no such account '${wanted}' in the pool. Known accounts: ${known}`);
  }
  const next = await setAccountOverride(workspace, { defaultAccountId: acct.id });
  // CLAUDE-ONLY marker, deliberately narrower than "a default is set" (D-002). The marker's
  // only job is to tell `chooseStatelessTransport` to route the in-process ANTHROPIC-direct
  // family through the gateway instead of ~/.claude. A Codex default says nothing about
  // Anthropic traffic, so setting the marker for one would reroute every judge/summariser off
  // the local login on the strength of an unrelated choice — a silent transport change the
  // owner never asked for. Codex defaults still apply where they mean something: the codex
  // leg of resolveAccountPool.
  publishDefaultAccountEnv(accountProvider(acct) === 'claude');
  return next;
}

/**
 * Publish the "a default account is in force" marker onto THIS process's env, which is what
 * `chooseStatelessTransport` (papercusp-shared) reads to route the in-process anthropic-direct
 * family through the gateway instead of `~/.claude` (P-008 / D-004). Env is the established
 * seam for this — papercusp-shared must not import operator-core.
 */
function publishDefaultAccountEnv(active: boolean): void {
  if (active) process.env[DEFAULT_ACCOUNT_ACTIVE_ENV] = '1';
  else delete process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
}

/**
 * Bring this process's default-account marker in line with the persisted override. Call at host
 * boot, BEFORE relying on in-process routing.
 *
 * The marker is per-PROCESS. `setDefaultAccount` updates the process that handled the write (the
 * operator), so its own in-process calls switch immediately. A SIBLING host (papercup-bg-host)
 * that booted earlier used to keep its stale marker until it next restarted — EI-19944784972017743.
 * That is now closed by REACTION, not by a cadence: `deployment/account-default-marker-rule.ts`
 * re-fires this on every `operator_account_override` change, riding the change stream that table
 * already emits (its `emit_change_notify_trg` → `pg_notify('sync_invalidate')` → the LISTEN every
 * host starts at boot → `bridgeTriggerEvent`). So do NOT add a polling cadence here; the push
 * already exists, and a timer would re-poll PG from every host to rediscover it.
 *
 * The gateway itself was never affected: it re-resolves the pool on its own hot-reload poll, so
 * once a caller chooses the gateway leg the account is always current. This is why the marker is
 * a boolean rather than a cached account id — a stale value can only be wrong about WHICH LEG to
 * take, never about which account, and both legs work.
 *
 * FAIL-SOFT on purpose, unlike readDefaultAccountId's other callers: this is a best-effort
 * refresher, not a routing decision. Leaving the previous marker in place on a transient read
 * error is strictly better than flipping every in-process call to a different transport.
 */
export async function syncDefaultAccountEnv(ws?: string): Promise<boolean | undefined> {
  try {
    const workspace = ws ?? activeWorkspaceId();
    const defaultId = await readDefaultAccountId(workspace);
    // Mirror setDefaultAccount's CLAUDE-ONLY rule (D-002) — the marker means "route in-process
    // Anthropic calls through the gateway", which a Codex default must not turn on. Resolving
    // the provider needs the pool, so a default whose account has since been REMOVED reads as
    // inactive here; that matches the resolvers, which treat a stale default as no default.
    const pool = await loadAccountPool(workspace);
    const acct = defaultId ? getAccount(pool, defaultId) : undefined;
    const active = Boolean(acct && accountProvider(acct) === 'claude');
    publishDefaultAccountEnv(active);
    return active;
  } catch {
    return undefined;
  }
}

/**
 * The default account id, or undefined when the box's own `~/.claude` login is in force.
 *
 * ⚠ Deliberately does NOT swallow a read error, unlike its `readAccountOverride` sibling.
 * That one is fail-soft because losing an allow/exclude list only widens the candidate set —
 * a safe direction. Losing the DEFAULT is not safe in the same way: it silently reroutes
 * every unpinned call to a DIFFERENT credential (the box's local login) while looking
 * perfectly healthy, which is precisely the silent-`local`-fallback fault that
 * `loadPoolOrThrow` in account-resolver was written to eliminate. So "no default is set"
 * (undefined) and "I could not find out" (throw) stay distinguishable, and each caller
 * decides — none of them may treat the second as the first.
 */
export async function readDefaultAccountId(ws?: string): Promise<string | undefined> {
  return (await getAccountOverride(ws ?? activeWorkspaceId())).defaultAccountId;
}

/**
 * Persist a NEWLY-assigned soft cache-affinity pin (account-cache-affinity-auto-pin Phase 1) under an
 * ATOMIC read-modify-write so N bees spawning concurrently for a fresh harness all converge on the SAME
 * account (P-005 concurrency). The write is a CAS-by-reconcile: if a CONCURRENT spawn already soft-pinned
 * this harness to a still-budgeted account, that winning pin stands (we return its id) and we DON'T
 * clobber it; otherwise we set the pin to `accountId`. A manual `boundTo` bind always wins (D-001) — when
 * present we clear any stray soft pin and route to the bind. Fail-soft: a write error returns the
 * originally-selected `accountId` (the spawn still routes; only the persisted affinity is lost).
 */
async function persistSoftPin(
  ws: string | undefined,
  harness: string,
  accountId: string,
  now: number,
): Promise<string> {
  try {
    let winner = accountId;
    await updateAccountPool((p) => {
      // Owner bind wins — never auto-pin over it (D-001). Clear any stale soft pin and defer to the bind.
      const bound = manuallyBoundAccount(p, harness);
      if (bound) {
        winner = bound.id;
        return clearSoftPin(p, harness);
      }
      // A concurrent spawn already pinned this harness to a still-budgeted account → keep that pin (CAS).
      const existing = softPinnedAccount(p, harness);
      if (existing && !accountFull(existing, now)) {
        winner = existing.id;
        return p;
      }
      winner = accountId;
      return setSoftPin(p, accountId, harness);
    }, ws);
    return winner;
  } catch {
    return accountId; // affinity write lost — the spawn still routes to the selected account
  }
}

/**
 * Resolve the pool account a spawning (or in-process) call should egress through (P-004/P-005). Loads
 * the pool (fail-soft → undefined on any IO error), applies the cache-affinity selection, and PERSISTS
 * a fresh soft auto-pin so the harness's consecutive bees co-locate on one credential's prompt cache
 * (account-cache-affinity-auto-pin Phase 1). Returns undefined when there are ≤1 accounts (no routing
 * needed — the gateway's active() account serves) or nothing is available, so the caller sets no header.
 */
export async function selectSpawnAccount(
  ws: string | undefined,
  harness: string | undefined,
  priorAccountId?: string,
  provider: AccountProvider = 'claude',
  /** Injectable RNG for the drain SPREAD (default Math.random). Production spreads concurrent bees
   *  across budgeted accounts; tests pass a fixed rng (e.g. `() => 0` → deterministic best). */
  rng: () => number = Math.random,
): Promise<string | undefined> {
  const pool = await loadAccountPool(ws).catch(() => null);
  if (!pool) return undefined;
  const providerPool = { accounts: accountsForProvider(pool, provider) };
  const now = Date.now();
  // WI-41147: the burn governor is flag-gated (default ON — protective, acts only near
  // exhaustion). Fail-soft to ON: a flag-read error must not change selection semantics.
  const burnGovernor = await getFlag(FLAGS.ACCOUNT_BURN_GOVERNOR, 'system').catch(() => true);
  // P-004: apply the owner's session-now override BEFORE selection (fail-soft, no-op when
  // unset). A `forced` allow-list restricts the candidates; `exclude` skips some. An
  // over-restrictive override (no candidate survives) → undefined = the frame-default
  // credential, exactly as an empty pool behaves today.
  const override = await readAccountOverride(ws);
  if (!isOverrideEmpty(override)) {
    const allowed = applyAccountOverride(
      providerPool.accounts.map((a) => a.id),
      override,
    );
    if (allowed.length === 0) return undefined;
    // A single surviving account IS the pick (forced-to-one, or the sole non-excluded) —
    // pin it (the owner's explicit choice; pause/failover is handled downstream).
    if (allowed.length === 1) return allowed[0];
    const allow = new Set(allowed);
    const sel = selectAccountForSpawn({ accounts: providerPool.accounts.filter((a) => allow.has(a.id)) }, now, {
      harness,
      priorAccountId,
      rng,
      burnGovernor,
    });
    return resolveSelection(ws, sel, now);
  }
  // No override. Legacy Claude behavior: no routing needed for <=1 account because the
  // frame/default credential is that account. Codex is different: without an explicit
  // PAPERCUSP_ACCOUNT_ID the per-session CODEX_HOME uses the launching user's default
  // ChatGPT auth, not the registered gateway account. So a sole available Codex
  // account must still be pinned.
  if (providerPool.accounts.length <= 1) {
    if (provider === 'codex' && providerPool.accounts.length === 1 && isAvailable(providerPool.accounts[0]!, now)) {
      return providerPool.accounts[0]!.id;
    }
    return undefined;
  }
  const sel = selectAccountForSpawn(providerPool, now, { harness, priorAccountId, rng, burnGovernor });
  return resolveSelection(ws, sel, now);
}

/** Apply a `SpawnSelection`: persist a newly-assigned soft pin (atomic CAS) and return the routed id. */
async function resolveSelection(ws: string | undefined, sel: SpawnSelection, now: number): Promise<string | undefined> {
  if (sel.newlyPinned) {
    // Persist the soft cache-affinity pin for FUTURE (sequential) bees of this harness, but route THIS
    // bee to its OWN spread pick (account-spawn-spread fix, 2026-06-23). Returning persistSoftPin's
    // CAS-converge winner forced every concurrent bee of a hive onto ONE account — the thundering herd
    // that RPM-storms it while budgeted peers idle ("accounts have usage but aren't picked"). The stored
    // pin still converges (sequential affinity → warm prefix cache); concurrent bees now diverge across
    // the headroom-weighted spread (selectAccountForSpawn step 4) so the fleet's load actually fans out.
    await persistSoftPin(ws, sel.newlyPinned.harness, sel.newlyPinned.accountId, now);
    return sel.accountId;
  }
  return sel.accountId;
}

/**
 * Account-AWARE replacement for the old account-BLIND "is the opus class paused?" check
 * (account-aware-rate-governor-routing-2026-06-16 Phase 1). The global `<provider>:<modelClass>`
 * governor bucket is account-blind: ONE account's 429 pauses it for the whole fleet even with idle
 * accounts (the owner's "rate-limit-with-headroom = routing bug"). This consults the POOL instead —
 * the class is genuinely paused ONLY when EVERY account is full (paused or at/over its 5h cap). With
 * ≥1 account having headroom this is false, so the caller keeps admitting + routes to the fresh
 * account via `selectSpawnAccount`. Fail-soft: any IO error → false (don't wedge admission on a bad
 * read — the per-account governor still paces each egress). An empty/≤1-account pool → false (the
 * single-credential governor pause governs, today's behavior).
 */
export async function accountRoutingExhausted(ws?: string, now = Date.now()): Promise<boolean> {
  const pool = await loadAccountPool(ws).catch(() => null);
  if (!pool) return false;
  const claudePool = { accounts: accountsForProvider(pool, 'claude') };
  if (claudePool.accounts.length <= 1) return false;
  return isClassExhausted(claudePool, now);
}

/**
 * Evaluate the fleet OPUS-BUDGET decision for a spawn of the given criticality (B-GW-4 —
 * inference-gateway-robustness-audit-2026-06-20 gateway P2). Loads the pool (fail-soft) and runs the
 * pure `evaluateOpusBudget` over the live per-account 5h/7d utilization projection. The caller
 * (operator-spawn) uses `decision.downgrade` to shed a non-critical OPUS escalation to sonnet,
 * pacing fleet opus to stay UNDER the 5h ceiling. Fail-soft: any IO error → an `admit` decision
 * (aggregateUtil null, downgrade false), so a bad pool read can never wedge or mis-route a spawn.
 */
export async function evaluateOpusBudgetForSpawn(
  criticality: WorkCriticality,
  ws?: string,
  now = Date.now(),
): Promise<OpusBudgetDecision> {
  const pool = await loadAccountPool(ws).catch(() => null);
  if (!pool) {
    return { aggregateUtil: null, headroom: null, zone: 'headroom', downgrade: false, pace: false, reason: 'opus budget: pool unreadable — admit (fail-soft)' };
  }
  return evaluateOpusBudget({ pool: { accounts: accountsForProvider(pool, 'claude') }, criticality, now, policy: await readOpusBudgetPolicy() });
}

/**
 * Pick the account an IN-PROCESS anthropic-direct / Queen-brain call should egress through
 * (account-aware-rate-governor-routing Phase 2). The Queen-brain + in-process operator calls used to
 * all egress on the gateway's fixed `active()` account, hammering + 429-ing it → poisoning the global
 * opus bucket → freezing the fleet. Routing them through the SAME per-account pool selector spreads
 * that non-bee load (drain → fresh budget) and keeps a sticky/soft-pinned credential for cache warmth.
 * `key` is a stable logical identity (e.g. `'brain'` or an operator-session id) used as the cache-
 * affinity harness so repeat in-process calls reuse one credential. Returns the account id to stamp on
 * the `x-papercusp-account` header, or undefined (≤1 account / all full) → the gateway's active().
 */
export async function selectInProcessAccount(key: string, ws?: string, priorAccountId?: string): Promise<string | undefined> {
  return selectSpawnAccount(ws, key, priorAccountId);
}

/**
 * Read-modify-write the pool ATOMICALLY — the ONLY sanctioned way to write it.
 *
 * The mutator runs inside a single transaction holding this workspace's row under
 * `SELECT … FOR UPDATE`, so a concurrent writer is serialized behind it and reads the
 * committed result rather than a snapshot taken before it. Keep the mutator PURE and
 * SYNCHRONOUS: it executes while the row lock is held.
 *
 * ⚠ WI-38164 — WHY THIS IS A TRANSACTION NOW, and why the old reasoning was wrong.
 * This used to be a bare `mutator(await loadAccountPool())` followed by a blind
 * whole-document `saveAccountPool()`, justified in a comment as safe because "the pool
 * is a low-churn PROJECTION … so a lost racing penalty write self-heals on the next
 * pause". That is true of the RATE fields and false of everything else in the same
 * document. The row also carries MEMBERSHIP, and a lost membership write does not
 * self-heal — the account is simply gone until a human notices.
 *
 * It bit exactly that way (owner report, 2026-08-12): accounts `ownerhandle2` and `ownerhandle4`
 * were registered from the Deploy Accounts page and vanished twice, hours later, along
 * with `ownerhandle2_codex`. The tell was an account REAPPEARING — `ownerhandle` was dropped from
 * the pool at 18:01 and was back at 18:40 with no registration in between, which no
 * mutator in `account-pool.ts` can do (they are all `accounts.map(...)`, none can add an
 * id that was not in its input). Only a writer flushing a whole document it had read
 * hours earlier can, and that same write is what erased the two new accounts.
 *
 * Callers that need to do IO (allocate an egress IP, redeploy a member) must do it
 * OUTSIDE and pass only the resulting pure mutation in here — never hold a pool object
 * across an await and write it back.
 */
export async function updateAccountPool(
  mutator: (pool: AccountPool) => AccountPool,
  ws?: string,
): Promise<AccountPool> {
  return await updateOperatorState<AccountPool>(
    'operator_account_pool',
    { accounts: [] },
    // Normalize INSIDE the transaction so the mutator sees exactly what
    // `loadAccountPool` would have handed it (WI-3068's partially-written `rate: {}`
    // rows read as permanently paused otherwise).
    (current) => mutator({ accounts: (current?.accounts ?? []).map(normalizeAccount) }),
    ws,
  );
}

// ── P-020: deploy-time account selection ─────────────────────────────────────

export interface DeployAccountDeps {
  loadPool: (ws: string) => Promise<AccountPool>;
  /** WI-38164: a MUTATION, not a whole-document save. The selection above reads the pool,
   *  then does async work (override read, headroom scoring) before it knows what to bind —
   *  writing back the pool it read would discard anything registered in that window. */
  mutatePool: (mutator: (pool: AccountPool) => AccountPool, ws: string) => Promise<AccountPool>;
  now?: () => number;
  log?: (level: LogLevel, msg: string) => void;
}

export function defaultDeployAccountDeps(log?: (level: LogLevel, msg: string) => void): DeployAccountDeps {
  return { log, loadPool: (ws) => loadAccountPool(ws), mutatePool: (m, ws) => updateAccountPool(m, ws) };
}

/**
 * Bind an account to a member's deployment at deploy time (P-020). An explicit
 * `credentialRef` on the deployment wins (the user pinned a credential) and is
 * returned unchanged. Otherwise the most-available account is chosen, stamped onto
 * the deployment (`credentialRef` + `accountId`), and the slug bound in the pool.
 * An empty pool / no available account ⇒ the deployment is returned unchanged (the
 * frame falls back to its env/default credential — today's behavior).
 */
export async function selectAccountForDeploy(
  deployment: DeploymentConfig,
  slug: string,
  ws: string,
  deps: DeployAccountDeps = defaultDeployAccountDeps(),
): Promise<DeploymentConfig> {
  if (deployment.credentialRef) return deployment; // explicit pin wins
  const now = deps.now?.() ?? Date.now();
  const pool = await deps.loadPool(ws);
  const claudePool = { accounts: accountsForProvider(pool, 'claude') };
  // P-004: restrict deploy-time binding to the owner's session-now override (fail-soft,
  // no-op when unset). If the override leaves no candidate, `chosen` is undefined → the
  // deployment is returned unchanged (frame-default credential), exactly as an empty pool.
  const override = await readAccountOverride(ws);
  const candidatePool = isOverrideEmpty(override)
    ? claudePool
    : { accounts: claudePool.accounts.filter((a) => applyAccountOverride([a.id], override).length > 0) };
  const chosen = selectAccountByHeadroom(candidatePool, now, { preferUnbound: true });
  if (!chosen) {
    deps.log?.('info', `[accounts] pool has no available account — '${slug}' deploys on the frame default credential`);
    return deployment;
  }
  // Re-derive the bind from the pool AS IT IS AT WRITE TIME, not from the `pool` snapshot
  // read above — the override read + headroom scoring in between is enough of a window for
  // a concurrent registration to be lost (WI-38164). The CHOICE stays based on the snapshot
  // (it is a heuristic pick, and re-scoring under the row lock would be IO in a transaction);
  // only the mutation is re-applied to current state.
  await deps.mutatePool((p) => bindAccount(unbindAccount(p, slug), chosen.id, slug), ws);
  deps.log?.('info', `[accounts] bound account '${chosen.id}' to '${slug}' by headroom`);
  return { ...deployment, credentialRef: chosen.credentialRef, accountId: chosen.id };
}

// ── P-021: scale-out reaction ────────────────────────────────────────────────

export interface ScaleOutDeps {
  loadPool: (ws: string) => Promise<AccountPool>;
  /** WI-38164: a MUTATION, not a whole-document save. This reaction runs a full
   *  teardown+redeploy per bound member between reading the pool and recording the new
   *  binds — minutes — so writing back the pool it read is the widest lost-update window
   *  in the file. Only the rebinds are re-applied, to current state. */
  mutatePool: (mutator: (pool: AccountPool) => AccountPool, ws: string) => Promise<AccountPool>;
  /** The member's current cloud deployment template (target/region/size) to replicate. */
  memberDeployment: (slug: string, ws: string) => Promise<DeploymentConfig | undefined>;
  /** Provision a fresh frame for `slug` on `deployment` (real = repoint registry + deployHarness). */
  redeploy: (slug: string, ws: string, deployment: DeploymentConfig) => Promise<{ frame: Frame }>;
  now?: () => number;
  log?: (level: LogLevel, msg: string) => void;
}

export interface ScaleOutMember {
  slug: string;
  frame?: Frame;
  error?: string;
}
export type ScaleOutResult =
  | { scaledOut: true; account: string; members: ScaleOutMember[] }
  | { scaledOut: false; reason: 'no-fresh-account' | 'not-sustained' | 'no-bound-members' };

/**
 * The P-021 reaction: when an account is exhausted, provision a fresh Swarm on a
 * fresh account for that account's bound members — instead of only pausing. Each
 * member's existing cloud deployment is replicated with the fresh account's
 * credential; the binding moves from the exhausted account to the fresh one. Pure
 * decision (`decideScaleOut`) + injected IO, so it's fully unit-testable; the real
 * `redeploy` provisions a machine (owner-gated, costs money).
 */
export async function handleAccountExhausted(
  exhaustedId: string,
  ws: string,
  deps: ScaleOutDeps,
  opts: { requireSustained?: boolean; policy?: ScalePolicy } = {},
): Promise<ScaleOutResult> {
  const now = deps.now?.() ?? Date.now();
  const pool = await deps.loadPool(ws);
  const decision = decideScaleOut(pool, exhaustedId, now, { ...opts, policy: opts.policy ?? (await readScalePolicy()) });
  if (!decision.provision) return { scaledOut: false, reason: decision.reason };

  const fresh = decision.account;
  const slugs = getAccount(pool, exhaustedId)?.boundTo ?? [];
  if (slugs.length === 0) return { scaledOut: false, reason: 'no-bound-members' };

  const members: ScaleOutMember[] = [];
  const rebound: string[] = [];
  for (const slug of slugs) {
    const template = await deps.memberDeployment(slug, ws).catch(() => undefined);
    if (!template || template.target === 'local') {
      members.push({ slug, error: 'no cloud deployment template to replicate' });
      continue;
    }
    const deployment: DeploymentConfig = { ...template, credentialRef: fresh.credentialRef, accountId: fresh.id };
    try {
      const { frame } = await deps.redeploy(slug, ws, deployment);
      members.push({ slug, frame });
      rebound.push(slug);
      deps.log?.('info', `[accounts] scaled '${slug}' off '${exhaustedId}' → '${fresh.id}' on frame ${frame.id}`);
    } catch (e) {
      members.push({ slug, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  // Apply the rebinds to the pool AS IT IS NOW. Accumulating them onto the `pool` object
  // read before the redeploy loop and saving that is what discarded every account
  // registered while the loop ran (WI-38164) — and each `redeploy` is a real machine
  // teardown + provision, so "while the loop ran" is minutes, per member.
  if (rebound.length > 0) {
    await deps.mutatePool(
      (p) => rebound.reduce((acc, slug) => bindAccount(unbindAccount(acc, slug), fresh.id, slug), p),
      ws,
    );
  }
  return { scaledOut: true, account: fresh.id, members };
}

export function defaultScaleOutDeps(log?: (level: LogLevel, msg: string) => void): ScaleOutDeps {
  return {
    log,
    loadPool: (ws) => loadAccountPool(ws),
    mutatePool: (m, ws) => updateAccountPool(m, ws),
    async memberDeployment(slug, ws) {
      const { loadHarnessRegistry } = await import('../harness-registry');
      const reg = await loadHarnessRegistry(ws);
      return reg.projects.find((p) => p.slug === slug)?.deployment;
    },
    async redeploy(slug, ws, deployment) {
      const { loadHarnessRegistry, saveHarnessRegistry } = await import('../harness-registry');
      const { deployHarness, teardownHarness, defaultDeployDeps } = await import('./deploy');
      const deployDeps = defaultDeployDeps(log);
      // Scale-out MOVES the member: destroy the exhausted account's frame first
      // (ends its billing; no-op when none). Skipping this would trip the
      // double-deploy guard — and before that guard existed it silently
      // overwrote the handle, orphaning the old frame's billing.
      await teardownHarness(slug, ws, deployDeps);
      const reg = await loadHarnessRegistry(ws);
      const p = reg.projects.find((x) => x.slug === slug);
      if (p) {
        p.deployment = deployment; // repoint at the fresh-account swarm config first
        await saveHarnessRegistry(reg, ws);
      }
      // The fresh deployment already carries credentialRef → selectAccount is a no-op here.
      return deployHarness(slug, ws, deployDeps);
    },
  };
}

// ── P-019/P-021: governor-pause → account bridge ─────────────────────────────

export interface ScaleObserverDeps {
  workspaceId: () => string;
  now: () => number;
  updatePool: (mutator: (pool: AccountPool) => AccountPool, ws: string) => Promise<AccountPool>;
  scaleOut: (accountId: string, ws: string) => Promise<ScaleOutResult>;
  emitExhausted: (accountId: string, pausedUntil: number) => void;
  /** Owner auto-scale-out toggle gate (queen-steering-panel P-006): false ⇒ the
   *  owner has disabled automatic scale-out on the 👑 tab for the home hive, so an
   *  exhausted account is NOT auto-scaled (manual accounts:scale_out still works).
   *  Default reads owner-steering fail-soft → true (enabled). */
  autoScaleOutAllowed: (ws: string) => Promise<boolean>;
  /** Effective scale policy (windowMs / sustainedPenaltyThreshold). Injectable so the
   *  observer test stays HERMETIC: the default reads the live store, which adds a DB
   *  round-trip to the per-pause callback — that latency (not the policy value) is what
   *  broke account-pool-store.test.ts's 5ms-flush observer test. Default = real readScalePolicy. */
  readScalePolicy: () => Promise<ScalePolicy>;
  /** EI-19303809952284205: report the DB outcome of the penalty read-modify-write so a caller (the
   *  inference gateway) can detect that this durable path has gone inert. Scoped DELIBERATELY to the
   *  `updatePool` round-trip and nothing else: the rest of the callback can fail for reasons that are
   *  not DB faults (no fresh account to scale to, owner steering off), and folding those in would
   *  fabricate a database alarm out of normal operation. Default = no-op, so a non-gateway caller of
   *  this observer is unaffected. */
  onDbOutcome: (ok: boolean, err?: unknown) => void;
  log: (level: LogLevel, msg: string) => void;
}

function defaultEmitExhausted(accountId: string, pausedUntil: number): void {
  // Reuse the await-event primitive (the gym's `rate-limit:*` family) so anyone can
  // `events:await { event: 'rate-limit:exhausted:<id>' }`. Lazy + fire-and-forget.
  void trackDetached(import('../events/await/engine'))
    .then(({ emitAwaitedEvent }) =>
      emitAwaitedEvent({
        key: `rate-limit:exhausted:${accountId}`,
        summary: `account '${accountId}' sustainedly rate-limited — scale-out candidate`,
        payload: { accountId, pausedUntil },
        source: 'account-pool',
      }),
    )
    .catch(() => {
      /* visibility only — never break the limiter */
    });
}

let observerUnsub: (() => void) | undefined;

/**
 * Wire the governor's per-account pause signal into the pool (P-019) + the
 * auto-scale-out reaction (P-021). On a pause for an ACCOUNT-keyed bucket
 * (`<provider>:<modelClass>@<id>` — set when a process runs under
 * `PAPERCUSP_ACCOUNT_ID`), record the penalty into the pool projection; when that
 * tips the account into "sustainedly limited", emit `rate-limit:exhausted:<id>`
 * and attempt a scale-out. Global buckets (no accountId) are left to the existing
 * `agent-governor-observer` (coord/toast surfacing). Idempotent; call once at boot.
 */
export function initAccountScaleObserver(deps: Partial<ScaleObserverDeps> = {}): () => void {
  if (observerUnsub) return observerUnsub;
  const workspaceId = deps.workspaceId ?? (() => activeWorkspaceId());
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((lvl, m) => console.warn(`[accounts:${lvl}] ${m}`));
  const onDbOutcome = deps.onDbOutcome ?? (() => {});
  const updatePool = deps.updatePool ?? updateAccountPool;
  const scaleOut = deps.scaleOut ?? ((id, ws) => handleAccountExhausted(id, ws, defaultScaleOutDeps(log)));
  const emitExhausted = deps.emitExhausted ?? defaultEmitExhausted;
  const resolveScalePolicy = deps.readScalePolicy ?? readScalePolicy;
  // Owner auto-scale-out toggle (queen-steering-panel P-006). Fail-soft → enabled.
  const autoScaleOutAllowed =
    deps.autoScaleOutAllowed ??
    (async (ws: string): Promise<boolean> => {
      try {
        const [{ getOwnerSteering, isAutoScaleOutEnabled }, { resolvePotHomeSlug }] = await Promise.all([
          import('../owner-steering'),
          import('../pot/wake'),
        ]);
        const home = resolvePotHomeSlug();
        return home ? isAutoScaleOutEnabled(await getOwnerSteering(ws, home)) : true;
      } catch {
        return true;
      }
    });

  observerUnsub = onGovernorPause((ev) => {
    const { accountId } = parseGovernorKey(ev.key);
    if (!accountId) return; // a global bucket — not an account pause
    // A TRANSPORT pause (egress-proxy circuit) is NOT a budget/rate signal — the account's Anthropic quota
    // is fine; its proxy briefly flapped (the gateway already routes around it). Counting it toward the
    // sustained-penalty threshold falsely marks a healthy account "sustainedly limited / exhausted" and can
    // trigger a PAID scale-out (2026-06-22: ownerhandle at 6% 5h-util paused 6.7h, penaltyCount 32 — overwhelmingly
    // its flaky Rayobyte proxy, not real 429s). Rate-exhaustion is a QUOTA verdict; skip transport entirely.
    if (ev.source === 'transport') return;
    const ws = workspaceId();
    const t = now();
    void (async () => {
      try {
        // EI-19303809952284205: report THIS round-trip's outcome (and only this one) so the gateway
        // can see the durable path go inert. Everything after it can fail for non-DB reasons.
        let pool: AccountPool;
        try {
          pool = await updatePool((p) => recordAccountPenalty(p, accountId, t, { pausedUntil: ev.pausedUntil }), ws);
          onDbOutcome(true);
        } catch (e) {
          onDbOutcome(false, e);
          throw e;
        }
        const acct = getAccount(pool, accountId);
        if (!acct || !isSustainedlyLimited(acct, t, await resolveScalePolicy())) return; // not exhausted (yet) — just pausing
        emitExhausted(accountId, ev.pausedUntil); // observability fires regardless of the toggle
        // Owner auto-scale-out toggle (queen-steering-panel P-006): when disabled, the
        // account is left paused (no auto-deploy); manual accounts:scale_out still works.
        if (!(await autoScaleOutAllowed(ws))) {
          log(
            'info',
            `'${accountId}' sustainedly limited but auto-scale-out is DISABLED by owner steering — not scaling (manual accounts:scale_out still works)`,
          );
          return;
        }
        const r = await scaleOut(accountId, ws);
        if (r.scaledOut) {
          log('info', `auto-scaled '${accountId}' → '${r.account}' (${r.members.length} member(s))`);
        } else {
          log('info', `'${accountId}' sustainedly limited but no scale-out (${r.reason}) — pausing as before`);
        }
      } catch (e) {
        log('warn', `account-scale observer failed for '${accountId}': ${(e as Error).message}`);
      }
    })();
  });
  return observerUnsub;
}

/** Test-only — drop the subscription + reset. */
export function _resetAccountScaleObserver(): void {
  observerUnsub?.();
  observerUnsub = undefined;
}

// ── Status read-model (for accounts:status) ──────────────────────────────────

export interface AccountStatusRow {
  id: string;
  provider: AccountProvider;
  label?: string;
  credentialRef: string;
  boundTo: string[];
  /** Can this account ACTUALLY serve right now — not rate-paused AND not usage-walled
   *  (`!accountFull`). WI-3310: this used to be the pause-only `isAvailable`, which read
   *  `true` on a weekly-usage-exhausted account whose (deliberately bounded) pause had
   *  lapsed — the stall-waker then woke agents onto a wall with "rate limit recovered". */
  available: boolean;
  /** The account is walled by an EXHAUSTED usage window (5h/7d utilization at/over cap) — a
   *  DIFFERENT meter than the bounded rate-limit pause. While true, retrying the account is
   *  futile until the window resets, no matter what `rate.pausedUntil` says. */
  usageWalled: boolean;
  /** When the binding exhausted usage window resets (epoch ms) — set when `usageWalled` and the
   *  provider supplied the window reset; absent otherwise. */
  usageResetAt?: number;
  sustainedlyLimited: boolean;
  /** Whether the live gateway supplied an edge-throttle signal for this row. */
  edgeThrottleKnown: boolean;
  /** A live Cloudflare/per-IP bare-429 cooldown; distinct from quota utilization and rate pause. */
  edgeThrottled: boolean;
  edgeThrottleResetAt?: number;
  edgeThrottleCooledIps: number;
  edgeThrottleBare429Streak: number;
  rate: AccountRateState;
  /** Per-account egress pin (proxy / local source IP), if the account is IP-routed. */
  egress?: AccountEgress;
  /** Per-account egress IP POOL (the rotating list) when the account is multi-IP routed. */
  egressPool?: AccountEgress[];
  /** Live governor buckets keyed to this account (present only if THIS process ran under it). */
  liveBuckets: { key: string; provider: string; modelClass: string; paused: boolean; pausedUntil: number }[];
  /**
   * How stale the `rate.utilization`/`utilization7d` projection this row's `available`/`usageWalled`
   * verdict is based on actually is (EI-18809949582687481 — a caller reading `available:false` had no
   * way to tell "we just measured this" from "we haven't asked in days"):
   *  - `'never-observed'` — no probe or live traffic has EVER reported a usage window for this account;
   *    `available`/`usageWalled` are computed purely from the (possibly ancient) rate-pause fields.
   *  - `'stale'` — the last observation is older than `DRAIN_UTIL_STALE_MS`; the drain selector already
   *    discounts it (see `effectiveDrainUtil`), and a caller deciding fleet capacity should too.
   *  - `'fresh'` — observed within the staleness window.
   */
  readingStatus: 'never-observed' | 'stale' | 'fresh';
  /** Epoch ms since the last observed window (`rate.utilizationAt`), or `undefined` if never observed. */
  readingAgeMs?: number;
  /**
   * Epoch ms of the most recent `accounts:probe-capacity` attempt that came back `no-reading` (the
   * probe request itself failed) and has NOT since been superseded by a real observation. Present ⇒
   * the last thing we tried on this account got no answer — read this row's `available`/`usageWalled`
   * as UNKNOWN, not as a measured verdict, until a fresh probe succeeds.
   */
  lastProbeFailedAt?: number;
  /**
   * WI-41147: the burn-rate governor's verdict for this account — the PROJECTION the bare
   * `available`/`usageWalled` booleans cannot express (they are threshold checks on the current
   * reading; this is the trajectory: burn rate, projected exhaustion, and whether it lands before
   * the window resets). Stale-gated (a stale/never-observed reading yields action 'none' with the
   * gap named) and always carries a `reason` — never a silent throttle.
   */
  burn: BurnVerdict;
}

export interface AccountStatusDeps {
  /** Inject a gateway snapshot for deterministic tests; omitted means best-effort live :8788 read. */
  gatewayStats?: RawGatewayStats | null;
}

export interface LiveEdgeThrottleStatus {
  edgeThrottleKnown: boolean;
  edgeThrottled: boolean;
  edgeThrottleResetAt?: number;
  edgeThrottleCooledIps: number;
  edgeThrottleBare429Streak: number;
}

/** Project the gateway's live edge signal onto one persisted account row. Pure for recurrence tests. */
export function projectLiveEdgeThrottle(
  accountId: string,
  gatewayStats: RawGatewayStats | null,
): LiveEdgeThrottleStatus {
  const signal = gatewayStats?.edgeThrottleByAccount?.[accountId];
  const known = gatewayStats?.edgeThrottleByAccount !== undefined;
  return {
    edgeThrottleKnown: known,
    edgeThrottled: signal?.edgeThrottled === true,
    edgeThrottleResetAt: signal && signal.cooldownUntil && signal.cooldownUntil > 0 ? signal.cooldownUntil : undefined,
    edgeThrottleCooledIps: signal?.cooledIpCount ?? 0,
    edgeThrottleBare429Streak: signal?.bare429Streak ?? 0,
  };
}

/** Assemble the per-account status: the persisted projection + any live local governor buckets. */
export async function accountStatus(ws?: string, now = Date.now(), deps: AccountStatusDeps = {}): Promise<AccountStatusRow[]> {
  const pool = await loadAccountPool(ws);
  const live = snapshotGovernors();
  const scalePolicy = await readScalePolicy();
  const gatewayStats =
    deps.gatewayStats !== undefined ? deps.gatewayStats : await fetchGatewayStatsRaw({ timeoutMs: 500 });
  return pool.accounts.map((a) => {
    const { readingStatus, readingAgeMs } = accountReadingStatus(a, now);
    return {
      id: a.id,
      provider: accountProvider(a),
      label: a.label,
      credentialRef: a.credentialRef,
      boundTo: a.boundTo,
      // WI-3310: `available` = "can actually serve" — pause-clear AND usage headroom. The old
      // pause-only read (`isAvailable`) told every consumer (stall-waker capacityBack, why-chain,
      // Accounts tab, fleet preflights) that a usage-exhausted account had recovered every time
      // its bounded pause lapsed (≤6h), while the weekly window stayed at 100% for days.
      available: !accountFull(a, now),
      usageWalled: effectiveDrainUtil(a, now) >= DRAIN_FULL_UTIL,
      usageResetAt: usageWalledUntil(a, now) || undefined,
      sustainedlyLimited: isSustainedlyLimited(a, now, scalePolicy),
      ...projectLiveEdgeThrottle(a.id, gatewayStats),
      rate: a.rate,
      egress: a.egress,
      egressPool: a.egressPool,
      liveBuckets: live
        .filter((b) => b.accountId === a.id)
        .map((b) => ({
          key: b.key,
          provider: b.provider,
          modelClass: b.modelClass,
          paused: b.state.pausedUntil > now,
          pausedUntil: b.state.pausedUntil,
        })),
      readingStatus,
      readingAgeMs,
      lastProbeFailedAt: a.rate.lastProbeFailedAt,
      burn: accountBurnVerdict(a.rate, now),
    };
  });
}

// ── Per-provider pool verdict (P-002) ────────────────────────────────────────

/**
 * WHAT is binding capacity right now. One vocabulary shared by every capacity surface so a
 * reader never has to translate between them (P-002's per-provider rollup and P-004's canonical
 * `capacity.<provider>.verdict` cell both speak it):
 *  - `usage-wall`             — a MEASURED provider wall: the usage window is exhausted, or the
 *                               provider is 429-ing us into a local pause. Retrying is futile.
 *  - `admission-concurrency`  — the gateway/admission layer is clamping concurrency. The accounts
 *                               themselves can serve; we are limiting ourselves at the door.
 *  - `pacing-policy`          — the burn governor is PACING us off a projection (see
 *                               `BurnDisposition`). Nothing is walled; this is a policy choice.
 *  - `host`                   — the box (CPU/memory/PSI), not the provider.
 *  - `none`                   — nothing is binding, OR the evidence does not support a verdict.
 *                               Never act on missing data: `reason` says which.
 */
export type CapacityBinding = 'usage-wall' | 'admission-concurrency' | 'pacing-policy' | 'host' | 'none';

/**
 * One provider's capacity rollup over its own `accounts:status` rows (P-002).
 *
 * `accounts:status` returns every provider's accounts INTERLEAVED in one list, so a reader
 * diagnosing (say) a codex fleet counts claude's walled rows as evidence about codex and concludes
 * "we are at capacity" when the provider they care about is fine. This rollup is per-provider by
 * construction, so that inference cannot be made.
 *
 * COUNTS OVERLAP — they are tallies, not a partition: a row can be both `walledFresh` and
 * `paused`, and a `paused` row may also be `unknown`. `serviceable` alone is disjoint from
 * `walledFresh`/`paused`/`edgeThrottled` (it requires `available`, which is pause-clear AND
 * headroom-clear, plus a live egress path that is not edge-throttled).
 */
export interface ProviderPoolVerdict {
  provider: AccountProvider;
  /** Accounts registered for this provider. */
  total: number;
  /** Fresh reading, `available`, AND no live edge throttle — can serve right now on a measurement. */
  serviceable: number;
  /** Accounts currently excluded from `serviceable` by a live per-account edge throttle. */
  edgeThrottled?: number;
  /** Fresh reading AND `usageWalled` — a MEASURED exhausted usage window. */
  walledFresh: number;
  /** Inside a local rate-limit pause window right now (a clock fact, known regardless of freshness). */
  paused: number;
  /**
   * Under a burn-governor PACING PROJECTION (`burn.disposition === 'pacing-projection'`). These
   * accounts still SERVE — counted separately precisely so a reader cannot add them to the walls.
   */
  pacing: number;
  /** Reading stale / never observed / last probe got no answer — UNKNOWN, never inferred either way. */
  unknown: number;
  /**
   * True only when EVERY row is measured unable to serve (no serviceable rows AND no unknown
   * rows). A pool of stale readings is never `atCapacity` — it is unmeasured.
   */
  atCapacity: boolean;
  binding: CapacityBinding;
  /** Always populated — the WHY, naming the provider and the counts that produced the verdict. */
  reason: string;
}

/**
 * Roll `accounts:status` rows up per provider. Pure over the rows, so the cell in P-004 and the
 * tool surface derive from ONE implementation and can never disagree.
 */
export function poolVerdictByProvider(rows: readonly AccountStatusRow[], now = Date.now()): ProviderPoolVerdict[] {
  const byProvider = new Map<AccountProvider, AccountStatusRow[]>();
  for (const r of rows) {
    const list = byProvider.get(r.provider);
    if (list) list.push(r);
    else byProvider.set(r.provider, [r]);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, group]) => {
      // A row whose reading is stale, never-observed, or whose last probe got no answer carries
      // no MEASUREMENT — its available/usageWalled are inferences off an old window.
      const measured = (r: AccountStatusRow): boolean =>
        r.readingStatus === 'fresh' && r.lastProbeFailedAt === undefined;
      const total = group.length;
      // `available` only covers the local pause/usage projection. A live edge throttle is a
      // separate egress wall: the pinned launch path can still receive an upstream 429 even
      // when that projection is healthy (EI-22808722843916932).
      const serviceable = group.filter((r) => measured(r) && r.available && !r.edgeThrottled).length;
      const edgeThrottled = group.filter((r) => r.edgeThrottled).length;
      const walledFresh = group.filter((r) => measured(r) && r.usageWalled).length;
      const paused = group.filter((r) => r.rate.pausedUntil > now).length;
      const pacing = group.filter((r) => r.burn.disposition === 'pacing-projection').length;
      const unknown = group.filter((r) => !measured(r)).length;
      const base = { provider, total, serviceable, edgeThrottled, walledFresh, paused, pacing, unknown };

      if (total === 0) {
        return { ...base, atCapacity: false, binding: 'none' as const, reason: `no '${provider}' accounts registered` };
      }
      if (serviceable > 0) {
        return {
          ...base,
          atCapacity: false,
          binding: 'none' as const,
          reason:
            `${serviceable} of ${total} '${provider}' account(s) can serve right now — this provider is NOT at capacity` +
            (edgeThrottled > 0 ? ` (${edgeThrottled} live edge-throttled account(s) excluded)` : '') +
            (pacing > 0
              ? ` (${pacing} under a burn PACING PROJECTION, which does not stop them serving — see burn.disposition)`
              : ''),
        };
      }
      if (unknown === total) {
        return {
          ...base,
          atCapacity: false,
          binding: 'none' as const,
          reason:
            `all ${total} '${provider}' reading(s) are stale or never-observed — capacity here is UNKNOWN, not walled; ` +
            `refresh with accounts:probe-capacity before concluding anything`,
        };
      }
      const binding: CapacityBinding =
        walledFresh > 0 || paused > 0 ? 'usage-wall' : pacing > 0 ? 'pacing-policy' : 'none';
      return {
        ...base,
        // Any unmeasured row could still serve, so a partial answer is never "at capacity".
        atCapacity: unknown === 0,
        binding,
        reason:
          `no '${provider}' account can serve on a fresh reading (${walledFresh} usage-walled, ${paused} rate-paused, ` +
          `${edgeThrottled} edge-throttled of ${total})` +
          (unknown > 0
            ? ` — but ${unknown} reading(s) are stale/never-observed, so this is NOT a measured at-capacity verdict`
            : ' — every reading is fresh, so this provider IS measurably at capacity'),
      };
    });
}
