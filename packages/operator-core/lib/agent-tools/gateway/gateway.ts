/**
 * gateway:* — agent control surface for the running inference gateway (:8788), B-GWCTL
 * (gateway-live-control-and-egress-plan-2026-06-20). Thin HTTP wrappers over the gateway's
 * /admin/config + /admin/reload endpoints (B-HOT-2), so an agent can read the LIVE pool config and
 * apply an accounts:* / egress change to the RUNNING gateway WITHOUT a restart (the hot-config core,
 * B-HOT-1) — instead of the two gateway restarts an account swap used to need.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { setOwnerPin, clearOwnerPin } from '../../deployment/account-owner-pins';
import { trackDetached } from '../../detached-imports';

/** Localhost base of the running gateway. Read PER-CALL (not at module load) so tests can point it at a
 *  mock server via PAPERCUSP_GATEWAY_PORT, and so an env override is honored without a re-import. */
const gwBase = () => `http://127.0.0.1:${Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788}`;
const ok = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...p }) }] });
const fail = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...p }) }] });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const AUTO_ACCOUNT_ROUTE = 'auto';

/**
 * Owner pins are a per-workspace DURABLE WRITE, so both legs below resolve through
 * `resolveConcreteWorkspaceId` — the shared helper that treats the `'*'` superuser
 * READ sentinel as "not concrete" and falls through to the active workspace.
 *
 * These two sites used the `x ?? ctx.workspaceId ?? … ?? activeWorkspaceId()` form that helper's
 * doc-comment names as buggy: a truthy `'*'` wins and the fallback never fires. The admin proxy
 * (`/api/admin/accounts/:verb`) re-dispatches in-process with a synthesized `?superuser=1` ctx and
 * forwards no `workspace`, so `_mcp-handler`'s `workspaceId || '*'` supplied `'*'` and the pin
 * landed under `workspace_id='*'` — a bucket nothing reads, since `adv-roster.ts` reads
 * `getOwnerPinsMap(activeWorkspaceId())`. The ACCT pill therefore reported `ok:true,
 * appliedLive:true` and then kept rendering "no pin", and unpin — scoped to that same empty
 * bucket — could not clear the pins that really existed (EI-20208335287200289; same class as
 * EI-3409 / WI-892).
 */

/**
 * P-003 — the legacy per-provider capacity reads on `/admin/config`, each mapped to WHAT ITS
 * WRITER ACTUALLY MEANS. The gateway's own endpoint already calls these "a legacy per-provider
 * read kept for compatibility" beside the canonical `admissionState`, but it emits them at the
 * SAME level as canonical fields, so a reader scanning the payload cannot tell which is which and
 * reaches for whichever name sounds like capacity. Quarantining them under `legacy:{}` makes the
 * distinction structural instead of a comment in a file the reader never opens.
 *
 * Nothing is dropped — every value is still present, one level down, next to the pointer that
 * says what to read instead.
 */
const LEGACY_CAPACITY_FIELDS: Readonly<Record<string, string>> = {
  admission: "the claude lane's raw admission counters — admissionState.lanes[lane='claude'] carries the same numbers PLUS which term binds them.",
  codexAdmission: "the codex lane's raw admission counters — admissionState.lanes[lane='codex'] carries the same numbers PLUS which term binds them.",
  concurrencyCap: 'the CONFIGURED cap only. Admission is capless by design (an adaptive window with a floor), so this is rarely what binds — admissionState.lanes[].binding says what does.',
  aimd: "the claude AIMD controller's internal state — superseded by admissionState, which dates its snapshot (generation/freshness) so a stale read is legible as stale.",
  codexAimd: "the codex AIMD controller's internal state — superseded by admissionState.",
  clamp: 'the serviceable-account clamp RECOMMENDATION. A recommendation is not a verdict: admissionState.lanes[].binding says whether the clamp is what actually holds the lane back.',
  admissionCeiling:
    'which of applied/aimd-effective/configured-cap/clamp won, in the pre-P-013 shape — admissionState.lanes[].binding is the canonical form of the same answer.',
  codexHealthyAccounts:
    'WRITER MEANING: the number of codex accounts that CAN SERVE RIGHT NOW — pool membership plus auth/credential health. It is NOT quota, headroom, or a capacity budget: an account that is usage-walled but authenticated still counts here, and a 0 means the pool or its credentials are broken, NOT that quota is exhausted. For the quota question read accounts:status → poolVerdict.',
};

