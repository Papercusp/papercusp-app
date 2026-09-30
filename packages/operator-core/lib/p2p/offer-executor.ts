/**
 * p2p/offer-executor.ts — P-104 LOCAL-AUTHORITY SPAWN (D-001)
 * (p2p-work-distribution-2026-07-02).
 *
 * A claimed work-offer is launched by the HOST SUPERVISOR — never the remote
 * peer. The requester steers only via the coord plane (send / receipts / wake);
 * nothing here is reachable as an MCP tool, so a remote session structurally
 * CANNOT invoke a spawn — the host's own supervisor calls this after it pulled
 * and claimed an offer (P-103 standing puller → P-202 claim gate → HERE).
 *
 * The execute pipeline, every step fail-closed with a P-004 receipt on refusal:
 *   (a) H9 EPOCH FENCE — the claim's stamped grantor epoch must equal the
 *       grantor's CURRENT epoch (revocation bumps it, grant-store H7/X6); a
 *       stale claim is refused, never launched. Fail-closed in BOTH directions
 *       (a future epoch is as unlaunchable as a past one).
 *   (b) D-007 CLAIM AUTHORITY re-check (evaluateClaimAuthority) — POLICY ×
 *       PHYSICS headroom at spawn time; leases advise, the gate decides.
 *   (c) PROVISION — ONE provisionForeignClone call (it registers the mig-467
 *       row itself: Q1 root invariant, X4 --no-local private ODB, base-sha
 *       anchor). The stamped epoch persists on the row as execution_epoch.
 *   (d) C2 CAPABILITY ENVELOPE — the v1 'foreign-session' profile is applied
 *       BEFORE launch (capability-envelope-overrides machinery); an envelope
 *       failure parks the row — a foreign session never runs unclamped.
 *   (e) LAUNCH via the injected host-supervisor seam, with the M14
 *       fleet-scoped presence label; then bindForeignSession flips the row
 *       provisioning→active. A bind race (row reaped mid-spawn) refuses — the
 *       foreign-guard fail-closes the orphan session because its row is not
 *       'active'.
 *   (f) H11 LEDGERS — buildClaimLedgers seeds per-axis P-107 reservation
 *       ledgers from the granted effective caps; every model call the foreign
 *       session makes reserves against them.
 *
 * Production wiring note: `launchSession`, `applyCapabilityEnvelope`,
 * `currentGrantorEpoch` (grant-store epoch read) and `hostAvailability`
 * (P-201 allotments − P-205 spend × live headroom) are REQUIRED injections —
 * there is deliberately no default for them (a defaulted epoch or headroom
 * would be fail-open). The PG store fns default to the real store.
 */
import type { ForeignWorkspace } from './foreign-workspaces';
import { bindForeignSession, setForeignWorkspaceState } from './foreign-workspaces';
import { provisionForeignClone } from './foreign-clone';
import type { BudgetAxis, LedgerState, WorkOffer } from './offer-budget';
import {
  buildClaimLedgers,
  claimRefusalToReceiptFields,
  evaluateClaimAuthority,
  type HostAvailability,
} from './claim-authority';
import { emitP2pReceipt } from './receipts';
import { resolveP2pGrantWorkspace } from './grant-store';
import { ensureForeignGitSyncRoutine } from '../harness/routines/foreign-git-sync-action';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

/** M14: the fleet-scoped presence label a foreign session carries, so hosts
 *  and peers can tell foreign work from native sessions at a glance. */
export function foreignPresenceLabel(fleetSlug: string, offerId: string): string {
  return `foreign:${fleetSlug}:${offerId}`;
}

/** What the host-supervisor launch seam receives (D-001: the seam IS the
 *  supervisor — tests stub it; production binds the fleet/psu spawn path). */
export interface ForeignLaunchSpec {
  offer: WorkOffer;
  workspace: ForeignWorkspace;
  clonePath: string;
  /** M14 fleet-scoped presence label (foreignPresenceLabel). */
  presenceLabel: string;
  /** C2: the capability role the envelope was applied under. */
  sessionRole: 'foreign-session';
}

/** Injectable ports. The four REQUIRED fields have no safe default (fail-open
 *  risk); the store/receipt fns default to the real PG-backed implementations. */
