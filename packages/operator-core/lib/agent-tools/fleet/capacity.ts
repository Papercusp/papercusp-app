/**
 * fleet:capacity — the Queen's SOURCE-side read of the shared inference-capacity oracle
 * (queen-capacity-aware-dispatch-2026-06-22 P-003, the dispatch counterpart to the gateway's SINK-side
 * priority tiers). It projects the live gateway `/stats` (the SHARED capacity oracle, D-007) into a
 * placement-decision read-model: the bee-tier `dispatchBudget` (spare slots = cap − inFlight − queued),
 * the per-tier caps, pool saturation (utilization / paused / queue), `healthyAccounts`, and a clamped
 * `recommendedHeadroom` for a proposed fresh-spawn count.
 *
 * It does NOT fork any logic: the read-model (`buildCapacityReport`) + the saturation curve live in the
 * `fleet/capacity-dispatch` domain module that `place_batch` already enforces automatically (so what the
 * Queen READS here matches what the placement path DOES), and the signal is the same `fetchGatewayHeadroom`
 * projection the `/admin` surface renders. Read-only; gateway-unreachable ⇒ a fail-safe "no clamp" report.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { parsePriorityTierMap } from '@papercusp/papercusp-shared/agent';
import { COORD_ROLES } from '../coordination/roles';
import { fetchGatewayHeadroom } from '../../inference-gateway/observability';
import {
  buildCapacityReport,
  deriveEdgeThrottleEvidence,
  egressIdentityOf,
  type AccountPoolAvailability,
  type AccountBindingTerms,
  type EdgeThrottleSnapshotEntry,
} from '../../fleet/capacity-dispatch';
import { activeWorkspaceId } from '../../workspace-registry';
import type { AccountProvider } from '../../deployment/account-pool';
import type { AccountStatusRow, ProviderPoolVerdict } from '../../deployment/account-pool-store';
import { deriveCapacityVerdict } from '../../fleet/capacity-verdict';
import { advSessionsByCoordOwner } from '../../adv-sessions';
import { listFleetRosterDiagnosed } from '../../fleet/fleet-roster';
import { resolveAgentIdentity, deriveFleetMembership, type AgentIdentity } from '../coordination/identity';
import { resolvePresenceFleet } from '../coordination/presence-fleet';

// Re-exported so existing importers (tests, the queen-brief gather) can reach the read-model via either path.
export { buildCapacityReport, type CapacityReport } from '../../fleet/capacity-dispatch';

/** The legacy/default provider for bee/cup placement (EI-12282). */
const BEE_PROVIDER: AccountProvider = 'claude';

/** Infer a provider only from model families with an unambiguous wire backend. */
export function providerForModel(model: string | undefined): AccountProvider | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/^(?:gpt(?:-|$)|o\d|codex(?:-|$)|openai(?:-|$))/.test(normalized)) return 'codex';
  return 'claude';
}

/**
 * Resolve the inference backends represented by a fleet's CURRENT members.
 *
 * This is intentionally the same member-scoping rule used by fleet:leader-brief:
 * dead historical rows and the observing leader do not describe the pool the
 * workers pull from; visible sessions with no model tier use their authoritative
 * adv-session backend. Unknown/OMP-only rows are ignored, but a fleet with no
 * measured backend is never guessed as Claude.
 */
export function fleetCapacityProvidersForMembers(
  members: ReadonlyArray<{
    agentId?: string;
    model?: string | null;
    alive?: boolean;
    sessionState?: string | null;
    fleetRole?: string | null;
  }>,
  agentByOwner: ReadonlyMap<string, 'claude' | 'omp' | 'codex' | null | undefined> = new Map(),
): AccountProvider[] {
  const providers = new Set<AccountProvider>();
  for (const member of members) {
    if (member.alive === false || member.sessionState === 'ended' || member.sessionState === 'suspect') continue;
    if (member.fleetRole === 'leader') continue;

    const modelProvider = providerForModel(member.model ?? undefined);
    if (modelProvider) {
      providers.add(modelProvider);
      continue;
    }

    const agent = member.agentId ? agentByOwner.get(member.agentId) : undefined;
    if (agent === 'claude' || agent === 'codex') providers.add(agent);
  }
  return [...providers].sort();
}

