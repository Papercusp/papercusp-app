/**
 * fleet:request_remote_spawn — ask a CONTRIBUTING HOST to spawn fleet members
 * from the seats it delegated to your fleet (agent-allocation-framework
 * P-009, cross-machine launch over P2P).
 *
 * The other machine advertised its delegation as a federated SEAT-OFFER
 * (D-005: "that machine: N model·effort seats, fleet X" — resource:delegate on
 * the contributing host published it). This tool authors the matching SIGNED
 * spawn-request into the same offer store; when it federates, the target
 * host's honor path (delegated-spawn-honor.ts) verifies it, checks its
 * owner-authority accept-delegated-seats gate + live seat availability, and —
 * only then — opens the member terminals joined to YOUR fleet's coord layer.
 *
 * What "success" looks like from here is ASYNC by design: the tool returns as
 * soon as the signed request is stored locally. Watch the members arrive via
 * federated presence (fleet:status / coord:presence); a refusal comes back as
 * a federated p2p receipt (p2p:trace threads it by the request's offer id).
 * A host whose gate is OFF does nothing at all — the request just expires
 * (60 min honor window) — so agree with that machine's owner first.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getFleet } from '../../agent-fleets-store';
import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';
import { listOffers, type StoredWorkOffer } from '../../p2p/offer-store';
import { publishSpawnRequest } from '../../p2p/spawn-request-publish';
import { resolvePlanHarnessSlug } from '../plans/source';
import { resolveRemotePlacementHive } from './launch-on-plan';
import { fleetRoleFor, json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

/** Deterministic pick order mirrors distributeRemotePlacement's max-spread
 *  sort in launch-on-plan.ts: host label then offer id. */
export function byHostThenOffer(a: StoredWorkOffer, b: StoredWorkOffer): number {
  return (
    (a.record?.seat?.hostLabel ?? '').localeCompare(b.record?.seat?.hostLabel ?? '') ||
    a.offerId.localeCompare(b.offerId)
  );
}

/**
 * PURE (P-004): auto-pick ONE seat-offer from a pot's open (fleetSlug=null,
 * potSlug-scoped) offers for a spawn-request target when the requester's
 * fleet has no fleet-scoped offer of its own — deterministic (sorted by host
 * label then offer id, mirroring distributeRemotePlacement's spread order),
 * the first candidate whose delegated seat count covers `count`. Null when
 * none qualifies (caller refuses, listing candidates).
 */
export function pickPotSeatOffer(offers: readonly StoredWorkOffer[], count: number): StoredWorkOffer | null {
  const sorted = [...offers].sort(byHostThenOffer);
  return sorted.find((o) => (o.record?.seat?.count ?? 0) >= count) ?? null;
}