export interface OfferExecutorDeps {
  /** H9: the grantor's CURRENT epoch (grant-store; revocation bumps it). */
  currentGrantorEpoch: (grantorGithubUserId: number) => Promise<number>;
  /** D-007 host availability snapshot for this offer's fleet (policy × physics). */
  hostAvailability: (offer: WorkOffer) => Promise<HostAvailability>;
  /** C2: apply the v1 foreign-session capability profile. Throw = refuse. */
  applyCapabilityEnvelope: (spec: {
    sessionRole: 'foreign-session';
    offerId: string;
    workspaceId: string;
    fleetSlug: string;
  }) => Promise<void>;
  /** D-001: the HOST supervisor spawn. Returns the local session id. */
  launchSession: (spec: ForeignLaunchSpec) => Promise<{ sessionId: string }>;
  provisionForeignClone?: typeof provisionForeignClone;
  bindForeignSession?: typeof bindForeignSession;
  setForeignWorkspaceState?: typeof setForeignWorkspaceState;
  emitP2pReceipt?: typeof emitP2pReceipt;
  /**
   * WI-5327 follow-up: seed this workspace's `system:foreign-git-sync` routine
   * (foreign-git-sync-action.ts) the moment a foreign workspace first exists —
   * per that file's own module doc, seeding belongs HERE (registerForeignWorkspace's
   * consumer, P-104 spawn), never a blanket boot-time seed, so the lane activates
   * exactly when foreign work exists (P-005). Best-effort: a seeding failure must
   * NEVER block or refuse the spawn — logged and swallowed, same posture as
   * ensure-host-routines.ts's boot-time seeding.
   */
  ensureForeignGitSyncRoutine?: typeof ensureForeignGitSyncRoutine;
}

export interface ExecuteClaimedOfferArgs {
  offer: WorkOffer;
  /** X9 numeric origin identity (the offer's publisher peer). */
  originGithubUserId: number;
  /** H9: the grantor epoch stamped on the claim at admission time. */
  stampedGrantorEpoch: number;
  /** The caller's RESOLVED identity workspace (C3; 'default' refused). */
  workspaceId: string | null | undefined;
  potSlug: string;
  /** This host's grantor user — the epoch fence subject AND receipt author. */
  responderGithubUserId: number;
  responderDevicePubkey?: string | null;
  executorDevice: string;
  /** The host repo to clone FROM (canonical tree or bare mirror). */
  sourceRepoPath: string;
  /** The Q1 quota-subtree root; the clone lands at <root>/repo. */
  rootPath: string;
  branch?: string;
  /** Q1 invariant scope passthrough (tests inject; prod defaults from env). */
  workspaceRoot?: string;
  canonicalTree?: string;
  /** Audit actor label; defaults to 'p2p:offer-executor'. */
  actor?: string;
}

export type ExecuteOutcome =
  | {
      ok: true;
      workspace: ForeignWorkspace;
      sessionId: string;
      clonePath: string;
      presenceLabel: string;
      /** H11 per-axis reservation ledgers seeded from the claim grants. */
      ledgers: Partial<Record<BudgetAxis, LedgerState>>;
      receiptsEmitted: number;
      receiptFailures: number;
    }
  | {
      ok: false;
      refusal: { code: string; detail: string };
      receiptsEmitted: number;
      receiptFailures: number;
    };

/**
 * Execute one CLAIMED offer on this host: fence → gate → provision → clamp →
 * launch → bind → ledgers. Never throws on runtime data; every refusal is
 * typed, receipted (P-004, M21 offer-id threaded), and — once a registry row
 * exists — parked with the reason (loud breadcrumb, never silent-deleted).
 */
