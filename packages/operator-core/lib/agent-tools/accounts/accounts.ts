/**
 * accounts:* — manage the Queen's pool of provider accounts + inspect each account's
 * rate-limit headroom, and manually trigger a scale-out (`cloud-deployment-layer-2026-06-06`
 * Phase 7, P-019/P-020/P-021). Thin MCP surface over `lib/deployment/account-pool*`.
 *
 * A Claude account = one Claude subscription (its own rate limits). Deploy-time selection
 * (deploy:harness / deploy:pot) binds the most-available account per Swarm; sustained
 * limiting on a bound account auto-scales out onto a fresh one. These tools register
 * the pool, read its state, and give the owner a manual scale-out lever.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { mergeIds, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { trackDetached } from '../../detached-imports';
import { accountsForProvider } from '../../deployment/account-pool';
import type { GatewayAccountBilling } from '../../inference-gateway/gateway';

/**
 * WI-10004486 (anthropic-credits-gateway P-009 remainder). A Claude account's LIVE billing state
 * (included | usage-credits | walled | api-credits) and its metered token totals exist only in the
 * gateway process's memory — `GET :8788/stats` → `billing.byAccount[id]` — never in the pool store
 * `accountStatus` reads. So `accounts:status` joins them per claude row, and says so when it can't:
 *   • `'unavailable'`  — the gateway did not answer. UNKNOWN, never "not metered".
 *   • `'not-observed'` — the gateway answered but holds no billing entry for this account (it has not
 *                        served it since the gateway started, or the gateway predates P-009).
 * Codex rows carry no `billing` key: the Anthropic billing model does not apply to them.
 */
export type AccountBillingView = GatewayAccountBilling | 'unavailable' | 'not-observed';

export interface AccountsBillingSummary {
  source: 'gateway:/stats';
  /** false ⇒ every claude row reads `billing:'unavailable'`. */
  reachable: boolean;
  /** false ⇒ the gateway answered without a `billing` block (a pre-P-009 build). */
  supported: boolean;
  /** Pool-wide metered tally (`billing.metered`), when the gateway reported one. */
  metered?: unknown;
}

export function joinGatewayBilling<R extends { id: string; provider?: string }>(
  rows: readonly R[],
  stats: unknown,
): { accounts: Array<R & { billing?: AccountBillingView }>; billing: AccountsBillingSummary } {
  const reachable = stats !== null && typeof stats === 'object';
  const block = reachable ? (stats as { billing?: unknown }).billing : undefined;
  const supported = block !== null && typeof block === 'object';
  const byAccountRaw = supported ? (block as { byAccount?: unknown }).byAccount : undefined;
  const byAccount =
    byAccountRaw !== null && typeof byAccountRaw === 'object'
      ? (byAccountRaw as Record<string, GatewayAccountBilling | undefined>)
      : {};
  const accounts = rows.map((row) => {
    if ((row.provider ?? 'claude') !== 'claude') return { ...row };
    const entry = Object.prototype.hasOwnProperty.call(byAccount, row.id) ? byAccount[row.id] : undefined;
    const view: AccountBillingView = !reachable ? 'unavailable' : (entry ?? 'not-observed');
    return { ...row, billing: view };
  });
  const metered = supported ? (block as { metered?: unknown }).metered : undefined;
  return {
    accounts,
    billing: { source: 'gateway:/stats', reachable, supported, ...(metered !== undefined ? { metered } : {}) },
  };
}

const ok =(payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }) }],
});
const fail = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...payload }) }],
});

const wsArg = z.string().min(1).optional().describe('Workspace id (defaults to the active workspace)');

