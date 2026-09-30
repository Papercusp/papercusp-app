/**
 * p2p/delegated-spawn-honor.ts — the P-009 HONOR path: a contributing host (B)
 * receives a fleet owner's signed 'spawn_request' offer-store record and, if —
 * and only if — every gate passes, spawns bounded members from its own
 * delegated seats onto the owner's fleet
 * (agent-allocation-framework-2026-07-03 P-009, entry gate P-008/D-006).
 *
 * DRIVE: projection-driven, not polled (the WI-1940 reaper pattern) — the
 * work-offers projection calls {@link honorSpawnRequestFromProjection} after a
 * REMOTE-origin open 'spawn_request' row lands (sync catch-up covers an offline
 * host: the hook fires whenever the row finally applies). There is NO
 * re-trigger on a later ACCEPT_DELEGATED_SEATS flip — a request that arrived
 * while the gate was off just sits un-disposed and EXPIRES; the owner
 * re-requests after the host opts in (the freshness fence is what makes a late
 * flip safe: a stale request must never fire a surprise spawn).
 *
 * GATES, in order (all fail-closed):
 *   1. ACCEPT_DELEGATED_SEATS (owner-authority, default-OFF) — gate off is a
 *      SILENT skip (no disposition, no receipt: the host owner simply hasn't
 *      opted in; nothing here is refused *yet*).
 *   2. Target match — the request names a seat-offer THIS machine published:
 *      re-derive seatOfferId over the host's own agent_slot allotments (both
 *      fleet-scoped, for record.fleetSlug, AND pot-scoped, any pot this host
 *      donated to — P-003) with its own device pubkey (the M19-local account
 *      string never crossed the wire; only its hash contribution did). Someone
 *      else's request → silent skip.
 *   3. Freshness — requestedAtMs within the honor window (default 60 min).
 *   2.5/3.5 (P-003) Audience — ONLY when Gate 2 matched a POT-scoped offer: the
 *      requesting fleet's OWNER (the spawn_request's publisher) must pass this
 *      host's audience check for that pot — 'trusted-members' → the host's
 *      local trust list (D-002: never a silent widening of trust:add's "auto-run
 *      remote work" semantics — a separate, explicit grant); 'whole-pot' → pot
 *      membership. A fleet-scoped match carries no audience concept and skips
 *      straight through. Fail-closed; refusal is LOUD (`audience_refused`,
 *      federated receipt threaded by offer id) so a trust revocation takes
 *      effect on the very next claim with no offer republish (D-002/D-003).
 *   4. Seat availability — resolveSeatLaunch's cap math; consumeSeatAtBoot
 *      re-enforces atomically at each member's bootstrap regardless.
 *   5. Atomic claim — local_disposition 'honoring' (per-offer variant, WHERE
 *      NULL) so two concurrent hooks can never double-spawn.
 * Refusals past gate 2 are LOUD: a host-local disposition ('refused:<code>')
 * + a federated p2p_receipts refusal (D-004 no-silent-drops) so the owner
 * learns why. Success needs no receipt: the members' federated presence
 * joining the owner's fleet IS the signal.
 *
 * The spawn itself reuses the launch-from-seats machinery verbatim
 * (memberLaunchCommand --seat/--fleet/--plan → bootstrap-su fleet stamp +
 * consumeSeatAtBoot), via dynamic import so this module — which the sync
 * projection layer imports — never drags the agent-tools graph into the
 * replication path. WI-1408 gotcha handled: bootstrap's fleet JOIN fail-softs
 * without a local agent_fleets row, and the registry is machine-local, so the
 * honor path ensures the row exists (createFleetIfAbsent, leader = the
 * requesting owner) before spawning.
 */

import type { Sql } from 'postgres';
import { hostAcceptsDelegatedSeats } from './accept-delegated-seats';
import { resolveUsageActor } from '../harness/usage-actor';
import { resolveDeviceKeychainId } from '../identity/device-keychain-id';
import { loadOrGenerateDeviceKeypair } from '../identity/attest';
import { listResourceAllotments, type AllotmentAudience } from './resource-allotments';
import {
  createByocBudget,
  prepareByocExecution,
  settleByocExecution,
  type ByocExecutionContext,
} from './byoc-execution';
import { emptyMeteringLedger } from './metering-ledger';
import type { BillingMode } from './billing-matrix';
import type { AxisCap, LedgerState } from './offer-budget';
import {
  resolveSeatLaunch,
  seatAvailabilityForFleet,
  seatLaunchOpts,
  slotFromAllotment,
  type SeatSlot,
} from '../fleet/seat-accounting';
import { setLocalOfferDispositionForOffer } from './offer-store';
import { resolveSpawnHostOperatorBaseUrl } from '../mcp-base-url';
import {
  parseWorkOfferRecordJson,
  type SpawnRequestPayload,
  type WorkOfferStoreRecord,
} from './offer-store-schema';
import { seatOfferId } from './offer-store-publish';
import { appendResponderBuildMarker, emitP2pReceipt } from './receipts';
import {
  resolveHonorAccount as resolveHonorAccountCore,
  probeLocalClaudeLogin,
  classifyHonorSpawnFailure,
  extractAuthFailureExcerpt,
  type HonorAccountResolution,
} from './honor-account-resolution';
import type { OrgSql } from '../work-items';
import type { FleetPresenceRow } from '../agent-tools/coordination/presence-fleet';
import { getBuildInfo, type BuildInfo } from '../build-info';
import { evaluateDelegatedSeatPolicy, loadDelegatedSeatPolicy } from './delegated-seat-policy';

/** How long a spawn-request stays honorable after its publisher-clock stamp. */
export const SPAWN_REQUEST_HONOR_WINDOW_MS = 60 * 60_000;
/** Tolerated forward clock skew before a future-dated request is refused. */
export const SPAWN_REQUEST_CLOCK_SKEW_MS = 10 * 60_000;

/** D-003 sentinel mirrored from offer-store-publish (the offer-id hash side). */
const AUTO_ACCOUNT = 'AUTO';

/** P-003: one of THIS host's pot-scoped agent_slot allotments, offered as a
 *  Gate-2 match candidate — the request names only a targetOfferId, never
 *  which pot in advance, so every active pot-scoped slot is tried. */
export interface PotSeatCandidate {
  slot: SeatSlot;
  potSlug: string;
  audience: AllotmentAudience;
}

export type SpawnRequestEvaluation =
  | {
      ok: true;
      slot: SeatSlot;
      payload: SpawnRequestPayload;
      /** P-003: set iff Gate 2 matched a POT-scoped candidate — the audience
       *  gate consults this; null for a fleet-scoped match (no audience concept). */
      potMatch: { potSlug: string; audience: AllotmentAudience } | null;
    }
  | {
      ok: false;
      code: 'not_spawn_request' | 'not_open' | 'not_target' | 'expired' | 'seat_ref_unknown';
      detail: string;
      /** null ⇒ silent skip (not ours to judge); a string ⇒ dispose + receipt. */
      disposition: string | null;
    };

/**
 * PURE: is this request addressed to THIS host, fresh, and matched to one of
 * its delegated slot templates (fleet-scoped OR pot-scoped, P-003)? No I/O —
 * the caller supplies the host's own identity + its active agent_slot slots.
 */