/** Top-level `/admin/config` fields that are CANONICAL and stay where they are.
 *  `codexModelRefusals` (WI-10003306) is current routing state — the (account, model) pairs the
 *  gateway is routing around right now — not a pre-admissionState capacity read, so it is canonical. */
export const CANONICAL_CONFIG_FIELDS = [
  'version',
  'accounts',
  'codexAccounts',
  'providers',
  'admissionState',
  'upstreamBase',
  'hotReload',
  'codexModelRefusals',
] as const;

/**
 * Move the legacy per-provider capacity reads out of the top level and under `legacy:{}`, with a
 * pointer to the canonical model. Pure, and exported for the drift test that pins this list
 * against what the gateway endpoint actually emits.
 */
export function quarantineLegacyCapacityFields(body: Record<string, unknown>): Record<string, unknown> {
  const legacy: Record<string, unknown> = {};
  const canonical: Record<string, unknown> = {};
  const meaning: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k in LEGACY_CAPACITY_FIELDS) {
      legacy[k] = v;
      meaning[k] = LEGACY_CAPACITY_FIELDS[k]!;
    } else {
      canonical[k] = v;
    }
  }
  if (Object.keys(legacy).length === 0) return canonical;
  return {
    ...canonical,
    legacy: {
      readInstead: 'admissionState',
      why: 'These are per-provider reads kept for compatibility. They predate the canonical admission model, do not say WHICH term binds a lane, and carry no generation/freshness — so a number taken from here cannot be told apart from a stale one. Read admissionState (and accounts:status → poolVerdict for quota) instead.',
      // Per-field, because the trap is not "these are old" but "this name does not mean what you
      // think": `codexHealthyAccounts` is auth health, never quota.
      meaning,
      ...legacy,
    },
  };
}