export default defineTool({
  name: 'accounts:register',
  description:
    "Register (or update) a provider account in the pool. `provider:'claude'` (default) uses a Claude subscription OAuth credential: `token:<path>` (`claude setup-token`) | `file:<path>` / absolute / `~` (`.credentials.json`) — or an Anthropic Console API key that spends API credits: `apikey:env:NAME` | `apikey:file:<path>` | `apikey:credentials` (the key saved with setup:save_key). `provider:'codex'` uses a bearer credential for the Codex/OpenAI-compatible gateway: `token:<path>` or `env:NAME`. Credential refs are references, never the secret. Optional `egress` pins the account to its own outbound IP. Re-registering an existing id updates credentialRef/provider/label/egress, preserving bindings + rate state. Returns {ok, account}.",
  guidance: {
    when: 'Adding a Claude Max subscription the inference gateway can pool (each subscription has its own 5h/7d rolling budget — more accounts = more aggregate budget). Register ≥2 before flipping papercusp-inference-gateway-multi-account.',
    notWhen: 'Setting the operator API key (operator:credentials). A one-off local run (no deploy).',
    chaining: 'accounts:register (×N Max subs) → flip papercusp-inference-gateway-multi-account → cups route by cache-affinity + 5h-budget drain; deploy:pot binds an account per member.',
    seeAlso: [
      'accounts:link-start (register via one-click OAuth instead of a setup-token)',
      'accounts:list (verify the pool after registering)',
      'accounts:status (per-account budget + rate-limit health)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('Stable account id (A-Za-z0-9 . _ - only; becomes part of the rate-bucket key)'),
    provider: z.enum(['claude', 'codex']).optional().describe("Provider for this account. Defaults to 'claude'."),
    credentialRef: z.string().min(1).describe('Credential reference. Claude: token:<path> | file:<path> | absolute/~ .credentials.json | apikey:env:NAME | apikey:file:<path> | apikey:credentials (Console API key). Codex: token:<path> or env:NAME bearer credential.'),
    label: z.string().min(1).optional().describe('Optional human label'),
    egress: z
      .object({
        proxyUrl: z.string().min(1).optional().describe('http(s)/socks proxy URL to route THIS account upstream through (its own IP)'),
        localAddress: z.string().min(1).optional().describe('local source IP to bind this account upstream socket to'),
      })
      .optional()
      .describe('Per-account egress for per-account IP routing (optional; default = shared egress). Owner-provisioned. Superseded by egressPool when set.'),
    meteredPolicy: z
      .enum(['overflow', 'never'])
      .optional()
      .describe(
        'Metered spend policy. overflow (default): an api-key account, or a subscription in usage-credits overage, serves only when no included-allowance account can. never: unselectable while metered.',
      ),
    egressPool: z
      .array(
        z.object({
          proxyUrl: z.string().min(1).optional().describe('http(s) proxy URL for this egress IP'),
          localAddress: z.string().min(1).optional().describe('local source IP to bind for this egress IP'),
        }),
      )
      .optional()
      .describe(
        'Per-account egress IP POOL (gateway-per-account-egress-ip-pool): an ORDERED list of egress IPs the gateway ROTATES this account across, so a per-IP Cloudflare edge throttle (bare-burst 429) takes ONE IP out of rotation instead of pausing the whole account — and a hard pin rides the pool. An empty {} entry = the box-default outbound IP (a valid distinct IP). SUPERSEDES the singular egress. Owner-provisioned.',
      ),
    workspace: wsArg,
  }),
  async handler(args) {
    const { updateAccountPool } = await import('../../deployment/account-pool-store');
    const { registerAccount, getAccount } = await import('../../deployment/account-pool');
    const ws = args.workspace ?? activeWorkspaceId();
    try {
      // Atomic RMW (WI-38164) — a load-then-blind-save here loses any account another
      // writer registered in between, which is exactly how owner-registered accounts
      // silently vanished from the Deploy Accounts page.
      const next = await updateAccountPool(
        (pool) => registerAccount(pool, { id: args.id, provider: args.provider, credentialRef: args.credentialRef, label: args.label, egress: args.egress, egressPool: args.egressPool, meteredPolicy: args.meteredPolicy }, Date.now()),
        ws,
      );
      return ok({ account: getAccount(next, args.id) });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});

export const accountsListTool = defineTool({
  name: 'accounts:list',
  description:
    "List the inference gateway's account pool: each account's id/label/credentialRef, the member harness slugs bound to it, and its rate-limit projection (pausedUntil / penaltyCount). Optionally filter by provider ('claude' or 'codex'). Returns {ok, accounts}.",
  guidance: {
    when: 'Seeing which accounts the gateway can draw from and what each is bound to; pass provider to inspect one provider pool.',
    notWhen: 'Wanting live headroom + sustained-limit flags — accounts:status.',
    seeAlso: [
      'accounts:status (live headroom + sustained-limit flags per account)',
      'accounts:register (add another Max subscription)',
      'accounts:set-session-override (steer or route around one)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    provider: z.enum(['claude', 'codex']).optional().describe("Filter to one provider's accounts."),
    workspace: wsArg,
  }),
  async handler(args) {
    const { loadAccountPool } = await import('../../deployment/account-pool-store');
    const ws = args.workspace ?? activeWorkspaceId();
    const pool = await loadAccountPool(ws);
    const accounts = args.provider ? accountsForProvider(pool, args.provider) : pool.accounts;
    return ok({ accounts });
  },
});

export const accountsRemoveTool = defineTool({
  name: 'accounts:remove',
  description:
    "Remove one OR many Claude accounts from the pool. Pass `id` for one or `ids` for several. Does NOT tear down anything already deployed on them. Returns { ok, results:[{ ok, id, removed }], counts } — correlate each result by its id, not by position.",
  guidance: {
    when: 'Retiring account(s) from the pool (e.g. subscriptions you no longer use). Retiring several at once? Pass them all via `ids`.',
    notWhen: 'Tearing down a deployed frame — deploy:teardown / deploy:teardown_pot.',
    seeAlso: [
      'accounts:set-session-override (temporarily exclude without removing from the pool)',
      'accounts:list (confirm the pool after removal)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('Account id to remove (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('Account ids to remove (1–100)'),
      workspace: wsArg,
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args) {
    const { updateAccountPool } = await import('../../deployment/account-pool-store');
    const { removeAccount, getAccount } = await import('../../deployment/account-pool');
    const ws = args.workspace ?? activeWorkspaceId();
    const ids = mergeIds(args.id, args.ids);
    // Atomic read-modify-write per id, sequentially (runBulk is sequential) so each
    // remove sees the prior write's pool state — and, since WI-38164, so a remove
    // cannot carry a stale snapshot back over a CONCURRENT writer's registration.
    const env = await runBulk(
      ids,
      async (id) => {
        let existed = false;
        await updateAccountPool((pool) => {
          existed = !!getAccount(pool, id);
          return removeAccount(pool, id);
        }, ws);
        return { ok: true as const, id, removed: existed };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});

export const accountsStatusTool = defineTool({
  name: 'accounts:status',
  description:
    "Per-account rate-limit PROJECTION: `available` (⚠ ONLY \"not inside a local pause window right now\" — seconds-scale, NOT a routability or authentication verdict), the sustained-limit flag (the scale-out trigger), the rate projection, and any LIVE local governor buckets. ⚠ `available`/`usageWalled` derive from the last OBSERVED usage window, which can be old — each row also carries `readingStatus` ('never-observed'|'stale'|'fresh'), `readingAgeMs`, and `lastProbeFailedAt` (a recent `accounts:probe-capacity` attempt got NO answer). Treat `readingStatus !== 'fresh'` or a present `lastProbeFailedAt` as UNKNOWN, not measured-unavailable — refresh via `accounts:probe-capacity` before trusting a `false`. NEVER conclude \"the pool is exhausted / a fleet cannot launch\" from this tool. Returns {ok, accounts, poolVerdict}.",
  guidance: {
    when: 'Inspecting one account’s rate-limit penalty/pause projection, or why an account auto-scaled out.',
    notWhen:
      'Deciding whether a FLEET CAN LAUNCH, whether accounts can AUTHENTICATE, or how many members to open — this tool answers NONE of those and reads misleadingly on all three. Ask the gateway instead: fleet:capacity, gateway:status, or the `capacityClamp` fleet:launch-on-plan returns (reachable/healthyAccounts/clamped). Real case (EI-18809949582687481): all 4 accounts read `available:false` with blind probes, while the gateway read reachable:true — 10 members then launched clean. `healthyAccounts` is also NOT a per-member cap.',
    seeAlso: [
      'fleet:capacity (the ROUTABILITY verdict — ask this before a launch, not accounts:status)',
      'accounts:probe-capacity (refresh the projection; `no-reading` ⇒ these flags are stale/blind)',
      'accounts:set-session-override (route the fleet around a limited account)',
      'accounts:reset-rate (clear a stale rate-limit penalty)',
      'accounts:scale_policy (tune when to scale out under sustained limiting)',
    ],
    returns:
      "{ ok, accounts:[...], poolVerdict:[...], billing }. Each claude row's `billing` is the gateway's live billing view (state, meteredNow, metered tokens); 'unavailable' = the gateway did not answer, so UNKNOWN. ⚠ `accounts` INTERLEAVES every provider in one list, so counting walled rows yourself makes a claude wall read as evidence about codex. Read `poolVerdict` instead — one row PER PROVIDER, derived from those same rows: { provider, total, serviceable, walledFresh, paused, pacing, unknown, atCapacity, binding, reason }. `atCapacity` is true ONLY when every row is measured unable to serve (no serviceable AND no unknown rows) — a pool of stale readings is unmeasured, never at capacity. `binding` is the shared capacity vocabulary: usage-wall | admission-concurrency | pacing-policy | host | none. The counts OVERLAP (a row can be both walledFresh and paused); `pacing` counts accounts under a burn PACING PROJECTION, which still SERVE — never add them to the walls. Per row, `burn.disposition` ('measured-wall' | 'pacing-projection' | 'no-verdict') says whether that verdict is a measurement or this system pacing itself; a 'pacing-projection' throttle/shed is NOT a provider wall and must not be remedied by throttling the fleet.",
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ workspace: wsArg }),
  result: z
    .object({
      ok: z.boolean().optional(),
      accounts: z.unknown().optional(),
      poolVerdict: z.unknown().optional(),
      billing: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args) {
    const { accountStatus, poolVerdictByProvider } = await import('../../deployment/account-pool-store');
    const { fetchGatewayStatsRaw } = await import('../../inference-gateway/observability');
    const ws = args.workspace ?? activeWorkspaceId();
    const now = Date.now();
    // WI-10004486: the live billing view is gateway-process memory. accountStatus already reads
    // /stats for edge-throttle state, so fetch ONE snapshot here (same 500ms bound; resolves null —
    // never throws — when :8788 is down) and inject it: one round-trip, and the edge-throttle and
    // billing fields describe the same instant. Unreachable ⇒ `billing:'unavailable'` per row.
    const stats = await fetchGatewayStatsRaw({ timeoutMs: 500 });
    const rows = await accountStatus(ws, now, { gatewayStats: stats });
    const { accounts, billing } = joinGatewayBilling(rows, stats);
    // P-002: the rows are INTERLEAVED across providers, so a reader diagnosing one provider
    // otherwise counts another's walls as evidence about theirs. Roll up per provider, from
    // these same rows, so that inference cannot be made.
    return ok({ accounts, poolVerdict: poolVerdictByProvider(rows, now), billing });
  },
});

export const accountsResetRateTool = defineTool({
  name: 'accounts:reset-rate',
  description:
    "Clear an account's rate-limit penalty state — its pause (pausedUntil), penalty count, and the rolling penalty window — back to fresh (accounts-pool-tab P-004; wraps the recordAccountReset projection reset). The owner's manual override for when an account's PROJECTED pause is stale (e.g. the 5h window actually reset, or a false-exhaustion). Does NOT touch live governor buckets (those self-expire) or the credential. `resetWindows:true` (WI-3553) is the DELIBERATE further override that ALSO zeroes the observed-budget projection (`utilization`/`windowResetAt`/`utilization7d`/`windowResetAt7d`) for when that probe-derived reading itself is wrong or can't be re-probed — default `false` is byte-identical to today (the budget reading survives the reset). Returns {ok, account}.",
  guidance: {
    when: "Clearing a pool account's projected pause/penalty after a confirmed reset — the Accounts tab's per-account Reset button, or unsticking an account the drain selector is avoiding on a stale projection.",
    notWhen:
      'Moving work off an exhausted account NOW — accounts:scale_out. Inspecting state — accounts:status. The observed-budget projection is wrong AND the probe can actually run — prefer accounts:probe-capacity (asks upstream for real evidence) over resetWindows (which only asserts).',
    seeAlso: [
      'accounts:status (see the rate-limit penalty before clearing it)',
      'accounts:scale_out (move work off the account NOW instead)',
      'accounts:probe-capacity (evidence-based utilization refresh — prefer this over resetWindows when the probe can run)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('Account id to reset (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('Account ids to reset (1–100)'),
      resetWindows: z
        .boolean()
        .optional()
        .describe(
          'Also zero the observed-budget projection (utilization/windowResetAt/utilization7d/windowResetAt7d) — the deliberate owner override for when that reading is wrong or the probe cannot run. Default false preserves it (byte-identical to pre-WI-3553 behavior).',
        ),
      workspace: wsArg,
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args) {
    const { loadAccountPool, updateAccountPool } = await import('../../deployment/account-pool-store');
    const { recordAccountReset, getAccount } = await import('../../deployment/account-pool');
    const ws = args.workspace ?? activeWorkspaceId();
    const ids = mergeIds(args.id, args.ids);
    let anyReset = false;
    // Atomic read-modify-write per id, sequentially so each reset sees the prior write
    // (WI-38164: the previous load-then-blind-save could flush a stale whole document).
    const env = await runBulk(
      ids,
      async (id) => {
        if (!getAccount(await loadAccountPool(ws), id)) return { ok: false as const, id, error: 'unknown_account' };
        const next = await updateAccountPool((pool) => recordAccountReset(pool, id, { resetWindows: args.resetWindows }), ws);
        anyReset = true;
        return { ok: true as const, id, account: getAccount(next, id) };
      },
      { keyOf: (id) => ({ id }) },
    );
    // Live UI reflection — the Accounts tab reads accounts.pool. Fire ONCE for the batch.
    if (anyReset) {
      void trackDetached(import('../../sync-sse'))
        .then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {}))
        .catch(() => {});
    }
    // EI-8797 residual: the store reset above is only the PERSISTED half — the live gateway process
    // keeps its own in-memory failover pause, so /stats kept reporting healthyAccounts=0 after a
    // confirmed reset (split-brain; capacity readers then under-count). Poke the live gateway to
    // readmit the reset ids NOW. Best-effort (gateway down / pre-readmit binary ⇒ reachable:false)
    // and REPORTED in the result, so the caller can verify the live pool cleared instead of assuming.
    let gatewayReadmit: { reachable: boolean; readmitted: string[]; healthyAccounts?: number; error?: string } | undefined;
    if (anyReset) {
      const { readmitGatewayAccounts } = await import('../../inference-gateway/observability');
      const okIds = env.results.filter((r) => r.ok).map((r) => r.id);
      gatewayReadmit = await readmitGatewayAccounts(okIds);
    }
    return bulkContent(gatewayReadmit ? { ...env, gatewayReadmit } : env);
  },
});

export const accountsScaleOutTool = defineTool({
  name: 'accounts:scale_out',
  description:
    "Manually scale out off an exhausted account (P-021): provision a FRESH cloud Swarm on the most-available account for the exhausted account's bound members, instead of waiting on the pause. ⚠ Provisions real machines (costs money) — owner-gated. `force` skips the sustained-limit check. Returns {ok, result}.",
  guidance: {
    when: "An account is rate-limited and you want to move its work onto a fresh account NOW (the same action the auto-scale-out takes; this is the manual lever).",
    notWhen: 'Just inspecting state — accounts:status. No fresh account is available (it will report no-fresh-account).',
    seeAlso: [
      'accounts:scale_policy (tune the scale-out threshold instead of provisioning now)',
      'accounts:status (per-account sustained-limit state)',
      'accounts:reset-rate (clear a stale penalty rather than scaling out)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('The exhausted account id to scale out from'),
    force: z.boolean().optional().describe('Skip the sustained-limit check (default false)'),
    workspace: wsArg,
  }),
  async handler(args) {
    const { handleAccountExhausted, defaultScaleOutDeps } = await import('../../deployment/account-pool-store');
    const ws = args.workspace ?? activeWorkspaceId();
    try {
      const result = await handleAccountExhausted(args.id, ws, defaultScaleOutDeps((lvl, m) => console.log(`[${lvl}] ${m}`)), {
        requireSustained: !args.force,
      });
      return ok({ result });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});
