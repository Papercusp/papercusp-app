/**
 * The spawn-env patch that points a bee at the pacing gateway (hive-inference-gateway P-012).
 *
 * Pure + flag-evaluated by the caller (the spawn chokepoint), so the hot spawn path stays sync and
 * this stays trivially testable. When the `INFERENCE_GATEWAY` flag is ON, every bee spawn gets
 * `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` + `ANTHROPIC_AUTH_TOKEN=<placeholder>` → the claude
 * CLI treats itself as authenticated (the auth-token env, NOT its local login state, is what makes
 * it send at all) and the localhost gateway paces + strips/reinjects the bound account's real
 * OAuth. Any local credential the spawn inherits is harmlessly ignored. Flipping the flag OFF
 * instantly reverts to direct egress on the local login with no other change.
 */
import { DEFAULT_GATEWAY_PORT } from './launch';
import { ACCOUNT_HEADER, ACCOUNT_PIN_HEADER, OWNER_HEADER, PRIORITY_HEADER } from './gateway';
import { accountFromArgv } from '../agent-config-constants';
import { subscriptionRelayAllowed } from '../anthropic-auth-policy';
import {
  accountProviderForInteractiveBackend,
  interactiveBackendFromSpawnBackend,
  type SpawnBackendLike,
} from '../backend-feature-capabilities';

export const GATEWAY_BASE_URL_ENV = 'ANTHROPIC_BASE_URL';
/** The papercusp-specific override the in-process anthropic-direct SDK transport reads
 *  (chat-stream.ts `anthropicDirectTransport`), distinct from the standard `ANTHROPIC_BASE_URL`
 *  the `claude` CLI honors. */
export const GATEWAY_SDK_URL_ENV = 'PAPERCUSP_ANTHROPIC_URL';
/** Bearer the claude CLI presents to the gateway (`ANTHROPIC_AUTH_TOKEN`). NOT a secret — the
 *  gateway strips + reinjects the routed account's real OAuth on every proxied request. Its job is
 *  client-side: with an auth-token env set, the CLI considers itself authenticated and actually
 *  SENDS, instead of gating on its LOCAL login state. Without it, a gateway-routed session whose
 *  config dir has no live local credential boots "Not logged in · Please run /login" and never
 *  makes a request — the macOS fleet-member failure (a fresh member config dir has no per-dir
 *  Keychain item, inherits only the often-stale base snapshot, fails the local refresh, and logs
 *  itself out; 2026-07-06 owner report #5). Verified live on the Mac VM: fresh config dir +
 *  this env + gateway → real completions. */
export const GATEWAY_CLIENT_AUTH_TOKEN = 'papercusp-gateway';

/** Explicit account-route marker carried by a launch envelope. Keep this name
 * in lockstep with psu-launcher.mjs: unlike the gateway URL, the marker is the
 * selector that tells the child whether an empty gateway env means "direct".
 */
export const ACCOUNT_ROUTING_MODE_ENV = 'PAPERCUSP_ACCOUNT_ROUTING_MODE';

export type AccountRoutingMode = 'default' | 'auto' | 'pin';

/** Claude auth selectors that a `--settings` overlay must clear or restore.
 * This is intentionally the same family enforced by the psu launcher. A wake
 * is a new CLI process, so inherited operator credentials must not outrank the
 * persisted account choice. */
const CLAUDE_ACCOUNT_ROUTE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLAUDE_CODE_API_BASE_URL',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_GATEWAY',
  'PAPERCUSP_ANTHROPIC_URL',
] as const;

/** Environment keys that can carry an inference-gateway route between the
 * operator and a detached wake child. The parent operator itself legitimately
 * has these keys for in-process LLM calls; a resumed session must receive only
 * its persisted route, never that ambient operator route. */
const INHERITED_WAKE_ROUTE_ENV_KEYS = [
  ...CLAUDE_ACCOUNT_ROUTE_ENV_KEYS,
  'PAPERCUSP_ACCOUNT_ID',
  'PAPERCUSP_CODEX_GATEWAY',
  ACCOUNT_ROUTING_MODE_ENV,
] as const;