export function evaluateSpawnRequestTarget(opts: {
  record: WorkOfferStoreRecord;
  selfGithubUserId: number;
  selfDevicePubkey: string;
  /** THIS host's active agent_slot slots for record.fleetSlug (fleet-scoped offers). */
  slots: readonly SeatSlot[];
  /** P-003: THIS host's active pot-scoped agent_slot allotments (any pot) —
   *  each tried as a candidate scope since the request doesn't name the pot. */
  potSlots?: readonly PotSeatCandidate[];
  nowMs: number;
  honorWindowMs?: number;
  clockSkewMs?: number;
}): SpawnRequestEvaluation {
  const { record } = opts;
  if (record.kind !== 'spawn_request' || !record.spawnRequest) {
    return { ok: false, code: 'not_spawn_request', detail: `kind=${record.kind}`, disposition: null };
  }
  const payload = record.spawnRequest;
  if (record.status !== 'open') {
    return { ok: false, code: 'not_open', detail: `status=${record.status}`, disposition: null };
  }
  if (payload.targetPublisherGithubUserId !== opts.selfGithubUserId) {
    return {
      ok: false,
      code: 'not_target',
      detail: `targets publisher ${payload.targetPublisherGithubUserId}, self=${opts.selfGithubUserId}`,
      disposition: null,
    };
  }
  const windowMs = opts.honorWindowMs ?? SPAWN_REQUEST_HONOR_WINDOW_MS;
  const skewMs = opts.clockSkewMs ?? SPAWN_REQUEST_CLOCK_SKEW_MS;
  const age = opts.nowMs - payload.requestedAtMs;
  if (age > windowMs || age < -skewMs) {
    return {
      ok: false,
      code: 'expired',
      detail:
        age > windowMs
          ? `request is ${Math.round(age / 60_000)} min old (window ${Math.round(windowMs / 60_000)} min) — the owner must re-request`
          : `request is dated ${Math.round(-age / 60_000)} min in the future (skew cap ${Math.round(skewMs / 60_000)} min)`,
      disposition: 'refused:expired',
    };
  }
  // The M19 re-derivation: the wire named a seat-offer id; only THIS machine
  // can recompute it (the hash needs the local account string + device pubkey).
  // Try the fleet-scoped slots first (the common case), then every pot-scoped
  // candidate (P-003) — the request names only a targetOfferId, never which
  // pot, so each active pot-scoped allotment is tried as its own scope.
  const fleetSlot = opts.slots.find(
    (s) =>
      seatOfferId({
        fleetSlug: record.fleetSlug,
        model: s.model,
        effort: s.effort,
        account: s.account || AUTO_ACCOUNT,
        devicePubkey: opts.selfDevicePubkey,
      }) === payload.targetOfferId,
  );
  let matchedSlot: SeatSlot | null = fleetSlot ?? null;
  let potMatch: { potSlug: string; audience: AllotmentAudience } | null = null;
  if (!matchedSlot) {
    for (const cand of opts.potSlots ?? []) {
      const id = seatOfferId({
        potSlug: cand.potSlug,
        model: cand.slot.model,
        effort: cand.slot.effort,
        account: cand.slot.account || AUTO_ACCOUNT,
        devicePubkey: opts.selfDevicePubkey,
      });
      if (id === payload.targetOfferId) {
        matchedSlot = cand.slot;
        potMatch = { potSlug: cand.potSlug, audience: cand.audience };
        break;
      }
    }
  }
  if (!matchedSlot) {
    return {
      ok: false,
      code: 'seat_ref_unknown',
      detail: `no active agent_slot delegation on this machine (fleet-scoped for ${record.fleetSlug}, or any pot-scoped donation) matches seat-offer ${payload.targetOfferId} (revoked since, or a different device)`,
      disposition: 'refused:seat_ref_unknown',
    };
  }
  return { ok: true, slot: matchedSlot, payload, potMatch };
}

export interface SpawnMembersRequest {
  workspaceId: string;
  /** The hive HOME slug — the harness the members boot into. */
  potHomeSlug: string;
  fleetSlug: string;
  planSlug: string;
  count: number;
  /** The consumed slot template ref ('<model>:<effort>:<account>'). */
  seatRef: string;
  /** psu pins derived from the slot (seatLaunchOpts). */
  launch: { model: string; account: string };
  /** Raw brief text from the request (composed under the baseline), or null. */
  launchContext: string | null;
  /** The requesting owner — becomes the ensured local fleet row's leader. */
  requesterOwnerId: string;
  /** Labels for the spawned terminals. */
  requestOfferId: string;
}

export interface SpawnMembersResult {
  opened: number;
  failed: number;
  firstError: string | null;
  /**
   * EI-24635523980082322: one handle per OPENED member, so a honor that later
   * refuses can stop what it started. Absent means the spawner could not say
   * (a DI override); the refusal then states the members were NOT stopped.
   */
  members?: SpawnedMemberHandle[];
}

/** What a refusing honor needs to stop one opened member and read its boot log. */
export interface SpawnedMemberHandle {
  /** Task-ledger id of an enrolled (headless) launch; null for a visible window. */
  taskId: string | null;
  pid: number | null;
  /** ANSI-free companion log when the spawner wrote one, else the raw log. */
  logPath: string | null;
}

/** Outcome of {@link defaultStopSpawnedMembers} / a caller's DI override. */
export interface StopSpawnedMembersResult {
  stopped: number;
  notStopped: number;
  /** Human detail naming what was stopped and why anything was not. */
  detail: string;
}

/** Result of {@link defaultVerifyLocalMemberBoot} / a caller's DI override. */
export interface LocalBootVerifyResult {
  /** True only when a NEW presence row for `fleetSlug` also has a completed tool
   * invocation after this honor started. A launcher can author presence without
   * the agent process ever taking a turn (WI-35786). */
  observed: boolean;
  /** Human detail — always states what evidence produced the verdict. */
  detail: string;
  /** Fresh launcher-authored owner whose first turn was not proven. */
  ownerId?: string;
  /** Bounded last assistant turn from that owner's local transcript, when one
   * exists. This makes an exit-zero CLI failure attributable without treating
   * every presence-only miss as an account failure. */
  failureDetail?: string | null;
}

/** How long to locally poll for the spawned member's first attributed tool call
 * before finalizing 'honored'. Mirrors the order of magnitude of
 *  spawnHeadless's own HEADLESS_BOOT_RECEIPT_MS boot-death window: long enough for a
 *  normal psu boot (coord:orient runs within the first few seconds), short enough to
 *  not meaningfully stall the replication-apply loop it runs inside. */
export const LOCAL_BOOT_VERIFY_MS = 8000;
const LOCAL_BOOT_VERIFY_POLL_MS = 1000;

/** Read the launched member's last assistant turn from the canonical local
 * transcript. A Claude auth failure can exit zero after its window/presence was
 * opened, so console-spawn has no non-zero boot receipt to fold into
 * SpawnMembersResult.firstError. This post-spawn seam recovers the actual CLI
 * verdict instead of manufacturing a cause from the missing tool call alone. */
async function defaultReadLocalMemberFailure(ownerId: string): Promise<string | null> {
  try {
    const [{ latestAdvSessionByCoordOwner }, claude, { readLastAssistantTurn }] = await Promise.all([
      import('../adv-sessions'),
      import('../claude-sessions'),
      import('../turn-journal'),
    ]);
    const session = await latestAdvSessionByCoordOwner(ownerId);
    if (session?.agent && session.agent !== 'claude') return null;
    const transcript = session?.sessionId
      ? await claude.resolveInteractiveTranscript(session.sessionId, { owner: ownerId })
      : claude.newestTranscriptUnderOwner(ownerId);
    if (!transcript) return null;
    const last = await readLastAssistantTurn(transcript, 'claude');
    const text = last?.text.trim() ?? '';
    return text ? text.slice(0, 2000) : null;
  } catch {
    return null;
  }
}

/**
 * WI-35786: LOCAL first-turn check after a spawn reports `opened > 0`.
 *
 * `spawn.opened` only proves the OS accepted a launch request. The Windows
 * desktop-bridge signal is only the Tauri IPC round-trip; the Linux/macOS/headless
 * probes detect an early process death but still do not prove the CLI reached its first
 * turn. The same first-turn oracle therefore applies on every platform.
 *
 * Presence alone is not the oracle: the macOS login-window failure created a fresh
 * launcher-authored row, then no CLI process, transcript, or tool call ever existed.
 * Poll the fleet roster plus its newest attributed tool invocation and require both
 * to be newer than the honor start. The caller fails closed on a miss.
 */