interface CapacityScopeArgs {
  provider?: AccountProvider;
  model?: string;
  account?: string;
  fleet?: string;
  headroom?: number;
}

interface ResolvedCapacityScope {
  provider: AccountProvider;
  modelProvider?: AccountProvider;
  accountProvider?: AccountProvider;
  accountRows?: AccountStatusRow[];
  accountFound?: boolean;
}

type ProviderSource = 'explicit' | 'fleet' | 'legacy-default';

interface FleetScopeContext {
  fleetSlug: string | null;
  ownerId?: string;
  workspaceId: string | null;
}

interface FleetProviderResolution {
  providers: AccountProvider[];
  reason?: string;
}

function resolveWorkspaceId(identity?: AgentIdentity): string | null {
  if (identity?.workspaceId) return identity.workspaceId;
  try {
    return activeWorkspaceId();
  } catch {
    return null;
  }
}

/** Resolve explicit fleet scope or the caller's authoritative current membership. */
async function resolveFleetScope(
  args: CapacityScopeArgs,
  ctx: unknown,
  inferMembership: boolean,
): Promise<FleetScopeContext> {
  let identity: AgentIdentity | undefined;
  try {
    identity = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]);
  } catch {
    // Handler unit tests and non-coordination callers may not carry an identity.
    // They can still use an explicit fleet, while an implicit fleet falls back to
    // the launch label only when that label is available.
  }

  const launchMembership = deriveFleetMembership();
  const explicitFleet = args.fleet?.trim() || null;
  if (explicitFleet) {
    return {
      fleetSlug: explicitFleet,
      ...(identity?.ownerId ? { ownerId: identity.ownerId } : {}),
      workspaceId: resolveWorkspaceId(identity),
    };
  }
  if (!inferMembership) {
    return { fleetSlug: null, workspaceId: resolveWorkspaceId(identity) };
  }

  const membership = identity
    ? await resolvePresenceFleet(identity.ownerId, launchMembership)
    : launchMembership;
  return {
    fleetSlug: membership.fleetSlug,
    ...(identity?.ownerId ? { ownerId: identity.ownerId } : {}),
    workspaceId: resolveWorkspaceId(identity),
  };
}

/** Read the fleet's provider set; every failure is UNKNOWN rather than legacy Claude. */
async function resolveFleetProviders(
  fleetSlug: string,
  workspaceId: string | null,
  ownerId?: string,
): Promise<FleetProviderResolution> {
  try {
    const [roster, sessions] = await Promise.all([
      listFleetRosterDiagnosed({ fleetSlug, workspaceId, leaderOwnerId: ownerId }),
      advSessionsByCoordOwner(),
    ]);
    const agentByOwner = new Map(
      [...sessions].map(([id, session]) => [id, session.agent] as const),
    );
    const providers = fleetCapacityProvidersForMembers(roster.entries, agentByOwner);
    if (providers.length > 0) return { providers };
    return {
      providers,
      reason: roster.degradedLegs.length > 0
        ? `fleet '${fleetSlug}' roster was incomplete (${roster.degradedLegs.join(', ')}); no member backend was measured`
        : `fleet '${fleetSlug}' has no live member backend with a measured provider`,
    };
  } catch {
    return {
      providers: [],
      reason: `fleet '${fleetSlug}' provider scope could not be measured`,
    };
  }
}

/** Resolve the requested backend before reading either gateway or account-pool capacity. */
async function resolveCapacityScope(args: CapacityScopeArgs): Promise<ResolvedCapacityScope> {
  const modelProvider = providerForModel(args.model);
  const accountId = accountPin(args.account);
  let accountRows: AccountStatusRow[] | undefined;
  let accountProvider: AccountProvider | undefined;

  // Validate real pins even when a model/provider is supplied. Auto selects the
  // routable pool; it cannot select a backend or narrow the pool to an account id.
  if (accountId) {
    try {
      const { accountStatus } = await import('../../deployment/account-pool-store');
      accountRows = await accountStatus(activeWorkspaceId());
      accountProvider = accountRows.find((row) => row.id === accountId)?.provider;
    } catch {
      // Keep the scope explicit but unknown; the later availability read remains fail-safe.
    }
  }

  return {
    provider: args.provider ?? modelProvider ?? accountProvider ?? BEE_PROVIDER,
    modelProvider,
    accountProvider,
    accountRows,
    accountFound: accountId ? accountRows?.some((row) => row.id === accountId) : undefined,
  };
}