/** Mirror the launcher's three account-route buckets. */
export function accountRoutingMode(value: unknown): AccountRoutingMode {
  const v = (value == null ? '' : String(value)).trim().toLowerCase();
  if (v === '' || v === 'default' || v === 'none' || v === 'system') return 'default';
  if (v === 'auto' || v === 'gateway') return 'auto';
  return 'pin';
}

export interface WakeAccountRoute {
  mode: AccountRoutingMode;
  /** null for direct/default and unpinned auto routing. */
  accountId: string | null;
  /** Explicit env overlay for the resumed child. */
  env: Record<string, string>;
  /** High-precedence Claude settings args; empty when no persisted route exists. */
  claudeArgs: string[];
}

/** Remove account/gateway state inherited from the operator before applying a
 * wake's explicit route. Non-route environment is preserved byte-for-byte. */
export function sanitizeInheritedWakeEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  for (const key of INHERITED_WAKE_ROUTE_ENV_KEYS) delete out[key];
  return out;
}

/** Build the settings overlay used by the launcher for an explicit Claude
 * account route. `--settings` outranks project/user settings, which is needed
 * because `claude --resume` starts a new CLI process and does not retain the
 * original launch flags. */
function claudeAccountRouteArgs(env: Record<string, string>): string[] {
  const mode = env[ACCOUNT_ROUTING_MODE_ENV] ?? 'default';
  const routedEnv: Record<string, string> = Object.fromEntries(
    CLAUDE_ACCOUNT_ROUTE_ENV_KEYS.map((key) => [key, '']),
  );
  if (mode === 'auto' || mode === 'pin') {
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']) {
      if (env[key]) routedEnv[key] = env[key];
    }
  }
  return ['--settings', JSON.stringify({ apiKeyHelper: '', env: routedEnv })];
}

/** Reconstruct a persisted `--account` choice for a wake resume. A missing
 * launch argv is deliberately `null`: old rows have no trustworthy route and
 * callers must not invent an explicit settings overlay for them. */
export function wakeAccountRouteFromArgv(argv: unknown, ownerId?: string | null): WakeAccountRoute | null {
  if (!Array.isArray(argv)) return null;
  const raw = accountFromArgv(argv);
  if (raw == null) return null;
  return wakeAccountRouteForChoice(raw, ownerId);
}

/**
 * The gateway-failover (`auto`) route for a wake resume. P-013
 * (review-system-rework-reduction-2026-09-23): a dead session whose persisted route
 * points at a WALLED account is re-homed onto this route, so the gateway picks an
 * account with headroom instead of resuming into the known wall.
 */
export function autoWakeAccountRoute(ownerId?: string | null): WakeAccountRoute {
  return wakeAccountRouteForChoice('auto', ownerId);
}

/** One `--account` value → the resumed child's explicit route (shared by the argv
 * reconstruction and the P-013 re-home, so both emit byte-identical overlays). */
function wakeAccountRouteForChoice(raw: string, ownerId?: string | null): WakeAccountRoute {
  const mode = accountRoutingMode(raw);
  const accountId = mode === 'pin' ? raw.trim() : null;
  const env =
    mode === 'default'
      ? { [ACCOUNT_ROUTING_MODE_ENV]: 'default' }
      : {
          ...gatewaySpawnEnv(true, {
            accountId: accountId ?? undefined,
            ownerId: ownerId ?? undefined,
            hardPin: mode === 'pin',
          }),
          [ACCOUNT_ROUTING_MODE_ENV]: mode,
          ...(accountId ? { PAPERCUSP_ACCOUNT_ID: accountId } : {}),
        };
  return { mode, accountId, env, claudeArgs: claudeAccountRouteArgs(env) };
}

/** The localhost gateway port (env override → default 8788). */
export function gatewayPort(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : DEFAULT_GATEWAY_PORT;
}

/**
 * The env patch to merge into a bee spawn's environment. `{}` when the gateway is disabled
 * (unchanged direct egress); `{ ANTHROPIC_BASE_URL }` when enabled. The caller passes the
 * resolved flag value so flag evaluation (PostHog / FLAG_DEFAULTS) stays at the chokepoint.
 */