export async function defaultVerifyLocalMemberBoot(args: {
  workspaceId: string;
  fleetSlug: string;
  sinceMs: number;
  windowMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  listPresence?: (workspaceId: string, fleetSlug: string) => Promise<FleetPresenceRow[]>;
  readMemberFailure?: (ownerId: string) => Promise<string | null>;
}): Promise<LocalBootVerifyResult> {
  const windowMs = args.windowMs ?? LOCAL_BOOT_VERIFY_MS;
  const pollMs = args.pollMs ?? LOCAL_BOOT_VERIFY_POLL_MS;
  const sleep =
    args.sleep ??
    ((ms: number) =>
      new Promise<void>((resolveSleep) => {
        const t = setTimeout(resolveSleep, ms);
        t.unref?.();
      }));
  const deadline = Date.now() + windowMs;
  let presenceOnly: FleetPresenceRow | null = null;
  try {
    const listPresence =
      args.listPresence ??
      (await import('../agent-tools/coordination/presence-fleet')).listFleetPresence;
    for (;;) {
      const rows = await listPresence(args.workspaceId, args.fleetSlug);
      const fresh = rows.find(
        (r) =>
          r.startedAt.getTime() >= args.sinceMs &&
          r.lastToolCallAt != null &&
          r.lastToolCallAt.getTime() >= Math.max(args.sinceMs, r.startedAt.getTime()),
      );
      if (fresh) {
        return {
          observed: true,
          detail:
            `member ${fresh.ownerId} took a tool-backed turn in '${args.fleetSlug}' locally ` +
            `(first-turn evidence at ${fresh.lastToolCallAt!.toISOString()})`,
        };
      }
      presenceOnly = rows.find((r) => r.startedAt.getTime() >= args.sinceMs) ?? presenceOnly;
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    }
  } catch (e) {
    return {
      observed: false,
      detail: `local presence check failed (best-effort, non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (presenceOnly) {
    const readMemberFailure = args.readMemberFailure ?? defaultReadLocalMemberFailure;
    const failureDetail = await readMemberFailure(presenceOnly.ownerId).catch(() => null);
    return {
      observed: false,
      ownerId: presenceOnly.ownerId,
      failureDetail,
      detail:
        `member ${presenceOnly.ownerId} registered presence in '${args.fleetSlug}', but no tool invocation ` +
        `was attributed to it within ${Math.round(windowMs / 1000)}s — presence-only is not a boot proof`,
    };
  }
  return {
    observed: false,
    detail: `no member took a tool-backed turn in '${args.fleetSlug}' locally within ${Math.round(windowMs / 1000)}s of honoring`,
  };
}

export type DelegatedSpawnHonorOutcome =
  | { outcome: 'gate_off' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'already_claimed' }
  | { outcome: 'refused'; code: string }
  | {
      outcome: 'honored';
      opened: number;
      failed: number;
      /**
       * P-017: seats actually COMMITTED against the BYOC budget — the reservation
       * is opened at `payload.count` and committed at the number of members that
       * genuinely booted, so this is the metered draw, not the requested one.
       * `null` only when settlement itself refused (logged; never unwinds a live
       * spawn — the members are already running).
       */
      committedSeats: number | null;
    };

/**
 * P-017 (D-045 §3f): which X7 billing authority a delegated seat runs under.
 *
 * The honoring host executes on ITS OWN credentials, so a seat pinned to this
 * host's local login or to a named pool id is `host-pays` — host-signed receipts
 * alone are authoritative. A seat authored `AUTO` spends the gateway ACCOUNT
 * POOL instead, which is `pool-with-attribution`; billing-matrix then enforces
 * M17 (single-owner pools only), because honoring a remote fleet's request out
 * of a MULTI-owner pool would spend other owners' credentials for a third party.
 */
export function byocBillingModeForRoute(credentialRoute: 'auto' | 'default' | 'pinned'): BillingMode {
  return credentialRoute === 'auto' ? 'pool-with-attribution' : 'host-pays';
}

/**
 * P-017: the seat axis this honor spends against. Denominated in `slots` (H14 —
 * both sides of every comparison must already agree, and the delegated-seat
 * board counts whole seats). The cap is what REMAINS on the matched slot, so a
 * single reserve of the requested count is the honest ceiling test; the H11
 * per-call clamp is the host's own `maxConcurrentSeats` policy ceiling.
 */
export function byocSeatAxisCap(available: number, maxConcurrentSeats: number): AxisCap {
  return {
    cap: Math.max(0, available),
    unit: 'slots',
    maxPerCall: maxConcurrentSeats > 0 ? maxConcurrentSeats : null,
  };
}

/** DI seams so unit tests run without PG/keychain/desktop. */
export interface DelegatedSpawnHonorDeps {
  hostAccepts?: typeof hostAcceptsDelegatedSeats;
  resolveActor?: typeof resolveUsageActor;
  resolveDevicePubkey?: (githubUserId: number) => Promise<string>;
  listAllotments?: typeof listResourceAllotments;
  availabilityForFleet?: typeof seatAvailabilityForFleet;
  setDisposition?: typeof setLocalOfferDispositionForOffer;
  spawnMembers?: (req: SpawnMembersRequest) => Promise<SpawnMembersResult>;
  /** EI-24635523980082322: stop the members a refusing honor opened. Default
   *  {@link defaultStopSpawnedMembers} kills through the task ledger. */
  stopSpawnedMembers?: (members: SpawnedMemberHandle[]) => Promise<StopSpawnedMembersResult>;
  /** EI-24635529006243850: bounded tail of a member's boot log, scanned for an
   *  auth signature when first-turn verification found no transcript detail. */
  readMemberLogTail?: (path: string) => Promise<string | null>;
  emitReceipt?: typeof emitP2pReceipt;
  /** Loaded responder identity sampled at each receipt emission (test seam). */
  getBuildInfo?: () => BuildInfo;
  /**
   * WI-5306: preflight whether THIS host can actually RUN a delegated member for
   * the seat's agent CLI, BEFORE claiming/spawning. Default resolves the CLI
   * (`claude`/`omp`) via a login-shell `command -v` ({@link defaultProbeAgentRuntime}).
   * A refusal here federates a receipt so the requester learns the host lacks
   * the runtime, instead of the member phantom-"opening" and never joining.
   */
  probeAgentRuntime?: (model: string | undefined) => Promise<{ resolved: boolean; detail: string }>;
  /**
   * WI-5316: resolve the seat's `--account` selection against THIS host's gateway
   * pool BEFORE claiming/spawning. A seat authored `AUTO` becomes `--account=auto`,
   * which psu refuses on a host with an empty pool → silent dead member (sibling of
   * WI-5306). Default {@link defaultResolveHonorAccount} downgrades auto→default when
   * the pool is empty but a local login exists, or refuses (`account_unfulfillable`,
   * federated receipt) when genuinely unfulfillable.
   */
  resolveHonorAccount?: (requestedAccount: string, workspaceId: string) => Promise<HonorAccountResolution>;
  /** P-516/F5 host-owned trust/cap policy; invalid overrides fail closed. */
  loadDelegatedSeatPolicy?: typeof loadDelegatedSeatPolicy;
  /**
   * P-003 audience gate, 'trusted-members' case: is this GitHub user on THIS
   * host's local trust list? Default {@link defaultIsTrustedUser} reads
   * user-trust-list.ts (the same store `trust:add`/`trust:remove` back).
   */
  isTrustedUser?: (workspaceId: string, githubUserId: number) => Promise<boolean>;
  /**
   * P-003 audience gate, 'whole-pot' case: is this GitHub user a member of the
   * named pot? Default {@link defaultIsPotMember} reads hive-membership-store.ts
   * (harness_shared.pot_members).
   */
  isPotMember?: (workspaceId: string, potSlug: string, githubUserId: number) => Promise<boolean>;
  nowMs?: () => number;
  honorWindowMs?: number;
  /**
   * WI-35786: LOCAL first-turn verification on every platform. A miss fails the
   * honor closed with a federated member_boot_unconfirmed refusal.
   */
  verifyLocalMemberBoot?: (args: {
    workspaceId: string;
    fleetSlug: string;
    sinceMs: number;
  }) => Promise<LocalBootVerifyResult>;
  /**
   * P-017 (D-045 §3f): the M17 single-owner reading for the gateway account
   * pool, consulted ONLY when the seat routes through it (`--account=auto` ⇒
   * `pool-with-attribution`). `null` means the ownership could not be
   * established, which billing-matrix treats as fail-closed — an unknown pool
   * is never spent on a remote fleet's behalf. Default reads the account
   * resolver lazily, keeping the inference-gateway graph off the sync
   * projection's import path (the same posture as the other lazy deps here).
   */
  resolveBillingPool?: (workspaceId: string) => Promise<{ singleOwner: boolean } | null>;
}

async function defaultResolveDevicePubkey(githubUserId: number): Promise<string> {
  const keypair = await loadOrGenerateDeviceKeypair(resolveDeviceKeychainId(githubUserId));
  return keypair.pubkeyBase64;
}

/**
 * P-003 default audience check, 'trusted-members' case — dynamic import keeps
 * the trust-list module off this file's (sync-projection) import path until an
 * honor actually needs it, mirroring the module's other lazy-load deps.
 */
async function defaultIsTrustedUser(workspaceId: string, githubUserId: number): Promise<boolean> {
  const { listTrustedUsers } = await import('../trust/user-trust-list');
  const trusted = await listTrustedUsers(workspaceId);
  return trusted.some((t) => t.githubUserId === githubUserId);
}

/** P-003 default audience check, 'whole-pot' case. */
async function defaultIsPotMember(workspaceId: string, potSlug: string, githubUserId: number): Promise<boolean> {
  const { getHiveMember } = await import('../hive-membership-store');
  // ⚠ SCOPE (WI-6312): `potSlug` arrives as the LOCAL handle. pot_members is written under
  // the FEDERATED scope, so the local handle returns null and this audience check answers
  // "not a member" for a REAL member — denying a legitimate delegated spawn on a divergent
  // joiner. Lazy-imported alongside the store to keep this file's projection import path thin.
  const { resolveFederatedPotScope } = await import('../federated-pot-scope');
  const potScope = await resolveFederatedPotScope(workspaceId, potSlug);
  const member = await getHiveMember(workspaceId, potScope, githubUserId);
  return member != null;
}

// ─── WI-5306: agent-runtime preflight ────────────────────────────────
//
// spawnConsole (and spawnMacConsole) report status:'ok' when the terminal
// WINDOW launches — NOT when the agent process booted. buildConsoleOneliner
// execs a login shell AFTER the greeting, so a member whose `claude`/`omp` CLI
// is absent hits `command not found`, the window stays open, and the spawner
// counts it opened anyway — honored "N opened", zero live members, no receipt,
// the requesting leader waits forever (proven on the mac rig, which has no
// `claude` CLI). Preflight the seat's agent CLI on THIS host and refuse LOUDLY
// (federated receipt) BEFORE claiming the request, so a missing runtime is
// visible instead of a phantom success.

export type RuntimeProbeError = {
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
  message?: string;
} | null;

/**
 * Classify a `command -v <bin>` probe outcome. PURE (no I/O) + exported for
 * unit tests. `err === null` ⇒ the probe exited 0 (binary resolved).
 *
 * Only a DEFINITIVE non-zero EXIT (a numeric code, not killed/signalled) proves
 * the binary is absent. ENOENT (no bash on the host), a timeout kill, or a
 * signal death cannot prove absence — those FAIL OPEN (resolved:true) so a
 * flaky probe never blocks a host that can actually run the member (the spawn's
 * own failure path still catches a genuinely broken launch).
 */
export function classifyRuntimeProbe(
  agentBin: string,
  err: RuntimeProbeError,
): { resolved: boolean; detail: string } {
  if (!err) return { resolved: true, detail: `'${agentBin}' is resolvable on the honoring host's login PATH` };
  if (typeof err.code === 'number' && err.code !== 0 && !err.killed && !err.signal) {
    const runtime = agentBin === 'omp' ? 'the omp local-model runner' : `the ${agentBin} CLI`;
    return {
      resolved: false,
      detail:
        `this host cannot run a '${agentBin}' member: '${agentBin}' is not on the member's login PATH ` +
        `(command not found). Install ${runtime} on this machine, or delegate a seat whose model this host can run.`,
    };
  }
  return {
    resolved: true,
    detail: `agent-runtime probe for '${agentBin}' was inconclusive (${err.message ?? String(err.code)}); assuming present`,
  };
}

/**
 * Probe whether the member's agent CLI (`claude`/`omp`/`codex`) is runnable on
 * THIS honoring host, resolving it the way the member's OWN login shell will —
 * `bash -lc 'command -v <bin>'`. The member launches under `bash -lc` and
 * buildConsoleOneliner exports PATH from the LOGIN shell, so a background
 * operator's own (narrower) PATH is NOT a faithful model — a login-shell probe
 * is. Bounded (5s) + best-effort (see {@link classifyRuntimeProbe} for the
 * fail-open policy). `agentBin` is a controlled literal, never user input.
 */
export async function probeAgentBinResolvable(agentBin: string): Promise<{ resolved: boolean; detail: string }> {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolvePromise) => {
    execFile('bash', ['-lc', `command -v ${agentBin}`], { timeout: 5000 }, (err) => {
      resolvePromise(classifyRuntimeProbe(agentBin, err as RuntimeProbeError));
    });
  });
}