function accountPin(account?: string): string | undefined {
  return account === 'auto' ? undefined : account;
}

/**
 * EI-18683773458136367: process-local memory of the LAST read's per-account edge-throttle state, so
 * `deriveEdgeThrottleEvidence` can tell a re-arming cooldown (deadline advancing, penalty climbing —
 * a backoff-loop bug) from one genuinely counting down. Deliberately ephemeral (in-memory, not
 * persisted) — this is a live diagnostic heuristic over consecutive `fleet:capacity` reads within one
 * process's lifetime, not a durable record; a restart just means the first post-restart read has no
 * prior snapshot to compare against (rearming reports `undefined` until a second read lands).
 */
const lastEdgeThrottleSnapshot = new Map<string, EdgeThrottleSnapshotEntry>();

/**
 * Best-effort snapshot of REAL account-pool availability for one provider (accounts:status), used to
 * cross-check the gateway's queue-slot dispatchBudget. Returns undefined on any read failure (fail-safe —
 * a missing cross-check leaves the report byte-identical to before this fix).
 *
 * Exported (WI-37161) so `fleet:leader-brief` can build the SAME `CapacityReport` this tool reports —
 * reuse-first: the alternative was leader-brief forking its own account-pool-availability read.
 */
export async function readProviderAvailability(
  provider: AccountProvider,
  accountId?: string,
  preloadedRows?: AccountStatusRow[],
): Promise<AccountPoolAvailability | undefined> {
  try {
    const pinnedId = accountPin(accountId);
    const ws = activeWorkspaceId();
    const { accountStatus } = await import('../../deployment/account-pool-store');
    const rows = (preloadedRows ?? (await accountStatus(ws))).filter(
      (r) => r.provider === provider && (!pinnedId || r.id === pinnedId),
    );
    if (rows.length === 0) return undefined;

    // EI-19932168784507536: raw pool-health (accountStatus above) is blind to the owner's
    // session-account-override (allow-list/exclude-list) — the SAME override spawn admission
    // (spawn-env.ts resolveSpawnGatewayEnv) actually enforces and refuses a route for. Without
    // this, an account pool-health calls healthy/usable was counted here even though every real
    // spawn into it would be rejected outright, so this cross-check reported an abundant pool
    // while admission refused every route into the excluded slice.
    const { getAccountOverride, applyAccountOverride } = await import('../../deployment/account-session-override');
    const override = await getAccountOverride(ws);
    const allowedIds = new Set(applyAccountOverride(rows.map((r) => r.id), override));
    const overrideExcludedCount = rows.length - allowedIds.size;
    const now = Date.now();
    const futureTerm = (value: number | undefined): number | undefined =>
      value != null && Number.isFinite(value) && value > now ? value : undefined;

    // EI-18683773458136367: derive the shared-egress / re-arm evidence that gates whether the
    // "down egress proxy, escalate to the owner" claim is actually supportable (see capacity-dispatch.ts).
    const snapshotPrefix = `${ws ?? ''}::`;
    const prevSnapshot = new Map(
      [...lastEdgeThrottleSnapshot]
        .filter(([key]) => key.startsWith(snapshotPrefix))
        .map(([key, v]) => [key.slice(snapshotPrefix.length), v] as const),
    );
    const { sharedEgress, rearming, nextSnapshot } = deriveEdgeThrottleEvidence(
      rows.map((r) => ({
        id: r.id,
        edgeThrottled: r.edgeThrottled,
        edgeThrottleResetAt: r.edgeThrottleResetAt,
        penaltyCount: r.rate.penaltyCount,
        // P-009: was `proxyUrl ?? localAddress ?? undefined`, which reported an account with no explicit
        // binding as UNKNOWN. It is not unknown — it is on the box's default SHARED egress, and saying so
        // is what lets deriveEdgeThrottleEvidence conclude sharedEgress at all. With the proxy entries
        // pulled (permanent per owner directive 2026-08-09) every account hit that branch, so every
        // identity was undefined and the shared-egress diagnosis was structurally unreachable.
        // EI-20613616736215896: pass `egressPool` TOO — it supersedes the singular `egress`, and reading
        // only the singular collapsed every pool-routed account onto one identity, flipping P-009's
        // total-fallback into an affirmative (and wrong) sharedEgress:true → a false owner escalation.
        egressIdentity: egressIdentityOf(r.egress, r.egressPool),
      })),
      prevSnapshot,
    );
    // Replace this workspace's slice wholesale — an account that drops out of throttle and later
    // re-enters should NOT be compared against a stale, unrelated prior episode.
    for (const key of [...lastEdgeThrottleSnapshot.keys()]) {
      if (key.startsWith(snapshotPrefix)) lastEdgeThrottleSnapshot.delete(key);
    }
    for (const [id, v] of nextSnapshot) lastEdgeThrottleSnapshot.set(`${snapshotPrefix}${id}`, v);

    return {
      provider,
      total: rows.length,
      // Excludes accounts the owner's session override forbids routing to — an account can be
      // pool-healthy AND forbidden, and admission (spawn-env.ts) refuses that route regardless.
      available: rows.filter((r) => r.available && allowedIds.has(r.id)).length,
      // A truly-usable account can serve, is not in an edge-throttle cooldown (a bare-429/IP wall),
      // AND is not excluded by the session override.
      usable: rows.filter((r) => r.available && !r.edgeThrottled && allowedIds.has(r.id)).length,
      // How many accounts the override excluded from the counts above — lets a caller distinguish
      // "genuinely no capacity" from "capacity exists but is fenced off by the owner's override".
      overrideExcludedCount,
      // Keep the exact steer alongside the derived counts. A zero usable count can be a
      // deliberate owner restriction, not quota exhaustion; consumers need the active input
      // to explain that distinction without reconstructing it from a refusal.
      sessionOverride: override,
      // EI-18664933641195210: break out WHY unusable accounts are unusable, so a poolExhausted advice
      // can name egress-throttle (owner-infra) vs usage-wall (just wait) instead of lumping both into
      // one vague "walled/rate-paused/edge-throttled" phrase that reads as generic quota exhaustion.
      edgeThrottledCount: rows.filter((r) => r.edgeThrottled).length,
      usageWalledCount: rows.filter((r) => r.usageWalled).length,
      // EI-19995356951235246: counts are only marginal evidence. Project the active reset terms for
      // routable accounts so capacity-dispatch can identify the constraint that actually gates the
      // earliest recovery. Expired terms and override-excluded rows must not steer that diagnosis.
      accountBindingTerms: rows
        .filter((r) => allowedIds.has(r.id))
        .map((r): AccountBindingTerms => ({
          id: r.id,
          ...(r.usageWalled && futureTerm(r.usageResetAt) != null
            ? { usageResetAt: futureTerm(r.usageResetAt) }
            : {}),
          ...(r.edgeThrottled && futureTerm(r.edgeThrottleResetAt) != null
            ? { edgeThrottleResetAt: futureTerm(r.edgeThrottleResetAt) }
            : {}),
          ...(futureTerm(r.rate.pausedUntil) != null ? { ratePausedUntil: futureTerm(r.rate.pausedUntil) } : {}),
        }))
        .filter((terms) => terms.usageResetAt != null || terms.edgeThrottleResetAt != null || terms.ratePausedUntil != null),
      // EI-18791793869559327: a sustainedlyLimited account is still `available`/not-edge-throttled (it
      // counts toward `usable` above), so without this the DEGRADED tier in buildCapacityReport can never
      // fire from a live read — the capacity advisor stayed blind to the pool's own scale-out signal.
      //
      // EI-19944752041493781: this MUST use the exact same predicate as `usable` above (line 102), not a
      // bare `rows.filter`. `AccountPoolAvailability.sustainedlyLimitedCount`'s own doc comment says "how
      // many of the `usable` accounts are sustainedlyLimited" and `degraded` in capacity-dispatch.ts compares
      // it directly against `acct.usable` — but a bare filter counts sustainedlyLimited across ALL accounts,
      // including ones that are unavailable/edge-throttled/override-excluded and therefore NOT in `usable`
      // at all. That mismatch let an unavailable (usage-walled) account's sustainedlyLimited flag get
      // counted against a DIFFERENT, actually-usable account — collapsing `degraded` to true (and the
      // advice to "all N/M usable accounts are sustainedly rate-limited") even when every truly-usable
      // account was fine. Measured live: usable=1 (avi_storewolf, sustainedlyLimited:false), yet the bare
      // filter reported sustainedlyLimitedCount=1 because ownerhandle (walled, NOT usable) was sustainedlyLimited
      // — a false "DEGRADED" verdict that was relayed to the owner and had to be retracted.
      sustainedlyLimitedCount: rows.filter(
        (r) => r.available && !r.edgeThrottled && allowedIds.has(r.id) && r.sustainedlyLimited,
      ).length,
      edgeThrottledSharedEgress: sharedEgress,
      edgeThrottledRearming: rearming,
      // EI-19281217347369076: `lastProbeFailedAt` is set the moment an accounts:probe-capacity attempt
      // came back 'no-reading' (the probe request itself failed) and cleared the moment ANY real
      // observation lands (recordAccountWindow) — so its presence here means "the last thing we tried
      // on this account got no answer", not "unmeasured in general". A majority of the pool carrying
      // this flag is the network-shaped signal buildCapacityReport degrades `poolExhausted`'s confidence
      // on (see its `blind` computation) instead of reporting a quota-shaped verdict off a stale store.
      //
      // EI-19928050541357086: fold a merely-STALE (never-refreshed) usage-window reading into this same
      // "unreliable" bucket, alongside an outright probe failure — `readingStatus` (accountReadingStatus,
      // account-pool-store.ts) already tracks exactly this ('never-observed'|'stale'|'fresh'), but nothing
      // here consulted it: only an actual probe FAILURE counted toward `blindCount`, so a pool that simply
      // hadn't been re-probed in 30-99 minutes (readingStatus:'stale', lastProbeFailedAt never set) reported
      // blind:false and a confident poolExhausted:true + owner-gated-egress-escalation verdict — which one
      // accounts:probe-capacity call then flatly contradicted (poolExhausted:false, usableAccounts:1) with
      // no other change. Both conditions mean the same thing to a caller: this row's available/usageWalled
      // verdict rests on data that is not a live measurement, so both belong in the one caveat.
      blindCount: rows.filter((r) => r.lastProbeFailedAt != null || r.readingStatus !== 'fresh').length,
    };
  } catch {
    return undefined;
  }
}