export function gatewaySpawnEnv(
  enabled: boolean,
  opts: { accountId?: string; ownerId?: string; priority?: string; hardPin?: boolean } = {},
): Record<string, string> {
  // P-019 / D-005: the gateway re-injects the routed account's Claude.ai OAuth upstream, so a
  // public build never routes a claude spawn through it (direct egress on the user's own
  // login or API key instead) unless the user opted in for their own accounts.
  if (!enabled || !subscriptionRelayAllowed('gateway-reinjection')) return {};
  const env: Record<string, string> = {
    [GATEWAY_BASE_URL_ENV]: `http://127.0.0.1:${gatewayPort()}`,
    // Client-side login-gate bypass (see GATEWAY_CLIENT_AUTH_TOKEN): the CLI only sends when it
    // believes it's authenticated. Local credential state is irrelevant upstream (the gateway
    // reinjects the routed account's OAuth), so hand every gateway-routed claude spawn a bearer
    // env — this is what makes a fresh-config-dir member log in with ZERO per-session login on
    // macOS, where there is no symlinkable credentials file to inherit.
    ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
  };
  // Custom request headers the claude CLI forwards on every call — ANTHROPIC_CUSTOM_HEADERS is parsed as
  // newline-separated `Name: Value` pairs (honored by claude-code 2.x):
  //  • the ACCOUNT pin (multi-credential cache-affinity routing P-004): pin this bee to its assigned pool
  //    account. Set only when the caller resolved an account (multi-account flag on + ≥2 accounts);
  //    otherwise the gateway routes the bee to its active() account — today's behavior.
  //  • the OWNER id (== spawnId, gateway-rate-limit-stall-autowake P-001): so the gateway can attribute a
  //    rate-limit shed back to THIS bee, and the stall-waker can wake it once the account recovers.
  //  • the PRIORITY label (gateway-priority-tiers-2026-06-22): the spawn role (queen/scout/su/bee/…) the
  //    gateway maps → an admission TIER. Set only when the caller resolved one (the tier flag is ON);
  //    absent under flag-OFF, so the bee's request stream is byte-identical to today.
  //  • the HARD-PIN marker (account-hard-pin-2026-06-29): only set by the operator/PSU pin path
  //    (resolveAccountPin), NEVER by bee spawns — it tells the gateway to route to `accountId` with NO
  //    failover (the operator explicitly chose this credential). Meaningful only alongside an accountId.
  const customHeaders: string[] = [];
  if (opts.accountId) customHeaders.push(`${ACCOUNT_HEADER}: ${opts.accountId}`);
  if (opts.accountId && opts.hardPin) customHeaders.push(`${ACCOUNT_PIN_HEADER}: hard`);
  if (opts.ownerId) customHeaders.push(`${OWNER_HEADER}: ${opts.ownerId}`);
  if (opts.priority) customHeaders.push(`${PRIORITY_HEADER}: ${opts.priority}`);
  if (customHeaders.length) env.ANTHROPIC_CUSTOM_HEADERS = customHeaders.join('\n');
  return env;
}

/**
 * The env patch for an IN-PROCESS caller that makes anthropic-direct SDK calls (the gym's
 * judge/proposer `llmCall`, FB-16). The spawn chokepoint only patches SPAWNED subprocesses, so an
 * in-process LLM call never receives `gatewaySpawnEnv`. This returns BOTH the standard
 * `ANTHROPIC_BASE_URL` (for any `claude` CLI subprocess the caller in turn spawns) and the
 * papercusp `PAPERCUSP_ANTHROPIC_URL` (read by `anthropicDirectTransport`) so every egress —
 * subprocess or in-process SDK — routes through the localhost pacing gateway. `{}` when disabled.
 */
export function gatewayLlmEnv(enabled: boolean): Record<string, string> {
  if (!enabled) return {};
  const url = `http://127.0.0.1:${gatewayPort()}`;
  return { [GATEWAY_BASE_URL_ENV]: url, [GATEWAY_SDK_URL_ENV]: url };
}