export async function executeClaimedOffer(
  args: ExecuteClaimedOfferArgs,
  deps: OfferExecutorDeps,
): Promise<ExecuteOutcome> {
  const provision = deps.provisionForeignClone ?? provisionForeignClone;
  const bind = deps.bindForeignSession ?? bindForeignSession;
  const setState = deps.setForeignWorkspaceState ?? setForeignWorkspaceState;
  const emit = deps.emitP2pReceipt ?? emitP2pReceipt;

  let receiptsEmitted = 0;
  let receiptFailures = 0;
  const refuse = (code: string, detail: string): ExecuteOutcome => ({
    ok: false,
    refusal: { code, detail },
    receiptsEmitted,
    receiptFailures,
  });

  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) {
    return refuse(
      'workspace_unresolved',
      "offer execute refused: unresolvable workspace partition (WI-1564) — a spawn recorded under 'default' never federates its receipts.",
    );
  }
  const hive = args.potSlug?.trim();
  if (!hive) return refuse('hive_required', 'offer execution is hive-scoped; pass the hive HOME slug.');

  const receipt = async (fields: {
    action: string;
    refusal: { code: string; detail: string };
    budgetAxis?: string | null;
  }): Promise<void> => {
    try {
      const r = await emit({
        workspaceId: ws,
        potSlug: hive,
        kind: 'refusal',
        offerId: args.offer.offerId,
        action: fields.action,
        refusal: fields.refusal,
        budgetAxis: fields.budgetAxis ?? null,
        requester: { ref: args.offer.publisherRef, githubUserId: args.originGithubUserId },
        responderGithubUserId: args.responderGithubUserId,
        responderDevicePubkey: args.responderDevicePubkey ?? null,
        actor: args.actor ?? 'p2p:offer-executor',
      });
      if (r.ok) receiptsEmitted += 1;
      else receiptFailures += 1;
    } catch {
      receiptFailures += 1;
    }
  };

  // (a) H9 epoch fence — before any IO beyond the epoch read itself.
  const currentEpoch = await deps.currentGrantorEpoch(args.responderGithubUserId);
  if (currentEpoch !== args.stampedGrantorEpoch) {
    const detail =
      `claim stamped at grantor epoch ${args.stampedGrantorEpoch} but the grantor is at epoch ` +
      `${currentEpoch} — the grant set changed since claim admission (H9: re-claim under the current epoch)`;
    await receipt({ action: 'work-offer:spawn', refusal: { code: 'stale-epoch', detail } });
    return refuse('stale-epoch', detail);
  }

  // (b) D-007 claim-authority re-check at spawn time (leases advise, the gate decides).
  const auth = evaluateClaimAuthority(args.offer, await deps.hostAvailability(args.offer));
  if (!auth.ok) {
    for (const r of auth.refusals) {
      const f = claimRefusalToReceiptFields(r);
      await receipt({ action: f.action, refusal: f.refusal, budgetAxis: f.budgetAxis });
    }
    return refuse(auth.refusals[0]!.code, auth.refusals.map((r) => r.detail).join('; '));
  }

  // (c) Provision — registers the registry row internally (Q1/X4; failures park it).
  const prov = await provision({
    sourceRepoPath: args.sourceRepoPath,
    workspaceId: ws,
    offerId: args.offer.offerId,
    fleetSlug: args.offer.fleetSlug,
    originGithubUserId: args.originGithubUserId,
    executorDevice: args.executorDevice,
    rootPath: args.rootPath,
    branch: args.branch,
    executionEpoch: args.stampedGrantorEpoch,
    workspaceRoot: args.workspaceRoot,
    canonicalTree: args.canonicalTree,
  });
  if (!prov.ok) {
    await receipt({ action: 'work-offer:spawn', refusal: prov.refusal });
    return refuse(prov.refusal.code, prov.refusal.detail);
  }

  // (c2) WI-5327 follow-up: seed the foreign-git-sync routine now that a
  // foreign workspace genuinely exists (foreign-git-sync-action.ts's own
  // seeding contract — activation gated by the real surface, P-005). Never
  // fabricated: installSlug is the SAME operator-home convention every other
  // host-wide singleton routine uses (ensure-host-routines.ts). Best-effort —
  // a seeding failure must never block or refuse a spawn that already
  // provisioned successfully.
  try {
    const seedRoutine = deps.ensureForeignGitSyncRoutine ?? ensureForeignGitSyncRoutine;
    await seedRoutine({ workspaceId: ws, installSlug: operatorHomeHarnessSlug() });
  } catch (e) {
    console.log(
      `[offer-executor] foreign-git-sync routine seed failed for offer ${args.offer.offerId} ` +
        `(non-fatal, spawn continues): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const park = (reason: string) =>
    setState(ws, args.offer.offerId, 'parked', {
      parkReason: reason,
      fromStates: ['provisioning', 'active'],
    }).catch(() => null);

  // (d) C2 capability envelope — BEFORE launch; a foreign session never runs unclamped.
  try {
    await deps.applyCapabilityEnvelope({
      sessionRole: 'foreign-session',
      offerId: args.offer.offerId,
      workspaceId: ws,
      fleetSlug: args.offer.fleetSlug,
    });
  } catch (e) {
    const detail = `capability envelope failed for offer ${args.offer.offerId}: ${e instanceof Error ? e.message : String(e)}`;
    await park(`capability-envelope-failed: ${detail}`);
    await receipt({ action: 'work-offer:spawn', refusal: { code: 'capability-envelope-failed', detail } });
    return refuse('capability-envelope-failed', detail);
  }

  // (e) Launch via the host supervisor, then bind provisioning→active.
  const presenceLabel = foreignPresenceLabel(args.offer.fleetSlug, args.offer.offerId);
  let sessionId: string;
  try {
    ({ sessionId } = await deps.launchSession({
      offer: args.offer,
      workspace: prov.workspace,
      clonePath: prov.clonePath,
      presenceLabel,
      sessionRole: 'foreign-session',
    }));
  } catch (e) {
    const detail = `host supervisor launch failed for offer ${args.offer.offerId}: ${e instanceof Error ? e.message : String(e)}`;
    await park(`launch-failed: ${detail}`);
    await receipt({ action: 'work-offer:spawn', refusal: { code: 'launch-failed', detail } });
    return refuse('launch-failed', detail);
  }

  const bound = await bind(ws, args.offer.offerId, sessionId);
  if (!bound) {
    // The row raced to a terminal state (e.g. reaped mid-spawn). The launched
    // session is fail-closed by the foreign-guard (its row is not 'active').
    const detail =
      `bind refused for offer ${args.offer.offerId}: registry row left the launchable states mid-spawn ` +
      `(raced by a reap/park) — the spawned session is fail-closed by the guard`;
    await receipt({ action: 'work-offer:spawn', refusal: { code: 'bind-race', detail } });
    return refuse('bind-race', detail);
  }

  // (f) H11: per-axis reservation ledgers from the granted effective caps.
  const ledgers = buildClaimLedgers(auth.grants);

  return {
    ok: true,
    workspace: bound,
    sessionId,
    clonePath: prov.clonePath,
    presenceLabel,
    ledgers,
    receiptsEmitted,
    receiptFailures,
  };
}