/**
 * WI-10003468: the agent CLI a delegated seat's member runs under, derived from
 * the seat MODEL alone — the honoring host has no calling agent whose backend it
 * could inherit. Same precedence resolveFleetAgent (launch-on-plan) applies with
 * no explicit agent and no caller: an ollama/ornith id ⇒ omp, a known cloud family
 * ⇒ its native CLI (cloudModelBackendHint: gpt-* / o-series / luna|terra|sol /
 * *codex* ⇒ codex; opus|sonnet|haiku|fable / claude-* ⇒ claude), unknown ⇒ claude.
 *
 * Before this the choice was `isOmpLocalModel ? 'omp' : 'claude'`, so a codex seat
 * (gpt-5.6-sol:xhigh) launched `psu --agent=claude`, psu refused the cross-backend
 * model at boot, and the seat settled refused:spawn_failed AFTER it was consumed
 * (P-202 WD-5/WD-6, run 20260927144532, receipt 8ed8d788). The runtime probe had the
 * same blind spot: it checked `claude` was on PATH for a member that needs `codex`.
 *
 * The launch-on-plan import is DYNAMIC so this module — imported by the sync
 * projection layer — never drags the agent-tools graph in until a request is
 * actually being honored.
 */
export async function resolveDelegatedSeatAgent(model: string | undefined): Promise<'claude' | 'omp' | 'codex'> {
  const { isOmpLocalModel, cloudModelBackendHint } = await import('../agent-tools/fleet_registry/launch-on-plan');
  if (isOmpLocalModel(model)) return 'omp';
  return cloudModelBackendHint(model) ?? 'claude';
}

/**
 * Default runtime preflight: probe the agent CLI the member will actually run
 * under ({@link resolveDelegatedSeatAgent} — omp / codex / claude by model family).
 */
async function defaultProbeAgentRuntime(model: string | undefined): Promise<{ resolved: boolean; detail: string }> {
  return probeAgentBinResolvable(await resolveDelegatedSeatAgent(model));
}

/**
 * Default honor-time account resolution (WI-5316): read THIS host's registered
 * claude pool (dynamic import keeps the inference-gateway graph off the sync
 * projection's import path) and hand it to the pure resolver. FAIL-OPEN on a
 * pool-load error — keep the requested account rather than block a valid host on
 * a transient PG blip (same philosophy as the WI-5306 runtime probe's fail-open).
 */
async function defaultResolveHonorAccount(
  requestedAccount: string,
  workspaceId: string,
): Promise<HonorAccountResolution> {
  let poolIds: string[] | null;
  try {
    const { resolveAccountPool } = await import('../inference-gateway/account-resolver');
    const pool = await resolveAccountPool(workspaceId, 'claude');
    // Exclude the `local` fallback: it means "no registered pool account", which is
    // exactly the state psu's gateway auto/pin route refuses.
    poolIds = pool.filter((a) => a.source !== 'local-fallback').map((a) => a.accountId);
  } catch {
    poolIds = null;
  }
  if (poolIds === null) return { ok: true, account: requestedAccount };
  const ids = poolIds;
  return resolveHonorAccountCore(requestedAccount, {
    listPoolAccountIds: async () => ids,
    probeLocalLogin: () => probeLocalClaudeLogin(),
  });
}