export default defineTool({
  name: 'fleet:request_remote_spawn',
  description:
    'Cross-machine launch: ask the machine that delegated seats to your fleet (its federated seat-offer) to spawn N members from those seats, joined to your fleet and working your plan. Async: returns once the SIGNED request is stored (it federates on the next sync tick); the target host honors it only if its owner enabled accept-delegated-seats. Watch arrivals via fleet:status / federated presence; refusals come back as p2p receipts (p2p:trace).',
  guidance: {
    when: "Your fleet holds a REMOTE seat-offer (another machine ran resource:delegate kind:'agent_slot' for your fleet) and you want those seats actually running members. Pick the target from the fleet's open seat-offers (auto-picked when there is exactly one).",
    notWhen:
      "Spawning from seats delegated on THIS machine → fleet:launch-on-plan (it consumes local seats directly). Spreading members across SEVERAL machines' seat-offers in one call → fleet:launch-on-plan placement:'remote' (it composes this request per target). Delegating seats in the first place → resource:delegate on the contributing machine.",
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:request_remote_spawn',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    fleet: z.string().min(1).describe('Your fleet slug (the seat-offer must name the same fleet).'),
    plan: z.string().min(1).describe('The plan slug the spawned members work (auto-kickoff on boot).'),
    count: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        "Members to spawn (1..the seat-offer's delegated count). The contributing host independently admits each actual start through its durable governor.",
      ),
    publisher: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Target seat-offer publisher (numeric GitHub user id). Optional when the fleet has exactly one open seat-offer.',
      ),
    offer: z
      .string()
      .min(1)
      .optional()
      .describe('Target seat-offer id (seat-<hex16>). Optional when the fleet has exactly one open seat-offer.'),
    hive: z
      .string()
      .min(1)
      .optional()
      .describe(
        "On a MULTI-hive workspace: which shared hive's federated seat-offers to spend (mirror of resource:delegate's `hive`). Defaults to the single shared hive; otherwise the call lists the candidate hives and refuses until you name one.",
      ),
    launchContext: z
      .string()
      .min(1)
      .max(8000)
      .optional()
      .describe('Optional brief TEXT for the members (the host composes it under the standard member baseline).'),
  }),
  async handler(args, ctx) {
    const { ownerId, workspaceId } = resolveFleetCaller(ctx);

    const fleet = await getFleet(workspaceId, args.fleet);
    if (!fleet) {
      return json(
        {
          ok: false,
          error: `no fleet '${args.fleet}' in this workspace — create it (fleet:create) before requesting remote members`,
        },
        true,
      );
    }
    if (fleetRoleFor(fleet.leaderOwnerId, ownerId) !== 'leader') {
      return json(
        {
          ok: false,
          error: `only the fleet leader may spend delegated seats — '${args.fleet}' is led by ${fleet.leaderOwnerId ?? '(nobody)'}; take leadership first (fleet:take-leadership) or ask the leader`,
        },
        true,
      );
    }

    const scope = await resolveWorkspaceHiveScope(workspaceId);
    const hivePick = resolveRemotePlacementHive(scope, args.hive, null);
    if (!hivePick.ok) {
      return json({ ok: false, error: hivePick.error }, true);
    }
    const hiveHomeSlug = hivePick.homeSlug;

    // Target selection: explicit pair, else the fleet's single open seat-offer.
    let targetPublisher = args.publisher ?? null;
    let targetOffer = args.offer ?? null;
    if ((targetPublisher == null) !== (targetOffer == null)) {
      return json(
        { ok: false, error: 'pass BOTH publisher + offer to pick a target seat-offer, or NEITHER to auto-pick' },
        true,
      );
    }
    // P-004: resolve "the pot" (the plan's owning harness) up front — needed both
    // for the pot-scoped auto-pick fallback below AND to thread requesterPotSlug
    // into publishSpawnRequest for an explicitly-named pot-scoped target.
    const potSlug = await resolvePlanHarnessSlug(workspaceId, args.plan);

    const seatOffers = await listOffers(workspaceId, hiveHomeSlug, {
      fleetSlug: args.fleet,
      kind: 'seat',
      status: 'open',
    });

    const candidateShape = (o: StoredWorkOffer) => ({
      publisher: o.publisherGithubUserId,
      offer: o.offerId,
      host: o.record?.seat?.hostLabel ?? null,
      seats: o.record?.seat ? `${o.record.seat.count} × ${o.record.seat.model}:${o.record.seat.effort}` : null,
    });
    let potOffers: StoredWorkOffer[] = [];
    if (targetPublisher == null || targetOffer == null) {
      if (seatOffers.length > 1) {
        return json(
          {
            ok: false,
            error: `fleet '${args.fleet}' has ${seatOffers.length} open seat-offers — pass publisher + offer to pick one`,
            candidates: seatOffers.map(candidateShape),
          },
          true,
        );
      }
      if (seatOffers.length === 1) {
        targetPublisher = seatOffers[0]!.publisherGithubUserId;
        targetOffer = seatOffers[0]!.offerId;
      } else {
        // No fleet-scoped offer — fall back to the pot's shared seat-offers
        // (fleetSlug=null, potSlug=this plan's harness) when the plan resolves
        // to a known pot.
        potOffers = potSlug
          ? await listOffers(workspaceId, hiveHomeSlug, { potSlug, kind: 'seat', status: 'open' })
          : [];
        const picked = pickPotSeatOffer(potOffers, args.count);
        if (!picked) {
          return json(
            {
              ok: false,
              error: potSlug
                ? potOffers.length === 0
                  ? `no open seat-offer for fleet '${args.fleet}' or its pot '${potSlug}' — the contributing machine delegates first (resource:delegate kind:'agent_slot', with or without a fleet)`
                  : `pot '${potSlug}' has ${potOffers.length} open seat-offer(s) but none delegates >= ${args.count} seat(s) — pass publisher + offer to pick one, or request fewer`
                : `no open seat-offer for fleet '${args.fleet}', and the plan '${args.plan}' does not resolve to a known pot — pass publisher + offer explicitly`,
              candidates: potOffers.length ? potOffers.map(candidateShape) : undefined,
            },
            true,
          );
        }
        targetPublisher = picked.publisherGithubUserId;
        targetOffer = picked.offerId;
      }
    }

    const res = await publishSpawnRequest({
      workspaceId,
      fleetSlug: args.fleet,
      targetPublisherGithubUserId: targetPublisher,
      targetOfferId: targetOffer,
      count: args.count,
      planSlug: args.plan,
      requesterOwnerId: ownerId,
      requesterPotSlug: potSlug ?? undefined,
      launchContext: args.launchContext ?? null,
      hiveOverride: hiveHomeSlug,
    });
    if (!res.ok) {
      return json({ ok: false, error: 'skipped' in res ? `not published: ${res.skipped}` : res.error }, true);
    }
    const seat =
      seatOffers.find((o) => o.offerId === targetOffer)?.record?.seat ??
      potOffers.find((o) => o.offerId === targetOffer)?.record?.seat ??
      null;
    return json({
      ok: true,
      requestOfferId: res.stored.offerId,
      target: { publisher: targetPublisher, offer: targetOffer, host: seat?.hostLabel ?? null },
      count: args.count,
      plan: args.plan,
      next: 'The signed request federates on the next sync tick. The target host spawns ONLY if its owner enabled accept-delegated-seats (/res) — otherwise the request expires after 60 min. Watch members arrive via fleet:status / coord:presence; a refusal federates back as a p2p receipt (p2p:trace with this requestOfferId).',
    });
  },
});
