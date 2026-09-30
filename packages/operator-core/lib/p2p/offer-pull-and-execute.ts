/**
 * p2p/offer-pull-and-execute.ts — WI-3629 puller-boundary caller (the
 * integration seam separated out of WI-1937 per leader scope ruling, msg
 * mre7x47s 2026-07-09).
 *
 * `standing-puller.evaluatePull` is a PURE decision core (no IO, H17) and
 * `offer-executor.executeClaimedOffer` is the P-104 local-authority spawn
 * pipeline — nothing in this codebase actually called the second from the
 * first until this file. This is that seam: evaluate one offer pull, and on
 * a WON claim/steal, assemble a full production `OfferExecutorDeps` and
 * execute it. A SKIP is a normal, loud outcome (D-004) — never an error, and
 * never anything this seam executes.
 *
 * EPOCH NOTE (do not conflate the two clocks): `evaluatePull`'s returned
 * `PullClaim.epoch` is the OFFER's X6 AUTHORSHIP epoch (the publisher-set
 * owner's high-water — verifies the device→user→publisher-set→owner chain
 * signed the offer). `executeClaimedOffer`'s H9 fence is a COMPLETELY
 * DIFFERENT clock: THIS HOST's own p2p_grantor_epochs row for
 * `ctx.responderGithubUserId` (the host's identity AS GRANTOR of capability
 * to the offer's origin — grant-store.ts's `currentGrantorEpoch`). This
 * function reads that host-grantor epoch fresh, right here, at the moment a
 * claim is WON (the "stamped at admission" baseline) — `executeClaimedOffer`
 * re-reads it again at spawn time via the SAME injected port and refuses if
 * it moved in between (a revocation raced the claim). A decision that was
 * only EVALUATED, never WON, must never spend this read.
 *
 * PRODUCTION WIRING: `productionOfferExecutorDeps` composes all FOUR
 * `OfferExecutorDeps` ports — `currentGrantorEpoch` (grant-store.ts) and
 * `hostAvailability` (host-availability.ts, WI-3590 note: PHYSICS headroom
 * is deliberately fail-closed to 0 today — see that module's doc — so this
 * seam is already correctly wired even though every claim it admits is
 * currently refused by design until WI-3590 lands real headroom) plus the
 * two WI-1937 ports via `foreignSessionExecutorDeps()`. `depsOverride` lets a
 * test (or a future dry-run caller) replace any subset without re-deriving
 * the wiring.
 *
 * This module still does NOT include the raw offer-payload INTAKE loop (the
 * P-016 supervisor-owned standing-claim runner that decodes wire payloads via
 * `parseOfferPayload`, resolves the rest of `PullEvaluationInput` off PG/the
 * P-002 settings store, and ticks on a schedule) — that IO edge is a
 * SEPARATE, larger piece of host-supervisor wiring the item's own doc
 * comment attributes to "the receiver's IO layer" and is not itself part of
 * WI-3629's scope (the puller-boundary CALLER seam). This file is the thing
 * that edge will call once built.
 */
import { evaluatePull, type PullClaim, type PullEvaluationInput, type PullSkip } from './standing-puller';
import { executeClaimedOffer, type ExecuteOutcome, type OfferExecutorDeps } from './offer-executor';
import { foreignSessionExecutorDeps } from './offer-executor-prod-deps';
import { currentGrantorEpoch } from './grant-store';
import { hostAvailability as buildHostAvailability } from './host-availability';
import type { WorkOffer } from './offer-budget';

/** Everything `ExecuteClaimedOfferArgs` needs that is NOT derivable from the
 *  offer/claim itself — i.e. this HOST's own configuration + identity. */