/**
 * P-017 default M17 pool reading (D-045 §3f).
 *
 * SCHEMA TRUTH, stated because the gate's strength depends on it: `AccountPool`
 * is `{ accounts: ClaudeAccount[] }` — there is NO per-account owner field, and
 * no multi-owner pool concept anywhere in this codebase today. A pool is loaded
 * from THIS host's own workspace-scoped configuration (the accounts its owner
 * linked in Settings → Deploy accounts), so a populated pool has exactly one
 * owner by construction and `singleOwner: true` is a fact about the schema, not
 * an assumption about the deployment. If a genuinely multi-owner pool is ever
 * introduced, THIS function is the single place that must learn to say so.
 *
 * What the gate therefore actually catches — both real, neither reachable
 * before this wiring:
 *   - the pool read FAILING while the seat routes through the pool. Today
 *     {@link defaultResolveHonorAccount} swallows that exception and returns the
 *     requested account unchanged, so `--account=auto` survives a pool it could
 *     not read and psu then refuses at boot: a silent dead member, the exact
 *     WI-5316 failure. `null` here fails the honor CLOSED instead, loudly.
 *   - a pool with no real accounts (local-fallback only) still carrying an
 *     `auto` route: there is nothing to attribute a pooled draw to.
 */
async function defaultResolveBillingPool(workspaceId: string): Promise<{ singleOwner: boolean } | null> {
  try {
    const { resolveAccountPool } = await import('../inference-gateway/account-resolver');
    const pool = await resolveAccountPool(workspaceId, 'claude');
    const real = pool.filter((a) => a.source !== 'local-fallback');
    return { singleOwner: real.length > 0 };
  } catch {
    // Unreadable pool ⇒ ownership UNKNOWN ⇒ fail closed (billing-matrix refuses
    // `pool-with-attribution` without a single-owner reading). Never guess.
    return null;
  }
}

/**
 * The default spawner — the launch-from-seats machinery, loaded lazily so the
 * projection layer's import of THIS module stays light (the agent-tools graph
 * only loads when a spawn is actually happening).
 */
/** Exported for tests: the WI-2142501 guard drives this directly to assert the
 *  headless FALLBACK greeting carries `--headless` (spawnHeadless's precondition).
 *  Every heavy dependency below is a lazy `await import`, so a test mocks them
 *  without pulling the console/fleet stack into an ordinary unit run. */
export async function defaultSpawnMembers(req: SpawnMembersRequest): Promise<SpawnMembersResult> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { papercuspPathForWorkspace } = await import('../papercusp-root');
  const { createFleetIfAbsent } = await import('../agent-fleets-store');
  const { buildConsoleEnvelope } = await import('../console-launcher');
  const { spawnConsole, spawnHeadless } = await import('../console-spawn');
  const { memberLaunchCommand, defaultMemberAccountRouting, composeMemberLaunchContext } = await import(
    '../agent-tools/fleet_registry/launch-on-plan'
  );
  // WI-10003468: the backend follows the seat's model family (codex seats launch
  // `--agent=codex`), never a hard-coded non-omp ⇒ claude fallback.
  const memberAgent = await resolveDelegatedSeatAgent(req.launch.model);

  // WI-1408: bootstrap's fleet JOIN fail-softs without a local agent_fleets row
  // and the registry is machine-local — ensure it (idempotent), leader = the
  // requesting owner (their presence federates, so the leadership is real).
  await createFleetIfAbsent({
    workspaceId: req.workspaceId,
    fleetSlug: req.fleetSlug,
    title: req.fleetSlug,
    owner: req.requesterOwnerId,
    leaderOwnerId: req.requesterOwnerId,
  });

  // Compose the member brief under the universal baseline (launch-on-plan's
  // exact flow); a compose failure falls back to no launch-context file.
  let launchContextPath: string | undefined;
  try {
    const composed = composeMemberLaunchContext({
      fleetSlug: req.fleetSlug,
      plan: req.planSlug,
      count: req.count,
      customBriefText: req.launchContext,
    });
    const ctxDir = join(papercuspPathForWorkspace(req.workspaceId), 'launch-context');
    mkdirSync(ctxDir, { recursive: true });
    const ctxPath = join(ctxDir, `fleet-${req.fleetSlug}-delegated-launch-context.md`);
    writeFileSync(ctxPath, composed, 'utf8');
    launchContextPath = ctxPath;
  } catch {
    launchContextPath = undefined;
  }

  // WI-6154: this-host identity (PAPERCUSP_HONO_PORT) must win over an inherited
  // PAPERCUSP_OPERATOR_URL — see resolveSpawnHostOperatorBaseUrl's doc for why.
  const operatorBaseUrl = resolveSpawnHostOperatorBaseUrl();
  const base = await buildConsoleEnvelope({
    workspaceId: req.workspaceId,
    slug: req.potHomeSlug,
    operatorBaseUrl,
    skipMcpJson: true,
  });
  const launchOpts = {
    fleetSlug: req.fleetSlug,
    agent: memberAgent,
    harness: req.potHomeSlug,
    plan: req.planSlug,
    model: req.launch.model,
    // req.launch.account is already RESOLVED against this host's gateway pool at
    // honor time (Gate 4.6 / WI-5316): 'auto' only survives when a pool account
    // exists, else it was downgraded to 'default' or refused. defaultMemberAccountRouting
    // is the empty→'default' safety net (resolution always passes a concrete value).
    account: defaultMemberAccountRouting(req.launch.account ?? undefined),
    seat: req.seatRef,
    launchContext: launchContextPath,
  };
  const command = memberLaunchCommand(launchOpts);
  // WI-2142501: the WI-5211 headless fallback below needs its OWN greeting — the
  // console one is WRONG there, and silently so. spawnHeadless's contract is explicit
  // (SpawnHeadlessOpts.envelope: "greetingCmd MUST be a `psu --headless …` command for
  // the session to stay injectable"), because `--headless` is what makes psu-launcher
  // take the managed-pty host despite non-TTY stdio. Reusing `command` there produced a
  // member with NO managed pty: the kickoff turn could never be injected, the CLI fell
  // through to `--print` with no prompt, and it exited 1 — after the seat had already
  // been consumed. Measured live 2026-09-02 on the physical tower<->VM rig: 2 of 3
  // delegated spawns died exactly this way, and the third only survived because
  // spawnConsole succeeded so this fallback never fired.
  const headlessCommand = memberLaunchCommand({ ...launchOpts, headless: true });
  const consoleResults = await Promise.all(
    Array.from({ length: req.count }, (_v, i) =>
      spawnConsole({
        envelope: { ...base, greetingCmd: command, cwd: base.cwd },
        label: `${req.fleetSlug} · delegated ${i + 1}/${req.count} (${req.requestOfferId})`,
        writeMcpJson: false,
        scheme: null,
        // EI-19330040718883562: this ok/error verdict is CONSUMED (spawn.opened
        // is what makes honorSpawnRequestFromProjection write
        // local_disposition='honored', consuming a delegated seat) — unlike the
        // human-facing "+"/resume callers, a phantom ok here silently strands a
        // seat. Runs under the Promise.all above, so the added latency (up to
        // HEADLESS_BOOT_RECEIPT_MS) is paid once per batch, not once per member —
        // the same tradeoff spawnHeadless below already accepts.
        verifyBootReceipt: true,
      }),
    ),
  );
  // WI-5211: a delegated host is often HEADLESS — a rig VM stuck at the loginwindow,
  // a WSL distro with no display — and spawnConsole hard-fails there ("no X display" /
  // no GUI session), which used to refuse the whole request as spawn_failed even
  // though the member runs fine windowless. Fall back PER MEMBER to spawnHeadless
  // (the same SpawnConsoleResult shape launch-on-plan's headless path uses); the
  // member logs under the workspace's fleet-logs dir instead of opening a window.
  const results = await Promise.all(
    consoleResults.map(async (r, i) => {
      if (r.status === 'ok') return r;
      try {
        return await spawnHeadless({
          // headlessCommand, NOT command — see its definition above. The console
          // greeting has no `--headless`, which leaves the member with no managed pty.
          envelope: { ...base, greetingCmd: headlessCommand, cwd: base.cwd },
          label: `${req.fleetSlug} · delegated ${i + 1}/${req.count} (${req.requestOfferId}, headless-fallback)`,
          logDir: join(papercuspPathForWorkspace(req.workspaceId), 'fleet-logs'),
        });
      } catch {
        return r; // keep the original console failure — it names the real fault
      }
    }),
  );
  let opened = 0;
  let firstError: string | null = null;
  const members: SpawnedMemberHandle[] = [];
  for (const r of results) {
    if (r.status === 'ok') {
      opened += 1;
      members.push({
        taskId: r.taskId ?? null,
        pid: r.pid,
        logPath: r.normalizedLogPath ?? r.logPath ?? null,
      });
    } else if (firstError === null) firstError = r.error;
  }
  return { opened, failed: req.count - opened, firstError, members };
}

