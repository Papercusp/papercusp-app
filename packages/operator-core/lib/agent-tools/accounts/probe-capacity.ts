/**
 * accounts:probe-capacity — ask UPSTREAM what each account's real budget is, and record the truth
 * (plan gateway-clamp-advisory-capacity-probe-2026-07-09, P-001).
 *
 * WHY THIS EXISTS. The account-pool's `utilization7d` projection is written ONLY from the response
 * headers of live traffic routed through that account (inference-gateway/launch.ts). A walled account
 * is routed no traffic, so it never gets a fresh reading, so it stays walled until its PROJECTED reset
 * — days. Nothing else in the tree ever re-asks upstream. `accounts:reset-rate` cannot help: it
 * deliberately PRESERVES the windows. This tool is the missing detector: one minimal request per
 * account recovers the authoritative `anthropic-ratelimit-unified-*` headers (which ride on 200s, not
 * just 429s) and feeds them through the SAME `recordAccountWindow` the live recorder uses.
 *
 * EVIDENCE, NOT ASSERTION (plan D-001). Prefer this over `accounts:reset-rate { resetWindows }`: the
 * probe PROVES a window reset where `resetWindows` merely asserts it. A 429 reply is signal too — it
 * CONFIRMS a real wall (and carries the true reset), in which case forcing an unwall would only make the
 * fleet hammer a capped account into fresh 429s.
 *
 * Out-of-process (plan D-002): talks to upstream directly through each account's own egress + credential,
 * so it works against a gateway that is wedged, walled, or too old to expose the routes you need — no
 * restart required.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { DRAIN_FULL_UTIL, effectiveDrainUtil, type AccountProvider, type ClaudeAccount } from '../../deployment/account-pool';
import { probeCapacityForAccounts, type CapacityProbeResult } from '../../inference-gateway/capacity-probe';
import { trackDetached } from '../../detached-imports';

const wsArg = z.string().min(1).optional().describe('Workspace id (defaults to the active workspace)');

const gwBase = () => `http://127.0.0.1:${Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788}`;
/** Keep best-effort gateway convergence bounded after the upstream probe has finished. */
export const GATEWAY_READMIT_PHASE_TIMEOUT_MS = 5_000;

/**
 * CONVERGE THE SECOND STORE. This tool writes the DB account-pool projection; the running gateway keeps a
 * SEPARATE in-memory `exhaustedUntil` map, and nothing reconciled the two. So a probe could prove upstream
 * that an account serves, write that truth to the projection, and leave the gateway still benching it —
 * with `accounts:probe-capacity` reporting success and `fleet:capacity` reporting `poolExhausted: true` at
 * the same moment, each correct about a different object. Worse, the gateway's stale count feeds the
 * serviceable-admission clamp, so a stale exclusion silently pins fleet-wide admission (measured
 * 2026-08-18: 1 "serviceable" account → live admission 4 while AIMD allowed 24).
 *
 * Readmitting here makes ONE action converge BOTH stores. It is safe: readmit only returns accounts to
 * ROTATION — the governors, the AIMD controller and the freshly-written projection all still apply, so a
 * genuinely walled account is re-excluded by its next real 429 rather than being forced open.
 *
 * Reports what actually happened (never assumed): an unreachable gateway is a WARNING on an otherwise
 * successful probe, because the projection write did land and is the durable half.
 */