export interface PullAndExecuteContext {
  /** C3: the caller's resolved identity workspace ('default' refused upstream). */
  workspaceId: string | null | undefined;
  /** The hive/pot HOME slug this offer executes under. */
  potSlug: string;
  /** THIS host's own grantor identity — the H9 epoch-fence subject AND receipt author. */
  responderGithubUserId: number;
  responderDevicePubkey?: string | null;
  /** THIS host's device ref (the executor). */
  executorDevice: string;
  /** THIS host's own P-205 metering `host_ref` (must match the spend-recording leg). */
  hostRef: string;
  /** The host repo to clone FROM (canonical tree or bare mirror). */
  sourceRepoPath: string;
  /** The Q1 quota-subtree root; the clone lands at `<root>/repo`. */
  rootPath: string;
  branch?: string;
  workspaceRoot?: string;
  canonicalTree?: string;
  /** Audit actor label; defaults to 'p2p:offer-executor' (offer-executor.ts). */
  actor?: string;
}

export type PullAndExecuteResult =
  | { readonly outcome: 'skip'; readonly decision: PullSkip }
  | { readonly outcome: 'executed'; readonly decision: PullClaim; readonly execute: ExecuteOutcome };

/**
 * Composer: assembles the FULL production `OfferExecutorDeps` for one
 * execute call, bound to `ctx`. Exported so a real-seam test — or a future
 * caller — can exercise/override the wiring directly without re-deriving it.
 * `overrides` wins over the production defaults (spread last).
 */
export function productionOfferExecutorDeps(
  ctx: Pick<PullAndExecuteContext, 'workspaceId' | 'potSlug' | 'hostRef'>,
  overrides?: Partial<OfferExecutorDeps>,
): OfferExecutorDeps {
  return {
    currentGrantorEpoch: (grantorGithubUserId: number) => currentGrantorEpoch(ctx.workspaceId, ctx.potSlug, grantorGithubUserId),
    hostAvailability: (offer: WorkOffer) => buildHostAvailability({ workspaceId: ctx.workspaceId, hostRef: ctx.hostRef }, offer.fleetSlug),
    ...foreignSessionExecutorDeps(),
    ...overrides,
  };
}

/**
 * THE puller-boundary caller (WI-3629): evaluate one offer pull, and — on a
 * won claim/steal — execute it via `executeClaimedOffer`. Never throws on
 * refusal; a skip is returned, not raised (D-004 — the caller's IO edge is
 * expected to log/receipt a skip itself if it wants one, same as any other
 * `PullSkip`).
 */
export async function pullAndExecuteOffer(
  input: PullEvaluationInput,
  ctx: PullAndExecuteContext,
  depsOverride?: Partial<OfferExecutorDeps>,
): Promise<PullAndExecuteResult> {
  const decision = evaluatePull(input);
  if (decision.outcome === 'skip') {
    return { outcome: 'skip', decision };
  }

  // Assemble deps FIRST so the "stamped at admission" epoch read below and
  // executeClaimedOffer's own re-read at spawn time go through the SAME
  // (possibly-overridden) port — a test can inject one epoch reader and have
  // both reads consistently honor it (see the H9 doc note above).
  const deps = productionOfferExecutorDeps(ctx, depsOverride);
  const stampedGrantorEpoch = await deps.currentGrantorEpoch(ctx.responderGithubUserId);

  const execute = await executeClaimedOffer(
    {
      offer: input.authorship.offer,
      originGithubUserId: decision.authorizedGithubUserId,
      stampedGrantorEpoch,
      workspaceId: ctx.workspaceId,
      potSlug: ctx.potSlug,
      responderGithubUserId: ctx.responderGithubUserId,
      responderDevicePubkey: ctx.responderDevicePubkey,
      executorDevice: ctx.executorDevice,
      sourceRepoPath: ctx.sourceRepoPath,
      rootPath: ctx.rootPath,
      branch: ctx.branch,
      workspaceRoot: ctx.workspaceRoot,
      canonicalTree: ctx.canonicalTree,
      actor: ctx.actor,
    },
    deps,
  );

  return { outcome: 'executed', decision, execute };
}