/**
 * EI-24635523980082322: stop every member a refusing honor opened. The requester
 * is told `refused`, so a member left running would do work nobody accounted for
 * (and a retry would double it). Kills go through the task ledger — the whole
 * cgroup scope on Linux, the verified process group elsewhere — never by name.
 * A visible-window member has no task row at this seam and is reported, not guessed at.
 */
export async function defaultStopSpawnedMembers(
  members: SpawnedMemberHandle[],
): Promise<StopSpawnedMembersResult> {
  const { killTask } = await import('../task-manager/control');
  let stopped = 0;
  const problems: string[] = [];
  for (const m of members) {
    if (!m.taskId) {
      problems.push(`pid ${m.pid ?? '?'} has no task-ledger row (visible window), so it was not stopped`);
      continue;
    }
    const out = await killTask(m.taskId, { signal: 'SIGTERM', escalateAfterMs: 5_000 });
    const alreadyExited =
      !out.ok &&
      (out.error === 'already_gone' ||
        out.error === 'not_live' ||
        (out.error === 'identity_mismatch' && (out.detail ?? '').includes('is gone')));
    if (out.ok || alreadyExited) stopped += 1;
    else problems.push(`task ${m.taskId}: ${out.error}${out.detail ? ` (${out.detail})` : ''}`);
  }
  const notStopped = members.length - stopped;
  return {
    stopped,
    notStopped,
    detail: `stopped ${stopped}/${members.length} opened member(s)${problems.length ? `; ${problems.join('; ')}` : ''}`,
  };
}

