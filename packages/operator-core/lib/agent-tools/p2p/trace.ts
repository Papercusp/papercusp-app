/**
 * p2p:trace — assemble the cross-machine P2P timeline
 * (p2p-work-distribution-2026-07-02 P-004, M21).
 *
 * SKELETON scope (P-004): the receipt timeline + the M15 refused-op counter
 * snapshot. Every receipt row federates (mig 468), so this ONE tool run on ANY
 * member machine sees BOTH sides' receipts for an offer — the origin column
 * says which rows were authored locally vs applied from a peer. As the offer
 * lifecycle lands (P-102 signed offers, P-103 puller, P-106 reaping), their
 * events join this timeline keyed by the SAME offer_id (M21: the offer-id
 * threads through every receipt/audit/log line on both sides).
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  compareResponderBuild,
  listP2pReceipts,
  listRefusedOpCounters,
  parseResponderBuildMarker,
  type ResponderBuildMarkerEvidence,
} from '../../p2p/receipts';
import { resolveP2pGrantWorkspace } from '../../p2p/grant-store';
import { resolveDelegatedSpawnOutcome } from '../../p2p/delegated-spawn-outcome-resolve';
import { getBuildInfo, type BuildInfo } from '../../build-info';

function projectResponderBuild(
  evidence: ResponderBuildMarkerEvidence | null,
  tracingBuild: Pick<BuildInfo, 'sha' | 'version'>,
) {
  if (!evidence) {
    return {
      evidence: 'unavailable' as const,
      sha: null,
      version: null,
      comparison: 'unknown' as const,
      comparisonDetail: 'no honored/refusal receipt is available to identify the responder build.',
    };
  }
  const compared = compareResponderBuild(evidence, tracingBuild);
  return {
    evidence: evidence.state,
    sha: evidence.sha,
    version: evidence.version,
    comparison: compared.comparison,
    comparisonDetail: compared.detail,
    ...(compared.comparison === 'skew' ? { chronology: 'not-measured' as const } : {}),
  };
}

export default defineTool({
  name: 'p2p:trace',
  profile: 'engineer',
  description:
    "Assemble a pot or offer's cross-machine P2P timeline: both sides' federated receipts plus local refused-op counters. `refusal` names a refused action; `excused-breach` is a preemption excluded from reliability; `honored` is success. Delegated-spawn receipts expose responder build evidence and compare it with this tracing operator as `same`, `skew`, or `unknown`; `skew` proves different loaded SHAs, never chronology. D-029 `honored-first-turn-proven` includes a tool-backed first turn; legacy launch-only success is `honored-unverified`. For delegated spawns, `memberEvidenceAvailable:false` means an `indeterminate` outcome is unknowable here, not unhonored.",
  guidance: {
    when: 'Debug a refused or silent cross-peer offer/wake/spawn; receipts name the missing capability or budget.',
    notWhen:
      'For grant state, use grants/checkP2pCapability; for coord history, use coord:feed/coord:catch-up. This is an event timeline.',
    chaining: 'p2p:trace → fix the named gap → retry.',
    seeAlso: ['audit:list (the local audit rows the receipts also land in)'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120, describe: 'the pot HOME slug whose P2P timeline to read' }),
    offerId: z.string().min(1).optional().describe('M21 thread key — restrict the timeline to one offer lifecycle'),
    limit: z.number().int().positive().max(500).optional().describe('max receipts (default 100)'),
  }),
  async handler(args, ctx) {
    const json = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    });
    const ident = resolveAgentIdentity(ctx);
    const ws = resolveP2pGrantWorkspace(ident.workspaceId);
    if (!ws) {
      return json({
        ok: false,
        error: 'workspace_unresolved',
        detail:
          "p2p:trace needs a concrete workspace partition (WI-1564) — an un-scoped session can't name which hive-home partition to read. Re-run from a workspace-scoped session or pass a scoped identity.",
      });
    }
    const tracingBuild = getBuildInfo();
    const [receipts, counters, spawnOutcome] = await Promise.all([
      listP2pReceipts({ workspaceId: ws, potSlug: args.pot, offerId: args.offerId ?? null, limit: args.limit }),
      listRefusedOpCounters({ workspaceId: ws, potSlug: args.pot }),
      // WI-7042: the SYNTHESIZED verdict, only meaningful for one offer's
      // lifecycle. Best-effort: this is an enrichment on a debugging read, so a
      // failure here must degrade to the raw timeline (which is still the whole
      // pre-WI-7042 value of the tool) rather than fail the call.
      args.offerId
        ? resolveDelegatedSpawnOutcome({
            workspaceId: ws,
            potSlug: args.pot,
            offerId: args.offerId,
          }).catch((err) => {
            console.error(`[p2p:trace] spawn-outcome reconciliation failed for ${args.offerId}:`, err);
            return null;
          })
        : Promise.resolve(null),
    ]);
    return json({
      ok: true,
      pot: args.pot,
      offerId: args.offerId ?? null,
      tracingBuild: { sha: tracingBuild.sha, version: tracingBuild.version },
      // Ascending event time when tracing one offer (a lifecycle reads forward);
      // listP2pReceipts already orders ASC for offerId reads, DESC otherwise.
      receipts: receipts.map((r) => ({
        ts: r.receiptTs,
        kind: r.kind,
        action: r.action,
        offerId: r.offerId,
        refusalCode: r.refusalCode,
        missing: r.missingCapability,
        budgetAxis: r.budgetAxis,
        requester: r.requesterKind ? `${r.requesterKind}:${r.requesterRef}` : null,
        responder: r.responderGithubUserId,
        origin: r.origin,
        detail: r.detail,
        receiptId: r.receiptId,
        responderBuild:
          r.action === 'delegated-seat:spawn'
            ? projectResponderBuild(parseResponderBuildMarker(r.detail), tracingBuild)
            : undefined,
      })),
      // M15: unauthenticated refusals have no receipt — the counters are their
      // only trace. reason format: '<surface>:<reason>' (e.g. 'grant-apply:grantor_mismatch').
      refusedOpCounters: counters,
      // WI-7042: present ONLY when `offerId` names a delegated spawn request.
      // Absent for a seat/work offer or an unknown id — there is genuinely no
      // spawn outcome for those, and an error-shaped field would read as a
      // finding. `memberEvidenceAvailable:false` is the honest caveat, not a
      // fault: for a REMOTE honor this host holds no member evidence at all, so
      // `indeterminate` means "unknowable from here", never "nobody honored it".
      spawnRequestOutcome: spawnOutcome
        ? {
            verdict: spawnOutcome.outcome.verdict,
            detail: spawnOutcome.outcome.detail,
            attribution: spawnOutcome.outcome.attribution,
            members: spawnOutcome.outcome.members,
            shortfall: spawnOutcome.outcome.shortfall,
            refusalCode: spawnOutcome.outcome.refusalCode,
            actionable: spawnOutcome.outcome.actionable,
            fleetSlug: spawnOutcome.request.fleetSlug,
            requestedSeats: spawnOutcome.request.count,
            requestedAtMs: spawnOutcome.request.requestedAtMs,
            targetOfferId: spawnOutcome.targetOfferId,
            honoringDevicePubkey: spawnOutcome.honoringDevicePubkey,
            memberEvidenceAvailable: spawnOutcome.memberEvidenceAvailable,
            concurrentRequests: spawnOutcome.concurrentRequests,
            requesterOwnerId: spawnOutcome.requesterOwnerId,
            planSlug: spawnOutcome.planSlug,
            responderBuild: projectResponderBuild(spawnOutcome.responderBuild, tracingBuild),
          }
        : undefined,
      note:
        receipts.length === 0 && counters.length === 0
          ? 'no P2P receipts or refused-op counters for this scope — either nothing was refused, or the action predates mig 468.'
          : undefined,
    });
  },
});