/** Backwards-compatible Claude read for the leader brief and existing callers. */
export async function readBeeProviderAvailability(accountId?: string): Promise<AccountPoolAvailability | undefined> {
  return readProviderAvailability(BEE_PROVIDER, accountId);
}

async function readClampArmed(): Promise<boolean> {
  try {
    const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
    return await getFlag(FLAGS.MUG_CAPACITY_DISPATCH, 'system').catch(() => false);
  } catch {
    return false;
  }
}

interface ProviderCapacityReading {
  provider: AccountProvider;
  model: string | null;
  account: string | null;
  verdict: 'blind' | 'measured' | 'unknown';
  [key: string]: unknown;
}

/**
 * Codex ChatGPT-subscription accounts may not have rows in the Claude-oriented account-pool store.
 * In that case the gateway's Codex /stats tier oracle is still a measured capacity source, but only
 * when it contains a positive healthy-account count and a concrete spare bee-tier budget. Missing,
 * non-positive, or incomplete tier data remains UNKNOWN so headcount admission stays fail-closed.
 */
function hasMeasuredCodexTierCapacity(
  provider: AccountProvider,
  report: Pick<
    ReturnType<typeof buildCapacityReport>,
    'tierLayer' | 'healthyAccounts' | 'dispatchBudget' | 'beeTier' | 'capByTier'
  >,
): boolean {
  if (provider !== 'codex' || report.tierLayer !== true) return false;
  // Every field here is nullable ("not measured"), and `Number.isInteger` is not a type guard —
  // it narrows nothing, so a bare `x <= 0` after it still reads a possible null. Guard the null
  // explicitly: a MISSING reading must fail this predicate for the same reason a bad one does.
  const positiveInt = (value: number | null | undefined): boolean =>
    value != null && Number.isInteger(value) && value > 0;
  const nonNegativeInt = (value: number | null | undefined): boolean =>
    value != null && Number.isInteger(value) && value >= 0;
  if (!positiveInt(report.healthyAccounts)) return false;
  if (!positiveInt(report.dispatchBudget)) return false;
  const beeTier = report.capByTier?.find((row) => row.tier === report.beeTier);
  return beeTier != null && [beeTier.minShare, beeTier.inFlight, beeTier.queued].every(nonNegativeInt);
}