/** Tail of a member's boot log, bounded so a runaway pty log is never read whole. */
export async function defaultReadMemberLogTail(path: string): Promise<string | null> {
  const { open } = await import('node:fs/promises');
  const TAIL_BYTES = 16_384;
  try {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * The projection hook (WI-1940 pattern): evaluate + honor ONE landed
 * spawn-request row. Never throws — the caller is the replication apply path
 * and a spawn hiccup must never unwind a landed write.
 */
export async function honorSpawnRequestFromProjection(
  args: {
    workspaceId: string;
    potHomeSlug: string;
    row: { publisher_github_user_id: number; offer_id: string; record_json: string; fleet_slug: string };
    sql?: Sql;
  },
  deps: DelegatedSpawnHonorDeps = {},
): Promise<DelegatedSpawnHonorOutcome> {
  const hostAccepts = deps.hostAccepts ?? hostAcceptsDelegatedSeats;
  const resolveActor = deps.resolveActor ?? resolveUsageActor;
  const resolveDevicePubkey = deps.resolveDevicePubkey ?? defaultResolveDevicePubkey;
  const listAllotments = deps.listAllotments ?? listResourceAllotments;
  const availabilityForFleet = deps.availabilityForFleet ?? seatAvailabilityForFleet;
  const setDisposition = deps.setDisposition ?? setLocalOfferDispositionForOffer;
  const spawnMembers = deps.spawnMembers ?? defaultSpawnMembers;
  const stopSpawnedMembers = deps.stopSpawnedMembers ?? defaultStopSpawnedMembers;
  const readMemberLogTail = deps.readMemberLogTail ?? defaultReadMemberLogTail;
  const emitReceipt = deps.emitReceipt ?? emitP2pReceipt;
  const readBuildInfo = deps.getBuildInfo ?? getBuildInfo;
  const probeAgentRuntime = deps.probeAgentRuntime ?? defaultProbeAgentRuntime;
  const resolveHonorAccount = deps.resolveHonorAccount ?? defaultResolveHonorAccount;
  const loadSeatPolicy = deps.loadDelegatedSeatPolicy ?? loadDelegatedSeatPolicy;
  const isTrustedUser = deps.isTrustedUser ?? defaultIsTrustedUser;
  const isPotMember = deps.isPotMember ?? defaultIsPotMember;
  const nowMs = deps.nowMs ?? Date.now;
  const verifyLocalMemberBoot = deps.verifyLocalMemberBoot ?? defaultVerifyLocalMemberBoot;

  const record = parseWorkOfferRecordJson(args.row.record_json);
  if (!record) return { outcome: 'skipped', reason: 'unparseable_record' };
  const publisher = args.row.publisher_github_user_id;

  // Gate 1 FIRST and silent: a host that hasn't opted in does no work at all.
  if (!(await hostAccepts())) return { outcome: 'gate_off' };

  const actor = await resolveActor();
  if (!actor) return { outcome: 'skipped', reason: 'no_github_identity' };
  let devicePubkey: string;
  try {
    devicePubkey = await resolveDevicePubkey(actor.githubUserId);
  } catch (e) {
    return { outcome: 'skipped', reason: `device_key_unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  /**
   * One chokepoint for every delegated-spawn receipt. The signed `detail`
   * payload remains backward-compatible while current peers get a bounded
   * loaded-build identity. Failure to resolve build identity degrades to an
   * explicit unknown marker; it must never suppress the receipt itself.
   */
  const emitDelegatedSpawnReceipt = (receipt: Parameters<typeof emitP2pReceipt>[0]) => {
    let build: BuildInfo;
    try {
      build = readBuildInfo();
    } catch {
      build = { sha: null, version: 'unknown' };
    }
    return emitReceipt({
      ...receipt,
      detail: appendResponderBuildMarker(receipt.detail ?? receipt.refusal?.detail ?? '', build),
    });
  };

  const allotments = await listAllotments(
    { workspaceId: args.workspaceId, fleetSlug: args.row.fleet_slug },
    args.sql as OrgSql | undefined,
  );
  const slots = allotments.map(slotFromAllotment).filter((s): s is SeatSlot => s != null);

  // P-003: pot-scoped candidates. A spawn_request names only a targetOfferId,
  // never which pot the matching seat-offer was donated to — pull this host's
  // whole allotment board (workspace-bounded, small) and offer every active
  // pot-scoped agent_slot row as a Gate-2 match candidate.
  const wholeBoard = await listAllotments({ workspaceId: args.workspaceId }, args.sql as OrgSql | undefined);
  const potSlots: PotSeatCandidate[] = [];
  for (const a of wholeBoard) {
    if (a.potSlug == null || a.audience == null) continue;
    const slot = slotFromAllotment(a);
    if (slot) potSlots.push({ slot, potSlug: a.potSlug, audience: a.audience });
  }

  const evaluated = evaluateSpawnRequestTarget({
    record,
    selfGithubUserId: actor.githubUserId,
    selfDevicePubkey: devicePubkey,
    slots,
    potSlots,
    nowMs: nowMs(),
    honorWindowMs: deps.honorWindowMs,
  });

  const refuse = async (code: string, detail: string, disposition: string): Promise<DelegatedSpawnHonorOutcome> => {
    const claimed = await setDisposition(
      args.workspaceId,
      args.potHomeSlug,
      publisher,
      args.row.offer_id,
      disposition,
      undefined,
      args.sql,
    );
    if (!claimed) return { outcome: 'already_claimed' };
    await emitDelegatedSpawnReceipt({
      workspaceId: args.workspaceId,
      potSlug: args.potHomeSlug,
      kind: 'refusal',
      offerId: args.row.offer_id,
      action: 'delegated-seat:spawn',
      refusal: { code, detail },
      requester: {
        kind: 'session',
        ref: record.spawnRequest?.requesterOwnerId ?? null,
        githubUserId: publisher,
      },
      responderGithubUserId: actor.githubUserId,
      responderDevicePubkey: devicePubkey,
      actor: 'delegated-spawn-honor',
    });
    return { outcome: 'refused', code };
  };

  if (!evaluated.ok) {
    if (evaluated.disposition === null) return { outcome: 'skipped', reason: evaluated.code };
    return refuse(evaluated.code, evaluated.detail, evaluated.disposition);
  }
  const { slot, payload, potMatch } = evaluated;

  // Gate 2.5/3.5 (P-003): the audience gate — ONLY when Gate 2 matched a
  // POT-scoped offer (potMatch set); a fleet-scoped match carries no audience
  // concept (D-002) and skips straight through. The subject is the REQUESTING
  // fleet's owner — the spawn_request's publisher (`publisher`, already
  // resolved above), never the honoring host's own identity. Fail-closed +
  // LOUD refusal so a trust revocation takes effect on the very next claim
  // with no offer republish (D-002/D-003).
  if (potMatch) {
    const passes =
      potMatch.audience === 'trusted-members'
        ? await isTrustedUser(args.workspaceId, publisher)
        : await isPotMember(args.workspaceId, potMatch.potSlug, publisher);
    if (!passes) {
      return refuse(
        'audience_refused',
        `requester (github ${publisher}) does not satisfy pot '${potMatch.potSlug}'s audience ` +
          `'${potMatch.audience}' on this host — ` +
          (potMatch.audience === 'trusted-members'
            ? 'not on this host\'s local trust list.'
            : 'not a member of the pot.'),
        'refused:audience_refused',
      );
    }
  }

  // Gate 4: cap pre-check (consumeSeatAtBoot re-enforces atomically at boot).
  const availability = await availabilityForFleet(
    { workspaceId: args.workspaceId, fleetSlug: args.row.fleet_slug },
    args.sql as OrgSql | undefined,
  );
  const resolution = resolveSeatLaunch({ availability, count: payload.count, seatRef: slot.ref });
  if (!resolution.ok) {
    return refuse(resolution.refusal.code, resolution.refusal.detail, `refused:${resolution.refusal.code}`);
  }

  // Gate 4.5 (WI-5306): can this host actually RUN the member? spawnConsole
  // 'ok' means a terminal WINDOW opened, not that the agent booted — a host
  // missing the seat's agent CLI (`claude`/`omp`) silently reports it opened
  // while zero members run. Preflight the runtime and refuse LOUDLY (a
  // federated receipt) instead of claiming + phantom-spawning. Refused straight
  // from the null disposition, so no 'honoring' claim is left dangling. Model
  // resolved from the matched slot, so it targets the RIGHT CLI (claude / omp /
  // codex — resolveDelegatedSeatAgent, WI-10003468).
  const runtime = await probeAgentRuntime(resolution.launch.model);
  if (!runtime.resolved) {
    return refuse('agent_runtime_missing', runtime.detail, 'refused:agent_runtime_missing');
  }

  // Gate 4.6 (WI-5316): resolve the seat's --account against THIS host's gateway
  // pool. A seat authored AUTO becomes --account=auto, which psu refuses on a host
  // with an empty pool (silent dead member, sibling of WI-5306). The honoring host
  // is authoritative: downgrade auto→default when the pool is empty but a local
  // login exists, or refuse LOUDLY (federated receipt) when genuinely unfulfillable
  // (empty pool + no login, or a pin this host lacks). Refused from the null
  // disposition, so no 'honoring' claim dangles.
  const acct = await resolveHonorAccount(resolution.launch.account, args.workspaceId);
  if (!acct.ok) {
    return refuse(acct.code, acct.detail, `refused:${acct.code}`);
  }
  if (acct.note) {
    console.log(`[delegated-spawn-honor] ${args.row.offer_id}: ${acct.note}`);
  }
  const resolvedLaunch = { ...resolution.launch, account: acct.account };

  // Gate 4.7 (P-516/F5): delegated seats are explicitly trusted host-agent
  // delegation. Host-owned allowlists and ceilings are checked before the
  // atomic claim; untrusted public execution must use the separate OS sandbox.
  const loadedPolicy = loadSeatPolicy();
  if (!loadedPolicy.ok) return refuse(loadedPolicy.code, loadedPolicy.detail, `refused:${loadedPolicy.code}`);
  const credentialRoute = resolvedLaunch.account === 'auto' ? 'auto' : resolvedLaunch.account === 'default' ? 'default' : 'pinned';
  const policy = evaluateDelegatedSeatPolicy({
    policy: loadedPolicy.policy,
    workspaceId: args.workspaceId,
    credentialRoute,
    requestedSeats: payload.count,
    activeSeats: resolution.slot.consumed,
    requestedAtMs: payload.requestedAtMs,
    nowMs: nowMs(),
  });
  if (!policy.ok) return refuse(policy.code, policy.detail, `refused:${policy.code}`);

  // Gate 4.8 (P-017 / D-045 §3f): BYOC control plane. This host is about to run
  // a remote fleet's members on ITS OWN credentials and seats — the definition
  // of a BYOC execution — so the offer-budget / inference-lease / billing legs
  // run BEFORE the atomic claim, from the null disposition, exactly like the
  // gates above (no 'honoring' claim is left dangling on a refusal).
  //
  // prepareByocExecution is the CHOKEPOINT, not a formality: it resolves the X7
  // billing authority (M17 single-owner pools for a pool-routed seat, D-009 no
  // v1 relay), revalidates an inference lease when one is carried, and RESERVES
  // the requested seats against the axis ledger under the H11 per-call clamp. A
  // refusal from any of those legs aborts the spawn.
  const billingMode = byocBillingModeForRoute(credentialRoute);
  const resolveBillingPool = deps.resolveBillingPool ?? defaultResolveBillingPool;
  const billingPool = billingMode === 'pool-with-attribution' ? await resolveBillingPool(args.workspaceId) : null;
  const byocContext: ByocExecutionContext = {
    // This host's stable metering identity. The device pubkey is what every
    // federated receipt on this path already signs as `responderDevicePubkey`,
    // so the spend meter keys on the SAME host identity the requester sees.
    hostRef: devicePubkey,
    fleetSlug: args.row.fleet_slug,
    // 'local': the honoring host executes on its own machine and credentials.
    axis: 'local',
    unit: 'slots',
    billedAmount: payload.count,
    reservationId: args.row.offer_id,
    billingMode,
    billingContext: { pool: billingPool },
    // Delegated seats carry no InferenceLease today, so the lease leg stays
    // dormant here by DATA, not by omission — prepareByocExecution revalidates
    // it the moment a lease is present on this context.
    attestedUserId: payload.requesterOwnerId,
    perUserContributionCap: null,
  };
  const byocBudget: LedgerState = createByocBudget(
    byocSeatAxisCap(resolution.slot.available, loadedPolicy.policy.maxConcurrentSeats),
  );
  const prepared = prepareByocExecution({ budget: byocBudget, context: byocContext });
  if (!prepared.ok) {
    return refuse(prepared.code, prepared.detail, `refused:${prepared.code}`);
  }

  // Gate 5: the atomic claim — exactly one hook invocation spawns.
  const claimed = await setDisposition(
    args.workspaceId,
    args.potHomeSlug,
    publisher,
    args.row.offer_id,
    'honoring',
    undefined,
    args.sql,
  );
  if (!claimed) return { outcome: 'already_claimed' };

  // Snapshot BEFORE spawning so the first-turn check below can never mistake a
  // pre-existing fleet member for the one this request launched.
  const honorStartedAtMs = nowMs();

  let spawn: SpawnMembersResult;
  try {
    spawn = await spawnMembers({
      workspaceId: args.workspaceId,
      potHomeSlug: args.potHomeSlug,
      fleetSlug: args.row.fleet_slug,
      planSlug: payload.planSlug,
      count: payload.count,
      seatRef: slot.ref,
      launch: resolvedLaunch,
      launchContext: payload.launchContext,
      requesterOwnerId: payload.requesterOwnerId,
      requestOfferId: args.row.offer_id,
    });
  } catch (e) {
    spawn = { opened: 0, failed: payload.count, firstError: e instanceof Error ? e.message : String(e) };
  }

  if (spawn.opened === 0) {
    // EI-19331694139523035: ATTRIBUTE the failure instead of reporting a bare
    // `spawn_failed`. When the member's own boot log carries an auth signature
    // (the boot-receipt scan folds it into firstError), this is an ACCOUNT
    // failure — refuse with the code the requester can act on, and name the
    // auto→default substitution when one was made. A boot death that merely
    // FOLLOWED a substitution is not reported as an account failure; it stays
    // spawn_failed with the substitution named as the prime suspect.
    const failure = classifyHonorSpawnFailure({
      count: payload.count,
      firstError: spawn.firstError,
      resolved: acct,
    });
    await setDisposition(
      args.workspaceId,
      args.potHomeSlug,
      publisher,
      args.row.offer_id,
      `refused:${failure.code}`,
      { expect: 'honoring' },
      args.sql,
    );
    await emitDelegatedSpawnReceipt({
      workspaceId: args.workspaceId,
      potSlug: args.potHomeSlug,
      kind: 'refusal',
      offerId: args.row.offer_id,
      action: 'delegated-seat:spawn',
      refusal: {
        code: failure.code,
        detail: failure.detail,
      },
      requester: { kind: 'session', ref: payload.requesterOwnerId, githubUserId: publisher },
      responderGithubUserId: actor.githubUserId,
      responderDevicePubkey: devicePubkey,
      actor: 'delegated-spawn-honor',
    });
    return { outcome: 'refused', code: failure.code };
  }

  // D-029 / WI-35786: `opened > 0` and even a fresh coord_presence row are not
  // proof that an agent took a turn. The macOS login-window failure produced both
  // while no CLI process or transcript ever existed. Require a fresh attributed
  // tool call on EVERY platform before publishing success.
  const bootVerify = await verifyLocalMemberBoot({
    workspaceId: args.workspaceId,
    fleetSlug: args.row.fleet_slug,
    sinceMs: honorStartedAtMs,
  });
  if (!bootVerify.observed) {
    // EI-20348412988546055: a CLI can open/register and then exit ZERO after
    // printing an auth failure. In that case spawn.opened===1, so the earlier
    // zero-open classifier never runs. Classify the observed transcript turn;
    // only an explicit auth signature upgrades the generic fail-closed result.
    // EI-24635529006243850: a CLI whose first API call 401s may never write a
    // transcript, leaving failureDetail empty while the member's own boot log
    // names the cause — fall back to that log's auth line before choosing the code.
    let failureEvidence = bootVerify.failureDetail ?? null;
    if (!failureEvidence) {
      for (const m of spawn.members ?? []) {
        const tail = m.logPath ? await readMemberLogTail(m.logPath) : null;
        const excerpt = tail ? extractAuthFailureExcerpt(tail) : null;
        if (excerpt) {
          failureEvidence = excerpt;
          break;
        }
      }
    }
    const postSpawnFailure = failureEvidence
      ? classifyHonorSpawnFailure({
          count: payload.count,
          firstError: failureEvidence,
          resolved: acct,
        })
      : null;
    const attributedAuthFailure = postSpawnFailure?.code === 'account_unfulfillable' ? postSpawnFailure : null;
    const code = attributedAuthFailure?.code ?? 'member_boot_unconfirmed';
    // EI-24635523980082322: the requester is about to be told `refused`, so the
    // members this honor opened must not keep running. Stop them BEFORE the
    // refusal federates, and say in the receipt whether that worked.
    const stop: StopSpawnedMembersResult = spawn.members
      ? await stopSpawnedMembers(spawn.members).catch((e: unknown) => ({
          stopped: 0,
          notStopped: spawn.members?.length ?? spawn.opened,
          detail: `stopping opened member(s) failed: ${e instanceof Error ? e.message : String(e)}`,
        }))
      : {
          stopped: 0,
          notStopped: spawn.opened,
          detail: `the spawner returned no member handles, so ${spawn.opened} opened member(s) were NOT stopped`,
        };
    if (stop.notStopped > 0) {
      console.warn(`[delegated-spawn-honor] ${args.row.offer_id}: refusing ${code} — ${stop.detail}`);
    }
    await setDisposition(
      args.workspaceId,
      args.potHomeSlug,
      publisher,
      args.row.offer_id,
      `refused:${code}`,
      { expect: 'honoring' },
      args.sql,
    );
    await emitDelegatedSpawnReceipt({
      workspaceId: args.workspaceId,
      potSlug: args.potHomeSlug,
      kind: 'refusal',
      offerId: args.row.offer_id,
      action: 'delegated-seat:spawn',
      refusal: {
        code,
        detail:
          (attributedAuthFailure
            ? `${attributedAuthFailure.detail} First-turn verification also reported: ${bootVerify.detail}`
            : `spawn opened ${spawn.opened}/${payload.count} member target(s), but no first agent turn was proven: ` +
              bootVerify.detail) + ` Member cleanup: ${stop.detail}.`,
      },
      requester: { kind: 'session', ref: payload.requesterOwnerId, githubUserId: publisher },
      responderGithubUserId: actor.githubUserId,
      responderDevicePubkey: devicePubkey,
      actor: 'delegated-spawn-honor',
    });
    return { outcome: 'refused', code };
  }

  // P-017 SETTLEMENT (D-045 §3f). The reservation was opened at the REQUESTED
  // count; commit it at what actually booted, so a partial honor draws only the
  // seats it really consumed (`commit`'s `actualAmount` clamp) and the metering
  // leg records that same number as the host's spend plus the requester's
  // attributed contribution. Deliberately AFTER the boot check: seats that
  // never ran a turn must not be metered.
  //
  // A settlement refusal is LOGGED, never a refusal outcome — the members are
  // already live and un-spawning them is not on the table. `committedSeats:
  // null` on the outcome is how a caller tells "not metered" from "metered 0".
  const settled = settleByocExecution({
    budget: prepared.ledger,
    metering: emptyMeteringLedger(),
    context: byocContext,
    actualAmount: spawn.opened,
  });
  if (!settled.ok) {
    console.log(
      `[delegated-spawn-honor] ${args.row.offer_id}: BYOC settlement refused (${settled.code}): ${settled.detail} ` +
        `— ${spawn.opened} member(s) are already live, so the honor stands unmetered.`,
    );
  }
  const committedSeats = settled.ok ? settled.committedAmount : null;

  await setDisposition(
    args.workspaceId,
    args.potHomeSlug,
    publisher,
    args.row.offer_id,
    'honored',
    { expect: 'honoring' },
    args.sql,
  );

  // EI-19333624101736074: FEDERATE the success. `local_disposition` above is
  // deliberately host-local and never crosses the wire (projections/
  // work-offers.ts:22,330), so without this receipt the requester's evidence
  // for a completed honor is identical to its evidence for a request nobody
  // picked up — measured live tower->Win rig 2026-08-02, and the ambiguity
  // alone cost two wakes. The receipt is the ONE channel proven to cross.
  //
  // It names the ACCOUNT the seat actually ran under, including any auto→default
  // downgrade this host applied (Gate 4.6), because "honored, but on which
  // account?" is the first question asked when the member then dies at boot —
  // and answering it currently requires shelling into the honoring host.
  const partial = spawn.failed > 0 ? `, ${spawn.failed} FAILED to open` : '';
  const bootNote = `. Local first-turn check CONFIRMED the agent ran (${bootVerify.detail}).`;
  // P-017: the requester's only federated view of what this honor actually
  // DREW. `local_disposition` never crosses the wire, so without this the
  // metered draw would be invisible to the side being billed for it.
  const meterNote = settled.ok
    ? ` Metered ${settled.committedAmount} seat(s) on axis 'local' under billing mode '${billingMode}'` +
      (settled.contributionCredited > 0 ? `, ${settled.contributionCredited} credited to '${payload.requesterOwnerId}'` : '') +
      '.'
    : ` NOT metered: BYOC settlement refused (${settled.code}).`;
  await emitDelegatedSpawnReceipt({
    workspaceId: args.workspaceId,
    potSlug: args.potHomeSlug,
    kind: 'honored',
    offerId: args.row.offer_id,
    action: 'delegated-seat:spawn',
    detail:
      `honored: opened ${spawn.opened}/${payload.count} member(s)${partial} for fleet ` +
      `'${args.row.fleet_slug}' on seat '${slot.ref}' with account='${acct.account}'` +
      (acct.note ? ` (${acct.note})` : '') +
      bootNote +
      meterNote,
    requester: { kind: 'session', ref: payload.requesterOwnerId, githubUserId: publisher },
    responderGithubUserId: actor.githubUserId,
    responderDevicePubkey: devicePubkey,
    actor: 'delegated-spawn-honor',
  });

  return { outcome: 'honored', opened: spawn.opened, failed: spawn.failed, committedSeats };
}