/**
 * Whether an inherited endpoint is the public Anthropic API default rather than
 * an intentional local/custom endpoint. The llm-test CLI runs inside operator
 * processes whose environment can carry the public default from an earlier
 * direct-credential path; leaving that value in place silently bypasses the
 * enabled local gateway. Keep explicit local/custom endpoints intact.
 */
export function isDirectAnthropicApiUrl(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname.toLowerCase() === 'api.anthropic.com'
    );
  } catch {
    return false;
  }
}

/**
 * Apply the in-process gateway patch to an environment. Empty values and the
 * canonical public Anthropic API endpoint are replaceable; an explicit custom
 * endpoint (including a loopback test gateway) is preserved.
 *
 * Returns the keys whose values changed so callers/tests can make the routing
 * decision observable without diffing the whole process environment.
 */
export function applyGatewayLlmEnv(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const patch = gatewayLlmEnv(enabled);
  const changed: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const existing = env[key]?.trim();
    if (!existing || isDirectAnthropicApiUrl(existing)) {
      if (env[key] !== value) changed.push(key);
      env[key] = value;
    }
  }
  return changed;
}

/**
 * Resolve the COMPLETE gateway+account spawn-env for a spawned agent — the ONE routing decision
 * BOTH spawn chokepoints must apply (the bee path `fleet/operator-spawn.ts` AND the `/invoke`
 * route `endpoint-route/routes/harness/spawn.ts`), so a routing change can't be added to one path
 * only. D-011: the `/invoke` path had DRIFTED and never routed Queen/overwatch/blueprint-run agents
 * through the pool → they egressed on the single shared `~/.claude` OAuth credential and 429'd on
 * its WEEKLY cap (silent 0-token wakes, the Queen placing nothing) while the 8-account pool sat idle.
 *
 * Evaluates the gateway flags (INFERENCE_GATEWAY, +_MULTI_ACCOUNT) and, when multi-account is on,
 * selects an AVAILABLE pool account for the resolved backend provider. Claude composes
 * `gatewaySpawnEnv` (ANTHROPIC_BASE_URL + account/owner routing headers) plus
 * `PAPERCUSP_ACCOUNT_ID` (the per-account governor key). Codex emits only `PAPERCUSP_ACCOUNT_ID`;
 * the per-spawn CODEX_HOME writer consumes it to add a model_provider gateway config. Unsupported
 * backends get `{}`. Fail-soft: a selection miss → no pin (the gateway routes
 * Claude to its `active()` account); flag OFF → `{}` (unchanged direct egress).
 * Lazy-imports the flag + account-pool deps so this module stays import-light for the pure helpers
 * above (and so a route module importing it picks up no extra registration side-effects).
 */