/** One provider-scoped reading, shared by uniform and mixed-fleet responses. */
async function readCapacityForProvider(
  args: CapacityScopeArgs,
  provider: AccountProvider,
  clampArmed: boolean,
  preloadedRows?: AccountStatusRow[],
): Promise<ProviderCapacityReading> {
  const hr = await fetchGatewayHeadroom({ timeoutMs: 1500, provider });
  // P-004: fetch the account rows ONCE and feed BOTH consumers — the existing availability
  // cross-check and the canonical per-provider verdict below. Without this the verdict would
  // re-read the pool and could disagree with the availability leg rendered beside it.
  const rows = preloadedRows ?? (await readAccountRowsForVerdict());
  const accountAvailability = await readProviderAvailability(provider, args.account, rows);
  const tierMap = parsePriorityTierMap(process.env.GATEWAY_PRIORITY_MAP);
  const report = buildCapacityReport(hr, {
    clampArmed,
    headroom: args.headroom,
    tierMap,
    accountAvailability,
  });
  const accountPool = accountAvailability
    ? {
        provider: accountAvailability.provider ?? provider,
        total: accountAvailability.total,
        available: accountAvailability.available,
        usable: accountAvailability.usable,
        edgeThrottledAccounts: accountAvailability.edgeThrottledCount ?? null,
        usageWalledAccounts: accountAvailability.usageWalledCount ?? null,
        sustainedlyLimitedAccounts: accountAvailability.sustainedlyLimitedCount ?? null,
        overrideExcludedAccounts: accountAvailability.overrideExcludedCount ?? null,
        blindAccounts: accountAvailability.blindCount ?? null,
      }
    : null;
  // P-004 — THE CANONICAL VERDICT. `poolExhausted`/`verdict` above say THAT the lane is
  // stuck; neither says WHICH TERM binds it, so a reader could not tell a provider wall
  // from our own admission clamp from a burn PACING PROJECTION. `capacityVerdict` merges
  // both legs into one answer whose `binding` names the remedy. Derived from the SAME `rows`
  // and the SAME report, so it cannot disagree with the fields beside it.
  const capacityVerdict = deriveCapacityVerdict({
    provider,
    pool: await poolVerdictFor(rows, provider),
    admission: {
      reachable: report.reachable,
      blind: report.blind,
      dispatchBudget: report.dispatchBudget,
      inFlight: report.inFlight,
    },
  });
  return {
    provider,
    model: args.model ?? null,
    account: args.account ?? null,
    verdict: report.blind
      ? 'blind'
      : accountAvailability || hasMeasuredCodexTierCapacity(provider, report)
        ? 'measured'
        : 'unknown',
    ...report,
    accountPool,
    capacityVerdict,
    // The RESULT-level unknown channel the `capacity.verdict` cell hoists (axis 2). A caller
    // who reads only `capacityVerdict.atCapacity` still cannot miss an unmeasured leg.
    capacityUnknown: capacityVerdict.unknown,
  };
}