export const gatewayStatusTool = defineTool({
  name: 'gateway:status',
  description:
    "WHY ARE MY AGENTS SLOW / QUEUED? — the live inference-gateway ADMISSION state, and the FIRST read when turns are stalling. Admission is CAPLESS: each lane's window is an adaptive target with a floor and NO maximum, so a lane sitting AT its window is working as designed, not capped. THE TELL: queued > 0 while availableStarts > 0 means work is WAITING WHILE SLOTS SIT IDLE — an ADMISSION bug, never a capacity shortage, and no pool headroom will fix it (WI-4541: the fleet ran single-file through ONE slot with 9-10 of 12 idle, for hours, while everyone blamed a 'capacity crunch'). CHECK THIS BEFORE concluding the pool is exhausted.",
  guidance: {
    when: "Agents/turns are SLOW, QUEUED, or stalling — or you are about to conclude 'the pool is capacity-crunched'. Also: confirming what pool + concurrency the running gateway uses, or verifying a hot-reload took effect (version bump).",
    returns:
      "`admissionState` is the CANONICAL model (P-013) — read it first; every other admission field is a legacy per-provider read kept for compatibility. Per lane it carries: the adaptive `desiredWindow`/`effectiveWindow`, `inFlight`, `queued`, `availableStarts`, and `binding` — the ONE term actually holding the lane back (`pause` | `physical-contract` | `effective-window` | null for nothing) together with the exact writer that produced it, so a number you distrust leads straight to its source file. Every measurement is a `value` paired with its `writer` (writer, unit, disposition); `generation` and `freshness` (fresh|aging|stale|unknown) date the snapshot, and `freshness:'unknown'` means a broken/skewed instrument, NOT a healthy zero. `fleet:capacity`, the health panels and the alert feed project from this same snapshot, so if two surfaces ever disagree about a binding writer, that is a bug in the projection, not a real difference. Also returns the pool config version + live account ids (confirming a gateway:reload landed).",
    notWhen: 'Editing the pool itself — accounts:register / accounts:remove (then gateway:reload to apply live). For per-AGENT outcomes (which account did MY session get, did it 429/shed/stall) use gateway:owner_report.',
    chaining:
      "Slowness triage: dev:why (walks every stage incl. admission) → gateway:status (per-tier detail) → gateway:owner_report (per-agent outcomes) → accounts:status / dev:rate_governor_status (only once admission is RULED OUT). Pool edits: accounts:register/remove → gateway:reload → gateway:status.",
    seeAlso: [
      'dev:why (one-call "why is nothing moving" — walks gate → deploy → ADMISSION → pool)',
      'gateway:owner_report (what THIS agent got: 429 / shed / stall / pin-yield, and on which account)',
      'gateway:reload (apply pool changes live)',
      'accounts:register (edit the pool)',
      'accounts:pin (route an agent to a specific account)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  // Keep the declared output aligned with the raw /admin/config projection. The
  // canonical admission values are nested under `admissionState`; `value` and
  // `writer` are properties of those nested measurements, not gateway:status's
  // top-level response.
  //
  // For the same reason `guidance.returns` above describes that nested pair in
  // prose and NOT as a `{value, writer}` clause: guidance-output-schema-live-guard
  // parses the FIRST brace clause in `returns` as this tool's TOP-LEVEL shape, so a
  // nested pseudo-type there reads as a promise of top-level `value`/`writer` and
  // fails the guard. Adding them to the schema below would be the wrong repair —
  // it would advertise a structuredContent shape this handler never emits.
  result: z
    .object({
      ok: z.boolean(),
      version: z.number().optional(),
      accounts: z.array(z.string()).optional(),
      codexAccounts: z.array(z.string()).optional(),
      providers: z.array(z.unknown()).optional(),
      admissionState: z.unknown().optional(),
      upstreamBase: z.string().optional(),
      legacy: z.unknown().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
  async handler() {
    try {
      const r = await fetch(`${gwBase()}/admin/config`, { signal: AbortSignal.timeout(5000) });
      const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      // P-003: the endpoint emits legacy per-provider capacity reads at the same level as the
      // canonical `admissionState`. Quarantine them so the reader cannot mistake one for the
      // other; nothing is dropped. A FAILURE body is left verbatim — never reshape an error.
      return r.ok
        ? ok(quarantineLegacyCapacityFields(b))
        : fail({ error: `gateway /admin/config → ${r.status}`, ...b });
    } catch (e) {
      return fail({ error: `gateway unreachable at ${gwBase()}: ${errMsg(e)}` });
    }
  },
});

export const accountsPinTool = defineTool({
  name: 'accounts:pin',
  description:
    "Route an agent LIVE (no respawn) through the inference gateway — the dynamic account re-pin verb (WI-4402). `agent` = the TARGET agent's owner/spawn id. `account` = a pool account id, or reserved `auto` to suppress the session's launch-time static pin and restore gateway selection/failover. `hard:true` is valid only for a named account and NEVER fails over off it; named pins are soft by default. Effective on the NEXT model call and durable across gateway restarts. Reaches sessions whose launch path forwards `x-papercusp-owner` (fresh and resumed `auto`/pool-account sessions). A `--account=default` session deliberately bypasses the gateway and CANNOT be dynamically re-pinned — respawn it instead. Returns {ok, ownerId, pin}.",
  guidance: {
    when: 'Dynamically routing an agent (yourself or another) to a specific pool account without respawning it.',
    notWhen: 'Steering which account NEW spawns get fleet-wide — that is accounts:set-session-override. Re-pinning a `--account=default` session — not reachable; respawn it instead.',
    chaining: 'gateway:status (pick an account with headroom) → accounts:pin { agent, account } → gateway:owner_report { agent } (confirm it took) → accounts:unpin to revert.',
    seeAlso: [
      'accounts:unpin (revert the pin)',
      'gateway:owner_report (read an agent\'s current routing/pin — the "what is this session pinned to" read)',
      'gateway:status (pick an account with headroom)',
      'accounts:set-session-override (steer NEW spawns fleet-wide instead)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z.string().min(1).describe("target agent's owner/spawn id (pass your own id to pin yourself)"),
    account: z.string().min(1).describe("pool account id, or reserved 'auto' to remove the launch-time pin while staying gateway-routed"),
    hard: z.boolean().optional().describe("true ⇒ never fail over off a named account; incompatible with account:'auto'"),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler({ agent, account, hard, workspace }, ctx) {
    const ws = resolveConcreteWorkspaceId(workspace, ctx?.workspaceId, ctx?.principal?.workspaceId);
    const requestedAccount = account.trim();
    const autoRoute = requestedAccount.toLowerCase() === AUTO_ACCOUNT_ROUTE;
    const routedAccount = autoRoute ? AUTO_ACCOUNT_ROUTE : requestedAccount;
    if (autoRoute && hard) return fail({ error: "hard:true is incompatible with account:'auto'" });
    try {
      const cfg = (await fetch(`${gwBase()}/admin/config`, { signal: AbortSignal.timeout(5000) })
        .then((r) => r.json())
        .catch(() => ({}))) as { accounts?: string[]; codexAccounts?: string[] };
      // The gateway serves separate Claude and Codex pools. Validate a named pin against
      // the union; checking only `accounts` rejects valid Codex owners even though the live
      // gateway advertises them under `codexAccounts` (EI-21719545129987944).
      const configuredAccounts = [
        ...(Array.isArray(cfg.accounts) ? cfg.accounts : []),
        ...(Array.isArray(cfg.codexAccounts) ? cfg.codexAccounts : []),
      ];
      const hasConfiguredPool = Array.isArray(cfg.accounts) || Array.isArray(cfg.codexAccounts);
      if (!autoRoute && hasConfiguredPool && !configuredAccounts.includes(routedAccount)) {
        return fail({ error: `account '${routedAccount}' is not in the gateway pool`, accounts: configuredAccounts });
      }
      // DURABLE write FIRST (the DB store is the source of truth — survives a gateway restart), THEN push to
      // the running gateway for IMMEDIATE effect. If the live push fails, the pin is still durable and loads
      // on the gateway's next poll / restart, so we report success-with-warning rather than failing.
      const pin = await setOwnerPin(ws, agent, { account: routedAccount, hard: !!hard });
      const r = await fetch(`${gwBase()}/admin/owner-pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ownerId: agent, account: routedAccount, hard: !!hard }),
        signal: AbortSignal.timeout(10000),
      }).catch((e) => ({ ok: false, status: 0, _e: errMsg(e) }) as unknown as Response);
      void trackDetached(import('../../sync-sse')).then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {})).catch(() => {});
      return ok({
        ownerId: agent,
        pin,
        appliedLive: r.ok,
        ...(r.ok ? {} : { warn: `pin saved durably but live apply to the gateway failed (it will load on the next poll/restart)` }),
      });
    } catch (e) {
      return fail({ error: `accounts:pin failed: ${errMsg(e)}` });
    }
  },
});

export const accountsUnpinTool = defineTool({
  name: 'accounts:unpin',
  description:
    'Remove a dynamic account pin set by accounts:pin (LIVE). `agent` = the target agent owner/spawn id. The agent reverts to its spawn-time routing (its static x-papercusp-account header, or the pool default). Returns {ok, ownerId, cleared}.',
  guidance: {
    when: 'Reverting an accounts:pin so the agent routes normally again.',
    notWhen: 'It was never dynamically pinned (no-op — cleared:false).',
    chaining: 'accounts:pin … → accounts:unpin { agent }.',
    seeAlso: [
      'accounts:pin (pin an agent to an account)',
      'gateway:status (confirm live routing)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z.string().min(1).describe('target agent owner/spawn id to unpin'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler({ agent, workspace }, ctx) {
    const ws = resolveConcreteWorkspaceId(workspace, ctx?.workspaceId, ctx?.principal?.workspaceId);
    try {
      const cleared = await clearOwnerPin(ws, agent); // durable clear first
      const r = await fetch(`${gwBase()}/admin/owner-pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ownerId: agent, clear: true }),
        signal: AbortSignal.timeout(10000),
      }).catch((e) => ({ ok: false, status: 0, _e: errMsg(e) }) as unknown as Response);
      void trackDetached(import('../../sync-sse')).then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {})).catch(() => {});
      return ok({ ownerId: agent, cleared, appliedLive: r.ok });
    } catch (e) {
      return fail({ error: `accounts:unpin failed: ${errMsg(e)}` });
    }
  },
});

export const gatewayReloadTool = defineTool({
  name: 'gateway:reload',
  description:
    'HOT-RELOAD the inference gateway account pool from the DB source-of-truth NOW (POST :8788/admin/reload) — applies a just-made accounts:register / accounts:remove / egress change to the RUNNING gateway immediately, NO restart (vs waiting for the gateway’s ~60s poll). Returns {ok, changed, version, accounts}; changed:false means the live pool already matched the DB.',
  guidance: {
    when: 'Right after accounts:register / accounts:remove / an egress change, to apply it live without a gateway restart.',
    notWhen: 'You can wait ~60s — the gateway polls + hot-reloads the DB pool on its own.',
    chaining: 'accounts:register → gateway:reload → gateway:status.',
    seeAlso: [
      'gateway:status (confirm the reload took effect)',
      'accounts:register (add an account to the pool)',
      'accounts:remove (remove one)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler() {
    try {
      const r = await fetch(`${gwBase()}/admin/reload`, { method: 'POST', signal: AbortSignal.timeout(10000) });
      const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return r.ok ? ok(b) : fail({ error: `gateway /admin/reload → ${r.status}`, ...b });
    } catch (e) {
      return fail({ error: `gateway unreachable at ${gwBase()}: ${errMsg(e)}` });
    }
  },
});

export const gatewayOwnerReportTool = defineTool({
  name: 'gateway:owner_report',
  description:
    "Per-owner inference-gateway outcome + routing-quality report (GET :8788/admin/owner-report). With `agent` (an owner/spawn id): that agent's ledger {requests, ok, upstream429, upstreamErrors, sheds, stalls, pinYields, lastAccount, lastStatus, recent events} + its last-routed account + live pin + owner-filtered recent routing decisions explaining why each account was picked. Without `agent`: the top ~25 owners ranked by bad outcomes plus the bounded all-owner routing-quality snapshot. `routingQuality` measures true upstream HTTP 429s per logical initial pick, automatic pick-vs-best-available divergence, and explicit/affinity pin-yield frequency; intentional pins are labeled and excluded from automatic-divergence counts. Counters are since the last gateway restart.",
  guidance: {
    when: "An agent reports API errors / slow turns and you need the gateway's view of THAT agent: what it got (429? shed? stall? pin yield?), on which account, when. Also fleet-wide triage (no args) after an error storm. Also: confirming an accounts:pin actually took effect / reading a session's current routing before deciding whether to re-pin it.",
    notWhen: 'Pool-level health — gateway:status (config/AIMD) or the /stats endpoint. Per-account usage — accounts:list.',
    chaining: 'gateway:owner_report { agent } → (if pin yields/429s on a capped pin) accounts:pin to move it, or accounts:list to find headroom.',
    seeAlso: ['gateway:status (live pool + admission)', 'accounts:pin (re-route the agent)', 'accounts:list (account headroom)'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z.string().min(1).optional().describe("The target agent's owner/spawn id (x-papercusp-owner). Omit for the top-erroring-owners overview."),
  }),
  async handler(args, ctx) {
    let owner = args.agent;
    if (owner === 'self') {
      try {
        owner = resolveAgentIdentity(ctx as ResolveIdentityCtx).ownerId;
      } catch {
        // `self` is a caller-relative alias, not a gateway owner id. Do not send the
        // literal through: the gateway would return a valid-looking zero report.
        return fail({
          error: 'unknown_agent',
          message: 'gateway:owner_report agent:"self" requires an attributable caller identity',
        });
      }
    }
    try {
      const q = owner ? `?owner=${encodeURIComponent(owner)}` : '';
      const r = await fetch(`${gwBase()}/admin/owner-report${q}`, { signal: AbortSignal.timeout(5000) });
      const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return r.ok ? ok(b) : fail({ error: `gateway /admin/owner-report → ${r.status}`, ...b });
    } catch (e) {
      return fail({ error: `gateway unreachable at ${gwBase()}: ${errMsg(e)}` });
    }
  },
});

export const gatewayEgressModeTool = defineTool({
  name: 'gateway:egress_mode',
  description:
    "Read or flip the inference gateway's EGRESS MODE live (GET/POST :8788/admin/egress-mode) — gateway-rayobyte-hardening. `proxy:'off'` ⇒ box-ip-only: drop the datacenter (Rayobyte squid) proxy egress and route ALL upstream through the box's own IP — the kill-switch when the proxies are flapping (transport `fetch failed` / stream stalls, NOT 429s). `proxy:'on'` ⇒ restore each account's proxy pool. Omit `proxy` to just read the current mode. LIVE, no restart. NOTE: this flip does NOT survive a gateway restart — the boot default is the PAPERCUSP_GATEWAY_DISABLE_PROXY_EGRESS service env; to make it durable, also set that drop-in. Returns {ok, proxyEgressDisabled, mode}.",
  guidance: {
    when: "Egress proxies are flapping — agents get 'upstream stream stalled (aborted)' / 'paced/paused' on QUIET accounts (transport failures, not usage). Flip proxy:'off' to route direct through the box IP; flip back on once the proxies recover.",
    notWhen: "A real per-account 429/usage cap (util5h≥1.0) — that's account budget, not egress; box-ip-only won't help. Check gateway:owner_report / the [429-shape=…] journal suffix first.",
    chaining: "gateway:owner_report / gateway:status (confirm the failures are transport, not 429) → gateway:egress_mode { proxy:'off' } → (once proxies recover) gateway:egress_mode { proxy:'on' }.",
    seeAlso: ['gateway:owner_report (per-owner outcomes — is it transport or quota?)', 'gateway:status (live pool + AIMD)'],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    proxy: z.enum(['on', 'off']).optional().describe("'off' = box-ip-only (drop proxy egress); 'on' = restore proxy pool; omit to just read the current mode."),
  }),
  async handler(args) {
    try {
      const q = args.proxy ? `?proxy=${args.proxy}` : '';
      const r = await fetch(`${gwBase()}/admin/egress-mode${q}`, { method: args.proxy ? 'POST' : 'GET', signal: AbortSignal.timeout(5000) });
      const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return { data: r.ok ? { ok: true, ...b } : { ok: false, error: `gateway /admin/egress-mode → ${r.status}`, ...b } };
    } catch (e) {
      return { data: { ok: false, error: `gateway unreachable at ${gwBase()}: ${errMsg(e)}` } };
    }
  },
});