export async function resolveSpawnGatewayEnv(opts: {
  workspaceId: string | undefined;
  slug: string | undefined;
  ownerId?: string;
  backend?: SpawnBackendLike;
  /** The spawn ROLE (queen/scout/overwatch/su/bee/worker/…) → mapped to an admission TIER by the gateway
   *  when `GATEWAY_PRIORITY_TIERS` is ON. Omit for an untiered caller. */
  role?: string;
  /** The role's resolved model SPEC (e.g. `claude-bridge/claude-opus-4-8:high`). For an omp spawn,
   *  the exact provider determines whether and how the model can be gateway-routed. */
  model?: string;
  /** Explicit per-spawn account-routing override (account-routing-3-options, 2026-06-30) — the
   *  cup:spawn `account` arg. Mirrors the interactive psu path (resolveAccountPin):
   *   • 'default' | 'none' | 'system' → skip the gateway entirely (direct egress, system credential).
   *   • 'auto' | 'gateway'            → gateway auto-route (active()/drain-select + failover, NO pin).
   *   • '<pool-id>'                   → HARD pin to that account via the gateway (no failover) — trusts
   *                                      the id like the PAPERCUSP_SPAWN_ACCOUNT_PIN env path.
   *  Omitted/'' → today's behavior (env pin → multi-account select → gateway active()). */
  account?: string | null;
}): Promise<Record<string, string>> {
  const acctOverride = (opts.account ?? '').trim();
  const acctMode = acctOverride.toLowerCase();
  const useDefault = acctMode === 'default' || acctMode === 'none' || acctMode === 'system';
  const wantAuto = acctMode === 'auto' || acctMode === 'gateway';
  const explicitPin = acctOverride && !useDefault && !wantAuto ? acctOverride : undefined;
  const explicitGatewayRoute = wantAuto || !!explicitPin;
  const routingWorkspaceId = opts.workspaceId ?? (await import('../workspace-registry')).activeWorkspaceId();
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const gwOn = await getFlag(FLAGS.INFERENCE_GATEWAY, 'system');
  if (!gwOn) {
    if (explicitGatewayRoute) {
      throw new Error(
        `account route '${acctOverride}' requires the inference gateway, but INFERENCE_GATEWAY is off; refusing default-system fallback`,
      );
    }
    return {};
  }
  // account-routing-3-options: an explicit `account` override picks the routing MODE up-front.
  // 'default'/'none'/'system' skips the gateway entirely (the operator's "use the system credential"
  // escape hatch) — return before any pool work.
  if (useDefault) return {};
  const backend = interactiveBackendFromSpawnBackend(opts.backend ?? 'claude');
  let ompModelRoute: import('@papercusp/orchestrator/omp-gateway-config').OmpGatewayModelRoute | null = null;
  if (backend === 'omp' && opts.model?.trim()) {
    const { ompGatewayModelFromSpec } = await import('./omp-models-config');
    ompModelRoute = ompGatewayModelFromSpec(opts.model);
    if (!ompModelRoute) {
      if (explicitGatewayRoute) {
        throw new Error(
          `OMP model '${opts.model}' is not compatible with gateway account routing; refusing model substitution`,
        );
      }
      // No owner-selected gateway route: preserve the selected OMP provider and
      // let it egress directly instead of replacing it with a gateway default.
      return {};
    }
  }
  const provider = ompModelRoute?.accountProvider ?? accountProviderForInteractiveBackend(backend);
  if (!provider) {
    if (explicitGatewayRoute) {
      throw new Error(`account routing is unsupported for backend '${backend}'; refusing default-system fallback`);
    }
    return {};
  }
  let accountId: string | undefined;
  let hardPin = false;
  if (explicitPin) {
    const [{ loadAccountPool }, { accountProvider }] = await Promise.all([
      import('../deployment/account-pool-store'),
      import('../deployment/account-pool'),
    ]);
    const pool = await loadAccountPool(routingWorkspaceId);
    const account = pool.accounts.find((candidate) => candidate.id === explicitPin);
    if (!account) {
      throw new Error(`account '${explicitPin}' is not in the account pool; refusing default-system fallback`);
    }
    const actualProvider = accountProvider(account);
    if (actualProvider !== provider) {
      throw new Error(
        `account '${explicitPin}' is a ${actualProvider} account, but ${backend} requires ${provider}; refusing fallback`,
      );
    }
    const { getAccountOverride } = await import('../deployment/account-session-override');
    const override = await getAccountOverride(routingWorkspaceId);
    if (override.excludeAccounts.includes(explicitPin)) {
      throw new Error(`account '${explicitPin}' is excluded by the session override; refusing fallback`);
    }
    if (override.forcedAccounts.length && !override.forcedAccounts.includes(explicitPin)) {
      throw new Error(`account '${explicitPin}' is outside the session override allow-list; refusing fallback`);
    }
    accountId = explicitPin;
    hardPin = true;
  } else if (wantAuto) {
    // An explicit auto selection is a contract with the credential pool. Verify
    // there is at least one allowed provider account before emitting an unpinned
    // gateway route; an empty pool must not look like a successful system login.
    const [{ loadAccountPool }, { accountProvider }] = await Promise.all([
      import('../deployment/account-pool-store'),
      import('../deployment/account-pool'),
    ]);
    const pool = await loadAccountPool(routingWorkspaceId);
    const { getAccountOverride } = await import('../deployment/account-session-override');
    const override = await getAccountOverride(routingWorkspaceId);
    const candidates = pool.accounts.filter((candidate) => {
      if (accountProvider(candidate) !== provider) return false;
      if (override.excludeAccounts.includes(candidate.id)) return false;
      return !override.forcedAccounts.length || override.forcedAccounts.includes(candidate.id);
    });
    if (!candidates.length) {
      throw new Error(
        `account route 'auto' has no allowed ${provider} account in the pool; refusing default-system fallback`,
      );
    }
    accountId = undefined;
  } else {
    // Owner-directed dedicated-account pin (2026-06-23): when PAPERCUSP_SPAWN_ACCOUNT_PIN names a
    // pool account, force it for the matching hive's spawns — so the queen→bee→scout→overwatch
    // autonomous loop can be verified in a lane isolated from the shared-pool stall storm (the
    // pinned account then carries only that hive's light load, not the whole fleet's). Scope with
    // PAPERCUSP_SPAWN_ACCOUNT_PIN_SLUG (one install slug; pins ALL slugs when unset). This is
    // operational ROUTING config (peer of ANTHROPIC_BASE_URL / PAPERCUSP_GATEWAY_PORT), NOT a
    // feature toggle — reversible by unsetting the env, and a no-op everywhere the env is absent.
    // Tradeoff: a pinned spawn does NOT fail over (it can only use the pinned account), so pin only
    // a LIGHT, isolated workload — never the whole fleet.
    const pinAccount = process.env.PAPERCUSP_SPAWN_ACCOUNT_PIN?.trim();
    const pinSlug = process.env.PAPERCUSP_SPAWN_ACCOUNT_PIN_SLUG?.trim();
    if (pinAccount && (!pinSlug || pinSlug === opts.slug)) {
      accountId = pinAccount;
    } else if (
      // D-005 (open-source-release-2026-09-29): a public build never pools Claude.ai
      // subscriptions on a user's behalf unless that user opts in for their own accounts.
      subscriptionRelayAllowed('account-pool')
      && await getFlag(FLAGS.INFERENCE_GATEWAY_MULTI_ACCOUNT, 'system')
    ) {
      const { selectSpawnAccount } = await import('../deployment/account-pool-store');
      accountId = await selectSpawnAccount(opts.workspaceId, opts.slug, undefined, provider).catch(() => undefined);
    }
  }
  if (backend === 'omp') {
    // OMP routes via a per-session models.yml (P-005 connect / P-006 fleet): the gateway
    // provider override is delivered through the omp child's HOME, NOT via ANTHROPIC_BASE_URL/
    // ANTHROPIC_CUSTOM_HEADERS (claude-CLI-specific) nor a CODEX_HOME. Emit the account-pin
    // signal PLUS the models.yml bytes + the model selector the per-spawn agent-home seeder
    // (connect: profile-writer; fleet: orchestrator invoke.ts) writes into
    // <home>/.omp/agent/models.yml and force-selects via `--model`. A bare PAPERCUSP_ACCOUNT_ID
    // (no models.yml) keeps a pinned-but-unseeded session fail-soft on direct egress.
    // (omp-account-pinning-gateway-2026-06-29 D-001/D-003/D-006/D-008)
    const env: Record<string, string> = {};
    if (accountId) env.PAPERCUSP_ACCOUNT_ID = accountId;
    // Same priority-TIER resolution as the claude path below (role → admission tier, flag-gated).
    const ompPriority =
      opts.role && (await getFlag(FLAGS.GATEWAY_PRIORITY_TIERS, 'system'))
        ? opts.role.trim() || undefined
        : undefined;
    // Lazy import: omp-models-config imports gatewayPort from THIS module, so a top-level import
    // would be a mutual cycle — defer it to the call site (the helpers above stay import-light).
    const { ompGatewayModelsConfig, ompProviderForAccountProvider } = await import('./omp-models-config');
    const cfg = ompGatewayModelsConfig({
      accountId,
      gatewayOn: wantAuto,
      provider: ompModelRoute?.gatewayProvider ?? ompProviderForAccountProvider(provider),
      ownerId: opts.ownerId,
      priority: ompPriority,
      models: ompModelRoute ? [ompModelRoute.modelId] : undefined,
    });
    if (cfg) {
      env.PAPERCUSP_OMP_MODELS_YML = cfg.content;
      env.PAPERCUSP_OMP_MODEL_SELECTOR = cfg.modelSelector;
    }
    return env;
  }
  if (provider === 'codex') {
    // WI-3645: `accountId` is undefined for the EXPLICIT-AUTO case (wantAuto, above) — the owner
    // asked for gateway auto-routing — and also whenever a resolved/validated pin turns out
    // unusable below. Previously either case fell straight to `return {}`, which skips the
    // gateway ENTIRELY: the spawned codex CLI then talks direct-to-ChatGPT on its own local
    // credential, unmetered and invisible to the gateway, even though the owner believed "auto"
    // meant gateway-routed. Mirror the claude branch above instead: ALWAYS route codex through
    // the gateway once it's enabled, with a pin when one validates, and WITHOUT one otherwise —
    // the gateway's own codex handling (gateway.ts `proxyOpenAi`) already falls back correctly
    // to its CLI-account list / pool.active() when no `x-papercusp-account` header is present, so
    // an unpinned request is NOT a broken request, just an auto-routed one.
    if (accountId) {
      try {
        const [{ loadAccountPool }, { credentialRefSupportsOpenAiBearer }] = await Promise.all([
          import('../deployment/account-pool-store'),
          import('./credential-store'),
        ]);
        const { parseCodexCliRef } = await import('./codex-cli-bridge');
        const pool = await loadAccountPool(routingWorkspaceId);
        const acct = pool.accounts.find((a) => a.id === accountId && a.provider === 'codex');
        const usable =
          !!acct && (!!parseCodexCliRef(acct.credentialRef) || (await credentialRefSupportsOpenAiBearer(acct.credentialRef)));
        if (!usable) {
          if (explicitPin) {
            throw new Error(`account '${explicitPin}' has no usable Codex gateway credential; refusing fallback`);
          }
          accountId = undefined;
        }
      } catch {
        if (explicitPin) {
          throw new Error(`account '${explicitPin}' could not be validated for Codex gateway routing; refusing fallback`);
        }
        accountId = undefined;
      }
    }
    // PAPERCUSP_CODEX_GATEWAY signals "route through the gateway" independent of whether a pin
    // resolved — writeSignedSpawnCodexHome (spawn-mcp.ts) reads it to decide whether to emit
    // gateway routing config even with no PAPERCUSP_ACCOUNT_ID.
    const env: Record<string, string> = { PAPERCUSP_CODEX_GATEWAY: '1' };
    if (accountId) env.PAPERCUSP_ACCOUNT_ID = accountId;
    return env;
  }
  // Priority-TIER header (gateway-priority-tiers-2026-06-22): stamp the role only when the tier flag is ON,
  // so flag-OFF emits NO new header (the bee's request stream stays byte-identical to today). The gateway
  // maps role → tier via GATEWAY_PRIORITY_MAP; an unknown role falls back to the default band there.
  const priority = opts.role && (await getFlag(FLAGS.GATEWAY_PRIORITY_TIERS, 'system')) ? opts.role.trim() || undefined : undefined;
  // hardPin only when the operator named a specific account (explicitPin) — a HARD pin tells the
  // gateway to route to it with NO failover; auto/env-pin/multi-account selection stay soft (yield to
  // liveness/load), unchanged from before.
  const env = gatewaySpawnEnv(true, { accountId, ownerId: opts.ownerId, priority, hardPin });
  if (explicitGatewayRoute) env.PAPERCUSP_ACCOUNT_ROUTING_MODE = explicitPin ? 'pin' : 'auto';
  if (accountId) env.PAPERCUSP_ACCOUNT_ID = accountId;
  return env;
}