/** Read the account rows for the canonical verdict. Fail-safe: a read failure yields
 *  `undefined`, which the verdict reports as an UNMEASURED pool leg rather than a clear one. */
async function readAccountRowsForVerdict(): Promise<AccountStatusRow[] | undefined> {
  try {
    const { accountStatus } = await import('../../deployment/account-pool-store');
    return await accountStatus(activeWorkspaceId());
  } catch {
    return undefined;
  }
}

/**
 * The P-002 rollup for ONE provider, off rows already in hand.
 *
 * Returns `null` — never a synthesised empty rollup — when the rows could not be read or the
 * provider has none. `deriveCapacityVerdict` reports a null pool as an UNMEASURED leg; a
 * zero-filled stand-in would read as a measured-clear pool, which is the fail-open direction.
 */
async function poolVerdictFor(
  rows: AccountStatusRow[] | undefined,
  provider: AccountProvider,
): Promise<ProviderPoolVerdict | null> {
  if (!rows) return null;
  const { poolVerdictByProvider } = await import('../../deployment/account-pool-store');
  return poolVerdictByProvider(rows).find((v) => v.provider === provider) ?? null;
}

export default defineTool({
  name: 'fleet:capacity',
  description:
    'Read live gateway /stats capacity for an explicit provider/model/account or the caller\'s fleet: dispatchBudget (= cap − inFlight − queued), tier caps, utilization/pauses/queue, healthyAccounts, and reserved floor. `fleet` selects a named fleet; omitted resolves the current fleet. Explicit scope wins; mixed-provider fleets return per-provider readings, never a guessed aggregate. The legacy Claude default applies only outside fleets. Only measured selected-provider exhaustion sets poolExhausted:true/factor 0; contradictory or unmeasured scope returns verdict:"unknown". `headroom` clamps a proposed spawn count. Gateway-unreachable returns fail-safe no-clamp data.',
  guidance: {
    when: 'Before a placement round, to size how many FRESH members to spawn: select the provider/model/account scope, then place up to dispatchBudget when scarce (top-ranked first), broadly when abundant. Re-read each cycle — capacity moves.',
    notWhen: 'Inspecting the gateway pool config / confirming a hot-reload — that is gateway:status. Editing the pool — accounts:* + gateway:reload.',
    chaining: 'fleet:capacity { fleet: "my-fleet", headroom: <members you want to place> } → fleet:place_batch (which ALSO clamps automatically under MUG_CAPACITY_DISPATCH; this tool lets you reason about it first).',
    returns:
      "⚠ READ `capacityVerdict` FIRST — it is the ONE canonical answer to \"are we at capacity\", and it is the only field here that says WHICH TERM binds. Everything else (poolExhausted, verdict, dispatchBudget, accountPool) says THAT the lane is stuck or gives you one leg of it; none says what to DO. `capacityVerdict` = { provider, atCapacity, binding, evidence[], reason, unknown[] }, also readable as the state cell `capacity.verdict` (state:read { cell:'capacity.verdict', as:'<provider>' }) so you can re-read or subscribe to it instead of transcribing a number that moves.\n\n`binding` is the remedy, and the four values are NOT interchangeable: 'usage-wall' = a PROVIDER wall, hold and wait for a reset (raising admission or changing pacing cannot help); 'admission-concurrency' = OUR OWN door at zero spare slots while accounts can serve, so raise the window or let in-flight work drain — do NOT wait for a provider reset and do NOT escalate; 'pacing-policy' = this system pacing ITSELF off a burn PROJECTION, nothing is walled and NO reset is coming, so waiting is the wrong move (accept the burn or change the policy); 'none' = no measured blocker.\n\n⚠ `atCapacity: false` is NOT \"we are fine\" whenever `capacityUnknown` is non-empty — it then means \"no MEASURED blocker\", which includes \"we could not measure\". An unreachable gateway and an all-stale pool both land here, and both are UNKNOWN rather than clear. Equally, `binding` can name a wall while `atCapacity` is false: that is a pool measurably walled on its fresh rows with some rows still stale — treat it as probably-walled and refresh with accounts:probe-capacity, not as clear.\n\n`evidence[]` entries are writer-stamped ({ signal, value, writer, means }), so a number you distrust leads straight to the code that produced it. `binding` is never 'host' — neither leg measures the box; read the `host.memoryPressure` cell for that.",
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    headroom: z.number().int().min(0).max(10000).optional().describe('A proposed fresh-spawn count to clamp to spare capacity.'),
    provider: z.enum(['claude', 'codex']).optional().describe('Inference provider to inspect; defaults to Claude for backward compatibility.'),
    model: z.string().min(1).max(120).optional().describe('Requested model family; gpt/o/codex models select the Codex backend when provider is omitted.'),
    account: z.string().min(1).max(200).optional().describe('Optional pinned account id. An account-only request resolves its provider from accounts:status.'),
    fleet: z.string().min(1).max(200).optional().describe('Optional named fleet to scope capacity to. Without an explicit backend, a caller in a fleet uses its current live member providers.'),
  }),
  // Keep the rich, evolving capacity report available as structured content while
  // publishing the load-bearing verdict fields used by guidance.returns. The
  // passthrough allows the read-model to grow without a second prose schema.
  result: z
    .object({
      provider: z.string().nullable().optional(),
      atCapacity: z.boolean().optional(),
      binding: z.enum(['usage-wall', 'admission-concurrency', 'pacing-policy', 'none']).optional(),
      evidence: z.array(z.unknown()).optional(),
      reason: z.string().optional(),
      unknown: z.array(z.unknown()).optional(),
      ok: z.boolean().optional(),
      model: z.string().nullable().optional(),
      account: z.string().nullable().optional(),
      verdict: z.string().optional(),
      capacityVerdict: z.unknown().optional(),
      capacityUnknown: z.array(z.unknown()).optional(),
      dispatchBudget: z.number().nullable().optional(),
      accountPool: z.unknown().nullable().optional(),
      scope: z.unknown().optional(),
      providerSource: z.string().optional(),
      fleet: z.string().optional(),
      providers: z.array(z.string()).optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const scope = await resolveCapacityScope(args);
    const pinnedAccount = accountPin(args.account);
    const explicitBackend = Boolean(args.provider || args.model || pinnedAccount);
    const fleetScope = await resolveFleetScope(args, ctx, !explicitBackend || !!args.fleet);
    const providerSource: ProviderSource = explicitBackend
      ? 'explicit'
      : fleetScope.fleetSlug
        ? 'fleet'
        : 'legacy-default';
    const fleetPayload = fleetScope.fleetSlug ? { fleet: fleetScope.fleetSlug } : {};
    const scopePayload = {
      provider: scope.provider,
      model: args.model ?? null,
      account: args.account ?? null,
      ...fleetPayload,
    };
    const modelProviderMismatch = !!args.provider && !!scope.modelProvider && args.provider !== scope.modelProvider;
    const accountScopeUnknown = !!pinnedAccount && scope.accountFound !== true;
    const accountProviderMismatch = !!scope.accountProvider && scope.accountProvider !== scope.provider;
    if (modelProviderMismatch || accountScopeUnknown || accountProviderMismatch) {
      const reason = modelProviderMismatch
        ? `model '${args.model}' belongs to provider '${scope.modelProvider}', not '${scope.provider}'`
        : accountProviderMismatch
          ? `account '${pinnedAccount}' belongs to provider '${scope.accountProvider}', not '${scope.provider}'`
          : `account '${pinnedAccount}' has no measured provider row`;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              verdict: 'unknown',
              provider: scope.provider,
              model: args.model ?? null,
              account: args.account ?? null,
              scope: scopePayload,
              providerSource,
              ...fleetPayload,
              reason,
            }),
          },
        ],
      };
    }

    let providers: AccountProvider[];
    let fleetReason: string | undefined;
    if (!explicitBackend && fleetScope.fleetSlug) {
      const fleetResolution = await resolveFleetProviders(
        fleetScope.fleetSlug,
        fleetScope.workspaceId,
        fleetScope.ownerId,
      );
      providers = fleetResolution.providers;
      fleetReason = fleetResolution.reason;
      if (providers.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                verdict: 'unknown',
                provider: null,
                model: null,
                account: null,
                scope: { ...scopePayload, provider: null },
                providerSource,
                ...fleetPayload,
                providers: [],
                reason: fleetReason,
              }),
            },
          ],
        };
      }
    } else {
      providers = [scope.provider];
    }
    const clampArmed = await readClampArmed();
    const readings = await Promise.all(
      providers.map((provider) => readCapacityForProvider(args, provider, clampArmed, scope.accountRows)),
    );

    if (readings.length > 1) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              verdict: 'unknown',
              provider: null,
              model: null,
              account: null,
              scope: { ...scopePayload, provider: null },
              providerSource,
              ...fleetPayload,
              providers,
              providerReadings: readings,
              reason:
                fleetReason ??
                `fleet '${fleetScope.fleetSlug ?? 'unknown'}' has mixed member providers; no single capacity verdict is valid`,
            }),
          },
        ],
      };
    }

    const reading = readings[0]!;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ...reading,
            scope: { ...scopePayload, provider: reading.provider },
            providerSource,
            ...fleetPayload,
          }),
        },
      ],
    };
  },
});