async function readmitIntoGateway(accountIds: string[], provider: AccountProvider): Promise<{
  converged: boolean;
  readmitted: string[];
  healthyAccounts: number | null;
  warning?: string;
}> {
  if (accountIds.length === 0) return { converged: false, readmitted: [], healthyAccounts: null };
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      reject(new Error(`gateway readmit phase exceeded ${GATEWAY_READMIT_PHASE_TIMEOUT_MS}ms`));
    }, GATEWAY_READMIT_PHASE_TIMEOUT_MS);
    deadlineTimer.unref?.();
  });

  try {
    // Keep the account selector on every request so a successful probe cannot reopen confirmed-walled
    // accounts (or a different provider's account) by accidentally invoking the endpoint's all-account
    // form. The gateway defaults this endpoint to Claude, so Codex must carry its provider explicitly.
    const providerQuery = provider === 'claude' ? '' : `&provider=${encodeURIComponent(provider)}`;
    const results = await Promise.all(
      accountIds.map(async (accountId) => {
        try {
          const result = await Promise.race([
            (async () => {
              const r = await fetch(`${gwBase()}/admin/readmit?account=${encodeURIComponent(accountId)}${providerQuery}`, {
                method: 'POST',
                signal: controller.signal,
              });
              if (!r.ok) return { accountId, ok: false as const, detail: `HTTP ${r.status}` };
              const b = (await r.json().catch(() => ({}))) as { readmitted?: string[]; healthyAccounts?: number };
              return {
                accountId,
                ok: true as const,
                readmitted: Array.isArray(b.readmitted) ? b.readmitted : [accountId],
                healthyAccounts: typeof b.healthyAccounts === 'number' ? b.healthyAccounts : null,
              };
            })(),
            deadline,
          ]);
          return result;
        } catch (e) {
          return {
            accountId,
            ok: false as const,
            detail: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
    const readmitted = results.flatMap((result) => (result.ok ? result.readmitted : []));
    const healthyAccounts =
      [...results].reverse().find((result) => result.ok && result.healthyAccounts !== null)?.healthyAccounts ?? null;
    const failures = results.filter((result): result is Extract<(typeof results)[number], { ok: false }> => !result.ok);
    if (failures.length === 0) return { converged: true, readmitted, healthyAccounts };

    const details = failures
      .slice(0, 3)
      .map((failure) => `'${failure.accountId}' (${failure.detail})`)
      .join(', ');
    return {
      converged: false,
      readmitted,
      healthyAccounts,
      warning: `projection updated, but the gateway's in-memory exclusions were NOT cleared for ${failures.length}/${accountIds.length} account(s) (${details}${failures.length > 3 ? ', …' : ''}). fleet:capacity may still report these accounts as unusable.`,
    };
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

// { data } shape (definetool-token-optimization P-003): the framework owns wire
// encoding (auto-TOON on the MCP transport, lossless JSON elsewhere) — no hand-rolled
// inline-JSON content array. Payload is identical to the legacy shape.
const ok = (payload: Record<string, unknown>) => ({
  data: { ok: true, ...payload },
});

/** One legible evidence row: what we thought, what upstream says, and the verdict. */
function reportRow(r: CapacityProbeResult) {
  return {
    accountId: r.accountId,
    ok: r.ok,
    status: r.status,
    before: { utilization: r.before.utilization, utilization7d: r.before.utilization7d },
    upstream: {
      utilization: r.windows.utilization,
      utilization7d: r.windows.utilization7d,
      ...(r.windows.bucket ? { bucket: r.windows.bucket } : {}),
    },
    verdict: !r.ok
      ? 'no-reading'
      : r.windows.bucket === 'base_model_inference'
        ? 'reserve-meter reading (Luna bucket) — NOT projected'
        : r.unwalls
          ? 'UNWALLED (stale projection)'
          : 'confirmed',
    ...(r.error ? { error: r.error } : {}),
  };
}

/** Args for {@link runCapacityProbe} — the same shape as the `accounts:probe-capacity` tool's
 *  own zod args, so a caller (the tool handler, or a scheduled system action) picks defaults
 *  identically to a direct MCP invocation. Direct probes are read-only by default; scheduled
 *  repair actions must opt into `apply:true`. */
export interface CapacityProbeArgs {
  id?: string;
  ids?: string[];
  provider?: AccountProvider;
  model?: string;
  walledOnly?: boolean;
  apply?: boolean;
  workspace?: string;
}

/**
 * A successful upstream response can refresh only one premium window. Evaluate serving against the
 * resulting projection, carrying forward any other stored window, so a 5h reset cannot accidentally
 * readmit an account whose weekly premium budget is still full. Use the account-pool's canonical
 * effective-fullness rules so reset expiry and freshness retain the same semantics as routing.
 */
function hasPremiumHeadroom(account: ClaudeAccount, result: CapacityProbeResult, observedAt: number): boolean {
  const windows = result.windows;
  const hasFreshWindow = windows.utilization !== undefined || windows.utilization7d !== undefined;
  const candidate: ClaudeAccount = {
    ...account,
    rate: {
      ...account.rate,
      ...(windows.utilization !== undefined ? { utilization: windows.utilization } : {}),
      ...(windows.windowResetAt !== undefined ? { windowResetAt: windows.windowResetAt } : {}),
      ...(windows.utilization7d !== undefined ? { utilization7d: windows.utilization7d } : {}),
      ...(windows.windowResetAt7d !== undefined ? { windowResetAt7d: windows.windowResetAt7d } : {}),
      ...(hasFreshWindow ? { utilizationAt: observedAt } : {}),
    },
  };
  return effectiveDrainUtil(candidate, observedAt) < DRAIN_FULL_UTIL;
}

/**
 * The core of `accounts:probe-capacity` — extracted (EI-21921833535413808) so a SCHEDULED
 * re-probe (`system:account-capacity-reprobe`) can call the exact same probe→apply→readmit
 * path an on-demand agent invocation does, rather than re-implementing it and risking drift.
 * The tool's `handler` below is now a thin wrapper: `ok(await runCapacityProbe(args))`.
 */
export async function runCapacityProbe(args: CapacityProbeArgs) {
  const { loadAccountPool, updateAccountPool } = await import('../../deployment/account-pool-store');
  const { recordProbeFailure } = await import('../../deployment/account-pool');
  const { recordAccountWindowWithBurnAlert } = await import('../../inference-gateway/burn-alert');
  const ws = args.workspace ?? activeWorkspaceId();
  // A direct probe is an observation, not an implicit repair. The scheduled reprobe action passes
  // apply:true explicitly because it owns the bounded probe → projection → gateway convergence loop.
  const apply = args.apply ?? false;
  const provider: AccountProvider = args.provider ?? 'claude';

  const pool = await loadAccountPool(ws);
  const wanted = new Set([...(args.id ? [args.id] : []), ...(args.ids ?? [])]);
  const providerAccounts = pool.accounts.filter((a) => (a.provider ?? 'claude') === provider);
  const accounts = wanted.size > 0 ? providerAccounts.filter((a) => wanted.has(a.id)) : providerAccounts;

  const results = await probeCapacityForAccounts(accounts, {
    walledOnly: args.walledOnly ?? false,
    fullUtil: DRAIN_FULL_UTIL,
    ...(args.model ? { codexModel: args.model } : {}),
  });

  // Record every USABLE reading — a probe reading is exactly what live traffic would have written, so
  // recording it is never a "force". A failed probe writes nothing (we must not invent a window).
  const applied: string[] = [];
  const burnTransitions: import('../../deployment/account-pool').BurnTransition[] = [];
  const observedAt = Date.now();
  // EI-22103680502746318: a `model:'gpt-reserve'` probe reads the Luna RESERVE meter. The pool
  // projection (`rate.utilization[7d]`) describes the PREMIUM meter — writing 0.04-of-reserve over a
  // 1.00 premium reading un-walled 'ownerhandle5_codex' (2026-09-02 04:32Z + 05:49Z), the gateway readmitted
  // it, live codex traffic burned terminal 429s on it (real caller stalls), the next premium reading
  // re-walled it, and every flip asserted/retracted a fact + broadcast fleet-wide. Report the
  // reading in rows[]; never project it, never unwall on it, never readmit on it.
  const reserveNotProjected = results
    .filter((r) => r.ok && r.windows.bucket === 'base_model_inference')
    .map((r) => r.accountId);
  if (apply) {
    const t = observedAt;
    for (const r of results) {
      if (!r.ok) {
        // The probe itself failed (network/auth/timeout) — no window was observed. Persist that
        // fact so a later accounts:status read can tell "we just asked and got nothing" apart
        // from "no one has asked in days" instead of silently keeping the old, now-unverified
        // projection (EI-18809949582687481).
        await updateAccountPool((p) => recordProbeFailure(p, r.accountId, t), ws);
        continue;
      }
      const w = r.windows;
      if (w.utilization === undefined && w.utilization7d === undefined) continue;
      if (w.bucket === 'base_model_inference') continue; // reserve meter — reported, never projected
      // WI-41147 leg c: the shared write-seam wrapper — records the window AND states any
      // burn-verdict wall the fresh reading implies (fact + severe-event on the transition
      // edge), so a probe that makes a wall VISIBLE is never silent about it.
      const { transition } = await recordAccountWindowWithBurnAlert(
        r.accountId,
        {
          utilization: w.utilization,
          windowResetAt: w.windowResetAt,
          utilization7d: w.utilization7d,
          windowResetAt7d: w.windowResetAt7d,
        },
        t,
        ws,
      );
      if (transition) burnTransitions.push(transition);
      applied.push(r.accountId);
    }
    if (applied.length > 0) {
      void trackDetached(import('../../sync-sse'))
        .then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {}))
        .catch(() => {});
    }
  }

  // Converge the gateway's in-memory exclusions with the projection we just wrote (see
  // readmitIntoGateway). Only accounts that actually PROVED they serve are readmitted — a 429 reply
  // confirms a real wall, and readmitting that account would just send the fleet back to hammer it.
  // A reserve-meter (`gpt-reserve`) 200 proves the LUNA bucket serves — not that the premium meter
  // the failover pool routes by has budget; readmitting on it sends premium traffic into the wall
  // (EI-22103680502746318: the 05:49:49Z readmit → terminal 429s on 'ownerhandle5_codex').
  const selectedAccounts = new Map(accounts.map((account) => [account.id, account]));
  const serving = results
    .filter((r) => {
      const account = selectedAccounts.get(r.accountId);
      return (
        account !== undefined &&
        r.ok &&
        r.status !== 429 &&
        r.windows.bucket !== 'base_model_inference' &&
        hasPremiumHeadroom(account, r, observedAt)
      );
    })
    .map((r) => r.accountId);
  const gateway = apply
    ? await readmitIntoGateway(serving, provider)
    : { converged: false, readmitted: [], healthyAccounts: null as number | null };

  return {
    probed: results.length,
    provider,
    // ⚠ `unwalled` is a DELTA — accounts this call CORRECTED. A healthy account was never walled, so it
    // never appears here, and an empty array means "nothing needed fixing", NOT "nothing works". Judge
    // capacity from `serving` (a STATE array) or from rows[].status, never from this one. A gate phrased
    // over `unwalled` being non-empty is unsatisfiable by construction (EI-20742908053146075).
    unwalled: results.filter((r) => r.unwalls).map((r) => r.accountId),
    /** STATE, not delta: accounts that answered upstream RIGHT NOW without a 429. This is the field to
     *  gate a launch on. */
    serving,
    /** Accounts whose reading came from the Luna RESERVE meter (`model:'gpt-reserve'`): visible in
     *  rows[] but NEVER written to the premium projection, never counted as serving, never readmitted
     *  (EI-22103680502746318). */
    reserveNotProjected,
    confirmedWalled: results.filter((r) => r.ok && !r.unwalls && r.status === 429).map((r) => r.accountId),
    failed: results.filter((r) => !r.ok).map((r) => r.accountId),
    applied,
    /** WI-41147 leg c: burn-verdict transitions this probe's writes surfaced (each was also
     *  stated as a fact + severe-event broadcast — the never-silent wall). */
    burnTransitions,
    dryRun: !apply,
    /** Did this call also converge the gateway's SEPARATE in-memory exclusion set? Reported rather than
     *  assumed — the projection write and the gateway readmit can succeed independently. */
    gatewayConverged: gateway.converged,
    gatewayReadmitted: gateway.readmitted,
    gatewayHealthyAccounts: gateway.healthyAccounts,
    ...(gateway.warning ? { warning: gateway.warning } : {}),
    rows: results.map(reportRow),
  };
}

export type CapacityProbeReport = Awaited<ReturnType<typeof runCapacityProbe>>;

export default defineTool({
  name: 'accounts:probe-capacity',
  description:
    "Probe upstream capacity for the selected account pool (read-only by default). Pass `apply:true` to write the observed projection and converge gateway exclusions. Default Claude; pass `provider:'codex'` for ChatGPT-subscription `codex-cli:<home>` accounts and x-codex headers. Optionally pass `model:'gpt-reserve'` to measure Luna's base-model-inference reserve bucket instead of the default Sol/generic bucket. Sends one minimal request per selected account; a 429 confirms a wall. Returns { ok, provider, probed, serving, rows[] }.",
  guidance: {
    when: "Refresh stale budget readings before `fleet:capacity`; use `provider:'codex'` for Codex, and `model:'gpt-reserve'` when checking Luna reserve capacity.",
    notWhen: 'Clearing local pauses (`accounts:reset-rate`) or gateway exclusions (POST `/admin/readmit`).',
    chaining: "`accounts:probe-capacity { provider:'codex' }` → `fleet:capacity { provider:'codex' }`; leave confirmed walls walled.",
    seeAlso: [
      'accounts:status (the projection this tool corrects)',
      'accounts:reset-rate (clears the PAUSE meter; resetWindows is the manual unwall override)',
      'accounts:test-egress (the network-level probe — exit IP, not budget)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).optional().describe('Probe a single account id.'),
    ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('Probe these account ids.'),
    provider: z
      .enum(['claude', 'codex'])
      .optional()
      .describe("Provider pool to refresh (default 'claude'; codex probes ChatGPT-subscription codex-cli accounts)."),
    model: z
      .string()
      .min(1)
      .optional()
      .describe("Optional Codex upstream model for the capacity reading (for Luna reserve use 'gpt-reserve')."),
    walledOnly: z
      .boolean()
      .optional()
      .describe('Probe only selected-provider accounts whose stored projection reads at/over the full-utilization threshold (default false).'),
    apply: z
      .boolean()
      .optional()
      .describe('Write the upstream reading into the account-pool projection and gateway (default false). true ⇒ apply repair; false ⇒ read-only dry run.'),
    workspace: wsArg,
  }),
  async handler(args) {
    return ok(await runCapacityProbe(args));
  },
});
